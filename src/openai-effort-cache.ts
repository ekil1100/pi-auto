import { createHash } from "node:crypto";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { supportedModel } from "./openai-effort-cache-allowlist.ts";

export const EFFORT_CACHE_ENTRY_TYPE = "pi-auto-openai-effort-cache";

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

type RecordValue = Record<string, unknown>;
interface Update {
	/** Position in the provider input before our updates are inserted. */
	index: number;
	effort: string;
}
interface State {
	version: 1;
	model: string;
	baseline: string;
	inputLength: number;
	inputHash: string;
	instructionsHash: string;
	updates: Update[];
}

/**
 * Owns only the main request's wire-level effort history, independently of /auto.
 * Reading the active branch on every request also handles reload, resume, fork,
 * tree navigation and recovery without a second, potentially stale state store.
 */
export function registerOpenAIEffortCache(pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event, ctx) => {
		const previous = readState(ctx.sessionManager.getBranch());
		const payload = record(event.payload);
		const reasoning = record(payload?.reasoning);
		const model = supportedModel(ctx.model);
		const invalidate = () => {
			if (previous) pi.appendEntry(EFFORT_CACHE_ENTRY_TYPE, null);
		};
		if (!model || !payload || payload.model !== ctx.model?.id || !reasoning ||
			!isEffort(reasoning.effort) || !supportedRequest(payload, reasoning)) {
			invalidate();
			return;
		}

		const input = removeOwnUpdates(payload.input as RecordValue[], previous);
		// Never take ownership of another extension's configuration updates.
		if (!input) {
			invalidate();
			return;
		}
		const instructionsHash = hash(payload.instructions ?? null);
		const extendsPrevious = previous?.model === model && previous.instructionsHash === instructionsHash &&
			input.length >= previous.inputLength && hash(input.slice(0, previous.inputLength)) === previous.inputHash &&
			previous.updates.every((update) => input[update.index]?.role === "user");
		const updates = extendsPrevious ? [...previous.updates] : [];
		const baseline = extendsPrevious ? previous.baseline : reasoning.effort;
		const effective = updates.at(-1)?.effort ?? baseline;
		if (extendsPrevious && reasoning.effort !== effective) {
			// Only append at a new user boundary, never before tool outputs or by
			// rewriting an already-sent user message (including retries).
			const index = input.findIndex((item, index) => index >= previous.inputLength && item.role === "user");
			if (index !== -1 && input.slice(index).every(isUserOrSystemMessage) && !hasPendingTools(input.slice(0, index))) {
				updates.push({ index, effort: reasoning.effort });
			}
		}
		const state: State = {
			version: 1, model, baseline, inputLength: input.length, inputHash: hash(input), instructionsHash, updates,
		};
		// Persist before dispatch: an interrupted/failed request can be replayed
		// exactly. No API-error fallback removes updates from an existing prefix.
		if (JSON.stringify(state) !== JSON.stringify(previous)) pi.appendEntry(EFFORT_CACHE_ENTRY_TYPE, state);
		const replay = [...input];
		for (let index = updates.length - 1; index >= 0; index--) {
			const update = updates[index]!;
			replay.splice(update.index, 0, configurationUpdate(update.effort));
		}
		// This hook returns the payload itself, not { payload: ... }.
		return { ...payload, reasoning: { ...reasoning, effort: baseline }, input: replay };
	});
}

function supportedRequest(payload: RecordValue, reasoning: RecordValue): boolean {
	if (payload.model === "gpt-6-astra" && reasoning.effort === "none") return false;
	if (reasoning.mode !== undefined && reasoning.mode !== "standard") return false;
	if (payload.multi_agent !== undefined && record(payload.multi_agent)?.enabled !== false) return false;
	// Pi supplies full history here, before Codex's internal WebSocket delta.
	// Server-managed histories and compaction need a different ownership model.
	if (payload.previous_response_id != null || payload.conversation != null || payload.context_management != null ||
		(payload.truncation !== undefined && payload.truncation !== "disabled") || payload.stream !== true) return false;
	if (!Array.isArray(payload.input) || !payload.input.length) return false;
	return payload.input.every((value) => {
		const item = record(value);
		return item && item.agent === undefined && [undefined, "message", "reasoning", "function_call",
			"function_call_output", "custom_tool_call", "custom_tool_call_output", "configuration_update"].includes(item.type as string | undefined);
	});
}

function isUserOrSystemMessage(item: RecordValue): boolean {
	return (item.type === undefined || item.type === "message") &&
		(item.role === "user" || item.role === "system" || item.role === "developer");
}

function hasPendingTools(input: RecordValue[]): boolean {
	const pending = new Set<unknown>();
	for (const item of input) {
		if (item.type === "function_call" || item.type === "custom_tool_call") pending.add(item.call_id);
		if (item.type === "function_call_output" || item.type === "custom_tool_call_output") pending.delete(item.call_id);
	}
	return pending.size > 0;
}

function configurationUpdate(effort: string): RecordValue {
	return { type: "configuration_update", reasoning: { effort } };
}

function removeOwnUpdates(input: RecordValue[], state: State | undefined): RecordValue[] | undefined {
	if (!input.some((item) => item.type === "configuration_update")) return input;
	if (!state) return;
	const clean: RecordValue[] = [];
	let count = 0;
	for (const item of input) {
		if (item.type !== "configuration_update") {
			clean.push(item);
			continue;
		}
		const expected = state.updates[count++];
		if (!expected || expected.index !== clean.length || JSON.stringify(item) !== JSON.stringify(configurationUpdate(expected.effort))) return;
	}
	return count === state.updates.length ? clean : undefined;
}

function readState(branch: SessionEntry[]): State | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "model_change" || entry.type === "compaction" || entry.type === "branch_summary") return;
		if (entry.type !== "custom" || entry.customType !== EFFORT_CACHE_ENTRY_TYPE) continue;
		const state = record(entry.data);
		if (!state || state.version !== 1 || typeof state.model !== "string" || !isEffort(state.baseline) ||
			!Number.isSafeInteger(state.inputLength) || (state.inputLength as number) < 1 ||
			!isHash(state.inputHash) || !isHash(state.instructionsHash) || !Array.isArray(state.updates)) return;
		let lastIndex = -1;
		let effort = state.baseline;
		for (const value of state.updates) {
			const update = record(value);
			if (!update || !Number.isSafeInteger(update.index) || (update.index as number) <= lastIndex ||
				(update.index as number) >= (state.inputLength as number) || !isEffort(update.effort) || update.effort === effort) return;
			lastIndex = update.index as number;
			effort = update.effort;
		}
		return state as unknown as State;
	}
	return;
}

function record(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function isEffort(value: unknown): value is string {
	return typeof value === "string" && EFFORTS.has(value);
}

function isHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
