import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readDefaultEnabled(path: string): boolean {
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null || Array.isArray(value) ||
		!("defaultEnabled" in value) || typeof value.defaultEnabled !== "boolean") {
		throw new Error("Invalid pi-auto settings");
	}
	return value.defaultEnabled;
}

export function writeDefaultEnabled(path: string, enabled: boolean): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ defaultEnabled: enabled }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
