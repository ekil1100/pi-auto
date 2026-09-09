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
import { describe, expect, it, vi } from "vitest";
import piAuto from "../src/index.ts";
import { DECISION_ENTRY_TYPE, readDecision } from "../src/selection-ui.ts";

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
		get model() { return activeModel; },
		get thinkingLevel() { return activeEffort; },
		scopedModels,
		sessionManager,
		modelRegistry: { getProvider: vi.fn(() => provider), getApiKeyAndHeaders },
		ui: {
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
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", ["Choosing effort…"]);
		expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("accent", "Choosing effort…");
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
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: "No API key" });
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

			expect(timeout).toHaveBeenCalledWith(20_000);
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
