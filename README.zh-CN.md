# pi-auto

[English](./README.md) | 简体中文

Pi 扩展：每次任务开始前，自动选择当前模型的 thinking effort（思考强度）。**只调整 effort，不切换模型。**

## 安装与使用

需要 Node.js **22.19.0 或更高版本**及 Pi **0.99.0 或更高版本**。不再支持旧版 Pi：检测到缺少原生分类器接口时，扩展会停用选档并提示升级，不会退回旧版 TypeSafe 调用方式。

通过 npm 安装的 Pi，请先升级并重启，再更新本扩展：

```bash
npm install -g @earendil-works/pi-coding-agent@latest
```

```bash
pi install npm:pi-auto
```

通过 `/model` 选择聊天模型即可，无需配置 scoped models。未设置启动默认值时扩展默认开启，底栏只显示 `auto` 和选中的选档模型，例如 `auto · typesafe/jev-latest`。

## 选择选档模型

运行 **`/auto model`** 打开双标签选择器：

- **`chat model`**：Pi 的 `/model` 支持且当前可用的聊天模型。
- **`system one`**：当前可用的分类器，配置后可包含 Jev。

两个标签都保存明确的**提供商与模型 ID**。聊天选档模型只是固定的判断者；通过 `/model` 切换回答模型，**不会跟着更换判断者**。不再提供笼统的当前聊天模型固定行，也没有自动后端选项。

选择器像 Pi 原生 `/model` 一样替换底部输入区，**不是浮窗**，默认打开已保存模型所属标签。默认 **Tab** 切换标签，按名称／提供商／ID 搜索，**↑↓** 移动，**Enter** 保存，**Esc** 取消；搜索词跨标签保留。沿用 Pi 原生主题和可配置键位，列表采用 Pi 0.99.1 的 `→ ✓ model-id [provider]` 格式，光标和勾选标记各占固定列，模型显示名称仅在列表下方单独显示。已保存模型不可用时明确提示，不会自动改选或错误勾选其他模型。RPC、JSON 和非交互模式会提示需要交互式终端。

**候选档位、系统策略及最终应用的 effort 始终属于回答模型。** 固定聊天判断者使用现有 `streamSimple()` 提示词选档路径，请求自身的推理档位和输出词元上限按判断者能力设置，不改变主回答模型身份。
没有已保存的后端时，扩展异步查询 Pi 中**具有可用凭据的分类器**，不只是检查模型目录：

1. 优先选择可用的 `typesafe/jev-latest`。
2. 否则按 `provider/id` 稳定排序，选择第一个分类器。
3. 没有可用分类器时，将当前回答模型保存为固定聊天选档模型；暂无回答模型时保持明确未选状态，仍可进入 `/auto model`。

默认选择保存在 `<agent-dir>/pi-auto.json`。首次自动选择分类器时，会以英文通知：该分类器将接收当前任务及最近一轮选档上下文，可用 `/auto model` 更改。已保存的选择不会因后来出现分类器而改变；指定分类器或聊天模型不可用时，仅本次回退到当前回答模型，**不覆盖保存配置**。查询或保存失败时，不会悄悄保存另一个默认后端。

鉴权和可用性均由 Pi 的 `getAvailableOfType()` 与 `classify()` 处理。可以通过 Pi 的 `/login`、`auth.json`、`models.json` 或提供商支持的环境变量配置凭据。**环境变量不再是 pi-auto 的后端开关。** 仅保存凭据也能使分类器可用；设置或取消 `TYPESAFE_API_KEY` 不会覆盖已保存的选择。支持 Pi 提供的任意分类器提供商和模型 ID，不限于 Jev。

**选择分类器或聊天判断者，都会向其提供商发送当前任务和最近一轮选档上下文，不会自动脱敏。** 不直接发送工具结果原文或图片数据，但助手回复可能包含工具获得的信息。涉及机密内容时，请明确选择可信提供商的模型，或运行 `/auto off`；发生回退时，回答模型的提供商也会接收同一份选档上下文。直连 TypeSafe 时可参阅 [TypeSafe 隐私政策](https://typesafe.ai/legal/privacy-policy)。

### 上下文策略

- **分类器和聊天判断者采用同一策略**：只使用上一轮用户输入、该轮最后一条助手文本回复，加本次用户输入，即 `user + assistant + user`。不发送更早历史、摘要、中间进度、thinking 或工具结果，也不调用上下文分类；每个后端仅请求一次选档。
- 没有上一轮时只发送本次输入；上一轮尚无回复时只补充上一条用户输入，不拼接更早的回复。当前任务和选中的上一轮文本均完整发送，不设本地字符上限。
- 指定选档模型失败后，当前回答模型使用相同上下文接管一次选档，最多合计两次请求；主动取消不触发回退。

### 代理支持

分类器使用 **Pi 的共享网络运行时**，不再创建扩展独立连接池。在标准 Pi 命令行中，**无需 `NODE_USE_ENV_PROXY=1`**。

- Pi 读取 `http_proxy`、`https_proxy`、`no_proxy` 及其大写形式，小写优先。HTTPS 未配置 `https_proxy` 时使用 `http_proxy`。
- Pi 全局设置中的 `httpProxy` 可以提供默认代理。此网络路径不支持仅设置 `ALL_PROXY` / `all_proxy`，请同时设置 `https_proxy`。
- 这些设置影响整个 Pi，不再仅影响某个分类器。扩展不替换 `fetch`、不安装网络调度器，也不在代理失败后改为直连重试分类器；由当前模型通过 Pi 管理的连接接管选档。
- 嵌入式 Pi 宿主需自行配置网络运行时；扩展不会为宿主安装代理层。

修改启动终端的代理变量后，请重启 Pi。

## 命令

| 命令 | 用途 |
| --- | --- |
| `/auto` 或 `/auto toggle` | 切换自动选择 |
| `/auto on` | 开启自动选择 |
| `/auto off` | 关闭自动选择，并取消正在进行的选档 |
| `/auto model` | 在底部输入区选择并保存选档后端 |
| `/auto status` | 查看后端、effort 和最近一次选档详情 |
| `/auto default on` | 立即开启，并保存为启动默认值 |
| `/auto default off` | 立即关闭、取消正在进行的选档，并保存为启动默认值 |

`/auto`、`/auto on` 和 `/auto off` 只作用于当前扩展实例。`/auto default on|off` 保存全局启动默认值，并立即应用到当前实例；`default off` 还会取消正在进行的选档。其他已运行实例不受影响，重启或重载时使用保存的默认值。

启动默认值与选档后端保存在 `<agent-dir>/pi-auto.json`，通常为 `~/.pi/agent/pi-auto.json`，遵循 `PI_CODING_AGENT_DIR`。文件不存在时默认开启，并按上述规则初始化后端；配置无效或无法读取时关闭自动选择并警告；保存失败不改变当前状态。保存后端时保留 `defaultEnabled` 及其他字段，保存启动默认值时保留后端；无效 JSON 需先修复再保存。不修改 Pi 自身的 `settings.json`。

后端结构为 `{ "type": "chat" | "classifier", "provider": "...", "id": "..." }`；省略 `backend` 表示尚未保存选择。例如：

```json
{
  "defaultEnabled": true,
  "backend": { "type": "chat", "provider": "openai", "id": "gpt-5" }
}
```

分类器使用 `"type": "classifier"` 及其 Pi 提供商／ID，例如 `typesafe/jev-latest`。前一轮实验配置 `{ "type": "current-model" }` 仅在初始化时一次性改写为当前回答模型的明确聊天身份，不作为运行时后端。没有回答模型时保留原文件，界面显示未选，待有模型或用户明确选择后再保存；改写或选择器保存失败都保留原配置。

要固定 effort，先执行 `/auto off`，再用 `/thinking` 设置档位。关闭自动选择**不等于**将 effort 设为 `off`。

### 查看选档结果

底栏格式为 `auto · provider/id`，显示选中的选档模型；未选时显示 `auto · Not selected`。底栏不显示思考档位、`selector:`、`last:` 或回退详情，发生回退也不会替换底栏中的选中模型。实际使用的后端和最近选档详情可通过 `/auto status` 查看。关闭自动选择后隐藏底栏。
选择结果会保留在对话中，默认折叠，并显示实际后端和总耗时，例如 `auto · high · typesafe/jev-latest · 0.53s`。总耗时包含回退尝试；模型 ID 是 Pi 配置的目录／请求标识，不代表服务端实际版本。按默认快捷键 **Ctrl+O** 展开，查看档位变化、理由、完整选档模型、耗时和上下文摘要。

`/auto status` 在交互终端打开只读浮窗，包含三个页面：

- **Overview（概览）**：配置后端、Pi 报告的可用性、最近实际后端、结果与原因，失败原因优先展示。
- **Context（上下文）**：最近一轮的来源 ID、角色、字符范围、历史长度及是否省略其他历史。不展示原文；旧记录缺少这些信息时标记为未记录。
- **Diagnostics（诊断）**：每次尝试的结果、期限及中断来源；聊天选档模型的停止原因、内容类型和响应长度；策略、effort 概率、用量及请求耗时。

默认 **Tab** 切页、**↑↓ / PageUp / PageDown** 滚动、**j / k** 向下／向上滚动、**Esc** 关闭。显式自定义键位优先于 j/k 别名，以浮窗提示为准。

浮窗展示打开时的快照。查看状态不会调用模型、重新选档或改变 effort，只展示选档元数据，不展示请求正文。RPC 客户端通过文本通知查看同一份分组信息。

### 调试选择器返回

聊天选档模型的响应会在现有会话 JSONL 的 `pi-auto-decision` 条目中记录 `selectorResponses.effort`，包括停止原因、内容块类型和文本长度，这些信息也会显示在 `/auto status` 的诊断页。`selectorAttempts` 记录每个后端的尝试结果、耗时、期限和中断来源：`deadline`（本地超时）、`escape`（按 Esc）、`runtime`（运行时取消）、`auto-off`（关闭自动选择）、`settings-changed`（设置变化）、`session-shutdown`（会话关闭）或 `provider`（提供商中止）。旧记录缺少字段时显示为未记录；提供商中止不再被直接当作本地超时。已有字段仍保存模型、支持档位、耗时及用量。选档校验失败会细分为 `not_json_object`、`invalid_json`、`missing_effort`、`invalid_effort_type` 或 `unsupported_effort`，可在展开结果或 `/auto status` 中查看。

分类器会保存 `classifierDiagnostics`：最后的本地阶段（`request` 请求、`validation` 校验或 `complete` 完成）、错误码，以及收到原生结果时的 `stopReason`。本地校验针对 Pi 规范化后的答案，不是原始 HTTP 响应。回退到当前模型后，这些诊断仍然保留。

`classifierTiming` 记录完整的 `classify()` 调用耗时（包括运行时鉴权）、本地校验耗时、适配器总耗时，以及运行时返回的输入／输出词元数和目录计价费用（如有）。不再记录 HTTP 状态、请求大小、响应头／正文分段耗时、连接复用、建连及上传耗时；不会根据错误文本猜测缺失的数据。历史选档记录仍可读取，不再支持的诊断字段会被忽略，不修改会话文件。

| 分类器错误码 | 含义 |
| --- | --- |
| `request_cancelled` | 调用方信号中止；具体超时或取消来源见 `selectorAttempts.interruption` |
| `request_failed` | 运行时鉴权、HTTP、网络传输、解码或原生解析失败；不保存提供商错误文本 |
| `provider_aborted` | 本地未取消，但原生结果报告中止 |
| `model_unavailable` | 已保存的分类器在 Pi 中不可用，缺少模型或凭据 |
| `invalid_envelope`、`invalid_model`、`invalid_answers`、`missing_effort`、`unexpected_answers` | 规范化结果或答案未通过防御性校验 |
| `invalid_effort_answer`、`invalid_answer_type`、`unsupported_effort` | 规范化选档答案无效或档位不受支持 |
| `invalid_confidence`、`invalid_probabilities`、`probability_keys_mismatch`、`invalid_probability` | 置信度、概率对象、选项键或概率数值无效 |
| `probability_sum`、`choice_not_max` | 概率总和超出舍入容差，或所选档位不是最高概率选项 |

部分无效响应会被 Pi 提前拒绝，因此表现为 `request_failed`，而不是本地校验错误码。Pi 会移除原始响应中的多余答案，并用请求模型标识代替服务端版本，此处无法查看这些原始字段。是否达到本地期限以 `selectorAttempts` 为准；超过期限才返回的结果会被忽略。

默认不保存响应正文。需要捕获返回文本时，在启动终端运行：

```bash
PI_AUTO_DEBUG=1 pi
```

启用后，聊天选档模型的文本保存在 `selectorResponses.effort.rawText`；分类器通过本地校验后，将规范化的 `{ model, answers }` 保存到 `classifierDiagnostics.rawText`，仅包含配置模型 ID、受支持的档位、置信度和数值概率。**不保存**未通过校验的答案字符串、原始 HTTP 正文、无效 JSON、原生错误结果或未知字段。扩展不读取或记录 Pi 解析出的凭据。每份记录最多 **8,192 个 UTF-16 代码单元**，并用 `rawTextTruncated` 标记截断，此上限不限制选档输入。不保存请求正文、鉴权头、thinking 内容、工具参数或提供商错误文本及正文。原始文本不会显示在状态界面，也不会加入主模型上下文。

分类器记录使用 `classifierTiming` 和 `classifierDiagnostics`。`selectorAttempts.backend` 中，`classifier` 表示原生分类，`chat` 表示固定聊天判断者，`current-model` 表示当前回答模型回退（初始化失败时也可能临时使用）。旧会话文件不会被改写；不支持的旧诊断字段会被忽略，不会强行套用新格式。

**返回文本可能复述任务中的敏感信息，不会自动脱敏。** 分享日志前请人工检查；排查后不带该变量重启 Pi 即可关闭，已有记录不会自动删除。请求未返回或返回晚于超时／取消时，没有可保存的响应；旧故障也无法补录。

在 Pi 的 bash 工具中可读取当前会话的记录（使用 `jq`；会输出启用调试时保存的敏感文本）：

```bash
jq 'select(.type == "custom" and .customType == "pi-auto-decision") | .data | {reason, routerModel, routerEffort, routing, selectorUsage, selectorResponses}' "$PI_SESSION_FILE"
```

普通终端中请将 `"$PI_SESSION_FILE"` 替换为实际会话文件路径；默认位于 `~/.pi/agent/sessions/` 下。仅内存会话不会写入磁盘。

## 失败回退

选择指定分类器或聊天判断者时，回退顺序为：

```text
指定选档模型不可用或失败一次 → 当前回答模型接管选档 → 再失败则恢复 Pi 配置的默认 effort
```

聊天判断者通过 Pi 的 `streamSimple()` 运行时统一处理系统指令和鉴权。分类器和聊天请求均显式设置 `maxRetries: 0`，不重试请求，也不切换主模型。指定选档模型请求失败、超时或返回无效结果后，由当前回答模型接管。**指定聊天判断者已经是当前回答模型时（相同提供商／ID），失败直接恢复 Pi 默认档位，不对同一后端重复请求。**
分类器和聊天判断者每次选档均有 **10 秒期限**。指定选档模型失败后的当前回答模型回退使用独立的 10 秒期限，两次尝试合计最多约 20 秒。期限覆盖 Pi 可用性检查、运行时鉴权和整个请求，不只是网络传输。首次后端发现另有 10 秒查询期限，不发起分类请求。分类器本身是一次原生选档分类，但不额外调用上下文分类。

默认 effort 从 Pi 保存的全局及已信任项目 `settings.json` 中读取，优先级如下：

1. 当前模型的 `modelThinkingLevels["provider/modelId"]`。
2. `defaultThinkingLevel`。
3. 两者均未配置时，使用 Pi 内置默认值 `medium`。

超出模型能力时，按 Pi 的规则调整档位。不使用上一次自动选出的 effort 作为默认值，也不修改配置文件。相关配置无效或无法读取时，保留当前 effort，并在状态中说明原因。

交互终端中，选档期间按 **Esc** 可立即取消本次选档，保留当前 effort，让主任务继续；不会关闭自动选择，也不会触发回退。选档结束后，Esc 恢复 Pi 原有行为。

收到运行时取消信号、执行 `/auto off`，或切换选档后端、聊天模型、effort、会话时，在途结果失效，不触发回退，也不覆盖用户的新设置。配置成功改变时丢弃旧的在途决策及迟到诊断；保存失败则不取消现有选档。非交互模式不监听 Esc；Pi 的 `before_agent_start` 阶段可能没有运行时取消信号，此时可用 `/auto off` 取消选档。

两种后端均完整发送本次输入和最近一轮文本，不做本地截断。单轮仍可能很长，增加费用、延迟或超出提供商限制。

## 费用与限制

- 只选择当前模型支持的档位；只有一个可用档位时直接使用，不额外调用模型。
- 分类器或聊天判断者均只调用一次选档接口；指定选档模型失败后回退到当前回答模型，合计最多 **两次调用**。
- **额外调用会增加等待时间，并可能产生费用。** 扩展直接调用 `classify()` 不会自动计入会话费用。pi-auto 仅在自身诊断中记录用量，不计入 Pi 底栏或 `/session` 总计；聊天选档调用也不计入。
- 分类器费用来自 Pi 的模型目录计价，不是提供商账单。内置的直连 `typesafe/jev-latest` 目前没有目录价格，有用量时费用显示为零；**零费用不代表免费**。如果响应包含用量对象，Pi 可能将其中缺失或无效的词元字段规范化为零。
- 上下文筛选只影响选档输入，不修改主模型的会话上下文。
- 仅使用最近一轮可能遗漏相关历史，自动判断不保证最优。分类器的 confidence 不是任务成功率，也不单独用于升降 effort。

### 选档输入与外发范围

当前任务和上一轮文本均不设本地字符上限，但仍受提供商的上下文窗口及请求大小限制。此策略只影响选档输入，不改变主模型会话。

| 输入 | 最大范围 |
| --- | --- |
| 当前任务 | 无本地字符上限，完整发送 |
| 上一轮用户输入和最后一条助手文本回复 | 无本地字符上限，完整发送 |

两种后端均只发送**当前任务＋上一轮用户输入及最后一条助手文本回复**，不进行历史候选筛选或重要性分类。

请求还包含规则提示、模型及档位信息等额外内容。选择分类器或聊天判断者时，选档输入发送给对应提供商，且不会自动脱敏。发生回退时，当前模型的提供商只收到当前任务和最近一轮选档所需的输入。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
```
