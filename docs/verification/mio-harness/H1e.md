# Mio harness H1e · 模型缓存与用量

日期：2026-10-29（Asia/Taipei）。开工 fetch 后从最新 `origin/main`（`4a52403f8a89bb3e665cb1699d8984a896de9b1e`，已含 H1d／H3b／C13a）建立 `codex/mio-harness-h1e`。复用已附加且干净的 managed worktree `/Users/kouzen/.codex/worktrees/mio-harness-h1d/mioon`，保留目录名，不改主 checkout。仅实施 H1e；离线交付时未调用真实模型，后续授权的兼容复测见第 7 节；没有提交、推送。

证据目录：`/Users/kouzen/Library/Caches/mioon-harness-H1e-2026-10-29/`。本报告在最终源码快照外，供验证结束后补录；其余源码、测试、fixture 和文档纳入冻结检查。

## 1. 实现范围

- `task-cache-v2.ts`：官方 Anthropic Messages 的确定性工具排列和最多四个显式 5 分钟缓存断点。仅构建新请求时运行，不改恢复原件。
- `task-usage-v2.ts`：三协议私有用量的可选字段、累计快照解析和安全整数规范化。
- `task-gateway-v2.ts`／`anthropic-stream.ts`：三种 SSE 接入；Chat Completions 在空 choices 用量帧之前读取计数；Responses 从完成响应读取；Anthropic 从 start／delta 累计。旧聊天的默认严格 Anthropic 校验保留，任务模式允许缺失计数，继续拒绝思考／供应商托管工具等未准入能力。
- `task-runtime-v2.ts`：完成模型步骤时只把规范化用量附入已有私有 result；不改 H2 流式写入、状态机、授权、原 intent 或未知结果规则。公开快照、事件、HTTP／SSE 与 CLI 保持原投影。
- 两个测量 helper 与五个新测试文件，覆盖缓存边界、真实 SDK 精确 body、用量、运行时与公开隔离、聚合和前缀统计。更新执行文档；没有新增生产依赖、表、schema、迁移、公共接口或界面。

## 2. 策略与官方依据

缓存同时要求 `presetId=anthropic`、Messages 协议及官方 `https://api.anthropic.com` 根地址。预设允许用户修改地址，因此不能仅依赖预设 ID。MiniMax、自定义端点及伪装成官方预设的兼容地址均不添加断点。核心工具先排列，再按固定工具组顺序追加；组内沿用目录顺序。断点为核心末尾、全部工具末尾、系统末尾、末条消息最后一块；重合去重，核心请求通常三个，加载组后最多四个。仅操作协议 metadata，不递归改写 schema、工具参数或工具结果中的同名业务字段。

Anthropic 的前缀顺序是 tools → system → messages；显式断点写缓存，后续可查找此前写入的边界。核心断点提供工具组追加后仍相同的核心候选前缀；官方同时规定工具定义变化会使下游缓存失效，因此离线同字节不证明服务端跨工具集命中。系统断点提供 H1c 反复压缩历史时仍可复用的静态边界。末尾消息断点覆盖每次增长的历史，但 H1c 改写较早往返后，其后的旧缓存前缀失效；H1d 概况仍放在历史之后，概况变化不改动更早的历史内容，也不为缓存移动其位置。四断点预算不再给概况前额外加第五点。5 分钟 TTL、模型最小 token 门槛及 20 块查找窗口都需真实服务方验证。依据：[提示缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[工具与缓存](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching)。

私有 `result.usage` 的四字段为 `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`。输入统一表示含缓存的总输入；Anthropic 仅在未缓存输入、缓存读、缓存写均已报告时求和，其他协议直接读取总输入，不再加缓存数。字段缺失／无效保持未知，明确报告的零保留。流式事件为累计快照，按字段保留最后有效非递减计数，不逐帧累加；这仅证明计数被报告，不代表服务方提供了完整结算。旧记录缺字段或有畸形可选 metadata 不触发存储故障。

末尾消息断点在概况之后，跨轮概况改变时，其累积前缀也可能失配；保住更早历史文本，不等于已在该处写入可读缓存。本期将有限名额优先给核心／全工具和静态系统，以保留 H1c 重复压缩期间的静态候选；不新增概况前的第五点，也不移动 H1d 概况来改变上下文语义。容量表是单轮负载，不声称验证了跨轮历史的真实命中。中断／失败且未形成模型完成回执时，本期不生成用量结果，测量仍标为未知，不能据此作完整费用结算。

主动请求 Chat Completions `stream_options.include_usage` 仅限有官方依据的预设及官方端点：OpenAI `api.openai.com/v1`、DeepSeek `api.deepseek.com` 根地址或 `/v1`、Qwen 北京／新加坡固定 `/compatible-mode/v1`。未取得明确端点依据的 Qwen 工作空间及其他预设保持被动解析。OpenAI／Qwen 可在末尾提供空 choices 用量帧，流中断时不保证收到；DeepSeek 的终末内容帧本身也可带用量。Chat Completions 没有通用缓存写计数，保持缺失；DeepSeek `prompt_cache_miss_tokens` 是未缓存输入，不能冒充写入。Responses 读取 `input_tokens_details.cached_tokens / cache_write_tokens`。依据：

| 协议／预设 | 官方依据 |
| --- | --- |
| Chat Completions / OpenAI | [Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) |
| Chat Completions / Qwen | [Streaming](https://www.alibabacloud.com/help/en/model-studio/stream) |
| Chat Completions / DeepSeek | [Create chat completion](https://api-docs.deepseek.com/api/create-chat-completion/) |
| Responses | [Response usage schema](https://developers.openai.com/api/reference/resources/responses/methods/retrieve) |
| Anthropic Messages | [Streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)及上表提示缓存文档 |

## 3. 验证与基线

原始全量冻结源码 SHA-256：`dc10f418b0dcdaffefe23868d7f70b351d24f5d2cbf8614db7391d0ac6423288`，6054 文件、955 顶层测试文件。构建清单使用不同 JSON 聚合算法（`07af265f…`），6054 个路径／文件哈希与完整测试快照逐项完全相等。`caffeinate -i node scripts/tooling.ts build --channel=development` 实际 exit 0，158.36 秒，含三个严格类型项目和 Web／Desktop，前后所有源码哈希不变。证据 `build-final.json`、`build-final-source-before/after.json`、`final-source-build-equivalence.json`。

本机原始完整 955 文件已实际执行结束：946 文件 exit 0，9 文件非零；15131 个具名观察为 15091 passed、17 failed、1 cancelled、22 skipped。没有 600／630 秒整文件超时、遗漏或重复，6054 个冻结源零漂移。driver 实际 exit 1，5536.38 秒（wrapper 5536.59 秒），包含下述 195.06 秒文件边界等待，不作性能收益比较。16 个重文件独占串行，优先 maxmix／compiler，其余共享并发 2；原独占名次与实际名次分别记录，测试内部 deadline 与跳过策略均不变。完整实际 Docker 命令／TAP SHA／退出码见 `full-final/candidate-results.json`、`candidate-suite-command-result.json`。

同一次原始全量的 harness 67 文件 **1281/1281 passed**，无跳过：旧 52 文件 1112 名、main 的 H3b 五文件 59 名、本期五文件 68 名、额外共享 Anthropic 五文件 42 名。与旧 H1d 同步聚焦的 1112 名全部匹配、状态无变化；H1c／C8c 聚焦的 837 名也全部匹配且通过。没有把小范围参考之外的名称当成新增回归。正式 99 指纹文件 actual exit 0（62.77 秒）；runtime 整文件 **185/185 passed**（250.85 秒），两项指定完整 FFmpeg 用例均实际 passed，未跳过：

- `whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay`
- `retained shot keeps a late product without selecting it and never dispatches after reversion`

上述覆盖直接由原始全量完整 TAP 派生，不是额外执行；固定镜像、Node／FFmpeg 版本、完整命令与源哈希绑定在 `full-final/runtime-required-media-evidence.json`、`focused67-derived-results.json`。

原始非零文件分别为：

| 文件 | 实际结果 | 原始失败类别 |
| --- | --- | --- |
| `typecheck-runtime.test.ts` | 4/5，135.96 秒 | genuine compiler 子进程原 120 秒 ETIMEDOUT，无 TS 诊断 |
| `agent-edit-wire.test.ts` | 32/37，377.48 秒 | 5 项原 12 秒 backend readiness |
| `agent-timeline-gain-wire.test.ts` | 35/37，334.06 秒 | 2 项原 12 秒 backend readiness |
| `agent-chat-durable-crash.test.ts` | 3/5，99.25 秒 | 2 项原 15 秒 backend readiness |
| `agent-edit-wire-lifecycle.test.ts` | 10 passed＋1 cancelled，16.62 秒 | startup parent IPC 用例原 15 秒 test timeout |
| `agent-timeline-move-wire.test.ts` | 27/31，329.72 秒 | 4 项原 12 秒 backend readiness |
| `export-preview-media.test.ts` | 4/5，13.16 秒 | 全库快照断言：queued 导出被 worker 接手后改变 |
| `integration.test.ts` | 父项 failed，13.01 秒 | 后端原 10 秒启动门槛；8 个子用例尚未注册执行 |
| `transport-utf8-output.test.ts` | 3/4，0.88 秒 | 本期新增 CLI 文本消费点漏登 QA 清单 |

最后一项是本期测试登记遗漏，不能归因资源。两个 CLI listener 已正确在注册处 `setEncoding('utf8')`；全量结束且自有进程排空后，仅给现有 `textSites` 加一行新文件计数 2，没有豁免文件或削弱守卫，原守卫继续逐 listener 逐字节注入 Unicode。最终源码为 `7edef24576c19c3c2a84cb6972ef017bfb59b87921e513313826723e162c62e5`，仍为 6054／955；与原始全量严格只有该测试文件一行差异，其余 6053 文件（含全部生产代码、测量 helper、指纹）逐字节相同。原快照和原失败 TAP 不改，证明见 `final2-only-test-inventory-diff.json`。

最终原生三个整文件串行实际通过：UTF-8 守卫 4/4（2.85 秒）、H1e runtime 15/15（23.87 秒）、`typecheck-runtime` 5/5（79.46 秒，首用例实际串行编译 foundation／browser／tests 三严格项目），合计 24/24。均使用 Node 24.21.0、UTC、真实 TMPDIR、scoped caffeinate，原用例及 120／150 秒编译期限不变。6054 源前后不变且与最终快照精确同源，见 `native-final2-validation/results.json`、`source-equivalence.json` 及三个独立 TAP。没有为一行测试清单登记再执行 955 文件，也不把补充覆盖说成原始 Linux 全绿；生产构建输入与已通过的 158 秒构建完全相同。

预览断言的只读排查确认仅 `exports` 与对应目标修订改变：queued→failed、`MANAGED_SOURCE_INVALID`、revision 8→10。测试第 4 个 corruption 分支临时恢复 queued 状态，真实 worker 每 200 ms 接手；fixture 未写原 PNG 源文件，running／failed 两次写入与实际差异吻合，预览 404 断言已通过。十个相关文件与 main4a 逐字节一致；这只是 worker 竞态的源码证据，是否在 main 复现以实际配对为准，不改 C8 源码或测试。证据 `export-preview-triage/`。

九个文件的 pristine main／最终候选整文件配对已完成：18 次真实执行，固定镜像、原期限、main→candidate 逐文件串行；除 compiler 外其余八文件两侧全部通过。driver／wrapper 实际 exit 1，1312.20 秒，失败为两侧 compiler status 137。main 为原始 4a 的 6046 源，绝不使用容量测量的 helper overlay；候选为上述唯一 QA 登记后的最终版本。两边源前后零漂移。

| 整文件 | main 秒／结果 | 最终候选秒／结果 |
| --- | --- | --- |
| `typecheck-runtime.test.ts` | 77.77 / 4/5（137） | 77.38 / 4/5（137） |
| `agent-edit-wire.test.ts` | 173.41 / 37/37 | 185.71 / 37/37 |
| `agent-timeline-gain-wire.test.ts` | 169.26 / 37/37 | 220.75 / 37/37 |
| `agent-chat-durable-crash.test.ts` | 26.67 / 5/5 | 26.38 / 5/5 |
| `agent-edit-wire-lifecycle.test.ts` | 3.40 / 11/11 | 3.52 / 11/11 |
| `agent-timeline-move-wire.test.ts` | 133.91 / 31/31 | 138.47 / 31/31 |
| `export-preview-media.test.ts` | 5.46 / 5/5 | 5.92 / 5/5 |
| `integration.test.ts` | 28.66 / 9/9 | 27.63 / 9/9 |
| `transport-utf8-output.test.ts` | 1.36 / 4/4 | 1.38 / 4/4 |

compiler 配对中的 137 与原始全量的 ETIMEDOUT 是不同错误，均保留；本次没有 TS 诊断，不能由当前容器的资源计数反推此前 137 的唯一原因。Linux compiler 门槛仍未通过，原生同源 5/5 的补充不能冒充 Linux 通过。启动超时／取消在此次原门槛候选整文件中均未复现；预览快照竞态此次两侧未复现，不因此抹掉原始断言。integration 两侧均真实执行父项和 8 个子项，9/9 通过，补回的 8 个观察不是新增测试或给未执行项记通过。

| 观察视图 | 文件 | 具名结果 | passed | failed | cancelled | skipped |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 原始完整 Linux | 955 | 15131 | 15091 | 17 | 1 | 22 |
| Linux 整文件补充组合 | 955 | 15139 | 15116 | 1 | 0 | 22 |
| 再以原生 TC 整文件替换的跨环境组合 | 955 | 15139 | 15117 | 0 | 0 | 22 |

组合视图只替换有实际完整 TAP 的对应整文件，不双计其余通过项，不使用 main 控制结果替代候选，也不隐藏原始失败。第三行组合了原始全量、最终单测试登记后的 Linux 补充及同源原生 TC；不是第二次 955 全量，更不是 Linux 全绿。`supplemented-replacement-manifest.json` 将每个来源、实际命令／退出／TAP SHA／源哈希及唯一测试变更证明绑定；`post-full-controls-prepared/linux-controls-results.json` 保存完整原件。

前两项中 maxmix 6/6 通过；Linux compiler 文件 4/5 通过，首项触发原 120 秒子进程期限 `ETIMEDOUT`，没有 TS 诊断，原件保留。随后执行链路文件完整 32/37 通过，五项为原 12 秒 owned-backend readiness 超时，没有取消或外层超时。只读观察时主机 CPU 空闲 0.48%，另一个工作树正在并发 4 跑 65 个文件，并有 Unity／IDE 负载；这不是唯一根因证明。本线只关闭后续派发，当前文件自然收尾，未停止任何其他进程。用户随后明确要求“继续并发，保留原测试期限和所有失败”，据此恢复原队列；这次实际调度包含已授权的资源竞争，不把原失败覆盖为通过，也不据此自动归因。暂停／恢复和用户覆盖记录在 `full-final/manual-dispatch-control-history.ndjson`。

具名基线另取得 H1d PR #70 的八个成功 CI job 完整日志（16 段 TAP）：15012 项＝14990 passed＋22 skipped，逐段 footer 与完整层级名称计数对账通过。CI 真正 checkout 为 merge-ref `e9a7a5a9ce0b32e8a4d4c96e1da410895781ae40`，Git Data 的 tree `f1358da713e0ddc4ad46f0f551bdc38fb81f8c0b` 与 PR head `8116a6a…` 相同；不是直接执行 head 的表述。945 文件及目录哈希由八份日志的实际 shard header／选中数证明；当前 main 950，比该参考多五个 H3b 文件。CI 多文件 TAP 没有可靠文件身份，因此按完整名称及 multiplicity／状态／跳过原因比较，不伪造文件映射；H0 等历史逐文件结果另行比较。`ci-reference/` 保存原始日志、分段、SHA、GitHub 原响应和解析完整性记录，不称为独立跑过最新 main 的全量。

### CI 具名 multiset 对照

CI 没有可靠文件身份，以下“精确键”同时包含完整层级名称、状态、跳过原因和 multiplicity，不能与下表只按名字匹配的计数混同。原始 955 的精确键匹配 14981；参考独有 31＝18 状态变化＋5 字面差异＋8 未执行子项，候选独有 150＝18 状态变化＋5 字面差异＋127 新名称（main H3b 59、本期 H1e 68）。源／原 TAP 核实 integration 的 fixture 启动失败发生在注册八个子项之前，不归因为删源。

| 候选观察视图 | 同 CI 945 目录的名数 | 精确键匹配 | 参考／候选各自剩余 |
| --- | ---: | ---: | --- |
| 原始 Linux | 15004 | 14981 | 参考 31／候选 23 |
| Linux 整文件补充组合 | 15012 | 15006 | 各 6：5 字面＋compiler 状态差异 |
| 原生 TC 补充组合 | 15012 | 15007 | 各 5：只剩字面差异 |

五对字面差异中三处 CI 原文含 `***`，不臆断具体掩码来源；两处为运行时 PID。相关声明源在 CI 等价 head、main4a 和候选逐字节相同，仍坚持 exact unmatched，不替换字面或推造文件归属。报告不输出潜在敏感字面，完整路径哈希／源行／匹配次数保存在 `ci-reference/candidate-comparison-raw-attribution.json`。

两个有效视图由独立脚本重新核验每个实际 TAP、命令、退出、来源 lane、sourceguard 与唯一 QA 变更证明：Linux 组合为 946 个原 dc10 文件观察＋9 个最终 Linux 补充；跨环境组合为 946 原观察＋8 Linux＋1 原生 TC，main 控制一律不参与候选替换。原始结果未修改。证据 `ci-reference/candidate-comparison-effective-{linuxOnly,crossEnvironmentNative}.json`、`candidate-comparison-effective-attribution.json`。补充后的八个 integration 子项均由真实候选 TAP 取得 passed，不借名字算术补通过。

### 历史具名比较

按“相对文件＋完整 TAP 层级名称＋同名序号”逐项比较 15 个独立标记的历史参考。匹配／缺失列为原始→补充，状态变化列依次为原始全量／Linux 补充／原生 TC 组合；“参考外”不等同本期新增，聚焦参考尤其不能推作全量。

| 参考 | 参考名数 | 匹配：原始→补充 | 缺失：原始→补充 | 参考外名称（补充） | 状态变化：原始／Linux／原生 |
| --- | ---: | ---: | ---: | ---: | ---: |
| H0 | 14540 | 14479→14487 | 61→53 | 652 | 18／1／0 |
| H1a | 14575 | 14520→14528 | 55→47 | 611 | 18／1／0 |
| H1a＋43c9 main | 14606 | 14557→14565 | 49→41 | 574 | 18／1／0 |
| H1b 0432 原始 | 14660 | 14639→14647 | 21→13 | 492 | 22／5／6 |
| H1b 0432 有效 | 14660 | 14639→14647 | 21→13 | 492 | 18／1／0 |
| H1b 有效＋main 32 聚焦 | 14660 | 14639→14647 | 21→13 | 492 | 18／1／0 |
| H1b＋main＋C7/UI | 14685 | 14664→14672 | 21→13 | 467 | 18／1／0 |
| H1c 原始 | 14732 | 14711→14719 | 21→13 | 420 | 17／0／1 |
| H1c 有效 | 14732 | 14711→14719 | 21→13 | 420 | 18／1／0 |
| H1c/C8c 37 文件聚焦 | 837 | 837→837 | 0→0 | 14302 | 0／0／0 |
| H1c 有效＋C8c 聚焦联合 | 14776 | 14755→14763 | 21→13 | 376 | 18／1／0 |
| H1d 原始 Linux 930 | 14859 | 14837→14845 | 22→14 | 294 | 43／30／31 |
| H1d Linux 补充 | 14859 | 14837→14845 | 22→14 | 294 | 17／0／1 |
| H1d 原生补充组合 | 14859 | 14837→14845 | 22→14 | 294 | 18／1／0 |
| H1d 同步后 52 文件聚焦 | 1112 | 1112→1112 | 0→0 | 14027 | 0／0／0 |

全部 15 参考的已匹配跳过名称／状态／理由变化均为 0，没有用新增 skip 规避失败。H1b 原始参考补充后的 5／6 个变化、H1d 原始参考的 30／31 个变化均是旧失败或取消转通过；H1c 原始参考的原生 1 个变化同样是旧 compiler 失败转通过，不能算新回归。最新 H1d 同步聚焦 1112 名与 H1c/C8c 聚焦 837 名保持全匹配／全通过。

integration 的 8 个未执行子项在真实补充后恢复，故具名总量由 15131 增至 15139，所有参考的对应缺失减少 8（聚焦范围不含该文件的参考除外）。剩余历史未匹配按原身份保留，没有改写 PID、来源名称、schema 版本或模糊匹配来凑成零；具体列表、状态方向及各参考的实际覆盖范围见 `full-final/supplemented15-name-comparison.json`。本期只新增五文件 68 名，未删改既有测试标题。最新 CI 的字面／未执行差异另按无文件身份的 multiset 比较，不与这张逐文件表混用。

环境沿用 Node 24.21.0、pnpm 11.25.0、UTC、真实 TMPDIR、scoped `caffeinate -i`。原生 `CI=true pnpm install --frozen-lockfile` 实际 exit 0（0.66 秒），锁 SHA-256 保持 `429c516aa89649ac5acb2e4313c7087060bf3acbe1f6b9b749685eadde497e5b`。Linux 沿用 H0 固定完整 FFmpeg 镜像 `sha256:32fc444b18573b988300b1bb9ceb7009ae4d9cb2456c382a0353b0c521846de5`，非 root、禁止网络。

## 4. 容量、用量与前缀测量

最终四项双源测量实际 exit 0：main／候选 legacy 17.71／16.63 秒，main／候选 stress30 18.25／19.91 秒。基线使用干净 main 生产源码加同一份测量插桩（仅两个 helper overlay），另标明其源码哈希；不称为原始 archive 的未经修改结果。使用官方预设、UTC 和 controlled 0 ms 流式时钟，三协议均完成 legacy 29 步（15 模型＋14 工具）及 stress30 30 步（15 模型＋15 工具），每轮预算仍为 30。

| 固定负载／协议 | 请求总字节 main → H1e | 配额保留字节 main → H1e | 配额行 main → H1e |
| --- | ---: | ---: | ---: |
| legacy / Chat Completions | 1,452,776 → 1,453,376 | 6,058,501 → 6,059,161 | 193 → 193 |
| legacy / Responses | 1,455,137 → 1,455,137 | 6,069,856 → 6,069,856 | 193 → 193 |
| legacy / Anthropic | 1,444,586 → 1,446,651 | 6,049,695 → 6,052,126 | 193 → 193 |
| stress30 / Chat Completions | 1,273,970 → 1,274,570 | 6,314,148 → 6,314,808 | 198 → 198 |
| stress30 / Responses | 1,274,065 → 1,274,065 | 6,320,651 → 6,320,651 | 198 → 198 |
| stress30 / Anthropic | 1,265,304 → 1,267,369 | 6,304,236 → 6,306,667 | 198 → 198 |

这里是生产配额 inventory 对 data 列的保留字节／行，不是页、WAL、累计重写量或 token。请求总量每轮 CC 增 600 B，Anthropic 增 2065 B，Responses 不变；保存 JSON 内的转义使落库增量分别为 660／2431 B，行数不变。完整步骤结果、每条请求／history 和表级测量均保留在 `final-measurement/`，不通过剥离候选 metadata 冒充实际 main 存储测量。

默认合成网关没有服务方用量：全部测量 `tokenUsage / cacheReadRate=null`，每轮 15 模型步骤四字段的已报告数均为 0、缺失数均为 15。显式合成计数只用于聚合回归，不当真实用量；例如两步 `{input:10, output:2, read:4}` 与 `{output:3}` 汇总已知数为输入 10／输出 5／缓存读 4，输入和缓存读各缺一步，不产生命中率或写入零值。每字段分别报告覆盖，不能把部分计数叫完整用量。

离线前缀按 tools／system／messages 投影比较，分别保留含 metadata 的原始字节及移除合法 metadata、把 string 简写规范成单 text 块后的内容字节；实际请求哈希不做这些转换。既比较当前末端，也检查前一请求已写入边界是否仍保留在当前请求。main 没有断点时只能报告明确标识的虚拟边界，实际声明断点数仍为零。这些 JSON 哈希不是服务方 cache key，消息块距离只是查找窗口的保守估算（未合并连续工具块）；20 个检查位置包含当前断点，距离 19 在估算窗内、20 已在窗外。不能据此报告实测 token 命中率或费用节省。

各负载均为 15 个请求，以下只比较后续 14 个与前一个；首请求没有已写入前缀。这两个固定负载不加载组，核心和全部工具断点重合；另有真实 5 步加载回归验证核心点保留、全工具层变化、下一请求工具层恢复稳定。

严格比较“当前断点末端的完整累计前缀”与“上次末端”时，两负载、main／候选的工具与系统均为 14/14 字节相同，历史均为 0/14（含 metadata 及规范内容两种投影均如此）。历史普通追加也会使末端变长。下表的 10/14／8/14 是另一项统计：上次已写入的旧边界在当前对应位置是否仍逐字节相同，用于评估查找旧缓存的候选机会；两种相等不能混称。

| Anthropic 离线边界 | legacy 保留的旧边界／14 | stress30 保留的旧边界／14 | 与无断点 main 的比较 |
| --- | ---: | ---: | --- |
| 工具内容／含 metadata 的投影 | 14／14 | 14／14 | 同样稳定；main 只是虚拟边界，声明断点 0 |
| 系统内容／含 metadata 的投影 | 14／14 | 14／14 | 同样稳定；候选实际声明静态点 |
| 历史内容投影（规范文本简写） | 10／14 | 8／14 | main 同位置为 10／14、8／14；候选才写入显式点 |
| 历史含 metadata 的原始投影 | 0／14 | 0／14 | main 为 10／14、8／14；移动标记／文本简写改变 wire 表示，不能据此推断提示内容全变 |

legacy 的第 6／9／12／15 请求压缩，四次旧历史边界已不可定位；stress30 第 4／6／8／10／12／14 请求压缩，六次中一次对应边界内容不同、五次不可定位。可定位且相同的历史旧边界均在保守 20 位置估算窗内。工具和系统内容前缀投影分别固定 11,570／12,672 B；多个点的前缀重叠，不能相加算作命中次数或 token。预期收益是历史不变时复用此前写入的旧边界、压缩时保住静态前缀；没有断点的 main 只有相同内容，未配置显式写入机会。仍需真实 usage 验证，特别是默认 Haiku 4.5 的最小缓存长度为 4096 token；JSON 字节数不能证明已达到该门槛。[官方限制](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-limitations)。

开发首版统计把 string 简写当作无内容，另把 20 位置误算为包含之前第 20 块；独立复核发现后，修复统一文本块投影、真实虚拟指针及 `<20` 边界并补三步表示转换、19／20 测试。最后 14/14 实际通过（9.53 秒）；旧开发容量原件保留，不用于上述最终统计。

## 5. 请求指纹

main fixture 的 SHA-256 为 `89dd1b4e60af51e05391fbaa13cb7c7dc93b2abdbaa4d4d5856deb260e2ead25`。先在未更新 fixture 的候选做两次采样（26.69／58.17 秒），99 条 bytes／SHA 逐条相等，身份、顺序和数量不变。逐项复核及独立反事实审计后，真实执行 `node tests/helpers/agent-task-request-fingerprints-v2.ts --update`（Node 24.21.0／UTC／真实 TMPDIR／caffeinate，29.29 秒，exit 0），输出与两次预览完全相等。新 fixture SHA-256 为 `96f0f046f40e73980a5a37db9230900f8ce31580a281318ddba78eeb04329c23`。

| 实际变化 | 条数 | 每条差值 | 原因 |
| --- | ---: | ---: | --- |
| 官方 OpenAI Chat Completions | 5 | +40 B | 只增加 `stream_options.include_usage` |
| 官方 Anthropic 核心工具请求 | 2 | +161 B | 三个断点；system 及末条纯文本消息转为单 text 块 |
| 官方 Anthropic 已加载 canvas 的后续请求 | 3 | +173 B | 四个断点；system 转单 text 块、工具按组排序；末条消息本来就是块数组 |
| 其他请求（含 12 条诊断） | 89 | 0 | bytes 和 SHA 均完全不变；Responses 全部不变 |

两个 +161 B 身份为 `official_single_reply/1`、`official_read_edit_roundtrip/1`；三个 +173 B 为该往返的 index 2／3／4。Chat Completions 同样为单次一条、往返四条。Qwen／DeepSeek 的主动开关由新增端点矩阵测试覆盖，本套 99 场景仅有 OpenAI／Anthropic 官方预设，不声称 fixture 已覆盖其他官方服务。

独立审计在只读候选与干净 main 生产源上，对同配置、持久 history、按原目录选取的工具及诊断选项重新构造 main body。候选仅撤去上述 metadata／表示包裹并恢复原目录顺序后，99/99 序列化字节等于 main builder 对照，对照 99/99 又等于旧 fixture；实际候选请求 99/99 与未插桩预览一致。没有替换 ID／时间，没有修改实际哈希输入或输出完整请求／会话密钥。审计 exit 0，29.19 秒；证据 `counterfactual-fingerprint-audit/`。

指纹 helper 只在配对验证副本中移除合法 content-block 缓存 metadata，再交原上下文 validator；哈希仍直接覆盖已持久 body 原件。开发首轮因原 validator 不认识新 metadata 而失败的采样保留，不把它算作成功的 99 条。旧网关完整目录测试改按工具名称逐项严格校验全部 schema 和唯一集合，仅官方 Anthropic 接受新排序，其他组合仍校验原顺序；没有删除覆盖或跳过用例。

## 6. 停止点与真实复测计划

以下为离线交付时的停止点与方案：当时代码及离线验证已完成，尚无真实模型、生产连接、媒体生成或付费生成调用，也未创建真实样本结果文件。后续用户确认与调整见第 7 节。原方案须由用户提供连接并明确确认；结果写入 `docs/verification/mio-harness/H1-REAL-SAMPLE.md`，不记录密钥、完整请求或连接凭据。

拟用 OpenAI 官方 `gpt-4.1-mini`（Chat Completions／Responses）及 Anthropic 官方 `claude-haiku-4-5`；实际模型以用户提供并确认的连接为准。不更改产品默认模型。先从独立合成项目离线冻结以下五份代表请求，真实阶段仅调用 gateway 并解析响应，不执行模型返回的任何业务工具；即使返回生成或写调用，也只记录白名单化的结果分类，不进入派发。因此不触发图片／视频／音频生成、导出或其他付费生成。

| 请求 | 预设／协议／模型 | 目的 |
| --- | --- | --- |
| 1 | openai / Chat Completions / gpt-4.1-mini | 核心工具、短回复及终末 usage 帧 |
| 2 | openai / Responses / gpt-4.1-mini | 带合成只读观察回执的合法续接及 usage |
| 3 | anthropic / Messages / claude-haiku-4-5 | 核心工具、三个断点，观察首次缓存写入／最小门槛 |
| 4 | 同请求 3，完全相同 body | 请求 3 完成后串行发送，且距请求 3 发起不足 5 分钟，观察真实缓存读；过期如实记录，不自动追加请求 |
| 5 | 同 Anthropic 连接，核心相同、追加 canvas 工具组及离线冻结的压缩历史 | 四断点的核心候选前缀与压缩后历史；仅发送定义和合成记录，不执行工具 |

总计五次模型请求，不自动重试、不运行完整 stress30 的 15 次真实模型循环。按离线 13 KiB 核心请求及有界压缩样本估计，总输入约 3万–8万 token（非服务方 tokenizer 实测），预期总输出约 300–1000 token；每次原有 4096 输出上限不变，五次最坏总输出上限 20,480 token。缓存读／写是输入分项，不额外相加；实际 token 与命中情况只以服务方返回为准。若 Haiku 核心未达到 4096 token，显式零缓存应如实记录，不填充工具定义或伪称策略失败／命中。模型 API 本身可能计费；必须先由用户提供连接并确认计划及这项 token 预算，再运行并补真实结果。

真实记录逐请求列协议／模型、原件 bytes／SHA、发起时间、私有四字段及各字段是否报告；在总输入和缓存读均已报告且输入大于零时计算该请求缓存读占比，否则为 null。分协议／模型汇总已知量和覆盖，不把缺失写成零，也不把缓存读占比称为节省费用。对 H0 中有相同场景及语义对应的指纹比较请求字节，明确 H1b 工具加载新增步骤的对应关系；不存在对应样本则标 N/A。H0 仅离线合成模型、`tokenUsage=null`，所以 H0 的真实 token／命中率收益没有基线，不做虚构百分比；本期相同负载的 main 对照另用于隔离新增字段的字节影响，不额外增加真实请求。


## 7. 后续真实复测记录

2026-10-29，用户另行确认预算并选择“先测 MiniMax，官方缓存待补”。已完成中国区 MiniMax-M3 的五次两协议推理及两次只计数请求；详细结果见 [H1-REAL-SAMPLE.md](H1-REAL-SAMPLE.md)。原第 6 节保留离线交付时提出的官方方案；Responses、官方 OpenAI／Anthropic 及 Haiku 断点计数尚未执行。MiniMax 兼容端点继续不发送缓存断点，生产源码与离线冻结版不变。临时密钥文件已删除，未提交、未推送。
