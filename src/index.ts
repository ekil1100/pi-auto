import { join } from "node:path";
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
import { matchesKey } from "@earendil-works/pi-tui";
import { getAgentDir, SettingsManager, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planEffort, ROUTER_RESPONSE_TEXT_LIMIT, type RouterResponseDiagnostics, type CompleteRouter, type RouterInvocation, type RoutingDiagnostics } from "./router.ts";
import { selectWithClassifier, type SelectClassifier, type ClassifierTiming, type ClassifierDiagnostics } from "./classifier.ts";
import { collectHistory, hasContextImages } from "./session-context.ts";
import { createSelectingWidget, DECISION_ENTRY_TYPE, readDecision, renderDecisionEntry, type EffortDecision, type SelectionAttempt } from "./selection-ui.ts";
import { showAutoStatus } from "./status-ui.ts";
import { readSettings, writeSettings, backendLabel, type SelectorBackend } from "./settings.ts";
import { availableClassifiers, defaultBackend } from "./backends.ts";
import { showModelSelector } from "./model-selector.ts";

const ROUTER_TIMEOUT_MS = 10_000;
const ROUTER_MAX_OUTPUT_TOKENS = 2_048;
const STATUS_KEY = "pi-auto";
const PROGRESS_KEY = "pi-auto-selecting";

export default function piAuto(pi: ExtensionAPI): void {
	const settingsPath = join(getAgentDir(), "pi-auto.json");
	let enabled: boolean;
	let backend: SelectorBackend | undefined;
	let settingsLoadFailed = false;
	let resolveInitialCurrentModel = false;
	try {
		const settings = readSettings(settingsPath);
		enabled = settings.defaultEnabled ?? true;
		resolveInitialCurrentModel = settings.backend?.type === "current-model";
		backend = settings.backend?.type === "current-model" ? undefined : settings.backend;
	}
	catch { enabled = false; settingsLoadFailed = true; }
	let upgradeWarningShown = false;
	const requireRuntime = (ctx: ExtensionContext): boolean => {
		if (typeof ctx.modelRegistry.classify === "function" && typeof ctx.modelRegistry.getAvailableOfType === "function") return true;
		enabled = false;
		if (!upgradeWarningShown) {
			upgradeWarningShown = true;
			const message = "pi-auto requires Pi 0.99.0 or later. Upgrade Pi (npm install -g @earendil-works/pi-coding-agent@latest) and restart; pi-auto is disabled.";
			if (ctx.hasUI || ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.notify(message, "error");
			else console.error(message);
		}
		return false;
	};
	let lastDecision: EffortDecision | undefined;
	let activeSelection: AbortController | undefined;
	let stopped = false;
	let selectionRevision = 0;
	let pickerOpen = false;
	const ownEffortChanges: { level: ModelThinkingLevel; previousLevel: ModelThinkingLevel }[] = [];
	const applyEffort = (level: ModelThinkingLevel, previousLevel: ModelThinkingLevel) => {
		// Pi dispatches this notification asynchronously; earlier extensions may delay it.
		const change = { level, previousLevel };
		ownEffortChanges.push(change);
		try { pi.setThinkingLevel(level); }
		catch (error) {
			const index = ownEffortChanges.indexOf(change);
			if (index >= 0) ownEffortChanges.splice(index, 1);
			throw error;
		}
	};
	const invalidateSelection = (reason = "settings_changed") => {
		selectionRevision++;
		activeSelection?.abort(reason);
	};

	const updateFooter = (ctx: ExtensionContext, active: boolean) => {
		ctx.ui.setStatus(STATUS_KEY, active
			? ctx.ui.theme.fg("accent", "auto") + ctx.ui.theme.fg("dim", ` · ${backendLabel(backend)}`)
			: undefined);
	};
	let initializing: Promise<void> | undefined;
	const ensureBackend = (ctx: ExtensionContext): Promise<void> => {
		if (backend) return Promise.resolve();
		if (initializing) return initializing;
		const revision = selectionRevision;
		initializing = (async () => {
			try {
				const signal = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
				const models = resolveInitialCurrentModel ? [] : await withAbort(availableClassifiers(ctx.modelRegistry, signal), signal);
				if (stopped || revision !== selectionRevision || backend) return;
				const selected = defaultBackend(models, ctx.model);
				if (!selected) { updateFooter(ctx, enabled); return; }
				writeSettings(settingsPath, { backend: selected });
				backend = selected;
				resolveInitialCurrentModel = false;
				if (selected.type === "classifier") {
					const message = `pi-auto selected ${backendLabel(selected)}, an available classifier in Pi, and saved it as the effort selector. It will receive your current task and recent-turn selection context. Use /auto model to change this, or choose a fixed chat model in the chat model tab.`;
					if (ctx.mode === "tui" || ctx.mode === "rpc") ctx.ui.notify(message, "info");
					else console.error(message);
				}
				updateFooter(ctx, enabled);
			} catch {
				// Failed discovery must not permanently save an accidental current-model default.
				if (stopped || revision !== selectionRevision) return;
				ctx.ui.notify("Could not initialize pi-auto selector settings; using current chat model for now. Use /auto model to retry.", "warning");
			}
		})().finally(() => { initializing = undefined; });
		return initializing;
	};

	pi.registerEntryRenderer(DECISION_ENTRY_TYPE, renderDecisionEntry);
	pi.registerCommand("auto", {
		description: "Control automatic effort selection (toggle, on, off, model, status, default on/off)",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase().replace(/\s+/g, " ");
			const matches = ["toggle", "on", "off", "model", "status", "default on", "default off"]
				.filter((value) => value.startsWith(normalized));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			if (!requireRuntime(ctx)) return;
			const action = args.trim().toLowerCase().replace(/\s+/g, " ") || "toggle";
			if (action === "default on" || action === "default off") {
				try {
					writeSettings(settingsPath, { defaultEnabled: action === "default on" });
					invalidateSelection(action === "default off" ? "auto_disabled" : "settings_changed");
					settingsLoadFailed = false;
					enabled = action === "default on";
					updateFooter(ctx, enabled);
					ctx.ui.notify(`pi-auto ${enabled ? "enabled" : "disabled"}; startup default saved as ${enabled ? "on" : "off"}.`, "info");
				} catch {
					ctx.ui.notify("Could not save pi-auto startup default; current state unchanged.", "error");
				}
				return;
			}
			if (action === "toggle" || action === "on" || action === "off") {
				enabled = action === "toggle" ? !enabled : action === "on";
				if (!enabled) invalidateSelection("auto_disabled");
				updateFooter(ctx, enabled);
				ctx.ui.notify(enabled ? "pi-auto enabled (effort only)" : "pi-auto disabled", "info");
				return;
			}
			if (action === "model") {
				if (ctx.mode !== "tui") {
					const message = "/auto model requires an interactive TUI. Open Pi in a terminal to change the effort selector.";
					if (ctx.hasUI || ctx.mode === "rpc") ctx.ui.notify(message, "warning");
					else console.error(message);
					return;
				}
				const revision = selectionRevision;
				try {
					const signal = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
					const [chat, classifier] = await withAbort(Promise.all([
						ctx.modelRegistry.getAvailableOfType("chat", undefined, { signal }),
						availableClassifiers(ctx.modelRegistry, signal),
					]), signal);
					if (stopped || revision !== selectionRevision) return;
					pickerOpen = true;
					let selected: SelectorBackend | undefined;
					try { selected = await showModelSelector(ctx, { chat, classifier }, backend); }
					finally { pickerOpen = false; }
					if (!selected || stopped || revision !== selectionRevision) return;
					writeSettings(settingsPath, { backend: selected });
					backend = selected;
					resolveInitialCurrentModel = false;
					invalidateSelection();
					updateFooter(ctx, enabled);
					ctx.ui.notify(`Effort selector saved: ${backendLabel(selected)}.`, "info");
				} catch {
					if (stopped || revision !== selectionRevision) return;
					ctx.ui.notify("Could not load or save the effort selector; current setting unchanged. Check Pi credentials and pi-auto.json permissions, then retry /auto model.", "error");
				}
				return;
			}
			if (action === "status") {
				const configured = backend;
				const currentModel = ctx.model;
				const snapshot = { enabled, effort: ctx.thinkingLevel ?? "off", last: lastDecision };
				let availability: string;
				try {
					if (configured) {
						const signal = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
						const models = await withAbort(ctx.modelRegistry.getAvailableOfType(configured.type, configured.provider, { signal }), signal);
						const sameAsAnswer = configured.type === "chat" && currentModel?.provider === configured.provider && currentModel.id === configured.id;
						availability = models.some((model) => model.provider === configured.provider && model.id === configured.id)
							? "available (Pi credentials configured)"
							: !currentModel ? "unavailable; no answering model selected"
							: sameAsAnswer ? "unavailable; uses Pi default effort (no duplicate request)"
							: "unavailable; falls back to the answering model, then Pi default effort";
					} else availability = "not selected; choose a model with /auto model";
				} catch { availability = "unknown (Pi availability check failed)"; }
				if (stopped) return;
				await showAutoStatus(ctx, {
					enabled: snapshot.enabled,
					model: currentModel ? modelKey(currentModel) : "none",
					effort: snapshot.effort,
					backend: configured ? `${configured.type}: ${backendLabel(configured)}` : "Not selected",
					availability,
					supportedEfforts: currentModel ? getSupportedThinkingLevels(currentModel) : [],
					...(snapshot.last ? { last: snapshot.last } : {}),
				});
				return;
			}
			ctx.ui.notify("Usage: /auto [toggle|on|off|model|status|default on|default off]", "warning");
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
	pi.on("session_start", async (_event, ctx) => {
		if (!requireRuntime(ctx)) return;
		if (settingsLoadFailed) ctx.ui.notify("Could not load pi-auto settings; automatic selection is disabled. Repair pi-auto.json before saving, or use /auto on for this instance.", "warning");
		restore(ctx);
		if (!settingsLoadFailed) await ensureBackend(ctx);
	});
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", async (_event, ctx) => { invalidateSelection(); updateFooter(ctx, enabled); if (!settingsLoadFailed) await ensureBackend(ctx); });
	pi.on("thinking_level_select", (event, ctx) => {
		const own = ownEffortChanges.findIndex((change) => change.level === event.level && change.previousLevel === event.previousLevel);
		if (own >= 0) ownEffortChanges.splice(own, 1);
		else invalidateSelection();
		// A delayed notification may describe an effort that is no longer active.
		updateFooter(ctx, enabled);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopped = true;
		activeSelection?.abort("session_shutdown");
		ctx.ui.setWidget(PROGRESS_KEY, undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!requireRuntime(ctx) || !enabled || stopped || ctx.signal?.aborted) return;
		if (activeSelection) invalidateSelection();
		const controller = new AbortController();
		const userSignal = ctx.signal;
		const onUserAbort = () => controller.abort("runtime_cancelled");
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
		let classifierTiming: ClassifierTiming | undefined;
		let classifierDiagnostics: ClassifierDiagnostics | undefined;
		let routerProbabilities: Record<string, number> | undefined;
		let routing: RoutingDiagnostics | undefined;
		const selectorAttempts: SelectionAttempt[] = [];
		const selectorUsage: NonNullable<EffortDecision["selectorUsage"]> = {};
		const selectorResponses: NonNullable<EffortDecision["selectorResponses"]> = {};
		const debugResponses = process.env.PI_AUTO_DEBUG === "1";
		const interrupted = (): Pick<EffortDecision, "status" | "reason"> => controller.signal.reason === "settings_changed"
			? { status: "kept", reason: "Model, effort or session changed during selection" }
			: { status: "cancelled", reason: controller.signal.reason === "user_cancelled" ? "Selection cancelled by user" :
				controller.signal.reason === "runtime_cancelled" ? "Selection cancelled by runtime" :
				controller.signal.reason === "session_shutdown" ? "Session shut down during selection" : "Auto disabled during selection" };
		let configured = backend;
		let actualBackend: string | undefined;
		const settingsChanged = () => initialRevision !== selectionRevision || (ctx.model !== initialModel && !modelsAreEqual(ctx.model, initialModel)) ||
			(ctx.thinkingLevel ?? "off") !== previousEffort;
		let primaryFailure: string | undefined;
		let outcome: Pick<EffortDecision, "status" | "reason"> = { status: "kept", reason: "Selection interrupted" };
		const runSelection = async (selectedBackend: SelectorBackend | undefined) => {
			const attempt = new AbortController();
			const deadline = AbortSignal.timeout(ROUTER_TIMEOUT_MS);
			const signal = AbortSignal.any([controller.signal, attempt.signal, deadline]);
			const attemptStartedAt = performance.now();
			const trace: SelectionAttempt = {
				backend: selectedBackend?.type ?? "current-model", outcome: "failed", timeoutMs: ROUTER_TIMEOUT_MS, elapsedMs: 0,
			};
			let acceptingDiagnostics = true;
			try {
				let selectorModel: Model<Api> | undefined;
				// No request or availability check is needed for a single-choice answering model.
				if (selectedBackend?.type === "chat" && ctx.model && getSupportedThinkingLevels(ctx.model).length > 1) {
					try {
						const models = await withAbort(ctx.modelRegistry.getAvailableOfType("chat", selectedBackend.provider, { signal }), signal);
						signal.throwIfAborted();
						selectorModel = models.find((model) => model.provider === selectedBackend.provider && model.id === selectedBackend.id);
					} catch { throw new Error("Chat selector availability check failed"); }
					if (!selectorModel) throw new Error("Chat selector unavailable in Pi");
				}
				const result = await planForEvent(event, ctx, signal, (invocation) => {
					prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
					actualBackend = `${modelKey(invocation.model)}${primaryFailure ? " (fallback)" : ""}`;
					routerModel = modelKey(invocation.model);
					routerEffort = invocation.effort;
					return completeRouter(ctx, invocation, debugResponses,
						(usage) => { if (acceptingDiagnostics) selectorUsage[invocation.purpose] = usage; },
						(response) => { if (acceptingDiagnostics) selectorResponses[invocation.purpose] = response; });
				}, selectedBackend?.type === "classifier" ? async (invocation) => {
					prepareMs ??= Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);
					actualBackend = backendLabel(selectedBackend);
					routerModel = actualBackend;
					const decision = await selectWithClassifier(ctx.modelRegistry, {
						...invocation, debugResponses,
						onTiming: (timing) => { if (acceptingDiagnostics) classifierTiming = structuredClone(timing); },
						onDiagnostics: (value) => { if (acceptingDiagnostics) classifierDiagnostics = structuredClone(value); },
					}, selectedBackend);
					if (acceptingDiagnostics) {
						routerModel = backendLabel(selectedBackend);
						routerConfidence = decision.confidence;
						routerProbabilities = { ...decision.probabilities };
					}
					return decision;
				} : undefined, (value) => { if (acceptingDiagnostics) routing = structuredClone(value); }, selectorModel);
				trace.outcome = result.status;
				if (result.status === "selected" && !routerModel) actualBackend = "default";
				if (result.status === "skipped") trace.reason = result.reason;
				return result;
			} catch (error) {
				if (controller.signal.aborted) {
					trace.outcome = "cancelled";
					trace.interruption = cancellationSource(controller.signal.reason);
				} else if (deadline.aborted) trace.interruption = "deadline";
				else if (["router provider aborted the request", "Classifier provider aborted the request"].includes(errorMessage(error))) trace.interruption = "provider";
				trace.reason = trace.interruption === "deadline" ? "router timed out" :
					trace.outcome === "cancelled" ? interrupted().reason : errorMessage(error);
				throw new Error(trace.reason);
			} finally {
				trace.elapsedMs = Math.max(0, Math.round(performance.now() - attemptStartedAt));
				selectorAttempts.push(trace);
				// Freeze this attempt's diagnostics before aborting any non-cooperative work.
				acceptingDiagnostics = false;
				attempt.abort();
			}
		};
		let removeTerminalInput: (() => void) | undefined;
		ctx.ui.setWidget(PROGRESS_KEY, createSelectingWidget);
		try {
			if (ctx.mode === "tui") {
				removeTerminalInput = ctx.ui.onTerminalInput((data) => {
					if (pickerOpen || !matchesKey(data, "escape")) return;
					controller.abort("user_cancelled");
					return { consume: true };
				});
			}
			await withAbort(ensureBackend(ctx), controller.signal);
			controller.signal.throwIfAborted();
			if (settingsChanged() || stopped || !enabled) return;
			configured = backend;
			let result;
			try {
				result = await runSelection(configured);
			} catch (error) {
				const sameAsAnswer = configured?.type === "chat" && initialModel?.provider === configured.provider && initialModel.id === configured.id;
				if (!configured || sameAsAnswer || controller.signal.aborted || !enabled || stopped || settingsChanged()) throw error;
				primaryFailure = errorMessage(error);
				routerModel = undefined;
				routerEffort = undefined;
				routerConfidence = undefined;
				routerProbabilities = undefined;
				routing = undefined;
				result = await runSelection(undefined);
			}
			if (controller.signal.aborted || !enabled) {
				outcome = interrupted();
				return;
			}
			if (result.status === "skipped") {
				outcome = { status: "kept", reason: primaryFailure
					? `Selector failed (${primaryFailure}); current-model fallback skipped: ${result.reason}` : result.reason };
				return;
			}

			const { plan } = result;
			if (initialRevision !== selectionRevision || !modelsAreEqual(ctx.model, plan.model) || (ctx.thinkingLevel ?? "off") !== previousEffort) {
				outcome = { status: "kept", reason: "Model or effort changed during selection" };
				return;
			}
			// The notification from our own setter must not cancel the completed decision.
			if (activeSelection === controller) activeSelection = undefined;
			if (previousEffort !== plan.effort) applyEffort(plan.effort, previousEffort);
			outcome = { status: "selected", reason: primaryFailure
				? `Selector failed (${primaryFailure}); current-model fallback: ${plan.reason}` : plan.reason };
		} catch (error) {
			if (controller.signal.aborted || !enabled || stopped) {
				outcome = interrupted();
			} else if (settingsChanged()) {
				outcome = { status: "kept", reason: "Model or effort changed during selection" };
			} else {
				const failure = primaryFailure ? `Selector failed (${primaryFailure}); current-model fallback failed: ${errorMessage(error)}` : errorMessage(error);
				try {
					if (!initialModel) throw new Error("No current model is selected");
					const effort = configuredDefaultEffort(ctx, initialModel);
					if (activeSelection === controller) activeSelection = undefined;
					if (previousEffort !== effort) applyEffort(effort, previousEffort);
					actualBackend = "default";
					outcome = { status: previousEffort === effort ? "kept" : "selected", reason: `${failure}; restored Pi default effort (${effort})` };
				} catch {
					outcome = { status: "kept", reason: `${failure}; Pi default effort unavailable` };
				}
			}
		} finally {
			removeTerminalInput?.();
			userSignal?.removeEventListener("abort", onUserAbort);
			if (!activeSelection || activeSelection === controller) ctx.ui.setWidget(PROGRESS_KEY, undefined);
			if (activeSelection === controller) activeSelection = undefined;
			if (!stopped && initialRevision === selectionRevision) {
				lastDecision = {
					...outcome,
					...(actualBackend ? { actualBackend } : {}),
					model: ctx.model ? modelKey(ctx.model) : "none",
					previousEffort,
					effort: ctx.thinkingLevel ?? "off",
					routerModel,
					routerEffort,
					...(routerConfidence !== undefined ? { routerConfidence } : {}),
					...(prepareMs !== undefined ? { prepareMs } : {}),
					...(classifierTiming ? { classifierTiming: structuredClone(classifierTiming) } : {}),
					...(classifierDiagnostics ? { classifierDiagnostics: structuredClone(classifierDiagnostics) } : {}),
					...(routerProbabilities ? { routerProbabilities: { ...routerProbabilities } } : {}),
					...(routing ? { routing: structuredClone(routing) } : {}),
					selectorAttempts,
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
	selectClassifier?: SelectClassifier,
	onDiagnostics?: (value: RoutingDiagnostics) => void,
	selectorModel?: Model<Api>,
) {
	const contextEntries = ctx.sessionManager.buildContextEntries();
	return withAbort(planEffort(
		{
			task: event.prompt,
			hasImages: (event.images?.length ?? 0) > 0 || hasContextImages(contextEntries),
			currentModel: ctx.model,
			...(selectorModel ? { selectorModel } : {}),
			currentEffort: ctx.thinkingLevel ?? "off",
			history: collectHistory(contextEntries),
			signal,
			...(onDiagnostics ? { onDiagnostics } : {}),
		},
		complete,
		selectClassifier,
	), signal);
}

async function completeRouter(
	ctx: ExtensionContext,
	invocation: RouterInvocation,
	debugResponses: boolean,
	onUsage: (usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }) => void,
	onResponse: (response: RouterResponseDiagnostics) => void,
): Promise<string> {
	invocation.signal.throwIfAborted();

	// Provider exceptions can echo request bodies or credentials, not just status codes.
	let response: AssistantMessage;
	try {
		// The runtime normalizes system messages and resolves provider authentication.
		response = await ctx.modelRegistry.streamSimple(
			invocation.model,
			{
				systemPrompt: invocation.systemPrompt,
				messages: [{
					role: "user",
					content: [{ type: "text", text: invocation.userPrompt }],
					timestamp: Date.now(),
				}],
			},
			{
				signal: invocation.signal,
				maxRetries: 0,
				maxTokens: Math.min(ROUTER_MAX_OUTPUT_TOKENS, invocation.model.maxTokens),
				cacheRetention: "none",
				sessionId: uuidv7(),
				...(invocation.effort ? { reasoning: invocation.effort } : {}),
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
	if (response.stopReason === "aborted") throw new Error("router provider aborted the request");
	if (response.stopReason === "length") throw new Error("router reached the output limit");
	if (response.stopReason === "error") throw new Error("router request failed");
	if (!text.trim()) throw new Error("router returned no decision");
	return text.trim();
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort: () => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new Error("router request interrupted"));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function cancellationSource(reason: unknown): NonNullable<SelectionAttempt["interruption"]> {
	switch (reason) {
		case "user_cancelled": return "escape";
		case "runtime_cancelled": return "runtime";
		case "auto_disabled": return "auto-off";
		case "settings_changed": return "settings-changed";
		case "session_shutdown": return "session-shutdown";
		default: return "runtime";
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

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
