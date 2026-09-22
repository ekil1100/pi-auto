import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, readDecision, type EffortDecision } from "../src/selection-ui.ts";
import { AutoStatusPanel, buildStatusPages, showAutoStatus, type AutoStatus } from "../src/status-ui.ts";

function decision(): EffortDecision {
	return {
		status: "selected", model: "test/previous", previousEffort: "medium", effort: "high",
		routerModel: "typesafe/jev", routerEffort: undefined, reason: "Selected by Jev Choice", elapsedMs: 320,
		routerConfidence: 0.8, routerProbabilities: { low: 0.1, medium: 0.1, high: 0.8 },
		routing: {
			policyVersion: "1", supportedEfforts: ["low", "medium", "high"], taskTruncated: false, selectionMs: 200,
			compaction: {
				status: "extracted", candidateCount: 3, candidateCharacters: 9_000, selectedCount: 2, selectedCharacters: 3_000,
				candidatesTruncated: false, elapsedMs: 120,
				candidateSources: [
					{ id: "c0:0:900", entryId: "user-source", role: "user", start: 0, end: 900 },
					{ id: "c1:0:2100", entryId: "reply-source", role: "assistant", start: 0, end: 2_100 },
					{ id: "c2:0:5000", entryId: "oversize-source", role: "user", start: 0, end: 5_000 },
				],
				sources: [
					{ entryId: "user-source", role: "user", start: 0, end: 900 },
					{ entryId: "reply-source", role: "assistant", start: 0, end: 2_100 },
				],
				ratings: [{ id: "c0:0:900", importance: "background" }, { id: "c1:0:2100", importance: "required" }, { id: "c2:0:5000", importance: "useful" }],
			},
		},
	};
}

function status(last: EffortDecision | undefined = decision()): AutoStatus {
	return { enabled: true, model: "test/current", effort: "low", backend: "current model", supportedEfforts: ["off", "low", "high"], ...(last ? { last } : {}) };
}

function text(state: AutoStatus, page: number): string {
	return buildStatusPages(state)[page]!.lines.map(({ text }) => text).join("\n");
}

function panel(state = status(), rows = 24, keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
	const terminal = { rows, columns: 100 };
	const tui = { terminal, requestRender: vi.fn() };
	const theme = { fg: vi.fn((_color: string, value: string) => value) };
	const done = vi.fn();
	const component = new AutoStatusPanel(buildStatusPages(state), tui as unknown as TUI, theme as unknown as Theme, keybindings, done);
	return { component, terminal, theme, done, tui, render: (width = 90) => component.render(width).map(stripVTControlCharacters) };
}

describe("status information hierarchy", () => {
	it("separates current settings from the previous selection and hides technical detail on overview", () => {
		const overview = text(status(), 0);
		expect(overview).toContain("Current (at open)\nAuto: enabled");
		expect(overview).toContain("Current model: test/current\nCurrent effort: low");
		expect(overview).toContain("Last selection\nEffort: medium -> high | selected | 0.32s");
		expect(overview).toContain("Model: test/previous");
		expect(overview).not.toMatch(/Confidence|Policy|socket|Candidate:/);
	});

	it("distinguishes classification from retention and exposes complete source metadata", () => {
		const context = text(status(), 1);
		expect(context).toContain("1. user | background | retained");
		expect(context).toContain("2. assistant | required | retained");
		expect(context).toContain("3. user | useful | not retained");
		expect(context).toContain("Source: oversize-source\n   Range: 0-5000 | Candidate: c2:0:5000");
		expect(context).toContain("Candidate pool incomplete: no");
		expect(context).toContain("omitted: yes");
		expect(context).not.toContain("budget exceeded"); // No inferred per-candidate explanations.
	});

	it("marks bypassed history as unclassified and distinguishes pool omissions", () => {
		const last = decision();
		const context = last.routing!.compaction!;
		context.status = "bypassed";
		context.ratings = [];
		context.candidatesTruncated = true;
		expect(text(status(last), 1)).toContain("user | not classified | retained");
		expect(text(status(last), 1)).toContain("Candidate pool incomplete: yes");
	});

	it.each(["failed", "extracting"] as const)("does not invent rejection decisions for %s packing", (phase) => {
		const last = decision();
		last.status = "kept";
		last.reason = "required_context_exceeds_budget";
		const context = last.routing!.compaction!;
		context.status = phase;
		context.sources = [];
		context.selectedCount = 0;
		context.selectedCharacters = 0;
		const page = text(status(last), 1);
		expect(page).toContain(`${phase} · no packed context`);
		expect(page).toContain("required | not packed");
		expect(page).not.toContain("not retained");
		const overview = buildStatusPages(status(last))[0]!;
		expect(overview.lines.find(({ text }) => text.startsWith("Reason:"))?.tone).toBe("warning");
	});

	it("preserves legacy source and rating visibility without inventing their association", () => {
		const last = decision();
		delete last.routing!.compaction!.candidateSources;
		const page = text(status(last), 1);
		expect(page).toContain("Candidate/source mapping was not recorded.");
		expect(page).toContain("Retained: user | user-source | 0-900");
		expect(page).toContain("Candidate c0:0:900: background | retention unknown");
	});

	it("renders empty and legacy states without fabricating metrics", () => {
		const state = status();
		delete state.last;
		expect(text(state, 0)).toContain("No selection recorded for this branch.");
		expect(text(state, 1)).toContain("No context diagnostics recorded.");
		expect(text(state, 2)).toContain("No selection diagnostics recorded.");
		state.last = decision();
		delete state.last.routing;
		delete state.last.routerConfidence;
		delete state.last.routerProbabilities;
		expect(text(state, 2)).toContain("Policy metadata not recorded.");
		expect(text(state, 2)).toContain("Usage not recorded.");
		expect(text(state, 2)).not.toMatch(/Confidence:|0 input|Context stage:/);
	});

	it("keeps complete probabilities and usage accessible without success-rate claims", () => {
		const last = decision();
		last.jevTiming = { outputTokens: 1 }; // Unknown input is not zero.
		last.contextDecisions = [{ id: "c0:0:900", importance: "background", confidence: 0.7,
			probabilities: { required: 0.1, useful: 0.1, background: 0.7, irrelevant: 0.1 } }];
		const page = text(status(last), 2);
		for (const value of ["low: 0.1", "high: 0.8", "background: 0.7", "confidence 0.7", "not task success probability", "not included in Pi footer", "unknown input / 1 output"]) expect(page).toContain(value);
	});

	it("round trips bounded metadata without storing candidate text or dependencies", () => {
		const last = decision();
		const entry = { type: "custom" as const, customType: DECISION_ENTRY_TYPE, id: "decision", parentId: null, timestamp: "2026-01-01", data: last };
		expect(readDecision(JSON.parse(JSON.stringify(entry)))).toEqual(last);
		const source = last.routing!.compaction!.candidateSources![0]!;
		for (const candidateSources of [null, {}, Array(33).fill(source), [{ ...source, end: -1 }], [{ ...source, id: 42 }], [{ ...source, text: "private" }], [{ ...source, requires: [] }]]) {
			const bad = structuredClone(entry);
			Object.assign(bad.data.routing!.compaction!, { candidateSources });
			expect(readDecision(bad)).toBeUndefined();
		}
	});

	it("removes terminal control sequences from all externally supplied fields", () => {
		const state = status();
		state.model = "test/\x1b[31mmodel\x1b[0m\x07";
		state.last!.routing!.compaction!.candidateSources![0]!.entryId = "entry\x1b]52;c;private\x07\nspoof";
		state.last!.reason = "reason\r\nother line";
		const pages = buildStatusPages(state);
		for (const page of pages) for (const line of page.lines) expect(line.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(JSON.stringify(pages)).not.toContain("private");
	});
});

describe("status floating viewport", () => {
	it("switches three tabs, scrolls to all candidates, and closes via the injected keybinding", () => {
		const view = panel();
		expect(view.render().join("\n")).toContain("[Overview]");
		view.component.handleInput("\t");
		expect(view.render().join("\n")).toContain("[Context]");
		const seen: string[] = [];
		for (let index = 0; index < 50; index++) {
			seen.push(...view.render());
			view.component.handleInput("\x1b[B");
		}
		expect(seen.join("\n")).toContain("Source: oversize-source");
		expect(seen.join("\n")).toContain("Candidate: c2:0:5000");
		view.component.handleInput("\t");
		expect(view.render().join("\n")).toContain("[Diagnostics]");
		view.component.handleInput("\t");
		expect(view.render().join("\n")).toContain("Current (at open)");
		view.component.handleInput("\x1b");
		expect(view.done).toHaveBeenCalledOnce();
		expect(view.tui.requestRender).toHaveBeenCalled();
	});

	it.each([["j", "k"], ["\x1b[106u", "\x1b[107u"]])("scrolls down/up with %j and %j without passing the viewport bounds", (down, up) => {
		const view = panel();
		view.component.handleInput("\t");
		const top = view.render().join("\n");
		expect(top).toContain("j/k");
		view.component.handleInput(up);
		expect(view.render().join("\n")).toBe(top);
		view.component.handleInput(down);
		expect(view.render().join("\n")).toContain("Lines 2-");
		view.component.handleInput(up);
		expect(view.render().join("\n")).toBe(top);
		for (let index = 0; index < 100; index++) view.component.handleInput(down);
		const bottom = view.render().join("\n");
		expect(bottom).toContain("Source: oversize-source");
		view.component.handleInput(down);
		expect(view.render().join("\n")).toBe(bottom);
		view.component.handleInput(up);
		expect(view.render().join("\n")).not.toBe(bottom);
	});

	it("gives explicit bindings precedence over Vim aliases and omits conflicting hints", () => {
		const bindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.cancel": "j", "tui.input.tab": "k" });
		const view = panel(status(), 24, bindings);
		expect(view.render().join("\n")).not.toContain("j/k");
		view.component.handleInput("k");
		expect(view.render().join("\n")).toContain("[Context]");
		view.component.handleInput("j");
		expect(view.done).toHaveBeenCalledOnce();
	});

	it("honors customized navigation and advertises the actual keys", () => {
		const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.tab": "ctrl+n", "tui.select.cancel": "ctrl+q", "tui.select.down": "j", "tui.select.pageDown": "f",
		});
		const view = panel(status(), 24, bindings);
		expect(view.render().join("\n")).toContain("ctrl+n page · ctrl+q close");
		view.component.handleInput("\t");
		expect(view.render().join("\n")).toContain("[Overview]");
		view.component.handleInput("\x0e");
		expect(view.render().join("\n")).toContain("[Context]");
		view.component.handleInput("f");
		expect(view.render().join("\n")).not.toContain("Context: extracted");
		view.component.handleInput("\x1b");
		expect(view.done).not.toHaveBeenCalled();
		view.component.handleInput("\x11");
		expect(view.done).toHaveBeenCalledOnce();
	});

	it.each([[96, 40], [60, 24], [32, 18], [24, 12], [12, 6], [1, 3]])("fits %i columns / %i rows including wide text and long IDs", (width, rows) => {
		const state = status();
		state.last!.reason = "中文👨‍👩‍👧‍👦 full-width text ".repeat(8);
		state.last!.routing!.compaction!.candidateSources![0]!.entryId = "long-source-id-".repeat(20);
		const view = panel(state, rows);
		for (let page = 0; page < 3; page++) {
			const lines = view.render(width);
			expect(lines.length).toBeLessThanOrEqual(Math.max(1, Math.min(Math.floor(rows * 0.8), rows - 2)));
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			view.component.handleInput("\t");
		}
	});

	it.each([[32, 13], [36, 13], [24, 8], [32, 6]])("keeps the full custom close hint within %i columns / %i rows", (width, rows) => {
		const bindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": "ctrl+up", "tui.select.down": "ctrl+down",
			"tui.select.pageUp": "ctrl+pageUp", "tui.select.pageDown": "ctrl+pageDown",
			"tui.input.tab": "ctrl+shift+n", "tui.select.cancel": "ctrl+shift+q",
		});
		const view = panel(status(), rows, bindings);
		const height = Math.max(1, Math.min(Math.floor(rows * 0.8), rows - 2));
		for (let page = 0; page < 3; page++) {
			const lines = view.render(width);
			expect(lines.length).toBeLessThanOrEqual(height);
			expect(lines.join(" ").replace(/\s+/g, " ")).toContain("ctrl+shift+q close");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			view.component.handleInput("\x1b[78;6u");
		}
		view.component.handleInput("\x1b[81;6u");
		expect(view.done).toHaveBeenCalledOnce();
	});

	it.each([
		["j"], ["\x1b[B"], ["\x1b[6~"], ["j", "j", "k"],
		["\x1b[6~", "\x1b[5~"], ["\t", "j"],
	])("preserves input after switching pages without an intervening paint: %j", (...keys) => {
		const state = status();
		const context = state.last!.routing!.compaction!;
		context.candidateSources = Array.from({ length: 32 }, (_, index) => ({
			id: `c${index}:0:100`, entryId: `source-${index}`, role: "user", start: 0, end: 100,
		}));
		context.candidateCount = 32;
		context.ratings = [];
		context.sources = [];
		context.selectedCount = 0;
		context.selectedCharacters = 0;
		const queued = panel(state, 40);
		const repainted = panel(state, 40);
		queued.render(96);
		repainted.render(96);
		for (const key of ["\t", ...keys]) {
			queued.component.handleInput(key);
			repainted.component.handleInput(key);
			repainted.render(96);
		}
		expect(queued.render(96)).toEqual(repainted.render(96));
	});

	it.each(["j", "\x1b[B", "\x1b[6~"])("preserves scrolling after terminal shrink before repaint: %j", (key) => {
		const state = status();
		delete state.last;
		const queued = panel(state, 40);
		const repainted = panel(state, 40);
		queued.render(96);
		repainted.render(96);
		queued.terminal.rows = 12;
		repainted.terminal.rows = 12;
		repainted.render(96);
		queued.component.handleInput(key);
		repainted.component.handleInput(key);
		expect(queued.render(96)).toEqual(repainted.render(96));
	});

	it.each(["j", "\x1b[B", "\x1b[6~"])("preserves scrolling after terminal width shrink before repaint: %j", (key) => {
		const state = status();
		const queued = panel(state, 24);
		const repainted = panel(state, 24);
		queued.render(96);
		repainted.render(96);
		queued.terminal.columns = 26;
		repainted.terminal.columns = 26;
		repainted.render(24);
		queued.component.handleInput(key);
		repainted.component.handleInput(key);
		expect(queued.render(24)).toEqual(repainted.render(24));
	});

	it("refreshes the width after expanding a previously narrow viewport before paging", () => {
		const state = status();
		const queued = panel(state, 12);
		const repainted = panel(state, 12);
		for (const view of [queued, repainted]) {
			view.terminal.columns = 26;
			view.render(24);
			view.terminal.columns = 100;
		}
		repainted.render(96);
		queued.component.handleInput("\x1b[6~");
		repainted.component.handleInput("\x1b[6~");
		expect(queued.render(96)).toEqual(repainted.render(96));
	});

	it("keeps all overview essentials visible at standard terminal height", () => {
		const state = status();
		state.model = state.last!.model;
		const view = panel(state, 24);
		const page = view.render(60).join("\n");
		expect(page).toContain("Current effort: low");
		expect(page).toContain("medium -> high | selected | 0.32s");
		expect(page).toContain("2 of 3 blocks retained");
	});

	it("shows scrolling and closing hints in a narrow viewport", () => {
		const view = panel(status(), 12);
		view.component.handleInput("\t");
		const page = view.render(24).join("\n");
		expect(page).toContain("Context · 2/3");
		expect(page).toContain("up/down scroll · j/k");
		expect(page).toContain("tab page · escape close");
	});

	it("reflows on resize and rebuilds theme colors on invalidation", () => {
		const view = panel();
		view.component.handleInput("\t");
		view.render();
		for (let index = 0; index < 30; index++) view.component.handleInput("\x1b[B");
		view.terminal.rows = 12;
		const small = view.render(24);
		expect(small.length).toBeLessThanOrEqual(9);
		view.terminal.rows = 60;
		view.theme.fg.mockImplementation((_tone, value) => `\x1b[32m${value}\x1b[0m`);
		view.component.invalidate();
		const wide = view.component.render(96);
		expect(wide.join("\n")).toContain("\x1b[32m");
		expect(wide.map(stripVTControlCharacters).join("\n")).toContain("Context: extracted");
	});

	it.each(["rpc", "print", "json"] as const)("does not instantiate a terminal component in %s mode", async (mode) => {
		const ctx = { mode, model: {}, ui: { custom: vi.fn(), notify: vi.fn() } };
		await showAutoStatus(ctx as unknown as ExtensionContext, status());
		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Overview\n"), "info");
		expect(ctx.ui.notify.mock.lastCall?.[0]).toContain("Source: user-source");
	});

	it("opens a snapshot and lets the host close and restore focus via done", async () => {
		const state = status();
		const view = panel();
		let component: AutoStatusPanel | undefined;
		const custom = vi.fn((factory) => new Promise<void>((resolve) => {
			component = factory(view.tui, view.theme, new KeybindingsManager(TUI_KEYBINDINGS), resolve);
		}));
		const pending = showAutoStatus({ mode: "tui", ui: { custom } } as unknown as ExtensionContext, state);
		expect(custom).toHaveBeenCalledWith(expect.any(Function), { overlay: true, overlayOptions: { width: 96, maxHeight: "80%", margin: 1 } });
		state.effort = "max";
		expect(component!.render(90).join("\n")).toContain("Current effort: low");
		component!.handleInput("\x1b");
		await expect(pending).resolves.toBeUndefined();
	});
});
