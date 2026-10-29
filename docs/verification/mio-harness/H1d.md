# Mio harness H1d · 执行记录、项目概况、过期提示

日期：2026-10-28 至 2026-10-29（Asia/Taipei）。从 `2665fcfc850c8062d7fcebc7c770c5564c10f7ce` 开始，即以 merge commit 合入 H1c 的 PR #58。按用户要求新建 managed worktree `/Users/kouzen/.codex/worktrees/mio-harness-h1d/mioon`，分支 `codex/mio-harness-h1d`；起点干净，不改主 checkout。首次阶段实施只做 H1d，交付后停下；用户确认后授权的提交、同步 main 与 PR 验证见第 7 节。

证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H1d-2026-10-28/`。本报告不进入最终验证源快照，供验证结束后补录；其他源码、测试、fixture 与文档均须冻结并核对哈希。

## 1. 实现范围

- 业务：新增 `task-run-record-v2.ts`、`task-context-observations-v2.ts`、`task-context-base-v2.ts`。分别提供跨轮执行记录、发送时的项目概况／请求边界的修订提示、私有基础上下文分组及模型消息投影。
- Journal：新增窄字段查询 `modelContextRuns`，不改原 `contextRuns`。只取同项目、同对话最近四个普通终态轮次；原话、说明、最后完成回复分别投影，模型请求、完整步骤及服务商输出不进入跨轮查询结果。Changes 逐行取目标与 A6 所需历史名称，不带正文、提示词、undo 或模型总结。
- 装配与运行时：`task-context-v2.ts`、`task-context-compaction-v2.ts`、`task-runtime-v2.ts` 接入冻结概况、完整历史分组与可重放提示。每个新模型 intent 只捕获一次目标修订基线，该基线同时用于提示和持久 intent。执行循环与容量检查开头仍只复制基础上下文；原请求 intent 直接使用持久 body。
- 契约与传输：不改公共契约、HTTP、client、RPC、MCP、CLI 或工具目录；不改 H3a 检查接口，也不改 H2 流式写入阈值、频率及其断言。
- 测试：新增四个 H1d 文件，覆盖四语、窄查询、安全投影、三协议压缩、历史边界、诊断隔离及真实 runtime 接线。原 runtime 容量断言改用基础上下文的模型消息投影计算字节／历史回复数，保留原拒绝、原子性、intent 不变及整轮削减断言。
- 文档：仅更新 `docs/AGENT-TASKS-V2.md` 的上下文相关段落及本报告；测量辅助未改。

## 2. 计划对照与取舍

跨轮纳入 `completed / failed / stopped / reverted`，诊断排除。每轮保留用户原话与全部说明，仅 completed 保留最后完成模型回复。每条宿主记录的完整 JSON 消息不超过 4096 UTF-8 字节；始终保留状态／合规失败码，依次填入跳过、后台、变化。每类选最近的前缀，最多读取 64 个候选，每条 Change 最多显示 8 个 A6 目标，保留总数与省略数。与 H1c 本轮记录保留最早被移除往返不同，跨轮更看重发送时最近的保存状态。未满的低优先级空间不挤掉已保留高优先级项目。

模型执行记录由相邻的历史轮次关联，不额外展示内部 runId。开发指纹复核发现这项计划外字段会把无模型用途的随机内部身份带入原始请求，已移除并加入直接回归；采样不做事后 UUID／时间归一化，fixture 仍覆盖实际持久请求原件。

窄查询必须与 A6 对历史快照条目的识别一致。独立复核发现原 `value` 为 null／primitive／array 时，重建名称对象会误把旧 job 视为已有生命周期记录；新增直接对照完整 A6 的 22 组合回归，先复现 `generation.submit` 误标为 `generation.status`，再在 SQL 中只接受原 kind/id 为字符串且 value 为对象的条目。红绿原件保留为 `run-record-a6-regression-red.*` 与 `run-record-development-6.*`。

随后继续对照 A6 发现两处名称语义差异：非空非字符串的主名称必须阻断 `label/title` 回退，超长媒体路径须先取 basename 再裁剪。新增直接 before／after 对照，覆盖数字／布尔／对象／数组、null／缺失、正反斜路径、超长目录及超长 basename，均先红后绿。最终名称 SQL 仅保留四个白名单字符串；null／缺失保留 null，其他类型投影为哨兵 0，不携带原对象／数组。文本边界完全交由 A6 决定。逐条 Change 迭代受原行 2 MiB 存储上限及固定结构／解码开销约束，不累积完整名称原件；仅保留最多 64 个小 DTO。不把投影字节硬称为最多 2 MiB，也不量化未实测的内存收益。执行记录定向测试 15/15；证据 `run-record-a6-name-fallback-red.*`、`run-record-a6-basename-red.*`、`run-record-development-7.*`。

SQLite 的裸 TEXT 提取还会替换孤立 UTF-16 代理字符。用户原话、说明、末次模型文字与名称改为 JSON `->` 投影、再由 JS 解码；有序 notes 聚合实测保留 JSON subtype。末次模型仍先按顺序选中，再判断解码后的 text 类型，不退选更早文字。项目名同样只投影 JSON 字符串，非文本对象不能被串化成概况内容。新增四语 Unicode／引号／反斜线、非文本保护、只读及末次非文本回复回归，均先红后绿；最终执行记录 17/17、概况／修订模块 27/27。红绿原件为 `run-record-utf16-red.*`、`run-record-development-8.*`、`observations-name-fidelity-red.*`／`-green.*`。

项目概况的完整 JSON 消息不超过 2048 UTF-8 字节；只读已保存的项目、时间线与本地后台记录，不触发惰性时间线创建、媒体读取、工作执行或服务商查询。旧恢复格式缺少后台表时跳过不存在的表。没有已保存时间线时格式为 null，轨道／片段／字幕数量和时长帧数为零，不伪造默认格式；镜头、素材及后台数量仍独立读取。字符串使用 A6 的控制／双向字符、空白、Unicode 安全截断规则。

既有自由 JSON `run.context` 使用宿主外层类型标识历史轮次和概况，避免把用户仿写的提示正文当成分组。发送给模型前展开为原协议消息；概况与本次消息固定保留，历史用户／说明／回复／执行记录按组整体删除，不能留下孤立回执。旧平铺上下文继续使用原 H1c 分组策略。

修订提示只依赖本轮已完成工具的 `targets / executedTargets / referencedTargets` 及保存基线。自身变化必须覆盖完整修订区间；夹杂外部推进的缺口不能被后来的自身 Change 掩盖。重新读取到当前修订后不再提示。复合回执／Change 的全部目标须在历史边界已知，后到后台结果不能改写旧提示。缺少旧基线或目标证据时不猜测；例如没有保存 referencedTargets 的聚合读取，不从结果正文反推目标。正常完成往返的历史提示并入该往返，随其压缩／删除；discarded、partial 或 retry 恢复边界没有 continuation 时，为保持顺序固定保留该提示。本次提示在新边界加入一次，未再推进时后续请求只重放旧提示。

所有新增宿主文本提供简中、繁中、English、日本語，明确仅供参考、不授予权限或审批，不改变任何暂停／跳过／未知结果处理。顺带补齐 discarded／replan 两条提示的四语，简中原文字节不变。

按用户要求新建 worktree，是相对并行 Prompt“沿用原 worktree”的明确调整。没有其他阶段扩展；没有表、schema 版本、持久字段、迁移、备份规则、生产依赖或真实模型／付费调用变化。

## 3. 验证与基线对比

最终冻结源码 SHA-256：`94a296ffe28aa483e03419501776f7aef135e5b3f0d881c42388d665aea1b742`，5993 个源码文件、930 个顶层测试文件。仅本报告排除在快照外；5992 个检查源（另排除指纹 fixture）与 `build-final-3` 的路径及哈希完全相同，fixture 另与两次稳定采样逐条相等。最终全量已完成全部 930 文件；原始失败及后续整文件复验分别保留。

前一冻结 e309 的 65 项独立覆盖／容量与部分全量证据原样保留。最终 94a 相对 e309 只再改 journal、observations 与其两个测试文件，覆盖 A6／文本保真修复；没有将旧证据改写成新源结果。旧等待调度器未派发用例即收尾，最终全量使用 `attempt3-final-v2-gated/` 独立目录及 94a 守卫。

实际验证（开发覆盖与最终冻结源分别标明）：

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| `CI=true pnpm install --frozen-lockfile`（独立 worktree） | exit 0，4.52 秒，锁不变 | `native-install.log/json` |
| 前一冻结源的构建 | exit 0，244.46 秒，含三个严格类型项目及 Web／Desktop | `build-final-2.log/json`（开发证据，不代替最终版本） |
| H1d 模块与上下文开发回归 | context 21/21、observations 22/22、run-record 13/13 | `context-h1d-unit-3.*`、`observations-unit-2.*`、`run-record-development-6.*` |
| 三协议真实 runtime 新回归 | 9/9；原 intent、诊断、四终态、冻结概况、外部与自身修订 | `h1d-runtime-4.*`（模型记录去除 runId 前的开发覆盖；最终版本由全量验证） |
| 更新后旧 runtime 整文件 | Linux exit 0，185/185，374.87 秒；185 名与 H1c 全匹配、无跳过或状态回归 | `preview-2-agent-task-runtime-v2.test.ts.tap`、`preview-2-runtime-name-comparison.json` |
| 冻结 e309 的四个 H1d 文件 | Linux 逐文件实际 exit 0，65/65（21＋22＋13＋9），无跳过；源码与 fixture 无漂移 | `isolated-final/isolated-final-results.json`、`isolated-final-check.json` 及四份 TAP |
| 最终严格构建 | `nice -n 10 caffeinate -i node scripts/tooling.ts build --channel=development`，exit 0，153.83 秒，三个严格项目及 Web／Desktop通过，源码无漂移 | `build-final-3.log/json` |
| 最终正式指纹 | `node --test --test-reporter=tap tests/agent-task-request-fingerprints-v2.test.ts`，exit 0，25.54 秒，99 条全部匹配 1cf2 fixture | `fingerprints-final-native-3.log/json` |
| 冻结 94a 的四个 H1d 文件 | Linux 逐文件 exit 0，74/74（21＋27＋17＋9），无跳过；对旧 65 名全匹配、无状态变化，新增 9 名，无缺失 | `isolated-final-v2/isolated-final-check.json`、`comparison-to-e309.json` 及四份 TAP |

e309 独立覆盖与容量探针在重跑 gate 闭合期间串行执行，共 169.28 秒、driver 实际 exit 0。最终 94a 又独立实际执行四文件及两探针，共 47.69 秒、driver exit 0，source／fixture 无漂移、自有进程及容器排空。它们不是完整全量或全量之后的新执行。新版模板原 scope 文案残留 Attempt2，实际路径／代码／守卫均绑定 attempt3 的 94a；原 runner／log 不改，`isolated-final-v2/scope-clarification.json` 单独说明。

初次严格检查的 9 条 TS2322 均来自新测试把具名 target interface 直接放入 JSON；改为显式 JSON 字段投影后，最终三个编译项目通过。开发 runtime 首轮的 4 个失败均为旧测试直接统计私有平铺 context（两项 null fallback 字节边界、两项历史 assistant 数）；改为实际模型消息投影后原断言全部通过，没有放宽上限或流式断言。前后原件均保留。

基线为独立 `git archive 2665fcf`，5986 个源文件、926 个顶层测试文件，源码 SHA-256 `f0a0cb53ec85d736558b304a7f758e9c6e543810110db4edfccf0fd725ac29ee`。99 条指纹及 legacy／stress30 三协议基线探针实际 exit 0；三协议都完成 legacy29 与 stress30。

历史比较保留 11 个参考视图；最新为 H1c 全量加最终 C8c 聚焦的实际执行联合参考（926 文件、14776 具名用例），不冒充独立完整跑过 2665。名称按相对文件＋完整 TAP 层级＋同名序号精确比较，原失败／跳过／动态 PID 名称差异不隐藏。

环境使用 Node 24.21.0、UTC、真实 TMPDIR、scoped `caffeinate -i`。Linux 使用 H0 固定完整 FFmpeg 镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`，非 root、网络禁用、pnpm 11.25.0。Linux 依赖 APFS 克隆自同锁已成功安装的独立基线，核对 12 个 workspace manifest 与安装锁，不伪称一次新的 Linux 安装。锁 SHA-256 保持 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。

首轮全量启动后，首文件 `agent-edit-wire.test.ts` 多项 owned-backend readiness 在原内部 12 秒限制内未就绪（module-loading／server-starting）。只读资源观察时宿主 load 达 287、CPU idle 为 0，存在广泛 CPU 竞争；这不足以归因某一个会话或证明唯一根因。主代理授权只向本线 driver 请求 SIGTERM（15），原 handler 以 KeyboardInterrupt 收尾，wrapper 实录 exit -2、472.21 秒。0 个完整文件，部分 TAP 有 35 项结果（4 通过／31 失败），没有最终 TAP 汇总或该文件退出码；不把它算成完整全量，也不提高测试期限。自有 driver／wrapper／caffeinate／容器全部排空，其他会话、VM 配置和冻结源码未动。完整重跑使用独立输出目录；首次原件与 SHA 清单封存在 `attempt1-aborted-resource-contention/`。

最终 94a 队列的首文件在原门槛下实际 37/37 通过（241.05 秒），随后持续运行。第 16 文件再次出现成批就绪超时，同时只读确认新的本仓库原生全量进程（并发 6），本线仅暂停后续派发，在途文件按原期限自然结束。用户随后明确要求“同步进行”，覆盖最初仅单套本机全量的调度偏好；于 2026-10-29 00:36:25（Asia/Taipei）恢复剩余 914 文件，本线仍并发 2，并未停止其他会话或改任何 deadline。该次运行包含已授权的并行资源竞争，失败须另作对照，不能预先全归为环境或产品回归。授权与派发证据见 `attempt3-final-v2-gated/user-parallel-authorization-change.json` 及调度 NDJSON。

全量实际驱动命令为 `python3 -u /Users/kouzen/Library/Caches/mioon-harness-H1d-2026-10-28/attempt3-final-v2-gated/candidate-suite.py`，配套独立 scoped `caffeinate -i`；镜像内每个文件执行 `timeout --signal=TERM --kill-after=5s 600s node --test --test-reporter=tap --test-concurrency=1 <file>`，宿主另设 630 秒保护。完整逐文件 Docker 参数、actual exit、时间和 TAP SHA 保留在结果 JSON。

最终原始全量 driver 实际 exit 1：930/930 个唯一文件，923 成功、7 失败，无遗漏、重复或外层 600／630 秒超时；14859 个具名结果为 14806 passed、28 failed、3 cancelled、22 skipped。总墙钟 7752.93 秒包含暂停等待，不作性能比较。源码／fixture 全程无漂移，原始结果和每份 TAP 保留在 `attempt3-final-v2-gated/`，清理仅限本线 driver、容器与 caffeinate。

harness 38 文件实际 870/870 passed：原 34 文件 796 名全部匹配 H1c 聚焦基线、无状态变化，另加 H1d 四文件 74 名。C8 的三个文件单独计 41/41 passed。原 runtime 整文件 185/185 passed（132.48 秒），其中两项必须完整 FFmpeg 的测试均在 H0 固定镜像实际通过：

- `whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`
- `retained shot keeps a late product without selecting it and never dispatches after reversion`

最终全量中的正式指纹文件同样 exit 0、99 条匹配，12 条诊断不变。以上均从实际全量整文件派生，不重复计数，不以早期开发结果代替；证据为 `candidate-final-v2-focus38-derived.json`、`runtime-required-media-observation.json` 及对应 TAP。

按名称与 11 个历史参考比较如下。名称数量在原始全量及两层补充覆盖中相同；状态变化列依次为“原始全量 → Linux 整文件复验替换 → 同源原生编译整文件再替换”，补充覆盖的构造及实际结果见下文。状态变化包含失败和取消，跳过身份／理由的匹配项无变化；小范围参考之外的候选名称不能称为新增回归或新增跳过。

| 参考视图 | 参考名数 | 匹配 | 新增 | 缺失 | 状态变化：原始 → Linux → 原生补充 |
| --- | ---: | ---: | ---: | ---: | ---: |
| H0 | 14540 | 14498 | 361 | 42 | 31 → 1 → 0 |
| H1a | 14575 | 14537 | 322 | 38 | 31 → 1 → 0 |
| H1a＋43c9 main refresh | 14606 | 14574 | 285 | 32 | 31 → 1 → 0 |
| H1b 0432 raw | 14660 | 14658 | 201 | 2 | 29 → 5 → 6 |
| H1b 0432 effective | 14660 | 14658 | 201 | 2 | 31 → 1 → 0 |
| H1b effective＋main focus32 | 14660 | 14658 | 201 | 2 | 31 → 1 → 0 |
| H1b＋main focus＋f554 C7/UI | 14685 | 14683 | 176 | 2 | 31 → 1 → 0 |
| H1c raw | 14732 | 14729 | 130 | 3 | 30 → 0 → 1 |
| H1c effective | 14732 | 14729 | 130 | 3 | 31 → 1 → 0 |
| H1c C8c focus37（仅 37 文件） | 837 | 837 | 14022 | 0 | 0 → 0 → 0 |
| H1c effective＋C8c focus37 | 14776 | 14773 | 86 | 3 | 31 → 1 → 0 |

最新联合参考的 86 个新名称分为 H1d 74 项、main 已有 schema64 M5 6 项、Look／LUT／restore 3 项、future 标签 1 项、动态 PID 标签 2 项。三条 exact 缺失逐项对应 `future64 → future66`、upgrade lock PID `15 → 16`、backup lock PID `16 → 14`；原件全部 passed，保留缺失身份，不做模糊匹配。独立核对 7 个相关测试、9 个直接 helper、3 个支持文件与 clean2665、Git 对象和冻结94a 的字节一致；C8a 的 `7c690db` 已在 main 中引入 CURRENT64／NEXT66／lineage64。逐项完整名称、源码行及哈希见缓存 `name-attribution-final-v2.md/json`。

H0 的原 42 条缺失全部保留；H1a／refresh 原 37／31 条分别另加一条动态 opacity PID 标题，成为 38／32。旧移除／改名归因沿用 `/Users/kouzen/Library/Caches/mioon-harness-H1c-2026-10-28/historical-name-attribution.md/json`，中间 future／PID 名称再衔接本次证据，不能直接沿用旧目标名。全部参考的原始比较及精确身份见 `candidate-final-v2-test-name-comparison.json`，源及结果绑定见 `candidate-final-v2-postprocess-binding.json`。

原始失败均保留；已完成以下七组整文件复验，使用 clean2665 → 冻结94a、同一固定镜像、每次一个文件、原内部期限及外层 600／630 秒，不能用复验覆盖原始全量：

| 文件 | 原始失败位置／期限 | clean2665 整文件复验 | 冻结94a 整文件复验 |
| --- | --- | --- | --- |
| `asset-disposition-transports.test.ts` | 父测试 120 秒；最后一次重启尚未就绪，历史重放的业务断言未到达 | exit 0，10/10，58.60 秒 | exit 0，10/10，70.33 秒 |
| `inspection-wire.test.ts` | 父测试 120 秒；最后一个 CLI 调用因父测试取消，其自身 10 秒未到 | exit 0，9/9，49.37 秒 | exit 0，9/9，53.49 秒 |
| `typecheck-runtime.test.ts` | 实际严格编译子进程原总期限 120 秒；ETIMEDOUT，无 TS 诊断；其他四项通过 | exit 1，4/5，126.80 秒；ETIMEDOUT | exit 1，4/5，90.38 秒；compiler 137 |
| `agent-timeline-gain-wire.test.ts` | 22 项失败，主要为 owned backend 原 12 秒就绪超时 | exit 0，37/37，195.25 秒 | exit 0，37/37，197.14 秒 |
| `timeline-split-media.test.ts` | 原 10 秒 backend 就绪超时，未进入媒体合成断言 | exit 0，1/1，10.35 秒 | exit 0，1/1，11.48 秒 |
| `workspace-preferences-http.test.ts` | 两项原 10 秒 backend 就绪超时 | exit 0，3/3，9.53 秒 | exit 0，3/3，9.96 秒 |
| `workspace-preferences.test.ts` | 最后一项跨库 CAS 原 20 秒期限取消 | exit 0，10/10，12.99 秒 | exit 0，10/10，11.34 秒 |

六个业务文件的原始失败／取消均在本次两边整文件复验中未复现；这支持保留为首轮时序／就绪失败，仍不据此证明唯一资源根因。Linux 编译门槛仍未通过：clean 的首项为 120 秒 `ETIMEDOUT`，候选首项为返回 137，TAP 没有直接给出 SIGKILL 或 OOM 证据，两种机制分开保留。两边其他四项均通过，无新 TS 诊断；同类 Linux 137／超时限制亦记录于 H1c 第 3／6 节，不能将历史相似现象当成本次唯一原因。

配对 driver 实际 exit 1，14 条真实测试命令共 150 项：148 passed、2 failed（两边各一项编译门槛）；每组两边完整名称／状态差异为零。两边源码及 TAP 哈希均核对不变，自有 Linux 容器、driver 和 caffeinate 排空后才启动原生检查。证据均在 `post-full-linux-pairs-final-v2/`：`command-results.json`、`paired-cleanup-and-summary.json`、`typecheck-paired-failure-mechanisms.json`，不将 driver 完成或清理成功写成测试全通过。

随后同一冻结94a 在 Darwin／Node 24.21.0、UTC、`TMPDIR=/private/tmp`、GNU tar 下执行 `node --test --test-reporter=tap --test-concurrency=1 tests/typecheck-runtime.test.ts`，配套独立 scoped `caffeinate -i`，实际 exit 0、5/5 passed；保留原 120 秒编译子进程／150 秒首项期限，没有放宽。命令测量 61.18 秒、TAP 内部 60.76 秒、完整 wrapper 62.25 秒分别记录。源码集合、逐文件哈希与 TAP 哈希均无漂移，自有 Node 进程组、driver、wrapper 和 caffeinate 排空。该原生真实编译和最终严格构建提供补充覆盖，不能替 Linux 编译门槛宣称通过。原件在 `post-full-native-typecheck-final-v2/`。

补充视图只以实际候选的整文件观察替换同一文件，不混入 clean 的结果，也不双计其他已通过用例：

| 覆盖视图 | 文件通过／总数 | 具名总数 | passed | failed | cancelled | skipped |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 原始 Linux 全量 | 923/930 | 14859 | 14806 | 28 | 3 | 22 |
| 加七个候选 Linux 整文件复验 | 929/930 | 14859 | 14836 | 1 | 0 | 22 |
| 再加同源原生编译整文件的跨环境覆盖 | 930/930 | 14859 | 14837 | 0 | 0 | 22 |

这不是重新执行一遍全量，也不表示首轮或补充后的 Linux 编译门槛全绿。22 个跳过的名称、状态及理由始终不变，未通过新增跳过规避失败。原生补充后与最新 H1c 联合参考的已匹配状态差异为零；与 H1b raw 的 6 项、H1c raw 的 1 项差异均为历史失败转通过。三个 exact 缺失仍保留。

派生结果和 11 参考精确比较均在 `attempt3-final-v2-gated/`：`candidate-final-v2-linux-supplemented-results.json`／`-name-comparison.json`、`candidate-final-v2-native-supplemented-results.json`／`-name-comparison.json`，完整输入 SHA 和原始全量不变校验见 `candidate-final-v2-supplemented-view-summary.json`。这些文件只派生统计，没有追加执行测试。

## 4. 请求、落库与行数

最终 94a 冻结源码实测已完成，发生在完整全量之前、重跑 gate 闭合期间。实际命令为固定镜像中的 `node tests/helpers/agent-task-context-report.ts` 与 `node tests/helpers/agent-task-context-report.ts --stress-30-steps`，各 exit 0；不改 helper，不把本次结果改称为全量之后新跑。基线与候选使用完全相同的 helper（SHA-256 以测量 manifest 为准）及场景配置；报告与 source 哈希分别绑定 f0a0 基线、94a 候选。新版两份报告与旧 e309 的原输出字节和全部 JSON 字段完全相同，但保留各自真实执行／source 记录。统计沿用生产配额 inventory 的 SQLite data 列保留 UTF-8 字节；流式阈值及事件频率仍沿用 H1c，H2 单独负责。

- legacy：14 个单工具往返加最后回复，实际 15 模型＋14 工具＝29/30 步。
- stress30：首模型两个核心只读调用，随后 13 轮各一个，最后回复；15 模型＋15 工具＝30/30 步，每条完整工具结果精确 20,480 B。
- 两边三协议均 completed、15 个真实模型请求；每条模型文本为固定 30 KiB、delta 3 KiB，150 个文本事件。token 均为 null，没有以 0 冒充用量。

| 场景／协议 | 累计请求字节：前 → 后 | 模型步骤 data 累计字节：前 → 后 | 配额保留字节：前 → 后 | 配额行：前 → 后 |
| --- | ---: | ---: | ---: | --- |
| legacy / Chat Completions | 1,420,841 → 1,428,536 | 4,079,055 → 4,095,960 | 6,029,992 → 6,048,586 | 283 → 283 |
| legacy / Responses | 1,423,472 → 1,431,167 | 4,088,919 → 4,105,824 | 6,041,647 → 6,060,241 | 283 → 283 |
| legacy / Anthropic Messages | 1,416,896 → 1,424,591 | 4,075,138 → 4,092,043 | 6,025,971 → 6,044,565 | 283 → 283 |
| stress30 / Chat Completions | 1,242,035 → 1,249,730 | 3,723,305 → 3,740,210 | 6,285,639 → 6,304,233 | 288 → 288 |
| stress30 / Responses | 1,242,400 → 1,250,095 | 3,728,299 → 3,745,204 | 6,292,442 → 6,311,036 | 288 → 288 |
| stress30 / Anthropic Messages | 1,237,614 → 1,245,309 | 3,718,301 → 3,735,206 | 6,280,512 → 6,299,106 | 288 → 288 |

六组均为相同已完成工作量：累计请求 +7,695 B，模型步骤 data +16,905 B，配额保留 +18,594 B（约 +0.30%–0.31%），行数与 150 个文本事件不变。每个请求 +513 B、每个模型步骤 data +1,127 B；保护内容及旧压缩切点在这两组固定负载下保持可容纳，原完整工具结果仍保留。新增事实概况有明确开销，本期不宣称存储削减。

每协议 15 项请求／模型步骤的完整前后向量、各表 rows／bytes 及容量估算，见 `isolated-final-v2/capacity-comparison-isolated-final.md/json` 与两份原始 `legacy-report.json`／`stress30-report.json`。真实命令、exit、报告 SHA 和最终 source 检查见 `isolated-final-v2/isolated-command-results.json`、`isolated-final-check.json`、`comparison-to-e309.json`。

helper 在每个协议中只发送一个新对话、使用固定空项目；因此两种负载测量本轮容量和该项目概况的开销，不包含跨轮记录载荷，也不能据此宣称跨轮窄查询的内存收益。窄字段读取与跨轮字节上限由独立测试验证。

请求字节仅为冻结 JSON body，不含 HTTP headers／真实传输；不能推断 token、缓存命中或成本。保留量只统计 inventory 定义的 data 列，不含其他元数据列、索引、SQLite 页、WAL 或同一行的累计重写，模型步骤保留量也不等同累计 I/O。两边使用完全相同的 helper 与固定 30 KiB 回复，未测四轮记录同时接近上限或高频 stale 的最坏负载。

## 5. 兼容性、指纹与 pin

新代码继续读取旧平铺 context；已冻结请求 body 不重新装配，后到说明不会改写旧 intent。跨轮派生内容只用于模型视图，不删改原执行、回执、Change 或结果。恢复副本查询保持只读。公共 CLI 调用方及权限／审批、目标冲突、跳过和未知结果语义不变。

先逐条复核，随后实际运行 `node tests/helpers/agent-task-request-fingerprints-v2.ts --update`（exit 0）。旧 fixture SHA-256 为 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`，更新为 `1cf2cb5a290ef45ca1c33584749a0c25a1a8af9d93a780a5869f512799c68dad`。99 个身份与顺序不变，仅 87 条普通请求更新；12 条诊断的 bytes／SHA 逐项不变。

| 实际请求变化类别 | 条数 | 每条字节差 |
| --- | ---: | ---: |
| 简中／繁中概况、官方预设及历史场景首请求 | 72 | +498 |
| English 概况（含附件） | 6 | +503 |
| 日本語概况 | 3 | +561 |
| 历史场景后两请求：概况及所属旧轮执行记录 | 6 | +904 |
| 诊断三种 profile | 12 | 0，SHA 同样不变 |

三个协议的 `conversation_history_trim` 每组分别增加 498／904／904 字节，合计 2306；保留的历史轮次与旧实现相同。本批没有触发 stale 的请求，中文 discarded／replan 原句也未产生额外变化。

开发原记录带 runId 时，实际两次采样仅历史场景 index 2／3 共 6 条 SHA 不稳定；移除后连续两次 99 条 bytes／SHA 全相等。另在缓存内的独立 helper 副本做反事实审计：从已持久 history 只移除三类新增宿主消息，按原配置、冻结工具顺序与诊断选项重新构造请求，仅输出 bytes／SHA。实际移除 87 个概况、6 个跨轮记录、0 个 stale；重建后的 99 条与旧 fixture 完全相等，审计副本的实际生产请求也与未插桩的两次采样全部相等，证明本批差异仅来自新增宿主消息。未修改仓库 helper，未事后归一化 UUID／时间，未输出 body 或会话密钥。证据：`preview-1-repeat-stability.json`、`preview-2-repeat-stability.json`、`preview-2-counterfactual-audit-comparison.json`、`preview-2-audit-production-crosscheck.json`、`fingerprint-update-review.json`。

本期未改 `reviewed-live-sources.json` 列出的源文件，也没有操作 schema 改动，不生成无关 pin 或 schema 差异。

## 6. 剩余事项及后续

以上为首次阶段交付时已完成的实现与验证；当时停止在 H1d，没有提交、推送或创建 PR。后续用户确认并授权的同步见第 7 节，不进入 H1e；H2／H3a 已由 main 合入，其语义继续保留。

- Linux 编译首项仍未通过；两边原门槛复验、同源原生 5/5 及严格构建的证据分别保留，未定位 137 的唯一原因。后续 CI 应继续检查该 Linux 门槛。
- 缺少已保存目标回执的聚合读取不推断 stale；discarded／partial／retry 无 continuation 的恢复提示固定保留。正常往返提示与压缩组合已有直接覆盖，恢复提示再触发压缩的组合未另设专门新用例。
- 容量实测不包含四个接近 4 KiB 的跨轮记录或高频 stale 最坏负载，不由保留字节推断内存、累计写入量、token 或缓存成本。
- H1e 设计缓存断点时，继续保留本期历史前缀确定性，并计入 H1b 按需加载改变工具列表导致的缓存失效；本期不增加缓存字段。

## 7. 确认后的 main 同步与跨轮问答

2026-10-29，按用户明确授权，先将已确认 H1d 提交为 `9692e43`，未推送；随后 fetch `origin/main`，将 `66e1b3e` 以双父 merge commit `74c2b7a` 合入，父提交为 `9692e43` 与 `66e1b3e`，没有 rebase。main 相对 `2665fcf` 的 11 个合并 PR 为 #59、#60、#62、#63、#64、#66、#65、#61、#68、#69、#67。

冲突涉及 compaction、journal、runtime 与请求指纹。保留 C13a 的提问工具、原文回答约束、`awaiting_answer`、对话策略；保留 H2 的 8 KiB／250 ms 定时合并、异常正文保留和关闭门禁；保留 H3a 检查接口。相对 main 的 runtime 差异仍仅为 H1d 上下文接线，journal 在加入窄查询以外与 main 逐字核对一致。指纹先采用 main 原件，不把旧 H1d fixture 覆盖到 C13a 目录上。

同步 main 的 fixture SHA-256 为 `ce325c3aeff5fd9779c3b1556c3cb9ddf66d9198ba997b5309316ea293031ac8`；旧 `01492d0d…` 仅是首次阶段基线。旧 H1d 相对 `2665fcf` 的逐请求增量从两个提交原件提取，作为本次 99 条的比较门槛。干净 main 正式 99 条先实际通过（20.70 秒），随后候选两次 Linux 采样实际 exit 0（19.98／19.80 秒）；99 个完整元数据逐条稳定、每条增量均符合门槛，12 条诊断的 bytes／SHA 同 main。

| 合并后相对 main 的变化 | 条数 | 实际字节差 | 对旧 H1d 增量的偏差 |
| --- | ---: | ---: | ---: |
| 简中／繁中概况等 | 72 | +498 | 0 |
| English 概况等 | 6 | +503 | 0 |
| 日本語概况 | 3 | +561 | 0 |
| 历史场景后两请求 | 6 | +904 | 0 |
| 诊断 | 12 | 0，SHA 不变 | 0 |

主代理另从实际 metadata 原件与 Git 中 main／2665fcf／9692e43 的 fixture 独立核对全部 99 行后，才实际执行 `node tests/helpers/agent-task-request-fingerprints-v2.ts --update`（原生 Node 24.21.0、UTC、真实 TMPDIR、scoped caffeinate，exit 0，19.77 秒）。新 fixture SHA-256 为 `89dd1b4e60af51e05391fbaa13cb7c7dc93b2abdbaa4d4d5856deb260e2ead25`，99 条与已复核的 Linux 预览全部相等，无异常增量。证据为 `expected-fingerprint-deltas.json`、`fingerprint-delta-review.json`、`fingerprint-update.json/log` 及 `validation/candidate-preview-1/` 两份 metadata／summary；只记录 bytes／SHA，不保存请求正文或会话密钥。

跨轮问答新增仅修改 `task-journal-v2.ts` 的窄查询和 `task-context-v2.ts` 的内部装配接口／消息组，不改 runtime、公共契约、数据库或执行记录格式。已答提问按步骤位置与说明交错，使用问题／选项参数及已保存的 canonical `answer.choices / answer.text`，不依赖重复展示字段；用户文字不再清理或裁剪。这里的回答原文指已保存的 `answer.text`：C13a 原有运行时保存前的 trim 行为继续保留，跨轮阶段不再次 trim。未绑定说明保留在末尾；未回答就结束的提问不带入。问答作为普通 user 消息归入该历史组，整组删除，4 KiB 执行记录中不重复。无问答的轮次继续原 notes 路径。

本次证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H1d-sync-2026-10-29/`。只重跑用户指定的类型、开发构建、harness、99 指纹和 main／候选 legacy／stress30 对照，全量由 PR CI 执行；不会把第 3 节旧全量写成最新 main 的全量。

跨轮新测试 `agent-task-h1d-answers-v2.test.ts` 开发整文件 15/15 通过（7.34 秒）：四语原文及 UTF-16 保真、步骤与说明排序、四终态、未答／诊断、canonical 字段、窄读取／无 snapshot、跨轮整组删除与真实只读恢复。原两个 H1d 测试文件各追加三协议组合：context 24/24、runtime 12/12（共 36/36），覆盖真实等待回答、等待期间外部修订推进、压缩后答案原文约束、过期提示顺序、概况保留、工具配对及后续请求前缀；不改旧 C13a 测试。新问答业务仅两个文件，独立只读审查未发现明确缺陷。

### 同步验证

最终同步候选源码 SHA-256 为 `e5c7d66236549f3309dc741398c963e491276db25b391890b595d49bf57cca67`，6036 个源文件、945 个顶层测试文件，仅本报告排除。与双采预览 `2b4941e6…` 的完整源集合逐文件核对，只有 fixture 改为已复核的 `89dd1b4e…`，其他路径和字节完全相同。manifest 在 `validation/candidate-final-snapshot.json`。

干净 main 固定 `66e1b3e5970fe63a59df3d2427f25f913c1bc4ed`，6028 个源文件、940 个测试文件；本次只实际执行 main 正式 99 条及两项容量探针，不声称重新跑了 main 全量。两边锁仍为 `429c516a…de497e5b`，依赖声明未变；main 仅根 package 的 description 文本有差异。Linux 独立复用并克隆同锁安装依赖，核对 manifest／installed lock，不伪称一次新的 Linux 安装。

| 实际命令／范围 | 结果 | 证据 |
| --- | --- | --- |
| 原生 `CI=true pnpm install --frozen-lockfile`（合并后 worktree） | exit 0，0.28 秒，Already up to date，锁不变 | `candidate-install.json/log` |
| 原生 `node scripts/tooling.ts typecheck`（最终同步源） | exit 0，56.10 秒，严格项目通过，源码／锁／fixture 不变 | `validation/candidate-final/native-command-results.json` |
| 原生 `node scripts/tooling.ts build --channel=development`（最终同步源） | exit 0，114.34 秒，三个严格项目及 Web／Desktop 通过，6036 源及 fixture 不变 | 同上，完整日志及 SHA 分别记录 |
| Linux 五个 H1d 整文件 | 95/95：answers 15、context 24、observations 27、run-record 17、runtime 12；相对首次 74 项新增 21 项 | 本次候选整文件 TAP，纳入下述 52 文件覆盖，不双计 |
| Linux 正式请求指纹整文件 | exit 0，40.26 秒，99 条全部匹配最终 `89dd1b4e…` fixture | 同一候选聚焦中的正式指纹 TAP，不另计为 99 个 TAP 用例 |
| Linux 52 个 harness 整文件 | driver exit 0，301.11 秒；1112/1112 passed，无失败／取消／跳过／外层超时 | `validation/candidate-final/focus-results.json` 及每文件 TAP／命令结果 |

52 文件由原 38 文件加 Anthropic 恢复、H2 streaming／report、H3a checks／integration／transport、C13a policy-answer／恢复位置／M5／wire／UI、editing boundaries／client，以及本次新 answers 文件组成。每文件独立进程，保持原内部期限及 600／630 秒保护，共享并发 2；严格类型与开发构建结束后才启动 Linux 回归。旧 38 文件的 870 个完整 TAP 身份全部匹配，无缺失、状态或跳过理由变化；新增 242 项中，本次 H1d 新增 21（跨轮 15＋组合 6），其余 221 来自 main 既有扩展与纳入范围，不能说成本期新增实现。精确文件、层级及同名序号见 `focus-name-comparison.json`。原 runtime 185 项及两项完整 FFmpeg 撤销／晚到产品回归均通过；检查、提问、工具加载和流式断言没有放宽。

### 与当前 main 的容量对照

main 与最终候选分别实际执行未改动的 helper：`node tests/helpers/agent-task-context-report.ts --delta-interval-ms 0` 与加 `--stress-30-steps` 的固定压力场景，两边三协议均 completed。两边共同模拟 Date／setTimeout 的 0 ms delta 时钟，避免把调度差异当作 H2 的写入变化；这与第 4 节首次默认时钟口径不同，不直接跨口径宣称削减。helper SHA-256 两边一致：`0da3b15bdb33ad286e0c02318607c875552d660c15ed61095fe5e59e99a93c3f`。

- legacy 均为 29 步＝15 模型＋14 工具；stress30 均为 30 步＝15 模型＋15 工具，完整工具结果每条 20480 B。
- 六组均有 15 个请求、60 次正文追加、60 个文本事件，token 用量为 null；步骤、行数与流式追加次数前后相同。

| 场景／协议 | 请求字节 main → 候选 | 模型步骤 data 字节 main → 候选 | 配额保留字节 main → 候选 | 配额行 main → 候选 |
| --- | ---: | ---: | ---: | ---: |
| legacy / Chat Completions | 1,441,151 → 1,448,846 | 4,101,015 → 4,117,920 | 6,035,482 → 6,054,076 | 193 → 193 |
| legacy / Responses | 1,443,587 → 1,451,282 | 4,110,654 → 4,127,559 | 6,046,912 → 6,065,506 | 193 → 193 |
| legacy / Anthropic Messages | 1,436,771 → 1,444,466 | 4,096,573 → 4,113,478 | 6,030,936 → 6,049,530 | 193 → 193 |
| stress30 / Chat Completions | 1,262,345 → 1,270,040 | 3,745,265 → 3,762,170 | 6,291,129 → 6,309,723 | 198 → 198 |
| stress30 / Responses | 1,262,515 → 1,270,210 | 3,750,034 → 3,766,939 | 6,297,707 → 6,316,301 | 198 → 198 |
| stress30 / Anthropic Messages | 1,257,489 → 1,265,184 | 3,739,736 → 3,756,641 | 6,285,477 → 6,304,071 | 198 → 198 |

各组累计请求 +7695 B、模型步骤 data +16905 B、配额保留 +18594 B；每请求 +513 B、每模型步骤 +1127 B。正文追加导致的整行 data 重写量每组增加 67620 B＝60×1127，是每行携带更多上下文的开销；追加次数及 text event 字节不变，没有改变 H2 的合并频率。按当前 inventory 估算的可再执行同等轮数，两边 legacy 均 43、stress30 均 41。本期不宣称节省存储或提升该负载容量。

原 helper 的 legacy 报告未提供可选 `toolSteps` 数组，工具执行数 14 依据此固定场景的 29 步减 15 模型步骤；未提供的逐工具向量不冒充 0 次工具。初版派生摘要曾将缺失数组计为 0，已修正并保留 `capacity-vs-main.initial.json`、修正说明；原始报告和哈希未改，也未为修改统计重跑测试。stress30 原件显式提供 15 个工具步骤。

六组每请求／每步骤向量、逐表 rows／bytes、容量与 streaming 指标见 `validation/candidate-final/capacity-vs-main.json`；原报告及各自真实命令、exit、耗时、SHA 单独保留。保留字节、重写字节、token 的统计边界仍按第 4 节，重写量不等于 SQLite 物理写入。本探针仍是固定空项目的新对话，没有跨轮问答载荷，不能把 +513 B 推广至所有带历史问答的请求。

最终主工作树和冻结副本均核对 6036 个源文件无漂移，只有本报告补录；本线测试 driver、容器、caffeinate 和资源观察器已排空，未操作其他会话。完整结果、原件路径和哈希索引在 `validation/VALIDATION-DELIVERY-INDEX.json`。源码 pin 和工具 schema 均沿用 main，无需重新生成。

本次指定验证完成后提交补充改动、推送本分支并创建面向 main 的 PR；请使用 merge commit 合入，不启用自动合并，代理不执行合并。当前 main 的整仓全量由 PR 的 CI 覆盖，本轮未在本机执行全量。
