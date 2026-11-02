# Immediate Responses increment (2B)

Date: 2026-10-09 (UTC)

Status: **historical increment 2B, committed as `e2db533`**. Baseline: `3db1a02` (increment 2A). This supersedes the earlier Responses deferral. That stage added independent text adapters and temporary conversation. Later durability and [bounded read tools](AGENT-READ-TOOLS.md) extend it; the acceptance below remains historical. The same increment replaces modal Agent/settings presentation with the shared right workspace.

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
- Ollama: own local profile for `qwen3:8b`, `reasoning: {effort: "none"}`. Official docs describe stateless Responses from v0.13.3; stateful continuation/truncation differ. The dedicated local profile has separate fixtures; it omits unsupported truncation and does not blindly send all OpenAI-only fields. This profile permits native runtime acceptance against a synthetic local Responses-shaped service. [Compatibility](https://docs.ollama.com/api/openai-compatibility)
- DeepSeek: officially documents stateless `/responses` for `deepseek-flash`, with `reasoning.effort: "none"`; some OpenAI fields are ignored. The dedicated fixture-tested profile is included. Top-level instructions are preserved; no CC thinking field is substituted. Context overflow is documented as HTTP 400 rather than silent truncation. [Responses guide](https://api-docs.deepseek.com/guides/responses_api/)
- Qwen: the dedicated profile accepts exactly `qwen3.8-flash`, with `reasoning.effort: none`, `max_output_tokens: 2048`, `store: false` and an adapter-level 32-KiB aggregate text limit. The existing CC `qwen-plus` model is never silently replaced. The Chinese reference documents the output budget; the provider automatically truncates at approximately 80% of its window and offers no documented disable switch. The local cap is far below this model’s documented 1M-token window, an engineering inference rather than a guarantee or live verification. Mioon promises to send complete selected bounded turns, not to control all provider internals. Existing regional/workspace bases append `/responses`; account/region access remains unverified. Fixtures cover queued creation, UUID IDs, blank initial model, null logprobs, comments and non-contiguous increasing sequence numbers. [Responses reference](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses), [Chinese output-budget reference](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses), [exact model](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash)
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

## Shared right workspace (user-required presentation)

- The existing right dock contains accessible Properties / Agent tabs; Agent and its settings do not render a modal or cover the canvas/timeline. Reuse the dock identity, resize/recall behavior and existing narrow layout.
- Properties, chat and settings use nested visibility boundaries and mounted state. Tab/mode/collapse/settings changes retain unsent chat and nonsecret settings drafts. Hidden pages are inert; their floating controls close and must not reclaim focus. An asset selection never forces Agent back to Properties.
- The active tab is session-only, not a new persisted layout preference. Global settings remain mounted across project loading; chat is keyed to the current project.
- Switching projects with an unsent chat draft uses an explicit discard confirmation. Cancel retains the project and draft. Confirm discards only the unsent local draft and disposes its callbacks; returning reads the backend’s temporary project conversation. A running reply alone does not block navigation or Stop/reconnect.
- A typed secret remains transient input only. Hiding its page clears it immediately with visible explanation on return; nonsecret settings draft remains. Hidden/submitted saves retain CAS/reconciliation semantics and never resubmit automatically.
- One accepted inference can finish while hidden. Reopening is read-only reattachment; no automatic next round, tool execution, POST retry or model/protocol fallback.

## Verification in progress

- Settings/migration owner: 62/62 focused cases. Adapter/network/SSE owner: 55/55. Lead runtime/HTTP: 28/28, including real loopback HTTP for both protocols; graphical synthetic fixture: 1/1.
- Independent security review: 160/160 combined focused cases, 24/24 final Responses/SSE cases, 66/66 UI cases at its checkpoint; no open backend/renderer security blocker. These totals overlap and must not be added as unique test counts.
- A concrete SSE-name ambiguity was corrected: data-only frames are distinct from an explicitly mismatching `event: message` or empty event. The framing algorithm/default CC output is unchanged; Responses opts into name metadata.
- Final renderer composition/guard checkpoint: 167/167 focused/shared/workspace cases passed. Web and development-desktop builds passed serially (`index-BbNztiAE.js`, `index-BRSrb8rP.css`); parent independent full bounded suite passed **794/794, zero skips**, 156.5 seconds (`evidence/agent-responses/parent-all-tests-bounded.log`).
- Actual Chromium: all nine recorded groups passed against the final bundle and corrected synthetic fixture. Report `evidence/agent-responses/browser/report.json`: shared dock/draft/key visibility, protocol pinning, both real loopback paths, safe failures/hostile output, acknowledgement recovery, explicit project-discard guard, late response isolation, active-SSE restart and 500px narrow navigation. Domain hash was unchanged.
- The first graphical fixture emitted a second tool item before sealing the first assistant item, so the strict parser correctly rejected the malformed stream with a protocol error rather than the test’s expected tool-capability error. The fixture was corrected without production changes; its focused check and the full browser flow were rerun successfully. Earlier evidence remains in `browser/report-before-fixture-correction.json`.
- Actual sandboxed Linux Electron: all seven recorded groups passed, with both protocols, protocol-bound dummy credential acquisition, inline key/draft visibility, Stop/incomplete states, active Responses restart and normal active quit. Report `evidence/agent-responses/native/report.json`; domain hash unchanged, metadata mode0600 contains neither dummy key nor chat. The first44-second restart attempt completed before confirmation and is explicitly excluded; the repeated active case aborted correctly. No production change was required.
- Screenshot/build/source hashes and exact changed paths are recorded in `evidence/agent-responses/{screenshots-manifest,build-manifest,source-manifest}.json` and `source-files.txt`. No live-provider verification has occurred.

## Final evidence and remaining boundaries

- Baseline: `3db1a02`; final UI assets: `index-BbNztiAE.js` / `index-BRSrb8rP.css`. Desktop staged UI is byte-identical to the built web UI. Serial build logs are in `evidence/agent-responses/`. No production dependency, renderer-preload capability, installer or security override was added.
- Parent independent aggregate: **794/794, zero skips**, after the synthetic fixture correction and before the final idle-resource browser/native run. Source was unchanged during those runtime checks; only acceptance documentation/evidence was finalized afterward.
- Nine browser groups and seven native groups, with 26 original runtime JPEGs. Suggested visual evidence: `browser/04-responses-streaming-inline.jpg`, `browser/03-inline-agent-beside-editing-workspace.jpg`, `native/07-native-chat-completions-explicit-protocol.jpg`, `native/06-native-incomplete-is-not-success.jpg`.
- Named presets are documentation-backed and mock-contract-tested only. Qwen has the explicit provider truncation caveat above. OpenRouter/Zhipu/Kimi/MiniMax Responses choices remain unimplemented/unverified profiles, not vendor-wide impossibility claims.
- Durable conversations, scoped shared-service tools, change previews and paid-generation approval remain future increments. Reasoning/tool continuation requires proper item/call IDs and opaque reasoning state as specified above, not flattened text.
- Real remote provider/account/billing behavior, macOS/Windows native QA, signed packaging and system-vault behavior outside the tested Linux session-only fallback remain unverified.
