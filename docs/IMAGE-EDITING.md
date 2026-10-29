# Single-source reference image editing

Date: 2026-10-11. Baseline: `07ee1910f00822607a739df6b543bb92a3f7d7b5`.
Status: implementation, focused checks, fresh production build/package and
Linux native acceptance complete. Final independent aggregate passed:3960 total,
3958 passed,0 failed,2 skipped (1000449.189933ms).

Updated 2026-10-27 (schema 62): sources may be PNG, JPEG or WebP within each
model's edit profile, and the output size follows the source's aspect ratio.
See [Model-sized edits](#model-sized-edits-schema-62). The native acceptance
record at the end describes the original PNG-only, 1024×1024 profile.

## Bounded workflow

The right Properties image page offers text generation or editing one existing,
project-owned managed PNG, JPEG or WebP image. Pick the source explicitly, inspect its thumbnail,
name, dimensions and fixed source identity, then enter the desired change.
OpenAI first prepares an immutable local review; the user confirms that exact
source, prompt, model, output options and destination in the application.
External HTTP/CLI/MCP clients can prepare and read reviews, but cannot approve.

Mock exercises the same source validation, versioning and recovery lifecycle.
Its output is the same labeled static test card: it does not redraw the input
or demonstrate model quality. The official adapter is tested only against
synthetic responses. No live provider, real credential or charge is part of this
acceptance. Custom-compatible and local ComfyUI slots remain text-to-image-only.

The full PNG bytes, including any retained metadata, would be sent to the
explicit official destination after real user approval. AI redraw may alter
areas the prompt did not mention. There is no mask, crop, deterministic
compositing, exact identity, unchanged-pixel or subject-lock promise. Imported
originals, earlier versions, jobs, timeline clips and exports are not modified.
Adding a result to a timeline, reference or subject remains a separate explicit
existing operation.

## Shared request and provenance

Use existing `image.generate` with two paired fields:

```json
{
  "projectId": "PROJECT_UUID",
  "name": "Reviewed image change",
  "providerId": "mock",
  "model": "mock-image-v1",
  "prompt": "Make the background blue",
  "options": {"size":"1536x1152","quality":"low","outputFormat":"png","background":"opaque","n":1},
  "purpose": "edit",
  "inputImage": {"assetId":"SOURCE_ASSET_UUID","sha256":"EXACT_SOURCE_SHA256"},
  "requestId": "retained-image-edit-request-0001"
}
```

For the official slot use `providerId:"openai"` and
`model:"gpt-image-2.5-flare-2026-09-08"`, nested in the existing
`image.review.prepare` wrapper with the current dedicated Images
`settingsRevision`. Do not invent an approval flag, supply bytes/URLs/paths,
replace a retained key, or borrow Agent/video credentials.

Omitting both new fields preserves the old text-generation branch. Supplying
only one, a different purpose, an unsupported provider, extra source fields,
or an incorrect hash fails strict validation. Existing group versions also
require the existing `groupId` and `expectedRevision` pair. The output is a new
asset and immutable image version; even an unchanged-looking Mock result has
its own identity.

The backend derives `sourceImage` with asset/hash, MIME, byte length,
dimensions, saved name and typed import/image-version/extracted-frame or
storyboard keyframe origin (see [Storyboard keyframe sources](#storyboard-keyframe-sources-schema-68)).
Arguments cannot invent provenance. The accepted source identity is fixed in
task, review and version records. Public DTOs contain no source bytes,
filesystem paths, remote source URLs or secrets. The existing built-in Agent
read/write tool allowlists are unchanged; there is no automatic context upload.

## Limits and wire

- Source: one managed PNG, JPEG or WebP image under 50 MB (at most 52,428,799
  bytes), each edge 1–4096 pixels and at most 16,777,216 pixels, fully opaque.
  PNG keeps the strict decoder: RGB or fully opaque RGBA, 8-bit, noninterlaced,
  nonanimated; compressed ICC/text and unsupported ancillary chunks are
  rejected. JPEG and WebP bytes are sent unchanged, so only their container is
  checked: one baseline, extended or progressive Huffman JPEG frame (8-bit, one
  or three components) or one VP8/VP8L/VP8X WebP image without alpha or
  animation, whose size matches the managed asset, with an intact end.
  Unsupported sources are rejected rather than silently converted or truncated.
- Source names: at most 200 characters / 800 UTF-8 bytes. Typed source chains:
  at most 32 links, with cycle and mixed-owner rejection.
- Output: one opaque low-quality PNG of the request's `options.size` (see
  [Model-sized edits](#model-sized-edits-schema-62)); the bounded result decoder
  rejects any other size.
- Prompt: existing 2,000-character / 8,000-byte limit.
- Official edit body: at most 52,457,183 bytes (the 52,428,799-byte source
  bound, a conservative 12,000-byte prompt allowance and 16,384 bytes for
  multipart overhead).
  Both the SDK form and the serialized multipart stream are bounded. Existing
  generation/custom body cap remains 16,384 bytes.
- Source verification admission: at most four active checks per shared database
  handle, at most two per project. Slots release when validation really settles;
  this is a process/owner-instance bound, not a multi-process global claim.
- Existing task/page/receipt/retention limits remain; this is not a new generic
  task executor or request-key namespace.

Since 2026-10-26, official edits use the pinned `openai@7.39.0` SDK's
`images.edit()` to generate multipart for `https://api.openai.com/v1/images/edits`.
The source is a single backend-created File named `source.png`, `source.jpg`
or `source.webp` with the asset's MIME type, constructed from the project-owned,
hash-checked bytes; the form also carries the request's `size`. The host retains
DNS/TLS pinning, credential binding and the synchronous dispatch fence after
serialization. No Files API upload, remote-image URL, redirect, capability-probe
request, protocol fallback or automatic POST retry is used.

The SDK edit contract does not expose `moderation`, so this implementation no
longer explicitly sends the former JSON request's `moderation:auto`; native
service handling applies. Multipart editing is not claimed to be wire-equivalent
to the previous JSON/Base64 request. Private source bytes are never stored as
Base64 in SQLite. `input_fidelity` remains omitted for this bounded profile.

## Model-sized edits (schema 62)

Each editable model has a fixed edit profile in
`packages/contracts/src/image-edit-profiles.ts`. GPT Image 2.5 Flare follows the
pinned `openai@7.39.0` `images.edit` documentation (checked 2026-10-27): PNG,
JPEG or WebP sources under 50 MB, and `WIDTHxHEIGHT` outputs whose edges are
multiples of 16 with an aspect ratio between 1:3 and 3:1. Sizes above
2560×1440 are documented as experimental and are not offered. The 4096-pixel
edge, pixel and opacity bounds are application limits, not model claims. Mock
uses the same profile, so every size path runs offline.

- An edit's output keeps the source's aspect ratio: the long edge is 1536 and
  the short edge is rounded to a multiple of 16, with the ratio clamped to
  1:3–3:1. A 640×480 source gives `1536x1152`; a 3:4 portrait gives
  `1152x1536`. The image page shows this size before submitting.
- `options.size` must be a size the model can produce; `1024x1024` stays valid
  for every source. Text-to-image is unchanged at `1024x1024`.
- New official edit reviews are intent version 5, which allows the wider
  sources and sizes. Version 4 rows keep the original PNG-only, 1024×1024
  profile and stay readable; they are never rewritten as version 5.
- A result whose size is not 1024×1024 is recorded with result receipt
  version 3; 1024×1024 results keep the version 1 receipt.

## Storyboard keyframe sources (schema 68)

A keyframe that "建分镜" (`scene.shots.create`) saved in the asset library can be
picked as the source like any other managed image, and the image page labels it
"分镜关键帧". Its origin is
`{kind:"scene-keyframe",sceneKeyframe:{sceneTaskId,sourceAssetId,sourceHash,segment,sourceFrame}}`:
the finished storyboard task that captured it, the reference video and that
video's hash, the segment and the captured source frame, all read from the
task's own receipt. A keyframe whose storyboard was undone stays an owned image
and stays editable. An image that only carries `scene-keyframe` provenance,
without a storyboard receipt that names it, is refused like any other forged
source. Only version 5 edit intents accept this origin; a workspace still at
schema 66 refuses keyframe sources until startup upgrades it.

## Recovery, ownership and privacy

Source verification checks actual managed bytes and the current typed
project/asset/version/frame/storyboard lineage. Approval and the final synchronous dispatch
fence recheck the saved source and configuration; a renderer selection change
cannot replace the approved source. Publication and explicit staged-result
recovery also check the source graph. Historical replay returns the original
receipt before new settings/file freshness checks, while current ownership must
remain safe before disclosure.

Keep the exact input/key after lost acknowledgement or uncertain errors. Read
`image.request.get` and the task; only explicit exact replay uses that identity.
A queued task is not a completed image. Async source validation errors do not
claim a durable no-write proof: another same-key invocation may still accept.
The current Mock composer retains one unresolved identity per project; if a
transparent/corrupt source fails without a task receipt, it conservatively stays
blocked for exact lookup rather than discarding the key or offering an automatic
new attempt. Multi-intent draft retention is not implemented. Startup never posts or automatically
approves. Undispatched cancellation, unknown submitted outcome and recoverable
local staged result remain distinct. Stopping local waiting does not prove that
a provider request was cancelled or unbilled. `recoverResult` can publish only
already staged task-bound bytes; it never regenerates.

Requests, prompts and source provenance are retained in plaintext local SQLite,
not encrypted by the credential vault. Managed input/output files remain local
until the user explicitly approves an outbound operation. Changing the source,
prompt, options or settings requires a distinct newly reviewed intent, not an
in-place rewrite of a pending one.

## Migration and compatibility

Schema 23 extends the existing `image_reviews` CHECK for official edit intent
version 4. It does not rewrite legacy task/version/receipt JSON, add a namespace,
or change legacy review versions 1–3. The isolated startup connection temporarily
suspends FK enforcement before its rebuild transaction and restores enforcement
before exposing the store. The transaction preserves rowids, raw column strings,
indexes, triggers, child FK references and sequence state; a failed verification
rolls back. Populated ComfyUI remote-run references are included in the frozen
schema-22 migration fixture. Unsupported downgrade is not promised.

Schema 62 rebuilds `image_reviews` once more to add the version 5 branch. The
version 4 branch and its limits are kept exactly; the rebuild uses the same
isolated foreign-key guard and preserves every row, rowid and raw byte, which
`tests/image-edit-migration.test.ts` checks on a genuine ordinary60 workspace
with version 4 rows. Restored 63 copies keep these rows read-only.

Schema 68 rebuilds `image_reviews` with the same guard to add the
storyboard-keyframe alternative to the version 5 branch only; version 4 and
every retained row, rowid and raw byte are kept, and the reviewed delta is
frozen in `tests/fixtures/workspace-schema-profiles/current-ordinary-68-delta.json`.
Backups of a schema 68 workspace restore as read-only copies at schema 69
(`restored-local-v23`).

Old snapshots keep schemaVersion 1 through strict legacy/edit branches. Original
T2I requests are not decorated with defaults or new fields. Existing public
profile discovery remains byte-compatible unless its already-supported
settings-revision option is explicitly requested.

## Official sources and evidence status

Checked 2026-10-11:

- [Images edit API](https://developers.openai.com/api/reference/resources/images/methods/edit)
- [GPT Image 2.5 Flare model](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)

These establish the documented endpoint/model/input format, not account access,
paid output quality or live compatibility. The app's smaller source limits and
opaque-only restriction are deliberate implementation limits. Focused contract/migration, lifecycle, renderer, adapter and real HTTP/CLI/MCP
checks passed after the fixture corrections recorded in acceptance. The fresh
production Linux package passed archive inspection. Actual native UI created two
Mock edit versions (imported PNG → V1 → V2), reused V1 as a first-frame reference
and V2 as a subject-library version, then exported a V1 still-image timeline to
a fully decoded 3-second 720×1280/30fps H.264/AAC MP4. Both normal exits returned
0; a new app lifetime preserved all 19 audited table hashes, original media,
source provenance and task/version/export records without creating another task.
No shot subject binding was created in this native flow. The first independent
aggregate failed two existing process-timeout leaves (3950 total,3945 passed,
3 failures including a parent suite,2 skipped). Exact baseline/candidate isolated
comparisons did not reproduce the timeouts. Six test/fixture-only diagnostic
changes retain every deadline and business assertion; their14-case contract/
UTF-8 gate and29-case real-transport group passed. The final parent aggregate
passed3960 total/3958 passed/0 failed/2 skipped. The initial latency cause remains
unknown, not a claimed product or environment fix. macOS/Windows and real-provider
acceptance remain pending.
