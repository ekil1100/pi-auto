import { stripVTControlCharacters } from "node:util";
import { keyHint, type CustomEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, createSelectingWidget, formatAutoEffort, formatJevTiming, readDecision, renderDecisionEntry, type EffortDecision } from "../src/selection-ui.ts";
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
		expect(lines.join("\n")).toContain(`auto · low · ${status}`);
		expect(theme.fg).toHaveBeenCalledWith("warning", ` · ${status}`);
		expect(lines.join("\n")).not.toContain("Reason:");
	});

	it("does not imply a selector call for a single supported effort", () => {
		const { lines } = render(true, { effort: "off", routerEffort: undefined, routerModel: undefined });
		expect(lines.join("\n")).toContain("Selector: not called");
	});

	it("shows Jev but reserves confidence for the diagnostics page", () => {
		const { lines } = render(true, {
			routerModel: "typesafe/jev-1.13.0", routerEffort: undefined, routerConfidence: 0.85,
			reason: "Selected by Jev Choice",
		});
		const text = lines.join("\n");
		expect(text).toContain("Selector: typesafe/jev-1.13.0");
		expect(text).not.toContain("Confidence:");
		expect(diagnostics({ routerConfidence: 0.85 })).toContain("Confidence: 0.850 (not success probability)");
		expect(text).not.toContain("not called");
		expect(text).not.toContain(" @ ");
	});

	it("preserves Jev metadata in a JSON history round trip", () => {
		const data = entry({ routerModel: "typesafe/jev-1.13.0", routerEffort: undefined, routerConfidence: 0 });
		expect(readDecision(JSON.parse(JSON.stringify(data)))).toMatchObject({
			routerModel: "typesafe/jev-1.13.0", routerConfidence: 0,
		});
	});

	it.each([-1, 1.1, NaN, Infinity, "0.8", null])("rejects invalid confidence %j in saved records", (routerConfidence) => {
		expect(readDecision({ ...entry(), data: { ...entry().data, routerConfidence } })).toBeUndefined();
	});

	it("renders partial and completed numeric timing without inventing missing stages", () => {
		const text = diagnostics({ prepareMs: 0.5, jevTiming: { setupMs: 0.2, headersMs: 900.1 } });
		expect(text).toContain("Prepare: 0.5ms");
		expect(text).toContain("headers 900.1ms");
		expect(text).not.toContain("body/decode");
	});

	it("round trips effort socket evidence without fabricating reused dial times", () => {
		const data: Partial<EffortDecision> = {
			jevTiming: { transport: { status: "observed", requestCount: 1, connection: "reused", socketId: 7, afterUploadMs: 270.3 } },
		};
		expect(readDecision(JSON.parse(JSON.stringify(entry(data))))).toMatchObject(data);
		const text = diagnostics(data);
		expect(text).toContain("Effort request\ntransport observed\nconnection reused\nsocket #7\nafter-upload 270.3ms");
		expect(text).not.toContain("connect 0.0ms");
	});

	it.each(["partial", "unavailable", "ambiguous"] as const)("shows %s transport without inventing missing measurements", (status) => {
		const text = formatJevTiming({ transport: { status, connection: "unknown", requestCount: status === "ambiguous" ? 2 : 0 } });
		expect(text).toContain(`transport ${status} · connection unknown`);
		expect(text).not.toMatch(/socket #|connect [\d.]|after-upload/);
	});

	it.each([
		null, [], {}, { status: "private", connection: "new", requestCount: 1 },
		{ status: "observed", connection: "private", requestCount: 1 },
		{ status: "partial", connection: "unknown", requestCount: -1 },
		{ status: "partial", connection: "unknown", requestCount: 0.5 },
		{ status: "partial", connection: "unknown", requestCount: 1, socketId: 0 },
		{ status: "partial", connection: "unknown", requestCount: 1, connectMs: NaN },
		{ status: "partial", connection: "unknown", requestCount: 1, afterUploadMs: "100" },
		{ status: "partial", connection: "unknown", requestCount: 1, remoteAddress: "private" },
		{ status: "partial", connection: "unknown", requestCount: 1, headers: "private" },
	])("rejects malformed or private transport fields: %j", (transport) => {
		expect(readDecision({ ...entry(), data: { ...entry().data, jevTiming: { transport } } })).toBeUndefined();
	});

	it.each([null, [], { headersMs: -1 }, { totalMs: NaN }, { setupMs: "1" }, { requestBody: "private" }])("rejects malformed timing metadata: %j", (jevTiming) => {
		expect(readDecision({ ...entry(), data: { ...entry().data, jevTiming } })).toBeUndefined();
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
		effort: "max", routerModel: "typesafe/jev-1.13.0", routerEffort: undefined, routerConfidence: 0.9,
		prepareMs: 1, elapsedMs: 61,
		jevTiming: { setupMs: 1, headersMs: 40, bodyAndDecodeMs: 4, validateMs: 0.5, totalMs: 45.5, inputTokens: 300, outputTokens: 1 },
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
			"Policy: 1", "Selector choices: low, medium, high, max", "Task truncated: true",
			"Local context: 0.5ms", "Effort request", "total 45.5ms",
			"Effort usage: 300 input / 1 output tokens",
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
		for (const field of ["routing", "jevTiming", "routerProbabilities", "selectorUsage"]) expect(restored).not.toHaveProperty(field);
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
