# Mio harness H4b · 要求与补做的界面

日期：2026-10-29–30（Asia/Taipei）。分支 `codex/mio-harness-h4b`，独立 managed worktree `~/.codex/worktrees/mio-harness-h4b/mioon`。从 main `0094b5b7f5711da29b555ceb7f84ad62a1ab367c`（已含 H4a，PR #85）创建，开工时工作树干净。设计资料仅从主 checkout 的 `designs/` 读取，没有复制进分支或修改设计稿。

实施依据是 `MIO-HARNESS-PARALLEL-PROMPTS.md` 第 7 节和已确认的 `.pen` 第 11 分区／11-01～11-07 预览；提示词里的单一最坏状态摘要优先于早期行为说明的双摘要示例。只完成 H4b；H5、真实官方模型复测与媒体生成不在本期范围。按本期授权停止在修改与验证，不提交、推送或创建 PR。

## 1. 改动与边界

- 界面：要求组在宿主检查组之前，显示 Hint、条件原文、当前值以及达成／未达成／等待中／补做中。摘要合计要求和宿主项，并只显示最坏状态。当前未达成的要求仅在同轮已有补做模型、运行仍处于 running／awaiting_approval／awaiting_answer 时显示补做中。
- 步骤：目标声明显示“整理要求 · N 项”；被后续有效声明取代的旧声明显示“已更新”。同 run/source 只给首个补做模型专用标题与徽标，后续模型／工具仍沿原展示。当前目标由最后 completed 回执的严格参数／结果绑定决定，畸形最后回执不回退；新声明与清空会立即屏蔽旧缓存要求。
- 读取：沿 H3b 的并发、可见性、缓存、修订刷新和完整预检机制；补做中自动轻读，手动完整预检保留。若完整预检期间补做结束或目标被替换，收尾后补一次串行轻读，避免已过滤的旧要求不再刷新；普通 completed 轮次的预检稳定性不变。
- 契约／业务：时长保留 `{seconds,toleranceSeconds?}`，新增互斥的 `{minSeconds?,maxSeconds?}`，至少一边、两边须有序、范围不接受容差。仅扩展 duration schema／规范化／帧域比较及可选机器值，不改其他检查计算、runtime、恢复或补做状态机。旧秒数规范化字节不变；半帧及 `1e-9` 同时适用于上下界。
- CLI：去掉 H4a 临时剔除，`agent task checks` 原样输出可选 requirements；HTTP/client/旧 host groups 保留。文档同步到 `docs/CLI.md`、`docs/AGENT-TASKS-V2.md`。
- 四语：新增要求、当前值、状态、说明行及步骤标题／徽标，使用既有语义色和中性 token，不增加操作按钮、字体或依赖。

没有存储 schema／表／列／迁移、持久字段、历史改写、工具发现或权限策略变更。既存冻结请求、旧 seconds／tolerance 回执与只读恢复副本继续兼容；时长新 wire 分支会有意改变非诊断模型请求，指纹必须先复核再更新。

## 2. 验证方法与 main 基线

证据目录：`~/Library/Caches/mioon-harness-H4b-2026-10-29/`。新工作树实际执行 `CI=true pnpm install --frozen-lockfile` 成功，5.4 秒，Node 24.21.0、pnpm 11.25.0；没有清空原工作树依赖，锁未改。长过程使用 `caffeinate -i`、UTC、真实 TMPDIR，每文件独立进程和原期限。

main 源由 `git archive 0094b5b…` 冻结为 6123 源文件／973 测试文件，SHA-256 `2b0d54db7868d987a23f50b9b05139ca8b3fcd44358d5ea37d9904d55e5c6e46`。H3b 原 25 文件与标准 harness 63 文件去重为 79 文件，实际 1377/1377 通过（25 文件 324 项、63 文件 1209 项，范围重叠不可相加），无失败／取消／跳过／超时／缺失／重复。runtime 185/185 和 H0 指定完整 FFmpeg 两项均通过。

固定 Linux 镜像为 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`，Node 24.21.0、FFmpeg 7.1.5、UTC、非 root、断网；复用独立复制的同锁 Linux 依赖，配置和虚拟锁逐项核对，不声称重新安装 Linux 依赖。保留调度 gate 起初漏 source hash 而等待的原件，补齐元数据后才派发测试；总 wall 930.98 秒包含等待，不将其算作测试通过。源与副本前后零漂移，自有进程／容器零遗留。证据为 `main-baseline/suite/main-results.json`、命令结果与清理记录。

本地不跑全量，以以后获授权创建 PR 后的 CI 为准；本期没有提前创建 PR。

## 3. 指纹复核与更新

当前 backend／实际指纹 helper 的 487 文件独立守卫哈希为 `df535388cf96f11eae3b9422be7f519c84a2645490090183ec457c09c22de568`。两次离线 runtime intent 采样均 actual exit 0（33.00／31.17 秒），99 项身份、顺序、字节和 SHA-256 全部稳定。采样只输出 metadata，没有输出 body 或合成会话密钥，也没有调用真实模型。

| 协议 | 非诊断 | 非诊断每项增量 | 诊断 | 诊断差异 |
| --- | ---: | ---: | ---: | --- |
| Chat Completions | 29 | +525 B | 4 | 字节／哈希均为 0 |
| Responses | 29 | +525 B | 4 | 字节／哈希均为 0 |
| Anthropic Messages | 29 | +525 B | 4 | 字节／哈希均为 0 |

纯 schema 归因：原 duration 分支的 279 B 逐字节不变，新增互斥范围分支 524 B，加一处分隔逗号共 525 B；其余六类条件逐字节不变。完整参数从 2809 B 增至 3334 B，总 87 项增加 45675 B。官方预设、兼容预设与各语言的分类增量相同；没有改工具排序、系统指令、缓存断点、历史或恢复请求。

复核后明确执行 `node tests/helpers/agent-task-request-fingerprints-v2.ts --update`，actual exit 0、21.16 秒；新 99 项逐条等于两次预览。fixture 从 main 的 `f11fd5e19890254fc94ceae91b9136be84b656569d64fa337255d75235449250` 更新为 `d60cd4e811829359d0b1929ad03517269059aaaaa2fed048d4a5a0815d6bd149`。已登记的 reviewed-live source 没有改动或 pin 不匹配，未更新 pin；宿主参数不属于公共 operation schema，未运行 schema 生成器。证据在 `fingerprint-preview/` 与 `fingerprint-update/`。

## 4. 真实界面与设计对照

主 checkout 的 `.pen` 原始 JSON 只读核对了九个指定 frame／组件板，SHA-256 为 `d4f8911df3a17a2f0ce718494d5f716f218a241062e8cd887e74bb21bc80e2cb`；原始节点名、文案和字号保存在 `design-source-read.json`。Hint 与说明行均沿组件板的 11px 及既有次要文字 token，没有修改设计文件。

候选冻结为 6131 源文件／978 测试文件，SHA-256 `bde58c8ef0157ff6905d650d268209c8b6c4ca063c471127d41fe8ee29e38325`，仅排除本报告。截图读取该不可变候选的真实 AgentTaskPanel、I18nProvider、ConfirmationProvider、共享控件和源 CSS，通过契约校验的合成只读 HTTP fixture 渲染；不是手写 HTML 替代，也不是完整 App／真实供应商验收。

Chrome 156.0.8078.75，320×850、DPR 1。主轮 11 次 capture／21 PNG，最小补轮 2 次 capture／4 PNG，均 actual exit 0（11.32／6.74 秒）。合计 112 个请求全部 GET，页面错误、未知 API、外网和写请求均为 0；面板及完成情况无横向溢出，新增文字至少 10px，检查点击区域至少 24×24。付费确认卡两个按钮实测 128.5×24，费用说明及“拒绝”“确认生成”仍在，未点击；界面不会因为补做标记代替用户确认。

| 设计画板 | 实际截图与观察 |
| --- | --- |
| 11-01 | `11-01-repairing-initial-light.png`：要求最前、两项补做中、首个补做模型只有一个徽标；`11-01-repairing-manual-full.png`：通过原重检入口完成预检后，完整结果参与计数。 |
| 11-02 | `11-02-repaired-collapsed.png` 与 `11-02-repaired-expanded.png`：全部达成默认折叠，可通过原展开按钮查看全部要求。 |
| 11-03 | `11-03-still-unmet.png`：未达成的当前时长为 danger，一次补做说明没有按钮。 |
| 11-04a | `11-04a-waiting-only.png`：运行级生成汇总 1/2、等待说明，不新增镜头查询。 |
| 11-04b | `11-04b-budget-exhausted.png`：步数用尽说明，不增加补做入口。 |
| 11-05 | `11-05-paid-confirmation.png` 与补图 `11-05-paid-card-complete.png`：上限时长、无可核对生成结果、补做中与原付费确认卡共存。 |
| 11-06 | `11-06-requirements-updated.png` 及补图：旧声明带“已更新”，最新要求组完整补图不含旧要求；保留真实 model/tool 补做来源。 |
| 11-07 | `11-07-english.png`：英文说明和单一摘要在 320 宽下正常换行，未截断要求值。 |
| 恢复副本 | `restore-requirements.png`：要求及说明继续显示，沿原只读行为，没有新增执行操作。 |

每个较长展开状态另有 `*-checks.png` 完整完成情况补图，避免把滚动外的内容误认为缺失。主图在 `browser/screenshots-v1/`，费用卡和旧声明滚动补图在 `browser/screenshots-supplements/`；各目录 `report.json`、原生 DOM／ARIA、请求和图片哈希均保留。

与设计稿的有意差异及原因：

1. active 首次轻读没有完整预检缓存，真实 `PREFLIGHT_NOT_REQUESTED` 按 H3b 隐藏、不计数，因此 11-01 是 3 要求＋1 宿主项＝4，非画板的 5；11-05 同样仅计实际可显示项。手动重检补图沿真实只读 full 返回与缓存，没有伪造轻读已通过。
2. 11-04a／11-05 的生成要求只给运行级 `count/completedCount`，不能复制画板中的镜头名、百分比或定位。非零显示“当前 1/2 已完成”，零项显示“当前没有可核对的生成结果”；不额外查询或暗示已发出付费请求。
3. 当前真实 Changes 区是卡片 section，没有整组折叠按钮；保留现有结构，仅单卡 details 可折叠，使用原日志滚动和完整要求区补图，不为凑稿添加控件或隐藏 DOM。Panel fixture 也不包含外层 Dock 页签，不冒充整页像素复刻。
4. 字体沿应用原栈，原生中文实际使用 PingFang SC；不为设计稿的 Noto Sans SC 引入字体依赖。英文长摘要可换行，保持单一摘要语义，内容不截断。

## 5. 开发回归与审查修正

开发早期条件／真实 CLI 9/9、步骤 10/10、读取 8/8 与要求组件 8/8 各自保留来源；这些不代替最终冻结源验证。随后增加真实工具回执到 checks 的端到端断言，步骤完善为 12 项、读取完善为 11 项；最终新五文件应有 40 项，由正式候选套件统一覆盖。

初轮要求组件为 7 通过／1 失败，原因是英文使用 plural 对象而其他三语仍为字符串，不符合既有词库 template-kind 规则；只将对应三语同文案改为 one/other，原断言不变，8/8 补验通过。步骤 fixture 初轮漏注入真实 question helper 的 2 项失败，以及 schema 归因脚本最初误假定分支数的失败，也各保留原件，没有改生产逻辑或削弱检查来掩盖。

独立审查发现完整预检期间 repair A→B 并结束时，旧全通过响应可能阻止 B 的下一次轻读。修正仅在 repair 结束或 repair 期 goal ID 变化时保留一次轻读需求，完整预检仍不中断；始终可见、隐藏后再显示、换轮迟到隔离均有新回归。新 reader 11/11、原 H3b state 25/25 通过，普通 completed 的 revision／visibility 不追加轻读原断言保留。H4a 的整条补做链都带 repair 来源，因此前端按 run/source 的最小 position 只标首次模型，model→tool→model 的真实链和恢复副本均有回归；没有修改后端标记。

冻结 v1 的正式类型检查保留 actual exit 2、54.52 秒：新 duration 测试的异构条件数组采用 `satisfies`，类型推导含 optional undefined，无法赋给 `AgentTaskJson`（TS2322）。只改为显式 `const args:AgentTaskJson` 上下文类型，不改数据、断言或生产代码，不增加 any／忽略。当时开发构建和正式 99 未派发，候选 Linux 队列也未运行，不能把它们写成 v1 通过。

修正后 v2 冻结为 `adc3102b295e1a177af10ed368f8c61be227796afedb97ae138d16e0dabc21ef`，仍为 6131 源文件／978 测试文件。相对视觉 v1 仅一条测试源路径变化，其余 6130 文件字节相同；TypeScript 6.0.3 实际擦除前后 JS 完全相同，SHA-256 均为 `22102aacf248a0691d19ae98f82f4ded012649374348086ed7c0a502f1f65a63`。因此复用 v1 真实截图与 487 文件双采的证明，不冒称 v2 重跑视觉或采样；类型、开发构建、正式指纹与候选 84 文件则在 v2 上重新执行。证据为 `candidate-v2/test-erasure-proof.json`、`v1-equivalence-proof.json` 与原 `native-validation/` 失败原件。

## 6. 冻结回归与最终小范围补验

v2 实际执行下列检查，均 actual exit 0、源文件守卫无漂移：

| 实际命令／队列 | 结果 | 用时 |
| --- | --- | ---: |
| `node scripts/tooling.ts typecheck` | 三套 strict 通过 | 55.64 秒 |
| `node scripts/tooling.ts build --channel=development` | 三套 strict 与 Web/Desktop 通过 | 120.14 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/agent-task-request-fingerprints-v2.test.ts` | 更新后的 99 条全部通过 | 21.69 秒 |
| 同 H0 固定镜像中的 84 文件候选队列 | 1417/1417，84 文件通过，无失败／取消／跳过／超时／缺失／重复 | 474.44 秒 |

独立 parser 重解析 fresh main79 与 candidate84 的每份原始 TAP，核对 SHA、footer、完整 path 数组、occurrence、状态和跳过原因；1377 项基线中 1376 项精确同名保留，另 1 项是本期 CLI 语义更新的明确标题替换：`H4a clients retain optional requirements while CLI and existing UI keep the original check groups` → `H4b clients and CLI retain optional requirements while host check groups stay separate`。对应断言保留 HTTP/client 和 host groups，只将 CLI 预期改为完整 report；没有模糊匹配或静默删名。其余新增、缺失、状态和跳过差异为 0。

新五文件的 40 项在该快照全部通过（duration 8、CLI 1、steps 12、reader 11、requirements 8）。H3b 原 25／既有 harness 63 的重叠范围分别为 324／1209，不重复相加。runtime 185/185、指定完整 FFmpeg 两项均通过（候选 runtime 104.66 秒）。原件在 `native-validation-v2/`、`candidate-suite-v2/`；独立逐名结果为 `independent-final-audit/final-name-comparison.json`。

该队列运行期间又发现一个 Panel 挂载边界：局部变量 `latest` 实际表示最后一个有模型正文的步骤，而非“最新轮次”。原表达式把 `latest` 同时施加给补做分支，合法的全空文本工具调用链会不显示完成情况。新增单例覆盖三种 active 状态的空正文、普通 running 与无正文 completed；在原代码上 actual exit 1，最小括号修复后 exit 0。只将条件改为 `(completed && latest) || isTaskGoalRepairActive(snapshot)`，保留普通 completed 的最后文本规则；没有改后端补做逻辑。

最终 v3 冻结源为 `859e44f202f71e7c01acbcabd47d3f2546b4ccecdb4f2a63296d19ec328ed540`，6131 源文件／978 测试文件。相对 v2 只改 Panel 表达式和 steps 测试追加 1 项，其他 6129 文件字节相同；backend／helper 487 文件、锁、fixture、CSS 和检查状态机均不变。v2 的 84 队列继续在原不可变副本上跑完，没有混入 v3。最终只补类型／开发构建／正式指纹、四个实际依赖 Panel 的文件及一份空正文真实界面；不重跑整套 84／FFmpeg，不把 v2 的 1417 项说成 v3 重新执行。直接引用名但只 stub Panel 的旧 agent-chat-ui 不是依赖，不为此追加重测。

v3 补验实际结果均 actual exit 0，7 阶段各自 6131 文件守卫无漂移：

| 实际命令 | 结果 | 用时 |
| --- | --- | ---: |
| `node scripts/tooling.ts typecheck` | 三套 strict 通过 | 94.69 秒 |
| `node scripts/tooling.ts build --channel=development` | 三套 strict、Web 与 Desktop 通过 | 212.61 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/agent-task-request-fingerprints-v2.test.ts` | 99 条通过，fixture 仍为 `d60cd4…d149` | 28.05 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/agent-task-panel-v2-components.test.ts` | 39/39 | 1.17 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/agent-task-reviews-ui.test.ts` | 10/10 | 0.61 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/mio-change-marks-ui.test.ts` | 6/6 | 0.49 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/mio-requirement-steps.test.ts` | 13/13 | 0.74 秒 |

四文件共 68/68，不与 v2 的 1417 累加为一次套件。最终新增共 41 项：v2 的其他四个新文件 28 项与源逐字节相同，steps 文件由 12 项补验至 13 项；不声称最新源码重新跑过五文件 41 项或完整 84 文件。补验原件在 `native-validation-v3/`，新源的两路径等价和原视觉输入谓词等价证明独立保留。

独立补审重解析四文件 TAP：与 v2 重叠的 57 项身份／状态全部保留，追加 1 项空文本修复回归；其余 10 项为另加的旧 reviews 文件检查范围，不算本期新增。原始 footer／SHA、native 七阶段、public snapshot 契约、空文本两字段与实际 DOM 均逐一绑定，结果见 `independent-final-audit/v3-final-supplement-audit.json`（SHA-256 `285e13b4e61356a14d031417e05f7e2d6654d847fa352acd6c4fa53f257e7c48`）。

另从 v3 新 bundle 实际运行一份空模型文本界面，不重拍原 25 图。真实 `agentTaskSnapshotSchema` 再 parse 成功，5 个 model 的公开 `step.text` 与 `result.text` 均为空，repair 来源仍保留；DOM 无模型回复段落、完成情况实际挂载、显示 3 个要求及 2 个补做中。11 个请求全为 GET，checks 读取 1 次，无页面错误、外网、写请求或横向溢出；服务器与专用 caffeinate 已退出。两张图为 `browser-v3-empty/screenshots/empty-model-text-repair.png` 与 `*-checks.png`，每个模型字段和原始 DOM 证据为 `browser-v3-empty/empty-text-evidence-assertions.json`。本期合计 27 PNG／123 个只读请求，旧 25 图仍属于 v1，并由 v2／v3 的明确等价证明连接，不冒称最终源码全量重拍。

最终 `final-source-owned-cleanup.json` 对 main／v1／v2／v3 冻结源、各工作副本与主线共 10 个根逐文件复核，全部零漂移；主线完整 pathset 6131 无缺失／额外，唯一显式排除本报告。锁仍为 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`，fixture 为 `d60cd4…d149`；本线 wrapper／driver／caffeinate 和精确标签容器均无遗留，没有停止其他会话进程。

独立审计再次核算 10 根共 61294 份源哈希，零漂移；进程清理明确引用验证代理的保存观察，不冒称另一次实时查询。最终验证摘要 `validation-delivery-summary.json` 的 SHA-256 为 `4c04124786405c69fe2dd2466ab2e8ddce435dde9f2751c793dd369fee1e093d`，独立 `audit-manifest.json` 为 `c390bac8a03d26436a6059325913e6b0121907dec3a70146cbc4a0d5776a47f0`，均保留各阶段原件与范围限制。

## 7. 文件与兼容性交付

| 分组 | 本期文件 |
| --- | --- |
| 业务 | `packages/business/src/agent/task-goals-v2.ts`，仅 duration 扩展；runtime、gateway、journal、宿主检查观察计算未改。 |
| 契约 | `packages/contracts/src/agent-task-goals-v2.ts`、`agent-task-checks-v2.ts`。 |
| 传输／CLI | `apps/cli/src/agent.ts`；HTTP、client、MCP 和工具发现未改。 |
| 前端 | `AgentTaskChecks.tsx`、`AgentTaskPanel.tsx`、`agent-task-checks-state.ts`、`agent-task-presentation.ts`、新 `agent-task-requirements.ts`、`agent-task-v2.css`。 |
| 四语 | `packages/i18n/src/catalogs/mio-panel.ts`、新 `mio-requirements.ts`、注册 `packages/i18n/src/index.ts`。 |
| 测试 | 新 duration／CLI／steps／reader／requirements 五文件、新 UI fixture helper；三个旧测试文件只同步 CLI 预期／标题或实际模块注入，原只读、host 分组与 UI 断言保留；99 指纹 fixture。 |
| 文档 | `docs/AGENT-TASKS-V2.md`、`docs/CLI.md`、本报告。 |

旧 seconds／tolerance、数量上下限、已保存的请求／回执与恢复副本继续可读；不重写旧记录、改变未知结果处理或绕过放行确认。新增时长字段是可选的闭集扩展，拒绝与旧形式混用；CLI 开始输出本已可选的 requirements，是本期明确要求的行为变化。没有工作区存储格式、依赖、公共 RPC schema 或模型私有用量暴露变化。

H4b 的实现与本地验证已完成；完整 978 文件全量未在本机运行，按要求留待后续获授权创建 PR 时的 CI。当前 26 个本期文件仍未提交、未推送，未调用真实模型或付费生成，停下等待复核；没有实施 H5。
