# pi-auto

English | [简体中文](./README.zh-CN.md)

A Pi extension that automatically selects the current model's thinking effort before each task. **It adjusts effort only—never switches your model.**

## Install and use

Requires Node.js **22.19.0 or later** and Pi **0.87.1 or later**.

```bash
pi install npm:pi-auto
```

Choose your model with `/model`; no scoped-model configuration is needed. The extension starts enabled unless you save a different startup default, and the footer shows the current effort, such as `auto · low`.

By default, your current model also selects the effort. You can optionally use Jev as the selector instead.

## Optional: use Jev

Set a TypeSafe API key in the terminal where you start Pi:

```bash
export TYPESAFE_API_KEY="your-api-key"
pi
```

An unset, empty, or whitespace-only key uses the current-model selector. Restart Pi after changing shell environment variables. Use `/auto status` to inspect the configured backend and the latest selection, including any fallback.

**Enabling Jev sends your current task and relevant conversation history to TypeSafe without automatic redaction.** Raw tool results and image data are not sent directly, but assistant replies may contain information obtained through tools. For sensitive tasks, disable automatic selection, or unset the key and restart Pi. See the [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy).

### Proxy support

Jev uses its own Undici connection pool and reads proxy environment variables automatically. **`NODE_USE_ENV_PROXY=1` is not required.**

- Supports `http_proxy`, `https_proxy`, and `no_proxy`, plus their uppercase variants. Lowercase takes precedence.
- HTTPS requests use `https_proxy`, falling back to `http_proxy` when it is not configured. Hosts matched by `no_proxy` bypass the proxy.
- Without these proxy settings, requests connect directly. `ALL_PROXY` / `all_proxy` is not read; if that is your only proxy variable, also set `https_proxy`.
- These settings apply only to this extension's Jev requests, not Pi's global network configuration. A proxy failure does not trigger a direct Jev retry; the current model takes over effort selection.

Restart Pi after changing proxy variables in its launch terminal.

## Commands

| Command | Action |
| --- | --- |
| `/auto` or `/auto toggle` | Toggle automatic selection |
| `/auto on` | Enable automatic selection |
| `/auto off` | Disable automatic selection and cancel a pending selection |
| `/auto status` | Inspect the backend, effort, and latest selection |
| `/auto default on` | Enable automatic selection now and save on as the startup default |
| `/auto default off` | Disable automatic selection now, cancel a pending selection, and save off as the startup default |

`/auto`, `/auto on`, and `/auto off` affect only the current extension instance. `/auto default on|off` saves a global startup default and immediately applies it to the current instance. `default off` also cancels a pending selection. Other running instances are unaffected; restarting or reloading uses the saved default.

The default is saved in `<agent-dir>/pi-auto.json` (normally `~/.pi/agent/pi-auto.json`; respects `PI_CODING_AGENT_DIR`). Without this file, selection starts enabled. Invalid or unreadable settings disable selection with a warning; a failed save leaves the current state unchanged. Pi's own `settings.json` is not modified.

To use a fixed effort, run `/auto off`, then choose a level with `/thinking`. Disabling automatic selection does **not** set effort to `off`.

### Inspect a selection

Selection results appear in the conversation, collapsed by default, with the actual selector model and total selection time: `auto · high · jev-1.13.0 · 0.53s` or `auto · high · gpt-6-astra · 1.20s`. After current-model fallback, the label shows that model rather than Jev; the total time includes both attempts. Use the default **Ctrl+O** shortcut to expand the effort change, reason, selector, elapsed time, and context summary.

In an interactive terminal, `/auto status` opens a read-only overlay with three pages:

- **Overview:** current state and the latest selection, with failure reasons shown first.
- **Context:** source IDs, roles, character ranges, history length, and omission indicators for the latest turn. Message text is not displayed; missing metadata in older records is marked as unrecorded.
- **Diagnostics:** per-attempt outcomes, deadlines and interruption sources; current-model stop reason, content types and response length; policy, effort probabilities, usage and request timing.

Default controls: **Tab** to change pages, **↑↓ / PageUp / PageDown** to scroll, **j / k** to scroll down/up, and **Esc** to close. Explicit custom keybindings take precedence over j/k aliases; follow the displayed hints.

The view is a snapshot taken when opened. Inspecting it does not call a model, rerun selection, or change effort. It shows selection metadata, not request payloads. RPC clients receive the same grouped information as a text notification.

### Debug selector responses

Current-model response metadata is saved in session JSONL entries of type `pi-auto-decision`, under `selectorResponses.effort`. It includes stop reasons, content block types, and text length, also visible on the Diagnostics page of `/auto status`. `selectorAttempts` records each backend's outcome, elapsed time, deadline and interruption source (`deadline`, `escape`, `runtime`, `auto-off`, `settings-changed`, `session-shutdown`, or `provider`). Older records without these fields are marked as unrecorded; a provider abort is not assumed to be a local timeout. Invalid decisions report `not_json_object`, `invalid_json`, `missing_effort`, `invalid_effort_type`, or `unsupported_effort`.

Jev saves `jevDiagnostics` with the last stage (`request`, `response`, `validation`, or `complete`), an error code, and the decoded response type and length when available. These fields appear in `/auto status`; they remain available after current-model fallback. HTTP status, token usage and transport timing are stored separately in `jevTiming`.

| Jev error codes | Meaning |
| --- | --- |
| `request_cancelled`, `request_timeout` | Request cancelled or SDK deadline reached |
| `http_error`, `transport_error`, `response_read_failed` | HTTP failure, transport failure, or failure while reading the response body |
| `invalid_envelope`, `invalid_model`, `invalid_answers` | Invalid top-level response, model ID, or answers object |
| `missing_effort`, `unexpected_answers` | Missing effort answer or unexpected extra answers |
| `invalid_effort_answer`, `invalid_answer_type`, `unsupported_effort` | Invalid effort answer object, wrong answer type, or unsupported effort |
| `invalid_confidence`, `invalid_probabilities`, `probability_keys_mismatch`, `invalid_probability` | Invalid confidence, probability object, option keys, or probability values |
| `probability_sum`, `choice_not_max` | Probability sum outside rounding tolerance, or chosen effort is not a highest-probability option |

Run `PI_AUTO_DEBUG=1 pi` to also capture current-model text in `selectorResponses.effort.rawText` and Jev's decoded successful HTTP response in `jevDiagnostics.rawText`. Jev JSON is re-serialized, not the original HTTP bytes; non-JSON responses are kept as text. Jev's known API key is masked before capture. Each capture is capped at **8,192 UTF-16 code units**, with `rawTextTruncated` indicating truncation. This response-log limit does not restrict selector input. Raw text is not displayed in the status UI or added to the main model's context. Requests, credentials, thinking, tool arguments, and provider error bodies are not recorded.

**Responses may repeat sensitive task information without redaction.** Review logs before sharing them. Restart without the variable to disable capture; existing records remain. Capture includes invalid Jev decisions received over successful HTTP responses, but never HTTP error bodies, request headers or SDK exception bodies. Missing or late responses after cancellation or timeout cannot be captured.

## Failure handling

With Jev enabled, the fallback chain is:

```text
Jev fails once → current model selects effort → if that fails, restore Pi's configured default effort
```

Current-model selection uses Pi's model runtime to normalize system instructions and resolve authentication, rather than calling a provider directly. There are no request retries and no main-model switch. Jev request failures, timeouts, and invalid decisions trigger the current-model fallback. Without Jev, a failed current-model selection also restores the configured default effort.

Both backends use the same context strategy: the previous user input, that turn's final assistant text reply, and the current input (`user + assistant + user`). They make one effort-selection request without classification. Earlier history, summaries, and intermediate progress are excluded. The selected messages are sent in full without local character limits. Without a previous turn, only the current input is sent; an unanswered turn never borrows an older reply.

Each selection has a **10-second deadline**. Current-model fallback after a Jev failure gets a separate deadline, for about 20 seconds total across both attempts. Cancellation does not trigger fallback. Removing classification calls does not prevent selection timeouts.

Default effort is read from Pi's saved global and trusted-project `settings.json` files, in this order:

1. `modelThinkingLevels["provider/modelId"]` for the current model.
2. `defaultThinkingLevel`.
3. Pi's built-in default, `medium`, if neither is configured.

The level is adjusted to the model's capabilities using Pi's rules. The previous automatically selected effort is not treated as the default, and configuration files are not modified. If the relevant configuration is invalid or cannot be read, the current effort is kept and the status explains why.

In interactive terminals, press **Esc** during selection to cancel it, keep the current effort, and continue the main task without fallback or disabling automatic selection. Esc returns to its normal behavior afterward; non-interactive mode does not listen for Esc.

Runtime cancellation signals, `/auto off`, and changes to the model, effort, or session invalidate pending results. They do not trigger fallback or overwrite the user's new settings. Pi may not expose a cancellation signal during `before_agent_start`; use `/auto off` to cancel selection in that case.

Both backends send the current input and the selected previous turn without local truncation. Even a single turn can be large, increasing cost and latency or exceeding provider limits.

## GPT-6 effort changes and prompt caching

For supported main-model requests, pi-auto follows OpenAI's [mid-conversation reasoning updates](https://developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation): it keeps the first request's top-level `reasoning.effort` and inserts a `configuration_update` before the next new user message. Later requests replay every update in its original position. Switching effort therefore does not rewrite an already-sent input prefix; ordinary cache size, lifetime, and routing requirements still apply. **This is prefix preservation, not a guarantee of cache hits or measured cost/latency savings.**

The allowlist is deliberately narrow:

| Provider / API | Models | Endpoint |
| --- | --- | --- |
| `openai` / `openai-responses` | `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna` | `https://api.openai.com/v1` |
| `openai-codex` / `openai-codex-responses` | `gpt-6-astra` only | `https://chatgpt.com/backend-api` |

OpenAI documents standard, single-agent GPT-6 support. Codex Astra accepted the update and exact prefix replay in a real Pi 0.87.1 SSE smoke test; cache-performance benefits and live WebSocket behavior have not been verified. Pi's Codex WebSocket path receives the transformed full history before its own incremental-request processing; pi-auto does not change transports.

- The first observed request establishes the baseline without an update. Repeated requests and retries do not duplicate or move updates. Several effort choices before dispatch produce only the final choice.
- Tool-only continuations retain the effective effort. A manual change during tool execution waits for a new user-message boundary; no update is inserted before a tool result or while tool calls are unresolved. Until then, Pi's effort display reflects the requested level, not the still-active wire-level effort.
- `/auto off` disables selection, not history replay. Manual `/thinking` changes use the same boundary rules, so disabling auto does not erase earlier updates.
- Branch-local metadata is saved as `pi-auto-openai-effort-cache` custom entries: baseline, update positions, efforts, and input hashes, not message text, tool output, or credentials. Each request reads the active branch, including after reload, resume, tree navigation, or fork.
- Model changes, Pi compaction, branch summaries, and changed/shortened provider history establish a fresh baseline. An existing session without this metadata also starts a new baseline; its earlier cache prefix cannot be recovered. Pi's local summarization remains available and does not send these wire-only updates to the summarizer.
- Pro/multi-agent requests, server automatic compaction/truncation, server-managed history (`previous_response_id` or `conversation` supplied before the hook), standalone compact requests, and unfamiliar native input-item types are not transformed. Neither are other models/APIs/providers, aliases, or third-party endpoints merely named GPT. Existing updates from another extension are not taken over. Leaving supported mode ends the old baseline.

No API-error fallback silently removes updates, and this feature makes no extra model calls. Other extensions that rewrite requests after this hook can still invalidate the prefix. The provider response's `reasoning.effort` reports the original top-level setting, not the latest update.

## Costs and limits

- Only effort levels supported by the current model can be selected. A model with just one supported level uses it without an extra model call.
- Each backend makes one selection request; Jev failure followed by current-model fallback makes at most **two calls**.
- **These extra calls add latency and may incur charges.** Their usage is not currently included in Pi's footer statistics for the main model.
- Context filtering affects only the selector's input, not the main model's conversation context.
- Using only the latest turn can omit relevant history, and automatic selection is not guaranteed to be optimal. Jev confidence is not a task-success probability and does not independently raise or lower effort.

### Selector input and data sent

Neither the current task nor the selected previous turn has a local character limit. Provider context-window and request-size limits still apply. This strategy affects only selector input, not the main model's conversation.

| Input | Maximum |
| --- | --- |
| Current task | No local character limit; sent in full |
| Previous user input and final assistant text reply | No local character limit; sent in full |

Both backends send only the current task and the previous turn's user input and final assistant text reply, without candidate selection or importance classification.

Instructions, model information, and effort options are additional input. With Jev enabled, the selection request sends its input to TypeSafe without automatic redaction. On fallback, the current model's provider receives the same current task and previous-turn context.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
```
