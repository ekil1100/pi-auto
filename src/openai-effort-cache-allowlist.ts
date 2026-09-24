import type { Api, Model } from "@earendil-works/pi-ai";

const ALLOWLIST = [
	{
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
	},
	{
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		models: ["gpt-6-astra"],
	},
];

export function supportedModel(model: Model<Api> | undefined): string | undefined {
	if (!model?.reasoning) return;
	const endpoint = model.baseUrl.replace(/\/$/, "");
	const supported = ALLOWLIST.some((entry) =>
		entry.provider === model.provider && entry.api === model.api &&
		entry.baseUrl === endpoint && entry.models.includes(model.id));
	return supported ? `${model.provider}/${model.api}/${model.id}` : undefined;
}
