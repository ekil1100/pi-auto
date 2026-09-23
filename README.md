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

**Enabling Jev sends your current task and relevant conversation history to TypeSafe without automatic redaction.** Raw tool results and image data are not sent directly, but existing summaries may contain information obtained through tools. For sensitive tasks, disable automatic selection, or unset the key and restart Pi. See the [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy).

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
- **Context:** candidate source IDs, roles, character ranges, importance ratings, and actual retention. Ratings and retention are shown separately; missing classification or older metadata is marked as unknown rather than inferred.
- **Diagnostics:** policy, probabilities, usage, and timing and connection details for classification and effort selection.

Default controls: **Tab** to change pages, **↑↓ / PageUp / PageDown** to scroll, **j / k** to scroll down/up, and **Esc** to close. Explicit custom keybindings take precedence over j/k aliases; follow the displayed hints.

The view is a snapshot taken when opened. Inspecting it does not call a model, rerun selection, or change effort. It shows selection metadata, not request payloads. RPC clients receive the same grouped information as a text notification.

调试选择器返回：使用 `PI_AUTO_DEBUG=1 pi` 显式开启有长度上限的响应文本记录；默认只保存响应元数据。[日志字段、读取方法与隐私说明](./README.zh-CN.md#调试选择器返回)。

## Failure handling

With Jev enabled, the fallback chain is:

```text
Jev fails once → current model selects effort → if that fails, restore Pi's configured default effort
```

There are no request retries and no main-model switch. Jev request failures, timeouts, and invalid decisions trigger the current-model fallback. Without Jev, a failed current-model selection also restores the configured default effort.

Each backend has a **10-second deadline shared by classification and effort selection**. The current-model fallback gets its own 10-second deadline, so both attempts can take approximately 20 seconds in total.

Default effort is read from Pi's saved global and trusted-project `settings.json` files, in this order:

1. `modelThinkingLevels["provider/modelId"]` for the current model.
2. `defaultThinkingLevel`.
3. Pi's built-in default, `medium`, if neither is configured.

The level is adjusted to the model's capabilities using Pi's rules. The previous automatically selected effort is not treated as the default, and configuration files are not modified. If the relevant configuration is invalid or cannot be read, the current effort is kept and the status explains why.

交互终端中，选档期间按 **Esc** 可立即取消本次选档，保留当前 effort 并继续主任务，不触发回退，也不关闭自动选择。选档结束后恢复 Esc 原有行为；非交互模式不监听 Esc。

Runtime cancellation signals, `/auto off`, and changes to the model, effort, or session invalidate pending results. They do not trigger fallback or overwrite the user's new settings. Pi may not expose a cancellation signal during `before_agent_start`; use `/auto off` to cancel selection in that case.

If required history exceeds the context budget, either backend can skip selection. This keeps the current effort and is not treated as a connection failure.

## Costs and limits

- Only effort levels supported by the current model can be selected. A model with just one supported level uses it without an extra model call.
- Each backend normally makes one selection call. Long history adds a classification call first. A Jev failure followed by a current-model fallback rebuilds the selection context, for up to **four calls** in total.
- **These extra calls add latency and may incur charges.** Their usage is not currently included in Pi's footer statistics for the main model.
- Context filtering affects only the selector's input, not the main model's conversation context.
- Input limits can omit relevant history, and automatic selection is not guaranteed to be optimal. Jev confidence is not a task-success probability and does not independently raise or lower effort.

### Selector input and data sent

Lengths below use JavaScript `.length`: **UTF-16 code units**, not tokens or bytes. They limit selector input, not the main model's conversation.

| Input | Maximum |
| --- | --- |
| Current task | 12,000; oversized tasks retain the beginning and end, independently of the history budget |
| Candidate history for classification | 24,000 for the complete candidate JSON, up to 32 fragments, including source labels and other metadata |
| History for final effort selection | 6,000, including source labels, omission markers, and separators |

Short history usually needs only the effort-selection request. Long history first sends **the current task + candidate history** for classification, then **the current task + selected history** for effort selection. Classification can therefore expose more history than the final selection request.

Instructions, model information, and effort options are additional input; these limits are not caps on the complete HTTP request or server-side token usage. With Jev enabled, both Jev stages send their inputs to TypeSafe without automatic redaction. On fallback, the current model's provider receives the inputs needed for its own classification and selection.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
```
