# Mio harness H1b · 工具分组与按需加载

日期：2026-10-27–28（Asia/Taipei）。起点：`ae83ff0faada0311603a519f412183c8ec79a84c`，已通过 merge commit 合入 H1a（PR #51）。

分支：`codex/mio-harness-h1b`。复用用户已切到该分支的干净 managed worktree：`~/.codex/worktrees/mio-harness-h1a/mioon`。开工时 HEAD 与新拉取的 `origin/main` 相同，没有未提交改动。

## 实现与计划对照

仅实施 H1b：默认核心组，其他工具按需加载，模型步骤是否有权调用工具取决于它的冻结请求。

- 业务：新增纯 `task-tool-groups-v2.ts`，定义核心及 11 个非核心组；`task-tools-v2.ts` 在分档旁接入实际目录的完整分组覆盖断言和只读宿主 `mioon_tools_load`。参数为非核心组闭集，去重并按固定组序排列；结果仅包含本次新增的组及其工具名，重复加载返回空新增集合。
- 上下文与运行时：`task-context-v2.ts` 从本轮已完成的宿主加载步骤派生可见组，保持原目录顺序；带附件时自动显示托管素材／Cube 导入工具。`task-runtime-v2.ts` 在准备、目标读取、审批和执行前检查来源模型步骤原始 body 的工具列表。未加载工具写入普通 rejected 步骤，返回 `TOOL_NOT_LOADED` 和对应组，随后可由模型重新规划。
- 网关：宿主独立传入可信完整目录，允许解析“已知但未加载”的调用，再交由运行时拒绝；请求 body 或模型不能扩充该目录，未知工具继续是协议错误。四语加载指令只为非诊断新请求追加；加载工具描述按本轮语言投影，旧工具定义不改。
- 展示：只在 `mio-panel.ts` 新增实际步骤标题使用的 `agent.display.operation.tools.load` 四语文案；不改界面结构或公共操作描述目录。加载工具不进入公共业务 schema、RPC、MCP 或 CLI 发现。
- 测试：新增分组和运行时加载边界用例；原编辑、审批、冲突、预算及崩溃恢复合成流程先真实加载再继续原业务脚本，断言计入新增模型往返和工具步骤，不过滤公开快照来隐藏加载步骤。Windows 原生 smoke 的合成模型同样改为先加载再编辑。
- 文档：更新 `docs/AGENT-TASKS-V2.md` 和本文件；新增离线工具组字节测量 helper。

契约与传输：无公共契约、HTTP、client、RPC、MCP 或 CLI 接口变更；传输改动仅为内部模型网关的宿主目录参数与协议解析，CLI 调用方保留原行为。

分组语义按计划保持。为避免纯上下文函数依赖工具执行器，分组表放在分档文件旁的独立纯模块，覆盖断言仍在实际 `list()` 目录上执行。两个附件导入工具分别归入 assets、colour 组，并额外按本轮附件自动显示；每个模型可见工具仍恰好属于一个组。C7a 尚未向 Mio 开放的 `subject.variants.*` 和 `image.review.*` 不借本期扩充授权。

## 保留的控制与兼容边界

- 每个模型步骤、工具步骤继续按原规则计步，加载工具计 1 步、无 Change，仍受只读策略、暂停、停止、授权和未知结果门禁约束。
- 成功加载的组在本轮只增不减，新一轮从核心组开始；失败、待确认或未知的加载结果不扩大可见范围。
- 同一回复先加载再调用原请求没有的工具，后者仍被拒绝。加载步骤之后才生成的新模型请求才能看到新增工具。
- H1b 前保存的全量工具 intent 按原 body 和原工具列表继续执行，不重新装配。已完成步骤、未知结果和恢复副本规则保持。
- 诊断沿用原选择规则，排除新加载工具，且不附加加载系统指令。
- 不升级工作区格式，不新增表或 Run/Step 持久字段，不删除、重写已有请求和历史；加载结果保存在既有 tool 步骤的自由 JSON 中。不新增依赖、不调用真实模型或付费生成。

## 验证环境与证据

证据目录：`~/Library/Caches/mioon-harness-H1b-2026-10-27/`。原生环境为 Node 24.21.0、`TMPDIR=/private/tmp`、UTC。长时间命令使用本次进程生命周期内的 `caffeinate -i`。

Linux 使用 H0 的固定完整媒体镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`，Node 24.21.0、完整 FFmpeg/ffprobe 7.1.5、GNU tar 1.34，非 root、断网。每文件独立进程和有界超时。基线源码从 `ae83ff0` 独立展开，不混用候选源码。

### 请求指纹

先用独立干净 `ae83ff0` 重采集原 87 条指纹，逐条匹配原 fixture；再在未更新 fixture 时采集候选并复核原文结构。复核后才执行正式 `--update`，随后连续两次正式指纹测试通过，且每次都重新核对 12 条诊断记录与冻结基线完全一致。

| 类别 | 条数 | 变化原因 |
|---|---:|---|
| 普通核心请求 | 39 | 原目录改为核心 13 工具；附件场景另自动显示两个托管导入工具；追加本轮语言的加载指令及加载工具描述 |
| 加载后的原业务流程 | 36 | `read_edit_roundtrip`、`official_read_edit_roundtrip`、`conflict_skip_replan`、`tool_failure_retry` 在原流程前真实加载 canvas，随后目录为核心加 canvas，历史增加该加载往返 |
| 新增加载请求 | 12 | 上述 4 场景 × 3 协议各新增一个真实加载模型请求；原场景请求 index 顺延 1 |
| 诊断原请求 | 12 | text、read_only、catalog 的原文、字节数、SHA-256 和完整记录均不变，无新工具或指令 |

原 87 条全部有明确映射：75 条普通请求有预期变化、12 条诊断不变，加上 12 条新请求后为 99 条；没有删除原场景。

结构复核覆盖全部 186 份观察原文，均与采集的 byte/SHA 对应；原 98 工具定义不变，三协议 × 四语言共 1,176 项原 wire 定义深比较相等，保留 `_mio_step`、原 schema、原目录顺序和所有协议控制字段（包括官方预设的 parallel、choice、strict）。普通系统指令只追加对应语言后缀。映射历史中 51 条本来相等，36 条移除唯一加载往返后严格相等；12 条新增加载请求使用原初始历史，无其他未分类差异。

原文观察器只加在 cache 内的独立副本，先经过原请求和合成密钥保护检查；正式 helper/API、fixture 不保存 observer 或请求正文。只读结构证据：`candidate-request-structure-proof-1.json`、`catalog-structure-proof.json`；原请求到新请求的完整映射：`candidate-fingerprint-review-1.json`。

实际更新及复验入口：

```sh
TMPDIR=/private/tmp TZ=UTC node tests/helpers/agent-task-request-fingerprints-v2.ts --update
TMPDIR=/private/tmp TZ=UTC node --test --test-reporter=tap tests/agent-task-request-fingerprints-v2.test.ts
# 上一条连续执行两次，均使用 Node 24.21.0 和 caffeinate -i
```

fixture SHA-256：`4507448cc42c74309d8bcc6e8d158b32fe41e07ccd2292daf8db6d9c320b7447` → `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`。两次正式采集均与更新前已复核的 99 条候选完全一致。日志：`fingerprints-authorized-update.tap`、`fingerprints-final-run1.tap`、`fingerprints-final-run2.tap`；稳定性汇总：`fingerprint-stability-results.json`。

本次生产改动不在 `reviewed-live-sources.json` 名单中，没有更新该 pin；公共操作 schema 未变，不运行公共 schema 生成器。

### 核心组、各组与请求字节

测量 helper：`tests/helpers/agent-task-tool-group-report.ts`，使用生产目录、分组和真实 `buildTaskModelRequest()`，无模型或供应商请求。配置为 local/ollama，固定英文输入与 `en` 语言。

每个协议列为“仅该组的 wire tools 数组字节 / 核心加该组的完整请求字节”。core 行即核心请求。原定义字节只序列化 name、description、parameters；wire 还包括协议包装、`_mio_step` 和 schema 投影。数组各自包含括号，完整请求还包含控制字段，因此不可直接相加推算请求。

| 组（工具数） | 原定义字节 | Chat Completions | Responses | Anthropic Messages |
|---|---:|---:|---:|---:|
| core (13) | 4,636 | 10,612 / 11,878 | 10,443 / 11,718 | 10,235 / 11,550 |
| canvas (11) | 7,156 | 12,216 / 24,093 | 12,073 / 23,790 | 11,897 / 23,446 |
| subjects (6) | 3,146 | 5,906 / 17,783 | 5,828 / 17,545 | 5,732 / 17,281 |
| assets (9) | 6,247 | 10,387 / 22,264 | 10,270 / 21,987 | 10,126 / 21,675 |
| editing (13) | 20,580 | 26,559 / 38,436 | 26,390 / 38,107 | 26,182 / 37,731 |
| subtitles (3) | 1,686 | 3,066 / 14,943 | 3,027 / 14,744 | 2,979 / 14,528 |
| audio (7) | 6,846 | 10,066 / 21,943 | 9,975 / 21,692 | 9,863 / 21,412 |
| colour (7) | 2,920 | 6,140 / 18,017 | 6,049 / 17,766 | 5,937 / 17,486 |
| exports (5) | 9,532 | 11,831 / 23,708 | 11,766 / 23,483 | 11,686 / 23,235 |
| video (5) | 3,661 | 5,958 / 17,835 | 5,893 / 17,610 | 5,813 / 17,362 |
| images (9) | 6,275 | 11,272 / 23,149 | 11,155 / 22,872 | 11,011 / 22,560 |
| scenes (11) | 6,807 | 11,865 / 23,742 | 11,722 / 23,439 | 11,546 / 23,095 |

模型目录合计 99 个工具，正常初始请求为 13 个；诊断原目录仍为 98 个。若加载全部组，同一固定英文输入下的完整请求分别为 127,133 / 125,855 / 124,311 字节，包含新加载工具及指令。

### 长执行请求与存储对照

使用原 `tests/helpers/agent-task-context-report.ts`，干净 `ae83ff0` 与候选均为同一合成负载：每次回复约 30 KiB、每个 delta 3 KiB、最多 30 步；该流程只使用核心 `project.inspect`，无需新增加载往返。以下为逐次请求字节：

| 协议 | 基线请求 1–5 | H1b 请求 1–5 |
|---|---|---|
| Chat Completions | 125,691 / 156,878 / 188,065 / 219,252 / 250,439 | 11,939 / 43,126 / 74,313 / 105,500 / 136,687 |
| Responses | 124,426 / 155,742 / 187,058 / 218,374 / 249,690 | 11,779 / 43,095 / 74,411 / 105,727 / 137,043 |
| Anthropic Messages | 122,898 / 154,110 / 185,322 / 216,534 / 247,746 | 11,611 / 42,823 / 74,035 / 105,247 / 136,459 |

每个模型步骤的落库数据字节：

| 协议 | 基线模型步骤 1–5 | H1b 模型步骤 1–5 |
|---|---|---|
| Chat Completions | 230,072 / 292,611 / 355,089 / 417,567 / 480,045 | 105,714 / 168,253 / 230,731 / 293,209 / 355,687 |
| Responses | 228,732 / 291,549 / 354,305 / 417,061 / 479,817 | 105,649 / 168,466 / 231,222 / 293,978 / 356,734 |
| Anthropic Messages | 226,688 / 289,283 / 351,817 / 414,351 / 476,885 | 105,305 / 167,900 / 230,434 / 292,968 / 355,502 |

| 协议 | 单轮配额字节：基线 → H1b | 差值 | 配额行 | 文本事件 | 估算额外同负载轮次：基线 → H1b |
|---|---:|---:|---:|---:|---:|
| Chat Completions | 2,428,786 → 1,806,990 | -621,796 | 99 → 99 | 50 → 50 | 109 → 147 |
| Responses | 2,425,450 → 1,810,029 | -615,421 | 99 → 99 | 50 → 50 | 109 → 147 |
| Anthropic Messages | 2,412,378 → 1,805,457 | -606,921 | 99 → 99 | 50 → 50 | 110 → 147 |

三协议首请求下降约 90.5%，单轮保留字节下降约 25%。落库测量沿用生产配额 inventory，为 SQLite 数据列保留的 UTF-8 字节，不包含页、WAL 或同一行累计重写量。容量估算只适用于相同负载，不是其他流程的承诺；加载流程会额外产生模型及工具步骤。

最终 `3151630b` 快照在同 Linux 镜像重新执行 `node tests/helpers/agent-task-context-report.ts` 和 `node tests/helpers/agent-task-tool-group-report.ts`，均 exit 0；两份完整 JSON 分别与复核过的初测结果深比较相等。最终原始数字及命令见 `final-context-report.json`、`final-tool-group-report.json`、`final-measurement-results.json`。

基线和 H1b 均在 5 次模型请求、10/30 步后触发同一 `AGENT_CHAT_LIMIT` 历史上限。行数、文本事件和限制不变，token 用量均为 `null`；本期没有实施 H1c，也没有更改预算、输出或历史上限以改变探针结果。

### 全量测试与基线按名称对比

本节保留首次交付的完整验证记录。2026-10-28 审查修复后的最终验证见下方“审查修复”一节，两次候选的证据独立保存。

最终统一候选快照：`3151630b84c89fbfde810ce294a30cbfbed908aeb746fb0d9517ec190bb61156`，5,939 个源文件，920 个测试文件。先顺序运行 16 个排他文件（原 15 个加上 H1a 曾出现后端启动超时的 gain-wire），共享队列起初并发 4。每文件独立容器，内层 600 秒、外层 630 秒上限，直接 TAP 文件 stdio；driver 生命周期使用 `caffeinate -i -w driverPID`。

运行期间观察到共享 VM 资源争用：4 核、24 容器中本轮仅 4 个；CPU 总计约 421%，其中其余容器约 300%；约 3 GiB 可用内存，1 GiB swap 仅余约 536 KiB。观察没有读取其他容器业务日志或停止其他容器，也不能单凭这些数字给每项失败确定单一原因（`readiness-resource-observation.json`、`typecheck-exit137-resource-observation.json`）。

为减少本轮争用，对专用 driver 定向中止继续调度，让 4 个在途测试按原有边界自然结束。前段累计 82 个唯一文件，0 强制中断；其余 838 文件从同一冻结清单减去已完成集合后单并发续跑。原始失败保留，未修改测试、源码或超时；两段始终使用同一 `3151630b` 快照。

完整覆盖已完成，920 个唯一文件，无缺漏、无重复，5,939 个快照源文件未变化。原始 Linux 结果为 915 文件 exit 0、5 文件未通过，文件级 600/630 秒超时为 0；原始 TAP 为 14,596 通过、25 失败、7 取消、22 跳过，共 14,650 项。

队列清空后，同镜像串行配对干净 `ae83ff0` 与未改动的候选整文件：

| 文件 | 原始未通过 | 干净 main Linux | 候选 Linux | 补充验证 |
|---|---|---|---|---|
| `agent-edit-wire.test.ts` | 1 项后端启动等待超时 | 37/37 | 37/37 | 原失败未复现 |
| `agent-task-crash-v2.test.ts` | 7 项 25 秒测试超时，被 Node 计为 cancelled | 12/12 | 12/12 | 原失败未复现 |
| `agent-task-http-v2.test.ts` | 4 项 CLI status/control 子进程超时 | 20/20 | 20/20 | 原失败未复现 |
| `agent-timeline-gain-wire.test.ts` | 19 项 module-loading/server-starting 等待超时 | 37/37 | 37/37 | 原失败未复现 |
| `typecheck-runtime.test.ts` | 首项编译子进程返回 137，无 TS 诊断 | 4/5，首项仍 137 | 4/5，首项仍 137 | 同候选原生 Node 24 整文件 5/5 |

前四文件在两边各 106/106 通过；原失败均完整保留，没有修改测试、源码或 deadline。配对前观察到其余容器 CPU 已降至约 73.7%、VM load 约 0.91/1.39/2.23；这些观察与复验结果不等于证明了每项失败的单一原因。

Linux 编译首项的确切名称为 `repository source policy and genuine compiler check all current included runtime sources`。干净 main 约 79.8 秒、候选约 75.6 秒，同样返回 137，没有 TypeScript 诊断，不能归为 H1b 新增回归。该 Linux 检查仍未通过，未将其改报为绿灯。候选原生 Node 24.21.0、UTC、真实 TMPDIR、现有 GNU tar 下整文件 5/5 通过，约 42 秒，真实执行三个严格编译项目、CLI、官方 MCP 和 React；源码内原有 150 秒测试／120 秒编译子进程边界保持，外层仅加 300 秒有界保护。

| 结果层 | 唯一文件 | 具名测试 | 通过 | 失败 | 取消 | 跳过 |
|---|---:|---:|---:|---:|---:|---:|
| 原始 Linux 完整覆盖 | 920 | 14,650 | 14,596 | 25 | 7 | 22 |
| 补充复验后的有效覆盖 | 920 | 14,650 | 14,628 | 0 | 0 | 22 |

**有效覆盖组合了原始全量、同源码 Linux 整文件复验和原生类型检查；不表示首次 Linux 全量全绿，也不表示又跑了一遍完整全量。** 两边相同的 Linux 137 限制与原始所有失败/取消记录均保留。

精确测试名对照使用文件、完整 TAP 名称层级及重名序号，而非只比较文件数：

| 参考 | 参考文件／具名测试 | 同名匹配 | 新名称 | 缺失名称 |
|---|---:|---:|---:|---:|
| H0 原全量与对应环境修复复验 | 911 / 14,540 | 14,498 | 152 | 42 |
| H1a 有效全量 | 915 / 14,575 | 14,539 | 111 | 36 |
| H1a 全量加 `43c9c6e` 的 84 文件刷新 | 918 / 14,606 | 14,576 | 74 | 30 |

第三行是已执行结果的组合参考，不是独立跑过一整套干净 `ae83ff0`。干净 `ae83ff0` 只对候选失败和名称差异做针对性核对，不冒充第二套全量基线。

按 `ae83ff0` 测试源码归因，H1b 净增 39 项：gateway 15、group 5、loading 18、真实 caption 1；另有两项 runtime 用例为加载多出的模型／工具两步，将名称中的预算 3 改为 5，原行为断言保留。因此 H1b 精确新增名称 41、缺失名称 2，净增 39；其余 33 个新名、28 个缺失名来自本期前的主干变更及动态 PID 名称。所有参考与候选均 22 项跳过，跳过状态与跳过原因差异为 0，无新增跳过。

`agent-task-runtime-v2.test.ts` 在完整镜像实际通过 176/176、0 跳过，指定两项均实际执行通过：

- `whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`
- `retained shot keeps a late product without selecting it and never dispatches after reversion`

原始结果与逐文件命令：`candidate-results.json`；配对：`paired-isolated-results.json`；原生补验：`native-typecheck-runtime-final.tap`、`native-typecheck-runtime-final.json`；精确名称与归因：`test-name-comparison.json`、`test-name-delta-provenance.json`；媒体证明：`agent-task-media-confirmation.json`。cache TAP 解析器将 `testTimeoutFailure` 按 Node 原页脚归为 cancelled，7 项具名状态与原页脚一致；原派生 JSON 已备份，原 TAP、退出码及原始计数未改。

有效回归子集：harness 24 文件／651 项、Mio 8 文件／85 项、crash 4 文件／43 项、recovery 47 文件／708 项，均通过；集合之间存在重叠，不将其累加为额外覆盖。Windows 原生 smoke 的现有平台跳过保持，本期没有宣称完成 Windows 原生验收。

实际 driver 入口如下；这些脚本在 cache 内保存，逐容器参数、文件命令和中途切换记录均由结果 JSON 索引：

```sh
H1B_EVIDENCE=~/Library/Caches/mioon-harness-H1b-2026-10-27
TMPDIR=/private/tmp python3 "$H1B_EVIDENCE/candidate-suite.py"
TMPDIR=/private/tmp python3 "$H1B_EVIDENCE/candidate-resume.py"
TMPDIR=/private/tmp python3 "$H1B_EVIDENCE/paired-isolated.py"
TMPDIR=/private/tmp python3 "$H1B_EVIDENCE/measure-final-candidate.py"
python3 "$H1B_EVIDENCE/finalize-evidence.py"
python3 "$H1B_EVIDENCE/write-final-summary.py"
```

最终摘要 `H1b-validation-summary.json` 与统一索引 `H1b-evidence-index.json` 包含原始结果、补验组合和所有证据路径。`candidate-final-integrity.json` 核对结束快照 5,939 文件 SHA 不变；主代理再核对当前工作区对应 5,939 文件，全部一致，只有本报告随后补齐。本阶段 9 个精确 label 的容器、自有 driver 与已记录 caffeinate 均无遗留；未停止其他用户进程。收尾 HEAD 仍为 `ae83ff0`，无暂存或新提交。

### 类型与构建

在本 worktree 运行 `CI=true pnpm install --frozen-lockfile` 成功，依赖和锁文件未变（`install.log`）。所有下面的 Node 检查使用 24.21.0、真实 `TMPDIR`、UTC 和 scoped `caffeinate -i`：

| 检查 | 实际结果 | 证据 |
|---|---|---|
| `node --test tests/agent-task-gateway-v2.test.ts` | 74/74，涵盖三协议宿主目录、隐藏工具、未知工具、旧 metadata 处理与四语指令 | `gateway-final.tap` |
| `node --test tests/agent-task-http-v2.test.ts` | 20/20，保留 HTTP/CLI 回执、审批、跳过、撤销和安全投影 | `http-initial.tap` |
| runtime 开发检查 | 前半 88/88、后半 86/86；仅两个本机缺完整 FFmpeg 的用例留给 Linux 全量 | `runtime-front-development.tap`、`tools-runtime-tail.tap` |
| 加载/context、分组 | 27/27、5/5 | `runtime-loading-context.tap`、`group-caption-fixed.tap` |
| 实际面板标题与公共操作目录 | 23/23，四语言加载步骤无需模型文案也显示正确标题，公共操作描述目录保持完整且未扩展 | `caption-tests.tap` |
| `node scripts/tooling.ts build --channel=development` | exit 0，包含严格 runtime/tooling/tests 类型检查，Web 与 Desktop development 构建完成 | `build-development-caption-fixed.log` |
| `git diff --check`；新增文件逐个 `git diff --no-index --check /dev/null 文件` | 全部通过，含 5 个新增文件 | 收尾命令输出 |

收尾发现最初的加载文案放在公共操作描述目录，实际面板从 `mio-panel.ts` 的 `agent.display.operation.*` 读取短标题。修正为正确标题键，补了真实 `taskStepTitle()` 四语回归，撤回不必要的公共目录及其测试变更；后续构建先捕获到分组单测仍引用旧键的类型错误，更新该测试至实际标题目录后严格构建通过。此前成功/失败的开发构建日志均保留，没有降级类型检查。

全量刚启动时为这项修正停止了旧快照尝试：4 文件已完成、1 文件明确中断，专用 driver、容器和防睡眠进程已结束。原记录在 `aborted-before-caption/`，由 `abort-checkpoint.json` 记录，不计入最终覆盖。修正后重新冻结单一源码快照跑完整全量。

## 审查修复（2026-10-28）

修复前 `loadedAgentTaskToolGroups()` 将回执 tools 与当前组成员完整比较，且要求结果组恰等于按前序回执计算的新增组。以后组成员变化，会将合法旧回执误判为存储损坏；补充说明的容量探测还会经 `action` 的存储错误处理影响整个运行时。本次按审查要求删除这两种耦合，不改写已保存记录。

- 只读取已完成的宿主加载步骤。调用参数与结果须具有字符串数组 groups；结果必须是该条调用请求 groups 的子集，随后只采纳当前认识的非核心组。未知组忽略；校验无效只忽略该条回执，不影响之前／之后的合法加载，也不使用 `AGENT_TASK_STORAGE_*` 错误码。
- 回执 tools 是历史信息，不参与加载身份校验。后续请求仍从当前目录按已加载组投影，执行权限仍由来源模型步骤的冻结请求及原有门禁决定。新工具调用参数的严格闭集校验保持。
- 分组单测 5 → 9 项，补自身请求子集、未知组、无效回执隔离、旧 tools 元数据兼容；集成测试 18 → 24 项，在三协议下覆盖旧名单重启后继续、下一次请求显示当前成员、正常补充说明及其他项目继续执行，且旧回执保持原样。
- 更新 `docs/AGENT-TASKS-V2.md` 的兼容语义，移除原目录扩展限制，将 H1e 缓存备注记在下方。未扩展本阶段范围。

独立证据目录：`~/Library/Caches/mioon-harness-H1b-2026-10-27/review-fix-2026-10-28/`。修复源码快照 `0432d899ce241eeb6693651f1365fe3cd9e33093b75a148707501db66cb20278`，相对 `3151630b` 只变更业务文档、分组模块、分组及加载测试四个快照文件；本报告在快照外继续补齐。

全量修复候选在 418 个文件已有退出记录时因会话中断停止，原 driver 和自有容器均已结束。按原 920 清单减去已完成集合，剩余 502 个文件从同一 `0432d899` 快照续跑，保持逐文件 600／630 秒上限和原工具链。两个在途 TAP 虽已写页脚但缺少 driver 捕获的退出码，原件归档到 `interrupted-unrecorded-taps/`，不据此推断通过；只将其作为未完整记录文件重新运行。中断点、原 progress 备份和续跑进程均独立记录，不把两段当成第二套全量。

已实际完成的定向验证，均使用 Node 24.21.0、真实 `TMPDIR=/private/tmp`、UTC 和 scoped `caffeinate -i`：

| 命令／检查 | 结果 | 证据 |
|---|---|---|
| 旧实现执行新增 `--test-name-pattern="stale load receipt"` 用例 | 6/6 复现失败；3 项恢复状态失败、3 项补充说明抛存储不可用 | `stale-receipt-before.tap`、`.json` |
| `node --test --test-reporter=tap tests/agent-task-tool-groups-v2.test.ts` | 9/9 通过，0 跳过 | `group-receipts-after.tap`、`.json` |
| `node --test --test-reporter=tap tests/agent-task-tool-loading-v2.test.ts tests/agent-task-context-v2.test.ts` | 33/33 通过，含新增 6 项，0 跳过 | `loading-context-after.tap`、`.json` |
| `node scripts/tooling.ts build --channel=development` | exit 0，三个严格类型项目及 Web/Desktop development 构建通过 | `build-development.log`、`.json` |
| 原生 `node --test --test-reporter=tap --test-concurrency=1 tests/typecheck-runtime.test.ts` | 高负载时首项在原 120 秒编译子进程边界超时，4/5；负载实质回落、运行时重型段结束后，同源码同命令整文件复验 5/5，约 71 秒 | `native-typecheck-runtime.tap`、`.json`；`native-typecheck-runtime-recheck.tap`、`.json` |
| 正式指纹测试，不带 `--update` | exit 0；99 条与原 fixture 一致，12 条诊断与 `ae83ff0` 完全相同 | `measurement-final-comparison.json` 所列命令和 TAP |
| context/group 两个测量 helper | exit 0；完整 JSON 深比较及字节比较均与原 final 报告相等 | `measurement-final-comparison.json` |

本次修复不改变正常请求、落库字节、行数和 token 测量，上述表格继续适用。fixture SHA 仍为 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`，未更新 fixture、pin、依赖或公共 schema。

修复后的 Linux 全量覆盖已经完成：920 个唯一文件，918 文件 exit 0、2 文件未通过，0 个文件级超时、0 缺漏、0 重复。原始 TAP 为 14,660 项：14,632 通过、6 失败、0 取消、22 跳过。5,939 个冻结源文件在结束时均未变化（`repair-results.json`）。

原始失败仅有两类：`typecheck-runtime.test.ts` 首项编译子进程返回 137、没有 TS 诊断；`agent-timeline-gain-wire.test.ts` 的 5 项 owned backend readiness 等待失败，未进入业务断言。前者与修复前候选及干净 main 的已记录 Linux 失败同名同退出；本轮原生首次补验在高负载时触发原 120 秒编译边界，负载实质下降后同源码同命令 5/5 通过。两次原生记录和 Linux 失败均保留，不将 Linux 编译门禁改报通过。

本次修复相对 `3151630b` 净增 10 项：分组 +4、加载 +6。精确名称是新增 11 个、缺失 1 个，其中原分组校验用例改写为新的已完成宿主回执语义；其余名称差异须按未修改源码中的动态 PID 名称单独归因，不做模糊匹配。

修复全量的精确名称对照（原始状态保留）：

| 参考 | 参考文件／具名测试 | 同名匹配 | 新名称 | 缺失名称 |
|---|---:|---:|---:|---:|
| 修复前 H1b `3151630b` 原始全量 | 920 / 14,650 | 14,648 | 12 | 2 |
| 修复前 H1b 补验有效视图 | 920 / 14,650 | 14,648 | 12 | 2 |
| H0 | 911 / 14,540 | 14,498 | 162 | 42 |
| H1a | 915 / 14,575 | 14,538 | 122 | 37 |
| H1a 加 `43c9c6e` 刷新 | 918 / 14,606 | 14,575 | 85 | 31 |

与 `3151630b` 表面新增 12／缺失 2，其中 11／1 来自本次测试调整，另 1／1 是 `workspace-backup-lock.test.ts` 未改源码生成的 PID 名称（15 → 14）。各参考均 22 项跳过，跳过状态与跳过原因差异均为 0。证据为 `repair-test-name-comparison-raw.json`，按文件、完整层级名称及重名序号比较；参考的历史执行范围沿用前文限定，不冒充新跑的干净 main 全量。

本轮原始全量中，harness 24 文件／661 项、Mio 8／85、crash 4／43、recovery 47／708 均通过，集合可能重叠，不叠加为额外覆盖。

队列清空后，gain-wire 在同镜像单并发配对修复前 `3151630b` 与修复后 `0432d899`，两边均 37/37、exit 0，原 5 项启动等待失败未复现（`repair-paired-isolated-results.json`）。没有改源码、业务断言或测试时限。最终结果分三层保存：

| 结果层 | 唯一文件 | 具名测试 | 通过 | 失败 | 取消 | 跳过 |
|---|---:|---:|---:|---:|---:|---:|
| 修复候选原始 Linux 全量 | 920 | 14,660 | 14,632 | 6 | 0 | 22 |
| 加上同源码 Linux 隔离复验 | 920 | 14,660 | 14,637 | 1 | 0 | 22 |
| 再加同源码原生类型整文件补验的有效视图 | 920 | 14,660 | 14,638 | 0 | 0 | 22 |

**Linux 编译首项仍未通过；有效视图组合了 Linux 覆盖、Linux 整文件复验和原生补验，不代表 Linux 全绿，也不是又跑一遍全量。** 原始 6 项失败、原生首次 120 秒超时、两份缺少退出码的中断 TAP 均保留。

最终名称比较 `repair-test-name-comparison.json` 同时保存原始与有效状态。有效视图相对修复前 H1b 原始记录有 32 个状态改善（原失败／取消 → 通过）；相对其补验有效视图、H0、H1a、H1a 加刷新参考的同名状态差异均为 0，无回归状态变化。各参考跳过状态及原因差异为 0。

完整证据入口为 `repair-validation-summary.json`、`repair-evidence-index.json`、`repair-acceptance-check.json`；主代理另用 `root-effective-crosscheck.json` 独立重算三层总数，一致。验收核对 920 唯一文件、14,660 具名测试、418／502 两段记录、两份中断归档 SHA、5,939 源文件及五参考差异。原始、续跑、配对 label 均无残留容器，记录的 driver／caffeinate 和原生补验进程均已结束（含 `repair-native-process-completion.json`），没有停止其他用户进程。

实际全量、配对及汇总入口：

```sh
H1B_REPAIR_EVIDENCE=~/Library/Caches/mioon-harness-H1b-2026-10-27/review-fix-2026-10-28
TMPDIR=/private/tmp python3 "$H1B_REPAIR_EVIDENCE/repair-suite.py"
TMPDIR=/private/tmp python3 "$H1B_REPAIR_EVIDENCE/repair-resume.py"
python3 "$H1B_REPAIR_EVIDENCE/repair-paired-isolated.py"
python3 "$H1B_REPAIR_EVIDENCE/assemble-effective-verification.py"
python3 "$H1B_REPAIR_EVIDENCE/compare-repair-test-names.py" --results "$H1B_REPAIR_EVIDENCE/repair-results.json" --output "$H1B_REPAIR_EVIDENCE/repair-test-name-comparison.json" --effective-results "$H1B_REPAIR_EVIDENCE/repair-effective-results.json"
python3 "$H1B_REPAIR_EVIDENCE/finalize-repair.py" --effective-results "$H1B_REPAIR_EVIDENCE/repair-effective-results.json"
```

逐文件完整 Docker 命令保存在 `repair-results.json`，配对命令在 `repair-paired-isolated-results.json`，最后四步及独立验收 exit 0 的记录在 `repair-finalization-command-results.json`。依赖、锁文件、公共 schema、pin、fixture 和已保存的执行记录均未改写；HEAD 仍为 `ae83ff0`，未暂存、未提交、未推送。

## 同步 main 与 PR 交付（2026-10-28）

以上为 H1b 确认前的独立冻结验证记录。用户确认 H1b 后，另行授权同步最新 main、复验、提交、推送并创建 PR，要求使用 merge commit 合入，但本次不执行 PR 合并。

`git fetch origin main` 后，`origin/main` 为 `c75981d0cc8096f25558bf3e0e3b95122b1377d8`，新增 C7b／C7c 的界面、文案、测试和文档共 21 个文件，与 H1b 的 26 个工作文件无重叠。在 `codex/mio-harness-h1b` 执行 `git merge --ff-only origin/main`，HEAD 从 `ae83ff0` 快进到 `c75981d`；26 个 H1b 文件逐文件 SHA-256 完全保留，无冲突、无历史改写、无新增合并提交，也未切换主 checkout。

同步复验证据目录：`~/Library/Caches/mioon-harness-H1b-2026-10-27/sync-main-2026-10-28/`。同步前后哈希与实际命令在 `before-sync.json`、`sync-result.json` 和 `fast-forward.log`；该次同步后的验证与前述 `0432d899` 全量分开记录。

同步后源码快照为 `0e7a29b26a015f45c4a6132c2504202330a7265f0712db08e6e8950df260dd7f`，5,946 个源文件。使用相同固定 Linux 完整媒体镜像、Node 24.21.0、pnpm 11.25.0、UTC、完整 FFmpeg 7.1.5 和 GNU tar 1.34，逐文件独立进程、600／630 秒边界、双并发、scoped `caffeinate -i` 执行聚焦回归：

| 同步后检查 | 实际结果 |
|---|---|
| 正式 `agent-task-request-fingerprints-v2.test.ts`（包含在下行 harness 内） | exit 0；99 条请求匹配原 fixture；12 条诊断逐记录与 `c75981d` 的 main 相同；未使用 `--update` |
| harness：`agent-task-*-v2`、任务面板、编辑保护与手动协作 | 24 文件／661 项全部通过 |
| Mio 回归 | 8 文件／85 项全部通过 |
| 总计 | 32 文件／746 项通过，0 失败、取消、跳过或文件级超时，0 缺漏、重复 |
| runtime 与指定完整媒体用例 | 176/176；两项指定 FFmpeg 用例均实际执行通过 |

fixture SHA 仍为 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`。源码快照与当前工作区 5,946 文件核对无差异（可继续补写的本报告不在快照内），自有容器、driver 和 caffeinate 均已结束。该次按新增要求只复验 32 个文件；同步后仓库共有 921 个测试文件，没有将同步前 920 文件的全量改报成新 main 的全量结果。

实际入口：

```sh
H1B_SYNC_EVIDENCE=~/Library/Caches/mioon-harness-H1b-2026-10-27/sync-main-2026-10-28
python3 "$H1B_SYNC_EVIDENCE/prepare-focus-snapshot.py"
TMPDIR=/private/tmp python3 "$H1B_SYNC_EVIDENCE/focus-suite.py"
python3 "$H1B_SYNC_EVIDENCE/finalize-focus.py"
```

逐文件完整 Docker 命令、原始 TAP 和退出码在 `focus-results.json`；独立指纹、完整媒体、源完整性及进程收尾核对在 `focus-validation-summary.json`。聚焦中的正式 Node 命令为 `node --test --test-reporter=tap --test-concurrency=1 文件`，正式指纹以真实 fixture 比较通过，没有用静态哈希替代运行。

与修复后 `0432d899` 的相同范围逐名比较，746 项全部匹配，新增、缺失和状态变化均为 0（`focus-name-comparison.json`）；所有入口和证据在 `focus-evidence-index.json`。

## 完成边界

本期不实施 H1c 的结果截断或历史压缩。工具目录变小不会消除 128 KiB 历史上限；保留原超限语义，token 用量仍不伪造。

H1e 备注：加载新组会改变发给模型的工具列表，Anthropic 提示缓存会在加载后失效一次。设计最后一个工具定义和历史内容的缓存断点时，需要区分加载前后的目录，不能把二者视为相同缓存前缀；本期仅记录，不增加缓存字段或真实模型调用。

H1b 已确认；本次按后续授权同步、复验、提交、推送并创建 PR，保持 PR 未合并。H1c 已获实施授权，但须从包含 H1b 的最新 main 另开分支；在 H1b 合入前不开始 H1c 实现。
