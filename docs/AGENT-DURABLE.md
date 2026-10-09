# Durable typed-chat conversations

Date: 2026-10-09 (UTC). Baseline: `9716677`.

Status: implementation and local synthetic acceptance complete; pending independent
parent review and local commit. This is the first durability increment, **not scoped project tools or a completed editing Agent**.
Both Chat Completions and Responses remain supported by their existing independent
text adapters. All acceptance uses synthetic local HTTP services; no live account,
real key, media upload, OAuth or paid generation is authorized for this work.

## Stored state and identity

An additive SQLite migration introduces Agent-owned thread, accepted-request,
run, event and quota tables. Existing project/business rows, mutation journals,
workspace preferences and media are not rewritten.

- One stable thread identity per project. Empty views derive the same UUID without
  creating database rows; first acceptance materializes it. Identity is not
  authorization: every access still validates the requested project.
- Run and request IDs survive backend and application restart. The backend
  `instanceId` remains an ephemeral epoch that rejects stale send/Stop/SSE calls.
- Accepted request fingerprint, selected typed-chat context, consent, settings
  revision and exact configuration are immutable. No credential enters this
  record. Settings changes cannot retarget a previously accepted run.
- Acceptance commits before acknowledgement and before credential acquisition or
  gateway invocation. A durable model-request boundary commits before invoking
  the gateway; this is not proof the provider received, accepted or billed it.
- Exact duplicate requests return the original run before current revision checks,
  after project/epoch validation. Changed reuse conflicts. No request tombstones
  or accepted runs are silently evicted to make room for another send.

Only the latest 16 runs form the existing context-selection window. At most 12
completed turns, the fixed instruction and the current message fit within the
32-KiB text budget. Failed/stopped/interrupted turns are excluded. Browsing older
history never widens outbound context. The exact selection is made once in the
backend and retained with acceptance, not independently reconstructed by the UI.

## Recovery and stream lifecycle

- Text batches are bounded to 2 KiB or approximately 50 ms. A batch, run snapshot
  and monotonic event sequence commit before the event is published. Terminal
  transitions and Stop flush eligible pending text in the same transaction.
- Startup locally marks unfinished runs interrupted. A started model request
  becomes unknown; no inference, credential acquisition, tool dispatch or POST
  retry occurs during reconciliation.
- An authenticated read-only request-ID lookup resolves lost acknowledgements
  across epochs and outside the most recent history page. SSE reconnection reads
  saved events or a current snapshot; it never re-sends the message.
- Stop revokes future work, aborts the active request and preserves committed
  partial output. It does not promise remote cancellation or a refund.
- Shutdown interrupts runs and closes subscribers before HTTP drain and SQLite
  close. Old promises, timers and provider callbacks are fenced.
- If a journal write fails, the runtime fences further work and closes SSE
  without publishing a fabricated terminal. The next healthy startup reconciles
  the durable state. A failed acknowledgement is not evidence of failed admission.

The renderer retains a pending request ID until read reconciliation succeeds, or
the user explicitly ends checking after a duplicate-cost warning. Ending local
checking neither cancels the remote computation nor re-sends anything; a new
send requires fresh consent.

## Bounds and privacy

The journal retains at most 2,048 runs and 64 MiB of accounted logical data, with
reserved terminal capacity and bounded active work. This is not a physical SQLite
file-size guarantee: WAL, indexes and free pages have their own overhead. Capacity
or storage failure stops new work explicitly; there is no automatic transcript or
replay-journal deletion. A chat-history deletion/export/retention UI is not part of
this increment.

History is read in SQL-bounded 16-run pages. The renderer keeps one older page and
a bounded cursor trail separately from the current conversation and draft.

Sent chat text and replies are stored in the local application database. **This
database is not encrypted by the credential vault.** The UI discloses this before
send and asks users not to enter secrets. Application credentials remain in the
existing separate secret-store/broker boundary; no secret getter or preload API
was added. User-entered chat may itself contain sensitive text: the application
does not claim to detect or remove all such content.

Existing private default data directories are reused. Broader storage-permission,
symlink/ownership and backup/migration hardening remains the separately tracked
Q2 work; this increment does not certify arbitrary custom directories as private.
Database copies/backups now also contain saved chat and must be treated accordingly.

Unsent drafts remain renderer memory only. Tab/mode/collapse/settings changes and
read/reconnect retain them; project navigation retains its explicit discard guard.
Full renderer reload or application exit can lose an unsent draft. Session
storage retains only bounded non-secret receipt identities, never chat text. These
receipts support reconciliation across backend restarts in the current page
session; a fresh browser/application session is not promised to retain them.

## API and ownership

Existing authenticated `/api/agent/chat/:projectId` snapshot/run/Stop/SSE routes
retain the local Host/Origin/token boundary and exact request schemas.

- `GET /requests/:requestId`: current-epoch run envelope, no resume side effect.
- `GET /history?before=:runId`: bounded earlier page; cursor ownership is checked.
- Durable envelopes include a stable `threadId`; snapshot persistence is
  `local_database`. Missing and foreign IDs expose no foreign record.

The journal is a business-layer persistence module, independent of React,
Electron, settings and network transport. Native Electron uses the same backend;
there is no native-only conversation engine. Both gateway implementations and
their endpoint/DNS/IP pinning, streaming limits and no-fallback policy are unchanged.

## Required acceptance

1. Additive migration/reopen, immutable accepted fields, quota rollback and fault
   injection, no GET-side records, exact request replay and conflicting reuse.
2. Commit-before-provider/ack/event ordering; batching, partial flush, storage
   failure, Stop/shutdown and every late callback after SQLite closes.
3. Real child-process graceful restart and forced crash during committed live SSE
   for both protocols. Stable IDs/text/events survive; startup/read-only recovery
   performs zero credential acquisitions and zero new inference POSTs.
4. Read-only lookup after lost acknowledgement, cross-project denials and bounded
   older-page reads. Existing business rows/files remain unchanged.
5. Renderer epoch/pending races, interrupted and failed states, explicit local
   pending-release warning, inert output and retained draft/settings/dock behavior.
6. Fresh final web and development-desktop builds, followed by actual own-cloud
   browser and sandboxed Linux Electron screenshots on that exact bundle. Record
   failed attempts separately; do not represent reused old UI as a fresh build.
7. Serial aggregate verification, exact source/build/screenshot hashes and parent
   review before local commit. macOS/Windows native QA remains unverified.

## Recorded acceptance (2026-10-09)

All evidence below is synthetic, using localhost HTTP through the production
adapters. Presets remain documentation-backed, not live-provider verified.

- Full bounded suite: **898/898, 0 skipped**, 112.9 s. The only subsequent
  production change clarified two native recovery dialogs; all affected desktop
  tests then passed **64/64**, including four new disclosure regression cases.
  Independent final aggregate verification is owned by the parent before commit.
- Real process-level crash/reopen tests cover both protocols, lost acknowledgement,
  immutable context/replay, event ordering, and zero restart credential acquisition
  or inference. Runtime/journal focused tests passed **39/39**; subprocess crash
  tests **5/5**. HTTP and renderer regressions are included in the full suite.
- Fresh web build passed; development desktop rebuilt after the dialog correction.
  Desktop and web UI bytes match exactly; the desktop backend hash is unchanged
  across the copy-only rebuild. Vite's existing large-chunk warning remains.
- Own-cloud browser: **9 checked groups**, **13 screenshots**, **22 synthetic
  POSTs**. Completed CC/Responses, partial interruption, lost acknowledgement,
  older pages, inert hostile output/tool rejection, Stop/detach/project isolation,
  unsent-draft guards, dock/mode/settings retention and business-row integrity pass.
- Sandboxed Linux Electron: **7 checked groups**, **14 screenshots**, **4 synthetic
  POSTs**. Completed history survived service restart. Forced backend crashes in
  **both protocols** restored exact committed partial text, stable IDs and the next
  interrupted event; no new inference POST appeared. Normal quit during Responses
  exited zero, closed upstream, and full application relaunch retained all stored
  runs byte-for-byte. The corrected restart and crash dialogs explicitly exclude
  automatic Agent inference/resending. Final normal quit also exited zero.
- Browser and native business-record hashes remained unchanged; no model
  Authorization header was used in native acceptance and its settings secret is
  null. Agent tables are deliberately excluded from the business-record comparison.

Evidence lives in the ignored `evidence/agent-durable/` directory:
`all-tests-bounded.log`, `desktop-copy-tests.log`, `web-build-final.log`,
`desktop-build-copy-final.log`, `build-manifest.json`, browser/native `report.json`,
`source-manifest.json` and `screenshot-manifest.json`. Native read-only SQLite
snapshots and mock request/close logs establish identity/output/POST assertions;
a screenshot alone does not establish them. Native screenshots 10–14 use the final
rebuilt desktop main. Earlier native screenshots use identical final web/backend
bytes before the two dialog-copy corrections. Screenshots 08 and 14 visibly show
interruption; some history screenshots show another position in the scroll view.

Preserved failed attempts: the first aggregate run was 897/898 because one test
still expected superseded receipt wording; the assertion was corrected and the
full suite rerun green. An initial graphical launcher lacked Node on PATH; its
log is retained and the wrapper now explicitly selects the already-installed
runtime. Native bulk text/paste hit an AT-SPI technical limitation; supported Sky
key events completed the same UI interaction without changing app security.

Remaining limits: no live provider test, no macOS/Windows native verification,
no tools or project-content access, no chat deletion/export/retention UI, and no
Q2 storage-permission certification. The narrow right dock has repeated disclosure
copy; a later UI refinement should consolidate it into compact status/details while
retaining explicit outbound consent and truthful persistence/cost disclosure.

## Next boundaries

Shared non-creating project inspection and trusted scoped dispatch come next.
Both protocol tool continuations follow that boundary. Explicit run-level consent
may cover bounded ordinary read tools and model continuation; mandatory approval
for each read is not the intended UX. Changed scope/destination, local mutations
and paid generation require their respective authorization. Restart never
automatically resumes inference. None of those tool capabilities exists in this
durability-only increment.
