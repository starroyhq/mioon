# HTTP API

Base URL defaults to `http://127.0.0.1:4318`. Only loopback Host/Origin accepted. All `/api/*` except login and all `/media/*` require `Authorization: Bearer <local token>` or the HttpOnly SameSite=Strict login cookie. `/health` is public. The token is server-side configuration; do not place it in URLs.

`POST /api/login` body `{"token":"<local token>"}` exchanges the token for a browser cookie.

`POST /api/rpc` body:

```json
{"operation":"project.create","input":{"name":"我的影片"}}
```

Response: `{"ok":true,"data":...}`. Error: `{"ok":false,"error":{"code":"REVISION_CONFLICT","message":"...","details":{"currentRevision":2},"retryable":false}}`. HTTP 400 invalid input, 401 unauthenticated, 403 invalid origin/provider disabled, 404 missing record/operation, 409 stale revision or idempotency conflict. Do not blindly retry a generation with a new key when a response is lost; replay the original exact request.

For business RPC, the runtime schemas in `packages/contracts/src/index.mjs` are authoritative and strict (unknown fields rejected). `docs/CONTRACT.md` documents full-record and mutation input/record contracts. MCP tools expose these same schemas through tools/list.

### Private last-project locator

Authenticated `GET /api/last-project` and `PUT /api/last-project` share a fixed,
bounded private navigation service. This is renderer-only discovery/storage,
not an RPC/CLI/MCP/Agent operation. Reads are noncreating; writes require the
verified workspace scope, current service instance, original expected revision,
and existing project ID. Exact schemas and capacity/CAS/recovery limits are in
[`last-project.ts`](../packages/contracts/src/last-project.ts) and
[LAST-PROJECT.md](LAST-PROJECT.md). Restored workspaces return unsupported before
accessing the companion file. Reopening a project never grants task execution.

### Private clip-property drafts

The authenticated `/api/local-drafts/clip` GET/PUT/DELETE and
`/api/local-drafts?projectId=…` GET routes share the bounded local-draft service.
These are renderer draft storage, outside RPC/MCP/CLI and the Agent catalog.
They cannot execute timeline edits or model tasks. Exact fields, limits,
workspace/instance binding and CAS are specified in
[`local-drafts.ts`](../packages/contracts/src/local-drafts.ts) and
[the first-slice scope](LOCAL-CLIP-DRAFTS.md). Reads do not create or reset files.
Restored workspaces return an explicit unsupported result without reading or
writing a companion file; their existing local editing remains available.
Unconfirmed writes require read-only reconciliation before any new write.

### Private delivery-name drafts and export intents

The authenticated `/api/local-delivery` boundary is private first-party renderer
storage and fixed-purpose local export recovery. It shares the existing
Host/Origin/authentication gates and returns `Cache-Control: no-store`. It does
not add an RPC, CLI/MCP tool, Agent capability, native bridge or arbitrary
operation executor. The existing public `timeline.render` schema is unchanged.
Implementation is under acceptance; see [scope and pending gates](DELIVERY-DRAFTS.md).

Exact, unknown-field-rejecting schemas are in
[`local-delivery.ts`](../packages/contracts/src/local-delivery.ts). IDs below are
UUIDs except the existing render `requestId`; `workspaceScope` is a backend-derived
SHA-256 scope and `instanceId` is the current service nonce. Each project's draft
and latest intent have separate monotonic CAS revisions.

- `GET /api/local-delivery?projectId=…`: exactly one query key; noncreating,
  read-only discovery. No other route accepts query parameters.
- `PUT /api/local-delivery/draft`: exactly `{workspaceScope,instanceId,projectId,
  expectedDraftRevision,draftId,timelineId,baseRevision,raw:{deliveryName}}`.
- `DELETE /api/local-delivery/draft`: exactly `{workspaceScope,instanceId,
  projectId,expectedDraftRevision,draftId}`. Retains a revision tombstone; a repeated
  DELETE without its deleted identity is a conflict, not a fabricated success.
- `POST /api/local-delivery/prepare`: exactly `{workspaceScope,instanceId,
  projectId,expectedIntentRevision,expectedIntentId,intentId,timelineId,
  baseRevision,draft,input}`. The prior intent ID is null only at revision zero;
  `draft` is null or `{draftId,revision,raw:{deliveryName}}`. `input` is the exact
  canonical `timeline.render` input restricted to `purpose:'export'`, with
  original project/revision/requestId and optional `deliveryName`,
  `exportSettings`, `preflightSnapshotHash`. It preserves optional omission and
  must match the captured name and baseline. Prepare durably reserves the intent
  before any render dispatch; it never executes it.
- `POST /api/local-delivery/execute` and `POST /api/local-delivery/recover`:
  exactly `{workspaceScope,instanceId,projectId,intentId,expectedIntentRevision}`.
  Neither accepts a replacement input, operation nor caller-declared outcome.
  Explicit recovery may first execute a prepared-but-unsubmitted export; when
  an original receipt exists, it returns that receipt without another dispatch.

The raw draft holds only a valid-Unicode name of at most 512 UTF-16 units,
including incomplete/invalid-for-render names. It is not an output-settings
form draft. The immutable intent separately stores the complete original render
input. Empty draft name means omitted render `deliveryName`; actual dispatch
still uses the existing strict business name and closed profile validators.

Successful draft/discovery/prepare data is `{supported:true,workspaceScope,
instanceId,projectId,draftRevision,draft,intentRevision,intent,draftTargetStatus,
intentTargetStatus}`. Target status is independently `unset`, `matching`,
`changed` or `missing`. Each intent contains its ID, timeline/baseline, captured
draft or null, exact input, creation time and outcome. Outcomes are `pending`,
`accepted` with `exportId,responseSha256,resolvedAt`, or `not_applied` with
`code,resolvedAt`. Execution data is `{envelope,response}`; response is the
validated original queued acknowledgement only for accepted outcomes, otherwise
null. Accepted is business acceptance, not completed or decoded media.

Terminal acceptance requires the original hash-checked, ownership-validated
shared receipt. Terminal `not_applied` requires the existing proof validator for
the original input and rechecked receipt absence; generic errors or absent
receipts alone are insufficient. A durable `not_applied` intent never executes
again, even if current timeline/settings later become suitable. New preparation
requires exact terminal intent CAS. Accepted settlement clears only its exactly
captured draft, leaving later drafts intact.

Mount, GET, reconnect, restoring the name and reopening never execute/retry an
intent. Unknown prepare keeps the original request/CAS; an empty read cannot
release it. Explicit reprepare may adopt only a verified same-workspace new
instance nonce, not current draft/business revisions or a new request ID. If
another window changed the draft while preparation remained unconfirmed and no
exact saved intent is found, the original prepare remains a conflict. No automatic
rebase or conflict escape is promised.

Draft writes also pause after failure. An explicit retry of an unknown PUT
retains its exact draft identity, expected revision, original baseline and raw
name; a same-workspace read may update only the service nonce. Empty GET or a
later refusal never settles that earlier unknown write. After confirming the
original PUT, newer current input still requires explicit saving. Local input
validation refuses before sending, so correction followed by explicit saving is
available; confirmed service refusal likewise permits an explicit current-input
retry, without silently replacing a newly discovered candidate or rebasing it.
Read-only reconciliation alone never resumes these writes, and failed DELETE
is not retried as PUT.

Storage is the fixed private plaintext `local-delivery-v1.json`: at most 128
retained project slots, 8192 serialized bytes/slot and 2 MiB/file, independent
logical limits rather than disk quota. Tombstones count and are not evicted.
There are no credential/path/media fields, but user-entered name text and its
captured intent copy remain private user data. Existing backups exclude this
companion. Restored workspaces return exactly
`{supported:false,reason:"RESTORED_WORKSPACE_UNSUPPORTED"}` before touching it;
their existing explicit local export route remains available.

URLs are bounded to 2048 bytes, JSON request bodies to 12 KiB and ordinary data
envelopes to 12 KiB. Original render responses retain their 4 MiB limit; execution
data and the final HTTP success body are separately checked against 4 MiB + 12 KiB.
The renderer also streams and bounds the complete HTTP response: 12 KiB for
ordinary requests and 4 MiB + 12 KiB for execute/recover, with fatal UTF-8 decoding.
Its default whole-transport deadline is 10 seconds for ordinary requests and
35 seconds for execute/recover, including body reads. Timeout only aborts the
transport; it does not cancel backend work or prove nonapplication. Oversized,
malformed and timed-out responses leave the original result unknown.
Unsupported methods return 405; errors expose empty
`details` and `retryable:false`. Fixed codes map validation to 400, owner failure
to 403, missing route/target to 404, CAS/scope/instance conflicts to 409, size to 413,
capacity to 507 and storage/unconfirmed durability to 503. No error response can
supply renderer-authored settlement proof. Corrupt, foreign or unreadable storage
is never silently reset. See the scope document for exact durability and evidence
limits.

`provider.list` additionally returns exact `inputProfiles`, `inputProfileVersion`, `providerRegion`, `profileEvaluationDate` and `inputProfileEvaluations` for the production registry. They are read-only discovery, not request overrides or permission to spend. That original discovery increment left submit/retry schemas and historical replay unchanged; the later explicit subject-video input adds an optional `subjectVersionId` to submit, with historical replay preserved. See [model input limits](GENERATION-INPUT-LIMITS.md).

## Local source-frame extraction

Six strict RPCs share the existing authenticated backend. The authoritative
schemas and non-normalizing response validators are in
`packages/contracts/src/frame-extraction.mjs`. This increment is under acceptance;
see [source-frame scope and release gates](SOURCE-FRAMES.md). No native, live
provider or platform acceptance is implied by API availability.

| Operation | Exact input | Result / effect |
| --- | --- | --- |
| `frame.extract` | `{projectId,sourceAssetId,sourceHash,sourceFrame,requestId}` | Immutable original queued task acknowledgement; accepts one local decode |
| `frame.request.get` | `{projectId,requestId}` | `{projectId,requestId,operation,response}` or `null`; original acknowledgement only |
| `frame.task.get` | `{projectId,taskId}` | Current project-owned task |
| `frame.task.list` | `{projectId,limit?,cursor?}` | `{projectId,items,nextCursor}`; read-only |
| `frame.task.cancelQueued` | `{projectId,taskId,expectedRevision,requestId}` | Original `cancelled_before_start` acknowledgement; only provably unstarted work |
| `frame.task.recoverResult` | `{projectId,taskId,expectedRevision,requestId}` | Original `persisting` acknowledgement; verifies/publishes a complete local checkpoint |

IDs are UUIDs; `sourceHash` is lowercase SHA-256; `sourceFrame` is a nonnegative
integer 30fps editing mark, with the source end exclusive. It is not a native
source-frame index or observed VFR PTS. Profile `local-png-1024-v1` selects the
first presentation timestamp at or after that timepoint, then outputs one PNG
within 1024×1024 without upscaling. It does not promise browser-identical pixels.
The local initial profile permits managed MP4/WebM, one unambiguous H.264/VP8/VP9
8-bit yuv420p progressive stream, known zero start, square pixels and no rotation.
Source limits are 512 MiB, 600 seconds, edge 4096 and 8 Mi pixels; output is at
most 4 MiB. Unsupported capture sources remain usable by existing editor flows.
No path, filename, decoder command, profile override, provider or generic executor
is accepted. It calls no provider or network service and never changes originals,
existing clips, versions, exports, references or subject bindings automatically.

Tasks expose only `id,projectId,requestId,sourceAssetId,sourceHash,sourceFrame,fps,
profileId,state,revision,started,result,errorCode,createdAt,updatedAt`. A successful
`result` contains `assetId,sha256,mimeType,width,height,byteLength`; it names a new
managed image with `extracted-frame` provenance. Other states have `result:null`.
States are `queued`, `running`, `persisting`, `succeeded`,
`cancelled_before_start`, `interrupted`, `local_result_error`, `failed`.
Public DTOs omit bytes, local paths, snapshots and staged manifests. A task/ACK
response is bounded to 4 KiB. Pages default to 20/max 50, with cursors bounded to
768 bytes; use only a returned cursor unchanged with the same project and limit.
Cursors expire at backend restart; pages are not a frozen snapshot.

The three writes require caller-owned 8–200-character request IDs in a separate
workspace-wide frame namespace. Changed operation/input/project reuse conflicts
without disclosing another project's receipt. Exact replay returns the historical
original acknowledgement before current task revision checks, never another
extraction. Control ACKs retain the task's initial extraction `requestId`; their
own keys belong to their separate request receipts. Read current state before a
new control intent, and use its task revision (not a project/timeline revision).

Lost, malformed or mismatched success responses remain uncertain. First-party
clients keep the original operation/key in recovery guidance, never generate a
replacement key, retry automatically or normalize an invalid DTO. Preserve the
complete original input yourself. An authenticated backend refusal can resolve
nonacceptance only through exact `details.frameOutcome`:
`{status:"not_accepted",operation,projectId,requestId,inputHash}`. `inputHash` is
lowercase SHA-256 of shared `canonicalFrameInput(input)` for that exact operation.
Clients require HTTP 507 with `FRAME_CAPACITY`, or HTTP 409 with
`FRAME_QUEUE_FULL`, `FRAME_REVISION_CONFLICT`, `FRAME_STATE_CONFLICT`,
`FRAME_SOURCE_INVALID`, `FRAME_SOURCE_CHANGED` or `FRAME_RESULT_INVALID`.
Every identity field and the proof's exact shape must match. Any other status,
code, message, missing receipt or unverified marker cannot settle a previous
unknown write; unverified frame proofs are discarded. A proven fresh refusal
has `submissionMayHaveSucceeded:false`; an unknown frame write retains `true`.
Reads carrying a request ID never imply a submission.

Only explicit new extraction may decode. Restart classifies unfinished tasks as
interrupted; reads, replay and opening a panel never resume them. Explicit
`recoverResult` may publish the same verified staged PNG/manifest; missing or
corrupt checkpoints never trigger another decode. Running work cannot be
cancelled as unstarted. One local task is active, with at most two queued per
project/eight per workspace; retention is 256 tasks/project, 2048/workspace and
16 immutable ACKs/task, without silent eviction. Task metadata and request
journals use plaintext local SQLite; PNGs/manifests are local managed files,
not vault-encrypted. No built-in Agent tool/catalog or generic recovery allowlist
is expanded by these six external operations.

## Local image generation and review preparation
### Single-PNG reference edits

The same `image.generate` accepts paired `purpose:"edit"` and
`inputImage:{assetId,sha256}` for Mock and the fixed official OpenAI slot. The
backend validates one project-owned managed PNG (8 MiB, maximum 1024 per edge,
opaque 8-bit RGB/RGBA) and derives immutable source provenance. Omit both fields
for the existing text-generation shape. Custom-compatible/Comfy editing, masks
and identity/pixel guarantees are outside this profile. Mock remains a static
test card. Official edits require the existing private user review; preparation
also performs bounded local source-byte validation. Keep the exact request key
through uncertain outcomes. See [single-PNG editing](IMAGE-EDITING.md) for the
strict source/output contract, disclosure and current verification status.



The same RPC exposes `image.profile.list`, `image.generate`, `image.request.get`,
`image.task.get/list`, `image.group.get/list`, `image.version.list`,
`image.task.cancelQueued`, `image.task.recoverResult`, the two local-ComfyUI
remote operations below, and exactly three review operations. Image schemas and bounded DTOs are authoritative in
`packages/contracts/src/images.mjs`, `image-reviews.mjs` and `comfy-images.mjs`.
[Image generation](IMAGE-GENERATION.md) includes the exact generation request.

Mock produces a deterministic local 1024×1024 PNG test card, not prompt-conditioned
imagery. The fixed OpenAI activation checkpoint `4e66a96` (2026-10-10) passed its
461-test affected gate, builds, Linux synthetic-network native acceptance and
full suite (2758 total, 2756 passed, 0 failed, 2 skipped). The current
[custom Images increment](IMAGE-COMPATIBLE.md) is implemented with its
own passed focused/build/Linux synthetic-native gates and independent full suite
(2857 total, 2855 passed, 0 failed, 2 skipped). Neither checkpoint establishes real-provider or macOS/Windows
acceptance. Official OpenAI retains its fixed destination/model/options. The
custom slot adds `providerId:"openai-compatible"` and its configured model to
the same generation request shape; endpoint/credential/approval overrides are
not public inputs. Agent/video credentials cannot activate Images. Discovery
reports local availability with `offline-tested-not-live` evidence, not live
compatibility or permission to spend.

`image.profile.list` accepts `{}` (unchanged legacy response) or
`{"includeSettingsRevision":true}`. The latter may add `settingsRevision`, a
positive safe integer, to an existing official/custom/local-ComfyUI profile.
It comes from the same safe snapshot as that slot's displayed metadata. Mock,
missing/zero/invalid/unreadable revisions never get an invented value; incomplete
custom/Comfy configurations remain omitted as before. `false` behaves like omission.
No endpoint, key, secret storage data or settings object is returned. The read
neither decrypts nor probes, prepares, approves or dispatches. A revision is a
freshness value, not permission; unavailable profiles remain unavailable.
Use the selected provider's returned revision for a new review, and let existing
CAS reject later changes. Do not replace a retained intent's revision or request
key automatically. See [profile discovery](IMAGE-PROFILE-DISCOVERY.md).

| Review RPC | Strict input | Result / effect |
| --- | --- | --- |
| `image.review.prepare` | `{input:<complete official/custom/local-ComfyUI image.generate input>,settingsRevision}` | Retained exact request/configuration review; local database write and bounded PNG validation for edits |
| `image.review.get` | `{projectId,reviewId}` | Existing owned review; read-only |
| `image.review.list` | `{projectId,limit?,cursor?}` | `{projectId,items,nextCursor}`; read-only |

`settingsRevision` is a positive safe integer. The stable generation `requestId`
is nested in `input`; no extra top-level key, secret, approval flag or endpoint
is accepted. Preparing never approves or dispatches. Exact preparation repeats
return the same identity with its retained current state; changed input/project/
settings revision under its key conflicts. Review fields, state transitions,
plain-local-SQLite storage and limits are specified in
[Images activation](IMAGE-ACTIVATION.md#shared-public-review-operations).

New direct official/custom/local-ComfyUI `image.generate` calls remain blocked without private
review approval. `image.generate` effect metadata nevertheless includes possible
separately approved worker activity: external I/O, paid generation, open-world
access and database/file writes, without local subprocesses. Review preparation
writes local records and, for edits, validates the selected local PNG; reads never dispatch. A local RPC POST used for reads
is not a provider POST. No metadata grants paid Agent authority.

The original three image mutations require an exact stable request ID.
`image.generate` returns its original queued task receipt; query `image.task.get`
for current state. After lost acknowledgement use `image.request.get` in the same
project or replay the exact original input. Do not automatically reapprove or
re-key unknown work. New group versions need both `groupId` and `expectedRevision`;
generated assets never automatically alter a timeline, subject or first-frame
reference. The image request namespace is separate from older mutation journals.
Image/review pages default to 20 records (maximum 50); public DTOs omit result
bytes, secrets and filesystem paths. Review intents are bounded at 32 KiB, rows
at 64 KiB, retained reviews at 1000/project and 10,000/workspace, with no cleanup.
The nested generation input retains its original 24-KiB bound.

### Private Images application routes

Authenticated `GET`/`PUT /api/images/settings` manages the dedicated fixed preset
and redacted secret metadata. It is not an RPC/CLI/MCP/model-tool setting. Web
credentials are session-only for the backend lifetime; Electron persistent
storage uses a narrow main-process OS codec, never renderer/preload decryption
or plaintext fallback. Saving settings neither generates nor approves a request.
The exact official secret-write/read contract is in
[Images activation](IMAGE-ACTIVATION.md#private-authenticated-http-settings-contract).
The separate authenticated `GET`/`PUT /api/images/custom-settings` uses the same
strict `{expectedRevision,configuration,secret}` update and redacted result
shape. Its configuration adds `connectionId:"custom"`, uses provider
`openai-compatible`, profile `openai-images-json-png-v1`, a canonical public-DNS
HTTPS base URL and a bounded ASCII model. See [custom settings](IMAGE-COMPATIBLE.md#exact-private-settings-contract)
for exact fields and constraints. Saving validates syntax without probing.
Changing a keyed base URL/model requires explicit removal or a newly entered key;
the official slot stays untouched. Custom review DTOs additionally retain full
immutable `configuration` and actual `destination`; official v1 DTOs stay intact.

Authenticated `POST /api/images/reviews/approve` and `/reject` each take exactly
`{projectId,reviewId,expectedRevision}`. Approval returns the original queued
image-task receipt; rejection returns the retained review. These private UI
routes are absent from RPC, CLI, MCP and model-tool discovery. Local token/session
authentication is not cryptographic human-presence proof or permission for an
external agent to approve. The user explicitly approves the visible exact
prompt/project/model/options/destination and at most one POST. Official/custom
Images have unknown usage-based cost; local ComfyUI has unknown local compute cost. This is not a currency spending cap or a per-image budget wizard.

The dispatch gateway checks changed settings and pending saves synchronously at
the same final boundary as the durable review/task dispatch fence and network
`end()`. No automatic retry follows unknown outcomes or restart; result recovery
only validates and publishes an existing task-bound local receipt and staged PNG.
See [Images activation](IMAGE-ACTIVATION.md) for the authority, persistence,
network boundary, and [custom Images](IMAGE-COMPATIBLE.md) for schema 18 and the
current validation results and remaining live/native-platform limits.

### First-party local ComfyUI increment (synthetic validation)

`comfy-local` adds a separate fixed `comfy-t2i-png-v1` text-to-image profile for
ComfyUI `0.39.0`: seven nodes/six standard classes, exactly one 512×512 PNG.
It requires a user-selected installed checkpoint, explicit connection check and
per-request application review. Opening/saving settings does not probe. No
runtime/model installation, image upload, arbitrary workflow, public endpoint,
remote cancellation or real-runtime acceptance is included.

`GET`/`PUT /api/images/comfy-settings` reads/saves the independent no-secret
configuration; PUT is exactly `{expectedRevision,configuration}`.
`POST /api/images/comfy-check` takes `{baseUrl,model?}` and explicitly performs
bounded GETs for version/nodes/checkpoints. Its successful evidence is RAM-only.
Only root HTTP origins with literal `127.0.0.1` or `[::1]` and an explicit port
are accepted, excluding Mioon's actual backend port. These private application
routes are not RPC/CLI/MCP/Agent tools. Local runtime trust remains the user's;
loopback and reported node/version names prove neither safety nor offline/free
execution.

The v3 review freezes full configuration, destination, graph/hash, seed,
prompt/client UUIDs and output nonce. User approval permits at most one POST;
prompt UUID reuse does not provide ComfyUI idempotency. No automatic retry or
runtime polling follows submission or startup.

| Shared operation | Strict input | Effect |
| --- | --- | --- |
| `image.task.remote.get` | `{projectId,taskId}` | Local read of retained `{projectId,taskId,remote,observation}`; never contacts runtime |
| `image.task.observeRemote` | `{projectId,taskId,expectedRevision,requestId}` | Durable explicit observation, then bounded job GET and at most one verified result GET |

Observation `expectedRevision` is the current `remote.revision`; use a distinct
stable 8–200-character request key. Exact replay returns the original queued
acknowledgement without another GET. Read the two task records for current state;
observation `finished` is not proof of successful generation. New explicit queries
use a new observation key and current remote revision. No operation permits
another generation POST or joins the built-in Agent allowlist. Old
`image.task.recoverResult` remains local-only. Terminal graph/client/nonce/status
checks and immutable descriptor/hash/byte pinning precede result staging.

Schema 19 adds remote runs/observations and v3 reviews while preserving legacy
rows/rowids/inputs/receipts and SQL objects, except the documented narrow
ComfyUI-verified `outcome_unknown` → `failed` lifecycle trigger branch. Observation
retention is 1000/project and 10,000/workspace, without eviction. This increment's
focused/build/Linux native synthetic checks and independent full suite passed
(2993 total /2991 pass /0 fail /2 skip); its first aggregate failures are retained. No real runtime, GPU
or model has been used. Exact contracts, bounded effects, migration and remaining
gates: [local ComfyUI connector](COMFY-CONNECTOR.md).

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
| `timeline.render` | `purpose:'preview'|'export'`, optional `preflightSnapshotHash` (lowercase SHA-256), optional export-only `exportSettings` (closed MP4/H.264 profile), optional export-only `deliveryName` |

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

Times are integer frames at 30fps. Output defaults to 720×1280; pristine timelines can explicitly select 1280×720 or 720×720 (see [format rules](TIMELINE-OUTPUT-FORMATS.md)); maximum 12 tracks,
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
`chat_and_reviewed_timeline_edits` when the timeline reviewed-edit service is available
(with legacy shot-only/inspection scopes retained for those injected services). Its `inspection` capability retains
availability, schema version, catalog hash and the fixed
two-model-request/one-read/8-KiB limits. The separate `edit` capability publishes
the selected-shot schema/catalog and text/round limits described below. A separate
`timelineEdit` capability describes the selected-clip move catalog and limits.
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

## Reviewed Agent selected-clip moves

The separate `selected_timeline_clip_move` mode pins one saved clip and its
timeline revision. Its only proposed patch is `{startFrame}` to the existing
`timeline.clip.update` operation, after explicit human diff approval. Same-track
non-overlap, source/duration/audio/geometry preservation and existing CAS/history
apply. Proposal/recovery routes retain their existing authenticated shapes; no
new public mutation or model approval endpoint is added. Full consent fields,
bounded context, discriminated schema24 and historical receipt semantics:
[reviewed timeline moves](AGENT-TIMELINE-MOVE.md).

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
shares collision protection with `asset.range.set`, the original six local
mutations and the three subject writes: eleven local operations in total. Exact historical replay precedes current revision checks, after
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

`timeline.export.preflight` accepts `{projectId,expectedRevision}` with optional
strict `exportSettings` for an export-specific frozen snapshot:
`projectId` is a UUID and `expectedRevision` is a positive integer for the
existing timeline. It is a read operation, separate from export submission.
It does not initialize a missing timeline, write SQLite/cache/files, create an
export, fully decode media, call providers, or incur generation charges. It
reads managed source bytes, hashes them incrementally, and runs bounded local
`ffprobe` metadata checks. Supported timeline output is one of the three [closed 30fps preset pairs](TIMELINE-OUTPUT-FORMATS.md).

```json
{"operation":"timeline.export.preflight","input":{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":4}}
```

The strict public response contains only:

- `projectId`, the requested `expectedRevision`, ISO `checkedAt`
- `timelineId` (UUID or null), `timelineRevision` (positive integer or null)
- `snapshotHash` (lowercase 64-character SHA-256 or null; includes delivery settings when supplied)
- `status`: `ready`, `blocked`, `incomplete`, or `stale`
- `summary` (null or the bounded counts below; optional frozen `delivery` when requested)
- `checks:{totalAssets,checkedAssets,bytesHashed,fullDecode:false,subtitles?}`;
  only nonempty captions can add `subtitles:{profileId:"bottom_cjk_v1",fontVerified,inkMeasured:false}`.
  `bytesHashed` counts managed-media bytes, excluding the separately fixed font read.
- `issues`: at most 128 `{code,severity,message,assetId?,clipId?}` entries;
  codes are 1–64 uppercase letters/digits/underscores beginning with a letter,
  severity is `error` or `warning`, and messages are at most 240 characters.
  Optional asset/clip IDs are UUIDs. No source filenames, paths, URLs, raw probe
  diagnostics, commands, credentials, or media bytes are included.

A non-null summary is
`{fps:30,width,height,durationFrames,trackCount,clipCount,assetCount,visualClipCount,audibleClipCount,mutedTrackCount,hiddenVideoTrackCount}`, with width/height bound to one supported timeline preset pair.
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

### Durable UI edit tasks (nineteen explicit operations)

The authenticated `/api/tasks` route family has an explicit nineteen-operation
allowlist: fourteen timeline metadata edits (all timeline mutations except
`timeline.render`), `reference.attach` / `reference.detach`, and the three subject
writes listed below. The sixteenth entry is `timeline.format.set`, with its own pristine-state and dual-revision gates; three `timeline.subtitle.*` writes append to the same timeline lane. The subject extension is implemented; focused checks, builds
and Linux native acceptance passed, with the independent full release gate passed.
See [its current gate](SUBJECT-LIBRARY.md). It is a UI recovery control plane, not
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

The original eight local canvas/asset edits, rendering and generation retain their
existing UI recovery/storage paths. The subject writes use the separate `subject:mutation` lane; format and subtitle edits use `timeline:mutation`. External callers still use
their existing operation and original key directly; this route family does not upgrade their request
persistence automatically. No task input contains credentials or media bytes;
local task parameters are ordinary SQLite data, not vault-encrypted.

## Local versioned subject library

Status: implemented; focused checks, final web/desktop builds and Linux native
acceptance passed. The independent full-suite release gate passed.
These strict shared contracts are specified in
[SUBJECT-LIBRARY.md](SUBJECT-LIBRARY.md) and
`packages/contracts/src/subjects.mjs`. They add local planning metadata only.

| Operation | Strict RPC input |
| --- | --- |
| `subject.create` | `{projectId,kind,name,assetId,requestId}` |
| `subject.version.add` | `{projectId,subjectId,expectedRevision,assetId,requestId}` |
| `subject.binding.set` | `{projectId,shotId,subjectId,role,subjectVersionId,expectedRevision,expectedSubjectRevision,requestId}` |
| `subject.list` | `{projectId,limit?,cursor?}` |
| `subject.version.list` | `{projectId,subjectId,limit?,cursor?}` |
| `subject.binding.list` | `{projectId,shotId?,subjectId?,limit?,cursor?}` with exactly one filter |

Record IDs are UUIDs. `kind` is `character|product|location|look`; name is
nonblank, 1–120 characters. Every version fixes one existing owned managed
PNG/JPEG/WebP asset, without imports, byte copies or caller-supplied provenance.
All three writes require an 8–200-character stable `requestId`. Version-add
checks the positive subject revision; same-head asset rejects without a write.
Binding-set checks its independent revision (0 only if never created) plus the
positive current `expectedSubjectRevision`. `role` is `style` for `look`,
`subject` for other kinds. At most eight active bindings are allowed per shot.

`subjectVersionId` is required and nullable: a UUID pins that exact owned subject
version, and `null` clears while retaining a revisioned tombstone. Every fresh
set saves the current head as `reviewedHeadVersionId`. `needsReview` is derived
from active selection plus a changed head, not selected-version inequality.
Explicitly adopting latest or keeping the old selected version while acknowledging
the latest head both clear that review flag; no choice propagates automatically.

Create/version-add return a subject with
`id,projectId,kind,name,revision,headVersionId,headVersion,createdAt,updatedAt`.
The frozen `headVersion` (also a version-list item) contains
`id,projectId,subjectId,number,assetId,sha256,mimeType,width,height,provenance,createdAt`.
Backend-derived `provenance` has `kind` and nullable local
`versionId,shotId,jobId`, never provider task IDs, paths or URLs. The frozen
`sha256` comes from the existing asset record; subject operations do not read,
rehash or probe media bytes.
Binding-set/list return
`id,projectId,shotId,subjectId,role,revision,subjectVersionId,reviewedHeadVersionId,headVersionId,subjectRevision,needsReview,createdAt,updatedAt`.
Lists return `{projectId,items,nextCursor}`; page size defaults to 20, maximum 50,
cursor maximum 768 characters. Binding-list includes cleared rows. Cursors bind
operation/project/filter/limit and expire after backend restart. Pages are not
a cross-request frozen snapshot. All lists are non-creating metadata reads.

Subject receipts atomically join the existing eight-operation local mutation key
namespace as operations nine through eleven; timeline/reference/generation/export
namespaces remain separate. Exact replay returns the original validated response
before new revision checks, after current ownership checks. Keep full input/key
after uncertain or malformed replies and refresh current state after replay.
Only matching operation/project/request `not_applied` rollback proof resolves a
fresh rejected intent; no generic 4xx or automatic retry does. Subject input and
receipt caps are 8 KiB and 16 KiB respectively.

The three writes also enter the UI's explicit durable allowlist under
`subject:mutation`, with prepare-before-dispatch and restart discovery but no
automatic execution. Task limits remain 8 KiB input, 16 KiB reserved per row,
4,096 identities and 64 MiB logical total; capacity refuses before dispatch and
no unresolved identity is silently evicted. Schema 15 adds subject tables and
transactionally rebuilds `edit_tasks` while preserving old bytes/sequence/guards;
eight independent schema-preservation cases, focused checks, final builds and
Linux native acceptance passed. The independent full release gate passed.
Local SQLite metadata is not
vault-encrypted and must contain no secrets.

No shot revision, first-frame reference, timeline, frozen generation snapshot,
provider input, built-in Agent catalog/context or paid generation changes.
`reference.attach` remains the separate actual `first_frame` path. The later
[saved first/last frames](VIDEO-FRAME-PAIRS.md) and
[explicit subject-version input](SUBJECT-VIDEO-INPUTS.md) are separate generation
choices; they do not automatically consume planning bindings. Motion remains
future work. See [subject scope and recovery](SUBJECT-LIBRARY.md).


## Timeline output presets (schema 21)

`timeline.format.get` is noncreating and returns the current project/timeline revision fences, saved/effective preset and bounded eligibility reasons. `timeline.format.set` requires `projectId`, `expectedProjectRevision`, `expectedRevision` (0 means no timeline), a stable `requestId`, and one of `portrait_720`, `landscape_720`, `square_720`. Output is respectively 720×1280, 1280×720 or 720×720, always 30 fps. The setter returns the exact full timeline acknowledgement; historical replay precedes fresh CAS checks. Existing same-preset new-key requests reject without a successful mutation.

This changes only timeline preview/export. Legacy storyboard output stays 9:16. Nonempty timelines, any undo/redo history, non-format receipts, timeline exports or another pending timeline edit block reconfiguration; no geometry migration or history deletion occurs. The format operation uses the existing timeline request namespace and is the sixteenth explicit durable UI edit, outside clip undo/redo. The original fifteen entries keep their order and semantics. Public transport access adds no built-in Agent tool or automatic execution authority.

Use the returned revisions, keep the exact input/key after ambiguity, and recover explicitly. Do not issue a new request merely because an acknowledgement was lost. Read/get/list and restart never apply a prepared intent. See [full scope, recovery and acceptance](TIMELINE-OUTPUT-FORMATS.md).

## Manual timeline subtitles

Three shared, strict writes use the existing timeline journal and CAS:
- `timeline.subtitle.add`: `{projectId,expectedRevision,requestId,text,startFrame,durationFrames}`.
- `timeline.subtitle.update`: `{projectId,expectedRevision,requestId,cueId,patch}`; the nonempty patch contains only text/startFrame/durationFrames.
- `timeline.subtitle.remove`: `{projectId,expectedRevision,requestId,cueId}`.

CLI discovery/commands are `timeline subtitle add|update|remove`; MCP names are
`timeline_subtitle_add`, `timeline_subtitle_update`, `timeline_subtitle_remove`.
Use live schema discovery, retain exact input/key on unknown outcomes, and never
automatically retry under a new key. Each successful write returns the complete
saved timeline. IDs and the fixed `bottom_cjk_v1` profile are backend-owned.
Full subtitle state is available through `timeline.get` or `project.get`;
`timeline.inspect` deliberately omits subtitle cues from its bounded DTO. No new
built-in Agent tool or automatic project-context category is added.

Intervals use integer 30 fps frames with exclusive ends, within existing media
duration. Cues cannot overlap (adjacency is legal); maximum100 cues,1–2 lines,
20 Unicode scalars per line,161 UTF-8 bytes. Only printable ASCII, the pinned
font's supported Han U+4E00–9FEF and an explicit Chinese punctuation set are
accepted. Unsupported characters identify line/column and code point. Literal
text is preserved; there is no ASR, SRT import, automatic wrapping or style menu.

The fixed font/profile burns into timeline rendered preview/export, not dry
source playback or the legacy storyboard export. Saving media edits that strand
existing cues fails atomically; shorten/remove cues explicitly first. History and
recovery preserve optional field absence and original receipt bytes. Frozen
exports retain their accepted subtitle text/font hash. Preflight can verify the
font resource but does not measure glyph ink; actual render performs bounded
measurement and can reject overflow. See [scope and acceptance](MANUAL-SUBTITLES.md).

## Timeline delivery profile and local encoder capability

Optional export-only `timeline.render.exportSettings` and optional
`timeline.export.preflight.exportSettings` use the closed `mp4_h264_v1` profile.
`timeline.export.capabilities` accepts exactly
`{projectId,expectedRevision,exportSettings}` and performs an explicit bounded
local synthetic encode. It creates no timeline/export and writes no DB/cache or
files. Its read-only/localProcess effect is distinct from media preflight.
Read [EXPORT-SETTINGS.md](EXPORT-SETTINGS.md) for all settings, caps, safe report
statuses, exact frozen delivery fields, cancellation and replay semantics.
Omitted settings preserve legacy requests/receipts; preview rejects settings.

## Saved first/last-frame video selection

See [VIDEO-FRAME-PAIRS.md](VIDEO-FRAME-PAIRS.md) for implementation/acceptance status and exact provider scope.
`shot.create` and `shot.update.patch` accept optional `lastFrameAssetId: UUID | null`.
An omitted property keeps legacy shape (and means no change in an update); `null`
explicitly clears it. Non-null values must identify a same-project managed image.
The existing `referenceAssetIds` array and `reference.attach` / `reference.detach`
remain first-frame-only. Detaching a first frame does not erase the saved tail.
Saving a tail-only draft is allowed, but generation requires one distinct first
image. Only current Ark Seedance 2.5 and Mock profiles accept this paired mode;
subject/style bindings are not sent. Other adapters reject the complete unsupported
selection rather than dropping the tail. For this saved-frame mode, shot revision
pins the saved choices; each accepted job freezes both
roles, identities, hashes and metadata. Old job retry uses only its old snapshot.

Use the existing stable shot mutation request key and `expectedRevision`. Exact
replay returns its original shot response. No new operation, migration, edit-task
namespace or built-in Agent write privilege is added. Manual shot-edit pending
receipt recovery remains session-scoped; this does not add a cross-restart pending
edit ledger or undo/history for shot fields. Successful saved choices persist.

## Explicit one-version subject-image video input

`generation.submit` additionally accepts optional `subjectVersionId: UUID` for
one immutable same-project `character`, `product` or `location` image version.
It is a per-submit choice, not a shot patch. Omission preserves the legacy path;
null, arrays and caller-supplied asset/hash metadata reject. Planning subject/style
bindings never automatically enter the request. Any saved first/last image or
first-frame connection conflicts; clearing it requires a separate explicit save.

Only current Ark Seedance 2.5 and Mock v3 profiles support this role. The server
freezes complete `snapshot.subjectReference` plus the exact one-image manifest.
Same-key changed version conflicts; failed-job retry keeps its old version, even
after head advances. Malformed acknowledgements do not settle new subject pending
requests. The renderer's full reviewed pin is session storage, not a new durable
intent ledger. No operation, migration or Agent authority is added. See
[SUBJECT-VIDEO-INPUTS.md](SUBJECT-VIDEO-INPUTS.md) for implementation status, exact
wire mapping, real-face restrictions, immutable provenance and acceptance.

## Offline workspace backup readiness

`workspace.backup.inspect` accepts only `{}` and returns bounded workspace-wide
DB counts with `captureReady:false`, `reason:"BACKEND_RUNNING"`, nullable unknown
counts and fixed capacity limits. It requires the existing local authentication.
It reads no media, paths or credentials and creates no task, directory, receipt,
or project. A completed count inspection is not file validation or a cold backup.
The built-in Agent tool allowlist is unchanged.

Actual create/verify are explicit offline local CLI actions backed by shared Node
business services. No HTTP RPC accepts backup paths or grants restore authority.
See [scope and safeguards](WORKSPACE-BACKUP.md) and the
[offline user guide](WORKSPACE-BACKUP-GUIDE.zh-CN.md).


## Restored workspace profile

`workspace.restore.inspect` accepts exactly `{}` under normal local authentication.
An ordinary workspace returns exactly `{restored:false}`. A restored workspace
returns fixed `restored-local-v1` schema25 identity, source backup/hash binding,
creation time, bounded held counts and explicit operation availability. It returns
no filesystem paths, prompts, credentials or generic execution capability.
Built-in Agent tools stay unchanged.

For explicitly fresh allowed effects on a restored branch, the RPC outer body
adds `expectedWorkspaceOrigin: UUID` alongside `operation` and `input`. It is not
a domain field, request hash change, bearer credential or permission to resume
captured work. Missing/mismatched origin refuses; old valid receipt reads remain
exact and cannot enqueue work. Special edit-task/preference routes enforce the
same backend profile. Captured identities, even terminal ones, are held.

Local metadata/timeline editing and fresh local export share existing validators,
CAS, history and request journals. New generation/Agent/Comfy/frame/waveform
execution is unavailable. Fixed saved history/media readers do not construct
recovery runtimes. `RESTORED_RECORD_HELD` and `RESTORE_*` refusals are not proof that
an earlier unknown write failed. Never discard its original key on that basis.

Restore and status discovery are explicit offline Node/CLI actions only. No
HTTP endpoint receives restore filesystem paths. See [WORKSPACE-RESTORE.md](WORKSPACE-RESTORE.md)
for fixed schema gates, limits, recursive-backup restriction and current evidence.


## Named timeline deliveries

`timeline.render` with `purpose:'export'` and `timeline.export.preflight` accept optional `deliveryName`: exact nonblank1–120 UTF-16 units, valid Unicode without control/line characters. Omission remains absent in historical requests and receipts. The preflight digest and original render key bind the name together with the frozen timeline/settings; changed or removed names cannot reuse that key. The encoding-capability request does not accept a name. `export.get` returns the immutable `snapshot.deliveryName` when supplied.

Named download links bind `/media/{assetId}?download=1&exportId={exportId}`. The authenticated server validates the historical export/output/receipt and derives a safe attachment filename; callers cannot supply a destination path or trusted filename. Existing unnamed/storyboard behavior remains. See [scope, safety and acceptance](NAMED-DELIVERIES.md).
