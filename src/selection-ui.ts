import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { CLASSIFIER_ERROR_CODES, CLASSIFIER_RESPONSE_TEXT_LIMIT, type ClassifierDiagnostics, type ClassifierTiming } from "./classifier.ts";
import { ROUTER_RESPONSE_TEXT_LIMIT, type RouterResponseDiagnostics, type RoutingDiagnostics } from "./router.ts";
import { keyHint, type EntryRenderer, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";

export const DECISION_ENTRY_TYPE = "pi-auto-decision";

const SELECTING_LABEL = "choosing effort";
/** Same Braille frames and cadence as Pi's built-in loader. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface SelectionAttempt {
	backend: "classifier" | "chat" | "current-model";
	outcome: "selected" | "skipped" | "failed" | "cancelled";
	timeoutMs: number;
	elapsedMs: number;
	interruption?: "deadline" | "escape" | "runtime" | "auto-off" | "settings-changed" | "session-shutdown" | "provider";
	reason?: string;
}

export interface EffortDecision {
	status: "selected" | "kept" | "cancelled";
	actualBackend?: string;
	model: string;
	previousEffort: ModelThinkingLevel;
	effort: ModelThinkingLevel;
	reason: string;
	routerModel: string | undefined;
	routerEffort: Exclude<ModelThinkingLevel, "off"> | undefined;
	routerConfidence?: number;
	prepareMs?: number;
	classifierTiming?: ClassifierTiming;
	classifierDiagnostics?: ClassifierDiagnostics;
	routerProbabilities?: Record<string, number>;
	routing?: RoutingDiagnostics;
	selectorAttempts?: SelectionAttempt[];
	selectorResponses?: Partial<Record<"effort", RouterResponseDiagnostics>>;
	selectorUsage?: Partial<Record<"effort", { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>>;
	elapsedMs: number;
}

export function formatAutoEffort(theme: Theme, effort: ModelThinkingLevel, backend?: string): string {
	return theme.fg("accent", "auto") + theme.fg("dim", " · ") + theme.getThinkingBorderColor(effort)(effort) + (backend ? theme.fg("dim", ` · ${inlineText(backend)}`) : "");
}

export function formatClassifierTiming(timing: ClassifierTiming): string {
	const labels = { classifyMs: "classify", validateMs: "validate", totalMs: "total" } as const;
	const parts = Object.entries(labels).flatMap(([key, label]) => {
		const value = timing[key as keyof typeof labels];
		return value === undefined ? [] : [`${label} ${value.toFixed(1)}ms`];
	});
	return parts.join(" · ");
}

/** Spinning progress row shown while the effort request is pending; stops when the widget is cleared. */
export function createSelectingWidget(tui: TUI, theme: Theme): Component & { dispose(): void } {
	let frame = 0;
	const timer = setInterval(() => {
		frame = (frame + 1) % SPINNER_FRAMES.length;
		tui.requestRender();
	}, SPINNER_INTERVAL_MS);

	return {
		render: (_width) => [` ${theme.fg("accent", SPINNER_FRAMES[frame]!)} ${theme.fg("accent", SELECTING_LABEL)}`],
		invalidate: () => {},
		dispose: () => clearInterval(timer),
	};
}

export const renderDecisionEntry: EntryRenderer<EffortDecision> = (entry, { expanded }, theme) => {
	const decision = readDecision(entry);
	if (!decision) return undefined;

	let heading = formatAutoEffort(theme, decision.effort, decision.actualBackend);
	if (!decision.actualBackend && decision.routerModel) {
		const modelName = decision.routerModel.slice(decision.routerModel.indexOf("/") + 1);
		heading += theme.fg("dim", ` · ${inlineText(modelName)}`);
	}
	heading += theme.fg("dim", ` · ${(decision.elapsedMs / 1_000).toFixed(2)}s`);
	if (decision.status !== "selected") heading += theme.fg("warning", ` · ${decision.status}`);
	if (!expanded) return new Text(`${heading} ${keyHint("app.tools.expand", "to expand")}`, 1, 0);

	const detail = (label: string, value: string) => theme.fg("muted", `  ${label}: `) + value;
	const lines = [
		heading,
		detail("Model", theme.fg("text", inlineText(decision.model))),
		detail("Effort", theme.getThinkingBorderColor(decision.previousEffort)(decision.previousEffort) +
			theme.fg("dim", " → ") + theme.getThinkingBorderColor(decision.effort)(decision.effort)),
		detail("Selector", decision.routerModel
			? theme.fg("text", inlineText(decision.routerModel)) + (decision.routerEffort
				? theme.fg("dim", " @ ") + theme.getThinkingBorderColor(decision.routerEffort)(decision.routerEffort)
				: "")
			: theme.fg("dim", "not called")),
		detail(decision.status === "selected" ? "Reason" : "Kept because", theme.fg(decision.status === "selected" ? "text" : "warning", inlineText(decision.reason))),
		detail("Elapsed", theme.fg("dim", `${(decision.elapsedMs / 1000).toFixed(1)}s`)),
		...(decision.routing?.context ? [detail("Context", theme.fg("text", formatContextSummary(decision.routing.context)))] : []),
		theme.fg("dim", "  /auto status: inspect the latest decision"),
	];
	return new Text(lines.join("\n"), 1, 0);
};

export function formatContextSummary(context: NonNullable<RoutingDiagnostics["context"]>): string {
	return `${context.sources.length} messages retained · omitted: ${context.omitted ? "yes" : "no"}`;
}

export function readDecision(entry: SessionEntry): EffortDecision | undefined {
	if (entry.type !== "custom" || entry.customType !== DECISION_ENTRY_TYPE) return undefined;
	if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return undefined;
	const { classifierTiming, classifierDiagnostics, actualBackend, jevTiming: _oldTiming, jevDiagnostics: _oldDiagnostics, ...fields } = entry.data as Record<string, unknown>;
	// Optional diagnostics must not hide a valid saved decision after schema changes.
	const timing = readClassifierTiming(classifierTiming);
	if (Array.isArray(fields.selectorAttempts) && fields.selectorAttempts.some((item) => isRecord(item) && item.backend === "jev")) delete fields.selectorAttempts;
	const data: Record<string, unknown> = {
		...fields,
		...(typeof actualBackend === "string" ? { actualBackend } : {}),
		...(timing ? { classifierTiming: timing } : {}),
		...(isClassifierDiagnostics(classifierDiagnostics) ? { classifierDiagnostics } : {}),
	};
	if ((data.status !== "selected" && data.status !== "kept" && data.status !== "cancelled") ||
		typeof data.model !== "string" || typeof data.reason !== "string" ||
		!isEffort(data.previousEffort) || !isEffort(data.effort) ||
		(data.routerModel !== undefined && typeof data.routerModel !== "string") ||
		(data.routerEffort !== undefined && (!isEffort(data.routerEffort) || data.routerEffort === "off")) ||
		(data.routerConfidence !== undefined && (typeof data.routerConfidence !== "number" ||
			!Number.isFinite(data.routerConfidence) || data.routerConfidence < 0 || data.routerConfidence > 1)) ||
		(data.prepareMs !== undefined && !isNonnegativeNumber(data.prepareMs)) ||
		(data.routerProbabilities !== undefined && (!isRecord(data.routerProbabilities) ||
			!Object.entries(data.routerProbabilities).every(([key, value]) => isEffort(key) && isNonnegativeNumber(value) && value <= 1))) ||
		(data.routing !== undefined && !isRoutingDiagnostics(data.routing)) ||
		(data.selectorAttempts !== undefined && (!Array.isArray(data.selectorAttempts) || data.selectorAttempts.length > 2 ||
			!data.selectorAttempts.every((attempt: unknown) => isRecord(attempt) &&
				["classifier", "chat", "current-model"].includes(String(attempt.backend)) &&
				["selected", "skipped", "failed", "cancelled"].includes(String(attempt.outcome)) &&
				isNonnegativeNumber(attempt.timeoutMs) && isNonnegativeNumber(attempt.elapsedMs) &&
				(attempt.interruption === undefined || ["deadline", "escape", "runtime", "auto-off", "settings-changed", "session-shutdown", "provider"].includes(String(attempt.interruption))) &&
				(attempt.reason === undefined || typeof attempt.reason === "string")))) ||
		(data.selectorResponses !== undefined && (!isRecord(data.selectorResponses) || !Object.entries(data.selectorResponses).every(([key, value]) =>
			key === "effort" && isRouterResponseDiagnostics(value)))) ||
		(data.selectorUsage !== undefined && (!isRecord(data.selectorUsage) || !Object.entries(data.selectorUsage).every(([key, value]) =>
			key === "effort" && isRecord(value) && ["input", "output", "cacheRead", "cacheWrite", "cost"].every((field) => isNonnegativeNumber(value[field]))))) ||
		typeof data.elapsedMs !== "number" || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return undefined;
	return data as unknown as EffortDecision;
}

function isClassifierDiagnostics(value: unknown): value is ClassifierDiagnostics {
	if (!isRecord(value) || !["request", "validation", "complete"].includes(String(value.stage)) ||
		(value.errorCode !== undefined && !CLASSIFIER_ERROR_CODES.some((code) => code === value.errorCode)) ||
		!Object.keys(value).every((key) => ["stage", "errorCode", "stopReason", "responseType", "responseCharacters", "rawText", "rawTextTruncated"].includes(key))) return false;
	if (value.stopReason !== undefined && !["stop", "error", "aborted"].includes(String(value.stopReason))) return false;
	if (value.responseType === undefined) return value.responseCharacters === undefined && value.rawText === undefined && value.rawTextTruncated === undefined;
	return value.responseType === "object" &&
		isNonnegativeNumber(value.responseCharacters) && Number.isSafeInteger(value.responseCharacters) &&
		(value.rawText === undefined ? value.rawTextTruncated === undefined :
			typeof value.rawText === "string" && value.rawText.length === Math.min(value.responseCharacters, CLASSIFIER_RESPONSE_TEXT_LIMIT) &&
			value.rawTextTruncated === (value.responseCharacters > CLASSIFIER_RESPONSE_TEXT_LIMIT));
}

function isRouterResponseDiagnostics(value: unknown): value is RouterResponseDiagnostics {
	return isRecord(value) && typeof value.stopReason === "string" &&
		["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(value.stopReason) &&
		Array.isArray(value.contentTypes) && value.contentTypes.length <= 3 &&
		value.contentTypes.every((type: unknown) => typeof type === "string" && ["text", "thinking", "toolCall"].includes(type)) &&
		isNonnegativeNumber(value.textCharacters) && Number.isSafeInteger(value.textCharacters) &&
		(value.rawText === undefined ? value.rawTextTruncated === undefined :
			typeof value.rawText === "string" && value.rawText.length === Math.min(value.textCharacters, ROUTER_RESPONSE_TEXT_LIMIT) &&
			value.rawTextTruncated === (value.textCharacters > ROUTER_RESPONSE_TEXT_LIMIT));
}

function isNonnegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function readClassifierTiming(value: unknown): ClassifierTiming | undefined {
	if (!isRecord(value)) return undefined;
	const fields = ["classifyMs", "validateMs", "totalMs", "inputTokens", "outputTokens", "cost"];
	const entries = Object.entries(value).filter(([key, item]) => fields.includes(key) && isNonnegativeNumber(item));
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoutingDiagnostics(value: unknown): value is RoutingDiagnostics {
	if (!isRecord(value) || typeof value.policyVersion !== "string" || !/^\d{1,8}$/.test(value.policyVersion) ||
		!Array.isArray(value.supportedEfforts) || value.supportedEfforts.length > 7 || !value.supportedEfforts.every(isEffort) ||
		typeof value.taskTruncated !== "boolean" || (value.selectionMs !== undefined && !isNonnegativeNumber(value.selectionMs))) return false;
	const context = value.context;
	if (context === undefined) return true;
	return isRecord(context) && context.strategy === "recent-turn" && typeof context.omitted === "boolean" &&
		isNonnegativeNumber(context.characters) && Number.isSafeInteger(context.characters) &&
		isNonnegativeNumber(context.elapsedMs) && Array.isArray(context.sources) && context.sources.length <= 2 &&
		context.sources.every(isContextSource) &&
		Object.keys(context).every((key) => ["strategy", "omitted", "characters", "elapsedMs", "sources"].includes(key));
}

function isContextSource(source: unknown): boolean {
	return isRecord(source) && typeof source.entryId === "string" &&
		(source.role === "user" || source.role === "assistant") &&
		isNonnegativeNumber(source.start) && Number.isSafeInteger(source.start) &&
		isNonnegativeNumber(source.end) && Number.isSafeInteger(source.end) && source.end >= source.start &&
		Object.keys(source).every((key) => ["entryId", "role", "start", "end"].includes(key));
}

function isEffort(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function inlineText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
