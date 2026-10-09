# Immediate Responses increment (2B)

Date: 2026-10-09 (UTC)

Status: **required in the current Agent iteration; planned, not implemented**. This supersedes the earlier Responses deferral. Increment 2A is only Chat-Completions conversational transport. Implement 2B immediately after its review/commit, before unrelated features. Neither increment claims project tools or durable conversations.

## Protocol and credential migration

Add required configuration `protocol: "chat_completions" | "responses"`. New writes, safe DTOs and trusted credential acquisition must validate it strictly. Add catalog `defaultProtocol` and profile-specific available choices; preserve existing choices when reopening. Do not infer protocol from a model name, URL or failed response.

Persist an outer settings envelope v2. A dedicated strict v1 loader validates exactly the old four configuration fields and maps them to explicit `chat_completions` in memory. Reading v1 does not rewrite the file, increment revision or decrypt/re-encrypt solely for migration. First authorized PUT writes v2 with revision +1 through the existing atomic path. Unknown versions/malformed legacy objects fail closed. Old four-field clients fail validation rather than silently switching a Responses configuration back to CC.

Keep the inner encrypted credential payload and desktop channel wrapper at their existing versions. Preserve exact credential binding `[presetId, platformId, canonicalBaseUrl]`, including the base path. Model/protocol changes within that same explicitly authenticated base need not invalidate its key. This lets legacy ciphertext survive byte-for-byte while the vault is locked. A changed preset/platform/base still invalidates it.

Protocol authorization is separate: include it in full configuration equality, immutable run snapshots, expected settings revision/acquisition, consent key and send consent. Prefer the exact derived request URL in consent, alongside protocol and model. A protocol-only save invalidates prior consent and stale acquisitions. If a provider has different credentials/accounts per API family, represent separate authenticated profiles instead of silently sharing them.

## Independent adapters and fixed transport paths

Keep `chat-completions.mjs`; add `responses.mjs` and a small explicit dispatcher. Each adapter rejects mismatched protocol. Share framing, bounded transport, safe errors and validation rather than copying lifecycle/business logic.

Only these fixed suffixes are derived from the protocol enum:

- `chat_completions`: `/chat/completions`
- `responses`: `/responses`

Never accept a free-form request path. Preserve all DNS/pinning/TLS/redirect/proxy/private-address/self-port/loopback safeguards. No auto-detection, probe, retry, protocol fallback, model replacement or provider rerouting.

Keep the runtime-facing delta/done/safe-error interface. Unsupported profile/model combinations should fail before secret acquisition/socket creation where practical. A received text fragment or completed output item is not whole-response success.

## Stateless request and context

Native OpenAI text profile allowlist: `model`, `stream: true`, `store: false`, `max_output_tokens: 2048`, `instructions`, ordered `input`, and explicit `truncation: "disabled"`. Use the fixed system instruction on every request. Translate all bounded, completed prior user/assistant turns in order plus the new user message. Do not silently drop turns or replace them with an ad hoc summary. [Migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses), [create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

Do not send `previous_response_id`, `conversation`, `background`, tools/hosted tools, media/file inputs, project IDs/content, arbitrary metadata/headers or model-supplied URLs. One explicitly approved send is one POST. `store: false` is an application-state setting, not a universal zero-retention/logging promise. [Data controls](https://developers.openai.com/api/docs/guides/your-data)

The initial profile is non-reasoning text. Actual reasoning items are an explicit unsupported capability, not silently discarded success. Later reasoning support needs replayable item history, including opaque encrypted reasoning and phase; flattened assistant text is insufficient. Current reasoning documentation discusses stateless encrypted reasoning continuation. Preserve it correctly when that capability is implemented, without exposing opaque content in UI/logs. [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)

## Responses event validation

Use the official Responses event vocabulary and semantics, independently of CC framing. [Streaming reference](https://developers.openai.com/api/reference/resources/responses/streaming-events)

- Recognize response lifecycle (`created`, `in_progress`, `completed`, `incomplete`, `failed`, `error`), output-item and content-part events, text/refusal delta/done events.
- JSON `type` is semantic authority; when an SSE event name is supplied it must agree. A data-only framing form needs explicit fixtures.
- Track response identity, monotonic sequence numbers, output indices, item IDs and content indices under hard count/size limits.
- Assemble text/refusal per content part. Final text/part/item/response snapshots must agree. Never append `.done` text twice.
- Initially accept only assistant message items with output text/refusal. Detect tools/reasoning/unsupported modalities in streamed events **and final response.output**, then fail explicitly. A nullable reasoning configuration object alone is not generated reasoning output.
- Function-argument events and custom/hosted tool items are unsupported in 2B, with zero dispatch. Unknown semantic output types, conflicting IDs/statuses or malformed output fail closed.
- Success requires `response.completed`, `status: "completed"`, no error/incomplete details, and validated final output matching the stream. Do not trust a convenience aggregate `output_text` field instead.
- `response.incomplete` never succeeds; output-token limit becomes truncation, filtering becomes provider failure. Failed/error events expose only safe allowlisted errors.
- Responses does not require the CC `[DONE]` sentinel. A sentinel cannot create success. EOF before terminal, malformed trailing data or socket failure keeps the result partial/failed.
- Preserve cancellation, strict byte/event/time bounds, clean stream termination and no automatic retry. Account for final snapshots repeating output within the wire limit. Only completed turns enter later context.

## Future shared tools are still required

This text-only increment does not permanently disable Responses tools. When scoped execution is added, preserve each function-call item ID, **call_id**, function name and complete arguments. Accumulate fragments per item; validate the completed JSON, final snapshots and unique call IDs before execution. Append the relevant assistant output items, then `function_call_output` with the matching **call_id** and bounded tool result. Do not substitute the item ID or use CC `role: tool` / `tool_call_id` syntax. Reasoning items accompanying calls also require faithful continuation. [Function-calling guide](https://developers.openai.com/api/docs/guides/function-calling)

The shared dispatcher, project authorization, tool schema validation, durable idempotency, approval and bounded-round policies remain prerequisites. Model output never grants these capabilities.

## Provider evidence and initial choices

These are documentation findings, not live compatibility certifications:

- OpenAI: initial native Responses text profile for `gpt-4.1-mini` and its documented snapshot. These are deliberate baseline models, not a newest-model claim. [Model reference](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- Custom remote compatible: explicit user-selected Responses protocol and model; strict native-style text contract; unverified server compatibility, no fallback.
- Ollama: own local profile for `qwen3:8b`, `reasoning: {effort: "none"}`. Official docs describe stateless Responses from v0.13.3; stateful continuation/truncation differ. Enable only after separate fixtures; do not blindly send all OpenAI-only fields. This profile permits native runtime acceptance against a synthetic local Responses-shaped service. [Compatibility](https://docs.ollama.com/api/openai-compatibility)
- DeepSeek: officially documents stateless `/responses` for `deepseek-flash`, with `reasoning.effort: "none"`; some OpenAI fields are ignored. A dedicated fixture-tested profile is feasible. [Responses guide](https://api-docs.deepseek.com/guides/responses_api/)
- Qwen: Responses is documented, but regional/workspace/model-specific behavior and automatic truncation need a dedicated profile. Do not label the vendor unsupported or assume the current CC model is verified for Responses. [Responses reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses)
- OpenRouter: stateless `/api/v1/responses` is documented; its Basic Usage page currently shows `response.content_part.delta`, `response.done`, `[DONE]`, differing from native OpenAI events. Keep documented availability separate from parser support until the dialect is resolved by dedicated fixtures. [Overview](https://openrouter.ai/docs/api_reference/responses/overview), [streaming examples](https://openrouter.ai/docs/api_reference/responses/basic-usage)
- This research did not establish primary-source Responses profiles for the existing Zhipu/Kimi/MiniMax settings. Leave untested choices unavailable without claiming vendor-wide impossibility.

Existing and newly selected catalog defaults should remain CC for this additive migration; users explicitly select supported Responses profiles. A future catalog-default change requires separate review and never silently updates an existing configuration.

## Bounded ownership and tests

1. Config/migration owner: `config.mjs`, `presets.mjs`, `settings.mjs`, migration/credential/desktop compatibility tests.
2. Adapter owner: new `responses.mjs`, dispatcher, fixed transport-path derivation, minimal CC protocol guard, parser/profile tests.
3. UI/integration owner: settings projections/selector, chat runtime consent, protocol-aware panel destination, HTTP/client tests.
4. Independent review and final integration: no shared-file races. Preserve secret broker/file atomicity/framing algorithms unless a concrete test requires change.

Required acceptance:

- v1 metadata/ciphertext/locked or unreadable vault; v2 restart; unknown version; protocol-only keep retains session key/ciphertext; platform/base change invalidates; failed saves/stale CAS preserve state.
- Exact adapter/path selection and body, full bounded completed history/instructions; no stateful/project/tool fields; one POST maximum, no fallback.
- Fragmented UTF-8, multiple text parts, refusal, native completion without `[DONE]`; all incomplete/error/truncation/ID/type/final-output/usage/limit cases; hidden final tools/reasoning.
- Abort before acquisition, during DNS, before first byte and midstream; timeout/iterator cleanup.
- Protocol consent invalidation, settings race, two-window conflict, lost acknowledgement, Stop, dismiss/reopen, temporary-state boundaries.
- Actual browser/native screenshots of protocol selection and derived endpoint, local synthetic Responses streaming/failure/stop and unchanged project records. Then serial focused/aggregate/build checks against the final tree.

No live model calls, real keys, uploads, OAuth, deployment or push are part of this authorization. Both 2A and 2B must land before reporting dual-protocol support complete.
