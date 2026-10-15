# Internal envelope processing integration

Base: `b8821e70b7eaafd84305fe6d0d4d8b40aaedf657`. This checkpoint integrates
internal processing only. It does not admit saved envelope mutations, migrate
workspace schemas, advertise capabilities, edit Inspector UI, or enable legacy
V1 automation. Candidate Node ingress modules remain standalone and are not
imported into production or browser contracts. No replacement path strips points.
Existing historical schemas, receipts, constructors and no-envelope behavior stay
valid; this is not an activated end-to-end editing feature.

## Processing and identities

- The shared graph preserves absent/null strings exactly. Non-null uses the
  existing compiler after scalar/pad/trim/fades, with explicit fltp→dblp→aeval→fltp
  fences. Its integer origin is original clip-local `n + offset`, independent of
  source slip and export trim. The historical filter source/hash proof remains
  frozen separately from the new exact current helper hash.
- Continuous snapshots and plan hashes retain absence versus null versus value.
  The non-null path evaluates existing scalar/fades × envelope per sample, not
  linearly interpolated product endpoints. Existing absent/null loop, cursor,
  seek, block and PCM allocations are unchanged.
- Full and isolated projections retain every point, including scalar candidate
  passes. Isolated rebasing changes start only; its non-null response binds the
  exact envelope digest, retaining the historic generic array prohibition.
  Full and isolated responses declare `volumeEnvelopeProcessingProfile` only
  for non-null processing. Their old algorithm/stage identifiers are unchanged.
- Render snapshots and continuous plans/snapshots use `volumeEnvelopeProfile`.
  The inferred reader adapter derives a missing profile but rejects any explicit
  unknown, undefined or inactive profile, never overwriting conflicting evidence.
  Complete original reader wrappers and generated processing wrappers containing
  any envelope field, including null, remain within 256 KiB. Absence retains old
  wrapper behavior. Existing output/response caps are not enlarged.
- Legacy20sV1 refuses any non-null field before projection, irrespective of
  mute/gain. Absent/null legacy DSP and response shapes remain unchanged.

## Actual source policy and budgets

`timeline-volume-envelope-source.ts` consumes only actual trusted parsed audio
metadata after the caller's managed ownership/hash/identity checks. Render reuses
`parseTimelineAudioPreviewProbe` on its identity-bracketed probe; analysis and
continuous already use that same restricted parser. No edit-time probe or caller
verification token is introduced. Images, unsupported stream/channel/rate
metadata, unavailable audio and out-of-source intervals fail before output.

Required verification is independent of audible voices: non-null muted, zero
scalar, cached-no-audio and all-zero curves are included. Cached-no-audio with
fades and audio-track clips reaches actual verification in the non-null branch
instead of failing solely on cached metadata. Analysis and continuous reject
actual/cached presence mismatch; render retains its existing actual-metadata
replacement behavior. This is not a claim that cached metadata proves audio.

Continuous budgets union voices with required envelope sources under existing
hash/source limits, probes all required sources before any block output, and
keeps twelve cursors, sixty-frame blocks and the unchanged 96 MiB admission.
Initially inaudible sources get two hashes bracketing the probe, then reuse that
session proof only while exact pathname/dev/ino/size/mtime/ctime fences hold.
Audible legacy sources retain their existing first-decode hash bracket. Analysis
retains streaming, segment, two-pass work/byte and total source caps. Render
retains its existing preparation budgets. No full-clip buffers or global cap
increases were added. Bounded 16-point expression/evaluation cost is not a new
empirical process-memory or runtime qualification.

## Verification and retained limitation

Pinned executable:
`/workspace/scratch/6877817dff0d/toolchains/node24.21/node-v24.21.0-linux-x64/bin/node`
(`v24.21.0`). Source and executable SHA-256 values are recorded in
`evidence/volume-envelope-processing-source-hashes.json`.

- New pure/mock processing, analysis and continuous tests, historical source
  proofs, candidate tests, legacy contracts and mocked business services ran in
  one combined invocation: **231/232 passed**. The remaining existing browser
  client cancellation test uses a 10 ms deadline and expected a GET to have
  started; concurrent load timed out first (`gets=0`, expected 1). Its test and
  callback implementation are unchanged from the base. No timeout was widened.
- One authorized isolated diagnostic of that exact test passed 1/1. This does
  not erase the combined failure or establish a passing combined suite. No
  further retry or broad rerun was made to obtain green output.
- After the final cached-source correction, targeted analysis/continuous tests
  passed 29/29; independent review reran the relevant subset 9/9. Earlier final
  independent processing/legacy review passed 55/55 and found no remaining
  blockers after profile and complete-wrapper corrections.
- Strict narrow TypeScript 6.0.3 no-emit check passed for changed typed consumers
  and imports. The existing copied-source actual compiler negative/recovery test
  passed. Existing installed compiler/declarations were copied locally for that
  test; no dependency installation or package modification occurred.

No media process ran for this integration. A separate single installed-compiler
qualification on the unchanged compiler ran once with FFmpeg 7.1.5: 96,000 stereo
frames each for absent/null/automated; absent/null were byte-identical and the
16-point fade-overlap result matched the float-baseline × pure evaluator exactly.
Its retained report SHA-256 is
`34028bb01b5ff3d3374557444c94d8b573860e13aafd986f17a6400a76b168b1`.
That isolates compiler/parser/fence behavior, not this integrated consumer graph.

Still required before feature activation: exact short integrated render/continuous/
full/isolated PCM and segmentation/seek equivalence, resource qualification,
complete durable/workspace admission and history/replay/replacement proofs,
then separately bounded drafts/capability/UI. No GUI, CLI transport, long media
acceptance, installation, build, public push or Mac operation occurred here.
