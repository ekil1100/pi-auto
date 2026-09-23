import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JEV_MODEL, selectWithJev, type JevTiming } from "../src/jev.ts";
import { planEffort, type EffortState } from "../src/router.ts";
import { createJevTransport, type TimedJevFetch } from "../src/jev-transport.ts";

beforeEach(() => {
	for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"]) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

it("makes one HTTP request per long-history routing invocation and reuses the connection", async () => {
	const transport = createJevTransport();
	const socketIds = new WeakMap<Socket, number>();
	type Payload = { state: EffortState; questions: Record<string, { criteria: Record<string, string> }> };
	const requests: { payload: Payload; socketId: number }[] = [];
	let nextSocketId = 0;
	const server = createServer((request, response) => {
		if (!socketIds.has(request.socket)) socketIds.set(request.socket, ++nextSocketId);
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			try {
				const payload = JSON.parse(body) as Payload;
				requests.push({ payload, socketId: socketIds.get(request.socket)! });
				const answers = Object.fromEntries(Object.entries(payload.questions).map(([key, question]) => [key, {
					type: "choice", choice: "high", confidence: 1,
					probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === "high" ? 1 : 0])),
				}]));
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
		const timings: JevTiming[][] = [[], []];
		const model: Model<Api> = { id: "synthetic", name: "Synthetic", api: "openai-responses", provider: "test",
			baseUrl: "https://example.test", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8_192 };
		const complete = vi.fn(async () => { throw new Error("Current-model backend must not be called"); });
		for (let index = 0; index < 2; index++) {
			const task = `Continue the agreed change ${index}`;
			const previousTask = `Synthetic previous task ${index}`;
			const finalAnswer = `Synthetic final answer ${index}`;
			const result = await planEffort({ task, hasImages: false,
				currentModel: model, currentEffort: "medium", signal: AbortSignal.timeout(5_000),
				history: [
					{ entryId: "old", role: "user", text: "Private old request".repeat(2_000) },
					{ entryId: "old-answer", role: "assistant", text: "Private old answer" },
					{ entryId: `u${index}`, role: "user", text: previousTask },
					{ entryId: "progress", role: "assistant", text: "Private intermediate commentary" },
					{ entryId: `a${index}`, role: "assistant", text: finalAnswer },
				],
			}, complete, (invocation) => selectWithJev("synthetic-key", {
				...invocation, onTiming: (value) => timings[index]!.push(structuredClone(value)),
			}, fetchLocal));
			expect(result).toMatchObject({ status: "selected", plan: { model, effort: "high" } });
			expect(requests).toHaveLength(index + 1);
			const { payload } = requests[index]!;
			expect(Object.keys(payload.questions)).toEqual(["effort"]);
			expect(payload.state.task).toBe(task);
			expect(payload.state.contextOmitted).toBe(true);
			expect(payload.state.recentConversation).toBe([
				"[Earlier history omitted]",
				`[user source="u${index}" range=0:${previousTask.length}]\n${previousTask}`,
				`[assistant source="a${index}" range=0:${finalAnswer.length}]\n${finalAnswer}`,
			].join("\n\n"));
			for (const excluded of ["Private old request", "Private old answer", "Private intermediate commentary"]) expect(JSON.stringify(payload)).not.toContain(excluded);
			expect(timings[index]!.at(-1)?.transport).toMatchObject({ status: "observed", requestCount: 1 });
		}
		expect(complete).not.toHaveBeenCalled();
		expect(requests.map(({ socketId }) => socketId)).toEqual([1, 1]);
		const first = timings[0]!.at(-1)!.transport!;
		const second = timings[1]!.at(-1)!.transport!;
		expect(first).toMatchObject({ status: "observed", connection: "new", connectMs: expect.any(Number), afterUploadMs: expect.any(Number) });
		expect(second).toMatchObject({ status: "observed", connection: "reused", socketId: first.socketId });
		expect(second).not.toHaveProperty("connectMs");
		for (const secret of ["synthetic-key", "Synthetic previous task", "Synthetic final answer", "Continue the agreed change", "Private", "127.0.0.1", "example.test"]) expect(JSON.stringify(timings)).not.toContain(secret);
	} finally {
		await transport.dispose();
		server.closeAllConnections();
		await new Promise<void>((resolve) => { server.close(() => resolve()); });
	}
});
