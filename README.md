# pi-auto

English | [简体中文](./README.zh-CN.md)

A Pi extension that automatically selects the current model's thinking effort before each task. **It adjusts effort only—never switches your model.**

## Install and use

Requires Node.js **22.19.0 or later** and Pi.

```bash
pi install npm:pi-auto
```

Choose your model with `/model`; no scoped-model configuration is needed. The extension is enabled by default, and the footer shows the current effort, such as `auto · low`.

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

The toggle applies to the current extension instance; restarting or reloading enables it again. To use a fixed effort, run `/auto off`, then choose a level with `/thinking`. Disabling automatic selection does **not** set effort to `off`.

### Inspect a selection

Selection results appear in the conversation, collapsed by default. Use the default **Ctrl+O** shortcut to expand the effort change, reason, selector, elapsed time, and context summary.

In an interactive terminal, `/auto status` opens a read-only overlay with three pages:

- **Overview:** current state and the latest selection, with failure reasons shown first.
- **Context:** source IDs, roles, character ranges, history length, and omission indicators for the latest turn. Message text is not displayed; missing metadata in older records is marked as unrecorded.
- **Diagnostics:** policy, effort probabilities, usage, local context preparation time, and selection request timing and connection details.

Default controls: **Tab** to change pages, **↑↓ / PageUp / PageDown** to scroll, **j / k** to scroll down/up, and **Esc** to close. Explicit custom keybindings take precedence over j/k aliases; follow the displayed hints.

The view is a snapshot taken when opened. Inspecting it does not call a model, rerun selection, or change effort. It shows selection metadata, not request payloads. RPC clients receive the same grouped information as a text notification.

### Debug selector responses

Current-model response metadata is saved in session JSONL entries of type `pi-auto-decision`, under `selectorResponses.effort`. It includes stop reasons, content block types, and text length. Invalid decisions report `not_json_object`, `invalid_json`, `missing_effort`, `invalid_effort_type`, or `unsupported_effort`.

Run `PI_AUTO_DEBUG=1 pi` to also capture response text in `rawText`, capped at **8,192 UTF-16 code units** per response, with `rawTextTruncated` indicating truncation. This response-log limit does not restrict selector input. Raw text is not displayed in the status UI or added to the main model's context. Requests, credentials, thinking, tool arguments, and provider error bodies are not recorded.

**Responses may repeat sensitive task information without redaction.** Review logs before sharing them. Restart without the variable to disable capture; existing records remain. Capture applies only to current-model responses, including Jev fallback, not raw Jev HTTP responses. Missing or late responses after cancellation or timeout cannot be captured.

## Failure handling

With Jev enabled, the fallback chain is:

```text
Jev fails once → current model selects effort → if that fails, restore Pi's configured default effort
```

There are no request retries and no main-model switch. Jev request failures, timeouts, and invalid decisions trigger the current-model fallback. Without Jev, a failed current-model selection also restores the configured default effort.

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
