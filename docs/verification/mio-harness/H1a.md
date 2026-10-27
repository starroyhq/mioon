# Mio harness H1a · 上下文装配器

日期：2026-10-27（Asia/Taipei）。原始验收起点：`079b7b6d9f3f9646edc1f04951981323906a528e`，已通过 merge commit 合入 H0（PR #45）。PR 前按用户授权快进到 `43c9c6e805a6528fa0595c7b48f93bbfe1f60ba1`，同步验证单列于下文，原始验收证据不覆盖。

分支：`codex/mio-harness-h1a`。工作目录：`/Users/kouzen/.codex/worktrees/mio-harness-h1a/mioon`。

## 范围与实现

只实施 H1a，抽取上下文装配，保持模型请求字节不变。

业务代码：

- 新增 `packages/business/src/agent/task-context-v2.ts`：
  - `assembleRunContext()`：从宿主已限定范围的历史轮次构造语言标记、用户消息、说明、最后有效回复与附件句柄，按原 UTF-8 上限裁掉最早的整轮。
  - `assembleModelInput()`：克隆基上下文，组合依次产生的历史片段，筛选并追加未绑定说明，返回历史、工具、待绑定说明和只在内存使用的指标。
  - `replayModelContext()`：生成已绑定说明、废弃未知结果提示、协议续接、重新规划提示和已保存的流式文本片段。
  - `selectTaskModelTools()`：复用原普通、text、read_only、catalog 工具选择规则，保持目录顺序。
- 调整 `packages/business/src/agent/task-runtime-v2.ts`：发送、执行和说明容量探测接入同一装配器；保留原执行循环、动态工具结果与调度。

装配器不读数据库、时钟、随机数或外部可变回调，不执行工具，不写库。上下文所属项目、对话及已完成轮次仍由 journal 查询限定。

执行时点保持：

- 基上下文仍在每轮执行开头克隆；协议续接在原分支立即校验，没有延后到后续工具执行之后。
- `performTool()` 继续提供包含旧批次失效、跳过、拒绝和失败的实际结果；装配器不推测执行是否成功。
- 最终回复期间到达的说明仍通过即时 journal 查询决定是否续接，说明绑定仍在新模型 intent 的事务内完成。
- 已保存的未发送 intent 仍惰性使用原始 body，不重新构造请求或读取新工具目录。
- 说明容量检查保留 saved history 优先、显式空数组、已持久 partial 正文和原超限错误语义；它只探测容量。
- 授权、确认、修订检查、步数、事务、未知结果及恢复门禁没有变化。

本期差异不涉及契约、HTTP、client、CLI、界面、网关、journal、工具执行器、依赖与存储格式，没有新增持久字段或改写历史。本期不实施工具分组、截断或压缩。C7 对图像编辑 `size` 的变更与指纹更新由 C7 负责；PR 前同步的 main 已包含这些变更。

测试：新增 `tests/agent-task-context-v2.test.ts`，9 项检查覆盖 UTF-8 精确上限、整轮裁剪、空数组与 legacy fallback、深冻结输入不变、确定性、三协议多工具/null 结果配对、说明绑定、partial 容量与诊断目录顺序。

文档：本文件。没有更新请求指纹 fixture、reviewed-live-sources pin 或生成 schema。

与计划一致：两处装配入口和说明容量探测共用纯函数，模型原请求不变。实现另外拆出 `replayModelContext()` 和 `selectTaskModelTools()`，分别保留协议续接的原校验时点、集中现有诊断过滤；执行循环仍负责实际工具执行和门禁判断。这是抽取的内部边界，没有增加本期业务范围。

## 验证与证据

本节至“PR 前同步 main”之前均为 `079b7b6` 起点的原始验收。

证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/`。

原生检查使用现有 Node 24.21.0：`/Users/kouzen/.npm/_npx/538786c08bcb9442/node_modules/node/bin/node`，`TMPDIR=/private/tmp`、`TZ=UTC`。长时间命令使用 `caffeinate -i`，仅在本次命令生命周期内保持唤醒。

| 检查 | 结果 | 证据 |
|---|---|---|
| `CI=true pnpm install --frozen-lockfile` | exit 0；锁文件未变 | 开工工具输出 |
| `node --test tests/agent-task-request-fingerprints-v2.test.ts` | 原生检查与 Linux 全量均匹配 87 条原始请求指纹，fixture 未更新 | `candidate-agent-task-request-fingerprints-v2.test.ts.tap` |
| `node --test tests/agent-task-context-v2.test.ts` | 9/9 通过，0 失败、0 跳过 | `context-unit-tests.tap`、`context-unit-result.json` |
| `node scripts/tooling.ts typecheck` | exit 0，三个严格项目通过；后续构建再次检查当前全部源码 | 工具输出、`build-development.log` |
| `node scripts/tooling.ts build --channel=development` | exit 0；包含当前全部源码和新增单测的严格类型检查，Web 与 Desktop development 构建完成；仅有既有大 chunk 提示 | `build-development.log` |
| `git diff --check` | 通过 | 收尾工具输出 |

87 条 fixture SHA-256 保持 `1813840e99f88c7bd245c62472ef9adec64ba894802d28457d11a9e4445a0de2`。本期没有更改 fixture 内容或使用 `--update`。新增模块和调整的 runtime 不在 reviewed-live-sources 名单中，因此不需要更新该 pin。

### 请求与存储测量

执行：

```sh
TMPDIR=/private/tmp TZ=UTC node tests/helpers/agent-task-context-report.ts \
  --output=/Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/context-report.json
```

与 H0 原始 `measurement-agent.json` 全对象深比较相等，包含每次请求、每个模型步骤、全部配额表和容量估算；比较结果保存为 `context-report-comparison.json`。

| 协议 | 请求字节首→末（H0 = H1a） | 单轮配额字节（H0 = H1a） | 配额行 | 文本事件 |
|---|---:|---:|---:|---:|
| Chat Completions | 125,665 → 250,413 | 2,428,656 | 99 | 50 |
| Responses | 124,400 → 249,664 | 2,425,320 | 99 | 50 |
| Anthropic Messages | 122,872 → 247,720 | 2,412,248 | 99 | 50 |

每个模型步骤的落库数据字节也逐项相等（按步骤 1–5）：

| 协议 | H0 = H1a 的 `storedDataBytes` |
|---|---|
| Chat Completions | 230,046 / 292,585 / 355,063 / 417,541 / 480,019 |
| Responses | 228,706 / 291,523 / 354,279 / 417,035 / 479,791 |
| Anthropic Messages | 226,662 / 289,257 / 351,791 / 414,325 / 476,859 |

落库测量沿用生产配额口径，为 SQLite 数据列保留的 UTF-8 字节，不包含页、WAL 开销或同一行的累计重写量。

所有指标差值为 0，token 用量仍为 `null`。原有长执行在 5 次模型请求、10/30 步后触发历史上限的行为同样保留；这项改善属于后续阶段。本期没有通过改变预算、容量或结果大小让该探针通过。

### 全量与 H0 按测试名对比

候选源码冻结后完成隔离 Linux 全量检查，再对唯一失败进行干净 main 与候选的配对复验；没有发现可复现的 H1a 新增失败。

环境使用 H0 记录的现有不可变镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`（Linux arm64、Node 24.21.0、完整 FFmpeg/ffprobe 7.1.5、GNU tar 1.34），非 root、断网。当前 lock 与 H0 依赖一致，复用的是独立克隆的 Linux 依赖，源码重新从 H1a 同步并核对，没有使用 H0 旧源码冒充当前候选。

候选源码快照摘要：`476d301e51e47301e9aa23d744d2fa038eaa6e64d9a0821cf0dcecb31b9ff3ea`。本轮完整清单 915 文件，先 15 个 exclusive 文件顺序执行，再 900 个文件并发 4；每文件独立容器与进程，内层 600 秒、外层 630 秒上限，直接文件 stdio。开始与结束核对 5,915 个快照文件的哈希一致；清单无缺失、无重复，测试结束后本轮容器、driver 和防睡眠进程均已退出。

| 检查层 | 文件 | 具名测试 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|---:|---:|
| 首次全量原始结果 | 915（914 exit 0） | 14,575 | 14,552 | 1 | 22 |
| 配对复验：干净 `079b7b6` 的 gain-wire 整文件 | 1 | 37 | 37 | 0 | 0 |
| 配对复验：未改动候选的 gain-wire 整文件 | 1 | 37 | 37 | 0 | 0 |
| 补充复验后的有效覆盖 | 915 | 14,575 | 14,553 | 0 | 22 |

首次全量唯一失败是 `tests/agent-timeline-gain-wire.test.ts` 中的 `responses: gain history branches once and historical recovery never restores a discarded redo branch`。错误为 `Timed out: owned backend readiness`，后端停留在 `server-starting`，约 12 秒后超时，尚未进入该用例的模型请求和业务断言。H0 同名结果为通过；候选与干净 main 的该测试文件字节相同。全量负载结束后，两边在同一镜像顺序隔离运行整个文件，均 37/37 通过，原失败未复现。没有修改源码、超时或断言。

原始失败保留在 `candidate-agent-timeline-gain-wire.test.ts.tap` 和 `candidate-results.json`。配对日志为 `clean-main-isolated-agent-timeline-gain-wire.test.ts.tap`、`candidate-isolated-agent-timeline-gain-wire.test.ts.tap`，汇总为 `paired-isolated-results.json`。有效覆盖只用该候选整文件复验补充原失败文件，**不表示首次全量全绿，也不表示另跑了一遍完整全量**。

H0 参考按文件和测试名合成原全量、37 个失败文件的修复复验、最终类型检查及官方 87 指纹检查，共 911 文件、14,540 个具名结果。比较键为文件路径、完整 TAP 层级名称和重名出现序号；核对所有状态与跳过原因，结果如下：

- 精确同名匹配 14,534 项；新增名称 41 项，缺失名称 6 项。
- 本期新增纯函数测试 9 项；最新 main 的发布、打包及媒体校验测试带来 30 个新名、4 个旧名替换或移除；另有 2 对名称包含 `process.pid`，宿主与容器 PID 不同。
- 当前相对 H0 多 4 个测试文件：main 的 `actions-apple-keychain`、`actions-smoke-diagnostics`、`desktop-archive-member`，以及本期 `agent-task-context-v2`。
- 914 个既有测试文件的字节均与起点 `079b7b6` 一致，本期没有删改既有测试。唯一新增文件是 9 项上下文单测。
- H0 与候选均 22 项跳过；没有新增或消失的跳过名称，匹配项的状态与跳过原因差异为 0。

H0 参考混合了原生全量与对应环境的修复复验，本轮候选全量统一使用固定 Linux 镜像；环境差异没有被当成业务差异。精确新增与缺失名称、原始失败及复验分类保存在 `h0-candidate-test-name-comparison.json`，测试源码归属证据为 `candidate-test-source-ancestry.json`。

| 必需子集（可能相互重叠） | 文件 | 测试 | 结果 |
|---|---:|---:|---|
| harness（task v2、界面、编辑保护、人工协作） | 22 | 609 | 全部通过、0 跳过 |
| `mio-*` | 8 | 85 | 全部通过、0 跳过 |
| crash | 4 | 43 | 全部通过、0 跳过 |
| recovery | 47 | 708 | 全部通过、0 跳过 |

子集清单和逐项状态见 `candidate-regression-subsets.json`。

实际全量、复验与对比入口（脚本内部为各测试保留完整 Docker 命令，并用 `caffeinate -i -w driverPID` 覆盖运行生命周期）：

```sh
TMPDIR=/private/tmp python3 /Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/candidate-suite.py
TMPDIR=/private/tmp python3 /Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/paired-isolated.py
python3 /Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/compare-h0.py
python3 /Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/finalize-evidence.py
```

完整证据索引与最终计数：`H1a-validation-summary.json`；结束快照校验：`candidate-final-integrity.json`。

其中 `agent-task-runtime-v2.test.ts` 已在该镜像通过 176/176、0 跳过，以下两项均实际执行通过，证据为 `agent-task-media-confirmation.json` 和 `candidate-agent-task-runtime-v2.test.ts.tap`：

- `whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`
- `retained shot keeps a late product without selecting it and never dispatches after reversion`

## PR 前同步 main

按用户“拉取 origin/main 更新后，提 PR”的授权，执行 `git fetch origin main`，再以 `git merge --ff-only origin/main` 从 `079b7b6` 无冲突快进到 `43c9c6e805a6528fa0595c7b48f93bbfe1f60ba1`。H1a 的两个业务文件和新增单测与原始验收时的字节完全一致。

main 已包含 C7a、schema 谱系和 SQLite `busy_timeout` 修正。C7a 的 `ce29ab3` 已更新 87 条请求指纹 fixture，其 SHA-256 为 `4507448cc42c74309d8bcc6e8d158b32fe41e07ccd2292daf8db6d9c320b7447`；本期不再更新 fixture，以新 main 的指纹验证请求字节不变。锁文件仍为 `1f01209b29290b248b96045912aa4fb70d10beb32139de496047d4217163fb42`。

同步验证证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/pr-refresh-43c9c6e/`。

`TMPDIR=/private/tmp TZ=UTC node scripts/tooling.ts build --channel=development` 再次 exit 0，包含当前全部源码的严格类型检查及 Web、Desktop development 构建；日志为该子目录的 `build-development.log`。

独立 `git archive 43c9c6e` 展开干净 main，克隆本地已有依赖并核对 business/runtime/contracts 的实际解析路径均位于该独立目录，避免误用 H1a 模块。两边使用 Node 24.21.0、UTC 和 `caffeinate -i` 执行同一 `tests/helpers/agent-task-context-report.ts`，完整报告全对象与原始 JSON 字节均相等。命令、源码哈希和导入路径证据为 `measurement-comparison.json`，原件为 `measurement-main43.json`、`measurement-h1a.json`。

| 协议 | 请求字节首→末（main 43c9c6e = H1a） | 单轮配额字节（main = H1a） | 配额行 | 文本事件 |
|---|---:|---:|---:|---:|
| Chat Completions | 125,691 → 250,439 | 2,428,786 | 99 | 50 |
| Responses | 124,426 → 249,690 | 2,425,450 | 99 | 50 |
| Anthropic Messages | 122,898 → 247,746 | 2,412,378 | 99 | 50 |

相对原始 `079b7b6`，新 main 的工具 schema 使每次请求增加 26 字节、单轮配额增加 130 字节；这一差异在干净 main 和 H1a 中相同。本期相对最新 main 的每次请求、逐步落库、配额、行数和事件数差值均为 0，token 仍为 `null`。

同步后补跑 84 文件聚焦回归：原 harness、Mio、crash、recovery 子集去重，再加入 `agent-task-m5-storage`、`storage-main-schema-integration`、`workspace-schema-lineage`、`subject-variants` 和 `image-edit-profiles`。全部 1,496/1,496 通过，0 失败、0 跳过、0 文件级超时；清单无缺失、无重复。新 main 的 87 条指纹全部匹配，runtime 176 项中两项指定真实 FFmpeg 用例再次实际通过。

仍使用上述固定 Linux 镜像、Node 24.21.0、完整 FFmpeg 7.1.5，非 root、断网；每文件独立容器和进程，内层 600 秒、外层 630 秒上限，并发 2，`caffeinate -i` 覆盖运行生命周期。源码快照为 `d49cf37f57db09941c70b47642681200aaa6ba0fa959ab46525e1f8f09f598cf`，5,934 个快照文件在测试结束时未变；本次之后仅补充验证文档。

入口为：

```sh
TMPDIR=/private/tmp python3 /Users/kouzen/Library/Caches/mioon-harness-H1a-2026-10-27/pr-refresh-43c9c6e/refresh-suite.py
```

逐文件实际命令、结果、快照校验和工具版本见 `refresh-results.json`，两项 FFmpeg 名称与 TAP 路径见 `refresh-media-confirmation.json`。这是更新 main 后的聚焦回归；前文 915 文件全量仍明确属于 `079b7b6` 起点，没有将其表述为 `43c9c6e` 的全量结果。

## 兼容与完成边界

现有 Run、Step、Change、模型原请求、旧记录读取、恢复副本和 CLI 调用方保持原行为；新指标不落库、不暴露为公共契约。原生 macOS 的系统 FFmpeg 仍缺少部分能力，媒体结论以明确记录的 Linux 复验为准。本次构建不属于原生应用发布验收。

只完成 H1a，验收后再进入下一阶段。本次按用户授权同步 main、提交、推送并创建 PR；不合并 PR，不进入 H1b。合并方式沿用 merge commit。
