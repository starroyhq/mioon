# Clip volume envelope: isolated pure design phase

Base: accepted `ad72c8f4be6abb5f351c05ebf3fc5ea089dd57cd`.
This phase is not a delivered editing or audio feature. The new standalone MJS
module has no package export and no production imports. No schema, services,
workspace marker, UI, role behavior or DSP implementation changes in this phase.
Ordinary40/restored41 are provisional future reservations only.

## Fixed choices and algebra

`volumeEnvelope` is absent, explicit null, or `{profileId, points}`. The fixed
provisional profile is `mioon-clip-linear-attenuation-v1`; each of 1–16 points is
`{frame, multiplier}`. Frame is an integer in [0, durationFrames], duration is
1–18000 frames, and multiplier is finite 0–1. Times are unique and increasing.
Invalid input is rejected, not sorted, clamped, normalized or silently reduced.
Negative zero is rejected because JSON would not preserve its signed identity.
The pure validator accepts ordinary data records, not a generic adversarial
object-execution boundary: surrounding transport/intent guards remain required.

Hold the nearest point outside the defined anchors. Interpolate at integer local
sample positions, exactly 1600 samples/frame. Actual membership is [0, duration
samples), while the separate limit evaluator accepts the closed right endpoint.
Absent and null have unity multiplier within that interval, but retain different
stored field shapes. Evaluation captures a detached copy, so later draft edits
cannot alter an already-created evaluator. Arithmetic is IEEE-754: exact sample
positions and anchors do not promise bit-identical results after algebraic
repartitioning. Representative single-split equivalence is tested to a declared 1e-14 absolute
tolerance; this is not a proven error bound for arbitrary repeated split histories.

Existing scalar gain remains 0–2; fades and this multiplier are at most one.
Combined clip gain therefore remains at most two. This is not a limiter, clipping
prevention, AAC safety or loudness guarantee. Simultaneous linear fade and
linear automation produce a quadratic product; their combined endpoints must
not be interpolated as one linear ramp.

The edit helper returns only the envelope field for a caller-owned clip merge.
Move and source slip preserve local point times; expansion holds the final value.
Shrink rejects any point after the new end unless the same patch explicitly
replaces or clears the envelope. It never infers crop/stretch from generic
start/source/duration edits. Split partitions/rebases points and adds the cut's
interpolated value only where needed. Held regions avoid redundant boundary
points, preserving the 16-point cap. Existing fade split restrictions are outside
this helper and remain mandatory. Source replacement preserves automation and
must pass future source eligibility checks. Existing history must restore exact
absent/null/value shape; no new Undo mechanism is proposed.

## Serialized-size proof and limits

No global cap changes are proposed. The deterministic test computes a conservative
bound using 32 ASCII characters for a finite binary64 JSON number (a deliberately
loose bound above shortest-round-trip decimal output):

- Point: at most 61 bytes, including a five-digit frame and object keys.
- Full 16-point numeric envelope: at most 1051 bytes.
- Added clip field, including comma and key: at most 1069 bytes.
- 100 clips: at most 106900 added bytes.
- Per-edit conservative reservation: two maximally escaped 200-code-unit strings
  (2400 bytes), complete colour declaration allowance (2048), remaining identifiers,
  numeric values and structure (1024), plus envelope field (1069) = 6541 bytes,
  below the existing durable input 8192-byte cap. Independent decomposition:
  maximal JPEG colour has 27 keys (each <=16 ASCII characters), 17 ASCII
  strings (each <=64), six numbers (<=32), one boolean and four objects.
  Reserving key punctuation/commas gives 27×20 + 17×66 + 6×32 + 5 + 8 = 1867
  bytes, below 2048. Remaining complete update structure has at most 21 keys,
  three UUID values, audioRole, eleven numbers and three objects; its <=903-byte
  allowance fits 1024. Envelope-key double-counting is conservative. The natural
  node count is 20 base + 28 colour + 51 envelope = 99, below 128; admitting
  arrays still requires a separate narrowly reviewed parser change.
  This is a size proof, not proof
  that today's strict operation or durable intent schema accepts the field.

The existing timeline/history/ACK cap is 256 KiB. No positive point cap can promise
that every already-near-cap record accepts extra data. Future mutation admission
must serialize the complete candidate, reject excess atomically with an exact
request-bound definite rejection, and leave prior state/receipt/history intact.
The existing image aggregate-budget guard is the architectural precedent; do not
turn an unsupported new field or oversized candidate into generic corruption.
Retain 16 as a per-clip cap, not an unconditional aggregate capacity promise.

Other hard integration gates:

- Draft rows are 8192 bytes, HTTP envelope 12 KiB, complete disk envelope 2 MiB.
  The existing rawNumber permits 48 arbitrary valid-Unicode characters. Reusing
  it for both fields of 16 points permits 32 × 48 × 6 = 9216 bytes of escaped
  control characters alone, before keys or other draft data. The test constructs
  this counterexample. A future UI needs a bounded lexical raw representation
  plus whole-row admission, or explicit retained-in-memory/not-persisted error
  handling. Never truncate the raw draft or raise caps silently.
- Durable edit task `plain()` currently rejects every array, even though its
  byte/node limits could fit this numeric envelope. Future point-array admission
  must be narrow and retain getters/proxy/depth/node/byte guards. Existing global
  128-node cap must be checked against a maximal complete edit, not enlarged.
- Isolated-clip response `isTimelineClipLoudnessResponse` also rejects arrays.
  Its 8192-byte/256-node/depth limits need a new response shape or envelope digest
  binding, not an accidental relaxation of historic responses.
- Frozen legacy 20-second V1 audition stays unchanged and must explicitly reject
  any non-null automation. Null/absent retain old processing semantics. This phase
  adds no such service guard yet, because no production mutation admits the field.
- Continuous plans, analysis projections, render snapshots and drafts each need
  their complete serialized admission checked. The envelope's own bound does not
  substitute for these aggregate checks.

## Source eligibility: evidence and decided integration boundary

Mutation `timeline-recovery.mjs` uses the bounded owned graph reader, and
`timeline-inputs.mjs` validates source category, source duration and cached fade
eligibility. It does not hash/probe media during an edit. `fileInfo()` in
`media.mjs` obtains source hash and probe information at import/generation paths
(`services.mjs`, `jobs.mjs`). A saved `hasAudio` flag is therefore useful metadata,
not fresh proof that the current managed bytes contain a supported audio stream.

The actual render/preflight `prepareTimelineInputs()` path in
`timeline-sources.mjs` checks ownership, managed identity, frozen hash, bounded
hashing and source identity around a trusted probe, then validates the resulting
actual stream metadata. Continuous and analysis preparation have their own
verified-source/actual-decoder paths. These are the right places to enforce
non-null automation's actual audio requirement before output, not mutation-time
media probing or a caller-submitted `hasAudio: true`.

Decision for later integration: use conservative existing cached metadata only as
an edit eligibility hint, explicitly not fresh verification. No mutation-time
probe, invented inspection token or metadata persistence is added. Still images
are ineligible. Neither the pure module nor editorial audioRole establishes audio
evidence. Source replacement preserves automation; incompatible replacements
reject rather than strip it. Trusted processing preparation must reject actual
incompatible/no-audio bytes before output.

Activation is atomic at the feature level: do not enable mutation/capability or
advance the workspace schema until render, continuous, both analysis paths and
legacy audition rejection are coherent. Dormant typed-contract/admission helpers
may land first; a live writable field that any old DSP silently ignores may not.

## Concrete later integration sequence

1. Complete independent review of this pure slice and retain the source-admission
   decision above.
   Add strict operation/record/draft fields, bounded array admission, aggregate
   failure proof, snapshot profile and opt-in capability. Gate compatible ordinary
   and restored profiles; scan all historical/durable evidence before migration.
   Keep historical constructors and receipts unchanged. No new Agent authority.
2. Shared renderer helper: preserve resample/channel conversion → scalar gain →
   pad/trim → clip-local fades. Add the envelope as its own sample-aware stage
   after fades and before mix. Do not change source decoding or move old gain/fade
   operations. Automation must use original clip-local samples across segment
   boundaries. Do not assume frame-evaluated FFmpeg volume is sample-accurate.
3. Continuous: include field in frozen projection/hash and validate eligibility.
   Replace combined-endpoint ramp logic only in the new envelope path with actual
   per-sample products, retaining the absent/null legacy path. Preserve seek,
   cancellation, byte/work budgets, source cursors and stale-revision fences.
4. Full-mix and isolated analysis: include envelope in signal identity, projection
   and processing profile; shared renderer graph evaluates it. Isolated start
   rebasing must leave local anchors unchanged. Zero automation yields honest
   silence/no-valid-loudness, not a source-only measurement. Scalar loudness
   candidates/apply preserve all points and measure actual changed output.
5. Legacy V1 audition rejects non-null automation explicitly, with no broadened
   voice schema. Raw source decoding and source cache profile need no change when
   the decoded bytes remain dry. Processed plan/report/snapshot semantics do need
   an explicit version or envelope-profile discriminator. Measurement algorithm
   and codec identifiers need not change merely because input processing changes.
6. Only after all processing paths are coherent: bounded saved Inspector editor,
   persistent raw-draft behavior, CAS/replay/Undo/unknown recovery and supported
   capability presentation. No UI path may silently strip an unsupported envelope.

Later numeric/media gates: absent/null equivalence, all-zero and constant curves,
ramps overlapping fades, source slip, all split positions, seeks inside ramps,
unrelated clip edges, block boundaries, replacement, shrink rejection/atomic
replacement, replays after Undo and complete analysis/render equivalence. Define
PCM tolerances and failure classifications before execution. No old readiness,
CLI-timing or 600-second acceptance loop is reopened by this plan.

## Dormant contract/admission foundation: partial candidate slice

The standalone candidate subset is now implemented and described in
[VOLUME-ENVELOPE-CANDIDATE-ADMISSION.md](VOLUME-ENVELOPE-CANDIDATE-ADMISSION.md).
It adds no production imports, operation exposure, workspace activation or
durable writer. The broader integration items below remain future gates;
standalone snapshot/receipt evidence is not a live render/continuous contract.

Keep editing disabled and do not bump workspace markers yet. Implement and test
candidate-specific schemas/validators behind an unadvertised capability first:

- `contracts/index.mjs`: candidate clip add/update field, only when the eventual
  compatible admission gate is active; do not broaden old frozen schemas.
- `contracts/timeline-replacement.mjs` (`isTimelineRecord`) and
  `timeline-acknowledgement.mjs`: complete field presence, request-bound add/update,
  split semantics, replacement preservation and historical render snapshot checks.
- `business/timeline-inputs.mjs`, `timeline-recovery.mjs`: typed shape validation,
  complete-candidate 256-KiB admission, precise atomic rejection proof and source
  eligibility policy. The new field remains unreachable in live mutations until
  the processing rollout is complete.
- `business/edit-tasks.mjs`: admit a point array only at the intentional typed
  clip-input envelope path, through a dedicated validator; retain generic array
  rejection everywhere else, with existing 128-node/8-depth/8192-byte limits.
  `contracts/edit-tasks.mjs` complete-task validation must agree. Do not enable a
  generic arrays option on the existing plain-data walker.
- New snapshot envelope-profile guard, called from the current frozen snapshot
  validators, with exact presence/profile consistency. Extend candidate-only
  `continuousAudioSnapshotSchema` in `contracts/timeline-audio-continuous.ts`;
  retain legacy20s schemas unchanged and plan its non-null rejection before any
  projection. Candidate schema acceptance alone must not activate live playback.
- Plan the new isolated processing response in `timeline-clip-loudness.ts` with
  either a typed envelope identity or exact digest binding; preserve the old
  generic array prohibition. Audit the already-array-aware full-mix response
  guard separately rather than copying a relaxation across all response types.
- Add a new envelope evidence scanner beside
  `business/workspace-audio-role-validation.ts`, then later wire exact-profile
  dispatch/restoration and opt-in capability in `workspace-schema-dispatch.ts`
  and `contracts/workspace-restore.mjs`. Do not alter roles or reuse their profile
  as evidence of audio-envelope support. 40/41 remain reserved, not installed.

Acceptance for that dormant foundation: maximal complete-edit bytes/nodes/depth;
reject arrays at every unrelated path, sparse/proxy/getter/extra-property arrays;
absent/null preservation; exact ACK after Undo/replay and mismatched request
rejection; all split derived shapes; over-cap atomic no-write rejection;
old-schema intent refusal before durable writes; missing/unknown/extra snapshot
profiles; null-compatible legacy and non-null V1 audition refusal; serialization
of 100 envelope clips near both sides of the unchanged cap. Draft persistence
remains a later gate, not a reason to widen rawNumber or global row limits.

Only after this dormant slice passes independent review should workspace writes,
continuous/render/analysis consumers and finally UI be integrated as the explicit
processing sequence above. This proposal does not authorize any such work.
