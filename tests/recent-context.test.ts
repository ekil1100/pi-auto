import { describe, expect, it } from "vitest";
import { getRecentContext } from "../src/recent-context.ts";
import type { HistoryMessage } from "../src/session-context.ts";

function message(entryId: string, role: HistoryMessage["role"], text: string): HistoryMessage {
	return { entryId, role, text };
}

function exactContext(history: readonly HistoryMessage[]) {
	const before = structuredClone(history);
	const result = getRecentContext(history);
	expect(history).toEqual(before);
	expect(result.sources.length).toBeLessThanOrEqual(2);
	const parts = result.sources.map(({ entryId, role, start, end }) => {
		const original = history.find((entry) => entry.entryId === entryId)!;
		expect(role).toBe(original.role);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThanOrEqual(start);
		expect(end).toBeLessThanOrEqual(original.text.length);
		return `[${role} source=${JSON.stringify(entryId)} range=${start}:${end}]\n${original.text.slice(start, end)}`;
	});
	expect(result.text).toBe(parts.length ? [
		...(result.omitted ? ["[Earlier history omitted]"] : []), ...parts,
	].join("\n\n") : "");
	return result;
}

describe("getRecentContext", () => {
	it("returns empty context without omissions when there is no history", () => {
		expect(exactContext([])).toEqual({ text: "", sources: [], omitted: false });
	});

	it("keeps a complete short pair verbatim without marking omissions", () => {
		const result = exactContext([message("u", "user", "Question"), message("a", "assistant", "Answer")]);
		expect(result).toEqual({
			text: '[user source="u" range=0:8]\nQuestion\n\n[assistant source="a" range=0:6]\nAnswer',
			sources: [{ entryId: "u", role: "user", start: 0, end: 8 }, { entryId: "a", role: "assistant", start: 0, end: 6 }],
			omitted: false,
		});
	});

	it("keeps only the latest user and its final assistant reply in order", () => {
		const result = exactContext([
			message("old", "user", "Old task"), message("old-answer", "assistant", "Old answer"),
			message("user", "user", "New task"), message("progress", "assistant", "Working"), message("answer", "assistant", "Final answer"),
		]);
		expect(result.sources.map(({ entryId }) => entryId)).toEqual(["user", "answer"]);
		expect(result.omitted).toBe(true);
		for (const text of ["Old task", "Old answer", "Working"]) expect(result.text).not.toContain(text);
	});

	it.each([
		[message("orphan", "assistant", "Orphan reply")],
		[message("summary", "summary", "Summary")],
		[message("old", "user", "Old task"), message("summary", "summary", "Summary")],
		[message("old", "user", "Old task"), message("summary", "summary", "Summary"), message("orphan", "assistant", "Orphan reply")],
	].map((history) => ({ history })))("does not invent a pair across a summary or missing user: %#", ({ history }) => {
		expect(exactContext(history)).toEqual({ text: "", sources: [], omitted: true });
	});

	it("uses a new pair after a summary without including the summary or orphan reply", () => {
		const result = exactContext([
			message("s", "summary", "Summary text"), message("orphan", "assistant", "Residual reply"),
			message("u", "user", "Continue"), message("a", "assistant", "Continued"),
		]);
		expect(result.sources.map(({ entryId }) => entryId)).toEqual(["u", "a"]);
		expect(result.omitted).toBe(true);
		expect(result.text).not.toContain("Summary text");
		expect(result.text).not.toContain("Residual reply");
	});

	it.each(["", " \n\t", "New unanswered task"])("does not borrow an old reply for an unanswered user: %j", (text) => {
		const result = exactContext([
			message("old", "user", "Old task"), message("old-answer", "assistant", "Old answer"), message("new", "user", text),
		]);
		expect(result.sources).toEqual([{ entryId: "new", role: "user", start: 0, end: text.length }]);
		expect(result.omitted).toBe(true);
		expect(result.text).not.toContain("Old answer");
	});

	it("keeps an image-only user's own reply without an older text user", () => {
		const result = exactContext([
			message("old", "user", "Old task"), message("image", "user", ""), message("reply", "assistant", "Image answer"),
		]);
		expect(result.sources).toEqual([
			{ entryId: "image", role: "user", start: 0, end: 0 }, { entryId: "reply", role: "assistant", start: 0, end: 12 },
		]);
		expect(result.text).toContain("Image answer");
		expect(result.text).not.toContain("Old task");
	});

	it("preserves Chinese, CRLF, indentation, negation and escaped source IDs", () => {
		const text = "  不要删除 src/权限.ts，不能回退。\r\n\r\n```ts\r\n  const allowed = false;\r\n\r\n  deny();\r\n```\r\n";
		const result = exactContext([message('用户"\\\n', "user", text)]);
		expect(result.omitted).toBe(false);
		expect(result.sources[0]).toMatchObject({ start: 0, end: text.length });
		expect(result.text).toContain(text);
	});

	it("retains role attribution for identical user and assistant text", () => {
		const result = exactContext([message("u", "user", "Keep this"), message("a", "assistant", "Keep this")]);
		expect(result.sources.map(({ role }) => role)).toEqual(["user", "assistant"]);
	});

	it.each([2_000, 3_000, 4_900, 5_000, 6_000, 30_000])("preserves %i-character messages with exact ranges", (length) => {
		const result = exactContext([message("user", "user", "u".repeat(length)), message("answer", "assistant", "a".repeat(length))]);
		expect(result.sources).toHaveLength(2);
		expect(result.omitted).toBe(false);
		for (const source of result.sources) {
			expect(source.start).toBe(0);
			expect(source.end).toBeGreaterThan(0);
			expect(source.end).toBe(length);
		}
	});

	it("preserves a long unanswered user message", () => {
		const text = "x".repeat(100_000);
		const result = exactContext([message("u", "user", text)]);
		expect(result.omitted).toBe(false);
		expect(result.sources).toHaveLength(1);
		expect(result.sources[0]!.end).toBe(text.length);
		expect(result.text).toContain(text);
	});

	it("preserves both sides of an uneven pair", () => {
		const result = exactContext([message("u", "user", "Short task"), message("a", "assistant", "a".repeat(30_000))]);
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0]).toEqual({ entryId: "u", role: "user", start: 0, end: 10 });
		expect(result.sources[1]!.end).toBeGreaterThan(0);
		expect(result.sources[1]!.end).toBe(30_000);
		expect(result.omitted).toBe(false);
	});

	it("preserves context with long source labels", () => {
		const result = exactContext([message("id".repeat(10_000), "user", "Task")]);
		expect(result.omitted).toBe(false);
		expect(result.sources).toHaveLength(1);
		expect(result.text).toContain("Task");
	});
});
