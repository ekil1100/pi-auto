import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ClassifierRegistry } from "./backends.ts";
import type { SelectorBackend } from "./settings.ts";
import type { EffortState } from "./router.ts";
import { EFFORT_INSTRUCTIONS, getEffortCriteria } from "./effort-policy.ts";

export const CLASSIFIER_RESPONSE_TEXT_LIMIT = 8_192;
export const CLASSIFIER_ERROR_CODES = [
	"request_cancelled", "request_failed", "provider_aborted", "model_unavailable",
	"invalid_envelope", "invalid_model", "invalid_answers", "missing_effort", "unexpected_answers",
	"invalid_effort_answer", "invalid_answer_type", "unsupported_effort", "invalid_confidence",
	"invalid_probabilities", "probability_keys_mismatch", "invalid_probability", "probability_sum", "choice_not_max",
] as const;
type ClassifierErrorCode = typeof CLASSIFIER_ERROR_CODES[number];

export interface ClassifierDiagnostics {
	stage: "request" | "validation" | "complete";
	errorCode?: ClassifierErrorCode;
	stopReason?: "stop" | "error" | "aborted";
	responseType?: "object";
	responseCharacters?: number;
	/** Normalized successful classifier result, never HTTP bodies or runtime errors. */
	rawText?: string;
	rawTextTruncated?: boolean;
}

class ClassifierValidationError extends Error {
	constructor(readonly code: ClassifierErrorCode) { super(`Classifier returned an invalid decision (${code})`); }
}

export interface ClassifierTiming {
	classifyMs?: number;
	validateMs?: number;
	totalMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface ClassifierInvocation {
	state: EffortState;
	signal: AbortSignal;
	onTiming?: (timing: Readonly<ClassifierTiming>) => void;
	onDiagnostics?: (diagnostics: Readonly<ClassifierDiagnostics>) => void;
	debugResponses?: boolean;
}

export interface ClassifierDecision {
	effort: ModelThinkingLevel;
	model: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type SelectClassifier = (invocation: ClassifierInvocation) => Promise<ClassifierDecision>;

export async function selectWithClassifier(registry: ClassifierRegistry, { state, signal, onTiming, onDiagnostics, debugResponses = false }: ClassifierInvocation, backend: Extract<SelectorBackend, { type: "classifier" }>): Promise<ClassifierDecision> {
	const startedAt = performance.now();
	const timing: ClassifierTiming = {};
	const diagnostics: ClassifierDiagnostics = { stage: "request" };
	const elapsed = (since: number) => Math.max(0, Math.round((performance.now() - since) * 10) / 10);
	const report = () => {
		try { onTiming?.({ ...timing }); } catch { /* Ignore observer failures. */ }
		try { onDiagnostics?.({ ...diagnostics }); } catch { /* Ignore observer failures. */ }
	};
	try {
		signal.throwIfAborted();
		const models = await registry.getAvailableOfType("classifier", backend.provider, { signal });
		signal.throwIfAborted();
		const model = models.find((item) => item.provider === backend.provider && item.id === backend.id);
		if (!model) {
			diagnostics.errorCode = "model_unavailable";
			throw new Error("Configured classifier is unavailable in Pi (model or credentials missing)");
		}
		report();
		const classifyStartedAt = performance.now();
		// Authentication and transport belong to Pi. The caller owns the attempt deadline.
		const response = await registry.classify(model, { state, questions: {
			effort: { type: "choice", instructions: EFFORT_INSTRUCTIONS, criteria: getEffortCriteria(state.supportedEfforts) },
		} }, { signal, maxRetries: 0 }).finally(() => { timing.classifyMs = elapsed(classifyStartedAt); });
		signal.throwIfAborted();
		diagnostics.stopReason = response.stopReason;
		// A failed classification may still have billed usage. Do not infer missing counts.
		if (response.usage) {
			const { input, output, cost } = response.usage;
			if (Number.isFinite(input) && input >= 0) timing.inputTokens = input;
			if (Number.isFinite(output) && output >= 0) timing.outputTokens = output;
			if (Number.isFinite(cost.total) && cost.total >= 0) timing.cost = cost.total;
		}
		if (response.stopReason === "aborted") {
			diagnostics.errorCode = "provider_aborted";
			throw new Error("Classifier provider aborted the request");
		}
		if (response.stopReason !== "stop") throw new Error("Classifier request failed");
		const validationStartedAt = performance.now();
		diagnostics.stage = "validation";
		// Only normalized answers are available; never capture errorMessage or unknown fields.
		try {
			const { answers } = parseEnvelope(response);
			const answer = parseChoice(answers.effort, state.supportedEfforts);
			const effort = state.supportedEfforts.find((candidate) => candidate === answer.choice)!;
			diagnostics.stage = "complete";
			// Capture only validated fields. Never log arbitrary answers or resolved credentials.
			const text = JSON.stringify({ model: model.id, answers: { effort: { type: "choice", ...answer } } });
			diagnostics.responseType = "object";
			diagnostics.responseCharacters = text.length;
			if (debugResponses) {
				diagnostics.rawText = text.slice(0, CLASSIFIER_RESPONSE_TEXT_LIMIT);
				diagnostics.rawTextTruncated = text.length > CLASSIFIER_RESPONSE_TEXT_LIMIT;
			}
			return { effort, model: model.id, confidence: answer.confidence, probabilities: answer.probabilities };
		} finally {
			timing.validateMs = elapsed(validationStartedAt);
		}
	} catch (error) {
		if (signal.aborted) {
			diagnostics.errorCode = "request_cancelled";
			throw new Error("Classifier request cancelled");
		}
		if (error instanceof ClassifierValidationError) {
			diagnostics.errorCode = error.code;
			throw error;
		}
		if (diagnostics.errorCode === "provider_aborted" || diagnostics.errorCode === "model_unavailable") throw error;
		// Runtime errors can include credentials or echoed request bodies.
		diagnostics.errorCode = "request_failed";
		throw new Error("Classifier request failed");
	} finally {
		timing.totalMs = elapsed(startedAt);
		report();
	}
}

function parseEnvelope(response: unknown): { model: string; answers: Record<string, unknown> } {
	if (!isRecord(response)) throw new ClassifierValidationError("invalid_envelope");
	if (typeof response.model !== "string" || !response.model.trim()) throw new ClassifierValidationError("invalid_model");
	if (!isRecord(response.answers)) throw new ClassifierValidationError("invalid_answers");
	if (!Object.hasOwn(response.answers, "effort")) throw new ClassifierValidationError("missing_effort");
	if (Object.keys(response.answers).length !== 1) throw new ClassifierValidationError("unexpected_answers");
	return { model: response.model, answers: response.answers };
}

function parseChoice(answer: unknown, efforts: readonly string[]): { choice: string; confidence: number; probabilities: Record<string, number> } {
	if (!isRecord(answer)) throw new ClassifierValidationError("invalid_effort_answer");
	if (answer.type !== "choice") throw new ClassifierValidationError("invalid_answer_type");
	const effort = efforts.find((candidate) => candidate === answer.choice);
	if (!effort) throw new ClassifierValidationError("unsupported_effort");
	if (!isProbability(answer.confidence)) throw new ClassifierValidationError("invalid_confidence");
	if (!isRecord(answer.probabilities)) throw new ClassifierValidationError("invalid_probabilities");
	if (Object.keys(answer.probabilities).length !== efforts.length || efforts.some((key) => !Object.hasOwn(answer.probabilities as object, key))) {
		throw new ClassifierValidationError("probability_keys_mismatch");
	}

	let total = 0;
	const probabilities: number[] = [];
	const distribution: Record<string, number> = {};
	for (const candidate of efforts) {
		const probability = answer.probabilities[candidate];
		if (!isProbability(probability)) throw new ClassifierValidationError("invalid_probability");
		total += probability;
		probabilities.push(probability);
		distribution[candidate] = probability;
	}
	const selectedProbability = answer.probabilities[effort] as number;
	// Observed two-decimal responses can sum to 0.99; allow only bounded rounding drift.
	const twoDecimalValues = probabilities.every((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);
	const sumTolerance = twoDecimalValues ? efforts.length * 0.005 + 1e-8 : 0.001;
	if (Math.abs(total - 1) > sumTolerance) throw new ClassifierValidationError("probability_sum");
	if (probabilities.some((probability) => probability > selectedProbability)) {
		throw new ClassifierValidationError("choice_not_max");
	}
	return { choice: effort, confidence: answer.confidence, probabilities: distribution };
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
