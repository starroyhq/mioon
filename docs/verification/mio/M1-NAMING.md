# Mio · M1 命名与用词

日期：2026-10-21。仅实施 `MIO-IMPLEMENTATION-PLAN.md` 第 4 节的 M1；M0 已由用户确认。本阶段不进入 M2，也不实施 A1–A6。

工作树：`~/.codex/worktrees/mio-m0-preparation/mioon`，分支 `codex/mio-m0-preparation`；基线 `ab65771998936e5e0bb1e2465e40ecefff233e91`。继续沿用 M0 的隔离分支，没有切换原工作区分支、创建提交或推送。

证据目录：`/private/tmp/mioon-mio-m1-20261021-J7UxDD/evidence/`。日志与 PNG 保留在仓库外；验证副本在检查结束后删除。

## 1. 完成内容与文件

| 分类 | 文件 | 本阶段结果 |
| --- | --- | --- |
| 界面 | `apps/web/src/AgentTaskPanel.tsx`、`agent-tasks-v2.ts`、新增 `agent-task-errors.ts` | 发送时捕获界面语言；切换语言不重建 session、不丢草稿；步骤、执行和本地连接错误按稳定码取词条，不显示服务端诊断 message；“准备中”不显示步数。既有元素的 test ID 保留。 |
| i18n | `packages/i18n/src/catalogs/agent-tasks.ts`、`command.ts`、`creation-connections.ts`、`creation-ui.ts`、`native.ts`、`operations.ts`、`settings-redesign.ts`、`shell.ts`、`timeline-delivery.ts`、`workbench-shell.ts`、`workspace-configuration.ts`；新增 `agent-task-errors.ts`，注册于 `src/index.ts` | 简中、繁中、English、日本語均使用 Mio。按附录 B 调整发送、继续执行、整体撤销、对话历史、执行方式等文案；顶栏后台任务中心的“任务”保留。9 个轮次标签完整。错误文案固定本地化，未知码退回通用提示，不反射错误码或任意消息。 |
| 契约 | `packages/contracts/src/agent-tasks-v2.ts` | send 增加可选、严格枚举的 `locale`：`zh-Hans / zh-Hant / en / ja`；省略为简中。未增加控制动作、模型侧步骤说明公共字段或 Change 展示投影。 |
| 业务 | `packages/business/src/agent/task-runtime-v2.ts`、`task-gateway-v2.ts` | 去掉固定简中回复要求。宿主将发起语言固定在已有 context 中的精确首条标记，按该语言生成两协议的根说明；续轮、预算继续、恢复均沿用。标记不作为额外消息发送给模型，历史裁剪保留标记和最新输入；不改写已经保存的请求 intent。 |
| 传输 | 复用现有 HTTP、客户端和 CLI 的公共 send schema | HTTP、客户端与 CLI JSON 同步接受 `locale` 并拒绝无效枚举；原 URL、命令、鉴权、控制回执和 SSE 语义不变。没有另加 HTTP/CLI 入口或 MCP 管理工具。 |
| 测试 | `tests/agent-task-{runtime,gateway,http}-v2.test.ts`、`agent-tasks-v2-ui.test.ts`、`agent-task-panel-v2-components.test.mjs`、`agent-settings-ui.test.mjs`、`client-agent.test.mjs`、`cli-agent.test.mjs`、`desktop-agent-recovery-copy.test.ts`、`i18n-command-presentation.test.ts`；新增 `mio-naming.test.ts`、`mio-errors.test.ts` | 覆盖四语言、两协议、续轮/重启/裁剪、原 intent、请求重放与冲突、无效语言、草稿与未知回执、错误诊断不直接显示、9 状态和产品命名。按新设计更新旧文案断言，原行为保护保留。 |
| 文档 | `README.md`、`docs/AGENT-AUTHORIZATION.md`、`AGENT-TASKS-V2.md`、`CLI.md`、`CORE-TRIAL.zh-CN.md`、`MAC-SOURCE-TRIAL.zh-CN.md`、`MCP.md`、`SETTINGS-WORKSPACE.md`、`TASK-DISPOSITIONS.md`、`WORKSPACE-BACKUP-GUIDE.zh-CN.md`、`WORKSPACE-GUIDE.zh-CN.md`、`WORKSPACE-SETTINGS.md`、本报告 | 面向用户的内置助手改称 Mio；补全现有 `project_agent` 范围和完整接口地址、模型、范围绑定说明；说明 CLI JSON `locale` 与 CLI 展示语言选项不同。历史验收记录和 M0 报告未重写。 |

相同请求 ID 的省略语言与显式 `zh-Hans` 视为同一请求；换成其他语言会返回请求冲突。服务端不接受调用方提交任意 context。旧记录没有语言标记时保持默认简中；本阶段不推断或迁移旧执行的语言。

本地回执不可读的提示只要求核对原执行，不承诺后台已经停止；本地服务连接或响应错误不引导用户错误地修改模型地址/Key。这两类问题已在独立审查中修正并补充回归。

## 2. 设计输入与阶段对照

本阶段重新阅读用户指定的附录 B、M1 两条补充、A6，以及 5.4、5.6、5.7、5.9、5.16；`AGENT-HARNESS-PLAN.md` 第 6 节开头按修订后的阶段说明理解。

| 输入 | 本轮最终 SHA-256 |
| --- | --- |
| `designs/MIO-IMPLEMENTATION-PLAN.md` | `ed11dee51c05b7e7c5380c592f338fd5746eb07738510f0be622c2f2cb14d424` |
| `designs/AGENT-HARNESS-PLAN.md` | `12ccf39714fa35ab03b718f43a9bb2497214ab231226caf8430f83e1986574bd` |
| `designs/DESIGN-GUIDE.md` | `02d90e14e798d812b3b1b5c839c15d91cde993a1bd5e6e3d03ee2b3d8cf109f2` |
| `designs/mioon-design.pen` | `791e5623494f34552226b65f247e1f1012daab70afa083344ed23d52d67e10e0` |

`designs/` 被忽略，本轮从原工作区只读读取。使用已有 pen 0.3.12，按附录 A 导出 11 屏和组件区，没有读原始 `.pen` 或保存设计修改。源设计和指南在本轮有其他分区的更新；重新导出的 07 分区 12 张 PNG 与 M0 逐字节相同。文件指纹、图片尺寸和节点见 `m1-inputs-and-designs.json`，导出日志见 `design-export.log`。

对照：Mio 品牌、附录 B 轮次用词、准备中隐藏步数、错误本地化和发起语言固定已落地。英文/日文授权按钮在 320 面板中曾溢出，本轮按实际截图缩短为“允许向此模型发送”等四语短标签；完整发送范围、接口地址和模型仍由旁边的既有披露展示，授权行为未改变。

按阶段保留的结构差距：旧面板、步骤工具标题/状态 badge、参数详情、旧首次授权勾选方式、历史位置等由 M2/M3 改造；本轮不冒充已经完成 07 新面板。M2 的模型侧步骤说明包装、A6 安全展示投影，M4 的冲突跳过、M5 重试/撤销预览、M7 设置重排和测试连接均未提前实施。1050×680 的长内容需滚动，底部输入固定属于 M2；本轮确认滚动后发送控件可完整到达。原生文件输入框沿用系统语言，M2 将按计划替换为附件按钮。

## 3. 实际验证与基线

环境：Darwin arm64，Node **24.21.0**，pnpm **11.25.0**，`TMPDIR=/private/tmp`。所有依赖安装和验证在独立副本中进行，没有使用或清空原仓库 `node_modules`，没有修改依赖或锁文件。

```sh
rsync -a --exclude node_modules --exclude .git --exclude apps/desktop/build --exclude apps/web/dist \
  ~/.codex/worktrees/mio-m0-preparation/mioon/ \
  /private/tmp/mioon-mio-m1-20261021-J7UxDD/verify/
cd /private/tmp/mioon-mio-m1-20261021-J7UxDD/verify
CI=true pnpm install --frozen-lockfile
node scripts/tooling.ts build --channel=development
node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json
```

PATH 显式使用已有 Node 24 bin；媒体指向 `/private/tmp/mioon-tools/ffmpeg`、`ffprobe`。二者为 **9.0.2-tessus**，`drawtext`、`subtitles` 可用；完整 drawtext help 无 `text_shaping`。本轮不代表 CI 的 FFmpeg 7.1.5 或其他操作系统结果。

未改基线使用 `git archive ab65771998936e5e0bb1e2465e40ecefff233e91` 的独立源码快照。以下完整文件逐文件独立 Node 进程运行，每文件 600 秒上限，文件最多并发 2：

```sh
node --test --test-reporter=tap --test-concurrency=2 <单个测试文件>
```

范围含 acceptance README 的八文件：`agent-task-{runtime,tools,journal,crash,boundaries}-v2.test.ts`、`worker-shutdown.test.mjs`、`server-worker-shutdown.test.ts`、`export-controls.test.ts`；加本轮相关 gateway、HTTP、session、Panel、settings、client、CLI、i18n 和文档测试。仓库外 `baseline-runner.ts` 保存每文件命令、PID、时限、退出码、TAP 和输入/日志哈希。

| 执行批次 | 结果 | 证据 |
| --- | --- | --- |
| 未改基线 19 个已有文件 | **357/357**；0 失败、跳过、超时 | `baseline-summary.json`、`baseline-manifest.json` |
| 第一轮改动后 22 文件 | 380 项，379 通过、1 失败；旧 settings 文案断言没有同步更新 | `after-summary.json`、`after-analysis.json`；失败历史保留 |
| fix1 七完整文件 | **59/59**；同步旧文案断言，保留原行为检查 | `fix1-summary.json` |
| fix2 三完整文件 | **12/12**；错误段落末尾标点与补充回归 | `fix2-summary.json` |
| 最后授权短标签回归 | 五个受影响完整文件 **51/51**，全部退出 0；0 失败、跳过、超时 | `fix3-manifest.json`、`fix3-summary.json` |
| 最终有效覆盖 | **22 文件、383/383**（顶层 370、嵌套 13）；after 15 文件 323 项 + fix1 两文件 9 项 + fix3 五文件 51 项。按文件只选一轮证据，未变化文件不重复跑、不重复计数 | `final-combined-coverage.json` |

候选路径 `tests/i18n-source-coverage.test.ts` 在该基线不存在，清单明确记录缺失；没有将其算成通过或用另一个文件冒充。

本轮 journal、crash、boundaries、tools、runtime 回归保留先落库、撤销授权、unknown 不重发、工具顺序、崩溃恢复、备份恢复、撤销不覆盖人工修改等保护。现有 schema 52 与恢复副本 53 的兼容测试包含在 journal 回归中；没有刷新冻结 schema/历史证据的哈希来掩盖变更。

HTTP 新语言路径通过实际 `startServer`、公共 schema、runtime 和请求构造器到注入的合成网关；覆盖两协议、lookup/replay/conflict 与无效语言。CLI 测试通过真正 CLI 子进程到本地 HTTP fixture，核对 JSON 传输及无效值在发送前拒绝；fixture 响应是预制快照，不将其单独称为 CLI 到模型的完整端到端验收。

另补生产后端集成：`node /private/tmp/mioon-mio-m1-20261021-J7UxDD/evidence/m1-cli-backend-locale-runner.ts`（仓库外 runner 使用上述 verify 源码）真实启动 `startServer/runtime/client/CLI`，只注入合成 TaskGateway 和内存设置持久化。CLI 的 `agent task send/status/lookup --input -` 均退出 0、同一 Run completed，根指令为日语；同参数 send 重放返回同 Run，同 requestId 改成英语返回 `AGENT_TASK_REQUEST_CONFLICT`、CLI 退出 3。共 **1** 次合成模型请求、0 工具调用、0 Change。输入走 stdin，合成 token 仅经子进程环境传递；自有服务已关闭、临时数据已删除。脱敏证据见 `m1-cli-backend-locale-result.json`；此项实测协议为 Chat Completions，Responses 由 HTTP/gateway/runtime 回归覆盖。全程未调用真实模型。

最终源码的 `node scripts/tooling.ts build --channel=development`（含严格类型、Web/桌面开发构建）与 `node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json` 均退出 **0**，日志为 `final3-build.log`、`final3-tests-typecheck.log`。构建已有的 use-client/sourcemap、chunk/bundle 尺寸提示保留，没有关闭检查。

独立只读审查结论 **no finding**：覆盖语言固定/首条宿主标记、幂等、旧 intent、未知结果恢复，以及错误码投影、授权短标签和 session 生命周期。未把 M2/M7 的既有结构差距当作 M1 已完成能力。

## 4. 浏览器与截图

使用现有 `playwright-cli` **0.0.65**、Chrome **155.0.8059.85**，独立本地服务、临时数据目录、合成 TaskGateway。合成凭据只在 fixture 进程内存中，浏览器通过本地一次性启动入口取得会话；没有读取、复制或重启桌面持有的真实 Key，没有真实模型或付费生成。

矩阵为四语言 × 两尺寸（1440×900、1050×680）× 空闲 / 准备中 / 失败 / 设置。实际 journal 默认直接创建 running；“准备中”截图使用隔离库里的展示 fixture，只证明 accepted 的显示映射，不声称它是自然生产状态转换。

首轮 `browser/<语言>-<宽度>-<状态>.png` 与 `matrix-results.json` 保留。初始只测控件自身 scrollWidth 的判据漏掉了越过父容器的按钮；后续 `boundary-audit-results.json` 改为核对父容器边界，发现英日授权按钮 12 项溢出，其余可见 M1 控件未发现同类问题。1px 隐藏 label/input 是既有无障碍结构，不计为可见裁切。

最终修正后定向补拍 **16 张**：四语 × 两尺寸的失败态，以及英日 × 两尺寸的空闲/准备中；`browser/latest-matrix-results.json` 均为 0 诊断原文、0 旧助手名、0 可见父边界溢出。最新 JS 是 `index-Dqx8QcLy.js`，SHA-256 `bc8eefa4f80c729991d63e6b0ebd3e821e93a3d6c877f6b8e00c67487cee6181`，见 `browser/latest-build-manifest.json`；没有把旧包截图冒充最终包。

代表截图均位于上述证据目录：

- `browser/latest/en-1050-idle.png`：短授权按钮完整、范围与完整 endpoint 披露保留；
- `browser/latest/ja-1050-preparing.png`：“準備中”且无步数；
- `browser/latest/zh-Hans-1440-failure.png`、`zh-Hant-1050-failure.png`：运行与步骤错误均已本地化；
- `browser/latest/en-1440-local-receipt.png`：只提示核对原执行，不承诺取消；
- `browser/ja-1050-failure-vertical-scroll.png`：长内容纵向滚动后发送控件可完整到达。

四语言 × 本地回执/本地连接/本地响应三类错误另测 **12 例**，与最终 catalog 逐字匹配，诊断 marker 不显示、无可见溢出，见 `browser/local-error-results.json`。四语言各进行一次合成发送，切换界面语言后草稿均保留、对应语言回复实际可见；4 个唯一请求、4 个 Run、4 个 completed model step，dispatch 恰好 **4**，0 重发、0 外部请求、0 付费请求，见 `browser/draft-language-results.json`、`dispatch-run-correlation.json`。

期间浏览器检查脚本曾把已折叠历史的不可见按钮判作溢出并中止，属于检查器可见性误判；补充 closed-details 祖先过滤后按原 Run 只读核对前三次，仅再发送尚未运行的日文一次。原始日志保留，未通过重复发送绕开失败。浏览器与自有测试服务已关闭。

详细浏览器记录见 `browser/M1-BROWSER-ACCEPTANCE.md`，机器摘要为 `browser/acceptance-summary.json`；最终源码、输入、原工作区与验证副本清理检查见 `final-validation.json`。

本轮只验收 M1 的命名、错误和语言链，未验收新 Mio 面板全结构、浅色全屏、原生 Electron 交互或真实模型是否遵循语言要求。这些按计划保留至对应阶段/收尾。

## 5. 兼容性与下一阶段

- 旧 HTTP/CLI 调用省略 `locale` 继续可用；新字段仅由本轮新版后端接受。JSON `locale` 不替代 CLI 的 `--locale` 展示选项。端点、控制请求身份、回执查询、SSE 和 MCP 工具目录不变。
- 旧执行、诊断历史与已保存 intent 不迁移、不改写；旧记录语言缺省为简中。Run 的现有 context 承载宿主标记，无新表、schema 版本或备份格式。
- 已保存设置、系统/会话 Key、发送授权及执行策略不变。`project_agent` 文档补全不自动授予任何范围，旧授权仍不能替代它。
- 未新增/升级依赖，未 commit、push、部署或发布；未调用真实模型或真实付费生成。原工作区已有未跟踪待办和 M0 报告保留原样。
- 下一阶段为 M2：按更新计划实施新面板、模型侧步骤说明包装和 A6 白名单安全展示投影；保留公开快照不暴露原始 before/after/undo 的边界。M1 的错误模板可复用，未知码仍须固定回退。

**停在 M1，等待用户确认后再进入下一阶段。**
