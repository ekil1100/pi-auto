import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { classifyWithJev, JEV_MODEL, selectWithJev, type JevTiming } from "../src/jev.ts";
import { planEffort } from "../src/router.ts";
import { createJevTransport, type TimedJevFetch } from "../src/jev-transport.ts";

beforeEach(() => {
	for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"]) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("reuses one real connection across classification and selection without sleeps or prewarming", async () => {
	const transport = createJevTransport();
	const socketIds = new WeakMap<Socket, number>();
	const requests: { purpose: string; socketId: number }[] = [];
	let nextSocketId = 0;
	const server = createServer((request, response) => {
		if (!socketIds.has(request.socket)) socketIds.set(request.socket, ++nextSocketId);
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			try {
				const payload = JSON.parse(body) as { questions: Record<string, { criteria: Record<string, string> }> };
				requests.push({ purpose: payload.questions.effort ? "effort" : "context", socketId: socketIds.get(request.socket)! });
				const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, question], index) => {
					const choice = key === "effort" ? "high" : index === 0 ? "required" : "irrelevant";
					return [key, { type: "choice", choice, confidence: 1,
						probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === choice ? 1 : 0])) }];
				}));
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify({ model: JEV_MODEL, answers }));
			} catch {
				response.writeHead(500);
				response.end();
			}
		});
	});
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local server address");
		const fetchLocal: TimedJevFetch = (url, init, onTiming) => {
			expect(url).toBe("https://api.typesafe.ai/v1/systemone");
			return transport.fetch(`http://127.0.0.1:${address.port}/v1/systemone`, init, onTiming);
		};
		const contextTimings: JevTiming[] = [], effortTimings: JevTiming[] = [];
		const model: Model<Api> = { id: "synthetic", name: "Synthetic", api: "openai-responses", provider: "test",
			baseUrl: "https://example.test", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8_192 };
		const result = await planEffort({ task: "Continue the agreed change", hasImages: false,
			currentModel: model, currentEffort: "medium", signal: AbortSignal.timeout(5_000),
			history: [0, 1, 2].map((index) => ({ entryId: `u${index}`, role: "user", text: `Synthetic request ${index}. `.padEnd(2_500, "x") })),
		}, async () => { throw new Error("Current-model backend must not be called"); }, {
			classify: (invocation) => classifyWithJev("synthetic-key", { ...invocation, onTiming: (value) => contextTimings.push(structuredClone(value)) }, fetchLocal),
			select: (invocation) => selectWithJev("synthetic-key", { ...invocation, onTiming: (value) => effortTimings.push(structuredClone(value)) }, fetchLocal),
		});
		expect(result).toMatchObject({ status: "selected", plan: { effort: "high" } });
		expect(requests).toEqual([{ purpose: "context", socketId: 1 }, { purpose: "effort", socketId: 1 }]);
		expect(contextTimings.at(-1)?.transport).toMatchObject({ status: "observed", connection: "new", connectMs: expect.any(Number), afterUploadMs: expect.any(Number) });
		expect(effortTimings.at(-1)?.transport).toMatchObject({ status: "observed", connection: "reused", socketId: contextTimings.at(-1)!.transport!.socketId });
		expect(effortTimings.at(-1)?.transport).not.toHaveProperty("connectMs");
		for (const secret of ["synthetic-key", "Synthetic request", "127.0.0.1", "example.test"]) expect(JSON.stringify([...contextTimings, ...effortTimings])).not.toContain(secret);
	} finally {
		await transport.dispose();
		server.closeAllConnections();
		await new Promise<void>((resolve) => { server.close(() => resolve()); });
	}
});
