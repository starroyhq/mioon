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
| `timeline.clip.add` | `trackId,assetId,startFrame,durationFrames`, optional `name,sourceInFrame,rect,gain` |
| `timeline.clip.update` | `clipId`, nonempty `patch:{trackId?,name?,startFrame?,durationFrames?,sourceInFrame?,rect?,gain?}` |
| `timeline.clip.remove` | `clipId` |
| `timeline.clip.split` | `clipId,atFrame` (strict interior integer timeline frame; non-ripple) |
| `timeline.seed` | none; only an empty timeline with all shot selections present |
| `timeline.render` | `purpose:'preview'|'export'` |

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

`asset.import` also supports `audio/wav`, `audio/mpeg` and `audio/mp4` (M4A),
with byte-signature/decoded-stream validation and the existing 30MiB limit.
`node.create` also supports `type:'audio'` with a matching audio asset.
The original `export.create` selected-shot sequence behavior is unchanged.

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
