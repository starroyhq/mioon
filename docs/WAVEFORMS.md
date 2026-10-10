# Local source waveforms

Updated: 2026-10-10 UTC. Baseline: `2a764f9`.
Status: implemented; affected tests, fresh builds and local browser/native runtime
verification passed. Independent parent aggregate/release review is pending. This
document records only this bounded increment.

## Scope and meaning

An explicit, session-only timeline toggle requests waveforms for visible clips
whose managed sources have confirmed audio. It starts off, including after app
recreation, project changes and a mode change that remounts the timeline. Audio assets and a video's first audio stream
are eligible. The overlay is the **raw source envelope**, before clip gain,
fade-in/out, track mute, mixing or rendering. It does not measure the audible
mix, loudness, true inter-sample peaks or source-native/VFR frame positions.

Source files, asset/version records, saved ranges/dispositions, clips, timeline
revisions/history and immutable export/request receipts remain unchanged.
Waveforms are derived, removable and rebuildable. This increment does not add a
proxy engine, waveform editing, beat detection or any built-in Agent tool/context.

## Fixed algorithm and resource limits

`peak-u16-48k-100hz-v1` selects the first audio stream, preserves its one or two
channels, decodes little-endian float32 at 48 kHz, and takes the largest absolute
sample across both channels in each 480-sample-frame (10 ms) bin. Opposite-phase
stereo therefore cannot cancel into false silence. Bins use fixed full scale,
quantized to unsigned 16-bit; samples above full scale set a clipping indication.
NaN/infinite samples and incomplete sample frames fail instead of becoming a
valid waveform. Chunk boundaries retain only the unfinished sample frame. Ready metadata also
reports the actual decoded sample-frame count. Display bins wholly beyond that
coverage are `null` and remain blank, rather than becoming invented silence.
Material first-audio relative start offsets are unsupported (only one 48 kHz
sample of rounding is tolerated). Negative or unknown origins are unsupported;
untimed WAV is explicitly interpreted at sample zero. Audio/container duration differences over 100 ms are unsupported;
small codec-padding tails are never stretched to fill the source.

Initial limits are explicit waveform capability limits, not import/edit/export
bans:

- Entire managed source at most 600 seconds and 512 MiB; longer sources show
  “超过10分钟暂不支持波形”, without a misleading partial waveform.
- Mono or stereo first audio stream only; other channel layouts are unsupported.
- At most 60,000 stored bins; at most 230,400,000 cumulative decoded PCM bytes
  for stereo, half for mono. PCM is consumed incrementally, never fully buffered.
- Decoder deadline 120 seconds, with the existing owned-child TERM/KILL/reap
  policy. The whole attempt, including probing and source hashes, is capped at
  180 seconds. Event-loop timers are not a hard real-time scheduling guarantee.
- One active decode and four queued requests per exclusive workspace owner; 64 cache entries and
  16 MiB reserved cache payload budget, including admitted unfinished entries.
- At most 2,048 returned display points per explicit source-frame window; the
  renderer also limits retained entries and visible scheduling. The 16 MiB limit
  accounts for serialized cache payloads/reservations, not total SQLite file/WAL
  size or total process RSS.

The source-frame window uses the existing 30 fps timeline clock, inclusive start
and exclusive end. Source in/out and visible zoom/scroll windows select that
source interval; the full-source waveform is never stretched to fit a trim.
10 ms bins and further display reduction are approximate visual timing, not
sample-exact editing or a source-frame-accuracy claim.

## Shared service and ownership

`asset.waveform.get` reads only an already-owned asset and existing cache state.
It never creates a row/timeline, changes access timestamps, probes files,
decodes media, repairs corruption or evicts entries. Missing, queued, running,
ready, interrupted, error and unsupported remain distinguishable.

`asset.waveform.request` explicitly admits local cache work. Inputs identify only
project and asset plus an explicit retry choice; callers cannot supply a path,
source hash, algorithm, executable, filter or authority. HTTP, CLI and official
MCP use these same business services and explicit operation-effect descriptors.
No provider submission, upload or paid generation is involved.

Cache identity includes project scope, the managed source's stored SHA-256 and
algorithm version. Relational and JSON ownership are validated before lookup,
request and publication. Identical bytes in a foreign project reveal neither
its cache status nor errors. GET deliberately does not rehash media bytes; it
reads the derivation for the immutable managed-source record. External edits to
managed files are outside that immutability assumption and are detected during
a rebuild, rather than certified afresh by every cache read. File regularity, link/permission/ancestor policy,
size and actual streamed hash are checked; source identity/hash and project
binding are rechecked before publishing a completed result. Hash/FFmpeg work
runs outside short synchronous SQLite transactions.

The existing private workspace policy remains in force. FFmpeg is a local media
decoder, not a sandbox for hostile codecs. The same-user/root adversary limitation
of pathname-based probing/decoding remains; pre/post checks do not certify that
an attacker with equivalent OS authority can never race file access. Windows
storage is still fail-closed pending a real ACL/reparse-safe backend and native
QA. Linux verification does not certify macOS/Windows readiness.

## Cache lifecycle and recovery

An additive schema migration stores disposable cache state separately from
business objects and permanent replay journals. A new attempt gets an internal
identity; late callbacks cannot publish over a later attempt. Completed peak
payloads have bounded structure/digest validation. Corrupt results are shown as
errors, never repaired by GET. Explicit retry rebuilds derived state only.

Admission deduplicates the same in-flight content key. This is **not** the
immutable exactly-once mutation receipt contract: cache eviction or explicit
retry may perform local work again. A lost request acknowledgement is recovered
through GET, followed by a deliberate request if still needed. The client does
not automatically resend a POST after an ambiguous acknowledgement.

A backend-only opaque ownership check is derived from the acquired workspace
lock and its current identity. It is invalidated before store close/release.
Only that exclusive workspace owner can reconcile, admit, decode or publish
cache work. Secondary `lock:false` business readers retain GET but cannot steal
another owner's running state or start a decoder. Same-store wrappers share one
queue. Empty/ready-only cache initialization uses no write transaction.

Restart by a new exclusive owner reconciles unfinished work to interrupted
without starting a decoder.
An explicit request is needed to resume/rebuild. Accepted work may finish when
its UI is hidden; hiding stops new requests and polling, and does not imply
business cancellation. Backend shutdown aborts and joins explicitly owned work
before SQLite closes. Cancellation cannot force an uncooperative filesystem
operation to settle; an unconfirmed drain rejects shutdown instead of claiming
the descriptor or database is safely released. Unconfirmed media termination retains the existing
resource accounting/fail-closed shutdown behavior.

Capacity admission may evict terminal entries deterministically, never active
or queued work. GET has no LRU write. Cache cleanup can touch only cache rows;
it cannot delete source files, active work, business state or replay protection.
Corruption beyond the admission bounds leaves waveform operations unavailable
while ordinary editing remains accessible. That exceptional case requires safe
removal of the disposable cache while the backend is closed; this increment
does not provide a general database-repair or cache-management UI.

## Acceptance gates

- Real mono/stereo, opposite-phase, silence, amplitude steps and video-embedded
  audio; first-stream selection and honest unsupported capability states.
- Every PCM byte/chunk boundary, partial frames, nonfinite/floating full-scale
  samples, byte/time/stderr limits, spawn/exit/abort/unconfirmed ownership.
- Noncreating reads, bounded windows, corruption, migration preservation,
  deterministic cache capacity, same-key dedupe, bounded queue, project/asset
  reassignment and source path/hash/identity changes.
- Actual authenticated HTTP, CLI and official MCP discovery/request/get/restart,
  with synthetic sources and no live provider calls.
- Timeline offset/trim/split/zoom geometry, explicit opt-in, visibility bounds,
  stale responses, project navigation, lost acknowledgements and explicit retry.
- Fresh builds and ordinary sandboxed Linux Electron screenshots, including
  persisted ready cache with default-off UI after complete app recreation.
- Independent parent aggregate and source-hash review before commit.

## Verification record

The first combined 16-file affected run
reported **340 total, 333 passed, 3 failed and 4 cancelled**. Six deterministic
mutation race cases were affected by the unnecessary empty-cache constructor
transaction; the other failure was an existing explicit read-only operation
fixture that needed the newly added `asset.waveform.get`. The failed run is
retained in `evidence/waveforms/affected-before-owner-fix.log`; it is not a pass.
The portable-only launcher also correctly rejected a Linux-specific file group
until the explicitly selected full/Linux lane was supplied; that admission log
is retained separately. The corrected identical 16-file group passed **348/348**, zero skips or
cancellations, in 56.09 s (`evidence/waveforms/affected-final.log`). It includes
52 cache/owner checks, 19 decoder checks, 9 real transport checks, waveform UI,
legacy cross-process replay, storage/inspection and real fade-render regressions.
The six originally blocked mutation races separately passed 6/6.

Fresh `node scripts/tooling.mjs build` passed for web and desktop; the existing
Vite chunk-size warning remains. All 49 built-file hashes were unchanged through
runtime QA (`evidence/waveforms/build-manifest.json` and `runtime-integrity.json`).
The cloud browser used a disposable local authenticated fixture with synthetic
MP4 and opposite-phase stereo WAV sources. It verified default-off state, real
ready overlays, source-in amplitude/silence mapping, keyboard zoom, draft
preservation across waveform toggle/right-dock tabs, cancelled project navigation,
collapse/mode lifecycle and default-off reload with byte-identical cache reuse.
The UI DOM at source-in 30 frames showed approximately 0.8/0/0.35/0.65 raw
amplitude regions, unaffected by the clip's 0.6 gain and existing fades.

Ordinary sandboxed Linux Electron, without debugging hooks, verified initial
cache count zero and opt-in preparation, source-in inspection, complete process
exit/recreation, default-off state and reuse of exactly the same cache rows and
attempt IDs. Both native lifetimes exited normally with code 0. Browser and
native audits retained identical assets, ranges, dispositions, timelines/history
receipts and managed-source hashes. No jobs, exports or Agent runs were created
by waveform QA. The separate affected regression suite includes real fade exports.

Evidence lives under `evidence/waveforms/`: six browser and five native screenshots,
fixture before/ready/after audits, `native-comparison.json` and runtime integrity.
`native-05-recreated-cache-ready.jpg` shows the actual timeline envelopes after
app recreation with source-in 30 frames and gain 0.6 visible; the large center
preview icon is the existing audio-source artwork, not measured waveform output.
The failed browser checkbox-role locator, ineffective bound-window Alt-F4 and
small audit-field mistakes were QA harness issues; supported button/window-manager
controls and corrected read-only audits completed the checks. No application
change was made for those failures. Original tool results are the primary evidence;
`runtime-notes.json` records their scope without claiming packet capture or blanket
absence of network attempts. Mac/Windows native behavior and live providers were
not tested. Independent parent aggregate remains the release gate.

## Upstream reference

Checked 2026-10-10: FFmpeg documents input protocol allowlists in
[Protocol Options](https://ffmpeg.org/ffmpeg-protocols.html#Protocol-Options)
and demuxer selection limits in
[Format Options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options).
Waveform probing and decoding use explicit local protocol and supported-demuxer
allowlists; the real fixture tests verify those bounds on the installed binary.
These flags do not establish a complete hostile-media decoder sandbox.
