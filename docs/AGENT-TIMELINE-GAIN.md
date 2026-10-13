# Reviewed Agent selected-clip gain

Date: 2026-10-13 UTC. Implementation baseline:
`c3a0a57da7b54f62a999fe006dbc47d46d6c83c0`.
Status: implementation, focused checks, strict typecheck, fresh production builds,
packaged Linux native flow and real decoded-media checks passed. The independent
parent gate also passed on the frozen source: strict typecheck exit 0, then
5,729 total / 5,727 passed / 0 failed / 2 explicit skips in 1,057,619.29961 ms
(full-suite exit 0). Synthetic model requests use local fixtures;
no real model/provider verification is claimed.

## One saved clip, one gain value

In Editing, select a saved audio clip or a saved video clip whose owned asset
metadata has `hasAudio:true`, then choose the separate selected-clip volume
proposal mode in the shared Agent dock. For example, “Lower this music clip to
40%” can produce an immutable `1 → 0.4` gain review. The proposal changes nothing
until the user separately approves it.

Gain is a linear amplitude multiplier in the inclusive range 0–2. It is not a
loudness measurement. Zero silences this clip without muting its track. A muted
track remains eligible, with a visible warning that the stored gain stays
inaudible until the user separately unmutes the track. Hidden video with known
embedded audio is eligible; hiding video does not mute its audio. Images,
silent video and unknown audio metadata are ineligible. Admission does not run
a probe, waveform job or render to make an asset eligible.

Only the selected clip's `gain` changes. Timing, source/version provenance,
source in-point, duration, rectangle, fades, tracks, other clips, subtitles and
timeline duration remain unchanged. Original media and existing frozen
preview/export snapshots are untouched. This mode does not normalize, measure
loudness, duck other clips, change fades or unmute a track. Gain above 1 can
increase clipping risk; there is no automatic limiter or safe-loudness promise.

Mixed timeline audio, rendered previews and new exports use the approved gain.
Original-source preview remains unchanged. Proposal and approval do not
automatically render or play media; use the ordinary explicit rendered-preview
or export controls to check the result.

## Exact consent and outbound data

The independent mode is `selected_timeline_clip_gain`, with provenance
`project_selected_timeline_audio_gain`. Its `timelineGainEdit` capability is:

`{available,schemaVersion:1,catalogHash,maxModelRequests:2,maxToolCalls:1,maxResultBytes:8192,minGain:0,maxGain:2}`.

The existing strict run envelope is unchanged. Consent binds destination,
protocol, model, context, project ID, capability schema/catalog/limits, timeline
ID, clip ID, expected timeline revision and the exact displayed `reviewTarget`.
That review target contains project/timeline/clip/track IDs, saved names, track
kind/mute, `hasAudio:true`, fps, width, height, expected revision and saved gain.
The backend resolves the same owned saved target and compares this disclosure
before accepting the run. Selection, disclosure and opening the panel alone
send nothing to a model.

The backend separately freezes the full validated saved clip, selected track,
timeline format/duration/revision and source identity. The source projection is
exactly `{id,sha256,mimeType,hasAudio:true}`; generated-source ownership and
version/job/shot relationships remain checked by the existing owned-media graph.
The target is read without creating a missing timeline and is bounded to 16 KiB.
This private target is not the model payload.

The complete project-data projection sent to the model is exactly:

`{clip:{name,gain},track:{name,kind,muted},hasAudio:true,minGain:0,maxGain:2}`.

It accompanies the user's request and eligible bounded completed typed-only
conversation. Project/clip/track/source IDs, source hashes, source metadata beyond
known audio presence, timing/geometry, paths, URLs, media bytes, other clip text,
waveforms, transcripts and loudness measurements are not added as project
context. Local identity details in the review UI are not sent to the model.
Names, user text, history and tool results remain untrusted data. The model has
not listened to or measured this source.

The continuation also includes the bounded tool result: proposal kind,
operation, `status:'pending_review'`, `applied:false`, proposal ID and proposal
digest. Those proposal audit values grant no authority and do not disclose the
private source fingerprint.

## Tool, request bounds and send fence

The sole tool is `mioon_propose_timeline_clip_gain`, with exactly `{gain:number}`.
It rejects non-finite values, values outside 0–2, negative zero, strings, null,
duplicate keys including escaped spellings, and extra fields. Direct contract
validation also rejects accessors, hidden/symbol properties and non-JSON data.
An unchanged value cannot create a proposal. This no-op rejection belongs to
the new Agent mode; the existing manual/shared gain update semantics are
unchanged. Valid finite values are preserved exactly, without rounding to the
UI percentage.

The model cannot supply a target, operation, revision, request key or approval.
Bounds are one proposal-tool call, two model requests, 1 KiB arguments and
8 KiB tool results. The complete serialized first model request, including
protocol/tool overhead, is capped at 30 KiB; the complete serialized answer
continuation is capped at 64 KiB. Existing chat/output/event/storage bounds also
apply. Request counts are resource limits, not a monetary cap.
The accepted bounded model run may incur model charges; edit approval grants
no generation or other spending authority.

Both Chat Completions and Responses require complete valid single-call output,
exact call linkage and a successful completed proposal-bearing run before
approval. The answer continuation has tools disabled. Responses is stateless
with `store:false`; no previous-response continuation or protocol fallback is
introduced. Fragments, malformed or incomplete output, foreign tools and extra
calls do not grant approval authority. Model requests are not automatically
retried.

A synchronous gain-target fence checks live/Stop state and the complete pinned
saved target before credential acquisition, after acquisition, before each
model dispatch, before/after DNS, and on the verified connected socket
immediately before `request.end(body)`. Async fence results fail closed. A
changed target or Stop blocks a later POST, including the answer continuation;
it cannot retract a request already sent or guarantee remote billing stopped.
Ordinary context staleness is reported as a context change, not journal damage.

Gain-derived turns never become typed-only history or project context for
inspection, shot edits or clip moves. Gain mode itself uses eligible typed-only
history, not previous gain-derived project text. The original shot and move
catalogs and accepted policy bytes remain independent and unchanged.

## Immutable review and shared mutation

The dock shows saved clip/track, base revision, exact before/after multipliers
and friendly percentages, with muted-track and clipping-risk warnings. The exact
multiplier remains visible even when a percentage is rounded. Authoritative
proposal state is separate from model prose.

Fresh approval requires the matching selected target and gain mode. Dirty
property/source-range/subtitle/format state, recovered clip drafts and pending
or uncertain timeline work block new review/application until resolved. A
selection, project, settings, mode, saved gain/mute or revision change does not
retarget or rebase an old proposal. UI guards supplement backend authorization.
Explicit recovery of an already approved unknown outcome retains its original
target rather than using a new selection.

The same authenticated list/detail/approve/reject/recover routes in
[AGENT-EDITS.md](AGENT-EDITS.md#http-surface) are used, including exact action
bodies `{instanceId,digest}`. No new API route, public RPC operation, MCP/CLI
approval tool or generic model executor is added. Existing external clients
retain their separately authorized `timeline.clip.update` gain contract.

New stored definitions use version 3. The public proposal has
`operation:'timeline.clip.update'`, exact `patch:{gain}` and
`diff:{before:{gain},after:{gain}}`, plus its strict gain target and provenance.
Move and gain proposals share an operation name; the validated gain shape and
tool provenance distinguish them publicly, and the definition version does so
privately. An operation name alone is not a discriminator.

Approval persists the immutable digest and exact backend-generated input/key
before dispatch:

`{projectId,clipId,expectedRevision,patch:{gain},requestId}`.

A fixed backend-only entry invokes the existing `timeline.clip.update` service.
Inside that shared transaction, a fresh mutation rereads ownership, full saved
target and audio eligibility. Same-revision target/source changes fail closed;
newer revisions use the existing CAS rejection. No automatic merge, rebase or
new key is allowed. The existing timeline receipt namespace and normal undo/redo
history are reused. A successful new edit clears a redo branch under the
ordinary history rules; a rejected edit or historical acknowledgement does not
create another gain edit.

## Historical acknowledgement and recovery

An applied outcome is exactly
`{status:'applied',timelineId,clipId,revision}`, at base revision plus one.
`{status:'not_applied',code}` requires the existing shared transaction's
request-bound rollback proof. A generic error, lost response or absent receipt
after an interrupted dispatch is not proof that nothing happened.

Historical replay validates the original request hash, shared receipt response
and frozen selected-target projection with only the approved gain changed.
Current project/timeline and historical source ownership, source hash and MIME
must remain safe. An established acknowledgement may survive Undo, later gain
or mute changes, clip removal, and later same-source audio/duration metadata
discovery. This does not authorize a fresh edit against an ineligible or stale
target. Changed source identity or unsafe ownership fails closed. The UI rereads
the current timeline instead of replacing it with the historical response.

Restart only discovers/reconciles local records and receipts. It does not run a
model, approve, dispatch or retry an edit. Explicit Recover reuses the exact
approved input and key. Duplicate approval, two-window races, lost
acknowledgements and reordered responses cannot silently replace that identity.
Stop invalidates unapproved proposals; failed/stopped/interrupted runs cannot
be freshly approved.

## Storage, restore and older-version limits

There is no DDL or schema-marker change. Definition v3 reuses schema24's existing
`targetKind:'timeline_clip'`, null shot ID and timeline/clip XOR. It does not
change v1 shot or v2 move definitions, their catalog bytes, raw JSON, approvals,
receipts or sequence identities. Capability `schemaVersion:1` is separate from
the stored proposal definition version.

The shared proposal quota remains 2,048 retained rows and 64 MiB of logical
payload reservation, not a whole SQLite/WAL disk-size guarantee. Gain public
proposals and private targets are separately bounded to 16 KiB. Capacity failure
does not evict uncertain replay identities. Saved chat and proposal text remains
ordinary local SQLite data, not secret-vault encryption.

Existing restored schema25 behavior is unchanged: captured Agent records are
retained, but the Agent service and route family remain unavailable. Captured
unexecuted request keys are held under their original operation/input identity;
they cannot be reused for a fresh write or another operation. An already applied
captured timeline receipt may still support exact historical replay under the
existing restore rules. Ordinary current-origin manual gain editing remains a
separate shared-service capability; retained Agent records do not grant it
automatic execution authority.

The preservation gate probes frozen baseline validators against v3 records.
They reject the unknown mode/version without interpreting gain as a move or
dispatching it. Old reconciliation can conservatively change an unrecognized
approved/dispatching row to `unknown` and update `updatedAt`; it preserves the
definition, approval, outcome and immutable fields. This is not a run of an old
packaged binary, a blanket every-column-unchanged claim, or downgrade support.

## Acceptance checkpoint

Final parent aggregate: `node scripts/tooling.mjs test --suite=full --concurrency=1`,
5,729 total / 5,727 passed / 0 failed / 2 skipped, exit 0. The same run
was preceded by successful strict typecheck. Evidence logs are
`evidence/agent-gain/parent-full-final.tap` and `parent-typecheck-final.log`.
After that gate, only this external document received the final facts; product,
test, embedded resources and packaged artifacts remained frozen.

Focused sets overlap and must not be added together:

- Contracts: 10 passed. UI/renderer: 331 passed.
- Final gain/domain/preservation/protocol/wire and existing Agent regression set:
  214 passed. This includes complete serialized request limits, real HTTP/SSE,
  shared CLI/MCP, and SIGKILL/recreation at five durable approval boundaries for
  each protocol. These are service/process tests, not native GUI crash tests.
- Core compatibility: 189 passed. Corrected catalog/UTF-8 inventory and actual
  compiler fixture set: 12 passed. The initial stale test inventories and one
  new invalid platform fixture failure are retained in evidence, not counted as
  final passes. Business assertions and deadlines were not relaxed.
- Preservation: 6 passed, including raw v1/v2 rows, catalogs, receipts, sequence
  and SQL structure, frozen old validators, backup/create/verify/restore and held
  captured v3 keys. The old-validator gate is not an old packaged-binary test.
- Real media: 1 matrix test passed, with 11 actual queued worker exports covering
  stereo, resampled mono and embedded video audio, 0.4/zero/1.5 gain and Undo.
  Each file decoded to 90 H264 frames at 30 fps, 720×1280 and stereo 48 kHz AAC.
  The 0.4 plateau RMS ratios were approximately 0.398–0.400. Undo restored
  byte-identical decoded PCM; original media and decoded video frames remained
  unchanged. Silent/muted sources remained absent. Low-level boost is not a
  clipping-prevention promise. Two new media-fixture mistakes are retained with
  their corrected full matrix result.
- Final strict typecheck, production Web/Desktop build and Linux unpacked
  package completed successfully. No production/test edits followed those builds.

The final unmodified packaged Linux backend was exercised through supported
native UI controls in a synthetic isolated workspace. Chat Completions proposed
`1 → 0.4`; the timeline stayed at revision 2 until explicit approval produced
revision 3. An explicit real export then produced 60 frames, 1280×720, 30 fps,
stereo 48 kHz AAC. Four decoded RMS windows including fade regions measured
0.397707–0.401923 versus the gain-1 baseline; video pixels and source hash stayed
unchanged. Responses next proposed `0.4 → 0.7`; explicit approval produced
revision 4, and ordinary timeline Undo restored 0.4 at revision 5.

The same package then reopened with both immutable original approval receipts,
unchanged history/source and the single existing export. Each approved model
run used two loopback POSTs; the final reopened instance sent zero model
requests. Three exits were normal, with code 0 and no signal. Native review
used the default-width shared dock, ordinary scrolling and timeline collapse;
these results do not claim a new exhaustive minimum-width accessibility audit.
The native exits are not forced-exit evidence. There was no subjective listening,
macOS/Windows validation or real-provider/model verification.

Reproducible checked-in tests include
[protocol/wire](../tests/agent-timeline-gain-wire.test.mjs),
[preservation](../tests/agent-timeline-gain-preservation.test.mjs),
[rendered media](../tests/agent-timeline-gain-media.test.mjs) and
[renderer boundaries](../tests/agent-timeline-gain-renderer.test.mjs).
Local evidence paths are `evidence/agent-gain/affected/`, `media/`,
`native-summary.json`, `native-review.md`, `screenshots/`, build logs and the
exact source/artifact manifest. Private runtime settings, connection material
and working databases are excluded from the portable evidence archive.
