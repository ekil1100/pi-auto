import { AsyncResource } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { fetchWithTransportTiming, type JevTransportTiming } from "../src/jev-transport.ts";

const url = "https://example.test/v1/systemone";
const init = { method: "POST", body: "private-request-body", headers: { Authorization: "Bearer private-key" } };
const publish = (name: string, value: unknown) => channel(`undici:${name}`).publish(value);
const request = () => ({ origin: "https://example.test", path: "/v1/systemone", method: "POST" });
const connection = (connector = () => {}, socket = {}) => ({ connector, socket, connectParams: { host: "example.test" } });
function send(req: object, socket: object): void { publish("client:sendHeaders", { request: req, socket }); }
function upload(req: object): void { publish("request:bodySent", { request: req }); }
function headers(req: object, statusCode = 200): void { publish("request:headers", { request: req, response: { statusCode } }); }
const last = (snapshots: JevTransportTiming[]) => snapshots.at(-1)!;
const listeners = ["request:create", "client:beforeConnect", "client:connected", "client:connectError", "client:sendHeaders", "request:bodySent", "request:headers"];
function expectDetached(): void { for (const name of listeners) expect(channel(`undici:${name}`).hasSubscribers).toBe(false); }

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("records a single dial, socket and post-upload wait without retaining private fields", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const snapshots: JevTransportTiming[] = [];
	const forbidden = vi.fn(() => { throw new Error("Private field accessed"); });
	vi.stubGlobal("fetch", vi.fn(async () => {
		const req = request();
		Object.defineProperties(req, { headers: { get: forbidden }, body: { get: forbidden } });
		const connected = connection();
		Object.defineProperty(connected.socket, "remoteAddress", { get: forbidden });
		publish("request:create", { request: req });
		now = 2; publish("client:beforeConnect", connected);
		now = 12; publish("client:connected", { ...connected, connectParams: { host: "example.test" } });
		now = 13; send(req, connected.socket);
		now = 15; upload(req);
		now = 115; headers(req);
		return Response.json({ secret: "private-response-body" });
	}));
	const response = await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots)).toMatchObject({ status: "observed", requestCount: 1, connection: "new", socketId: expect.any(Number),
		connectMs: 10, sendHeadersMs: 13, bodySentMs: 15, responseHeadersMs: 115, afterUploadMs: 100 });
	expect(snapshots[0]).toEqual({ status: "partial", requestCount: 1, connection: "unknown" });
	for (const text of ["private", "example.test", "Authorization", "secret"]) expect(JSON.stringify(snapshots)).not.toContain(text);
	expect(forbidden).not.toHaveBeenCalled();
	expect(await response.json()).toEqual({ secret: "private-response-body" });
	expect(globalThis.fetch).toHaveBeenCalledExactlyOnceWith(url, init);
	expectDetached();
});

it("distinguishes known reuse from a first-observed pre-existing socket", async () => {
	const socket = {};
	const snapshots: JevTransportTiming[] = [];
	vi.stubGlobal("fetch", async () => {
		const req = request();
		publish("request:create", { request: req });
		send(req, socket); upload(req); headers(req);
		return new Response();
	});
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	const first = last(snapshots);
	expect(first).toMatchObject({ status: "partial", connection: "unknown" });
	expect(first).not.toHaveProperty("connectMs");
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots)).toMatchObject({ status: "observed", connection: "reused", socketId: first.socketId });
	expect(last(snapshots)).not.toHaveProperty("connectMs");
	expectDetached();
});

it("does not label a socket newly connected across an unobserved interval", async () => {
	const connected = connection();
	let call = 0;
	const snapshots: JevTransportTiming[] = [];
	vi.stubGlobal("fetch", async () => {
		const req = request();
		publish("request:create", { request: req });
		if (call++ === 0) { publish("client:beforeConnect", connected); publish("client:connected", connected); }
		else { send(req, connected.socket); upload(req); headers(req); }
		return new Response();
	});
	await fetchWithTransportTiming(url, init, () => {});
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots).connection).toBe("unknown");
	expect(last(snapshots)).not.toHaveProperty("connectMs");
});

it("keeps overlapping requests separate even when callbacks run in the other async scope", async () => {
	const snapshotsA: JevTransportTiming[] = [], snapshotsB: JevTransportTiming[] = [];
	const reqA = request(), reqB = request(), socketA = {}, socketB = {};
	let finishA!: () => void;
	let finishB!: () => void;
	vi.stubGlobal("fetch", vi.fn()
		.mockImplementationOnce(async () => {
			publish("request:create", { request: reqA });
			send(reqA, socketA);
			await new Promise<void>((resolve) => { finishA = resolve; });
			// Body/headers belong to B despite running inside A's async context.
			upload(reqB); headers(reqB); upload(reqA); headers(reqA);
			return new Response();
		})
		.mockImplementationOnce(async () => {
			publish("request:create", { request: reqB }); send(reqB, socketB);
			await new Promise<void>((resolve) => { finishB = resolve; });
			return new Response();
		}));
	const a = fetchWithTransportTiming(url, init, (value) => snapshotsA.push(value));
	const b = fetchWithTransportTiming(url, init, (value) => snapshotsB.push(value));
	finishA(); await a;
	expect(channel("undici:request:create").hasSubscribers).toBe(true);
	finishB(); await b;
	expect(last(snapshotsA).requestCount).toBe(1);
	expect(last(snapshotsB).requestCount).toBe(1);
	expect(last(snapshotsA).socketId).not.toBe(last(snapshotsB).socketId);
	expect(last(snapshotsA)).toHaveProperty("afterUploadMs");
	expect(last(snapshotsB)).toHaveProperty("afterUploadMs");
	expectDetached();
});

it("reports missing hooks as unavailable, not as a zero-duration connection", async () => {
	const snapshots: JevTransportTiming[] = [];
	vi.stubGlobal("fetch", async () => new Response());
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots)).toEqual({ status: "unavailable", requestCount: 0, connection: "unknown" });
	expectDetached();
});

it("ignores unrelated calls, origins, paths and methods", async () => {
	const snapshots: JevTransportTiming[] = [];
	vi.stubGlobal("fetch", async () => {
		for (const req of [{ ...request(), origin: "https://other.test" }, { ...request(), path: "/other" }, { ...request(), method: "GET" }]) {
			publish("request:create", { request: req }); send(req, {}); upload(req); headers(req);
		}
		return new Response();
	});
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots)).toEqual({ status: "unavailable", requestCount: 0, connection: "unknown" });
	expectDetached();
});

it.each(["redirect", "multiple requests", "repeated send"])("marks %s ambiguous rather than combining different hops", async (mode) => {
	const snapshots: JevTransportTiming[] = [];
	vi.stubGlobal("fetch", async () => {
		const req = request();
		publish("request:create", { request: req }); send(req, {}); upload(req); headers(req);
		if (mode === "multiple requests") publish("request:create", { request: request() });
		if (mode === "repeated send") send(req, {});
		const response = new Response();
		if (mode === "redirect") Object.defineProperty(response, "redirected", { value: true });
		return response;
	});
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots)).toEqual({ status: "ambiguous", requestCount: mode === "multiple requests" ? 2 : 1, connection: "unknown" });
	expectDetached();
});

it("omits ambiguous concurrent dial durations even when both share a connector", async () => {
	const snapshots: JevTransportTiming[] = [];
	vi.stubGlobal("fetch", async () => {
		const req = request(), a = connection(), b = connection(a.connector);
		publish("request:create", { request: req });
		publish("client:beforeConnect", a); publish("client:beforeConnect", b);
		publish("client:connected", b); publish("client:connected", a);
		send(req, a.socket); upload(req); headers(req);
		return new Response();
	});
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots)).toMatchObject({ status: "partial", connection: "new" });
	expect(last(snapshots)).not.toHaveProperty("connectMs");
});

it("omits shared connector dial durations when completions cross async scopes", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const aEvents: JevTransportTiming[] = [], bEvents: JevTransportTiming[] = [];
	const a = connection(), b = connection(a.connector), aRequest = request(), bRequest = request();
	let aScope!: AsyncResource, bScope!: AsyncResource, finishA!: () => void, finishB!: () => void;
	vi.stubGlobal("fetch", vi.fn()
		.mockImplementationOnce(async () => {
			aScope = new AsyncResource("connect-a");
			publish("request:create", { request: aRequest }); publish("client:beforeConnect", a);
			await new Promise<void>((resolve) => { finishA = resolve; });
			return new Response();
		})
		.mockImplementationOnce(async () => {
			bScope = new AsyncResource("connect-b");
			publish("request:create", { request: bRequest }); publish("client:beforeConnect", b);
			await new Promise<void>((resolve) => { finishB = resolve; });
			return new Response();
		}));
	const pendingA = fetchWithTransportTiming(url, init, (value) => aEvents.push(value));
	now = 50;
	const pendingB = fetchWithTransportTiming(url, init, (value) => bEvents.push(value));
	now = 60;
	aScope.runInAsyncScope(() => {
		publish("client:connected", { ...b, connectParams: { host: "example.test" } });
		send(bRequest, b.socket); upload(bRequest); headers(bRequest);
	});
	now = 100;
	bScope.runInAsyncScope(() => {
		publish("client:connected", { ...a, connectParams: { host: "example.test" } });
		send(aRequest, a.socket); upload(aRequest); headers(aRequest);
	});
	finishA(); finishB();
	await Promise.all([pendingA, pendingB]);
	for (const events of [aEvents, bEvents]) {
		expect(last(events)).toMatchObject({ status: "partial", connection: "new" });
		expect(last(events)).not.toHaveProperty("connectMs");
	}
	aScope.emitDestroy(); bScope.emitDestroy();
	expectDetached();
});

it("also treats an overlapping untraced dial on the same connector as ambiguous", async () => {
	const events: JevTransportTiming[] = [], a = connection(), b = connection(a.connector);
	let finish!: () => void;
	vi.stubGlobal("fetch", async () => {
		const req = request();
		publish("request:create", { request: req }); publish("client:beforeConnect", a);
		await new Promise<void>((resolve) => { finish = resolve; });
		publish("client:connected", a); send(req, a.socket); upload(req); headers(req);
		return new Response();
	});
	const pending = fetchWithTransportTiming(url, init, (value) => events.push(value));
	publish("client:beforeConnect", b); publish("client:connected", b);
	finish(); await pending;
	expect(last(events)).toMatchObject({ status: "partial", connection: "new" });
	expect(last(events)).not.toHaveProperty("connectMs");
	expectDetached();
});

it("marks a redirect ambiguous even when its later hop fails before fetch returns", async () => {
	const paths: string[] = [], snapshots: JevTransportTiming[] = [];
	const server = createServer((req, res) => {
		paths.push(req.url!);
		req.resume();
		req.on("end", () => {
			if (req.url === "/start") { res.writeHead(307, { Location: "/fail" }); res.end(); }
			else req.socket.destroy();
		});
	});
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local server address");
		await expect(fetchWithTransportTiming(`http://127.0.0.1:${address.port}/start`, { method: "POST", body: "test" },
			(value) => snapshots.push(value))).rejects.toThrow("fetch failed");
		expect(paths).toEqual(["/start", "/fail"]);
		expect(last(snapshots)).toEqual({ status: "ambiguous", requestCount: 1, connection: "unknown" });
		expectDetached();
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => { server.close(() => resolve()); });
	}
});

it("ignores provisional headers and does not invent a post-upload wait for early final headers", async () => {
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const snapshots: JevTransportTiming[] = [];
	vi.stubGlobal("fetch", async () => {
		const req = request();
		publish("request:create", { request: req }); send(req, {}); headers(req, 100);
		expect(last(snapshots)).not.toHaveProperty("responseHeadersMs");
		now = 0.02; headers(req, 413);
		now = 0.03; upload(req);
		return new Response(null, { status: 413 });
	});
	await fetchWithTransportTiming(url, init, (value) => snapshots.push(value));
	expect(last(snapshots)).not.toHaveProperty("afterUploadMs");
});

it("detaches on abort and never mutates snapshots when a non-cooperative fetch finishes late", async () => {
	const controller = new AbortController(), snapshots: JevTransportTiming[] = [];
	let finish!: () => void;
	vi.stubGlobal("fetch", async () => {
		const req = request();
		publish("request:create", { request: req }); send(req, {});
		await new Promise<void>((resolve) => { finish = resolve; });
		upload(req); headers(req);
		return new Response();
	});
	const pending = fetchWithTransportTiming(url, { ...init, signal: controller.signal }, (value) => snapshots.push(value));
	controller.abort();
	const saved = JSON.stringify(snapshots);
	expectDetached();
	finish(); await pending;
	expect(JSON.stringify(snapshots)).toBe(saved);
});

it("cleans up failures and ignores malformed events or broken observers", async () => {
	vi.stubGlobal("fetch", async () => {
		for (const name of listeners) { publish(name, null); publish(name, {}); }
		const req = request();
		publish("request:create", { request: req }); send(req, {});
		throw new Error("Synthetic failure");
	});
	await expect(fetchWithTransportTiming(url, init, () => { throw new Error("Observer failed"); })).rejects.toThrow("Synthetic failure");
	expectDetached();
});

it("observes native fetch sockets and delayed headers on a local HTTP server", async () => {
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => { setTimeout(() => res.end("ok"), 15); });
	});
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local server address");
		const target = `http://127.0.0.1:${address.port}/test`;
		const snapshots: JevTransportTiming[] = [];
		await (await fetchWithTransportTiming(target, { method: "POST", body: "test" }, (value) => snapshots.push(value))).text();
		const first = last(snapshots);
		expect(first).toMatchObject({ status: "observed", connection: "new", requestCount: 1, connectMs: expect.any(Number) });
		expect(first.afterUploadMs).toBeGreaterThanOrEqual(10);
		await setImmediate();
		await (await fetchWithTransportTiming(target, { method: "POST", body: "test" }, (value) => snapshots.push(value))).text();
		expect(last(snapshots)).toMatchObject({ status: "observed", connection: "reused", socketId: first.socketId });
		expect(last(snapshots)).not.toHaveProperty("connectMs");
		expectDetached();
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => { server.close(() => resolve()); });
	}
});
