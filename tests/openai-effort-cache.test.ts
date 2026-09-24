import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { SessionManager, type BeforeProviderRequestEvent, type ExtensionAPI, type ExtensionContext, type ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { EFFORT_CACHE_ENTRY_TYPE, registerOpenAIEffortCache } from "../src/openai-effort-cache.ts";

type Item = Record<string, unknown>;
interface Payload extends Item {
	model: string;
	stream: boolean;
	reasoning: { effort: string; [key: string]: unknown };
	input: Item[];
}
const user = (text: string): Item => ({ role: "user", content: [{ type: "input_text", text }] });
const reply = (text: string): Item => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }], phase: "final_answer" });
const update = (effort: string): Item => ({ type: "configuration_update", reasoning: { effort } });
const initial = [user("private-first-task")];
const second = [...initial, reply("private-first-answer"), user("private-second-task")];
const third = [...second, reply("private-second-answer"), user("private-third-task")];

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", api: "openai-responses",
		baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text", "image"],
		contextWindow: 100_000, maxTokens: 8_192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}
function payload(effort: string, input = initial, extra: Item = {}): Payload {
	return { model: "gpt-6-astra", stream: true, reasoning: { effort, summary: "auto" }, input: structuredClone(input), ...extra };
}
function assistant(): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: "Done" }], api: "openai-responses", provider: "openai", model: "gpt-6-astra",
		stopReason: "stop", timestamp: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}
function harness(currentModel = model(), sessionManager = SessionManager.inMemory()) {
	let handler: ExtensionHandler<BeforeProviderRequestEvent, unknown>;
	const appendEntry = vi.fn((type: string, data: unknown) => { sessionManager.appendCustomEntry(type, structuredClone(data)); });
	registerOpenAIEffortCache({
		on: (_name: string, value: typeof handler) => { handler = value; }, appendEntry,
	} as unknown as ExtensionAPI);
	const ctx = { model: currentModel, sessionManager };
	return {
		ctx, appendEntry, session: sessionManager,
		async send(body: unknown): Promise<Payload> {
			const original = structuredClone(body);
			const result = await handler({ type: "before_provider_request", payload: body }, ctx as unknown as ExtensionContext);
			expect(body).toEqual(original); // Neither provider objects nor opaque signatures may be mutated.
			return (result === undefined ? body : result) as Payload;
		},
	};
}

function expectEffort(body: Payload, baseline: string, efforts: string[]) {
	expect(body.reasoning.effort).toBe(baseline);
	expect(body.input.filter((item) => item.type === "configuration_update")).toEqual(efforts.map(update));
	for (let index = 0; index < body.input.length; index++) {
		if (body.input[index]?.type === "configuration_update") expect(body.input[index + 1]?.role).toBe("user");
	}
}

describe("OpenAI effort cache history", () => {
	it("establishes the first request without an update and preserves unrelated fields", async () => {
		const h = harness();
		const body = payload("low", initial, { tools: [{ type: "function", name: "read" }], prompt_cache_key: "session", instructions: "Instructions" });
		expect(await h.send(body)).toEqual(body);
		expect(h.appendEntry).toHaveBeenCalledExactlyOnceWith(EFFORT_CACHE_ENTRY_TYPE, expect.objectContaining({ version: 1, baseline: "low", updates: [] }));
		expect(h.session.buildSessionContext().messages).toEqual([]);
		const saved = JSON.stringify(h.appendEntry.mock.calls);
		for (const secret of ["private-first-task", "Instructions", "prompt_cache_key", '"tools"']) expect(saved).not.toContain(secret);
	});

	it("keeps exact prefixes and all update positions through low → high → medium → low", async () => {
		const h = harness();
		const first = await h.send(payload("low"));
		const next = await h.send(payload("high", second));
		expectEffort(next, "low", ["high"]);
		expect(next.input.slice(0, first.input.length)).toEqual(first.input);
		expect(next.input[2]).toEqual(update("high"));
		const last = await h.send(payload("medium", third));
		expectEffort(last, "low", ["high", "medium"]);
		expect(last.input.slice(0, next.input.length)).toEqual(next.input);
		const fourth = await h.send(payload("low", [...third, reply("Third"), user("Fourth")]));
		expectEffort(fourth, "low", ["high", "medium", "low"]);
		expect(fourth.input.slice(0, last.input.length)).toEqual(last.input);
	});

	it("coalesces effort changes before dispatch and never rewrites a sent user on retries", async () => {
		const h = harness();
		await h.send(payload("low"));
		// Only the effort on the dispatched payload matters, not intermediate UI choices.
		const changed = await h.send(payload("medium", second));
		for (const effort of ["medium", "high", "low", "max"]) {
			expect(await h.send(payload(effort, second))).toEqual(changed);
		}
		for (let attempt = 0; attempt < 3; attempt++) expect(await h.send(changed)).toEqual(changed);
		expect(h.appendEntry).toHaveBeenCalledTimes(2);
		const next = await h.send(payload("max", third));
		expectEffort(next, "low", ["medium", "max"]);
	});

	it("does not create updates when the effort stays the same", async () => {
		const h = harness();
		await h.send(payload("low"));
		expectEffort(await h.send(payload("low", second)), "low", []);
		await h.send(payload("high", third));
		expectEffort(await h.send(payload("high", [...third, reply("Third"), user("Fourth")])), "low", ["high"]);
	});

	it("defers a manual tool-turn effort change until a new user, preserving opaque reasoning and tools", async () => {
		const h = harness();
		await h.send(payload("low"));
		const sent = await h.send(payload("high", second));
		const toolHistory = [...second,
			{ type: "reasoning", id: "rs_1", encrypted_content: "opaque-signature", summary: [] },
			{ type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
			{ type: "function_call_output", call_id: "call_1", output: "private-tool-result" }];
		const continuation = await h.send(payload("max", toolHistory));
		expectEffort(continuation, "low", ["high"]);
		expect(continuation.input.slice(0, sent.input.length)).toEqual(sent.input);
		expect(continuation.input.slice(-3)).toEqual(toolHistory.slice(-3));
		const next = await h.send(payload("max", [...toolHistory, reply("Done"), user("Next")]));
		expectEffort(next, "low", ["high", "max"]);
		expect(next.input.slice(0, continuation.input.length)).toEqual(continuation.input);
	});

	it.each(["function_call", "custom_tool_call"])("does not add an update while a %s is unresolved", async (type) => {
		const h = harness();
		await h.send(payload("low"));
		const pending = [...initial, { type, call_id: "pending" }, user("Steering")];
		expectEffort(await h.send(payload("high", pending)), "low", []);
	});

	it("only updates a new user suffix, not a reconstructed user before a tool result", async () => {
		const h = harness();
		await h.send(payload("low"));
		const history = [...second, { type: "function_call", call_id: "a" }, { type: "function_call_output", call_id: "a", output: "done" }];
		expectEffort(await h.send(payload("high", history)), "low", []);
	});

	it("preserves image input and inserts a single update before multiple queued users", async () => {
		const h = harness();
		await h.send(payload("low"));
		const users = [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,private" }] }, user("More instructions")];
		const result = await h.send(payload("high", [...initial, reply("Ready"), ...users]));
		expectEffort(result, "low", ["high"]);
		expect(result.input.slice(-2)).toEqual(users);
	});

	it("replays a failed request after recovery omits an unsent assistant attempt", async () => {
		const h = harness();
		await h.send(payload("low"));
		const sent = await h.send(payload("high", second));
		const failed = h.session.appendMessage({ ...assistant(), stopReason: "error", errorMessage: "Transient failure" });
		h.session.appendContextEdit(failed, null);
		expect(await h.send(payload("high", second))).toEqual(sent);
		expect(h.appendEntry).toHaveBeenCalledTimes(2);
	});

	it("recovers exact history from disk without storing request contents", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-auto-effort-"));
		try {
			const session = SessionManager.create(process.cwd(), directory);
			const h = harness(model(), session);
			await h.send(payload("low"));
			const sent = await h.send(payload("high", second));
			session.appendMessage(assistant()); // Flush the initial session entries to disk.
			const restored = harness(model(), SessionManager.open(session.getSessionFile()!));
			expect(await restored.send(payload("high", second))).toEqual(sent);
			expect(restored.appendEntry).not.toHaveBeenCalled();
			expectEffort(await restored.send(payload("medium", third)), "low", ["high", "medium"]);
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

	it("follows active branches and forks instead of abandoned updates", async () => {
		const h = harness();
		await h.send(payload("low"));
		const root = h.session.getLeafId()!;
		const abandoned = await h.send(payload("high", second));
		const oldLeaf = h.session.getLeafId()!;
		h.session.branch(root);
		const alternate = await h.send(payload("medium", second));
		expectEffort(alternate, "low", ["medium"]);
		h.session.branch(oldLeaf);
		expect(await h.send(payload("high", second))).toEqual(abandoned);
		h.session.createBranchedSession(oldLeaf);
		const forked = harness(model(), h.session);
		expect(await forked.send(payload("high", second))).toEqual(abandoned);
	});

	it.each(["changed", "shorter", "instructions"])("resets the baseline when history is %s", async (change) => {
		const h = harness();
		await h.send(payload("low"));
		await h.send(payload("high", second));
		const next = payload("medium", change === "shorter" ? initial : third,
			change === "instructions" ? { instructions: "New Codex instructions" } : {});
		if (change === "changed") next.input[0] = user("Edited history");
		expectEffort(await h.send(next), "medium", []);
	});

	it("resets on local compaction even when the retained input is identical", async () => {
		const h = harness();
		const firstId = h.session.appendMessage({ role: "user", content: "First", timestamp: 1 });
		await h.send(payload("low"));
		await h.send(payload("high", second));
		h.session.appendCompaction("Summary", firstId, 80_000);
		expectEffort(await h.send(payload("medium", second)), "medium", []);
		expectEffort(await h.send(payload("max", third)), "medium", ["max"]);
	});

	it("resets on a model switch away and back even without an intervening request", async () => {
		const h = harness();
		await h.send(payload("low"));
		await h.send(payload("high", second));
		h.session.appendModelChange("anthropic", "claude");
		h.session.appendModelChange("openai", "gpt-6-astra");
		expectEffort(await h.send(payload("medium", third)), "medium", []);
	});

	it("resets a branch summary and does not reuse older metadata behind malformed state", async () => {
		const h = harness();
		await h.send(payload("low"));
		const leaf = h.session.getLeafId()!;
		h.session.branchWithSummary(leaf, "Summary", leaf);
		expectEffort(await h.send(payload("high", second)), "high", []);
		h.session.appendCustomEntry(EFFORT_CACHE_ENTRY_TYPE, { version: 42 });
		expectEffort(await h.send(payload("medium", third)), "medium", []);
	});
});

describe("effort cache capability boundaries", () => {
	it.each([
		model(), model({ id: "gpt-6-sol" }), model({ id: "gpt-6-luna" }),
		model({ provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }),
	])("supports the explicit $provider/$id API and endpoint", async (current) => {
		const h = harness(current);
		await h.send(payload("low", initial, { model: current.id }));
		expectEffort(await h.send(payload("high", second, { model: current.id })), "low", ["high"]);
	});

	it.each([
		{ provider: "third-party" }, { api: "openai-completions" }, { api: "anthropic-messages" },
		{ id: "gpt-5.5" }, { id: "gpt-6-astra-pro" }, { id: "gpt-6-future" }, { id: "gpt-6-astra-2026-09-01" },
		{ baseUrl: "https://proxy.test/v1" }, { baseUrl: "https://api.openai.com.evil.test/v1" },
		{ baseUrl: "https://api.openai.com/v1/responses/compact" }, { reasoning: false },
		{ provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", id: "gpt-6-sol" },
		{ provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://proxy.test/backend-api" },
	] satisfies Partial<Model<Api>>[])("leaves unsupported model/provider/endpoint unchanged: %j", async (overrides) => {
		const h = harness(model(overrides));
		const first = payload("low", initial, { model: h.ctx.model.id });
		const next = payload("high", second, { model: h.ctx.model.id });
		expect(await h.send(first)).toEqual(first);
		expect(await h.send(next)).toEqual(next);
		expect(h.appendEntry).not.toHaveBeenCalled();
	});

	it.each([
		{ reasoning: { effort: "high", mode: "pro" } }, { reasoning: { effort: "high", mode: "future" } },
		{ multi_agent: { enabled: true } }, { multi_agent: {} }, { stream: false },
		{ context_management: [{ type: "compaction", compact_threshold: 10_000 }] },
		{ context_management: [] }, { truncation: "auto" }, { previous_response_id: "resp_1" }, { conversation: "conv_1" },
		{ input: [{ type: "compaction", encrypted_content: "opaque" }] }, { input: [{ type: "compaction_trigger" }] },
		{ input: [{ ...user("Next"), agent: { agent_name: "/root" } }] },
		{ input: [{ type: "item_reference", id: "old" }] }, { input: "String input" }, { input: [] },
		{ input: [null] }, { reasoning: { summary: "auto" } }, { reasoning: { effort: "future" } },
		{ reasoning: { effort: "none" } },
		{ model: "gpt-6-sol" },
	])("does not inject in unsupported request mode %j and ends the old baseline", async (extra) => {
		const h = harness();
		await h.send(payload("low"));
		await h.send(payload("high", second));
		const unsupported = payload("high", third, extra);
		expect(await h.send(unsupported)).toEqual(unsupported);
		expect(h.appendEntry).toHaveBeenLastCalledWith(EFFORT_CACHE_ENTRY_TYPE, null);
		expectEffort(await h.send(payload("medium", third)), "medium", []);
	});

	it("accepts explicit standard mode, disabled truncation and single-agent mode", async () => {
		const h = harness();
		await h.send(payload("low"));
		expectEffort(await h.send(payload("high", second, {
			reasoning: { effort: "high", mode: "standard" }, truncation: "disabled", multi_agent: { enabled: false },
		})), "low", ["high"]);
	});

	it("keeps provider-mapped none effort for Sol instead of inventing an off wire value", async () => {
		const h = harness(model({ id: "gpt-6-sol" }));
		await h.send(payload("none", initial, { model: "gpt-6-sol" }));
		expectEffort(await h.send(payload("high", second, { model: "gpt-6-sol" })), "none", ["high"]);
		expectEffort(await h.send(payload("none", third, { model: "gpt-6-sol" })), "none", ["high", "none"]);
	});

	it.each([
		{ input: [...initial, update("high"), user("Next")] },
		{ input: [...initial, reply("First"), update("max"), user("Next")] },
		{ input: [...initial, reply("First"), update("high"), update("max"), user("Next")] },
	])("does not take over foreign, moved or adjacent updates: %j", async ({ input }) => {
		const h = harness();
		await h.send(payload("low"));
		await h.send(payload("high", second));
		const body = payload("medium", input);
		expect(await h.send(body)).toEqual(body);
		expect(h.appendEntry).toHaveBeenLastCalledWith(EFFORT_CACHE_ENTRY_TYPE, null);
	});

	it.each([null, undefined, 1, "payload", []])("ignores a non-object payload %j", async (body) => {
		const h = harness();
		expect(await h.send(body)).toEqual(body);
		expect(h.appendEntry).not.toHaveBeenCalled();
	});
});
