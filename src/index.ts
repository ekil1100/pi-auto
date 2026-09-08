import { modelsAreEqual, uuidv7, type Api, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	estimateTokens,
	type BeforeAgentStartEvent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { planRoute, type RouterInvocation, type RoutePlan } from "./router.ts";
import { collectRecentContext, hasContextImages } from "./session-context.ts";

const ROUTER_TIMEOUT_MS = 20_000;
const ROUTER_MAX_OUTPUT_TOKENS = 2_048;
const STATUS_KEY = "pi-auto";

interface LastDecision {
	model: string;
	effort: ModelThinkingLevel;
	reason: string;
	routerModel?: string;
}

export default function piAuto(pi: ExtensionAPI): void {
	let enabled = true;
	let lastDecision: LastDecision | undefined;
	let warnedAboutScope = false;

	pi.registerCommand("auto", {
		description: "Manage automatic scoped model and effort routing (on, off, status)",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "on") {
				enabled = true;
				setReadyStatus(ctx);
				ctx.ui.notify("pi-auto enabled", "info");
				return;
			}
			if (action === "off") {
				enabled = false;
				ctx.ui.setStatus(STATUS_KEY, "auto:off");
				ctx.ui.notify("pi-auto disabled", "info");
				return;
			}
			if (action === "status") {
				showStatus(ctx, enabled, lastDecision);
				return;
			}
			ctx.ui.notify("Usage: /auto [on|off|status]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setReadyStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		if (ctx.scopedModels.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, "auto:scope-required");
			if (!warnedAboutScope) {
				warnedAboutScope = true;
				ctx.ui.notify("pi-auto needs at least one model in /scoped-models; keeping the current route", "warning");
			}
			return;
		}

		ctx.ui.setStatus(STATUS_KEY, "auto:routing…");
		try {
			const result = await planForEvent(event, ctx);
			if (result.status === "skipped") {
				ctx.ui.setStatus(STATUS_KEY, "auto:fallback");
				ctx.ui.notify(`pi-auto kept the current route: ${result.reason}`, "warning");
				return;
			}

			const changed = await applyPlan(pi, ctx, result.plan);
			lastDecision = toLastDecision(result.plan);
			ctx.ui.setStatus(STATUS_KEY, `auto:${result.plan.model.id}:${result.plan.effort}`);
			if (changed) {
				ctx.ui.notify(
					`pi-auto → ${modelKey(result.plan.model)} @ ${result.plan.effort}: ${result.plan.reason}`,
					"info",
				);
			}
		} catch (error) {
			ctx.ui.setStatus(STATUS_KEY, "auto:fallback");
			ctx.ui.notify(`pi-auto routing failed; keeping the current route: ${errorMessage(error)}`, "warning");
		}
	});
}

async function planForEvent(event: BeforeAgentStartEvent, ctx: ExtensionContext) {
	const timeoutSignal = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
	const usage = ctx.getContextUsage();
	const contextEntries = ctx.sessionManager.buildContextEntries();
	// Pi has not appended the incoming message during before_agent_start.
	const promptTokens = estimateTokens({
		role: "user",
		content: [{ type: "text", text: event.prompt }, ...(event.images ?? [])],
		timestamp: Date.now(),
	});
	return planRoute(
		{
			task: event.prompt,
			hasImages: (event.images?.length ?? 0) > 0 || hasContextImages(contextEntries),
			scopedModels: ctx.scopedModels,
			currentModel: ctx.model,
			currentEffort: ctx.thinkingLevel ?? "off",
			recentContext: collectRecentContext(contextEntries),
			contextTokens: usage?.tokens == null ? null : usage.tokens + promptTokens,
			signal: timeoutSignal,
		},
		(invocation) => completeRouter(ctx, invocation),
	);
}

async function completeRouter(ctx: ExtensionContext, invocation: RouterInvocation): Promise<string> {
	const response = await ctx.modelRegistry.complete(
		invocation.model,
		{
			systemPrompt: invocation.systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: invocation.userPrompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			signal: invocation.signal,
			maxTokens: Math.min(ROUTER_MAX_OUTPUT_TOKENS, invocation.model.maxTokens),
			cacheRetention: "none",
			sessionId: uuidv7(),
			...(invocation.effort ? { reasoningEffort: invocation.effort } : {}),
		},
	);

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

async function applyPlan(pi: ExtensionAPI, ctx: ExtensionContext, plan: RoutePlan): Promise<boolean> {
	const modelChanged = !modelsAreEqual(ctx.model, plan.model);
	const effortChanged = (ctx.thinkingLevel ?? "off") !== plan.effort;

	if (modelChanged) {
		const success = await pi.setModel(plan.model);
		if (!success) throw new Error(`authentication is unavailable for ${modelKey(plan.model)}`);
	}
	pi.setThinkingLevel(plan.effort);
	return modelChanged || effortChanged;
}

function setReadyStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(STATUS_KEY, "auto:ready");
}

function showStatus(ctx: ExtensionContext, enabled: boolean, last: LastDecision | undefined): void {
	const lines = [
		`pi-auto is ${enabled ? "enabled" : "disabled"}`,
		`Scoped models: ${ctx.scopedModels.length || "none"}`,
	];
	if (last) {
		lines.push(`Last route: ${last.model} @ ${last.effort}`);
		lines.push(`Reason: ${last.reason}`);
		if (last.routerModel) lines.push(`Router: ${last.routerModel}`);
	}
	ctx.ui.notify(lines.join("\n"), ctx.scopedModels.length > 0 ? "info" : "warning");
}

function toLastDecision(plan: RoutePlan): LastDecision {
	return {
		model: modelKey(plan.model),
		effort: plan.effort,
		reason: plan.reason,
		...(plan.routerModel ? { routerModel: modelKey(plan.routerModel) } : {}),
	};
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
