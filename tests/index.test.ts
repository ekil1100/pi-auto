import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, InMemoryCredentialStore, type ClassifierModel, type ClassifierApi, type Api, type AssistantMessage, type Context, type ImageContent, type Model, type ModelThinkingLevel, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	SessionManager,
	SettingsManager,
	ModelRegistry,
	ModelRuntime,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionEvent,
	type ExtensionHandler,
	type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piAuto from "../src/index.ts";
import { selectWithClassifier, type ClassifierDecision, type ClassifierTiming } from "../src/classifier.ts";
import { DECISION_ENTRY_TYPE, readDecision } from "../src/selection-ui.ts";

vi.mock("../src/classifier.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/classifier.ts")>();
	return { ...actual, selectWithClassifier: vi.fn() };
});

const classifierDecision: ClassifierDecision = { effort: "high", model: "jev-latest", confidence: 0.85, probabilities: { off: 0, minimal: 0, low: 0, medium: 0.15, high: 0.85 } };

const classifierModel: ClassifierModel<ClassifierApi> = {
	type: "classifier", provider: "typesafe", id: "jev-latest", name: "Jev", api: "typesafe-system-one",
	baseUrl: "https://example.test", input: ["text"], contextWindow: 100_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
let availableModels: ClassifierModel<ClassifierApi>[];
let availableChats: Model<Api>[] | undefined;
let agentDirectory: string;
beforeEach(async () => {
	agentDirectory = await mkdtemp(join(tmpdir(), "pi-auto-settings-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
	vi.spyOn(SettingsManager, "create").mockReturnValue(SettingsManager.inMemory({ defaultThinkingLevel: "medium" }));
	availableModels = [];
	availableChats = undefined;
	vi.stubEnv("TYPESAFE_API_KEY", undefined);
	vi.stubEnv("PI_AUTO_DEBUG", undefined);
	vi.mocked(selectWithClassifier).mockReset().mockResolvedValue(classifierDecision);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(agentDirectory, { recursive: true, force: true });
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
	const streamSimple = vi.fn((model: Model<Api>, context: Context, options?: SimpleStreamOptions) => ({
		result: () => complete(model, context, options),
	}));
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
		cwd: process.cwd(),
		isProjectTrusted: vi.fn(() => false),
		signal: undefined as AbortSignal | undefined,
		mode: "rpc" as ExtensionContext["mode"],
		get model() { return activeModel; },
		get thinkingLevel() { return activeEffort; },
		scopedModels,
		sessionManager,
		modelRegistry: { classify: vi.fn(), getAvailableOfType: vi.fn(async (type: string) => type === "chat" ? availableChats ?? (activeModel ? [activeModel] : []) : availableModels), streamSimple, getProvider: vi.fn(() => provider), getApiKeyAndHeaders },
		ui: {
			onTerminalInput: vi.fn<ExtensionContext["ui"]["onTerminalInput"]>(() => vi.fn()),
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
		return await handlers.get(event.type)?.(event, ctx as unknown as ExtensionContext);
	}

	return {
		pi,
		emit,
		ctx,
		complete,
		provider,
		streamSimple,
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
				systemPromptOptions: {
					cwd: process.cwd(), selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
					appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [],
				},
			});
		},
	};
}

describe("command completions", () => {
	it.each([
		["", ["toggle", "on", "off", "model", "status", "default on", "default off"]],
		["o", ["on", "off"]],
		["st", ["status"]],
		["d", ["default on", "default off"]],
		["default ", ["default on", "default off"]],
		["default of", ["default off"]],
		[" DEFAULT   O", ["default on", "default off"]],
		["unknown", []],
		["default off extra", []],
	] as const)("completes argument prefix %j", async (prefix, expected) => {
		const harness = createHarness(createModel());
		const command = harness.pi.registerCommand.mock.calls.find(([name]) => name === "auto")![1];
		expect(command.getArgumentCompletions).toBeTypeOf("function");
		const result = await command.getArgumentCompletions!(prefix);
		expect(result).toEqual(expected.length ? expected.map((value) => ({ value, label: value })) : null);
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		await expect(readFile(join(agentDirectory, "pi-auto.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("startup defaults", () => {
	it("persists off across instances and disables the current instance", async () => {
		const current = createHarness(createModel());
		await current.command("default off");
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toMatchObject({ defaultEnabled: false });
		await current.start("Current instance is disabled");
		expect(current.complete).not.toHaveBeenCalled();
		expect(current.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
		const restarted = createHarness(createModel());
		await restarted.emit({ type: "session_start", reason: "startup" });
		await restarted.start("Disabled after restart");
		expect(restarted.complete).not.toHaveBeenCalled();
		await restarted.command("on");
		await restarted.start("Temporary override");
		expect(restarted.complete).toHaveBeenCalledTimes(1);
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toMatchObject({ defaultEnabled: false });
	});

	it("persists on and enables the current disabled instance", async () => {
		await writeFile(join(agentDirectory, "pi-auto.json"), '{"defaultEnabled":false}');
		const current = createHarness(createModel());
		await current.command(" DEFAULT   ON ");
		expect(current.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · Not selected");
		await current.start("Enabled immediately");
		expect(current.complete).toHaveBeenCalledTimes(1);
		const restarted = createHarness(createModel());
		await restarted.start("Enabled after reload");
		expect(restarted.complete).toHaveBeenCalledTimes(1);
		await restarted.command("off");
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toMatchObject({ defaultEnabled: true });
	});

	it.each(["default", "default maybe", "default off extra"])("rejects invalid command %s without writing settings", async (command) => {
		const harness = createHarness(createModel());
		await harness.command(command);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "warning");
		await expect(readFile(join(agentDirectory, "pi-auto.json"))).rejects.toMatchObject({ code: "ENOENT" });
		await harness.start("Still enabled");
		expect(harness.complete).toHaveBeenCalledTimes(1);
	});

	it.each(["not JSON", '{"defaultEnabled":"false"}'])("disables selection and warns for invalid settings %s", async (settings) => {
		await writeFile(join(agentDirectory, "pi-auto.json"), settings);
		const harness = createHarness(createModel());
		await harness.emit({ type: "session_start", reason: "startup" });
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not load"), "warning");
		await harness.start("Do not select");
		expect(harness.complete).not.toHaveBeenCalled();
		await harness.command("default on");
		expect(harness.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Could not save"), "error");
		await rm(join(agentDirectory, "pi-auto.json"));
		const restarted = createHarness(createModel());
		await restarted.start("Recovered");
		expect(restarted.complete).toHaveBeenCalledTimes(1);
	});

	it.each(["model", "classifier", "fallback"] as const)("default off cancels pending %s selection without applying late results", async (backend) => {
		if (backend !== "model") availableModels = [classifierModel];
		const model = createModel();
		const harness = createHarness(model);
		let release!: () => void;
		if (backend === "classifier") vi.mocked(selectWithClassifier).mockImplementationOnce(() => new Promise((resolve) => {
			release = () => resolve(classifierDecision);
		}));
		else {
			if (backend === "fallback") vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
			harness.complete.mockImplementationOnce(() => new Promise((resolve) => {
				release = () => resolve(routerResponse(model));
			}));
		}
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await harness.command("default off");
		await pending;
		expect(decisions(harness)).toHaveLength(0);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toMatchObject({ defaultEnabled: false });
		release();
		await Promise.resolve();
		await harness.start("Still disabled");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
		expect(decisions(harness)).toHaveLength(0);
	});

	it("reports save failures without changing the current state", async () => {
		const harness = createHarness(createModel());
		await mkdir(join(agentDirectory, "pi-auto.json"));
		await harness.command("default off");
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Could not save"), "error");
		await harness.start("Still enabled");
		expect(harness.complete).toHaveBeenCalledTimes(1);
	});
});

function requestPayload(harness: ReturnType<typeof createHarness>, index = 0) {
	const content = harness.complete.mock.calls[index]?.[1].messages[0]?.content;
	if (!Array.isArray(content) || content[0]?.type !== "text") throw new Error("Missing selection payload");
	return JSON.parse(content[0].text) as {
		task: string;
		taskCharacters: number;
		taskTruncated: boolean;
		recentConversation?: string;
		contextOmitted: boolean;
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

describe("Classifier lifecycle", () => {
	it.each(["classify", "getAvailableOfType"] as const)("disables selection and requests an upgrade when %s is missing", async (method) => {
		const harness = createHarness(createModel());
		Reflect.deleteProperty(harness.ctx.modelRegistry, method);
		await harness.emit({ type: "session_start", reason: "startup" });
		await harness.command("on");
		await harness.start("Continue");
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Upgrade Pi"), "error");
		expect(harness.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(harness.complete).not.toHaveBeenCalled();
		expect(selectWithClassifier).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("checks for the native API even before session_start", async () => {
		const harness = createHarness(createModel());
		Reflect.deleteProperty(harness.ctx.modelRegistry, "classify");
		await harness.start("Continue");
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("0.99.0"), "error");
		expect(harness.complete).not.toHaveBeenCalled();
	});

	it.each([undefined, "", " \t "])("uses the current model when the key is %j", async (key) => {
		vi.stubEnv("TYPESAFE_API_KEY", key);
		const harness = createHarness(createModel());

		await harness.start("Continue");

		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(selectWithClassifier).not.toHaveBeenCalled();
	});

	it("uses an available classifier and records the actual selector, not an effort", async () => {
		availableModels = [classifierModel];
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
		const [registry, invocation] = vi.mocked(selectWithClassifier).mock.calls[0]!;
		expect(registry).toBe(harness.ctx.modelRegistry);
		expect(invocation.state).toMatchObject({
			hasImages: true, model: { id: "test/current" }, currentEffort: "medium",
			supportedEfforts: ["off", "minimal", "low", "medium", "high"],
		});
		expect(invocation.state.recentConversation).toContain("Earlier task");
		expect(invocation.state.task).toBe(`start-${"x".repeat(20_000)}-end`);
		expect(invocation.state.task).toMatch(/^start-/);
		expect(invocation.state.task).toMatch(/-end$/);
		expect(JSON.stringify(invocation.state)).not.toContain(image.data);
		expect(decisions(harness)[0]).toMatchObject({
			status: "selected", model: "test/current", effort: "high", routerEffort: undefined,
			routerModel: `typesafe/${"jev-latest"}`, routerConfidence: 0.85, reason: "Selected by Classifier Choice",
		});
		const status = harness.ctx.ui.notify.mock.lastCall?.[0];
		expect(status).toContain(`Selector: typesafe/${"jev-latest"}`);
		expect(status).toContain("Confidence: 0.850 (not success probability)");
		expect(status).not.toContain("Selector: not called");
		expect(JSON.stringify(decisions(harness))).not.toContain("test-typesafe-key");
		expect(harness.ctx.sessionManager.buildSessionContext().messages).toHaveLength(1);
	});

	it("persists timing snapshots and exposes them through status", async () => {
		availableModels = [classifierModel];
		const timing: ClassifierTiming = { classifyMs: 503, validateMs: 0.1, totalMs: 503.1 };
		vi.mocked(selectWithClassifier).mockImplementationOnce(async (_registry, invocation) => {
			invocation.onTiming?.(timing);
			return classifierDecision;
		});
		const harness = createHarness(createModel());
		await harness.start("Continue");
		await harness.command("status");

		expect(decisions(harness)[0]).toMatchObject({ prepareMs: expect.any(Number), classifierTiming: timing });
		expect(harness.ctx.ui.notify.mock.lastCall?.[0]).toContain("classify 503.0ms");
		timing.totalMs = 999;
		expect(decisions(harness)[0]?.classifierTiming?.totalMs).toBe(503.1);
	});

	it.each(["no model", "single effort", "disabled"])("does not call either selector for %s", async (scenario) => {
		availableModels = [classifierModel];
		const harness = createHarness(scenario === "no model" ? undefined : createModel("plain", { reasoning: false }));
		if (scenario === "disabled") await harness.command("off");

		await harness.start("Continue");

		expect(selectWithClassifier).not.toHaveBeenCalled();
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("respects saved current-model selection after classifiers become available", async () => {
		const harness = createHarness(createModel());
		await harness.start("First task");
		availableModels = [classifierModel];
		vi.stubEnv("TYPESAFE_API_KEY", "not-a-backend-switch");
		await harness.start("Second task");
		expect(harness.complete).toHaveBeenCalledTimes(2);
		expect(selectWithClassifier).not.toHaveBeenCalled();
		expect(decisions(harness).map((decision) => decision.routerConfidence)).toEqual([undefined, undefined]);
	});

	it.each(["Classifier request failed", "Classifier request failed (HTTP 401)", "Classifier request failed (HTTP 429)", "Classifier returned an invalid decision"])("falls back to the current model once on %s", async (message) => {
		availableModels = [classifierModel];
		vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error(message));
		const harness = createHarness(createModel());

		await harness.start("Continue");

		expect(harness.ctx.thinkingLevel).toBe("high");
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(1);
		expect(harness.complete.mock.calls[0]?.[2]).toMatchObject({ maxRetries: 0 });
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ status: "selected", reason: `Selector failed (${message}); current-model fallback: Best fit`, routerModel: "test/current" });
		expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
	});

	it("records provider aborts as provider failures and keeps the business fallback", async () => {
		availableModels = [classifierModel];
		vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier provider aborted the request"));
		const harness = createHarness(createModel());
		await harness.start("Continue");
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(decisions(harness)[0]?.selectorAttempts).toEqual([
			expect.objectContaining({ backend: "classifier", outcome: "failed", interruption: "provider" }),
			expect.objectContaining({ backend: "current-model", outcome: "selected" }),
		]);
	});

	it.each([false, true])("retains Classifier diagnostics across current-model fallback with debug=%j", async (debug) => {
		availableModels = [classifierModel];
		vi.stubEnv("PI_AUTO_DEBUG", debug ? "1" : undefined);
		const harness = createHarness(createModel());
		vi.mocked(selectWithClassifier).mockImplementationOnce(async (_registry, invocation) => {
			expect(invocation.debugResponses).toBe(debug);
			invocation.onDiagnostics?.({ stage: "validation", errorCode: "missing_effort", responseType: "object", responseCharacters: 2,
				...(debug ? { rawText: "{}", rawTextTruncated: false } : {}),
			});
			throw new Error("Classifier returned an invalid decision (missing_effort)");
		});
		await harness.start("Continue");
		const saved = decisions(harness)[0]!;
		expect(saved).toMatchObject({ status: "selected", routerModel: "test/current", classifierDiagnostics: { stage: "validation", errorCode: "missing_effort" } });
		expect(saved.classifierDiagnostics?.rawText).toBe(debug ? "{}" : undefined);
		await harness.command("status");
		expect(harness.ctx.ui.notify.mock.lastCall?.[0]).toContain("Error code: missing_effort");
		expect(harness.complete).toHaveBeenCalledTimes(1);
	});

	it("freezes Classifier diagnostic snapshots before cancellation and late callbacks", async () => {
		availableModels = [classifierModel];
		const harness = createHarness(createModel());
		let report!: NonNullable<Parameters<typeof selectWithClassifier>[1]["onDiagnostics"]>;
		let release!: () => void;
		vi.mocked(selectWithClassifier).mockImplementationOnce((_registry, invocation) => new Promise((resolve) => {
			report = invocation.onDiagnostics!;
			const snapshot = { stage: "request" as const };
			report(snapshot);
			Object.assign(snapshot, { errorCode: "request_failed" });
			release = () => resolve(classifierDecision);
		}));
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(report).toBeTypeOf("function"));
		await harness.command("off");
		await pending;
		expect(decisions(harness)).toHaveLength(0);
		const before = JSON.stringify(harness.pi.appendEntry.mock.calls);
		report({ stage: "complete", responseType: "object", responseCharacters: 7, rawText: "private", rawTextTruncated: false });
		release();
		await Promise.resolve();
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).toBe(before);
		expect(harness.complete).not.toHaveBeenCalled();
	});

	it("uses a fresh fallback deadline after a Classifier timeout and ignores a late result", async () => {
		availableModels = [classifierModel];
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(new AbortController().signal).mockReturnValueOnce(controller.signal);
		try {
			let resolve!: (decision: ClassifierDecision) => void;
			vi.mocked(selectWithClassifier).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
			const harness = createHarness(createModel());
			const pending = harness.start("Continue");
			await vi.waitFor(() => expect(selectWithClassifier).toHaveBeenCalled());
			controller.abort();
			await pending;
			resolve(classifierDecision);
			await Promise.resolve();

			expect(vi.mocked(selectWithClassifier).mock.calls[0]?.[1].signal.aborted).toBe(true);
			expect(harness.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith("high");
			expect(harness.complete).toHaveBeenCalledTimes(1);
			expect(timeout).toHaveBeenCalledTimes(3);
			expect(timeout).toHaveBeenNthCalledWith(1, 10_000);
			expect(timeout).toHaveBeenNthCalledWith(2, 10_000);
			expect(harness.complete.mock.calls[0]?.[2]?.signal).not.toBe(vi.mocked(selectWithClassifier).mock.calls[0]?.[1].signal);
			expect(decisions(harness)).toEqual([expect.objectContaining({ status: "selected", reason: "Selector failed (router timed out); current-model fallback: Best fit" })]);
			expect(decisions(harness)[0]?.routerConfidence).toBeUndefined();
			expect(decisions(harness)[0]?.selectorAttempts).toEqual([
				expect.objectContaining({ backend: "classifier", outcome: "failed", interruption: "deadline", timeoutMs: 10_000 }),
				expect.objectContaining({ backend: "current-model", outcome: "selected" }),
			]);
			expect(decisions(harness)[0]?.selectorAttempts?.[1]).not.toHaveProperty("interruption");
		} finally {
			timeout.mockRestore();
		}
	});

	it("does not mutate persisted partial timings when a timed-out request finishes late", async () => {
		availableModels = [classifierModel];
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		try {
			let resolve!: (decision: ClassifierDecision) => void;
			vi.mocked(selectWithClassifier).mockImplementationOnce((_registry, invocation) => {
				invocation.onTiming?.({ classifyMs: 1 });
				return new Promise((done) => { resolve = done; });
			});
			const harness = createHarness(createModel());
			const pending = harness.start("Continue");
			await vi.waitFor(() => expect(selectWithClassifier).toHaveBeenCalled());
			controller.abort();
			await pending;
			vi.mocked(selectWithClassifier).mock.calls[0]?.[1].onTiming?.({ classifyMs: 1, totalMs: 25_000 });
			resolve(classifierDecision);
			await Promise.resolve();
			expect(decisions(harness)[0]?.classifierTiming).toEqual({ classifyMs: 1 });
			expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		} finally {
			timeout.mockRestore();
		}
	});

	it.each(["model", "effort", "off", "off-on", "shutdown"])("discards Classifier results after a manual %s change", async (change) => {
		availableModels = [classifierModel];
		let resolve!: (decision: ClassifierDecision) => void;
		vi.mocked(selectWithClassifier).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const harness = createHarness(createModel());
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(selectWithClassifier).toHaveBeenCalled());
		if (change === "model") await harness.pi.setModel(createModel("next"));
		if (change === "effort") harness.pi.setThinkingLevel("low");
		if (change === "off" || change === "off-on") await harness.command("off");
		if (change === "off-on") await harness.command("on");
		if (change === "shutdown") await harness.emit({ type: "session_shutdown", reason: "reload" });
		if (["off", "off-on", "shutdown"].includes(change)) await pending;
		resolve(classifierDecision);
		await pending;
		await Promise.resolve();

		expect(harness.ctx.thinkingLevel).toBe(change === "effort" ? "low" : "medium");
		expect(harness.pi.setThinkingLevel).toHaveBeenCalledTimes(change === "effort" ? 1 : 0);
		expect(harness.complete).not.toHaveBeenCalled();
		if (["shutdown", "off", "off-on"].includes(change)) expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		else expect(decisions(harness)[0]?.status).toBe("kept");
	});
});

describe("configured default fallback", () => {
	it.each(["off", "low", "high", "max"] as const)("restores configured %s after both selectors fail, without changing models", async (effort) => {
		availableModels = [classifierModel];
		vi.mocked(SettingsManager.create).mockReturnValue(SettingsManager.inMemory({ defaultThinkingLevel: effort }));
		vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
		const model = createModel("current", { thinkingLevelMap: { max: "max" } });
		const harness = createHarness(model);
		harness.complete.mockRejectedValueOnce(new Error("private-error-body"));
		await harness.start("Continue");
		expect(harness.ctx.thinkingLevel).toBe(effort);
		expect(selectWithClassifier).toHaveBeenCalledTimes(1);
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(harness.pi.setThinkingLevel).toHaveBeenCalledExactlyOnceWith(effort);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ reason: `Selector failed (Classifier request failed); current-model fallback failed: router request failed; restored Pi default effort (${effort})` });
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).not.toContain("private-error-body");
	});

	it("prefers the per-model default and clamps it to supported levels", async () => {
		vi.mocked(SettingsManager.create).mockReturnValue(SettingsManager.inMemory({ defaultThinkingLevel: "low", modelThinkingLevels: { "test/current": "max" } }));
		const harness = createHarness(createModel());
		harness.complete.mockRejectedValueOnce(new Error("failure"));
		await harness.start("Continue");
		expect(harness.ctx.thinkingLevel).toBe("high");
		expect(SettingsManager.create).toHaveBeenCalledWith(harness.ctx.cwd, undefined, { projectTrusted: false });
	});

	it("uses Pi's built-in medium only when no default is configured", async () => {
		vi.mocked(SettingsManager.create).mockReturnValue(SettingsManager.inMemory());
		const harness = createHarness(createModel());
		harness.pi.setThinkingLevel("high");
		harness.complete.mockRejectedValueOnce(new Error("failure"));
		await harness.start("Continue");
		expect(harness.ctx.thinkingLevel).toBe("medium");
	});

	it.each([true, false])("reads saved settings without modifying them, with project trust %s", async (trusted) => {
		vi.mocked(SettingsManager.create).mockRestore();
		await mkdir(".agents", { recursive: true });
		const root = await mkdtemp(join(process.cwd(), ".agents", "fallback-settings-"));
		try {
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			await mkdir(agentDir);
			await mkdir(join(cwd, ".pi"), { recursive: true });
			const globalPath = join(agentDir, "settings.json"), projectPath = join(cwd, ".pi", "settings.json");
			const globalText = JSON.stringify({ defaultThinkingLevel: "low" });
			const projectText = JSON.stringify({ defaultThinkingLevel: "high" });
			await writeFile(globalPath, globalText);
			await writeFile(projectPath, projectText);
			vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
			const harness = createHarness(createModel());
			harness.ctx.cwd = cwd;
			harness.ctx.isProjectTrusted.mockReturnValue(trusted);
			harness.complete.mockRejectedValueOnce(new Error("failure"));
			await harness.start("Continue");
			expect(harness.ctx.thinkingLevel).toBe(trusted ? "high" : "low");
			expect(await readFile(globalPath, "utf8")).toBe(globalText);
			expect(await readFile(projectPath, "utf8")).toBe(projectText);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("keeps the current effort if the saved defaults cannot be read", async () => {
		vi.mocked(SettingsManager.create).mockImplementationOnce(() => { throw new Error("private-settings-error"); });
		const harness = createHarness(createModel());
		harness.complete.mockRejectedValueOnce(new Error("failure"));
		await harness.start("Continue");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]?.reason).toContain("Pi default effort unavailable");
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).not.toContain("private-settings-error");
	});

	it.each([
		'{"defaultThinkingLevel":null}',
		'{"defaultThinkingLevel":"invalid"}',
		'{"defaultThinkingLevel":42}',
		'{"defaultThinkingLevel":"low","modelThinkingLevels":{"test/current":null}}',
	])("does not apply an explicitly invalid default: %s", async (json) => {
		vi.mocked(SettingsManager.create).mockReturnValue(SettingsManager.inMemory(JSON.parse(json)));
		const harness = createHarness(createModel());
		harness.pi.setThinkingLevel("high");
		harness.pi.setThinkingLevel.mockClear();
		harness.complete.mockRejectedValueOnce(new Error("failure"));
		await harness.start("Continue");
		expect(harness.ctx.thinkingLevel).toBe("high");
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(decisions(harness)[0]?.reason).toContain("Pi default effort unavailable");
	});

	it.each(["classifier", "fallback"] as const)("honors the runtime cancellation signal during %s", async (phase) => {
		availableModels = [classifierModel];
		const harness = createHarness(createModel());
		const user = new AbortController();
		harness.ctx.signal = user.signal;
		const remove = vi.spyOn(user.signal, "removeEventListener");
		let fail!: (error: Error) => void;
		if (phase === "classifier") vi.mocked(selectWithClassifier).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
		else {
			vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
			harness.complete.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
		}
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(phase === "classifier" ? selectWithClassifier : harness.complete).toHaveBeenCalled());
		user.abort("private-cancellation-reason");
		await pending;
		fail(new Error("late failure"));
		await Promise.resolve();
		expect(decisions(harness)[0]).toMatchObject({ status: "cancelled", reason: "Selection cancelled by runtime" });
		expect(decisions(harness)[0]?.selectorAttempts?.at(-1)).toMatchObject({ outcome: "cancelled", interruption: "runtime" });
		expect(JSON.stringify(decisions(harness))).not.toContain("private-cancellation-reason");
		expect(SettingsManager.create).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.complete).toHaveBeenCalledTimes(phase === "classifier" ? 0 : 1);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
	});

	it("does not inherit the previous automatic effort as the configured default", async () => {
		vi.mocked(SettingsManager.create).mockReturnValue(SettingsManager.inMemory({ defaultThinkingLevel: "low" }));
		const harness = createHarness(createModel());
		await harness.start("First task");
		expect(harness.ctx.thinkingLevel).toBe("high");
		harness.complete.mockRejectedValueOnce(new Error("failure"));
		await harness.start("Second task");
		expect(harness.ctx.thinkingLevel).toBe("low");
	});

	it.each(["off", "model", "effort", "shutdown"] as const)("does not restore defaults after %s during fallback", async (change) => {
		availableModels = [classifierModel];
		vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
		const harness = createHarness(createModel());
		let reject!: (error: Error) => void;
		harness.complete.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(harness.complete).toHaveBeenCalled());
		if (change === "off") await harness.command("off");
		if (change === "model") await harness.pi.setModel(createModel("new"));
		if (change === "effort") harness.pi.setThinkingLevel("low");
		if (change === "shutdown") await harness.emit({ type: "session_shutdown", reason: "reload" });
		reject(new Error("failure"));
		await pending;
		expect(SettingsManager.create).not.toHaveBeenCalled();
		expect(harness.pi.setThinkingLevel).toHaveBeenCalledTimes(change === "effort" ? 1 : 0);
		if (change === "shutdown") expect(harness.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("ignores late Classifier diagnostics while the current-model fallback is still running", async () => {
		availableModels = [classifierModel];
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(new AbortController().signal).mockReturnValueOnce(deadline.signal);
		let resolveClassifier!: (value: ClassifierDecision) => void;
		vi.mocked(selectWithClassifier).mockImplementationOnce(() => new Promise((resolve) => { resolveClassifier = resolve; }));
		const harness = createHarness(createModel());
		let resolveModel!: (value: AssistantMessage) => void;
		harness.complete.mockImplementationOnce(() => new Promise((resolve) => { resolveModel = resolve; }));
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(selectWithClassifier).toHaveBeenCalled());
		deadline.abort();
		await vi.waitFor(() => expect(harness.complete).toHaveBeenCalled());
		vi.mocked(selectWithClassifier).mock.calls[0]![1].onTiming?.({ totalMs: 99999 });
		resolveClassifier(classifierDecision);
		await Promise.resolve();
		resolveModel(routerResponse(harness.ctx.model!));
		await pending;
		expect(decisions(harness)[0]).toMatchObject({ routerModel: "test/current", routerEffort: "low" });
		expect(decisions(harness)[0]?.routerConfidence).toBeUndefined();
		expect(decisions(harness)[0]?.classifierTiming).toBeUndefined();
	});
});

describe("pi-auto lifecycle", () => {
	it("shows only auto and the selected model with accent and dim colors on startup", async () => {
		const harness = createHarness(createModel());

		await harness.emit({ type: "session_start", reason: "startup" });

		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · test/current");
		expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("accent", "auto");
		expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("dim", " · test/current");
		expect(harness.ctx.ui.theme.getThinkingBorderColor).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("toggles with bare auto or explicit toggle, without changing effort", async () => {
		const harness = createHarness(createModel());

		await harness.command("");
		await harness.start("Continue");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);

		await harness.command("");
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · Not selected");
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
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · Not selected");

		await harness.pi.setModel(next);
		harness.pi.setThinkingLevel("off");
		await harness.emit({ type: "model_select", model: next, previousModel: current, source: "set" });
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · test/next");

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
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · test/current");
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
		expect(harness.pi.registerEntryRenderer).toHaveBeenCalledWith(DECISION_ENTRY_TYPE, expect.any(Function));
		expect(decisions(harness)).toEqual([expect.objectContaining({
			status: "selected", model: "test/current", previousEffort: "medium", effort: "high",
			reason: "Best fit", routerModel: "test/current", routerEffort: "low", elapsedMs: expect.any(Number),
		})]);
		expect(harness.ctx.ui.theme.fg).toHaveBeenCalledWith("accent", "auto");
		expect(harness.ctx.ui.theme.getThinkingBorderColor).not.toHaveBeenCalled();
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
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · test/plain");
		expect(harness.ctx.ui.theme.getThinkingBorderColor).not.toHaveBeenCalled();
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

	it("uses Pi's runtime to preserve instructions and resolve provider authentication", async () => {
		const model = createModel();
		const harness = createHarness(model);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const registry = new ModelRegistry(runtime);
		let systemPrompt: string | undefined;
		let requestOptions: SimpleStreamOptions | undefined;
		registry.registerProvider("test", {
			api: model.api, apiKey: "synthetic-key", baseUrl: "https://example.test",
			streamSimple: (_model, context, options) => {
				systemPrompt = getCurrentSystemPrompt(context.messages);
				requestOptions = options;
				const stream = createAssistantMessageEventStream();
				const response = routerResponse(model, { content: [{ type: "text", text: systemPrompt?.includes('"effort"') ? '{"effort":"high"}' : "Missing instructions" }] });
				stream.push({ type: "done", reason: "stop", message: response });
				stream.end();
				return stream;
			},
		});
		harness.streamSimple.mockImplementation((...args) => registry.streamSimple(...args));

		await harness.start("Continue");

		expect(harness.streamSimple).toHaveBeenCalledTimes(1);
		expect(harness.ctx.modelRegistry.getProvider).not.toHaveBeenCalled();
		expect(harness.getApiKeyAndHeaders).not.toHaveBeenCalled();
		expect(systemPrompt).toContain('"effort"');
		expect(requestOptions).toMatchObject({ apiKey: "synthetic-key", cacheRetention: "none", maxRetries: 0 });
		expect(decisions(harness)[0]).toMatchObject({ status: "selected", effort: "high" });
	});

	it.each([
		{ modelMax: 8_192, budget: 2_048 },
		{ modelMax: 512, budget: 512 },
	])("requests a $budget-token budget for a $modelMax-token model", async ({ modelMax, budget }) => {
		const harness = createHarness(createModel("current", { maxTokens: modelMax }));

		await harness.start("Fix the typo");

		expect(harness.complete.mock.calls[0]?.[2]?.maxTokens).toBe(budget);
	});

	it("preserves long tasks without switching to a larger model", async () => {
		const current = createModel("small", { contextWindow: 10_000 });
		const harness = createHarness(current, [{ model: createModel("large") }]);

		await harness.start("x".repeat(32_000));

		expect(harness.ctx.model).toBe(current);
		expect(harness.pi.setModel).not.toHaveBeenCalled();
		expect(requestPayload(harness).task).toBe("x".repeat(32_000));
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

	it.each(["model", "classifier", "fallback"] as const)("sends only the prior user and final text reply to %s while keeping current input as task", async (backend) => {
		if (backend !== "model") availableModels = [classifierModel];
		if (backend === "fallback") vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
		const model = createModel();
		const harness = createHarness(model);
		const session = harness.ctx.sessionManager;
		const oldUserId = session.appendMessage({ role: "user", content: "Obsolete user task", timestamp: Date.now() });
		session.appendMessage(routerResponse(model, { content: [{ type: "text", text: "Obsolete assistant reply" }] }));
		session.appendCompaction("Private summary of earlier work", oldUserId, 90_000);
		const user = "Investigate the connection failure";
		const userId = session.appendMessage({ role: "user", content: user, timestamp: Date.now() });
		session.appendMessage(routerResponse(model, { content: [{ type: "text", text: "Intermediate progress" }] }));
		session.appendMessage({ role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "Private tool output" }], isError: false, timestamp: Date.now() });
		const reply = "The connection uses an outdated endpoint.\nUpdate the endpoint configuration.";
		const assistantId = session.appendMessage(routerResponse(model, { content: [
			{ type: "thinking", thinking: "Private reasoning" },
			...reply.split("\n").map((text) => ({ type: "text" as const, text })),
		] }));
		session.appendMessage(routerResponse(model, { content: [{ type: "thinking", thinking: "Trailing private reasoning" }] }));
		const before = session.buildSessionContext().messages;
		const task = "Apply that fix and add a regression test";

		await harness.start(task);

		expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
		const payload = backend === "classifier" ? vi.mocked(selectWithClassifier).mock.calls[0]![1].state : requestPayload(harness);
		if (backend === "fallback") expect(vi.mocked(selectWithClassifier).mock.calls[0]![1].state).toEqual(payload);
		expect(payload).toMatchObject({ task, taskCharacters: task.length, contextOmitted: true });
		expect(payload).not.toHaveProperty("candidates");
		expect(payload.recentConversation).toContain(user);
		expect(payload.recentConversation).toContain(reply);
		expect(payload.recentConversation!.indexOf(user)).toBeLessThan(payload.recentConversation!.indexOf(reply));
		for (const excluded of [task, "Private summary of earlier work", "Obsolete user task", "Obsolete assistant reply", "Intermediate progress", "Private tool output", "Private reasoning", "Trailing private reasoning"]) {
			expect(payload.recentConversation).not.toContain(excluded);
		}
		expect(decisions(harness)[0]).toMatchObject({ status: "selected", routing: { context: {
			strategy: "recent-turn", omitted: true, characters: payload.recentConversation!.length, elapsedMs: expect.any(Number), sources: [
				{ entryId: userId, role: "user", start: 0, end: user.length },
				{ entryId: assistantId, role: "assistant", start: 0, end: reply.length },
			],
		} } });
		expect(session.buildSessionContext().messages).toEqual(before);
	});

	it.each(["model", "classifier", "fallback"] as const)("does not send a summary or an orphan assistant reply to %s", async (backend) => {
		if (backend !== "model") availableModels = [classifierModel];
		if (backend === "fallback") vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
		const model = createModel();
		const harness = createHarness(model);
		const session = harness.ctx.sessionManager;
		session.appendMessage({ role: "user", content: "Compacted private task", timestamp: Date.now() });
		const replyId = session.appendMessage(routerResponse(model, { content: [{ type: "text", text: "Orphan private reply" }] }));
		session.appendCompaction("Private summary", replyId, 90_000);
		const before = session.buildSessionContext().messages;

		await harness.start("New task");

		expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
		const payload = backend === "classifier" ? vi.mocked(selectWithClassifier).mock.calls[0]![1].state : requestPayload(harness);
		if (backend === "fallback") expect(vi.mocked(selectWithClassifier).mock.calls[0]![1].state).toEqual(payload);
		expect(payload).toMatchObject({ task: "New task", contextOmitted: true });
		expect(payload).not.toHaveProperty("recentConversation");
		for (const secret of ["Compacted private task", "Orphan private reply", "Private summary"]) expect(JSON.stringify(payload)).not.toContain(secret);
		expect(decisions(harness)[0]).toMatchObject({ status: "selected", routing: { context: {
			strategy: "recent-turn", omitted: true, characters: 0, sources: [], elapsedMs: expect.any(Number),
		} } });
		expect(session.buildSessionContext().messages).toEqual(before);
	});

	it.each(["model", "classifier", "fallback"] as const)("reports an untruncated single user as retained without omissions for %s", async (backend) => {
		if (backend !== "model") availableModels = [classifierModel];
		if (backend === "fallback") vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
		const harness = createHarness(createModel());
		const user = "Investigate the failure";
		const entryId = harness.ctx.sessionManager.appendMessage({ role: "user", content: user, timestamp: Date.now() });

		await harness.start("Continue");
		await harness.command("status");

		expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
		const payload = backend === "classifier" ? vi.mocked(selectWithClassifier).mock.calls[0]![1].state : requestPayload(harness);
		if (backend === "fallback") expect(vi.mocked(selectWithClassifier).mock.calls[0]![1].state).toEqual(payload);
		expect(payload).toMatchObject({ task: "Continue", contextOmitted: false });
		expect(payload.recentConversation).toContain(user);
		expect(payload.recentConversation).not.toContain("omitted");
		expect(decisions(harness)[0]?.routing?.context).toEqual({ strategy: "recent-turn", omitted: false,
			characters: payload.recentConversation!.length, elapsedMs: expect.any(Number),
			sources: [{ entryId, role: "user", start: 0, end: user.length }] });
		const status = harness.ctx.ui.notify.mock.lastCall?.[0];
		expect(status).toContain("Context: recent-turn");
		expect(status).toContain("1 messages retained · omitted: no");
		expect(status).toContain(`Source: ${entryId}`);
		expect(status).toContain("1. user");
	});

	it.each(["model", "classifier", "fallback"] as const)("preserves long recent history for %s without a model classification call", async (backend) => {
		if (backend !== "model") availableModels = [classifierModel];
		if (backend === "fallback") vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
		const model = createModel();
		const harness = createHarness(model);
		const user = "Recent user request: ".padEnd(7_000, "u");
		const reply = "Final assistant reply: ".padEnd(7_000, "a");
		harness.ctx.sessionManager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
		harness.ctx.sessionManager.appendMessage(routerResponse(model, { content: [{ type: "text", text: reply }] }));

		await harness.start("Continue with the next step");

		expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
		const payload = backend === "classifier" ? vi.mocked(selectWithClassifier).mock.calls[0]![1].state : requestPayload(harness);
		if (backend === "fallback") expect(vi.mocked(selectWithClassifier).mock.calls[0]![1].state).toEqual(payload);
		expect(payload).toMatchObject({ task: "Continue with the next step", contextOmitted: false });
		expect(payload).not.toHaveProperty("candidates");
		expect(payload.recentConversation).toContain(user);
		expect(payload.recentConversation).toContain(reply);
		const context = decisions(harness)[0]?.routing?.context;
		expect(context).toMatchObject({ strategy: "recent-turn", omitted: false, characters: payload.recentConversation!.length, elapsedMs: expect.any(Number) });
		expect(context!.sources).toHaveLength(2);
		expect(decisions(harness)[0]?.status).toBe("selected");
		expect(context!.sources.every(({ start, end }) => start === 0 && end === 7_000)).toBe(true);
	});

	it.each(["model", "classifier"] as const)("selects with %s after an image-only turn even when an older task exceeds the context budget", async (backend) => {
		if (backend === "classifier") availableModels = [classifierModel];
		const model = createModel();
		const harness = createHarness(model);
		const session = harness.ctx.sessionManager;
		session.appendMessage({ role: "user", content: "old-task ".repeat(3_000), timestamp: Date.now() });
		const userId = session.appendMessage({ role: "user", content: [image], timestamp: Date.now() });
		const reply = "The screenshot shows a connection error.";
		const assistantId = session.appendMessage(routerResponse(model, { content: [{ type: "text", text: reply }] }));

		await harness.start("Continue investigating the screenshot");

		expect(decisions(harness)[0]).toMatchObject({ status: "selected", effort: "high", routing: {
			context: { strategy: "recent-turn", omitted: true, sources: [
				{ entryId: userId, role: "user", start: 0, end: 0 },
				{ entryId: assistantId, role: "assistant", start: 0, end: reply.length },
			] },
		} });
		expect(harness.complete).toHaveBeenCalledTimes(backend === "model" ? 1 : 0);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "classifier" ? 1 : 0);
		const state = backend === "classifier" ? vi.mocked(selectWithClassifier).mock.calls[0]![1].state
			: JSON.parse((harness.complete.mock.calls[0]![1].messages[0]!.content[0] as { text: string }).text);
		expect(state.hasImages).toBe(true);
		expect(state.recentConversation).toContain("The screenshot shows a connection error.");
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

	it("does not mislabel a provider abort as a local timeout", async () => {
		const current = createModel();
		const harness = createHarness(current);
		harness.complete.mockResolvedValueOnce(routerResponse(current, { stopReason: "aborted" }));
		await harness.start("Continue");
		expect(decisions(harness)[0]?.reason).toContain("provider aborted");
		expect(decisions(harness)[0]?.reason).not.toContain("timed out");
		expect(decisions(harness)[0]?.selectorAttempts).toEqual([
			expect.objectContaining({ backend: "chat", outcome: "failed", interruption: "provider" }),
		]);
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
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · test/current");
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

	it("keeps the effort when the runtime cannot authenticate", async () => {
		const harness = createHarness(createModel());
		harness.streamSimple.mockImplementationOnce(() => { throw new Error("No API key"); });

		await harness.start("Continue");

		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.complete).not.toHaveBeenCalled();
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: "router request failed; restored Pi default effort (medium)" });
	});

	it.each(["runtime-sync", "runtime-rejection"])("never persists echoed credentials from %s", async (failure) => {
		const harness = createHarness(createModel());
		const privateBody = "HTTP 400 private-body api_key=secret-canary";
		if (failure === "runtime-sync") harness.streamSimple.mockImplementationOnce(() => { throw new Error(privateBody); });
		if (failure === "runtime-rejection") harness.complete.mockRejectedValueOnce(new Error(privateBody));
		await harness.start("Continue");
		expect(decisions(harness)[0]).toMatchObject({ status: "kept", reason: "router request failed; restored Pi default effort (medium)" });
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
			expect(decisions(harness)).toEqual([expect.objectContaining({ status: "kept", reason: "router timed out; restored Pi default effort (medium)" })]);
			expect(decisions(harness)[0]?.selectorAttempts).toEqual([
				expect.objectContaining({ backend: "chat", outcome: "failed", interruption: "deadline", timeoutMs: 10_000 }),
			]);
			expect(harness.ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-auto-selecting", undefined);
		} finally {
			timeout.mockRestore();
		}
	});

	it("passes the abort signal to the runtime while it prepares a request", async () => {
		const controller = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		try {
			const harness = createHarness(createModel());
			harness.streamSimple.mockImplementationOnce(() => ({ result: () => new Promise(() => {}) }));

			const pending = harness.start("Continue");
			await vi.waitFor(() => expect(harness.streamSimple).toHaveBeenCalledTimes(1));
			controller.abort();
			await pending;
			expect(harness.streamSimple.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);

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
		expect(selectWithClassifier).not.toHaveBeenCalled();
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
		expect(decisions(harness)).toHaveLength(0);
		expect(harness.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · test/current");
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
		expect(decisions(harness)).toHaveLength(0);
	});
});

type Backend = "model" | "classifier" | "fallback";
const lifecycleBackends = ["model", "classifier", "fallback"] as const;

function historyHarness(backend: Backend, paused = false, model = createModel()) {
	availableModels = backend === "model" ? [] : [classifierModel];
	const harness = createHarness(model);
	const history = ["old-private-history", "active-private-history", "recent-private-history"].map((prefix) => prefix.padEnd(2_500, "x"));
	const entryIds = history.map((content) => harness.ctx.sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() }));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const attempts: ("model" | "classifier")[] = [];
	const signals: (AbortSignal | undefined)[] = [];
	const wait = async (selector: "model" | "classifier", signal?: AbortSignal) => {
		attempts.push(selector);
		signals.push(signal);
		if (paused) await gate; // Deliberately ignore abort to simulate a late backend.
	};
	harness.complete.mockImplementation(async (current, _context, options) => {
		await wait("model", options?.signal);
		return routerResponse(current, {
			content: [{ type: "text", text: '{"effort":"high"}' }],
			usage: { input: 120, output: 15, cacheRead: 3, cacheWrite: 2, totalTokens: 140,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
		});
	});
	vi.mocked(selectWithClassifier).mockImplementation(async (_registry, invocation) => {
		invocation.onTiming?.({ classifyMs: 2 });
		if (backend === "fallback") throw new Error("Classifier request failed");
		await wait("classifier", invocation.signal);
		invocation.onTiming?.({ classifyMs: 2, totalMs: 20, inputTokens: 100, outputTokens: 1 });
		return classifierDecision;
	});
	return { ...harness, history, entryIds, attempts, signals, release };
}

describe("history routing lifecycle", () => {
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

	it.each(lifecycleBackends)("cancels %s selection with Escape without changing effort or retrying", async (backend) => {
		const harness = historyHarness(backend, true);
		harness.ctx.mode = "tui";
		const removeInput = vi.fn();
		harness.ctx.ui.onTerminalInput.mockReturnValue(removeInput);
		const pending = harness.start("Continue");
		await vi.waitFor(() => expect(harness.attempts).toContain(backend === "classifier" ? "classifier" : "model"));
		const input = harness.ctx.ui.onTerminalInput.mock.calls[0]?.[0];
		expect(input).toBeDefined();
		expect(input!("a")).toBeUndefined();
		expect(harness.signals.at(-1)?.aborted).toBe(false);
		expect(input!("\u001b")).toEqual({ consume: true });
		await pending;
		expect(harness.signals.at(-1)?.aborted).toBe(true);
		expect(removeInput).toHaveBeenCalledTimes(1);
		expect(decisions(harness)[0]).toMatchObject({ status: "cancelled", effort: "medium", reason: "Selection cancelled by user" });
		expect(decisions(harness)[0]?.selectorAttempts?.at(-1)).toMatchObject({ outcome: "cancelled", interruption: "escape" });
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(SettingsManager.create).not.toHaveBeenCalled();
		expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
		const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
		harness.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(decisions(harness)).toHaveLength(1);
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).toBe(saved);
	});

	it.each(["success", "failure", "shutdown"] as const)("removes the Escape listener after %s", async (outcome) => {
		const harness = createHarness(createModel());
		harness.ctx.mode = "tui";
		const removeInput = vi.fn();
		harness.ctx.ui.onTerminalInput.mockReturnValue(removeInput);
		if (outcome === "failure") harness.complete.mockRejectedValueOnce(new Error("Request failed"));
		if (outcome === "shutdown") harness.complete.mockImplementationOnce(() => new Promise(() => {}));
		const pending = harness.start("Continue");
		if (outcome === "shutdown") {
			await vi.waitFor(() => expect(harness.complete).toHaveBeenCalled());
			await harness.emit({ type: "session_shutdown", reason: "reload" });
		}
		await pending;
		expect(removeInput).toHaveBeenCalledTimes(1);
	});

	it("does not register terminal input outside TUI mode", async () => {
		const harness = createHarness(createModel());
		await harness.start("Continue");
		expect(harness.ctx.ui.onTerminalInput).not.toHaveBeenCalled();
	});

	it.each(["model", "classifier"] as const)("times out %s effort within its attempt budget and ignores late callbacks", async (backend) => {
		const harness = historyHarness(backend, true);
		const pending = harness.start("Continue");
		await vi.advanceTimersByTimeAsync(5_000);
		expect(harness.attempts).toEqual([backend]);
		const selectionSignal = backend === "classifier" ? vi.mocked(selectWithClassifier).mock.calls[0]![1].signal : harness.complete.mock.calls[0]![2]!.signal;
		expect(selectionSignal).toBe(harness.signals[0]);
		expect(AbortSignal.timeout).toHaveBeenCalledTimes(2);
		expect(AbortSignal.timeout).toHaveBeenNthCalledWith(2, 10_000);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(harness.pi.appendEntry).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		if (backend === "classifier") {
			expect(AbortSignal.timeout).toHaveBeenCalledTimes(3);
			expect(harness.pi.appendEntry).not.toHaveBeenCalled();
			expect(harness.attempts).toEqual(["classifier", "model"]);
			expect(harness.signals.at(-1)).not.toBe(selectionSignal);
			expect(harness.signals.at(-1)?.aborted).toBe(false);
			expect(AbortSignal.timeout).toHaveBeenNthCalledWith(2, 10_000);
			await vi.advanceTimersByTimeAsync(9_999);
			expect(harness.pi.appendEntry).not.toHaveBeenCalled();
			expect(harness.signals.at(-1)?.aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(harness.signals.at(-1)?.aborted).toBe(true);
		}
		await pending;
		expect(selectionSignal?.aborted).toBe(true);
		expect(decisions(harness)).toEqual([expect.objectContaining({ status: "kept", reason: expect.stringContaining("router timed out"), elapsedMs: backend === "classifier" ? 20_000 : 10_000,
			routing: expect.objectContaining({ context: expect.objectContaining({ strategy: "recent-turn", elapsedMs: 0, omitted: true }) }) })]);
		if (backend === "classifier") expect(decisions(harness)[0]?.classifierTiming).toEqual({ classifyMs: 2 });
		const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
		harness.release();
		await vi.advanceTimersByTimeAsync(0);
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).toBe(saved);
		expect(harness.pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.ctx.thinkingLevel).toBe("medium");
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "classifier" ? 1 : 0);
	});

	for (const backend of lifecycleBackends) {
		it.each(["model", "effort", "off-on", "shutdown"] as const)(`invalidates ${backend} selection after %s even when settings return to their original values`, async (change) => {
			const original = createModel();
			const harness = historyHarness(backend, true, original);
			const pending = harness.start("Continue");
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.attempts.at(-1)).toBe(backend === "classifier" ? "classifier" : "model");
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
			expect(harness.pi.appendEntry).not.toHaveBeenCalled();
			const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
			harness.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(harness.attempts).toEqual([backend === "classifier" ? "classifier" : "model"]);
			expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
			expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
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

	it("makes one effort call in the current-model fallback after Classifier selection fails", async () => {
		const harness = historyHarness("fallback");
		await harness.start("Continue");
		expect(selectWithClassifier).toHaveBeenCalledTimes(1);
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(requestPayload(harness)).not.toHaveProperty("candidates");
		expect(requestPayload(harness)).toMatchObject({ task: "Continue", contextOmitted: true });
		expect(requestPayload(harness)).toEqual(vi.mocked(selectWithClassifier).mock.calls[0]![1].state);
		expect(requestPayload(harness).recentConversation).toContain(harness.history[2]);
		for (const history of harness.history.slice(0, 2)) expect(requestPayload(harness).recentConversation).not.toContain(history);
		expect(harness.complete.mock.calls[0]![1].systemPrompt).toContain('"effort"');
		expect(decisions(harness)[0]?.routing?.context).toMatchObject({ strategy: "recent-turn", omitted: true,
			sources: [{ entryId: harness.entryIds[2], role: "user", start: 0, end: 2_500 }] });
		expect(harness.ctx.thinkingLevel).toBe("high");
		expect(decisions(harness)[0]).toMatchObject({ routerModel: "test/current", reason: expect.stringContaining("current-model fallback:") });
		expect(decisions(harness)[0]?.routerConfidence).toBeUndefined();
	});

	it("restores the configured effort immediately when the fallback effort call also fails", async () => {
		vi.mocked(SettingsManager.create).mockReturnValue(SettingsManager.inMemory({ defaultThinkingLevel: "low" }));
		const harness = historyHarness("fallback");
		harness.complete.mockRejectedValueOnce(new Error("fallback effort failed"));
		await harness.start("Continue");
		expect(selectWithClassifier).toHaveBeenCalledTimes(1);
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(harness.ctx.thinkingLevel).toBe("low");
		expect(decisions(harness)[0]?.reason).toContain("restored Pi default effort (low)");
	});

	for (const backend of ["model", "classifier"] as const) {
		it.each([true, false])(`applies max through ${backend} with xhigh supported: %s`, async (xhigh) => {
			const model = createModel("current", { thinkingLevelMap: { max: "max", xhigh: xhigh ? "xhigh" : null } });
			const harness = historyHarness(backend, false, model);
			if (backend === "classifier") vi.mocked(selectWithClassifier).mockResolvedValueOnce({ ...classifierDecision, effort: "max", probabilities: { max: 1 } });
			else {
				const complete = harness.complete.getMockImplementation()!;
				harness.complete.mockImplementation(async (...args) => {
					const response = await complete(...args);
					return { ...response, content: [{ type: "text", text: '{"effort":"max"}' }] };
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

	it.each(lifecycleBackends)("persists private-text-free %s diagnostics, source ranges and numeric usage", async (backend) => {
		const harness = historyHarness(backend);
		const task = "private-current-task".padEnd(12_001, "t");
		const before = harness.ctx.sessionManager.buildSessionContext().messages;
		await harness.start(task);
		const decision = decisions(harness)[0]!;
		const payload = backend === "classifier" ? vi.mocked(selectWithClassifier).mock.calls[0]![1].state : requestPayload(harness);
		expect(payload).toMatchObject({ taskTruncated: false, contextOmitted: true });
		expect(payload.task).toBe(task);
		expect(decision.routing).toMatchObject({ taskTruncated: false, selectionMs: expect.any(Number) });
		expect(decision.routing!.context).toEqual({ strategy: "recent-turn", omitted: true,
			characters: payload.recentConversation!.length, elapsedMs: expect.any(Number),
			sources: [{ entryId: harness.entryIds[2], role: "user", start: 0, end: 2_500 }] });
		expect(decision.routing).not.toHaveProperty("compaction");
		expect(decision).not.toHaveProperty("contextTiming");
		expect(decision).not.toHaveProperty("contextDecisions");
		expect(harness.complete).toHaveBeenCalledTimes(backend === "classifier" ? 0 : 1);
		expect(selectWithClassifier).toHaveBeenCalledTimes(backend === "model" ? 0 : 1);
		if (backend === "classifier") {
			expect(decision.classifierTiming).toMatchObject({ inputTokens: 100, outputTokens: 1 });
			expect(decision.routerProbabilities).toEqual(classifierDecision.probabilities);
			expect(decision.selectorUsage).toBeUndefined();
			expect(decision.selectorResponses).toBeUndefined();
		} else {
			expect(decision.selectorUsage).toEqual({
				effort: { input: 120, output: 15, cacheRead: 3, cacheWrite: 2, cost: 0.03 },
			});
			expect(Object.keys(decision.selectorResponses!)).toEqual(["effort"]);
		}
		const serialized = JSON.stringify(harness.pi.appendEntry.mock.calls);
		for (const secret of ["private-current-task", ...harness.history, "test-key", "test-typesafe-key", "userPrompt", "systemPrompt", '"candidates":']) expect(serialized).not.toContain(secret);
		expect(harness.ctx.sessionManager.buildSessionContext().messages).toEqual(before);
		const restored = createHarness(harness.ctx.model, [], harness.ctx.sessionManager);
		await restored.emit({ type: "session_start", reason: "resume" });
		await restored.command("status");
		expect(decisions(restored)).toEqual([decision]);
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("Context: recent-turn");
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("1 messages retained · omitted: yes");
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain(`Source: ${harness.entryIds[2]}`);
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("1. user");
		expect(restored.ctx.ui.notify.mock.lastCall?.[0]).toContain("Task truncated: false");
	});

	it.each([undefined, "0", "1"])("records response diagnostics with opt-in raw text: %s", async (debug) => {
		vi.stubEnv("PI_AUTO_DEBUG", debug);
		const harness = createHarness(createModel());
		const text = '  {"effort":"unknown","reason":"private-response"}  ';
		harness.complete.mockResolvedValueOnce(routerResponse(harness.ctx.model!, {
			content: [{ type: "thinking", thinking: "private-thinking" }, { type: "text", text }],
		}));
		const before = harness.ctx.sessionManager.buildSessionContext().messages;
		await harness.start("private-task");
		const decision = decisions(harness)[0]!;
		expect(decision.reason).toContain("unsupported_effort");
		expect(decision.selectorResponses?.effort).toEqual({
			stopReason: "stop", textCharacters: text.length,
			contentTypes: ["thinking", "text"],
			...(debug === "1" ? { rawText: text, rawTextTruncated: false } : {}),
		});
		const saved = JSON.stringify(harness.pi.appendEntry.mock.calls);
		for (const secret of ["private-task", "private-thinking", "test-key"]) expect(saved).not.toContain(secret);
		if (debug !== "1") expect(saved).not.toContain("private-response");
		expect(harness.ctx.sessionManager.buildSessionContext().messages).toEqual(before);
	});

	it.each(["length", "error", "aborted"] as const)("captures bounded response text before rejecting stop reason %s", async (stopReason) => {
		vi.stubEnv("PI_AUTO_DEBUG", "1");
		const harness = createHarness(createModel());
		const text = "x".repeat(9_000);
		harness.complete.mockResolvedValueOnce(routerResponse(harness.ctx.model!, {
			stopReason, content: [{ type: "text", text }], errorMessage: "private-provider-error",
		}));
		await harness.start("Task");
		expect(decisions(harness)[0]?.selectorResponses?.effort).toEqual({
			stopReason, textCharacters: 9_000, contentTypes: ["text"],
			rawText: text.slice(0, 8_192), rawTextTruncated: true,
		});
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).not.toContain("private-provider-error");
	});

	it("records only the current-model effort reply without displaying raw text", async () => {
		vi.stubEnv("PI_AUTO_DEBUG", "1");
		const harness = historyHarness("model");
		await harness.start("Task");
		const responses = decisions(harness)[0]?.selectorResponses;
		expect(Object.keys(responses!)).toEqual(["effort"]);
		expect(harness.complete).toHaveBeenCalledTimes(1);
		expect(JSON.parse(responses!.effort!.rawText!)).toMatchObject({ effort: "high" });
		await harness.command("status");
		expect(harness.ctx.ui.notify.mock.lastCall?.[0]).not.toContain(responses!.effort!.rawText!);
	});

	it("does not attach a late response to a later decision", async () => {
		vi.stubEnv("PI_AUTO_DEBUG", "1");
		const deadline = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(new AbortController().signal).mockReturnValueOnce(deadline.signal);
		const harness = createHarness(createModel());
		let resolve!: (value: AssistantMessage) => void;
		harness.complete.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
		const pending = harness.start("First task");
		await vi.waitFor(() => expect(harness.complete).toHaveBeenCalled());
		deadline.abort();
		await pending;
		await harness.start("Second task");
		resolve(routerResponse(harness.ctx.model!, { content: [{ type: "text", text: "late-private-response" }] }));
		await vi.advanceTimersByTimeAsync(0);
		expect(decisions(harness)[0]?.selectorResponses).toBeUndefined();
		expect(decisions(harness)[1]?.selectorResponses?.effort?.rawText).toContain('"effort":"high"');
		expect(JSON.stringify(harness.pi.appendEntry.mock.calls)).not.toContain("late-private-response");
	});

	it("captures thinking-only responses without logging thinking text", async () => {
		vi.stubEnv("PI_AUTO_DEBUG", "1");
		const harness = createHarness(createModel());
		harness.complete.mockResolvedValueOnce(routerResponse(harness.ctx.model!, {
			content: [{ type: "thinking", thinking: "private-thinking" }],
		}));
		await harness.start("Task");
		expect(decisions(harness)[0]?.selectorResponses?.effort).toEqual({
			stopReason: "stop", textCharacters: 0, contentTypes: ["thinking"], rawText: "", rawTextTruncated: false,
		});
		expect(decisions(harness)[0]?.reason).toContain("router returned no decision");
	});
});

describe("main request payload isolation", () => {
	it("leaves provider requests untouched across automatic and manual effort changes", async () => {
		const current = createModel("gpt-6-astra", { provider: "openai", baseUrl: "https://api.openai.com/v1" });
		const h = createHarness(current);
		const input: Record<string, unknown>[] = [{ role: "user", content: "First" }];
		const request = () => h.emit({ type: "before_provider_request", payload: {
			model: current.id, stream: true, reasoning: { effort: h.ctx.thinkingLevel }, input: [...input],
		} });
		await h.start("First");
		expect(h.ctx.thinkingLevel).toBe("high");
		expect(await request()).toBeUndefined();
		input.push({ role: "assistant", content: "Done" }, { role: "user", content: "Second" });
		h.complete.mockResolvedValueOnce(routerResponse(current, { content: [{ type: "text", text: '{"effort":"low"}' }] }));
		await h.start("Second");
		expect(h.ctx.thinkingLevel).toBe("low");
		expect(await request()).toBeUndefined();
		await h.command("off");
		h.pi.setThinkingLevel("medium");
		expect(h.ctx.thinkingLevel).toBe("medium");
		expect(await request()).toBeUndefined();
		input.push({ role: "assistant", content: "Done again" }, { role: "user", content: "Third" });
		await h.start("Third");
		expect(h.ctx.thinkingLevel).toBe("medium");
		expect(await request()).toBeUndefined();
		expect(h.complete).toHaveBeenCalledTimes(2);
	});
});

describe("saved selector backend", () => {
	it("saves the first authenticated classifier, notifies about context sharing, and shows it before any result", async () => {
		availableModels = [{ ...classifierModel, provider: "a", id: "first" }, classifierModel];
		const h = createHarness(createModel());
		await h.emit({ type: "session_start", reason: "startup" });
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toEqual({ backend: { type: "classifier", provider: "typesafe", id: "jev-latest" } });
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringMatching(/available classifier.*current task and recent-turn selection context.*\/auto model/), "info");
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · typesafe/jev-latest");
		expect(selectWithClassifier).not.toHaveBeenCalled();
		const restarted = createHarness(createModel());
		await restarted.emit({ type: "session_start", reason: "startup" });
		expect(restarted.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("saves stable provider/id ordering when the preferred classifier is absent", async () => {
		availableModels = [{ ...classifierModel, provider: "z" }, { ...classifierModel, provider: "a", id: "z" }, { ...classifierModel, provider: "a", id: "a" }];
		const h = createHarness(createModel());
		await h.emit({ type: "session_start", reason: "startup" });
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toEqual({ backend: { type: "classifier", provider: "a", id: "a" } });
	});

	it("does not infer availability from environment keys and persists current when none are available", async () => {
		vi.stubEnv("TYPESAFE_API_KEY", "not-available-through-Pi");
		const h = createHarness(createModel());
		await h.emit({ type: "session_start", reason: "startup" });
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toEqual({ backend: { type: "chat", provider: "test", id: "current" } });
		await h.start("Task");
		expect(selectWithClassifier).not.toHaveBeenCalled();
	});

	it("keeps a saved unavailable classifier and retries it next time after current-model fallback", async () => {
		const saved = { defaultEnabled: true, backend: { type: "classifier", provider: "custom", id: "classifier/v2" } };
		await writeFile(join(agentDirectory, "pi-auto.json"), JSON.stringify(saved));
		const h = createHarness(createModel());
		const actual = await vi.importActual<typeof import("../src/classifier.ts")>("../src/classifier.ts");
		vi.mocked(selectWithClassifier).mockImplementationOnce(actual.selectWithClassifier);
		await h.start("Task");
		expect(decisions(h)[0]).toMatchObject({ actualBackend: "test/current (fallback)", classifierDiagnostics: { errorCode: "model_unavailable" } });
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · custom/classifier/v2");
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toEqual(saved);
		await h.command("status");
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Configured backend: classifier: custom/classifier/v2");
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Availability: unavailable");
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Actual backend: test/current (fallback)");
		availableModels = [{ ...classifierModel, provider: "custom", id: "classifier/v2" }];
		await h.start("Next task");
		expect(selectWithClassifier).toHaveBeenCalledTimes(2);
		expect(decisions(h)[1]?.actualBackend).toBe("custom/classifier/v2");
	});

	it("distinguishes restored Pi default effort from both selector backends", async () => {
		availableModels = [classifierModel];
		const h = createHarness(createModel());
		vi.mocked(selectWithClassifier).mockRejectedValueOnce(new Error("Classifier request failed"));
		h.complete.mockRejectedValueOnce(new Error("Private provider failure"));
		await h.start("Task");
		expect(decisions(h)[0]?.actualBackend).toBe("default");
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · typesafe/jev-latest");
		await h.command("status");
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Actual backend: default");
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("restored Pi default effort");
	});

	it("saves a picker choice without changing enabled or unrelated settings", async () => {
		await writeFile(join(agentDirectory, "pi-auto.json"), JSON.stringify({ defaultEnabled: false, enabled: false, other: 42, backend: { type: "current-model" } }));
		const h = createHarness(createModel());
		h.ctx.mode = "tui";
		availableModels = [classifierModel];
		h.ctx.ui.custom.mockResolvedValue({ type: "classifier", provider: "typesafe", id: "jev-latest" });
		await h.command("model");
		expect(h.ctx.ui.custom.mock.calls[0]).toHaveLength(1);
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toEqual({ defaultEnabled: false, enabled: false, other: 42, backend: { type: "classifier", provider: "typesafe", id: "jev-latest" } });
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
		await h.command("default on");
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toMatchObject({ defaultEnabled: true, enabled: false, other: 42, backend: { type: "classifier", provider: "typesafe", id: "jev-latest" } });
	});

	it("Esc cancellation does not create or change settings", async () => {
		const h = createHarness(createModel());
		h.ctx.mode = "tui";
		await h.command("model");
		await expect(readFile(join(agentDirectory, "pi-auto.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("a failed save leaves both the current backend and in-flight work unchanged", async () => {
		await writeFile(join(agentDirectory, "pi-auto.json"), JSON.stringify({ backend: { type: "current-model" } }));
		const h = createHarness(createModel());
		h.ctx.mode = "tui";
		let release!: (response: AssistantMessage) => void;
		h.complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const pending = h.start("Task");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await rm(join(agentDirectory, "pi-auto.json"));
		await mkdir(join(agentDirectory, "pi-auto.json"));
		h.ctx.ui.custom.mockResolvedValue({ type: "classifier", provider: "typesafe", id: "jev-latest" });
		await h.command("model");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("current setting unchanged"), "error");
		expect(h.complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);
		release(routerResponse(h.ctx.model!));
		await pending;
		expect(decisions(h)[0]?.actualBackend).toBe("test/current");
	});

	it("changing the saved backend aborts in-flight selection and late work cannot overwrite the new result", async () => {
		availableModels = [classifierModel];
		const h = createHarness(createModel());
		h.ctx.mode = "tui";
		let release!: (decision: ClassifierDecision) => void;
		vi.mocked(selectWithClassifier).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const pending = h.start("Old task");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		h.ctx.ui.custom.mockResolvedValue({ type: "chat", provider: "test", id: "current" });
		await h.command("model");
		await pending;
		expect(h.complete).not.toHaveBeenCalled();
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
		expect(vi.mocked(selectWithClassifier).mock.calls[0]![1].signal.aborted).toBe(true);
		await h.start("New task");
		const snapshot = JSON.stringify(h.pi.appendEntry.mock.calls);
		release(classifierDecision);
		await Promise.resolve();
		expect(JSON.stringify(h.pi.appendEntry.mock.calls)).toBe(snapshot);
		expect(decisions(h).at(-1)?.actualBackend).toBe("test/current");
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · test/current");
	});

	it("does not persist a late automatic default after settings change during availability lookup", async () => {
		const h = createHarness(createModel());
		let release!: (models: ClassifierModel<ClassifierApi>[]) => void;
		h.ctx.modelRegistry.getAvailableOfType.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const starting = h.emit({ type: "session_start", reason: "startup" });
		await h.command("off");
		release([classifierModel]);
		await starting;
		await expect(readFile(join(agentDirectory, "pi-auto.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", undefined);
	});

	it("keeps status read-only after initial discovery fails", async () => {
		const h = createHarness(createModel());
		h.ctx.modelRegistry.getAvailableOfType.mockRejectedValueOnce(new Error("Discovery failed"));
		await h.emit({ type: "session_start", reason: "startup" });
		availableModels = [classifierModel];
		h.ctx.modelRegistry.getAvailableOfType.mockClear();
		h.ctx.ui.notify.mockClear();

		await h.command("status");

		await expect(readFile(join(agentDirectory, "pi-auto.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(h.ctx.modelRegistry.getAvailableOfType).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Configured backend: Not selected");
		expect(selectWithClassifier).not.toHaveBeenCalled();
		expect(h.complete).not.toHaveBeenCalled();
	});

	it("does not migrate an initial backend when inspecting status", async () => {
		const path = join(agentDirectory, "pi-auto.json");
		const original = '{"backend":{"type":"current-model"},"defaultEnabled":false}';
		await writeFile(path, original);
		const h = createHarness(createModel());

		await h.command("status");

		expect(await readFile(path, "utf8")).toBe(original);
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Configured backend: Not selected");
		expect(h.ctx.modelRegistry.getAvailableOfType).not.toHaveBeenCalled();
	});

	it("reports availability failures without leaking errors or saving a misleading default", async () => {
		const h = createHarness(createModel());
		h.ctx.modelRegistry.getAvailableOfType.mockRejectedValueOnce(new Error("secret-credential"));
		await h.emit({ type: "session_start", reason: "startup" });
		await expect(readFile(join(agentDirectory, "pi-auto.json"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.stringify(h.ctx.ui.notify.mock.calls)).not.toContain("secret-credential");
	});

	it.each(["rpc", "print", "json"] as const)("explains the TUI requirement in %s without opening a picker", async (mode) => {
		const h = createHarness(createModel());
		h.ctx.mode = mode as ExtensionContext["mode"];
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
		await h.command("model");
		expect(h.ctx.ui.custom).not.toHaveBeenCalled();
		expect(mode === "rpc" ? h.ctx.ui.notify.mock.lastCall?.[0] : stderr.mock.lastCall?.[0]).toContain("requires an interactive TUI");
	});
});

describe("selector settings concurrency", () => {
	it("does not consume picker Escape as selection cancellation", async () => {
		await writeFile(join(agentDirectory, "pi-auto.json"), JSON.stringify({ backend: { type: "current-model" } }));
		const h = createHarness(createModel());
		h.ctx.mode = "tui";
		let release!: (response: AssistantMessage) => void;
		h.complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const pending = h.start("Task");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		h.ctx.ui.custom.mockImplementationOnce(async () => {
			const listener = h.ctx.ui.onTerminalInput.mock.calls[0]![0];
			expect(listener("\u001b")).toBeUndefined();
			return undefined as never;
		});
		await h.command("model");
		expect(h.complete.mock.calls[0]?.[2]?.signal?.aborted).toBe(false);
		release(routerResponse(h.ctx.model!));
		await pending;
		expect(decisions(h)[0]?.status).toBe("selected");
	});

	it("ignores a delayed notification from its own setter while a newer selection is pending", async () => {
		const h = createHarness(createModel());
		await h.start("First task");
		expect(h.ctx.thinkingLevel).toBe("high");
		let release!: (response: AssistantMessage) => void;
		h.complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const pending = h.start("Second task");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await h.emit({ type: "thinking_level_select", level: "high", previousLevel: "medium" });
		expect(h.complete.mock.calls[1]?.[2]?.signal?.aborted).toBe(false);
		release(routerResponse(h.ctx.model!));
		await pending;
		expect(decisions(h)).toHaveLength(2);
	});

	it("cancels availability checks before classifying and does not fall back on explicit abort", async () => {
		await writeFile(join(agentDirectory, "pi-auto.json"), JSON.stringify({ backend: { type: "classifier", provider: "typesafe", id: "jev-latest" } }));
		const h = createHarness(createModel());
		const actual = await vi.importActual<typeof import("../src/classifier.ts")>("../src/classifier.ts");
		vi.mocked(selectWithClassifier).mockImplementationOnce(actual.selectWithClassifier);
		let release!: (models: ClassifierModel<ClassifierApi>[]) => void;
		h.ctx.modelRegistry.getAvailableOfType.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const pending = h.start("Task");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await h.command("off");
		await pending;
		release([classifierModel]);
		await Promise.resolve();
		expect(h.ctx.modelRegistry.classify).not.toHaveBeenCalled();
		expect(h.complete).not.toHaveBeenCalled();
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});
});

describe("fixed chat selector", () => {
	const saveChat = async (model: Model<Api>) => writeFile(join(agentDirectory, "pi-auto.json"), JSON.stringify({
		defaultEnabled: true, backend: { type: "chat", provider: model.provider, id: model.id }, other: 42,
	}));

	it.each([false, true])("uses the saved judge's reasoning/maxTokens and the answerer's effort options (reasoning=%j)", async (reasoning) => {
		const judge = createModel("judge", { reasoning, maxTokens: 512, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } });
		const answer = createModel("answer", { thinkingLevelMap: { max: "max" } });
		await saveChat(judge);
		availableChats = [judge, answer];
		const h = createHarness(answer);
		h.complete.mockResolvedValue(routerResponse(judge, { content: [{ type: "text", text: '{"effort":"max"}' }] }));
		await h.start("Deep task");
		expect(h.complete).toHaveBeenCalledTimes(1);
		expect(h.complete.mock.calls[0]![0]).toBe(judge);
		expect(h.complete.mock.calls[0]![2]).toMatchObject({ maxTokens: 512, maxRetries: 0 });
		expect(h.complete.mock.calls[0]![2]?.reasoning).toBe(reasoning ? "high" : undefined);
		expect(requestPayload(h)).toMatchObject({ model: { id: "test/answer" }, supportedEfforts: expect.arrayContaining(["max"]) });
		expect(h.complete.mock.calls[0]![1].systemPrompt).toContain('"max"');
		expect(h.ctx.thinkingLevel).toBe("max");
		expect(h.pi.setModel).not.toHaveBeenCalled();
		expect(decisions(h)[0]).toMatchObject({ model: "test/answer", routerModel: "test/judge", actualBackend: "test/judge" });
		const next = createModel("next");
		await h.pi.setModel(next);
		await h.emit({ type: "model_select", model: next, previousModel: answer, source: "set" });
		h.complete.mockResolvedValue(routerResponse(judge));
		await h.start("New answerer");
		expect(h.complete.mock.calls[1]![0]).toBe(judge);
		expect(requestPayload(h, 1)).toMatchObject({ model: { id: "test/next" } });
		const restarted = createHarness(next);
		await restarted.start("After reload");
		expect(restarted.complete.mock.calls[0]![0]).toBe(judge);
	});

	it.each(["unavailable", "request", "invalid", "availability"])("falls back from a non-current chat selector on %s without rewriting the saved choice", async (failure) => {
		const judge = createModel("judge");
		const answer = createModel();
		await saveChat(judge);
		const original = await readFile(join(agentDirectory, "pi-auto.json"), "utf8");
		availableChats = failure === "unavailable" ? [] : [judge];
		const h = createHarness(answer);
		if (failure === "request") h.complete.mockRejectedValueOnce(new Error("secret provider body"));
		if (failure === "invalid") h.complete.mockResolvedValueOnce(routerResponse(judge, { content: [{ type: "text", text: '{"effort":"max"}' }] }));
		if (failure === "availability") h.ctx.modelRegistry.getAvailableOfType.mockRejectedValueOnce(new Error("secret auth body"));
		await h.start("Task");
		expect(h.complete).toHaveBeenCalledTimes(["request", "invalid"].includes(failure) ? 2 : 1);
		expect(h.complete.mock.lastCall?.[0]).toBe(answer);
		expect(decisions(h)[0]).toMatchObject({ actualBackend: "test/current (fallback)", selectorAttempts: [
			expect.objectContaining({ backend: "chat", outcome: "failed" }),
			expect.objectContaining({ backend: "current-model", outcome: "selected" }),
		] });
		expect(JSON.stringify(h.pi.appendEntry.mock.calls)).not.toContain("secret");
		expect(await readFile(join(agentDirectory, "pi-auto.json"), "utf8")).toBe(original);
		await h.command("status");
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Configured backend: chat: test/judge");
		expect(h.ctx.ui.notify.mock.lastCall?.[0]).toContain("Actual backend: test/current (fallback)");
	});

	it.each(["request", "unavailable"])("does not retry the same answering model on %s", async (failure) => {
		const answer = createModel();
		await saveChat(answer);
		availableChats = failure === "unavailable" ? [] : [answer];
		const h = createHarness(answer);
		h.complete.mockRejectedValue(new Error("private error"));
		await h.start("Task");
		expect(h.complete).toHaveBeenCalledTimes(failure === "request" ? 1 : 0);
		expect(decisions(h)[0]).toMatchObject({ actualBackend: "default", selectorAttempts: [expect.objectContaining({ backend: "chat", outcome: "failed" })] });
		expect(h.ctx.thinkingLevel).toBe("medium");
	});

	it("restores Pi default after both chat selectors fail", async () => {
		const judge = createModel("judge");
		await saveChat(judge);
		availableChats = [judge];
		const h = createHarness(createModel());
		h.pi.setThinkingLevel("high");
		h.complete.mockRejectedValue(new Error("private error"));
		await h.start("Task");
		expect(h.complete).toHaveBeenCalledTimes(2);
		expect(decisions(h)[0]).toMatchObject({ actualBackend: "default", effort: "medium" });
	});

	it.each(["off", "shutdown", "model", "runtime", "escape"])("does not fall back or apply late results after %s", async (action) => {
		const judge = createModel("judge");
		await saveChat(judge);
		availableChats = [judge];
		const h = createHarness(createModel());
		h.ctx.mode = "tui";
		const controller = new AbortController();
		h.ctx.signal = controller.signal;
		let release!: (response: AssistantMessage) => void;
		h.complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const pending = h.start("Task");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		if (action === "off") await h.command("off");
		if (action === "shutdown") await h.emit({ type: "session_shutdown", reason: "quit" });
		if (action === "model") {
			const next = createModel("next");
			await h.pi.setModel(next);
			await h.emit({ type: "model_select", model: next, previousModel: createModel(), source: "set" });
		}
		if (action === "runtime") controller.abort();
		if (action === "escape") h.ctx.ui.onTerminalInput.mock.calls[0]![0]("\u001b");
		await pending;
		release(routerResponse(judge));
		await Promise.resolve();
		expect(h.complete).toHaveBeenCalledTimes(1);
		expect(h.pi.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("cancels a fixed chat availability check without requesting either backend", async () => {
		await saveChat(createModel("judge"));
		const h = createHarness(createModel());
		let release!: (models: Model<Api>[]) => void;
		h.ctx.modelRegistry.getAvailableOfType.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
		const pending = h.start("Task");
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		await h.command("off");
		await pending;
		release([createModel("judge")]);
		await Promise.resolve();
		expect(h.complete).not.toHaveBeenCalled();
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("gives a non-current chat timeout one answering-model fallback and ignores the late reply", async () => {
		const judge = createModel("judge");
		await saveChat(judge);
		availableChats = [judge];
		vi.useFakeTimers();
		vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), ms);
			return controller.signal;
		});
		try {
			const h = createHarness(createModel());
			let release!: (response: AssistantMessage) => void;
			h.complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
			const pending = h.start("Task");
			await vi.advanceTimersByTimeAsync(9_999);
			expect(h.complete).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(h.complete).toHaveBeenCalledTimes(2);
			expect(decisions(h)[0]).toMatchObject({ actualBackend: "test/current (fallback)", selectorAttempts: [
				expect.objectContaining({ backend: "chat", outcome: "failed", interruption: "deadline" }),
				expect.objectContaining({ backend: "current-model", outcome: "selected" }),
			] });
			const saved = JSON.stringify(h.pi.appendEntry.mock.calls);
			release(routerResponse(judge));
			await vi.advanceTimersByTimeAsync(0);
			expect(JSON.stringify(h.pi.appendEntry.mock.calls)).toBe(saved);
		} finally { vi.clearAllTimers(); vi.useRealTimers(); }
	});

	it("saves a fixed chat picker choice and restores it without changing the answering model", async () => {
		const judge = createModel("judge");
		availableChats = [judge];
		const h = createHarness(createModel());
		h.ctx.mode = "tui";
		h.ctx.ui.custom.mockResolvedValue({ type: "chat", provider: judge.provider, id: judge.id });
		await h.command("model");
		expect(h.pi.setModel).not.toHaveBeenCalled();
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toEqual({ backend: { type: "chat", provider: "test", id: "judge" } });
		const restarted = createHarness(createModel("answer"));
		await restarted.start("Task");
		expect(restarted.complete.mock.calls[0]![0]).toBe(judge);
	});

	it("rewrites only the initial current-model setting, once, to a fixed chat identity", async () => {
		await writeFile(join(agentDirectory, "pi-auto.json"), JSON.stringify({ backend: { type: "current-model" }, defaultEnabled: false, other: 42 }));
		availableModels = [classifierModel];
		const h = createHarness(createModel());
		await h.emit({ type: "session_start", reason: "startup" });
		const saved = JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"));
		expect(saved).toEqual({ backend: { type: "chat", provider: "test", id: "current" }, defaultEnabled: false, other: 42 });
		expect(h.ctx.modelRegistry.getAvailableOfType).not.toHaveBeenCalled();
		const next = createModel("next");
		await h.pi.setModel(next);
		await h.emit({ type: "model_select", model: next, previousModel: createModel(), source: "set" });
		expect(JSON.parse(await readFile(join(agentDirectory, "pi-auto.json"), "utf8"))).toEqual(saved);
	});

	it.each([false, true])("leaves no-model configuration intact (initial setting=%j) and opens the picker", async (initial) => {
		const path = join(agentDirectory, "pi-auto.json");
		if (initial) await writeFile(path, '{"backend":{"type":"current-model"},"other":42}');
		const h = createHarness(undefined);
		await h.emit({ type: "session_start", reason: "startup" });
		await h.start("No answerer");
		expect(h.complete).not.toHaveBeenCalled();
		if (initial) expect(await readFile(path, "utf8")).toBe('{"backend":{"type":"current-model"},"other":42}');
		else await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
		h.ctx.mode = "tui";
		await h.command("model");
		expect(h.ctx.ui.custom).toHaveBeenCalledTimes(1);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-auto", "auto · Not selected");
	});
});
