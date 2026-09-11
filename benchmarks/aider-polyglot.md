# Aider polyglot · DeepSeek Flash · 本地 pilot

用 **40 道 Aider polyglot 题**在本地比较固定 `max` 与 pi-auto，验证“`auto` 成功率不掉、token/耗时下降、难题不降档翻车”。取舍是便宜、快、多语言，代价是题目偏小，适合做路由准确度与成本的 pilot。

**当前状态：harness 已接入并本地验证 `plan` 与 python/rust 的 `oracle`；未调用任何模型。**

## 题源

- 仓库：`https://github.com/Aider-AI/polyglot-benchmark`
- 固定 commit：`7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`（见 [`aider.json`](aider.json)）
- 题源：Exercism；每题自带测试与 `.meta/` 参考解。
- 目录结构：`<track>/exercises/practice/<slug>/`。

## 题集（40 题）

按 track 排序后等距抽取，未按模型成绩挑选，完整清单见 [`aider.json`](aider.json)。

| Track | 题数 | Slugs |
|---|---:|---|
| python | 8 | affine-cipher, bowling, food-chain, grep, pig-latin, react, sgf-parsing, two-bucket |
| javascript | 7 | affine-cipher, complex-numbers, house, parallel-letter-frequency, react, simple-linked-list, twelve-days |
| go | 7 | alphametics, connect, food-chain, markdown, poker, say, trinary |
| java | 6 | affine-cipher, change, hangman, pig-latin, resistor-color-trio, tree-building |
| rust | 6 | accumulate, book-store, gigasecond, nucleotide-codons, react, two-bucket |
| cpp | 6 | all-your-base, circular-buffer, diamond, knapsack, perfect-numbers, space-age |

## 执行方式

- 用 **Pi headless** 跑题：`pi --print --mode json --thinking max [--extension src/index.ts]`。
- 判分复用各 track 自带测试（`aider.py` 里的 `grading_commands`）。
- 所有 provider 流量走 [`gateway.py`](gateway.py)：selector 与 execution 请求都计入，预算不足或用量缺失即停；模型与费率在 [`gateway.json`](gateway.json)。
- 交给 agent 前删除 `.meta/` 与 `.approaches/`，避免读到参考解；`oracle` 才注入 `.meta` 参考解。
- 各 track 依赖先由 `setup_commands` 准备（`npm install`、`go mod download`、`cargo fetch`、`./gradlew testClasses`）。

## 分组与指标

同一批题，两组独立运行，按题号交替先后顺序：

- `max`：固定 `--thinking max`，不加载扩展（基线）。
- `auto`：加载 `src/index.ts`，由 pi-auto 选择档位。

指标：官方测试通过率、总 token（含 selector 与缓存命中）、总耗时、以及 **回归清单**（`max` 通过但 `auto` 未通过）。

## 判定标准

| 编号 | 条件 |
|---|---|
| G1 | `auto` 通过数 ≥ `max` − 1 题 |
| G2 | `auto` 总 token ≤ `max` 的 85%，总耗时 ≤ 90% |
| G3 | 回归清单为 0 题 |

40 题下 0 回归对应约 7.5% 的 95% 置信上界，只够做 pilot，不足以宣称稳定结论。

## 流程

```bash
# 1. 拉取固定版本题目（无模型调用）
npm run benchmark -- fetch

# 2. 先过 oracle，只保留参考解能通过的题（无模型调用）
npm run benchmark -- oracle --languages python rust

# 3. 校准成本与接入（付费）
DEEPSEEK_API_KEY=... npm run benchmark -- compare \
  --languages python rust --budget-usd 2 --allow-paid

# 4. 全量
DEEPSEEK_API_KEY=... npm run benchmark -- compare --budget-usd 10 --allow-paid
```

`plan` 只打印任务矩阵，不联网、不调用模型。`compare` 需要 `--allow-paid`；结果写入 `benchmarks/results/aider-<timestamp>/`（已 gitignore），含 `summary.json`、`calls.jsonl`、`report.json`。

## 成本（DeepSeek-V4.1-Flash）

- 费率：输入 `$0.30/M`、缓存 `$0.006/M`、输出 `$1.20/M`。
- 单题约 50k 输入 + 10k 输出 ≈ `$0.027`（约 ¥0.19）。
- 40 题 × 2 组 ≈ **$2（约 ¥15）**；含缓存与多轮，估计 **¥10–40**。
- selector 约 6k 输入 + 3k 输出，40 次约 ¥1.5。
- `oracle` 与 `fetch` 不产生模型费用。
- 默认预算上限 `$10`（约 ¥71），每请求预留 `$0.05`。

## 已知限制

- 40 题只能抓大差异（成功率差 ≥15pp），抓不到 2pp 级别；要更细需扩到 100+ 题。
- 题目小而清晰，路由器应当大多选 `low`；`auto` 相对 `max` 的节省主要来自简单题，难题上 `high` 与 `max` 差距有限。
- 裸环境部分题需要外部依赖（如 rust `decimal` 需要 `num-*` crate，已替换为 `book-store`）；`oracle` 必须先过再 `compare`。
- 本地需要各 track 工具链；缺失时 `oracle` 会报环境未就绪。macOS 上 python/rust/cpp 基本可用，go/java 视安装而定。
- 任务文件会被复制到临时目录运行，`.meta` 参考解在 agent 运行前删除，但题目测试对 agent 可见——与真实开发一致。
- 两组的 DeepSeek 缓存无法隔离；交替先后顺序并保留 cache 用量，总 token 包含缓存命中输入。

## 相关文件

- [`aider.json`](aider.json)：题目与预算的唯一配置。
- [`gateway.json`](gateway.json)：模型、费率与预算上限。
- [`aider.py`](aider.py)：`plan` / `fetch` / `oracle` / `compare`。
- [`gateway.py`](gateway.py)：计量代理，`reserve_usd` 可配置以适配小题集。
- [`tests/`](tests)：无网络的单元测试。
