import {
	getSupportedThinkingLevels,
	modelsAreEqual,
	uuidv7,
	type Api,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planEffort, type CompleteRouter, type RouterInvocation } from "./router.ts";
import { collectRecentContext, hasContextImages } from "./session-context.ts";
import { DECISION_ENTRY_TYPE, formatAutoEffort, readDecision, renderDecisionEntry, type EffortDecision } from "./selection-ui.ts";

const ROUTER_TIMEOUT_MS = 20_000;
const ROUTER_MAX_OUTPUT_TOKENS = 2_048;
const STATUS_KEY = "pi-auto";
const PROGRESS_KEY = "pi-auto-selecting";

export default function piAuto(pi: ExtensionAPI): void {
	let enabled = true;
	let lastDecision: EffortDecision | undefined;
	let activeSelection: AbortController | undefined;
	let stopped = false;

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
				showStatus(ctx, enabled, lastDecision);
				return;
			}
			ctx.ui.notify("Usage: /auto [toggle|on|off|status]", "warning");
		},
	});

	const restore = (ctx: ExtensionContext) => {
		lastDecision = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			const decision = readDecision(entry);
			if (decision) lastDecision = decision;
		}
		updateFooter(ctx, enabled);
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => updateFooter(ctx, enabled));
	pi.on("thinking_level_select", (event, ctx) => updateFooter(ctx, enabled, event.level));
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
		const previousEffort = ctx.thinkingLevel ?? "off";
		let routerModel: string | undefined;
		let routerEffort: EffortDecision["routerEffort"];
		let outcome: Pick<EffortDecision, "status" | "reason"> = { status: "kept", reason: "Selection interrupted" };
		ctx.ui.setWidget(PROGRESS_KEY, [ctx.ui.theme.fg("accent", "Choosing effort…")]);
		try {
			const result = await planForEvent(event, ctx, signal, (invocation) => {
				routerModel = modelKey(invocation.model);
				routerEffort = invocation.effort;
				return completeRouter(ctx, invocation);
			});
			if (controller.signal.aborted || !enabled) {
				outcome = { status: "cancelled", reason: "Auto disabled during selection" };
				return;
			}
			if (result.status === "skipped") {
				outcome = { status: "kept", reason: result.reason };
				return;
			}

			const { plan } = result;
			if (!modelsAreEqual(ctx.model, plan.model) || (ctx.thinkingLevel ?? "off") !== previousEffort) {
				outcome = { status: "kept", reason: "Model or effort changed during selection" };
				return;
			}
			if (previousEffort !== plan.effort) pi.setThinkingLevel(plan.effort);
			outcome = { status: "selected", reason: plan.reason };
		} catch (error) {
			outcome = controller.signal.aborted
				? { status: "cancelled", reason: "Auto disabled during selection" }
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
) {
	const contextEntries = ctx.sessionManager.buildContextEntries();
	return withAbort(planEffort(
		{
			task: event.prompt,
			hasImages: (event.images?.length ?? 0) > 0 || hasContextImages(contextEntries),
			currentModel: ctx.model,
			currentEffort: ctx.thinkingLevel ?? "off",
			recentContext: collectRecentContext(contextEntries),
			signal,
		},
		complete,
	), signal);
}

async function completeRouter(ctx: ExtensionContext, invocation: RouterInvocation): Promise<string> {
	const provider = ctx.modelRegistry.getProvider(invocation.model.provider);
	if (!provider) throw new Error(`provider is unavailable for ${modelKey(invocation.model)}`);
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(invocation.model);
	invocation.signal.throwIfAborted();
	if (!auth.ok) throw new Error(auth.error);

	// The simple API maps effort to each provider's native thinking controls.
	const response = await provider.streamSimple(
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

	if (response.stopReason === "aborted") throw new Error("router timed out");
	if (response.stopReason === "length") throw new Error("router reached the output limit");
	if (response.stopReason === "error") throw new Error(response.errorMessage || "router request failed");
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

function showStatus(ctx: ExtensionContext, enabled: boolean, last: EffortDecision | undefined): void {
	const lines = [
		`pi-auto is ${enabled ? "enabled" : "disabled"} (effort only)`,
		`Current model: ${ctx.model ? modelKey(ctx.model) : "none"}`,
		`Current effort: ${ctx.thinkingLevel ?? "off"}`,
		`Supported efforts: ${ctx.model ? getSupportedThinkingLevels(ctx.model).join(", ") || "none" : "none"}`,
	];
	if (last) {
		lines.push(`Last decision: ${last.model} @ ${last.effort} (${last.status})`);
		lines.push(`Reason: ${last.reason}`);
		lines.push(`Selector effort: ${last.routerEffort ?? "not called"}`);
	}
	ctx.ui.notify(lines.join("\n"), ctx.model ? "info" : "warning");
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
