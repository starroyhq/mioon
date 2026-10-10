# Shared contract v1 (2026-10-09)

Shared public business operations go through `services.call(operation, input)`, used by authenticated HTTP `POST /api/rpc` and official SDK MCP stdio and CLI shared client. UI business calls use that API; private authenticated settings and user-approval routes remain outside the public operation catalog. JSON response `{ok:true,data}` or `{ok:false,error:{code,message,details}}`; conflict HTTP 409, validation 400, not found 404. Dates ISO UTC. IDs opaque UUID. Revisions integers starting at 1. All updates require expectedRevision. SQLite transactions, WAL, foreign keys and busy timeout. Project `revision` protects project-wide shot ordering; each shot/node has its own revision. Position never defines sequence.

## Image task/version contract

The original ten image operations are defined in
`packages/contracts/src/images.mjs`; the additive activation contract adds only
`image.review.prepare/get/list` in `image-reviews.mjs`. See
[Image generation](IMAGE-GENERATION.md) for task/version DTOs and limits, and
[Images activation](IMAGE-ACTIVATION.md) for exact reviews, settings and approval.
The accepted first slice at baseline `82c70f3` enabled only Mock. Fixed-preset
OpenAI activation at `4e66a96` (2026-10-10) passed its affected/build/Linux synthetic
native checks and full suite (2758 total, 2756 passed, 0 failed, 2 skipped).
The [custom Images increment](IMAGE-COMPATIBLE.md) is implemented; its
final gate is pending. Earlier results do not establish this increment's gate,
live-provider or macOS/Windows acceptance. The generation request/receipt shapes
are retained with additive provider `openai-compatible` and configured ASCII model
values. Existing Agent/video keys never activate Images; new direct official or
custom RPC remains blocked without private review approval.

Review preparation takes exactly `{input:<complete official/custom generation request>,
settingsRevision}` and writes a retained immutable intent locally, without
approval, task creation or provider work. Get takes `{projectId,reviewId}`; list
takes `{projectId,limit?,cursor?}` and returns `{projectId,items,nextCursor}`,
default 20/max 50. The generation request's stable key stays nested in `input`.
Settings and approval/rejection routes are absent from CLI/MCP/model tools;
local authentication is not cryptographic human-presence proof or paid authority.
Approval binds the visible exact request and current configuration to at most
one POST, at usage-based unknown cost rather than an enforced currency cap.

Schema 17 added only the review table/index/triggers. Schema 18 rebuilds only
`image_reviews` for official v1/custom v2 intents, copying/checking raw rowids,
all 16 columns, historical states and retained index/trigger SQL. Other tables,
receipts and serialized history stay untouched. Custom backend-created intents
and DTOs retain complete immutable configuration plus actual destination;
official v1 intent/DTO shapes and bytes remain intact. Task snapshot v1 stays
content-only: full custom execution provenance is the validated retained
task-linked review, never current settings. The immutable review intent cap is 32 KiB,
review-row cap 64 KiB, retained reviews 1000/project and 10,000/workspace, without
cleanup. The nested generation input retains its original 24-KiB bound. Review
requests and prompts remain plaintext local SQLite. `image.generate` effects now
include possible approved external/paid worker activity; review preparation is
local-database-only and review get/list are read-only.

`image.generate` returns an immutable original queued-task receipt, while
`image.task.get` reads the current task. `image.request.get` reads the saved
receipt by project and stable request ID. Generate/cancelQueued/recoverResult
share an image-only exact-request journal; no global cross-journal deduplication
is claimed. `groupId` and positive `expectedRevision` must be supplied together
for a new version, or both omitted for a new group. All three mutations require
request IDs of 8–200 characters. Result versions and their managed assets are
immutable; creating one never edits a timeline, subject, reference or video job.

Profiles/read/list/request lookup cannot infer or publish media. Startup
interrupts undispatched queued work and marks dispatched work without durable
output as unknown. Queued cancellation requires a false dispatch fence;
explicit result recovery is restricted to already-staged local bytes. Public
image DTOs omit bytes/base64, paths and credentials, but include the saved
prompt for authorized local readers. Prompt text is retained in local SQLite.

## Operations and input
- project.create `{name,description?}` → project
- project.list `{}` → project[]
- project.get `{projectId}` → `{project,assets,shots,nodes,edges,jobs,versions,exports}`
- asset.import `{projectId,name,mimeType,dataBase64}` → asset. Backend validates bytes and stores a managed filename; no arbitrary local paths or URLs.
- asset.list `{projectId}` → asset[]
- asset.disposition.list `{projectId,assetIds}` → `{projectId,items:[{id:assetId,assetId,projectId,revision,disposition}]}`; 1–100 unique UUIDs, exact requested order, non-creating and all-or-nothing.
- asset.disposition.set `{projectId,assetId,expectedRevision,requestId,disposition:"neutral"|"favorite"|"rejected"}` → strict disposition item; independent revision, required stable key.
- shot.create `{projectId,requestId?,title,prompt?,referenceAssetIds?:[],aspectRatio?:"9:16",duration?:2,parameters?:{},position?:{x,y}}` → shot
- shot.update `{shotId,expectedRevision,requestId?,patch:{title?,prompt?,referenceAssetIds?,aspectRatio?,duration?,parameters?,position?}}` → shot
- shot.reorder `{projectId,expectedRevision,requestId?,shotIds}` → project. Exact permutation.
- node.create `{projectId,requestId?,type:"text"|"image"|"video"|"audio",label?,text?,assetId?,position:{x,y}}` → node
- node.update `{nodeId,expectedRevision,requestId?,patch:{label?,text?,position?}}` → node
- edge.create `{projectId,source,target}` → decorative edge; edge.delete `{edgeId}` → `{deleted:true}`. Visual-only; typed reference edges cannot be deleted through this operation.
- reference.attach `{projectId,sourceNodeId,targetShotId,expectedSourceRevision,expectedShotRevision,requestId,role:"first_frame"}` → `{edge,shot}`. Atomically attaches a managed image node to a shot with no manual reference selection.
- reference.detach `{projectId,edgeId,expectedShotRevision,requestId}` → `{edge,shot,detached:true}`. Atomically removes a first-frame edge and its owned shot reference. Original asset/node and historical jobs remain intact.
- provider.list `{}` → capabilities array
- generation.submit `{shotId,expectedRevision,requestId,providerId:"mock"|"runway"|"ark"|"veo"|"minimax"|"vidu",model?,parameters?:{scenario?:"success"|"failure"|"delay"|"timeout"|"unknown",delayMs?}}` → job. Deduplication returns same job for same requestId and identical input; different input = IDEMPOTENCY_CONFLICT. Immutable snapshot includes shot fields, actual reference assets, provider/model, merged parameters. Only mock enabled without explicit environment gate and secure server-side configuration.
- job.get `{jobId}` → job; job.list `{projectId}` → job[]
- job.retry `{jobId,requestId}` → new job, only definitively failed jobs; original snapshot preserved; unknown never resubmits
- job.cancel `{jobId}` → job; local cancellation explicitly separate from remote cancellation
- version.list `{shotId}` → version[]; version.select `{shotId,versionId,expectedRevision,requestId?}` → shot
- export.create `{projectId,requestId}` → export (async); export.get `{exportId}` → export

## Records
project: id,name,description,revision,createdAt,updatedAt.
asset: id,projectId,name,mimeType,sizeBytes,width,height,duration,sha256,url,createdAt.
shot: id,projectId,title,prompt,referenceAssetIds,aspectRatio,duration,parameters,position,orderIndex,revision,selectedVersionId,createdAt,updatedAt.
node: id,projectId,type,label,text,assetId,position,revision.
edge: id,projectId,source,target,kind? (`decorative` or `reference`). Historical edges without kind remain decorative. A reference edge additionally has role:`first_frame`,sourceAssetId,createdAt.
job: id,projectId,shotId,requestId,providerId,model,status,phase,progress,snapshot,providerJobId,submissionCount,error,createdAt,updatedAt,versionId,cancelScope.
version: id,projectId,shotId,jobId,number,providerId,model,isMock,snapshot,assetId,url,sha256,createdAt.
export: id,projectId,requestId,status,orderedVersionIds,assetId,url,error,createdAt,updatedAt.

Job states: queued → submitting → running → downloading → succeeded; failed; submission_unknown; cancelled. Persist submission intent before provider side effect. Restart of submitting without provider ID becomes submission_unknown, never blind resubmission. Recoverable known provider IDs queried again. Mock reconciliation uses durable deterministic provider ledger and request key. Local stop cancels waiting only unless adapter positively confirms remote cancellation. Immutable versions created only once with unique job ID.

## Adapter interface (packages/business/src/providers)
`createMockProvider({db,root})`, `createRunwayProvider({root})` return `{id,capabilities,submit(snapshot,context),poll(providerJobId,context),download(providerJobId,destination,context),reconcile(requestId,context),cancel?(providerJobId,context)}`. Async methods. context `{requestId,jobId}`. submit returns `{providerJobId}` or throws error tagged `uncertain=true`; poll `{status:"running"|"succeeded"|"failed",progress?,error?}`. download writes destination MP4, returns optional metadata. reconcile returns `{providerJobId}` or null (null does NOT prove safe resubmission). capabilities `{id,name,models:[...],inputModes:["image"],aspectRatios:["9:16"],durations:[2,4,8],mock,configured,enabled}`. Snapshot includes `referenceAssets:[{id,path,mimeType,sha256}]`; paths only internal adapter context and omitted in public serialization. Only backend reads credentials. Provider worker owns mock.mjs/runway.mjs and provider contract tests; backend owns db/services/jobs/http; frontend owns src. Adapter errors must not echo secrets.

## Runtime/security decisions
Node 24 native SQLite 3.53.3 with ESM JavaScript and shared strict Zod runtime schemas is deliberate: no C++ addon build and one process. React Flow UI is Vite-built. HTTP listens only on 127.0.0.1; Host is restricted to localhost/127.0.0.1 selected port; foreign Origin is rejected. All API/media requests require a local Bearer token or HttpOnly SameSite=Strict cookie; token is not put in URL or source. The legacy video registry reads its provider secrets from backend environment configuration, never returning them or storing them in project/task snapshots. Dedicated Images credentials instead use the separate authenticated settings route, backend-lifetime session storage or explicit Electron OS-encrypted persistence; see [Images activation](IMAGE-ACTIVATION.md). Imported bytes go under generated managed IDs; path APIs and arbitrary remote URL ingestion are absent; media routes resolve realpath beneath managed media root. Login is the only unauthenticated mutation and requires the local token. Stdio MCP is a thin authenticated HTTP client and never opens a second writer.

## V4 additions

The public schema additionally accepts provider IDs `ark`, `veo`, `minimax`, `vidu`. `provider.list` preserves legacy aggregate fields and adds per-model `modelCapabilities`, safe `configuration`, readiness `status`, optional `region` and local count `budget`. Never derive a model's input support from another model or aggregate union. Shared `findModelCapabilities` and `getGenerationIssue` are exported by contracts for renderer/client validation; backend adapter validation plus production-registry exact model/region input-profile validation are authoritative before queueing and again before dispatch. Safe discovery adds `inputProfiles`, `inputProfileVersion`, `providerRegion`, `profileEvaluationDate`, and `inputProfileEvaluations`; public submit inputs remain unchanged. New snapshots pin the profile and complete reference bindings without rewriting legacy snapshots. See [model input limits](GENERATION-INPUT-LIMITS.md).

Snapshot reference entries additionally preserve width and height. Mode is inferred from reference count, not an independent mutable request field. Native output dimensions are probed before version publication; a >1% aspect mismatch is paused as `cancelled` / `output_review_required`, retaining the existing provider ID and private output. This is not a remote cancellation or a safe-to-retry failed generation.

## Typed first-frame connections

The reference service accepts only a project-local image node backed by an existing managed PNG/JPEG/WebP asset. It checks both source-node and target-shot revisions for attach, and the target-shot revision for detach. One typed reference edge per shot is allowed; an identical attach with a new request ID and current revisions returns the existing edge/shot without another revision bump. Different sources require an explicit detach. A pre-existing visual edge may coexist and remains visual-only.

Attaching never adopts or overwrites a manual `referenceAssetIds` selection, even when it is the same image. Clear and save that selection explicitly first. While connected, `shot.update` may retain the exact same reference IDs but cannot replace or clear them. Detach clears only the owned image; inconsistent state rejects instead of overwriting it. Source-node `assetId` is immutable through `node.update`; node/asset deletion operations are not exposed. Source labels and positions can change without changing the fixed image.

Both mutations save the exact original response in additive schema-v4 `reference_requests` storage in the same transaction. Replay precedes revision checks and remains byte-equivalent after detach, later edits or restart. Reusing an ID with changed input or for the other reference operation returns `IDEMPOTENCY_CONFLICT`. Refresh `project.get` after replay to see current state.

New generation snapshots include `referenceConnections:[{edgeId,sourceNodeId,sourceAssetId,role}]` alongside the existing frozen image IDs, bytes hash, dimensions and provider settings. Detaching, reattaching or moving/renaming a node does not change queued/running jobs or their explicit retries. Attach does not upload, submit generation or guarantee model compatibility: existing model-specific validation and approved-media gates still apply when generating. This is a first-frame input, not character/style consistency, general DAG execution, prompt propagation, or timeline history.

New adapter factories: `createArkProvider`, `createVeoProvider`, `createMinimaxProvider`, `createViduProvider`. All use fixed official endpoints, validated opaque task IDs, explicit backend configuration, approved managed image hashes, no automatic generation POST retries, bounded safe media downloads and truthful local-only cancellation. The private registry centralizes discovery and environment names; actual docs and supported narrow model subsets are in PROVIDERS.md.

## Local edit replay extension

The six optional-key operations above use an additive immutable original-response
journal. `requestId` is 8–200 characters. Same operation/project/complete input
replays the historical response before revision checks, after validating current
ownership; altered reuse conflicts. Defaults are not inserted into the input
fingerprint. No key preserves legacy behavior. Mutation and receipt are one
synchronous transaction; no file/provider work is included. Optional-key effects
remain `idempotent:false` / MCP `idempotentHint:false`. Full failure/recovery and
client-storage boundaries: [MUTATION-REPLAY.md](MUTATION-REPLAY.md).

## Saved video/audio source-range metadata

- `asset.range.get {projectId,assetId}` → `{id:assetId,assetId,projectId,revision,range,sourceFrameCount,fps:30}`.
- `asset.range.set {projectId,assetId,expectedRevision,requestId,inFrame,outFrame}` → the same envelope with a persisted range and next revision.

No saved row returns revision `0` and `range:null`, without creating a row or a
timeline. The UI may show the full source as a draft; that is not a persisted
selection. Saved `range` is `{inFrame,outFrame}`: safe integer positions in the
30-fps timeline timebase, inclusive in/exclusive out, at least one frame within
the known finite source duration. This is not native/VFR frame-number indexing.

`expectedRevision` belongs to the range, not the asset/project/timeline. The new
set operation requires its stable key; the six historical local operations keep
optional keys and unchanged responses. With the later disposition extension,
the shared helper checks all three immutable receipt tables in one write
transaction, so all eight supported local mutations share key collision
protection. Timeline/reference/generation journals retain their existing
separate scopes. See [source-range details](SOURCE-RANGES.md).

## Asset review disposition metadata

Disposition records are separate from the unchanged asset record shape. The
strict result is `{id:assetId,assetId,projectId,revision,disposition}` with one of
`neutral`, `favorite`, `rejected`. An owned asset with no saved metadata reads
as neutral/revision 0, without creating rows or a timeline. List accepts 1–100
unique UUIDs and returns every requested item in exact order, or fails the whole
batch. Missing and foreign scope have the same `NOT_FOUND` 404 without a current
record, partial result or definite-not-applied claim. Invalid owned metadata
fails closed with `INVALID_ASSET_DISPOSITION_RECORD` 409.

Set requires a nonnegative safe-integer `expectedRevision` and a caller-owned
8–200-character `requestId`. Each fresh successful set increments only the
independent disposition revision. Saving neutral preserves revision history;
it does not delete metadata or restore revision 0. Same-value new intents also
advance the revision. At the maximum safe integer, new sets fail with
`DISPOSITION_REVISION_LIMIT` 409; valid historical replays still precede CAS.

Schema v12 adds `asset_dispositions` and the immutable
`asset_disposition_requests` companion. All eight local mutations share key
collision checks across this companion, `asset_range_requests` and
`mutation_requests`, atomically with the business write. Original six optional
keys/responses remain unchanged; range/disposition set require their keys.
Timeline/reference/generation/export journals retain their existing scopes.

Disposition changes do not rewrite originals, saved source ranges, clips,
versions or any asset/project/shot/timeline revision. Rejection never deletes,
removes an in-use clip, or changes legacy `asset.list` and explicit clip-add
semantics. Inspection and built-in Agent DTOs/model tools are unchanged. Browser
pending recovery receipts are session-only; backend receipts persist through
restart. See [asset dispositions](ASSET-DISPOSITIONS.md).
