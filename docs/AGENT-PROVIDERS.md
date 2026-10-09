# Agent provider presets: research and test contract

Research date: 2026-10-09 (UTC)

Status: **official-documentation research; catalog/settings implemented locally, live compatibility unverified**. No provider request, account-access check, real credentials or live compatibility test was performed. The settings UI uses these presets. The CC-only text adapter has local mock/runtime evidence in increment 2A; the separate Responses adapter is required immediately in 2B. Scoped Agent execution is not delivered. See [settings acceptance](AGENT-SETTINGS-ACCEPTANCE.md) and [iteration plan](AGENT-ITERATION.md).

## Compatibility and status labels

Current approved scope covers both Chat Completions and Responses in promptly consecutive adapter increments. The first transport baseline is text-only Chat Completions; Responses support must be independently documented/tested and explicitly selected. JSON function tools follow only after scoped execution is implemented. Both protocols use application-managed history and streaming with their own event semantics. A preset is a starting configuration, not a promise that every model or endpoint from that vendor implements the same protocol.

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

Required checks: installed model, tool-capable template, tool-call IDs and argument strings, SSE reconstruction and replay. Verify any non-thinking configuration per model rather than assuming a universal toggle.

Sources: [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [tool calling](https://docs.ollama.com/capabilities/tool-calling).

### Custom OpenAI-compatible

- No invented endpoint, model, account or credential default.
- User explicitly supplies the remote HTTPS base and model. Apply the same strict network and secret-binding rules as named providers.
- Baseline supports only the documented Chat Completions profile. Do not auto-discover another API by sending project data to speculative paths.
- Unsupported reasoning, schema, response or streaming shapes produce an actionable compatibility error. Never parse text into executable commands as a fallback.
- Provider/model capability tests are explicit and can bill. The app must disclose the exact destination and use synthetic context.

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
