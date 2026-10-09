# Conversational streaming increment

Date: 2026-10-09 (UTC)
Feature baseline: `66a0193` (secure Agent settings); integration baseline: `80334cf` (roadmap-only follow-up)
Status: increment 2A, Chat-Completions-only conversational transport, implemented with runtime acceptance; aggregate verification passed; parent review/local commit pending. Responses is required in immediate increment 2B of the same current Agent iteration; compatibility is incomplete until both are delivered. No completed-Agent claim.

## Bounded outcome

This increment adds text conversation, a secure Chat Completions gateway, streaming, Stop and explicit error/reconnect behavior. It is **conversation-only**: the model cannot read project records, inspect media, use tools or edit the workspace. Only text typed in this conversation and a bounded selection of completed prior chat turns are sent. Project identity is used for local isolation, not as automatic model context.

Conversations are temporarily retained in the **current backend process only**. They survive dialog dismissal, project navigation and renderer reload while that backend remains alive. Backend/app restart loses them; there is no persistent conversation recovery or automatic resend. The separate Responses adapter and explicit versioned protocol settings follow immediately in increment 2B, before unrelated work. Durable conversations and scoped tools follow those transport increments in [the iteration plan](AGENT-ITERATION.md).

One explicit Send starts at most one inference POST and one response. There are no tools, autonomous rounds, provider fallback or implicit retries. A detached response may finish under its original project; it never creates another round. Stop preserves partial output and aborts local work, but cannot promise to reverse remote computation or billing.

## Ownership and interfaces

- Gateway: business `agent/network-policy.mjs`, `sse.mjs`, `chat-completions.mjs`, `chat-errors.mjs`.
- Runtime: business `agent/chat-runtime.mjs`, trusted settings credential acquisition, narrow desktop broker integration.
- HTTP: dedicated `apps/server/src/chat-http.mjs`, small server lifecycle integration.
- UI: dedicated `AgentPanel.jsx` and `agent-chat.js`; minimal App integration and scoped styles, retaining the secure settings dialog.
- Independent security review plus synthetic HTTP/browser/native acceptance. Builds and aggregate suites run serially.

The authenticated route family is `/api/agent/chat/:projectId`:

- GET: temporary conversation snapshot and safe settings metadata.
- POST `/runs`: explicit send with stable request UUID, backend instance UUID, expected settings/conversation revisions, message and destination/model/context consent tuple.
- GET `/runs/:runId?instanceId=...`: read an existing run.
- GET `/runs/:runId/events?instanceId=...&after=...`: bounded SSE replay, never inference restart.
- POST `/runs/:runId/stop`: stop that exact project/run/instance.

All run reads, event subscriptions, deduplication and Stop checks validate project ownership and backend instance. Reusing a send UUID with changed input conflicts. An evicted request leaves a tombstone rather than becoming permission to send again. Lost acknowledgements are reconciled by reads; a new Send requires a new explicit user action. An unresolved receipt is deliberately not cleared merely because a snapshot lacks its run: absence does not prove rejection. If rereading never finds it, this stage requires a backend/app restart to invalidate the old instance and start again. That loses all temporary chats, and the original remote work or charges may already exist. A narrow request-ID cancellation fence is deferred; this is a documented recovery limitation, not successful recovery. Only instance/request IDs may be kept in renderer session storage, never prompts, responses, settings or credentials.

Settings acquisition is a trusted backend operation, not an HTTP, CLI, MCP, renderer or model capability. It rechecks the settings revision, exact credential binding and current vault availability. The renderer continues to receive only safe presence/storage flags. No preload or general IPC capability is added.

## Outbound consent and context

Before sending, the UI shows the chosen endpoint/model, temporary persistence, and the category of content to be transmitted. Explicit consent must match the backend's current destination/model and expected conversation revision. A changed destination, changed conversation or restarted backend requires rereading and explicit confirmation.

The backend composes a fixed capability-limiting system instruction plus bounded completed text turns and the new user text. Partial, failed or filtered output must not be silently presented as a complete successful turn. No project name, project payload, credential, filesystem path or media is inserted automatically.

Provider/model output, provider errors and previous assistant messages are untrusted text. They cannot change endpoints, context categories, project scope, authority or execution policy. The UI renders plain escaped text, with no model-supplied active HTML, image fetches or tool buttons.

## Network and compatibility boundary

The production gateway uses built-in Node HTTP(S), not browser fetch or environment proxy forwarding. Remote profiles require HTTPS, validation of every DNS answer, one pinned connection destination, peer verification and normal TLS certificate/hostname checks. Redirects, arbitrary headers, cookies, private/metadata destinations and request-time endpoint overrides are denied. DNS/connect, idle and total durations plus response/header/event/text sizes are bounded. Cancellation during DNS must prevent a later socket connection. The gateway also conservatively denies Azure’s public-looking platform VIP `168.63.129.16`, documented as a platform/WireServer channel rather than an ordinary provider endpoint ([Microsoft source](https://learn.microsoft.com/en-us/azure/virtual-network/what-is-ip-address-168-63-129-16)).

Ollama is a separate exact loopback `/v1/chat/completions` path. It denies the Mioon backend's own port and does not become a generic local-network fetch tool. User-configured endpoints remain editable; unsupported models/protocol features produce a meaningful failure rather than silent field removal, protocol substitution or rerouting.

The initial named profiles cover the officially researched baseline model IDs only. An editable model field does not certify arbitrary models from a vendor. A custom remote compatible profile has a deliberately small text-only contract. Reasoning and tool-call outputs are unsupported in this stage; they never execute. [Provider research](AGENT-PROVIDERS.md) remains documentation evidence, not a live service compatibility certificate.

## Lifecycle and platform gates

- Dialog close/project navigation detaches UI state; stale stream callbacks cannot write into another project or a later dialog lifetime.
- SSE cursor replay is read-only. A gap is reconciled from a snapshot, never by repeating inference.
- Stop is idempotent. Late gateway bytes cannot reopen or mutate a terminal run.
- Shutdown aborts inference, closes SSE clients and drains bounded work before HTTP/store close. Native menu restart and normal quit must remain responsive with an active stream.
- Shared modules own business and network behavior. Platform-specific secret storage stays behind the existing desktop adapter; no Linux-specific production paths or implicit Windows/macOS readiness claim.

## Verification plan and current status

Implemented verification coverage:

1. Offline/injected DNS/socket tests: special IP ranges, mixed public/private answers, rebinding, TLS name/peer pinning, proxy/redirect denial, local exception, own-port rejection and timeout/abort cleanup.
2. Bounded SSE/protocol fixtures: fragmented UTF-8/CRLF, keepalives, usage-only chunks, malformed/deep/oversized JSON, missing terminal markers, repeated terminal frames, tools/reasoning fields and mid-stream errors.
3. Runtime/HTTP tests: exact replay, changed reuse, cross-project and old-instance denial, lost acknowledgement, consent/settings/conversation conflicts, cache bounds, cancellation, subscriptions/backpressure and shutdown.
4. UI tests: duplicate Send, unknown acknowledgement without retry, detach/reopen, stale callbacks, project switch, restart loss, plain-text rendering and explicit consent renewal.
5. Actual Chromium and sandboxed Linux Electron against a local **synthetic Ollama-shaped HTTP server**, using the real gateway and standard settings. No external provider or model is involved. Validate streaming, Stop, failure, dismissal, navigation, late acknowledgements, backend restart and unchanged project data.
6. Serial aggregate suite, web/development-desktop builds, final-bundle runtime checks, original screenshots and `git diff --check`.

No live credentials, external provider call, media upload, OAuth, installer, push or deployment is authorized by this local development increment.


## Observed acceptance (increment 2A only)

- Independent security review: **113/113 focused cases passed**, no remaining blocking finding. Includes the seven new gateway/runtime/HTTP/credential/UI suites and settings/desktop regressions. Fixes during review covered partial/filter completion, error-code mapping, prototype-shaped receipt keys, truthful unresolved-send guidance and the Azure platform VIP deny rule.
- Owned runtime regression: **62/62 passed**, `evidence/agent-chat/runtime-focused-tests.log`.
- Final full aggregate: **725/725 passed, zero failures/skips**, 101.2 seconds. Command: `node --test --test-concurrency=2 tests/*.test.mjs`; log `evidence/agent-chat/all-tests-bounded.log`. Run serially after final builds and runtime QA, with browser/native acceptance idle.
- Web and development-desktop builds: **passed serially**. Logs: `evidence/agent-chat/{web-build,desktop-build}.log`. UI assets: `index-yKtSRbc0.js` / `index-BdccRlXR.css`; development identity `app.starroy.mioon.dev`. The established 768 MiB Node heap bound was used for the web build; no build configuration or security override changed. Existing dependency-directive/bundle-size warnings remain.
- The first aggregate found one shared-component guard failure (722/723): consent used a raw input. It was replaced with existing shared Input/Label, without weakening the guard; 77/77 affected UI tests and independent delta review passed. Both builds and all eight browser checks were rerun afterward. The failed log is retained as `all-tests-attempt-shared-controls.log`.
- `git diff --check`: passed.

### Actual Chromium

Eight recorded checks passed in the own-cloud Chromium browser against the final built UI and real production gateway to a synthetic local HTTP fixture:

- Opening/typing makes no model request. Explicit endpoint/model/context consent starts one request; Stop closes upstream and preserves partial output.
- Truncated streams fail honestly; function-call output is rejected; hostile HTML/instructions remain inert text.
- Dropped accepted send acknowledgement is reconciled by reads without a second inference POST.
- Dismiss/reopen attaches to the existing run; project navigation isolates the other conversation.
- Held acknowledgement cannot overwrite a newer draft; restart during active SSE closes upstream and shows explicit temporary-session loss, with no resend. The observed backend close/start was 10 ms in this fixture; this is evidence, not a general latency guarantee.
- Actual native window resize to a 500 × 757 viewport preserves destination/consent/composer/footer access without horizontal overflow; restore/close/reopen remains responsive.
- All project/media/timeline/job/history records remain unchanged.

Report: `evidence/agent-chat/browser/report.json`. Original JPEGs under `evidence/agent-chat/browser/`:

1. `01-explicit-destination-consent.jpg`
2. `02-synthetic-streaming.jpg`
3. `03-stopped-partial-billing-warning.jpg`
4. `04-truncated-stream-preserves-partial.jpg`
5. `05-hostile-output-is-inert-text.jpg`
6. `06-lost-acknowledgement-no-resend.jpg`
7. `07-navigation-isolates-project-conversation.jpg`
8. `08-late-ack-cannot-replace-new-draft.jpg`
9. `09-backend-restart-explicit-session-loss.jpg`
10. `10-narrow-consent-composer.jpg`

### Actual Linux Electron

Seven checks passed in the ordinary sandboxed development application, without remote debugging, smoke hooks or renderer privilege changes:

- Settings save makes no probe; the dummy key clears from the input and no plaintext key/chat text enters the metadata file.
- Explicit native consent sends to the exact local synthetic endpoint. The fixture records only whether the Authorization header was present, confirming the narrow main/utility credential path without logging its value.
- Native Stop closes an incomplete stream and retains partial text.
- Normal app restart clears temporary chat/session-key state while keeping nonsecret configuration.
- Application-menu restart during an active response replaces utility PID/port and aborts upstream. The replacement starts with empty temporary history, never repeats inference.
- Normal app quit during active SSE exits 0, removes its connection descriptor and aborts the incomplete upstream response.
- Domain records remain unchanged; settings file mode is 0600 with no dummy key/chat marker.

Report: `evidence/agent-chat/native/report.json`; read-only snapshots are under `native-runtime/`. Original JPEGs under `evidence/agent-chat/native/`:

1. `01-synthetic-session-connection.jpg`
2. `02-native-explicit-outbound-consent.jpg`
3. `03-native-streaming-real-local-http.jpg`
4. `04-native-stopped-partial.jpg`
5. `05-native-relaunch-empty-temporary-history.jpg`
6. `06-active-stream-restart-confirmation.jpg`
7. `07-after-restart-temporary-history-empty.jpg`
8. `08-active-stream-before-normal-quit.jpg`
9. `09-final-shared-control-consent.jpg`
10. `10-final-native-streaming.jpg`
11. `11-final-native-stopped.jpg`
12. `12-final-active-stream-quit.jpg`

An initial 13-second mock response completed while its native restart confirmation was being inspected; it was not counted as an active-restart pass. The bounded synthetic stream was extended to 44 seconds and both active restart and quit were rerun successfully. No application source change was needed. A new native partition displays empty history plus the fixed temporary-history disclosure; the browser's same-session restart additionally displays the session-lost banner.

The initial seven native checks preceded the shared-control-only correction. Final-bundle native consent, streaming, Stop and active quit were rerun successfully (three additional checks in `finalBundleRegression`); gateway/backend business source was unchanged. Opening/typing still made no request, both explicitly sent streams closed incomplete, normal quit exited 0 and domain records remained unchanged.

The 22 files are original runtime JPEGs, verified with dimensions and hashes in `evidence/agent-chat/screenshots-manifest.json`. Evidence is gitignored and delivered separately with the local commit report.

### Remaining boundaries

This is CC-only text conversation, not full compatible Agent completion. [The immediate Responses increment](AGENT-RESPONSES.md) is required next. Tools, durable conversations, workspace execution and paid-generation approval remain unimplemented. Unresolved sends may require restarting the backend, with the loss/cost limits described above. Real provider compatibility and billing remain unverified; remote HTTPS/DNS/TLS behavior was tested with injected socket/DNS fixtures, not live vendors. Native macOS/Windows keychains/ACLs and a working Linux encrypted keyring are not certified by these Linux runtime and synthetic tests.
