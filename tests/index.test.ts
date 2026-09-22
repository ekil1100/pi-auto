import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, ImageContent, Model, ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionEvent,
	type ExtensionHandler,
	type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piAuto from "../src/index.ts";
import { JEV_MODEL, selectWithJev, classifyWithJev, type JevDecision, type JevTiming } from "../src/jev.ts";
import { DECISION_ENTRY_TYPE, readDecision } from "../src/selection-ui.ts";

vi.mock("../src/jev.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/jev.ts")>();
	return { ...actual, selectWithJev: vi.fn(), classifyWithJev: vi.fn() };
});

const jevDecision: JevDecision = { effort: "high", model: JEV_MODEL, confidence: 0.85, probabilities: { off: 0, minimal: 0, low: 0, medium: 0.15, high: 0.85 } };

beforeEach(() => {
	vi.stubEnv("TYPESAFE_API_KEY", undefined);
	vi.mocked(selectWithJev).mockReset().mockResolvedValue(jevDecision);
	vi.mocked(classifyWithJev).mockReset().mockImplementation(async (_key, { candidates }) => candidates.map(({ id }) => ({ id, importance: "useful" })));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function createModel(id = "current", overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function routerResponse(model: Model<Api>, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: '{"effort":"high","reason":"Best fit"}' }],
		stopReason: "stop",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function createHarness(
	currentModel: Model<Api> | undefined,
	scopedModels: ScopedModel[] = [],
	sessionManager = SessionManager.inMemory(process.cwd()),
) {
	let activeModel = currentModel;
	let activeEffort: ModelThinkingLevel = currentModel?.reasoning ? "medium" : "off";
	const handlers = new Map<string, ExtensionHandler<ExtensionEvent>>();
	const complete = vi.fn(async (
		model: Model<Api>,
		_context: Context,
		_options?: SimpleStreamOptions,
	): Promise<AssistantMessage> => routerResponse(model));
	const provider = {
		streamSimple: vi.fn((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ({
			result: () => complete(model, context, options),
		})),
	};
	const getApiKeyAndHeaders = vi.fn<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>(async () => ({
		ok: true, apiKey: "test-key",
	}));
	const pi = {
		registerCommand: vi.fn<ExtensionAPI["registerCommand"]>(),
		registerEntryRenderer: vi.fn<ExtensionAPI["registerEntryRenderer"]>(),
		appendEntry: vi.fn((type: string, data: unknown) => { sessionManager.appendCustomEntry(type, data); }),
		on: (name: string, handler: ExtensionHandler<ExtensionEvent>) => handlers.set(name, handler),
		setModel: vi.fn(async (model: Model<Api>) => { activeModel = model; return true; }),
		setThinkingLevel: vi.fn((effort: ModelThinkingLevel) => { activeEffort = effort; }),
	};
	const ctx = {
		mode: "rpc" as ExtensionContext["mode"],
		get model() { return activeModel; },
		get thinkingLevel() { return activeEffort; },
		scopedModels,
		sessionManager,
		modelRegistry: { getProvider: vi.fn(() => provider), getApiKeyAndHeaders },
		ui: {
			custom: vi.fn<ExtensionContext["ui"]["custom"]>().mockResolvedValue(undefined),
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: {
				fg: vi.fn((_color: string, text: string) => text),
				getThinkingBorderColor: vi.fn((_level: ModelThinkingLevel) => (text: string) => text),
			},
		},
		getContextUsage: vi.fn(() => undefined),
	};
	piAuto(pi as unknown as ExtensionAPI);

	async function emit(event: ExtensionEvent) {
		await handlers.get(event.type)?.(event, ctx as unknown as ExtensionContext);
	}

	return {
		pi,
		emit,
		ctx,
		complete,
		provider,
		getApiKeyAndHeaders,
		async command(args: string) {
			const command = pi.registerCommand.mock.calls.find(([name]) => name === "auto")?.[1];
			if (!command) throw new Error("Missing auto command");
			await command.handler(args, ctx as unknown as ExtensionCommandContext);
		},
		async start(prompt: string, images?: ImageContent[]) {
			await emit({
				type: "before_agent_start",
				prompt,
				...(images ? { images } : {}),
				systemPrompt: "Test system prompt",
				systemPromptOptions: { cwd: process.cwd() },
			});
		},
	};
}

function requestPayload(harness: ReturnType<typeof createHarness>) {
	const content = harness.complete.mock.calls[0]?.[1].messages[0]?.content;
	if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Missing selection payload");
	return JSON.parse(content[0].text) as {
		task: string;
		taskCharacters: number;
		hasImages: boolean;
		model: { id: string };
		supportedEfforts: string[];
	};
}

function decisions(harness: ReturnType<typeof createHarness>) {
	return harness.ctx.sessionManager.getBranch().flatMap((entry) => {
		const decision = readDecision(entry);
		return decision ? [decision] : [];
	});
}

const image: ImageContent = { type: "image", data: "private-image-data", mimeType: "image/png" };

describe("Jev lifecycle", () => {
	it.each([undefined, "", " \t "])("uses the current model when the key is %j", async (key) => {
		vi.stubEnv("TYPESAFE_API_KEY", key);
		const harness = createHarness(createModel());

		await harness.start("Continue");

		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(selectWithJev).not.toHaveBeenCalled();
	});

	it("uses Jev with a nonempty key and records the actual selector, not an effort", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", " test-typesafe-key ");
		const model = createModel();
		const harness = createHarness(model);
		harness.ctx.sessionManager.appendMessage({ role: "user", content: "Earlier task", timestamp: Date.now() });

		await harness.start(`start-${"x".repeat(20_000)}-end`, [image]);
		await harness.command("status");

		expect(harness.ctx.model).toBe(model);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.getApiKeyAndHeaders).not.toHaveBeenCalled();
		const [key, invocation] = vi.mocked(selectWithJev).mock.calls[0]!;
		expect(key).toBe("test-typesafe-key");
		expect(invocation.state).toMatchObject({
			hasImages: true, model: { id: "test/current" }, currentEffort: "medium",
			supportedEfforts: ["off", "minimal", "low", "medium", "high"],
		});
		expect(invocation.state.recentConversation).toContain("Earlier task");
		expect(invocation.state.task).toHaveLength(12_000);
		expect(invocation.state.task).toMatch(/^start-/);
		expect(invocation.state.task).toMatch(/-end$/);
		expect(JSON.stringify(invocation.state)).not.toContain(image.data);
		expect(decisions(harness)[0]).toMatchObject({
			status: "selected", model: "test/current", effort: "high", routerEffort: undefined,
			routerModel: `typesafe/${JEV_MODEL}`, routerConfidence: 0.85, reason: "Selected by Jev Choice",
		});
		const status = harness.ctx.ui.notify.mock.lastCall?.[0];
		expect(status).toContain(`Selector: typesafe/${JEV_MODEL}`);
		expect(status).toContain("Confidence: 0.850 (not success probability)");
		expect(status).not.toContain("not called");
		expect(JSON.stringify(decisions(harness))).not.toContain(key);
		expect(harness.ctx.sessionManager.buildSessionContext().messages).toHaveLength(1);
	});

	it("persists timing snapshots and exposes them through status", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		const timing: JevTiming = { setupMs: 1, headersMs: 500, bodyAndDecodeMs: 2, validateMs: 0.1, totalMs: 503.1, requestBytes: 2000,
			transport: { status: "observed", requestCount: 1, connection: "new", socketId: 1, connectMs: 350, afterUploadMs: 140 } };
		vi.mocked(selectWithJev).mockImplementationOnce(async (_key, invocation) => {
			invocation.onTiming?.(timing);
			return jevDecision;
		});
		const harness = createHarness(createModel());
		await harness.start("Continue");
		await harness.command("status");

		expect(decisions(harness)[0]).toMatchObject({ prepareMs: expect.any(Number), jevTiming: timing });
		expect(harness.ctx.ui.notify.mock.lastCall?.[0]).toContain("headers 500.0ms");
		expect(harness.ctx.ui.notify.mock.lastCall?.[0]).toContain("connection new\nsocket #1\nconnect 350.0ms\nafter-upload 140.0ms");
		timing.totalMs = 999;
		timing.transport!.connectMs = 999;
		expect(decisions(harness)[0]?.jevTiming?.totalMs).toBe(503.1);
		expect(decisions(harness)[0]?.jevTiming?.transport?.connectMs).toBe(350);
	});

	it.each(["no model", "single effort", "disabled"])("does not call either selector for %s", async (scenario) => {
		vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		const harness = createHarness(scenario === "no model" ? undefined : createModel("plain", { reasoning: false }));
		if (scenario === "disabled") await harness.command("off");

		await harness.start("Continue");

		expect(selectWithJev).not.toHaveBeenCalled();
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("reads the key for each task, without leaking a previous selector's confidence", async () => {
		const harness = createHarness(createModel());
		await harness.start("First task");
		vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		await harness.start("Second task");
		vi.stubEnv("TYPESAFE_API_KEY", "");
		await harness.start("Third task");

		expect(harness.complete).toHaveBeenCalledTimes(2);
		expect(selectWithJev).toHaveBeenCalledTimes(1);
		expect(decisions(harness).map((decision) => decision.routerConfidence)).toEqual([undefined, 0.85, undefined]);
	});

	it.each(["Jev request failed (HTTP 401)", "Jev request failed (HTTP 429)", "Jev returned an invalid decision"])("keeps effort without fallback on %s", async (message) => {
		vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		vi.mocked(selectWithJev).mockRejectedValueOnce(new Error(message));
		const harness = createHarness(createModel());

		await harness.start("Continue");

		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: message, routerModel: `typesafe/${JEV_MODEL}` });
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
	});

	it("times out without fallback and never applies a late Jev result", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		try {
			let resolve!: (decision: JevDecision) => void;
			vi.mocked(selectWithJev).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
			const harness = createHarness(createModel());
			const pending = harness.start("Continue");
			await vi.waitFor(() => expect(selectWithJev).toHaveBeenCalled());
			controller.abort();
			await pending;
			resolve(jevDecision);
			await Promise.resolve();

			expect(vi.mocked(selectWithJev).mock.calls[0]?.[1].signal.aborted).toBe(true);
			expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
			expect(harness.complete).not.toHaveBeenCalled();
			expect(decisions(harness)).toEqual([expect.objectContaining({ status: "kept", reason: "router timed out" })]);
			expect(decisions(harness)[0]?.routerConfidence).toBeUndefined();
		} finally {
			timeout.mockRestore();
		}
	});

	it("does not mutate persisted partial timings when a timed-out request finishes late", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		try {
			let resolve!: (decision: JevDecision) => void;
			vi.mocked(selectWithJev).mockImplementationOnce((_key, invocation) => {
				invocation.onTiming?.({ setupMs: 1 });
				return new Promise((done) => { resolve = done; });
			});
			const harness = createHarness(createModel());
			const pending = harness.start("Continue");
			await vi.waitFor(() => expect(selectWithJev).toHaveBeenCalled());
			controller.abort();
			await pending;
			vi.mocked(selectWithJev).mock.calls[0]?.[1].onTiming?.({ setupMs: 1, totalMs: 25_000 });
			resolve(jevDecision);
			await Promise.resolve();
			expect(decisions(harness)[0]?.jevTiming).toEqual({ setupMs: 1 });
			expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
		}
	});

	it.each(["model", "effort", "off", "off-on", "shutdown"])("discards Jev results after a manual %s change", async (change) => {
		vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		let resolve!: (decision: JevDecision) => void;
		vi.mocked(selectWithJev).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const harness = createHarness(createModel());
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(selectWithJev).toHaveBeenCalled());
		if (change === "model") await harness.pi.setModel(createModel("next"));
		if (change === "effort") harness.pi.setThinkingLevel("low");
		if (change === "off" || change === "off-on") await harness.command("off");
		if (change === "off-on") await harness.command("on");
		if (change === "shutdown") await harness.emit({ type: "session_shutdown", reason: "reload" });
		if (["off", "off-on", "shutdown"].includes(change)) await pending;
		resolve(jevDecision);
		await pending;
		await Promise.resolve();

		expect(harness.ctx.thinkingLevel).toBe(change === "effort" ? "low" : "medium");
		expect(harness.pi.setThinkingLevel).toHaveBeenCalledTimes(change === "effort" ? 1 : 0);
		expect(harness.complete).not.toHaveBeenCalled();
		if (change === "shutdown") expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		else expect(decisions(harness)[0]?.status).toBe(change.startsWith("off") ? "cancelled" : "kept");
	});
});

describe("pi-auto lifecycle", () => {
	it("shows the current effort with primary auto and native effort colors on startup", async () => {
		const harness = createHarness(createModel());

		await harness.emit({ type: "session_start", reason: "startup" });

		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · medium");
		expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("accent", "auto");
		expect(harness.ctx.ui.theme.getThinkingBorderColor).toHaveBeenCalledWith("medium");
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("toggles with bare auto or explicit toggle, without changing effort", async () => {
		const harness = createHarness(createModel());

		await harness.command("");
		await harness.start("Continue");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);

		await harness.command("");
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · medium");
		await harness.command("toggle");
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("updates the footer after manual effort and model changes, but hides it when disabled", async () => {
		const current = createModel();
		const next = createModel("next", { reasoning: false });
		const harness = createHarness(current);

		harness.pi.setThinkingLevel("low");
		await harness.emit({ type: "thinking_level_select", level: "low", previousLevel: "medium" });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · low");

		await harness.pi.setModel(next);
		harness.pi.setThinkingLevel("off");
		await harness.emit({ type: "model_select", model: next, previousModel: current, source: "set" });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · off");

		await harness.command("off");
		await harness.emit({ type: "thinking_level_select", level: "off", previousLevel: "low" });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
	});

	it("selects effort without scoped models or context usage", async () => {
		const current = createModel();
		const harness = createHarness(current);

		await harness.start("Implement the change");

		expect(harness.ctx.model).toBe(current);
		expect(harness.ctx.thinkingLevel).toBe("high");
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(harness.ctx.getContextUsage).not.toHaveBeenCalled();
		expect(harness.complete.mock.calls[0]?.[0]).toBe(current);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · high");
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
		expect(harness.pi.registerEntryRenderer).toHaveBeenCalledWith(DECISION_ENTRY_TYPE, expect.any(Function));
		expect(decisions(harness)).toEqual([expect.objectContaining({
			status: "selected", model: "test/current", previousEffort: "medium", effort: "high",
			reason: "Best fit", routerModel: "test/current", routerEffort: "low", elapsedMs: expect.any(Number),
		})]);
		expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("accent", "auto");
		expect(harness.ctx.ui.theme.getThinkingBorderColor).toHaveBeenCalledWith("high");
	});

	it("shows progress while the request is pending without adding model context", async () => {
		const current = createModel();
		const harness = createHarness(current);
		let resolve!: (response: AssistantMessage) => void;
		harness.complete.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));

		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(harness.complete).toHaveBeenCalled());
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", expect.any(Function));
		expect(decisions(harness)).toEqual([]);

		resolve(routerResponse(current));
		await pending;

		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
		expect(decisions(harness)).toHaveLength(1);
		expect(harness.ctx.sessionManager.buildSessionContext().messages).toEqual([]);
	});

	it("completes the progress row even when the selected effort is unchanged", async () => {
		const current = createModel();
		const harness = createHarness(current);
		harness.complete.mockResolvedValueOnce(routerResponse(current, { content: [{ type: "text", text: '{"effort":"medium"}' }] }));

		await harness.start("Continue");

		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ status: "selected", effort: "medium" });
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
	});

	it("ignores scoped candidates and pinned efforts", async () => {
		const current = createModel();
		const other = createModel("other");
		const harness = createHarness(current, [{ model: other }, { model: current, thinkingLevel: "low" }]);

		await harness.start("Debug the failure");

		expect(harness.ctx.model).toBe(current);
		expect(harness.ctx.thinkingLevel).toBe("high");
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(requestPayload(harness).model.id).toBe("test/current");
		expect(JSON.stringify(requestPayload(harness))).not.toContain("other");
	});

	it("uses the current model even when it is outside the scope", async () => {
		const current = createModel();
		const harness = createHarness(current, [{ model: createModel("other") }]);

		await harness.start("Debug the failure");

		expect(harness.complete.mock.calls[0]?.[0]).toBe(current);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
	});

	it("keeps non-reasoning models at off without requesting a decision", async () => {
		const current = createModel("plain", { reasoning: false });
		const harness = createHarness(current);

		await harness.start("Implement the change");

		expect(harness.ctx.thinkingLevel).toBe("off");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ effort: "off", routerEffort: undefined });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · off");
		expect(harness.ctx.ui.theme.getThinkingBorderColor).toHaveBeenCalledWith("off");
	});

	it("skips when no model is selected", async () => {
		const harness = createHarness(undefined);

		await harness.start("Continue");

		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: expect.stringContaining("No current model") });
	});

	it.each(["openai-responses", "anthropic-messages", "google-generative-ai"] as const)("uses provider-neutral low effort for %s even when the agent is off", async (api) => {
		const harness = createHarness(createModel("current", { api }));
		harness.pi.setThinkingLevel("off");

		await harness.start("Debug this");

		expect(harness.complete.mock.calls[0]?.[2]?.reasoning).toBe("low");
		expect(harness.ctx.thinkingLevel).toBe("high");
		expect(harness.pi.setModel).not.toHaveBeenCalled();
	});

	it("passes resolved authentication, headers, base URL and environment to the provider", async () => {
		const model = createModel();
		const harness = createHarness(model);
		const headers = { "x-custom-auth": "test-token" };
		const env = { TEST_PROVIDER_REGION: "test-region" };
		harness.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: true, apiKey: "resolved-key", headers, env, baseUrl: "https://proxy.test" });

		await harness.start("Continue");

		expect(harness.getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(harness.complete.mock.calls[0]?.[0].baseUrl).toBe("https://proxy.test");
		expect(harness.complete.mock.calls[0]?.[2]).toMatchObject({ apiKey: "resolved-key", headers, env, cacheRetention: "none" });
		expect(harness.ctx.model).toBe(model);
	});

	it.each([
		{ modelMax: 8_192, budget: 2_048 },
		{ modelMax: 512, budget: 512 },
	])("requests a $budget-token budget for a $modelMax-token model", async ({ modelMax, budget }) => {
		const harness = createHarness(createModel("current", { maxTokens: modelMax }));

		await harness.start("Fix the typo");

		expect(harness.complete.mock.calls[0]?.[2]?.maxTokens).toBe(budget);
	});

	it("clips long tasks instead of switching to a larger model", async () => {
		const current = createModel("small", { contextWindow: 10_000 });
		const harness = createHarness(current, [{ model: createModel("large") }]);

		await harness.start("x".repeat(32_000));

		expect(harness.ctx.model).toBe(current);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(requestPayload(harness).task.length).toBe(12_000);
		expect(requestPayload(harness).taskCharacters).toBe(32_000);
	});

	it("reports images without sending image data or choosing a vision model", async () => {
		const current = createModel();
		const harness = createHarness(current);

		await harness.start("Look", [image]);

		expect(requestPayload(harness).hasImages).toBe(true);
		expect(JSON.stringify(requestPayload(harness))).not.toContain(image.data);
		expect(harness.ctx.model).toBe(current);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
	});

	it.each(["model", "jev"] as const)("selects with %s after an image-only turn even when an older task exceeds the candidate budget", async (backend) => {
		if (backend === "jev") vi.stubEnv("TYPESAFE_API_KEY", "test-typesafe-key");
		const model = createModel();
		const harness = createHarness(model);
		const session = harness.ctx.sessionManager;
		session.appendMessage({ role: "user", content: "old-task ".repeat(3_000), timestamp: Date.now() });
		session.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
		session.appendMessage(routerResponse(model, { content: [{ type: "text", text: "The screenshot shows a connection error." }] }));

		await harness.start("Continue investigating the screenshot");

		expect(decisions(harness)[0]).toMatchObject({ status: "selected", effort: "high", routing: {
			compaction: { status: "bypassed", candidatesTruncated: true, candidateCount: 1, selectedCount: 1 },
		} });
		expect(harness.complete).toHaveBeenCalledTimes(backend === "model" ? 1 : 0);
		expect(selectWithJev).toHaveBeenCalledTimes(backend === "jev" ? 1 : 0);
		expect(classifyWithJev).not.toHaveBeenCalled();
		const state = backend === "jev" ? vi.mocked(selectWithJev).mock.calls[0]![1].state
			: JSON.parse((harness.complete.mock.calls[0]![1].messages[0]!.content[0] as { text: string }).text);
		expect(state.hasImages).toBe(true);
		expect(state.recentConversation).toContain("The screenshot shows a connection error.");
		expect(state.recentConversation).toContain("partialTurn=true");
		expect(JSON.stringify(state)).not.toContain(image.data);
		expect(JSON.stringify(state)).not.toContain("old-task");
	});

	it.each(["user", "toolResult", "custom_message"] as const)("reports historical %s images without sending their data", async (type) => {
		const harness = createHarness(createModel());
		const content = [{ type: "text" as const, text: "private result text" }, image];
		if (type === "user") {
			harness.ctx.sessionManager.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
		} else if (type === "toolResult") {
			harness.ctx.sessionManager.appendMessage({
				role: "toolResult", toolCallId: "read-image", toolName: "read", content,
				isError: false, timestamp: Date.now(),
			});
		} else {
			harness.ctx.sessionManager.appendCustomMessageEntry("image-context", content, false);
		}

		await harness.start("Use the image above");

		const payload = requestPayload(harness);
		expect(payload.hasImages).toBe(true);
		expect(JSON.stringify(payload)).not.toContain(image.data);
		expect(JSON.stringify(payload)).not.toContain("private result text");
	});

	it.each([true, false])("honors compaction boundaries when an image is retained: %s", async (retained) => {
		const model = createModel();
		const harness = createHarness(model);
		const session = harness.ctx.sessionManager;
		const imageId = session.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
		const textId = session.appendMessage({ role: "user", content: "New task", timestamp: Date.now() });
		session.appendCompaction("Earlier work", retained ? imageId : textId, 90_000);
		session.appendMessage(routerResponse(model, { content: [{ type: "text", text: "Ready" }] }));

		await harness.start("Continue");

		expect(requestPayload(harness).hasImages).toBe(retained);
		expect(harness.ctx.model).toBe(model);
	});

	it("ignores images in abandoned branches and extension state entries", async () => {
		const harness = createHarness(createModel());
		const session = harness.ctx.sessionManager;
		const root = session.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
		session.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
		session.branch(root);
		session.appendCustomEntry("image-cache", { content: [image] });

		await harness.start("Fix the typo");

		expect(requestPayload(harness).hasImages).toBe(false);
	});

	it.each(["length", "aborted", "error"] as const)("preserves model and effort on a %s response even if JSON parses", async (stopReason) => {
		const current = createModel();
		const harness = createHarness(current);
		harness.complete.mockResolvedValueOnce(routerResponse(current, { stopReason, errorMessage: "Request failed" }));

		await harness.start("Fix the typo");

		expect(harness.ctx.model).toBe(current);
		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", effort: "medium", routerEffort: "low" });
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · medium");
	});

	it.each(["", '{"effort":"invalid"}', '{"route":"r1"}'])("preserves effort on an invalid decision: %s", async (text) => {
		const current = createModel();
		const harness = createHarness(current);
		harness.complete.mockResolvedValueOnce(routerResponse(current, { content: [{ type: "text", text }] }));

		await harness.start("Fix the typo");

		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.pi.setModel).not.toHaveBeenCalled();
	});

	it("keeps the effort when authentication is unavailable", async () => {
		const harness = createHarness(createModel());
		harness.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, error: "No API key" });

		await harness.start("Continue");

		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: "router authentication failed" });
	});

	it.each(["auth-result", "auth-rejection", "provider-sync", "provider-rejection"])("never persists echoed credentials from %s", async (failure) => {
		const harness = createHarness(createModel());
		const privateBody = "HTTP 400 private-body api_key=secret-canary";
		if (failure === "auth-result") harness.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, error: privateBody });
		if (failure === "auth-rejection") harness.getApiKeyAndHeaders.mockRejectedValueOnce(new Error(privateBody));
		if (failure === "provider-sync") harness.provider.streamSimple.mockImplementationOnce(() => { throw new Error(privateBody); });
		if (failure === "provider-rejection") harness.complete.mockRejectedValueOnce(new Error(privateBody));
		await harness.start("Continue");
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: failure.startsWith("auth") ? "router authentication failed" : "router request failed" });
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).not.toContain("secret-canary");
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).not.toContain("private-body");
	});

	it("stops waiting on a timeout and never applies a late decision", async () => {
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		try {
			const model = createModel();
			const harness = createHarness(model);
			let resolve!: (response: AssistantMessage) => void;
			harness.complete.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));

			const pending = harness.start("Continue");
			await vi.waitFor(() => expect(harness.complete).toHaveBeenCalled());
			controller.abort();
			await pending;
			resolve(routerResponse(model));
			await Promise.resolve();

			expect(timeout).toHaveBeenCalledWith(10_000);
			expect(harness.complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
			expect(harness.ctx.thinkingLevel).toBe("medium");
			expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
			expect(decisions(harness)).toEqual([expect.objectContaining({ status: "kept", reason: "router timed out" })]);
			expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
		} finally {
			timeout.mockRestore();
		}
	});

	it("does not start a request after authentication outlives the timeout", async () => {
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		try {
			const harness = createHarness(createModel());
			let resolve!: (value: { ok: true; apiKey: string }) => void;
			harness.getApiKeyAndHeaders.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));

			const pending = harness.start("Continue");
			controller.abort();
			await pending;
			resolve({ ok: true, apiKey: "test-key" });
			await Promise.resolve();

			expect(harness.complete).not.toHaveBeenCalled();
			expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
		}
	});

	it("does not apply an old decision after the user changes models", async () => {
		const current = createModel();
		const next = createModel("next");
		const harness = createHarness(current);
		harness.complete.mockImplementationOnce(async () => {
			await harness.pi.setModel(next);
			return routerResponse(current);
		});

		await harness.start("Continue");

		expect(harness.ctx.model).toBe(next);
		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.pi.setModel).toHaveBeenCalledTimes(1);
	});

	it("does not overwrite a manual effort change during selection", async () => {
		const current = createModel();
		const harness = createHarness(current);
		harness.complete.mockImplementationOnce(async () => {
			harness.pi.setThinkingLevel("low");
			return routerResponse(current);
		});

		await harness.start("Continue");

		expect(harness.ctx.thinkingLevel).toBe("low");
		expect(harness.pi.setThinkingLevel).toHaveBeenCalledTimes(1);
	});

	it("supports on/off/status without scoped models", async () => {
		const harness = createHarness(createModel());

		await harness.command("off");
		await harness.start("Continue");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith("pi-auto disabled", "info");

		await harness.command("on");
		await harness.start("Continue");
		await harness.command("status");

		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("effort only"), "info");
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Selector effort: low"), "info");
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Supported efforts: off, minimal, low, medium, high"), "info");
	});

	it("opens a read-only overlay for TUI status without changing effort or calling a selector", async () => {
		const harness = createHarness(createModel());
		harness.ctx.mode = "tui";
		await harness.start("Continue");
		const before = decisions(harness);
		harness.complete.mockClear();
		harness.pi.setThinkingLevel.mockClear();
		harness.pi.appendEntry.mockClear();

		await harness.command("status");

		expect(harness.ctx.ui.custom).toHaveBeenCalledWith(expect.any(Function), {
			overlay: true, overlayOptions: { width: 96, maxHeight: "80%", margin: 1 },
		});
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
		expect(harness.complete).not.toHaveBeenCalled();
		expect(selectWithJev).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(decisions(harness)).toEqual(before);
	});

	it("restores decision details from saved session history without adding model context", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-auto-history-"));
		try {
			const current = createModel();
			const session = SessionManager.create(process.cwd(), directory);
			const harness = createHarness(current, [], session);
			await harness.start("Continue");
			session.appendMessage(routerResponse(current, { content: [{ type: "text", text: "Task complete" }] }));

			const loaded = SessionManager.open(session.getSessionFile()!);
			const restored = createHarness(current, [], loaded);
			await restored.emit({ type: "session_start", reason: "resume" });
			await restored.command("status");

			expect(decisions(restored)).toEqual(decisions(harness));
			expect(restored.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Reason: Best fit"), "info");
			expect(loaded.buildSessionContext().messages).toHaveLength(1);
			expect(loaded.buildSessionContext().messages[0]?.role).toBe("assistant");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not report a decision from an abandoned branch", async () => {
		const harness = createHarness(createModel());
		const session = harness.ctx.sessionManager;
		const root = session.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
		await harness.start("Continue");
		const oldLeafId = session.getLeafId();
		session.branch(root);

		await harness.emit({ type: "session_tree", newLeafId: root, oldLeafId });
		await harness.command("status");

		expect(decisions(harness)).toEqual([]);
		expect(harness.ctx.ui.notify.mock.lastCall?.[0]).not.toContain("Last decision:");
	});

	it("does not apply an old decision after toggling off and back on", async () => {
		const current = createModel();
		const harness = createHarness(current);
		harness.complete.mockImplementationOnce(async () => {
			await harness.command("");
			await harness.command("");
			return routerResponse(current);
		});

		await harness.start("Continue");

		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(decisions(harness)).toEqual([expect.objectContaining({ status: "cancelled" })]);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · medium");
	});

	it("clears pending UI and avoids stale history writes during shutdown", async () => {
		const current = createModel();
		const harness = createHarness(current);
		let resolve!: (response: AssistantMessage) => void;
		harness.complete.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(harness.complete).toHaveBeenCalled());

		await harness.emit({ type: "session_shutdown", reason: "reload" });
		await pending;
		resolve(routerResponse(current));
		await Promise.resolve();

		expect(harness.complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("discards an in-flight decision if auto is disabled", async () => {
		const current = createModel();
		const harness = createHarness(current);
		harness.complete.mockImplementationOnce(async () => {
			await harness.command("off");
			return routerResponse(current);
		});

		await harness.start("Continue");

		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith("pi-auto disabled", "info");
		expect(decisions(harness)).toEqual([expect.objectContaining({ status: "cancelled", effort: "medium" })]);
	});
});

type Backend = "model" | "jev";
type Phase = "context" | "effort";

function twoStageHarness(backend: Backend, pausedPhase?: Phase, model = createModel()) {
	vi.stubEnv("TYPESAFE_API_KEY", backend === "jev" ? "test-typesafe-key" : undefined);
	const harness = createHarness(model);
	const history = ["old-private-history", "active-private-history", "recent-private-history"].map((prefix) => prefix.padEnd(2_500, "x"));
	const entryIds = history.map((content) => harness.ctx.sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() }));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const phases: Phase[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	const wait = async (phase: Phase, signal?: AbortSignal) => {
		phases.push(phase);
		signals.push(signal);
		if (phase === pausedPhase) await gate; // Deliberately ignore abort to simulate a late backend.
	};
	const ratings = (candidates: readonly { id: string }[]) => candidates.map(({ id }, index) => ({
		id, importance: index === 1 ? "required" as const : "irrelevant" as const,
	}));
	harness.complete.mockImplementation(async (current, context, options) => {
		const content = context.messages[0]!.content;
		if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Missing request");
		const state = JSON.parse(content[0].text);
		const phase = state.candidates ? "context" : "effort";
		await wait(phase, options?.signal);
		return routerResponse(current, {
			content: [{ type: "text", text: state.candidates ? JSON.stringify(ratings(state.candidates)) : '{"effort":"high"}' }],
			usage: { input: 120, output: 15, cacheRead: 3, cacheWrite: 2, totalTokens: 140,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
		});
	});
	vi.mocked(classifyWithJev).mockImplementation(async (_key, invocation) => {
		invocation.onTiming?.({ setupMs: 1 });
		await wait("context", invocation.signal);
		invocation.onTiming?.({ setupMs: 1, totalMs: 15, inputTokens: 120, outputTokens: 3 });
		invocation.onDecisions?.(ratings(invocation.candidates).map((rating) => ({ ...rating, confidence: 1,
			probabilities: { required: rating.importance === "required" ? 1 : 0, useful: 0, background: 0, irrelevant: rating.importance === "irrelevant" ? 1 : 0 },
		})));
		return ratings(invocation.candidates);
	});
	vi.mocked(selectWithJev).mockImplementation(async (_key, invocation) => {
		invocation.onTiming?.({ setupMs: 2 });
		await wait("effort", invocation.signal);
		invocation.onTiming?.({ setupMs: 2, totalMs: 20, inputTokens: 100, outputTokens: 1 });
		return jevDecision;
	});
	return { ...harness, history, entryIds, phases, signals, release };
}

describe("two-stage lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Native AbortSignal.timeout uses real timers; bridge only that clock boundary.
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), milliseconds);
			return controller.signal;
		});
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each(["model", "jev"] as const)("shares one 10-second budget when %s classification takes 5 seconds", async (backend) => {
		const harness = twoStageHarness(backend, "effort");
		const classifyDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 5_000));
		if (backend === "jev") {
			const classify = vi.mocked(classifyWithJev).getMockImplementation()!;
			vi.mocked(classifyWithJev).mockImplementation(async (...args) => { await classifyDelay(); return classify(...args); });
		} else {
			const complete = harness.complete.getMockImplementation()!;
			harness.complete.mockImplementation(async (...args) => {
				if (harness.complete.mock.calls.length === 1) await classifyDelay();
				return complete(...args);
			});
		}
		const pending = harness.start("Continue");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(harness.phases).toEqual(["context", "effort"]);
		const selectionSignal = backend === "jev" ? vi.mocked(selectWithJev).mock.calls[0]![1].signal : harness.complete.mock.calls[1]![2]!.signal;
		expect(selectionSignal).toBe(harness.signals[0]);
		expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(10_000);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(selectionSignal?.aborted).toBe(true);
		expect(decisions(harness)).toEqual([expect.objectContaining({ status: "kept", reason: "router timed out", elapsedMs: 10_000,
			routing: expect.objectContaining({ compaction: expect.objectContaining({ status: "extracted", elapsedMs: 5_000 }) }) })]);
		if (backend === "jev") expect(decisions(harness)[0]?.jevTiming).toEqual({ setupMs: 2 });
		const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
		harness.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).toBe(saved);
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.ctx.thinkingLevel).toBe("medium");
		if (backend === "jev") expect(harness.complete).not.toHaveBeenCalled();
		else expect(selectWithJev).not.toHaveBeenCalled();
	});

	it.each(["model", "jev"] as const)("never launches selection after a %s classifier ignores the deadline", async (backend) => {
		const harness = twoStageHarness(backend, "context");
		const pending = harness.start("Continue");
		await vi.advanceTimersByTimeAsync(10_000);
		await pending;
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: "router timed out", routing: { compaction: { status: "extracting" } } });
		expect(decisions(harness)[0]?.routing?.compaction).not.toHaveProperty("elapsedMs");
		const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
		harness.release();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(harness.phases).toEqual(["context"]);
		expect(selectWithJev).not.toHaveBeenCalled();
		expect(harness.complete).toHaveBeenCalledTimes(backend === "model" ? 1 : 0);
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).toBe(saved);
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
	});

	for (const backend of ["model", "jev"] as const) {
		for (const phase of ["context", "effort"] as const) {
			it.each(["model", "effort", "off-on", "shutdown"] as const)(`invalidates ${backend} ${phase} after %s even when settings return to their original values`, async (change) => {
				const original = createModel();
				const harness = twoStageHarness(backend, phase, original);
				const pending = harness.start("Continue");
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.phases.at(-1)).toBe(phase);
				if (change === "model") {
					const next = createModel("next");
					await harness.pi.setModel(next);
					await harness.emit({ type: "model_select", model: next, previousModel: original, source: "set" });
					await harness.pi.setModel(original);
					await harness.emit({ type: "model_select", model: original, previousModel: next, source: "set" });
				} else if (change === "effort") {
					harness.pi.setThinkingLevel("low");
					await harness.emit({ type: "thinking_level_select", level: "low", previousLevel: "medium" });
					harness.pi.setThinkingLevel("medium");
					await harness.emit({ type: "thinking_level_select", level: "medium", previousLevel: "low" });
				} else if (change === "off-on") {
					await harness.command("off");
					await harness.command("on");
				} else await harness.emit({ type: "session_shutdown", reason: "reload" });
				await pending;
				expect(harness.signals.at(-1)?.aborted).toBe(true);
				if (change === "shutdown") expect(harness.pi.appendEntry).not.toHaveBeenCalled();
				else expect(decisions(harness)).toEqual([expect.objectContaining({
					status: change === "off-on" ? "cancelled" : "kept",
					reason: change === "off-on" ? "Auto disabled during selection" : "Model, effort or session changed during selection",
				})]);
				const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
				harness.release();
				await vi.advanceTimersByTimeAsync(0);
				expect(harness.phases).toEqual(phase === "context" ? ["context"] : ["context", "effort"]);
				expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).toBe(saved);
				expect(harness.ctx.model).toBe(original);
				expect(harness.ctx.thinkingLevel).toBe("medium");
				expect(harness.pi.setThinkingLevel).toHaveBeenCalledTimes(change === "effort" ? 2 : 0);
				expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
				if (change === "shutdown") {
					await harness.start("New task after shutdown");
					expect(harness.pi.appendEntry).not.toHaveBeenCalled();
				}
			});
		}
	}

	it.each(["model", "jev"] as const)("keeps effort when %s required context overflows without selecting or falling back", async (backend) => {
		const harness = twoStageHarness(backend);
		if (backend === "jev") vi.mocked(classifyWithJev).mockImplementationOnce(async (_key, { candidates }) => candidates.map(({ id }) => ({ id, importance: "required" })));
		else harness.complete.mockImplementationOnce(async (model, context) => {
			const content = context.messages[0]!.content;
			if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Missing request");
			const { candidates } = JSON.parse(content[0].text) as { candidates: { id: string }[] };
			return routerResponse(model, { content: [{ type: "text", text: JSON.stringify(candidates.map(({ id }) => ({ id, importance: "required" }))) }] });
		});
		await harness.start("Continue");
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: "required_context_exceeds_budget", effort: "medium",
			routing: { compaction: { status: "failed", selectedCount: 0, sources: [], ratings: [
				{ id: "c0:0:2500", importance: "required" }, { id: "c1:0:2500", importance: "required" }, { id: "c2:0:2500", importance: "required" },
			] } } });
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(selectWithJev).not.toHaveBeenCalled();
		expect(classifyWithJev).toHaveBeenCalledTimes(backend === "jev" ? 1 : 0);
		expect(harness.complete).toHaveBeenCalledTimes(backend === "model" ? 1 : 0);
	});

	for (const backend of ["model", "jev"] as const) {
		it.each([true, false])(`applies max through ${backend} with xhigh supported: %s`, async (xhigh) => {
			const model = createModel("current", { thinkingLevelMap: { max: "max", xhigh: xhigh ? "xhigh" : null } });
			const harness = twoStageHarness(backend, undefined, model);
			if (backend === "jev") vi.mocked(selectWithJev).mockResolvedValueOnce({ ...jevDecision, effort: "max", probabilities: { max: 1 } });
			else {
				const complete = harness.complete.getMockImplementation()!;
				harness.complete.mockImplementation(async (...args) => {
					const response = await complete(...args);
					return harness.complete.mock.calls.length === 2 ? { ...response, content: [{ type: "text", text: '{"effort":"max"}' }] } : response;
				});
			}
			await harness.start("Prove the interacting system invariants");
			expect(harness.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("max");
			expect(harness.ctx.thinkingLevel).toBe("max");
			expect(decisions(harness)[0]).toMatchObject({ status: "selected", effort: "max" });
			const supported = decisions(harness)[0]!.routing!.supportedEfforts;
			expect(supported).toContain("max");
			expect(supported.includes("xhigh")).toBe(xhigh);
		});
	}

	it.each(["model", "jev"] as const)("persists private-text-free %s diagnostics, source ranges, ratings and numeric usage", async (backend) => {
		const harness = twoStageHarness(backend);
		const task = "private-current-task".padEnd(12_001, "t");
		const before = harness.ctx.sessionManager.buildSessionContext().messages;
		await harness.start(task);
		const decision = decisions(harness)[0]!;
		expect(decision.routing).toMatchObject({ taskTruncated: true, selectionMs: expect.any(Number),
			compaction: { status: "extracted", candidateCount: 3, selectedCount: 1, candidatesTruncated: false,
				sources: [{ entryId: harness.entryIds[1], role: "user", start: 0, end: 2_500 }],
				ratings: [{ id: "c0:0:2500", importance: "irrelevant" }, { id: "c1:0:2500", importance: "required" }, { id: "c2:0:2500", importance: "irrelevant" }] } });
		if (backend === "jev") {
			expect(decision.contextTiming).toMatchObject({ inputTokens: 120, outputTokens: 3 });
			expect(decision.contextDecisions).toHaveLength(3);
			expect(decision.contextDecisions?.[1]).toEqual({ id: "c1:0:2500", importance: "required", confidence: 1, probabilities: { required: 1, useful: 0, background: 0, irrelevant: 0 } });
			expect(decision.jevTiming).toMatchObject({ inputTokens: 100, outputTokens: 1 });
			expect(decision.routerProbabilities).toEqual(jevDecision.probabilities);
			const context = vi.mocked(classifyWithJev).mock.calls[0]![1];
			const selection = vi.mocked(selectWithJev).mock.calls[0]![1];
			expect(context.taskTruncated).toBe(true);
			expect(selection.state.taskTruncated).toBe(true);
			expect(context.task).toHaveLength(12_000);
			expect(context.task).toBe(selection.state.task);
		} else {
			expect(decision.selectorUsage).toEqual({
				context: { input: 120, output: 15, cacheRead: 3, cacheWrite: 2, cost: 0.03 },
				effort: { input: 120, output: 15, cacheRead: 3, cacheWrite: 2, cost: 0.03 },
			});
		}
		const serialized = JSON.stringify(harness.pi.appendEntry.mock.calls);
		for (const secret of ["private-current-task", ...harness.history, "test-key", "test-typesafe-key", "userPrompt", "systemPrompt", '"candidates":']) expect(serialized).not.toContain(secret);
		expect(harness.ctx.sessionManager.buildSessionContext().messages).toEqual(before);
		const restored = createHarness(harness.ctx.model, [], harness.ctx.sessionManager);
		await restored.emit({ type: "session_start", reason: "resume" });
		await restored.command("status");
		expect(decisions(restored)).toEqual([decision]);
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("Context: extracted");
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("1 of 3 blocks retained");
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain(`Source: ${harness.entryIds[1]}`);
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("2. user | required | retained");
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("Task truncated: true");
	});

	it("does not save invalid model classification response bodies or start selection", async () => {
		const harness = twoStageHarness("model");
		harness.complete.mockResolvedValueOnce(routerResponse(harness.ctx.model!, { content: [{ type: "text", text: 'private-response-body private-current-task' }] }));
		await harness.start("private-current-task");
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: "context_classification_failed" });
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(selectWithJev).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
		expect(saved).not.toContain("private-response-body");
		expect(saved).not.toContain("private-current-task");
	});
});
