# H3b · 检查的界面

日期：2026-10-29。范围只包含 H3b；保留首版与复核历史，最终提交前补充及交付授权见第 7 节。

复核更新：第 6 节记录同步最新 main 后的五项修复；第 7 节记录最终 sentinel 间距修复和提交前复验。第 1～5 节保留首版历史证据，其中预检取消、自动次数、空项与语义色的旧行为以第 6 节为准。

## 1. 基点与范围

- 从 `origin/main` 的 `bd7ad28993d2589ab7cbccf7a1d7b26f946f6a0e`（PR #66 的 H3a merge commit）新建工作树 `/Users/kouzen/.codex/worktrees/mio-harness-h3b/mioon` 与分支 `codex/mio-harness-h3b`；开工时工作树干净。主 checkout 和 H3a 工作树未修改。
- 按主 checkout 中只读的 `designs/MIO-HARNESS-PARALLEL-PROMPTS.md` 第 4 节、`MIO-HARNESS-DESIGN-PROMPTS.md` H3b、`mioon-design.pen` 第 10 分区和 10-01～10-08 预览实施。第 11 分区、要求组、补做徽标和说明行不实现。
- 只修改前端、四语文案、对应测试与文档。没有改业务、契约、HTTP／SDK／CLI、请求装配、流式写入、存储格式、工具发现、依赖或请求指纹 fixture。
- 本阶段没有模型调用、付费生成、用户项目数据写入、提交或推送。完整测试套件留到获准创建 PR 后的 CI，本机只跑聚焦集合。

## 2. 实现与文件

| 分组 | 文件与结果 |
| --- | --- |
| 界面 | 新增 `apps/web/src/AgentTaskChecks.tsx`；`AgentTaskPanel.tsx` 在本轮变化之后挂载，仅 `completed`、有 Mio 回复且属于当前项目的轮次可显示。原有步骤、变化和控制样式不改。 |
| 界面状态 | 新增 `apps/web/src/agent-task-checks-state.ts`，集中管理按需读取、并发、缓存、自动／手动预检、失效、取消和等待刷新；所有状态仅保存在应用内存。 |
| 展示与样式 | `apps/web/src/agent-task-presentation.ts` 追加目标名称、结构化原因、已有时间线字段与既有定位入口的投影；`agent-task-v2.css` 只追加检查组件样式，使用现有 token。新按钮复用共享 WorkbenchButton／Tooltip。 |
| 浏览器读取 | `apps/web/src/agent-tasks-v2.ts` 追加独立 `createAgentTaskChecksReader`／`readAgentTaskChecks`；原 `AgentTaskClient` 接口、执行读取与 session 语义不改。只 GET checks，用 `agentTaskChecksSchema` 校验并绑定 projectId／runId。 |
| 四语 | 新增 `packages/i18n/src/catalogs/mio-checks.ts` 的 61 个 `agent.checks.*` 键，`packages/i18n/src/index.ts` 仅追加注册。覆盖 4 组、10 类型、20 原因码、参数、进度、英文单复数和可访问名称。 |
| 测试 | 新增 `tests/mio-checks-reader.test.ts`、`mio-checks-state.test.ts`、`mio-checks-presentation.test.ts`、`mio-checks-components.test.ts`、`mio-checks-i18n.test.ts`，严格 TypeScript；已有断言不放宽。 |
| 文档 | `docs/AGENT-TASKS-V2.md` 只补检查界面的行为及服务端／前端缓存边界；本文件记录验收证据。 |

### 显示与安全边界

- 不适用项与空组不显示；保留接口分组顺序，各组内稳定地将未通过项排在最前。全部通过默认折叠，未通过／等待默认展开，用户可手动切换。
- 状态图标、名称、对象和既有定位入口按设计显示。对象名优先使用 `target.name`，缺失时沿用 `taskTargetTitle`。时间线片段数、画幅、fps 只使用接口给的 `current` 字段。
- 原因来自闭集原因码和完整的安全参数。缺少期望／实际宽高时使用保守原因，不猜文件已删除、不回显 provider 消息、机器状态、issueCodes 或内部 ID。语义色仅用于状态图标和摘要失败数字；费用待核对、记录不可用等等待不旋转。
- 标题按钮的可访问名称包含展开动作、检查项数和最坏状态摘要；保留 `aria-expanded`／`aria-controls`。重新检查、定位有四语可访问名称和提示。
- 恢复副本与普通轮次共用检查读取。检查不成为授权、审批、恢复或补做依据，没有新增执行按钮。

### 读取、预检与缓存

1. 以 IntersectionObserver 限定进入日志可视区域的轮次；同时检查 dock、历史覆盖层、加载切换与 document 可见性。应用共享队列最多并发 2 个 checks 读取，排队取消不会派发。
2. 轻量结果按工作区／项目／runId 和返回的 runRevision 缓存，最多保留 100 轮报告。切换项目、对话或轮次不会显示别轮结果。
3. 快照 run.revision 改变或 `backgroundPending` 从 true 变为 false 时立即轻量重读。现有 SSE 不能覆盖所有更新：例如 scene.detect 完成只更新 scene 表，进度／费用变化也不保证追加 run event。因此可见且有等待项时每 5 秒轻量兜底；没有等待项、隐藏或卸载即停止。
4. 最新一轮轻量结果有 `PREFLIGHT_NOT_REQUESTED` 时，在应用生命周期共享集合中先占位，最多自动完整预检一次；失败、取消、StrictMode 重挂或重开面板都不自动重试。普通历史轮不自动完整预检。
5. 用户重新检查才显式再发完整预检；忙碌期间共享按钮实际禁用，成功后标题显示“刚刚检查”直到下一次刷新。轻量默认 12 秒，完整 `max(configuredTimeout, 60000)`；超时或外部取消即使 fetch／body reader 不响应 signal 也会拒绝，清理 timer／listener。
6. 完整预检只与同轮检查项 `basis` 中的 timeline ID／revision 对照；不比较整段 basis，因为完整结果还带素材等依据、轻量项只带 timeline。轻量读到不同时间线修订就失效。没有可复用完整结果时，`PREFLIGHT_NOT_REQUESTED` 不显示、不计数、不旋转；正在实际预检时临时显示进行中。
7. epoch 与 AbortController 阻止迟到轻量结果覆盖完整结果；读取失败保留上次结果并显示原有错误样式。所有请求都是只读，不新增供应商轮询或模型请求。

### 定位能力

| 检查目标 | 复用入口／限制 |
| --- | --- |
| shot | 必须匹配本轮已有 change，调用原 onLocate。 |
| timeline | 用本轮已有时间线 change 的原入口切到剪辑模式；不新增时间线对象标记。 |
| job | 原 onOpenRequests 的 job UUID。 |
| export | 仅能证明来自本轮 timeline.render 时打开 `render:`；分镜 export.create 不在渲染列表，不显示定位。 |
| scene_task | 原 `scene:` 后台入口。 |
| image_task／frame_task | 普通工作区用原 `image:`／`frame:`；恢复副本的现有 App 会拒绝这两类导航，因此隐藏定位按钮。 |
| project、asset、version、image_group、image_version、step、run | 没有可复用的直接入口，不显示定位按钮。shot 没有匹配 change 时同样隐藏。 |

## 3. 与计划和设计稿的对照

- 按 H3b 范围实现；H4b 要求组可在 `groups.map` 前追加，本期不增加目标检查或补做操作。
- 图稿箭头位于标题左侧，沿用已确认 `.pen`／预览的排列。第 4 节文字枚举把展开箭头列在最后；此处以确认画板为准，未增加额外按钮。
- 图稿中的红色原因与费用等待旋转按最新第 4 节修正：原因使用次要文字色，只有 `TASK_PENDING`、给了 progress 或实际完整预检的项旋转。
- 图稿的预检、文件删除原因、片段信息只有接口能支持时才呈现；不补查接口外的信息。示例项数随真实结果计数，不硬编码为旧行为提示词的 4 项。
- 原日志的 stable scrollbar 使 320px 面板内检查区实测约 291px，比画板的 296px 窄约 5px；保留原日志／面板样式，长内容在原日志内滚动。10-08 只验证实际面板在中性位置 fixture 中的位置，不冒充对整套剪辑页面作像素复刻。

## 4. 验证环境与结果

证据根目录为 `/Users/kouzen/Library/Caches/mioon-harness-H3b-2026-10-29/`，不在临时目录。原生使用 Node 24.21.0、pnpm 11.25.0、UTC、`TMPDIR=/private/tmp`；长运行由各自的 `caffeinate -i` 包裹。

- 在自己的新工作树运行 `CI=true pnpm install --frozen-lockfile`，冻结锁安装成功，没有清空旧工作树依赖或修改锁文件。
- `node scripts/tooling.ts build --channel=development` 首版与最终图标修正版都 exit 0；均实际运行 3 个 strict TypeScript 项目、Web 与 Desktop development 构建。日志 `build-final.log`／`build-final-v2.log`，命令结果 `build-result.json`／`build-result-v2.json`。没有仅靠 Vite 转译代替类型检查。
- TypeScript AST 审计覆盖全部 12 个改动／新增 `.ts`、`.tsx` 文件，显式 any 与 ignore／nocheck 均为 0，最终逐文件哈希在 `source-audit-v2.json`。

### Linux 聚焦与逐名对比

固定完整 FFmpeg 镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`（Node 24.21.0／FFmpeg 7.1.5）、UTC、非 root、network none。每文件独立容器／进程，内层 600 秒、外层 630 秒限制，并发 2；保留已有独占调度规则，不运行本机全量。

首版快照 6017 个输入（仅排除本报告），SHA-256 `8be31bb1743a944e31c4d0c17156cb93362b2f82152933c79ce3680aacbb6093`。实际执行 `TMPDIR=/private/tmp python3 -u /Users/kouzen/Library/Caches/mioon-harness-H3b-2026-10-29/focus-suite.py`，完整逐文件 Docker 命令保存在结果 JSON。

首轮 **63/63 文件、1107/1107 通过**，294.989 秒，0 失败／跳过／取消／超时。包含 runtime 185 条及两个 H0 要求的完整 FFmpeg 用例、Anthropic 恢复 15 条、context-report 4 条、H2 流式 23 条、H3a 检查 26 条、99 条请求指纹（含 12 条诊断）。原 H3a 42 文件／895 条和额外 16 文件／165 条的测试名、层级路径、同名序号及状态均匹配；新增 5 文件／47 条，合计 63／1107，不重复累计重叠用例。

截图复核时修正了图稿已要求的失败圆环叉和失败项主文字色，并在原组件用例增加圆环断言；仅涉及 `AgentTaskChecks.tsx`、`agent-task-v2.css`、`mio-checks-components.test.ts`。进行中的首版快照始终不改，仍按原件完成。其驱动整体 exit 1 是末尾源漂移门禁检测到这 3 个宿主文件有意前移，**不是测试失败**；快照自身无变化，门禁没有关闭或绕过。首版结果不能单独作为最终候选整体验收，最终修正版另建快照并复验。

最终修正版快照 SHA-256 `000573e55b97e10d8e5184dfb24091b50d9d6790dc034b1d9bad7fedab7ca760`，同为 6017 输入；与首版正好上述 3 文件不同，其余 6014 输入逐字节相同。证据 `design-alignment-v2/source-differences.json` 和 `.patch`。

实际执行 `TMPDIR=/private/tmp python3 -u /Users/kouzen/Library/Caches/mioon-harness-H3b-2026-10-29/design-alignment-v2/focus-suite.py`，**25/25 文件、301/301 通过**，59.073 秒，驱动 exit 0，0 失败／跳过／取消／超时。范围为新增 5 文件、Panel 组件、agent-tasks-v2 UI、ui-components、Mio 命名与展示、UTF-8 门禁、13 个既有 i18n 文件和 99 指纹。逐名与首版同范围对比，301 个完整路径／出现序号全部匹配，0 缺失、增加或状态变化；圆环仅增强已有断言，没有增加用例数量。完整结果、清单和命令见 `design-alignment-v2/{selection,candidate-focus-results,name-comparison,validation-summary,focus-suite-command-result}.json`。

两轮按文件去重后的覆盖仍为 **63 文件／1107 条**：首版未受图形修改影响的 38 文件／806 条，加最终修正版替换的 25 文件／301 条。不能将 1107 与 301 相加，也不声称最终修正版独立跑过一次 63 文件，更不是全量测试。无需重复未改的 runtime 长测，两个指定 FFmpeg 用例的首版通过证据保留。

基线来源：原 H3a 42／895 取自 `mioon-harness-H3a-2026-10-28/sync-main-for-pr/candidate-focus-results.json`；额外 15／161 取自 H1c `mioon-harness-H1c-2026-10-28/candidate-effective-results.json`（base `f554a21051238513abc2d22493c687ade0e2bca0` 的历史实测，不称为本次 main 独立全量）；UTF-8 门禁 1／4 取自 H3a `ci-utf8-inventory/linux-results.json`。`name-comparison.json` 保存各来源与完整逐名对比。新增 5 文件／47 条是本期新增能力，不冒充既有基线覆盖。

最终运行结束后，6017 个输入在候选工作树与新快照中均无漂移（本报告除外）。专用 driver／wrapper／caffeinate 均已退出，没有本次标签的残留容器；详见最终 `validation-summary.json`。开发期间的严格类型收窄、浏览器 ES2022 数组方法和调度测试时序错误均已修正，原始失败日志保留；没有删除断言、降低类型门槛或把中途失败算作正式通过。

### 真实浏览器与设计对照

使用已安装的 Python Playwright 与 Chrome，沿用仓库的 headless 截图方式，不安装新依赖。缓存中的中性容器加载真实 `AgentTaskPanel`、`I18nProvider`、共享控件与项目原 CSS；Vite／Tailwind 编译实际源文件，不手写仿制检查 HTML。schema 校验的合成 GET 响应驱动状态，所有非 GET／外部请求硬拒绝并审计。没有使用用户项目或真实模型。

最终 bundle、输入哈希、驱动和记录保存在 `design-alignment-v2/browser/`；PNG、DOM 尺寸、ARIA、网络审计在其 `screenshots/`。首版观察图保留，最终以本目录为准。

| 画板 | 最终截图与实际核验 |
| --- | --- |
| 10-01 | `10-01-pass.png`；全部通过默认折叠。 |
| 10-02 | `10-02-failed.png`、`10-02-failed-scroll-checks.png`；失败默认展开、组内置顶、圆环叉、参数原因。 |
| 10-03 | `10-03-progress.png`；生成中 62%，实际进行中的 2 项旋转、费用等待不旋转。 |
| 10-04 | `10-04-background-finished.png`；通过真实 SSE 的新快照自动轻读后全部通过，截图显式展开查看 3 项。 |
| 10-05 | `10-05-manual-recheck.png`、`10-05-manual-recheck-scroll-checks.png`；点击后只 GET 完整预检、文件不可用、标题“刚刚检查”。 |
| 10-06 | `10-06-restored.png`、`10-06-restored-scroll-checks.png`；恢复副本保留检查／重新检查／已有定位，未新增写操作。 |
| 10-07 | `10-07-english.png`、`10-07-english-scroll.png`、`10-07-english-scroll-checks.png`；320 宽下完整 5 项与标题同屏可读，长说明换行。 |
| 10-08 | `10-08-position-fixture.png`；实际面板在中性布局中的位置证据，未宣称复刻完整剪辑页。 |

最终 Chrome 版本为 156.0.8078.48，共 16 张 PNG（7 种状态、4 张日志滚动、4 张检查区补图、1 张位置图）；67 个请求全部 GET，其中 checks 读取 15 次。全部面板为 320×850；没有横向溢出，新增检查文案最小 11px，刷新／定位点击区至少 24×24，pageerror、未知 API、非 GET 与外部请求均为 0。CDP 实测中文沿现有字体栈使用 PingFangSC-Medium；设计稿指定 Noto Sans SC，本期没有为此更换原有字体或增加字体依赖。长内容保留原日志滚动，并提供完整检查区补图。

浏览器关闭，fixture driver、server 和专用 caffeinate 均退出；截图后修正版 3 文件 SHA 仍与最终快照一致。审计见 `design-alignment-v2/browser/validation-summary.json`、`browser/screenshots/report.json`、`final-browser-confirmation.json`。

### 请求指纹与 pin

99 条请求指纹（含 12 条诊断）全部不变，没有运行 `--update`。fixture SHA-256 为 `01492d0daa0cdc653108036d5f9dbc2029e64b452cd3fdbf4fbd0ecbfe78fac5`，与 HEAD 原件相同。`pnpm-lock.yaml` SHA-256 为 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`；`reviewed-live-sources.json` SHA-256 为 `6b860168e9893f06386ecb6ebaab5f0d878590c5c693802b8dab51e175755c6e`，所有已登记源码逐个哈希核对通过，没有 pin／schema 更新。

## 5. 兼容性与交付边界

- 旧执行记录、未发送 intent、恢复副本、既有 CLI／SDK 调用方不改；检查接口、快照、运行状态、持久化结构与请求原件不变。
- 全部缓存仅在前端内存；没有写入 workspace、localStorage 或会话回执。不改变后台结果的未知处理、重发、计费、确认或授权边界。
- 没有新增依赖或新式 JSX 配置假设：新 `.tsx` 显式 import React，兼容当前 main 的转换方式。
- H3b 已完成验证，没有本期未处理的问题；全量套件仍按授权留到 PR 的 CI。没有实现 H4a／H4b 或主线 H1d。当前停下，等待确认再提交或同步 main／创建 PR；届时重新核对并保留并行线改动，合并方式仍用 merge commit，代理不合并。

## 6. 审查修复：同步 main 与五项调整

### 同步与授权边界

按本次明确授权，先将 `codex/mio-harness-h3b` 从 `bd7ad28993d2589ab7cbccf7a1d7b26f946f6a0e` 快进到最新 `origin/main` 的 `66e1b3e5970fe63a59df3d2427f25f913c1bc4ed`，包含 #61、#65、#67、#68、#69，再恢复 H3b 的 15 文件改动。同步前保存 tracked patch、各文件哈希和原 stash 清单，记录在 `review-fixes/before-sync.patch`、`before-sync-files.json`、`previous-stashes.txt` 与 `sync-record.json`。

只创建并 apply 本轮自己的 stash `3c945905ea8a0e1ace4261ae18b2dafc119e362d`，仍保留作备份；没有 pop／drop、apply 或改动其他共享 stash。`AgentTaskPanel.tsx` 与 `agent-tasks-v2.ts` 两处冲突已人工保留双方：Mio 提问／回答、档位菜单及 session 与 H3b 检查接入／独立 reader 均在；自动合并的 CSS、文档 main 新段落也完整保留。解决冲突后尚未创建任何提交或推送。

本次继续只修改 H3b 前端、四语、对应测试和文档。main 自带的契约、存储、runtime、指纹和 pin 更新属于上游同步，不计为本期新改动。

### 五项修复与回归

| 审查项 | 修复与可观察结果 | 回归证据 |
| --- | --- | --- |
| 1. 完整预检生命周期 | 将可读可见性与检查归属分离。已开始的完整预检忽略同轮 revision、后台完成、viewport／document／dock 可见性变化；期间的轻量刷新合并丢弃，不排另一个请求。只在卸载、切换对话／项目、换轮或轮次不再 completed 时取消。手动成功保留完整结果与“刚刚检查”。 | deferred reader：手动预检期间 backgroundPending true→false、revision 推进；自动预检滚出／滚回；隐藏期间完成；归属取消及迟到响应。 |
| 2. 自动次数 | 用应用内“正在尝试”的 token 与“已经终结”的集合分别记录。成功／真实失败（含超时）才消耗一次；取消立即释放自己 token，旧响应不能消费或释放重挂后的新尝试。已完成的失败不自动重试。 | deferred reader：dispose 后 remount 重试；旧失败迟到不抢新 lease；第三个观察者不重复派发；实际失败／超时后 remount 不重试。 |
| 3. 空项与初读 | 同一 section 保持观察器引用；无可显示项且无预检／错误时只保留零高 sentinel。首次读取和成功的全 not_applicable／NOT_REQUESTED-only 均没有标题、0 项或空文案。首次失败仍有错误及重试入口。 | 组件测试覆盖初读 loading／未 loading、三种空结果、错误重试、实际预检进行中；sentinel 的零高与非 display:none 校验。 |
| 4. 画板文案与颜色 | 四语 titleCount 去掉内部的点，独立分隔点放在项数与摘要之间，例如“完成情况 5 项 · 1 项未通过”。整段失败摘要及失败原因用现有 danger，等待摘要用现有正文色，背景不填色。 | 四语单复数／点位、组件 sibling 顺序与完整摘要 tone、失败原因与等待色 token；真实截图计算颜色。 |
| 5. 真实 fixture | 合成返回中的 timeline target 去掉 name，保留实际 H3a 返回形状。对象名依既有 taskTargetTitle 按当前语言回退。 | fixture 生成时断言 timeline target 无 name；English 真实 DOM 断言两条时间线对象使用 Timeline、无中文“时间线”。 |

Panel 没有用通用 loading 阶段取消完整预检：新 main 在同对话恢复可见时也会进入 loading。另用只在用户真正选择另一对话时改变的 navigation epoch／attached 标记，保留窗口隐藏与同对话重读的完整预检；过期的选择回调不能恢复新导航的归属。

`docs/AGENT-TASKS-V2.md` 的完成情况段落同步上述行为。没有新增模型请求、写操作、依赖或业务工具。

### 本轮验证

本轮证据集中在 `/Users/kouzen/Library/Caches/mioon-harness-H3b-2026-10-29/review-fixes/`。独立 `node scripts/tooling.ts typecheck` exit 0；源码冻结后 `node scripts/tooling.ts build --channel=development` 也 exit 0，114.905 秒，包含 3 个 strict 项目、Web 与 Desktop development。两者均使用 Node 24.21.0、UTC、`TMPDIR=/private/tmp`、专用 `caffeinate -i`。命令和结果见 `typecheck-result.json`、`build-result.json`；冻结锁安装 exit 0，锁未改。12 个改动／新增 TS／TSX 文件 AST 审计的 explicit any、ignore／nocheck 为 0，见 `source-audit.json`。

Linux 沿用固定镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`、Node 24.21.0、FFmpeg 7.1.5、UTC、非 root、network none。独立克隆此前同锁验证通过的 Linux 依赖，并逐个核对依赖清单／配置，不声称重新安装。每文件独立进程／容器、600／630 秒限制，并发 2；基线与候选依次执行，不叠加并发。

| 本次实际验证 | 结果 |
| --- | --- |
| 干净 main 的已有 20 文件 | 20/20 文件、264/264 测试通过，46.402 秒，driver exit 0。源码取自 `git archive 66e1b3e…`，没有混入 H3b 改动。 |
| 同步修复后的原 25 文件聚焦集 | 25/25 文件、323/323 测试通过，52.522 秒，driver exit 0。0 失败／跳过／取消／超时。 |
| 本期 5 个新测试文件 | 59/59（reader 9、state 25、presentation 9、components 11、i18n 5），包含用户指定的 deferred 场景。 |
| Mio Panel／session／共享 UI | Panel 组件 39、agent-tasks-v2 UI 72、ui-components 29 均通过；其他命名、展示、UTF-8 与 13 个 i18n 文件均通过。 |
| 请求指纹 | 99 条、含 12 条诊断，在干净 main 和候选中均通过，候选 fixture 逐字节等于新 main。 |

实际驱动为缓存中的 `main-baseline/focus-suite.py` 与 `focus-suite.py`，由各自 `caffeinate -i` wrapper 执行；完整逐文件命令和路径见 `validation-summary.json`、各自 `focus-suite-command-result.json` 及 `candidate-focus-results.json`。本轮只跑用户指定的聚焦范围及对应干净基线，没有跑全量或重跑 runtime 185。

干净 main 的 264 个测试与候选对应 264 个按文件、完整 TAP 路径和重名序号全部匹配，0 缺失／新增／状态变化。相对旧 H3b v2 的 301 项，本轮为 `301 + 10 个上游新增 + 12 个本期净新增 = 323`；上游新增为 Panel 3、session UI 7。精确名称对比为 298 个保留、25 个新名、3 个有意替换旧名：英文摘要从数字着色改为整句着色、自动预检卸载由消耗次数改为释放 lease、隐藏取消仅指轻量读取。新增与替换均对应本次审查规则，没有把旧名消失写成无故丢失，映射见 `name-comparison.json`。不同基线与重复执行的计数不累加。

候选冻结 6036 个输入（仅排除本报告），SHA-256 `158783787a643415b26a6a32ed1b1ac1962b6220521a14428d8bf62f3ba54772`；干净 main 6028 输入，SHA-256 `77ccb462efa3311a2f200ca38d587ae168181186eb178ce83f9f48d87df3f241`。运行后工作树／快照／输入列表均无漂移，专用 driver、wrapper、caffeinate 与标签容器均已退出。

同步后的 fixture SHA-256 为 `ce325c3aeff5fd9779c3b1556c3cb9ddf66d9198ba997b5309316ea293031ac8`；`reviewed-live-sources.json` 为 `b0909305d6e1be6af3f761f10974581f521ee3dd15f1a00ab0adfa168e0b371b`，两者均与新 main 相同，没有 `--update` 或 pin 更新。旧 `01492d…` 到新 fixture 的变化来自上游 87 条非诊断请求，12 条诊断未变；归因见 `upstream-fingerprint-differences.json`，不算本期改变请求字节。锁仍为 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。

### 本轮截图与最终状态

实际 Chrome 156.0.8078.75，继续使用真实 Panel／Provider／共享控件与 CSS 的合成只读 fixture。最终证据在 `review-fixes/browser/screenshots-clean/`：10-01～10-07、English、原滚动／检查区补图及 10-08 位置图全部重采，另有 `09-pure-qa-initial-loading.png` 与 `10-pure-qa-all-not-applicable.png`，合计 18 张 PNG。原生检查文本最小 11px，点击区至少 24×24，320 宽没有横向溢出。

- 未通过摘要整句与原因的 danger 色、等待摘要正文色、分隔点位置均已核对；四语标题／单复数有严格用例。
- English 两条时间线对象实际为 `Timeline · 5 clips` 和 `Timeline · 1080×1920 · 30 fps`，fixture 及渲染均不注入中文 name。
- 纯问答用延迟响应与 MutationObserver 观测全过程：初读与成功全 not_applicable 后 sentinel 均高度 0、无文本／子元素，完成情况 header 插入记录为空，没有瞬闪空标题。
- 83 个请求全部 GET，页面错误、未知 API、写请求／模型请求／外网请求均为 0。首跑 Playwright 库自身的 Response.finished 收尾 warning 已保留；缓存 helper 等待响应 body 完成后重跑清洁证据，断言不改、仓库源码不变，最终日志无该 warning。
- 浏览器、fixture server／driver／caffeinate 均结束，截图源码与冻结候选一致。审计、图片哈希和清理见 `browser/validation-summary.json`、`browser/screenshots-clean/report.json`。

本次五项修复与指定验证已完成。旧执行记录、恢复副本、契约和业务／runtime 未做本期新改动；没有新依赖或真实模型／付费调用。自己的备份 stash 及其他共享 stash 均保留（`stash-audit.json`）。当前分支基点与 `origin/main` 同为 `66e1b3e…`，所有 H3b 改动仍未提交、未推送，停下等待复核。

## 7. 提交前补充：抵消空 sentinel 的 flex gap

H3b 复核通过后，按新增要求仅补 `.mio-round>.mio-checks-sentinel{margin-top:calc(-1*var(--wb-space-3))}`。零高元素仍参与 flex 布局，这条规则抵掉它额外带入的 12px gap；不使用 display:none，不移除或替换原生 IntersectionObserver。其余行为与第 6 节一致。

改动后再次 `git fetch origin`、`git merge --ff-only origin/main`，返回 Already up to date，main 仍为 `66e1b3e5970fe63a59df3d2427f25f913c1bc4ed`，没有需要再次合并的新提交。提交前的范围仍为 H3b 原 15 文件；锁、契约、business／runtime、server、SDK／CLI／MCP、指纹和 pin 相对该 main 均不改。

本轮独立证据在 `/Users/kouzen/Library/Caches/mioon-harness-H3b-2026-10-29/submit-pr/`。冻结 6036 输入（本报告除外），SHA-256 `9b12aa27278d696f50ad68d862a7206d2224e945124ba86ce22b95046cf6330a`；逐文件与第 6 节快照对比，只有上述 CSS 一行变化，见 `source-differences.json`／`.patch`。

| 本轮实际验证 | 结果 |
| --- | --- |
| `node scripts/tooling.ts typecheck` | exit 0，52.137 秒，3 个 strict 项目通过；Node 24.21.0、UTC、`TMPDIR=/private/tmp`、专用 `caffeinate -i`。 |
| 原 25 文件 Linux 聚焦集 | 25/25 文件、323/323 测试通过，44.567 秒，driver exit 0；0 失败／跳过／取消／超时。固定镜像、并发 2、独立进程及 600／630 秒限制沿用第 6 节。 |
| 逐名对比 | 与第 6 节 323 项完整 TAP 路径／重名序号／状态完全匹配；与同 main 的 20 文件／264 项对应范围也完全匹配。 |
| 请求指纹 | 99 条、含 12 条诊断全通过；fixture `ce325c3aeff5fd9779c3b1556c3cb9ddf66d9198ba997b5309316ea293031ac8`、pin `b0909305d6e1be6af3f761f10974581f521ee3dd15f1a00ab0adfa168e0b371b` 均逐字节等于 main，没有更新。 |

实际命令和结果为 `typecheck-result.json`、`focus-suite-command-result.json`、`candidate-focus-results.json`、`name-comparison.json` 与 `validation-summary.json`。最终输入及快照没有漂移，专用 wrapper／driver／caffeinate 与标签容器均退出。本轮不跑全量，按要求交给 PR CI。

提交检查时同步修正了 CSS 中仍描述旧“仅摘要数字着色”的陈旧注释。该项仅改变注释；逐字移除注释后的 CSS 与已验证快照相同，实际 esbuild 压缩结果也逐字节相同，证据为 `final-comment-audit.json`。没有因此改动已验证的样式声明或交互。

### 连续两轮纯问答与 main 对照

同一份合成只读数据，用真实 clean-main `66e1b3e…` 与候选 Panel／CSS 分别构建，Chrome 156.0.8078.75、320×850；没有仿制 HTML 或修改 IntersectionObserver。main 与候选两轮纯问答的最终 PNG 字节相同，候选初读等待态与最终 PNG 也相同，SHA-256 均为 `84950690e9194ca4cbb009b39dafa709424a1b12f98ffef338fd4a860b9b8c7f`。

| 实测位置／间距（px） | main | 候选 |
| --- | ---: | ---: |
| 第一轮高度 | 142.9375 | 142.9375 |
| 第二轮高度 | 155.9375 | 155.9375 |
| 第二轮分隔线 Y | 203.9375 | 203.9375 |
| 两轮之间 gap | 12 | 12 |
| 各轮可见子项邻接 gap | 12、12、12 | 12、12、12 |

候选两个零高 sentinel 在 `.mio-log` 可见范围内各触发一次真实 checks GET，读取前后均为 height 0、没有 header 插入／瞬闪，读取完成后几何不变；main 的 checks GET 为 0。20 个请求全为 GET，pageerror、未知 API、写／模型／外部请求为 0。两份真实 Vite 构建均 exit 0，浏览器、两个 fixture server 及专用进程均结束。

图片为 `browser/two-rounds/main-two-rounds.png`、`candidate-two-rounds-initial-loading.png`、`candidate-two-rounds.png`；尺寸、请求、原生观察器、图片哈希和清理证据见 `browser/validation-summary.json` 与 `browser/two-rounds/report.json`。

本次交付已获授权：将上述已确认的 H3b 改动提交、推送并创建面向 main 的 PR。合并方式要求 merge commit，不使用 squash／rebase；代理不执行合并。既有共享 stash 及本阶段的独立备份继续保留。
