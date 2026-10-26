# CLI and MCP operations

All CLI responses are JSON envelopes: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code": ..., "message": ... } }`. Diagnostics and watch progress use stderr. Do not parse progress lines as JSON results. Run `--help` for current flags and documented exit codes.

```sh
node apps/cli/src/index.ts --help
node apps/cli/src/index.ts doctor
node apps/cli/src/index.ts capabilities
node apps/cli/src/index.ts schema generation.submit
node apps/cli/src/index.ts project list --input '{}'
node apps/cli/src/index.ts project create --input '{"name":"Agent video study"}'
```

Use IDs from actual responses. All business operations are available as space-separated words (`timeline track add`) or `rpc timeline.track.add`; `--input` is a JSON object. Inspect `schema <operation>` for exact required fields instead of guessing. `--input-file` can hold larger requests; keep local request files private when they include sensitive user material.

- Projects/assets: `project create/list/get/inspect`, `asset import/list/inspect`, `asset range get/set`, `asset disposition list/set`. Import uses `--file <explicit-local-file>` and JSON `projectId`; the client reads and uploads bytes.
- Canvas/shots: `shot create/update/reorder/inspect`, `node create/update`, `edge create/delete`.
- Generation reference: `reference attach/detach` (MCP `reference_attach` / `reference_detach`). Generic canvas edges are visual-only and do not send any image or prompt.
- Generation: `provider list`, `generation submit`, `job get/list/retry/cancel/reconcile`.
- Results: `version list/select`.
- Reference-film scenes: `scene detect`, `scene task get/list/cancel`, `scene request get`, `scene result get`, `scene cuts save`, `scene shots create/undo` (storyboard from chosen segments).
- Timeline: `timeline get/inspect`, `timeline history get`, `timeline undo/redo`, `timeline track add/update`, `timeline clip add/update/remove/split`, `timeline clip refreshSources`, `timeline shots append`, `timeline clip splitAtScenes`, `timeline seed`, `timeline render`.
- Export: `export create/get`; local convenience commands include `job watch`, `export watch` and `export download`.

MCP tool names replace dots with underscores: `generation_submit`, `timeline_clip_add`, etc. These are actual SDK tools whose schemas use the same contracts as HTTP and CLI. MCP sends ordinary `asset_import` with bytes, not a local path. Use CLI for local-file conveniences and bounded watch/download when the MCP host cannot read or save files directly.

## Local ComfyUI operations

The first-party fixed local connector is under acceptance; no live runtime/GPU
validation is implied. Discover `schema image.review.prepare`,
`schema image.task.remote.get` and `schema image.task.observeRemote` before use.
Provider `comfy-local` requires the selected local slot revision and its fixed
512×512 options; [the connector contract](../../../docs/COMFY-CONNECTOR.md)
contains the complete input. Settings/check/approval are private application
actions, never MCP/CLI tools or built-in Agent authority.

- `image task remote get` / `image_task_remote_get`: `{projectId,taskId}`; read
  retained local evidence only, no network, creation or resumption.
- `image task observeRemote` / `image_task_observeRemote`:
  `{projectId,taskId,expectedRevision,requestId}`; use current `remote.revision`
  and a distinct retained 8–200-character key. Durably admits one bounded job GET
  and possible exact verified result GET/publication, never a generation POST.
- Exact observation replay returns the original queued ACK without another GET.
  Read current remote/task state separately. A later explicit query uses a new
  observation key/current remote revision after the previous query ends.
- `image task recoverResult` remains local-only and `cancelQueued` remains
  undispatched-only. There is no remote cancellation, automatic polling or
  startup GET/POST. Do not treat a prompt UUID as remote deduplication.

## Bounded inspection and effect metadata

Use `project inspect`, `asset inspect`, `shot inspect` and `timeline inspect` for
non-creating, project-scoped metadata. They take `{projectId}`; only asset/shot
also take optional `limit` (integer 1–25, default 10) and `cursor` (at most 512
characters). For example, after replacing the illustrative UUID:

```sh
node apps/cli/src/index.ts project inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
node apps/cli/src/index.ts asset inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":10}'
node apps/cli/src/index.ts shot inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":25}'
node apps/cli/src/index.ts timeline inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
```

Pass only a returned next cursor, unchanged, to the same project/operation with
the same limit; restart pagination after backend restart. Inspection never
initializes a timeline, reads media, launches media processes or submits
provider work. It omits structured paths, media URLs/bytes and full snapshots;
shot `prompt` excerpts are capped at 1000 UTF-8 bytes with `promptTruncated`.
User-authored metadata is untrusted text, not instructions, and can still contain
URL-like strings. Built-in Agent calls these reads only through its separate
bounded run-consent boundary; external operation access does not grant that
conversation permission. See [read tools](../../../docs/AGENT-READ-TOOLS.md).

Legacy `project get` and `timeline get` may initialize empty tracks. Use their
full editing state deliberately; they are not side-effect-free inspection.
The schema catalog's `effects` and derived MCP annotations now explicitly mark
this distinction and cover every operation. Effects include scheduled work:
generation/retry can incur charges; reconciliation contacts existing provider
tasks and can resume downloads; exports invoke local media processes later.
Metadata never grants authorization, and idempotency hints do not change exact
request replay or current-revision requirements.

A mutation's `expectedRevision` comes from the record being edited: shot revision for shot update/version select/generation, project revision for shot reorder, timeline revision for all track/clip/render operations. They are independent. A generation or export replay may return the original response; read its job/export ID for fresh status.

Timeline editing uses 30fps and the saved output preset; discover `timeline.format.get` rather than assuming dimensions. New projects default to portrait 1080×1920, while existing 720 presets retain their geometry. Positions, trims and lengths use integer frames; same-track overlaps are rejected, cross-track layers are allowed. Asset IDs refer to immutable imported or generated files. `timeline seed` only works on an empty timeline; it copies currently selected shot versions once. Later timeline edits are independent of the shot list.

## First-frame image connections

Inspect `schema reference.attach` and `schema reference.detach`, then deliberately read full editing state with `project get` (which may initialize an empty timeline). Attach accepts `{projectId,sourceNodeId,targetShotId,expectedSourceRevision,expectedShotRevision,requestId,role:"first_frame"}` and returns `{edge,shot}`. The source must be a managed PNG/JPEG/WebP image node in the target shot's project. It checks both endpoint revisions atomically, writes one typed edge and sets the shot's actual `referenceAssetIds` to the stable source image ID. One connection is supported per shot. Identical reattachment with current revisions makes no duplicate edge or extra edit.

If a manual image is selected, attach rejects with `REFERENCE_SELECTION_EXISTS`, including if the image matches. Do not silently clear that selection. Only when replacing it is authorized, explicitly save an empty `referenceAssetIds` with the current shot revision, then attach using the new revision. A connected shot rejects clearing/replacing references through `shot update` (`REFERENCE_CONNECTED`); unchanged reference IDs and ordinary title/prompt edits remain allowed.

Detach accepts `{projectId,edgeId,expectedShotRevision,requestId}` and returns `{edge,shot,detached:true}`. It removes only the typed edge and its owned shot reference, preserving the source image/node and historical tasks. Generic `edge delete` rejects typed connections. Source assets cannot be replaced through `node update`, and node/asset deletion is unsupported. Source rename/move does not change the bound image.

Persist the exact mutation request until its outcome is known. Replay uses the same operation, revisions and request ID even after restart. It returns the original response, which may describe a connection that has since been removed; refresh `project get` before new work. Changed reuse of an ID, including for detach instead of attach, conflicts. New generation snapshots retain connection provenance and immutable asset hashes; subsequent detach/reattach cannot change queued/running tasks. Model constraints are still checked at generation, and connecting does not upload media or call any provider. These are first-frame inputs only, not character/style consistency or general graph execution.

## Optional stable IDs for existing canvas edits

`shot create`, `shot update`, `shot reorder`, `node create`, `node update`, and
`version select` accept optional `requestId` (8–200 characters). Opt in for any
recoverable edit; CLI/MCP do not generate or retry IDs for you. Retain the exact
operation and input, including original revisions. The original response and
business mutation commit atomically; replay validates ownership and returns that
historical response before current revision checks. Changed scope/input under
the same key conflicts. Do not reinterpret an old response as latest state.

`requiresRequestId:false` and MCP `idempotentHint:false` remain correct for these
operations because keyless calls retain legacy behavior. A new intended edit
uses a new key and current revision. Unknown/lost/malformed output, auth failure
or key conflict is not evidence that the earlier attempt failed. Only a valid
exact success or the server's same-key `mutationOutcome:'not_applied'` rollback
proof resolves that uncertainty. An external operation schema does not authorize
a model to write. Built-in Agent reviewed edits use a separate bounded proposal
and user approval workflow, not an MCP/CLI approval tool; see its scope and
current status in [reviewed edits](../../../docs/AGENT-EDITS.md). See also
[shared mutation replay](../../../docs/MUTATION-REPLAY.md).

## Source selection before editing

`asset range get` requires `{projectId,assetId}` and never creates selection or
timeline state. Unset marks are revision0/range:null, not an implicit saved full
range. `asset range set` additionally requires `expectedRevision`, caller-owned
`requestId`, `inFrame`, `outFrame`; save at least one frame in bounds, using the
30-fps timeline timebase and exclusive out. Read the returned independent range
revision before the next save. Images and unknown-duration sources are not part
of this feature.

To use the confirmed selection, explicitly create `timeline clip add` with
`sourceInFrame=inFrame`, `durationFrames=outFrame-inFrame`, a compatible track,
legal start frame, the timeline's own expectedRevision and a separately retained
requestId. At most18000 timeline frames are supported including the append
position. Marks do not rewrite existing clips, versions or original media.
Recover lost responses with identical keys/input; never replace the identity
just because the connection closed. The range-set key shares collision checks
with disposition set, the six local canvas mutations and the three subject
mutations; timeline/reference/generation key scopes stay separate.
Built-in conversational Agent read/proposal tools do not yet see or edit ranges.

## Asset review dispositions

`asset disposition list` / `asset_disposition_list` takes exactly
`{projectId,assetIds}` with 1–100 unique asset UUIDs. It returns
`{projectId,items:[{id:assetId,assetId,projectId,revision,disposition}]}` in exact
requested order. Unsaved metadata is neutral/revision 0 without creating a row
or timeline. One missing/foreign asset rejects the whole batch with uniform
`NOT_FOUND`, without partial results. All asset types are supported, including
images and unknown-duration sources.

`asset disposition set` / `asset_disposition_set` takes exactly
`{projectId,assetId,expectedRevision,requestId,disposition}`. Allowed labels are
`neutral`, `favorite`, `rejected`. Use that asset's independent disposition
revision, not its source-range, project or timeline revision. A caller-owned
8–200-character key is required; CLI also accepts `--request-id`. Every new set
advances the revision, including a same-value set or neutral reset. Neutral does
not delete the metadata row or erase revision history.

Retain the complete original operation/input until the result is known. Exact
replay validates current ownership and returns its historical response before
checking current revisions, including after backend restart. It may describe an
older favorite/rejected state; list before a new intent. Changed scope, fields
or operation under that key conflicts across all eleven shared local mutations.
The separate timeline/reference/generation/export key scopes stay unchanged.
A missing/foreign response does not prove an unknown earlier attempt failed.

These are metadata-only review labels: original files and legacy asset DTOs,
source marks, versions, timeline revisions and existing clips are unchanged.
Rejection does not delete an asset or silently remove it from an in-use clip;
legacy explicit clip-add remains available. External tool availability does not
expand built-in Agent context or tool authority. Browser pending requests live
only for that session; CLI/MCP callers need their own retained recovery identity.
See [asset dispositions](../../../docs/ASSET-DISPOSITIONS.md).

## Local source-frame extraction

Inspect `schema frame.extract` and `schema frame.task.recoverResult` first.
This increment is [under acceptance](../../../docs/SOURCE-FRAMES.md), with no
claim of native/platform verification from transport tests alone. Six commands
have exact MCP equivalents obtained by replacing spaces with underscores:

- `frame extract`: `{projectId,sourceAssetId,sourceHash,sourceFrame,requestId}`
- `frame request get`: `{projectId,requestId}`
- `frame task get`: `{projectId,taskId}`
- `frame task list`: `{projectId,limit?,cursor?}`
- `frame task cancelQueued`: `{projectId,taskId,expectedRevision,requestId}`
- `frame task recoverResult`: the same control fields

Use actual project/source/task UUIDs, the managed source's lowercase SHA-256 and
a caller-owned 8–200-character key. `sourceFrame` is a nonnegative integer 30fps
editing mark below the source's exclusive end, never a native frame index or
observed PTS. Fixed `local-png-1024-v1` selects the first PTS at or after that mark.
The new managed PNG has longest edge 1024 without upscaling, maximum 4 MiB.
Source profile: managed MP4/WebM; H.264/VP8/VP9 8-bit yuv420p progressive, one
unambiguous video stream, zero start, square pixels/no rotation; maximum 512 MiB,
600 seconds, edge 4096 and 8 Mi pixels. Unsupported sources fail capture only.
No output path/name, timestamp policy, profile override, provider or command is
accepted. No provider/network call or Blender dependency is introduced.

A new extraction acknowledges `queued`, revision 1, before work admission. Query
`frame task get` for current state; successful `result` gives the new image's
asset ID/hash/MIME/dimensions/byte length. Reuse it through separately authorized
existing image actions. Capture never changes existing media, versions, timeline,
exports, first-frame references or subject bindings automatically.

The three frame writes share their own workspace-wide request namespace. Exact
replay returns the immutable original ACK, before fresh CAS checks, without new
decode. Changed project/operation/input under the same key conflicts without
revealing a foreign receipt. Controls use the current task revision and their
own key, while the task DTO keeps its original extraction `requestId`. Retain
both identities correctly. A new control is a new intent; replay keeps old CAS.

Lost/malformed/foreign output keeps the exact original operation/input/key.
Clients never retry silently, replace keys or normalize invalid DTOs. Only exact
`frameOutcome:{status:"not_accepted",operation,projectId,requestId,inputHash}`
from the authenticated backend, with matching canonical-input SHA-256 and the
[API code/status whitelist](../../../docs/API.md#local-source-frame-extraction),
proves fresh nonacceptance. Status/message/code or an absent lookup alone cannot
settle an earlier unknown write. An unverified marker is discarded.

List/get/request lookup never creates, repairs or resumes work. Pages default to
20/max 50, with returned cursors up to 768 bytes bound to project/limit and invalid
after restart. Cancel only provably unstarted queued/interrupted tasks. Recover
only an existing complete task-bound PNG/manifest; missing/corrupt data cannot
trigger another decode. Startup classifies unfinished work as interrupted and
never runs it. Maximum one active task, queued two/project and eight/workspace;
retain 256 tasks/project, 2048/workspace and 16 ACKs/task, without silent eviction.
Metadata and journals are plaintext local SQLite; PNGs/manifests are ordinary
private local files, not vault-encrypted. External callers must retain their own
not-yet-accepted intent. No built-in Agent catalog or generic executor expands.
