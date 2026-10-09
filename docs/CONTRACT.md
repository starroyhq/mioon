# Shared contract v1 (2026-10-09)

All application mutations and reads go through `services.call(operation, input)`, used by authenticated HTTP `POST /api/rpc` and official SDK MCP stdio and CLI shared client. UI calls same HTTP API. JSON response `{ok:true,data}` or `{ok:false,error:{code,message,details}}`; conflict HTTP 409, validation 400, not found 404. Dates ISO UTC. IDs opaque UUID. Revisions integers starting at 1. All updates require expectedRevision. SQLite transactions, WAL, foreign keys and busy timeout. Project `revision` protects project-wide shot ordering; each shot/node has its own revision. Position never defines sequence.

## Operations and input
- project.create `{name,description?}` → project
- project.list `{}` → project[]
- project.get `{projectId}` → `{project,assets,shots,nodes,edges,jobs,versions,exports}`
- asset.import `{projectId,name,mimeType,dataBase64}` → asset. Backend validates bytes and stores a managed filename; no arbitrary local paths or URLs.
- asset.list `{projectId}` → asset[]
- shot.create `{projectId,title,prompt?,referenceAssetIds?:[],aspectRatio?:"9:16",duration?:2,parameters?:{},position?:{x,y}}` → shot
- shot.update `{shotId,expectedRevision,patch:{title?,prompt?,referenceAssetIds?,aspectRatio?,duration?,parameters?,position?}}` → shot
- shot.reorder `{projectId,expectedRevision,shotIds}` → project. Exact permutation.
- node.create `{projectId,type:"text"|"image"|"video",label?,text?,assetId?,position:{x,y}}` → node
- node.update `{nodeId,expectedRevision,patch:{label?,text?,position?}}` → node
- edge.create `{projectId,source,target}` → edge; edge.delete `{edgeId}` → `{deleted:true}`
- provider.list `{}` → capabilities array
- generation.submit `{shotId,expectedRevision,requestId,providerId:"mock"|"runway"|"ark"|"veo"|"minimax"|"vidu",model?,parameters?:{scenario?:"success"|"failure"|"delay"|"timeout"|"unknown",delayMs?}}` → job. Deduplication returns same job for same requestId and identical input; different input = IDEMPOTENCY_CONFLICT. Immutable snapshot includes shot fields, actual reference assets, provider/model, merged parameters. Only mock enabled without explicit environment gate and secure server-side configuration.
- job.get `{jobId}` → job; job.list `{projectId}` → job[]
- job.retry `{jobId,requestId}` → new job, only definitively failed jobs; original snapshot preserved; unknown never resubmits
- job.cancel `{jobId}` → job; local cancellation explicitly separate from remote cancellation
- version.list `{shotId}` → version[]; version.select `{shotId,versionId,expectedRevision}` → shot
- export.create `{projectId,requestId}` → export (async); export.get `{exportId}` → export

## Records
project: id,name,description,revision,createdAt,updatedAt.
asset: id,projectId,name,mimeType,sizeBytes,width,height,duration,sha256,url,createdAt.
shot: id,projectId,title,prompt,referenceAssetIds,aspectRatio,duration,parameters,position,orderIndex,revision,selectedVersionId,createdAt,updatedAt.
node: id,projectId,type,label,text,assetId,position,revision.
edge: id,projectId,source,target.
job: id,projectId,shotId,requestId,providerId,model,status,phase,progress,snapshot,providerJobId,submissionCount,error,createdAt,updatedAt,versionId,cancelScope.
version: id,projectId,shotId,jobId,number,providerId,model,isMock,snapshot,assetId,url,sha256,createdAt.
export: id,projectId,requestId,status,orderedVersionIds,assetId,url,error,createdAt,updatedAt.

Job states: queued → submitting → running → downloading → succeeded; failed; submission_unknown; cancelled. Persist submission intent before provider side effect. Restart of submitting without provider ID becomes submission_unknown, never blind resubmission. Recoverable known provider IDs queried again. Mock reconciliation uses durable deterministic provider ledger and request key. Local stop cancels waiting only unless adapter positively confirms remote cancellation. Immutable versions created only once with unique job ID.

## Adapter interface (packages/business/src/providers)
`createMockProvider({db,root})`, `createRunwayProvider({root})` return `{id,capabilities,submit(snapshot,context),poll(providerJobId,context),download(providerJobId,destination,context),reconcile(requestId,context),cancel?(providerJobId,context)}`. Async methods. context `{requestId,jobId}`. submit returns `{providerJobId}` or throws error tagged `uncertain=true`; poll `{status:"running"|"succeeded"|"failed",progress?,error?}`. download writes destination MP4, returns optional metadata. reconcile returns `{providerJobId}` or null (null does NOT prove safe resubmission). capabilities `{id,name,models:[...],inputModes:["image"],aspectRatios:["9:16"],durations:[2,4,8],mock,configured,enabled}`. Snapshot includes `referenceAssets:[{id,path,mimeType,sha256}]`; paths only internal adapter context and omitted in public serialization. Only backend reads credentials. Provider worker owns mock.mjs/runway.mjs and provider contract tests; backend owns db/services/jobs/http; frontend owns src. Adapter errors must not echo secrets.

## Runtime/security decisions
Node 24 native SQLite 3.53.3 with ESM JavaScript and shared strict Zod runtime schemas is deliberate: no C++ addon build and one process. React Flow UI is Vite-built. HTTP listens only on 127.0.0.1; Host is restricted to localhost/127.0.0.1 selected port; foreign Origin is rejected. All API/media requests require a local Bearer token or HttpOnly SameSite=Strict cookie; token is not put in URL or source. The backend reads provider secrets from environment only, never returns them or stores them in project/task snapshots. Imported bytes go under generated managed IDs; path APIs and arbitrary remote URL ingestion are absent; media routes resolve realpath beneath managed media root. Login is the only unauthenticated mutation and requires the local token. Stdio MCP is a thin authenticated HTTP client and never opens a second writer.

## V4 additions

The public schema additionally accepts provider IDs `ark`, `veo`, `minimax`, `vidu`. `provider.list` preserves legacy aggregate fields and adds per-model `modelCapabilities`, safe `configuration`, readiness `status`, optional `region` and local count `budget`. Never derive a model's input support from another model or aggregate union. Shared `findModelCapabilities` and `getGenerationIssue` are exported by contracts for renderer/client validation; backend `provider.validate(snapshot)` is authoritative before queueing.

Snapshot reference entries additionally preserve width and height. Mode is inferred from reference count, not an independent mutable request field. Native output dimensions are probed before version publication; a >1% aspect mismatch is paused as `cancelled` / `output_review_required`, retaining the existing provider ID and private output. This is not a remote cancellation or a safe-to-retry failed generation.

New adapter factories: `createArkProvider`, `createVeoProvider`, `createMinimaxProvider`, `createViduProvider`. All use fixed official endpoints, validated opaque task IDs, explicit backend configuration, approved managed image hashes, no automatic generation POST retries, bounded safe media downloads and truthful local-only cancellation. The private registry centralizes discovery and environment names; actual docs and supported narrow model subsets are in PROVIDERS.md.
