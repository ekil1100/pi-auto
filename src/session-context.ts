import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

export type HistoryMessage = {
	entryId: string;
	role: "user" | "assistant" | "summary";
	text: string;
};

export function hasContextImages(entries: readonly SessionEntry[]): boolean {
	return entries.some((entry) => sessionEntryToContextMessages(entry).some((message) =>
		"content" in message && Array.isArray(message.content) &&
		message.content.some((part) => part.type === "image"),
	));
}

/** The caller supplies only active, compaction-aware entries, in context order. */
export function collectHistory(entries: readonly SessionEntry[]): HistoryMessage[] {
	const history: HistoryMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction") {
			if (entry.summary.trim()) history.push({ entryId: entry.id, role: "summary", text: entry.summary });
			continue;
		}
		if (entry.type !== "message") continue;
		const { message } = entry;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = extractText(message.content);
		// Empty/image-only users still start turns; do not attach their replies to an older user.
		if (message.role === "user" || text.trim()) history.push({ entryId: entry.id, role: message.role, text });
	}
	return history;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	// Keep each text part verbatim. Offsets refer to this newline-joined text,
	// never to thinking, tool calls, or the serialized session entry.
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const value = part as { type?: unknown; text?: unknown };
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("\n");
}
