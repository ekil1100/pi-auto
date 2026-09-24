import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore, type Api, type Model } from "@earendil-works/pi-ai";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { registerOpenAIEffortCache } from "../src/openai-effort-cache.ts";

type Item = Record<string, unknown>;
interface Body { model: string; reasoning: { effort: string }; input: Item[] }

function response(sequence: number, tool: boolean): Response {
	const item = tool
		? { type: "function_call", id: `fc_${sequence}`, call_id: `call_${sequence}`, name: "probe", arguments: "{}", status: "completed" }
		: { type: "message", id: `msg_${sequence}`, role: "assistant", phase: "final_answer", status: "completed",
			content: [{ type: "output_text", text: `Answer ${sequence}`, annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: `resp_${sequence}` } },
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: `resp_${sequence}`, status: "completed", output: [item],
			usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 0 } } } },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		status: 200, headers: { "content-type": "text/event-stream" },
	});
}

describe("real Pi 0.87.1 request pipeline (offline)", () => {
	it.each(["openai", "openai-codex"] as const)("replays updates through %s serialization, hook dispatch, SSE and tools", async (provider) => {
		const directory = await mkdtemp(join(tmpdir(), "pi-auto-runtime-"));
		const bodies: Body[] = [];
		const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
			const text = new Headers(init?.headers).get("content-encoding") === "zstd"
				? zstdDecompressSync(init!.body as Uint8Array).toString("utf8") : String(init?.body);
			bodies.push(JSON.parse(text) as Body);
			return response(bodies.length, bodies.length === 2);
		});
		const errors: unknown[] = [];
		const model: Model<Api> = {
			id: "gpt-6-astra", name: "GPT-6 Astra", provider,
			api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
			baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
			reasoning: true, thinkingLevelMap: { off: null, minimal: null, max: "max" },
			input: ["text"], contextWindow: 100_000, maxTokens: 8_192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		const apiKey = provider === "openai" ? "synthetic-key" : `test.${Buffer.from(JSON.stringify({
			"https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
		})).toString("base64")}.test`;
		runtime.registerProvider(provider, {
			api: model.api, baseUrl: model.baseUrl, apiKey,
			streamSimple: (current, context, options) => provider === "openai"
				? openaiStream(current as Model<"openai-responses">, context, { ...options, fetch: fetchMock })
				: codexStream(current as Model<"openai-codex-responses">, context, { ...options, fetch: fetchMock, transport: "sse" }),
		});
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", transport: "sse" });
		const loader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Offline test", extensionFactories: [registerOpenAIEffortCache],
		});
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			await loader.reload();
			const tool = vi.fn(async () => {
				session!.setThinkingLevel("max");
				return { content: [{ type: "text" as const, text: "Tool complete" }], details: undefined };
			});
			({ session } = await createAgentSession({
				cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: "low",
				settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), noTools: "builtin",
				customTools: [{ name: "probe", label: "Probe", description: "Offline probe", parameters: Type.Object({}), execute: tool }],
			}));
			await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
			await session.prompt("First");
			expect(session.getLastAssistantText(), JSON.stringify(session.messages.at(-1))).toBe("Answer 1");
			session.setThinkingLevel("high");
			await session.prompt("Second");
			expect(tool).toHaveBeenCalledOnce();
			expect(session.getLastAssistantText()).toBe("Answer 3");
			await session.prompt("Third");
			expect(session.getLastAssistantText()).toBe("Answer 4");
			expect(errors).toEqual([]);
			expect(bodies).toHaveLength(4);
			expect(bodies.map((body) => body.reasoning.effort)).toEqual(["low", "low", "low", "low"]);
			expect(bodies.map((body) => body.input.filter((item) => item.type === "configuration_update")))
				.toEqual([[], [{ type: "configuration_update", reasoning: { effort: "high" } }],
					[{ type: "configuration_update", reasoning: { effort: "high" } }],
					[{ type: "configuration_update", reasoning: { effort: "high" } }, { type: "configuration_update", reasoning: { effort: "max" } }]]);
			for (let index = 1; index < bodies.length; index++) {
				const previous = bodies[index - 1]!;
				expect(bodies[index]!.input.slice(0, previous.input.length)).toEqual(previous.input);
			}
			expect(bodies[2]!.input.at(-1)).toMatchObject({ type: "function_call_output", output: "Tool complete" });
			for (const body of bodies) {
				for (let index = 0; index < body.input.length; index++) {
					if (body.input[index]?.type === "configuration_update") expect(body.input[index + 1]?.role).toBe("user");
				}
			}
		} finally {
			session?.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	});
});
