import { stripVTControlCharacters } from "node:util";
import type { Api, Model, ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme, KeybindingsManager as AppKeybindings } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AutoModelSelector, showModelSelector, type SelectorModels } from "../src/model-selector.ts";
import type { SelectorBackend } from "../src/settings.ts";

const model = (provider: string, id: string, name = id): ClassifierModel<ClassifierApi> => ({
	type: "classifier", provider, id, name, api: "typesafe-system-one", baseUrl: "https://example.test", input: ["text"],
	contextWindow: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const chat = (provider: string, id: string, name = id): Model<Api> => ({
	...model(provider, id, name), type: "chat", api: "openai-responses", reasoning: true, maxTokens: 2048,
});
const models: SelectorModels = {
	chat: [chat("openai", "gpt-test", "GPT Test"), chat("custom", "chat-v2", "Task chat")],
	classifier: [model("typesafe", "jev-latest", "Jev"), model("custom", "selector-v2", "Task classifier")],
};
const saved: SelectorBackend = { type: "chat", provider: "openai", id: "gpt-test" };
function harness(current: SelectorBackend | undefined = saved, items = models, kb = new KeybindingsManager(TUI_KEYBINDINGS)) {
	const done = vi.fn();
	const tui = { requestRender: vi.fn() } as unknown as TUI;
	const fg = vi.fn((_color: string, text: string) => text);
	const theme = { fg } as unknown as Theme;
	const component = new AutoModelSelector(items, current, tui, theme, kb, done);
	return { component, done, tui, theme, fg, kb, render: (width = 90) => component.render(width).map(stripVTControlCharacters).join("\n") };
}

describe("bottom-area two-tab model selector", () => {
	it("mounts with native custom UI and no overlay options", async () => {
		const h = harness();
		const custom = vi.fn<ExtensionContext["ui"]["custom"]>().mockImplementation(async (factory) => {
			const component = await factory(h.tui, h.theme, h.kb as AppKeybindings, vi.fn());
			expect(component).toBeInstanceOf(AutoModelSelector);
			component.handleInput?.("\u001b");
			return undefined as never;
		});
		await showModelSelector({ ui: { custom } } as unknown as ExtensionContext, models, saved);
		expect(custom.mock.calls[0]).toHaveLength(1);
	});

	it("uses native ID/provider rows, fixed marker columns and a separate selected name", () => {
		const h = harness();
		const text = h.render();
		expect(text).toContain("chat model | system one");
		expect(text).toContain("→ ✓ gpt-test [openai]");
		expect(text).toContain("    chat-v2 [custom]");
		expect(text).toContain("Model Name: GPT Test");
		expect(text).not.toMatch(/Current chat model|Jev|Task chat/);
		expect(h.fg).toHaveBeenCalledWith("accent", "chat model");
		expect(h.fg).toHaveBeenCalledWith("muted", "system one");
		expect(h.fg).toHaveBeenCalledWith("muted", "[openai]");
	});

	it("opens the saved classifier tab and uses Tab to switch without saving", () => {
		const h = harness({ type: "classifier", provider: "typesafe", id: "jev-latest" });
		expect(h.render()).toContain("→ ✓ jev-latest [typesafe]");
		expect(h.fg).toHaveBeenCalledWith("accent", "system one");
		h.component.handleInput("\t");
		expect(h.render()).toContain("chat-v2 [custom]");
		expect(h.render()).not.toContain("✓");
		h.component.handleInput("\t");
		expect(h.render()).toContain("→ ✓ jev-latest [typesafe]");
		expect(h.done).not.toHaveBeenCalled();
	});

	it.each(["Task", "custom", "chat-v2", "custom/chat-v2"])("searches chat by name/provider/id: %s", (query) => {
		const h = harness();
		h.component.handleInput(query);
		expect(h.render()).not.toContain("[openai]");
		h.component.handleInput("\r");
		expect(h.done).toHaveBeenCalledWith({ type: "chat", provider: "custom", id: "chat-v2" });
	});

	it("keeps search across tabs and clears back to the saved selection", () => {
		const h = harness();
		h.component.handleInput("Task");
		h.component.handleInput("\t");
		expect(h.render()).toContain("selector-v2 [custom]");
		expect(h.render()).not.toContain("[typesafe]");
		h.component.handleInput("\r");
		expect(h.done).toHaveBeenCalledWith({ type: "classifier", provider: "custom", id: "selector-v2" });
		h.component.handleInput("\t");
		h.component.handleInput("\x15");
		expect(h.render()).toContain("→ ✓ gpt-test [openai]");
	});

	it("wraps up/down and honors custom tab/selection/cancel keys", () => {
		const h = harness();
		h.component.handleInput("\u001b[A");
		expect(h.render()).toContain("→   chat-v2 [custom]");
		h.component.handleInput("\u001b[B");
		expect(h.render()).toContain("→ ✓ gpt-test [openai]");
		const kb = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.input.tab": "ctrl+t", "tui.select.down": "ctrl+n", "tui.select.confirm": "ctrl+s", "tui.select.cancel": "ctrl+q" });
		const custom = harness(saved, models, kb);
		custom.component.handleInput("\x14");
		custom.component.handleInput("\x0e");
		custom.component.handleInput("\x13");
		expect(custom.done).toHaveBeenCalledWith({ type: "classifier", provider: "typesafe", id: "jev-latest" });
		expect(custom.render()).toContain("ctrl+t switch tab");
		custom.component.handleInput("\x11");
		expect(custom.done).toHaveBeenLastCalledWith(undefined);
		h.component.handleInput("\u001b");
		expect(h.done).toHaveBeenCalledWith(undefined);
	});

	it("keeps unavailable saved identities unmarked and permits switching out of an empty tab", () => {
		const h = harness({ type: "classifier", provider: "missing", id: "old" }, { ...models, classifier: [] });
		expect(h.render()).toContain("Saved selector unavailable: missing/old");
		expect(h.render()).toContain("No matching models");
		expect(h.render()).not.toContain("✓");
		h.component.handleInput("\r");
		expect(h.done).not.toHaveBeenCalled();
		h.component.handleInput("\t");
		h.component.handleInput("\r");
		expect(h.done).toHaveBeenCalledWith({ type: "chat", provider: "custom", id: "chat-v2" });
	});

	it("scrolls a bounded native list without a pinned current-model row", () => {
		const h = harness(saved, { ...models, chat: Array.from({ length: 30 }, (_, index) => chat("provider", `model-${index}`)) });
		h.component.handleInput("\u001b[A");
		expect(h.render()).toContain("→   model-29");
		expect(h.render()).toContain("(30/30)");
		expect(h.render()).not.toContain("model-0 [provider]");
	});

	it("propagates focus and fits narrow/wide Unicode renders without a selectable no-match row", () => {
		const h = harness(saved, { ...models, chat: [chat("custom", "中文🌱".repeat(40), "中文🌱".repeat(40))] });
		h.component.focused = true;
		expect(h.component.focused).toBe(true);
		expect(h.component.render(80).join("\n")).toContain(CURSOR_MARKER);
		for (const width of [1, 12, 24, 30, 80, 160]) {
			for (const line of h.component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		h.component.handleInput("no-match");
		expect(h.render()).toContain("No matching models");
		h.component.handleInput("\r");
		expect(h.done).not.toHaveBeenCalled();
		h.component.focused = false;
		expect(h.component.render(80).join("\n")).not.toContain(CURSOR_MARKER);
	});

	it("shows an explicit unsaved state without inventing an identity", () => {
		const h = harness();
		const component = new AutoModelSelector(models, undefined, h.tui, h.theme, h.kb, h.done);
		const text = component.render(90).join("\n");
		expect(text).toContain("No selector saved");
		expect(text).not.toContain("✓");
	});
});
