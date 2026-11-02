# Reviewed Agent timeline moves

Date: 2026-10-12 UTC. Baseline: `9d75f5e68c510eb6cd67116e3431728402f7908f`.
Status: implemented with focused checks and packaged Linux synthetic business-flow
acceptance, including a final copy-corrected package smoke. Final independent full
gate passed4437/4439,0 failures,2 skips after two legacy migration fixture
assertions were corrected. No live model verification.

## One useful edit, with an explicit target

In Editing, select a saved timeline clip and open the shared right-hand Agent
page. The separate **selected clip move** mode can propose one new start frame.
It is a same-track, non-ripple move. Source/version provenance, source in-point,
duration, name, rectangle, gain, mute and fades remain unchanged. Other clips and
subtitle cues do not move. The original media and older export snapshots are
untouched. Timeline total duration may change because it is derived from clips.

The fixed editing timebase remains 30 fps, with integer start frames and an
exclusive end no later than frame 18,000. The shared timeline validator rejects
same-track overlap, invalid source/bounds and a shortened timeline that would
leave an existing subtitle out of bounds. A no-op proposal is rejected. There
is no silent ripple, clamping, trimming or automatic subtitle adjustment.

Dirty properties, source-range or subtitle drafts block new review/approval
until explicitly saved or discarded. The current saved project, timeline,
clip, revision and timing disclosure must still match for fresh approval.
Changing selection or project never redirects an existing proposal to another
clip. This additional UI guard does not replace backend authorization.

## Exact outbound consent and protocol boundary

The send mode is `selected_timeline_clip_move`, with provenance
`project_selected_timeline_timing`. The existing strict run envelope is retained.
Consent contains the normal destination/protocol/model fields plus project,
timeline ID, clip ID, expected timeline revision and the current `timelineEdit`
capability fields: schema/catalog, at most two model requests, one tool call,
8 KiB result, maximum start frame and 99 other same-track occupied intervals.

Before acquiring credentials or starting a model POST, the backend resolves
the owned saved timeline and freezes the complete private target. The model
receives only the selected clip name/start/end/duration, track name/kind, fps,
numeric intervals of other clips on that track, the bounded typed conversation
and the user request. It does not receive project/clip/source IDs, media hashes,
paths, URLs, bytes, other clip text, secrets or arbitrary project data. Names and
tool results are untrusted data. Viewing a clip or opening the panel sends nothing.

The independent tool is `mioon_propose_timeline_clip_move`, with exactly
`{startFrame}`. Arguments are capped at 1 KiB, selected context at 30 KiB and
continuation at 64 KiB. The model cannot supply an operation, request key,
revision, project or target. Both Chat Completions and Responses require a
complete valid single tool call, exact call linkage and a successful terminal
proposal-bearing run. Responses is stateless with `store:false`. The second
answer request has tools disabled. Fragments, duplicate keys, foreign tools,
incomplete output and additional calls never apply edits.

This is a new independent policy/catalog. The original selected-shot policy,
catalog hash and accepted execution records are not rewritten. Timeline-derived
answers never enter subsequent typed-only, inspection or shot-edit context as
if they contained only user-typed text. Stop prevents future rounds and
invalidates unapproved proposals. An already accepted bounded model run may
finish while the panel is hidden; its displayed consent explains this. Model
requests may cost money; an edit approval grants no generation/spending authority.

## Durable review and shared mutation

The right dock shows immutable before/after start/end frames and seconds,
unchanged clip duration, derived total duration, human-readable target/track and
base revision. Audit identifiers remain available in details. The authoritative
proposal status is separate from model prose.

The same authenticated application routes of the reviewed-edit increment
provide list/detail and explicit approve/reject/recover. No new public RPC, MCP
or CLI approval operation exists. The public proposal union adds
`operation:'timeline.clip.update'`, an exact `{startFrame}` patch, discriminated
timeline target and timing diff. A successful outcome is
`{status:'applied',timelineId,clipId,revision}`. A proven fresh rolled-back
rejection may be `{status:'not_applied',code}`; generic errors are not proof.

Approval persists the exact operation/input/request key and immutable digest
before dispatch. The backend-only fixed entry delegates to the same
`timeline.clip.update` implementation used by UI, HTTP, CLI and MCP. Project,
clip and complete frozen timing/format identity are checked inside that shared
transaction. CAS, exact historical replay and normal undo/redo history are
unchanged. A stale proposal never refreshes its base or silently reapproves.
As with a manual timeline edit, a newly applied edit discards an existing redo
branch through the existing history rules.

Timeline proposal receipts use the existing timeline request namespace, not the
six-operation mutation journal or a new generic executor. Exact receipt recovery
checks the approved input hash and frozen response projection. An established
historical applied acknowledgement can remain valid after the clip has moved,
been undone or removed; current project/timeline and historical source ownership
must remain safe. The UI rereads the current timeline rather than overwriting it
with that historical response.

Restart discovers pending or uncertain proposals and reconciles local receipts
only. It does not run inference, approve or dispatch. Explicit Recover uses the
original approved input/key. No receipt after an interrupted dispatch means
unknown, not confirmed failure. Duplicate approvals, reordered responses and
two-window approval/rejection cannot create a second differently keyed move.

## Schema24 and compatibility

The sole migration rebuilds `agent_edit_proposals` to add a real discriminator:
legacy `targetKind:'shot'` retains its shot ID, while `timeline_clip` has a null
shot ID and separate timeline/clip IDs. It never invents a shot ID for a clip.
Version1 definitions remain byte-identical; new move definitions use version2.

Within one startup transaction, all legacy columns/positions/raw definition,
approval and outcome strings, row sequence positions/high-water/absence,
indexes, triggers and foreign keys are preserved. The new target columns and
XOR constraint plus immutable-target trigger are additive. The marker is written
last; injected interruption rolls everything back. Legacy nonstandard JSON
whitespace/key order is retained on recovery rather than reserialized.

The shared retained-proposal limit remains 2,048 rows and 64 MiB logical payload
reservation, not a whole SQLite/WAL disk-size guarantee. Definitions, rows and
approval/outcome payloads retain bounded limits. Capacity exhaustion does not
evict uncertain identities. Chat/proposal text is local plain SQLite data,
not encrypted by the secret vault. Existing POSIX privacy and Windows readiness
gates are unchanged. Native macOS/Windows and real providers are unverified here.

## Acceptance record

Release requires both real synthetic HTTP/SSE protocol flows; migration byte
preservation; no preapproval business writes; approval/rejection and Stop races;
stale targets; loss/crash/restart reconciliation; historical receipt replay;
bounded disclosure and typed-context exclusion; actual CLI/MCP shared-service
parity; right-dock draft/selection/pagination guards; fresh build and Linux
packaged approval/undo/recreation; and a decoded real FFmpeg export with unchanged
source hashes.

Focused terminal results (overlapping, not additive): backend/migration62/62;
protocol/runtime97/97; renderer143/143; actual HTTP/CLI/MCP/crash31/31; legacy
migration/process120/120; broad compatibility224/224. The wrong provenance
acceptance found in the initial protocol test was fixed before persistence; the
first raw log was overwritten and only its original tool assertion survives.

The actual packaged Linux flow used a synthetic loopback model: CC proposal,
separate approval, undo and redo; Responses proposal, normal original-process
exit/recreation, original pending review and explicit approval. Four model POSTs
occurred before restart, zero after restart/approval. Every audited table hash
was unchanged across the pending restart. The single-clip fixture preserves
all other clip fields and tracks; multi-clip constraints are tested separately.

Actual output is720×1280/30fps,120frames/4seconds,H264/AAC48kHz stereo, full
decode exit0. At1second the sampled frame is black and audio0.5–1.5seconds is silent;
at3seconds green source and
approximately880Hz audio appear. Output45534bytes SHA256
`fde4da336e31032846ea0cc47d4c0645317416746e54c28c31541b850242d0b0`.
Original source SHA256
`826e778a227d79bf9ad440505545b36c59b8c87e6685dcb026dbb7626e96e8ef`
remains unchanged. This verifies decoded media, not audible playback quality.

The first native launch showed rendering corruption; a normal exit/reopen
restored the display. Root cause is unresolved, and no GPU or security options
were changed. The full business flow precedes a final generic settings-sentence
correction. The corrected final package reopened the same data, showed the
updated header and applied history, made0 model POSTs and exited normally.
Every table was unchanged at reopen; explicit dock collapse later changed only
workspace_preferences, with all business rows/source/export bytes preserved.
The main/backend bundles are byte-identical across both packages. Final app.asar
SHA256 `c50efd10c1d417365de80904b4dded4c3ab889cd8da4228e0062f473af47278b`.
Final aggregate counts below are from the independent terminal run.

The first independent full gate exited1:4439 total,4435 passed,2 failed,2 skipped
(1021135.05134ms). Both failures were old Comfy/custom-Images startup fixtures
expecting pre-schema24 proposal table SQL. The test-only correction pins the
exact new columns/CHECK/trigger while retaining every old SQL, raw row, sequence
and receipt comparison. Focused corrections15/15 and complete migration/storage/
UTF-8 inventory164/164 passed. Production sources and all six final build/package
hashes are unchanged; existing native evidence is reused, not newly rerun. The
first failure log remains preserved. The final independent full gate exited0:
4439 total,4437 passed,0 failed,2 skipped (1008326.521857ms), parent session50282.
The two skipped cases retain their existing platform prerequisites. Final log
SHA256 `2ab5f401f297292c60456568ec012eca574e85fa2064488565b60101f87df2ce`.
