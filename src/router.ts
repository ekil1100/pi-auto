import { getSupportedThinkingLevels, type Api, type AssistantMessage, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getRecentContext, type ContextSource } from "./recent-context.ts";
import { EFFORT_INSTRUCTIONS, EFFORT_POLICY_VERSION, getEffortCriteria } from "./effort-policy.ts";
import type { SelectJev } from "./jev.ts";
import type { HistoryMessage } from "./session-context.ts";

const MAX_REASON_LENGTH = 160;
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

export interface ContextDiagnostics {
	strategy: "recent-turn";
	omitted: boolean;
	characters: number;
	elapsedMs: number;
	sources: ContextSource[];
}

export interface RoutingDiagnostics {
	policyVersion: string;
	supportedEfforts: ModelThinkingLevel[];
	taskTruncated: boolean;
	context?: ContextDiagnostics;
	selectionMs?: number;
}

export interface RouterInvocation {
	model: Model<Api>;
	effort: Exclude<ModelThinkingLevel, "off">;
	purpose: "effort";
	systemPrompt: string;
	userPrompt: string;
	signal: AbortSignal;
}

export type CompleteRouter = (invocation: RouterInvocation) => Promise<string>;

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

export async function planEffort(input: PlanEffortInput, complete: CompleteRouter, selectJev?: SelectJev): Promise<PlanEffortResult> {
	const model = input.currentModel;
	if (!model) return { status: "skipped", reason: "No current model is selected" };
	const efforts = getSupportedThinkingLevels(model);
	const diagnostics: RoutingDiagnostics = {
		policyVersion: EFFORT_POLICY_VERSION, supportedEfforts: efforts,
		taskTruncated: false,
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
	const task = input.task;
	const contextStartedAt = performance.now();
	const context = getRecentContext(input.history);
	diagnostics.context = {
		strategy: "recent-turn", omitted: context.omitted, characters: context.text.length,
		sources: context.sources, elapsedMs: elapsed(contextStartedAt),
	};
	report();

	input.signal.throwIfAborted();
	const state: EffortState = {
		task, taskCharacters: input.task.length, taskTruncated: diagnostics.taskTruncated,
		hasImages: input.hasImages, ...(context.text ? { recentConversation: context.text } : {}),
		contextOmitted: context.omitted,
		model: { id: `${model.provider}/${model.id}`, name: model.name },
		currentEffort: input.currentEffort, supportedEfforts: efforts,
	};
	const selectionStartedAt = performance.now();
	try {
		if (selectJev) {
			const decision = await selectJev({ state, signal: input.signal });
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

function elapsed(startedAt: number): number { return Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
