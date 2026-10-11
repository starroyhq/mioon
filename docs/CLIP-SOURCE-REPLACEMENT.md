# Explicit clip source replacement

Updated: 2026-10-10 UTC. Baseline: `168c22d`.
Implementation and local verification are complete; the parent-owned independent
release suite and commit remain pending. This is a bounded version-workflow increment,
not visual A/B comparison or automatic generation/version propagation.

## Shared operation

`timeline.clip.replaceSource` takes `projectId`, `clipId`, `assetId`, required
`expectedRevision` and stable `requestId`, plus optional explicit `versionId`.
HTTP, CLI, official MCP and the built-in UI share the timeline business service.
The operation is not an in-app Agent tool.

- Replace video with video, audio with audio, or still image with still image.
  Supported MIME types remain the existing timeline types. Cross-category
  replacement is deliberately excluded even when the track accepts both kinds.
- Preserve clip ID, name, track, start, duration, source-in, rectangle, gain and
  optional fade fields. Preserve neighboring clips, total duration and order.
  The new source must supply the entire existing source range. No trimming,
  source-in reset, fade reset, name update or layout adjustment is implicit.
- Frame positions use the existing 30 fps editing timebase. The exclusive source
  end must be within `sourceFrameCount(duration)`; this is not native/VFR
  frame-accurate source indexing. Still images keep source-in zero.
- Replacing a clip with its current asset returns `SOURCE_UNCHANGED` without a
  revision/history/replay write. Choose another source or edit clip fields with
  the existing operation.
- The new asset is a fixed same-project managed asset. An explicit `versionId`
  must resolve to exactly that asset with valid project/shot/job/hash lineage.
  The backend pins its canonical `versionId` and `shotId`. Asset-only selection
  does not invent a shot/version relation. Prior `versionId`, `shotId` and
  `jobId` clip fields are removed together before installing explicit provenance.
- Changing a shot's selected version or generating a later version does not
  replace any timeline source. Originals, versions, saved source ranges,
  dispositions and old render snapshots are untouched.

## Atomicity, replay and ownership

Replacement reuses the timeline's synchronous SQLite mutation transaction,
required revision check, durable exact-response journal and undo/redo history.
It does not add a database migration or another request-key namespace. Timeline
request IDs conflict across timeline operations/projects when the exact input
changes; this is not a claim of global deduplication across every business API.
An exact acknowledged response is returned before fresh revision checks, including
following later replacement, removal, undo/redo, branching and restart.

The new operation additionally validates bounded relational/JSON identity and
media lineage in the same transaction. Replay validates its saved response and
owned timeline/source bindings without requiring today's clip to still match.
Foreign, missing or corrupt relations fail safely; a replay cannot disclose a
foreign historical source. Existing operations retain their prior wire behavior.
New safety checks reuse the private inspection graph reader and its limits rather
than trusting caller asset/version metadata. The existing reader caps a timeline
row/receipt at 256 KiB (unified by the later manual-subtitle slice; originally
128 KiB) and a validated source graph at 4 MiB / 1024 records;
oversized or malformed records fail without a partial edit. Both new-operation
backend and client acknowledgement checks accept the supported saved timeline
shape rather than normalizing arbitrary unknown stored fields. This is not
generic database repair.

A successful replacement is one history entry. Undo and redo restore source
provenance with all clip fields and advance the ordinary timeline revision.
Rejected operations cannot consume a key, remove redo, or partly update a clip.

## Right Properties workflow

The existing clip inspector offers inline source selection and a distinct review
step. The review displays old/new source names and durations, preserved clip name,
source range/timing and reviewed timeline revision. A version option is explicitly
labeled. Current/foreign/unsupported or insufficient sources are not authorized
by the picker; the backend remains authoritative.

Save or explicitly discard existing clip-field drafts before beginning replacement.
Review targets and metadata are pinned. Revision, candidate metadata, clip or
project changes invalidate approval rather than silently refreshing the proposal.
Tab changes and dock collapse do not apply it. A retained completed review is
labeled as a historical acknowledgement; later edits or undo may change the
current source shown above it. The existing main preview/player
is reused; there is no additional hidden player or new modal.

The UI stores the exact submitted operation/input/key before dispatch using the
existing session receipt. An uncertain response does not mean failure or permit
a differently keyed retry. Arbitrary 4xx errors do not clear a replacement receipt:
a successful earlier attempt can later fail an ownership or receipt check during
recovery. Only a valid matching acknowledgement or request-bound `not_applied`
proof from an observed fresh-key, known pre-write rejection and completed rollback
releases it. Ownership, auth, malformed receipt, key conflict, untyped and
post-write failures do not supply that proof. Explicit recovery resends the same
bytes/key. Durable
backend replay survives restart, but this UI session receipt does not claim native
app-recreation discovery for an acknowledgement lost before the renderer saved its
result. Already applied timeline edits and history are persistent on recreation.

## Derived data and exports

Replacement increments the timeline revision, making old preflight reports and
rendered-preview freshness checks stale. Waveform lookup follows the fixed new
asset and its source-hash/algorithm cache key; the replacement operation requests no
decode, and old source cache data remains valid for its original asset. An already
enabled, explicitly opted-in waveform view may schedule the newly visible source
through its existing bounded queue. Waveforms
still describe raw source audio, before timeline gain/fades/mix.

An earlier export retains its frozen old asset/hash and output bytes. A subsequent
explicit preview/export freezes the new source. Ordinary render-time file/hash,
metadata and decoding checks remain required; replacement is not a full source
file verification pass.

## Acceptance gates

- Shared strict schema/effect discovery; real HTTP, CLI and official MCP calls,
  duplicates, lost acknowledgement, restart, changed-key conflict and CAS.
- Exact field/omitted-field preservation, MIME/category/fade/source-bound errors,
  explicit version lineage, corrupt SQL/JSON ownership and uniform safe errors.
- Atomic rollback, independent writers, no-op and rejected edit preserve history;
  exact original replay after later history/removal/branching.
- Real synthetic contrasting video/audio exports: same frame count, geometry,
  timing, gain and fades; decoded colors/tones change; original and old export
  byte hashes stay unchanged. Preflight and waveform identity follow the source.
- Actual browser/native inline review, dirty/stale/cancel/tab/collapse/navigation
  behavior, explicit replacements, undo/redo and full app recreation.
- Final affected checks, fresh web/desktop build, source/bundle hashes and runtime
  screenshots; parent-owned independent full suite is the final release gate.

No live providers, real credentials, uploads to providers, paid generation,
macOS/Windows native certification or visual comparison are part of this gate.

## Local verification checkpoint (2026-10-10 UTC)

Evidence is retained locally under `evidence/clip-replacement/` (ignored, synthetic
fixtures only). These overlapping focused runs are not one aggregate suite:

- Backend/replay/ownership/recovery: 171/171 passed. Shared protocol/schema/client
  checks: 14/14 passed, including real HTTP, CLI and official MCP processes.
- UI/state/recovery: 142/142 passed; cross-feature affected checks: 119/119 passed,
  including real media export. Final history/copy checks: 42/42 passed after the
  two presentation-only corrections found during runtime QA.
- Final installed-entrypoint web/desktop build passed. Staged desktop web files
  match the final web build; source and 49 built-file hashes are recorded locally.
- Actual cloud-browser UI covered dirty draft retention, excluded candidates,
  stale review after another saved edit, cancel, project/tab/collapse transitions,
  explicit asset-only replacement, undo/redo, export and reload. Browser runtime
  preceded the final historical-acknowledgement wording change.
- Actual Linux Electron UI covered explicit V2 replacement while the shot kept
  selected V1, undo/redo, export, normal exit and process recreation. On final
  bundle recreation, timeline/request/export state matched the previous clean
  exit before further actions. A second explicitly reviewed asset-only replacement
  and undo then exercised the final acknowledgement copy and restored V2. Both
  native processes exited normally; no replacement was initiated by recreation.
- Real before/after exports fully decoded. Runtime exports both retained 60 frames
  / 2 seconds; center colors changed red to blue. The separate media regression
  also checked source-offset timing, rectangle, gain/fade amplitude windows and
  440 Hz to 880 Hz content. Original media and earlier export byte hashes/snapshots
  remained unchanged. No waveform decode or Agent run was created by replacement.

The first transport run had a test-only JSON-schema expectation mismatch
(`minimum: 1` versus Zod's `exclusiveMinimum: 0`). Its original log was overwritten
before the preservation request; the complete captured tool output and provenance
note are retained, followed by the corrected passing run. Initial UI launcher
startup used an unavailable `node` PATH entry; its failure was retained and the
fixture wrapper switched to the existing verified absolute Node path. No app
security setting was changed. Native audio-device warnings and cloud-browser
extension metadata errors are retained; audible device playback is not claimed.
Build directive/chunk-size warnings remain visible rather than being suppressed.

Final native screenshots 13–17 use the final bundle. Earlier browser/native
screenshots remain labeled with their earlier builds. The independent parent
aggregate is still required before release.
