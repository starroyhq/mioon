# Mio 的服务方用量字段

用量只记录响应中收到的非负安全整数。缺失字段保持未知；显式 `0` 才记为零。不会根据字符数、其他字段或模型限额估计用量。计数是整条回复的累计值，不把多个事件重复相加。

## Chat Completions

宿主对已核实的官方预设和端点发送 `stream_options.include_usage: true`：原有的 OpenAI、DeepSeek、Qwen 固定区域端点，以及 MiniMax-M3 的中国站 `https://api.minimax.cn/v1` 和国际站 `https://api.minimax.io/v1`。MiniMax 的平台必须与端点匹配。自定义兼容地址、代理和未纳入白名单的端点保持现状；未纳入并不表示服务方不支持该选项。

[OpenAI 的流事件说明](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)规定，用量可以出现在最后一个 `choices: []` 的块中；中断时可能收不到该块。宿主在处理结束标记前采集该块，也接受随结束块返回的用量。`prompt_tokens` 已是总输入；`prompt_tokens_details.cached_tokens` 和显式的 `cache_write_tokens` 是其明细，不再次加到输入。未收到的明细保持未知。

[MiniMax 中国站](https://platform.minimax.cn/docs/api-reference/text-openai-api)和[国际站](https://platform.minimax.io/docs/api-reference/text-openai-api)的 M3 参数表明确列出 `stream_options.include_usage`。这是新请求的字段变化；冻结的旧请求仍按原字节发送，不在恢复时补加字段。[DeepSeek 文档](https://api-docs.deepseek.com/api/create-chat-completion/)也说明其用量可随最后的内容块返回。

## Responses

宿主从 `response.completed.response.usage` 采集 `input_tokens`、`output_tokens` 以及已报告的缓存明细。总输入不再加缓存，缺少 `usage` 或明细均保持未知，不影响已完整结束的回复。[OpenAI 流事件文档](https://developers.openai.com/api/reference/resources/responses/streaming-events)定义了这个完成事件。

## Anthropic Messages 与 MiniMax 的验收记录

宿主同时采集 `message_start.message.usage` 和 `message_delta.usage`，按累计计数合并；后一个事件省略某字段时，保留之前收到的值。这条路径在 X5 前已存在，离线传输测试覆盖了输入、缓存读和缓存写分散在不同事件中的情况。

Messages 的 `input_tokens` 是未缓存部分。只有三个输入分量 `input_tokens`、`cache_read_input_tokens` 和 `cache_creation_input_tokens` 都有实测值，宿主才能给出总输入。任一缺失时，总输入仍是未知；不会将未缓存部分冒充总输入，也不会把缺失的缓存写当成零。[Claude 的用量定义](https://platform.claude.com/docs/en/api/typescript/messages)说明总输入是三项之和；[MiniMax 的缓存文档](https://platform.minimax.cn/docs/api-reference/text-prompt-caching)同样把其 Messages `input_tokens` 定义为新增输入，并展示三项字段。

11-03 的 MiniMax-M3 实测回执显示输出和缓存读已知、总输入及缓存写未知。该回执是宿主聚合后的结果，没有保留原始 SSE 用量块，因此不能据此断言服务方没返回原始 `input_tokens`：仅缺缓存写也会使总输入未知。现有解析已覆盖 start 和 delta，未发现事件遗漏；本次不发真实模型请求，也不据缺失字段补值。协调人复测时可核对这两个事件实际返回的字段，再区分服务方省略和其他不完整情况。

用量是宿主测量数据，不放回模型的工具结果或后续对话；公开的每轮用量接口仍以“已知/未知及覆盖数”表达不完整数据。
