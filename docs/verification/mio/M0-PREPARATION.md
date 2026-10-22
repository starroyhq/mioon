# Mio · M0 准备

日期：2026-10-21。范围：`MIO-IMPLEMENTATION-PLAN.md` 第 4 节的 M0；本阶段完成后等待用户确认，不进入 M1。

## 1. 基线与改动范围

- 开工前 `git fetch origin main`，本地与远端 main 均为 `ab65771998936e5e0bb1e2465e40ecefff233e91`。
- 隔离 worktree：`/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon`；分支：`codex/mio-m0-preparation`。
- 原工作区 `/Users/kouzen/Documents/data/mioon` 的已跟踪文件干净；唯一已有未跟踪文件是 `docs/MIOON-详细待办-2026-10-16.md`，保留原样。SHA-256：`bcd893c9e071d0c59948589796e6d1eeb366e877cd7c2ac35b380e22af918aad`。
- 界面、i18n、契约、业务、HTTP/CLI、测试源码均未修改。文档仅新增本报告；临时 TypeScript 验证 runner、日志、设计 PNG 和清单均位于下述仓库外证据目录。
- 未新增或升级依赖，未提交、推送、发布，未调用真实模型或真实付费生成，未启动或重启已有原生应用。

证据目录：`/private/tmp/mioon-mio-m0-20261021-kS61xo/evidence/`。

`designs/` 被仓库 `.gitignore` 忽略，因此未出现在新 worktree 中。本阶段从原工作区只读读取三份设计说明，并通过 pen 导出原设计；没有将其他被忽略文件复制进 worktree。后续阶段继续从上述原目录读取设计输入，并先核对指纹。

## 2. 已读材料与现状

已按职责核对以下材料及相关实现、邻近测试：

- `designs/MIO-IMPLEMENTATION-PLAN.md` 全文，含第 2–7 节与附录 A、B。
- `designs/AGENT-HARNESS-PLAN.md` 的状态机、Change、风险档位、命名与面板结构。
- `designs/DESIGN-GUIDE.md` 第 2–5 节、第 6 节 Mio 与设置中心。
- `README.md`、`docs/ARCHITECTURE.md`、`docs/CONTRACT.md`、`docs/UI-COMPONENTS.md`、`docs/TYPESCRIPT.md`、`docs/CLI.md`。
- `docs/verification/ai-workflows-acceptance/README.md`、`DESKTOP-REAL-ACCEPTANCE.md`，以及 Agent v2、授权、UI session、变更定位、HTTP/CLI 与存储相关实现和测试。

确认的当前基线：9 个 Run 状态、8 个 Step 状态、4 档执行策略；默认每轮 30 步、付费需确认；普通库 schema 52、恢复副本格式 53。当前没有对话实体、`note/retry` 动作、冲突跳过列表或整体撤销的 superseded 跳过实现。

保留的保护包括：先持久化 intent/dispatch 再执行；领域修改、Change 和完成回执同事务；模型发送、工具执行和后台真正提交前复查授权；unknown 不自动重发；重启进入 interrupted；控制使用版本与稳定请求身份；撤销不覆盖人工修改。官方 OpenAI SDK 仍通过现有网关，`maxRetries: 0`，网络策略不变。

文档里的旧现场结果按其日期和协议理解：桌面真实文本验收是 Chat Completions，Responses 由合成回归覆盖；真实视频质量、计费与 Mio 新界面没有因此获得新验收。

## 3. 设计导出与逐屏对照

使用现有 `pen 0.3.12`，按附录 A 的 `pen interactive` / `execute(Export(...))` 命令，`scale: 1` 导出 12 张 PNG；没有使用 AI 生成命令、读取原始 `.pen` 内容或保存设计修改。`--out` 指向证据目录的临时 `scratch.pen`。

逐屏实际查看记录：

| 节点 / PNG | 尺寸 | 对照要点 |
| --- | --- | --- |
| `pIAuS.png` · 组件区 | 1440×2287 | 会话头、轮次标签、步骤、变化、输入、三类暂停、失败、付费确认、撤销确认、中断恢复、建议和历史条目 |
| `CgJlu.png` · 01 运行中 | 1440×900 | 剪辑右侧面板保持原高度；轮次标签、暂停、步骤与实时变化、底部停止键；时间线 Mio 修改标记 |
| `hS0cM.png` · 02 等待确认 | 1440×900 | 画板上的已产生变化、精确生成确认卡、服务商/方式/比例/时长/结果/费用提示；设置入口独立 |
| `SIrbS.png` · 03 已暂停 | 1440×900 | 当前人工修改与 Mio 原计划对照；跳过这一处并继续、停止；补充说明输入 |
| `ibtup.png` · 04 已完成 | 1440×900 | 步骤折叠、用时、本轮变化、逐条和整体撤销；后改条目禁用撤销，跳过行独立显示 |
| `KfVyL.png` · 05 失败 | 1440×900 | 错误位于失败步骤，附重试、详情、视频工具设置入口；末尾说明后续尚未执行 |
| `q6UmzI.png` · 06 中断恢复 | 1440×900 | 先核对未知结果、再继续或放弃；未知未处理时继续和输入禁用 |
| `xNIhU.png` · 07 空对话 | 1440×900 | 新对话与三个图标；介绍、四条建议、附件标签、模型和当前项目、唯一发送键 |
| `lCVcD.png` · 08 对话历史 | 1440×900 | 历史浮层覆盖消息区；搜索、日期分组、当前条目标记；底部输入保留 |
| `F112jm.png` · 09 设置顶部 | 1440×900 | 960×640 统一外框；模型连接、密钥状态和连接测试；保存无改动时禁用 |
| `Tg2uD.png` · 10 设置底部 | 1440×900 | 执行方式、付费警示、30 步输入、授权目标和撤销授权 |
| `RgQuF.png` · 11 首次发送授权 | 1440×900 | Mio 背景上的授权弹窗；范围、模型目标、费用和撤销入口；取消保留草稿 |

PNG 路径为上述证据目录下的 `design/<节点 id>.png`。输入文档、设计与各 PNG 的 SHA-256、尺寸、节点清单见 `m0-inputs-and-designs.json`。

三份设计说明与源设计的输入指纹：

| 文件 | SHA-256 |
| --- | --- |
| `MIO-IMPLEMENTATION-PLAN.md` | `c9f66ca2d8b06cfbbc0c29a62a36195fed7760acf8d1a635dc2c8fea4cde2af7` |
| `AGENT-HARNESS-PLAN.md` | `1531db7c1e66ca43c4debaec69424e5058a77e1fe9b28371e03a640e0e120b3b` |
| `DESIGN-GUIDE.md` | `c283789a348e6f2800105d2bb5fa2db9bed4d290f1728c4128000805138ddf8a` |
| `mioon-design.pen` | `5469fa14c906a469bf512f2c046f529d29e9e12a25166f4710f21970560ab525` |

M0 没有界面实现或有意的视觉偏离。静态设计导出仅作为后续对照输入；四语言、浅色、1050×680、实际点击/焦点/滚动/定时标记的检查按对应界面阶段及收尾实施，不以 PNG 证明这些行为。

## 4. 本轮验证

环境：Darwin arm64，Node **24.21.0**，pnpm **11.25.0**，`TMPDIR=/private/tmp`。系统默认 Node 为 26，因此所有项目验证显式将已有 Node 24 的 bin 放到 PATH 前面。没有使用原仓库的 `node_modules`。

隔离验证副本创建与安装：

```sh
rsync -a --exclude node_modules --exclude .git --exclude apps/desktop/build --exclude apps/web/dist \
  /Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/ \
  /private/tmp/mioon-mio-m0-20261021-kS61xo/verify/
cd /private/tmp/mioon-mio-m0-20261021-kS61xo/verify
CI=true pnpm install --frozen-lockfile
```

媒体使用已有的 `/private/tmp/mioon-tools/ffmpeg`、`ffprobe`，版本均为 **9.0.2-tessus**。完整 `drawtext`、`subtitles` 滤镜可用；`drawtext` help 没有 `text_shaping`，沿用现有有界能力探测的等价路径。它不是 CI 的 FFmpeg 7.1.5；本轮结果仅代表上述 macOS 工具环境。能力原文与工具指纹保存在 `m0-baseline-logs/`、`m0-baseline-environment.json`。

为同时遵守 acceptance 收口范围和本阶段“每个文件独立进程、有超时”的要求，仓库外 `m0-baseline-runner.ts` 对以下八文件各执行一次：

```sh
node --test --test-reporter=tap --test-concurrency=2 <单个测试文件>
```

文件进程最多并发 2，每文件超时 600 秒；没有失败重跑、缩减用例、更新旧断言或跳过测试。

| 完整文件 | TAP tests / pass | 顶层用例 | 退出码 |
| --- | --- | --- | --- |
| `tests/agent-task-runtime-v2.test.ts` | 65 / 65 | 65 | 0 |
| `tests/agent-task-tools-v2.test.ts` | 57 / 57 | 57 | 0 |
| `tests/agent-task-journal-v2.test.ts` | 24 / 24 | 24 | 0 |
| `tests/agent-task-crash-v2.test.ts` | 12 / 12 | 12 | 0 |
| `tests/agent-task-boundaries-v2.test.ts` | 5 / 5 | 5 | 0 |
| `tests/worker-shutdown.test.mjs` | 20 / 20 | 20 | 0 |
| `tests/server-worker-shutdown.test.ts` | 2 / 2 | 2 | 0 |
| `tests/export-controls.test.ts` | 8 / 8 | 4 | 0 |
| 合计 | **193 / 193** | **189** | 全部 0 |

总计包含 4 个嵌套子例；0 fail、0 cancelled、0 skipped、0 todo、0 timeout。逐文件命令、时间、退出码和计数见 `m0-baseline-results.json`，TAP 在 `m0-baseline-logs/`。没有沿用旧验收文档中的 165 数字。

| 其他实际命令 | 结果 / 日志 |
| --- | --- |
| `CI=true pnpm install --frozen-lockfile` | 0；`install.log` |
| `node scripts/tooling.ts build --channel=development` | 0；含严格类型、Web 与桌面开发构建；`build.log` |
| `node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json` | 0；`tests-typecheck.log` |

构建保留未修改基线已有的 `use client` / sourcemap 提示和 chunk/bundle 尺寸警告，未关闭检查。M0 的源码与未修改 main 一致，所以此轮直接建立后续比较用的基线；没有功能改动需要以第二次同源测试冒充回归对比。新报告写入后重新 rsync，最终检查源码/锁文件与基线一致、报告空白规范、输入指纹和原工作区状态，并删除整个 `verify/` 副本，证据目录保留。

## 5. 后续阶段需纳入的差距

以下只记录现状，没有在 M0 修复或扩大阶段范围。

| 阶段 | 证据与注意事项 |
| --- | --- |
| M1 / M2 | 附录 B 和组件区只有 8 个显示标签，契约含第 9 个 `accepted`（`packages/contracts/src/agent-tasks-v2.ts:4`）。需补齐本地化映射，不能显示内部原值。当前已有稳定错误码，重点是按码显示与覆盖完整性。 |
| M1 / M2 | `task-gateway-v2.ts:23` 固定要求中文回答；用户语言的模型侧说明需连同此约束处理，不能仅翻译静态词条。步骤说明字段只能加在模型侧工具包装，执行前剥离，不能改变公共 RPC schema。 |
| M2 | `task-runtime-v2.ts:33–36` 的公开快照会把 Change before/after 置 null、删除 undo，HTTP 回归明确保护此边界（`tests/agent-task-http-v2.test.ts:47`）。需设计可安全本地化的变化投影，保留隐私边界，不能直接暴露整个原始业务快照来做摘要。 |
| M2 | 5.6 写建议分画板/剪辑两组，07 图只展示单列四项。分组指配置/模式切换还是可见标题，应在实现该屏前明确；不是 M0 的阻塞。 |
| M2 / M7 | 授权按完整 endpoint + 模型 + 范围绑定；设计示例的 base URL/host 不替代真实目标披露。只读工具还会返回项目描述、素材标注、主体、图像任务等，首次授权文案须按实际返回内容定稿。 |
| M3 / M7 | 计划 5.16 的“runtime 已排除诊断历史”只对上下文成立：`task-runtime-v2.ts:246` 排除 diagnostic，但 `:329`、`task-journal-v2.ts:46–53` 的历史查询仍返回它们。A1/M7 要补实际历史过滤。 |
| M4 / M5 | harness 方案中“1–5 节后端已实现”的概括过宽；冲突跳过与 superseded 跳过仍分别是 A2/A5。以实施计划的阶段划分和当前代码为准，不提前实施。 |
| M1 / M7 | `tests/agent-task-panel-v2-components.test.mjs:27` 固定直接显示服务端 message；`tests/agent-settings-ui.test.mjs:257–263` 固定旧介绍并禁止连接测试。后续按新设计改断言，保留草稿、回执、不重发和后台等待保护。`docs/AGENT-AUTHORIZATION.md:5` 也漏列现有 `project_agent`。 |

UI 工程约束已经核对：仍存在元素的 test ID 与定位选择器要保留；Tooltip 会覆盖按钮的 `data-slot`，使用稳定 `.wb-button`；颜色/尺寸复用 `--wb-*` token；四语言均使用 Mio，后台任务中心保留“任务”；静态界面标点与旧规范冲突时按本次设计优先。

## 6. 兼容性与阶段交接

- 旧执行记录、v1 只读历史、schema 52/53、旧备份恢复、HTTP/CLI 参数、已保存连接配置、密钥和授权均未改动。本阶段没有迁移，不新增 HTTP/CLI 行为。
- M3 实施 A1；M4 实施 A2/A3；M5 实施 A4/A5。届时新 schema、严格分类、备份恢复、HTTP/CLI 和对应测试一起落地，旧备份仍可恢复。
- M0 的 11 屏与组件区已导出并核对、基线测试/类型/构建完成。没有阻止 M0 收口的环境问题；后续设计细节和数据投影问题保留在上表。
- **停在 M0。等待用户确认后，才开始 M1 · 命名与用词。**
