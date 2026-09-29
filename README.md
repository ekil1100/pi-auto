# pi-auto

English | [简体中文](./README.zh-CN.md)

A Pi extension that automatically selects the current model's thinking effort before each task. **It adjusts effort only—never switches your model.**

## Install and use

Requires Node.js **22.19.0 or later** and Pi **0.99.0 or later**. Older Pi versions are not supported: pi-auto disables selection and asks you to upgrade instead of using the old TypeSafe SDK.

For an npm-installed Pi, upgrade and restart before updating this extension:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
```

```bash
pi install npm:pi-auto
```

Choose your chat model with `/model`; no scoped-model configuration is needed. The extension starts enabled unless you save a different startup default. The footer shows only `auto` and the selected selector model, for example `auto · typesafe/jev-latest`.

## Choose the effort selector

Run **`/auto model`** to open a two-tab picker:

- **`chat model`** lists available chat models supported by Pi's `/model`.
- **`system one`** lists available classifiers, including Jev when configured.

Both tabs save an explicit **provider and model ID**. A chat selector is a fixed judge: switching the answering model with `/model` does **not** change it. There is no generic Current chat model row or Auto option.

The picker replaces the bottom input area, like Pi's `/model`; it is **not an overlay**. It opens the saved selector's tab. Use **Tab** to switch tabs, search by name/provider/ID, **↑↓** to navigate, **Enter** to save, and **Esc** to cancel. The search is retained across tabs. Pi's configurable selection keys and native theme apply. Rows follow Pi 0.99.1's format: `→ ✓ model-id [provider]`, with fixed cursor/checkmark columns; the display name appears only below the list as `Model Name:`. Unavailable saved models are reported, not silently replaced or marked as selected. RPC, JSON, and print modes explain that an interactive TUI is required.

**The answering model owns the effort options and receives the final effort.** The fixed chat judge uses the existing `streamSimple()` selection prompt, with its own supported reasoning effort and output-token limit; it never becomes the answering model.
When no backend has been saved, pi-auto asynchronously asks Pi for **available classifier models with configured credentials**, not just catalog entries:

1. Prefer `typesafe/jev-latest` if available.
2. Otherwise choose the first classifier in stable `provider/id` order.
3. If none are available, save the answering model as a fixed `chat` selector. Without an answering model, leave the selector explicitly unselected; `/auto model` remains usable.

The choice is saved in `<agent-dir>/pi-auto.json`. First-time classifier selection produces an English notice explaining that it will receive your current task and recent-turn selection context, and that `/auto model` changes the choice. A saved choice is respected even if classifiers become available later. If a saved classifier or chat selector becomes unavailable, only that attempt falls back to the answering model; the saved choice is not replaced. Discovery or persistence failures do not silently save a different default.

Authentication and availability belong to Pi, through `getAvailableOfType()` and `classify()`. Configure credentials with Pi's `/login`, `auth.json`, `models.json`, or supported provider environment variables. **Environment variables are not pi-auto backend switches.** Stored credentials alone can make a classifier available; setting or unsetting `TYPESAFE_API_KEY` does not override a saved choice. Arbitrary Pi classifier providers and IDs are supported, not just Jev.

**Choosing either a classifier or a chat selector sends the current task and recent-turn context to that selector's provider without automatic redaction.** Raw tool results and image data are not sent directly, but assistant replies may contain information obtained through tools. For sensitive tasks, explicitly select a model from a trusted provider or run `/auto off`. The answering provider receives the same selection context on fallback. For direct TypeSafe usage, see the [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy).

### Proxy support

Classifier selection uses **Pi's shared HTTP runtime**, not an extension-owned connection pool. In the standard Pi CLI, **`NODE_USE_ENV_PROXY=1` is not required**.

- Pi reads `http_proxy`, `https_proxy`, and `no_proxy`, plus their uppercase variants; lowercase takes precedence. HTTPS falls back to `http_proxy` when `https_proxy` is not configured.
- Pi's global `httpProxy` setting can supply proxy defaults. `ALL_PROXY` / `all_proxy` alone is not supported by this HTTP path; also set `https_proxy`.
- These are Pi-wide settings, not settings isolated to the classifier. The extension does not replace `fetch`, install a dispatcher, or retry the classifier directly after a proxy failure. The current model takes over selection using its own Pi-managed connection.
- Embedded Pi hosts must configure their own HTTP runtime; the extension does not install a proxy layer for them.

Restart Pi after changing proxy variables in its launch terminal.

## Commands

| Command | Action |
| --- | --- |
| `/auto` or `/auto toggle` | Toggle automatic selection |
| `/auto on` | Enable automatic selection |
| `/auto off` | Disable automatic selection and cancel a pending selection |
| `/auto model` | Choose and save the selector backend in the bottom input area |
| `/auto status` | Inspect the backend, effort, and latest selection |
| `/auto default on` | Enable automatic selection now and save on as the startup default |
| `/auto default off` | Disable automatic selection now, cancel a pending selection, and save off as the startup default |

`/auto`, `/auto on`, and `/auto off` affect only the current extension instance. `/auto default on|off` saves a global startup default and immediately applies it to the current instance. `default off` also cancels a pending selection. Other running instances are unaffected; restarting or reloading uses the saved default.

The startup default and selector backend are saved in `<agent-dir>/pi-auto.json` (normally `~/.pi/agent/pi-auto.json`; respects `PI_CODING_AGENT_DIR`). Without this file, selection starts enabled and initializes a saved backend as described above. Invalid or unreadable settings disable selection with a warning; a failed save leaves the current state unchanged. Backend writes preserve `defaultEnabled` and other fields; startup-default writes preserve the backend. Repair invalid JSON before saving again. Pi's own `settings.json` is not modified.

The backend schema is `{ "type": "chat" | "classifier", "provider": "...", "id": "..." }`; omitting `backend` means no saved selection. For example:

```json
{
  "defaultEnabled": true,
  "backend": { "type": "chat", "provider": "openai", "id": "gpt-5" }
}
```

For a classifier, use `"type": "classifier"` with its Pi provider/ID, such as `typesafe/jev-latest`. An initial experimental `{ "type": "current-model" }` setting is rewritten once to the answering model's explicit chat identity during initialization. It is not a runtime backend. If no answering model exists, the file is left intact and the picker shows an unselected state until a model can be chosen. A failed rewrite or picker save leaves the original configuration intact.

To use a fixed effort, run `/auto off`, then choose a level with `/thinking`. Disabling automatic selection does **not** set effort to `off`.

### Inspect a selection

The footer shows `auto · provider/id` for the selected selector model, or `auto · Not selected` when none is selected. It does not show effort, `selector:`, `last:`, or fallback details; fallback does not replace the selected model in the footer. Use `/auto status` to inspect the actual backend and latest selection details. Disabling auto hides the footer.
Selection results appear in the conversation, collapsed by default, with the actual backend and total time, for example `auto · high · typesafe/jev-latest · 0.53s`. The total includes fallback attempts. IDs refer to Pi's configured catalog/request model, not a resolved server version. Use the default **Ctrl+O** shortcut to expand the effort change, reason, exact selector model, elapsed time, and context summary.

In an interactive terminal, `/auto status` opens a read-only overlay with three pages:

- **Overview:** configured backend, Pi-reported availability, latest actual backend, result and reason, with failure reasons shown first.
- **Context:** source IDs, roles, character ranges, history length, and omission indicators for the latest turn. Message text is not displayed; missing metadata in older records is marked as unrecorded.
- **Diagnostics:** per-attempt outcomes, deadlines and interruption sources; chat-selector stop reason, content types and response length; policy, effort probabilities, usage and request timing.

Default controls: **Tab** to change pages, **↑↓ / PageUp / PageDown** to scroll, **j / k** to scroll down/up, and **Esc** to close. Explicit custom keybindings take precedence over j/k aliases; follow the displayed hints.

The view is a snapshot taken when opened. Inspecting it does not call a model, rerun selection, or change effort. It shows selection metadata, not request payloads. RPC clients receive the same grouped information as a text notification.

### Debug selector responses

Chat-selector response metadata is saved in session JSONL entries of type `pi-auto-decision`, under `selectorResponses.effort`. It includes stop reasons, content block types, and text length, also visible on the Diagnostics page of `/auto status`. `selectorAttempts` records each backend's outcome, elapsed time, deadline and interruption source (`deadline`, `escape`, `runtime`, `auto-off`, `settings-changed`, `session-shutdown`, or `provider`). Older records without these fields are marked as unrecorded; a provider abort is not assumed to be a local timeout. Invalid decisions report `not_json_object`, `invalid_json`, `missing_effort`, `invalid_effort_type`, or `unsupported_effort`.

Classifiers save `classifierDiagnostics` with their last local stage (`request`, `validation`, or `complete`), an error code, and the native `stopReason` when a result is received. Local validation operates on Pi's normalized answers, not the original HTTP response. Diagnostics remain available after current-model fallback.

`classifierTiming` records the full `classify()` duration (including runtime authentication), local validation time, total adapter time, and runtime-reported input/output tokens and catalog cost when available. HTTP status, request size, header/body timings, socket reuse, connection time, and upload timing are no longer recorded. Missing data is not reconstructed from error text. Saved decisions remain readable; unsupported diagnostic fields are ignored without changing the session file.

| Classifier error codes | Meaning |
| --- | --- |
| `request_cancelled` | Caller signal aborted; `selectorAttempts.interruption` identifies the deadline or cancellation source |
| `request_failed` | Runtime authentication, HTTP, transport, decoding, or native parsing failure; provider error text is deliberately omitted |
| `provider_aborted` | Native result reported `aborted` without local cancellation |
| `model_unavailable` | The saved classifier is unavailable in Pi (model or credentials missing) |
| `invalid_envelope`, `invalid_model`, `invalid_answers`, `missing_effort`, `unexpected_answers` | Defensive validation of the normalized result or answers |
| `invalid_effort_answer`, `invalid_answer_type`, `unsupported_effort` | Invalid normalized effort answer or unsupported effort |
| `invalid_confidence`, `invalid_probabilities`, `probability_keys_mismatch`, `invalid_probability` | Invalid confidence, probability object, option keys, or probability values |
| `probability_sum`, `choice_not_max` | Probability sum outside rounding tolerance, or chosen effort is not a highest-probability option |

Pi rejects some malformed responses before returning answers; those failures appear as `request_failed`, not a local validation code. Extra wire-level answers and the server's model version are normalized away by Pi and cannot be inspected here. The authoritative deadline diagnosis is `selectorAttempts`; a result arriving after the deadline is ignored.

Run `PI_AUTO_DEBUG=1 pi` to also capture chat-selector text in `selectorResponses.effort.rawText` and a classifier's validated `{ model, answers }` in `classifierDiagnostics.rawText`. Classifier capture contains only the configured model ID, supported effort choice, confidence, and numeric probabilities, after successful validation. Unvalidated answer strings, original HTTP bodies, malformed JSON, native error results, and unknown fields are never captured. The extension does not read or log Pi's resolved credentials. Each capture is capped at **8,192 UTF-16 code units**, with `rawTextTruncated` indicating truncation. This response-log limit does not restrict selector input. Raw text is not displayed in the status UI or added to the main model's context. Requests, credential headers, thinking, tool arguments, and provider error messages/bodies are not recorded.

Classifier entries use `classifierTiming` and `classifierDiagnostics`. Attempt backends are `classifier` for native classification, `chat` for a fixed chat selector, and `current-model` for the answering-model fallback (also used temporarily if initialization fails). Existing session files are never rewritten; unsupported old diagnostic fields are ignored rather than interpreted as the new schema.

**Responses may repeat sensitive task information without redaction.** Review logs before sharing them. Restart without the variable to disable capture; existing records remain. Missing or late responses after cancellation or timeout cannot be captured.

## Failure handling

For a saved classifier or chat selector, the fallback chain is:

```text
Saved selector unavailable or fails once → answering model selects effort → if that fails, restore Pi's configured default effort
```

Chat selection uses Pi's `streamSimple()` runtime to normalize system instructions and resolve authentication. Classifier and chat calls set `maxRetries: 0`; there are no request retries and no answering-model switch. Request failures, timeouts, and invalid decisions trigger fallback. **If the fixed chat selector is already the answering model (same provider/ID), failure goes directly to Pi's default effort, without calling the same backend again.**
Both backends use the same context strategy: the previous user input, that turn's final assistant text reply, and the current input (`user + assistant + user`). They make one effort-selection request each (a native choice classification for classifiers), with no separate history-classification call. Earlier history, summaries, and intermediate progress are excluded. The selected messages are sent in full without local character limits. Without a previous turn, only the current input is sent; an unanswered turn never borrows an older reply.

Each selection has a **10-second deadline**. Current-model fallback after a saved-selector failure gets a separate deadline, for about 20 seconds total across both attempts. Cancellation does not trigger fallback. The deadline covers Pi availability checks, runtime authentication, and the request, not just network I/O. Initial backend discovery has its own 10-second budget and makes no classification call.

Default effort is read from Pi's saved global and trusted-project `settings.json` files, in this order:

1. `modelThinkingLevels["provider/modelId"]` for the current model.
2. `defaultThinkingLevel`.
3. Pi's built-in default, `medium`, if neither is configured.

The level is adjusted to the model's capabilities using Pi's rules. The previous automatically selected effort is not treated as the default, and configuration files are not modified. If the relevant configuration is invalid or cannot be read, the current effort is kept and the status explains why.

In interactive terminals, press **Esc** during selection to cancel it, keep the current effort, and continue the main task without fallback or disabling automatic selection. Esc returns to its normal behavior afterward; non-interactive mode does not listen for Esc.

Runtime cancellation signals, `/auto off`, and changes to the selector backend, chat model, effort, or session invalidate pending results. Successful configuration changes discard the old in-flight decision, including late diagnostics; a failed save does not cancel it. They do not trigger fallback or overwrite the user's new settings. Pi may not expose a cancellation signal during `before_agent_start`; use `/auto off` to cancel selection in that case.

Both backends send the current input and the selected previous turn without local truncation. Even a single turn can be large, increasing cost and latency or exceeding provider limits.

## Costs and limits

- Only effort levels supported by the current model can be selected. A model with just one supported level uses it without an extra model call.
- Each backend makes one selection request; saved-selector failure followed by answering-model fallback makes at most **two calls**.
- **These extra calls add latency and may incur charges.** Direct extension calls to `classify()` do not automatically enter session cost totals. pi-auto records usage in its own diagnostics, not Pi's footer or `/session` totals; chat-selector calls are also excluded.
- Classifier cost comes from Pi's model catalog, not the provider's bill. The built-in direct `typesafe/jev-latest` currently has no catalog price and reports zero cost when usage is present; **zero does not mean free**. Pi may normalize absent or malformed token fields to zero when a usage object is present.
- Context filtering affects only the selector's input, not the main model's conversation context.
- Using only the latest turn can omit relevant history, and automatic selection is not guaranteed to be optimal. Classifier confidence is not a task-success probability and does not independently raise or lower effort.

### Selector input and data sent

Neither the current task nor the selected previous turn has a local character limit. Provider context-window and request-size limits still apply. This strategy affects only selector input, not the main model's conversation.

| Input | Maximum |
| --- | --- |
| Current task | No local character limit; sent in full |
| Previous user input and final assistant text reply | No local character limit; sent in full |

Both backends send only the current task and the previous turn's user input and final assistant text reply, without candidate selection or importance classification.

Instructions, model information, and effort options are additional input. The selection request sends its input to the saved classifier or chat provider without automatic redaction. On fallback, the current model's provider receives the same current task and previous-turn context.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
```
