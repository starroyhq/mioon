# Mio · M4 冲突与补充说明（A2、A3）

日期：2026-10-22／23（本机 Asia/Taipei）。本阶段仅实施 M4 和用户指定的 M3 遗留，未进入 M5。功能验证与环境阻塞分别记录，不将全量失败报告为通过。

工作树 `/Users/kouzen/.codex/worktrees/mio-m0-preparation/mioon`，分支 `codex/mio-m0-preparation`，开工 HEAD `8da3340ddd8627fc6be46a33eca52cabda6b4ffb`，开工状态干净；冻结 main 对照 `471197b7b21360f3f4d85349d0d8692504e1894b`。没有 commit、push、合入 main、依赖变更、真实模型调用或真实付费生成。

持久证据根 `/Users/kouzen/Library/Caches/mioon-mio-m4-20261022/`。最终完整回归为 `current-fix4`；中断的 current／fix1／fix2 以及已完成但早于最后界面／UTF8清单修正的 fix3 单独保留，不拼接为最终结果。

## 1. 改动与文件

| 分类 | 主要文件 | 完成内容 |
| --- | --- | --- |
| 界面 | `apps/web/src/AgentTaskPanel.tsx`、`agent-tasks-v2.ts`、`agent-task-presentation.ts`、`agent-task-errors.ts`、`AgentConversationHistory.tsx`、`agent-task-v2.css`、`App.tsx` | 真实当前值与 A6 原计划的冲突卡；跳过／停止；独立已跳过行；本轮补充说明、动态提示、单一发送／停止键；失败与丢 ACK 保留草稿、只查原回执；历史单框与状态圆点；恢复57入口。 |
| i18n | `packages/i18n/src/catalogs/mio-panel.ts`、`agent-task-errors.ts` | 简中、繁中、English、日本語同步，Mio 保留拉丁字母；未把原始错误码／工具参数放入面板。模型收到的跳过说明也按本轮四语生成。 |
| 契约 | `packages/contracts/src/agent-tasks-v2.ts`、`workspace-backup.ts`、`workspace-restore.ts`、`workspace-schema-profiles.ts` | note／skip 严格控制契约，Run.notes／skippedTargets 兼容旧读取；正常56、恢复57及固定52／54备份档位。 |
| 业务 | `packages/business/src/agent/task-journal-v2.ts`、`task-runtime-v2.ts`、`task-tools-v2.ts`、`task-display-v2.ts`、`task-schema-v2.ts`、新 `task-interaction-schema-v2.ts` | note与稳定回执同事务、下一模型intent原子绑定；精确冲突目标持久跳过；所有显式引用和worker发送门禁；A6真实展示、名称按类型处理；迟到结果保护与存储异常传播。 |
| 业务与迁移 | 新 `workspace-schema-v56.ts`、`workspace-restore-schema-v57.ts`；schema dispatch、backup／restore／readiness／inventory、project lifecycle和现有领域入口 | 54→56原子迁移、严格字段及引用验证、不可回删约束、备份恢复、计量／项目删除／只读档位接线。相关领域文件只接入56／57，未改变其业务与撤销语义。 |
| 传输 | `apps/server/src/index.ts`、`packages/client/src/agent.ts`、`apps/cli/src/agent.ts` | 复用现有 actions HTTP 路由和共享契约，client／CLI新增note、skip；只属于宿主管理命令，不进入模型／MCP业务工具目录。 |
| 测试 | 新 `agent-task-interactions-schema-v2.test.ts`、`mio-history-metadata.test.mjs`、`helpers/current-schema56-delta.ts`，更新runtime／tools／journal／HTTP／client／CLI／UI／schema／恢复测试 | 精确跳过、note时机／5条上限／幂等／写库失败／重启、后台发送与迟到选择、52／54／56备份恢复及反例。旧固定格式及哈希不放宽。 |
| 文档 | `docs/CLI.md`、`docs/AGENT-TASKS-V2.md`、本报告 | 新命令、冲突普通resume的拒绝边界、note绑定时机、版本与兼容说明。 |

共102个改动／新增文件：界面7、i18n 2、契约4、业务23、传输3、测试60、文档3。完整分类文件列表及 SHA 见文末的文件清单链接；所有文件均在本阶段授权范围内。已有 M0–M3 报告、用户待办、设计输入、package.json 和锁文件单独核对保护。

A2：跳过只写实际冲突目标、来源步骤和时间；无关目标不进入名单，停止不写名单，不生成 Change／Undo，也不释放用户草稿占用。当前 Run 以后显式涉及跳过目标的工具返回 denied／TARGET_SKIPPED；包括只读显式引用在读取目标前检查，已删除目标也不能绕开。项目整体观察仍可用，其他目标可重新规划，新 Run 从空名单开始。旧参数和审批作废，不重提旧生成。已发工作可以保存结果，但无权自动覆盖已跳过目标的用户选择。

A3：运行中、等待确认、普通暂停都可 note，单条同 send 的32KiB UTF-8，最多5条未绑定说明。稳定 requestId／版本／原文共同约束回执；响应丢失只查询。说明在新的模型intent事务内首次绑定，不改已保存或已发送的body；最后回复期间到达的说明在同一预算内续一个新模型步骤，到限保留排队说明。未知结果仍先处置，不能借note重发。结束后的输入使用同一对话的新一轮send。

M3遗留：字幕“A/B 对比：雨后的城市”、镜头“左/右机位”保持原文；片段“clips/a.mp4”只显示a.mp4，服务端与前端均有测试。只有媒体文件名取basename。历史搜索聚焦时也只有外层边框／焦点环；条目为“时间 · ● 状态 · N处变化”，0项不显示变化数。

## 2. 设计对照与截图

只读导出07-03（SIrbS）、07-04（ibtup）、组件区（pIAuS）、历史（lCVcD）和运行参考（CgJlu）到 `evidence/design/`；未把加密.pen当文本读取。设计与计划输入指纹见初始／最终保护回执。

最终UI与真实功能证据全部来自新的 `current-fix4` 编译产物，不再以旧fix2／fix3截图代表最终卡片。实际HTTP响应字节与dist一致：JS `index-CZwm7hCz.js`（SHA256 `164df33e839e6a2b15b0207f304c3e9d580f2999ceed37fe2c2969ecefea266c`）、CSS `index-Cv8eNbPm.css`（`0b5d577591851b8fa67286faf5396e5d47a9b8da0423164b9324176d187ee940`）。来源、全列表和检查范围见 `evidence/browser-fix4/{README.md,build-manifest.json,served-assets.json,screenshots.json,ui-browser-summary.json}`。

最终原图62张：以下50张主矩阵、4张英文焦点图，加四语各一张1050冲突顶部和已跳过底部补图，共8张。8张派生contact sheet另计。最终headless真实CLI六条命令全exit0；四语及CLI各3次合成响应，总15次，真实模型／外部／付费请求为0。每组note进入下一模型intent，后续同目标拒绝，其他目标只产生1条Change。自建服务、浏览器和私有数据／凭据已清理，未触碰桌面进程。

50张主矩阵图：四语 × 两尺寸 × 运行补充说明／冲突／已跳过／历史／变化上段／变化下段，共48张，另深色冲突、已跳过2张；再加English × 浅／深色 × 两尺寸的聚焦历史框4张。外层面板320px、实际内宽318px。已采集视图的横向边界与scrollWidth检查未检测到横向溢出；没有把该量测称作完整纵向裁切检测。最小5.252:1只覆盖脚本纳入的非禁用文字，不包括禁用控件和图标。字号／点击区检查也限于量测样本；完整范围见最终browser摘要。

代表截图（均为最终编译产物、持久路径）：

- [07-03简中冲突暂停](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/matrix/zh-Hans-1050-conflict.png>)
- [07-04日文已跳过完整值](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/details/ja-1050-skipped-bottom.png>)
- [07-04繁中已跳过完整值](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/details/zh-Hant-1050-skipped-bottom.png>)
- [繁中运行补充说明](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/matrix/zh-Hant-1050-running-note.png>)
- [英文历史](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/matrix/en-1050-history.png>)
- [英文浅色历史聚焦](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/focused/final-light-1050-history-focus.png>)
- [英文深色历史聚焦](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/focused/final-dark-1050-history-focus.png>)
- [英文变化行下段](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/matrix/en-1050-changes-bottom.png>)
- [日文变化行](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/matrix/ja-1050-changes.png>)
- [深色简中冲突](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/dark/zh-Hans-1050-conflict.png>)
- [深色英文已跳过](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/dark/en-1050-skipped.png>)

沿用现有组件和token。合成项目在画布中用镜头时长（当前5秒、原计划4秒）和四语长描述制造真实冲突，设计示例为剪辑页的片段音量；外围工作区与fixture内容不同。冲突卡已改为07-03的目标／你的修改／Mio原计划三行双列对照块，说明置后，按钮最后；缺值不猜。标题和按钮样式沿用M2现有组件，与设计示例的图标／主按钮填充细节并非逐像素相同；本轮聚焦冲突信息结构和新交互，不重排其他区域。已跳过行的当前值在读取时取得，不冒充跳过时快照。输入在unknown／interrupted时仍先要求明确恢复处置，符合既有保护；普通paused支持note。没有提前做M5重试或整体撤销跳过。

浏览器流程经生产HTTP／runtime和真实本地域事务，模型响应仅由本地合成网关注入；历史日期是明确的视觉fixture。最终真实浏览器发送note覆盖running，等待确认／普通暂停发送note及unknown／interrupted入口由定向测试覆盖，不冒充本轮浏览器覆盖。未声称实际输入法硬件、真实生成worker远端行为或三系统原生验收。迟到选择竞态使用真实Mock受理／binding加本地gate hook定向验证，不能冒充真实付费worker端到端证据。

## 3. 验证与基线对比

同机Darwin arm64，Node24.19.0、pnpm11.25.0，TMPDIR=/private/tmp。隔离副本冻结安装，无清空原node_modules；带完整Git历史，包括4355c07。实际命令及进程、源指纹、原始TAP／NDJSON保留。

```sh
rsync -a --exclude node_modules --exclude .git \
  --exclude apps/desktop/build --exclude apps/web/dist <worktree>/ <copy>/
CI=true pnpm install --frozen-lockfile
node scripts/tooling.ts build --channel=development
node node_modules/typescript/bin/tsc -p tests/tsconfig.tests.json
node --test --test-concurrency=2 --test-timeout=600000 \
  --test-reporter=tap --test-reporter-destination=stdout \
  --test-reporter=<evidence>/full-test-events-reporter.mjs \
  --test-reporter-destination=<phase>.events.ndjson \
  "tests/*.test.mjs" "tests/*.test.ts"
```

实际使用的可执行文件是 `/Users/kouzen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`，pnpm由它执行 `/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs install --frozen-lockfile`（CI=true）。为保留完整历史，先在owned副本执行 `git clone --no-checkout --no-hardlinks`，只在副本设置固定引用／read-tree，再rsync工作树。完整argv、cwd、起止时间、退出码和历史对象核验见[复制及冻结安装](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/bootstrap-fix4-results.json>)、[构建与测试类型检查](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/current-fix4-build-results.json>)；上面的占位路径仅为命令结构说明，不替代这些实际记录。原仓库与当前工作树没有执行Git写操作。

最终fix4 development build、生产严格类型检查、tests tsc均退出0。Web与desktop main／backend／preload已构建；既有Vite use-client／chunk等提示原样保留，不声称无警告。

定向验证：M3遗留36/36；最后布局修正之前的UI相关6文件142/142；最后冲突卡布局新增四语断言，组件25/25、presentation20/20、history1/1及tests tsc通过；存储40文件913/913（包含新schema22、对话10、journal24、LUT4；不与全量计数相加）；迟到选择新增7/7，同一测试换回旧实现2过5失败，修复后tools58/58、tests tsc0。UTF8测试清单遗漏修前3/4、修后4/4，登记从2个listener补为4个，连续解码断言未放宽。补充说明在异步回放尾部漏续请求的精确回归也保留修前失败／修后通过证据。HTTP／client／CLI、双协议往返和安全收口的最终实际数量见下列完整轮次提取，不拼接旧子集。

全量命令两次都实际退出1，按完整用例身份（文件、完整父子名称、同名出现序号）对照，未按行号猜配：

| 完整轮次 | 文件 | 总用例 | 通过 | Node失败 | 跳过 | 可操作失败／父级传播 | 墙钟耗时 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 冻结main 471197b | 839/839 | 13049 | 12959 | 68 | 22 | 65／3 | 2390.660秒 |
| 最终工作树 current-fix4 | 849/849 | 13360 | 13268 | 70 | 22 | 67／3 | 3905.417秒 |

两轮均无缺失文件、运行中源码漂移、解析歧义或取消用例。65项可操作失败两边共有，2项只在本分支，0项只在基线。最后轮次来源指纹为 `423248a2fe3ccb21c6fab749ebee8c911c165b9e60877b063b79ae8f3cbff315`。精确命令、cwd、清理前副本与完整Git历史核验见[最终全量进程记录](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/current-fix4-full-state.json>)、[基线全量摘要](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/baseline-full-summary.json>)、[最终全量摘要](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/current-fix4-full-summary.json>)、[逐项对照](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/current-fix4-vs-baseline-comparison.json>)。

acceptance README指定的8个安全收口文件直接从同一最终完整轮次提取：228项，226通过、2项两边共有失败、0新增失败；其中双协议6类通用崩溃窗口共12项通过。失败未到达的whole-undo／迟到产物媒体完成断言仍不算通过。提取没有再拼接其他轮次，详见[安全收口](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/safety-regression-final.json>)。

修正前fix3也曾完整跑完（13359项、13266通过、71失败、22跳过）；当时独有失败为两项Look加UTF8流读取清单遗漏。修正后重新跑完整fix4，清单用例4/4通过，未以局部重跑替代完整结果。

只列本分支独有的失败（两项均参数化定义于 `tests/look-pack-portability.test.ts:18`，实际断言为 `:54`）：

| 完整用例名称 | 来源／当前结果 |
| --- | --- |
| `project-owned Look survives removed source file, cold reopen, render and ordinary54/restored55 backup` | 继承M3的新增档位，冻结main没有此用例。首个普通渲染返回MEDIA_EXIT_FAILED，未进入第70行备份和71行恢复。 |
| `project-owned Look survives removed source file, cold reopen, render and ordinary56/restored57 backup` | 本次M4新增档位。同一首渲染断言返回MEDIA_EXIT_FAILED，备份／恢复媒体链路未到达。 |

原有52→53的同系列用例两边同样失败。本机zscale缺失、生产SDR渲染链依赖zscale且独立最小探针失败，是强环境候选；本轮失败子进程stderr未被该测试捕获，不能将其断言成唯一已确认根因。两项保留为未通过。独立的严格schema／LUT备份冷恢复52→53、54→55、56→57已经通过，不能替代这两项完整媒体链路。

环境：实际FFmpeg为 `/opt/homebrew/Cellar/ffmpeg/9.0.2_1/bin/ffmpeg`（Homebrew 9.0.2_1），缺drawtext、subtitles、zscale和libwebp；未更换安装或新加依赖。最终重采7组Node／pnpm／FFmpeg／tar／最小探针的stdout及退出码与开测时逐项一致，见[最终工具链复核](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/final-toolchain-check.json>)。

共有65项失败的审计中，22项有错误正文直接证实环境限制（19项drawtext、1项GNU tar格式、2项Node固定版本断言预期24.21而本机24.19）；其余43项是带限定的静态／前序失败推断，包含媒体处理、libwebp配方和级联断言，未伪装为已确认根因。两个runtime用例未保存精确job.error／失败子进程参数，单独保留未知限制。7项共有错误正文发生变化，逐项人工复核仍是相同Mock drawtext阻断；随机引用、progress、nextPollAt、根目录及堆栈行号的差异全部保留并标注，不只做字符串归一化便宣称相同。

最终审计 `manualChangedMessageReviewPending=false`、未知新增错误和未分类共有错误均为空。它表示审计完成，并不表示上述测试通过。见[最终失败审计](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/failure-audit-current-fix4.md>)、[逐项原错及复核](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/failure-audit-current-fix4.json>)、[基线失败证据与推断界限](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/baseline-failure-audit.json>)。

独立相互复审：runtime／storage及UI只读复审最终no finding。复审曾发现并修复wait局部变量误引用、失效工具批的TARGET_SKIPPED丢失、skip来源排序过严、note异步尾部旧快照、历史聚焦双框、冲突卡布局偏离和UTF8测试helper清单遗漏，以及迟到选择把已处理skip／授权／存储错误伪装为新冲突。精确7条迟到回归旧版5失败、当前7/7；已处理skip／deny不再重复暂停，真实冲突保留来源，授权保留原原因，存储和未知异常向上传递。没有吞异常或削弱保护来通过测试。

## 4. 兼容性

- 普通库54升级56，恢复格式55保留，新56备份恢复57（restored-local-v17）。52→53、54→55、56→57均按各自精确固定格式处理；52／53／54／55源文件指纹原样不变。
- 旧v2 Run读取可缺notes／skippedTargets，普通迁移只补空数组并安装精确约束，不重写context、事件、请求digest、回执、原版本或时间。新56／57必须包含数组，校验引用、唯一性、最多5条排队及不可回删／改绑。v1保持只读。
- note／skip只扩展已有宿主actions；旧暂停／预算继续语义保留。冲突状态的旧resume现在明确拒绝AGENT_TASK_SKIP_REQUIRED，这是A2的有意行为变化，调用方须使用skip或stop。新公开Run含数组，使用旧严格解析器的独立client／CLI需同步升级；不承诺旧二进制能接受新增字段。
- 已保存设置、密钥格式、project_agent授权、审批精确绑定、默认付费确认、费用证据、网关与网络策略不变；skip／note不扩大权限。先落库、发送前／执行前复查、结果未知不自动重发与用户修改保护保留。
- 其余领域文件只接线56／57；原撤销补偿语义、模型／MCP业务目录及CLI其他命令未扩张。

## 5. 未完成与阶段边界

- M4实现已完成，独立复审no finding；必要验证保留以下环境／覆盖缺口，不将其当作验收通过。全量两条独有Look媒体链路仍待具备相应FFmpeg能力的环境复验；冻结main共有的媒体失败及两个runtime的精确根因也未全部捕获。若后续更换工具链，仍需同机同环境重新对照，不能删除断言或靠改测试跳过。
- note／skip持久化重启测试使用正常runtime关闭后重建；通用双协议SIGKILL窗口已回归，但尚未新增note／skip专用OS强杀窗口。说明在intent已保存与实际发送之间到达的极窄窗口没有单独注入；已验证派发后到达的说明不改已保存body并进入下一请求。相关边界与实际证据见[覆盖清单](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/runtime-evidence/M4-COVERAGE.md>)。
- 最终浏览器note发送覆盖运行中；等待确认／暂停等状态由定向测试覆盖。未新增原生IME／多窗口或真实生成worker端到端验收；全部模型响应来自合成网关，未调用真实模型或付费生成。这些不是用真实调用补测的授权。
- 本阶段没有待决定的公共API／CLI实现选择。下一阶段如扩展重试，须保留本Run的跳过名单、note绑定、旧参数／审批失效、幂等回执和未知结果处置边界；不复用旧请求来重提交生成。
- 本次8份owned验证副本已删除，截图、原始日志、SHA清单和仅包含改动源码的归档留在持久缓存。已有工作树、原node_modules、用户待办、密钥和桌面进程保持不动。

阶段停在M4，不进入M5。后续只有用户确认后才实施失败重试或其他阶段。已有工作与设计输入保护、Git最终状态、源码归档及owned-copy删除回执见证据索引；截图／日志／源归档保留，原工作树与node_modules、用户数据和持有真实Key的桌面进程不清理。


## 证据索引

- [全部文件分类、SHA与新增标记](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/m4-change-inventory.json>)；[最终源码与完整回归一致性](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/canonical-vs-final-full.json>)。
- [完整回归逐项比较](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/current-fix4-vs-baseline-comparison.json>)；[安全收口](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/safety-regression-final.json>)；[最终失败审计](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/failure-audit-current-fix4.md>)。
- [最终浏览器证据说明](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/README.md>)；[62张原图与派生图清单](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/screenshots.json>)；[浏览器量测范围](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/ui-browser-summary.json>)；[CLI真实路径记录](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/cli-controls.json>)；[自建服务清理](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/browser-fix4/cleanup.json>)。
- [存储定向验证](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/storage-verify/evidence/STORAGE-SUMMARY.md>)；[覆盖范围与限制](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/runtime-evidence/M4-COVERAGE.md>)；[UTF8清单修正前后](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/runtime-evidence/UTF8-INVENTORY-REPAIR.md>)。
- [最终11项受保护输入核对](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/protected-final-check.json>)；[最终Git状态](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/final-git-state.json>)；[8份验证副本清理回执](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/owned-copy-cleanup.json>)。
- [M4改动源码归档](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/m4-source.tar.gz>)；[归档SHA与文件列表](</Users/kouzen/Library/Caches/mioon-mio-m4-20261022/evidence/source-archive-manifest.json>)。归档仅含改动源码、新文件、报告、patch与清单，不含Git历史、依赖、数据目录或凭据。
