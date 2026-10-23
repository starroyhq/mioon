# Mio · M3 对话与历史（A1）

日期：2026-10-22。M3 实现、完整回归对比与本机可执行验证已收口；媒体能力阻塞单独保留，不计为通过。

工作树 `/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon`，分支 `codex/mio-m0-preparation`，M3 开工 HEAD `4355c0746821dad76622b9fdaaed72400bdc5a92`。冻结 main 对比点为 `ab65771998936e5e0bb1e2465e40ecefff233e91`。只做 M3 与用户指定的 M2 变化文案遗留，没有实施 M4。没有 commit、push、合入其他提交、变更依赖、调用真实模型或付费生成。

持久证据根：`/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/`。最终前端为第五次构建；中断的 current 全量和第三次构建截图单独保留，不用于最终通过结论。

## 1. 本阶段改动

| 分类 | 文件 | 结果 |
| --- | --- | --- |
| 界面 | [apps/web/src/AgentTaskPanel.tsx](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/AgentTaskPanel.tsx)、[AgentWorkspace.tsx](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/AgentWorkspace.tsx)、[App.tsx](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/App.tsx) | 同一对话分轮展示；标题、新对话、历史、设置；传递当前时间线 fps；恢复副本入口明确允许原 53 与新增 55。 |
| 界面 | 新 [AgentConversationHistory.tsx](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/AgentConversationHistory.tsx)、[agent-conversations.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/agent-conversations.ts)，重写 [AgentLegacyHistory.tsx](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/AgentLegacyHistory.tsx) | 历史浮层只覆盖消息区；本地标题搜索、今天／昨天／更早、滚底分页、当前标记；旧 v1 独立 DTO 只读展示，不迁移、不提供旧批准或发送。 |
| 界面与生命周期 | `agent-tasks-v2.ts`、[native-close-sources.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/native-close-sources.ts)、[agent-task-v2.css](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/agent-task-v2.css) | 按对话保存草稿和附件，审批与授权确认绑定对话；分页读取完整轮次；取消选择、迟到响应、旧输入回调、IME 保护；隐藏的草稿、未知结果及已观察的后台等待仍参与保护。 |
| 变化文案 | [agent-task-presentation.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/web/src/agent-task-presentation.ts) | 当前 fps 换算秒并保留一位；无 fps 回退帧；dB 一位、静音本地化；省略可推导出点；正文两属性加“等 N 项”，详情保留完整可展示列表；新增与空前值使用动作句式。 |
| i18n | [packages/i18n/src/catalogs/mio-panel.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/i18n/src/catalogs/mio-panel.ts)、新 [mio-conversations.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/i18n/src/catalogs/mio-conversations.ts)、`index.ts` | 简中、繁中、English、日本語同步；项目原文不随界面语言改写；Mio 保留拉丁字母。 |
| 契约 | [packages/contracts/src/agent-tasks-v2.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/contracts/src/agent-tasks-v2.ts)、`workspace-backup.ts`、`workspace-restore.ts`、[workspace-schema-profiles.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/contracts/src/workspace-schema-profiles.ts) | send 可选 conversationId，新增对话摘要／成员页契约；严格列举 54 普通库、55 恢复格式及受支持的备份角色。 |
| 业务 | [packages/business/src/agent/task-journal-v2.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/business/src/agent/task-journal-v2.ts)、[task-runtime-v2.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/business/src/agent/task-runtime-v2.ts)、[task-schema-v2.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/business/src/agent/task-schema-v2.ts)，新 [task-conversation-schema-v2.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/business/src/agent/task-conversation-schema-v2.ts) | 宿主事务分配身份，跨项目／不存在 ID 拒绝；上下文只取同对话最近四轮完成记录；按对话聚合历史；诊断在 SQL LIMIT 前排除且保留审计查询。 |
| 业务与 schema 接入 | 新 [workspace-schema-v54.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/business/src/workspace-schema-v54.ts)、[workspace-restore-schema-v55.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/business/src/workspace-restore-schema-v55.ts)，schema dispatch／backup／restore／readiness／inventory，项目删除和相关业务入口 | 独立迁移、精确 catalog／行验证、备份恢复与只读门禁；其余业务文件只把已有普通／恢复档位接入新版本，不改变其领域操作或撤销语义。具体 21 个业务文件见交接索引。 |
| 传输 | [apps/server/src/agent-task-http-v2.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/server/src/agent-task-http-v2.ts)、`index.ts`、[packages/client/src/agent.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/packages/client/src/agent.ts)、[apps/cli/src/agent.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/apps/cli/src/agent.ts) | HTTP、client、CLI 共用契约，新增会话成员 GET 和 `agent task conversation`；管理能力不进入模型／MCP 目录。 |
| 测试 | 新 [agent-task-conversations-v2.test.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/tests/agent-task-conversations-v2.test.ts)、[mio-conversations-ui.test.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/tests/mio-conversations-ui.test.ts)、[mio-conversation-history.test.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/tests/mio-conversation-history.test.ts)、[helpers/current-schema54-delta.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/tests/helpers/current-schema54-delta.ts)；更新运行、传输、界面、恢复、相邻版本用例 | 分组、上下文、重放、52／54 备份恢复、诊断、分页、时钟倒退与切换保护；只修当前版本断言，旧固定格式 pin 与夹具不放行。 |
| 文档 | [docs/AGENT-TASKS-V2.md](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/docs/AGENT-TASKS-V2.md)、[docs/CLI.md](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/docs/CLI.md)、最终 M3 报告 | 对话参数、成员命令、版本与独立调用方兼容边界。 |

完整分类文件列表见 [evidence/m3-changed-files.json](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/m3-changed-files.json)（含本报告共 100 文件）及 [evidence/m3-backend-handoff.json](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/m3-backend-handoff.json)。已有 M0／M1／M2 报告、计划、锁文件和用户未跟踪待办保持原样；设计稿在全量运行期间有外部保存，相关四张导出逐字节不变，见下文。

## 2. 与设计和计划的对照

重新只读导出：07 空对话 `xNIhU`、08 对话历史 `lCVcD`、04 变化参考 `ibtup`、组件区 `pIAuS`，均在 [evidence/design/](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/design)；`.pen` 未作为文本读取，本阶段未改写设计稿。

08:29 与 09:00 UTC 观察到设计稿外部保存，密文指纹从 `791e5623…e10e0` 经 `b86b1197…2c7` 变为 `eb30cb8b…54ba8`。两次都用计划原命令只读重导出四个节点，见 [第一次导出](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/design-after-external-save/receipt.json) 和 [最新导出](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/design-after-external-save-2/receipt.json)：两轮四张 PNG 都与开工导出逐字节相同，导出前后输入指纹不变。计划及其他保护文件未变，因此本阶段设计对照仍有效；不覆盖外部保存。

最终浏览器使用第五构建 `index-5ZIUj56A.js`，SHA256 `16264ebd45fc148d3a203ee7eb89bde3b1da453e690ed1871bc7fa5db0ed79d3`；CSS `index-Dyqv9TWN.css`，SHA256 `914bfa0403ebe35ed86606984e6e6458be7be53ba7eb613e9b279f24deee7c76`。每张截图核对实际加载资产与源码指纹。

44 张最终 PNG：四语 × 1440×900／1050×680 × 历史／变化上段／变化下段／完整详情／新对话，共 40 张；深色历史与中断抽查 2 张；历史滚底 v1 条目及 v1 只读内容 2 张。浅色为主，外层 dock 320px、扣除边框后的内容 318px。44 次可见 DOM 检查未发现内部字段／原始状态、原生文件输入／授权勾选、溢出、正文小于 10px、可操作按钮小于 24px或正文低对比；最小实测文字对比 5.252:1。标题按设计允许单行省略；项目里的中文原文在英文／日文界面保持原样。

代表证据均在 [evidence/browser/](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser)：

- [matrix/zh-Hans-1050-history.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/matrix/zh-Hans-1050-history.png)、[matrix/zh-Hant-1440-history.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/matrix/zh-Hant-1440-history.png)：分组、当前标记、固定输入区。
- [matrix/en-1050-changes.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/matrix/en-1050-changes.png)、[matrix/ja-1050-changes-bottom.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/matrix/ja-1050-changes-bottom.png)：320px 外框中的双属性、秒、添加／设置文案。
- [matrix/en-1050-change-details.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/matrix/en-1050-change-details.png)：正文省略属性的完整详情。
- [matrix/zh-Hans-1440-new-conversation.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/matrix/zh-Hans-1440-new-conversation.png)：07 空对话。
- [dark/zh-Hans-1440-history.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/dark/zh-Hans-1440-history.png)：深色历史抽查。
- [focused/en-1050-history-older-v1.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/focused/en-1050-history-older-v1.png)、[focused/en-1050-v1-read-only.png](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/browser/focused/en-1050-v1-read-only.png)：加载更早及 v1 只读。

浮层沿用共享 Input／Button／tooltip 和现有颜色、间距、字号 token；保留一个可见关闭入口和可键盘操作的“加载更早”按钮作为滚底自动加载的补充。新对话沿用现有加号图标；当前对话标记使用独立一行文字，比设计选中行更占高度，换取沿用现有组件时的明确标记。独立目视复核另逐张查看英文／日文 1050 的十张最终图和三张设计参考，未发现可操作缺陷（visual-independent-review.md）。fixture 的素材、用户内容和日期与设计示例不同，画布其他区域沿用已验收的现有实现；没有借此进入后续阶段的视觉改造。

## 3. 实际验证与完整对比

同一台 Darwin arm64；Node 24.19.0、pnpm 11.25.0，`TMPDIR=/private/tmp`。不清理原 node_modules，复制仓库排除 node_modules／.git／构建目录，在隔离副本 `CI=true pnpm install --frozen-lockfile`。副本补齐独立完整 Git 历史，用同一工具与环境跑 baseline／current-fix1／current-fix2，整轮严格顺序；安装和源码 SHA 都有回执。

最终第五轮命令：

```sh
node scripts/tooling.ts build --channel=development
node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json
```

两者退出 0。build 内部先执行生产严格类型检查，再构建 Web 与 desktop main／backend／preload。既有 Vite use-client／sourcemap 与 chunk 提示仍保留，不隐藏为无警告构建。

定向验证均每文件独立进程、600 秒超时：

- schema／兼容最终 8 文件 166/166；52 备份→53、新 54 备份→55，原52字段越界拒绝及 strict catalog 反例。
- >100 诊断记录不挤掉普通对话的专门用例 1/1；未发模型请求。
- 第五轮前端、会话与 i18n 100/100，其中新会话保护 23/23；相邻 UI 源码／恢复／手动协作 224/224。
- acceptance README 的收口 8 文件均在完整轮次内执行；最终提取 205 项：203 pass、2 fail；两项失败都与基线相同，发生于 Mock 媒体前置，未到达的后续断言不算通过。其余 7 文件全通过；这 8 文件没有当前独有失败，见 safety-regression-final.json。
- 变化文案 20/20；先前 HTTP／client／CLI 定向结果及修复历史独立保留，完整轮次不拼接子集。
- 同一个合成 headless 服务：实际 HTTP 与源码 CLI 各读取 history／conversation，两个命令退出 0，返回值 deepEqual。命令与输入／结果见 `browser/http-cli-consistency.json`。
- 实际浏览器：50→59 分页、只过滤已加载标题、v1 只读、A／B 草稿附件隔离、新对话无 POST、运行／中断禁新建、切换失败保留草稿、合成 IME 事件禁切换、丢 ACK 后恰好一个 POST 并查询原回执、跨项目无旧历史缓存。合成网关调用 1 次，真实模型／外部请求／付费请求全部 0。变化记录来自实际本地域事务；为检查视觉状态而使用的历史日期、运行中／中断状态属于明确标记的 fixture 注入，不将这些截图当作真实崩溃或远端取消证据。

上述完整轮次均使用：

```sh
node --test --test-concurrency=2 --test-timeout=600000 \
  --test-reporter=tap --test-reporter-destination=stdout \
  --test-reporter=<证据根>/evidence/full-test-events-reporter.mjs \
  --test-reporter-destination=<对应轮次>.events.ndjson \
  "tests/*.test.mjs" "tests/*.test.ts"
```

冻结 main：830/830 文件，13015 tests、12925 pass、68 Node fail（65 个实际失败，另 3 个父级传播）、22 skip、0 cancel、exit1，2397.017 秒。

首轮完整 current-fix1：838/838 文件，13250 tests、13159 pass、69 fail（66 实际、3 父级传播）、22 skip。唯一当前独有错误为 [lut-resources-backup.test.ts](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/tests/lut-resources-backup.test.ts) 的 restore53 用例：current openStore 已是54却仍断言52。现已保留真实52→53并扩展54→55，定向3/3；同类被媒体错误遮蔽的 look-pack 用例也保留两档覆盖。

最终完整 current-fix2：838/838 文件，13252 tests、13161 pass、69 Node fail（66 个实际失败，另 3 个父级传播）、22 skip、0 cancel、exit1，2688.796 秒。与基线共同失败 65 项、当前独有 1 项、基线独有 0 项。所有文件均有证据，源码漂移 0、解析歧义 0；7 条共同错误的文字差异已逐项核对为同一媒体／Mock 原因或合成 ID、时序差异，原始错误均保留。

只列最终当前独有失败：

| 用例 | 实际结果与边界 |
| --- | --- |
| [tests/look-pack-portability.test.ts:53](/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon/tests/look-pack-portability.test.ts:53) · `project-owned Look survives removed source file, cold reopen, render and ordinary54/restored55 backup` | 新增 54→55 用例在首次普通渲染得到 `MEDIA_EXIT_FAILED`。同机相同色彩转换探针报 `No such filter: zscale`；源码在编码前强制执行此转换。失败发生在备份／恢复之前，所以这条完整媒体链仍未验证通过。原 52→53 用例在冻结 main 和当前均同样失败。 |

原始 TAP、stderr、NDJSON、每文件证据、源指纹、完整用例 identity 和比较 JSON 都保留；最终差集见 [evidence/current-fix2-vs-baseline-comparison.json](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/current-fix2-vs-baseline-comparison.json)，环境因果见 [evidence/failure-audit-current-fix2.json](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/failure-audit-current-fix2.json)。首次 current 因独立 review 发现真实 owner 生命周期问题而主动中断，`current-full-abort.json` 明确不计最终轮次；没有拼接通过片段。

review 修复：选择 v1 曾卸载独立草稿恢复 owner，清除未知恢复回执的 native-close fence；现在只隐藏内容、保留 owner。精确新用例在修前源码 0/1、修后 1/1，另外实际 owner 用例验证隐藏期间仍 blocked，返回后只查询原回执。另保留隐藏对话的 unknown／backgroundPending 门禁。最终静态独立复查 no finding，实际浏览器和完整测试另行提供证据，不互相替代。

共同失败仍不算通过：65 项里，23 项的原错误直接支持环境原因，37 项结合同机探针和源码执行顺序定位到媒体能力问题，另 5 项为前序 Mock 失败造成共享 fixture 缺失的级联断言。保留原错误与推断依据，未到达的后续媒体断言不能据此视为通过。具体工具限制：Homebrew FFmpeg 9.0.2（9.0.2_1）缺 drawtext／subtitles、zscale／libwebp；系统 BSD tar 不支持旧测试要求的 GNU 写入格式；两个冻结夹具硬要求 Node24.21.0，现为24.19.0。最终逐项证据在 failure audit 中；没有更换冻结工具、放宽断言或升级依赖来隐藏错误。

## 4. 兼容性

- 普通库 52 在独立事务中迁移为 54；恢复格式 53 已被旧52占用，新54备份恢复为55（restored-local-v16）。52 备份仍按原固定格式恢复为53，固定50仍对应51，不复用版本号。
- 缺 conversationId 的旧 v2 每条分别成为 run.id 对应的单轮对话。旧 Run.context 与不可变事件、原请求 digest、回执不重写；若恢复已经持久化的旧执行，仍保留它当时的 context 证据，新发送严格取同对话上下文。v1 不迁移且只读。
- 旧 send 调用方不传 conversationId 仍可调用，每次开始独立新对话，不再隐式混入项目其他对话。续发必须带服务端返回的 ID；未知／其他项目／仅诊断 ID 均 fail closed。请求 ID 同时绑定是否携带对话 ID 及原值，丢响应只查询原回执。
- v2 history 响应从 runs 改为 conversations；独立严格解析器须同步更新。新增只读成员接口与 CLI conversation 命令；每轮快照、控制回执、旧 v1 接口和 MCP 业务目录保持原边界。
- 设置、密钥保存格式、授权范围、默认付费确认、费用证据、网关与网络策略均未改变。对话身份不扩大执行权限。
- 39 个旧固定源码／夹具相对 M2 HEAD 与冻结 main 均字节相同。测试中的新54独立SQL／有限逆账本须先精确验证新增定义和行身份，再还原原52 pin；没有修改旧 hash 放行。

## 5. 未完成、环境限制与下一阶段

本阶段功能已实施并停在 M3。环境媒体与冻结 Node／tar 限制独立保留，不能报告全量或媒体全绿；新增 Look 54→55 的后半段需要具备 zscale 等必要能力的 FFmpeg 环境后再验证。纯 LUT 52→53、54→55 备份恢复与严格 schema 验证已通过，不能替代该媒体链的未完成部分。浏览器 IME 使用合成 composition 事件；没有声称完成实体输入法或三系统原生运行验收。

同一对话的新轮次 createdAt 取当前墙钟与已有创建／更新时间最大值 +1ms 中的较大值；每个 Run.updatedAt 不早于自身 createdAt 或原 updatedAt。不同对话之间仍使用墙钟。时钟倒退时总耗时可能暂为0秒，Step／生成／费用证据时间与字段不变。已观察的后台等待须有持久快照确认完成才释放新对话／发送门禁。

下一阶段仍是用户确认后的 M4：A2 跳过、A3 补充说明尚未实施；失败重试、整体撤销跳过、设置重排和修改标记也未提前实施。M4 后续 schema 应在当前54／55基础上按实际已占用版本选择，继续保留52备份恢复。

收尾记录：只读观察时间 2026-10-22T09:05:02.686658+00:00，远端 origin/main、本地 main 和缓存 origin/main 仍为冻结 `ab65771`，没有新增合并或重叠文件；未 fetch 或合入提交。工作树 HEAD 仍为 `4355c07`。其他九个保护文件指纹不变，设计稿外部保存及四张一致导出单独记录。

最终源码与复现夹具归档到 [evidence/m3-source-and-reproduction.tar.gz](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/m3-source-and-reproduction.tar.gz)，SHA 与文件清单见 [evidence/source-archive-manifest.json](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/source-archive-manifest.json)；tracked patch 另存，新增文件以归档为准。五个本阶段 owned 验证副本的删除回执为 [evidence/owned-copy-cleanup.json](/Users/kouzen/Library/Caches/mioon-mio-m3-20261022/evidence/owned-copy-cleanup.json)。日志、截图、设计导出、源归档均保留在上述持久目录，原仓库、工作树、原 node_modules、用户文件不清理。最终浏览器服务与本次 Playwright 会话已关闭，桌面真实进程未触碰。

本阶段没有需要扩大授权的实现选择。请先验收 M3；未经确认不进入 M4。
