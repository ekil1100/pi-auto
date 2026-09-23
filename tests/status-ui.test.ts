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
			context: {
				strategy: "recent-turn", omitted: true, characters: 3_000, elapsedMs: 0.2,
				sources: [
					{ entryId: "user-source", role: "user", start: 0, end: 900 },
					{ entryId: "reply-source", role: "assistant", start: 0, end: 2_100 },
				],
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

	it("shows recent-turn source ranges, omissions, characters and local elapsed time", () => {
		const context = text(status(), 1);
		for (const value of ["Context: recent-turn", "1. user", "2. assistant", "Source: user-source",
			"Source: reply-source", "Range: 0-2100", "2 messages retained · omitted: yes",
			"History: 3000 UTF-16 units", "Local elapsed: 0.2ms", "[start, end)", "message text is not displayed"]) {
			expect(context).toContain(value);
		}
		expect(context).not.toMatch(/Candidate|classification|rating|packed|background|required/);
	});

	it.each([true, false])("uses the recorded omitted flag (%j) rather than inferring it from source counts", (omitted) => {
		const last = decision();
		last.routing!.context!.omitted = omitted;
		expect(text(status(last), 1)).toContain(`2 messages retained · omitted: ${omitted ? "yes" : "no"}`);
	});

	it("distinguishes empty recorded context from missing diagnostics", () => {
		const last = decision();
		Object.assign(last.routing!.context!, { sources: [], characters: 0, omitted: false, elapsedMs: 0 });
		const page = text(status(last), 1);
		expect(page).toContain("0 messages retained · omitted: no");
		expect(page).toContain("No messages retained.");
		expect(page).toContain("Local elapsed: 0ms");
		expect(page).not.toContain("No context diagnostics recorded.");
	});

	it("keeps the outcome reason visible for unsuccessful selections", () => {
		const last = decision();
		last.status = "kept";
		last.reason = "Selector request failed";
		const overview = buildStatusPages(status(last))[0]!;
		expect(overview.lines.find(({ text }) => text.startsWith("Reason:"))).toEqual({ text: "Reason: Selector request failed", tone: "warning" });
	});

	it("does not infer recent-turn context from deprecated classification diagnostics", () => {
		const last = decision();
		delete last.routing!.context;
		Object.assign(last.routing!, { compaction: { status: "extracted", sources: [{ entryId: "old-source" }], ratings: [] } });
		Object.assign(last, { contextTiming: { totalMs: 120 }, contextDecisions: [{ id: "old-candidate" }] });
		const restored = readDecision({ type: "custom", customType: DECISION_ENTRY_TYPE, id: "decision", parentId: null, timestamp: "2026-01-01", data: last });
		expect(restored).toMatchObject({ status: "selected", effort: "high" });
		const pages = buildStatusPages(status(restored));
		expect(pages[1]!.lines).toEqual([{ text: "No context diagnostics recorded.", tone: "dim" }]);
		expect(JSON.stringify(pages)).not.toMatch(/old-source|old-candidate|120ms|classification/);
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
		expect(text(state, 2)).not.toMatch(/Confidence:|0 input|Local context:/);
	});

	it("keeps complete probabilities and usage accessible without success-rate claims", () => {
		const last = decision();
		last.jevTiming = { outputTokens: 1 }; // Unknown input is not zero.

		const page = text(status(last), 2);
		for (const value of ["low: 0.1", "high: 0.8", "not task success probability", "not included in Pi footer", "unknown input / 1 output"]) expect(page).toContain(value);
	});

	it("shows current-model response metadata and explains missing raw logs", () => {
		const last = decision();
		last.routerModel = "test/current";
		last.status = "kept";
		last.reason = "Router returned an invalid or unsupported effort (not_json_object)";
		last.selectorResponses = { effort: { stopReason: "stop", textCharacters: 19, contentTypes: ["text"] } };
		const page = text(status(last), 2);
		expect(page).toContain("Stop reason: stop");
		expect(page).toContain("Response text: 19 UTF-16 units");
		expect(page).toContain("Content types: text");
		expect(page).toContain("PI_AUTO_DEBUG=1");
	});

	it("shows per-attempt deadlines and interruption sources after fallback", () => {
		const last = decision();
		last.selectorAttempts = [
			{ backend: "jev", outcome: "failed", interruption: "deadline", timeoutMs: 10_000, elapsedMs: 10_000, reason: "router timed out" },
			{ backend: "current-model", outcome: "failed", interruption: "provider", timeoutMs: 10_000, elapsedMs: 12, reason: "router provider aborted the request" },
		];
		const page = text(status(last), 2);
		for (const value of ["1. jev: failed", "2. current-model: failed", "Interruption source: deadline", "Interruption source: provider", "Elapsed: 12ms | Deadline: 10000ms"]) expect(page).toContain(value);
	});

	it("locates opt-in raw logs without displaying private response text", () => {
		const last = decision();
		last.selectorResponses = { effort: { stopReason: "stop", contentTypes: ["text"], textCharacters: 14, rawText: "private-output", rawTextTruncated: false } };
		const page = text(status(last), 2);
		expect(page).toContain("Raw response saved: 14 UTF-16 units | truncated: no");
		expect(page).toContain("selectorResponses.effort.rawText");
		expect(page).not.toContain("private-output");
	});

	it("validates attempt traces when restoring a saved decision", () => {
		const last = decision();
		const attempt = { backend: "current-model" as const, outcome: "cancelled" as const, interruption: "escape" as const, timeoutMs: 10_000, elapsedMs: 4 };
		last.selectorAttempts = [attempt];
		const entry = { type: "custom" as const, customType: DECISION_ENTRY_TYPE, id: "decision", parentId: null, timestamp: "2026-01-01", data: last };
		expect(readDecision(JSON.parse(JSON.stringify(entry)))).toEqual(last);
		for (const attempts of [null, {}, [attempt, attempt, attempt], [{ ...attempt, backend: "unknown" }], [{ ...attempt, interruption: "unknown" }], [{ ...attempt, timeoutMs: -1 }], [{ ...attempt, elapsedMs: NaN }]]) {
			const bad = structuredClone(entry);
			Object.assign(bad.data, { selectorAttempts: attempts });
			expect(readDecision(bad)).toBeUndefined();
		}
	});

	it("round trips bounded metadata without storing message text or dependencies", () => {
		const last = decision();
		const entry = { type: "custom" as const, customType: DECISION_ENTRY_TYPE, id: "decision", parentId: null, timestamp: "2026-01-01", data: last };
		expect(readDecision(JSON.parse(JSON.stringify(entry)))).toEqual(last);
		const source = last.routing!.context!.sources[0]!;
		for (const sources of [null, {}, Array(3).fill(source), [{ ...source, end: -1 }], [{ ...source, entryId: 42 }], [{ ...source, text: "private" }], [{ ...source, requires: [] }]]) {
			const bad = structuredClone(entry);
			Object.assign(bad.data.routing!.context!, { sources });
			expect(readDecision(bad)).toBeUndefined();
		}
	});

	it("removes terminal control sequences from all externally supplied fields", () => {
		const state = status();
		state.model = "test/\x1b[31mmodel\x1b[0m\x07";
		state.last!.routing!.context!.sources[0]!.entryId = "entry\x1b]52;c;private\x07\nspoof";
		state.last!.reason = "reason\r\nother line";
		const pages = buildStatusPages(state);
		for (const page of pages) for (const line of page.lines) expect(line.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
		expect(JSON.stringify(pages)).not.toContain("private");
	});
});

describe("status floating viewport", () => {
	it("switches three tabs, scrolls to all sources, and closes via the injected keybinding", () => {
		const view = panel();
		expect(view.render().join("\n")).toContain("[Overview]");
		view.component.handleInput("\t");
		expect(view.render().join("\n")).toContain("[Context]");
		const seen: string[] = [];
		for (let index = 0; index < 50; index++) {
			seen.push(...view.render());
			view.component.handleInput("\x1b[B");
		}
		expect(seen.join("\n")).toContain("Source: reply-source");
		expect(seen.join("\n")).toContain("Range: 0-2100");
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
		expect(bottom).toContain("Source: reply-source");
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
		expect(view.render().join("\n")).not.toContain("Context: recent-turn");
		view.component.handleInput("\x1b");
		expect(view.done).not.toHaveBeenCalled();
		view.component.handleInput("\x11");
		expect(view.done).toHaveBeenCalledOnce();
	});

	it.each([[96, 40], [60, 24], [32, 18], [24, 12], [12, 6], [1, 3]])("fits %i columns / %i rows including wide text and long IDs", (width, rows) => {
		const state = status();
		state.last!.reason = "中文👨‍👩‍👧‍👦 full-width text ".repeat(8);
		state.last!.routing!.context!.sources[0]!.entryId = "long-source-id-".repeat(20);
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
		const context = state.last!.routing!.context!;
		context.sources[0]!.entryId = "long-user-source-".repeat(100);
		context.sources[1]!.entryId = "long-assistant-source-".repeat(100);
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
		expect(page).toContain("2 messages retained");
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
		expect(wide.map(stripVTControlCharacters).join("\n")).toContain("Context: recent-turn");
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
