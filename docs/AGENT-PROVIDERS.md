# 当前协议目录与通用模板（X6a）

当前权威目录为 `packages/business/src/agent/presets.ts`，严格浏览器叶契约为 `agent-provider-catalog.ts`。每个平台按协议记录 base/template、来源、核对日和可运行限制；availableProtocols 仅从未阻断项推导。以下旧验收记录中的地址和模型限制是历史事实，实际保存和发请求均以当前目录及 profile 为准。

- OpenAI：Chat Completions/Responses；Anthropic 仅原生 Messages，测试/比较用途的兼容层不开放。
- DeepSeek、Qwen、Zhipu/Z.ai、Kimi、MiniMax、OpenRouter：按各平台的协议条目精确查表，区域和套餐不互换。Qwen 六个 workspace 模板只填 ID，不接受任意子域或完整 URL。MiniMax Messages 使用各自 `/anthropic` 路径。Kimi/OpenRouter Messages 的 Bearer 适配尚未完成，目录虽记录来源仍阻断，不能拿现有 x-api-key 发送。
- Ollama：回环 origin；C/R 使用 `/v1`，Messages 使用根路径。不放宽 selfPort、非回环或远端云路由约束。
- custom：明确选择协议和完整 HTTPS base，保留路径及既有网络校验，不猜测/自动修正。

精确匹配已有适配模型优先，保留其历史 wire 和能力。官方 OpenAI Responses 按下文 Q11 的已知档案、有限旧型号清单和未知型号载体规则处理；其他合法型号使用所选协议的通用模板，标“未验证”，未知上下文为 null，输出保守为 4096，不继承别的型号的容量或供应商托管工具权限。OpenRouter Responses 继续使用原通用档案及 `reasoning.enabled:false`，不会借用官方 OpenAI 的 Responses 档案。具体字段和固定夹具见 `agent-generic-profiles.test.ts` / `fixtures/agent-generic-request-fingerprints.json`。

保存、官方目录、手填型号和通用请求模板均不证明账号权限或真实模型可用性。Q11 的新默认及请求字段会有意识地更新相应指纹；其他型号的旧字节和行为继续回归。流量边界按下文区分协议，工具、记录及总时限不因此放宽。

## OpenAI 当前型号、默认与兼容（Q11，核对 2026-11-10）

从官方 [型号目录](https://developers.openai.com/api/docs/models)、[完整目录](https://developers.openai.com/api/docs/models/all) 和 [弃用公告](https://developers.openai.com/api/docs/deprecations) 出发核对后，新配置采用 `gpt-6.1-terra`，OpenAI 预设默认协议改为 Responses；其他厂商默认协议不变。Terra 的普通输入/输出价格为每百万 token $1/$5，可用 `none`，定位适合高频、带工具的任务。备选为更省的 `gpt-6-luna`（$0.1/$0.5）和能力更强、最低 effort 为 `low` 的 `gpt-6.1-sol`（$2/$10）。费用随输入长度、缓存和处理档位变化，此处不是费用承诺。`AGENT_DEFAULT_OPENAI_MODEL` 是唯一默认型号常量，OpenRouter 默认在它前面拼 `openai/`。保存过的配置不迁移；`gpt-4.1-mini` 和 `gpt-5.4-mini` 等旧配置仍按其档案处理。上轮把 5.4-mini 当成当前一代的结论已更正。

纯型号策略在 `packages/contracts/src/agent-openai-model-family.ts`，请求档案、设置适配标签和建议列表共用。适配标签来自本地已核对档案，不能相信模型列表供应商自报的标签。下表“当前”表示完整目录未标弃用，包含仍可用的旧代；当前一代排在建议列表前面。已弃用型号保留手填和已保存配置匹配，退出建议；已关停型号退出专用档案和建议，显式排除未知推理载体规则，手填时仅走未验证通用行为，供应商可以拒绝。日期快照继承其精确父型号的规则。

| 型号（包含日期快照） | 状态 | effort 集合；最低档 | 上下文 / 最大输出 | 官方 CC 带工具 | 核对日期 |
| --- | --- | --- | --- | --- | --- |
| [`gpt-6.1-terra`](https://developers.openai.com/api/docs/models/gpt-6.1-terra) | 当前一代，默认 | none/low/medium/high/xhigh/max；`none` | 1,050,000 / 128,000 | 须用 Responses | 2026-11-10 |
| [`gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[`gpt-6-astra`](https://developers.openai.com/api/docs/models/gpt-6-astra) | 当前一代 | low/medium/high/xhigh/max；`low` | 1,050,000 / 128,000 | 须用 Responses | 2026-11-10 |
| [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna)、[`gpt-6-sol`](https://developers.openai.com/api/docs/models/gpt-6-sol) | 当前 | none/low/medium/high/xhigh/max；`none` | 1,050,000 / 128,000 | 仅 `reasoning_effort:none` | 2026-11-10 |
| [`gpt-5.6-sol`](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、别名 `gpt-5.6` | 当前 | none/low/medium/high/xhigh/max；`none` | 1,050,000 / 128,000 | 可用 | 2026-11-10 |
| [`gpt-5.6-terra`](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、[`gpt-5.6-luna`](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | 当前 | none/low/medium/high/xhigh/max；`none` | 1,050,000 / 128,000 | 可用 | 2026-11-10 |
| `gpt-5.4`、`gpt-5.5` | 当前，旧代 | none/low/medium/high/xhigh；`none` | 1,050,000 / 128,000 | 可用 | 2026-11-10 |
| `gpt-5.2`、`gpt-5.4-mini` | 当前，旧代 | none/low/medium/high/xhigh；`none` | 400,000 / 128,000 | 可用 | 2026-11-10 |
| `gpt-5.4-pro` | 当前，旧代 | medium/high/xhigh；`medium` | 1,050,000 / 128,000 | 须用 Responses | 2026-11-10 |
| `gpt-5.4-nano` | 已弃用 | none/low/medium/high/xhigh；`none` | 400,000 / 128,000 | 兼容保留 | 2026-11-10 |
| `gpt-5`、`gpt-5-mini`、`gpt-5-nano` | 已弃用 | minimal/low/medium/high；`minimal` | 400,000 / 128,000 | 兼容保留 | 2026-11-10 |
| `gpt-5.1` | 已弃用 | none/low/medium/high；`none` | 400,000 / 128,000 | 兼容保留 | 2026-11-10 |
| `gpt-5.3-codex` | 已弃用 | low/medium/high/xhigh；`low` | 400,000 / 128,000 | 须用 Responses | 2026-11-10 |
| `gpt-5-pro` | 已弃用 | high；`high` | 400,000 / 272,000 | 须用 Responses | 2026-11-10 |
| `o3` | 已弃用 | low/medium/high；`low` | 200,000 / 100,000 | 兼容保留 | 2026-11-10 |
| `gpt-4.1-mini` 等有限旧非推理清单 | 已弃用 | 不加推理字段 | 保留旧容量 / 请求上限 4096 | 兼容保留 | 2026-11-10 |
| `o1`、`o3-mini`、`o4-mini` 等已关停清单 | 已关停 | 无专用档案，不承载推理 | 不再借用旧容量 | 未验证通用请求，接口可拒绝 | 2026-11-10 |

旧代容量、effort 来源：[GPT-5.2](https://developers.openai.com/api/docs/models/gpt-5.2)、[GPT-5.4 Mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini)、[GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4)、[GPT-5.5](https://developers.openai.com/api/docs/models/gpt-5.5)、[GPT-5.4 Pro](https://developers.openai.com/api/docs/models/gpt-5.4-pro)、[GPT-5.4 Nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)、[GPT-5](https://developers.openai.com/api/docs/models/gpt-5)、[GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1)、[GPT-5.3 Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex)、[GPT-5 Pro](https://developers.openai.com/api/docs/models/gpt-5-pro)、[o3](https://developers.openai.com/api/docs/models/o3)。状态以完整目录与弃用公告为准，文档能力不证明账号权限或真实调用成功。

应用的“思考档”仍是 unsupported/optional/required 能力分类，没有新增用户 effort 档位或持久化字段。已知档案发送最低合法 effort：官方 CC 用 `reasoning_effort`，官方 Responses 用 `reasoning.effort`。`none` 归 optional，其他最低值归 required，后者仍可产生推理。已核对的推理档案请求 32768 输出 token，并在输入预算中扣除；这是低于型号最大输出的本地预算，不保证总时限内用满。旧非推理档案和其他厂商的原输出预算不变。

官方 OpenAI 预设中，CC 携带工具且型号已知只支持 Responses 工具调用时，在构造请求和派发前均以 HTTP 422 `AGENT_CHAT_RESPONSES_REQUIRED` 拒绝，并明确提示改选 Responses；不向供应商发无效请求，不自动换协议或重试。不带工具的文本诊断不被此门控误拦。Luna 和旧 Sol 的 CC 工具请求明确发送 `reasoning_effort:"none"`。依据是上述各型号页及 [推理指南](https://developers.openai.com/api/docs/guides/reasoning)；供应商托管工具权限仍没有扩大。

### 未知型号与有限旧清单

官方 OpenAI Responses 不再按 `gpt-5.x`、mini/nano 等名字猜能力。有限的已知旧非推理清单（`gpt-4.1-mini`、`gpt-4.1`、`gpt-4o`、`gpt-4o-mini`）继续使用旧行为；已知关停清单显式排除推理载体兼容，也不恢复旧支持或另增关停派发错误。其余未知 ID，不论今后怎样命名，都允许接收和回放推理载体，能力分类为 required，标签仍“未验证”，不发送 effort，容量和文档最大输出均为 null，本地输出上限回到 4096。`gpt-5.1-mini` 是 SDK 为类型兼容保留的非 API 拼写，不把它标为已适配。

未知 ID 的 4096 只是保守请求值，不能证明该模型支持 4096；真实上限更小时供应商仍可能拒绝，应用如实报告，不猜容量、不静默调参、不自动重试。未知 special suffix 也不能借用相邻型号的 effort、容量、状态或工具承诺。这个载体兼容规则只适用于官方 OpenAI Responses，其他供应商和 CC 通用档案不因此获得推理权限。

### OpenRouter 的独立 CC 依据

OpenRouter 默认精确 ID 为 [`openai/gpt-6.1-terra`](https://openrouter.ai/openai/gpt-6.1-terra)，保留 CC。2026-11-10 核对其 [公开模型目录](https://openrouter.ai/api/v1/models) 与 [供应商端点详情](https://openrouter.ai/api/v1/models/openai/gpt-6.1-terra/endpoints)：该 ID 明确列 CC 端点和 `tools/tool_choice/reasoning/reasoning_effort`，容量为 1,050,000 / 128,000，支持 none/low/medium/high/xhigh/max、默认 medium、非强制推理。因此不继承 OpenAI 官方接口的 Terra CC 工具禁令；默认请求使用已有 OpenRouter 形状 `reasoning:{effort:"none"}`，不增加额外协议。

[OpenRouter CC 参考](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) 另说明 `reasoning_effort` 是 `reasoning.effort` 的等价简写，不可同时给出不同值；[工具指南](https://openrouter.ai/docs/guides/features/tool-calling) 明确给出 CC 工具往返。精确型号的公开元数据与原生 OpenAI 档案分别核对，不能只按 `openai/` 前缀认定所有路由能力。此处未用真实账户做模型推理验证。

### 流和续接

OpenAI 推理档案的 Responses 始终使用 `store:false`，保留显式的 `include:["reasoning.encrypted_content"]` 兼容写法。2026-11-10 的官方指南已说明无状态模式默认返回 `encrypted_content`，不再要求 include，但仍接受它；保留它让请求意图明确，续接始终以实际收到的载体为准。最终 reasoning 条目及其加密内容、assistant 消息的 `phase`、function_call、function_call_output 原样进入下一轮。推理只校验并保留为私有续接记录，不作为可见文本输出。added reasoning 可不完整，完成的原生推理载体必须可续接；缺失加密内容判为未完成，不能只回放 `rs_…` ID。item.done 的状态仍可能是 incomplete，此时等整体终端区分输出耗尽或其他未完成原因，不生成完成结果或执行工具；response.completed 却含 incomplete 项仍按协议错误拒绝。

`phase` 仅允许在 assistant 消息上出现，值限 null、`commentary`、`final_answer`；其他位置或值按协议错误拒绝。未知输出项类型报 `AGENT_CHAT_RESPONSES_ITEM_UNSUPPORTED`，不再冒充工具未授权。`response.incomplete` 的 max_output_tokens 原因报 `AGENT_CHAT_OUTPUT_LIMIT`，其他未完成报 `AGENT_CHAT_RESPONSES_INCOMPLETE`；这些已观察到的模型失败记录为 failed，不冒充结果未知，不自动重试或执行工具。

来源：[流事件与最终 reasoning 载体](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[推理指南的无状态续接与 phase 回放](https://developers.openai.com/api/docs/guides/reasoning#preserve-reasoning-without-stored-responses)，并核对仓库 openai SDK 的 `ResponseReasoningItem` / `ResponseOutputMessage` 类型。

### Responses 字节边界

仅官方 OpenAI Responses 使用 4 MiB 整流上限；五个生命周期事件 created/in_progress/completed/incomplete/failed 每个 2 MiB；已知 item、content、arguments 和推理摘要 done 等完整载体每个 512 KiB。普通 delta、未命名或未列出的事件仍是 64 KiB。大事件必须先出现显式 event 名称，网关再核对名称与 JSON type 一致；改名、下一帧、分片行均重新核对，不能借生命周期名称绕过。8192 事件、120 秒总时限以及文本/单推理项 128 KiB、工具参数 32 KiB、历史 128 KiB 等本地边界保留。Chat Completions、Messages 和其他厂商 Responses 仍用原 1 MiB / 64 KiB。

离线实测全部 111 个工具与 instructions，短回复 UTF-8 整流 455916 字节，ASCII 转义为 616795 字节。再加入 131072 字节可见文本和 123026 字节 reasoning 条目及真实 done/terminal 重复回显，整流分别为 1360062 / 2831621 字节，最大 ASCII 事件 721454 字节；原 1 MiB / 64 KiB 不足，现上限可容纳。独立字段都取最大值不代表聚合可豁免：30 个大参数调用等超过整流或历史预算时仍精确拒绝，不声称无界输出。

验证仅使用真实形状离线流、真实桌面设置 broker 接线和合成供应商传输，不发真实模型请求、不使用真实密钥；签名包实际 Responses 对话和工具调用由协调人与用户验收。

## 其他厂商新配置默认与兼容（Q12，核对 2026-11-10）

本轮以各家当前目录、生命周期及协议原页为依据，只更新已确认组合的新配置。所有厂商原默认协议、端点、鉴权方式、旧保存配置和原始 journal 不迁移；OpenAI/OpenRouter 的 Q11 默认及行为不变。型号页可用不代表账号、地域或本机已获权，以下均为离线适配和官方文档证据。

| 厂商 / 平台 | 新建默认与状态 | 协议与思考控制 | 容量与本地请求预算 | 日期 |
| --- | --- | --- | --- | --- |
| Anthropic 全球 | `claude-sonnet-5-5`，当前/Active | Messages；按用户批准使用 adaptive + `output_config.effort:low` 和下述固定 beta | context 原页 1M、精确整数未知；最大输出已证 128000；本地仍16384 | 2026-11-10 |
| DeepSeek 全球 | `deepseek-flash`，当前别名，保持 | CC `thinking.type:disabled`；Responses `reasoning.effort:none`；Messages disabled，保留原实现 | 目录1M/384K；原字段/本地4096不变，不把缩写追加包装成精确整数来源 | 2026-11-10 |
| Qwen 北京/新加坡共享域及六个workspace | `qwen3.8-flash`，当前/正式 | CC `enable_thinking:false`；Responses `reasoning.effort:none`；Messages `thinking.type:disabled` | 原页1M/128K，精确context/max均null；三协议本地4096 | 2026-11-10 |
| Kimi 中国/国际 | `kimi-k3.1-pro`，当前标准档 | 仅现已开放CC；强制思考，最低 `reasoning_effort:low`，不发送K2旧thinking开关；`max_completion_tokens` | context及CC最大输出均1048576；本地4096 | 2026-11-10 |
| 智谱中国/国际 | `glm-4.7`，旧代仍可用，按用户决定暂保 | 新Flash CC有依据，但中国Responses说明冲突、两地Messages精确契约不足；现开放/blocked状态不变 | 旧档案/预算不变，不以CC能力认证其他协议 | 2026-11-10 |
| MiniMax中国/国际 | `MiniMax-M3`，旧代仍可用，按用户决定暂保 | 新Flash强制思考，但Responses输入/输出reasoning schema不对称且无完整回放例子补证；不自造转换 | 旧档案、自然EOF特例和预算不变 | 2026-11-10 |
| Ollama本机 | `qwen3:8b`，旧代库tag仍在，未确认新默认 | Granite4.2 3B/Qwen3.5 4B的精确量化tag、思考metadata、内存与任务质量待定；不下载/切云端 | 本机有效窗口和独立最大输出未知；原字段/4096不变 | 2026-11-10 |

### Sonnet 的明确模式、版本和代价

Sonnet 5.5 不能用旧 `thinking.disabled`。最低 `between_tools` 模式又不接受 `block_binding`，无法靠一个额外参数安全承受现有动态工具清单、指令及历史压缩造成的前缀变化。用户已明确选择保留 Sonnet，用 `thinking:{type:"adaptive",block_binding:{prefix_mismatch_behavior:"drop_block"}}` + `output_config:{effort:"low"}`；不在客户端剥离思考块或自动重试，不改现有工具授权和历史机制。

这个精确模式发送固定 `anthropic-beta:thinking-binding-controls-2026-08-01`，且仅此新模式使用 `anthropic-version:2026-10-21`。官方示例及当前SDK默认支持的是该新版本，未用它们冒称旧2023兼容；用户已另行批准这一精确版本分流。原 `2023-06-01` 常量及旧型号、旧冻结body、其他厂商和自定义兼容服务不变。SDK与host分别按官方Anthropic/global/精确Sonnet ID、官方地址及实际冻结body推导，不透传任意SDK header。旧请求不能因预设改变而获得beta或新版本。

服务端可能因前缀变化舍弃旧思考，增加输出token、延迟并改变依赖旧推理的任务质量；官方将其列为过渡策略。低effort也不等于完全不思考。客户端仍保留收到的完整、原序 thinking/signature/tool_use 和 tool_result，包括空thinking+非空签名。流只对上述可信请求允许 `message_start.message.input_transformations` 和fallback `message_delta.input_transformations`：校验数组、条目字段和 `messages.<索引>.content.<索引>` 路径。`type` 和 `reason` 均须为不超过 256 UTF-8 字节的字符串，解析器丢弃包括未知值在内的全部回执条目。无条目时官方返回 `[]`，解析器兼容官方 SDK 类型允许的 `null`；旧模式仍拒绝这些未知扩展，签名非空要求不放宽。

依据：[Sonnet概览](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)、[迁移](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)、[effort精确128000及低档](https://platform.claude.com/docs/en/build-with-claude/effort)、[保留思考与prefix策略](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)、[新版绑定限制](https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5)、[API版本](https://platform.claude.com/docs/en/api/versioning)、[官方SDK版本默认](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)、[beta回执结构](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/beta/messages/messages.ts)。Haiku4.5仍在官方[生命周期表](https://platform.claude.com/docs/en/about-claude/model-deprecations)为Active，旧ID/快照、disabled及原容量/请求字节保留。当前Haiku5.5是可完全关闭思考的较便宜备选，本卡按用户选择不替换成它。

### Qwen / Kimi 的精确新档案与旧配置

Qwen八平台都按已核[区域发布记录](https://help.aliyun.com/zh/model-studio/newly-released-models)、[文本型号](https://help.aliyun.com/zh/model-studio/text-generation-model)、[Base URL](https://help.aliyun.com/zh/model-studio/base-url)切换同一精确ID，不改变共享域/workspace和Key地域边界；香港Messages专页漏地域标签，通用Base URL与型号表有组合依据，但不将文档支持写成空间权限或本地部署保证。CC/Responses/Messages开关分别依据[深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)、[Responses](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)、[Messages](https://help.aliyun.com/zh/model-studio/anthropic-api-messages)。不从1M/128K猜精确整数；原Responses实现中的1000000不再当精确容量使用，本地输出/字节/时限不变。`qwen-plus`仍列支持，确切下线表未完整核到，不声称已退役；旧CC字段和未知容量保留。

Kimi两个平台分别核对[中国CC](https://platform.kimi.com/docs/api/chat)、[国际CC](https://platform.kimi.ai/docs/api/chat)、[快速上手](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart)、[精确context](https://platform.kimi.ai/docs/pricing/chat)、[推理档位](https://platform.kimi.com/docs/guide/use-reasoning-effort)。标准K3.1 Pro是当前代中较便宜版本，官方仍称旗舰，不以名称“Pro”误作最贵Highspeed。流式reasoning_content只私有校验/保留，下一工具轮原样回传assistant推理、tool_calls及匹配的tool结果，low和输出字段不变；推理不显示。Responses/Messages仍按原目录blocked，不借更换默认开放新协议或改变鉴权。

K2.6在[中国](https://platform.kimi.com/docs/models)/[国际](https://platform.kimi.ai/docs/models)目录已停止向新账号开放，旧账号仍可用，预计2026年底全面退役但无精确日期；旧ID档案、disabled/max_tokens和原字节继续作为显式兼容选择，不作为新账号默认。

### 未确认项和保留项

DeepSeek从[当前目录](https://api-docs.deepseek.com/quick_start/pricing/)、[更新](https://api-docs.deepseek.com/updates/)及三协议原文复核，Flash别名已经是当前V4.1-Flash-1017，所以不为“换代”杜撰另一个ID。

智谱[两地目录](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[国际目录](https://docs.z.ai/guides/overview/overview)虽列当前5.3 Flash，但[中国Responses](https://docs.bigmodel.cn/cn/guide/develop/responses/introduction)的none/low映射与型号强制思考说明冲突，Flash组合及两地Messages严格契约仍不足。用户已决定暂保两平台旧默认，不能用已确认CC去掩盖共享默认的其他开放协议缺口。

MiniMax两地的[中国Responses schema](https://platform.minimax.cn/docs/api-reference/text/api/openapi-responses.json)/[国际schema](https://platform.minimax.io/docs/api-reference/text/api/openapi-responses.json)明确输出reasoning.content含reasoning_text，输入ContentPart却未列该类型；CC和Messages回放指南不构成Responses的补证。未发现完整下一轮例子填平，故用户决定暂保M3。此处是文档不能确认，不是证明服务端一定拒绝。两地[状态表](https://platform.minimax.cn/docs/faq/models)/[国际状态表](https://platform.minimax.io/docs/faq/models)仍列M3可用；M2.5/M2.7的退役安排不套给M3。

Ollama按调研“未确认”不改。官方[新发布目录](https://ollama.com/library?sort=newest)、[Granite4.2标签](https://ollama.com/library/granite4.2)、[Qwen3.5标签](https://ollama.com/library/qwen3.5)和[兼容文档](https://docs.ollama.com/api/openai-compatibility)只能支持候选研究；文件大小不能替代8GB整机实测、工具质量或逐tag思考关闭绑定证据。不下载权重，不调用本机模型，不切云路由。

所有可用旧默认均保留精确匹配和原请求语义。未发现上述旧默认已全面关停的明确证据，不因“旧代”而批量删除；明确已下线型号不会加入新建议。没有新增SDK依赖、持久格式、公共设置DTO、并行/strict授权或资源上限；所有测试均为合成凭据、网络替身或本地受控服务，不是模型账户认证。

## 当前模型清单与检查（X6b）

模型获取使用独立 GET/JSON 传输，路径和鉴权只由服务端目录决定：OpenAI、DeepSeek、Kimi 和 MiniMax 的 C/R 使用 OpenAI 型列表；Anthropic、MiniMax Messages 使用原生分页列表。DeepSeek Messages 固定回同平台 `/models`；Ollama 各协议固定回同一回环 origin 的 `/v1/models`。OpenRouter 按固定 offset/limit 分页，忽略远端 next URL。自定义只尝试明确 base 下的协议列表路径，不猜兄弟路径。Qwen 通用接口、BigModel/Z.ai 未确认列表直接显示不可获取，保留手填，不接供应商原生管理接口或跨平台回退。

每次最多15秒（含本地输入、取钥、DNS及全部分页），单连接和读取各5秒，最多10页/1000项、累计原始JSON 1 MiB，公开完整回包256 KiB。公网连接沿用全部DNS答案检查、固定IP/peer和TLS校验；本机限定回环且拒绝宿主端口，不跟重定向或环境代理。结果只有成功、密钥无效、不提供列表、不可达、网络策略拒绝五类；只投影模型ID、可选显示名及静态适配标记，不传远程错误正文、能力、next URL或密钥反射。

列表来自官方接口也只表示一次观察。“检查”调用同一个列表接口，不发项目内容，不改变 `verification`，不证明该模型支持工具或账号有调用权限。没有列表的平台须先保存 Mio 选择，再按既有授权流程测试连接。未适配模型仍走 X6a 通用模板，缓存不扩大模型能力或预算。测试仅使用合成密钥和网络替身/回环服务，没有真实供应商验收流量。

---

## 历史协议验收及限制记录

# Agent provider presets: research and test contract

Research date: 2026-10-09 (UTC)

Status: **official-documentation research; catalog/settings implemented locally, live compatibility unverified**. No provider request, account-access check, real credentials or live compatibility test was performed. The settings UI uses these presets. The CC-only text adapter has local mock/runtime evidence in increment 2A; the separate Responses adapter is implemented locally in 2B with profile fixtures; local synthetic runtime acceptance passed; live vendor compatibility remains unverified. See [Responses profiles and limitations](AGENT-RESPONSES.md). [Bounded read-tool adapters](AGENT-READ-TOOLS.md) now have profile-specific synthetic fixtures; actual release acceptance is tracked there. Editing/generation execution remains planned. See [settings acceptance](AGENT-SETTINGS-ACCEPTANCE.md) and [iteration plan](AGENT-ITERATION.md).

## Compatibility and status labels

Current scope covers independently selected Chat Completions and Responses adapters. Both now have bounded read-tool mock fixtures using the shared scoped inspection services; release evidence and exact limits are recorded in [read-tool acceptance](AGENT-READ-TOOLS.md). Both protocols use application-managed history and streaming with their own event semantics. A preset is a starting configuration, not a promise that every model or endpoint from that vendor implements the same protocol.

Track these states separately:

1. `documentation_backed`: official sources support the listed endpoint/model/profile.
2. `configured`: local non-secret settings and any required secret reference are present.
3. `mock_contract_passed`: the adapter passes local synthetic fixtures.
4. `connection_test_passed`: an explicitly authorized real synthetic probe passed for the exact endpoint/model/mode at a recorded time.
5. `live_e2e_verified`: a separately authorized real end-to-end workflow passed, with its exact scope and date recorded.

Do not promote one state into another. `configured` does not mean reachable; a text response does not prove tool calling; one model does not certify the vendor. Current research establishes only the first state for the facts below.

Settings should preserve the selected preset ID, explicit region/platform, exact base URL, model, protocol/mode, capability-profile version, opaque secret reference and verification metadata. Preserve user edits across preset-catalog updates. Changing origin/region invalidates the existing secret binding and previous test results.

The initial request profile should avoid temperature, forced tools, parallel tools, strict schemas and JSON response mode unless the selected profile explicitly supports them. Provider-specific non-thinking controls are intentional request fields, not arbitrary user headers. Always validate tool arguments locally.

## Presets

### OpenAI

- Base URL: `https://api.openai.com/v1`
- Conservative baseline model: `gpt-4.1-mini` (editable; a snapshot can be chosen explicitly).
- Official model documentation lists Chat Completions, streaming and function calling. It is a non-thinking baseline, not a claim that it is the newest or strongest model.
- Use `store: false` for this profile. Retention semantics of other compatible providers must be verified separately.
- Do not silently substitute newer reasoning models: current migration documentation notes Chat Completions tool-calling restrictions for newer reasoning-model configurations.
- Strict tool schemas are optional profile work; they require schema adaptation and tests. Responses support is a separate adapter.

Sources: [model capabilities](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses).

### DeepSeek

- Base URL: `https://api.deepseek.com`
- Current conservative example: `deepseek-flash`.
- Non-thinking profile: request body `thinking: {"type":"disabled"}`. The reference documents thinking as enabled by default.
- Function calling and streaming tool deltas are documented. Aggregate by tool-call index; ID/name may arrive only in the first chunk.
- Thinking mode has additional historical `reasoning_content` replay requirements and tool-choice limitations. It is outside the first profile.
- Strict tools require the separately documented `/beta` base and supported schema subset. Do not enable strict mode or change the base automatically.

Required checks: non-thinking function/result round trip, streamed argument reconstruction, exact accepted schema and no unintended reasoning-mode fallback.

Sources: [Chat API](https://api-docs.deepseek.com/api/create-chat-completion/), [tool calls](https://api-docs.deepseek.com/guides/tool_calls/), [thinking and SDK parameter placement](https://api-docs.deepseek.com/guides/thinking_mode/).

### Qwen / DashScope

- Beijing PAYG base: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Singapore PAYG base: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`
- The current production recommendation also supports workspace-specific bases: `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`.
- Documented workspace regions include `cn-beijing`, `ap-southeast-1`, `us-east-1`, `cn-hongkong`, `ap-northeast-1` and `eu-central-1`. A template is not an automatically valid endpoint: the user must supply the correct workspace/region.
- Conservative example: `qwen-plus`, subject to the selected region's model catalog; baseline request uses `enable_thinking: false`.
- Keys, workspace permissions and model availability are region-specific. Do not copy credentials across regions or auto-fallback. Prefer explicit workspace-specific US configuration rather than guessing among legacy US endpoint tables.
- Function calling and SSE are documented. Thinking modes have forced-tool restrictions; JSON output modes are separate model capabilities.
- Use PAYG credentials for this custom application. Coding/Token Plan restrictions must not be treated as permission to use those keys in an arbitrary app/backend.

Required checks: endpoint/key/region/model pairing, tool SSE, accepted schema subset, usage chunks and non-thinking control.

Sources: [endpoint matrix](https://www.alibabacloud.com/help/en/model-studio/base-url), [region rules](https://www.alibabacloud.com/help/en/model-studio/regions), [Chat API](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions), [function calling](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling), [plan restrictions](https://www.alibabacloud.com/help/en/model-studio/more-tools).

### Zhipu / GLM / Z.ai

- China BigModel base: `https://open.bigmodel.cn/api/paas/v4`
- International Z.ai base: `https://api.z.ai/api/paas/v4`
- Treat these as distinct platform/account presets. Credential portability is not assumed.
- Conservative example: `glm-4.7`; baseline request uses `thinking: {"type":"disabled"}`.
- The Chat reference documents SSE ending in `[DONE]` and lists automatic tool choice. Do not require forced tool choices.
- Streaming function arguments additionally use `tool_stream: true` for documented supported GLM families. Do not send it to arbitrary models without capability confirmation.
- Examples vary in argument representation; verify the actual OpenAI-compatible JSON-string tool round trip rather than accepting every shape opportunistically.
- Do not substitute a Coding Plan endpoint.

Required checks: each platform separately, chosen model access, tool-stream control, argument representation and complete assistant/tool-result replay.

Sources: [China setup](https://docs.bigmodel.cn/cn/guide/start/quick-start), [GLM-4.7](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7), [international Chat API](https://docs.z.ai/api-reference/llm/chat-completion), [streaming tools](https://docs.z.ai/guides/tools/stream-tool).

### Kimi / Moonshot

- China base: `https://api.moonshot.cn/v1`
- International base: `https://api.moonshot.ai/v1`
- Conservative baseline: `kimi-k2.6` with `thinking: {"type":"disabled"}`. Current flagship documentation also uses `kimi-k3`, which is not interchangeable with this non-thinking profile.
- K2.6 supports function calls and SSE but rejects `tool_choice: "required"`.
- Omit temperature in the baseline: accepted values depend on model/mode.
- K3 always reasons and requires preservation of assistant reasoning for continuation; defer until separately implemented/tested.
- Current tool documentation has strict schemas enabled by default and an MFJS schema subset. Use explicit `strict: false` for the initial non-strict profile where documented; continue local validation.

Required checks: endpoint/account pairing, model-specific schema acceptance, fragmented tool SSE and multi-round replay.

Sources: [international tool guide](https://platform.kimi.ai/docs/api/tool-use), [China setup](https://platform.kimi.com/docs/get-api-key), [model constraints](https://platform.kimi.ai/docs/api/models-overview), [Chat/SSE reference](https://platform.kimi.ai/docs/api/chat).

### MiniMax

- China base: `https://api.minimax.cn/v1`
- International base: `https://api.minimax.io/v1`
- Non-thinking baseline: exact model ID `MiniMax-M3`, request body `thinking: {"type":"disabled"}`. Current compatibility and PAYG documentation support this combination.
- Do not use M2.x as a non-thinking fallback: those models ignore thinking-disable. `MiniMax-M3.1-Flash-Preview` rejects it and is currently plan-only, so it is not a generic PAYG default.
- Use `tools`, not deprecated `function_call`; `n` must be 1. Familiar OpenAI sampling parameters may be ignored.
- Reasoning-enabled models require full assistant continuation information; those profiles remain deferred.
- Text streaming is documented. Combined streaming function calls still require explicit capability testing before the app marks that profile as verified.
- The exact `MiniMax-M3` non-thinking Chat Completions profile at the matching official China/international base accepts a fully framed stream's natural EOF after `stop` or `tool_calls`, with no transport error or cancellation. Other profiles and edited/custom endpoints still require `[DONE]`. This follows the [recommended OpenAI SDK's SSE iterator](https://github.com/openai/openai-node/blob/v7.39.0/src/core/streaming.ts), which accepts normal EOF; MiniMax's text documentation does not explicitly promise omission of `[DONE]`. All tool argument, finish-reason, refusal and truncation checks still apply.
- Live observation on 2026-10-24 (Asia/Taipei): China `MiniMax-M3`, thinking disabled, text-only diagnostic returned the complete text with `finish_reason: stop`, three complete frames and natural EOF without `[DONE]`.
- The same authorized desktop session then completed real streaming function/result rounds: Mio created a creative text node, a shot, two video nodes and two visual edges, submitted one CN H3 `2K`/nominal 4-second generation, edited it with an existing clip and exported an 8-second 1080×1920/30fps H.264/AAC video. The host corrected unsupported generation arguments before any provider submission and approved the single valid paid step; this is evidence for that assisted workflow, not unassisted reliability or international compatibility. Both source tasks retained one submission each, the old source hash stayed unchanged, and the final export hash and full decode passed.
- Follow-up fixed offline: ordinary background progress/scheduling updates no longer append business changes. Meaningful lifecycle changes use `generation.status`, publication uses `generation.publish`, and legacy labels are corrected only in their read-time display. Uncertain-cost audit and independent version selection remain intact; later target revisions are no longer attributed to the user. Local pre-dispatch generation-parameter errors can return safe model-specific feedback for correction while preserving paid approval and UNKNOWN gates. Regression evidence covers 300 polling updates, atomic uncertainty audit, publication, both model protocols and original-task recovery; no additional live generation was performed for these fixes.

Required checks: non-thinking M3 access, complete function/result cycle, tool SSE, schema acceptance and ignored/unsupported-parameter handling.

Sources: [international compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api), [China compatibility](https://platform.minimax.cn/docs/api-reference/text-openai-api), [function calls](https://platform.minimax.io/docs/guides/text-m3-function-call), [PAYG availability](https://platform.minimax.io/docs/guides/pricing-paygo).

### OpenRouter

- Base URL: `https://openrouter.ai/api/v1`
- Conservative example: `openai/gpt-4.1-mini`, currently listed with tools/tool-choice support.
- Support depends on the model and serving provider, not just OpenRouter's request format.
- Set `provider.require_parameters: true` when relying on tool parameters; otherwise routing can ignore unsupported optional parameters.
- SSE may contain keepalive comments and mid-stream error objects despite HTTP 200. Final usage/accounting frames may repeat finish reasons; do not execute calls twice.
- Aborting the client stream does not guarantee all upstream providers stop generation or billing.
- Preserve only documented continuation metadata if a future profile requires it; do not infer reasoning compatibility from ordinary text success.

Required checks: exact model/routing profile, tool round trip, repeated terminal frames, keepalives, mid-stream errors and abort behavior.

Sources: [model](https://openrouter.ai/openai/gpt-4.1-mini), [tool calling](https://openrouter.ai/docs/guides/features/tool-calling), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [SSE](https://openrouter.ai/docs/api_reference/streaming).

### Ollama local

- Suggested local base: `http://127.0.0.1:11434/v1` (official examples also use `localhost`).
- Example model: `qwen3:8b`, only if installed, tool-capable and suitable for the user's machine. The model field remains editable; do not download models automatically.
- The local API normally ignores API keys. Omit authentication unless the selected local gateway explicitly requires it; an SDK placeholder is not a real credential.
- Official compatibility docs list Chat Completions streaming and tools. Behavior still depends on server version and the selected model/template.
- Do not reuse native `/api/chat` parsing: its messages/tool arguments differ from the `/v1` compatibility interface.
- Keep local inference distinct from signed-in/cloud Ollama models. The local preset is not authorization for cloud routing.
- The endpoint must satisfy the dedicated loopback-only policy and must not target Mioon's own backend port.
- The Ollama server sets the context window. The OpenAI-compatible API can neither set it per request nor report it. Ollama's FAQ lists a 4096-token default; its context-length guide picks 4k, 32k or 256k from available VRAM and recommends at least 64000 tokens for agents. Raise it on the server before running Mio tasks. Mioon does not infer the window from the model name, so it applies only the byte caps and a 4,096-token output limit (see [task output and context limits](#task-output-and-context-limits)).

Required checks: installed model, tool-capable template, tool-call IDs and argument strings, SSE reconstruction and replay. Verify any non-thinking configuration per model rather than assuming a universal toggle.

Sources: [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [tool calling](https://docs.ollama.com/capabilities/tool-calling), [FAQ](https://docs.ollama.com/faq), [context length](https://docs.ollama.com/context-length).

### Custom OpenAI-compatible

- No invented endpoint, model, account or credential default.
- User explicitly supplies the remote HTTPS base and model. Apply the same strict network and secret-binding rules as named providers.
- The explicitly selected Chat Completions or Responses profile is used, with separate strict text/read-tool contracts. Do not auto-discover another API by sending project data to speculative paths.
- Unsupported reasoning, schema, response or streaming shapes produce an actionable compatibility error. Never parse text into executable commands as a fallback.
- Provider/model capability tests are explicit and can bill. The app must disclose the exact destination and use synthetic context.

## Task output and context limits

2026-11-02 核对，来源见本节链接。profile 分别记录文档给出的上下文窗口、最大输出，以及本次请求实际发送的输出上限；文档最大输出不等于请求上限。

- **Chat Completions、Responses：** 所有 preset、开思考的请求和自定义连接都保持 4,096 token。
- **Messages：** `anthropic` 小表中的确切模型取 `min(文档最大输出, 16384)`；表外模型和其他组合保持 4,096。专用 Chat Completions、Responses profile 仍在发送前拒绝未支持的模型名，不因此改协议或回退。

| 协议 · preset | 模型 | 上下文窗口（token） | 文档最大输出 | Mio 请求输出上限 |
|---|---|---:|---:|---:|
| Chat Completions, Responses · OpenAI | `gpt-4.1-mini`, `gpt-4.1-mini-2025-04-14` | 1,047,576 | 32,768 | 4,096 |
| Chat Completions · OpenRouter | `openai/gpt-4.1-mini` | 1,047,576（沿用 OpenAI 模型文档） | 32,768 | 4,096 |
| Chat Completions, Responses · DeepSeek | `deepseek-flash` | 1,000,000 | 393,216 | 4,096 |
| Chat Completions · Zhipu | `glm-4.7` | 200,000 | 128,000 | 4,096 |
| Chat Completions · Kimi | `kimi-k2.6` | 262,144 | 未单列；输入加输出须在窗口内 | 4,096 |
| Chat Completions · MiniMax | `MiniMax-M3` | 1,000,000（输入加输出） | 未单列；输入加输出须在窗口内 | 4,096 |
| Messages · Anthropic | `claude-haiku-4-5`, `claude-haiku-4-5-20251001` | 200,000 | 64,000 | 16,384 |
| Responses · Qwen | `qwen3.8-flash` | 1,000,000 | 暂无已核对数字 | 4,096 |
| Chat Completions · Qwen | `qwen-plus` | 未知 | 暂无已核对数字 | 4,096 |
| 所有协议 · Ollama | `qwen3:8b` | 未知，由本地服务设置 | — | 4,096 |
| 所有协议 · custom 及其他组合 | 任意 | 未知 | — | 4,096 |

### 按协议选择上限的原因

Chat Completions、Responses 的长回复仍受每条流 **1 MiB、8,192 个 SSE 事件、单事件 64 KiB 和 120 秒总期限**约束。假设每个事件 250–330 字节、约一个 token，则 `1,048,576 ÷ (250–330) ≈ 3,178–4,194` 个事件，约在 3K–4K token 触及字节上限。这是分块假设下的估算，不是所有模型的实际截断点；只把输出上限放大，不能保证更长的回复通过。[OpenAI 速率限制指南](https://developers.openai.com/api/docs/guides/rate-limits#reduce-the-max_tokens-to-match-the-size-of-your-completions)还说明，请求计数取 `max_tokens` 与按请求字符数估算的 token 较大者。例如原估算约 5K 的请求改设 16,384，会把该计数抬到 16,384；本轮保持 4,096。

Messages 取 16,384，给较长的工具参数留出输出额度：单个参数限 32 KiB，假设每 token 3–4 字节，约需 8K–11K token。16,384 token 的解码内容在同一假设下约 48–64 KiB，可处于共用的 128 KiB 输出计数内，但工具参数、思考、签名和实际编码都会影响剩余额度。[Anthropic 的 OTPM](https://platform.claude.com/docs/en/api/rate-limits)按实际产生的输出 token 计数，`max_tokens` 不参与 OTPM 计算；提高请求上限本身不增加 OTPM 预留，实际多生成的 token 仍消耗额度和费用。

**Messages 也不能保证完整输出 16,384 token。** 它同样经过上述 SSE 和总期限检查。按[官方 `text_delta` 事件形状](https://platform.claude.com/docs/en/build-with-claude/streaming)，使用紧凑 JSON、LF 换行、索引 0 时，空内容事件包装为 115 字节。继续假设每 token 3 字节：

- 每事件 4 token：`4,096 × 115 + 16,384 × 3 = 520,192` 字节，另加控制事件，字节与事件额度可以容纳。
- 每事件 1 token：`16,384 × 115 + 16,384 × 3 = 1,933,312` 字节，且事件超过 16,384，先触发限制。
- 每事件 2 token：仅 delta 已占满 8,192 个事件，加入开始、结束等控制事件便超限。思考、工具 JSON 和签名的包装还会增加流量。
- 即使其他额度够用，`16,384 ÷ 120 ≈ 136.5 token/s` 也是完成回复所需的最低平均速度；连接、首字延迟和其他开销会提高要求。单事件仍不得超过 64 KiB。

这些是透明的容量估算，不是实测分块或吞吐；官方协议不保证固定 token/事件。X3 保持 X2 的协议输出额度和现有 SSE／总期限，不承诺多调用就能输出更长的回复。普通请求允许多个工具调用，宿主仍逐个执行、审批和计步。四语宿主说明要求同一回复只放互不依赖、参数短的调用；依赖前一个结果或新 ID 的操作放在下一次回复，长参数调用单独回复，提问放在本次回复最后。输出限额导致截断时，包括前面已完整的调用在内，整条回复没有调用被执行。

批次中用户批准后继续后缀；用户拒绝或回答提问后，原后缀全部不执行并交回 Mio 重新规划。新请求按确切工具名称加载，旧 groups 只兼容原冻结请求和已有回执，加载不增加授权。每个结果视图仍最多 16 KiB，整批结果在最终 continuation 中的序列化贡献最多 64 KiB，超限只收紧派生视图，完整记录不变；最小占位装不下仍报容量错误。完整兼容与恢复边界见[执行与恢复](AGENT-TASKS-V2.md)。

### 思考与 token 预算

Messages 的“必须思考”档发送 `max_tokens = 输出上限`、`budget_tokens = max(1024, 输出上限 − 4096)`。以 Haiku 的上限代入为 16,384 / 12,288；未知模型为 4,096 / 1,024。4,096 是回答预留目标，未知模型受最小思考预算约束后只剩 3,072。当前目录没有必须思考的模型，也没有生产开启思考的请求。

本轮不统一各协议思考内容的字节计数器。当前没有开启思考的生产请求，统一计数不改变现有结果；Chat Completions、Responses 的长流还先受上述传输额度约束。首次加入思考模型时，再按实测检查计数方式，不以“token 上限必先到”为依据。

- Mioon 以 UTF-8 字节数除以 3、向上取整估算 token，不调用 tokenizer、`count_tokens` 或用量接口，请求装配保持确定、离线。一个 3 字节汉字计作一个 token；JSON 和英语平均每 token 字节较多时会高估。这不是对所有 tokenizer 的保证，供应商用量只记录。
- 窗口已知时，若请求估算加本协议输出上限超过窗口，在发送前报 `AGENT_CHAT_LIMIT`。
- 历史 token 预算等于窗口减去输出上限，再减去其余请求（指令、工具目录和协议字段）的估算。压缩及跨轮裁剪同时满足字节与 token 预算，高低水位不变；窗口未知时只按字节限制。
- 当前目录中 token 检查不会先于字节上限收紧。最小已知窗口为 200,000；512 KiB 请求估算为 174,763 token，即使加最大的 16,384 也只需 191,147。加载全部可用工具后，历史 token 预算仍高于 128 KiB 历史对应的 43,691 token。
- Ollama 的上下文继续按未知处理，不从模型名猜测；应先在本地服务调大上下文，OpenAI 兼容接口不负责调整它。`qwen-plus` 的窗口和最大输出、`qwen3.8-flash` 的最大输出保持未知，拿到已核对的官方数字后再改。

字节上限不变：历史 128 KiB、单次请求 512 KiB。每个模型步骤仍保存完整请求，整个工作区的 Mio 历史共用 20,000 行 / 256 MiB 存储额度；较大的模型窗口不会放大这些额度。

模型与上下文来源：[OpenAI gpt-4.1-mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini)、[DeepSeek 模型与价格](https://api-docs.deepseek.com/quick_start/pricing)、[DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)、[GLM-4.7](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7)、[Kimi 模型](https://platform.kimi.ai/docs/models)、[Kimi 价格](https://platform.kimi.ai/docs/pricing/chat)、[Kimi Chat API](https://platform.kimi.ai/docs/api/chat)、[MiniMax API 概览](https://platform.minimax.io/docs/api-reference/api-overview)、[Claude Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview)、[Qwen 文本模型](https://www.alibabacloud.com/help/en/model-studio/text-generation-model)、[Ollama FAQ](https://docs.ollama.com/faq)、[Ollama 上下文长度](https://docs.ollama.com/context-length)。

## Capability test suite

Offline adapter fixtures are mandatory before any optional live probe:

1. Plain text, streamed text and a complete function → tool result → final answer cycle.
2. Split UTF-8, CRLF, SSE comments, split JSON arguments, multiple call indices, first-chunk-only names/IDs, empty choices and usage chunks.
3. Malformed/oversized arguments, unknown tools, duplicate/conflicting call IDs, repeated terminal frames, truncation, transport drop and HTTP-200 stream errors.
4. Cancellation before output, during arguments and after a committed tool. No unfinished call executes; no repeated side effect occurs.
5. Exact assistant/tool-result continuation and any explicitly enabled provider metadata.
6. Separate optional tests for forced tools, strict schemas, JSON response mode, parallel-call requests, reasoning replay and model-list discovery. Passing them is not part of the baseline by assumption.
7. Redaction and destination tests: errors never expose keys; edited origins do not reuse credentials; forbidden network destinations and redirects fail closed.

Persist real probe results only for the exact endpoint, model, mode and profile version tested. A provider alias update, endpoint change, region change or capability-profile change can invalidate that result. No named preset is currently live-verified by this research.

## Evidence and maintenance

Official documentation can change. Preserve the verified URL/date and a concise factual profile; recheck sources before implementation and before adding new default models or modes. Avoid copying provider documentation wholesale.

Runtime evidence should identify whether it used an injected fixture, local synthetic HTTP server, installed local model or real remote endpoint. A mock screenshot must be labeled simulated. Real connection checks require separate authorization; this research does not grant it.
