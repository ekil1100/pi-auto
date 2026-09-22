import { stripVTControlCharacters } from "node:util";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Keybinding, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { formatContextSummary, formatJevTiming, type EffortDecision } from "./selection-ui.ts";

const OVERLAY_WIDTH = 96;
const OVERLAY_MARGIN = 1;

export interface AutoStatus {
	enabled: boolean;
	model: string;
	effort: ModelThinkingLevel;
	backend: string;
	supportedEfforts: readonly ModelThinkingLevel[];
	last?: EffortDecision;
}

type StatusLine = { text: string; tone?: "accent" | "warning" | "dim" };
export type StatusPage = { title: string; lines: StatusLine[] };
const row = (text: string, tone?: StatusLine["tone"]): StatusLine => ({ text: safeText(text), ...(tone ? { tone } : {}) });
const section = (title: string): StatusLine[] => [row(""), row(title, "accent")];

/** All views consume the same snapshot; inspecting it never re-runs selection. */
export function buildStatusPages(state: AutoStatus): StatusPage[] {
	const last = state.last;
	const context = last?.routing?.compaction;
	const overview = [
		row("Current (at open)", "accent"),
		row(`Auto: ${state.enabled ? "enabled" : "disabled"} (effort only)`),
		row(`Current model: ${state.model}`),
		row(`Current effort: ${state.effort}`),
		row(`Selector backend: ${state.backend}`),
	];
	if (!last) overview.push(...section("Last selection"), row("No selection recorded for this branch.", "dim"));
	else {
		overview.push(...section("Last selection"),
			row(`Effort: ${last.previousEffort} -> ${last.effort} | ${last.status} | ${(last.elapsedMs / 1_000).toFixed(2)}s`, last.status === "selected" ? undefined : "warning"));
		if (last.status !== "selected") overview.push(row(`Reason: ${last.reason}`, "warning"));
		if (last.model !== state.model) overview.push(row(`Model: ${last.model}`));
		overview.push(row(`Selector: ${last.routerModel ?? "not called"}`));
		if (context) overview.push(row(`Context: ${formatContextSummary(context)}`));
		if (last.status === "selected") overview.push(row(`Reason: ${last.reason}`));
		if (last.routing?.taskTruncated) overview.push(row("Current task was truncated for selection.", "warning"));
	}

	const contextLines: StatusLine[] = [];
	if (!context) contextLines.push(row("No context diagnostics recorded.", "dim"));
	else {
		const packed = context.status === "bypassed" || context.status === "extracted";
		contextLines.push(row(`Context: ${context.status}`, "accent"), row(formatContextSummary(context)),
			row(`Candidate pool incomplete: ${context.candidatesTruncated ? "yes" : "no"}`, context.candidatesTruncated ? "warning" : undefined),
			row(`Candidate JSON: ${context.candidateCharacters} UTF-16 units`),
			row(`Packed history: ${context.selectedCharacters} UTF-16 units`));
		if (context.reason) contextLines.push(row(`Failure: ${context.reason}`, "warning"));
		contextLines.push(row("Ranges are [start, end) in newline-joined message text.", "dim"),
			row("Importance is a rating, not a guarantee of retention.", "dim"),
			row("Source metadata only; message text is not displayed.", "dim"));
		if (context.candidateSources) {
			const ratings = new Map(context.ratings.map(({ id, importance }) => [id, importance]));
			contextLines.push(...section("Candidates (source order)"));
			if (!context.candidateSources.length) contextLines.push(row("No candidate metadata available.", "dim"));
			for (const [index, candidate] of context.candidateSources.entries()) {
				const retained = context.sources.some((source) => source.entryId === candidate.entryId && source.role === candidate.role &&
					source.start === candidate.start && source.end === candidate.end);
				const importance = ratings.get(candidate.id) ?? (context.status === "bypassed" ? "not classified" : "not recorded");
				contextLines.push(row(`${index + 1}. ${candidate.role} | ${importance} | ${packed ? (retained ? "retained" : "not retained") : "not packed"}`),
					row(`   Source: ${candidate.entryId}`),
					row(`   Range: ${candidate.start}-${candidate.end} | Candidate: ${candidate.id}`), row(""));
			}
		} else {
			// Old entries did not record candidate-to-source links. Do not infer them from IDs.
			contextLines.push(...section("Saved sources and ratings"), row("Candidate/source mapping was not recorded.", "dim"));
			for (const source of context.sources) contextLines.push(row(`Retained: ${source.role} | ${source.entryId} | ${source.start}-${source.end}`));
			for (const rating of context.ratings) contextLines.push(row(`Candidate ${rating.id}: ${rating.importance} | retention unknown`));
		}
	}

	const diagnostics: StatusLine[] = [row("Current capabilities", "accent"), row(`Supported efforts: ${state.supportedEfforts.join(", ") || "none"}`)];
	if (!last) diagnostics.push(row("No selection diagnostics recorded.", "dim"));
	else {
		diagnostics.push(...section("Last selection policy"));
		if (last.routerEffort) diagnostics.push(row(`Selector effort: ${last.routerEffort}`));
		if (last.routing) diagnostics.push(row(`Policy: ${last.routing.policyVersion}`),
			row(`Selector choices: ${last.routing.supportedEfforts.join(", ")}`), row(`Task truncated: ${last.routing.taskTruncated}`));
		else diagnostics.push(row("Policy metadata not recorded.", "dim"));
		if (last.routerConfidence !== undefined || last.routerProbabilities) {
			diagnostics.push(...section("Effort probabilities"), row("Confidence is not task success probability.", "dim"));
			if (last.routerConfidence !== undefined) diagnostics.push(row(`Confidence: ${last.routerConfidence.toFixed(3)} (not success probability)`));
			for (const [effort, probability] of Object.entries(last.routerProbabilities ?? {})) diagnostics.push(row(`${effort}: ${probability}`));
		}
		diagnostics.push(...section("Timing"), row(`Total: ${last.elapsedMs}ms`));
		if (last.prepareMs !== undefined) diagnostics.push(row(`Prepare: ${last.prepareMs.toFixed(1)}ms`));
		if (context?.elapsedMs !== undefined) diagnostics.push(row(`Context stage: ${context.elapsedMs}ms`));
		if (last.routing?.selectionMs !== undefined) diagnostics.push(row(`Selection: ${last.routing.selectionMs}ms`));
		for (const [label, timing] of [["Context request", last.contextTiming], ["Effort request", last.jevTiming]] as const) {
			if (!timing) continue;
			diagnostics.push(...section(label), ...formatJevTiming(timing).split(" · ").filter(Boolean).map((text) => row(text)));
			if (timing.requestBytes !== undefined) diagnostics.push(row(`Request bytes: ${timing.requestBytes}`));
			if (timing.httpStatus !== undefined) diagnostics.push(row(`HTTP status: ${timing.httpStatus}`));
			if (timing.transport) diagnostics.push(row(`Observed requests: ${timing.transport.requestCount}`));
		}
		diagnostics.push(...section("Usage"), row("Extra selector calls are not included in Pi footer totals.", "dim"));
		let hasUsage = false;
		for (const [label, timing] of [["Context", last.contextTiming], ["Effort", last.jevTiming]] as const) {
			if (timing?.inputTokens === undefined && timing?.outputTokens === undefined) continue;
			hasUsage = true;
			diagnostics.push(row(`${label} usage: ${timing.inputTokens ?? "unknown"} input / ${timing.outputTokens ?? "unknown"} output tokens`));
		}
		for (const [purpose, usage] of Object.entries(last.selectorUsage ?? {})) {
			hasUsage = true;
			diagnostics.push(row(`${purpose}: ${usage.input} input / ${usage.output} output tokens`),
				row(`Cache: ${usage.cacheRead} read / ${usage.cacheWrite} write | Cost: $${usage.cost}`));
		}
		if (!hasUsage) diagnostics.push(row("Usage not recorded.", "dim"));
		if (last.contextDecisions?.length) {
			diagnostics.push(...section("Context classification probabilities"), row("Confidence is not classification accuracy.", "dim"));
			for (const decision of last.contextDecisions) {
				diagnostics.push(row(`${decision.id}: ${decision.importance} | confidence ${decision.confidence}`));
				for (const [importance, probability] of Object.entries(decision.probabilities)) diagnostics.push(row(`  ${importance}: ${probability}`));
			}
		}
	}
	return [{ title: "Overview", lines: overview }, { title: "Context", lines: contextLines }, { title: "Diagnostics", lines: diagnostics }];
}

export async function showAutoStatus(ctx: ExtensionContext, state: AutoStatus): Promise<void> {
	const pages = buildStatusPages(structuredClone(state));
	if (ctx.mode !== "tui") {
		// RPC supports notifications, not terminal component factories.
		ctx.ui.notify(pages.map((page) => `${page.title}\n${page.lines.map(({ text }) => text).join("\n")}`).join("\n\n"), ctx.model ? "info" : "warning");
		return;
	}
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => new AutoStatusPanel(pages, tui, theme, keybindings, done), {
		overlay: true,
		overlayOptions: { width: OVERLAY_WIDTH, maxHeight: "80%", margin: OVERLAY_MARGIN },
	});
}

/** Bounded viewport with fixed navigation; all long IDs remain reachable by wrapping. */
export class AutoStatusPanel implements Component {
	private page = 0;
	private offset = 0;
	private pageSize = 1;
	private lineCount = 0;
	private lastWidth = 0;
	private lastRows = 0;
	private lastColumns = 0;

	constructor(
		private readonly pages: StatusPage[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: () => void,
	) {}

	handleInput(data: string): void {
		const matches = (id: Keybinding) => this.keybindings.matches(data, id);
		if (matches("tui.select.cancel")) { this.done(); return; }
		// Resize notifications schedule paints. Use the same width cap/margins as the host overlay.
		const { rows, columns } = this.tui.terminal;
		if (this.lastWidth > 0 && (this.lastRows !== rows || this.lastColumns !== columns)) {
			const width = this.lastColumns !== columns ? Math.min(OVERLAY_WIDTH, Math.max(1, columns - 2 * OVERLAY_MARGIN)) : this.lastWidth;
			this.layout(width);
		}
		if (matches("tui.input.tab")) {
			this.page = (this.page + 1) % this.pages.length;
			this.offset = 0;
			// Refresh bounds now: another key can arrive before the host paints this page.
			if (this.lastWidth > 0) this.layout(this.lastWidth);
		} else if (matches("tui.select.up")) this.offset--;
		else if (matches("tui.select.down")) this.offset++;
		else if (matches("tui.select.pageUp")) this.offset -= this.pageSize;
		else if (matches("tui.select.pageDown")) this.offset += this.pageSize;
		// Explicit Pi bindings take precedence over the local Vim-style aliases.
		else if (matchesKey(data, "k")) this.offset--;
		else if (matchesKey(data, "j")) this.offset++;
		else return;
		this.offset = this.lastWidth > 0
			? Math.max(0, Math.min(this.offset, Math.max(0, this.lineCount - this.pageSize)))
			: Math.max(0, this.offset);
		this.tui.requestRender();
	}

	private layout(width: number) {
		this.lastWidth = width;
		this.lastRows = this.tui.terminal.rows;
		this.lastColumns = this.tui.terminal.columns;
		const height = Math.max(1, Math.min(Math.floor(this.lastRows * 0.8), this.lastRows - 2));
		const page = this.pages[this.page]!;
		const hint = (id: Keybinding) => this.keybindings.getKeys(id)[0] ?? "unbound";
		const help = `${hint("tui.input.tab")} page · ${hint("tui.select.cancel")} close`;
		const aliases = (["j", "k"] as const).filter((key) =>
			(["tui.input.tab", "tui.select.cancel", "tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const)
				.every((id) => id === (key === "j" ? "tui.select.down" : "tui.select.up") || !this.keybindings.getKeys(id).includes(key)));
		const scrollHint = `${hint("tui.select.up")}/${hint("tui.select.down")} scroll${aliases.length ? ` · ${aliases.join("/")}` : ""}`;
		const chrome = (compact: boolean) => {
			const innerWidth = Math.max(1, width - (compact ? 0 : 4));
			const navigation = compact ? scrollHint : `${scrollHint} · ${hint("tui.select.pageUp")}/${hint("tui.select.pageDown")} page scroll`;
			const title = `${page.title} · ${this.page + 1}/${this.pages.length}`;
			const tabs = this.pages.map((item, index) => this.theme.fg(index === this.page ? "accent" : "dim", index === this.page ? `[${item.title}]` : item.title)).join("   ");
			const header = compact ? [this.theme.fg("accent", title)] : [this.theme.fg("accent", "pi-auto · status snapshot"), tabs, ""];
			const footer = [...wrapTextWithAnsi(navigation, innerWidth), ...wrapTextWithAnsi(help, innerWidth)];
			return { compact, innerWidth, header, footer };
		};
		let frame = chrome(width < 32 || height < 10);
		const overhead = () => frame.header.length + frame.footer.length + (frame.compact ? 0 : 2);
		if (!frame.compact && overhead() >= height) frame = chrome(true);
		if (overhead() >= height) {
			// Drop secondary navigation before sacrificing the close hint or all body space.
			frame.footer = wrapTextWithAnsi(`${hint("tui.select.cancel")} close`, frame.innerWidth);
			if (overhead() >= height) frame.header = [];
			frame.footer = frame.footer.slice(0, height);
		}
		const content = page.lines.flatMap(({ text, tone }) => wrapTextWithAnsi(this.theme.fg(tone ?? "text", text), frame.innerWidth));
		this.pageSize = Math.max(0, height - overhead());
		this.lineCount = content.length;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, content.length - this.pageSize)));
		return { ...frame, content };
	}

	render(width: number): string[] {
		if (width < 1) return [];
		const { compact, innerWidth, header, footer, content } = this.layout(width);
		const body = content.slice(this.offset, this.offset + this.pageSize);
		while (body.length < this.pageSize) body.push("");
		if (!compact) header[2] = this.theme.fg("dim", `Lines ${this.offset + 1}-${Math.min(this.offset + this.pageSize, content.length)} of ${content.length}`);
		const lines = [...header, ...body, ...footer.map((line) => this.theme.fg("dim", line))];
		if (compact) return lines.map((line) => truncateToWidth(line, width));
		const border = (line: string) => this.theme.fg("borderMuted", line);
		const framed = lines.map((line) => {
			const clipped = truncateToWidth(line, innerWidth);
			return `${border("│")} ${clipped}${" ".repeat(innerWidth - visibleWidth(clipped))} ${border("│")}`;
		});
		return [border(`╭${"─".repeat(width - 2)}╮`), ...framed, border(`╰${"─".repeat(width - 2)}╯`)];
	}

	invalidate(): void { /* Colors and wrapping are rebuilt on every render. */ }
}

function safeText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}
