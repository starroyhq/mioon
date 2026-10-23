# Mio · M5 失败与撤销（A4、A5）

日期：2026-10-23。本阶段仅实施 M5，未进入 M6。工作树 `/Users/kouzen/.codex/worktrees/mio-m5/mioon`，分支 `codex/mio-m5`，基于冻结 main `3f678c628e3afcbe8e71372fea00a36afd9033c5`，开工状态干净。没有 commit、push、开 PR、合入 main、依赖变更、真实模型调用或付费生成。

持久证据根：`/Users/kouzen/Library/Caches/mioon-mio-m5-20261023/`，下文简称 E。完整全量为 `current-fix1`，随后仅修正 UTF-8 检查清单并单文件重验；不把定向结果拼接成另一轮全量。早期 `current` 在修复审查问题后主动终止，不能当成最终结果。功能修改完成与环境未通过的检查分开记录。

## 1. 完成内容与文件

| 分类 | 文件（相对仓库） | 结果 |
| --- | --- | --- |
| 界面（4） | `apps/web/src/AgentTaskPanel.tsx`、`agent-tasks-v2.ts`、`agent-task-errors.ts`、`agent-task-v2.css` | 末步失败原因、重试、安全详情和按错误码的设置入口；轮末固定说明；整体撤销预览、取消和数量确认；禁止单撤后续修改，显示已撤销。 |
| i18n（2） | `packages/i18n/src/catalogs/mio-panel.ts`、`agent-task-errors.ts` | 简中、繁中、English、日本語同步；预检过期原因专门本地化；Mio 保留拉丁字母。 |
| 契约（1） | `packages/contracts/src/agent-tasks-v2.ts` | retry 控制、只读 modifiedAfter／undoDisposition、undo_all 的可选确认集合 undoChangeIds。 |
| 业务（4） | `packages/business/src/agent/task-runtime-v2.ts`、`task-journal-v2.ts`、`task-tools-v2.ts`、`task-schema-v2.ts` | 持久幂等重试、失败批次失效、投影与实际补偿共享边界、superseded 保留、拒绝展示字段进入固定备份格式。 |
| 传输（1） | `packages/client/src/agent.ts` | 命令目录新增 retry，HTTP／CLI 复用现有共享契约与通用 actions 路由，无需新增专用路由。 |
| 测试（7） | `tests/agent-task-runtime-v2.test.ts`、`agent-task-tools-v2.test.ts`、`agent-task-http-v2.test.ts`、`agent-task-panel-v2-components.test.mjs`、`agent-tasks-v2-ui.test.ts`、新 `agent-task-m5-storage.test.ts`、`transport-utf8-output.test.mjs` | 重试、授权、预算、付费、未知结果、补偿链、确认集合竞态、UI 状态、HTTP／CLI、固定格式备份恢复。 |
| 文档（3） | `docs/CLI.md`、`docs/AGENT-TASKS-V2.md`、本报告 | 命令、失败与未知结果边界、撤销证明和兼容限制、验证证据。 |

合计22个改动／新增文件（含本报告）。用户原有未跟踪待办、原工作区、设计输入、package.json 和锁文件保持原样，最终哈希与文件清单见 `E/evidence/final-delivery-state.json`。

**A4。** retry 仅允许 failed 轮次的最后 failed 步骤，拒绝 unknown／dispatch_started；保持 Run、已有步骤和预算。模型只有在网关证明尚未发送时记为可重试失败；无法证明未发送的超时或连接故障继续作为结果未知处理（此规则已在复审中修订，见第 6 节）。工具确定失败后停止旧批次，重试把失败交给模型重新规划，后续旧参数失效，不重放原调用。预算耗尽进入步数暂停，明确继续才扩额。稳定 requestId、版本和回执、发送授权及执行前复查、跳过名单、付费确认、网络策略全部保留。未知本地结果经过原有原子回执核对并明确处置后，同样废弃旧批次，避免恢复时卡回新引入的终止门禁。

**A5。** modifiedAfter 只在读取时比较当前目标修订与 revisionAfter；undoDisposition 模拟逆序补偿链，明确哪些能撤、保留或被安全边界阻断。整体撤销只有在严格单目标、修订更晚、内容确实不同且没有草稿时标 superseded；ABA、复合变化、缺证据、草稿仍停止。首个阻断之后的更早项不会算进确认数量。本轮自身补偿链仍可连续回退，用户其他目标不受影响。

预览和补偿共同检查时间线领域约束、主体绑定／墓碑、生成依赖；不把实际无法撤销的项列为承诺。面板提交确认时精确的 undoChangeIds，服务端先比较可撤集合，逐条补偿前再限于该集合，防止另一窗口释放草稿后实际多撤了弹窗未确认的变化。集合过期写 rejected 回执，不能换新 ID 自动重试。

## 2. 设计对照与截图

按计划 A4、A5、5.10、5.12 与 07-04／07-05／组件区实施。设计输入指纹记录于 `E/evidence/initial-state.json`；PNG 在 `E/design/`，未读取加密 .pen 内容。

最终56张状态截图：四种语言×1440×900／1050×680×5种状态40张；另12张窄屏完整卡片、4张深色抽查。自动检查未发现横向溢出、低于10px文字、低于24px点击区；被测文字最低对比度浅色5.252、深色4.691。人工重点复核25张，覆盖四语完整卡片和全部深色图，未声称逐张人工核对全部矩阵。另保留4张实际撤销后的画面，共60张最终证据。

代表图（实际持久路径）：

- [模型失败](/Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/browser-accepted/m5-en-1440x900-model-failure-light.png)
- [工具失败](/Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/browser-accepted/m5-ja-1050x680-tool-detail-light.png)
- [有保留项的整体确认](/Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/browser-accepted/m5-en-1050x680-undo-confirm-light.png)
- [后续修改提示](/Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/browser-accepted/m5-ja-1050x680-undo-detail-light.png)
- [零项禁用](/Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/browser-accepted/m5-ja-1050x680-zero-confirm-light.png)
- [深色确认](/Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/browser-accepted/m5-en-1050x680-undo-dark.png)

有意复用／偏离：整体确认使用项目共享的420px居中 Dialog，保留焦点返回、Esc、遮罩和分组列表；组件稿为更紧凑的示意卡。失败末尾固定说明沿用已有 `.mio-error` 危险色，07-05 是普通正文色；内容、位置与四语按计划，实测对比度达标。合成工具失败选用真实预检过期，没有故意破坏工具或提交真实渲染来制造 FFmpeg 错误；FFmpeg、连接、生成服务各设置路由由组件测试覆盖。

1050×680 默认消息视口短，完整卡片补图通过用户已有的“收起时间线”和重新打开 Mio 展示，并非改变产品布局；长工具卡之后的固定尾句仍可滚动查看。失败轮次没有暂停按钮，输入框保留一个操作键。最终构建与浏览器静态资源SHA一致；完整截图清单、哈希、采集限制和历史见 `E/evidence/browser-evidence-manifest.json`、`browser-evidence.md`、`ui-visual-review.md`。

## 3. 实际验证与基线对比

运行环境：macOS arm64；Node24.19.0；pnpm11.25.0；TMPDIR=/private/tmp；GNU tar1.35。两个全量副本具有完整Git历史，包括4355c07。使用冻结锁文件安装隔离副本，没有清空仓库 node_modules。

隔离复制／安装及最终构建实际执行：

```sh
rsync -a --exclude node_modules --exclude .git --exclude apps/desktop/build --exclude apps/web/dist /Users/kouzen/.codex/worktrees/mio-m5/mioon/ /Users/kouzen/Library/Caches/mioon-mio-m5-20261023/verify/
CI=true pnpm install --frozen-lockfile
node scripts/tooling.ts build --channel=development
node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json
```

build 包含严格生产类型、Web 和桌面开发构建，退出0；测试严格类型退出0。构建日志保留既有 Vite use-client／大chunk警告。记录 `E/evidence/build-final.json`；日志 `E/logs/build-final.log`、`types-tests-final.log`。

完整全量实际启动命令（工作目录、Node绝对路径、双reporter等参数均由状态收据保存）：

```sh
python3 /Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/run-full-suite.py baseline
python3 /Users/kouzen/Library/Caches/mioon-mio-m5-20261023/evidence/run-full-suite.py current-fix1
```

两次均使用 `node --test --test-concurrency=2 --test-timeout=600000 "tests/*.test.mjs" "tests/*.test.ts"`，并启用 TAP 与逐事件 NDJSON reporter。逐文件隔离，超时一致且没有放宽；完整命令分别在 `E/evidence/baseline-full-state.json`、`current-fix1-full-state.json`。

| 完整运行 | 文件覆盖 | 测试 | 通过 | 失败 | 跳过 | 退出码 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 冻结 main 3f678c6 | 849/849 | 13,433 | 13,342 | 69 | 22 | 1 |
| 本分支 current-fix1 | 850/850 | 13,494 | 13,402 | 70 | 22 | 1 |

两边均无取消、无源码漂移、无缺文件、无解析归属歧义，TAP与全局计数一致。上表包含各3项父级传播失败；去重后共同失败66项，本分支独有1项，基线独有0项。按文件＋完整父子名称＋同名序号逐条对照，不按会变化的行号匹配。完整对照为 `E/evidence/full-comparison.json`；独立方法复核为 `full-comparison-method-review.md`。7组共同失败的原错文字差异已逐条核验，为合成标识、时间／轮询进度、临时路径及栈位置差异，未发现不同失败机制；两侧原错保存在 `m5-common-changed-failure-audit.json`，判断依据见同名.md。

**只在本分支失败的用例：**

| 用例 | 原因、修复与复验 |
| --- | --- |
| `tests/transport-utf8-output.test.mjs:270` — `every inventoried test/QA text collector configures continuous decoding at its actual listener, before delivery` | 新增HTTP/CLI测试helper后，stdout／stderr监听共6个，清单仍登记4，触发 `6 !== 4`。已核对三处helper均在on(data)前setEncoding(utf8)，只把第76行登记数4→6；原连续解码检查不变，不改例外哈希。修复后单文件4/4、退出0。 |

修复实际命令：

```sh
node --test --test-reporter=tap --test-timeout=600000 tests/transport-utf8-output.test.mjs
```

**没有再次执行整套全量。** 上表保留完整运行的真实失败；随后只有这一个测试清单字面量变化，已单独验证，未改产品源码。不能把“完整运行＋单项复验”改称第二轮全量全绿。修复命令、环境、6处连续解码证据及前后SHA在 `E/evidence/m5-utf8-inventory-fix.json`；完整运行副本没有被修改。未发现尚未修复的本分支新增失败。


最终 harness 安全收口（8文件）：

```sh
node --test --test-concurrency=2 --test-timeout=600000 tests/agent-task-runtime-v2.test.ts tests/agent-task-tools-v2.test.ts tests/agent-task-journal-v2.test.ts tests/agent-task-crash-v2.test.ts tests/agent-task-boundaries-v2.test.ts tests/worker-shutdown.test.mjs tests/server-worker-shutdown.test.ts tests/export-controls.test.ts
```

313测试，311通过／2失败；两项均为冻结 main 同名同原错的 Mock 媒体链，不将它们记通过。第一项独立诊断有 MOCK_RENDERER_UNSUPPORTED 直接证据，第二项下载屏障未进入仅作缺 drawtext 的源码支持推断。双协议 tool_before_commit SIGKILL 恢复通过。详情 `E/evidence/m5-safety-final-audit.md`、原日志 `E/logs/safety-final.tap`。

定向检查结果（存在重叠，不相加冒充独立总数）：

| 实际范围 | 结果 | 证据 |
| --- | --- | --- |
| UTF-8清单修复后的单文件 | 4/4 | `E/evidence/m5-utf8-inventory-fix.json`、`E/logs/backend-utf8-inventory-fix.tap` |
| 最终 tools 全文件 | 73/73 | `E/logs/backend-tools-shared-full.tap` |
| HTTP 与 CLI 双协议 retry／undo 范围 | 2/2 | `E/logs/backend-http-scope.tap` |
| panel／session／i18n | 33/33、57/57、5/5 | `E/logs/ui-review-*.log` |
| 新M5固定格式兼容 | 19/19 | `E/storage/validation.json` |
| 原会话／交互存储 | 39/39 | `E/storage/validation.json` |
| 带确认集合回执的52→53、54→55、56→57实际备份恢复 | 3/3 | `E/evidence/undo-scope-storage.log` |
| 独立后端审查最终定向复验 | 38/38 | `E/evidence/backend-review-final-focused.log` |
| 实际浏览器操作 | 13/13 | `E/evidence/browser-actions/functional-results.json` |

实际定向命令详见 `E/evidence/m5-delivery-facts.md` 与对应执行回执。独立审查发现的首次元数据补偿、轨道依赖、主体绑定三处问题已修复并复验，最终固定源没有尚未解决的已确认可操作问题；不把审查当成穷尽正确性证明。

浏览器连接独立合成数据目录，正常HTTP→runtime→领域事务执行；四语均验证同Run重试、预算不变、旧失败记录保留、旧工具不重放、失败结果进入模型上下文。整体撤销实际把第一镜头4恢复6秒，第二镜头保留人工改后的5秒，未新增生成或导出。丢ACK后保持未确认，点击查询原操作仅GET回执，无重复POST；设置入口不返回Key。最终种子24+重试8，共32次合成网关调用；真实模型／外部请求／付费均0。服务和浏览器已关闭。两静态资源的服务返回与磁盘构建SHA相同，见 `served-build.json`。

FFmpeg为 `/opt/homebrew/bin/ffmpeg` 9.0.2（Homebrew9.0.2_1），ffprobe同来源。可编码本次合成本地H.264/AAC素材，但缺少 drawtext、subtitles、zscale 滤镜和 libwebp 编码器。本次未新增依赖或下载替代构建。全量共同失败的直接错误、前置fixture级联、源码推断与未确证候选分别记录在 `E/evidence/m5-baseline-failure-audit.md`，不能只凭“基线也失败”判定所有根因都是环境。Node满足一般engines>=24，但历史测试另有24.21精确断言，实测结果单独列明。

## 4. 兼容性

- 普通56／恢复57保持不变。retry 回执原有 action 字符串和 result JSON 可承载；superseded 本就在固定Change枚举；重试元数据位于既有 Step.data JSON。没有表、列、索引、marker或恢复格式变更。
- modifiedAfter、undoDisposition 仅属于读取投影；固定持久分类显式拒绝，防止共享公共schema扩展意外放宽历史备份。52／54／56各自备份恢复和只读恢复边界实际通过；旧v1仍只读，旧执行不自动重跑。
- 新版client读取旧快照兼容可选字段；旧版strict client／CLI读取新增字段可能报协议错误，应与服务端配套更新。旧请求省略undoChangeIds在新服务端仍可用，但不享有UI确认集合绑定；新字段发给旧服务端会严格拒绝。retry是宿主控制，不加入模型或MCP业务工具目录。
- 已保存设置、凭据、project_agent授权、分档权限、付费默认确认和网络策略未改变。未迁移、提取或使用用户Key，未触碰持有会话Key的原生主进程。

## 5. 剩余事项与阶段边界

M5功能、类型、构建、定向安全和浏览器链路已落实；全量结果按上文实测报告，媒体能力缺失相关的失败仍保留，未放宽测试或超时来掩盖。完整媒体套件需要在已获授权且具备要求滤镜／编码器的环境中重验；本阶段没有擅自安装。

到此停在M5。未进入M6，未提交或推送。独立验证副本在保存日志／源码证据后清理，持久截图、日志、差分和源字节归档继续保留。设计输入、原待办和Git保护核对见 `E/evidence/final-delivery-state.json`。

## 6. 复审修复（2026-10-23）

复审发现 A4 与计划不一致：请求一旦发出，之后运行中收到的失败（429、401、500 等非 200 响应，超时，连接中断，流截断）都被记为结果未知。用户要先"标记为失败"，真实原因随之被替换，之后才能重试。计划 A4 要求超时、连接错误可以直接重试，附录 B 也写了"模型请求失败：重试 ／ 检查 Mio 的模型连接"；harness 计划里的结果未知只指"请求可能已经发出，但结果没落库"。

修复（未改协议、存储或 schema，仍为 56／57）：

- `packages/business/src/agent/task-runtime-v2.ts`：记录正在进行的模型步骤。若失败来自这次模型交换本身，并且是运行中观察到的，就把该步骤记为 failed，保留原错误码和原因，可以直接重试。适用的错误码：`AGENT_CHAT_CONNECT_FAILED`、`TIMEOUT`、`HTTP_ERROR`、`PROTOCOL_ERROR`、`TRUNCATED`、`PROVIDER_ERROR`、`LIMIT`、`TOOLS_UNSUPPORTED`、`REASONING_UNSUPPORTED`。模型步骤完成之前不会执行任何工具，所以项目不受影响。以下情况仍为 unknown：进程在请求途中退出、存储故障、未归类的异常、明确的未知结果，以及所有工具步骤。不自动重发、重试须由用户明确发起的规则不变。
- 整体撤销确认框：保留项中"之后被修改过"一项的说明改为新文案 `agent.panel.modifiedAfterKept`（"之后又被你修改过"），四语同步；变化行文案不变。
- 测试 `tests/agent-task-runtime-v2.test.ts`：
  - 原有 3 条（HTTP 401、伪造错误字段、HTTP 400）的状态预期改为 failed，不自动重发和不泄露原始内容的断言保留；
  - 新增 429／500 失败后可直接重试，超时前的部分文本保留但不进入重试请求，未归类异常仍为 unknown 且重试被拒；
  - 重试门禁里的 unknown 场景改用未归类异常构造。
- 文档：`docs/AGENT-TASKS-V2.md`、`docs/CLI.md` 按新规则改写，并说明重试会再发一次模型请求，上一次请求可能已经计费。

验证（独立副本：main `2609c57`，含 PR #18、#19，叠加 M5 全部改动，带完整 Git 历史；Node 26.12.0，同一台 Mac）：

| 运行 | 测试 | 通过 | 失败 | 取消 | 跳过 |
| --- | ---: | ---: | ---: | ---: | ---: |
| main `2609c57` | 13,469 | 13,374 | 73 | 0 | 22 |
| M5 修复前 | 13,530 | 13,434 | 73 | 1 | 22 |
| M5 修复后 | 13,537 | 13,442 | 73 | 0 | 22 |

- 失败数包含父级传播。按完整测试名去重后，main 与修复后的失败集合完全相同（各 70 项），没有新增失败。
- 修复前多出的 `tests/http-file-shutdown.test.mjs`（20 秒超时）是两份全量同时运行导致的负载问题；单独重跑 3 次均为 3/3。
- 类型检查 `node scripts/tooling.ts typecheck`、`tsc -p tests/tsconfig.tests.json` 均通过。
- 运行时测试 166 条通过 164 条；剩下 2 条是与 main 相同的模拟媒体链失败。另外 38 个 Mio 相关测试文件 586/586 通过。
- 界面没有新增状态：失败卡片、重试按钮、按错误码的设置入口和组件测试都是原有的，本次没有新增截图。
