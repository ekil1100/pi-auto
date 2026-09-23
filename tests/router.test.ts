import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { planEffort, type EffortState, type RoutingDiagnostics, type RouterInvocation } from "../src/router.ts";
import type { HistoryMessage } from "../src/session-context.ts";
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

		const result = await planEffort(input(model), complete, selectJev);

		expect(complete).not.toHaveBeenCalled();
		expect(selectJev.mock.calls[0]?.[0].signal).toBe(signal);
		expect(result).toEqual({ status: "selected", plan: {
			model, effort: "low", reason: "Selected by Jev Choice", routerEffort: undefined,
		} });
	});

	it.each([undefined, { reasoning: false }, { thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } }])("bypasses both selectors when no decision is needed: %j", async (overrides) => {
		const complete = vi.fn();
		const selectJev = vi.fn();
		await planEffort({ ...input(), currentModel: overrides ? createModel(overrides) : undefined }, complete, selectJev);
		expect(complete).not.toHaveBeenCalled();
		expect(selectJev).not.toHaveBeenCalled();
	});

	it("still rejects unsupported efforts from a structured selector", async () => {
		const complete = vi.fn();
		await expect(planEffort(input(), complete, async () => ({
			effort: "max", model: "jev-1.13.0", confidence: 1, probabilities: { max: 1 },
		}))).rejects.toThrow("Jev returned an unsupported effort");
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

	it.each([
		["plain text", "not_json_object"],
		['{"effort":}', "invalid_json"],
		['{"reason":"private-reason"}', "missing_effort"],
		['{"effort":null}', "invalid_effort_type"],
		['{"effort":"private-unknown"}', "unsupported_effort"],
	])("explains rejected decisions without echoing their text: %s", async (response, failure) => {
		await expect(planEffort(input(), async () => response)).rejects.toThrow(
			`Router returned an invalid or unsupported effort (${failure})`,
		);
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

		expect(routedTask).toBe(task);
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

const longHistory: HistoryMessage[] = [
	{ entryId: "old-user", role: "user", text: "private-old-task".repeat(4_000) },
	{ entryId: "old-agent", role: "assistant", text: "private-old-answer" },
	{ entryId: "user", role: "user", text: "private-previous-task" },
	{ entryId: "progress", role: "assistant", text: "private-intermediate-commentary" },
	{ entryId: "agent", role: "assistant", text: "private-previous-answer" },
];

function selectors() {
	return {
		complete: vi.fn(async (_invocation: RouterInvocation) => '{"effort":"high"}'),
		select: vi.fn<SelectJev>(async () => ({ effort: "high", model: "jev-1.13.0", confidence: 1, probabilities: { high: 1 } })),
	};
}

describe.each(["model", "jev"] as const)("single-call %s routing", (backend) => {
	function stateFrom({ complete, select }: ReturnType<typeof selectors>): EffortState {
		expect(complete).toHaveBeenCalledTimes(backend === "model" ? 1 : 0);
		expect(select).toHaveBeenCalledTimes(backend === "jev" ? 1 : 0);
		if (backend === "jev") {
			expect(select.mock.calls[0]![0].signal).toBe(signal);
			return select.mock.calls[0]![0].state;
		}
		expect(complete.mock.calls[0]![0]).toMatchObject({ purpose: "effort", signal });
		return JSON.parse(complete.mock.calls[0]![0].userPrompt);
	}

	it("sends only the latest user and final assistant despite long history", async () => {
		const mocks = selectors();
		const onDiagnostics = vi.fn<(value: RoutingDiagnostics) => void>();
		const model = createModel();
		const result = await planEffort({ ...input(model), task: "private-current-task", history: longHistory, onDiagnostics }, mocks.complete,
			backend === "jev" ? mocks.select : undefined);
		expect(result).toMatchObject({ status: "selected", plan: { model, effort: "high" } });
		const state = stateFrom(mocks);
		expect(state.task).toBe("private-current-task");
		expect(state.recentConversation).toBe('[Earlier history omitted]\n\n[user source="user" range=0:21]\nprivate-previous-task\n\n[assistant source="agent" range=0:23]\nprivate-previous-answer');
		for (const excluded of [longHistory[0]!.text, longHistory[1]!.text, longHistory[3]!.text, state.task]) expect(state.recentConversation).not.toContain(excluded);
		expect(state.contextOmitted).toBe(true);
		const diagnostics = onDiagnostics.mock.lastCall![0];
		expect(diagnostics).toMatchObject({
			taskTruncated: false, selectionMs: expect.any(Number),
			context: { strategy: "recent-turn", omitted: true, characters: state.recentConversation!.length, elapsedMs: expect.any(Number), sources: [
				{ entryId: "user", role: "user", start: 0, end: 21 },
				{ entryId: "agent", role: "assistant", start: 0, end: 23 },
			] },
		});
		expect(Object.keys(diagnostics.context!).sort()).toEqual(["characters", "elapsedMs", "omitted", "sources", "strategy"]);
		expect(diagnostics.context!.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(diagnostics.selectionMs).toBeGreaterThanOrEqual(0);
		expect(diagnostics).not.toHaveProperty("compaction");
		const serialized = JSON.stringify(onDiagnostics.mock.calls);
		for (const secret of [state.task, ...longHistory.map(({ text }) => text)]) expect(serialized).not.toContain(secret);
	});

	it.each([
		{ history: [] as HistoryMessage[], omitted: false, sourceIds: [] },
		{ history: [{ entryId: "u", role: "user", text: "Short task" }] as HistoryMessage[], omitted: false, sourceIds: ["u"] },
		{ history: [{ entryId: "s", role: "summary", text: "Private summary" }] as HistoryMessage[], omitted: true, sourceIds: [] },
	])("handles empty, short and summary-only histories: %#", async ({ history, omitted, sourceIds }) => {
		const mocks = selectors();
		const onDiagnostics = vi.fn<(value: RoutingDiagnostics) => void>();
		await planEffort({ ...input(), history, onDiagnostics }, mocks.complete, backend === "jev" ? mocks.select : undefined);
		const state = stateFrom(mocks);
		expect(state.contextOmitted).toBe(omitted);
		if (!sourceIds.length) expect(state).not.toHaveProperty("recentConversation");
		else expect(state.recentConversation).toContain("Short task");
		expect(onDiagnostics.mock.lastCall![0].context).toMatchObject({ strategy: "recent-turn", omitted, characters: state.recentConversation?.length ?? 0 });
		expect(onDiagnostics.mock.lastCall![0].context!.sources.map(({ entryId }) => entryId)).toEqual(sourceIds);
	});

	it("preserves long recent pairs with exact source diagnostics", async () => {
		const mocks = selectors();
		const onDiagnostics = vi.fn<(value: RoutingDiagnostics) => void>();
		const history: HistoryMessage[] = [
			{ entryId: "user", role: "user", text: "previous-task:" + "u".repeat(30_000) },
			{ entryId: "agent", role: "assistant", text: "previous-answer:" + "a".repeat(30_000) },
		];
		await planEffort({ ...input(), history, onDiagnostics }, mocks.complete, backend === "jev" ? mocks.select : undefined);
		const state = stateFrom(mocks);
		for (const message of history) expect(state.recentConversation).toContain(message.text);
		expect(state.contextOmitted).toBe(false);
		const context = onDiagnostics.mock.lastCall![0].context!;
		expect(context).toMatchObject({ strategy: "recent-turn", omitted: false, characters: state.recentConversation!.length });
		expect(context.sources).toHaveLength(2);
		const parts = context.sources.map(({ entryId, role, start, end }, index) => {
			expect(entryId).toBe(history[index]!.entryId);
			expect(start).toBe(0);
			expect(end).toBeGreaterThan(0);
			expect(end).toBe(history[index]!.text.length);
			return `[${role} source=${JSON.stringify(entryId)} range=${start}:${end}]\n${history[index]!.text.slice(start, end)}`;
		});
		expect(state.recentConversation).toBe(parts.join("\n\n"));
		expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("previous-task:");
		expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("previous-answer:");
	});

	it("bypasses long history when no model or only one tier is available", async () => {
		for (const currentModel of [undefined, createModel({ reasoning: false }), createModel({ thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } })]) {
			const mocks = selectors();
			await planEffort({ ...input(), currentModel, history: longHistory }, mocks.complete, backend === "jev" ? mocks.select : undefined);
			expect(mocks.complete).not.toHaveBeenCalled();
			expect(mocks.select).not.toHaveBeenCalled();
		}
	});

	it.each([12_000, 12_001, 100_000])("preserves %i-character tasks in the request and reports no truncation", async (length) => {
		const mocks = selectors();
		const onDiagnostics = vi.fn();
		await planEffort({ ...input(), task: "t".repeat(length), history: longHistory, onDiagnostics }, mocks.complete, backend === "jev" ? mocks.select : undefined);
		const state = stateFrom(mocks);
		expect(state.task).toBe("t".repeat(length));
		expect(state.taskCharacters).toBe(length);
		expect(state.taskTruncated).toBe(false);
		expect(onDiagnostics.mock.lastCall?.[0].taskTruncated).toBe(false);
	});

	it("does not call either selector when already cancelled", async () => {
		const mocks = selectors();
		await expect(planEffort({ ...input(), signal: AbortSignal.abort(), history: longHistory }, mocks.complete, backend === "jev" ? mocks.select : undefined)).rejects.toThrow();
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.select).not.toHaveBeenCalled();
	});

	it("isolates routing from diagnostic observer mutation and failure", async () => {
		const mocks = selectors();
		await expect(planEffort({ ...input(), history: longHistory, onDiagnostics: (value) => {
			value.supportedEfforts.length = 0;
			if (value.context) value.context.sources.length = 0;
			throw new Error("Observer failed");
		} }, mocks.complete, backend === "jev" ? mocks.select : undefined)).resolves.toMatchObject({ status: "selected" });
		const state = stateFrom(mocks);
		expect(state.supportedEfforts).toContain("high");
		expect(state.recentConversation).toContain("private-previous-task");
	});
});
