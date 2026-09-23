import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { JevTiming } from "./jev.ts";
import { ROUTER_RESPONSE_TEXT_LIMIT, type RouterResponseDiagnostics, type RoutingDiagnostics } from "./router.ts";
import { keyHint, type EntryRenderer, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";

export const DECISION_ENTRY_TYPE = "pi-auto-decision";

const SELECTING_LABEL = "choosing effort";
/** Same Braille frames and cadence as Pi's built-in loader. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export interface EffortDecision {
	status: "selected" | "kept" | "cancelled";
	model: string;
	previousEffort: ModelThinkingLevel;
	effort: ModelThinkingLevel;
	reason: string;
	routerModel: string | undefined;
	routerEffort: Exclude<ModelThinkingLevel, "off"> | undefined;
	routerConfidence?: number;
	prepareMs?: number;
	jevTiming?: JevTiming;
	routerProbabilities?: Record<string, number>;
	routing?: RoutingDiagnostics;
	selectorResponses?: Partial<Record<"effort", RouterResponseDiagnostics>>;
	selectorUsage?: Partial<Record<"effort", { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>>;
	elapsedMs: number;
}

export function formatAutoEffort(theme: Theme, effort: ModelThinkingLevel): string {
	return theme.fg("accent", "auto") + theme.fg("dim", " · ") + theme.getThinkingBorderColor(effort)(effort);
}

export function formatJevTiming(timing: JevTiming): string {
	const labels = { setupMs: "setup", headersMs: "headers", bodyAndDecodeMs: "body/decode", validateMs: "validate", totalMs: "total" } as const;
	const parts = Object.entries(labels).flatMap(([key, label]) => {
		const value = timing[key as keyof typeof labels];
		return value === undefined ? [] : [`${label} ${value.toFixed(1)}ms`];
	});
	const transport = timing.transport;
	if (transport) {
		parts.push(`transport ${transport.status}`, `connection ${transport.connection}`);
		if (transport.socketId !== undefined) parts.push(`socket #${transport.socketId}`);
		if (transport.connectMs !== undefined) parts.push(`connect ${transport.connectMs.toFixed(1)}ms`);
		if (transport.afterUploadMs !== undefined) parts.push(`after-upload ${transport.afterUploadMs.toFixed(1)}ms`);
	}
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

	let heading = formatAutoEffort(theme, decision.effort);
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
	const data = entry.data as Record<string, unknown>;
	if ((data.status !== "selected" && data.status !== "kept" && data.status !== "cancelled") ||
		typeof data.model !== "string" || typeof data.reason !== "string" ||
		!isEffort(data.previousEffort) || !isEffort(data.effort) ||
		(data.routerModel !== undefined && typeof data.routerModel !== "string") ||
		(data.routerEffort !== undefined && (!isEffort(data.routerEffort) || data.routerEffort === "off")) ||
		(data.routerConfidence !== undefined && (typeof data.routerConfidence !== "number" ||
			!Number.isFinite(data.routerConfidence) || data.routerConfidence < 0 || data.routerConfidence > 1)) ||
		(data.prepareMs !== undefined && !isNonnegativeNumber(data.prepareMs)) ||
		(data.jevTiming !== undefined && !isJevTiming(data.jevTiming)) ||
		(data.routerProbabilities !== undefined && (!isRecord(data.routerProbabilities) ||
			!Object.entries(data.routerProbabilities).every(([key, value]) => isEffort(key) && isNonnegativeNumber(value) && value <= 1))) ||
		(data.routing !== undefined && !isRoutingDiagnostics(data.routing)) ||
		(data.selectorResponses !== undefined && (!isRecord(data.selectorResponses) || !Object.entries(data.selectorResponses).every(([key, value]) =>
			key === "effort" && isRouterResponseDiagnostics(value)))) ||
		(data.selectorUsage !== undefined && (!isRecord(data.selectorUsage) || !Object.entries(data.selectorUsage).every(([key, value]) =>
			key === "effort" && isRecord(value) && ["input", "output", "cacheRead", "cacheWrite", "cost"].every((field) => isNonnegativeNumber(value[field]))))) ||
		typeof data.elapsedMs !== "number" || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return undefined;
	return data as unknown as EffortDecision;
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

function isJevTiming(value: unknown): value is JevTiming {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const fields = ["setupMs", "headersMs", "bodyAndDecodeMs", "validateMs", "totalMs", "requestBytes", "httpStatus", "inputTokens", "outputTokens"];
	return Object.entries(value).every(([key, item]) => key === "transport" ? isTransportTiming(item) : fields.includes(key) && isNonnegativeNumber(item));
}

function isTransportTiming(value: unknown): boolean {
	if (!isRecord(value) || typeof value.status !== "string" || !["observed", "partial", "unavailable", "ambiguous"].includes(value.status) ||
		typeof value.connection !== "string" || !["new", "reused", "unknown"].includes(value.connection) ||
		!isNonnegativeNumber(value.requestCount) || !Number.isSafeInteger(value.requestCount)) return false;
	const numeric = ["connectMs", "sendHeadersMs", "bodySentMs", "responseHeadersMs", "afterUploadMs"];
	return Object.entries(value).every(([key, item]) => {
		if (["status", "connection", "requestCount"].includes(key)) return true;
		if (key === "socketId") return isNonnegativeNumber(item) && Number.isSafeInteger(item) && item > 0;
		return numeric.includes(key) && isNonnegativeNumber(item);
	});
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
