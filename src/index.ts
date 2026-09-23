import {
	getSupportedThinkingLevels,
	clampThinkingLevel,
	modelsAreEqual,
	uuidv7,
	type Api,
	type AssistantMessage,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { SettingsManager, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planEffort, ROUTER_RESPONSE_TEXT_LIMIT, type RouterResponseDiagnostics, type CompleteRouter, type RouterInvocation, type JevBackend, type RoutingDiagnostics } from "./router.ts";
import { JEV_MODEL, selectWithJev, classifyWithJev, type JevTiming } from "./jev.ts";
import { collectHistory, hasContextImages } from "./session-context.ts";
import { createSelectingWidget, DECISION_ENTRY_TYPE, formatAutoEffort, readDecision, renderDecisionEntry, type EffortDecision } from "./selection-ui.ts";
import { showAutoStatus } from "./status-ui.ts";
import { createJevTransport } from "./jev-transport.ts";

const ROUTER_TIMEOUT_MS = 10_000;
const ROUTER_MAX_OUTPUT_TOKENS = 2_048;
const STATUS_KEY = "pi-auto";
const PROGRESS_KEY = "pi-auto-selecting";

export default function piAuto(pi: ExtensionAPI): void {
	const jevTransport = createJevTransport();
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
	pi.on("session_shutdown", async (_event, ctx) => {
		stopped = true;
		activeSelection?.abort();
		ctx.ui.setWidget(PROGRESS_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await jevTransport.dispose();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled || stopped || ctx.signal?.aborted) return;
		const controller = new AbortController();
		const userSignal = ctx.signal;
		const onUserAbort = () => controller.abort("user_cancelled");
		userSignal?.addEventListener("abort", onUserAbort, { once: true });
		activeSelection = controller;
		const initialModel = ctx.model;
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
		const selectorResponses: NonNullable<EffortDecision["selectorResponses"]> = {};
		const debugResponses = process.env.PI_AUTO_DEBUG === "1";
		const interrupted = (): Pick<EffortDecision, "status" | "reason"> => controller.signal.reason === "settings_changed"
			? { status: "kept", reason: "Model, effort or session changed during selection" }
			: { status: "cancelled", reason: controller.signal.reason === "user_cancelled" ? "Selection cancelled by user" : "Auto disabled during selection" };
		const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
		const settingsChanged = () => initialRevision !== selectionRevision || !modelsAreEqual(ctx.model, initialModel) ||
			(ctx.thinkingLevel ?? "off") !== previousEffort;
		let primaryFailure: string | undefined;
		let outcome: Pick<EffortDecision, "status" | "reason"> = { status: "kept", reason: "Selection interrupted" };
		const runSelection = async (useJev: boolean) => {
			const attempt = new AbortController();
			const signal = AbortSignal.any([controller.signal, attempt.signal, AbortSignal.timeout(ROUTER_TIMEOUT_MS)]);
			let acceptingDiagnostics = true;
			try {
				return await planForEvent(event, ctx, signal, (invocation) => {
					prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
					routerModel = modelKey(invocation.model);
					routerEffort = invocation.effort;
					return completeRouter(ctx, invocation, debugResponses,
						(usage) => { if (acceptingDiagnostics) selectorUsage[invocation.purpose] = usage; },
						(response) => { if (acceptingDiagnostics) selectorResponses[invocation.purpose] = response; });
				}, useJev && typesafeApiKey ? {
					select: async (invocation) => {
						prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
						routerModel = `typesafe/${JEV_MODEL}`;
						const decision = await selectWithJev(typesafeApiKey, {
							...invocation, onTiming: (timing) => { if (acceptingDiagnostics) jevTiming = structuredClone(timing); },
						}, jevTransport.fetch);
						if (acceptingDiagnostics) {
							routerModel = `typesafe/${decision.model}`;
							routerConfidence = decision.confidence;
							routerProbabilities = { ...decision.probabilities };
						}
						return decision;
					},
					classify: async (invocation) => {
						prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
						routerModel = `typesafe/${JEV_MODEL}`;
						return classifyWithJev(typesafeApiKey, {
							...invocation, onTiming: (timing) => { if (acceptingDiagnostics) contextTiming = structuredClone(timing); },
							onDecisions: (values) => { if (acceptingDiagnostics) contextDecisions = structuredClone(values); },
						}, jevTransport.fetch);
					},
				} : undefined, (value) => { if (acceptingDiagnostics) routing = structuredClone(value); });
			} finally {
				// Freeze this attempt's diagnostics before aborting any non-cooperative work.
				acceptingDiagnostics = false;
				attempt.abort();
			}
		};
		ctx.ui.setWidget(PROGRESS_KEY, createSelectingWidget);
		try {
			let result;
			try {
				result = await runSelection(Boolean(typesafeApiKey));
			} catch (error) {
				if (!typesafeApiKey || controller.signal.aborted || !enabled || stopped || settingsChanged()) throw error;
				primaryFailure = errorMessage(error);
				routerModel = undefined;
				routerEffort = undefined;
				routerConfidence = undefined;
				routerProbabilities = undefined;
				contextDecisions = undefined;
				routing = undefined;
				result = await runSelection(false);
			}
			if (controller.signal.aborted || !enabled) {
				outcome = interrupted();
				return;
			}
			if (result.status === "skipped") {
				outcome = { status: "kept", reason: primaryFailure
					? `Jev failed (${primaryFailure}); current-model fallback skipped: ${result.reason}` : result.reason };
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
			outcome = { status: "selected", reason: primaryFailure
				? `Jev failed (${primaryFailure}); current-model fallback: ${plan.reason}` : plan.reason };
		} catch (error) {
			if (controller.signal.aborted || !enabled || stopped) {
				outcome = interrupted();
			} else if (settingsChanged()) {
				outcome = { status: "kept", reason: "Model or effort changed during selection" };
			} else {
				const failure = primaryFailure ? `Jev failed (${primaryFailure}); current-model fallback failed: ${errorMessage(error)}` : errorMessage(error);
				try {
					if (!initialModel) throw new Error("No current model is selected");
					const effort = configuredDefaultEffort(ctx, initialModel);
					if (activeSelection === controller) activeSelection = undefined;
					if (previousEffort !== effort) pi.setThinkingLevel(effort);
					outcome = { status: previousEffort === effort ? "kept" : "selected", reason: `${failure}; restored Pi default effort (${effort})` };
				} catch {
					outcome = { status: "kept", reason: `${failure}; Pi default effort unavailable` };
				}
			}
		} finally {
			userSignal?.removeEventListener("abort", onUserAbort);
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
					...(Object.keys(selectorResponses).length ? { selectorResponses: structuredClone(selectorResponses) } : {}),
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
	debugResponses: boolean,
	onUsage: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) => void,
	onResponse: (response: RouterResponseDiagnostics) => void,
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
				maxRetries: 0,
				maxTokens: Math.min(ROUTER_MAX_OUTPUT_TOKENS, invocation.model.maxTokens),
				cacheRetention: "none",
				sessionId: uuidv7(),
				reasoning: invocation.effort,
			},
		).result();
	} catch { throw new Error("router request failed"); }

	onUsage({ input: response.usage.input, output: response.usage.output, cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, cost: response.usage.cost.total });
	const text = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	// Capture before validation so empty, truncated and rejected replies remain diagnosable.
	onResponse({
		stopReason: response.stopReason,
		contentTypes: [...new Set(response.content.map((part) => part.type))],
		textCharacters: text.length,
		...(debugResponses ? { rawText: text.slice(0, ROUTER_RESPONSE_TEXT_LIMIT), rawTextTruncated: text.length > ROUTER_RESPONSE_TEXT_LIMIT } : {}),
	});
	if (response.stopReason === "aborted") throw new Error("router timed out");
	if (response.stopReason === "length") throw new Error("router reached the output limit");
	if (response.stopReason === "error") throw new Error("router request failed");
	if (!text.trim()) throw new Error("router returned no decision");
	return text.trim();
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

function configuredDefaultEffort(ctx: ExtensionContext, model: Model<Api>): ModelThinkingLevel {
	const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
	if (settings.drainErrors().length) throw new Error("Pi default effort settings could not be read");
	// Match Pi's per-model/global precedence and its built-in default when neither is configured.
	const perModel = settings.getModelThinkingLevel(model.provider, model.id);
	const global = settings.getDefaultThinkingLevel();
	const effort = perModel !== undefined ? perModel : global !== undefined ? global : "medium";
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("Invalid Pi default effort");
	return clampThinkingLevel(model, effort);
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
