import { getSupportedThinkingLevels, type Api, type AssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { buildContextCandidates, packContext, type ContextRating, type ContextSource } from "./context-compaction.ts";
import { CONTEXT_INSTRUCTIONS, IMPORTANCE_CRITERIA, type ClassifyContext } from "./context-policy.ts";
import { EFFORT_INSTRUCTIONS, EFFORT_POLICY_VERSION, getEffortCriteria } from "./effort-policy.ts";
import type { SelectJev } from "./jev.ts";
import type { HistoryMessage } from "./session-context.ts";

const MAX_REASON_LENGTH = 160;
const MAX_TASK_CHARACTERS = 12_000;
export const ROUTER_RESPONSE_TEXT_LIMIT = 8_192;

export interface RouterResponseDiagnostics {
	stopReason: AssistantMessage["stopReason"];
	contentTypes: AssistantMessage["content"][number]["type"][];
	textCharacters: number;
	/** Opt-in text only; never includes thinking, tool arguments or provider errors. */
	rawText?: string;
	rawTextTruncated?: boolean;
}

export type EffortState = {
	task: string;
	taskCharacters: number;
	taskTruncated: boolean;
	hasImages: boolean;
	recentConversation?: string;
	contextOmitted: boolean;
	model: { id: string; name: string };
	currentEffort: ModelThinkingLevel;
	supportedEfforts: ModelThinkingLevel[];
};

export interface CompactionDiagnostics {
	status: "bypassed" | "extracting" | "extracted" | "failed";
	candidateCount: number;
	candidateCharacters: number;
	candidatesTruncated: boolean;
	selectedCount: number;
	selectedCharacters: number;
	elapsedMs?: number;
	sources: ContextSource[];
	/** Metadata only; optional for records saved before the context inspector. */
	candidateSources?: (ContextSource & { id: string })[];
	ratings: ContextRating[];
	reason?: string;
}

export interface RoutingDiagnostics {
	policyVersion: string;
	supportedEfforts: ModelThinkingLevel[];
	taskTruncated: boolean;
	compaction?: CompactionDiagnostics;
	selectionMs?: number;
}

export interface RouterInvocation {
	model: Model<Api>;
	effort: Exclude<ModelThinkingLevel, "off">;
	purpose: "context" | "effort";
	systemPrompt: string;
	userPrompt: string;
	signal: AbortSignal;
}

export type CompleteRouter = (invocation: RouterInvocation) => Promise<string>;
export interface JevBackend { select: SelectJev; classify: ClassifyContext }

export interface PlanEffortInput {
	task: string;
	hasImages: boolean;
	currentModel: Model<Api> | undefined;
	currentEffort: ModelThinkingLevel;
	history: readonly HistoryMessage[];
	signal: AbortSignal;
	onDiagnostics?: (diagnostics: RoutingDiagnostics) => void;
}

export interface EffortPlan {
	model: Model<Api>;
	effort: ModelThinkingLevel;
	reason: string;
	routerEffort: Exclude<ModelThinkingLevel, "off"> | undefined;
}

export type PlanEffortResult =
	| { status: "selected"; plan: EffortPlan }
	| { status: "skipped"; reason: string };

export async function planEffort(input: PlanEffortInput, complete: CompleteRouter, jev?: JevBackend): Promise<PlanEffortResult> {
	const model = input.currentModel;
	if (!model) return { status: "skipped", reason: "No current model is selected" };
	const efforts = getSupportedThinkingLevels(model);
	const diagnostics: RoutingDiagnostics = {
		policyVersion: EFFORT_POLICY_VERSION, supportedEfforts: efforts,
		taskTruncated: input.task.length > MAX_TASK_CHARACTERS,
	};
	const report = () => {
		try { input.onDiagnostics?.(structuredClone(diagnostics)); } catch { /* Diagnostics must not change routing. */ }
	};
	report();
	if (efforts.length === 0) return { status: "skipped", reason: "The current model has no supported effort" };
	if (efforts.length === 1) {
		return { status: "selected", plan: { model, effort: efforts[0]!, reason: "Only supported effort", routerEffort: undefined } };
	}
	input.signal.throwIfAborted();
	const reasoningLevels = efforts.filter((level): level is Exclude<ModelThinkingLevel, "off"> => level !== "off");
	const routerEffort = reasoningLevels.includes("low") ? "low" : reasoningLevels[0];
	if (!routerEffort) throw new Error("Invariant violated: missing router effort");
	const task = clipText(input.task, MAX_TASK_CHARACTERS);
	const contextStartedAt = performance.now();
	const pool = buildContextCandidates(input.history);
	const context: CompactionDiagnostics = {
		status: "bypassed", candidateCount: pool.candidates.length, candidateCharacters: pool.candidateCharacters,
		candidatesTruncated: pool.truncated, selectedCount: 0, selectedCharacters: 0, sources: [], ratings: [],
		candidateSources: pool.candidates.map(({ id, entryId, role, start, end }) => ({ id, entryId, role, start, end })),
	};
	diagnostics.compaction = context;
	let packed = packContext(pool);
	try {
		if (packed.status === "failed" && packed.reason === "context_requires_classification") {
			context.status = "extracting";
			report();
			input.signal.throwIfAborted();
			const classification = {
				task, taskTruncated: diagnostics.taskTruncated, candidates: pool.candidates,
				candidatesTruncated: pool.truncated, signal: input.signal,
			};
			const ratings = jev ? await jev.classify(classification) : parseContextRatings(await complete({
				model, effort: routerEffort, purpose: "context", signal: input.signal,
				systemPrompt: `${CONTEXT_INSTRUCTIONS}\nCategories: ${JSON.stringify(IMPORTANCE_CRITERIA)}\nReturn JSON only: [{"id":"<candidate id>","importance":"<category>"}]. Return exactly one item per candidate; no other fields or free text.`,
				userPrompt: JSON.stringify({ task, taskTruncated: diagnostics.taskTruncated, candidates: pool.candidates, candidatesTruncated: pool.truncated }),
			}));
			input.signal.throwIfAborted();
			packed = packContext(pool, ratings);
			// Persist only validated IDs/categories, never malformed model output.
			if (packed.status === "ready" || packed.reason === "required_context_exceeds_budget") {
				context.ratings = ratings.map(({ id, importance }) => ({ id, importance }));
			}
			context.status = "extracted";
		}
		if (packed.status === "failed") {
			context.status = "failed";
			context.reason = packed.reason;
			return { status: "skipped", reason: packed.reason };
		}
		context.sources = packed.sources;
		context.selectedCount = packed.sources.length;
		context.selectedCharacters = packed.text.length;
	} catch {
		context.status = "failed";
		context.reason = input.signal.aborted ? "context_selection_cancelled" : "context_classification_failed";
		throw new Error(context.reason);
	} finally {
		context.elapsedMs = elapsed(contextStartedAt);
		report();
	}

	input.signal.throwIfAborted();
	const state: EffortState = {
		task, taskCharacters: input.task.length, taskTruncated: diagnostics.taskTruncated,
		hasImages: input.hasImages, ...(packed.text ? { recentConversation: packed.text } : {}),
		contextOmitted: pool.truncated || packed.sources.length < pool.candidates.length,
		model: { id: `${model.provider}/${model.id}`, name: model.name },
		currentEffort: input.currentEffort, supportedEfforts: efforts,
	};
	const selectionStartedAt = performance.now();
	try {
		if (jev) {
			const decision = await jev.select({ state, signal: input.signal });
			input.signal.throwIfAborted();
			if (!efforts.includes(decision.effort)) throw new Error("Jev returned an unsupported effort");
			return { status: "selected", plan: { model, effort: decision.effort, reason: "Selected by Jev Choice", routerEffort: undefined } };
		}
		const responseText = await complete({
			model, effort: routerEffort, purpose: "effort", signal: input.signal,
			systemPrompt: `${EFFORT_INSTRUCTIONS}\nSupported effort criteria: ${JSON.stringify(getEffortCriteria(efforts))}\nReturn JSON only: {"effort":"<supported effort>","reason":"<brief English reason, max 160 characters>"}.`,
			userPrompt: JSON.stringify(state),
		});
		input.signal.throwIfAborted();
		const selected = parseDecision(responseText, efforts);
		return { status: "selected", plan: { model, ...selected, routerEffort } };
	} finally {
		diagnostics.selectionMs = elapsed(selectionStartedAt);
		report();
	}
}

function parseContextRatings(text: string): ContextRating[] {
	try {
		const value: unknown = JSON.parse(text.trim());
		if (!Array.isArray(value)) throw new Error();
		return value.map((item: unknown) => {
			if (!isRecord(item) || typeof item.id !== "string" || typeof item.importance !== "string" ||
				!Object.hasOwn(IMPORTANCE_CRITERIA, item.importance) || Object.keys(item).length !== 2) throw new Error();
			return { id: item.id, importance: item.importance as ContextRating["importance"] };
		});
	} catch { throw new Error("invalid_context_ratings"); }
}

function parseDecision(responseText: string, efforts: readonly ModelThinkingLevel[]): { effort: ModelThinkingLevel; reason: string } {
	const invalid = (code: string) => new Error(`Router returned an invalid or unsupported effort (${code})`);
	const json = extractJsonObject(responseText);
	if (!json) throw invalid("not_json_object");
	let value: unknown;
	try { value = JSON.parse(json); } catch { throw invalid("invalid_json"); }
	if (!isRecord(value)) throw invalid("not_json_object");
	if (!Object.hasOwn(value, "effort")) throw invalid("missing_effort");
	if (typeof value.effort !== "string") throw invalid("invalid_effort_type");
	const effort = efforts.find((candidate) => candidate === value.effort);
	if (!effort) throw invalid("unsupported_effort");
	const reason = typeof value.reason === "string" ? sanitizeReason(value.reason) || "Selected by router" : "Selected by router";
	return { effort, reason };
}

function extractJsonObject(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
	return fenced?.startsWith("{") && fenced.endsWith("}") ? fenced : undefined;
}

function sanitizeReason(reason: string): string {
	return reason.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON_LENGTH);
}

function clipText(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const available = limit - 3;
	return `${text.slice(0, Math.ceil(available / 2))}\n…\n${text.slice(-Math.floor(available / 2))}`;
}

function elapsed(startedAt: number): number { return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
