import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SelectorBackend = { type: "chat"; provider: string; id: string } | { type: "classifier"; provider: string; id: string };
// Read only for the one-time initialization rewrite; never a callable backend.
type InitialBackend = SelectorBackend | { type: "current-model" };
export interface AutoSettings { defaultEnabled?: boolean; backend?: InitialBackend; [key: string]: unknown }

export function readSettings(path: string): AutoSettings {
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value) ||
		("defaultEnabled" in value && typeof value.defaultEnabled !== "boolean") ||
		("backend" in value && !(isBackend(value.backend) || isInitialCurrentModel(value.backend)))) throw new Error("Invalid pi-auto settings");
	return value as AutoSettings;
}

export function isBackend(value: unknown): value is SelectorBackend {
	if (typeof value !== "object" || value === null || !("type" in value)) return false;
	return (value.type === "chat" || value.type === "classifier") &&
		"provider" in value && validId(value.provider) && "id" in value && validId(value.id);
}
function isInitialCurrentModel(value: unknown): boolean {
	return typeof value === "object" && value !== null && "type" in value && value.type === "current-model";
}
function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function writeSettings(path: string, patch: { defaultEnabled?: boolean; backend?: SelectorBackend }): void {
	// Merge before writing: changing a backend must never erase the startup default.
	const value = { ...readSettings(path), ...patch };
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function backendLabel(backend: SelectorBackend | undefined): string {
	return backend ? `${backend.provider}/${backend.id}` : "Not selected";
}
