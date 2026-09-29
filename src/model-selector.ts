import { stripVTControlCharacters } from "node:util";
import type { Api, Model, ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, fuzzyFilter, truncateToWidth, type KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { backendLabel, type SelectorBackend } from "./settings.ts";

export interface SelectorModels {
	chat: readonly Model<Api>[];
	classifier: readonly ClassifierModel<ClassifierApi>[];
}
type Item = { backend: SelectorBackend; name: string; provider: string; id: string };
const safe = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
const equal = (a: SelectorBackend, b: SelectorBackend | undefined) => a.type === b?.type && a.provider === b.provider && a.id === b.id;

export async function showModelSelector(ctx: ExtensionContext, models: SelectorModels, current: SelectorBackend | undefined) {
	// No overlay options: Pi mounts this component in the bottom editor container.
	return ctx.ui.custom<SelectorBackend | undefined>((tui, theme, kb, done) => new AutoModelSelector(models, current, tui, theme, kb, done));
}

/** Pi 0.99.1 /model layout and row format, with backend tabs instead of scopes. */
export class AutoModelSelector extends Container {
	private readonly input = new Input();
	private readonly items: Item[];
	private filtered: Item[] = [];
	private selected = 0;
	private tab: SelectorBackend["type"];
	get focused(): boolean { return this.input.focused; }
	set focused(value: boolean) { this.input.focused = value; }

	constructor(models: SelectorModels, private readonly current: SelectorBackend | undefined,
		private readonly tui: TUI, private readonly theme: Theme, private readonly kb: KeybindingsManager,
		private readonly done: (backend: SelectorBackend | undefined) => void) {
		super();
		this.tab = current?.type ?? "chat";
		this.items = (["chat", "classifier"] as const).flatMap((type) => models[type].map((model) => ({
			backend: { type, provider: model.provider, id: model.id }, name: safe(model.name), provider: safe(model.provider), id: safe(model.id),
		}))).sort((a, b) => Number(equal(b.backend, current)) - Number(equal(a.backend, current)) || a.provider.localeCompare(b.provider));
		this.filter();
	}

	private filter(): void {
		const active = this.items.filter((item) => item.backend.type === this.tab);
		const query = this.input.getValue();
		// Match native /model's provider-prefixed fuzzy-search ranking.
		this.filtered = query ? fuzzyFilter(active, query, (item) => `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id} ${item.name}`) : active;
		this.selected = query ? 0 : Math.max(0, this.filtered.findIndex((item) => equal(item.backend, this.current)));
	}

	handleInput(data: string): void {
		if (this.kb.matches(data, "tui.input.tab")) {
			this.tab = this.tab === "chat" ? "classifier" : "chat";
			this.filter();
		} else if (this.kb.matches(data, "tui.select.cancel")) { this.done(undefined); return; }
		else if (this.kb.matches(data, "tui.select.confirm")) {
			const item = this.filtered[this.selected];
			if (item) this.done(item.backend);
			return;
		} else if (this.kb.matches(data, "tui.select.up")) this.selected = (this.selected + this.filtered.length - 1) % Math.max(1, this.filtered.length);
		else if (this.kb.matches(data, "tui.select.down")) this.selected = (this.selected + 1) % Math.max(1, this.filtered.length);
		else { this.input.handleInput(data); this.filter(); }
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 1) return [];
		this.clear();
		const fg = (color: Parameters<Theme["fg"]>[0], text: string) => this.theme.fg(color, text);
		this.addChild(new DynamicBorder((text) => fg("border", text)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(fg(this.tab === "chat" ? "accent" : "muted", "chat model") + fg("muted", " | ") + fg(this.tab === "classifier" ? "accent" : "muted", "system one"), 0, 0));
		this.addChild(new Text(fg("dim", "Chooses effort; does not change your answering model."), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		const start = Math.max(0, Math.min(this.selected - 5, this.filtered.length - 10));
		for (const [offset, item] of this.filtered.slice(start, start + 10).entries()) {
			const active = start + offset === this.selected;
			const cursor = active ? fg("accent", "→ ") : "  ";
			const marker = equal(item.backend, this.current) ? fg("accent", "✓ ") : "  ";
			const id = active ? fg("accent", item.id) : item.id;
			// Native /model uses fixed cursor/marker columns, then ID and muted provider.
			this.addChild(new Text(truncateToWidth(`${cursor}${marker}${id} ${fg("muted", `[${item.provider}]`)}`, width), 0, 0));
		}
		if (this.filtered.length > 10) this.addChild(new Text(fg("muted", `  (${this.selected + 1}/${this.filtered.length})`), 0, 0));
		const selected = this.filtered[this.selected];
		if (selected) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(fg("muted", `  Model Name: ${selected.name}`), 0, 0));
		} else this.addChild(new Text(fg("muted", "  No matching models. Use /login to configure providers."), 0, 0));
		if (!this.current) this.addChild(new Text(fg("warning", "No selector saved. Choose a model and press Enter."), 0, 0));
		else if (!this.items.some((item) => equal(item.backend, this.current)))
			this.addChild(new Text(fg("warning", `Saved selector unavailable: ${safe(backendLabel(this.current))}`), 0, 0));
		this.addChild(new Spacer(1));
		const hint = (id: Parameters<KeybindingsManager["getKeys"]>[0]) => this.kb.getKeys(id).join("/") || "unbound";
		this.addChild(new Text(fg("dim", `${hint("tui.input.tab")} switch tab · ${hint("tui.select.up")}/${hint("tui.select.down")} navigate · ${hint("tui.select.confirm")} save · ${hint("tui.select.cancel")} cancel`), 0, 0));
		this.addChild(new DynamicBorder((text) => fg("border", text)));
		return super.render(width).map((line) => truncateToWidth(line, width));
	}
}
