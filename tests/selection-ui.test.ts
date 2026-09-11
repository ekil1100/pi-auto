import { stripVTControlCharacters } from "node:util";
import { keyHint, type CustomEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { DECISION_ENTRY_TYPE, createSelectingWidget, formatAutoEffort, readDecision, renderDecisionEntry, type EffortDecision } from "../src/selection-ui.ts";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, keyHint: vi.fn((_binding: string, description: string) => `ctrl+o ${description}`) };
});

function entry(overrides: Partial<EffortDecision> = {}): CustomEntry<EffortDecision> {
	return {
		type: "custom",
		customType: DECISION_ENTRY_TYPE,
		id: "decision",
		parentId: null,
		timestamp: new Date().toISOString(),
		data: {
			status: "selected",
			model: "test/current",
			previousEffort: "medium",
			effort: "low",
			reason: "A small, well-scoped question",
			routerModel: "test/current",
			routerEffort: "low",
			elapsedMs: 1200,
			...overrides,
		},
	};
}

function createTheme() {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		getThinkingBorderColor: vi.fn((_effort: string) => (text: string) => text),
	};
}

function render(expanded: boolean, overrides: Partial<EffortDecision> = {}, width = 100) {
	const theme = createTheme();
	const component = renderDecisionEntry(entry(overrides), { expanded }, theme as unknown as Theme);
	if (!component) throw new Error("Missing decision component");
	return { theme, lines: component.render(width).map(stripVTControlCharacters) };
}

describe("selection UI", () => {
	it("spins in front of the selecting label and stops once disposed", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const widget = createSelectingWidget({ requestRender } as unknown as TUI, createTheme() as unknown as Theme);

			expect(widget.render(80)).toEqual([" ⠋ choosing effort"]);
			vi.advanceTimersByTime(80);
			expect(widget.render(80)).toEqual([" ⠙ choosing effort"]);
			expect(requestRender).toHaveBeenCalledTimes(1);

			widget.dispose();
			vi.advanceTimersByTime(800);
			expect(requestRender).toHaveBeenCalledTimes(1);
			expect(widget.render(80)).toEqual([" ⠙ choosing effort"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses primary auto and the corresponding effort color", () => {
		const theme = createTheme();
		expect(formatAutoEffort(theme as unknown as Theme, "high")).toBe("auto · high");
		expect(theme.fg).toHaveBeenCalledWith("accent", "auto");
		expect(theme.fg).toHaveBeenCalledWith("dim", " · ");
		expect(theme.getThinkingBorderColor).toHaveBeenCalledWith("high");
	});

	it("keeps details collapsed and shows the native expand shortcut", () => {
		const { lines } = render(false);
		const text = lines.join("\n");

		expect(lines).toHaveLength(1);
		expect(text).toContain("auto · low");
		expect(text).toContain("ctrl+o");
		expect(keyHint).toHaveBeenCalledWith("app.tools.expand", "to expand");
		expect(text).not.toContain("Reason:");
		expect(text).not.toContain("test/current");
	});

	it("shows all decision details when Pi expands the entry", () => {
		const { lines, theme } = render(true);
		const text = lines.join("\n");

		expect(text).toContain("Model: test/current");
		expect(text).toContain("Effort: medium → low");
		expect(text).toContain("Selector: test/current @ low");
		expect(text).toContain("Reason: A small, well-scoped question");
		expect(text).toContain("Elapsed: 1.2s");
		expect(text).not.toContain("to expand");
		expect(theme.getThinkingBorderColor).toHaveBeenCalledWith("medium");
		expect(theme.getThinkingBorderColor).toHaveBeenCalledWith("low");
	});

	it.each(["kept", "cancelled"] as const)("keeps the %s outcome visible while hiding details", (status) => {
		const { lines, theme } = render(false, { status });
		expect(lines.join("\n")).toContain(`auto · low · ${status}`);
		expect(theme.fg).toHaveBeenCalledWith("warning", ` · ${status}`);
		expect(lines.join("\n")).not.toContain("Reason:");
	});

	it("does not imply a selector call for a single supported effort", () => {
		const { lines } = render(true, { effort: "off", routerEffort: undefined, routerModel: undefined });
		expect(lines.join("\n")).toContain("Selector: not called");
	});

	it.each([24, 80, 120])("wraps long details within %s terminal columns", (width) => {
		const { lines } = render(true, { reason: "A long reason with multiple constraints. ".repeat(10) }, width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	it("reads a decision after a JSON history round trip", () => {
		const restored = JSON.parse(JSON.stringify(entry({ routerEffort: undefined, routerModel: undefined })));
		expect(readDecision(restored)).toMatchObject({ status: "selected", effort: "low", reason: "A small, well-scoped question" });
	});

	it.each([undefined, null, {}, { ...entry().data, effort: "invalid" }, { ...entry().data, routerEffort: "off" }, { ...entry().data, elapsedMs: -1 }])("ignores malformed decision data: %j", (data) => {
		expect(readDecision({ ...entry(), data })).toBeUndefined();
	});
});
