import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

const DEFAULT_CHARACTER_BUDGET = 6_000;
const MAX_ENTRY_CHARACTERS = 2_000;

export function hasContextImages(entries: readonly SessionEntry[]): boolean {
	return entries.some((entry) => sessionEntryToContextMessages(entry).some((message) =>
		"content" in message && Array.isArray(message.content) &&
		message.content.some((part) => part.type === "image"),
	));
}

export function collectRecentContext(
	entries: readonly SessionEntry[],
	characterBudget = DEFAULT_CHARACTER_BUDGET,
): string {
	const sections: string[] = [];
	let remaining = characterBudget;

	for (let index = entries.length - 1; index >= 0 && remaining > 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		const section = formatEntry(entry);
		if (!section) continue;

		const separatorLength = sections.length > 0 ? 2 : 0;
		const available = remaining - separatorLength;
		if (available <= 0) break;
		const clipped = clipText(section, Math.min(available, MAX_ENTRY_CHARACTERS));
		sections.push(clipped);
		remaining -= separatorLength + clipped.length;
	}

	return sections.reverse().join("\n\n");
}

function formatEntry(entry: SessionEntry): string | undefined {
	if (entry.type === "compaction") {
		return `Conversation summary:\n${entry.summary}`;
	}
	if (entry.type !== "message") return undefined;

	const { message } = entry;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = extractText(message.content);
	if (!text) return undefined;
	return `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			const value = part as { type?: unknown; text?: unknown };
			return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
		})
		.join("\n")
		.trim();
}

function clipText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	if (limit <= 1) return text.slice(0, limit);

	const marker = "\n…\n";
	if (limit <= marker.length) return text.slice(0, limit);
	const available = limit - marker.length;
	const head = Math.ceil(available / 2);
	const tail = Math.floor(available / 2);
	return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}
