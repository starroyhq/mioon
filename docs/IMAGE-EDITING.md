# Single-PNG reference image editing

Date: 2026-10-11. Baseline: `07ee1910f00822607a739df6b543bb92a3f7d7b5`.
Status: implementation, focused checks, fresh production build/package and
Linux native acceptance complete. Final independent aggregate passed:3960 total,
3958 passed,0 failed,2 skipped (1000449.189933ms).

## Bounded workflow

The right Properties image page offers text generation or editing one existing,
project-owned managed PNG. Pick the source explicitly, inspect its thumbnail,
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
  "options": {"size":"1024x1024","quality":"low","outputFormat":"png","background":"opaque","n":1},
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
dimensions, saved name and typed import/image-version/extracted-frame origin.
Arguments cannot invent provenance. The accepted source identity is fixed in
task, review and version records. Public DTOs contain no source bytes,
filesystem paths, remote source URLs or secrets. The existing built-in Agent
read/write tool allowlists are unchanged; there is no automatic context upload.

## Limits and wire

- Source: one managed PNG, at most 8 MiB, each edge 1–1024 pixels and at most
  1,048,576 pixels. RGB or fully opaque RGBA, 8-bit, noninterlaced, nonanimated.
  Unsupported sources, including compressed ICC/text and unsupported ancillary
  chunks in the existing strict PNG decoder, are rejected rather than silently
  converted or truncated.
- Source names: at most 200 characters / 800 UTF-8 bytes. Typed source chains:
  at most 32 links, with cycle and mixed-owner rejection.
- Output: one 1024×1024 opaque PNG, low quality, existing bounded result decoder.
- Prompt: existing 2,000-character / 8,000-byte limit.
- Official edit body: at most 8,416,992 bytes (8 MiB source, a conservative
  12,000-byte prompt allowance and 16,384 bytes for multipart overhead).
  Both the SDK form and the serialized multipart stream are bounded. Existing
  generation/custom body cap remains 16,384 bytes.
- Source verification admission: at most four active checks per shared database
  handle, at most two per project. Slots release when validation really settles;
  this is a process/owner-instance bound, not a multi-process global claim.
- Existing task/page/receipt/retention limits remain; this is not a new generic
  task executor or request-key namespace.

Since 2026-10-26, official edits use the pinned `openai@7.39.0` SDK's
`images.edit()` to generate multipart for `https://api.openai.com/v1/images/edits`.
The source is a single backend-created `image/png` File named `source.png`,
constructed from the project-owned, hash-checked PNG bytes. The host retains
DNS/TLS pinning, credential binding and the synchronous dispatch fence after
serialization. No Files API upload, remote-image URL, redirect, capability-probe
request, protocol fallback or automatic POST retry is used.

The SDK edit contract does not expose `moderation`, so this implementation no
longer explicitly sends the former JSON request's `moderation:auto`; native
service handling applies. Multipart editing is not claimed to be wire-equivalent
to the previous JSON/Base64 request. Private source bytes are never stored as
Base64 in SQLite. `input_fidelity` remains omitted for this bounded profile.

## Recovery, ownership and privacy

Source verification checks actual managed bytes and the current typed
project/asset/version/frame lineage. Approval and the final synchronous dispatch
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
