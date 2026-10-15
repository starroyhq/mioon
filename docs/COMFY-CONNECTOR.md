# First-party local ComfyUI image connector

The subsequent bounded increment adds [optional startup admission](COMFY-OPTIONAL-MODULE.md)
without changing the original settings-enabled meaning or retained task formats.
Its separate verification status does not extend the accepted checkpoint below.

Status: implemented and accepted on top of `8c694d1` (2026-10-10). Focused
checks, fresh builds, Linux native synthetic acceptance and the independent final
full suite passed: **2993 total, 2991 passed, 0 failed, 2 skipped**. Validation
uses synthetic protocol/PNG fixtures.
No ComfyUI installation, model download, GPU execution or real runtime call has
been performed for this acceptance work. Earlier Mock, OpenAI and custom Images
results do not establish this connector's acceptance.

## Scope and trust boundary

The bundled provider is `comfy-local`, with profile `comfy-t2i-png-v1`, workflow
version `1`, and exactly ComfyUI `0.39.0`. It connects to an already installed,
already running runtime selected by the user. It does not install, launch,
upgrade or sandbox that runtime, download checkpoints, or load plugins.

The only workflow is text-to-image: seven nodes using six built-in class names:

1. `CheckpointLoaderSimple`, with the explicitly selected checkpoint
2. `EmptyLatentImage`, 512×512, batch size 1
3. `CLIPTextEncode`, the exact approved prompt
4. `CLIPTextEncode`, an empty negative prompt
5. `KSampler`, a frozen backend-generated seed, 20 steps, CFG 8, `euler`,
   `normal`, denoise 1
6. `VAEDecode`
7. `SaveImage`, a frozen per-execution `mioon_<outputNonce>` filename prefix

The result must be one validated 512×512 PNG, at most 30 MiB. There is no image
upload, image-to-image, arbitrary graph/node input, workflow import, custom-node
execution API, credential field, remote public endpoint, automatic provider
fallback or batch generation.

The user independently trusts the local runtime and its installed code/models.
Literal loopback addresses and reported version/class/module names constrain
compatibility checks; they do not attest code, prove offline behavior, establish
safety, or guarantee free computation. The runtime may consume GPU, memory,
electricity and disk, or perform behavior outside Mioon's control. No external
runtime sandbox or cost cap is provided.

## Connection and explicit check

The independent no-secret settings slot uses namespace `mioon.comfy.local.v1`.
It cannot use or change Agent, video, official Images or custom Images credentials.
The authenticated application routes are:

| Route | Strict request | Result / network effect |
| --- | --- | --- |
| `GET /api/images/comfy-settings` | No query/body | `{revision,configuration,readiness}`; local read only |
| `PUT /api/images/comfy-settings` | `{expectedRevision,configuration}` | Saved settings result; no runtime I/O |
| `POST /api/images/comfy-check` | `{baseUrl,model?}` | Explicit bounded runtime GETs; never submits a prompt |

All return the normal `{ok:true,data:...}` envelope. Existing Host/Origin/session
gates apply. These routes are absent from RPC, CLI, MCP and built-in Agent
catalogs. Token/session access is not permission for an agent to change settings
or approve generation. Settings/check request bodies are limited to 16 KiB,
with strict JSON content type and unknown-field rejection.

Configuration contains exactly:

```json
{
  "enabled": true,
  "providerId": "comfy-local",
  "connectionId": "comfy-local",
  "profileId": "comfy-t2i-png-v1",
  "baseUrl": "http://127.0.0.1:8188",
  "model": "selected-checkpoint.safetensors",
  "options": {
    "size": "512x512", "steps": 20, "cfg": 8,
    "sampler": "euler", "scheduler": "normal", "denoise": 1, "n": 1
  },
  "comfyVersion": "0.39.0"
}
```

The endpoint and model above are illustrative, not a discovered local service
or model. Use the user's actual endpoint and a checkpoint from its explicit
check. The default is disabled with both `baseUrl` and `model` empty; otherwise
both must be complete. Checkpoint names are bounded safe relative names, at
most 240 UTF-8 bytes; traversal, backslashes, controls and URL syntax are rejected.
A PUT includes the current nonnegative settings `expectedRevision`. A successful
save advances that revision; a stale or uncertain save is not silently retried.

Only canonical root origins `http://127.0.0.1:<explicit-port>` and
`http://[::1]:<explicit-port>` are accepted. Ports are 1–65535. No `localhost`,
other loopback spelling, DNS, LAN, HTTPS, userinfo, path, query, fragment or proxy
is accepted. Both the configured backend port and its actual listening port are
excluded, including dynamically assigned ports. The actual socket peer address
and port are checked before request bytes are sent and when the response arrives.
There are no redirects, cookies, authentication headers or fallback destinations.

Opening settings, saving, profile discovery, review reads and startup do not
probe ComfyUI. Only the explicit check reads `/system_stats` and the six exact
`/object_info/<class>` routes. It verifies the reported version and required
node signatures, rejects API-node declarations, and returns at most 256 safe
checkpoint names plus whether the optional selected checkpoint is present.
It does not send the generation prompt or run an inference.

Successful check evidence is RAM-only and cannot be supplied in settings input.
Readiness is `{checked,checkedAt}`. Restart or close loses that evidence; an
explicit recheck revokes the prior evidence for that endpoint before I/O, and
stale check completions cannot reinstate it. Prepare/approval/dispatch require
a complete enabled configuration, its exact revision and a successful matching
check. A check does not guarantee that models remain installed or that inference
will succeed. No check result alone grants generation authority.

## Review and one submission

External authorized clients may use the existing `image.review.prepare/get/list`
operations for the local provider. A preparation request is exactly:

```json
{
  "input": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "name": "Local image",
    "providerId": "comfy-local",
    "model": "selected-checkpoint.safetensors",
    "prompt": "A ceramic cup on a plain table",
    "options": {
      "size": "512x512", "steps": 20, "cfg": 8,
      "sampler": "euler", "scheduler": "normal", "denoise": 1, "n": 1
    },
    "requestId": "local-image-intent-0001"
  },
  "settingsRevision": 1
}
```

Replace every illustrative identity/model/revision with actual selected values.
For a new version of an existing image group, include both `groupId` and its
current `expectedRevision` inside `input`. Do not add endpoint, graph, seed,
prompt UUID, client UUID, nonce, credential or approval overrides.

Preparation writes an immutable local review only. Its v3 intent freezes the
whole configuration, exact `/prompt` destination, original input, seed, full
graph and graph SHA-256, prompt UUID, client UUID and output nonce. The review
response exposes the frozen `configuration` and `execution` for inspection.
The backend generates those identities before review; changing settings cannot
retarget an existing task. Exact preparation replay retains the same identity
and current review state. Changed reuse conflicts.

Only the user's explicit application approval of that visible review can admit
new generation. Approve/reject remain private application actions, not shared
operations or model tools. New direct `image.generate` for `comfy-local` is
blocked without that approval. The review policy is exactly one POST attempt,
`automaticRetry:false`, `price:"local-compute-unknown"`, and
`promptStorage:"local-plaintext"`.

Immediately before sending, the backend synchronously fences current settings,
review/task authority and the remote identity in the durable database, then sends
one `POST /prompt`. No await may open a gap between that final fence and request
`end()`. A valid acknowledgement must name the frozen prompt UUID. An ambiguous
response or a restart never authorizes another POST. Supplying a prompt UUID is
correlation, not server idempotency; repeating it may queue duplicate work.

Submission acknowledgement leaves the image task `receiving`. It does not
schedule runtime polling or output download. Explicit observation is the next
separate step. A queued/running UUID match is not full content verification.

## Shared local read and explicit remote observation

These two additions use the same strict catalog through HTTP RPC, CLI and MCP.
They do not enter any built-in Agent allowlist or enlarge Agent run consent.

| Operation | Strict input | Effect |
| --- | --- | --- |
| `image.task.remote.get` | `{projectId,taskId}` | Read existing local remote evidence and latest observation; no network or writes |
| `image.task.observeRemote` | `{projectId,taskId,expectedRevision,requestId}` | Durably accept one explicit runtime query and possible verified result retrieval |

`remote.get` returns `{projectId,taskId,remote,observation}`. `remote` includes the
frozen IDs/profile/version/seed, endpoint, graph hash, state/revision,
`contentVerified`, optional output descriptor/SHA-256/byte count, safe error code
and timestamps. It omits raw graph and output bytes; the owned review supplies
the graph. `observation` is the latest retained observation or `null`. This read
cannot create, repair or resume a record and is not a fresh runtime status check.

For `observeRemote`, use `remote.revision` as `expectedRevision`, not the image
task, review or settings revision. `requestId` is a caller-retained 8–200-character
key distinct from generation/review keys. Admission uses revision CAS, validates
task/review ownership and writes the request plus its acknowledgement before
network I/O. The acknowledgement contains `id`, `projectId`, `taskId`,
`requestId`, `state:"queued"`, `revision:1`, `remoteRevision` equal to the supplied
revision plus one, and `createdAt`. It is not evidence that the query completed.

Exact replay with the original input/key returns that original acknowledgement,
without another GET, even after interruption or restart. Changed reuse conflicts.
Read `remote.get` and `image.task.get` for current state. A later deliberately
requested query needs a new observation key and current remote revision, after
the prior query is no longer active. Do not substitute a new generation key.
`image.request.get` remains the original image-mutation lookup and does not
retrieve observation acknowledgements; retain the exact observation request.

Only dispatched ComfyUI tasks in `receiving` or `outcome_unknown` are eligible;
a terminal failed remote run is not. At most one observation is admitted as
queued/running across the workspace. Each accepted observation issues at most
one `GET /api/jobs/<frozen-prompt-UUID>` and, only after validated terminal success,
one fixed `GET /view` for the bound PNG descriptor. There is no automatic polling,
retry, broad queue/history scan, arbitrary result URL or caller-supplied descriptor.

A fresh rejected observation may clear a retained client intent only with the
exact operation/project/task/request/hash-bound `not_accepted` proof. The backend
emits it after rollback, current ownership validation and proof that no saved
identity exists. Ambiguous transport failures, malformed acknowledgements and
generic errors keep the original key. Recovery is an explicit user action, not
automatic resubmission.

Remote states are `prepared`, `submitted`, `submission_unknown`, `queued`,
`running`, `completed`, `failed`, and `unavailable`. Observation states are
`queued`, `running`, `finished`, and `interrupted`. These are separate from the
existing image-task lifecycle. A `finished` observation may have an error or may
have observed pending work; it does not mean successful image generation.
A missing job or unavailable response does not prove that generation never ran.
`submitted` records the durable sending boundary, not delivery certainty; startup
converts any remaining such boundary to `submission_unknown` without I/O.

## Terminal evidence, publication and restart

A terminal result must match the entire frozen graph, client UUID and correlation
marker, including graph hash and output nonce. The connector also checks the
actual `execution_status`, rather than trusting only a normalized `completed`
label. Success requires successful completed execution with no execution error,
exactly one image from node 7, output type `output`, an empty subfolder and the
nonce-bound filename. A terminal failure needs matching content and explicit
error execution status before the image task can become failed.

The fixed `/view` response must be a fully validated 512×512 PNG. Its descriptor,
SHA-256 and byte count are durably pinned and immutable before local staging.
Publication validates task → review → remote-run → receipt ownership and uses
the existing managed staging/asset/version path. Local ComfyUI receipts use v2
with `providerId:"comfy-local"` and 512×512 dimensions; legacy v1 receipts and
1024×1024 provider outputs remain unchanged.

If the process stops after pinning but before local staging/publication, only a
new explicit observation can retrieve the same terminal result. It must match
the pinned descriptor, SHA-256 and byte count exactly; different bytes or another
output cannot replace the result. Existing `image.task.recoverResult` remains
local-only: it validates and publishes eligible task-bound staged bytes and never
performs GET or POST. It cannot fetch a missing result.

Startup reconciles local states only: no POST and no runtime GET. Interrupted
observations remain retained and require a new explicit query. Undispatched
queued tasks stay interrupted; ambiguous dispatched tasks stay unknown unless
retained local evidence can be handled under the existing lifecycle. Closing the
panel, disconnecting a client, stopping local observation or closing Mioon does
not cancel remote GPU work. Remote cancellation is not implemented;
`image.task.cancelQueued` is still undispatched-only.

## Internal connector boundary

`packages/business/src/comfy/connector.mjs` implements the used, first-party
validated connector interface: `check`, `submit` and `observe`. The server
constructs it with trusted transport dependencies and runtime backend-port
exclusions. Contracts/workflow validation fix its DTOs and graph; the network
module maps typed operations to the small fixed route set. Core settings,
reviews, remote observation journal and image services own persistence,
authorization, CAS and publication. The connector owns bounded protocol handling
and candidate validation, not those core authorities.

This is the internal SDK extraction actually used by the integration. It is not
a public stable SDK, arbitrary third-party loader, user-supplied transport,
generic HTTP proxy or extension execution system. Dependency injection is a
trusted backend/test seam and cannot be selected through RPC/CLI/MCP input.

Network limits: 16-KiB headers, 256-KiB status JSON, 2-MiB aggregate node metadata,
32-KiB graph, 36-KiB submission, 30-MiB PNG; connect timeout 5 seconds, JSON request
10 seconds, PNG request 30 seconds and complete check 30 seconds. Responses use
bounded bodies and exact expected content types with no compressed encoding.
Errors returned to clients are bounded safe codes/messages, not raw upstream
payloads or local paths.

## Schema 19 and retention

Schema 19 extends `image_reviews` with a v3 intent branch. Its transactional table
rebuild copies every old SQL column value and hidden rowid without JSON
reserialization, compares both directions, restores existing indexes/triggers,
and checks foreign keys. Official v1/custom v2 reviews, original input and
response receipt bytes, and their replay identities are retained.

It adds `image_remote_runs` and `image_remote_observations`, their ownership,
immutability/retention constraints and cross-image-key collision guards. The
only intentional change to an existing image lifecycle trigger is the narrow
`image_task_state_transitions` branch from `outcome_unknown` to `failed`: it
requires a ComfyUI-bound, content-verified terminal failure and an active matching
observation. It does not permit other providers or unverified observations to
settle unknown generation.

Reviews retain the 24-KiB generation input, 32-KiB intent, 64-KiB row and
1000/project, 10,000/workspace limits. Remote graphs are capped at 32 KiB, run
payloads at 64 KiB and descriptors at 4 KiB; observation processing is bounded
at 8 KiB. Observation history retains at most 1000/project and 10,000/workspace,
without eviction or cleanup. Full capacity rejects new admission; it never frees
keys by deleting unresolved identities. Prompts, checkpoints, endpoints, graphs
and provenance remain plain local data visible to authenticated readers. Do not
include credentials or secrets in them.

## Verification checkpoint: 2026-10-10

- Serial affected gate: **883/883 passed, no skips**. Separate settings (20),
  connector (30), contracts/migration (137), UI (81), business recovery (10) and
  real HTTP/CLI/official-MCP transport (8) checks also passed; these overlap the
  affected gate and are not an additional unique-test total.
- The independent frozen schema-18 fixture verifies original rows, rowids,
  stored input/response byte strings, indexes and triggers. The documented
  unknown-to-failed Comfy lifecycle branch is an intentional exception to SQL
  trigger-text preservation, not a claim that all old SQL is byte-identical.
- Fresh Web, desktop main and backend builds passed. The final native runs used
  those unmodified bundles, including the independently integrated reference
  labels and package/tooling changes. No injected transport or renderer test
  switch was added to the product.
- Actual Linux Electron UI: invalid `localhost` rejected, explicit literal
  loopback check/save, immutable workflow review, one approved POST, no automatic
  result polling, explicit PNG retrieval, V2 preparation and tab/draft retention.
  Original app and renderer exited normally; a new process rediscovered the
  unobserved task as unknown without a POST or GET. Explicit retrieval saved V2;
  V1 and original project/shot/node/reference records remained byte-identical.
- The synthetic HTTP fixture recorded exactly two POSTs, two single-job GETs
  and two PNG GETs, plus seven explicitly requested compatibility-check GETs.
  Both POST bodies matched the frozen review graphs and correlation identities.
  This establishes fixture request counts, not a packet-capture claim about all
  network traffic or a real Comfy/GPU compatibility test.
- The recovered 512×512 PNG was explicitly added to the timeline. Native
  preflight and FFmpeg export succeeded; independent decode returned exit 0,
  H.264/AAC, 720×1280, 30 fps, 90 frames, 3 seconds. File SHA-256:
  `35f4f318881a7073a10b5050cec57817f9e675c770bc73b2a87b51614e623ed5`.
- First independent aggregate: **2992 tests, 2981 passed, 9 failed (six leaf
  failures and three enclosing suites), 2 skipped**. Four catalog tests assumed
  all input schemas had one object root; tests now validate every exact strict
  union branch. The source-range fixture deleted later version markers while
  retaining later tables; its targeted additive reapplication now preserves
  unrelated schema versions and checks complete schema/receipt invariants.
- The sixth leaf failure was a 30-second A3 MCP client timeout importing a small
  synthetic MP4. Its unchanged test passed separately in 18.6 seconds with the
  existing preserve-workspace option. That rerun does **not** identify or fix
  the original timeout cause. No production timeout was increased. The exact
  default-environment A3 also passed (14.2 seconds); its identical 122374-byte
  MP4 imported in 154 ms. Corrected catalog/transport tests passed 36/36 and
  source-range tests passed 16/16. Production/build hashes are unchanged; the
  final independent full rerun passed **2993/2991/0/2** (total/pass/fail/skip),
  701470.359 ms, including A3 in 11.92 seconds. The earlier failed aggregate
  and both isolated runs are retained; its timeout cause remains unconfirmed.
  Native macOS/Windows, a real installed Comfy runtime and GPU/model output
  remain unverified.

Cloud-local logs, source/build hashes, fixture audits and 18 actual native
screenshots are retained under ignored `evidence/comfy-local/`; they are not
included in the source checkout. The first launcher attempt correctly refused
an existing non-private fixture directory; acceptance used a newly created
private child without modifying the old directory's mode. A native quit action
was initially denied, then the exact same action was retried once after explicit
user-authorization evidence and succeeded. Neither was a product failure.

No installation, model acquisition, real generation or live canary is authorized
by fixture success or this documentation. A real-runtime canary requires the
user's trusted pinned runtime/checkpoint and approved prompt/execution. See
[platform release gates](PLATFORM-RELEASE-GATES.md) for independent platform
blockers and [custom Images](IMAGE-COMPATIBLE.md) for the prior increment.

## Official compatibility sources

Sources inspected 2026-10-10; the tag, not a moving latest version, is the target:

- [ComfyUI v0.39.0 release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.39.0)
- [Tagged server routes and prompt submission](https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/server.py)
- [Tagged execution/queue implementation](https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/execution.py)
- [Tagged single-job normalization and terminal workflow evidence](https://github.com/Comfy-Org/ComfyUI/blob/v0.39.0/comfy_execution/jobs.py)
- [Official route overview](https://docs.comfy.org/development/comfyui-server/comms_routes)

The general route documentation describes more capabilities than this connector
allows. The existence of upstream upload, queue management, WebSocket or cancel
routes does not make them available through Mioon.
