import type { HistoryMessage } from "./session-context.ts";

export type ContextSource = {
	entryId: string;
	role: "user" | "assistant";
	start: number;
	end: number;
};
export type RecentContext = { text: string; sources: ContextSource[]; omitted: boolean };
type ContextPart = ContextSource & { text: string };

/** Select the latest user and its final text reply; never borrow across a summary or another user. */
export function getRecentContext(history: readonly HistoryMessage[]): RecentContext {
	let userIndex = -1;
	let assistantIndex = -1;
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index]!;
		if (message.role === "summary") break;
		if (message.role === "assistant" && assistantIndex < 0) assistantIndex = index;
		if (message.role === "user") { userIndex = index; break; }
	}
	const indices = userIndex < 0 ? [] : assistantIndex < 0 ? [userIndex] : [userIndex, assistantIndex];
	const parts: ContextPart[] = indices.map((index) => {
		const message = history[index]!;
		return { entryId: message.entryId, role: index === userIndex ? "user" : "assistant", start: 0, end: message.text.length, text: message.text };
	});
	const omitted = parts.length < history.length;
	return {
		text: render(parts, omitted), omitted,
		sources: parts.map(({ entryId, role, start, end }) => ({ entryId, role, start, end })),
	};
}

function render(parts: readonly ContextPart[], omitted: boolean): string {
	if (!parts.length) return "";
	return [
		...(omitted ? ["[Earlier history omitted]"] : []),
		...parts.map((part) => `[${part.role} source=${JSON.stringify(part.entryId)} range=${part.start}:${part.end}]\n${part.text}`),
	].join("\n\n");
}
