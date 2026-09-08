import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	ModelsApiStreamOptions,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	SessionManager,
	type BeforeAgentStartEvent,
	type ContextUsage,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionHandler,
	type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piAuto from "../src/index.ts";

function createModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
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
		content: [{ type: "text", text: '{"route":"r1","reason":"Best fit"}' }],
		stopReason: "stop",
		usage: {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

function createHarness(scopedModels: ScopedModel[], currentModel: Model<Api>, tokens: number | null = 0) {
	let activeModel = currentModel;
	let activeEffort: ModelThinkingLevel = currentModel.reasoning ? "medium" : "off";
	const handlers = new Map<string, ExtensionHandler<BeforeAgentStartEvent>>();
	const complete = vi.fn(async (
		model: Model<Api>,
		_context: Context,
		_options?: ModelsApiStreamOptions<Api>,
	): Promise<AssistantMessage> => routerResponse(model));
	const pi = {
		registerCommand: vi.fn(),
		on: (name: string, handler: ExtensionHandler<BeforeAgentStartEvent>) => handlers.set(name, handler),
		setModel: vi.fn(async (model: Model<Api>) => {
			activeModel = model;
			return true;
		}),
		setThinkingLevel: vi.fn((effort: ModelThinkingLevel) => { activeEffort = effort; }),
	};
	const ctx = {
		get model() { return activeModel; },
		get thinkingLevel() { return activeEffort; },
		scopedModels,
		sessionManager: SessionManager.inMemory(process.cwd()),
		modelRegistry: { complete },
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		getContextUsage: vi.fn((): ContextUsage | undefined => ({
			tokens,
			contextWindow: currentModel.contextWindow,
			percent: tokens === null ? null : tokens / currentModel.contextWindow * 100,
		})),
	};
	piAuto(pi as unknown as ExtensionAPI);

	return {
		pi,
		ctx,
		complete,
		async start(prompt: string, images?: ImageContent[]) {
			const handler = handlers.get("before_agent_start");
			if (!handler) throw new Error("Missing before_agent_start handler");
			await handler({
				type: "before_agent_start",
				prompt,
				...(images ? { images } : {}),
				systemPrompt: "Test system prompt",
				systemPromptOptions: { cwd: process.cwd() },
			}, ctx as unknown as ExtensionContext);
		},
	};
}

function requestPayload(harness: ReturnType<typeof createHarness>) {
	const content = harness.complete.mock.calls[0]?.[1].messages[0]?.content;
	if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Missing routing payload");
	return JSON.parse(content[0].text) as {
		hasImages: boolean;
		estimatedContextTokens: number;
		models: Array<{ model: string }>;
	};
}

const image: ImageContent = { type: "image", data: "private-image-data", mimeType: "image/png" };

describe("pi-auto lifecycle", () => {
	it("checks headroom against the full new prompt, not the clipped routing payload", async () => {
		const small = createModel("small", { contextWindow: 10_000 });
		const large = createModel("large", { contextWindow: 40_000 });
		const harness = createHarness([{ model: small }, { model: large }], small, 1_000);

		await harness.start("x".repeat(32_000));

		expect(harness.ctx.model).toBe(large);
		expect(harness.complete).not.toHaveBeenCalled();
	});

	it.each([null, undefined])("keeps the current model and effort when context usage is %s", async (tokens) => {
		const candidate = createModel("candidate");
		const current = createModel("current", { reasoning: true });
		const harness = createHarness([{ model: candidate }], current, null);
		if (tokens === undefined) harness.ctx.getContextUsage.mockReturnValue(undefined);

		await harness.start("Continue");

		expect(harness.ctx.model).toBe(current);
		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("usage is unknown"), "warning");
	});

	it("counts new image attachments toward context headroom", async () => {
		const small = createModel("small", { input: ["text", "image"], contextWindow: 10_000 });
		const large = createModel("large", { input: ["text", "image"] });
		const harness = createHarness([{ model: small }, { model: large }], small, 7_500);

		await harness.start("Look", [image]);

		expect(harness.ctx.model).toBe(large);
		expect(harness.complete).not.toHaveBeenCalled();
	});

	it("reports the full incoming message estimate without sending image data to the router", async () => {
		const text = createModel("text");
		const first = createModel("first", { input: ["text", "image"] });
		const second = createModel("second", { input: ["text", "image"] });
		const harness = createHarness([{ model: text }, { model: first }, { model: second }], first, 1_000);

		await harness.start("Look", [image]);

		const payload = requestPayload(harness);
		expect(payload.estimatedContextTokens).toBe(2_201);
		expect(payload.hasImages).toBe(true);
		expect(payload.models.map((model) => model.model)).toEqual(["test/first", "test/second"]);
		expect(JSON.stringify(payload)).not.toContain(image.data);
	});

	it.each([
		{ modelMax: 8_192, budget: 2_048 },
		{ modelMax: 512, budget: 512 },
	])("requests a $budget-token routing budget for a $modelMax-token model", async ({ modelMax, budget }) => {
		const first = createModel("first", { maxTokens: modelMax });
		const second = createModel("second");
		const harness = createHarness([{ model: first }, { model: second }], first);

		await harness.start("Fix the typo");

		expect(harness.complete.mock.calls[0]?.[2]?.maxTokens).toBe(budget);
	});

	it("fails open on an output-limit response even if the returned JSON parses", async () => {
		const first = createModel("first");
		const current = createModel("current", { reasoning: true });
		const harness = createHarness([{ model: first }, { model: current }], current);
		harness.complete.mockResolvedValueOnce(routerResponse(current, { stopReason: "length" }));

		await harness.start("Fix the typo");

		expect(harness.ctx.model).toBe(current);
		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("output limit"), "warning");
	});

	it("keeps vision support for a text-only follow-up to a historical image", async () => {
		const text = createModel("text");
		const vision = createModel("vision", { input: ["text", "image"] });
		const harness = createHarness([{ model: text }, { model: vision }], vision);
		harness.ctx.sessionManager.appendMessage({ role: "user", content: [image], timestamp: Date.now() });

		await harness.start("What color is it?");

		expect(harness.ctx.model).toBe(vision);
		expect(harness.complete).not.toHaveBeenCalled();
	});

	it.each(["toolResult", "custom_message"] as const)("retains vision for historical %s images without sending their content", async (type) => {
		const text = createModel("text");
		const first = createModel("first", { input: ["text", "image"] });
		const second = createModel("second", { input: ["text", "image"] });
		const harness = createHarness([{ model: text }, { model: first }, { model: second }], first);
		const content = [{ type: "text" as const, text: "private result text" }, image];
		if (type === "toolResult") {
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
		expect(payload.models.map((model) => model.model)).toEqual(["test/first", "test/second"]);
		expect(JSON.stringify(payload)).not.toContain(image.data);
		expect(JSON.stringify(payload)).not.toContain("private result text");
	});

	it.each([true, false])("honors compaction boundaries when an image is retained: %s", async (retained) => {
		const text = createModel("text");
		const vision = createModel("vision", { input: ["text", "image"] });
		const harness = createHarness([{ model: text }, { model: vision }], vision, 2_000);
		const session = harness.ctx.sessionManager;
		const imageId = session.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
		const textId = session.appendMessage({ role: "user", content: "New task", timestamp: Date.now() });
		session.appendCompaction("Earlier work", retained ? imageId : textId, 90_000);
		session.appendMessage(routerResponse(vision, { content: [{ type: "text", text: "Ready" }] }));

		await harness.start("Continue");

		expect(harness.ctx.model).toBe(retained ? vision : text);
	});

	it("ignores images in abandoned branches and extension state entries", async () => {
		const text = createModel("text");
		const vision = createModel("vision", { input: ["text", "image"] });
		const harness = createHarness([{ model: text }, { model: vision }], vision);
		const session = harness.ctx.sessionManager;
		const root = session.appendMessage({ role: "user", content: "Start", timestamp: Date.now() });
		session.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
		session.branch(root);
		session.appendCustomEntry("image-cache", { content: [image] });

		await harness.start("Fix the typo");

		expect(harness.ctx.model).toBe(text);
		expect(requestPayload(harness).hasImages).toBe(false);
	});

	it.each(["aborted", "error"] as const)("preserves the current route on a router %s response", async (stopReason) => {
		const first = createModel("first");
		const current = createModel("current", { reasoning: true });
		const harness = createHarness([{ model: first }, { model: current }], current);
		harness.complete.mockResolvedValueOnce(routerResponse(current, { stopReason, errorMessage: "Request failed" }));

		await harness.start("Fix the typo");

		expect(harness.ctx.model).toBe(current);
		expect(harness.ctx.thinkingLevel).toBe("medium");
	});
});
