# Image generation: shared workflow and original local slice

## Local ComfyUI increment: 2026-10-10

The [first-party local ComfyUI connector](COMFY-CONNECTOR.md) adds a separate
fixed 512×512 PNG profile, immutable workflow review and explicit remote result
observation. Focused tests, fresh builds and Linux native synthetic acceptance
and independent full suite passed (2993 total /2991 pass /0 fail /2 skip); real
GPU/runtime compatibility is unverified. Its independent settings do not alter the 1024×1024 official or
custom Images profiles described below.

## Accepted custom increment: 2026-10-10

The [custom Images slot](IMAGE-COMPATIBLE.md) is implemented with a
separate credential, canonical public-DNS HTTPS destination and configured ASCII
model using the existing fixed single-PNG profile. Its focused/build/Linux
synthetic-native gates and independent full suite passed: 2857 total, 2855 passed,
0 failed, 2 skipped. New official/custom requests through public `image.generate` require
the separate explicit UI paid approval; discovery is not permission to spend.
Mock remains a visibly labeled local test card without prompt-conditioned content.

The prior fixed-OpenAI activation checkpoint `4e66a96` passed its 461-test affected
gate, builds, Linux synthetic-network native acceptance and full suite (2758
total, 2756 passed, 0 failed, 2 skipped). See [Images activation](IMAGE-ACTIVATION.md)
for that historical record and shared approval/recovery rules. It does not
establish this custom gate, live-provider or macOS/Windows acceptance. Custom v2
reviews and the narrow schema-18 migration are documented in the new guide.

## Historical first-slice scope: 2026-10-10, baseline `82c70f3`

The scope statements in this section describe the accepted initial slice before
activation, and are retained as dated evidence. Current availability is described
above and in [Images activation](IMAGE-ACTIVATION.md).

This increment adds a separate image composer, durable image tasks, immutable
image versions and managed PNG assets to the shared UI/API/CLI/MCP service.
It does not change the existing video providers or Agent credentials, settings,
read-tool catalog or reviewed-shot-edit catalog.

### What was available in the first slice

- **Mock** (`mock`, `mock-image-v1`) produces a real, visibly labeled,
  deterministic 1024×1024 PNG locally. It does not use the prompt to synthesize
  a scene. Different prompts have the same Mock pixel content. This verifies
  the workflow and storage, not image-model quality or visual continuity.
- **OpenAI preset** (`openai`, `gpt-image-2.5-flare-2026-09-08`) has an adapter
  and synthetic transport fixtures, but is **hard-disabled in the product**.
  Its discovery evidence is `offline-tested-not-live`; that label does not
  certify live model availability, account access, output or pricing.
- Both profiles describe exactly one 1024×1024 image, `quality: "low"`,
  `outputFormat: "png"`, `background: "opaque"`, and `n: 1`.
- No custom endpoint, credential setting, API-key input, environment-flag
  activation, reference upload, image edit/mask, batch, seed, variable size or
  automatic image-to-video stage is exposed by this increment.

An OpenAI request returns `IMAGE_LIVE_DISABLED` before creating a task or
group. The production adapter has no default live transport or credential
resolver. Synthetic injection is an internal test seam, not an API or
environment setting. There is no fallback to Mock or another model.

Secure image-provider configuration and separately approved live activation
are the immediate follow-on, not removed scope. They must include a secure
credential route, fixed/validated destination, current provider-contract
review, explicit prompt/media and spending approval, and live acceptance
evidence. A ChatGPT subscription, configured Agent key or enabled video
provider cannot enable image generation. Activation must also update the
operation-effect metadata before any upstream generation is supported.

## Shared operations

Every operation uses the existing authenticated local `POST /api/rpc`.
CLI command words replace dots with spaces; official MCP tool names replace
dots with underscores, preserving case. There is one business implementation
and one database owner. Runtime schemas in `packages/contracts/src/images.mjs` and
`packages/contracts/src/image-reviews.mjs` are authoritative; all objects reject unknown fields.

| Operation | Input | Result / effect |
| --- | --- | --- |
| `image.profile.list` | `{includeSettingsRevision?:boolean}` | `{items,liveEnabled}`; default unchanged. Explicit true may add each eligible profile's non-secret revision; [exact discovery rules](IMAGE-PROFILE-DISCOVERY.md). No provider verification or approval |
| `image.generate` | See example below | Original queued task receipt; new public requests schedule Mock only; official/custom live requests require private reviewed approval |
| `image.review.prepare` | `{input:<complete official/custom image.generate input>,settingsRevision}` | Local immutable-intent review only; no approval or dispatch |
| `image.review.get` | `{projectId,reviewId}` | Existing owned review; read-only |
| `image.review.list` | `{projectId,limit?,cursor?}` | Bounded review page; read-only |
| `image.request.get` | `{projectId,requestId}` | `{projectId,requestId,operation,response}` or `null`; `response` is the original mutation receipt |
| `image.task.get` | `{projectId,taskId}` | Current task DTO; no dispatch or reconciliation |
| `image.task.list` | `{projectId,groupId?,limit?,cursor?}` | Bounded task page |
| `image.group.get` | `{projectId,groupId}` | One current owned group; no generation |
| `image.group.list` | `{projectId,limit?,cursor?}` | Bounded group page |
| `image.version.list` | `{projectId,groupId,limit?,cursor?}` | Bounded immutable version page |
| `image.task.cancelQueued` | `{projectId,taskId,expectedRevision,requestId}` | Explicit undispatched cancellation and original receipt |
| `image.task.recoverResult` | `{projectId,taskId,expectedRevision,requestId}` | Explicit local staged-result publication attempt; never a generation retry |

Pages return `{projectId,items,nextCursor}`. The default limit is 20; allowed
limits are integers 1–50. Cursors are opaque, at most 768 characters. Use only
a returned cursor for the same project, operation, filter and limit; restart
pagination if it becomes invalid. All project/group/task/version identities
are UUIDs. Foreign owned records fail closed rather than exposing their data.

For example, replace the illustrative project UUID with the chosen project:

```json
{
  "operation": "image.generate",
  "input": {
    "projectId": "11111111-1111-4111-8111-111111111111",
    "name": "Opening keyframe",
    "providerId": "mock",
    "model": "mock-image-v1",
    "prompt": "A quiet opening keyframe.",
    "options": {
      "size": "1024x1024",
      "quality": "low",
      "outputFormat": "png",
      "background": "opaque",
      "n": 1
    },
    "requestId": "image-opening-0001"
  }
}
```

The name is nonblank, 1–120 characters. The prompt is nonblank, at most 2000
UTF-16 code units and 8000 UTF-8 bytes; control-character validation also
applies. Mock and official OpenAI must match their exact named models; custom
`openai-compatible` accepts a 1–120-character printable non-whitespace ASCII model
that must match the reviewed custom settings. The request shape is unchanged;
URLs, credentials, connection IDs and approval flags are not generation fields.
No omitted options or unsupported options are silently substituted. See the
[custom review example](IMAGE-COMPATIBLE.md#public-request-preparation-private-paid-approval). Request IDs are 8–200
characters and required on the original three image mutations. Review preparation
retains the same key inside its complete nested generation input; its immutable
settings-bound review has no additional top-level key. See
[Images activation](IMAGE-ACTIVATION.md#shared-public-review-operations).

Omit `groupId` and `expectedRevision` together to create a group. To request a
new immutable version of an existing group, provide both its UUID and current
positive revision, plus the full new prompt/options and a new stable request
ID. Only one unresolved task may occupy a group. A stale revision or busy
group rejects without overwriting a prior task or version.

The initial `image.generate` response is a queued task, not completed PNG
bytes. Read `image.task.get` for the current state, then
`image.version.list` for the immutable result and managed `assetId`. Retrieve
the resulting asset through the existing authenticated media transport or
explicit CLI asset download. Stopping a client poll does not cancel work.

## Exact requests and interruption

Keep the entire original operation/input and stable request ID until the
outcome is known. A lost acknowledgement does not imply a failed mutation:

1. Use `image.request.get` in the same project to recover the original receipt.
2. Read the returned task ID with `image.task.get` for its current state.
3. If replay is needed, submit the exact original input and key. Replay returns
   the original receipt, even when the task is now complete or a newer group
   version exists. Do not replace the key to make an uncertain request run again.

Changed use of an existing image request ID returns `IMAGE_REQUEST_CONFLICT`.
The image mutation journal has its own namespace; this is not a claim of
workspace-global deduplication against video, timeline, reference, Agent or
other local mutation journals. A caller must keep operation-specific recovery
context rather than treating a bare key as global authority.

| State | Meaning and permitted next step |
| --- | --- |
| `queued` | Accepted in this backend session, not yet dispatched; explicit `cancelQueued` is permitted |
| `interrupted_before_dispatch` | Restart found undispatched work; it remains stopped and can be explicitly cancelled |
| `dispatching`, `receiving`, `persisting` | A durable dispatch fence exists; queued cancellation is no longer allowed |
| `succeeded` | One immutable version and managed PNG asset were published |
| `cancelled_before_dispatch` | Cancellation was proven to precede dispatch |
| `failed` | A definitive task failure; no automatic retry |
| `outcome_unknown` | Dispatch may have happened, but no recoverable durable output proves the result; never automatically resubmit |
| `local_result_error` | Durable staged local bytes exist but publication failed; only explicit `recoverResult` can retry local publication |

Backend startup turns retained `queued` tasks into
`interrupted_before_dispatch`. Dispatched tasks without durable result evidence
become `outcome_unknown`. Read/list/profile/request-lookup calls and client or
browser restarts never perform inference, resume a generation or publish a
staged result. Read-only operations can use a local HTTP POST envelope without
being an upstream generation POST.

`cancelQueued` is limited to `queued` or `interrupted_before_dispatch` tasks
whose dispatch fence is still false. It is not remote cancellation and makes
no refund promise. `recoverResult` accepts an eligible `local_result_error`
or `outcome_unknown` task under its current revision only when a valid
task-bound durable local receipt and staged bytes exist. It validates and
publishes those bytes. Unknown work without a local result remains blocked.
It never contacts a provider or
reconstructs a missing result by generating another image. These mutations
also retain their exact original receipts.

## Storage, bounds and privacy

- Image tasks, groups, versions and requests are additive local SQLite data.
  Immutable request input and generation snapshots retain the complete prompt.
  Snapshot v1 stays content-only; full custom configuration/destination provenance
  comes from the validated retained task-linked review, never current settings.
  Authorized local task/receipt readers can see that prompt. This is not
  encrypted prompt storage, nor a promise that prompts are absent from local
  backups. Do not put credentials or unrelated private information in prompts.
- Public image DTOs expose bounded IDs, prompt/configuration, status and
  provenance metadata. They omit provider secrets, raw/base64 output bytes,
  internal filesystem paths, staging receipts and internal snapshots. Media
  bytes use the existing authenticated asset transport separately.
- The application bounds request/snapshot JSON at 24,576 bytes, task records
  at 65,536 bytes, staged receipts/version records at 4096 bytes, saved
  mutation responses at 32,768 bytes and PNG results at 30 MiB. List pages
  are bounded by their record count and bounded records; the saved-response
  limit is not a blanket 32-KiB limit on a 50-task page.
- Admission permits at most 8 tasks in queued/dispatching/receiving/persisting
  states per project and 32 across the local workspace. Retained task caps
  are 1000 per project and 10,000 per workspace; retained mutation-receipt
  caps are 3000 per project and 30,000 per workspace. Only one unresolved
  task can occupy a group, including interrupted/unknown/local-result-error
  work. These are local image-work limits, not cloud account quotas,
  guaranteed currency budgets or permission to reset retained history.
- PNG output is structurally and fully scanline-validated before publication:
  exact 1024×1024, noninterlaced 8-bit RGB or fully opaque RGBA only. Chunk
  lengths, CRCs/order, a complete bounded zlib stream, row filters and alpha
  are checked. Animated, grayscale, indexed and 16-bit PNGs are unsupported;
  known metadata is bounded, with compressed text/color profiles rejected.
  No FFmpeg or other media subprocess is needed for this fixed-size slice.

Current discovery effects include separately approved worker activity:
`image.generate` declares database/file writes, external I/O, open-world access
and paid generation, with no local subprocess. This does not make an unapproved
official/custom live RPC executable. Review preparation writes only local database
records; image/review reads are read-only. `cancelQueued` writes only local records;
`recoverResult` can write local managed output. Effects and MCP annotations
remain advisory, not authority to act for a user.

## Reusing an image is a separate edit

A completed image appears as a normal managed library asset with immutable
image-generation provenance. Reuse the existing explicit operations to add
it to a timeline, choose it for a subject version or attach a supported
first-frame reference. Image generation itself creates none of those edits.
It does not select a video shot version, move an existing timeline clip to a
new source, change a subject binding or submit a video stage. No compound
shortcut is provided in this increment.

## Historical first-slice verification scope: 2026-10-10

These checks describe the original Mock acceptance. Activation has its own
[validation boundary](IMAGE-ACTIVATION.md#migration-and-validation-boundary)
at `4e66a96`: its final full suite passed with 2758 total, 2756 passed, 0 failed
and 2 skipped. The current custom increment has its own separately verified gate
in [custom Images](IMAGE-COMPATIBLE.md).

`tests/image-generation-transports.test.mjs` exercises the normal local server,
real HTTP, the actual CLI and the official MCP SDK stdio bridge. It covers
schema/effect parity, local profile discovery, disabled OpenAI requests,
project boundaries, a deliberately lost acknowledgement, exact/conflicting
replay, real persistent Mock PNG bytes, backend/client restart lookup and an
explicit new immutable group version. Adapter fixtures separately exercise
the request/response and before-network gates with synthetic transports.

Run evidence and release/native acceptance are recorded separately in
`STATUS.md`; the presence of tests is not a claim that a particular checkout
passed them. This slice does not establish live-provider, macOS or Windows
acceptance. No new package is required for its image adapters or PNG handling.

### Checkpoint: 2026-10-10 (baseline `82c70f3`)

The implementation passed 790 serial affected tests (zero failures/skips),
fresh web/desktop builds, and an isolated Linux native flow: create V1 and V2,
reuse V1 as an explicit first-frame reference and subject version, add a
90-frame still-image clip, pass preflight, export through FFmpeg, and save
through the native Save As dialog. The saved MP4 decodes as 720×1280 H.264/AAC,
30 fps, 90 video frames and 3 seconds. V1's record, accepted receipt and source
hash remained unchanged. A complete native application restart rediscovered
both versions without adding work; the full business-row/hash audit remained
identical through history reads and normal shutdown. These are synthetic
local results, not evidence of live OpenAI generation. The parent full release
gate passed: 2655 total, 2653 passed, zero failures and two platform skips
(exit 0; 588,972.468 ms).

Schema 16 is additive: four image tables, their indexes/triggers, and a narrow
legacy-version insert guard reject mixed image/video asset ownership. It does
not rebuild `edit_tasks`, renumber historical sequences or rewrite existing
serialized rows. The migration test uses an independently frozen schema-15
fixture, verifies all pre-existing SQL objects/raw row hashes/sequence values,
repeated startup, and rollback of an injected migration failure. Image history
and request receipts are retained; automatic history compaction and staging
orphan collection are not implemented. Restore a compatible backup when
rolling back the application rather than manually dropping guards or history.

Exact run logs, screenshots, immutable source hashes and the native output
hash are retained in the local `evidence/image-generation/` acceptance record.
Known platform limits remain: Linux development build only; native macOS and
Windows/live-provider acceptance are not established by this slice.

## Single managed PNG edits (2026-10-11)

The additive Mock/fixed-OpenAI edit branch and its current verification status are
specified in [IMAGE-EDITING.md](IMAGE-EDITING.md). Legacy text generation, original
receipts and versions retain their prior shape. Custom-compatible and ComfyUI
editing are not included.
