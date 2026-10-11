# Timeline output formats

Date: 2026-10-11. Implementation baseline: `eac925c9698d78f43eda2617af6505fe16ea1dc3`.
Status: implementation, focused checks, fresh builds, Linux native acceptance and the independent parent aggregate passed. Final commit is pending; Mac/Windows remain unverified.

## First slice

The right Properties workspace offers three closed timeline-output presets:

| presetId | Shape | Output | Editing clock |
| --- | --- | --- | --- |
| `portrait_720` | 9:16 | 720×1280 | 30 fps |
| `landscape_720` | 16:9 | 1280×720 | 30 fps |
| `square_720` | 1:1 | 720×720 | 30 fps |

These are dimension pairs, not independent width/height menus. Arbitrary resolutions and other frame rates are not implemented. New/default projects retain portrait compatibility. Source ranges, extracted-frame timepoints, audio fades and waveforms keep the existing 30-fps editing clock; they are not reinterpreted as native/VFR frame indexes.

The setting applies to the project's **timeline preview and timeline export**. Shot-generation aspect ratios, imported/original pixels and Images model options remain separate. Legacy **storyboard export stays 720×1280 / 30 fps / 9:16**. The interface labels that distinction; do not call this a global format switch for every project output.

Per-export [delivery scaling and quality](EXPORT-SETTINGS.md) are separate from these editing presets. A delivery-size choice does not change timeline geometry or the 30fps clock; 1080 short-edge output upscales the existing composition.


## Shared service contract

`timeline.format.get({projectId})` is a bounded, genuinely noncreating metadata read. It returns:

- `projectId`, `projectRevision`
- `timelineId` (null when absent), `timelineRevision` (0 when absent)
- `presetId`, `fps`, `width`, `height`
- `eligible`, `blockedReasons`

Absence means the effective compatible portrait default, not a newly persisted timeline. Strict closed DTO validation rejects mismatched project IDs, unsupported dimension pairs, contradictory eligibility and extra fields. Reading does not create an edit intent, execute a tool, render or probe media. Each metadata section is bounded to 4,096 rows and 16MiB of materialized text; receipt-owner enumeration is index-backed and capped at 4,096 distinct owners. Exceeding these inspection budgets fails closed, without deleting retained keys.

`timeline.format.set({projectId, expectedProjectRevision, expectedRevision, requestId, presetId})` changes the timeline aggregate. `expectedRevision:0` explicitly requires no timeline; success creates revision 1. An existing timeline requires its exact positive revision and increments it once. The project revision is an additional admission fence; the project row itself is not rewritten. The request key is required and belongs to the existing timeline replay namespace.

Exact historical replay is resolved before fresh revision/eligibility checks, while current ownership and immutable-response integrity remain mandatory. Changed reuse conflicts. Every new operation runs in the existing synchronous immediate transaction and commits mutation, original response and format provenance together. Existing same-preset requests with a fresh key are rejected as `TIMELINE_FORMAT_UNCHANGED`; they do not consume a successful timeline receipt. Exact successful retry still returns its original response.

## Pristine-only safety rule

Only an eligible, never-edited empty timeline can change formats. The server blocks:

- Current clips or nonzero duration (`CLIPS_PRESENT`)
- Any undo/redo history or history-cursor row, even an empty view at cursor zero (`HISTORY_PRESENT`)
- A non-format timeline request receipt (`REQUEST_HISTORY`)
- Any retained timeline export, including failed or queued records (`EXPORT_HISTORY`)
- Another unacknowledged timeline-mutation task (`PENDING_EDIT`)

Corrupt or inconsistent rows fail closed rather than being converted to a convenient eligibility result. A currently dispatching format task is exempt only through backend-created exact identity/input/digest evidence. No RPC field can request an exemption.

The right dock also blocks known current-session unresolved timeline/render intents. A server cannot observe an undispatched request sitting only in another browser's session; if it later arrives, the old revision fences prevent applying it to the new dimensions. No claim of cross-browser access to unsent drafts is made.

This first slice does not migrate nonempty geometry, delete history, resize old clips or clear recovery records. Emptying a previously edited timeline is insufficient. Create a separate project for another output format. Format selection itself sits outside clip undo/redo; before editing begins, select another preset and explicitly save again.

## Persistence and recovery

Existing timeline `fps`, `width` and `height` fields remain the only saved format authority. No preset field is inserted into old projects, timelines, frozen snapshots or receipts. New clip/seed rectangles derive from their own timeline; strict aggregate validation uses that timeline's pair. Frozen previews, preflight reports and exports render and display their own snapshot dimensions, not current mutable settings.

Schema 21 adds immutable format-request provenance alongside the existing timeline receipt and extends the explicit durable UI operation list with `timeline.format.set`. The `edit_tasks` rebuild copies raw columns; input byte strings, positions, claims, outcomes, sequence identity and existing protection semantics must be verified unchanged. It does not expand built-in Agent tools or create a generic execution endpoint.

The UI prepares one exact request in the existing plaintext local SQLite task ledger before dispatch. Its 4,096-identity/64-MiB logical reservation limits still apply; this is not a disk/WAL size guarantee. Failed/lost acknowledgements retain that identity. Listing or restarting never executes it; explicit reconciliation/recovery uses the saved input, not a newly edited draft. The other eight local-edit families and timeline rendering retain their existing session-recovery limits.

## Right-workspace behavior

A project-menu entry opens an extracted Properties subpage, with a return control. No new modal or canvas/timeline remount is required. The saved summary and editable preset draft are separate. Dock changes, collapse, mode changes and selection preserve the draft. Project leaving, new-project creation and browser navigation guard unsaved scope. Polling or late acknowledgements cannot erase newer drafts or update another project's page. A scope/revision conflict requires explicit review; it is not silently refreshed and resubmitted.

## Acceptance gates

- Strict contracts, explicit effects and unchanged built-in Agent catalog
- Actual HTTP, CLI and official MCP discovery/write/replay/conflict/lost-ACK/restart
- Read-only zero-write proof, both CAS fences, missing/foreign/corrupt rows, private own-task exemption
- Independent schema20→21 row/input/sequence/schema preservation and rollback fixture
- All three real output dimensions at 30 fps, exact frame count/duration and AAC/48-kHz/stereo; full decode, sampled pixels and tone/silence checks
- Old sources, existing output files and original receipts retain their bytes; preview/preflight labels remain snapshot-bound
- Final fresh Web/desktop builds and actual Linux right-dock selection→timeline→export→restart evidence
- Mac/Windows and live provider verification remain separately unverified and are not prerequisites for this cloud slice

## Candidate verification, 2026-10-11

Final serial affected groups passed 96/96 (historical replay and submitted-rectangle compatibility), 180/180 (shared transports, UI and real media), and 214/214 (remaining migration/contracts/UI), all with zero skips. These groups overlap and are not a new aggregate pass count. The earlier failed compatibility runs remain in the evidence: old exact-operation/schema harness assumptions were updated, and one real legacy submitted-rectangle error-code regression was corrected while persisted-corruption rejection remained strict.

A fresh development Web/desktop build used the unchanged lockfile and unmodified production backend. Actual Linux Electron UI acceptance saved landscape output in the right dock, retained its draft across an Agent tab switch, imported a synthetic 640×360/24-fps clip, added a 60-frame timeline clip with 1280×720 geometry, and demonstrated that undoing to an empty view still blocks format changes because history/receipts remain. Redo restored the clip. The native preflight displayed 1280×720 / 30 fps / 60 frames; actual export and rendered preview both completed.

Both resulting MP4 files are 371,208 bytes with SHA-256 `8a3e815ad7e3cdd20fb569657c45bf7df6dd5c8d2fd46ae4268c736b864d3b64`: 1280×720, 30 fps, exactly 60 decoded frames, 2 seconds, AAC/48-kHz/stereo, full decode exit 0 and nonzero decoded audio RMS. This checks decoded sound data, not a listening test. All three presets and the unchanged portrait storyboard path are covered by separate real-media tests.

Normal exit and complete new-process restart (PID 2252 → 2489) preserved the audited rows in 12 domain/recovery tables and all three managed media hashes exactly. Both app processes exited with code 0. The reopened UI retained the saved landscape dimensions, timeline and rendered preview; original imported bytes stayed unchanged. No Mac/Windows native result or paid/provider call is implied. No persistent drawing defect appeared during this bounded flow; transient capture/animation states are not evidence of fixing previously reported graphics behavior.

The synthetic evidence, source/build manifests, failure logs, native screenshots and restart/hash checks are prepared for a durable delivery archive. That archive excludes the runtime workspace database, connection/token/settings files and browser state. The parent aggregate gate is recorded below after its actual terminal result.

The first parent aggregate completed with 3,655 total / 3,652 passed / 1 failed / 2 skipped in 732.726 seconds. Its sole failure was the strict test-stream inventory: the new CLI helper already enabled continuous UTF-8 before both listeners, but its two text consumers were not registered and did not use the inventory's audited inline registration form. Both registrations now use the existing `setEncoding('utf8').on(...)` form and are explicitly counted as two text sites. HTTP bodies still concatenate binary chunks before one decode; official MCP stdout remains SDK-owned. Limits, deadlines and business assertions are unchanged. The seven focused inventory/real-transport tests passed, including deterministic split-Chinese/emoji coverage. This test-only correction leaves production and built assets unchanged; the original failed log is retained. The final aggregate result is recorded below.

Final independent parent gate: session 38383 exited 0 with **3,655 total / 3,653 passed / 0 failed / 2 skipped**, duration 742,622.320176 ms. The final log is retained alongside the first failed aggregate and the focused inventory correction. No production or build change occurred after native acceptance; only the two test registration/inventory updates and factual documentation changed. This completes the cloud verification gate for this bounded slice, without extending its platform or provider claims.
