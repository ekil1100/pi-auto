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
	const context = last?.routing?.context;
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
		contextLines.push(row(`Context: ${context.strategy}`, "accent"), row(formatContextSummary(context)),
			row(`History: ${context.characters} UTF-16 units`), row(`Local elapsed: ${context.elapsedMs}ms`),
			row("Ranges are [start, end) in newline-joined message text.", "dim"),
			row("Source metadata only; message text is not displayed.", "dim"));
		contextLines.push(...section("Sources (conversation order)"));
		if (!context.sources.length) contextLines.push(row("No messages retained.", "dim"));
		for (const [index, source] of context.sources.entries()) {
			contextLines.push(row(`${index + 1}. ${source.role}`), row(`   Source: ${source.entryId}`),
				row(`   Range: ${source.start}-${source.end}`), row(""));
		}
	}

	const diagnostics: StatusLine[] = [row("Current capabilities", "accent"), row(`Supported efforts: ${state.supportedEfforts.join(", ") || "none"}`)];
	if (!last) diagnostics.push(row("No selection diagnostics recorded.", "dim"));
	else {
		diagnostics.push(...section("Selection attempts"));
		if (!last.selectorAttempts?.length) diagnostics.push(row("Attempt trace not recorded.", "dim"));
		for (const [index, attempt] of (last.selectorAttempts ?? []).entries()) {
			diagnostics.push(row(`${index + 1}. ${attempt.backend}: ${attempt.outcome}`),
				row(`Elapsed: ${attempt.elapsedMs}ms | Deadline: ${attempt.timeoutMs}ms`));
			if (attempt.interruption) diagnostics.push(row(`Interruption source: ${attempt.interruption}`, "warning"));
			if (attempt.reason) diagnostics.push(row(`Detail: ${attempt.reason}`));
		}
		if (last.jevDiagnostics || last.jevTiming) {
			diagnostics.push(...section("Jev response"));
			const jev = last.jevDiagnostics;
			if (!jev) diagnostics.push(row("Jev response diagnostics not recorded.", "dim"));
			else {
				diagnostics.push(row(`Stage: ${jev.stage}`));
				if (jev.errorCode) diagnostics.push(row(`Error code: ${jev.errorCode}`, "warning"));
				if (jev.responseType !== undefined) {
					diagnostics.push(row(`Decoded type: ${jev.responseType}`), row(`Response text: ${jev.responseCharacters} UTF-16 units`));
					if (jev.rawText !== undefined) diagnostics.push(row(`Response capture saved: ${jev.rawText.length} UTF-16 units | truncated: ${jev.rawTextTruncated ? "yes" : "no"}`),
						row("Read jevDiagnostics.rawText in the session JSONL pi-auto-decision entry. Decoded JSON/text may contain sensitive data.", "warning"));
					else diagnostics.push(row("Response body not captured. Restart with PI_AUTO_DEBUG=1 to capture future successful HTTP response bodies.", "dim"));
				} else diagnostics.push(row("No decoded successful response recorded. HTTP error bodies are never saved.", "dim"));
			}
		}
		diagnostics.push(...section("Current-model response"));
		const response = last.selectorResponses?.effort;
		if (response) {
			diagnostics.push(row(`Stop reason: ${response.stopReason}`), row(`Content types: ${response.contentTypes.join(", ") || "none"}`),
				row(`Response text: ${response.textCharacters} UTF-16 units`));
			if (response.rawText !== undefined) diagnostics.push(row(`Raw response saved: ${response.rawText.length} UTF-16 units | truncated: ${response.rawTextTruncated ? "yes" : "no"}`),
				row("Read selectorResponses.effort.rawText in the session JSONL pi-auto-decision entry. It may contain sensitive text.", "warning"));
			else diagnostics.push(row("Raw response not captured. Restart with PI_AUTO_DEBUG=1 to capture future responses.", "dim"));
		} else diagnostics.push(row("No current-model response recorded (not called, no response before interruption, or older record).", "dim"));
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
		if (context?.elapsedMs !== undefined) diagnostics.push(row(`Local context: ${context.elapsedMs}ms`));
		if (last.routing?.selectionMs !== undefined) diagnostics.push(row(`Selection: ${last.routing.selectionMs}ms`));
		const timing = last.jevTiming;
		if (timing) {
			diagnostics.push(...section("Effort request"), ...formatJevTiming(timing).split(" · ").filter(Boolean).map((text) => row(text)));
			if (timing.requestBytes !== undefined) diagnostics.push(row(`Request bytes: ${timing.requestBytes}`));
			if (timing.httpStatus !== undefined) diagnostics.push(row(`HTTP status: ${timing.httpStatus}`));
			if (timing.transport) diagnostics.push(row(`Observed requests: ${timing.transport.requestCount}`));
		}
		diagnostics.push(...section("Usage"), row("Extra selector calls are not included in Pi footer totals.", "dim"));
		let hasUsage = false;
		if (timing?.inputTokens !== undefined || timing?.outputTokens !== undefined) {
			hasUsage = true;
			diagnostics.push(row(`Effort usage: ${timing.inputTokens ?? "unknown"} input / ${timing.outputTokens ?? "unknown"} output tokens`));
		}
		const usage = last.selectorUsage?.effort;
		if (usage) {
			hasUsage = true;
			diagnostics.push(row(`effort: ${usage.input} input / ${usage.output} output tokens`),
				row(`Cache: ${usage.cacheRead} read / ${usage.cacheWrite} write | Cost: $${usage.cost}`));
		}
		if (!hasUsage) diagnostics.push(row("Usage not recorded.", "dim"));
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
