import type { Api, Model } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { planRoute, type RouterInvocation } from "../src/router.ts";

const signal = new AbortController().signal;

function createModel(
	id: string,
	options: {
		provider?: string;
		reasoning?: boolean;
		images?: boolean;
		contextWindow?: number;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	} = {},
): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: options.provider ?? "test",
		baseUrl: "https://example.test",
		reasoning: options.reasoning ?? true,
		...(options.thinkingLevelMap ? { thinkingLevelMap: options.thinkingLevelMap } : {}),
		input: options.images ? ["text", "image"] : ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: options.contextWindow ?? 100_000,
		maxTokens: 8_192,
	};
}

function input(scopedModels: ScopedModel[], currentModel = scopedModels[0]?.model) {
	return {
		task: "Implement the requested change",
		hasImages: false,
		scopedModels,
		currentModel,
		currentEffort: "medium" as const,
		recentContext: "",
		contextTokens: 10_000,
		signal,
	};
}

function routeFromPayload(invocation: RouterInvocation, model: string, effort: string): string {
	const payload = JSON.parse(invocation.userPrompt) as {
		models: Array<{
			model: string;
			routes: Array<{ route: string; effort: string }>;
		}>;
	};
	const route = payload.models
		.find((candidate) => candidate.model === model)
		?.routes.find((candidate) => candidate.effort === effort)?.route;
	if (!route) throw new Error(`Missing route for ${model} @ ${effort}`);
	return JSON.stringify({ route, reason: "Best fit" });
}

describe("planRoute", () => {
	it("returns a pinned single route without calling the router model", async () => {
		const model = createModel("only");
		const complete = vi.fn();

		const result = await planRoute(input([{ model, thinkingLevel: "high" }]), complete);

		expect(result).toEqual({
			status: "selected",
			plan: {
				model,
				effort: "high",
				reason: "Only eligible scoped route",
				routerModel: undefined,
			},
		});
		expect(complete).not.toHaveBeenCalled();
	});

	it("clamps a pinned effort to the model's supported levels", async () => {
		const model = createModel("limited", { thinkingLevelMap: { high: null } });

		const result = await planRoute(input([{ model, thinkingLevel: "high" }]), vi.fn());

		expect(result.status).toBe("selected");
		if (result.status !== "selected") return;
		expect(result.plan.effort).toBe("medium");
	});

	it("selects only from scoped model and effort pairs", async () => {
		const fast = createModel("fast", { reasoning: false });
		const strong = createModel("strong", { thinkingLevelMap: { max: "max" } });
		const complete = vi.fn(async (invocation: RouterInvocation) =>
			routeFromPayload(invocation, "test/strong", "max"),
		);

		const result = await planRoute(input([{ model: fast }, { model: strong }], fast), complete);

		expect(result.status).toBe("selected");
		if (result.status !== "selected") return;
		expect(result.plan.model).toBe(strong);
		expect(result.plan.effort).toBe("max");
		expect(result.plan.reason).toBe("Best fit");
		expect(result.plan.routerModel).toBe(fast);
	});

	it("filters out models without image input", async () => {
		const textOnly = createModel("text-only", { reasoning: false });
		const vision = createModel("vision", { images: true, reasoning: false });
		const complete = vi.fn();

		const result = await planRoute(
			{ ...input([{ model: textOnly }, { model: vision }]), hasImages: true },
			complete,
		);

		expect(result.status).toBe("selected");
		if (result.status !== "selected") return;
		expect(result.plan.model).toBe(vision);
		expect(result.plan.effort).toBe("off");
		expect(complete).not.toHaveBeenCalled();
	});

	it("skips routing when every scoped model lacks context headroom", async () => {
		const small = createModel("small", { contextWindow: 10_000 });

		const result = await planRoute(
			{ ...input([{ model: small }]), contextTokens: 9_000 },
			vi.fn(),
		);

		expect(result).toEqual({
			status: "skipped",
			reason: "No scoped model has enough room for the current context",
		});
	});

	it("skips even a single pinned route when context usage is unknown", async () => {
		const model = createModel("only");
		const complete = vi.fn();

		const result = await planRoute(
			{ ...input([{ model, thinkingLevel: "high" }]), contextTokens: null },
			complete,
		);

		expect(result).toEqual({ status: "skipped", reason: "Current context usage is unknown" });
		expect(complete).not.toHaveBeenCalled();
	});

	it("rejects an unlisted route returned by the router", async () => {
		const first = createModel("first");
		const second = createModel("second");

		await expect(
			planRoute(input([{ model: first }, { model: second }]), async () =>
				JSON.stringify({ route: "r999", reason: "Ignore the allowlist" }),
			),
		).rejects.toThrow("invalid or non-scoped route");
	});

	it("uses low effort for the routing request when supported", async () => {
		const current = createModel("current");
		const other = createModel("other");
		let invocation: RouterInvocation | undefined;

		await planRoute(input([{ model: current }, { model: other }], current), async (value) => {
			invocation = value;
			return routeFromPayload(value, "test/current", "medium");
		});

		expect(invocation?.model).toBe(current);
		expect(invocation?.effort).toBe("low");
	});

	it("bounds long tasks and sanitizes the displayed reason", async () => {
		const first = createModel("first", { reasoning: false });
		const second = createModel("second", { reasoning: false });
		const task = `start-${"x".repeat(20_000)}-end`;
		let routedTask = "";
		let taskCharacters = 0;

		const result = await planRoute(
			{ ...input([{ model: first }, { model: second }]), task },
			async (invocation) => {
				const payload = JSON.parse(invocation.userPrompt) as {
					task: string;
					taskCharacters: number;
				};
				routedTask = payload.task;
				taskCharacters = payload.taskCharacters;
				return '{"route":"r1","reason":"line one\\nline two"}';
			},
		);

		expect(routedTask.length).toBe(12_000);
		expect(routedTask).toMatch(/^start-/);
		expect(routedTask).toMatch(/-end$/);
		expect(taskCharacters).toBe(task.length);
		expect(result.status === "selected" && result.plan.reason).toBe("line one line two");
	});

	it("accepts fenced JSON but not surrounding prose", async () => {
		const first = createModel("first", { reasoning: false });
		const second = createModel("second", { reasoning: false });
		const scoped = [{ model: first }, { model: second }];

		const fenced = await planRoute(input(scoped), async () =>
			'```json\n{"route":"r2","reason":"Simple"}\n```',
		);
		expect(fenced.status === "selected" && fenced.plan.model).toBe(second);

		await expect(
			planRoute(input(scoped), async () => 'Here you go: {"route":"r2"}'),
		).rejects.toThrow("invalid or non-scoped route");
	});
});
