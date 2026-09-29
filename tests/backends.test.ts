import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { availableClassifiers, defaultBackend } from "../src/backends.ts";
import { selectWithClassifier, type ClassifierInvocation } from "../src/classifier.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function runtime() {
	vi.stubEnv("TYPESAFE_API_KEY", undefined);
	const credentials = new InMemoryCredentialStore();
	const models = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
	return { credentials, models, registry: new ModelRegistry(models) };
}

describe("Pi classifier availability and authentication", () => {
	it("excludes catalog-only classifiers, includes stored credentials without an environment switch", async () => {
		const { credentials, registry } = await runtime();
		const fetch = vi.fn(() => { throw new Error("No network allowed"); });
		vi.stubGlobal("fetch", fetch);
		expect(registry.findOfType("classifier", "typesafe", "jev-latest")).toBeDefined();
		expect(await registry.getAvailableOfType("classifier", "typesafe")).toEqual([]);
		await credentials.modify("typesafe", async () => ({ type: "api_key", key: "stored-key" }));
		const available = await registry.getAvailableOfType("classifier", "typesafe");
		expect(available.map((model) => model.id)).toContain("jev-latest");
		expect(defaultBackend([...available])).toEqual({ type: "classifier", provider: "typesafe", id: "jev-latest" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("waits for asynchronous Pi availability, stable-sorts by provider/id and prefers direct TypeSafe", async () => {
		const { registry } = await runtime();
		const base = registry.findOfType("classifier", "typesafe", "jev-latest")!;
		const entries = [{ ...base, provider: "z", id: "a" }, { ...base, provider: "a", id: "z" }, { ...base, provider: "a", id: "a" }];
		vi.spyOn(registry, "getAvailableOfType").mockImplementationOnce(async () => {
			await Promise.resolve();
			return entries;
		});
		const signal = new AbortController().signal;
		const sorted = await availableClassifiers(registry, signal);
		expect(sorted.map(({ provider, id }) => `${provider}/${id}`)).toEqual(["a/a", "a/z", "z/a"]);
		expect(registry.getAvailableOfType).toHaveBeenCalledWith("classifier", undefined, { signal });
		expect(defaultBackend(sorted)).toEqual({ type: "classifier", provider: "a", id: "a" });
		expect(defaultBackend([...sorted, base])).toEqual({ type: "classifier", provider: "typesafe", id: "jev-latest" });
		expect(defaultBackend([])).toBeUndefined();
	});

	it("classifies with an arbitrary provider/id and leaves authentication to Pi", async () => {
		const { registry } = await runtime();
		const base = registry.findOfType("classifier", "typesafe", "jev-latest")!;
		const model = { ...base, provider: "custom", id: "classify/tasks-v2", name: "Custom classifier" };
		vi.spyOn(registry, "getAvailableOfType").mockResolvedValue([model]);
		const classify = vi.spyOn(registry, "classify").mockResolvedValue({
			api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
			answers: { effort: { type: "choice", choice: "high", confidence: 0.9, probabilities: { low: 0.1, high: 0.9 } } },
		});
		const invocation: ClassifierInvocation = { signal: new AbortController().signal, state: {
			task: "Task", taskCharacters: 4, taskTruncated: false, hasImages: false, contextOmitted: true,
			model: { id: "chat/current", name: "Current" }, currentEffort: "low", supportedEfforts: ["low", "high"],
		} };
		const result = await selectWithClassifier(registry, invocation, { type: "classifier", provider: model.provider, id: model.id });
		expect(result).toMatchObject({ effort: "high", model: "classify/tasks-v2" });
		expect(classify).toHaveBeenCalledWith(model, expect.objectContaining({ state: invocation.state }), { signal: invocation.signal, maxRetries: 0 });
		expect(registry.getAvailableOfType).toHaveBeenCalledWith("classifier", "custom", { signal: invocation.signal });
	});
});
