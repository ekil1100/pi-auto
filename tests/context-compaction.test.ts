import { describe, expect, it } from "vitest";
import {
	buildContextCandidates, packContext, CANDIDATE_BUDGET, CONTEXT_BUDGET, MAX_CANDIDATES,
	type CandidatePool, type ContextRating, type Importance,
} from "../src/context-compaction.ts";
import type { HistoryMessage } from "../src/session-context.ts";

function message(entryId: string, role: HistoryMessage["role"], text: string): HistoryMessage {
	return { entryId, role, text };
}
function rate(pool: CandidatePool, importance: Importance = "required"): ContextRating[] {
	return pool.candidates.map(({ id }) => ({ id, importance }));
}
function ready(pool: CandidatePool, ratings?: readonly ContextRating[]) {
	const result = packContext(pool, ratings);
	expect(result.status).toBe("ready");
	if (result.status !== "ready") throw new Error("Expected packed context");
	expect(result.text.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
	return result;
}
function exactSources(messages: HistoryMessage[], pool: CandidatePool) {
	expect(pool.candidateCharacters).toBe(JSON.stringify(pool.candidates).length);
	expect(pool.candidateCharacters).toBeLessThanOrEqual(CANDIDATE_BUDGET);
	expect(pool.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
	for (const candidate of pool.candidates) {
		const original = messages.find(({ entryId }) => entryId === candidate.entryId)!;
		expect(candidate.text).toBe(original.text.slice(candidate.start, candidate.end));
		expect(candidate.start).toBeGreaterThanOrEqual(0);
		expect(candidate.end).toBeLessThanOrEqual(original.text.length);
	}
}

describe("buildContextCandidates", () => {
	it("preserves source ranges, Chinese, CRLF, code indentation and negation verbatim", () => {
		const messages = [message("用户", "user", "  不要删除 src/权限.ts，不能回退。\r\n\r\n规则：\r\n- 不发请求\r\n- 不改主模型\r\n\r\n```ts\r\n  const allowed = false;\r\n\r\n  deny();\r\n```\r\n")];
		const pool = buildContextCandidates(messages);
		exactSources(messages, pool);
		expect(pool.truncated).toBe(false);
		const result = ready(pool);
		expect(result.text).toContain("不要删除 src/权限.ts，不能回退。");
		expect(result.text).toContain("```ts\r\n  const allowed = false;\r\n\r\n  deny();\r\n```");
	});

	it("exposes the middle constraint rather than taking the head and tail", () => {
		const constraint = "不要部署生产环境；只允许修改测试。";
		const messages = [message("long-user", "user", `${"前".repeat(3_000)}。\n\n${constraint}\n\n${"后".repeat(3_000)}。`)];
		const pool = buildContextCandidates(messages);
		exactSources(messages, pool);
		expect(packContext(pool)).toEqual({ status: "failed", reason: "context_requires_classification" });
		const ratings = pool.candidates.map(({ id, text }): ContextRating => ({ id, importance: text.includes(constraint) ? "required" : "irrelevant" }));
		const result = ready(pool, ratings);
		expect(result.text).toContain(constraint);
		expect(result.text).not.toContain("前".repeat(100));
		expect(result.text).not.toContain("后".repeat(100));
		expect(result.text.match(/\[Context omitted\]/g)).toHaveLength(2);
	});

	it("splits long prose only at complete English and Chinese sentence boundaries", () => {
		const sentences = [`Never ${"a".repeat(700)}! `, `不要${"删".repeat(700)}。`, `Keep ${"b".repeat(700)}!`];
		const messages = [message("sentences", "user", sentences.join(""))];
		const pool = buildContextCandidates(messages);
		exactSources(messages, pool);
		expect(pool.candidates.map(({ text }) => text)).toEqual(sentences);
	});

	it.each(["e.g.", "i.e.", "Dr.", "vs.", "U.S."])("never splits a negated instruction at the abbreviation %s", (abbreviation) => {
		const constraint = `${"B".repeat(970)}. Do not ${abbreviation} delete src/auth.ts or deploy to production.`;
		const pool = buildContextCandidates([message("old", "user", "x".repeat(6_100)), message("constraint", "user", constraint)]);
		expect(packContext(pool)).toEqual({ status: "failed", reason: "context_requires_classification" });
		const selected = pool.candidates.filter(({ text }) => text.includes("delete src/auth.ts"));
		expect(selected).toHaveLength(1);
		expect(selected[0]!.text).toContain(`Do not ${abbreviation} delete`);
		const result = ready(pool, pool.candidates.map(({ id, text }) => ({ id, importance: text.includes("delete src/auth.ts") ? "required" : "irrelevant" })));
		expect(result.text).toContain(constraint);
	});

	it.each([
		["fence", `Code:\n\n\`\`\`ts\n${"  work();\n\n".repeat(120)}\`\`\``],
		["tilde fence", `~~~text\n${"a\n\n".repeat(400)}~~~`],
		["unclosed fence", `\`\`\`ts\n${"  work();\n\n".repeat(120)}`],
		["list", `## Required constraints\n\n- ${"Never change this. ".repeat(70)}\n\n- Do not deploy.`],
		["list continuation", `Constraints:\n\n- First requirement\n\n    ${"Never deploy. ".repeat(100)}\n\n- Last requirement`],
		["table", `Results:\n\n| Key | Value |\n| --- | --- |\n${"| safe | no |\n".repeat(120)}`],
		["error", `Traceback (most recent call last):\n  File "a.py", line 1\n\nValueError: ${"do not ignore. ".repeat(120)}\n    at run (src/a.ts:1)`],
	])("keeps %s and its dependent content atomic", (_name, text) => {
		const pool = buildContextCandidates([message("atomic", "user", text)]);
		expect(pool.candidates).toHaveLength(1);
		expect(pool.candidates[0]!.text).toBe(text);
	});

	it("tracks multiple assistant messages with every user unit as a dependency", () => {
		const messages = [
			message("u", "user", `${"x".repeat(1_100)}\n\n${"y".repeat(1_100)}`),
			message("a1", "assistant", "First proposal"), message("a2", "assistant", "Revised proposal"),
			message("u2", "user", "Cancel the previous plan."), message("a3", "assistant", "Cancelled."),
		];
		const pool = buildContextCandidates(messages);
		const userIds = pool.candidates.filter(({ entryId }) => entryId === "u").map(({ id }) => id);
		for (const candidate of pool.candidates.filter(({ entryId }) => ["a1", "a2"].includes(entryId))) {
			expect(candidate.requires).toEqual(userIds);
			expect(candidate.partialTurn).toBe(false);
			expect(candidate.turnId).toBe(pool.candidates[0]!.turnId);
		}
		expect(pool.candidates.at(-1)!.requires).toEqual([pool.candidates.at(-2)!.id]);
		expect(new Set(pool.candidates.map(({ turnId }) => turnId)).size).toBe(2);
		exactSources(messages, pool);
	});

	it("prioritizes the latest user and final assistant before middle replies and older turns", () => {
		const messages = [
			message("older", "user", "o".repeat(8_000)), message("u", "user", "u".repeat(4_000)),
			message("middle", "assistant", "m".repeat(15_000)), message("final", "assistant", "f".repeat(8_000)),
		];
		const pool = buildContextCandidates(messages);
		expect(pool.candidates.map(({ entryId }) => entryId)).toEqual(["older", "u", "final"]);
		expect(pool.truncated).toBe(true);
		exactSources(messages, pool);
	});

	it("prioritizes the latest summary ahead of older turns, while output stays chronological", () => {
		const messages = [
			message("summary", "summary", "s".repeat(10_000)), message("old", "user", "o".repeat(14_000)),
			message("new", "user", "Continue"), message("reply", "assistant", "Continue the approved work"),
		];
		const pool = buildContextCandidates(messages);
		expect(pool.candidates.map(({ entryId }) => entryId)).toEqual(["summary", "new", "reply"]);
		expect(pool.truncated).toBe(true);
		exactSources(messages, pool);
	});

	it("marks genuinely missing users as partial instead of inventing dependencies", () => {
		const pool = buildContextCandidates([
			message("s", "summary", "Earlier request summarized"), message("a", "assistant", "Residual answer"),
			message("a2", "assistant", "Another residual answer"),
		]);
		for (const candidate of pool.candidates.filter(({ role }) => role === "assistant")) {
			expect(candidate.partialTurn).toBe(true);
			expect(candidate.requires).toEqual([]);
		}
		expect(ready(pool).text).toContain("partialTurn=true");
	});

	it("does not create orphan replies when an older user cannot fit", () => {
		const pool = buildContextCandidates([
			message("old", "user", "x".repeat(CANDIDATE_BUDGET)), message("orphan", "assistant", "Small answer"),
			message("new", "user", "New request"),
		]);
		expect(pool.candidates.map(({ entryId }) => entryId)).toEqual(["new"]);
		expect(pool.truncated).toBe(true);
	});

	it.each(["", " \n\t"])("does not pin an older user when the latest user has no text: %j", (text) => {
		const messages = [
			message("old", "user", "x".repeat(CANDIDATE_BUDGET)),
			message("old-reply", "assistant", "Answer to the old task"),
			message("image-only", "user", text),
			message("image-reply", "assistant", "The screenshot shows a connection error."),
		];
		const pool = buildContextCandidates(messages);
		expect(pool.error).toBeUndefined();
		expect(pool.truncated).toBe(true);
		expect(pool.candidates).toHaveLength(1);
		expect(pool.candidates[0]).toMatchObject({ entryId: "image-reply", partialTurn: true, requires: [] });
		exactSources(messages, pool);
		expect(ready(pool).text).toContain("The screenshot shows a connection error.");
	});

	it("does not pin an older user when the latest image-only turn has no reply", () => {
		const pool = buildContextCandidates([
			message("old", "user", "x".repeat(CANDIDATE_BUDGET)), message("image-only", "user", ""),
		]);
		expect(pool.error).toBeUndefined();
		expect(pool.truncated).toBe(true);
		expect(pool.candidates).toEqual([]);
		expect(ready(pool).text).toBe("[History omitted from candidate pool]");
	});

	it("omits an oversized indivisible assistant block without slicing it", () => {
		const pool = buildContextCandidates([message("u", "user", "Request"), message("a", "assistant", `\`\`\`\n${"x".repeat(CANDIDATE_BUDGET)}\n\`\`\``)]);
		expect(pool.candidates.map(({ entryId }) => entryId)).toEqual(["u"]);
		expect(pool.truncated).toBe(true);
		expect(ready(pool).text).toContain("[History omitted from candidate pool]");
	});

	it.each([
		"x".repeat(CANDIDATE_BUDGET),
		Array.from({ length: 33 }, () => "x".repeat(1_001)).join("\n\n"),
		'"'.repeat(12_000),
	])("fails if the complete latest user cannot fit", (text) => {
		const pool = buildContextCandidates([message("u", "user", text)]);
		expect(pool.error).toBe("latest_user_exceeds_candidate_budget");
		expect(pool.candidates).toEqual([]);
		expect(pool.candidateCharacters).toBe(2);
		expect(pool.truncated).toBe(true);
		expect(packContext(pool)).toEqual({ status: "failed", reason: pool.error });
	});

	it("counts full JSON escaping, metadata and dependencies against the budget", () => {
		const messages = [message("source\"\\", "user", "Do not change API")];
		for (let i = 0; i < 40; i++) messages.push(message(`a${i}`, "assistant", '"\\'.repeat(300)));
		const pool = buildContextCandidates(messages);
		exactSources(messages, pool);
		expect(pool.truncated).toBe(true);
		expect(pool.candidates.length).toBeLessThan(MAX_CANDIDATES);
		expect(pool.candidates.at(-1)!.entryId).toBe("a39");
	});

	it("caps small candidates at 32 without losing the latest user", () => {
		const messages = Array.from({ length: 60 }, (_, i) => message(`u${i}`, "user", `Task ${i}`));
		const pool = buildContextCandidates(messages);
		expect(pool.candidates).toHaveLength(MAX_CANDIDATES);
		expect(pool.candidates[0]!.entryId).toBe("u28");
		expect(pool.candidates.at(-1)!.entryId).toBe("u59");
		expect(pool.truncated).toBe(true);
		exactSources(messages, pool);
	});
});

describe("packContext", () => {
	it("bypasses classification for short history including summary and all assistant messages", () => {
		const pool = buildContextCandidates([
			message("s", "summary", "Already approved: tests only."), message("u", "user", "继续"),
			message("a1", "assistant", "Checking"), message("a2", "assistant", "No production changes"),
		]);
		const result = ready(pool);
		expect(result.sources.map(({ entryId }) => entryId)).toEqual(["s", "u", "a1", "a2"]);
		expect(result.text).toContain("[summary");
		expect(result.text).not.toContain("omitted");
	});

	it("handles empty history", () => {
		const pool = buildContextCandidates([]);
		expect(pool).toEqual({ candidates: [], candidateCharacters: 2, truncated: false });
		expect(ready(pool)).toEqual({ status: "ready", text: "", sources: [] });
	});

	it("uses the rendered budget, including labels, rather than raw text size", () => {
		const pool = buildContextCandidates([message("u", "user", "x".repeat(CONTEXT_BUDGET - 10))]);
		expect(packContext(pool)).toEqual({ status: "failed", reason: "context_requires_classification" });
		expect(packContext(pool, rate(pool))).toEqual({ status: "failed", reason: "required_context_exceeds_budget" });
	});

	it("fails for an atomic required block rather than truncating code", () => {
		const pool = buildContextCandidates([message("u", "user", "Use this code"), message("a", "assistant", `\`\`\`ts\n${"  doNotDelete();\n".repeat(450)}\`\`\``)]);
		expect(pool.error).toBeUndefined();
		expect(packContext(pool, rate(pool))).toEqual({ status: "failed", reason: "required_context_exceeds_budget" });
	});

	it("includes irrelevant user dependencies of a required assistant in chronological order", () => {
		const pool = buildContextCandidates([
			message("u", "user", `${"a".repeat(1_100)}\n\nDo not deploy.`), message("a", "assistant", "We will only test."),
			message("u2", "user", "Unrelated new task"),
		]);
		const ratings = pool.candidates.map(({ id, role }): ContextRating => ({ id, importance: role === "assistant" ? "required" : "irrelevant" }));
		const result = ready(pool, ratings);
		expect(result.sources.map(({ entryId }) => entryId)).toEqual(["u", "u", "a"]);
		expect(result.text).toContain("Do not deploy.");
	});

	it("fails when the required dependency closure exceeds the final budget", () => {
		const pool = buildContextCandidates([message("u", "user", "u".repeat(5_000)), message("a", "assistant", "a".repeat(1_000))]);
		const ratings = rate(pool, "irrelevant");
		ratings[1]!.importance = "required";
		expect(packContext(pool, ratings)).toEqual({ status: "failed", reason: "required_context_exceeds_budget" });
		ratings[1]!.importance = "useful";
		expect(ready(pool, ratings).sources).toEqual([]);
	});

	it("selects required, useful, then background, newest first within each optional level", () => {
		const pool = buildContextCandidates([
			message("required", "user", "Required constraint"), message("old-useful", "user", "o".repeat(2_500)),
			message("new-useful", "user", "n".repeat(2_500)), message("background", "user", "b".repeat(1_500)),
			message("irrelevant", "user", "Never include me"),
		]);
		const ratings = pool.candidates.map(({ id, entryId }): ContextRating => ({ id, importance: entryId.includes("useful") ? "useful" : entryId as Importance }));
		const result = ready(pool, ratings);
		expect(result.sources.map(({ entryId }) => entryId)).toEqual(["required", "old-useful", "new-useful"]);
		// When both useful units cannot fit, the newer one wins, not the earlier one.
		const crowded = buildContextCandidates([
			message("old", "user", "o".repeat(3_500)), message("new", "user", "n".repeat(3_500)),
		]);
		expect(ready(crowded, rate(crowded, "useful")).sources.map(({ entryId }) => entryId)).toEqual(["new"]);
	});

	it("skips an oversized optional unit and still admits smaller units with dependencies", () => {
		const pool = buildContextCandidates([
			message("u", "user", "Test only"), message("a", "assistant", "Small useful answer"),
			message("huge", "user", "x".repeat(7_000)),
		]);
		const ratings = pool.candidates.map(({ id, role }): ContextRating => ({ id, importance: role === "assistant" ? "useful" : "background" }));
		expect(ready(pool, ratings).sources.map(({ entryId }) => entryId)).toEqual(["u", "a"]);
	});

	it("fills background newest first and budgets truncation markers exactly", () => {
		const pool = buildContextCandidates([
			message("old", "user", "o".repeat(3_500)), message("new", "user", "n".repeat(3_500)),
		]);
		expect(ready(pool, rate(pool, "background")).sources.map(({ entryId }) => entryId)).toEqual(["new"]);
		const bounded = buildContextCandidates([message("u", "user", "x".repeat(5_850))]);
		expect(ready(bounded).text.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
		bounded.truncated = true;
		const packed = ready(bounded, rate(bounded));
		expect(packed.text).toContain("[History omitted from candidate pool]");
	});

	it("retains newer corrections without rewriting the older evidence", () => {
		const pool = buildContextCandidates([
			message("u1", "user", "Deploy src/auth.ts"), message("a1", "assistant", "I suggest a deployment"),
			message("u2", "user", "Do NOT deploy src/auth.ts; cancel that plan. Tests only."),
			message("a2", "assistant", "Understood. Tests only."),
		]);
		const ratings = pool.candidates.map(({ id, entryId }): ContextRating => ({ id, importance: entryId === "a2" ? "required" : "irrelevant" }));
		const packed = ready(pool, ratings);
		expect(packed.sources.map(({ entryId }) => entryId)).toEqual(["u2", "a2"]);
		expect(packed.text).toContain("Do NOT deploy src/auth.ts; cancel that plan. Tests only.");
		expect(packed.text).not.toContain("I suggest");
	});

	it("keeps a summary-only history and does not deduplicate it against user text", () => {
		const pool = buildContextCandidates([message("s", "summary", "Tests only"), message("u", "user", "Tests only")]);
		expect(ready(pool).sources.map(({ role }) => role)).toEqual(["summary", "user"]);
		expect(ready(buildContextCandidates([message("s", "summary", "Tests only")])).sources).toEqual([
			{ entryId: "s", role: "summary", start: 0, end: 10 },
		]);
	});

	it("retains role and turn attribution for identical text instead of unsafe deduplication", () => {
		const pool = buildContextCandidates([message("u", "user", "Keep this"), message("a", "assistant", "Keep this"), message("u2", "user", "Keep this")]);
		expect(ready(pool).sources.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
	});

	it("includes omission markers within the final budget even when all candidates are irrelevant", () => {
		const pool = buildContextCandidates([message("u", "user", "x".repeat(8_000))]);
		expect(ready(pool, rate(pool, "irrelevant"))).toEqual({ status: "ready", text: "[Context omitted]", sources: [] });
	});

	it.each([
		["missing", [], "missing_context_rating"],
		["duplicate", [{ id: "ID", importance: "required" }, { id: "ID", importance: "useful" }], "duplicate_context_rating"],
		["unknown", [{ id: "private text", importance: "required" }], "unknown_context_rating"],
		["importance", [{ id: "ID", importance: "private text" }], "invalid_context_rating"],
		["null", [null], "invalid_context_rating"],
		["missing id", [{ importance: "required" }], "invalid_context_rating"],
		["wrong id", [{ id: 12, importance: "required" }], "invalid_context_rating"],
		["not an array", null, "invalid_context_ratings"],
	])("strictly rejects %s ratings even for short history", (_name, input, reason) => {
		const pool = buildContextCandidates([message("u", "user", "Secret content")]);
		const ratings = Array.isArray(input) ? input.map((rating) => rating && "id" in rating && rating.id === "ID" ? { ...rating, id: pool.candidates[0]!.id } : rating) : input;
		expect(packContext(pool, ratings as unknown as ContextRating[])).toEqual({ status: "failed", reason });
	});

	it("accepts ratings in arbitrary order and does not mutate inputs", () => {
		const messages = [message("u", "user", "Question"), message("a", "assistant", "Answer")];
		const before = structuredClone(messages);
		const pool = buildContextCandidates(messages);
		const ratings = rate(pool).reverse();
		const poolBefore = structuredClone(pool);
		const ratingsBefore = structuredClone(ratings);
		expect(ready(pool, ratings).sources.map(({ entryId }) => entryId)).toEqual(["u", "a"]);
		expect(messages).toEqual(before);
		expect(pool).toEqual(poolBefore);
		expect(ratings).toEqual(ratingsBefore);
	});

	it("fails closed for missing dependency IDs", () => {
		const pool = buildContextCandidates([message("a", "assistant", "Answer")]);
		pool.candidates[0]!.requires = ["missing"];
		expect(packContext(pool, rate(pool))).toEqual({ status: "failed", reason: "invalid_context_dependencies" });
	});
});
