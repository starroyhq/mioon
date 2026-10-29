# Mio harness H4a · 目标检查与一次补做

日期：2026-10-29（Asia/Taipei）。分支 `codex/mio-harness-h4a`；本期验证基线为开始时同步的 main `9ae9b87db889cf556b754ab6972cad6a46d5d19a`，包含 #78。复用 managed worktree `/Users/kouzen/.codex/worktrees/mio-harness-h1d/mioon`。只实施 H4a 后端，不进入 H4b，不提交、不推送，不调用真实模型或媒体供应商。

验证期间 origin/main 又合入 #79（片段变换及 schema 70）与 #80（后端冷启动测试期限），最终检查时 tip 为 `46881d0`，本分支比该远端引用落后 5 个提交。本次保留起始基线与原期限的冻结验证，未合入这两项后续上游变更；本报告不声称覆盖它们，同步后需要重新复核相关差异。

证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H4a-2026-10-29/`。本报告分别记录实现、最终冻结源码、原始全量与独立补充视图；保留全部失败和范围限制，不以聚焦或隔离补验通过冒充原始全量通过。

审查修订与同步 main 的现行验证见第 9 节。条件契约与比较公式已按审查更新；第 5、6、8 节的冻结哈希、测试数及停止点保留首轮历史，不代表修订后重新执行的结果。

## 1. 实现范围

- `agent-task-goals-v2.ts`／`task-goals-v2.ts`：七类闭集条件、严格校验与确定性规范化；从本轮完成回执读取目标，基于宿主观测作纯比较。
- `task-tools-v2.ts`／`task-tool-groups-v2.ts`／`task-gateway-v2.ts`：宿主工具 `mioon_goal_set` 属于核心组、只读档，每次消耗一个工具步骤；只返回规范化条件，不生成 Changes。四语系统指令要求模型声明用户提出的可判定要求，并明确目标不授予权限、也不是用户确认。
- `task-checks-v2.ts`／检查契约：在原四组检查之外添加可选 `requirements`；原组仍为宿主来源，目标要求另标 `source:'goal'`。公开步骤仅添加可选 `repair.sourceModelStepId`，不暴露私有补做消息、请求或 `data`。
- `task-runtime-v2.ts`／上下文与压缩模块：最终回复前按失败要求最多发起一次补做；先持久化冻结差距，再构造请求；恢复保留原请求与权限链。压缩时单独保留补做消息。
- `apps/cli/src/agent.ts`：检查命令暂时移除返回值的可选 `requirements`，其余字段原样保留；后端与 client 继续支持该可选字段。现有界面仍只读取原四组，目标与补做的界面呈现留给 H4b。

没有新增数据库表、列、迁移或依赖；补做标记沿用既有步骤 JSON metadata。没有新增 RPC、MCP、CLI 的目标声明操作，也未改生成的公共 RPC 工具 schema 及其哈希。宿主工具不进入这些公共发现目录；诊断运行既不提供该工具，也不附加目标系统指令或返回目标要求。

## 2. 条件契约与回执

调用形状为 `{conditions:[...]}`，最多 20 项；根对象和每项对象都拒绝未知字段，不强制转换字符串或数字。计数／帧数是非负安全整数，宽高是正安全整数，帧率为有限正数，秒数／容差为有限非负数；条件数值上限为 `Number.MAX_SAFE_INTEGER`。不接受任意自然语言判断、代码、标识符或授权字段。

| `type` | 条件字段 | 比较含义 |
| --- | --- | --- |
| `duration` | `seconds`，可选 `toleranceSeconds` | 当前时间线时长；容差缺省为 `0`，比较额外允许半帧及极小 epsilon |
| `timeline_format` | `width`、`height`、`fps`，均必填 | 当前时间线三项格式精确相等 |
| `export_parameters` | 可选 `width`、`height`、`fps`、`durationFrames`，至少一项 | 本轮最近导出步骤的已验证输出几何参数 |
| `clip_count` | `min`／`max` 至少一个 | 当前时间线片段数量，含上下界；恰好等于用 `min = max` |
| `subtitle_count` | `min`／`max` 至少一个 | 当前时间线字幕条目数量，含上下界；至少一条用 `min:1` |
| `shot_count` | `min`／`max` 至少一个 | 当前项目镜头数量，含上下界；恰好等于用 `min = max` |
| `generation_completed` | 无额外字段 | 本轮适用的生成工作成功且完成宿主发布检查 |

`conditions:[]` 明确清空本轮目标。规范化返回新对象、固定字段顺序，只给时长条件补默认容差，不改调用方输入。宿主 prepare 不抓取项目完整快照、目标修订或媒体，也不执行业务工具；execute 保留执行前 fence、取消检查和运行所属项目校验，返回由外层 journal 保存的普通工具回执。

数量上下限为非负安全整数，提供两边时要求 `min <= max`；没有提供的一边不补造默认值。`expected` 原样给出规范化的上下限，`current.count` 给实际数量。契约尚未发布，本次严格拒绝旧 `{count:n}` 声明，统一改为 `{min:n,max:n}`；当前观测值的 `count` 字段保持不变。

按步骤位置选择本轮最后一个 `completed` 的目标声明；参数与回执都须可规范化且完全一致。后来的有效设置替换整份条件，拒绝／未完成的声明不覆盖之前的目标。若最新完成回执畸形或与自己的参数不符，则保守地不提供目标，不回退成更旧的声明。无效新参数通过现有 `VALIDATION_ERROR` 参数纠错返回固定、有限的安全提示；不反射未知字段和值，也不执行。

## 3. 检查来源与边界

`checks.groups` 仍严格按 `export_render`、`generation`、`timeline`、`decomposition_frames` 四组排列；既有 item 的 `source:'host'`、状态、修订依据和 H3 计算保留。只有非诊断运行存在有效、非空的本轮目标时才附加 `requirements`；没有目标或已清空时省略该字段。

每个要求含 `source:'goal'`、声明步骤 `goalStepId`、目标与修订依据、状态及必需的 `expected/current`。这些字段只允许有界机器值和闭集原因码，不使用供应商原始错误、路径或自由文本。目标检查复用本次 H3 读取的任务绑定、回执、受管产物及发布检查，不启 worker、生成请求或替代媒体验证。

时长由保存的 `durationFrames/fps` 得出，在帧域比较 `abs(durationFrames-seconds*fps) <= toleranceSeconds*fps + 0.5 + epsilon`，边界包含等号；半帧允许不可恰落帧格的秒数，小 epsilon 消除浮点舍入误差。格式和三种数量来自当前已保存项目数据，数量按提供的上下界作包含边界比较。缺少时间线记录时沿用现有分镜输出格式和空时间线的零时长／零片段／零字幕观测，不创建时间线；已有但畸形的时间线保持未知，不能伪造零值通过。缺少可比较观测时返回 `pending`。

导出条件仅覆盖几何参数，不覆盖 codec、编码质量、声音或主观观感。选择本轮最近的 `export.create`／`timeline.render` 步骤，并要求其 H3 绑定、状态、受管产物、冻结请求参数检查通过；不拿另一导出的 ACK 标识或较早的成功任务替代。任何相关宿主失败优先得到 `failed`，否则有等待项则 `pending`，宿主三项全通过才比较所声明字段。

导出 `current` 组合已验证的冻结参数、H3 产物宽高；时间线输出帧数复用渲染 worker 的 `timelineExportOutputFrames(frozenSnapshot)`，按导出范围计算，不能拿整段 composition 长度冒充范围导出长度。`current.status:'accepted_parameters'` 明确这是已接受参数的宿主观测，不声称重新 ffprobe 实际编码帧率／帧数。未观测字段保持等待。补充值只供要求比较，不改变原四组 H3 的 `expected/current`。

生成完成要求使用本轮 H3 生成状态与发布结果；失败优先于等待，等待不算失败，没有适用任务时为 `failed/NO_APPLICABLE_TASK`。只有任务成功且对应产物／版本发布检查通过才满足条件；独立的费用结算等待继续留在 H3 费用项，不单独阻塞“生成完成”。

后端和 client 的可选要求字段保持可解析；CLI 的 `agent task checks` 仅去掉顶层 `requirements`，不改其余检查。真实 HTTP／CLI 回归同时调用现有 `visibleAgentTaskChecks`，确认带目标的响应仍产生与旧响应相同的界面分组投影；本期不实现目标要求展示。

## 4. 一次补做、恢复与权限

仅在普通运行的模型回复没有工具调用时，读取目标要求中的 `failed`。满足“存在失败、本轮无补做标记、当前步数小于预算”才进入补做；只有 `pending`、目标已满足／清空、没有有效目标或预算耗尽时照常结束。失败与等待混合时只把失败差距交给模型，不把等待工作改成失败。没有声明目标的普通 H3 失败不独立触发本期补做。

先在原模型步骤私有 `data.goalRepair` 保存版本与完整消息，再创建下一模型 intent。四语消息说明差距仅供参考，不是权限或审批。下一次模型请求计一个模型步骤，之后模型若调用工具仍按普通预算计步；“最多一次”约束的是本轮一次补做过程，不给它无限工具或模型步骤。

补做标记保存的是当时检查差距，恢复不重新计算后覆盖它；已有 intent 的冻结 body 完整复用。三协议的崩溃用例分别覆盖标记已落库、以及新 intent 已落库的边界，检查恢复只续接一次、消息不重复，并验证崩溃后项目状态变化不会改写冻结观察。补充说明先走原有续接；检查读取期间若新说明被接受，先处理说明再决定首次补做。

后续模型和它产生的工具步骤保存补做来源，公开快照只给出严格 UUID 形状的 `repair.sourceModelStepId`。工具列表可见性、已加载组、取消、项目授权、目标保留／跳过、修订冲突、放行档位与付费确认仍走原 `performTool`／`toolFence` 链；来源标记不是批准，付费操作沿原放行／确认规则执行，需要确认时仍等待，拒绝后不会派发。

压缩时将冻结补做消息从模型往返中单独标为 pinned，防止旧回复被裁剪时同时丢掉补做条件；不会复制成多条消息。同一步骤同时具有重规划与补做标记时，真实执行和说明容量探测均保留两条通知，并一起 pinned，不丢掉重规划事实。原有 intent 仍完整旁路；执行循环与说明容量检查中用于复制基础上下文的步骤仍是纯 clone，压缩只在完整 fragments 装配时运行。

## 5. 首轮请求字节与 H1e 缓存取舍

99 条指纹已经连续预览两次（33.89／27.37 秒），逐条稳定；87 条非诊断请求改变，12 条诊断的字节数与 SHA-256 全部不变。逐条旧／新字节与哈希见 `validation/early-validation/fingerprint-difference-review.json`。复核后仅执行一次 `--update`，21.68 秒 exit 0；更新后正式 99 条验证 21.27 秒 exit 0，逐条等于两次预览。fixture SHA-256：`cd2ef13a6637c4dd8540aeb4ce8a2e4f47a0eee35ba00388efae0e3988377e26`，原 main 为 `21d3a000a1e57085a19f25d0ca27fef2d97c0690a0eced8ee3dc2326ca90d4b0`。下列增量均相对 main。

| 请求类别 | 每协议条数 | Chat Completions 增量 | Responses 增量 | Anthropic Messages 增量 |
| --- | ---: | ---: | ---: | ---: |
| 普通简体场景（含后续读改、历史、冲突等请求） | 20 | +3039 B | +3026 B | +3010 B |
| 官方预设简体场景 | 5 | +3054 B | +3041 B | +3010 B |
| 英文（单次与附件） | 2 | +3122 B | +3109 B | +3093 B |
| 繁体单次 | 1 | +3048 B | +3035 B | +3019 B |
| 日文单次 | 1 | +3251 B | +3238 B | +3222 B |
| 诊断 | 4 | 0 B | 0 B | 0 B |

基础增量来自新增核心工具及简体目标系统指令：三协议新增 wire 工具的请求贡献分别为 2887／2874／2858 B（各含数组分隔逗号 1 B），根系统提示均为 152 B。英文、繁体、日文分别相对基础增加 83／9／212 B；其中新增工具的本地化字段分别增加 38／3／123 B，根系统提示增加 45／6／89 B。官方 OpenAI 的两种协议另增加 15 B，来自新增工具沿用的 `strict:false` 元数据。所有后续请求均与所在类别保持同一增量；未出现额外历史、恢复或用量请求差异。

独立反事实审计在相同 configuration、已存 history 和实际工具集合上，仅移除 goal 定义并经同一 builder 重建：99 条 control 请求逐条字节数／哈希与 main fixture 完全相同，actual 则逐条等于两次预览。结构仅新增目标提示与工具定义，所有缓存断点位点保持相同，官方 Anthropic 核心仍以 loader 为末项；没有保存 body、history 或密钥。证据为 `tool-integration/fp-counterfactual-audit.json` 与 `fp-counterfactual-review.md`。

目录将新工具放在核心 loader 前，保留 `mioon_tools_load` 为实际核心末项，沿用 H1e 官方 Anthropic 的核心／全工具／系统／末条消息断点，仍最多四个，兼容端点不新增断点。新增核心定义和系统文字会改变升级后的候选前缀；加载组、较早历史压缩、概况变化的失配边界仍按 H1e 处理，不因本期 pinned 消息承诺真实服务端命中。

同一冻结补做消息重放内容确定；在下一次压缩阈值之前追加较小往返，三协议仍共享已构造前缀。跨越压缩阈值后较早历史仍可能改变，pinned 只保证消息保留一次，不声称整段请求永远共享前缀。本期不调整断点数量、TTL、概况位置或供应商策略，也不调用真实模型验证缓存。

## 6. 验证与基线

下表是开发阶段已经实际完成的定向记录，不等同于最终冻结源码的全量验收。环境为 Node 24.21.0、UTC、真实 TMPDIR 与 scoped `caffeinate -i`，测试原期限保留。

最终测试快照为 `31b4ee0a1f5dbce517a59e719f4f72cffd12e0105b2461fd165fc0ade297a9b4`（6094 个源文件、966 个测试文件）；production 摘要为 `c76cf01aa7851faff97a968ea30c0633c9fb1e7883a6eb11e349f819bb4eeb38`，测试摘要为 `7a16e5362a92cb705c7dcc9fef4138e8242a8a90267464427c26c07ed4abb527`。验证报告后续补录独立于被测源码。完整 FFmpeg 使用 H0 固定镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`，Linux arm64、Node 24.21.0、pnpm 11.25.0、FFmpeg n7.1.5、GNU tar 1.34；原生执行严格编译及开发构建。锁文件沿用 main 的 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。

| 开发验证 | 已确认结果 | 覆盖与证据 |
| --- | --- | --- |
| 目标规范化、纯比较、真实宿主检查 | 初次 13/13；导出范围修正后 14/14，7.849 秒 | `goals/unit-final.tap`；范围回归先红 `export-range-red.tap`，修后 `export-range-green.tap` |
| 新宿主工具＋原工具分组＋H1e 缓存 | 23/23，16.003 秒 | 新 goal-tool 7、原分组 9、原缓存 7；`tool-integration/targeted.tap` |
| 三协议运行时／恢复 | 开发原 33/33，双标记 3/3，成功闭环 3/3；最终冻结 39/39，60.49 秒 | 开发 `validation/root-development/` 三份原件；最终 `validation/full-final-root39/candidate-agent-task-goal-repair-v2.test.ts.tap` |
| 三协议压缩／前缀 | 3/3，2.003 秒 | `validation/root-development/mioon-h4a-context-tests.tap` |
| 检查 transport／CLI 兼容 | 9/9，10.946 秒 | 新 CLI 隔离回归先红 1/1，再整文件绿；`tool-integration/cli-requirements-{red,green}.tap` |

23 项含 16 项既有测试，不能写成 23 项新增。最终冻结全量中，四个新文件 63/63（14＋7＋39＋3）全部通过，其中运行时／恢复整文件 39/39、60.49 秒；既有 checks transport 9/9 包含新增兼容用例。因此本期新增 64 项已全部通过，不与开发阶段多次执行重复相加。全仓其余队列和最终具名对照继续单列。

| 最终门槛 | 状态 |
| --- | --- |
| 源码快照、锁文件／生成 schema 未改证明 | 通过；primary／native／Linux 三份 6094 源文件零漂移，锁文件及生成的业务 RPC schema 未改 |
| 99 条指纹连续稳定、逐类审计、正式验证及 fixture 哈希 | 通过；87 条预期改变，12 条诊断字节／哈希均不变，见第 5 节 |
| harness 聚焦回归与起始 main 基线的具名对照 | 最终全量中派生 74 文件，1379/1379 通过、0 跳过；20 份历史逐文件参考对比已校验，完整具名结果另列 |
| 全量测试、历史具名基线与跳过变化 | 原始 966 文件完整执行，961 文件 exit 0／5 文件非零；15,232 通过＋4 失败＋4 取消＋22 跳过。候选五文件补验 31/31 通过，原始记录保留；具名／跳过差异见下文 |
| 两项指定完整 FFmpeg 用例的固定 Linux 镜像验证 | 通过；runtime 185/185、0 跳过，指定两项分别为 TAP 的 `ok 64`／`ok 66` |
| 严格类型检查与 development build | 最终 `31b4ee0a…` 源码：TC 5/5，62.91 秒；开发构建 exit 0，156.51 秒，三套 strict 与 Web/Desktop 均通过 |
| 成对容量／请求字节／落库字节与行数 | 六对均完成；三协议 stress30 均完成预算内 30 步，配额行数不变，见下表 |

失败、取消、超时及补跑必须保留原始结果，按测试名区分本次回归、既有问题和环境证据；不延长原 deadline、不以新增 skip 或补充结果覆盖原始失败。

根代理开发命令为 `caffeinate -i env TZ=UTC <Node24.21.0> --test tests/agent-task-goal-repair-v2.test.ts`、`--test tests/agent-task-goal-repair-context-v2.test.ts`，以及修复双标记后带 `--test-name-pattern=marker_replan` 的定向补验。`<Node24.21.0>` 为 `/Users/kouzen/.npm/_npx/538786c08bcb9442/node_modules/node/bin/node`。开发期失败原件保留在同一 `root-development` 目录：合成 Responses 输出未保留文本使压缩测试没达到阈值、模拟 provider 未传入本地 DB、恢复组合在 interrupted 状态错误地提交说明；分别修正合成输出、provider fixture 和 resumed-but-not-launched 的组合状态，不改变生产期限或校验。

正式编译命令为 `caffeinate -i <Node24.21.0> --test --test-reporter=tap --test-concurrency=1 tests/typecheck-runtime.test.ts`，保持 compiler 子进程 240 秒、父用例 270 秒（均为上游 #76 已有设置）；开发构建为 `caffeinate -i <Node24.21.0> scripts/tooling.ts build --channel=development`。全量按每文件一个进程执行，16 个重文件独占，之后 shared 2，原文件 600／外层 630 秒上限和用例内部期限均保留。

具名参考不是一次 fresh main 全量：#78 CI 实际检出 `91310eb6…`，957 文件、15,129 项（15,107 通过／22 跳过），其 tree 与最终 main 不同。对 main `9ae9b87` 另外实际运行新增的 5 个 H1e 文件及修改的 3 个共享文件，8/8 文件、152/152 项全部通过，其中编译 5/5 为 84.22 秒。组合时精确替换原共享 83 项、追加新增 69 项，最终参考为 15,198 项（15,176 通过／22 跳过）；保留 CI 原始视图及 scope，未以目录相同冒充源码相同。证据和重复计数校验在 `validation/ci-reference/main-reference-evidence-manifest.json`。

按层级、原始名称和状态作 exact multiset 对照，组合 main 有 15,185 项完全相同、reference-only 13 项、candidate-only 77 项。后两者拆分为本期新增 64 项全部通过、8 个同名状态变化（4 个 passed → failed，4 个 passed → cancelled，集中于五个非零文件），以及 5 对保留的字面名称差异。22 项跳过的名称身份及理由完全不变。五对文字差异中，三条参考原日志呈现 `***`（不判定由哪一层掩码），两条锁保护测试名插入运行时 `process.pid`；四个相关源文件在 CI 等价树、main 与候选之间逐字节相同。未进行模糊匹配／名称归一化，未将这些差异冒充源码删除或重命名。对原始 CI 另保留 15,116 完全相同、reference-only 13、candidate-only 146 的原始视图，其中包含 main 已新增的 69 项 H1e 测试。

以下八项参考状态均为 passed；`›` 保留原父子层级，不把取消算成通过：

| 精确测试名 | 原始全量状态 |
| --- | --- |
| `actual HTTP, CLI and official MCP expose identical dated profiles and reject complete oversized saved reference` | failed |
| `asset dispositions share exact HTTP, real CLI and official MCP semantics without media work` | cancelled |
| `asset dispositions share exact HTTP, real CLI and official MCP semantics without media work › exact historical replay checks current ownership before exposing a retained response` | failed |
| `competing database connections commit one CAS winner and deduplicate simultaneous exact retries` | cancelled |
| `dedicated preferences HTTP survives a real killed/restarted backend and leaves project/history unchanged` | failed |
| `frames share strict real HTTP, actual CLI and official MCP extraction/recovery contracts` | cancelled |
| `frames share strict real HTTP, actual CLI and official MCP extraction/recovery contracts › bounded pagination and server recreation are read-only and retain immutable original acknowledgements` | cancelled |
| `preferences endpoint retains token/cookie authentication, strict origin/host validation and the 16 KiB body cap` | failed |

完整逐名 attribution、64 项新增的源声明证据及五项未匹配原文字证据见 `validation/ci-reference/candidate-main-comparison-raw-attribution.json`；参考日志不提供文件身份的条目仍保留 `file:null`，不猜测 CI 文件映射。

保留的编译前置失败为初轮 TC 4 通过／1 失败、直接 compiler exit 2：新 goal-tool 测试两处 CLI help 联合类型未先收窄，新 goals 测试两处对只读数组 `.push`。仅修测试的类型收窄与新数组重赋，生产类型未放宽；各自 7/7、14/14 补验通过，最终 TC 5/5。早于最终快照的 root36 队列只执行 TC 5/5（67.46 秒），后续误启动的旧副本构建由本线停止，原件留在 `validation/full-final`；它不是最终全量覆盖，最终唯一队列为 `full-final-root39`。

原始最终队列中素材处置传输文件保留了首个失败：121.87 秒 exit 1，8 通过／1 失败／1 取消，父用例原 120 秒触发，外层文件期限未触发；末项 CLI 在 preload 后收到 SIGTERM。只读初查见前八项总耗时 102.780 秒，而旧 CI 为 51.408 秒，不能据此断言唯一环境或代码根因。全量结束后的 main／最终候选配对结果见下表，首个失败不被补验覆盖。

随后另保留两个原始非零文件：`frame-transports` 为 126.08 秒、5 通过／0 失败／2 取消，父用例原 120 秒触发，分页／服务重启子项被取消；`generation-input-transports` 在第 35 行的原 10 秒服务就绪门槛失败，空 stderr、子进程尚未退出，业务 profile 对比未执行。两者也仅加入全量结束后的同条件 main／候选整文件首轮配对，不调整期限，不提前归因，不以补验替换原始全量。

全量最终于 6308.54 秒真正退出（约 105.1 分钟），966 文件唯一覆盖、无 outer timeout、无缺失／重复；原始结果为 15,232 通过、4 失败、4 取消、22 跳过。另两个非零文件是 `workspace-preferences-http`（1 通过／2 失败，两个首次后端启动原 10 秒失败）与 `workspace-preferences`（9 通过／1 取消，最后含两轮四 worker 的 CAS 用例原 20 秒触发）。HTTP 的业务／鉴权断言未执行；CAS 无阶段日志，不能定位到导入、ready 屏障或 CAS 计算。五个文件均安排 main `9ae9b87` → 最终候选 `31b4ee0a…` 的整文件首轮配对，十条命令串行、无预热或新缓存旗标、原期限不变；asset 原全量为独占，其余四文件原全量为 shared 2，隔离补验不冒充原并发全量条件，也不能覆盖原始失败。

十条补验均已实际完成，候选五个文件共 31/31 通过；main 的素材处置仍触发原 120 秒父期限，其余四个文件通过：

| 整文件 | main 原期限隔离补验 | H4a 原期限隔离补验 |
| --- | --- | --- |
| `asset-disposition-transports` | exit 1，6 通过／3 失败／1 取消，122.17 秒 | exit 0，10/10，109.99 秒 |
| `frame-transports` | exit 0，7/7，75.03 秒 | exit 0，7/7，65.70 秒 |
| `generation-input-transports` | exit 0，1/1，11.16 秒 | exit 0，1/1，9.02 秒 |
| `workspace-preferences-http` | exit 0，3/3，16.20 秒 | exit 0，3/3，13.05 秒 |
| `workspace-preferences` | exit 0，10/10，11.86 秒 | exit 0，10/10，15.47 秒 |

两侧实测 Node 24.21.0／Linux arm64／UTC／临时目录／uid 1000 一致，编译缓存 active／envConfigured／ownerConfigured 均为 false；OS 页缓存冷暖不受控。配对期间曾观察主机 load 73.09、CPU idle 0%、约 126 GB 已用及 20 GB 压缩内存，仅作时点事实，不据此断定唯一根因。没有候选独有的补验失败，不再追加第二轮；原始五个非零文件、main 补验失败及所有取消仍分别保留。

独立审计按 `(file, hierarchy, occurrence)` 验证原五文件与候选补验的 31 条身份完全相同，仅用同源候选完整文件替换，不混入 main 或重复相加，形成补充观察视图：15,262 项＝15,240 通过＋22 跳过。对组合 main 的 exact multiset 为 15,193 完全相同、reference-only 5、candidate-only 69（64 个新增＋五项字面差异），同名状态差异和跳过变化均为 0；原始全量的 4 失败／4 取消仍不变。该视图不是一次重新全绿的 966 文件全量，也不能证明原 shared 2 条件下通过。证据为 `post-full-controls-prepared/verified-summary.json`、`candidate-replacement-manifest.json` 与 `validation/ci-reference/candidate-main-comparison-effective.json`。

聚焦的 74 文件直接取自最终全量，未另跑重复队列；旧 H1e 同 70 文件的 1315 条历史名称全部匹配，0 missing／状态变化／跳过变化，本轮该范围只新增 checks transport 的 1 项；另外四个新文件 63 项，合计 1379/1379 全部通过。20 份历史逐文件对照的原始与补充视图分别保留。

指定完整 FFmpeg 两项均包含于最终 `candidate-agent-task-runtime-v2.test.ts.tap` 的 185/185：`whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`（ok 64），以及 `retained shot keeps a late product without selecting it and never dispatches after reversion`（ok 66）。更新后 99 条指纹另在同一固定 Linux 队列再次通过，54.74 秒。

### 成对容量、用量与前缀

main `9ae9b87` 与最终 H4a `31b4ee0a…` 快照，在 H0 固定完整 FFmpeg Linux 镜像、Node 24.21.0、UTC、真实 TMPDIR、非 root 和断网条件下各执行 legacy／stress30，四个命令分别覆盖三种协议，全部 exit 0（13.701／13.542／14.595／22.092 秒）。两侧只在缓存副本采用同一份测量 helper 观察插桩，实际请求和落库不变；生产源与原测试源、helper 唯一差异及退出清理均有守卫记录。

| 负载／协议 | 请求字节 main → H4a | 模型步骤落库字节 main → H4a | 配额保留字节 main → H4a | 配额行 main → H4a |
| --- | ---: | ---: | ---: | ---: |
| legacy / Chat Completions | 1,501,106 → 1,548,161 | 4,173,720 → 4,226,205 | 6,109,891 → 6,162,376 | 193 → 193 |
| legacy / Responses | 1,502,477 → 1,549,337 | 4,182,174 → 4,234,434 | 6,120,136 → 6,172,396 | 193 → 193 |
| legacy / Anthropic | 1,493,061 → 1,539,456 | 4,165,199 → 4,216,904 | 6,101,296 → 6,153,001 | 193 → 193 |
| stress30 / Chat Completions | 1,322,300 → 1,369,355 | 3,817,970 → 3,870,455 | 6,365,538 → 6,418,023 | 198 → 198 |
| stress30 / Responses | 1,321,405 → 1,368,265 | 3,821,554 → 3,873,814 | 6,370,931 → 6,423,191 | 198 → 198 |
| stress30 / Anthropic | 1,313,779 → 1,360,174 | 3,808,362 → 3,860,067 | 6,355,837 → 6,407,542 | 198 → 198 |

每项都是 15 次模型请求；legacy 另有 14 次工具调用，共 29 步，stress30 有 15 次工具调用，共 30 步且完成。每步历史字节向量两侧完全相同；helper 固定英文、使用官方预设，单请求增量依次为 3137／3124／3093 B，与第 5 节的官方简体增量加英文 83 B 一致。落库为配额 inventory 的 SQLite data 保留字节，不含页／WAL，也不是累计改写量。全 180 个模型步骤的输入、输出、缓存读、缓存写均缺失，覆盖为 reported 0／missing 15 每轮；token 总量和缓存读率为 `null`，没有用 0 代替未知。

两侧 Anthropic 实际每请求均 3 个断点，工具／系统前缀在相邻 14 次比较中 raw 与 content 都是 14/14 相同；内容前缀长度分别为 main 13,938／15,766 B，H4a 16,834／18,859 B。历史当前末端随内容追加均 0/14 相同；在上次边界比较 content，legacy 保留 10/14（4 次边界已不可用），stress30 保留 8/14（1 次改变、5 次不可用），两侧完全一致。历史压缩下降请求分别为 legacy 6／9／12／15，stress30 4／6／8／10／12／14。

无断点对比仅在内存中移除实际请求的合法缓存 metadata，每请求少 111 B、0 个实际断点，加 3 个虚拟观察边界；每轮 45 个内容前缀与实际投影一致。该分析保留了有断点 builder 的消息表示，不能冒充真正的无断点请求，也不代表服务方缓存 key、实际命中、费用或 Haiku token 门槛。原始向量、全表和语义限制在 `measurements-final/final-measurement-vectors.json` 与 `measurement-review.md`；派生脚本初次错用简体增量的失败另行保留，修正期望后没有重跑或覆盖原始测量。

## 7. 跨轮要求与补做结果：后续建议，本期不实施

目标声明和补做标记只影响当前运行。下一轮仍使用已有用户原话、补充说明、已回答问题、最终回复与执行记录／Changes 等历史投影；本期不增加跨轮 goals、requirements 或 repair 字段，不把上一轮声明自动升级为下一轮约束。

后续若要让模型知道“上一轮要求与补做结果”，建议由宿主从已验证条件、最终检查及补做来源生成有硬字节／条目上限的摘要，说明哪些完成、等待或未完成及是否补做过。摘要随对应原话按整轮保留或删除，沿用确定性投影与各类省略计数，不单独悬挂残余条件，不传原始私有请求、供应商错误或完整工具结果。

摘要必须在四语中标明仅供参考，不是当前要求、权限或确认；新的用户意图和本轮新声明仍决定当前目标。具体预算、裁剪优先级与缓存前缀影响应先独立设计和验证，再实施；本期只记录建议。

## 8. 首轮停止点

H4a 实施与本地验证已完成，原始全量的五个非零文件及隔离补验结论均已说明。本期停在待用户复核状态，没有提交、推送、创建 PR 或调用真实供应商；未进入 H4b，未实施目标跨轮记忆。

## 9. 审查修订与同步 main

审查后按授权修正两项条件语义：时长在容差帧数外叠加半帧和极小 epsilon；三种数量统一使用 `min`／`max`，至少提供一边，恰好等于用相等的上下界。工具 schema、规范化、expected 与实际运行用例同步，时长不额外扩展上下限。原始全量、失败与隔离补验仍保留在前述首轮记录。

本轮先创建 H4a 提交 `a2a6f353031ae4f24eaf22f65af5953f88576ed0`（暂不推送），随后 fetch 并以 merge commit `a9fb2f7ee58f1aaf3d2fe486f969d5597d29a96a` 合入最新 main `f7dabcce37fea89c06f900b9da9f4878187c6af6`，不 rebase。该 main 包含 #79、#80 及已合入的 #81（片段变换框，非本期 H4b）。`task-tools-v2.ts` 自动合并，无冲突；检查合并 diff 确认完整保留 `timeline.clip.setTransform` 的 Mio 禁用边界和 H4a 宿主目标工具。另在原目标工具用例中加入 public schema 仍有变换操作、Mio admission/list/prepare 拒绝它、目标工具保持核心只读的组合断言。

同步后复核 99 条指纹（12 条诊断预期不变），再明确 `--update`，重跑类型、开发构建和 harness 回归；本轮全量由 PR CI 执行。后续现行验证结果另列，不沿用首轮结果充当本轮通过。

提交前定向验证：条件与实际检查 18/18（包括 1,200 个 0.1–120 秒时长点及真实三字幕上下限）；工具／运行时／上下文／transport／分组五文件 70/70，其中补做运行时为 42 项。证据分别为 `mioon-harness-H4a-review-conditions/goals/` 和首轮证据目录下 `review-fix-count-range/`，原失败／先红后绿记录均保留。

为使首个提交的 fixture 与 schema 一致，在同步前先作两次安全 metadata 预览：99 条稳定，87 条非诊断相对首轮 H4a 各增加 738 B（三种数量分支各增加 246 B），12 条诊断字节／哈希均不变。复核后显式 `--update` exit 0（24.41 秒），99 条与两次预览逐条一致，新 fixture SHA-256 为 `9172b11e76500614ac370aa638a06d6de0f82e14cb3a4da32c89b5decf78116f`。同步后的对 main 正式复核与验证继续另记；不以本次预提交采样替代。

合并后冻结源码 `be77c24f3195d88dcb0b4d87e8f5711814ffceeae47cbcf83dcc3fb96c66cf9a`（6117 源文件、971 测试文件；本轮不执行本地全量），包括原目标工具用例中的合并边界断言。Node 24.21.0／UTC／真实 TMPDIR／`caffeinate -i` 下，完整类型检查 5/5、83.17 秒；开发构建 exit 0、159.50 秒，三套 strict 与 Web/Desktop 均通过。

合并后两次 99 条预览逐条一致，且全与预提交 `9172…` 相同。对合入 main 的 `21d3…` fixture，87 条非诊断改变、12 条诊断字节和 SHA-256 全部不变；复核后再次明确 `--update`（幂等、24.58 秒），正式 99 条通过（22.08 秒）。独立一次真实 intent 反事实审计证明：actual 99 条等于 `9172…`，同 builder 移除 goal 后的 control 99 条等于 main 的 `21d3…`；缓存锚点、历史／恢复／用量部分没有额外差异。

| 现行请求类别 | 每协议条数 | Chat Completions 对 main 增量 | Responses 对 main 增量 | Anthropic Messages 对 main 增量 |
| --- | ---: | ---: | ---: | ---: |
| 普通简体场景 | 20 | +3777 B | +3764 B | +3748 B |
| 官方预设简体场景 | 5 | +3792 B | +3779 B | +3748 B |
| 英文单次／附件 | 2 | +3860 B | +3847 B | +3831 B |
| 繁体单次 | 1 | +3786 B | +3773 B | +3757 B |
| 日文单次 | 1 | +3989 B | +3976 B | +3960 B |
| 诊断 | 4 | 0 B | 0 B | 0 B |

相对第 5 节首轮的唯一区别是三类数量 schema 各增加 246 B，合计每个非诊断请求增加 738 B；半帧比较改变的是判定语义，不改变时长工具参数。语言差异仍为英文 +83／繁体 +9／日文 +212 B，官方 OpenAI 两协议的 `strict:false` 仍另加 15 B。当前与 main 的模型目录除新增核心 goal 外完全相同（核心 16 → 17），公共 RPC schema 145 项及生成哈希与 main 相同；新变换操作保留公共接口、对 Mio 禁用。所有源码／目录和元数据证明在新证据目录 `/Users/kouzen/Library/Caches/mioon-harness-H4a-sync-2026-10-29/` 的 `postmerge-native-preview/`、`independent-audit/` 与后续聚焦结果内。

以上为同步到 #81／`f7dabcc` 的独立快照。聚焦队列执行期间主线又合入 #82／`c4fead2`（C8 v2），直接改变同一工具目录、契约和请求 fixture；因此暂停旧 102 队列后续派发，在途文件按原期限自然结束并保存为 pre-#82 记录，不将未完成队列写成通过。随后继续以 merge commit 同步新主线，最终验证以该新基线另记；已完成的类型、构建与指纹结果均不冒充覆盖 #82。
