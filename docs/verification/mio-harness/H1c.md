# Mio harness H1c · 工具结果视图与压缩

日期：2026-10-28（Asia/Taipei）。起点：`f554a21051238513abc2d22493c687ade0e2bca0`，即以 merge commit 合入 H1b 的 PR #54。开工时 fetch `origin/main`，HEAD 与该主线相同且工作区干净；从此建立 `codex/mio-harness-h1c`，复用 managed worktree，不改主 checkout。

阶段实施仅完成 H1c 并停下，未进入后续阶段。用户确认后授权的提交前同步与验证见第 7／8 节，最终提交基线为 c434c87；PR 要求使用 merge commit，未执行合并。

## 1. 实现范围

- 业务：新增 `task-result-view-v2.ts` 与 `task-context-compaction-v2.ts`；前者生成 16 KiB 合法 JSON 视图和存根，后者按完整模型往返重放高／低水位压缩。`task-context-v2.ts` 接入语义片段，新增单纯复制基础上下文的函数。`task-gateway-v2.ts` 仅增加视图字节常量。
- 运行时：`task-runtime-v2.ts` 的执行与说明容量探测共用装配器；基础复制不压缩，持久未发送 intent 直接使用原请求。协议续接在进入后续工具批之前仍即时校验。已知终态工具没有结果／结果为 null 时，容量探测与原执行 fallback 一致；未执行或未知步骤仍只用 null 占位，不准备或执行工具。
- 契约与传输：没有公共契约、HTTP、client、RPC、MCP、CLI 参数或协议字段变更。三协议都沿用原网关构造与解析。
- 测试：扩展上下文与 runtime 回归，新增结果视图与容量辅助测试；容量辅助保留旧默认场景，另以 `--stress-30-steps` 提供恰好消耗 30 步的固定压力负载。
- 文档：更新 `docs/AGENT-TASKS-V2.md`、`docs/CLI.md` 的结果视图、压缩与说明容量语义，以及本验证记录。

## 2. 计划对照与边界

单个工具结果超限时保留完整原件，只在模型视图中标注原字节、省略字节／值／字符数及重新读取提示，并递归移除七个已核对用途的绑定字段。小结果保持原值与键顺序；不信任工具返回的伪 `_mio_view` 元数据。字符串按 Unicode 码点和 JSON 转义后的 UTF-8 字节计量，深层预览有界。

历史仍是 128 KiB、请求 512 KiB、输出 4096 token。触发历史高水位后，依次将旧往返结果换为存根、整轮移除并加入宿主执行记录、删除最早旧对话轮次，目标为 60%。最新完整往返不降为存根，语言标记、本次消息、本轮全部说明、已知部分回复保持原文。低水位是目标；不可删内容过大继续原硬限制错误，不提高预算。

执行记录只取 A6 安全投影及合规步骤说明，细节预览最多 4 KiB；约束单独保留完整的跳过目标、拒绝确认及失败／未知步骤。四语宿主文案明确只供参考、不授予权限或审批。

每次从记录重放实际请求边界的压缩决定，避免逐步重新选切点。旧步骤后来追加后台 Change 时，历史摘要按当时模型保存的目标修订快照筛选，复合 Change 必须全部目标已知；下一次高水位压缩才刷新已移除往返的摘要。普通追加在两次压缩之间共享前缀；用户控制或旧状态事实变化可以更新派生约束。旧请求缺修订快照、或无法以目标修订证明时，用持久 createdAt 的严格先后关系作保守回退，不读当前时钟或猜测同毫秒顺序。

独立审计修复了两处问题，修复前后原始证据均保留：晚到 publication 改写旧 journal 前缀；说明探测少计终态 null 工具结果的执行 fallback。均补充实际回归，没有改变执行既有错误语义。

本期没有存储格式、表、字段、迁移、备份规则或依赖变化；完整原结果及已冻结请求不删改。没有模型摘要、跨轮新执行记录／项目概况、缓存字段、用量解析、流式合并或界面结构变更。

## 3. 验证

本节为用户确认 H1c 时、同步 C8 之前的完整验证，基线为 f554；提交前同步后的验证单独记录在第 7／8 节，不将旧全量冒充新 main 的完整执行。

最终 Linux 全量、原生补充和 Linux 配对复验均已执行完毕。Linux 编译门槛在干净 main 与候选上仍未通过，不把原始全量写成全绿。

最终冻结源码 SHA-256：`52fa09a48c65cf5accec7049b9cb78608888cd4edecc8db11130a97b1a7ee3d9`，5951 个源码文件、923 个顶层测试文件；仅本报告留在快照之外，供测试结束后补录。冻结后不再修改业务、测试或其他文档。

环境：Node 24.21.0、UTC、真实 TMPDIR；Linux 使用 H0 固定完整 FFmpeg 镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`（linux/arm64，FFmpeg 7.1.5，GNU tar 1.34，pnpm 11.25.0），非 root、禁止网络。依赖 APFS 克隆自已验证的 Linux 依赖，不改锁文件或旧阶段证据。16 个需独占文件先串行，其余并发 2；每文件独立 Node 进程，原 600 秒内部／630 秒外部保护，不改测试内部 deadline。

比较按“仓库相对文件＋完整 TAP 层级名称＋同名出现序号”精确匹配。保留 H0、H1a、H1a 主线同步、H1b 原始／复验、H1b 同步后的 32 文件以及本次干净 f554 的两个 C7 UI 文件共七个参考视图。最后一个参考是实际执行证据的组合（921 文件、14685 具名用例），不是独立跑过一遍完整 f554 的声明；各视图原始失败和复验来源分别保留。

冻结前门槛：

| 检查 | 实际结果 | 原始证据 |
| --- | --- | --- |
| `CI=true pnpm install --frozen-lockfile`（独立 worktree） | exit 0；锁文件 SHA-256 保持 `1f01209b29290b248b96045912aa4fb70d10beb32139de496047d4217163fb42` | `install.log` / `.json` |
| `node scripts/tooling.ts build --channel=development` | 最终 exit 0，154.49 秒；包含三个严格编译项目与 Web／Desktop 构建 | `build-final-2.log` / `.json` |
| `node --test --test-reporter=tap tests/agent-task-context-v2.test.ts` | 29/29；三协议 0–30 次完整往返、配对、冻结输入不变、首压缩前缀、后到说明、晚到多目标 Change 等 | `context-final.tap` / `.json` |
| runtime 定向 `--test-name-pattern` | 21/21，无跳过；含 intent 旁路、容量压缩与原子拒绝、临界 null 结果 fallback | `runtime-compaction-focused-final.tap` / `.json` |
| 独立晚到 publication 探针 | 首压缩 48,951 B；正常或晚到 Change 后均 96,342 B，旧前缀相同 | `audit-late-change-prefix-before.json` / `-after.json` |

上述结果与全量采用相同代码行为；全量仍单独核对冻结源码哈希、所有退出码与具名结果。开发阶段的 34 文件聚焦 788/788 通过保留为 `candidate-focus-*`，其源码在最后五个边界回归加入前，不作为最终覆盖数字。

### 最终冻结候选的完整覆盖

实际命令为逐文件 `node --test --test-reporter=tap --test-concurrency=1 tests/<file>`，外层使用固定镜像、`timeout 600s` 和 630 秒保护。原始 923 个文件全部执行，922 个 exit 0、1 个非零；总耗时 4119.55 秒。具名用例 14732：14709 通过、1 失败、0 取消、22 跳过，文件超时为 0。5951 个冻结源码哈希无漂移，队列和自有容器已排空，driver 实际 exit 1 与所有原始 TAP 均保留。

34 文件 harness 聚焦结果直接从本次完整执行派生，未额外重跑：**793/793 通过、无跳过**。其中 context 29、result-view 14、context-report 4、runtime 185 均全部通过。相对 H1b 同步后的聚焦参考，原 746 名全部保留并通过，新增 47 名（context +20、runtime +9、result-view 14、report 4）。

`agent-task-runtime-v2.test.ts` 中指定的两个完整 FFmpeg 用例实际通过：

- `whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`
- `retained shot keeps a late product without selecting it and never dispatches after reversion`

原始全量唯一失败为 `typecheck-runtime.test.ts` 的 `repository source policy and genuine compiler check all current included runtime sources`：编译子进程约 79.39 秒后返回 137，无 TypeScript 诊断。同文件 CLI、MCP、React 与编译门槛检查其余 4 项通过。原生最终构建的三个严格编译项目已通过；同源码整文件在原生 Node 24.21.0、UTC、真实 TMPDIR、GNU tar 1.35 下实际 **5/5 通过**，耗时 53.75 秒。该补充前后均校验 5951 个源码哈希不变，保留原 150 秒用例／120 秒编译子进程限制，外层仅加 300 秒保护。

全量排空且原生检查结束后，同一固定 Linux 镜像串行执行干净 f554 控制副本和冻结候选整文件：

| 来源 | 整文件实际退出 | 具名结果 | 首项实际错误 | 整文件秒数 |
| --- | ---: | --- | --- | ---: |
| 干净 f554（5947 源文件） | 1 | 4/5 通过 | 原内层 120 秒 `ETIMEDOUT` | 129.17 |
| 冻结 H1c（5951 源文件） | 1 | 4/5 通过 | 原内层 120 秒 `ETIMEDOUT` | 133.14 |
| 同源 H1c 原生补充 | 0 | 5/5 通过 | 无 | 53.75 |

配对前后两边源码哈希均不变。**原始候选 137 与配对超时是不同错误，分别保留**；无 TS 诊断及配对结果不能证明每次失败的单一环境根因。Linux 首项仍未通过；原生真实编译的补充覆盖不等于 Linux 全量全绿。配对采集 driver 的 exit 0 仅表示采集完成，不冒充两条测试命令通过。

与 f554 执行联合参考精确比较，原始结果匹配 14684 名、新增 48 名、缺失 1 名，已匹配状态变化 1 项（上述编译项），22 个跳过的状态与理由均无变化。新增中 47 名属于本期；另一个来自原测试 `workspace-backup-lock.test.ts:12` 的动态 `process.pid` 标题：参考为 `backup refuses existing lock "14" without takeover`，候选为 `backup refuses existing lock "16" without takeover`，两者实际通过。保留这一精确新增／缺失，没有归一化名称或伪称零缺失。

原始证据：`candidate-results.json`、`candidate-progress.ndjson`、`candidate-suite-command-result.json`、`candidate-test-name-comparison-raw.json`、`candidate-final-focus-derived.json`、`native-typecheck-runtime-final.tap` / `.json`、`candidate-paired-isolated-results.json`、`candidate-paired-command-result.json`。历史参考的来源与哈希见 `comparison-reference-manifest.json`。

### 补充覆盖与七套基线的精确名称比较

| 结果视图 | 文件 | 具名用例 | 通过 | 失败 | 取消 | 跳过 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 原始 Linux 全量 | 923 | 14732 | 14709 | 1 | 0 | 22 |
| 原生整文件补充后的跨环境有效覆盖 | 923 | 14732 | 14710 | 0 | 0 | 22 |

有效视图仅用同源实际原生 5/5 替换该整文件的观察，不双计其余 4 项。**它组合原始全量与补充检查，不表示首轮 Linux 全绿，也不是再跑一遍全量；Linux 编译首项依然未通过。** 对应原件为 `candidate-effective-results.json` 与 `candidate-test-name-comparison-final.json`，TAP 具名计数与汇总无异常。

| 参考视图 | 参考名称 | 精确匹配 | 新增 | 缺失 | 状态变化：原始 → 补充 | 跳过差异 |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| H0 | 14540 | 14498 | 234 | 42 | 1 → 0 | 0 |
| H1a | 14575 | 14538 | 194 | 37 | 1 → 0 | 0 |
| H1a + 主线 43c9 同步 | 14606 | 14575 | 157 | 31 | 1 → 0 | 0 |
| H1b 0432 原始 | 14660 | 14659 | 73 | 1 | 5 → 6 | 0 |
| H1b 0432 复验后 | 14660 | 14659 | 73 | 1 | 1 → 0 | 0 |
| H1b + 主线 32 文件同步 | 14660 | 14659 | 73 | 1 | 1 → 0 | 0 |
| H1b + 同步 + f554 C7 UI 执行联合参考 | 14685 | 14684 | 48 | 1 | 1 → 0 | 0 |

H1b 原始行的 5／6 个变化均为旧失败转通过；其余行原始的 1 个变化是编译项由通过变失败，原生补充后匹配状态相同。22 个跳过名称、状态和原因保持，无新增跳过来规避失败。

H0／H1a／同步参考的 42／37／31 条 missing 均逐项归因到既有主线改名或动态 PID，未归零：schema 版本名的两次改名（`059880cac6`、`8c8d7a2d1a`），H1b 工具加载带来的审批预算 3→5（`8c2600ac82`），媒体平台验收扩展（`6f6dbbced1`）、打包名称更新（`0947f1bfea`）、字幕归档校验更新（`ad3274134f`），以及 PID 标题。43 个不同旧身份覆盖三个参考的 110 条缺失记录，对应 42 个当前身份，均实际 passed；本期没有删除旧固定用例。完整旧名→当前名、历史提交 diff、源行和 TAP 哈希见 `historical-name-attribution.md` / `.json`。

## 4. 容量测量

本节为同步 C8 前的冻结候选测量；提交前同步没有重跑容量探针，旧数字不作为新 main 的重新测量结果。

测量只替换模型网关；实际使用 runtime、工具执行与 journal。统计为生产配额 inventory 的 SQLite data 列保留 UTF-8 字节，不含页、WAL 或累计重写量。token 用量均为 `null`。

### 两个固定负载

- legacy：保留原默认场景全部字段，14 个单工具往返，加最后无工具回复；预算 30，完整成功应实际使用 29 步（15 模型 + 14 工具）。回复 30 KiB，delta 3 KiB，真实 project.inspect 结果不填充。
- stress30：显式 `--stress-30-steps`，首模型两个核心只读调用、随后 13 轮各一个、最终无工具回答；完整成功实际使用 30 步（15 模型 + 15 工具），每条工具完整结果精确 20,480 字节，回复 30 KiB、delta 3 KiB。生产步骤预算、历史和输出上限均未改。
- 新 helper 的 legacy 输出已与未改 helper 的基线完整 JSON 深比较相等，新增工具步骤测量字段只在 stress30 返回。

### legacy：相同固定负载，实际执行进度不同

| 协议 | 状态：基线 → 候选 | 请求数 | 使用步数 / 预算 | 配额保留字节 | 配额行 | 文本事件 |
|---|---|---:|---|---:|---:|---:|
| Chat Completions | failed (AGENT_CHAT_LIMIT) → completed | 5 → 15 | 10/30 → 29/30 | 1,806,990 → 6,029,992 | 99 → 283 | 50 → 150 |
| Responses | failed (AGENT_CHAT_LIMIT) → completed | 5 → 15 | 10/30 → 29/30 | 1,810,029 → 6,041,647 | 99 → 283 | 50 → 150 |
| Anthropic Messages | failed (AGENT_CHAT_LIMIT) → completed | 5 → 15 | 10/30 → 29/30 | 1,805,457 → 6,025,971 | 99 → 283 | 50 → 150 |

#### 请求与模型步骤的完整向量

**Chat Completions**

- 基线请求字节：11,939 / 43,126 / 74,313 / 105,500 / 136,687
- 候选请求字节：11,939 / 43,126 / 74,313 / 105,500 / 136,687 / 75,754 / 106,941 / 138,128 / 76,675 / 107,862 / 139,049 / 77,596 / 108,783 / 139,970 / 78,518
- 基线模型步骤落库字节：105,714 / 168,253 / 230,731 / 293,209 / 355,687
- 候选模型步骤落库字节：105,714 / 168,253 / 230,731 / 293,209 / 355,687 / 233,880 / 296,358 / 358,836 / 235,926 / 298,404 / 360,882 / 237,972 / 300,450 / 362,928 / 239,825

**Responses**

- 基线请求字节：11,779 / 43,095 / 74,411 / 105,727 / 137,043
- 候选请求字节：11,779 / 43,095 / 74,411 / 105,727 / 137,043 / 75,852 / 107,168 / 138,484 / 76,773 / 108,089 / 139,405 / 77,694 / 109,010 / 140,326 / 78,616
- 基线模型步骤落库字节：105,649 / 168,466 / 231,222 / 293,978 / 356,734
- 候选模型步骤落库字节：105,649 / 168,466 / 231,222 / 293,978 / 356,734 / 234,371 / 297,127 / 359,883 / 236,417 / 299,173 / 361,929 / 238,463 / 301,219 / 363,975 / 240,313

**Anthropic Messages**

- 基线请求字节：11,611 / 42,823 / 74,035 / 105,247 / 136,459
- 候选请求字节：11,611 / 42,823 / 74,035 / 105,247 / 136,459 / 75,476 / 106,688 / 137,900 / 76,397 / 107,609 / 138,821 / 77,318 / 108,530 / 139,742 / 78,240
- 基线模型步骤落库字节：105,305 / 167,900 / 230,434 / 292,968 / 355,502
- 候选模型步骤落库字节：105,305 / 167,900 / 230,434 / 292,968 / 355,502 / 233,583 / 296,117 / 358,651 / 235,629 / 298,163 / 360,697 / 237,675 / 300,209 / 362,743 / 239,562

#### 共同已执行前缀的可比量

| 协议 | 共同模型数 | 请求累计字节：基线 → 候选 | 差值 | 模型步骤累计落库字节：基线 → 候选 | 差值 |
|---|---:|---:|---:|---:|---:|
| Chat Completions | 5 | 371,565 → 371,565 | +0 (0.00%) | 1,153,594 → 1,153,594 | +0 (0.00%) |
| Responses | 5 | 372,055 → 372,055 | +0 (0.00%) | 1,156,049 → 1,156,049 | +0 (0.00%) |
| Anthropic Messages | 5 | 370,175 → 370,175 | +0 (0.00%) | 1,152,109 → 1,152,109 | +0 (0.00%) |

legacy 的共同前 5 次请求和前 5 个模型步骤字节完全相同。旧运行在下一次装配时因历史超限失败，没有第 6 个真实请求或模型 intent，不能虚构其未产生的落库量。候选可继续产生并保存后续请求。

### stress30：相同固定负载，实际执行进度不同

| 协议 | 状态：基线 → 候选 | 请求数 | 使用步数 / 预算 | 配额保留字节 | 配额行 | 文本事件 |
|---|---|---:|---|---:|---:|---:|
| Chat Completions | failed (AGENT_CHAT_LIMIT) → completed | 3 → 15 | 7/30 → 30/30 | 1,268,150 → 6,285,639 | 66 → 288 | 30 → 150 |
| Responses | failed (AGENT_CHAT_LIMIT) → completed | 3 → 15 | 7/30 → 30/30 | 1,269,283 → 6,292,442 | 66 → 288 | 30 → 150 |
| Anthropic Messages | failed (AGENT_CHAT_LIMIT) → completed | 3 → 15 | 7/30 → 30/30 | 1,266,963 → 6,280,512 | 66 → 288 | 30 → 150 |

#### 请求与模型步骤的完整向量

**Chat Completions**

- 基线请求字节：11,939 / 84,092 / 135,553
- 候选请求字节：11,939 / 75,946 / 123,334 / 60,672 / 108,060 / 61,286 / 108,674 / 61,900 / 109,288 / 62,514 / 109,902 / 63,129 / 110,517 / 63,743 / 111,131
- 基线模型步骤落库字节：105,903 / 250,299 / 353,333
- 候选模型步骤落库字节：105,903 / 234,111 / 329,051 / 203,655 / 298,596 / 205,020 / 299,960 / 206,384 / 301,324 / 207,748 / 302,688 / 209,114 / 304,054 / 210,478 / 305,219

**Responses**

- 基线请求字节：11,779 / 84,089 / 135,679
- 候选请求字节：11,779 / 75,943 / 123,460 / 60,641 / 108,158 / 61,255 / 108,772 / 61,869 / 109,386 / 62,483 / 110,000 / 63,098 / 110,615 / 63,712 / 111,229
- 基线模型步骤落库字节：105,856 / 250,570 / 353,882
- 候选模型步骤落库字节：105,856 / 234,382 / 329,600 / 203,868 / 299,087 / 205,233 / 300,451 / 206,597 / 301,815 / 207,961 / 303,179 / 209,327 / 304,545 / 210,691 / 305,707

**Anthropic Messages**

- 基线请求字节：11,611 / 83,776 / 135,262
- 候选请求字节：11,611 / 75,630 / 123,043 / 60,369 / 107,782 / 60,983 / 108,396 / 61,597 / 109,010 / 62,211 / 109,624 / 62,826 / 110,239 / 63,440 / 110,853
- 基线模型步骤落库字节：105,475 / 249,916 / 353,006
- 候选模型步骤落库字节：105,475 / 233,728 / 328,724 / 203,302 / 298,299 / 204,667 / 299,663 / 206,031 / 301,027 / 207,395 / 302,391 / 208,761 / 303,757 / 210,125 / 304,956

#### 共同已执行前缀的可比量

| 协议 | 共同模型数 | 请求累计字节：基线 → 候选 | 差值 | 模型步骤累计落库字节：基线 → 候选 | 差值 |
|---|---:|---:|---:|---:|---:|
| Chat Completions | 3 | 231,584 → 211,219 | -20,365 (-8.79%) | 709,535 → 669,065 | -40,470 (-5.70%) |
| Responses | 3 | 231,547 → 211,182 | -20,365 (-8.80%) | 710,308 → 669,838 | -40,470 (-5.70%) |
| Anthropic Messages | 3 | 230,649 → 210,284 | -20,365 (-8.83%) | 708,397 → 667,927 | -40,470 (-5.71%) |

stress30 中每条工具完整结果始终保留为 20,480 字节；基线真实保存 4 条（81,920 结果字节），候选保存 15 条（307,200 结果字节）。视图截断没有篡改 journal 或把工具结果落库量伪造成减少。共同前 3 模型请求已见 16 KiB 视图带来的字节变化；后续请求因压缩可继续生成，旧实现没有这些后续请求可直接逐项比较。

### 正确结论与限制

- 可支持的结论：候选在固定上限与相同负载下完成 legacy29 和 stress30，三协议均不再在这两组探针中因历史超限提前结束；请求及单模型步骤保留字节通过截断/压缩受控。
- 不可支持的结论：不能用失败基线只完成 5 或 3 模型的全轮总字节，与候选完成 15 模型的总字节直接宣称“总体存储下降”。候选总保留字节、行数与事件增加首先反映完成了更多工作。
- 本期未实施 H2：流式写入仍为旧阈值，每 30 KiB 回复的 3 KiB delta 造成 10 条文本事件，完整 15 模型实际有 150 条，未通过合并写入降低行数。
- 容量估算只指相同已观察负载；失败轮和完成轮的“额外等价轮数”不能作相同业务产出的性能承诺。
- 本节使用最终冻结候选的真实容量数据；前缀稳定性、99 指纹及全量验证仍分别引用对应测试与执行证据，不以容量探针代替。

原始数字、逐表 rows/bytes 和每工具完整结果大小同时保存在同名 JSON 中。

原始命令：`node tests/helpers/agent-task-context-report.ts` 与 `node tests/helpers/agent-task-context-report.ts --stress-30-steps`；最终串行两负载均实际 exit 0，共 36.38 秒。干净生产基线的 stress30 仅拷入相同 helper 作仪器化，生产源码保持 f554；新 helper 的旧默认输出已与原 helper 的基线完整 JSON 相等。

证据：`baseline-context-report.json`、`baseline-stress30-report.json`、`baseline-stress-instrumentation.json`、`candidate-final-legacy-report.json`、`candidate-final-stress30-report.json`、`final-measurement-summary.json`、`capacity-comparison-final.json`；各最终报告绑定 source、scenario、实际退出码和报告 SHA-256。

## 5. 兼容性与指纹

旧执行从原 run.context 和完整步骤重放，显式空数组不转成缺失值回退。未发送 intent 的原 body 不经过装配、限额重算或后到说明绑定。恢复副本仍只读；工具准入、付费确认、目标修订、跳过门禁及未知结果处置不变。CLI 参数不变，只更新 note 对压缩后容量的说明。

最终冻结源码的正式指纹测试实际 exit 0：**99 条请求全部不变，包含 12 条诊断请求**；与干净 f554 的 fixture 完整 JSON 相同，未使用 `--update`。fixture SHA-256 保持 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`。本期的预期请求变化发生于大结果／超限历史：结果投影为 16 KiB、旧结果换存根、移除完整旧往返并附记录／约束，必要时删旧对话轮次；现有 99 个固定场景都未达到这些条件，无需逐条刷新基线。本次改动不在 `reviewed-live-sources.json` 列出的文件中，无 byte pin 更新或操作 schema 生成。

## 6. 限制与后续注意

- Linux 编译首项仍未通过：原始候选为 137，配对 main／候选均在原 120 秒限制超时；原生同源真实编译及整文件 5/5 通过。保留该验证环境限制，不声称已定位唯一原因或 Linux 全绿。
- 最新往返、当前消息、本轮说明及必要约束本身超限仍可返回 `AGENT_CHAT_LIMIT`；说明受理时对应为原 `AGENT_TASK_NOTE_CAPACITY`，保持原子拒绝和原回执重放。
- 结果视图截断会主动移除绑定凭据，实际应用前需重新准备完整结果；摘要、存根及视图都不能成为权限来源。
- H1e 的提示缓存应结合两个事实设计：工具组加载会改变工具目录；历史在下一次必要压缩或控制事实变化时也会改变前缀。本期不发送缓存控制字段，不记录 token 用量。
- 全轮总落库字节的比较须考虑完成工作量；不能用提前失败的基线与完成 30 步的候选直接宣称总存储下降。H2 的流式事件削减尚未实施。

证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H1c-2026-10-28/`。所有长验证使用进程范围内的 `caffeinate -i`，测试不调用真实模型或付费生成。

## 7. 阶段确认后首次同步 main（C8a／C8b）与验证

首次同步验证结束、提交前主线又合入 C8c；本节保留首次同步原件，第 8 节记录最终提交基线与重新验证。

2026-10-28，按用户授权 fetch `origin/main`，从 f554 快进到 `8962bd94f7a2d3197ad324fdd7497fb5cec1d940`，包含以 merge commit 合入的 C8a／C8b（PR #55／#56）。同步前备份本期 13 个文件，临时保存后恢复；无人工冲突处理。`docs/CLI.md` 同时保留 H1c 的 note 容量说明及 C8 预演命令章节。除 CLI 自动合并外，原 H1c 文件与阶段确认时一致；随后仅补录本报告。

C8 的生成 schema 从 137 项增加到 141 项，原有项逐项相同；新增四个 `previs.*` 操作均列入 Mio 禁止目录，模型工具分组不变。`task-tool-schemas-v2.ts`、`task-tools-v2.ts`、新锁文件和 byte pin 均保持 main 原样，未因 H1c 重生成或更新。Three 依赖来自已合入主线，不是本 PR 新增或升级依赖。

提交前冻结 5981 个源码文件（本报告例外），快照 SHA-256 为 `fb9f6b85887ded34b7060881327b81ac0add83ae9b4cbae2bcebe7fd950758c8`；新主线锁文件 SHA-256 为 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。测试前后冻结副本和主机源码均无漂移。

| 检查 | 实际结果 |
| --- | --- |
| 原生 `CI=true pnpm install --frozen-lockfile` | exit 0，1.20 秒，按主线新锁复用并安装 8 包 |
| Linux 同新锁 `CI=true pnpm install --frozen-lockfile` | exit 0，25.47 秒；保留供应链校验，未禁用策略 |
| `node scripts/tooling.ts build --channel=development` | exit 0，220.75 秒；含三个严格编译项目及 Web／Desktop 构建 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/<file>`，原 34 个 harness 文件 | 34/34 文件、796/796 具名用例通过，无失败／取消／跳过／超时 |
| 附加 `tests/previs.test.ts` | 14/14 通过，含预演操作不向 Mio 开放的断言 |
| 附加 `tests/previs-editor.test.ts` | 18/18 通过 |
| 同步后正式请求指纹测试 | 实际 exit 0，99 条全部不变；12 条诊断的字节数和哈希逐条与主线及旧 H1c 相同，无 `--update` |

Linux 首次 `--offline` 安装因临时 HOME 缺少既有 `@anthropic-ai/sdk` 的 registry 策略元数据返回 `ERR_PNPM_NO_OFFLINE_META`；原失败记录保留。随后仅在安装阶段允许 registry 网络，以相同冻结锁安装成功，未放宽供应链校验。正式测试使用 H0 同一完整 FFmpeg 镜像、Node 24.21.0、UTC、pnpm 11.25.0、GNU tar 1.34，实际核对 Three 0.186.1 和 @types/three 0.186.0；测试网络禁用，逐文件独立进程并发 2，沿用 600／630 秒保护和原内部 deadline，使用 scoped `caffeinate -i`。

合计 **36/36 文件、828/828 用例通过**，driver 实际 exit 0，耗时 458.21 秒。runtime 整文件 **185/185**（200.96 秒），第 3 节指定的两项 FFmpeg 用例再次实际通过。指纹 fixture SHA-256 保持 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`。

原 34 文件按“文件＋完整 TAP 路径＋同名序号”与用户确认的 H1c 比较：原 793 名全部保留并通过，新增 3 名、缺失 0、匹配状态与跳过变化 0。新增来自 C8 的当前 schema64 层扩展，均实际通过：

- `agent-task-conversations-v2.test.ts`：`schema64 backup restores the exact historical or new profile and retains conversation reads`。
- `agent-task-interactions-schema-v2.test.ts`：`schema64 rejects persisted step display during classification and restore admission`。
- `agent-task-interactions-schema-v2.test.ts`：`schema64 rejects persisted change display during classification and restore admission`。

与 H1b 同步参考比较，原 746 名全部匹配并通过，新增 50（H1c 的 47＋C8 的 3），无缺失或匹配状态变化；两个 C8 文件的 32 项单独计数，不混入原 harness 比较。

本次按授权重跑指纹、harness 及相邻 C8 集成检查，没有再次执行整仓全量或容量测量；原第 3／4 节的范围与 Linux 编译限制完整保留。提交范围仍为 H1c 的 13 个文件，PR 面向 main，注明使用 merge commit，未执行合并。

同步证据子目录：`/Users/kouzen/Library/Caches/mioon-harness-H1c-2026-10-28/sync-main-2026-10-28/`。原件包括 `pre-sync-worktree.json`、`sync-main-result.json`、`native-install.json`、`linux-install-network.json`、`native-build.json`、`candidate-focus-results.json`、`sync-suite-command-result.json`、`sync-validation-summary.json` 和 `sync-name-comparison.json`。最终检查表明本轮 wrapper、driver、caffeinate 及安装／测试容器均无遗留。

## 8. 提交前再同步 C8c 与最终回归

提交前检查发现 main 又合入 PR #57（C8c），于是 fetch 并从 8962bd9 快进到 `c434c87e6cf89880e6777d5a330682ffdcac83da`，再恢复本期文件。新主线修改 App、预演界面与关键帧／输出模块；本期 13 个文件全部与再次同步前逐字节相同，无冲突或 H1c 代码补丁。

第二次同步未改变任何 package manifest 或锁文件：12 个 workspace manifest 与第 7 节逐字节相同，锁 SHA-256 仍为 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。复用并独立克隆第 7 节实际成功安装的依赖，核对安装锁与 Three 版本；本轮未重新安装，不将依赖复用写成新一次安装通过。

最终冻结 5985 个源码文件（仅本报告例外），快照 SHA-256：`90c70a54657719c7dbdb467129b9014357e32927968f8de013c443f613d17455`。以相同 Node 24.21.0、UTC、真实 TMPDIR、scoped `caffeinate -i` 执行 `node scripts/tooling.ts typecheck`，三个严格编译项目实际 exit 0，93.54 秒。第 7 节完整 Web／Desktop 构建属于 8962bd9；本轮执行严格类型检查和下列 37 文件回归，未将旧构建当作 c434c87 的重新构建。

原 34 文件之外再次运行 `previs.test.ts`、`previs-editor.test.ts`，并纳入 C8c 新增 `previs-keyframes.test.ts`；使用同一 H0 固定 Linux 完整 FFmpeg 镜像，测试网络禁用，并发 2、每文件独立 Node 进程、原 600／630 秒保护及内部 deadline 不变。

| 最终检查 | 实际结果 |
| --- | --- |
| 原 34 个 harness 文件 | **796/796 通过**，原 793 名全部保留；C8 schema64 的三项扩展同第 7 节 |
| `previs.test.ts` | 14/14 通过 |
| `previs-editor.test.ts` | 18/18 通过 |
| `previs-keyframes.test.ts` | 9/9 通过 |
| 合计 | **37/37 文件、837/837 用例通过**，0 失败／取消／跳过／文件超时；driver 实际 exit 0，627.37 秒 |
| runtime 整文件 | **185/185 通过**，321.03 秒；两项指定 FFmpeg 用例再次实际通过 |
| 正式请求指纹 | 实际 exit 0，**99 条全部不变**；12 条诊断字节数和哈希逐条与 main、旧 H1c 相同，未 `--update` |

fixture SHA-256 仍为 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`。原 34 文件与第 7 节 796 名精确比较全部匹配，无新增／缺失／状态或跳过变化；全部 37 文件与上一轮 36 文件的 828 名比较全部保留，唯一新增为 C8c 关键帧文件的 9 名，均通过。没有用改名、跳过或放宽时限规避失败。

冻结副本及主机 5985 个源码哈希均无漂移，wrapper、driver、caffeinate 与本轮容器均无遗留。提交仍只包含 H1c 的 13 个文件及本报告补录，不进入后续 harness 阶段；全量与容量的旧证据仍按第 3／4 节原范围保留。

最终同步证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H1c-2026-10-28/sync-c8c-main-2026-10-28/`；包括 `sync-main-result.json`、`native-typecheck.json`、依赖复用核对、`candidate-focus-results.json`、`sync-suite-command-result.json`、`sync-validation-summary.json` 和 `sync-name-comparison.json`。
