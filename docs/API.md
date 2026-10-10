# HTTP API

Base URL defaults to `http://127.0.0.1:4318`. Only loopback Host/Origin accepted. All `/api/*` except login and all `/media/*` require `Authorization: Bearer <local token>` or the HttpOnly SameSite=Strict login cookie. `/health` is public. The token is server-side configuration; do not place it in URLs.

`POST /api/login` body `{"token":"<local token>"}` exchanges the token for a browser cookie.

`POST /api/rpc` body:

```json
{"operation":"project.create","input":{"name":"我的影片"}}
```

Response: `{"ok":true,"data":...}`. Error: `{"ok":false,"error":{"code":"REVISION_CONFLICT","message":"...","details":{"currentRevision":2},"retryable":false}}`. HTTP 400 invalid input, 401 unauthenticated, 403 invalid origin/provider disabled, 404 missing record/operation, 409 stale revision or idempotency conflict. Do not blindly retry a generation with a new key when a response is lost; replay the original exact request.

For business RPC, the runtime schemas in `packages/contracts/src/index.mjs` are authoritative and strict (unknown fields rejected). `docs/CONTRACT.md` documents full-record and mutation input/record contracts. MCP tools expose these same schemas through tools/list.

## File and event transports

Authenticated `GET /media/:assetId` and `HEAD /media/:assetId` retain single-byte
range support, including suffix/open-ended ranges and 416 rejection. Missing
managed file bytes return fixed 404 `FILE_UNAVAILABLE`. Per-backend file-transfer
admission can return 503 `FILE_RESPONSE_BUSY`. Errors after response headers
close that transport; they cannot return a second JSON envelope.

Agent SSE consumers may reconnect with the committed event cursor. A slow or
disconnected consumer is detached without stopping or retrying inference or
business mutations. Explicit Stop remains a separate authenticated request.
An acknowledgement lost after a write remains ambiguous: recover the exact
durable request identity, never infer failure or generate a new key merely
because the transport closed. Bounds and cleanup details: [HTTP streaming](HTTP-STREAMS.md).

## Non-creating project inspection

Use these additive operations to inspect bounded, allowlisted metadata without
creating a timeline, changing revisions/history, reading media files, running
media subprocesses, or contacting a provider:

| Operation | Strict RPC input |
| --- | --- |
| `project.inspect` | `{projectId}` |
| `asset.inspect` | `{projectId,limit?,cursor?}` |
| `shot.inspect` | `{projectId,limit?,cursor?}` |
| `timeline.inspect` | `{projectId}` |

`projectId` is a required UUID. Page `limit` is an integer from 1 through 25,
default 10; `cursor` is an optional opaque string of at most 512 characters.
Extra fields are rejected. For example, replace the example UUID with the
chosen project's actual ID:

```json
{"operation":"project.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111"}}
```

```json
{"operation":"asset.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111","limit":10}}
```

```json
{"operation":"shot.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111","limit":25}}
```

```json
{"operation":"timeline.inspect","input":{"projectId":"11111111-1111-4111-8111-111111111111"}}
```

Pass only a page's supplied `nextCursor` for continuation; never construct or
edit it. Keep the same limit. Cursors bind to the project, operation and limit and expire
across backend restarts. Restart from the first page when necessary. Inspection
does not export structured paths, media URLs, raw bytes, full provider/job
snapshots or credentials. Shot `prompt` fields are limited to a 1000-UTF-8-byte excerpt
with an explicit `promptTruncated` flag. User-authored text is untrusted and may itself
contain URL-like or path-like strings; omission of structural fields is not a
claim that arbitrary text is secret-free. See [Agent inspection](AGENT-INSPECTION.md)
for result fields, page consistency, limits and scope binding. Asset/shot pages
return `{items,nextCursor}` with `nextCursor:null` at the end; an absent timeline
returns `null`.

These RPC inputs select a project using the existing authenticated local
connection. The exported `inspectionArgumentSchemas` separately omit `projectId`
and all authority fields for callers that bind scope outside the arguments;
`inspectionSchemas` adds only the RPC project ID. Neither schemas nor inspection
metadata grant access. Built-in Agent inspection uses a separate explicit
run-consent boundary, described in [bounded Agent reads](AGENT-READ-TOOLS.md).

Legacy `project.get` and `timeline.get` retain their existing responses and can
create the default empty timeline on first access. They are not read-only. Use
the new `.inspect` operations when non-creating metadata inspection is required.

## Project workspace preferences (UI-only)

`GET /api/workspace-preferences/:projectId` returns `{ok:true,data:{projectId,revision,state}}`; an absent saved view has revision `0` and state `null`. `PUT` accepts exactly `{expectedRevision,state}`, a strict complete version-1 view whitelist capped at 16 KiB. It uses the same authentication and Host/Origin boundary. Stale differing state returns `409 PREFERENCES_CONFLICT`; an exact retry of the latest accepted write returns its existing revision.

These independent preference revisions never update project/shot/timeline revisions, history or business idempotency. This endpoint is not a business RPC operation or MCP tool. Full fields, bounds, concurrency, migration and close behavior: [Workspace preferences](WORKSPACE-PREFERENCES.md).

## Example Node client

```js
const call = async (operation, input) => {
  const response = await fetch('http://127.0.0.1:4318/api/rpc', {
    method: 'POST',
    headers: {'content-type':'application/json', authorization:`Bearer ${process.env.MIOON_TOKEN}`},
    body: JSON.stringify({operation,input})
  });
  const result = await response.json();
  if (!result.ok) throw result.error;
  return result.data;
};
const project = await call('project.create', {name:'短片'});
```

Assets are imported as base64 bytes, never arbitrary machine file paths or remote URLs. Metadata and generated media IDs map to managed files. Download `/media/{assetId}?download=1`; requests support byte ranges for browser video playback.

## Concurrency, retries and recovery

- shot.update/node.update/version.select require expectedRevision; stale values reject with the current record, never overwrite silently
- shot.reorder checks the project revision and must be an exact permutation of all shots
- generation.submit requires a stable requestId. Same exact input returns original job before checking current shot revision; same ID with altered payload yields IDEMPOTENCY_CONFLICT
- job.retry only accepts a definitively failed job plus a new requestId, retains the old snapshot, creates a linked new job
- job.reconcile resumes a known task or reconciles its request key without submitting. An optional verified providerJobId can attach an existing unknown task
- job.cancel stops local waiting only and explicitly returns cancelScope=local_only
- Result versions have a database immutability trigger, unique job ID and immutable files; first output auto-selects only if no selection exists
- export.create freezes shot order and chosen version IDs/hashes. Later edits do not change that export

## Optional exact replay for local edits

`shot.create`, `shot.update`, `shot.reorder`, `node.create`, `node.update` and
`version.select` accept optional `requestId` (8–200 characters). Supply and retain
one stable ID for each intent when recovery is needed. Without it, legacy calls
remain non-idempotent. Exact replay returns the original immutable response,
including original IDs/revisions, after ownership validation and before current
revision checks; changed operation/project/input under the key returns
`IDEMPOTENCY_CONFLICT`. New intentional edits use new keys and current revisions.
Mutation and receipt commit in the same synchronous SQLite transaction. Replaying
is not a read of current state; refresh before later edits. Missing/foreign/corrupt
ownership cannot be bypassed by an old receipt.

A fresh keyed business rejection can provide
`error.details:{mutationOutcome:"not_applied",requestId:"..."}` only after the
backend observed no prior receipt and rolled back. Other 4xx, malformed results,
authentication failures or lost responses are not no-commit proof. No HTTP client
or built-in Agent automatically retries these operations. Existing timeline,
reference and generation/export contracts are unchanged. See
[shared mutation replay](MUTATION-REPLAY.md) for UI recovery and persistence limits.

## Image-node generation inputs

Use `reference.attach` with `{projectId,sourceNodeId,targetShotId,expectedSourceRevision,expectedShotRevision,requestId,role:'first_frame'}` to connect a managed image node to a shot, returning `{edge,shot}`. Use `reference.detach` with `{projectId,edgeId,expectedShotRevision,requestId}` to remove it, returning `{edge,shot,detached:true}`. The operations are atomic and share strict schemas across HTTP, CLI and MCP.

- One first-frame connection per shot, same-project endpoints and an existing managed PNG/JPEG/WebP image only.
- Clear and save a manual image choice explicitly before attaching (`REFERENCE_SELECTION_EXISTS`). Connected images cannot be silently changed via `shot.update` or `edge.delete` (`REFERENCE_CONNECTED`); detach first.
- Source node and shot revisions must be current. Detach checks the shot revision. Source image IDs cannot be edited through `node.update`.
- Preserve the exact request after an uncertain result. Replay returns its saved original response even after later edits or restart; changed reuse conflicts. A repeated attach with a new ID and current revisions returns the existing edge without duplicates.
- UI/CLI/MCP validate complete operation-bound acknowledgements. Malformed success and later generic errors retain the original key; only fresh, pre-write, rolled-back reference rejection with exact operation/project/request proof permits clearing it. Historical replay revalidates ownership without requiring the old edge to remain present. Existing receipts gain DELETE/replacement retention triggers without data or schema-version changes. See [reference recovery](REFERENCE-RECOVERY.md).
- Detach preserves the managed asset, source node, generated versions and immutable in-flight snapshots. New generation snapshots also record the typed connection provenance.
- `edge.create` and all historical untyped edges remain decorative. They never supply generation inputs. No general graph execution or character/style consistency is implemented.

Model, MIME/dimension/ratio, budget and approved-media validation remain authoritative at generation time. Connecting an image makes no provider call. See [the full reference contract](CONTRACT.md#typed-first-frame-connections).

## Multitrack timeline (v2)

`project.get` additively includes a persistent `timeline`. Both it and `timeline.get`
accept `{projectId}` and lazily create the same empty default timeline for
legacy projects. Initial revision is 1; defaults are two video tracks and one
audio track. No existing shot or selected version is automatically copied.

All timeline writes accept `{projectId,expectedRevision,requestId,...}`:

| Operation | Additional inputs |
| --- | --- |
| `timeline.track.add` | `kind:'video'|'audio'`, optional `name` |
| `timeline.track.update` | `trackId`, nonempty `patch:{name?,hidden?,muted?}` |
| `timeline.clip.add` | `trackId,assetId,startFrame,durationFrames`, optional `name,sourceInFrame,rect,gain,fadeInFrames,fadeOutFrames` |
| `timeline.clip.update` | `clipId`, nonempty `patch:{trackId?,name?,startFrame?,durationFrames?,sourceInFrame?,rect?,gain?,fadeInFrames?,fadeOutFrames?}` |
| `timeline.clip.replaceSource` | required `clipId,assetId`; optional `versionId` (exact generated version) |
| `timeline.clip.remove` | `clipId` |
| `timeline.clip.split` | `clipId,atFrame` (strict interior integer timeline frame; non-ripple) |
| `timeline.seed` | none; only an empty timeline with all shot selections present |
| `timeline.render` | `purpose:'preview'|'export'`, optional `preflightSnapshotHash` (lowercase SHA-256) |

Mutations return the whole timeline and increment its revision once. Rendering
returns a queued `exports` record with `mode:'timeline'`, a frozen snapshot and
`timelineRevision`; poll `export.get` for current progress. The snapshot and
render output are never changed by later edits. Rendering does not increment
the timeline revision. Preview/export composition semantics are identical.

Every timeline request ID has an immutable saved response. Exact replay returns
that original response, including after newer edits and process restart.
Altered reuse conflicts before revision checking. For timeline rendering,
replaying the create call returns the original queued record even after the
job succeeds; use `export.get` to observe completion.

Times are integer frames at 30fps. Output is 720×1280; maximum 12 tracks,
100 clips, 18000 output frames. Reject same-track overlap, source overruns,
wrong track media types, cross-project references and invalid rectangles.
Unknown input fields (including nested patches and rectangles) reject. See
[`TIMELINE.md`](TIMELINE.md) for full rendering, bounds and migration semantics.

Clip `fadeInFrames` and `fadeOutFrames` are optional integer 30fps frame counts
from 0 to 18000. Each must fit the clip duration, and their sum cannot exceed it.
Missing fields mean zero without rewriting legacy clips, snapshots or saved
responses; explicit zero clears an existing fade. Positive fades require an
audio/video asset with `hasAudio:true`. Update validation uses the resulting
clip, so shortening a clip may require reducing its fades in the same patch.
Business bounds failures use `INVALID_FADE`; unsupported positive fades use
`FADE_AUDIO_UNSUPPORTED`; malformed fields use `VALIDATION_ERROR`. Rejections
change no timeline, history, redo branch or request journal.

Splits must also be outside the interior of a fade: the offset from the clip's
start must be at least `fadeInFrames` and at most
`durationFrames - fadeOutFrames`. Exact ramp boundaries are allowed if strictly
inside the clip. Otherwise `SPLIT_FADE_BOUNDS` returns absolute `minFrame` and
`maxFrame`. A successful split preserves the original outer fade-in/fade-out
and zeros only the corresponding present fields at the new inner edges.

Rendered previews and exports apply linear clip-local audio fades with existing
gain/mute behavior; source playback stays dry. The existing timeline revision,
undo/redo and exact-replay contracts apply. Bounded inspection DTOs and built-in
Agent permissions are unchanged. See [audio fades](TIMELINE.md#audio-fades).

`asset.import` also supports `audio/wav`, `audio/mpeg` and `audio/mp4` (M4A),
with byte-signature/decoded-stream validation and the existing 30MiB limit.
`node.create` also supports `type:'audio'` with a matching audio asset.
The original `export.create` selected-shot sequence behavior is unchanged.

### Explicit clip source replacement

`timeline.clip.replaceSource` accepts exactly
`{projectId,expectedRevision,requestId,clipId,assetId,versionId?}`. Project, clip,
asset and any supplied version are UUIDs; `expectedRevision` is the positive
current timeline revision. The stable `requestId` is **required** (8–200
characters); `versionId` alone is optional. The normal `timeline.clip.update`
patch still rejects `assetId`, `versionId` and other source/provenance fields.

This is an explicit, undoable edit of one existing clip. It preserves the clip
ID, name, track, start, duration, source in-point, rectangle, gain, optional fade
values and their exact presence/absence. Neighbors, gaps, track state and total
duration remain unchanged. It never adopts saved source marks, rescales,
retimes, changes audio settings or shortens a clip to fit. Only video→video,
audio→audio and image→image are allowed, including across supported containers
within that category. Image↔video remains incompatible even on a video track.
The new source must cover the unchanged source in-point plus duration and
support any retained positive audio fades.

Without `versionId`, only the fixed `assetId` is stored, even for a generated
asset. Old `versionId`, `shotId` and `jobId` links are cleared rather than
carried to another source. With an explicit `versionId`, the backend validates
the exact owned version/asset/shot/job lineage and asset hash, then pins that
version and its canonical `shotId`; no current shot selection is inferred or
changed. Later `version.select` calls never move this fixed clip.

Success returns the complete timeline, advances its revision once and records
one undoable history entry. Undo/redo restores the exact source and clip state.
Replacing with the already-current asset rejects with `SOURCE_UNCHANGED` (409),
even if a version is supplied; it adds no history or saved request. Incompatible
categories use `INVALID_CLIP_TYPE` (400), a too-short source uses `SOURCE_BOUNDS`
(400), and retained unsupported fades use `FADE_AUDIO_UNSUPPORTED` (400).
Missing/foreign/unsafe source or version lineage uses
`TIMELINE_SOURCE_UNAVAILABLE` (404). All rejection paths preserve timeline,
history, redo branch and request receipts.

A verified fresh-key business rejection may additionally return
`error.details:{...,mutationOutcome:'not_applied',requestId}`. This proof is
bound to that exact key and confirms that this attempt committed no mutation.
Only a checked fresh request with a rolled-back, pre-write revision/no-op/type/
bounds/fade rejection receives it. Missing proof, a different proof key,
ownership/receipt failures, authentication errors and idempotency conflicts do
not establish the outcome of an earlier uncertain attempt. Keep the original
request for explicit recovery instead of clearing it from a later 4xx alone.

The operation shares the existing timeline request-key namespace with timeline
edits, undo/redo and renders, across projects on the same backend; this is not a
new workspace-global key namespace covering unrelated operation families.
Changed operation/project/input reuse returns `IDEMPOTENCY_CONFLICT` before
revision checking. Exact replay retains the original complete response after
newer edits or restart, including original timestamps and provenance. After an
uncertain result, replay the full original input/key, preserving the optional
version's presence or absence and the original revision, then refresh before a
new edit. A new key with a stale revision returns `REVISION_CONFLICT`.
A malformed or mismatched success acknowledgement returns client-side
`BACKEND_PROTOCOL_ERROR` with `submissionMayHaveSucceeded:true`. The first-party
clients validate this operation's bounded full-timeline identity, target source
and optional provenance before clearing recovery state; retain and replay the
original request rather than assuming it failed or inventing another key.

Effects are limited to local timeline/history/replay database writes. No source
bytes, media files, probes, decoding, rendering, provider calls or paid
generation are involved. External HTTP/CLI/MCP discovery does not expand the
built-in Agent catalog, inspection DTOs, media context or approval scope.
Offline transport acceptance: `node --test tests/timeline-replacement-transports.test.mjs`.

## V4 discovery and capability validation

`pnpm exec mioon schema` provides the current JSON Schema catalog; MCP `tools/list` uses the same runtime definitions. Use the shared client rather than duplicating authentication/discovery logic. See [CLI.md](CLI.md) for private token files, downloads and bounded watches.

Each schema definition also contains explicit advisory `effects`: `readOnly`,
`idempotent`, `destructive`, `openWorld`, `databaseWrite`, `fileWrite`,
`externalIO`, `localProcess`, `paidGeneration`, and explanatory `notes`. The
catalog covers every operation; a missing or unknown effect descriptor fails
coverage instead of inferring safety from names such as `.get` or `.list`.
Effects include downstream scheduled/resumed work. `fileWrite` concerns managed
files separately from SQLite writes; `externalIO` concerns provider/external
services, not the authenticated loopback RPC transport. `paidGeneration` means
a new potentially paid generation can be submitted, not that existing remote
work is free. For example, `job.reconcile` has external I/O and may resume media
downloads, while `export.create`/`timeline.render` can later run local FFmpeg.
Metadata and MCP annotations are not authorization, budget approval or automatic
retry permission. Exact stable-request replay behavior is unchanged.

`provider.list` includes `modelCapabilities`, `status` (`available`, `disabled`, `not_configured`), `configuration.missing`, `configuration.requirements`, `liveVerified` and the local generation-count budget. Provider IDs are `mock`, `runway`, `ark`, `veo`, `minimax`, `vidu`. Configuration values and credentials are never returned. Capabilities can change as local count limits are consumed; re-read before new work.

Zero references means text input; one approved image means first-frame input. Each model controls which mode, MIME types, dimensions, aspect ratios, durations and advanced parameters are accepted. Unsupported inputs fail before creating a job. Seed is not accepted for Ark/Veo/MiniMax/Vidu in this version; inspect each model's `parameters` array.

If an actual downloaded live result differs from the requested ratio by more than 1%, the backend retains the existing task and downloaded file privately, sets `phase=output_review_required` with `OUTPUT_ASPECT_RATIO_MISMATCH`, and publishes no version. Its transport-compatible `status=cancelled` means local publication/waiting is paused, not that the provider failed or was cancelled. Do not submit a replacement or use `job.retry`; inspect/reconcile the same existing task.

## Agent chat and bounded project reads

The authenticated `/api/agent/chat/:projectId` routes retain their snapshot,
run, Stop, SSE, request-ID lookup and history semantics. Snapshot scope is now
`chat_and_reviewed_shot_edits` when the reviewed-edit service is available
(otherwise `chat_and_project_inspection`). Its `inspection` capability retains
availability, schema version, catalog hash and the fixed
two-model-request/one-read/8-KiB limits. The separate `edit` capability publishes
the selected-shot schema/catalog and text/round limits described below.
No view/lookup/history route starts inference or inspection.

The existing send envelope remains strict: `requestId`, `instanceId`,
`expectedSettingsRevision`, `expectedConversationRevision`, `message`, `consent`.
Typed consent is unchanged: `{destination,protocol,model,context:'typed_chat_only'}`.
Project-read consent additionally pins `context:'project_inspection'`, `projectId`,
`schemaVersion`, `catalogHash`, `maxModelRequests`, `maxToolCalls` and
`maxResultBytes` from the current capability. Extra authority fields are rejected.
No HTTP endpoint accepts a branded scope, model step ID or executable tool grant.

Inspection runs expose immutable `contextMode`/`provenance` and at most three
projected `activity` entries. Existing snapshot/delta/terminal SSE types are
unchanged; step transitions publish committed snapshots. Exact internal model
bodies, provider output artifacts and credentials are not added to public run
DTOs. Tool results are bounded inert JSON strings. Older typed runs remain
readable and typed send requests remain compatible. Full execution/recovery,
privacy and protocol contract: [Agent read tools](AGENT-READ-TOOLS.md).

## Reviewed Agent shot-edit proposals

The reviewed-edit increment adds a separate `selected_shot_edit` consent mode
and authenticated proposal review routes. Its only business write is an
explicitly approved `shot.update` title/prompt patch; creating a proposal does
not apply it. Discovery is backend-persistent and independent of renderer
session storage. Endpoint shapes, limits, states and current acceptance status:
[reviewed selected-shot edits](AGENT-EDITS.md). These review endpoints are not
business RPC operations or callable model tools.

## Saved source ranges

`asset.range.get({projectId,assetId})` is a non-creating read for an owned video or
audio asset. `asset.range.set({projectId,assetId,expectedRevision,requestId,inFrame,outFrame})`
saves local selection metadata under an independent range revision and an exact
required replay key. These operations do not modify asset bytes, versions or
existing timeline clips. Full timebase, replay and UI boundaries:
[SOURCE-RANGES.md](SOURCE-RANGES.md). Built-in Agent inspection/tool DTOs do not
include these marks in this increment.

## Asset review dispositions

`asset.disposition.list({projectId,assetIds})` returns
`{projectId,items:[{id,assetId,projectId,revision,disposition}]}` in exactly the
requested ID order. Supply 1–100 unique asset UUIDs. The read never creates
metadata or a timeline; an owned asset without saved metadata is `neutral` at
revision `0`. Images, video, audio and unknown-duration assets are supported.
Any missing/foreign asset rejects the entire batch with the same `NOT_FOUND`
error and no partial result.

`asset.disposition.set({projectId,assetId,expectedRevision,requestId,disposition})`
accepts `neutral`, `favorite` or `rejected` and returns the strict single-item
shape above. `expectedRevision` is the disposition's independent revision,
starting at `0`; every new accepted set advances it by one. Resetting to neutral
retains the row and revision. The 8–200-character request key is required and
shares collision protection with `asset.range.set` and the original six local
mutations. Exact historical replay precedes current revision checks, after
current ownership validation; changed reuse conflicts.

Only disposition metadata and its receipt are written. Asset bytes and existing
asset/shot/project/timeline revisions, source ranges, versions and in-use clips
are unchanged. `rejected` is a review label, not deletion or an automatic clip
edit; legacy asset list and explicit timeline operations keep their semantics.
No inspection DTO or built-in Agent tool/context is expanded. Browser pending
receipts remain session-only, while backend replay receipts survive restart.
See [asset dispositions](ASSET-DISPOSITIONS.md) for the UI and recovery boundary.

## Opt-in source waveforms

`asset.waveform.request({projectId,assetId,retry?})` explicitly requests a bounded
local source-audio analysis. Both IDs are required UUIDs; `retry` defaults to
`false`. Existing queued, running and ready cache work is reused. An interrupted
or failed attempt requires a new explicit request with `retry:true`; neither a
read nor a backend restart starts it again. After a lost request acknowledgement,
call `asset.waveform.get` for the same project/asset first. This is an evictable
derived cache, not a durable mutation receipt or an exact historical replay key.

`asset.waveform.get({projectId,assetId,sourceStartFrame?,sourceEndFrame?,points?})`
is genuinely read-only: it does not probe files, run decoding, initialize or
repair cache rows, update access timestamps, or create a timeline. Missing cache
returns `status:"missing"`. The default start is `0`; the end defaults to the
source end and is exclusive in the 30fps editing timebase. Explicit start is an
integer 0–17999, end is 1–18000 and must exceed start. The selected range must
fit the available source. `points` is an integer 1–2048, default 512.

Both operations return a strict public cache state:
`{projectId,assetId,algorithm,status,binsPerSecond,reason?,attemptId?,duration?,sourceFrames?,decodedSampleFrames?,sourceStartFrame?,sourceEndFrame?,peaks?,clipped?}`.
The algorithm is `peak-u16-48k-100hz-v1`, `binsPerSecond` is 100, and status is
`missing`, `queued`, `running`, `ready`, `interrupted`, `error` or `unsupported`.
A reason is `{code,message}` without decoder diagnostics. Ready get adds the
resolved range and at most the requested number of normalized peaks (0–1 or
`null` for a display bin entirely outside actual decoded coverage).
Ready request may omit peaks/range; all ready responses require `attemptId`,
`duration`, `sourceFrames`, `decodedSampleFrames` and `clipped`. Ready
`duration`/`sourceFrames` use the saved
asset source clock; `decodedSampleFrames` records actual 48kHz coverage (at most
28,800,000 frames), within 100ms of source duration. `sourceFrames` is the
complete 30fps frame count of that duration, with only binary-rounding tolerance.
Bins use their fixed source time positions, with no stretching
and no invented silent tail. A partly covered bin uses its covered maximum. `clipped` reports amplitude clipping; it is
not a timeline clipping operation. No paths, source hashes, URLs, commands or
credentials are accepted or returned. Unknown arguments are rejected. Missing
and foreign assets have the same `NOT_FOUND` error.

Only the first audio stream is used: mono/stereo, decoded as 48kHz float32 and
reduced by absolute maximum into 100Hz bins. Audio/container duration mismatch
greater than 100ms is unsupported; a tiny codec-padding tail remains explicitly
missing. Relative first-audio start offsets exceeding 1/48000 second are
unsupported; matching known nonnegative format/audio start timestamps are
allowed. Unknown timestamps are supported only for untimed WAV with its known
sample-zero origin; negative timestamps are unsupported.
Sources longer than 600 seconds,
larger than 512MiB, or outside supported audio bounds are unsupported for this
feature. Analysis is local, with a 180-second whole-attempt deadline including
bounded hash/probe/decode and a 120-second decoder deadline. Each backend has at
most one active and four queued attempts. Cache identity is project + source
SHA-256 + algorithm, with at most 64 entries / 16MiB; eviction can require an
explicit rebuild. Startup may mark unfinished attempts interrupted, but never
automatically decodes them. Completed cache data survives restart while retained.

Request can run local media subprocesses and write derived SQLite cache data;
it does not write output media files, contact external services, create paid
generation, or edit source assets, saved ranges, versions, timeline gain/mute/
fades, revisions or history. Peaks describe raw source audio before timeline
mixing and are a visual editing aid, not a rendered-output meter. Get advertises
read-only/idempotent effects; request deliberately has `idempotent:false` because
retry and eviction can repeat work. Request also has `destructive:true` because
admission/retry may replace or evict terminal derived-cache entries; source and
business records are unchanged. These advisory effects do not authorize an
action. External HTTP/CLI/MCP discovery does not add waveform tools or media
context to the built-in Agent allowlist.

## Local timeline export preflight

`timeline.export.preflight` accepts exactly `{projectId,expectedRevision}`:
`projectId` is a UUID and `expectedRevision` is a positive integer for the
existing timeline. It is a read operation, separate from export submission.
It does not initialize a missing timeline, write SQLite/cache/files, create an
export, fully decode media, call providers, or incur generation charges. It
reads managed source bytes, hashes them incrementally, and runs bounded local
`ffprobe` metadata checks. The supported output is 720×1280 at 30fps.

```json
{"operation":"timeline.export.preflight","input":{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":4}}
```

The strict public response contains only:

- `projectId`, the requested `expectedRevision`, ISO `checkedAt`
- `timelineId` (UUID or null), `timelineRevision` (positive integer or null)
- `snapshotHash` (lowercase 64-character SHA-256 or null)
- `status`: `ready`, `blocked`, `incomplete`, or `stale`
- `summary` (null or the bounded counts below)
- `checks:{totalAssets,checkedAssets,bytesHashed,fullDecode:false}`
- `issues`: at most 128 `{code,severity,message,assetId?,clipId?}` entries;
  codes are 1–64 uppercase letters/digits/underscores beginning with a letter,
  severity is `error` or `warning`, and messages are at most 240 characters.
  Optional asset/clip IDs are UUIDs. No source filenames, paths, URLs, raw probe
  diagnostics, commands, credentials, or media bytes are included.

A non-null summary is
`{fps:30,width:720,height:1280,durationFrames,trackCount,clipCount,assetCount,visualClipCount,audibleClipCount,mutedTrackCount,hiddenVideoTrackCount}`.
Duration is 0–18000 frames, track counts are 0–12, and clip/asset counts are
0–100. Counts of visual/audible clips reflect track visibility/mute and source
capabilities; they do not claim perceptual picture/sound quality. The check is
bounded to 100 assets, 512MiB per source, 1GiB total hashed bytes, 30 seconds,
and 128 reported issues. `checkedAssets` never exceeds `totalAssets` (both
0–100); `bytesHashed` is 0–1GiB. These bounds do not raise timeline limits.
Checks stop at the first blocking or incomplete condition; the issue list is
not an exhaustive audit of every source. Use `checkedAssets` to see completed
coverage. A strict `ready` report has a non-null timeline identity, revision,
digest and summary, matches the requested revision, has checked every summarized
asset, and contains no error issue. Visual/audible counts cannot exceed clips.
Preflight ownership-graph reads have an aggregate safety budget of 4MiB of
saved metadata and 1024 records. Exhaustion reports `incomplete` with
`PREFLIGHT_SNAPSHOT_BUDGET`; the digest stays null until ownership verification
succeeds. This is a security metadata bound, separate from source-byte limits.
The render worker instead validates each distinct clip/source lineage
independently before file I/O, retaining a 4MiB/1024-record safety bound for each
lineage. It has no aggregate whole-composition metadata ceiling: many valid
independent sources can render even when preflight exhausts its aggregate
budget. The per-lineage bound is an additional security limit that also applies
to rendering; only the aggregate preflight and preflight source-byte/time
budgets are preparation limits.

Interpret the status explicitly:

- `ready`: no known blocker was found by the checks completed at `checkedAt`.
  It is not a full decode or a guarantee that the sources will remain available.
- `blocked`: a known export blocker needs attention. A bounded check must not
  disguise a discovered blocker as a successful result.
- `incomplete`: a cap or timeout prevented a complete check. This does not mean
  export failed, and is not an export ban. A user may explicitly choose to try
  export with the limitations understood.
- `stale`: the expected revision no longer matches the current timeline or the
  checked snapshot changed. Refresh and check the intended current state.

A missing timeline is reported without creating one, with null timeline
identity/revision; an unknown project still returns `NOT_FOUND`. Reports are
point-in-time observations, not stored receipts. Repeated reads can differ.
`effects` truthfully advertises `readOnly:true`, `localProcess:true`, no database
or file writes, no external I/O, and no paid generation. MCP's conventional
`idempotentHint:true` for this read does not promise identical report bytes.

The shared Node client (CLI/MCP) gives only this operation a default 35-second
HTTP deadline, allowing grace after the backend's 30-second analysis budget and
best-effort child cleanup. Existing operations keep their 30-second default.
An explicitly configured client/request timeout wins, including an explicit
30 seconds. Node event-loop scheduling and filesystem work are not hard
real-time guarantees. Timeout/disconnect never causes an automatic POST retry.
The client rejects malformed or wrong-project/revision reports with
`BACKEND_PROTOCOL_ERROR`; it does not describe this read as an uncertain mutation.

For a separate, explicitly intended `timeline.render`, callers may supply the
report's non-null `snapshotHash` as `preflightSnapshotHash`, retaining its
`projectId` and `expectedRevision`. The backend verifies that digest against
current frozen content before admitting a new render. Never construct a digest
or silently replace a stale one. The field is optional with no default: omitted
legacy requests retain their exact input shape and response. Retain the complete
render request, including any digest and stable `requestId`, after uncertainty.
Exact render replay is resolved first and returns the original saved response,
even after later edits or source changes. Changing the digest under the same
key is changed reuse and conflicts. Preflight alone never submits an export;
observe an accepted render with `export.get`.

If an `incomplete` report has no digest, a user can separately choose a clearly
labeled, one-use attempt to export the current saved timeline without completed
preflight. Refresh and bind the intended project/current revision, use a fresh
render request key, and omit `preflightSnapshotHash`; never synthesize a checked
binding or label this attempt as checked/ready. The UI exposes this as a
separate explicit action, not an automatic fallback. Known blockers, error
issues and stale reports do not authorize that action. Actual worker ownership
and media validation still apply. This is a new user-approved intent, never a
way to modify an uncertain render request: exact replay must retain its
original digest or omission.

This additive external HTTP/CLI/MCP capability does not expand built-in Agent
model tools, inspection DTOs, media context, or approval scope. Offline transport
acceptance: `node --test tests/timeline-preflight-transports.test.mjs`.

### Timeline recovery acknowledgement boundary

All eleven keyed timeline writes (track/clip edits, seed, undo, redo and render)
validate complete operation-bound acknowledgements. A later 4xx, malformed success,
corrupt receipt or ownership failure leaves the original outcome unknown. Only a
matching request-bound `mutationOutcome:"not_applied"` proof from a fresh,
pre-write business rejection after rollback establishes non-application. Exact
historical replay checks current ownership before returning unchanged stored data;
it does not require the historical clip to remain present or a newer revision to
match. Request schemas, response shapes, history and journal namespaces are unchanged.

Pending timeline renders require explicit exact replay. Even a well-shaped
progressed public export cannot prove current receipt/source ownership; public
snapshots also omit private paths included in preflight digests. Project refresh
therefore never automatically clears an unknown render receipt. Reference errors conservatively retain uncertainty;
reference recovery now also validates operation-bound acknowledgements and retained ownership; see [REFERENCE-RECOVERY.md](REFERENCE-RECOVERY.md). See
[TIMELINE-RECOVERY.md](TIMELINE-RECOVERY.md) for scope and session-storage limits.

### Durable UI edit tasks (twelve-operation slice)

The authenticated `/api/tasks` route family coordinates only the ten timeline
metadata edits (all timeline mutations except `timeline.render`) and
`reference.attach` / `reference.detach`. It is a UI recovery control plane, not
an additional generic RPC, MCP tool or Agent capability. The underlying shared
business handlers, request schemas and exact response journals remain unchanged.
See [TASK-RECOVERY.md](TASK-RECOVERY.md) for implementation/acceptance status.

- `POST /api/tasks/prepare`: `{projectId,operation,input,origin}` where origin is
  `new` or explicitly adopted `legacy_session`. Preserve input's exact original
  request ID. Returns `{task,instanceId}` after durable preparation, without
  executing the edit.
- `GET /api/tasks?projectId=...&pendingOnly=true&limit=20&cursor=...`: bounded,
  noncreating `{items,nextCursor,instanceId}`. `pendingOnly=false` includes
  acknowledged retained identities. Limit is 1–50; cursors bind project/filter.
- `GET /api/tasks/:taskId?projectId=...`: noncreating task lookup.
- `POST /api/tasks/:taskId/execute`: `{projectId,digest,instanceId}`. Explicitly
  execute or recover only the immutable stored intent. A stale backend lifetime
  nonce is rejected; no endpoint automatically retries the request.
- `POST /api/tasks/:taskId/reconcile`: `{projectId,digest}`. Read the original
  business receipt and update coordination state only; never dispatch an edit.
- `POST /api/tasks/:taskId/acknowledge`: `{projectId,digest,expectedRevision,status}`
  with terminal status `applied` or `not_applied`. Acknowledgement hides a finished
  card, not its immutable identity or business receipt.

Action replies are `{task,instanceId,result?}`. A result is the original validated
business response, not a current project snapshot. Task identity, project,
operation, input, digest, backend instance and monotonic revision must be checked
before clearing uncertainty. A malformed 200 or generic 4xx does not establish
non-application. Re-read a lost acknowledgement; never substitute another key.

Preparation accepts at most 8 KiB exact input; HTTP preparation envelopes are
capped at 12 KiB, other action bodies at 1 KiB and request URLs at 2 KiB. Task
storage reserves 16 KiB per identity, up to 4,096 identities / 64 MiB logically.
Capacity refusal occurs before business dispatch and is distinct from disk full.
No silent eviction is implemented; this is not a bound on SQLite/WAL disk size.
GET/list cannot initialize timelines, execute recovery or clear pending state.

The eight local canvas/asset edits, rendering and generation retain their existing
UI recovery/storage paths. External callers still use their existing operation
and original key directly; this route family does not upgrade their request
persistence automatically. No task input contains credentials or media bytes;
local task parameters are ordinary SQLite data, not vault-encrypted.
