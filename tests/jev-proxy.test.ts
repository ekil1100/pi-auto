import { execFile } from "node:child_process";
import { createServer, request as requestHttp, type IncomingHttpHeaders, type Server } from "node:http";
import { promisify } from "node:util";
import { connect, type Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { getGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJevTransport, type JevTransportTiming } from "../src/jev-transport.ts";
import { selectWithJev, type JevInvocation } from "../src/jev.ts";

const environment = ["http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "all_proxy", "NODE_USE_ENV_PROXY"];
const transports: ReturnType<typeof createJevTransport>[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();

beforeEach(() => {
	for (const key of environment) vi.stubEnv(key, undefined);
});
afterEach(async () => {
	await Promise.all(transports.splice(0).map((transport) => transport.dispose()));
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	})));
	vi.unstubAllEnvs();
});

function transport() {
	const value = createJevTransport();
	transports.push(value);
	return value;
}

async function listen(server: Server): Promise<number> {
	servers.push(server);
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing local server address");
	return address.port;
}

async function fixture() {
	const originRequests: { body: string; headers: IncomingHttpHeaders; socket: Socket }[] = [];
	const proxyRequests: { url: string | undefined; headers: IncomingHttpHeaders; socket: Socket }[] = [];
	const originPort = await listen(createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => { body += chunk; });
		request.on("end", () => {
			originRequests.push({ body, headers: request.headers, socket: request.socket });
			response.end("local response");
		});
	}));
	const proxy = createServer((request, response) => {
		proxyRequests.push({ url: request.url, headers: request.headers, socket: request.socket });
		const headers = { ...request.headers };
		delete headers["proxy-authorization"];
		delete headers["proxy-connection"];
		const forwarded = requestHttp({ hostname: "127.0.0.1", port: originPort, path: new URL(request.url!).pathname,
			method: request.method, headers, agent: false }, (origin) => {
			response.writeHead(origin.statusCode!, origin.headers);
			origin.pipe(response);
		});
		forwarded.on("error", () => response.destroy());
		request.pipe(forwarded);
	});
	proxy.on("connect", (request, client, head) => {
		proxyRequests.push({ url: request.url, headers: request.headers, socket: request.socket });
		// Never resolve the requested host or open an external connection in these tests.
		const upstream = connect(originPort, "127.0.0.1");
		sockets.add(upstream);
		upstream.on("close", () => sockets.delete(upstream));
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
		client.on("close", () => upstream.destroy());
		upstream.once("connect", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream).pipe(client);
		});
	});
	const proxyPort = await listen(proxy);
	return { originRequests, proxyRequests, proxyUrl: `http://127.0.0.1:${proxyPort}`, url: `http://127.0.0.1:${originPort}/test` };
}

const requestInit = () => ({ method: "POST", body: "synthetic body", headers: { authorization: "Bearer synthetic-api-key" }, signal: AbortSignal.timeout(2_000) });

describe("request-local Jev proxy transport", () => {
	it("preserves an existing native fetch dispatcher when the module is first imported", async () => {
		const local = await fixture();
		const moduleUrl = new URL("../src/jev-transport.ts", import.meta.url).href;
		const script = `
			const url = ${JSON.stringify(local.url)};
			await (await fetch(url)).text();
			const key = Symbol.for("undici.globalDispatcher.1");
			const original = globalThis[key];
			let calls = 0;
			const sentinel = { dispatch(...args) { calls++; return original.dispatch(...args); } };
			globalThis[key] = sentinel;
			await import(${JSON.stringify(moduleUrl)});
			await (await fetch(url)).text();
			console.log(JSON.stringify({ unchanged: globalThis[key] === sentinel, calls }));
		`;
		const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script]);
		expect(JSON.parse(stdout)).toEqual({ unchanged: true, calls: 1 });
	});

	it("preserves Node's opt-in environment proxy for non-Jev requests on first import", async () => {
		const local = await fixture();
		const moduleUrl = new URL("../src/jev-transport.ts", import.meta.url).href;
		const script = `
			await import(${JSON.stringify(moduleUrl)});
			console.log(await (await fetch(${JSON.stringify(local.url)})).text());
		`;
		const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
			env: { ...process.env, NODE_USE_ENV_PROXY: "1", http_proxy: local.proxyUrl },
		});
		expect(stdout.trim()).toBe("local response");
		expect(local.proxyRequests).toHaveLength(1);
	});

	it.each(["http_proxy", "HTTP_PROXY"])("uses %s without a Node proxy flag and leaves global dispatchers alone", async (key) => {
		const local = await fixture();
		vi.stubEnv(key, local.proxyUrl);
		const originalFetch = globalThis.fetch;
		const originalDispatcher = getGlobalDispatcher();
		const client = transport();
		const timings: JevTransportTiming[] = [];
		expect(await (await client.fetch(local.url, requestInit(), (value) => timings.push(value))).text()).toBe("local response");
		await setImmediate();
		expect(await (await client.fetch(local.url, requestInit(), () => {})).text()).toBe("local response");
		expect(local.proxyRequests).toHaveLength(1);
		expect(local.originRequests).toHaveLength(2);
		expect(local.originRequests[0]!.socket).toBe(local.originRequests[1]!.socket);
		expect(local.proxyRequests[0]!.headers).not.toHaveProperty("authorization");
		expect(local.originRequests[0]).toMatchObject({ body: "synthetic body", headers: { authorization: "Bearer synthetic-api-key" } });
		for (const secret of ["synthetic-api-key", "synthetic body", "127.0.0.1"]) expect(JSON.stringify(timings)).not.toContain(secret);
		expect(globalThis.fetch).toBe(originalFetch);
		expect(getGlobalDispatcher()).toBe(originalDispatcher);
	});

	it.each(["https_proxy", "HTTPS_PROXY"])("routes HTTPS through %s and does not retry or fall back on proxy failure", async (key) => {
		const requests: string[] = [];
		const proxy = createServer();
		proxy.on("connect", (request, socket) => {
			requests.push(request.url!);
			expect(request.headers).not.toHaveProperty("authorization");
			socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
		});
		const port = await listen(proxy);
		vi.stubEnv(key, `http://proxy-user:proxy-secret@127.0.0.1:${port}`);
		const input: JevInvocation = {
			signal: AbortSignal.timeout(2_000), state: {
				task: "synthetic task", taskCharacters: 14, taskTruncated: false, hasImages: false, contextOmitted: false,
				model: { id: "test/model", name: "test" }, currentEffort: "low", supportedEfforts: ["low", "high"],
			},
		};
		await expect(selectWithJev("synthetic-api-key", input, transport().fetch)).rejects.toThrow(/^Jev request failed$/);
		expect(requests).toEqual(["api.typesafe.ai:443"]);
	});

	it.each(["no_proxy", "NO_PROXY"])("honors %s exclusions", async (key) => {
		const local = await fixture();
		vi.stubEnv("http_proxy", local.proxyUrl);
		vi.stubEnv(key, "127.0.0.1");
		const client = transport();
		await (await client.fetch(local.url, requestInit(), () => {})).text();
		expect(local.proxyRequests).toHaveLength(0);
		expect(local.originRequests).toHaveLength(1);
	});

	it("uses direct connections when proxy variables are absent", async () => {
		const local = await fixture();
		await (await transport().fetch(local.url, requestInit(), () => {})).text();
		expect(local.proxyRequests).toHaveLength(0);
		expect(local.originRequests).toHaveLength(1);
	});

	it("gives lowercase variables priority and supplies separate proxy credentials", async () => {
		const local = await fixture();
		const proxyUrl = new URL(local.proxyUrl);
		proxyUrl.username = "proxy-user";
		proxyUrl.password = "proxy-secret";
		vi.stubEnv("http_proxy", proxyUrl.href);
		vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:1");
		await (await transport().fetch(local.url, requestInit(), () => {})).text();
		expect(local.proxyRequests[0]!.headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("proxy-user:proxy-secret").toString("base64")}`);
		expect(local.originRequests[0]!.headers).not.toHaveProperty("proxy-authorization");
	});

	it("does not inspect invalid proxy settings until the first request", async () => {
		vi.stubEnv("https_proxy", "invalid-proxy-url");
		const client = transport();
		await client.dispose();
		await expect(client.fetch("https://unused.invalid/", undefined, () => {})).rejects.toThrow("Jev transport is closed");
	});

	it("does not touch the proxy or origin for an already cancelled request", async () => {
		const local = await fixture();
		vi.stubEnv("http_proxy", local.proxyUrl);
		await expect(transport().fetch(local.url, { signal: AbortSignal.abort() }, () => {})).rejects.toMatchObject({ name: "AbortError" });
		expect(local.proxyRequests).toHaveLength(0);
		expect(local.originRequests).toHaveLength(0);
	});

	it("cancels a request waiting on the proxy without waiting for the SDK timeout", async () => {
		let onConnect!: () => void;
		const connected = new Promise<void>((resolve) => { onConnect = resolve; });
		const proxy = createServer();
		proxy.on("connect", () => onConnect());
		const port = await listen(proxy);
		vi.stubEnv("https_proxy", `http://127.0.0.1:${port}`);
		const controller = new AbortController();
		const pending = transport().fetch("https://example.invalid/", { signal: controller.signal }, () => {});
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await connected;
		controller.abort();
		await rejected;
	});

	it("disposes one instance without closing another instance's connection pool", async () => {
		const local = await fixture();
		const first = transport(), second = transport();
		await (await first.fetch(local.url, requestInit(), () => {})).text();
		await first.dispose();
		await first.dispose();
		await expect(first.fetch(local.url, requestInit(), () => {})).rejects.toThrow("Jev transport is closed");
		await (await second.fetch(local.url, requestInit(), () => {})).text();
		expect(local.originRequests).toHaveLength(2);
	});
});
