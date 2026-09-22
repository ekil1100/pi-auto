import {
	getSupportedThinkingLevels,
	modelsAreEqual,
	uuidv7,
	type Api,
	type AssistantMessage,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planEffort, type CompleteRouter, type RouterInvocation, type JevBackend, type RoutingDiagnostics } from "./router.ts";
import { JEV_MODEL, selectWithJev, classifyWithJev, type JevTiming } from "./jev.ts";
import { collectHistory, hasContextImages } from "./session-context.ts";
import { createSelectingWidget, DECISION_ENTRY_TYPE, formatAutoEffort, readDecision, renderDecisionEntry, type EffortDecision } from "./selection-ui.ts";
import { showAutoStatus } from "./status-ui.ts";

const ROUTER_TIMEOUT_MS = 10_000;
const ROUTER_MAX_OUTPUT_TOKENS = 2_048;
const STATUS_KEY = "pi-auto";
const PROGRESS_KEY = "pi-auto-selecting";

export default function piAuto(pi: ExtensionAPI): void {
	let enabled = true;
	let lastDecision: EffortDecision | undefined;
	let activeSelection: AbortController | undefined;
	let stopped = false;
	let selectionRevision = 0;
	const invalidateSelection = () => {
		selectionRevision++;
		activeSelection?.abort("settings_changed");
	};

	pi.registerEntryRenderer(DECISION_ENTRY_TYPE, renderDecisionEntry);
	pi.registerCommand("auto", {
		description: "Toggle automatic effort selection (toggle, on, off, status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "toggle" || action === "on" || action === "off") {
				enabled = action === "toggle" ? !enabled : action === "on";
				if (!enabled) activeSelection?.abort();
				updateFooter(ctx, enabled);
				ctx.ui.notify(enabled ? "pi-auto enabled (effort only)" : "pi-auto disabled", "info");
				return;
			}
			if (action === "status") {
				await showAutoStatus(ctx, {
					enabled,
					model: ctx.model ? modelKey(ctx.model) : "none",
					effort: ctx.thinkingLevel ?? "off",
					backend: process.env.TYPESAFE_API_KEY?.trim() ? `typesafe/${JEV_MODEL}` : "current model",
					supportedEfforts: ctx.model ? getSupportedThinkingLevels(ctx.model) : [],
					...(lastDecision ? { last: lastDecision } : {}),
				});
				return;
			}
			ctx.ui.notify("Usage: /auto [toggle|on|off|status]", "warning");
		},
	});

	const restore = (ctx: ExtensionContext) => {
		invalidateSelection();
		lastDecision = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const decision = readDecision(entry);
			if (decision) lastDecision = decision;
		}
		updateFooter(ctx, enabled);
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => { invalidateSelection(); updateFooter(ctx, enabled); });
	pi.on("thinking_level_select", (event, ctx) => { invalidateSelection(); updateFooter(ctx, enabled, event.level); });
	pi.on("session_shutdown", (_event, ctx) => {
		stopped = true;
		activeSelection?.abort();
		ctx.ui.setWidget(PROGRESS_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || stopped) return;
		const controller = new AbortController();
		activeSelection = controller;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]);
		const startedAt = performance.now();
		const initialRevision = selectionRevision;
		const previousEffort = ctx.thinkingLevel ?? "off";
		let routerModel: string | undefined;
		let routerEffort: EffortDecision["routerEffort"];
		let routerConfidence: number | undefined;
		let prepareMs: number | undefined;
		let jevTiming: JevTiming | undefined;
		let contextTiming: JevTiming | undefined;
		let contextDecisions: EffortDecision["contextDecisions"];
		let routerProbabilities: Record<string, number> | undefined;
		let routing: RoutingDiagnostics | undefined;
		const selectorUsage: NonNullable<EffortDecision["selectorUsage"]> = {};
		const interrupted = (): Pick<EffortDecision, "status" | "reason"> => controller.signal.reason === "settings_changed"
			? { status: "kept", reason: "Model, effort or session changed during selection" }
			: { status: "cancelled", reason: "Auto disabled during selection" };
		const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
		let outcome: Pick<EffortDecision, "status" | "reason"> = { status: "kept", reason: "Selection interrupted" };
		ctx.ui.setWidget(PROGRESS_KEY, createSelectingWidget);
		try {
			const result = await planForEvent(event, ctx, signal, (invocation) => {
				prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
				routerModel = modelKey(invocation.model);
				routerEffort = invocation.effort;
				return completeRouter(ctx, invocation, (usage) => { selectorUsage[invocation.purpose] = usage; });
			}, typesafeApiKey ? {
				select: async (invocation) => {
					prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
					routerModel = `typesafe/${JEV_MODEL}`;
					const decision = await selectWithJev(typesafeApiKey, {
						...invocation, onTiming: (timing) => { jevTiming = structuredClone(timing); },
					});
					routerModel = `typesafe/${decision.model}`;
					routerConfidence = decision.confidence;
					routerProbabilities = { ...decision.probabilities };
					return decision;
				},
				classify: async (invocation) => {
					prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
					routerModel = `typesafe/${JEV_MODEL}`;
					return classifyWithJev(typesafeApiKey, {
						...invocation, onTiming: (timing) => { contextTiming = structuredClone(timing); },
						onDecisions: (values) => { contextDecisions = structuredClone(values); },
					});
				},
			} : undefined, (value) => { routing = structuredClone(value); });
			if (controller.signal.aborted || !enabled) {
				outcome = interrupted();
				return;
			}
			if (result.status === "skipped") {
				outcome = { status: "kept", reason: result.reason };
				return;
			}

			const { plan } = result;
			if (initialRevision !== selectionRevision || !modelsAreEqual(ctx.model, plan.model) || (ctx.thinkingLevel ?? "off") !== previousEffort) {
				outcome = { status: "kept", reason: "Model or effort changed during selection" };
				return;
			}
			// The notification from our own setter must not cancel the completed decision.
			if (activeSelection === controller) activeSelection = undefined;
			if (previousEffort !== plan.effort) pi.setThinkingLevel(plan.effort);
			outcome = { status: "selected", reason: plan.reason };
		} catch (error) {
			outcome = controller.signal.aborted
				? interrupted()
				: { status: "kept", reason: errorMessage(error) };
		} finally {
			if (activeSelection === controller) activeSelection = undefined;
			if (!stopped) {
				ctx.ui.setWidget(PROGRESS_KEY, undefined);
				lastDecision = {
					...outcome,
					model: ctx.model ? modelKey(ctx.model) : "none",
					previousEffort,
					effort: ctx.thinkingLevel ?? "off",
					routerModel,
					routerEffort,
					...(routerConfidence !== undefined ? { routerConfidence } : {}),
					...(prepareMs !== undefined ? { prepareMs } : {}),
					...(jevTiming ? { jevTiming: structuredClone(jevTiming) } : {}),
					...(contextTiming ? { contextTiming: structuredClone(contextTiming) } : {}),
					...(contextDecisions ? { contextDecisions: structuredClone(contextDecisions) } : {}),
					...(routerProbabilities ? { routerProbabilities: { ...routerProbabilities } } : {}),
					...(routing ? { routing: structuredClone(routing) } : {}),
					...(Object.keys(selectorUsage).length ? { selectorUsage: structuredClone(selectorUsage) } : {}),
					elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
				};
				pi.appendEntry(DECISION_ENTRY_TYPE, lastDecision);
				updateFooter(ctx, enabled);
			}
		}
	});
}

async function planForEvent(
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
	signal: AbortSignal,
	complete: CompleteRouter,
	jev?: JevBackend,
	onDiagnostics?: (value: RoutingDiagnostics) => void,
) {
	const contextEntries = ctx.sessionManager.buildContextEntries();
	return withAbort(planEffort(
		{
			task: event.prompt,
			hasImages: (event.images?.length ?? 0) > 0 || hasContextImages(contextEntries),
			currentModel: ctx.model,
			currentEffort: ctx.thinkingLevel ?? "off",
			history: collectHistory(contextEntries),
			signal,
			...(onDiagnostics ? { onDiagnostics } : {}),
		},
		complete,
		jev,
	), signal);
}

async function completeRouter(
	ctx: ExtensionContext,
	invocation: RouterInvocation,
	onUsage: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) => void,
): Promise<string> {
	const provider = ctx.modelRegistry.getProvider(invocation.model.provider);
	if (!provider) throw new Error(`provider is unavailable for ${modelKey(invocation.model)}`);
	let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
	try { auth = await ctx.modelRegistry.getApiKeyAndHeaders(invocation.model); }
	catch { throw new Error("router authentication failed"); }
	invocation.signal.throwIfAborted();
	if (!auth.ok) throw new Error("router authentication failed");

	// Provider exceptions can echo request bodies or credentials, not just status codes.
	let response: AssistantMessage;
	try {
		response = await provider.streamSimple(
			auth.baseUrl ? { ...invocation.model, baseUrl: auth.baseUrl } : invocation.model,
			{
				systemPrompt: invocation.systemPrompt,
				messages: [{
					role: "user",
					content: [{ type: "text", text: invocation.userPrompt }],
					timestamp: Date.now(),
				}],
			},
			{
				...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
				...(auth.headers !== undefined ? { headers: auth.headers } : {}),
				...(auth.env !== undefined ? { env: auth.env } : {}),
				signal: invocation.signal,
				maxTokens: Math.min(ROUTER_MAX_OUTPUT_TOKENS, invocation.model.maxTokens),
				cacheRetention: "none",
				sessionId: uuidv7(),
				reasoning: invocation.effort,
			},
		).result();
	} catch { throw new Error("router request failed"); }

	onUsage({ input: response.usage.input, output: response.usage.output, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, cost: response.usage.cost.total });
	if (response.stopReason === "aborted") throw new Error("router timed out");
	if (response.stopReason === "length") throw new Error("router reached the output limit");
	if (response.stopReason === "error") throw new Error("router request failed");
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!text) throw new Error("router returned no decision");
	return text;
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("router timed out"));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function updateFooter(ctx: ExtensionContext, enabled: boolean, effort: ModelThinkingLevel = ctx.thinkingLevel ?? "off"): void {
	ctx.ui.setStatus(STATUS_KEY, enabled ? formatAutoEffort(ctx.ui.theme, effort) : undefined);
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
