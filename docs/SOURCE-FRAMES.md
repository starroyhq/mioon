# Local source-frame extraction

2026-10-11. Implemented in `work/source-frame-extraction` on `8db96b528fafca98875124335b20679981b13d42`; final parent aggregate and release commit are pending. Focused shared-service/HTTP/CLI/MCP, migration, real FFmpeg and Linux native checks below have completed. This does not establish Mac/Windows native or live-provider verification.

## User scope

Pause an explicitly selected source video in Editing, then choose “提取此帧”. The request pins the project, managed source asset/hash and the acknowledged current 30fps editing mark. A proposed seek that has not reached the media element is not a capture fact. This is not native-frame/VFR-frame accuracy or a promise of identical browser pixels: the decoder selects the first presentation timestamp at or after that editing timepoint.

The result is one separately managed PNG, longest edge1024 without upscaling. It appears in the asset library; existing explicit canvas/timeline/first-frame/subject actions may consume it. No original asset, existing clip, version or export changes. No model, provider, network or automatic reference binding participates. Blender is not required.

A compact extracted Properties section shows current/recovered task states. It is not a modal or a new workspace tab. Dirty source-range/clip drafts remain intact when merely locating a completed PNG in the library. Hidden panels stop read subscriptions/polling; accepted local work may finish. Project changes fence old callbacks.

## Exact contract

Six strict shared operations, also discoverable through existing CLI/MCP:

- `frame.extract`: projectId, sourceAssetId, sourceHash, sourceFrame, requestId.
- `frame.request.get`: projectId, requestId. Reads the immutable original acknowledgement.
- `frame.task.get`: projectId, taskId. Reads current task status.
- `frame.task.list`: projectId, optional limit/cursor.
- `frame.task.cancelQueued`: projectId, taskId, expectedRevision, requestId.
- `frame.task.recoverResult`: same control fields.

Project/asset/task IDs are UUIDs. sourceHash is lowercase SHA-256. requestId is8–200 characters; it identifies the exact operation/input. The three frame mutations share their own workspace-wide namespace, separate from image/timeline/reference/local-mutation journals. Cross-operation or cross-project changed reuse conflicts without exposing a foreign receipt. Replay returns the original acknowledgement, including its historical queued state, before fresh revision checks; it never queues another extraction. Query task.get for current state.

No client path, output name/path, decoder command, timestamp policy, profile, provider or generic service operation is accepted. Built-in Agent read/edit tool allowlists are unchanged.

## Local profile and limits

Profile `local-png-1024-v1`, selection rule `first-pts-at-or-after-v1`:

- Managed MP4/WebM, one unambiguous non-cover video stream; initial H.264/VP8/VP9 8-bit yuv420p progressive profile.
- Known zero source start, square pixels, no rotation/display transform. Unsupported or uncertain timing/orientation remains an extraction error and does not disable ordinary editing/export.
- Source at most512MiB/600seconds, maximum edge4096 and8Mi pixels. Source metadata must be finite; marks use30fps with an exclusive source end.
- Exact integer PTS threshold uses the inspected `1/D` timebase, bounded denominator1e9; no cumulative seek epsilon or rounded decimal selection.
- Output at most4MiB,1024×1024 bounding box; strict PNG decoding validation and source hash/stat checks before/after decoding.
- Decoder child120s; decoder attempt180s plus bounded child cleanup. Initial acceptance hashing and later publication are outside that attempt timer. These are event-loop/OS best-effort limits, not hard real-time guarantees.
- One active task per exclusive workspace owner, queued2/project and8/workspace. Asynchronous source-hash/PNG preparation is separately capped at2/project and8/workspace; an identical in-flight key shares preparation, and a committed replay is returned before admission limits. Retain256tasks/project and2048/workspace; at most16 immutable request acknowledgements per task (initial acceptance plus15 controls).
- Input/snapshot/receipt/response4KiB each; task16KiB and request12KiB accounting bounds. They are logical record limits, not a bound on total SQLite/WAL/media disk usage.
- List pages default20/max50, bounded cursors768bytes. The renderer replaces20-row pages and provides latest/newer/older navigation through all256 retained project tasks. At most50 cards are shown at once, with a project-bound revision cache capped at256; paging does not discard an uncertain request or downgrade a newer task state. No silent eviction of unresolved identities or old replay receipts.

## Persistence and recovery

Additive schema20 introduces only `frame_tasks`, `frame_requests` and their indices/triggers. It preserves existing table definitions, rows/rowids, exact inputs, receipts and history. Tests compare fresh/upgraded frame schema invariants, preserve old records/rowids/receipt bytes and verify transactional migration rollback. They do not claim every historical global schema object is byte-identical to fresh bootstrap.

Acceptance and the immutable original acknowledgement commit atomically before decoder admission. A start fence precedes the first owned media child. Exact source/project/lock ownership is rechecked at every spawn and publication; mixed legacy/image/frame owners are rejected regardless of the asset's provenance label. Shared graph budgets cover indirect ancestry.

PNG bytes never enter SQLite. A private task-bound staging PNG and immutable complete manifest form the local recovery checkpoint; mere presence of a partial file is insufficient. Publication uses a new managed asset with `extracted-frame` provenance. A subject version freezes typed frameSource provenance, without inventing video-job/shot/version lineage.

Restart only classifies unfinished tasks as interrupted. Listing/opening does not decode. Only an explicit new extraction may decode; only explicit recoverResult may verify and publish the same already-staged bytes. Missing/corrupt checkpoints cannot trigger a fresh decode. Queued or interrupted provably unstarted tasks may be cancelled; running work is not falsely labelled cancelled. An unconfirmed owned child retains its resource slot until its exact handle closes; no numeric-PID fallback is used.

Renderer transport uncertainty retains the exact original input/key. A bounded authoritative `frameOutcome: not_accepted` proof may clear only a fresh confirmed refusal; status text or error code alone cannot. Restart discovery is backend-durable for accepted tasks; an unaccepted lost request whose key existed only in a destroyed window is not falsely described as durably prepared.

Chat/settings/secrets are unrelated. Task metadata is stored in the existing local plaintext SQLite workspace; PNGs and staging manifests are ordinary managed local files, not vault-encrypted. Existing private-storage policy applies.

## Required acceptance before release

1. Strict schemas/discovery/effects and unchanged built-in Agent allowlists; old startup/migration fixtures updated only for additive schema20.
2. Same-key lost ACK, changed reuse, two windows/processes, foreign/reassigned source, capacity failures before acceptance, no reads creating rows or starting children.
3. Crash before/after ACK, start fence, PNG/manifest publication, DB receipt and final asset commit; restart no spawn, exact local recovery, original ACK never rewritten.
4. Real CFR24/30, fractional/B-frame/VFR, source boundaries, unsupported offset/rotation/SAR/interlace, cancellation/late close and malformed/bomb PNG limits.
5. HTTP, actual CLI and official MCP parity with managed synthetic media.
6. Native actual seek→PNG→restart rediscovery→explicit reference/subject/timeline reuse and real still-image video export; sources/old exports hash-identical.
7. Fresh builds, frozen source/evidence hashes, parent independent aggregate. Persist an allowlisted evidence archive in Library, excluding tokens/settings/runtime databases. No live provider or Mac/Windows claim from Linux checks.

## Verification checkpoint (2026-10-11)

Focused suites completed serially: contracts14/14; business/recovery42/42; decoder/ownership87/87; renderer/source/import164/164; consumption4/4; compatibility250/250; desktop startup affected173/173; client119/119; actual HTTP/CLI/official MCP7/7; real fresh/upgraded migration10/10. All listed final runs have zero skips/failures. Suites overlap; these numbers are not an aggregate of unique tests. Final parent independent full gate: **3514 total /3512 passed /0 failed /2 skipped**,579494.847073ms,exit0. Parent confirmed the actual process exit; this is the release aggregate, not a sum of focused runs.

Fresh development Web and desktop builds completed. Final Web bundle is `index-BoeJ5tWC.js`; desktop main/backend and staged Web artifact hashes are recorded in the evidence manifest. Production source remained unchanged through final native acceptance; only test fixtures and documentation changed after those builds. Linux uses the already installed official Electron44.7.0 binary. No packaging/native-platform readiness is inferred.

Actual native acceptance used a private synthetic red/green/blue3-second30fps video and the unmodified final backend. A prior isolated service fixture deliberately stopped after the complete staging manifest to seed one recoverable local result; that fault hook was not part of the native launcher or renderer.

- Seek to editing mark30, preserve a dirty source-range draft, explicitly extract one180×320 green PNG; locating it in the library retained that draft/source. Normal quit presented the existing unsaved-draft guard.
- Destroy and recreate the full application process: original accepted acknowledgements, pending local-result task, original source and managed media hashes were unchanged. No new extraction request was created by startup or discovery.
- Explicitly recover the staged mark75 blue PNG. Add it once to the timeline, connect it as the shot's first-frame reference and create one local subject V1. No generation job or video version was created.
- Saved timeline revision2 exported90frames at720×1280/30fps. Actual FFmpeg full decode exited0; decoded pixel was RGB[1,0,255]. Output9,491bytes, SHA-256 `8e267c0ebea07800e0be3ca8315bb9cd6c5ef050f5ba0c7a6d71cc7cca7235ed`.
- A further complete application recreation retained all audited table hashes and managed bytes, including the successful PNGs, reference, subject version, clip and export. Four native processes exited normally with code0. Transport/worker fault tests separately prove recovery does not decode again; native row/hash checks alone are not OS process tracing.

Preserved unsuccessful checks: the first decoder run24/26 exposed VFR/rotation fixture assumptions; corrected fixtures establish actual timestamps/transform first. The compatibility run245/250 included new empty tables in an old-schema comparison; it now separately proves those tables empty and old rows unchanged. First transport run5/7 exposed split UTF-8 decoding in the test collector; continuous decoding retains strict discovery equality and deadlines. Migration run9/10 lacked the pre-existing quota singleton in its schema-only fixture; the fixture now seeds it before preservation capture. None of these corrections weakens production validation.

One real native observation remains unresolved: the second process developed white/blue rendering corruption after a maximize/scroll sequence. Normal exit and unchanged-bundle relaunch restored normal rendering; the later complete flow and fourth process were successful. Cause was not established, and this is not reported as a repaired defect. Original screenshots07/08 preserve that failure rather than serving as successful task-state evidence. No GPU/security flags were changed.

## Narrow desktop/client followups included

The already-reviewed Mac followup patch contributes four files: desktop startup cancellation fencing and its deterministic regression; client error-code/property-key secret redaction and actual CLI/MCP transport regression. The client merge preserves all frame routes and the earlier `8db96b5` behavior. Synthetic startup cancellation markers cannot suppress genuine cleanup or replacement errors. These changes are verified in the serial desktop/client suites above and the final Linux native bundle, not newly tested on Mac.

The separately observed pre-existing activate-during-backend-restart window-ownership gap is outside this cancellation patch and remains a follow-on. Mac packaging license-file omissions also remain a separate next slice. Neither is claimed repaired here. Mac sessions are idle at the user's request.

## Evidence retention

Ignored local logs are supporting workspace copies, not durable delivery by themselves. The release evidence archive will include allowlisted red/green logs, original screenshots, source/artifact hash manifests and the synthetic MP4. Runtime databases, connection tokens, settings files, user-data directories and raw fixture configuration are excluded. Parent Library receipt and final aggregate result must be recorded at release. Previous milestone pass counts are historical evidence, not reruns in this slice.

### Parent aggregate discovery-harness correction

The first parent full gate completed with **3509 total /3493 passed /14 failed /2 skipped**,589661.891808ms,exit1. The failures include parent-suite propagation. The concrete leaf diffs all show the full CLI catalog's Chinese description damaged at a pipe-chunk boundary (`不可变` became `不���变`), while MCP/shared schemas remained correct. Eight older test collectors coerced each Buffer chunk to text independently. Each now sets stdout/stderr UTF-8 decoding before its existing listener; strict schema comparisons, output limits, deadlines and all business assertions are unchanged. Production code did not change.

Three deterministic stream tests prove the old collector corrupts every forced interior split of Chinese/emoji and the real catalog's failing description, while continuous decoding preserves exact bytes and parsed schema. They passed3/3. All nine real transport suites (the eight affected suites plus frame transport) then passed74/74,zero skips/failures,in127137.984991ms. The first full failure and focused correction logs are preserved. At that checkpoint a final parent aggregate was still required; those focused checks were not a replacement full pass. The subsequent aggregate is recorded below. Native/build evidence is reused with exact unchanged production/artifact hashes, not described as newly rerun native acceptance.


### Second aggregate and complete collector correction

The second parent gate also failed: **3506 total /3503 passed /1 failed /2 skipped**,595950.120218ms,exit1. Its sole failure was the still-unfixed `cli-v4` full-catalog text collector. The smaller count is fully reconciled:3509+3 new deterministic tests−6 CLI nested tests not registered after the early assertion=3506. All original top-level outcomes and the same two explicit skips remain. `count-audit.md` preserves exact names and discovery inventories; those six cases were not considered passed in the failed run.

The follow-on data-flow inventory covers all27 CLI spawn helpers, SDK's separately exposed stderr, and the associated backend/crash/readiness text collectors.49 test/QA files now configure continuous UTF-8 directly at110 actual listener-registration sites. A per-site regression checks exact helper-instance counts and exercises each registration with byte-wise Chinese/emoji input. This is coverage of the enumerated direct stdout/stderr and `stream` aliases, not a general JavaScript AST detector. SDK protocol stdout, media bytes, raw log writers, historical fixtures and product readers are unchanged. HTTP-fixture text consumers found separately are documented outside this subprocess-only correction.

The48-file affected run completed **464 total /463 passed /1 failed /0 skipped**,390027.208553ms. Every catalog/transport case, including all six previously unreached CLI workflow cases, passed. Its sole remaining failure was an existing synthetic shutdown test assuming its nested hard-stop timer must run before the absolute30ms deadline. With a late graceful callback, that deadline correctly cancels the nested timer, leaving zero hard-stop calls and an explicitly unconfirmed owned child.

The test now drives timely phases causally at10/20/30ms while retaining the original owner, media, no-retry and restart-refusal assertions. A companion delayed-grace test proves absolute-deadline-first completion cancels the hard timer and even queued late callbacks cannot signal or restart. The production supervisor and its budgets are unchanged. The complete shutdown suite, including its real child/process tests, plus the UTF-8 configuration suite then passed **32/32**,zero failures/skips,in1069.213072ms. All original failed logs are retained; the failed48-file run is not relabelled green.

Final source freeze contains95 files.23 product source hashes and all four native-tested build artifacts remain identical to the50-file native checkpoint. Build/native evidence is reused on that explicit proof; neither is falsely described as rerun for these test-only corrections. Final parent independent full gate: **3514 total /3512 passed /0 failed /2 skipped**,579494.847073ms,exit0. Parent confirmed the actual process exit; this is the release aggregate, not a sum of focused runs.


## Final independent release gate

Final parent independent full gate: **3514 total /3512 passed /0 failed /2 skipped**,579494.847073ms,exit0. Parent confirmed the actual process exit; this is the release aggregate, not a sum of focused runs.

`parent-full-third.tap` SHA-256 `35317544533874a431b43500efb0ef4a6e477fcab0928bc52074cfea1cfa2ef6` preserves the complete final log. The two skips retain their existing platform/capability reasons: POSIX foreign-owner mutation capability and actual native Windows credential behavior. They are not passing native Windows evidence. All six CLI nested workflow cases absent after the second-run early failure now ran successfully. Total3514 is consistent with first3509 plus the original3 deterministic regressions, one complete collector-configuration case and one delayed-grace causal regression.

Final95-file classification:23 product sources,6 documentation/Skill files,66 tests/QA. The original native50-file checkpoint contained the same23 product sources and6 documents/Skill plus21 tests. The45 additional files are44 existing test/QA collector files and one new UTF-8 regression file; the shutdown causal correction is inside one of those44. This is not95 product files. All production and native artifact hashes still match the actual successful native run. The two failed parent aggregates, failed464-test affected run and unresolved native rendering anomaly remain recorded above, without relabelling them green.
