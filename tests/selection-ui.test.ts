import { stripVTControlCharacters } from "node:util";
import { keyHint, type CustomEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, createSelectingWidget, formatAutoEffort, formatClassifierTiming, readDecision, renderDecisionEntry, type EffortDecision } from "../src/selection-ui.ts";
import { buildStatusPages } from "../src/status-ui.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, keyHint: vi.fn((_binding: string, description: string) => `ctrl+o ${description}`) };
});

function entry(overrides: Partial<EffortDecision> = {}): CustomEntry<EffortDecision> {
	return {
		type: "custom",
		customType: DECISION_ENTRY_TYPE,
		id: "decision",
		parentId: null,
		timestamp: new Date().toISOString(),
		data: {
			status: "selected",
			model: "test/current",
			previousEffort: "medium",
			effort: "low",
			reason: "A small, well-scoped question",
			routerModel: "test/current",
			routerEffort: "low",
			elapsedMs: 1200,
			...overrides,
		},
	};
}

function createTheme() {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		getThinkingBorderColor: vi.fn((_effort: string) => (text: string) => text),
	};
}

function render(expanded: boolean, overrides: Partial<EffortDecision> = {}, width = 100) {
	const theme = createTheme();
	const component = renderDecisionEntry(entry(overrides), { expanded }, theme as unknown as Theme);
	if (!component) throw new Error("Missing decision component");
	return { theme, lines: component.render(width).map(stripVTControlCharacters) };
}

function diagnostics(overrides: Partial<EffortDecision>): string {
	return buildStatusPages({ enabled: true, model: "test/current", effort: "low", backend: "current model", supportedEfforts: ["low", "high"], last: entry(overrides).data! })[2]!.lines.map(({ text }) => text).join("\n");
}

describe("selection UI", () => {
	it("spins in front of the selecting label and stops once disposed", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const widget = createSelectingWidget({ requestRender } as unknown as TUI, createTheme() as unknown as Theme);

			expect(widget.render(80)).toEqual([" ⠋ choosing effort"]);
			vi.advanceTimersByTime(80);
			expect(widget.render(80)).toEqual([" ⠙ choosing effort"]);
			expect(requestRender).toHaveBeenCalledTimes(1);

			widget.dispose();
			vi.advanceTimersByTime(800);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(widget.render(80)).toEqual([" ⠙ choosing effort"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{ stopReason: "unknown", contentTypes: ["text"], textCharacters: 0 },
		{ stopReason: "stop", contentTypes: ["unknown"], textCharacters: 0 },
		{ stopReason: "stop", contentTypes: ["text"], textCharacters: -1 },
		{ stopReason: "stop", contentTypes: ["text"], textCharacters: 9_000, rawText: "x".repeat(9_000), rawTextTruncated: false },
		{ stopReason: "stop", contentTypes: ["text"], textCharacters: 1, rawText: "x" },
	])("rejects malformed persisted response diagnostics %#", (response) => {
		const saved = entry();
		Object.assign(saved.data!, { selectorResponses: { effort: response } });
		expect(readDecision(saved)).toBeUndefined();
	});

	it("round trips Classifier diagnostics and exposes the error code without raw text", () => {
		const saved = entry({ classifierDiagnostics: { stage: "validation", errorCode: "unsupported_effort", stopReason: "stop", responseType: "object",
			responseCharacters: 7, rawText: "private", rawTextTruncated: false } });
		const restored = readDecision(JSON.parse(JSON.stringify(saved)))!;
		expect(restored.classifierDiagnostics).toEqual(saved.data!.classifierDiagnostics);
		expect(diagnostics(restored)).toContain("Stage: validation");
		expect(diagnostics(restored)).toContain("Error code: unsupported_effort");
		expect(diagnostics(restored)).toContain("classifierDiagnostics.rawText");
		expect(diagnostics(restored)).not.toContain("private");
		expect(render(true, restored).lines.join("\n")).not.toContain("private");
	});

	it.each([
		null, {}, { stage: "unknown" }, { stage: "request", stopReason: "unknown" }, { stage: "validation", errorCode: "private-error" },
		{ stage: "request", headers: { Authorization: "private" } },
		{ stage: "validation", responseType: "object" },
		{ stage: "validation", responseType: "object", responseCharacters: -1 },
		{ stage: "validation", responseType: "object", responseCharacters: 2, rawText: "{}" },
		{ stage: "validation", responseType: "object", responseCharacters: 9_000, rawText: "x".repeat(9_000), rawTextTruncated: false },
	])("discards malformed optional Classifier diagnostics without hiding the decision %#", (classifierDiagnostics) => {
		const saved = entry();
		Object.assign(saved.data!, { classifierDiagnostics });
		expect(readDecision(saved)).toMatchObject({ status: "selected" });
		expect(readDecision(saved)).not.toHaveProperty("classifierDiagnostics");
	});

	it("uses primary auto and the corresponding effort color", () => {
		const theme = createTheme();
		expect(formatAutoEffort(theme as unknown as Theme, "high")).toBe("auto · high");
		expect(theme.fg).toHaveBeenCalledWith("accent", "auto");
		expect(theme.fg).toHaveBeenCalledWith("dim", " · ");
		expect(theme.getThinkingBorderColor).toHaveBeenCalledWith("high");
	});

	it("keeps details collapsed and shows the native expand shortcut", () => {
		const { lines } = render(false);
		const text = lines.join("\n");

		expect(lines).toHaveLength(1);
		expect(text).toContain("auto · low");
		expect(text).toContain("ctrl+o");
		expect(keyHint).toHaveBeenCalledWith("app.tools.expand", "to expand");
		expect(text).not.toContain("Reason:");
		expect(text).not.toContain("test/current");
	});

	it.each([
		["openai-codex/gpt-6-astra", "gpt-6-astra"],
		["typesafe/jev-latest", "jev-latest"],
	])("shows the actual selector %s in the collapsed heading", (routerModel, label) => {
		const { lines } = render(false, { effort: "high", routerModel });
		expect(lines.join("\n")).toContain(`auto · high · ${label} · 1.20s`);
		expect(lines.join("\n")).toContain("ctrl+o");
	});

	it.each([[0, "0.00s"], [530, "0.53s"], [12_345, "12.35s"]] as const)("shows %i milliseconds as total selection time", (elapsedMs, label) => {
		const { lines } = render(false, { routerModel: "typesafe/jev-latest", elapsedMs, classifierTiming: { totalMs: 100 } });
		expect(lines.join("\n")).toContain(`jev-latest · ${label} ctrl+o`);
	});

	it("labels the actual current-model selector after Classifier fallback", () => {
		const { lines } = render(false, { routerModel: "openai-codex/gpt-6-astra", reason: "Classifier failed; current-model fallback", classifierDiagnostics: { stage: "validation", errorCode: "missing_effort" } });
		expect(lines.join("\n")).toContain("auto · low · gpt-6-astra · 1.20s");
		expect(lines.join("\n")).not.toContain("jev-latest");
	});

	it("shows a concise decision summary when Pi expands the entry", () => {
		const { lines, theme } = render(true);
		const text = lines.join("\n");

		expect(text).toContain("Model: test/current");
		expect(text).toContain("Effort: medium → low");
		expect(text).toContain("Selector: test/current @ low");
		expect(text).toContain("Reason: A small, well-scoped question");
		expect(text).toContain("Elapsed: 1.2s");
		expect(text).not.toContain("to expand");
		expect(theme.getThinkingBorderColor).toHaveBeenCalledWith("medium");
		expect(theme.getThinkingBorderColor).toHaveBeenCalledWith("low");
	});

	it.each(["kept", "cancelled"] as const)("keeps the %s outcome visible while hiding details", (status) => {
		const { lines, theme } = render(false, { status });
		expect(lines.join("\n")).toContain(`auto · low · current · 1.20s · ${status}`);
		expect(theme.fg).toHaveBeenCalledWith("warning", ` · ${status}`);
		expect(lines.join("\n")).not.toContain("Reason:");
	});

	it("does not imply a selector call for a single supported effort", () => {
		const { lines } = render(true, { effort: "off", routerEffort: undefined, routerModel: undefined });
		expect(lines.join("\n")).toContain("Selector: not called");
	});

	it("shows Classifier but reserves confidence for the diagnostics page", () => {
		const { lines } = render(true, {
			routerModel: "typesafe/jev-latest", routerEffort: undefined, routerConfidence: 0.85,
			reason: "Selected by Classifier Choice",
		});
		const text = lines.join("\n");
		expect(text).toContain("Selector: typesafe/jev-latest");
		expect(text).not.toContain("Confidence:");
		expect(diagnostics({ routerConfidence: 0.85 })).toContain("Confidence: 0.850 (not success probability)");
		expect(text).not.toContain("not called");
		expect(text).not.toContain(" @ ");
	});

	it("preserves Classifier metadata in a JSON history round trip", () => {
		const data = entry({ routerModel: "typesafe/jev-latest", routerEffort: undefined, routerConfidence: 0 });
		expect(readDecision(JSON.parse(JSON.stringify(data)))).toMatchObject({
			routerModel: "typesafe/jev-latest", routerConfidence: 0,
		});
	});

	it.each([-1, 1.1, NaN, Infinity, "0.8", null])("rejects invalid confidence %j in saved records", (routerConfidence) => {
		expect(readDecision({ ...entry(), data: { ...entry().data, routerConfidence } })).toBeUndefined();
	});

	it("renders partial and completed numeric timing without inventing missing stages", () => {
		const text = diagnostics({ prepareMs: 0.5, classifierTiming: { classifyMs: 900.1 } });
		expect(text).toContain("Prepare: 0.5ms");
		expect(text).toContain("classify 900.1ms");
		expect(text).not.toContain("body/decode");
	});

	it("does not invent timing measurements", () => {
		expect(formatClassifierTiming({})).toBe("");
		expect(formatClassifierTiming({ totalMs: 123 })).toBe("total 123.0ms");
	});

	it.each([null, [], { classifyMs: -1 }, { totalMs: NaN }, { classifyMs: "1" }, { requestBody: "private" }])("ignores malformed optional timing metadata: %j", (classifierTiming) => {
		const restored = readDecision({ ...entry(), data: { ...entry().data, classifierTiming } });
		expect(restored).toMatchObject({ status: "selected" });
		expect(restored).not.toHaveProperty("classifierTiming");
	});

	it("keeps saved decisions and available usage while dropping unsupported network diagnostics", () => {
		const saved = entry();
		Object.assign(saved.data!, {
			classifierTiming: { headersMs: 20, transport: { socketId: 1 }, totalMs: 30, inputTokens: 200, outputTokens: 1 },
			classifierDiagnostics: { stage: "response", errorCode: "http_error" },
		});
		const restored = readDecision(JSON.parse(JSON.stringify(saved)))!;
		expect(restored).toMatchObject({ status: "selected", effort: saved.data!.effort,
			classifierTiming: { totalMs: 30, inputTokens: 200, outputTokens: 1 } });
		expect(restored.classifierTiming).not.toHaveProperty("headersMs");
		expect(restored.classifierTiming).not.toHaveProperty("transport");
		expect(restored).not.toHaveProperty("classifierDiagnostics");
		expect(diagnostics(restored)).toContain("200 input / 1 output");
	});

	it.each([24, 80, 120])("wraps long details within %s terminal columns", (width) => {
		const { lines } = render(true, { reason: "A long reason with multiple constraints. ".repeat(10) }, width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("reads a decision after a JSON history round trip", () => {
		const restored = JSON.parse(JSON.stringify(entry({ routerEffort: undefined, routerModel: undefined })));
		expect(readDecision(restored)).toMatchObject({ status: "selected", effort: "low", reason: "A small, well-scoped question" });
	});

	it.each([undefined, null, {}, { ...entry().data, effort: "invalid" }, { ...entry().data, routerEffort: "off" }, { ...entry().data, elapsedMs: -1 }])("ignores malformed decision data: %j", (data) => {
		expect(readDecision({ ...entry(), data })).toBeUndefined();
	});
});

function recentTurnDecision(): Partial<EffortDecision> {
	return {
		effort: "max", routerModel: "typesafe/jev-latest", routerEffort: undefined, routerConfidence: 0.9,
		prepareMs: 1, elapsedMs: 61,
		classifierTiming: { classifyMs: 45, validateMs: 0.5, totalMs: 45.5, inputTokens: 300, outputTokens: 1 },
		routerProbabilities: { low: 0.01, medium: 0.04, high: 0.05, max: 0.9 },
		routing: {
			policyVersion: "1", supportedEfforts: ["low", "medium", "high", "max"], taskTruncated: true, selectionMs: 45.5,
			context: { strategy: "recent-turn", omitted: true, characters: 2_600, elapsedMs: 0.5,
				sources: [{ entryId: "history-entry", role: "user", start: 12, end: 2_512 }],
			},
		},
	};
}

describe("recent-turn decision records", () => {
	it("round trips all new diagnostics including source ranges and effort probabilities", () => {
		const original = entry(recentTurnDecision());
		const restored = readDecision(JSON.parse(JSON.stringify(original)));
		expect(restored).toEqual(original.data);
		expect(restored?.routing?.context?.sources).toEqual([{ entryId: "history-entry", role: "user", start: 12, end: 2_512 }]);
	});

	it("moves detailed accounting to diagnostics and keeps transcript expansion brief", () => {
		const data = recentTurnDecision();
		const text = diagnostics(data);
		for (const detail of [
			"Policy: 1", "Answering model choices: low, medium, high, max", "Task truncated: true",
			"Local context: 0.5ms", "Effort request", "total 45.5ms",
			"Classifier usage: 300 input / 1 output tokens",
			"low: 0.01", "max: 0.9",
		]) expect(text).toContain(detail);
		const expanded = render(true, data, 200).lines;
		expect(expanded.length).toBeLessThanOrEqual(8);
		expect(expanded.join("\n")).toContain("1 messages retained · omitted: yes");
		expect(expanded.join("\n")).not.toMatch(/Policy:|timing:|Probabilities:|usage:/);
		const collapsed = render(false, data).lines;
		expect(collapsed).toHaveLength(1);
		expect(collapsed[0]).toContain("auto · max");
		expect(collapsed[0]).not.toMatch(/Policy|Context|Probabilities|usage/);
	});

	it("shows final model selection time separately from context time", () => {
		const { routing } = recentTurnDecision();
		const text = diagnostics({ routing: routing!, routerModel: "test/current", routerEffort: "low" });
		expect(text).toContain("Local context: 0.5ms");
		expect(text).toContain("45.5ms");
	});

	it("round trips and renders usage for the current-model effort request", () => {
		const selectorUsage = {
			effort: { input: 300, output: 12, cacheRead: 0, cacheWrite: 5, cost: 0.02 },
		};
		expect(readDecision(JSON.parse(JSON.stringify(entry({ selectorUsage }))))?.selectorUsage).toEqual(selectorUsage);
		const text = diagnostics({ selectorUsage });
		expect(text).toContain("effort: 300 input / 12 output tokens");
		expect(text).toContain("Cache: 0 read / 5 write | Cost: $0.02");
	});

	it("accepts legacy records without inventing new diagnostics or usage", () => {
		const restored = readDecision(JSON.parse(JSON.stringify(entry())))!;
		for (const field of ["routing", "classifierTiming", "routerProbabilities", "selectorUsage"]) expect(restored).not.toHaveProperty(field);
		expect(render(true, restored).lines.join("\n")).not.toMatch(/Policy:|Context:|timing:|Probabilities:|usage:/);
	});

	it.each([
		{ routerProbabilities: { high: NaN } },
		{ selectorUsage: { context: { input: 700, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } } },
		{ selectorResponses: { context: { stopReason: "stop", contentTypes: ["text"], textCharacters: 0 } } },
		{ selectorUsage: { effort: { input: 700, output: 1, cacheRead: 0, cacheWrite: 0, cost: Infinity } } },
		{ routing: { ...recentTurnDecision().routing, taskTruncated: "true" } },
		{ routing: { ...recentTurnDecision().routing, selectionMs: -1 } },
	])("rejects malformed saved metadata: %j", (overrides) => {
		expect(readDecision({ ...entry(), data: { ...entry().data, ...overrides } })).toBeUndefined();
	});

	it.each([
		null, [], {},
		{ strategy: "classification" }, { omitted: "false" }, { omitted: undefined },
		{ characters: -1 }, { characters: 0.5 }, { characters: Infinity },
		{ elapsedMs: undefined }, { elapsedMs: -1 }, { elapsedMs: NaN },
		{ sources: undefined }, { sources: Array(3).fill({ entryId: "entry", role: "user", start: 0, end: 5 }) },
		{ sources: [{ entryId: "entry", role: "summary", start: 0, end: 5 }] },
		{ sources: [{ entryId: "entry", role: "user", start: 10, end: 5 }] },
		{ sources: [{ entryId: "entry", role: "user", start: 0.5, end: 5 }] },
		{ text: "private" },
	])("rejects invalid recent-turn context metadata: %j", (overrides) => {
		const saved = entry(recentTurnDecision());
		const context = overrides === null || Array.isArray(overrides) || Object.keys(overrides).length === 0
			? overrides : { ...saved.data!.routing!.context, ...overrides };
		Object.assign(saved.data!.routing!, { context });
		expect(readDecision(saved)).toBeUndefined();
	});

	it("round trips effort response diagnostics without exposing raw text in the UI", () => {
		const selectorResponses = { effort: { stopReason: "stop" as const, contentTypes: ["text" as const],
			textCharacters: 7, rawText: "private", rawTextTruncated: false } };
		const restored = readDecision(JSON.parse(JSON.stringify(entry({ selectorResponses }))))!;
		expect(restored.selectorResponses).toEqual(selectorResponses);
		expect(render(true, restored).lines.join("\n")).not.toContain("private");
		expect(diagnostics(restored)).not.toContain("private");
	});
});

describe("legacy decision isolation", () => {
	it("ignores old classifier fields and attempt names without rewriting or crashing", () => {
		const old = entry();
		Object.assign(old.data!, {
			jevTiming: { transport: { invalid: true } }, jevDiagnostics: { incompatible: true },
			selectorAttempts: [{ backend: "jev", outcome: "selected", elapsedMs: 12, timeoutMs: 10000 }],
			classifierTiming: { classifyMs: "unknown" }, classifierDiagnostics: { stage: "old-schema" },
		});
		const serialized = JSON.stringify(old);
		const read = readDecision(old);
		expect(read).toMatchObject({ status: "selected", effort: "low" });
		expect(read).not.toHaveProperty("jevTiming");
		expect(read).not.toHaveProperty("jevDiagnostics");
		expect(read).not.toHaveProperty("classifierTiming");
		expect(read).not.toHaveProperty("classifierDiagnostics");
		expect(read).not.toHaveProperty("selectorAttempts");
		expect(() => buildStatusPages({ enabled: true, model: "test/current", effort: "low", backend: "current", supportedEfforts: ["low"], last: read! })).not.toThrow();
		expect(JSON.stringify(old)).toBe(serialized);
	});
});
