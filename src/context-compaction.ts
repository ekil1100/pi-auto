import type { HistoryMessage } from "./session-context.ts";

export const CONTEXT_BUDGET = 6_000;
export const CANDIDATE_BUDGET = 24_000;
export const MAX_CANDIDATES = 32;

export type Importance = "required" | "useful" | "background" | "irrelevant";
export type ContextRating = { id: string; importance: Importance };
export type ContextSource = {
	entryId: string;
	role: HistoryMessage["role"];
	start: number;
	end: number;
};
export type ContextCandidate = ContextSource & {
	id: string;
	turnId: string;
	partialTurn: boolean;
	text: string;
	requires: string[];
};
export type CandidatePool = {
	candidates: ContextCandidate[];
	candidateCharacters: number;
	truncated: boolean;
	error?: string;
};
export type ContextPackResult =
	| { status: "ready"; text: string; sources: ContextSource[] }
	| { status: "failed"; reason: string };

type Range = { start: number; end: number };
type Block = Range & { kind: "prose" | "heading" | "list" | "table" | "error" | "code" };
type Turn = { user: ContextCandidate[]; assistants: ContextCandidate[][] };
const UNIT_TARGET = 1_000;

/** Conservative Markdown boundaries: structured blocks are never sentence-split. */
function blockKind(text: string): Block["kind"] {
	if (/^ {0,3}(?:`{3,}|~{3,})/m.test(text) || /^(?: {4}|\t)\S/m.test(text)) return "code";
	if (/^\s*(?:[-+*]|\d+[.)])\s+/m.test(text)) return "list";
	if (/^\s*\|/m.test(text) || /^\s*:?-{3,}:?\s*\|/m.test(text)) return "table";
	if (/^\s*(?:\w*(?:Error|Exception)\b|Traceback\b|Caused by:|at\s+\S+|File ")/m.test(text)) return "error";
	if (/^ {0,3}#{1,6}\s+/m.test(text) || /\n\s*(?:={3,}|-{3,})\s*$/m.test(text)) return "heading";
	return "prose";
}

function wholeUnits(text: string): Range[] {
	const blocks: Block[] = [];
	let start = 0;
	let end = 0;
	let fence: string | undefined;
	const flush = () => {
		if (end <= start) return;
		blocks.push({ start, end, kind: blockKind(text.slice(start, end)) });
	};
	for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
		const line = match[0];
		if (!line) continue;
		const offset = match.index;
		if (!fence && !line.trim()) {
			flush();
			start = offset + line.length;
			end = start;
			continue;
		}
		const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line);
		if (delimiter) {
			const marker = delimiter[1]!;
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
		}
		end = offset + line.length;
	}
	flush();

	const grouped: Block[] = [];
	for (const block of blocks) {
		const previous = grouped.at(-1);
		const previousText = previous && text.slice(previous.start, previous.end);
		const attach = previous && (
			previous.kind === "heading" ||
			(block.kind !== "prose" && /[:：]\s*$/.test(previousText!)) ||
			(previous.kind === "list" && (block.kind === "list" || /^\s{2,}\S/.test(text.slice(block.start, block.end)))) ||
			(previous.kind === "table" && block.kind === "table") ||
			(previous.kind === "error" && (block.kind === "error" || block.kind === "code"))
		);
		if (attach) {
			previous.end = block.end;
			// A heading and its first dependent block remain indivisible.
			if (previous.kind !== "list" && previous.kind !== "error") {
				previous.kind = block.kind === "prose" ? "code" : block.kind;
			}
		} else grouped.push({ ...block });
	}

	const units: Range[] = [];
	for (const block of grouped) {
		if (block.kind !== "prose" || block.end - block.start <= UNIT_TARGET) {
			units.push(block);
			continue;
		}
		// Do not split at ASCII periods: abbreviations such as "Do not e.g. delete"
		// can otherwise lose their negation. Keep ambiguous prose as a larger unit.
		let sentenceStart = block.start;
		const paragraph = text.slice(block.start, block.end);
		for (const match of paragraph.matchAll(/(?:[。！？]+[”’」』）]*|[!?]+["'”’)]*(?=\s|$))\s*/g)) {
			const sentenceEnd = block.start + match.index + match[0].length;
			units.push({ start: sentenceStart, end: sentenceEnd });
			sentenceStart = sentenceEnd;
		}
		if (sentenceStart < block.end) units.push({ start: sentenceStart, end: block.end });
	}

	// Merge only adjacent complete units, preserving all intervening raw whitespace.
	const merged: Range[] = [];
	for (const unit of units) {
		const previous = merged.at(-1);
		if (previous && unit.end - previous.start <= UNIT_TARGET) previous.end = unit.end;
		else merged.push({ start: unit.start, end: unit.end });
	}
	return merged;
}

export function buildContextCandidates(messages: readonly HistoryMessage[]): CandidatePool {
	const turns: Turn[] = [];
	const summaries: ContextCandidate[][] = [];
	const chronological: ContextCandidate[] = [];
	let current: Turn | undefined;
	let turnId = "";
	for (const [index, message] of messages.entries()) {
		if (message.role === "user" || (message.role === "assistant" && !current)) {
			current = { user: [], assistants: [] };
			turns.push(current);
			turnId = `turn:${index}`;
		}
		const candidates = wholeUnits(message.text).map(({ start, end }): ContextCandidate => ({
			id: `c${index}:${start}:${end}`,
			entryId: message.entryId,
			role: message.role,
			start,
			end,
			turnId: message.role === "summary" ? `summary:${index}` : turnId,
			partialTurn: message.role === "assistant" && !current?.user.length,
			text: message.text.slice(start, end),
			requires: message.role === "assistant" ? current!.user.map(({ id }) => id) : [],
		}));
		for (const candidate of candidates) chronological.push(candidate);
		if (message.role === "summary") {
			summaries.push(candidates);
			current = undefined;
		} else if (message.role === "user") current!.user = candidates;
		else current!.assistants.push(candidates);
	}

	const selected = new Map<string, ContextCandidate>();
	let candidateCharacters = 2; // JSON's empty array also consumes characters.
	const add = (candidates: readonly ContextCandidate[]): boolean => {
		const additions = candidates.filter(({ id }) => !selected.has(id));
		if (selected.size + additions.length > MAX_CANDIDATES) return false;
		const combined = [...selected.values(), ...additions];
		const size = JSON.stringify(combined).length;
		if (size > CANDIDATE_BUDGET) return false;
		for (const candidate of additions) selected.set(candidate.id, candidate);
		candidateCharacters = size;
		return true;
	};

	// An image-only user still starts the latest turn; never pin an older text user instead.
	const latest = turns.at(-1);
	if (!add(latest?.user ?? [])) {
		return { candidates: [], candidateCharacters: 2, truncated: true, error: "latest_user_exceeds_candidate_budget" };
	}
	const addTurn = (turn: Turn) => {
		// All user units are dependencies. Never admit a reply to a locally omitted user.
		if (!add(turn.user)) return;
		for (const assistant of [...turn.assistants].reverse()) {
			for (const candidate of assistant) add([candidate]);
		}
	};
	if (latest) addTurn(latest);
	const latestSummary = summaries.at(-1);
	if (latestSummary) for (const candidate of latestSummary) add([candidate]);
	for (const turn of turns.slice(0, -1).reverse()) addTurn(turn);
	for (const summary of summaries.slice(0, -1).reverse()) for (const candidate of summary) add([candidate]);

	const candidates = chronological.filter(({ id }) => selected.has(id));
	return { candidates, candidateCharacters, truncated: candidates.length < chronological.length };
}

function render(pool: CandidatePool, selected: ReadonlySet<string>): string {
	const sections: string[] = [];
	if (pool.truncated) sections.push("[History omitted from candidate pool]");
	let omitted = false;
	for (const candidate of pool.candidates) {
		if (!selected.has(candidate.id)) {
			omitted = true;
			continue;
		}
		if (omitted) sections.push("[Context omitted]");
		omitted = false;
		sections.push(
			`[${candidate.role} source=${JSON.stringify(candidate.entryId)} range=${candidate.start}:${candidate.end} turn=${JSON.stringify(candidate.turnId)} partialTurn=${candidate.partialTurn}]\n${candidate.text}`,
		);
	}
	if (omitted) sections.push("[Context omitted]");
	return sections.join("\n\n");
}

function validateRatings(pool: CandidatePool, ratings: readonly ContextRating[]): string | undefined {
	if (!Array.isArray(ratings)) return "invalid_context_ratings";
	const ids = new Set(pool.candidates.map(({ id }) => id));
	const seen = new Set<string>();
	for (const rating of ratings) {
		if (!rating || typeof rating.id !== "string" ||
			!["required", "useful", "background", "irrelevant"].includes(rating.importance)) return "invalid_context_rating";
		if (!ids.has(rating.id)) return "unknown_context_rating";
		if (seen.has(rating.id)) return "duplicate_context_rating";
		seen.add(rating.id);
	}
	if (seen.size !== ids.size) return "missing_context_rating";
	return undefined;
}

/** Classification is needed only when the complete rendered pool cannot fit. */
export function packContext(pool: CandidatePool, ratings?: readonly ContextRating[]): ContextPackResult {
	if (pool.error) return { status: "failed", reason: pool.error };
	const byId = new Map(pool.candidates.map((candidate) => [candidate.id, candidate]));
	const close = (ids: Iterable<string>): Set<string> | undefined => {
		const selected = new Set<string>();
		const pending = [...ids];
		while (pending.length) {
			const id = pending.pop()!;
			if (selected.has(id)) continue;
			const candidate = byId.get(id);
			if (!candidate) return undefined;
			selected.add(id);
			pending.push(...candidate.requires);
		}
		return selected;
	};
	let selected: Set<string>;
	if (ratings === undefined) {
		const all = close(byId.keys());
		if (!all) return { status: "failed", reason: "invalid_context_dependencies" };
		if (render(pool, all).length > CONTEXT_BUDGET) return { status: "failed", reason: "context_requires_classification" };
		selected = all;
	} else {
		const error = validateRatings(pool, ratings);
		if (error) return { status: "failed", reason: error };
		const importance = new Map(ratings.map((rating) => [rating.id, rating.importance]));
		const required = close(ratings.filter((rating) => rating.importance === "required").map(({ id }) => id));
		if (!required) return { status: "failed", reason: "invalid_context_dependencies" };
		if (render(pool, required).length > CONTEXT_BUDGET) return { status: "failed", reason: "required_context_exceeds_budget" };
		selected = required;
		for (const level of ["useful", "background"] as const) {
			for (const candidate of [...pool.candidates].reverse()) {
				if (importance.get(candidate.id) !== level || selected.has(candidate.id)) continue;
				const expanded = close([...selected, candidate.id]);
				if (!expanded) return { status: "failed", reason: "invalid_context_dependencies" };
				if (render(pool, expanded).length <= CONTEXT_BUDGET) selected = expanded;
			}
		}
	}
	return {
		status: "ready",
		text: render(pool, selected),
		sources: pool.candidates.filter(({ id }) => selected.has(id)).map(({ entryId, role, start, end }) => ({ entryId, role, start, end })),
	};
}
