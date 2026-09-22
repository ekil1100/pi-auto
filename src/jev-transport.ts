import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";

export interface JevTransportTiming {
	status: "observed" | "partial" | "unavailable" | "ambiguous";
	requestCount: number;
	connection: "new" | "reused" | "unknown";
	socketId?: number;
	connectMs?: number;
	sendHeadersMs?: number;
	bodySentMs?: number;
	responseHeadersMs?: number;
	afterUploadMs?: number;
}

type SocketInfo = { id?: number; used: boolean; connectedEpoch: number; connectMs?: number };
type ConnectGroup = { epoch: number; count: number; ambiguous: boolean };
type PendingConnect = { startedAt: number; count: number; group: ConnectGroup };
type Trace = {
	active: boolean;
	startedAt: number;
	origin: string;
	host: string;
	path: string;
	method: string;
	request?: object;
	ambiguous: boolean;
	bodySentAt?: number;
	responseHeadersAt?: number;
	pending: Map<object, PendingConnect>;
	timing: JevTransportTiming;
	report: (value: JevTransportTiming) => void;
};

const scope = new AsyncLocalStorage<Trace>();
const requests = new WeakMap<object, Trace>();
const sockets = new WeakMap<object, SocketInfo>();
const connecting = new WeakMap<object, ConnectGroup>();
let nextSocketId = 0;
let activeTraces = 0;
let epoch = 0;
const elapsed = (since: number) => Math.max(0, Math.round((performance.now() - since) * 10) / 10);
const isObject = (value: unknown): value is object => value !== null && (typeof value === "object" || typeof value === "function");
const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function snapshot(trace: Trace): JevTransportTiming {
	const timing = trace.timing;
	if (trace.ambiguous || timing.requestCount > 1) {
		return { status: "ambiguous", requestCount: timing.requestCount, connection: "unknown" };
	}
	const complete = timing.connection !== "unknown" && timing.sendHeadersMs !== undefined &&
		timing.bodySentMs !== undefined && timing.responseHeadersMs !== undefined && timing.afterUploadMs !== undefined &&
		(timing.connection === "reused" || timing.connectMs !== undefined);
	return { ...timing, status: complete ? "observed" : timing.requestCount ? "partial" : "unavailable" };
}

function ignoreTiming(_timing: JevTransportTiming): void {}

function report(trace: Trace): void {
	try { trace.report(snapshot(trace)); } catch { /* Observers must not affect the request. */ }
}

function requestTrace(event: Record<string, unknown>): Trace | undefined {
	const trace = isObject(event.request) ? requests.get(event.request) : undefined;
	return trace?.active ? trace : undefined;
}

function afterUpload(trace: Trace): void {
	const { bodySentAt, responseHeadersAt } = trace;
	// Compare unrounded timestamps: an early rejection is not a zero wait.
	if (bodySentAt !== undefined && responseHeadersAt !== undefined && responseHeadersAt >= bodySentAt) {
		trace.timing.afterUploadMs = Math.round((responseHeadersAt - bodySentAt) * 10) / 10;
	}
}

function connectTrace(event: Record<string, unknown>): Trace | undefined {
	const trace = scope.getStore();
	return trace?.active && record(event.connectParams)?.host === trace.host && isObject(event.connector) ? trace : undefined;
}

function endConnect(connector: unknown): void {
	if (!isObject(connector)) return;
	const group = connecting.get(connector);
	if (group && --group.count === 0) connecting.delete(connector);
}

const handlers: [string, (event: Record<string, unknown>) => void][] = [
	["undici:request:create", (event) => {
		const trace = scope.getStore();
		const request = record(event.request);
		if (!trace?.active || !request) return;
		const origin = request.origin instanceof URL ? request.origin.origin : request.origin;
		if (origin !== trace.origin || request.path !== trace.path || request.method !== trace.method) return;
		trace.timing.requestCount++;
		if (trace.timing.requestCount === 1) {
			trace.request = request;
			requests.set(request, trace);
		}
		report(trace);
	}],
	["undici:client:beforeConnect", (event) => {
		if (!isObject(event.connector)) return;
		const connector = event.connector;
		let group = connecting.get(connector);
		if (!group || group.epoch !== epoch) {
			group = { epoch, count: 0, ambiguous: false };
			connecting.set(connector, group);
		}
		if (++group.count > 1) group.ambiguous = true;
		const trace = connectTrace(event);
		if (!trace) return;
		const pending = trace.pending.get(connector);
		if (pending) pending.count++;
		else trace.pending.set(connector, { startedAt: performance.now(), count: 1, group });
	}],
	["undici:client:connected", (event) => {
		if (!isObject(event.socket)) return;
		const info: SocketInfo = { used: false, connectedEpoch: epoch };
		const trace = connectTrace(event);
		const pending = trace?.pending.get(event.connector as object);
		if (pending) {
			// connectParams is a NEW object in each event. A shared/custom connector
			// can also finish in a different async scope: omit ALL overlapping dials.
			if (!pending.group.ambiguous && pending.count === 1 && pending.group === connecting.get(event.connector as object)) {
				info.connectMs = elapsed(pending.startedAt);
			}
			if (--pending.count === 0) trace!.pending.delete(event.connector as object);
		}
		endConnect(event.connector);
		sockets.set(event.socket, info);
	}],
	["undici:client:connectError", (event) => {
		const trace = connectTrace(event);
		const pending = trace?.pending.get(event.connector as object);
		if (pending && --pending.count === 0) trace!.pending.delete(event.connector as object);
		endConnect(event.connector);
		// Never inspect the error object: it may include credentials or addresses.
	}],
	["undici:client:sendHeaders", (event) => {
		if (!isObject(event.socket)) return;
		const trace = requestTrace(event);
		let info = sockets.get(event.socket);
		if (!info) {
			info = { used: false, connectedEpoch: 0 };
			sockets.set(event.socket, info);
		}
		if (trace?.timing.sendHeadersMs !== undefined) trace.ambiguous = true;
		if (trace && trace.timing.sendHeadersMs === undefined) {
			info.id ??= ++nextSocketId;
			trace.timing.socketId = info.id;
			trace.timing.connection = info.used ? "reused" : info.connectedEpoch === epoch ? "new" : "unknown";
			if (trace.timing.connection === "new" && info.connectMs !== undefined) trace.timing.connectMs = info.connectMs;
			trace.timing.sendHeadersMs = elapsed(trace.startedAt);
		}
		// Track only socket identity/use, including untraced sends on a known pool.
		// No headers, request body, peer address or unrelated request metadata is read.
		info.used = true;
		if (trace) report(trace);
	}],
	["undici:request:bodySent", (event) => {
		const trace = requestTrace(event);
		if (!trace) return;
		trace.bodySentAt = performance.now();
		trace.timing.bodySentMs = elapsed(trace.startedAt);
		afterUpload(trace);
		report(trace);
	}],
	["undici:request:headers", (event) => {
		const trace = requestTrace(event);
		const status = record(event.response)?.statusCode;
		if (!trace || typeof status !== "number" || status < 200) return;
		// A later hop may fail or be cancelled, so Response.redirected is not enough.
		if ([301, 302, 303, 307, 308].includes(status)) trace.ambiguous = true;
		trace.responseHeadersAt = performance.now();
		trace.timing.responseHeadersMs = elapsed(trace.startedAt);
		afterUpload(trace);
		report(trace);
	}],
];

// diagnostics_channel rethrows subscriber errors asynchronously. Guard EVERYTHING,
// not just observers, and subscribe only while requests are in flight.
const subscriptions = handlers.map(([name, handle]) => ({
	channel: channel(name),
	handle: (value: unknown) => {
		try { const event = record(value); if (event) handle(event); } catch { /* Best-effort diagnostics only. */ }
	},
}));

/** Observe one fetch without changing its URL, credentials, response or retry policy. */
export async function fetchWithTransportTiming(
	url: Parameters<typeof fetch>[0],
	init: Parameters<typeof fetch>[1],
	onTiming: (timing: JevTransportTiming) => void,
): Promise<Response> {
	const target = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
	const trace: Trace = {
		active: true, startedAt: performance.now(), origin: target.origin, host: target.host,
		path: target.pathname + target.search,
		method: (init?.method ?? (url instanceof Request ? url.method : "GET")).toUpperCase(),
		ambiguous: false, pending: new Map(), report: onTiming,
		timing: { status: "unavailable", requestCount: 0, connection: "unknown" },
	};
	if (activeTraces++ === 0) {
		epoch++;
		for (const subscription of subscriptions) subscription.channel.subscribe(subscription.handle);
	}
	const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined);
	const stop = () => {
		if (!trace.active) return;
		trace.active = false;
		if (trace.request) requests.delete(trace.request);
		delete trace.request;
		trace.pending.clear();
		trace.origin = trace.host = trace.path = trace.method = "";
		signal?.removeEventListener("abort", stop);
		if (--activeTraces === 0) for (const subscription of subscriptions) subscription.channel.unsubscribe(subscription.handle);
		report(trace);
		// A pooled socket may retain its old async context. Do not retain a request
		// (headers/body) or a caller/session closure through that context after stop.
		trace.report = ignoreTiming;
	};
	signal?.addEventListener("abort", stop, { once: true });
	if (signal?.aborted) stop();
	try {
		const response = await scope.run(trace, () => globalThis.fetch(url, init));
		trace.ambiguous ||= response.redirected;
		return response;
	} finally { stop(); }
}
