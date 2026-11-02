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
