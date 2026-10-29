# Mio · 收尾验收

日期：2026-10-26，10-27 合入最新 main 后在最终代码上复核。按 `designs/MIO-IMPLEMENTATION-PLAN.md` 第 7 节收尾，紧接 M7（见 [M7-SETTINGS.md](M7-SETTINGS.md)），同一工作树 `~/Documents/data/mioon-worktrees/mio-m7`、分支 `claude/mio-m7`。开工时基于 main `cfc5e8f`，最终基于 `2bb498f`（PR #42 合并）。没有新增依赖或付费生成。

持久证据根：`~/Library/Caches/mioon-mio-m7-20261025/`，下文简称 E。

## 1. 完成标准对照

| 第 7 节完成标准 | 结果 |
| --- | --- |
| 11 屏和组件区截图：简中、英、日，浅色，1440×900 和 1050×680 | 已完成，10-27 在合入 main 后的最终构建上全部重截；另加深色，繁中 1440 浅色抽查。组件区的三种暂停（冲突、步数用完、手动暂停）、失败、付费确认、撤销确认、中断恢复、建议和历史条目都有对应截图。共 193 张，状态全部正确，自动检查无问题。和设计的差异见第 3 节。 |
| 已授权的 A 项有测试；新 schema 有迁移和备份恢复测试；HTTP 与 CLI 一致 | M3–M5 已交付（A1–A6）。本次全量对比没有新增失败，见第 5 节。M7 新增的只读接口有 HTTP 与 CLI 一致性测试。 |
| harness v2 现有测试全部通过，类型检查和构建通过 | 10-27 完整 FFmpeg 环境下收口补验 338/338 通过；类型检查与构建的既有结果见第 5 节。 |
| 合成网关走完一轮完整流程 | 已完成，8 项全部覆盖，见第 4 节。 |
| 用你配置的真实模型跑一次 | **部分完成**：用户已确认真实模型连接正常；只读查看和可撤销修改两轮尚未完成，见第 7 节。 |
| 文档：`docs/CLI.md` 的新动作和对话参数、面向用户的 Mio 说明 | CLI 文档在 M3–M7 各阶段已补齐；新增用户说明 [MIO-GUIDE.zh-CN.md](../../MIO-GUIDE.zh-CN.md)，README 和核心试用指南加了链接。 |

## 2. 收尾中的修改

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/AgentTaskPanel.tsx`、`tests/agent-task-panel-v2-components.test.ts` | **对话打开时停在最新内容。** 面板隐藏时加载的一轮（例如重新加载后 Mio 页签还没打开），滚到底的计算是在高度为 0 时做的，打开页签后不会重算，对话停在中间，而"最新消息"按钮也不出现。现在面板或历史浮层重新显示时，处于跟随状态的对话会回到最新内容；用户主动上滑过则保持原位。浏览器实测：失败的一轮重新打开后距底部从 124px 变为 0，失败原因、"重试这一步"和轮末说明完整可见。新增 1 个测试，恢复旧代码时该测试失败。 |
| `apps/web/src/agent-task-errors.ts`、`AgentTaskPanel.tsx`、`tests/mio-errors.test.ts`、`tests/agent-task-panel-v2-components.test.ts` | **执行中改了连接设置的失败提示。** 一轮执行中保存了新的 Mio 连接，下一步会以 `AGENT_SETTINGS_CONFLICT` 失败。原先显示通用的"这一步未能完成"，现在和 `AGENT_TASK_SETTINGS_CHANGED` 一样显示"内容、状态或模型连接已变化"，并给出 Mio 设置入口。 |
| `apps/web/src/AgentEditingBoundary.tsx`、`agent-task-v2.css`、`packages/i18n/src/catalogs/agent-tasks.ts`、`tests/agent-editing-boundaries-v2.test.ts`、`tests/agent-editing-close-refresh.test.ts` | **编辑保护收为紧凑按钮**（原问题 2，按你的意见直接修改）。画板顶部、素材卡片、主体库和镜头属性原先各显示一段说明加"开始编辑此处"，英文、日文下按钮超出卡片被截断。现在未编辑时只有一个带铅笔图标的"编辑"按钮：悬停提示是原来的完整说明，读屏名称仍是"开始编辑此处"，状态说明留给读屏；编辑中只有"结束编辑"，悬停提示说明要先保存或放弃。需要你处理的两种恢复状态（无法确认、保留了草稿）仍显示说明卡片。新增 1 个测试，恢复旧代码时该测试失败。 |
| `docs/MIO-GUIDE.zh-CN.md`（新）、`README.md`、`docs/CORE-TRIAL.zh-CN.md` | 面向用户的 Mio 使用说明：连接与测试、首次授权、对话面板、补充说明、执行方式、步数上限、同时编辑、失败重试、撤销、中断恢复和常见问题。"同时修改"一节写明哪些地方要先点"编辑"、改完点"结束编辑"。 |
| `docs/verification/mio/M7-SETTINGS.md`、本报告 | 验收记录。 |

## 3. 11 屏截图

**环境。** 合成工作区 `E/browser/fixture.ts`：项目"UI 走查项目"有 4 个镜头（镜头 03 无版本）、scene-a 至 scene-d 四个片段、音乐床和两条字幕，记录都经正常服务创建，媒体由 ffmpeg 生成。模型是进程内的合成网关，按场景返回工具调用，不发网络请求。每种语言用一个全新的工作区。前端构建在 `E/web-dist`。

**场景如何得到。** 都是真实的运行状态，不是改库伪造：
- 07-01 运行中：网关在第三步前暂停；07-03 已暂停：网关规划时用户改了同一片段的音量，产生真实冲突。
- 07-05 失败：渲染带一个已过期的预检哈希，服务端拒绝（`PREFLIGHT_STALE`），与 M5 的做法相同。截图后点"重试这一步"，这一轮重新规划后完成。
- 07-02 等待确认：Mio 改比例和时长后提交 Mock 生成，付费默认需要确认。截图后点"拒绝"。
- 07-06 中断：关闭服务，用子进程（`E/browser/interrupt-child.ts`）在同一工作区上运行真实的 v2 运行时，在第二次付费受理的事务提交前 SIGKILL，再在同一端口重启服务，由启动恢复把这一轮标为"已中断"、那一步标为"结果未知"。截图后点"放弃"。
- 07-11 授权：先撤销当前目标的授权再发送。
- 组件区另两种暂停：步数上限临时设为 3，这一轮真的停在上限（截图后恢复为 30）；在网关暂停期间点"暂停"，放行后这一轮停在手动暂停。

**矩阵。** 脚本 `capture-panel.mjs`、`capture-settings.mjs`、`run-matrix.sh`、`final-run.sh`，结果在 `E/browser/shots-final/` 和 `E/browser/results/`。10-27 合入 main 后在最终构建上全部重截；合入前的一轮保留在 `shots-premerge/`、`results-premerge/`。
- 简中、英、日：11 屏 × 1440×900 / 1050×680 × 浅色 / 深色。07-09 另有执行方式和更换密钥两张。每种语言 52 张。
- 繁中：1440 浅色，13 张。
- 步数用完、手动暂停两种卡片：简中、英、日 × 两种尺寸 × 深浅，24 张（`run-pauses.sh`）。
- 自动检查（面板和设置页）：没有横向溢出，没有小于 10px 的文字，没有被截断的按钮或标题；每张的状态标签与场景一致。
- 与合入前相比：设置页的协议分段为三项（#34），设置中心是模态窗口（#39）；画板顶部和素材卡片上的编辑保护变成了紧凑的"编辑"按钮。其余画面相同。

截图时浏览器会话忽略 `beforeunload` 监听，因为存在结果未知的步骤时页面会阻止刷新，而换主题需要刷新。离开保护本身由 `agent-tasks-v2-ui`、`native-close-app`、`desktop-window-unknown-close` 等测试覆盖。

**逐屏对照**（设计导出在 `E/design/`）：

| 屏 | 结论 | 与设计的差异 |
| --- | --- | --- |
| 01 运行中 | 一致 | 设计只列工具步骤；实现把模型步骤显示为"理解你的要求"（M2 既定）。 |
| 02 等待确认 | 一致 | 卡片字段、费用提示、拒绝 / 确认生成、"以后都直接调用？"与设计相同。 |
| 03 已暂停（冲突） | 一致 | 目标、你的修改、Mio 原计划三行对照，跳过这一处并继续 / 停止。 |
| 组件区 · 步数用完、手动暂停 | 基本一致 | 标题、按钮与设计相同。步数用完的说明少了"可能陷入了重复操作"；手动暂停的说明没有写出已完成步数（M2 文案）。 |
| 04 已完成 | 基本一致 | 变化行比设计高（多一行"查看详情"）。1440×900 剪辑页里三条变化放不下，跟随最新时状态和回复在上方，需要上滑。 |
| 05 失败 | 一致 | 原因、重试这一步、查看详情、按错误码的设置入口、轮末固定说明。轮末说明用危险色（M5 已记录）。 |
| 06 中断恢复 | 结构一致 | 设计给付费未知步骤同时提供"向服务商核对结果"和"标记为失败"，并给两步编号。"标记为失败"已补上（见第 6 节问题 1）；仍没有编号，卡片说明是通用句。 |
| 07 空对话 | 一致 | 介绍文字左对齐（设计居中）；模型名显示配置值 `deepseek-flash`（设计为"DeepSeek Flash"）。 |
| 08 历史 | 一致 | 新对话状态下列表首项"新对话 · 当前对话"，分组、状态色点、变化数与设计相同。 |
| 09、10 设置 · Mio | 一致 | 见 M7 报告 3.4。设计稿的协议分段是两项，合入 #34 后为三项。 |
| 11 首次授权 | 一致 | |

1050×680 剪辑页的 Mio 是预览区上方的浮层，可见对话区约 120px，长卡片需要滚动（M5 已记录，未改布局）。

## 4. 合成网关全流程

脚本 `E/browser/flow-check.mjs`，简中、1440×900、浅色，同一个合成工作区里依次进行；结果 `E/browser/flow-results.json`，截图 `E/browser/shots/flow-*.png`。每项都核对了界面和工作区里的实际数据（通过同源 RPC 读取时间线）。10-27 在最终构建上重跑，各项结果与合入前（`flow-results-premerge.json`）相同。

| 覆盖项 | 操作与结果 |
| --- | --- |
| 步骤、变化 | "剪短 scene-b，背景音乐压低些"：已完成 · 7 步，3 条变化；scene-b 180→135 帧，scene-c 起点 360→315，音乐增益 1→0.398。 |
| 整体撤销 | 确认框列出将撤销的 3 处；撤销后时间线回到 180 / 360 / 1，这一轮显示"已撤销"。 |
| 补充说明 | 第三步规划中途发送"完成后告诉我总时长"：输入框提示"补充说明，下一步生效…"，对话里出现补充说明；放行后第 4 次模型请求带上这条说明，回复确认已处理。 |
| 冲突跳过 | 规划时用户把音乐改为 -4 dB：暂停并对照显示；选"跳过这一处并继续"后完成，出现"已跳过"行，音乐保留用户的 0.631。 |
| 付费确认 | 等待确认 → 确认生成：这一轮完成（9 步），Mock 任务被受理并开始执行（9:16、4 秒）。本机 FFmpeg 缺 drawtext 滤镜，Mock 渲染以 `MOCK_RENDERER_UNSUPPORTED` 失败，产品如实显示"生成失败"；这是本机环境，不影响确认与受理流程的验证。 |
| 失败重试 | 失败原因"预检结果已过期…"；重试后 Mio 收到失败结果重新规划，这一轮完成，没有重放旧的导出请求。 |
| 中断恢复 | 子进程在本地片段修改提交前被 SIGKILL，重启后"已中断"，结果未知期间"继续执行"和输入框禁用；"核对未提交并重新规划"确认没有生效后继续执行，scene-b 只被剪短一次（180→135），1 条变化。 |

这些都是合成网关和 Mock，不证明真实模型的规划质量或真实供应商的行为。

## 5. 测试、类型检查与构建

10-27 合入 main 后，全部在最终代码 `f158016` 上重新执行（工作树 `mio-m7`，TMPDIR 用规范路径），日志在 `E/closing/`。

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck`（基础、浏览器、测试三套配置） | 退出 0 |
| `node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json` | 退出 0 |
| acceptance README 收口：`node --test --test-concurrency=2 tests/agent-task-{runtime,tools,journal,crash,boundaries}-v2.test.ts tests/worker-shutdown.test.ts tests/server-worker-shutdown.test.ts tests/export-controls.test.ts` | 335 项，333 通过，2 失败（见下） |
| `docs/AGENT-TASKS-V2.md` 验证入口：`node --test tests/agent-task-*-v2.test.ts tests/agent-tasks-v2-ui.test.ts tests/agent-editing-protection.test.ts tests/agent-manual-collaboration.test.ts` | 596 项，594 通过，同样 2 失败 |
| `node scripts/tooling.ts build --channel=development`（严格生产类型、Web、桌面开发暂存） | 退出 0 |
| `pnpm --filter @mioon/web build` | 退出 0，只有既有的 `"use client"` 指令和分包体积提示 |
| `git diff --check 2bb498f HEAD` | 无问题 |
| 相关界面测试：`agent-settings-ui` 35、`settings-navigation-state` 43、`agent-connection-test` 7、`mio-errors` 4、`agent-task-panel-v2-components` 35、`agent-chat-ui` 78、`mio-change-marks-ui` 6、`transport-utf8-output` 4、`agent-editing-boundaries-v2` 12、`agent-editing-close-refresh` 10 | 全部通过 |

原验收时 acceptance README 里这条命令仍写 `tests/worker-shutdown.test.mjs`；该文件已在 #33 改为 `.ts`，上表按现有文件名执行。本次文档收尾已将 README 中的命令同步为 `.ts`。

两项失败都在 `agent-task-runtime-v2.test.ts`："whole undo retains the generated shot owner…"和"retained shot keeps a late product…"。它们用真实的 Mock 渲染器和时间线渲染，本机 FFmpeg 缺 drawtext 滤镜，这一轮以 failed 结束（期望 completed）。基线 main `2bb498f` 在同一台机器上同样失败，属于本机环境；acceptance README 也注明媒体回归要用完整的 FFmpeg。

**全量对比。** 做法与 M6 相同：每个测试文件单独一个进程，并发 6，单文件 600 秒超时，按失败的叶子测试名与基线对比。脚本和结果在 `E/suite/`（`run-suite.mjs`、`compare-suite.mjs`、`compare-*.txt`）。

| 运行 | 文件 | 通过 | 失败 | 超时 |
| --- | ---: | ---: | ---: | ---: |
| 基线 main `2bb498f`（10-27，同一台机器） | 909 | 14,231 | 73 | 0 |
| 本分支 `0fef88a`（第二次合入 main 后） | 910 | 14,229 | 83 | 0 |
| 本分支最终代码（`f158016` 加本次文档） | 910 | 14,239 | 73 | 0 |

多出的 1 个文件是新增的 `agent-connection-test.test.ts`。最终代码的 73 个失败与基线逐条相同（新增 0，修复 0），结论：相对 main 没有新增失败。`0fef88a` 上多出的 10 个失败都在 #39 新增的 `agent-editing-close-refresh.test.ts`：它用白名单加载 `AgentEditingBoundary.tsx`，拒绝了紧凑编辑按钮新引入的提示和图标两项依赖。`f158016` 在白名单里补上这两项后，该文件 10 项全部通过。

基线的 73 个失败里，72 个与上一轮基线 `cfc5e8f` 相同（媒体渲染缺 drawtext 滤镜等本机环境问题；#33 把其中多数文件从 `.mjs` 改成了 `.ts`）。另 1 个是 `dev-proxy.test.ts`："Vite dev proxy validates incoming origins…"按 Vite 配置固定使用 5173 端口，而本机另一个项目 `mioon-website` 的开发服务器占用了该端口。本分支没有改动这个测试、Vite 配置或开发代理。

**10-27 收口补验。** 本次文档收尾基于远端 main `1eff56e`，没有修改产品源码或依赖声明。使用已有 Node.js 24.21.0、pnpm 11.25.0，以及 `/Applications/data/ffmpeg/darwin-arm64/` 下的 FFmpeg / FFprobe 6.0；能力探针确认包含 `drawtext`、`ass` 和 `subtitles`。依赖以 `pnpm install --offline --frozen-lockfile` 安装，全部复用本机缓存，没有下载或升级。

按 acceptance README 的同一条 8 文件收口命令执行（`.ts` 文件名），并发 2，`TMPDIR=/private/tmp`，显式指定完整媒体工具路径并设置 `MIOON_ENABLE_LIVE_PROVIDER=0`。结果为 **338 项全部通过，失败、取消、跳过均为 0，退出 0**。此前失败的 "whole undo retains the generated shot owner…" 与 "retained shot keeps a late product…" 均通过；PR #43 已加入付费未知结果恢复用例，因此本轮总数为 338，原 335 项结果保留为历史记录。

本轮只补验上述收口范围，全量的 73 项基线共有失败仍按原记录保留，未重跑全量。未调用真实模型或付费生成，也未干预占用 5173 的现有服务。补验证据根为 `~/Library/Caches/mioon-mio-wrap-up-20261027/evidence/`，下文简称 E2；准确命令、环境、能力探针、原始 TAP 和摘要均保留。

## 6. 问题、合入与观察项

**问题 1：付费生成的"结果未知"步骤无法处理（已修，见 [PAID-UNKNOWN.md](PAID-UNKNOWN.md)）。** 付费提交在服务端同步报错（例如参数不被服务商支持、供应商不存在），或者进程在受理事务提交前退出，这一步都会记为"结果未知"（错误没有"未生效"证明时的保守规则）。但受理是本地原子事务，此时并没有生成任务：
- "向服务商核对结果"打开的任务中心里找不到对应请求；
- 面板对付费步骤不提供"核对后废弃"，服务端 `recoverLocalUnknown` 也只覆盖查看和本地可撤销操作；
- 只能"放弃"。放弃后这个对话里仍有未知步骤，"新建对话"一直被禁用，只能从历史切到别的对话。真实模型给出不受支持的时长时就会遇到。

处理方式：按你的决定，在 PR #43 开出后单独修改和验证，之后按你的意见合入本 PR。对 `generation.submit` / `image.generate`，找不到这次请求的受理记录、任务来源和费用状态时，按原子回执缺失证明"未生效"，与本地可撤销操作相同；面板提供"标记为失败"（设计稿 06 里已有这个按钮）；补了测试，重截了 06。受理事务里不会向服务商发出请求，包括非 Mock 的 `image.generate`（先审阅、再批准受理），依据见 PAID-UNKNOWN.md 第 2 节。

**问题 2：编辑保护的提示块与设计不符（已修）。** 画板顶部和每张素材卡片上原先都显示"开始编辑后，Mio 会等待你保存或放弃此处修改…／开始编辑此处"，英文、日文下按钮超出卡片宽度、被截断。你同意按我的理解直接修改，改为紧凑的"编辑"按钮，见第 2 节。

**合入 main。** 本分支开工时基于 `cfc5e8f`，之后两次用 merge 合入 main，冲突都按两边的意图合并：
- `2bcfc7d` 合入 #29、#32–#37，6 个文件冲突：
  - `AgentSettings.tsx`：#34 新增 Anthropic Messages，协议分段改为由 `AGENT_PROTOCOLS` 生成的三项，接上协议说明、Anthropic 的地址说明和适用范围；
  - `packages/i18n/src/index.ts`：两边的词条注册都保留；
  - #33 改为严格类型 `.ts` 的四个测试：`agent-settings-ui`、`settings-navigation-state`、`transport-utf8-output`，以及删除重建的 `agent-task-panel-v2-components`。本分支的测试修改移到新文件。
- `0fef88a` 合入 #38–#42，4 个文件冲突：`README.md`、`AgentAuthorizations.tsx`、`AgentSettings.tsx`、`settings-center.css`。README 保留 main 的新结构并加上 Mio 使用说明的链接；按 #39 的文字选择规则给 Mio 设置页的内容标 `data-text-selectable`；设置中心样式两边都保留。#39 新增的一个测试因依赖白名单失败，已在 `f158016` 修复（见第 5 节）。

**观察项（不阻塞）：**
- 06 恢复卡片：处理完未知步骤后，说明仍是"请先核对结果未知的步骤"；被核对废弃的那一步只显示失败图标，没有原因行。
- 04：变化行偏高，见第 3 节。
- 02：英文的"Confirm generation"按钮文字折成两行（合入前相同）。
- 面板之外：英文、日文下分镜条标题折成两行、镜头数被截断；日文左下角"読み込んだ素材は…"折行后被裁。合入 #38 后仍是这样。
- 设置页：同一预设的两个文档链接都叫"官方文档"（见 M7 报告）。

## 7. 真实模型验收

**验收方案。** 用最终构建在单独的数据目录起一个浏览器版实例（`E/real-model/`），建一个合成测试项目"Mio 真实模型验收"：scene-a（4 秒）、scene-b（5 秒）两个片段和两个镜头，媒体由 ffmpeg 生成，不含你的内容（`E/real-model/seed.mjs`）。你在 设置 › Mio 里填自己的连接和密钥；密钥用默认的"仅本次运行"，只在该实例的内存里。计划执行以下两轮：
1. 只读：问时间线里有哪些片段、总时长多少，不做修改；
2. 可撤销的小改动：把 scene-b 剪短 1 秒，核对时间线后整体撤销。

不调用付费生成，出现付费确认时拒绝，不自动重发。

**结果（2026-10-27 用户确认）。** 用户已手动实测真实模型连接，连接正常。本次只确认连通性；上述只读查看、剪短片段并整体撤销两轮尚未完成，不计为完整真实模型验收通过。后续补验时需记录实际结果和构建版本。

**实例清理。** 原测试实例（端口 4419）已停止。据此前清理记录，该实例的数据目录未保存连接或密钥；本次复核确认端口无监听。证据目录继续保留。

## 8. 证据

- 截图：`E/browser/shots-final/`（193 张，最终构建），全流程和设置页探测截图 `E/browser/shots/`；合入前的一轮在 `shots-premerge/`、`shots-premerge-probe/`。
- 指标：`E/browser/results/panel-*.json`、`settings-*.json`、`pauses-*.json`、`E/browser/flow-results.json`、`probe-settings.json`；合入前的在 `results-premerge/`、`*-premerge.json`。
- 脚本：`E/browser/fixture.ts`、`interrupt-child.ts`、`capture-panel.mjs`、`capture-settings.mjs`、`run-matrix.sh`、`run-pauses.sh`、`final-run.sh`、`flow-check.mjs`、`probe-settings.mjs`、`probe-scroll.mjs`、`restart-fixture.sh`。
- 构建：`E/web-dist`，在第二次合入 main（`0fef88a`）后构建，晚于所有前端源码改动；之后的 `f158016` 只改测试。
- 收口命令日志：`E/closing/`。全量对比：`E/suite/`。
- 设计导出：`E/design/`。
- 本次收口补验与清理：`E2/run-acceptance.sh`、`environment.txt`、`media-capabilities.log`、`acceptance.log`、`summary.txt`、`cleanup.json`。

## 9. 后续清理（2026-10-27）

本次文档收尾基于远端 main `1eff56e`，在独立工作树进行。清理回执保存在 `E2/cleanup.json`，包含删除前的分支 SHA、main 祖先校验及工作树列表。

- 删除此前列出的 14 个本地 `claude/*` 旧分支；删除前逐个确认已包含在 `1eff56e` 中，且没有工作树正在使用。新出现、仍有工作树使用的 `claude/subject-angles` 保留。
- 清除 `/private/tmp/mioon-blob-baselines-ni_dc4sm/` 下 a7、current、ff85、pre-a7 对应的 4 条失效 Git 工作树记录；先用 `git worktree prune --dry-run --verbose` 核对范围，再执行清理。
- 原有 Codex 工作树、证据缓存及主检出保持不变；主检出仍在 `codex/mio-storage-backup`，未跟踪的 `.idea/`、`docs/MIO-HARNESS.md`、`docs/MIOON-详细待办-2026-10-16.md` 均保留。

证据缓存仍被各阶段验收记录引用，继续保留。清理 Git 工作树或分支不代表删除验收证据，也不改变第 7 节尚未完成的真实模型功能验收状态。
