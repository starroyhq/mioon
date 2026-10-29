# H1 真实样本复测 · MiniMax 兼容协议

2026-10-29，Asia/Taipei 14:11（实际 UTC 06:11:25.916–06:11:37.933）。分支 `codex/mio-harness-h1e`，基点 `4a52403f8a89bb3e665cb1699d8984a896de9b1e`。

## 范围与结果

用户确认 H1e 代码及离线验证后，授权最多五次真实模型请求、输入预算上限估计 80,000 token、每次输出上限 4096（合计上限 20,480）。随后明确选择“先测 MiniMax，官方缓存待补”，允许复用已有中国区 `MiniMax-M3` 配置；未更改应用当前设置、模型或密钥保存方式。

实际完成五次推理、两次只计数请求，全部正常完成；执行器及 wrapper 均 exit 0，12.303 秒，无自动重试、失败重发或额外推理。五次都是独立 gateway 调用；不运行任务循环，不执行任何模型返回的业务工具，真实输出也均未请求工具，媒体生成／导出调用为 0。实际使用 Node 24.21.0、UTC、真实 TMPDIR 与 `caffeinate -i`。

本次只覆盖 MiniMax 的 Chat Completions 与 Anthropic Messages 兼容协议。Responses、官方 OpenAI 用量、官方 Anthropic 显式断点、Haiku 4.5 的 4096-token 门槛及各断点前缀计数均待补，没有把兼容测试称为官方缓存验证。

## 冻结样本与调用

地址分别为官方中国区 `https://api.minimax.cn/v1`、`https://api.minimax.cn/anthropic`。保持已复核的生产 builder 与 gateway，不修改请求以增加测试开关；所有请求 `cache_control` 断点数为 0，Chat Completions 不开启 `stream_options.include_usage`，输出上限仍为 4096。

1. Chat Completions：核心工具、短回复。
2. Chat Completions：实际离线本地 `project.inspect` 回执的合法续接；替代原计划中的 Responses 请求，Responses 留待官方连接复测。
3. Messages：核心＋canvas 工具组、较大的离线冻结压缩历史。
4. Messages：与请求 3 完全相同 body，串行重复。
5. Messages：仅核心工具、短回复。

核心 14 工具，加载 canvas 后 25 工具。大历史来自独立合成项目中重放的既有 legacy 容量流程第 14 次请求，宿主压缩已发生，history 为 128,843 B；legacy／stress30 各 15 条请求的字节向量与 H1e 离线测量一致。只复用已冻结 history，并用当前 builder 换成合法 core＋canvas 目录；不声称与原容量请求原件同字节。最小只读续接的回执也由真实本地只读工具产生，没有伪造工具结果。所有项目资料均为独立合成数据。

| 请求 | 协议 | body 字节 | 输入 token | 输出 token | 缓存读 token | 缓存写 token | 已报告缓存读／输入 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | chat_completions | 13871 | 未知 | 未知 | 未知 | 未知 | 未知 |
| 2 | chat_completions | 14473 | 未知 | 未知 | 未知 | 未知 | 未知 |
| 3 | anthropic_messages | 153478 | 23904 | 228 | 159 | 0 | 0.6652% |
| 4 | anthropic_messages | 153478 | 23904 | 274 | 23902 | 0 | 99.9916% |
| 5 | anthropic_messages | 13498 | 未知 | 34 | 3702 | 未知 | 未知 |

“未知”表示私有结果缺失相应字段，没有补零。Messages 输入统一为已报告的未缓存输入＋缓存读＋缓存写；三分量未齐时保持未知。缓存写的两个 0 是服务方明确报告的值。请求 5 缺少组成总输入所需的分量及缓存写数，因此不拿计数接口的 3773 填进 usage，也不计算其缓存读占比。当前 CC 模板没有主动请求 usage，这两次正常结束但没有可用计数；只验证了真实流和缺失用量正常完成，不能据此证明 CC 的真实用量解析覆盖。

| 协议 | 输入已知和／覆盖 | 输出已知和／覆盖 | 缓存读已知和／覆盖 | 缓存写已知和／覆盖 |
| --- | --- | --- | --- | --- |
| Chat Completions，2 请求 | 未知，0/2 | 未知，0/2 | 未知，0/2 | 未知，0/2 |
| Messages，3 请求 | 47,808，2/3 | 536，3/3 | 27,763，3/3 | 0，2/3 |

各字段分别汇总已报告量与覆盖；完整三请求的 Messages 缓存读占比仍为未知，不能用部分输入作整轮分母。已知输出 536 也只是三次 Messages 的合计，不代表全部五次输出或完整账单。

## 重复请求与自动缓存

请求 3、4 使用同一个冻结 body 文件，153,478 B，SHA-256 完全相同。请求 3 完成后再发 4，两者发送前最后一道 submission fence 间隔 2.853 秒；调用循环提前记录的间隔为 2645 ms，测点不同。没有在中间插入计数或额外模型调用，符合五分钟内串行重复的安排。

服务方报告的缓存读由请求 3 的 159 增至请求 4 的 23,902，后者相对该请求总输入的占比为 99.9916%。这是 MiniMax 自动缓存的单次观测；首个大样本已有 159 缓存读，不称冷缓存对照。没有显式断点，不能归因为 H1e 的 Anthropic 断点策略、推导费用节省或证明 Haiku 门槛。MiniMax 官方文档说明自动识别重复上下文，并展示两种兼容协议的缓存字段。[官方自动缓存说明](https://platform.minimax.cn/docs/api-reference/text-prompt-caching)

## 计数与预算

推理前对两份唯一 Messages 完整 prompt 分别调用 `POST /anthropic/v1/messages/count_tokens`，无推理输出，不计入五次模型请求；请求 4 因 body 完全相同复用请求 3 的计数。没有探测空 messages，也没有调用官方 Anthropic 或将 MiniMax 计数冒充 Haiku tokenizer。

| 完整 prompt | 计数接口 input_tokens |
| --- | ---: |
| 请求 3／4，共用较大压缩历史 | 23,904 |
| 请求 5，核心工具 | 3,773 |

这里是 MiniMax 对完整输入的估计，包含消息与工具，并非“核心工具断点”或“工具＋system 断点”的独立计数。官方中国区文档明确列出 MiniMax-M3 的计数接口，不生成输出；没有据此声称该接口免费。[官方接口说明](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)

Messages 三次输入预估为 51,581；CC 两次使用相同核心／系统计数，加各自完整消息 JSON 字节量与每次 2048 的工程余量，预留 15,820。合计预估 67,401，小于确认的 80,000。这是预算守门估计，CC 预留不冒充精确 tokenizer 结果或数学上界。真实已报告输入仅 47,808（2/5 请求），其余未知，不能宣称实际五次总输入等于预估。没有为补计数改写冻结 body、增加推理或重发请求。

## 请求原件与证据

| 请求 | body SHA-256 |
| --- | --- |
| 1 | `4d89a7b0cfeffb4bcc6e086913873587ef87ac72cf7a68f1b98ba39828f3e7c8` |
| 2 | `c700b51a62faf2d84a9fa1059ca42c918035a4263e9c0a0cdfcb96ff8914e3e7` |
| 3 | `89322f92df06dd2f569a6a86d320dbeda4b025fe96b81e67d94daa3d56007877` |
| 4 | `89322f92df06dd2f569a6a86d320dbeda4b025fe96b81e67d94daa3d56007877` |
| 5 | `e6715d2c28d7ce3fc1db5faafda6aeb6113e4aa040a901198264d070be8a87bd` |

证据根目录：`/Users/kouzen/Library/Caches/mioon-harness-H1e-2026-10-29/`。

- `real-sample-preparation/offline-samples/samples.json`、`sources.json`、`loader-validation.json`：样本来源、冻结原件及读回校验；完整合成 body 留在本机证据目录。
- `real-sample-preparation/run-minimax-real.ts`：一次性执行器，复用当前 gateway；固定端点、TLS／DNS pin、禁重试、失败即停、次数和预算限制。脚本在执行前经只读独立复核及转译语法检查。早期 `node --check .ts` 不支持类型语法的失败保留在会话记录，随后对转译后的 ESM 检查通过，未因此改变产品源码。
- `real-sample-execution/results.json`：五次完成回执的白名单计数、覆盖、时间、body／输出哈希；不保存真实回答全文、完整 SSE、请求头或密钥。
- `real-sample-wrapper/command.json`、`result.json`：真实命令、执行器 SHA、退出和时长；任意 stdout／stderr 不落日志，实际 stderr 为 0 B。

与 H0 的对应：H0 是合成网关，真实 token／缓存基线为空；本次短答文字、合成项目、模型及目录不同，无逐字节同语义对应请求，因此 H0 单条字节收益与真实 token／缓存收益均记 N/A。H1e 相同固定负载 main→候选的字节对照仍见 `H1e.md`，不拿不同服务方／不同输入计算节省比例。

用户在仓库外 `700` 目录中的 `600` 临时文件填写凭据；执行器只读入内存，用于选定 MiniMax 官方端点，结束后已删除该文件。未将密钥传入命令行、日志、报告、fixture 或请求 body；没有创建或改写应用的持久凭据。本轮仅补验证文档，不改已复核的生产代码，不提交、不推送。停在此处等待用户复核。

## 待测项

用户已确认上述 MiniMax 复测及 H1e 代码、离线验证通过，并决定以下真实复测不阻塞本期。后续须取得对应连接及真实调用授权，不以现有兼容结果替代官方服务验证。

- 官方 OpenAI：分别验证 Chat Completions 和 Responses 的真实输入、输出、缓存读写用量及字段缺失行为。
- 官方 Anthropic：验证显式缓存断点、Haiku 4.5 的 4096-token 最小可缓存前缀门槛，以及各断点累计前缀的 token 数。先发送“核心＋canvas 工具组＋较大离线压缩历史”的请求；完成后在五分钟内原样重复相同 body；最后发送只含核心工具的请求。推理前使用 `count_tokens` 记录各断点前缀，并明确完整输入计数、前缀估计与实际 usage 的区别；不以 MiniMax tokenizer 推断 Haiku 门槛。计数不计入上述三次推理请求。
- MiniMax Chat Completions：本次两次均未返回用量。官方文档已明确支持流式 `stream_options.include_usage=true`，后续可单独验证开启后的终末用量帧、四字段解析及缺失行为。本期保持已复核的请求模板，不开启该字段、不改指纹、不追加真实调用。[官方参数说明](https://platform.minimax.cn/docs/api-reference/text-openai-api)
