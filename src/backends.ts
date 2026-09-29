import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectorBackend } from "./settings.ts";

export type ClassifierRegistry = Pick<ExtensionContext["modelRegistry"], "getAvailableOfType" | "classify">;

export async function availableClassifiers(registry: ClassifierRegistry, signal: AbortSignal) {
	// Pi checks credentials and provider-specific availability, not just catalog membership.
	const models = await registry.getAvailableOfType("classifier", undefined, { signal });
	signal.throwIfAborted();
	return [...models].sort((a, b) => {
		const left = `${a.provider}/${a.id}`, right = `${b.provider}/${b.id}`;
		return left < right ? -1 : left > right ? 1 : 0;
	});
}

export function defaultBackend(models: Awaited<ReturnType<typeof availableClassifiers>>, currentModel?: Model<Api>): SelectorBackend | undefined {
	const model = models.find((model) => model.provider === "typesafe" && model.id === "jev-latest") ?? models[0];
	return model ? { type: "classifier", provider: model.provider, id: model.id } : currentModel ? { type: "chat", provider: currentModel.provider, id: currentModel.id } : undefined;
}
