# In-app Agent iteration plan

Date: 2026-10-09 (UTC)

Status: **settings (`66a0193`), Chat Completions (`3db1a02`), dual-protocol/right-dock (`e2db533`), durable chat (`ce60c97`), scoped inspection (`8341029`), both-protocol read tools (`dbf3b93`) and six-operation shared replay (`2ba58ee`) are committed. The narrow reviewed title/prompt editing increment has local synthetic runtime acceptance and awaits independent final aggregate/release review.** See [settings acceptance](AGENT-SETTINGS-ACCEPTANCE.md), chat acceptance, [Responses contract](AGENT-RESPONSES.md), durable chat, [shared scoped inspection](AGENT-INSPECTION.md), [bounded read tools](AGENT-READ-TOOLS.md), [shared replay](MUTATION-REPLAY.md) and reviewed edits. Broader edits and generation approvals remain planned. The companion [provider research](AGENT-PROVIDERS.md) does not certify live compatibility.

The architecture review used local HEAD `821600f` and the then-uncommitted panel work. The panel release was subsequently handed off as `ed23ef7`, the baseline for the first Agent settings increment. Preserve that panel work. Secure settings were committed as `66a0193`; `80334cf` adds roadmap documentation. Stage 2A was committed as `3db1a02`; stage 2B as `e2db533`, with independent Responses/CC adapters and the inline right dock. Stage 3A started from `9716677` and was committed as `ce60c97`, adding local typed-chat durability without project tools. Stage 3B starts from `ce60c97` and adds shared non-creating inspection without connecting it to model conversations.

## Outcome and scope

Deliver a real, project-scoped conversational Agent inside Mioon, with editable common-provider presets, secure in-app key configuration, streaming/cancellation/recovery, and tools that execute the same business operations used by the UI, CLI and MCP bridge.

The first complete increment can read the current project, propose and apply bounded local edits, and propose video generation for explicit approval. It is not merely a chat window that describes changes without executing them.

Included decisions:

- Keep the external CLI, official-SDK MCP bridge and portable Mioon skill usable. They continue to operate on the same running backend and data.
- Offer OpenAI, DeepSeek, Qwen, Zhipu/Z.ai, Kimi, MiniMax, OpenRouter, custom compatible and local Ollama presets. Region/account distinctions remain explicit.
- Settings are configurable inside the app. Keys are entered by the user, never prefilled with real credentials in development or evidence.
- Report every future local commit with its hash, verification scope and actual runtime screenshots.
- Preserve current editing, timeline/history, media, job recovery, desktop identity and security behavior.

Deferred: Codex/ChatGPT OAuth; reasoning-enabled model profiles; multimodal Agent context; arbitrary external MCP servers; browser/shell/filesystem tools; autonomous asset uploads; deployment and installers. These are separate capabilities, not implied by an OpenAI-compatible label.

Development/acceptance must use synthetic mock services and dummy credentials only. Live model calls, paid generation, real media uploads, OAuth, credential entry, push and deployment are outside this iteration's current execution authorization.

## Existing foundations and gaps

Existing architecture: UI calls authenticated HTTP; CLI/MCP use the shared client; all reach `packages/business/src/services.mjs`. Business imports no React, Electron or transport implementation.

Important gaps found in the review:

1. `services.call(operation, input)` currently has no caller/project authorization context. ID-only reads and writes can resolve records outside an Agent's selected project.
2. Timeline/reference requests already have exact durable replay. Several shot/node/selection/order operations lack stable request IDs. A chat-only journal cannot make those operations exactly-once across a crash.
3. At this Agent review baseline, Electron had no preload or renderer IPC bridge. The later [desktop project-window bridge](DESKTOP-PROJECT-WINDOWS.md) is limited to fixed window actions and non-secret identity; Agent still receives no general native APIs or file authority.
4. Server shutdown drains HTTP requests before closing SQLite. New long-lived SSE connections must end during shutdown or desktop restart/quit can hang.
5. Existing live-generation gates cover backend enablement, local generation counts and approved reference hashes. They do not provide a reliable monetary quote or enforce a currency budget.
6. Existing `project.get` and `timeline.get` can lazily create a missing timeline. A genuinely read-only Agent mode must use a shared non-creating inspection path, rather than mislabel these initialization side effects as read-only. Preserve existing public behavior for older clients.

## Minimal model protocol

Current approved scope explicitly includes **both Chat Completions and OpenAI Responses**, using independent adapters, explicit protocol selection/defaults and application-managed history. The 2026-10-09 scope correction supersedes the earlier Responses deferral. Ship two promptly consecutive bounded increments: 2A is the reviewed Chat-Completions-only conversational transport; 2B immediately adds Responses and versioned settings migration before unrelated features. Completion of 2A is not completion of compatible Agent support. Non-thinking model profiles remain the initial baseline; proper function-call/result semantics are required before scoped tools use either adapter.

- Use named function definitions and tool-call IDs. Plain text resembling a function call is never executable.
- Runtime contract validation is authoritative, even if a provider advertises strict schemas.
- Do not require forced tool choice, parallel tools, strict structured outputs, JSON response mode, vision or hosted tools.
- Request fields are selected by a documented provider/model profile. Do not silently remove rejected fields, change endpoint/model/region, or switch protocols to make a request appear successful.
- Default to automatic tool choice. Tools are executed serially under application policy, even if a provider returns multiple calls.
- Parse streamed arguments by tool-call index/ID and execute only after complete valid response termination. Truncation, malformed arguments or a failed stream executes no pending tools.
- Accept valid optional usage/empty chunks and SSE keepalives. Detect mid-stream error events. Duplicate terminal/accounting frames must not dispatch twice.
- Keep documented provider continuation fields separate from display text. Do not accept arbitrary provider fields as instructions. Reasoning modes remain unavailable until their own round-trip requirements pass tests.
- Use `store: false` in the OpenAI profile. This is not a claim that all compatible providers implement identical retention controls.

Responses is a separate adapter required in immediate increment 2B: it changes function definitions, output-item shapes, call correlation and state handling. Existing Zod schemas also cannot be blindly marked `strict: true`: OpenAI strict schemas require all properties to be required and objects to disallow additional properties. See [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [streamed chunks](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events), and [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses).

## Project and tool boundary

Add a backend-created execution context containing the immutable run/project identity, caller class and allowed capabilities. This context is not a model argument or a client-supplied authority flag.

- Resolve all indirect `shotId`, `nodeId`, `sourceNodeId`, `targetShotId`, `edgeId`, `jobId`, `versionId`, `exportId`, `assetId`, `referenceAssetIds`, and nested timeline track/clip IDs before access.
- Validate scope before returning records, revision-conflict details or idempotent responses. A saved replay must retain its project ownership even after an entity is removed.
- Host-inject project IDs, request IDs and policy context into projected tool inputs; reject attempts to override them.
- Reuse business contracts and handlers. Do not implement a second editing engine or let the Agent call handlers directly around the dispatcher.
- Existing fully authorized local UI/CLI/MCP access is not automatically reduced to one project. Their business results and replay/conflict semantics remain shared; the embedded Agent has an explicitly narrower execution context.
- Agent/session/settings/approval routes are not automatically exported into the MCP business catalog.

Initial read tools: bounded current-project metadata, asset metadata, shots, timeline/history, jobs, versions, exports and safe video-provider capabilities. Global project discovery is not included.

Add an explicitly non-creating shared inspection operation/helper for legacy projects without a timeline. Read-only mode must not initialize one indirectly through the current `project.get` implementation.

Initial editable tools: shot creation/update, selected-version choice, first-frame reference attach/detach, and existing timeline edits/render. Start with a bounded proposed change set and explicit Apply control; show exact project, targets and diffs. Do not advertise full-catalog support before each operation has its scope/replay coverage.

Do not expose arbitrary RPC, project creation/discovery, base64 asset import, local paths, downloads to arbitrary destinations, shell/network/browser tools, provider settings, secret operations or model-supplied provider-job reconciliation. Manually imported managed assets can be referenced by ID within the same project.

## Shared replay and conflict rules

Add backward-compatible optional `requestId` support to previously unjournaled mutations. Agent and updated first-party clients must use it. Discovery should distinguish optional support from required request IDs rather than falsely describing legacy calls as replay-safe.

- Journal operation, project, canonical request hash and original public response in the same transaction as each supported mutation.
- Exact retry returns the original response before revision validation, including after later edits and restart. Changed reuse returns `IDEMPOTENCY_CONFLICT`.
- Keep existing timeline/reference journals and generation recovery behavior intact. Never reconstruct an old response from mutable current state.
- Generate stable mutation request IDs in the backend and save intent before dispatch. Provider tool-call IDs alone are not globally unique application request IDs.
- Preserve expected revisions. A conflict refreshes evidence and requires a new proposal; it must not silently replace the revision and overwrite the user's edit.
- Avoid wrapping async handlers in a generic outer SQLite transaction. Integrate synchronous mutation transactions deliberately; existing timeline/reference services already own transactions.
- The Agent's tool-intent journal tracks orchestration, while the shared mutation journal proves whether the business operation committed. Reconcile the latter after a crash.
- Repeated stream fragments/call IDs and unchanged no-progress loops must not cause duplicate operations. Do not use a new request ID to recover an uncertain operation.
- Batches are not implicitly all-or-nothing. If a later operation conflicts, accurately display earlier committed edits and the remaining unapplied work.

## Context and untrusted content

Before first send, display the provider destination, model, current project and categories of context to be transmitted.

- Include only bounded relevant saved project text/metadata and explicit selections. Use summaries/pagination rather than dumping the full project/history.
- Exclude credentials, local paths, media bytes, unrelated projects and unsaved editor contents by default. Do not imply the model has visually inspected a media asset when it received only metadata.
- Treat project text, node names, prompts, asset names, tool results, provider errors and model output as untrusted content. They cannot change system instructions, scope, endpoints or approval state.
- Render escaped content. Validate internal record links/buttons against the active run's project. Never auto-fetch model-supplied URLs or render active HTML.
- Strip secrets and internal fields at explicit serialization boundaries; do not rely on a blacklist alone to make arbitrary objects safe.
- Approval and authorization tokens never enter the model context or tool schemas.
- A project switch never retargets an existing run. Events, Apply controls and results remain tied to the original project; stale callbacks cannot mutate the newly opened project.

## Secrets and endpoint policy

### Storage

Use a write-only authenticated settings API, an injected secret-store interface, and a narrow broker between the trusted desktop backend utility and Electron main.

- The settings password input necessarily holds a newly typed value transiently. Clear it after submission and on dismissal. There is no stored-secret getter or refill.
- Return only safe configuration status and an opaque secret reference. Never store plaintext keys in project SQLite, localStorage, conversation transcripts, logs, screenshots or export bundles.
- Desktop persistence uses `safeStorage` with a real OS secret store, channel/profile/origin binding and owner-restricted ciphertext files outside the project data directory.
- If encryption is unavailable or Linux reports `basic_text`, fail closed for persistence and offer session-only storage. Do not call plaintext mode an encrypted vault.
- Web-server mode initially supports backend-memory session-only entry. A persistent web vault requires a separately designed external key source; encrypting a file with a key beside it is not sufficient.
- Decryption is available only to the trusted backend for the selected profile, never arbitrary renderer requests. Preserve the app's no-preload/no-general-IPC policy.
- Origin/region changes invalidate the old credential binding. Never silently forward the previous key to a new destination.
- Protect against stale saves, restart races and failed replacement/deletion. OS-backed encryption protects storage at rest, not a compromised same-user process.

Electron documents that Linux `basic_text` uses a hardcoded password and is not protected secret storage: [safeStorage reference](https://www.electronjs.org/docs/latest/api/safe-storage).

### Network

- Remote endpoints require HTTPS, a validated path prefix, no username/password, query or fragment, and no redirects.
- Deny private/link-local/loopback/metadata destinations in remote profiles, including IPv4-mapped IPv6 and DNS-rebinding routes. Validate and bind the actual connection destination, not only the initial hostname lookup.
- Local Ollama is a separate explicit loopback profile with a fixed API route shape. Reject Mioon's own service port and do not turn this exception into unrestricted localhost access.
- Custom LAN/enterprise endpoints require a future explicit allowlist design; no generalized private-network bypass in this increment.
- Do not accept arbitrary headers, proxy configuration or model-supplied URLs. Apply profile-bound Bearer authentication only when configured; local Ollama normally needs no key.
- Capability/model-list probes require an explicit user action. Merely opening settings makes no provider request.
- Connection tests use synthetic text/tools, disclose possible inference billing and send no project content. There is currently no authorization to run real tests during development.

## Streaming, cancellation and recovery

Persist project conversations, runs, monotonic event IDs, model-request boundaries, tool intents and results independently of workspace view preferences.

Suggested starting bounds: 8 model rounds, 24 tool calls, 10 local mutations and 120 seconds per run, plus explicit context, argument, response and event byte limits. These are engineering limits, not currency-budget guarantees. A reached limit produces a visible resumable/terminal state, never an infinite loop.

- SSE reconnection reads saved events by cursor; it does not resend the user's message or restart inference.
- Batch text persistence reasonably; do not write a SQLite transaction for every character.
- Stop aborts active inference, revokes future tool dispatch and preserves truthful partial output/results. A synchronous mutation already committed before cancellation remains committed.
- Dropping a renderer connection is not proof the run failed. Reconnect to its durable state. Project navigation/hiding a panel must not silently create another run.
- Backend restart marks interrupted inference explicitly and reconciles durable tool intents. Do not automatically repeat an inference POST that may already have billed.
- Resume is an explicit action after interrupted inference. A known committed mutation reuses its saved result. Existing video jobs remain governed by their current job-recovery rules.
- Shutdown closes SSE clients, aborts model requests and drains bounded in-flight work before closing the store. No delayed callback may write after SQLite closes.
- Keep Agent Stop distinct from video job cancellation. Closing a stream does not guarantee a remote provider stopped computation or billing.

## Paid video generation

Expose a proposal tool, not an unrestricted paid submission tool.

The trusted approval UI must show and bind the project, shot revision, provider/account region/model, prompt, reference IDs/hashes, input mode, parameters, count and exact request. A one-use approval is tied to that immutable proposal; it cannot authorize a different payload, retry or destination.

- Approval is a direct user action, not model text, a tool result or a quoted instruction.
- Revalidate at submission. A changed snapshot/region/model requires a new proposal.
- Retain backend live-enable, per-provider count and reference-media authorization gates. Approval cannot enable missing backend credentials or bypass model capability checks.
- A live retry of a definitively failed job requires new approval and its own stable request ID.
- `submission_unknown` never causes automatic resubmission. Preserve/query the existing job and provider ID.
- Exact replay of an already accepted request remains safe after approval consumption; it must not require or consume a second approval.
- Show known charges/limits honestly. The current adapters do not establish a trustworthy currency quote or monetary cap. A count limit must never be called a financial budget.
- Local waiting cancellation does not claim remote cancellation or a refund.

## Staged commits and acceptance

Stages 0–4 are committed. Stage 3A has independent 902/902 acceptance; stage 3B has independent 974/974 and native runtime acceptance; stage 3C has independent 1,085/1,085 and both-protocol synthetic runtime acceptance. Stage 4 has independent 1,160/1,160 acceptance. Stage 5A has local synthetic runtime acceptance and awaits independent final release review; stages 5B–7 remain planned. A stage is not done until its tests and actual runtime evidence are recorded. All runtime model/provider fixtures must be visibly labeled simulated.

| Stage | Main ownership/files | Acceptance and runtime evidence |
| --- | --- | --- |
| 0. Record contract | This document; `AGENT-PROVIDERS.md` | Confirm panel handoff commit; retain actual current-workspace baseline screenshot. No new Agent capability claimed. |
| 1. Secure settings | New `AgentSettings.jsx`; business `agent/config.mjs`, `presets.mjs`; desktop `secret-store.mjs`, `secret-broker.mjs`; integrator-owned server/desktop entry points | Preset/region/model edit, reset, origin invalidation, replace/delete, safe reload, dummy-key redaction, real Electron unavailable-vault behavior. Screenshot settings and storage status. |
| 2A. Chat Completions streamed chat | Business `agent/chat-completions.mjs`, `sse.mjs`, `network-policy.mjs`; web `AgentPanel.jsx`, `agent-api.js`; synthetic mock server | Text streaming, stop, retry UI, fragmented UTF-8/SSE, keepalives, usage chunks, malformed input, truncation and mid-stream errors. Screenshot streaming, stop and actual simulated failure. |
| 2B. Responses and protocol settings | Separate `responses.mjs` adapter; explicit protocol field/defaults; versioned settings and credential-binding migration; consent/client projections | Stateless Responses history, completed/incomplete/failed event semantics, fragmented output, unsupported reasoning/tool output, cancellation and no automatic fallback. Preserve v1 settings/encrypted keys or fail closed when vault unavailable. Mock-only browser/native protocol-switch evidence and adapter-specific tests. Must follow 2A before unrelated work. |
| 3A. Durable typed chat | Business `agent/chat-journal.mjs`, `chat-runtime.mjs`; additive migration; authenticated lookup/history routes; existing Agent client/panel | Actual both-protocol crash/restart with stable IDs and no inference retry, durable event replay, quota/write faults and history/draft races. Screenshot restored completed/interrupted history. No tools yet. |
| 3B. Scoped inspection | Shared non-creating inspection operations, effect metadata and trusted project dispatcher | Two-project direct/indirect-ID denial matrix, bounded safe DTOs, no lazy timeline creation, unchanged external replay semantics. |
| 3C. Both-protocol read tools | Context/tool catalog, durable tool intents/results, CC/Responses continuation and run-level consent | Complete validated tool calls only; bounded approved reads/rounds, scope/destination pinning, Stop/restart and navigation policy. Screenshot project-labelled conversation and real scoped record result. |
| 4. Shared replay | Contracts, `services.mjs`, `mutation-replay.mjs`, migration, client discovery/request support; committed `2ba58ee` | Real HTTP/CLI/MCP replay after newer edits/restart; lost-response recovery; changed reuse; stale revisions; stable IDs; unchanged historical replay. Screenshot actual before/after/recovered project state. |
| 5A. Reviewed shot text | Immutable proposal/approval store, project-scoped shared shot.update, selected-shot consent and right-dock review | First bounded write allows title/prompt only. Double approval once, original diff/revision, reject/Stop, crash and native recreation with exact persisted key. No automatic startup execution. |
| 5B. Broader local editing (planned) | Scoped dispatcher/policy; additional supported proposal projections | Canvas/timeline edits and bounded batches require their own scope/recovery tests; not included in 5A. |
| 6. Generation approval | Proposal/approval store and routes; existing generation services; UI approval/result | Mock-only deny/approve once/double-click, stale snapshot, failed retry, lost response, restart and unknown submission. Screenshot disclosure and recovery of the existing job. |
| 7. Final hardening | Tests and API/contract/CLI/MCP/skill/acceptance documentation | Aggregate tests, web/development-desktop builds, real browser/Linux Electron regressions, source/destination/redaction review. Screenshots linked to exact final commit. |

Do not turn stage 4 into a wholesale rewrite of all historical operations. Add exact replay for the new writable allowlist first, while keeping previously supported semantics unchanged. Expand the allowlist only with corresponding scope/recovery tests.

## Verification matrix

New focused suites should cover:

- `agent-protocol`: text/function/result round trip, fragmented/interleaved indices, tool IDs/names only on first chunk, empty content, unknown tools, repeated IDs, malformed/deep/oversized JSON, truncation and non-function outputs.
- `agent-scope`: every direct and indirect ID type; same ID-shaped inputs from another project; conflict/replay error leakage; removed entities; nested timeline ownership; export/asset paths.
- `agent-replay`: crash before/after commit, lost response, restart, concurrent duplicate request, changed reuse, cancellation between intent and commit, stable output IDs.
- `agent-policy`: untrusted project text asking for credentials or other-project access, forged approval fields, paid retry bypass, unauthorized settings/network tools and repeated no-progress loops.
- `agent-network`: redirects, URL credentials, private/metadata addresses, IPv6 forms, DNS rebinding, self-service localhost port and endpoint/key-binding changes.
- `agent-secrets`: write-only API, no reads through MCP/CLI/model tools, fake-key redaction in every error path, unavailable vault/basic_text, failed save/delete, session-only restart and channel isolation.
- `agent-lifecycle`: SSE reconnect and cursor bounds, out-of-order/stale UI events, backend stop, pending approval, project switch, close/hide/reopen, two windows and auth rotation.
- Browser and native Electron acceptance: real tool-driven edits and existing panel/timeline/preferences regressions, not only component snapshots.

Run existing aggregate checks and web/development-desktop builds against the final code. Record passed, failed and not-run separately. No live capability claim may be inferred from injected-fetch or mock-server tests.

## File ownership and dependencies

- Business owner: migrations, shared contracts, scope enforcement, mutation journals and service integration.
- Transport/security owner: model adapter, SSE, endpoint policy and desktop secret broker.
- Renderer owner: dedicated Agent panel/settings and run UI state.
- One integrator: `App.jsx`, `styles.css`, server entry point, desktop main/backend/config/supervisor, manifests and release/status documentation.
- Independent QA: synthetic servers, adversarial suites and browser/native runtime evidence.

Avoid simultaneous edits to shared hot files. Stage 5 depends on scoped reads and shared replay; stage 6 depends on both plus the approval boundary. Provider/transport unit work can run independently once interfaces are agreed. Panel/layout files remain owned by the current panel work until handoff.

## Open boundaries and release blockers

- Writable Agent cannot ship before scope enforcement and shared durable replay.
- Persistent credentials cannot ship with a plaintext/basic_text fallback.
- Custom endpoints cannot ship with generalized SSRF or automatic key forwarding.
- Backend shutdown/restart must be verified with actual SSE connections in Electron.
- An Apply/approval mechanism must bind exactly what the user reviewed; no hidden scope expansion on resume.
- Provider presets are documentation-backed until tested per endpoint/model/mode. Account access and real compatibility remain unverified.
- macOS/Windows native keychain behavior remains unverified until native tests. Linux dummy-vault tests are not cross-platform certification.
- Currency pricing/enforcement is unresolved. Do not advertise guaranteed spend caps based on generation counts or token counts.
- No new installer, OAuth, live invocation, push or deployment is implied by completion of this local iteration.
