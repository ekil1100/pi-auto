import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { collectHistory, hasContextImages } from "../src/session-context.ts";
import { buildContextCandidates, packContext } from "../src/context-compaction.ts";

function entry(id: string, role: string, content: unknown): SessionEntry {
	return { id, type: "message", message: { role, content, timestamp: 0 } } as SessionEntry;
}
function summary(id: string, text: string): SessionEntry {
	return { id, type: "compaction", summary: text } as SessionEntry;
}
const image = { type: "image", data: "image-data", mimeType: "image/png" };

describe("collectHistory", () => {
	it("keeps only user and assistant text with original entry IDs and order", () => {
		expect(collectHistory([
			entry("u", "user", "Investigate auth"), entry("tool", "toolResult", "secret output"),
			entry("a", "assistant", [{ type: "text", text: "The token refresh is broken" }]),
		])).toEqual([
			{ entryId: "u", role: "user", text: "Investigate auth" },
			{ entryId: "a", role: "assistant", text: "The token refresh is broken" },
		]);
	});

	it("does not trim, normalize, or clip raw text, including long middle constraints", () => {
		const text = `  ${"前".repeat(7_000)}\r\n\r\n不要删除 src/权限.ts。\r\n\r\n${"后".repeat(7_000)}  \n`;
		expect(collectHistory([entry("u", "user", text)])).toEqual([{ entryId: "u", role: "user", text }]);
	});

	it("joins raw text parts with newlines but excludes thinking, tools and images", () => {
		expect(collectHistory([entry("a", "assistant", [
			{ type: "thinking", thinking: "private reasoning" },
			{ type: "text", text: "  First\r\n" },
			{ type: "toolCall", id: "call", name: "bash", arguments: { command: "secret" } },
			image, { type: "text", text: "\tDo not deploy.  " },
		])])).toEqual([{ entryId: "a", role: "assistant", text: "  First\r\n\n\tDo not deploy.  " }]);
	});

	it("preserves compaction summary text and its source ID", () => {
		expect(collectHistory([summary("s", "  已完成测试；未部署。\n"), entry("u", "user", "继续")])).toEqual([
			{ entryId: "s", role: "summary", text: "  已完成测试；未部署。\n" },
			{ entryId: "u", role: "user", text: "继续" },
		]);
	});

	it("omits non-context content but retains image-only user turn boundaries", () => {
		const entries = [
			{ type: "custom", id: "c", data: "private" },
			{ type: "custom_message", id: "cm", content: "private" },
			{ type: "branch_summary", id: "bs", summary: "Abandoned branch" },
			{ type: "model_change", id: "model", modelId: "private" },
		] as SessionEntry[];
		expect(collectHistory([
			...entries, entry("custom", "custom", "private"), entry("bash", "bashExecution", "private"),
			entry("thinking", "assistant", [{ type: "thinking", thinking: "private" }]), entry("image", "user", [image]),
		])).toEqual([{ entryId: "image", role: "user", text: "" }]);
	});

	it("ignores empty and malformed text content without creating invented text", () => {
		expect(collectHistory([
			entry("null", "user", null), entry("missing", "assistant", undefined), entry("empty", "user", " \n\t"),
			entry("bad", "assistant", [null, {}, { type: "text", text: 123 }, "not a text part"]), summary("s", "  "),
		])).toEqual([{ entryId: "null", role: "user", text: "" }, { entryId: "empty", role: "user", text: " \n\t" }]);
	});

	it("never attributes an image-only user's reply to a previous text user", () => {
		const pool = buildContextCandidates(collectHistory([
			entry("u1", "user", "Old text request"), entry("a1", "assistant", "Old reply"),
			entry("u2", "user", [image]), entry("a2", "assistant", "Reply to image"),
		]));
		const oldReply = pool.candidates.find(({ entryId }) => entryId === "a1")!;
		const imageReply = pool.candidates.find(({ entryId }) => entryId === "a2")!;
		expect(imageReply).toMatchObject({ partialTurn: true, requires: [] });
		expect(imageReply.turnId).not.toBe(oldReply.turnId);
		expect(JSON.stringify(pool)).not.toContain(image.data);
		const result = packContext(pool);
		expect(result.status === "ready" && result.text).toContain("partialTurn=true");
	});

	it("uses only the active entries provided by the caller, without following abandoned parents", () => {
		const abandoned = entry("old", "user", "Abandoned request");
		const active = { ...entry("new", "user", "Current request"), parentId: abandoned.id };
		expect(collectHistory([summary("s", "Active summary"), active]).map(({ entryId }) => entryId)).toEqual(["s", "new"]);
	});
});

describe("hasContextImages", () => {
	it.each(["user", "assistant", "toolResult"])("detects images in %s messages", (role) => {
		expect(hasContextImages([entry("image", role, [image])])).toBe(true);
	});

	it("detects images in context-bearing custom messages", () => {
		const custom = { type: "custom_message", id: "custom", customType: "example", content: [image], display: false, timestamp: "2026-01-01T00:00:00Z" } as SessionEntry;
		expect(hasContextImages([custom])).toBe(true);
		expect(collectHistory([custom])).toEqual([]);
	});

	it("does not inspect custom state, tool call arguments or image-looking text", () => {
		const custom = { type: "custom", id: "custom", customType: "example", data: { content: [image] } } as SessionEntry;
		expect(hasContextImages([
			custom, entry("u", "user", "{type: image}"),
			entry("a", "assistant", [{ type: "toolCall", arguments: { image } }]), summary("s", "image.png"),
		])).toBe(false);
	});

	it("handles empty history, null content and text-only arrays", () => {
		expect(hasContextImages([])).toBe(false);
		expect(hasContextImages([entry("u", "user", null), entry("a", "assistant", [{ type: "text", text: "No images" }])])).toBe(false);
	});
});
