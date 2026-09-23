import { setImmediate } from "node:timers/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { APIError, APITimeoutError, choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { EffortState } from "./router.ts";
import type { JevTransportTiming, TimedJevFetch } from "./jev-transport.ts";
import { EFFORT_INSTRUCTIONS, getEffortCriteria } from "./effort-policy.ts";

export const JEV_MODEL = "jev-1.13.0";
export const JEV_RESPONSE_TEXT_LIMIT = 8_192;
export const JEV_ERROR_CODES = [
	"request_cancelled", "request_timeout", "http_error", "transport_error", "response_read_failed",
	"invalid_envelope", "invalid_model", "invalid_answers", "missing_effort", "unexpected_answers",
	"invalid_effort_answer", "invalid_answer_type", "unsupported_effort", "invalid_confidence",
	"invalid_probabilities", "probability_keys_mismatch", "invalid_probability", "probability_sum", "choice_not_max",
] as const;
type JevErrorCode = typeof JEV_ERROR_CODES[number];

export interface JevDiagnostics {
	stage: "request" | "response" | "validation" | "complete";
	errorCode?: JevErrorCode;
	responseType?: "object" | "array" | "null" | "string" | "number" | "boolean" | "undefined";
	responseCharacters?: number;
	/** SDK-decoded response, serialized as JSON (or plain text), with the API key redacted. */
	rawText?: string;
	rawTextTruncated?: boolean;
}

class JevValidationError extends Error {
	constructor(readonly code: JevErrorCode) { super(`Jev returned an invalid decision (${code})`); }
}

export interface JevTiming {
	setupMs?: number;
	headersMs?: number;
	bodyAndDecodeMs?: number;
	validateMs?: number;
	totalMs?: number;
	requestBytes?: number;
	httpStatus?: number;
	inputTokens?: number;
	outputTokens?: number;
	transport?: JevTransportTiming;
}

export interface JevInvocation {
	state: EffortState;
	signal: AbortSignal;
	onTiming?: (timing: Readonly<JevTiming>) => void;
	onDiagnostics?: (diagnostics: Readonly<JevDiagnostics>) => void;
	debugResponses?: boolean;
}

export interface JevDecision {
	effort: ModelThinkingLevel;
	model: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type SelectJev = (invocation: JevInvocation) => Promise<JevDecision>;

export async function selectWithJev(apiKey: string, { state, signal, onTiming, onDiagnostics, debugResponses = false }: JevInvocation, fetchJev: TimedJevFetch): Promise<JevDecision> {
	const startedAt = performance.now();
	const timing: JevTiming = {};
	const diagnostics: JevDiagnostics = { stage: "request" };
	const elapsed = (since: number) => Math.max(0, Math.round((performance.now() - since) * 10) / 10);
	const report = () => {
		// Diagnostics must never interrupt routing or expose mutable snapshots.
		try { onTiming?.({ ...timing, ...(timing.transport ? { transport: { ...timing.transport } } : {}) }); } catch { /* Ignore observer failures. */ }
		try { onDiagnostics?.({ ...diagnostics }); } catch { /* Ignore observer failures. */ }
	};
	let headersAt: number | undefined;
	try {
		signal.throwIfAborted();
		const client = new TypeSafeClient({
			apiKey,
			baseURL: "https://api.typesafe.ai",
			defaultModel: JEV_MODEL,
			retry: { maxRetries: 0 },
			timeout: 10_000,
			logLevel: "off",
			fetch: async (url, init) => {
				// Let Undici return the previous response's socket to its pool before
				// a subsequent selection request asks for a connection.
				await setImmediate(undefined, { signal: init?.signal ?? signal });
				const fetchStartedAt = performance.now();
				timing.setupMs = elapsed(startedAt);
				if (typeof init?.body === "string") timing.requestBytes = Buffer.byteLength(init.body, "utf8");
				report();
				const response = await fetchJev(url, init, (transport) => {
					timing.transport = { ...transport };
					report();
				});
				headersAt = performance.now();
				timing.headersMs = elapsed(fetchStartedAt);
				timing.httpStatus = response.status;
				diagnostics.stage = "response";
				report();
				return response;
			},
		});
		let response: unknown;
		try {
			response = await client.systemOne({ state, questions: {
				effort: choice(EFFORT_INSTRUCTIONS, getEffortCriteria(state.supportedEfforts)),
			} }, { signal });
		} catch (error) {
			// Do not persist SDK error bodies: the service may echo sensitive input.
			if (signal.aborted) { diagnostics.errorCode = "request_cancelled"; throw new Error("Jev request cancelled"); }
			if (error instanceof APITimeoutError) { diagnostics.errorCode = "request_timeout"; throw new Error("Jev request timed out"); }
			if (error instanceof APIError) { diagnostics.errorCode = "http_error"; throw new Error(`Jev request failed (HTTP ${error.status})`); }
			diagnostics.errorCode = headersAt === undefined ? "transport_error" : "response_read_failed";
			throw new Error("Jev request failed");
		} finally {
			if (headersAt !== undefined) timing.bodyAndDecodeMs = elapsed(headersAt);
		}
		signal.throwIfAborted();
		if (isRecord(response) && isRecord(response.usage) &&
			typeof response.usage.input_tokens === "number" &&
			Number.isSafeInteger(response.usage.input_tokens) && response.usage.input_tokens >= 0) {
			timing.inputTokens = response.usage.input_tokens;
		}
		const validationStartedAt = performance.now();
		diagnostics.stage = "validation";
		diagnostics.responseType = response === null ? "null" : Array.isArray(response) ? "array" : typeof response as NonNullable<JevDiagnostics["responseType"]>;
		// The SDK has already decoded the body. Do not clone HTTP streams or record headers.
		const serialized = typeof response === "string" ? response : JSON.stringify(response) ?? "";
		const text = apiKey ? serialized.replaceAll(JSON.stringify(apiKey).slice(1, -1), "[REDACTED]").replaceAll(apiKey, "[REDACTED]") : serialized;
		diagnostics.responseCharacters = text.length;
		if (debugResponses) {
			diagnostics.rawText = text.slice(0, JEV_RESPONSE_TEXT_LIMIT);
			diagnostics.rawTextTruncated = text.length > JEV_RESPONSE_TEXT_LIMIT;
		}
		try {
			if (isRecord(response) && isRecord(response.usage) && typeof response.usage.output_tokens === "number" &&
				Number.isSafeInteger(response.usage.output_tokens) && response.usage.output_tokens >= 0) timing.outputTokens = response.usage.output_tokens;
			const { model, answers } = parseEnvelope(response);
			const answer = parseChoice(answers.effort, state.supportedEfforts);
			const effort = state.supportedEfforts.find((candidate) => candidate === answer.choice)!;
			diagnostics.stage = "complete";
			return { effort, model, confidence: answer.confidence, probabilities: answer.probabilities };
		} finally {
			timing.validateMs = elapsed(validationStartedAt);
		}
	} catch (error) {
		if (signal.aborted) diagnostics.errorCode = "request_cancelled";
		else if (error instanceof JevValidationError) diagnostics.errorCode = error.code;
		throw error;
	} finally {
		timing.totalMs = elapsed(startedAt);
		report();
	}
}

function parseEnvelope(response: unknown): { model: string; answers: Record<string, unknown> } {
	if (!isRecord(response)) throw new JevValidationError("invalid_envelope");
	if (typeof response.model !== "string" || !/^jev-[\w.-]{1,64}$/.test(response.model)) throw new JevValidationError("invalid_model");
	if (!isRecord(response.answers)) throw new JevValidationError("invalid_answers");
	if (!Object.hasOwn(response.answers, "effort")) throw new JevValidationError("missing_effort");
	if (Object.keys(response.answers).length !== 1) throw new JevValidationError("unexpected_answers");
	return { model: response.model, answers: response.answers };
}

function parseChoice(answer: unknown, efforts: readonly string[]): { choice: string; confidence: number; probabilities: Record<string, number> } {
	if (!isRecord(answer)) throw new JevValidationError("invalid_effort_answer");
	if (answer.type !== "choice") throw new JevValidationError("invalid_answer_type");
	const effort = efforts.find((candidate) => candidate === answer.choice);
	if (!effort) throw new JevValidationError("unsupported_effort");
	if (!isProbability(answer.confidence)) throw new JevValidationError("invalid_confidence");
	if (!isRecord(answer.probabilities)) throw new JevValidationError("invalid_probabilities");
	if (Object.keys(answer.probabilities).length !== efforts.length || efforts.some((key) => !Object.hasOwn(answer.probabilities as object, key))) {
		throw new JevValidationError("probability_keys_mismatch");
	}

	let total = 0;
	const probabilities: number[] = [];
	const distribution: Record<string, number> = {};
	for (const candidate of efforts) {
		const probability = answer.probabilities[candidate];
		if (!isProbability(probability)) throw new JevValidationError("invalid_probability");
		total += probability;
		probabilities.push(probability);
		distribution[candidate] = probability;
	}
	const selectedProbability = answer.probabilities[effort] as number;
	// Observed two-decimal responses can sum to 0.99; allow only bounded rounding drift.
	const twoDecimalValues = probabilities.every((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);
	const sumTolerance = twoDecimalValues ? efforts.length * 0.005 + 1e-8 : 0.001;
	if (Math.abs(total - 1) > sumTolerance) throw new JevValidationError("probability_sum");
	if (probabilities.some((probability) => probability > selectedProbability)) {
		throw new JevValidationError("choice_not_max");
	}
	return { choice: effort, confidence: answer.confidence, probabilities: distribution };
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
