# Benchmarks

用固定 `max` 与 pi-auto `auto` 做对照实验，所有 provider 流量走计量代理。

| 文件 | 作用 |
|---|---|
| [`aider-polyglot.md`](aider-polyglot.md) | Aider polyglot 本地 pilot 方案：题源、分组、指标、判定门槛、成本 |
| [`aider.json`](aider.json) | 40 道题目与默认预算 |
| [`aider.py`](aider.py) | `plan` / `fetch` / `oracle` / `compare` |
| [`gateway.json`](gateway.json) | 模型、费率、预算上限 |
| [`gateway.py`](gateway.py) | 计量代理，记录 selector 与 execution 请求 |
| [`tests/`](tests) | 无网络的单元测试 |

```bash
npm run benchmark -- plan                              # 只打印任务矩阵
npm run benchmark -- fetch                             # 拉取固定版本题目
npm run benchmark -- oracle --languages python rust    # 验证参考解，无模型调用
npm run benchmark -- compare --budget-usd 10 --allow-paid   # 付费对照
```

`plan`、`fetch`、`oracle` 不联网调用模型。`compare` 需要 `DEEPSEEK_API_KEY` 与 `--allow-paid`，结果写入 `benchmarks/results/`（已 gitignore）。
