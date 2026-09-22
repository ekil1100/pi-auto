import { setImmediate } from "node:timers/promises";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { APIError, APITimeoutError, choice, TypeSafeClient, type EntryType, type Questions } from "@typesafe-ai/sdk";
import type { EffortState } from "./router.ts";
import { fetchWithTransportTiming, type JevTransportTiming } from "./jev-transport.ts";
import type { ContextRating } from "./context-compaction.ts";
import { CONTEXT_INSTRUCTIONS, IMPORTANCE_CRITERIA, type ContextClassificationInput } from "./context-policy.ts";
import { EFFORT_INSTRUCTIONS, getEffortCriteria } from "./effort-policy.ts";

export const JEV_MODEL = "jev-1.13.0";

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
}

export interface JevDecision {
	effort: ModelThinkingLevel;
	model: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export type SelectJev = (invocation: JevInvocation) => Promise<JevDecision>;

export async function selectWithJev(apiKey: string, invocation: JevInvocation): Promise<JevDecision> {
	return requestJev(apiKey, invocation, {
		effort: choice(EFFORT_INSTRUCTIONS, getEffortCriteria(invocation.state.supportedEfforts)),
	}, (response) => {
		const { model, answers } = parseEnvelope(response, ["effort"]);
		const answer = parseChoice(answers.effort, invocation.state.supportedEfforts);
		const effort = invocation.state.supportedEfforts.find((candidate) => candidate === answer.choice)!;
		return { effort, model, confidence: answer.confidence, probabilities: answer.probabilities };
	});
}

export type JevContextDecision = ContextRating & { confidence: number; probabilities: Record<string, number> };
export type JevContextInvocation = ContextClassificationInput & {
	onTiming?: JevInvocation["onTiming"];
	onDecisions?: (decisions: JevContextDecision[]) => void;
};

export async function classifyWithJev(apiKey: string, input: JevContextInvocation): Promise<ContextRating[]> {
	const keys = input.candidates.map((_candidate, index) => `block_${index}`);
	const questions = Object.fromEntries(input.candidates.map((_candidate, index) => [keys[index]!,
		choice(`${CONTEXT_INSTRUCTIONS}\nEvaluate candidates[${index}].text and its turn dependencies.`, IMPORTANCE_CRITERIA),
	]));
	return requestJev(apiKey, {
		state: { task: input.task, taskTruncated: input.taskTruncated, candidates: [...input.candidates], candidatesTruncated: input.candidatesTruncated },
		signal: input.signal,
		...(input.onTiming ? { onTiming: input.onTiming } : {}),
	}, questions, (response) => {
		const { answers } = parseEnvelope(response, keys);
		const decisions = input.candidates.map((candidate, index): JevContextDecision => {
			const answer = parseChoice(answers[keys[index]!], Object.keys(IMPORTANCE_CRITERIA));
			return { id: candidate.id, importance: answer.choice as ContextRating["importance"], confidence: answer.confidence, probabilities: answer.probabilities };
		});
		try { input.onDecisions?.(structuredClone(decisions)); } catch { /* Diagnostics must not change selection. */ }
		return decisions.map(({ id, importance }) => ({ id, importance }));
	});
}

async function requestJev<T>(
	apiKey: string,
	{ state, signal, onTiming }: { state: EntryType; signal: AbortSignal; onTiming?: JevInvocation["onTiming"] },
	questions: Questions,
	parse: (response: unknown) => T,
): Promise<T> {
	const startedAt = performance.now();
	const timing: JevTiming = {};
	const elapsed = (since: number) => Math.max(0, Math.round((performance.now() - since) * 10) / 10);
	const report = () => {
		// Diagnostics must never interrupt routing or expose mutable snapshots.
		try { onTiming?.({ ...timing, ...(timing.transport ? { transport: { ...timing.transport } } : {}) }); } catch { /* Ignore observer failures. */ }
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
				// a back-to-back classification/selection request asks for a connection.
				await setImmediate(undefined, { signal: init?.signal ?? signal });
				const fetchStartedAt = performance.now();
				timing.setupMs = elapsed(startedAt);
				if (typeof init?.body === "string") timing.requestBytes = Buffer.byteLength(init.body, "utf8");
				report();
				const response = await fetchWithTransportTiming(url, init, (transport) => {
					timing.transport = { ...transport };
					report();
				});
				headersAt = performance.now();
				timing.headersMs = elapsed(fetchStartedAt);
				timing.httpStatus = response.status;
				report();
				return response;
			},
		});
		let response: unknown;
		try {
			response = await client.systemOne({ state, questions }, { signal });
		} catch (error) {
			// Do not persist SDK error bodies: the service may echo sensitive input.
			if (signal.aborted) throw new Error("Jev request cancelled");
			if (error instanceof APITimeoutError) throw new Error("Jev request timed out");
			if (error instanceof APIError) throw new Error(`Jev request failed (HTTP ${error.status})`);
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
		try {
			if (isRecord(response) && isRecord(response.usage) && typeof response.usage.output_tokens === "number" &&
				Number.isSafeInteger(response.usage.output_tokens) && response.usage.output_tokens >= 0) timing.outputTokens = response.usage.output_tokens;
			return parse(response);
		} finally {
			timing.validateMs = elapsed(validationStartedAt);
		}
	} finally {
		timing.totalMs = elapsed(startedAt);
		report();
	}
}

function parseEnvelope(response: unknown, keys: readonly string[]): { model: string; answers: Record<string, unknown> } {
	if (!isRecord(response) || typeof response.model !== "string" || !/^jev-[\w.-]{1,64}$/.test(response.model) ||
		!isRecord(response.answers) || Object.keys(response.answers).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(response.answers as object, key))) throw new Error("Jev returned an invalid decision");
	return { model: response.model, answers: response.answers };
}

function parseChoice(answer: unknown, efforts: readonly string[]): { choice: string; confidence: number; probabilities: Record<string, number> } {
	const invalid = () => new Error("Jev returned an invalid decision");
	if (!isRecord(answer)) throw invalid();
	const effort = efforts.find((candidate) => candidate === answer.choice);
	if (answer.type !== "choice" || !effort || !isProbability(answer.confidence) ||
		!isRecord(answer.probabilities) || Object.keys(answer.probabilities).length !== efforts.length) throw invalid();

	let total = 0;
	const probabilities: number[] = [];
	const distribution: Record<string, number> = {};
	for (const candidate of efforts) {
		const probability = answer.probabilities[candidate];
		if (!isProbability(probability)) throw invalid();
		total += probability;
		probabilities.push(probability);
		distribution[candidate] = probability;
	}
	const selectedProbability = answer.probabilities[effort] as number;
	// Observed two-decimal responses can sum to 0.99; allow only bounded rounding drift.
	const twoDecimalValues = probabilities.every((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);
	const sumTolerance = twoDecimalValues ? efforts.length * 0.005 + 1e-8 : 0.001;
	if (Math.abs(total - 1) > sumTolerance) throw new Error("Jev returned an invalid decision (probability sum)");
	if (probabilities.some((probability) => probability > selectedProbability)) {
		throw new Error("Jev returned an invalid decision (choice is not a highest-probability option)");
	}
	return { choice: effort, confidence: answer.confidence, probabilities: distribution };
}

function isProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
