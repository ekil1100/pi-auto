# pi-auto

`pi-auto` 是一个 Pi 扩展：每次开始新的任务时，自动从当前会话的 scoped models 中选择合适的模型与 thinking effort，然后再让 Pi 执行任务。

## 工作方式

1. 读取 `ctx.scopedModels`，不把模型选择扩展到 scope 之外。
2. 排除不支持当前附件或有效会话上下文中图片的模型，并检查上下文余量；用量未知时保留原模型与 effort。
3. 展开每个模型实际支持的 effort；如果 scope 已固定 effort，则只允许该组合。
4. 使用当前候选模型发起一次低 effort 路由请求；若当前模型不在候选中，则使用第一个合格候选。
5. 只接受路由白名单中的 opaque route ID，验证后调用 `pi.setModel()` 与 `pi.setThinkingLevel()`。
6. 任何超时、鉴权错误或无效输出都会 fail open：保留当前模型和 effort，不中断原任务。

路由策略默认优先选择“能够可靠完成任务的最低成本、最低 effort 组合”，避免为了省下一次较小调用而造成重试。`xhigh` 和 `max` 只应用于异常困难、高风险或跨范围很广的任务。

## 安装与试用

在仓库目录直接试用：

```bash
npm install
pi -e .
```

安装为本地 Pi package：

```bash
pi install /absolute/path/to/pi-auto
```

## 配置 scoped models

可以通过 `/scoped-models` 选择候选模型，也可以在 `~/.pi/agent/settings.json` 中配置：

```json
{
  "enabledModels": [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "openai-codex/gpt-5.6-sol",
    "xai/grok-4.6"
  ]
}
```

不要给模型添加 `:high` 等后缀，pi-auto 才能为它自动选择 effort。如果希望某个模型始终使用固定 effort，可以保留后缀：

```json
{
  "enabledModels": [
    "deepseek/deepseek-v4-flash:low",
    "openai-codex/gpt-5.6-sol:max"
  ]
}
```

未配置任何 scoped model 时，扩展不会把整个可用模型目录当作隐式候选，而是保留当前 route 并提示用户配置 scope。这避免意外使用未明确允许的模型或价格层级。

## 命令

```text
/auto status
/auto on
/auto off
```

不带参数的 `/auto` 等同于 `/auto status`。状态会显示候选数量、最近一次选择、理由和用于路由判断的模型。

## 行为说明

- 自动路由发生在 `before_agent_start`，因此模型切换会作用于即将开始的任务。
- 流式执行期间加入的 steer/follow-up 消息继续使用当前任务的模型，不会在工具循环中途切换。
- 路由请求有 20 秒超时，并向 SDK 传入最多 2,048 token 的输出预算（不超过模型自身上限）。供应商返回输出截断时保留原模型与 effort。预算能否生效取决于 SDK 和供应商；当前 Codex 适配器不传递 `maxTokens`，该路径仍依赖超时。
- 上下文估算在 Pi 提供的现有用量上，加入完整当前任务及附件的 token 估算，不使用裁剪后的路由文本。超过候选模型窗口的 85% 时排除该模型；压缩后等用量未知的情况跳过路由。
- 图片检查覆盖压缩后的有效上下文，包括用户消息、工具结果和扩展上下文消息中的图片；已被压缩移除或位于其他分支的图片不影响候选模型。这样可避免文本模型将仍需使用的图片替换为占位符。
- 路由请求只发送最多约 12,000 个字符的当前任务、最多约 6,000 个字符的有效上下文中近期用户/助手文本及会话摘要，以及候选模型元数据；不发送工具结果原文或图片数据。过长文本会保留首尾并裁剪中段。
- 路由调用由 `ModelRegistry.complete()` 独立完成，目前不会计入 Pi 会话 footer 的主调用用量统计，但仍会产生对应供应商的实际用量。

## 开发

```bash
npm test
npm run check
```

核心路由规则位于 `src/router.ts`，Pi 生命周期适配位于 `src/index.ts`，近期会话裁剪位于 `src/session-context.ts`。
