# Mio harness H4b · 要求与补做的界面

日期：2026-10-29–30（Asia/Taipei）。分支 `codex/mio-harness-h4b`，独立 managed worktree `~/.codex/worktrees/mio-harness-h4b/mioon`。从 main `0094b5b7f5711da29b555ceb7f84ad62a1ab367c`（已含 H4a，PR #85）创建，开工时工作树干净。设计资料仅从主 checkout 的 `designs/` 读取，没有复制进分支或修改设计稿。

实施依据是 `MIO-HARNESS-PARALLEL-PROMPTS.md` 第 7 节和已确认的 `.pen` 第 11 分区／11-01～11-07 预览；提示词里的单一最坏状态摘要优先于早期行为说明的双摘要示例。只完成 H4b；H5、真实官方模型复测与媒体生成不在本期范围。初次复核前按当时授权停止在修改与验证；2026-10-30 获准提交、合入最新 main、推送与创建 PR，同步后的记录见第 8 节。

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

以上为首次复核前的验证记录：当时完整 978 文件全量未在本机运行，26 个本期文件未提交、未推送；未调用真实模型或付费生成，没有实施 H5。用户确认后的同步、验证与 PR 交付记录见下节。


## 8. 审查通过后的 main 同步与交付（2026-10-30）

### 第一次同步（#86–#90）与双方语义

先将本报告原有两处本机主目录改为 `~`，把已批准的 26 文件提交为 `ce9d990b4c63d433714227879f2b0b1ddc832198`，未推送。随后 fetch 并固定最新 `origin/main` 为 `f8cf7146ec27920c4c006c400aa91f1b6ec0ab7c`，包含 #86–#90；用 merge commit `7bb80ba6fac89e271d560b3eda368cf662acf58b` 合入，父提交依次为 H4b 提交和该 main，没有 rebase。

冲突仅在 i18n 目录注册和指纹 fixture。前者同时保留 H4b 的 requirements 和 main 的 clipTransition 两个目录的 import、重复键校验与 spread；独立解析确认 main 的 5996 个四语键值全部保留，恰好新增 H4b 的 5 个步骤键和 45 个要求键，内置方法的 7 个键完整。`mio-panel.ts`、内置方法说明与 CLI 文档自动合并后的双方内容也逐项核对。

相对最新 main，源改动仍只在原 H4b 范围内；后端／契约差异严格等于已批准的时长上下限扩展，runtime、gateway、journal、工具分组、方法目录与 main 字节一致。main 自带的转场及 schema 72／73 变更原样保留，不算 H4b 新增。7 个界面关键输入与已批准 v3 字节相同，首次补做徽标、空正文挂载、最后声明清空／畸形处理和完整读取期间串行刷新均保留。因此本次沿用第 6 节按来源标记的截图，不宣称在合并源重拍。

### 指纹重新生成与逐条复核

先将工作 fixture 恢复成所固定 main 的原件（SHA-256 `9b612eb1d5cc62f0e94164e713732799d53efa415dbcb45b6d95ec2ef7e1c90b`），在合并源只读采集两次，actual exit 均为 0（22.121／22.120 秒），99 条元数据逐字节一致。按完整 `(scenario, protocol, index)` 对齐新 main、合并源、原 `0094b5b` 和原 H4b `ce9d990`，每条均满足“合并后 − main = H4b − 0094b5b”；没有缺项、重复或例外。复核后才执行 `node tests/helpers/agent-task-request-fingerprints-v2.ts --update`，actual exit 0，21.45 秒；结果与两次预览完全相同。

| 协议 | 非诊断请求 | 每条字节变化 | 诊断请求 | 诊断变化 |
| --- | ---: | ---: | ---: | --- |
| Chat Completions | 29 | +525 B | 4 | 字节数与 SHA 均不变 |
| Responses | 29 | +525 B | 4 | 字节数与 SHA 均不变 |
| Anthropic Messages | 29 | +525 B | 4 | 字节数与 SHA 均不变 |
| 合计 | 87 | +525 B | 12 | 全部不变 |

变化仍只有核心 `mioon_goal_set` 新增的时长上下限 schema 分支（524 B 加分隔逗号），旧分支及其余条件不变；诊断不提供该工具。main 的新方法提示与自身 fixture 已包含在比较基线内。新 fixture SHA-256 为 `672a617d64b474627ed429606e5f9ff407ae17fac31c2b23ccd436ced04693d2`。

本次原件单独保留在 `~/Library/Caches/mioon-harness-H4b-sync-2026-10-30/`；`fingerprint-preview/`、`fingerprint-update/` 保存实际命令、返回码与源守卫；`root-four-way-fingerprint-review.json` 为主代理独立逐条核对。独立审计 `independent-audit/merged-source-audit.json` SHA-256 为 `28f15577ddd560554aa792a4b2c3be98ad7e98e3a91f475915e762b173fcb3dc`，`fingerprint-final-audit.json` 为 `735d7af9300e6ba8b5c9598d2eb67176259aac8d90db49dfc43d67dcb883da0a`。旧阶段证据、失败与修复经过仍在原目录，没有覆盖或改标为本次结果。

### 同步后验证

固定 main 源摘要为 `119768889396a84f2d0ae2f2d96b6e349d93a10ba690e8e22968a03860d17608`（6146 源文件／976 测试文件），第一次同步候选为 `91573b3edff4ce5be73ed6fe00a8983cde5a5614b432a0b4b7dd3ac238503983`（6154 源文件／981 测试文件），仅排除本报告。源码逐 Git blob 验证，私有验证副本的 Git HEAD 分别固定到真实 `f8cf714`／`7bb80ba`，不修改主仓库 refs。14 项配置与 virtual-store lock 校验一致后才复用依赖，未重新安装或更新依赖；锁 SHA-256 仍为 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。

全部长执行使用 `caffeinate -i`，Node 24.21.0、pnpm 11.25.0、UTC 和真实临时目录；先串行完成原生检查，再依次运行 main 基线与 H4b 候选，不叠加重套。Linux 使用 H0 固定完整 FFmpeg 镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`；逐文件内部 600 秒、外部 630 秒，runtime 独占，其余并发 2，未因并发延长期限或停止其他会话进程。

| 合并候选的实际命令 | 结果 | 用时 |
| --- | --- | ---: |
| `node scripts/tooling.ts typecheck` | 三套 strict 通过，actual exit 0 | 57.70 秒 |
| `node scripts/tooling.ts build --channel=development` | strict、Web 与 Desktop 通过，actual exit 0 | 116.91 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/agent-task-request-fingerprints-v2.test.ts` | 99 条指纹通过（1 个聚合 TAP 测试），actual exit 0 | 26.98 秒 |

三阶段每次 6154 文件守卫均零漂移，原件见 `native-validation/`。独立重解析实际 metadata、driver、stdout／stderr SHA 和正式 TAP，结果 `independent-audit/native-final-audit.json` SHA-256 为 `801abb2fecd6b5b5ca225469b81326b0a492d3a39002ef8fa92a6be07b840ab1`。本次采样 runner 准备首次遇到 cache 内 Python 空格语法错误，actual exit 1，尚未派发采样或测试；原 stderr 和 `fingerprint-preview/runner-prepare-note.json` 保留，修正后才进行上文两次正式采样，未计作测试重跑。

### 聚焦集逐名对照与停止范围

本次沿原聚焦集，额外纳入已用于最终 Panel 修复的 `agent-task-reviews-ui.test.ts`，形成最新 main 的 80 文件基线；加 H4b 五个新文件后为候选 85 文件。#86 方法测试与共享 i18n 校验已包含，不扩展无关转场媒体套件。两套按前述同一镜像、相同逐文件命令和期限先后运行，取各 `*-results.json` 的队列 wall 用时：

| 本次实际 Linux 队列 | 结果 | 用时 |
| --- | --- | ---: |
| 固定 main `f8cf714`，80 文件 | 80/80 文件、1391/1391 项通过 | 682.57 秒 |
| 合并 H4b `7bb80ba`，85 文件 | 85/85 文件、1432/1432 项通过 | 791.36 秒 |

两套 actual exit 均为 0；失败、超时、取消、跳过、todo、文件缺失与重复均为 0，源守卫无漂移。两套 runtime 都是 185/185，指定完整 FFmpeg 两项均通过：`whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`、`retained shot keeps a late product without selecting it and never dispatches after reversion`。原始队列记录、每文件 TAP 与命令结果分别在 `main-baseline/suite/`、`candidate/suite/`，总调度结果为 `coordinator-result.json`；不与旧阶段用例相加。

按 `(file, path-array, occurrence)` 独立重解析 165 份原始 TAP，并核 footer、每份 SHA、实际退出码与源摘要。main 的 1391 项中，1390 项身份和状态精确保留；另 1 项沿本期已批准的 CLI 语义明确改名：`H4a clients retain optional requirements while CLI and existing UI keep the original check groups` → `H4b clients and CLI retain optional requirements while host check groups stay separate`。新增五文件 41 项全部通过：duration 8、CLI 1、steps 13、reader 11、requirements 8；没有其他缺失、既有文件额外新增、状态或跳过原因变化，不模糊匹配或归一测试标题。

旧 `0094b5b` 的 79 文件／1377 项也全部原名、原状态保留至 fresh main。本次 main 比旧基线多 14 项：额外 reviews 文件 10 项、main 新方法 1 项、schema 72 令原参数化循环增加 3 项（backup reads 1、step/change display 各 1）。后 3 项的测试源本身与旧基线相同，不算 H4b 新增。独立记录为 `independent-audit/main-baseline-evolution.json`，SHA-256 `dd0bbdc75875a722e51d760a44c8b1b00b1ba81f9140d241212a05143093e105`；最终逐名独立审计 `final-name-comparison.json` 为 `db945e556a1d81968ac56332eaedce909cbdaef1429343647ebeadefe0c582e5`。

第一次同步在 `7bb80ba` 的合并源码上重新完成类型、开发构建、99 条指纹和完整聚焦集；当时完整 981 文件全量未在本机运行。没有真实模型请求、付费生成或 H5 改动。验证期间 main 又合入 #92；第二次同步与最终验证见下节。


## 9. 验证期间 main 合入 #92 后的最终同步

第一次验证结束检查 Git 状态时，发现共享 `origin/main` 已前进到 `f6e8340c3931a0f1abb0e44c4e304fe17f0ffece`（#92，转场标记）。随后无冲突合入 merge commit `9751ce3ab3991e4a925d7b3a62e6f2c1e6a9c252`，父提交为 `7bb80ba` 和该 main；本报告保持未暂存，未混入这次合并提交。追加内容全部来自 main，未修改已批准的 H4b 实现。

#92 仅涉及 11 个转场界面／文案／测试文件，不改后端、依赖锁或指纹 fixture。两份 main 的 fixture 都是 `9b612eb1d5cc62f0e94164e713732799d53efa415dbcb45b6d95ec2ef7e1c90b`，因此前述 87 条各 +525 B、12 条诊断不变的逐条比较基线仍相同。本次仍对最终合并源重新执行类型、开发构建、正式 99 条指纹和完整 85 文件聚焦集；第 8 节全部原件及最终摘要封存，新增结果单独保存，不覆盖第一次同步的通过记录。

测试名比较继续使用第 8 节实际执行的 `f8cf714` fresh main80，不把该基线改标为在 `f6e8340` 上重跑。两个 main 的 80 份选集测试源均逐字节相同；#92 变更的两个转场测试都不在本期选集内。

独立检查确认旧 main 的 5996 个四语键值全部保留，仅新增 `timeline.transition.mark`／`timeline.transition.add`；最终目录共 6048 键，包含原 H4b 的 50 键。图标定义精确只新增 `transition` 一行，旧定义原字节保留；7 个 H4b renderer／CSS 仍等于批准 v3，未重拍截图。记录 `independent-audit/phase2-source-audit.json` 的 SHA-256 为 `8f85002d38b36664deb807bca6b78d94f82f585f8fafa18cddeef968dc60fd0a`。

最终冻结记录为 `phase2/candidate/source.json`：HEAD `9751ce3`，源摘要 `26560434c91d41e81001913a6ff01c8ba7f2e6b6d695b61c9b6beb29a02f7e0d`，6158 源文件／982 测试文件，仅排除本报告。两种平台继续复用已验证同锁依赖；最终指纹仍为 `672a617d64b474627ed429606e5f9ff407ae17fac31c2b23ccd436ced04693d2`，没有再次 `--update` 写入相同内容。独立冻结绑定为 `independent-audit/phase2-frozen-source-binding.json`，SHA-256 `dacb1b2b2d40c63c91a6d4277341537898146183bd7effb32ac7f8d28a351c90`。

### 最终合并源验证

最终原生三阶段均 actual exit 0，6158 文件守卫每次无漂移；命令继续由 `caffeinate -i` 包裹，Node 24.21.0／pnpm 11.25.0／UTC／原阶段期限不变：

| 在 `9751ce3` 上实际执行的命令 | 结果 | 用时 |
| --- | --- | ---: |
| `node scripts/tooling.ts typecheck` | strict 通过 | 60.77 秒 |
| `node scripts/tooling.ts build --channel=development` | strict、Web 与 Desktop 通过 | 137.03 秒 |
| `node --test --test-reporter=tap --test-concurrency=1 tests/agent-task-request-fingerprints-v2.test.ts` | 99 条指纹通过（1 个聚合 TAP 测试） | 28.57 秒 |

实际原件为 `phase2/native-validation/`。该次正式指纹与第一次同步的双预览和 fixture 全部一致；最新 main 的原 fixture 也与比较时相同，因此逐条差仍为 87 条各 +525 B、12 条诊断字节数和 SHA 不变，没有例外。

最终 Linux 85 文件队列继续在同 H0 镜像、Node 24.21.0、UTC、runtime 独占／其余并发 2、逐文件内部 600 秒／外部 630 秒下实际跑完：

| 最终实际队列 | 结果 | 队列 wall 用时 |
| --- | --- | ---: |
| `9751ce3` 完整聚焦 85 文件 | 85/85 文件、1432/1432 项通过，actual exit 0 | 572.46 秒 |

失败、超时、取消、跳过、todo、文件缺失与重复均为 0，6158 文件守卫无漂移，runtime 185/185 和指定完整 FFmpeg 两项均通过。原件为 `phase2/candidate/suite/`，实际命令、返回码与每文件 TAP 原样保留；没有以第一次同步的 1432 项代替这次执行。

对最终 85 份原始 TAP 重新解析后：与 `7bb80ba` 的 1432 项身份、状态和跳过原因全部精确保留；与实际执行过的 `f8cf714` main80 基线相比，仍为 1390 精确保留、1 项已批准 CLI 标题替换及五新文件 41 项通过，没有其他差异。独立解析全部 250 份原 TAP（main80／旧85／最终85），不模糊匹配或归一标题；记录 `independent-audit/phase2-final-name-comparison.json` SHA-256 为 `c9af63c59b2d4da2801d68b6875666947b6d7d128f38ab67d6e47ad423c9a319`。

最终原生独立审计为 `independent-audit/phase2-native-final-audit.json`，SHA-256 `845ea3520c33a0d8917332c9d7869f52d09a0e83e5d5047c6d2b752b1591d832`。主代理另用 `f6e8340` 原件四方复算全部 99 条差异，并确认最终相对 main 恰原批准 26 路径；`root-final-main-fingerprint-review.json` 的每行与独立结果一致，对应独立审计 `phase2-final-fingerprint-scope-audit.json` SHA-256 `f8c68e12aa73eca063597fd0dc78befdb78782d33fbe31f6ff58942025976120`。

本期最终代码与离线验证完成；完整 982 文件全量未在本机运行，交由本次 PR 的 CI。没有真实模型请求、付费生成或 H5 改动。最终测试固定到 `9751ce3` 的源，后续提交只补本报告并推送、创建 PR；PR 合并方式使用 merge commit，本次不执行合并。

最终守卫对 6 根共 36932 份源哈希逐项核对，无漂移；旧 `f8cf714`／`7bb80ba` 冻结源也保持原样，4 份私有 Git metadata 与最终 `9751ce3` 绑定一致。主线完整 6158 路径仅排除本报告；专属进程及精确标签容器无遗留，没有停止其他会话进程。原件为 `phase2/final-source-owned-cleanup.json`；独立实际重哈希记录 `independent-audit/phase2-final-guard-independent.json` SHA-256 为 `6e6bc798c07ca5bdebfc43fc8fd07e47d8e34d90ab3fcb3e386f2ac05261b61c`，其中 PID／容器明确引用验证代理保存的观测。

第二次同步的最终验证摘要为 `phase2/validation-delivery-summary.json`，SHA-256 `49d2285e6116012bf72967938f62ef242ae3fe4ff6917c0494c142a7119b9c17`；第一阶段 `validation-delivery-summary.json` 仍为 `facccc48534deb66df66f4353ea056253fcd15a49a54daffdc37dfb8bee0ed07`。两阶段证据分别封存，不把旧基线、旧截图或先前通过记录改标为最终重跑。
