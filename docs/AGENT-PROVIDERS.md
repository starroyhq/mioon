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

Checked 2026-11-02 against the official pages listed below.

Each Mio task request sends an output limit chosen for its model: the documented maximum output, capped at 16,384 tokens. A model without a documented maximum sends 4,096. So does every preset/protocol combination without a dedicated profile, including custom endpoints. A dedicated Chat Completions or Responses profile rejects other model names before dispatch; a Messages model name outside the table sends 4,096. Kimi and MiniMax list no separate maximum output; input plus output must fit the context window.

| Protocol · preset | Model | Context window (tokens) | Documented maximum output | Mio output limit |
|---|---|---:|---:|---:|
| Chat Completions, Responses · OpenAI | `gpt-4.1-mini`, `gpt-4.1-mini-2025-04-14` | 1,047,576 | 32,768 | 16,384 |
| Chat Completions · OpenRouter | `openai/gpt-4.1-mini` | 1,047,576 (OpenAI model page) | 32,768 | 16,384 |
| Chat Completions, Responses · DeepSeek | `deepseek-flash` | 1,000,000 | 393,216 | 16,384 |
| Chat Completions · Zhipu | `glm-4.7` | 200,000 | 128,000 | 16,384 |
| Chat Completions · Kimi | `kimi-k2.6` | 262,144 | not listed; fits the window | 16,384 |
| Chat Completions · MiniMax | `MiniMax-M3` | 1,000,000 (input plus output) | not listed; fits the window | 16,384 |
| Messages · Anthropic | `claude-haiku-4-5`, `claude-haiku-4-5-20251001` | 200,000 | 64,000 | 16,384 |
| Responses · Qwen | `qwen3.8-flash` | 1,000,000 | not documented | 4,096 |
| Chat Completions · Qwen | `qwen-plus` | unknown (not on the official page) | not documented | 4,096 |
| All protocols · Ollama | `qwen3:8b` | unknown (set by the local server) | — | 4,096 |
| All protocols · custom and other combinations | any | unknown | — | 4,096 |

Why 16,384: one tool argument may be 32 KiB, about 8K–11K tokens, which does not fit in 4,096. At up to about 5 bytes per token, a 16,384-token reply is under 80 KiB, below the 128 KiB output byte cap. So the token limit normally ends a reply first, and the byte caps remain a backstop. A larger limit, such as Haiku's 64,000, would let the shared 128 KiB Messages byte counter end replies first.

A Messages model that cannot disable thinking sends `max_tokens` equal to its output limit and `budget_tokens = max(1024, output limit − 4096)`, so the answer keeps at least 4,096 tokens. That is 16,384 / 12,288 for Haiku and 4,096 / 1,024 for an unknown model. No catalog model requires thinking today.

Token budgets:

- Mioon estimates tokens as UTF-8 bytes divided by 3, rounded up. It uses no tokenizer, `count_tokens` endpoint or reported usage, so request assembly stays deterministic and offline. A CJK character (3 bytes) counts as one token. JSON and English average more than 3 bytes per token, so the estimate errs high for them. It is an estimate, not a bound for every tokenizer. Reported usage is only recorded.
- When the window is known, a request whose estimate plus its output limit exceeds the window fails with `AGENT_CHAT_LIMIT` before dispatch.
- History then also has a token budget: the window, minus the output limit, minus the estimated rest of the request (instructions, tool catalog and protocol fields). Compaction and trimming of earlier runs must satisfy both the byte budget and the token budget, with the same high and low water marks. An unknown window keeps only the byte budget.
- With the current catalog these token checks never bind before the byte caps. The smallest known window is 200,000 tokens. A 512 KiB request estimates 174,763 tokens and, with a 16,384-token output, needs 191,147. With every tool group loaded, the history token budget also stays above the 43,691 tokens that 128 KiB of history estimates to.

The byte caps do not change: 128 KiB of history and 512 KiB per request. Every model step stores its complete request, and Mio history shares a workspace-wide limit of 20,000 rows / 256 MiB, so a large window does not raise them.

Sources: [OpenAI gpt-4.1-mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing), [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/), [GLM-4.7](https://docs.bigmodel.cn/cn/guide/models/text/glm-4.7), [Kimi models](https://platform.kimi.ai/docs/models), [Kimi pricing](https://platform.kimi.ai/docs/pricing/chat), [Kimi Chat API](https://platform.kimi.ai/docs/api/chat), [MiniMax API overview](https://platform.minimax.io/docs/api-reference/api-overview), [Claude Haiku 4.5](https://platform.claude.com/docs/en/models/haiku-4-5/overview), [Qwen text generation models](https://www.alibabacloud.com/help/en/model-studio/text-generation-model), [Ollama FAQ](https://docs.ollama.com/faq), [Ollama context length](https://docs.ollama.com/context-length).

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
