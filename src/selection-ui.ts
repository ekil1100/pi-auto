import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { keyHint, type EntryRenderer, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const DECISION_ENTRY_TYPE = "pi-auto-decision";

export interface EffortDecision {
	status: "selected" | "kept" | "cancelled";
	model: string;
	previousEffort: ModelThinkingLevel;
	effort: ModelThinkingLevel;
	reason: string;
	routerModel: string | undefined;
	routerEffort: Exclude<ModelThinkingLevel, "off"> | undefined;
	elapsedMs: number;
}

export function formatAutoEffort(theme: Theme, effort: ModelThinkingLevel): string {
	return theme.fg("accent", "auto") + theme.fg("dim", " · ") + theme.getThinkingBorderColor(effort)(effort);
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
		detail("Selector", decision.routerEffort
			? theme.fg("text", inlineText(decision.routerModel ?? decision.model)) + theme.fg("dim", " @ ") +
				theme.getThinkingBorderColor(decision.routerEffort)(decision.routerEffort)
			: theme.fg("dim", "not called")),
		detail("Reason", theme.fg("text", inlineText(decision.reason))),
		detail("Elapsed", theme.fg("dim", `${(decision.elapsedMs / 1000).toFixed(1)}s`)),
	];
	return new Text(lines.join("\n"), 1, 0);
};

export function readDecision(entry: SessionEntry): EffortDecision | undefined {
	if (entry.type !== "custom" || entry.customType !== DECISION_ENTRY_TYPE) return undefined;
	if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return undefined;
	const data = entry.data as Record<string, unknown>;
	if ((data.status !== "selected" && data.status !== "kept" && data.status !== "cancelled") ||
		typeof data.model !== "string" || typeof data.reason !== "string" ||
		!isEffort(data.previousEffort) || !isEffort(data.effort) ||
		(data.routerModel !== undefined && typeof data.routerModel !== "string") ||
		(data.routerEffort !== undefined && (!isEffort(data.routerEffort) || data.routerEffort === "off")) ||
		typeof data.elapsedMs !== "number" || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return undefined;
	return data as unknown as EffortDecision;
}

function isEffort(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function inlineText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
