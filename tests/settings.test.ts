import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBackend, readSettings, writeSettings, type SelectorBackend } from "../src/settings.ts";

let directory: string;
let path: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "pi-auto-schema-")); path = join(directory, "pi-auto.json"); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("selector settings schema", () => {
	it.each(["chat", "classifier"] as const)("round-trips explicit %s identities and preserves unrelated fields", (type) => {
		const backend: SelectorBackend = { type, provider: "custom", id: "family/model-v2" };
		writeFileSync(path, JSON.stringify({ defaultEnabled: false, other: { retained: true } }));
		writeSettings(path, { backend });
		expect(readSettings(path)).toEqual({ defaultEnabled: false, backend, other: { retained: true } });
		writeSettings(path, { defaultEnabled: true });
		expect(readSettings(path)).toEqual({ defaultEnabled: true, backend, other: { retained: true } });
	});

	it.each([
		{ type: "chat" }, { type: "chat", provider: "custom", id: "" },
		{ type: "chat", provider: " ", id: "model" }, { type: "chat", provider: "custom", id: "bad\u001b[2J" },
		{ type: "auto", provider: "custom", id: "model" },
	])("refuses malformed backend %j without rewriting the file", (backend) => {
		const text = JSON.stringify({ backend });
		writeFileSync(path, text);
		expect(() => readSettings(path)).toThrow("Invalid pi-auto settings");
		expect(() => writeSettings(path, { defaultEnabled: true })).toThrow();
		expect(readFileSync(path, "utf8")).toBe(text);
	});

	it("accepts the initial current-model setting only for resolution, not as a runtime backend", () => {
		const initial = { type: "current-model" };
		writeFileSync(path, JSON.stringify({ backend: initial }));
		expect(readSettings(path).backend).toEqual(initial);
		expect(isBackend(initial)).toBe(false);
	});

	it("keeps an absent backend explicitly unselected", () => {
		expect(readSettings(path)).toEqual({});
		writeSettings(path, { defaultEnabled: false });
		expect(readSettings(path)).toEqual({ defaultEnabled: false });
	});
});
