# Saved asset source ranges

Updated: 2026-10-10 UTC. Baseline: `7e04ecd`.
Status: implemented and locally verified; independent final aggregate and
release review are separate gates.

## Implemented boundary

One saved video/audio range per owned asset, scoped to its project. In Editing,
select a library source, seek the existing main player, enter or mark integer
in/out points in the right Properties panel, explicitly save, then explicitly
add the saved range to a compatible timeline track. The original whole-source
library Add and drag/drop paths retain their existing behavior.

Saving marks changes only local range metadata. It does not trim or replace the
managed original, reupload it, change a version, or modify an existing clip.
Favorites/rejects/tags, multiple ranges, native-timebase/VFR frame-accurate
selection, proxies, and model access to marks remain separate work.

## Timebase and API

The shared contracts helper converts finite positive media duration to complete
30-fps editing frames: `floor(duration * 30 + 1e-6)`, rejecting a result outside
the positive safe-integer range. The epsilon handles binary representation near
an exact frame boundary. It is not a source-native frame-rate or VFR guarantee.
The in point is inclusive and out point exclusive: `0 <= in < out <= count`.
One complete frame is the minimum. Images and unknown/invalid duration reject.

- `asset.range.get({projectId, assetId})` is noncreating. An unset asset returns
  `{id:assetId, assetId, projectId, revision:0, range:null,
  sourceFrameCount, fps:30}`. A displayed default full source is not a saved mark.
- `asset.range.set({projectId, assetId, expectedRevision, requestId,
  inFrame, outFrame})` requires a stable 8–200-character request ID and exact
  integer revision. Success returns the same envelope with revision incremented
  once and `range:{inFrame,outFrame}`. There is no clear/delete operation in this
  increment. Range revision is independent of project, asset, and timeline CAS.
- Missing and foreign project/asset ownership use the same `NOT_FOUND` response
  without foreign payloads. Corrupt owned identity/range data fails closed.
  Project and asset JSON are each bounded to 16 KiB before materialization.
- A range may exceed the timeline's 18000-frame duration cap. Adding is disabled
  when the selected length plus append position exceeds that cap, when the
  compatible track is absent, or when the existing 100-clip cap is reached.

HTTP RPC, CLI and official MCP expose the same validated business operations.
The get effect is read-only/noncreating; set is a local database mutation with
required-key exact replay, no network, generation, or media write. Built-in
Agent inspection DTOs and tool/proposal catalogs intentionally omit these marks.

## Persistence, replay and ownership

SQLite schema v11 adds `asset_ranges` and the single-purpose immutable
`asset_range_requests` journal in a startup transaction. Existing six-operation
`mutation_requests` rows and triggers are retained without rewriting receipts.
Fresh and upgraded databases receive the same constraints.

All seven supported local mutation writers check both journals under the same
`BEGIN IMMEDIATE` transaction. A reused key with changed operation, project or
exact canonical input conflicts. Duplicate cross-table presence or an operation
in the wrong table fails closed. Insert triggers also reject cross-table key
collisions. Mutation and original response are committed atomically; exact replay
precedes revision checks and returns the original response after later saves or
restart. Current ownership is still verified before exposing it. Saving performs
a final ownership/state verification in the same transaction before commit.

This key space covers only these seven local operations. Existing timeline,
reference, generation and export journals keep their prior independent scopes.
The original six optional-key schemas, response envelopes, keyless behavior and
error semantics are unchanged. New range ownership failures do not release a
client's pending receipt as a proven non-application.

## Renderer and clip snapshot semantics

The modular controller binds reads, saves, positions and callbacks to project,
asset and selection epochs. Older reads/acknowledgements cannot lower confirmed
revision or erase a newer draft. A conflict retains user input and requires an
explicit discard/reload decision. Properties/Agent tab changes and dock collapse
retain the draft; hidden controls cannot admit edits. Source replacement,
project navigation and mode changes use the existing unsaved-change guard.

Adding captures the displayed confirmed asset ID, revision, in and out at click
admission, then calls the existing `timeline.clip.add` with explicit immutable
`sourceInFrame` and `durationFrames`, its own stable request key and timeline CAS.
Later mark saves cannot change that pending input or the resulting clip. Existing
timeline history/undo/redo and replay behavior apply. Source playback uses the
existing media element and a source clock independent of the timeline playhead;
stale/hidden media callbacks do not update the current selection.
An explicit integer seek retains its intent through the browser's adjacent
microsecond timestamp representations. Once playback or native scrubbing moves
away, ordinary position flooring resumes. This does not add an accumulating
epsilon to source bounds or promise native-source frame accuracy.

Range and timeline requests are never automatically retried. A dropped or
malformed acknowledgement retains the exact pending request for the existing
explicit task-panel recovery. Successful range replay triggers a scoped read;
`project.get` alone does not contain range data. These first-party pending
receipts remain session-scoped. Reload can rediscover session storage, but native
window/application recreation can lose a pending UI request identity. Saved
marks and server receipts are durable; this increment does not promise durable
native pending-intent discovery. Inspect saved state before starting a new intent
after losing that receipt. Future Agent range writes would require their own
backend-persisted intent/approval boundary; none is exposed here.

## Verification record

- Backend/contracts focused checks: 20/20 passed, including populated-v10
  migration parity, unchanged legacy receipt bytes, noncreating reads, finite
  frame boundaries, fresh/stale CAS, corruption/foreign identity denial,
  rollback/restart, and two real processes racing the companion and legacy
  journals in both directions.
- Actual authenticated HTTP, CLI child and official MCP SDK transport checks:
  **8/8 passed**, including loss after commit, a later save, backend restart and
  original-response replay. A test-only transport guard rejects outbound work.
- Broad affected checks before the final native precision fix: **282/282
  passed**, including real FFmpeg render regressions. The initial **281/282**
  run exposed an outdated test-only read-only discovery list; its failed log
  remains retained. A separate storage test expectation now recognizes v11.
- Native QA reproduced a browser microsecond-roundtrip bug missed by the first
  component harness. The failing quantized-time test and superseded native
  screenshot are retained. After the narrowly scoped fix, final delta checks
  were **86/86 passed**, covering both step directions, event ordering,
  pause/EOF/source replacement, visibility, request recovery and storage.
  The earlier 282-case result is not presented as a final-source aggregate.
- Fresh final web and desktop builds passed serially. Web build: **8.03 s**;
  the existing large-chunk warning remains. All **49** staged artifact hashes
  were unchanged through final native acceptance.
- Ordinary sandboxed Linux Electron: **9 acceptance groups**, **17 final-build
  screenshots**, plus 3 explicitly superseded screenshots. Native controls
  selected `[60,120)`, saved revision1, added one fixed 60-frame clip, and
  performed one undo/redo. Agent/Properties switching, collapse and cancelled
  project navigation retained the draft. Later saving `[0,30)` revision2 left
  the original clip unchanged. A new native process recovered the range,
  clip and completed export without another mutation or export. Both final
  native process exits were code 0.
- The native-triggered real export is H.264/AAC, **720×1280, 30 fps, 60 frames,
  2.000 s**. All 60 decoded center samples are green (the chosen 2–4 s source
  segment); decoded audio RMS is 0.08785. Managed original bytes still match
  their import hash. Native recreation retained exactly 2 range receipts and 4
  timeline receipts (Add, Undo, Redo, Render), one export, zero generation jobs
  and zero Agent runs. Screenshots supplement these database/media assertions.
- Native keyboard automation reported an unavailable AT-SPI provider; the
  final workflow used supported mouse/seek/mark controls. No native keyboard
  success or audible playback claim is made; audio was verified from exported
  PCM. No new browser automation run or native macOS/Windows QA is claimed.
- The first parent aggregate finished **1608 total: 1605 passed, 1 failed,
  2 skipped**. Its extracted Agent project-navigation test environment omitted
  the new `setSourceDirty` dependency; production App declares it normally.
  The test fixture now supplies it and explicitly checks Cancel/Confirm dirty
  cleanup. The resulting Agent/source/visibility group passed **105/105**.
  This correction changes tests only; the verified build/runtime stays intact.
  The failed aggregate log is retained and is not described as a full pass.
- Parent independent final aggregate/release review remains a separate gate.

All runtime fixtures are synthetic local media. No live provider validation is
implied. Evidence and final hashes are retained under `evidence/source-ranges/`.
Linux verification does not certify native macOS or Windows; the Windows ACL
readiness gate remains unchanged.
