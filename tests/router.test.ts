import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { planEffort, type RouterInvocation } from "../src/router.ts";
import type { ClassifyContext } from "../src/context-policy.ts";
import type { SelectJev } from "../src/jev.ts";

const signal = new AbortController().signal;

function createModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "current",
		name: "Current model",
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 100_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function input(currentModel: Model<Api> | undefined = createModel()) {
	return {
		task: "Implement the requested change",
		hasImages: false,
		currentModel,
		currentEffort: "medium" as ModelThinkingLevel,
		history: [],
		signal,
	};
}

describe("planEffort", () => {
	it("uses structured Jev results instead of parsing a chat response", async () => {
		const complete = vi.fn();
		const selectJev = vi.fn<SelectJev>(async () => ({ effort: "low", model: "jev-1.13.0", confidence: 0.1, probabilities: { low: 1 } }));
		const model = createModel();

		const result = await planEffort(input(model), complete, { select: selectJev, classify: vi.fn() });

		expect(complete).not.toHaveBeenCalled();
		expect(selectJev.mock.calls[0]?.[0].signal).toBe(signal);
		expect(result).toEqual({ status: "selected", plan: {
			model, effort: "low", reason: "Selected by Jev Choice", routerEffort: undefined,
		} });
	});

	it.each([undefined, { reasoning: false }, { thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } }])("bypasses both selectors when no decision is needed: %j", async (overrides) => {
		const complete = vi.fn();
		const selectJev = vi.fn();
		await planEffort({ ...input(), currentModel: overrides ? createModel(overrides) : undefined }, complete, { select: selectJev, classify: vi.fn() });
		expect(complete).not.toHaveBeenCalled();
		expect(selectJev).not.toHaveBeenCalled();
	});

	it("still rejects unsupported efforts from a structured selector", async () => {
		const complete = vi.fn();
		await expect(planEffort(input(), complete, { classify: vi.fn(), select: async () => ({
			effort: "max", model: "jev-1.13.0", confidence: 1, probabilities: { max: 1 },
		}) })).rejects.toThrow("Jev returned an unsupported effort");
		expect(complete).not.toHaveBeenCalled();
	});

	it("uses off for a non-reasoning model without calling the selector", async () => {
		const model = createModel({ reasoning: false });
		const complete = vi.fn();

		const result = await planEffort(input(model), complete);

		expect(result).toEqual({
			status: "selected",
			plan: { model, effort: "off", reason: "Only supported effort", routerEffort: undefined },
		});
		expect(complete).not.toHaveBeenCalled();
	});

	it("uses a single supported reasoning effort without a selector call", async () => {
		const model = createModel({ thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } });
		const complete = vi.fn();

		const result = await planEffort(input(model), complete);

		expect(result.status === "selected" && result.plan.effort).toBe("high");
		expect(complete).not.toHaveBeenCalled();
	});

	it("skips when no current model is selected", async () => {
		const complete = vi.fn();
		const result = await planEffort({ ...input(), currentModel: undefined }, complete);

		expect(result).toEqual({ status: "skipped", reason: "No current model is selected" });
		expect(complete).not.toHaveBeenCalled();
	});

	it("skips models with no supported effort", async () => {
		const model = createModel({ thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null } });
		const complete = vi.fn();

		const result = await planEffort(input(model), complete);

		expect(result).toEqual({ status: "skipped", reason: "The current model has no supported effort" });
		expect(complete).not.toHaveBeenCalled();
	});

	it.each(["off", "minimal", "low", "medium", "high", "max"] as const)("selects %s without changing models", async (effort) => {
		const model = createModel({ thinkingLevelMap: { off: "none", xhigh: null, max: "max" } });
		const complete = vi.fn(async () => JSON.stringify({ effort, reason: "Best fit" }));

		const result = await planEffort(input(model), complete);

		expect(result).toEqual({ status: "selected", plan: { model, effort, reason: "Best fit", routerEffort: "low" } });
		const invocation = complete.mock.calls[0];
		expect(invocation).toBeDefined();
	});

	it("sends only the current model and its supported efforts", async () => {
		const model = createModel({ thinkingLevelMap: { off: null, xhigh: null, max: "max" } });
		let invocation: RouterInvocation | undefined;

		await planEffort({ ...input(model), history: [{ entryId: "user1", role: "user", text: "Earlier task" }], hasImages: true }, async (value) => {
			invocation = value;
			return '{"effort":"medium"}';
		});

		expect(invocation?.model).toBe(model);
		expect(invocation?.signal).toBe(signal);
		expect(JSON.parse(invocation!.userPrompt)).toEqual({
			task: "Implement the requested change",
			taskCharacters: 30,
			taskTruncated: false,
			contextOmitted: false,
			hasImages: true,
			recentConversation: expect.stringContaining("Earlier task"),
			model: { id: "test/current", name: "Current model" },
			currentEffort: "medium",
			supportedEfforts: ["minimal", "low", "medium", "high", "max"],
		});
	});

	it.each(["off", "high"] as const)("uses low for selection even when the current effort is %s", async (currentEffort) => {
		const complete = vi.fn(async (_invocation: RouterInvocation) => '{"effort":"high"}');

		await planEffort({ ...input(), currentEffort }, complete);

		expect(complete.mock.calls[0]?.[0].effort).toBe("low");
	});

	it.each([
		{ map: { low: null }, expected: "minimal" },
		{ map: { minimal: null, low: null, medium: null }, expected: "high" },
	])("uses $expected when low is unsupported", async ({ map, expected }) => {
		const complete = vi.fn(async (_invocation: RouterInvocation) => '{"effort":"high"}');

		await planEffort(input(createModel({ thinkingLevelMap: map })), complete);

		expect(complete.mock.calls[0]?.[0].effort).toBe(expected);
	});

	it.each([
		'{"effort":"off"}',
		'{"effort":"xhigh"}',
		'{"effort":"max"}',
		'{"effort":"unknown"}',
		'{"effort":null}',
		'{"route":"r1"}',
		'{"model":"another"}',
		'{"effort":',
		'[{"effort":"high"}]',
		'Here you go: {"effort":"high"}',
	])("rejects unsupported or invalid decisions: %s", async (response) => {
		const model = createModel({ thinkingLevelMap: { off: null } });

		await expect(planEffort(input(model), async () => response)).rejects.toThrow("invalid or unsupported effort");
	});

	it("bounds long tasks and sanitizes the displayed reason", async () => {
		const task = `start-${"x".repeat(20_000)}-end`;
		let routedTask = "";
		let taskCharacters = 0;

		const result = await planEffort({ ...input(), task }, async (invocation) => {
			const payload = JSON.parse(invocation.userPrompt);
			routedTask = payload.task;
			taskCharacters = payload.taskCharacters;
			return '{"effort":"low","reason":"line one\\nline two\\u0007"}';
		});

		expect(routedTask.length).toBe(12_000);
		expect(routedTask).toMatch(/^start-/);
		expect(routedTask).toMatch(/-end$/);
		expect(taskCharacters).toBe(task.length);
		expect(result.status === "selected" && result.plan.reason).toBe("line one line two");
	});

	it("caps reasons at 160 characters", async () => {
		const result = await planEffort(input(), async () => JSON.stringify({ effort: "high", reason: "x".repeat(200) }));

		expect(result.status === "selected" && result.plan.reason.length).toBe(160);
	});

	it("accepts fenced JSON and supplies a missing reason", async () => {
		const result = await planEffort(input(), async () => '```json\n{"effort":"low"}\n```');

		expect(result.status === "selected" && result.plan.effort).toBe("low");
		expect(result.status === "selected" && result.plan.reason).toBe("Selected by router");
	});
});

const longHistory = ["old", "active", "recent"].map((entryId) => ({
	entryId, role: "user" as const, text: `${entryId}:`.padEnd(2_500, "x"),
}));
const contextRatings = [
	{ id: "c0:0:2500", importance: "irrelevant" as const },
	{ id: "c1:0:2500", importance: "required" as const },
	{ id: "c2:0:2500", importance: "irrelevant" as const },
];

describe("two-stage effort routing", () => {
	it.each(["model", "jev"] as const)("uses one selection call for short history on %s", async (backend) => {
		const complete = vi.fn(async () => '{"effort":"high"}');
		const select = vi.fn<SelectJev>(async () => ({ effort: "high", model: "jev-1.13.0", confidence: 1, probabilities: { high: 1 } }));
		const classify = vi.fn();
		const onDiagnostics = vi.fn();
		await planEffort({ ...input(), history: longHistory.slice(0, 1), onDiagnostics }, complete,
			backend === "jev" ? { select, classify } : undefined);
		expect(classify).not.toHaveBeenCalled();
		expect(complete).toHaveBeenCalledTimes(backend === "model" ? 1 : 0);
		expect(select).toHaveBeenCalledTimes(backend === "jev" ? 1 : 0);
		expect(onDiagnostics.mock.lastCall?.[0].compaction).toMatchObject({ status: "bypassed", candidateCount: 1, selectedCount: 1, ratings: [],
			candidateSources: [{ id: "c0:0:2500", entryId: "old", role: "user", start: 0, end: 2_500 }] });
	});

	it.each(["model", "jev"] as const)("classifies then selects with the same %s backend and signal", async (backend) => {
		const calls: string[] = [];
		const complete = vi.fn(async (invocation: RouterInvocation) => {
			calls.push(invocation.purpose);
			return invocation.purpose === "context" ? JSON.stringify(contextRatings) : '{"effort":"high"}';
		});
		const classify = vi.fn<ClassifyContext>(async () => { calls.push("context"); return contextRatings; });
		const select = vi.fn<SelectJev>(async () => {
			calls.push("effort");
			return { effort: "high", model: "jev-1.13.0", confidence: 1, probabilities: { high: 1 } };
		});
		const onDiagnostics = vi.fn();
		const model = createModel();
		const result = await planEffort({ ...input(model), history: longHistory, onDiagnostics }, complete,
			backend === "jev" ? { classify, select } : undefined);
		expect(result).toMatchObject({ status: "selected", plan: { model, effort: "high" } });
		expect(calls).toEqual(["context", "effort"]);
		if (backend === "model") {
			expect(select).not.toHaveBeenCalled();
			for (const [invocation] of complete.mock.calls) {
				expect(invocation.model).toBe(model);
				expect(invocation.signal).toBe(signal);
			}
		} else {
			expect(complete).not.toHaveBeenCalled();
			// Both injected adapters receive the same total-budget signal.
			expect(select.mock.calls[0]![0].signal).toBe(signal);
			expect(classify.mock.calls[0]![0].signal).toBe(signal);
		}
		const state = backend === "model" ? JSON.parse(complete.mock.calls[1]![0].userPrompt) : select.mock.calls[0]![0].state;
		expect(state.recentConversation).toContain(longHistory[1]!.text);
		expect(state.recentConversation).not.toContain(longHistory[0]!.text);
		expect(state.recentConversation).not.toContain(longHistory[2]!.text);
		expect(state.contextOmitted).toBe(true);
		expect(onDiagnostics.mock.lastCall?.[0]).toMatchObject({
			taskTruncated: false, selectionMs: expect.any(Number),
			compaction: { status: "extracted", candidateCount: 3, selectedCount: 1, ratings: contextRatings,
				sources: [{ entryId: "active", role: "user", start: 0, end: 2_500 }] },
		});
		expect(onDiagnostics.mock.lastCall?.[0].compaction.candidateSources).toEqual(longHistory.map(({ entryId, role }, index) => ({
			id: `c${index}:0:2500`, entryId, role, start: 0, end: 2_500,
		})));
		expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain(longHistory[1]!.text);
	});

	it.each([
		["missing", contextRatings.slice(1), "missing_context_rating"],
		["unknown", [...contextRatings.slice(0, 2), { id: "unknown", importance: "required" }], "unknown_context_rating"],
		["duplicate", [contextRatings[0], contextRatings[0], contextRatings[2]], "duplicate_context_rating"],
	] as const)("rejects %s candidate ratings without selecting", async (_name, ratings, reason) => {
		const complete = vi.fn(async () => JSON.stringify(ratings));
		const onDiagnostics = vi.fn();
		await expect(planEffort({ ...input(), history: longHistory, onDiagnostics }, complete)).resolves.toEqual({ status: "skipped", reason });
		expect(complete).toHaveBeenCalledTimes(1);
		expect(onDiagnostics.mock.lastCall?.[0].compaction).toMatchObject({ status: "failed", reason, ratings: [], sources: [] });
	});

	it.each([
		{ id: "c0:0:2500" },
		{ id: "c0:0:2500", importance: "unknown-private-response" },
		{ id: "c0:0:2500", importance: "required", text: "private-response-body" },
		{ id: "c0:0:2500", importance: null },
	])("rejects invalid model categories and fields without retaining their bodies: %j", async (rating) => {
		const complete = vi.fn(async () => JSON.stringify([rating, ...contextRatings.slice(1)]));
		const onDiagnostics = vi.fn();
		await expect(planEffort({ ...input(), history: longHistory, onDiagnostics }, complete)).rejects.toThrow(/^context_classification_failed$/);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(onDiagnostics.mock.lastCall?.[0].compaction).toMatchObject({ status: "failed", ratings: [], sources: [] });
		expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("private-response");
	});

	it.each(["model", "jev"] as const)("does not classify long history with no model or a single tier on %s", async (backend) => {
		for (const currentModel of [undefined, createModel({ reasoning: false }), createModel({ thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } })]) {
			const complete = vi.fn();
			const classify = vi.fn();
			const select = vi.fn();
			await planEffort({ ...input(), currentModel, history: longHistory }, complete, backend === "jev" ? { classify, select } : undefined);
			expect(complete).not.toHaveBeenCalled();
			expect(classify).not.toHaveBeenCalled();
			expect(select).not.toHaveBeenCalled();
		}
	});

	it.each([12_000, 12_001])("reports task truncation at %i characters in both model requests and diagnostics", async (length) => {
		const complete = vi.fn(async ({ purpose }: RouterInvocation) => purpose === "context" ? JSON.stringify(contextRatings) : '{"effort":"high"}');
		const onDiagnostics = vi.fn();
		await planEffort({ ...input(), task: "t".repeat(length), history: longHistory, onDiagnostics }, complete);
		for (const [invocation] of complete.mock.calls) {
			const state = JSON.parse(invocation.userPrompt);
			expect(state.task).toHaveLength(12_000);
			expect(state.taskTruncated).toBe(length > 12_000);
		}
		expect(JSON.parse(complete.mock.calls[1]![0].userPrompt).taskCharacters).toBe(length);
		expect(onDiagnostics.mock.lastCall?.[0].taskTruncated).toBe(length > 12_000);
	});
});
