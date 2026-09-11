import { defineConfig } from "vitest/config";

// Benchmark checkouts under benchmarks/.cache contain the upstream Aider/Exercism
// spec files; only the extension's own tests belong to this suite.
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
	},
});
