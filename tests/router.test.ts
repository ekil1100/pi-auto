import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { planEffort, type RouterInvocation } from "../src/router.ts";

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
		recentContext: "",
		signal,
	};
}

describe("planEffort", () => {
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

		await planEffort({ ...input(model), recentContext: "Earlier task", hasImages: true }, async (value) => {
			invocation = value;
			return '{"effort":"medium"}';
		});

		expect(invocation?.model).toBe(model);
		expect(invocation?.signal).toBe(signal);
		expect(JSON.parse(invocation!.userPrompt)).toEqual({
			task: "Implement the requested change",
			taskCharacters: 30,
			hasImages: true,
			recentConversation: "Earlier task",
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
