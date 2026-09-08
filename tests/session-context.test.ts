import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { collectRecentContext } from "../src/session-context.ts";

function entry(role: "user" | "assistant" | "toolResult", text: string): SessionEntry {
	return {
		type: "message",
		message: {
			role,
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		},
	} as SessionEntry;
}

describe("collectRecentContext", () => {
	it("keeps user and assistant text while omitting tool results", () => {
		const result = collectRecentContext([
			entry("user", "Investigate auth"),
			entry("toolResult", "secret output"),
			entry("assistant", "The token refresh is broken"),
		]);

		expect(result).toBe("User: Investigate auth\n\nAssistant: The token refresh is broken");
	});

	it("spends a bounded budget on the newest relevant entries", () => {
		const result = collectRecentContext(
			[entry("user", "old context"), entry("assistant", "new context")],
			25,
		);

		expect(result).toContain("new context");
		expect(result).not.toContain("old context");
		expect(result.length).toBeLessThanOrEqual(25);
	});
});
