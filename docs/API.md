# HTTP API

Base URL defaults to `http://127.0.0.1:4318`. Only loopback Host/Origin accepted. All `/api/*` except login and all `/media/*` require `Authorization: Bearer <local token>` or the HttpOnly SameSite=Strict login cookie. `/health` is public. The token is server-side configuration; do not place it in URLs.

`POST /api/login` body `{"token":"<local token>"}` exchanges the token for a browser cookie.

`POST /api/rpc` body:

```json
{"operation":"project.create","input":{"name":"我的影片"}}
```

Response: `{"ok":true,"data":...}`. Error: `{"ok":false,"error":{"code":"REVISION_CONFLICT","message":"...","details":{"currentRevision":2},"retryable":false}}`. HTTP 400 invalid input, 401 unauthenticated, 403 invalid origin/provider disabled, 404 missing record/operation, 409 stale revision or idempotency conflict. Do not blindly retry a generation with a new key when a response is lost; replay the original exact request.

For business RPC, the runtime schemas in `packages/contracts/src/index.mjs` are authoritative and strict (unknown fields rejected). `docs/CONTRACT.md` lists every operation, input and record. MCP tools expose these same schemas through tools/list.

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

`project.get` additively includes a persistent `timeline`. `timeline.get`
accepts `{projectId}` and lazily creates the same empty default timeline for
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

`provider.list` includes `modelCapabilities`, `status` (`available`, `disabled`, `not_configured`), `configuration.missing`, `configuration.requirements`, `liveVerified` and the local generation-count budget. Provider IDs are `mock`, `runway`, `ark`, `veo`, `minimax`, `vidu`. Configuration values and credentials are never returned. Capabilities can change as local count limits are consumed; re-read before new work.

Zero references means text input; one approved image means first-frame input. Each model controls which mode, MIME types, dimensions, aspect ratios, durations and advanced parameters are accepted. Unsupported inputs fail before creating a job. Seed is not accepted for Ark/Veo/MiniMax/Vidu in this version; inspect each model's `parameters` array.

If an actual downloaded live result differs from the requested ratio by more than 1%, the backend retains the existing task and downloaded file privately, sets `phase=output_review_required` with `OUTPUT_ASPECT_RATIO_MISMATCH`, and publishes no version. Its transport-compatible `status=cancelled` means local publication/waiting is paused, not that the provider failed or was cancelled. Do not submit a replacement or use `job.retry`; inspect/reconcile the same existing task.
