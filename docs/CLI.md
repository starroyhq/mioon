# Mioon CLI (V4)

The CLI is a local HTTP client for the **same running backend and database** used by the browser, Electron, and MCP. It never starts a second service or reads backend database/media paths. Node.js 24+ and the source workspace dependencies are required; this is not a bundled standalone executable.

From the source checkout:

```sh
pnpm install --frozen-lockfile
pnpm exec mioon --help
# Equivalent launchers, without a global install:
pnpm cli --help
node apps/cli/src/index.mjs --help
```

`mioon` is the bin of `@mioon/cli`. These instructions do not install globally, edit your agent configuration, open accounts, or enable paid generation.

## Connect securely

Choose one connection mode in the environment of the CLI process.

### Electron

Start the desktop app. Set `MIOON_CONNECTION_FILE` to its owner-only `mcp-connection.json` descriptor (see [DESKTOP.md](DESKTOP.md) for the userData location). Do not set direct credentials in this mode.

```sh
export MIOON_CONNECTION_FILE='/absolute/path/to/userData/mcp-connection.json'
pnpm exec mioon doctor
```

Every HTTP request re-reads the descriptor and adjacent private token, checks the running PID and local origin, and follows token/port rotation after a desktop restart. A disappeared descriptor returns a safe connection error; no fallback backend is selected.

File-based credentials also require a current-user-owned private parent directory, bounded regular single-linked files and a safe canonical ancestry. A `0600` token directly inside a broadly accessible parent is refused. There is no automatic permission repair or fallback to another token. See [private storage and recovery](PRIVATE-STORAGE.md), including the explicit Windows ACL readiness blocker.

### V4.1 渠道对应的连接文件

正式版 ID 为 `app.starroy.mioon`，开发版 ID 为 `app.starroy.mioon.dev`，包括打包后的开发版。Linux 默认连接文件分别为 `$HOME/.config/app.starroy.mioon/mcp-connection.json` 与 `$HOME/.config/app.starroy.mioon.dev/mcp-connection.json`；macOS 对应 `$HOME/Library/Application Support/` 下的同名目录。实际位置受 Electron appData / `MIOON_DESKTOP_USER_DATA` 影响。JSON/TOML 中使用展开后的绝对路径。

源码默认构建开发版。两个渠道独立运行、轮换令牌；客户端只连明确配置的那一个，不自动猜测或回退。旧 `video-workbench/` 数据及历史连接配置保留；迁移项目后需手动把客户端连接路径改为目标渠道，详见 [数据迁移](DESKTOP.md#数据位置与单实例)。descriptor 的 `appId` / `channel` 是附加非敏感元数据，协议版本仍为 1。

### Direct Web backend

Start the normal backend separately (`pnpm dev`). Point to its existing owner-only token file rather than copying a token into a shell command, process argument, or agent prompt:

```sh
export MIOON_BASE_URL='http://127.0.0.1:4318'
export MIOON_TOKEN_FILE='/absolute/path/to/mioon/data/access-token'
pnpm exec mioon doctor
```

The token file must be a small regular file owned by the current user and, on POSIX, readable/writable only by that user (`0600`). Symlinks are rejected. Direct token files are re-read for each request. Only `http://127.0.0.1` or `http://localhost` origins are allowed, with no URL credentials, path, query, fragment, or redirects.

Legacy `MIOON_TOKEN` environment configuration still works, with default origin `http://127.0.0.1:4318`. Legacy explicit token configuration takes precedence over a desktop descriptor, preserving V3 behavior; avoid mixing modes. `MIOON_TOKEN_FILE` cannot be combined with `MIOON_TOKEN`, and a descriptor cannot be mixed with direct token-file/base-URL configuration. There is deliberately no `--token` option. Provider API credentials belong only in the separately authorized backend configuration, never CLI inputs or agent config.

## Discover and invoke

Every invocation writes one JSON envelope to stdout, including help and errors:

```json
{"ok":true,"data":{}}
```

```json
{"ok":false,"error":{"code":"VALIDATION_ERROR","message":"...","details":{},"retryable":false}}
```

Progress and concise diagnostics go only to stderr. A wrapper should use the process exit code and parse stdout; it should never parse human stderr. No logs include connection tokens or private credential paths.

```sh
mioon --help
mioon --version
mioon doctor
mioon capabilities
mioon schema
mioon schema generation.submit
mioon generation submit --help
```

`--help`, `--version`, and `schema` work offline. `doctor` authenticates against the backend and reports safe readiness metadata and provider capabilities; it neither submits generation nor exposes secret locations. `capabilities` returns the current `provider.list` data, including legacy fields and per-model `modelCapabilities`. Use enabled/configured/model constraints from that response rather than assuming a provider is ready. Production discovery also includes exact `inputProfiles`, server API region and dated lifecycle evaluations; inspect [model input limits](GENERATION-INPUT-LIMITS.md) before submitting. These fields are not client overrides. Current provider IDs are `mock`, `runway`, `ark`, `veo`, `minimax`, and `vidu`; live providers stay disabled without explicit backend opt-in and an authorized budget.

`schema [operation]` converts the actual exported Zod input schema to JSON Schema. It returns the operation, natural command, MCP tool name, description, `inputSchema`, `requiresRequestId`, and explicit advisory `effects`. Custom refinements (such as rectangle containment) still run in the shared Zod validator even where JSON Schema cannot represent them. Effects describe direct and scheduled work; they never authorize a call or waive required approval. Missing effect coverage is an error, not a suffix-based safety guess.

Every shared operation is available in either form:

```sh
mioon project create --input '{"name":"Agent demo"}'
mioon rpc project.create --input '{"name":"Agent demo"}'
mioon timeline track add --input-file ./track-request.json
cat ./request.json | mioon generation submit --input -
```

The command covers projects, assets, shots, canvas nodes/edges, providers, generation, jobs, versions, timeline tracks/clips, and exports automatically from the contracts. `--input-file` and `--input -` read only explicitly requested client-side input. `--input` and `--input-file` are mutually exclusive. Unknown fields, including nested fields, are rejected. `--json` may be specified but JSON is already the default.

### Inspect without creating a timeline

The four `.inspect` operations return bounded, allowlisted metadata without
writing project state or reading/processing media. Replace the illustrative UUID
with the selected project's actual ID:

```sh
mioon schema project.inspect
mioon project inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
mioon asset inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":10}'
mioon shot inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":25}'
mioon timeline inspect --input '{"projectId":"11111111-1111-4111-8111-111111111111"}'
```

Only asset/shot inspection accepts optional `limit` (integer 1–25, default 10)
and `cursor` (opaque string, at most 512 characters). Use only a returned
`nextCursor`, unchanged, for the same project, operation and limit. Restart pagination after
a backend restart invalidates the cursor. No request ID is required. All inputs
are strict, including rejection of credentials, paths and authority overrides.

Inspection does not return structured paths, media URLs or bytes, and does not
start generation or rendering. Shot `prompt` fields are excerpts of at most 1000 UTF-8
bytes with an explicit `promptTruncated` flag. User-authored text remains untrusted and
may contain URL-like strings. `timeline inspect` reports an absent timeline
without initializing it. By contrast, legacy `project get` and `timeline get`
retain their original responses and can create an empty timeline on first read;
their effect metadata is not read-only. See [Agent inspection](AGENT-INSPECTION.md)
for result contracts and scope boundaries. Built-in Agent uses the same reads
under [separate bounded run consent](AGENT-READ-TOOLS.md); a CLI call does not
start or authorize an Agent conversation.

Built-in Agent proposal review is a separate authenticated application workflow,
not a new CLI operation. External clients continue to use the shared authorized
`shot update` contract with their own retained replay key. See
[reviewed selected-shot edits](AGENT-EDITS.md) for its bounded scope and status.

The `effects` fields also describe managed-file writes, local subprocesses,
external/provider I/O and potentially paid new generation. `job reconcile`
contacts the existing provider task and can resume download/publication;
`export create` and `timeline render` can later run local FFmpeg. Effect metadata
does not change stable-request replay, current-revision checks or user approvals.

### Connect a real first-frame input

Visual `edge create` links never feed generation. Use the shared typed operations instead:

```sh
mioon schema reference.attach
mioon reference attach --input '{"projectId":"PROJECT_UUID","sourceNodeId":"IMAGE_NODE_UUID","targetShotId":"SHOT_UUID","expectedSourceRevision":1,"expectedShotRevision":1,"requestId":"first-frame-attach-001","role":"first_frame"}'
mioon reference detach --input '{"projectId":"PROJECT_UUID","edgeId":"EDGE_UUID","expectedShotRevision":2,"requestId":"first-frame-detach-001"}'
```

Replace placeholders and revisions with the current `project get` results. The source must be an image node referencing an imported managed asset in the same project. A shot with a manual reference selection requires an explicit clear/save first; never automatically discard a user's choice. One first-frame connection is supported. Connected references cannot be changed with `shot update` or deleted with `edge delete`; use the revision-safe detach. Detach preserves the source image and historical generation snapshots. Source-node assets cannot be replaced through `node update`.

Attach/detach both need a caller-owned request ID. After an uncertain response, replay the exact original operation and input, including its original revisions. The response is the original saved result, not a fresh project read, even after the connection was removed or the backend restarted. Refresh before another edit. MCP exposes the identical `reference_attach` and `reference_detach` schemas and behavior. Attaching neither generates nor uploads media; per-model support and live authorization are checked when submitting generation.

## Local image generation and review preparation

Image commands use the same backend and schema catalog:

```sh
mioon image profile list
mioon schema image.generate
mioon image generate --input-file ./image-request.json
mioon image request get --input '{"projectId":"PROJECT_UUID","requestId":"image-opening-0001"}'
mioon image task get --input '{"projectId":"PROJECT_UUID","taskId":"TASK_UUID"}'
mioon image version list --input '{"projectId":"PROJECT_UUID","groupId":"GROUP_UUID"}'
mioon schema image.review.prepare
mioon image review prepare --input-file ./image-review.json
mioon image review get --input '{"projectId":"PROJECT_UUID","reviewId":"REVIEW_UUID"}'
mioon image review list --input '{"projectId":"PROJECT_UUID","limit":20}'
```

Replace placeholders with actual IDs. The direct `image generate` example is
for local deterministic Mock PNG generation. New OpenAI requests cannot be
approved through the CLI. Dedicated Images settings and explicit UI approval
are now implemented. The 461-test affected gate, fresh builds and Linux native
synthetic-network acceptance passed; the independent final full suite passed
(2758 total, 2756 passed, 0 failed, 2 skipped). This is not live-provider or macOS/Windows acceptance evidence. No real
provider call is authorized for this acceptance increment.

A review file contains exactly `{input:<complete OpenAI image.generate input>,
settingsRevision:<current positive settings revision>}`. Obtain that revision
from the dedicated Images settings UI; do not guess it. The complete nested
`input` retains the existing stable `requestId`, prompt/project, pinned model,
fixed options and optional group/revision pair. There is no top-level request
key, approval flag, key input or destination override. Prepare only retains this
immutable intent locally. Get/list read retained reviews; none dispatches or
charges. Only the user's explicit application paid/review button may continue
this workflow. There is no CLI approval/rejection or Images credential command,
and raw authenticated HTTP access does not grant authority to bypass that UI.

Review get takes exactly `{projectId,reviewId}`. List takes
`{projectId,limit?,cursor?}` and returns `{projectId,items,nextCursor}`, default
20/max 50 records. Retain returned cursors unchanged with the same project and
limit; backend restart invalidates them. Review requests/prompts are plain local
SQLite: the intent limit is 32 KiB, row limit 64 KiB, retention 1000/project and
10,000/workspace without cleanup. The nested generation input remains 24 KiB.
Exact prepare repeats retain the same identity/current state; changed content
or settings revision under its key conflicts.

See [Image generation](IMAGE-GENERATION.md) and
[Images activation](IMAGE-ACTIVATION.md) for exact inputs, review DTOs and limits.
Image discovery is `image profile list`, separate from video `capabilities`.
Enabled means local configuration is present, not live verification or permission
to spend. The `image.generate` effects conservatively include separately approved
paid/external worker work; prepare is local-database-only, get/list read-only.
These effects do not grant agents approval authority.

Retain the complete request/key; lookup never generates and exact replay returns
the original queued receipt rather than current task state. Never automatically
reapprove, resubmit or replace a key after an unknown outcome or restart.
Explicit `image task cancelQueued` only cancels undispatched/interrupted work.
`image task recoverResult` only republishes eligible task-bound staged local
bytes; neither is a provider retry. Preserve these camel-case command words.
There is no image-specific `watch` shortcut. Poll the existing task explicitly;
timeout or Ctrl+C does not cancel it. Full prompt text is retained locally and
returned to authenticated readers; never put credentials in prompts or files.

## Safe mock workflow

The following commands show the contract. Replace UUID placeholders with IDs returned by previous commands. Preserve each complete intended mutation request in a JSON file before submitting it.

```sh
mioon project create --input '{"name":"Offline mock video"}'
mioon asset import --file ./reference.png --input '{"projectId":"PROJECT_UUID"}'
mioon shot create --input '{"projectId":"PROJECT_UUID","requestId":"demo-create-shot-001","title":"Opening","prompt":"A calm opening shot","referenceAssetIds":["ASSET_UUID"],"aspectRatio":"9:16","duration":2}'
mioon generation submit --input '{"shotId":"SHOT_UUID","expectedRevision":1,"requestId":"demo-shot-001-v1","providerId":"mock"}'
mioon job watch --input '{"jobId":"JOB_UUID"}' --timeout-ms 60000 --interval-ms 500
mioon version list --input '{"shotId":"SHOT_UUID"}'
mioon project get --input '{"projectId":"PROJECT_UUID"}'
mioon version select --input '{"shotId":"SHOT_UUID","versionId":"VERSION_UUID","expectedRevision":2,"requestId":"demo-select-version-001"}'
mioon timeline get --input '{"projectId":"PROJECT_UUID"}'
mioon timeline seed --input '{"projectId":"PROJECT_UUID","expectedRevision":1,"requestId":"demo-seed-001-v1"}'
mioon timeline render --input '{"projectId":"PROJECT_UUID","expectedRevision":2,"requestId":"demo-render-001-v1","purpose":"export"}'
mioon export watch --input '{"exportId":"EXPORT_UUID"}' --timeout-ms 60000
mioon export download --input '{"exportId":"EXPORT_UUID"}' --output ./agent-result.mp4
```

Revisions above are illustrative for a fresh, otherwise unmodified project. Read the current shot revision from `project get` immediately before `version select`; the first successful generation can auto-select a version and increment the shot revision. Timeline revisions are independent of shot/project revisions; read `timeline get` before new timeline edits. A stale revision is a conflict, never an automatic overwrite.

For simple shot-order export use `export create` with `projectId` and a stable `requestId`; use `export watch` and `export download` on the returned export ID. `timeline render` freezes the independent multitrack timeline. The returned media URL is a relative authenticated local resource, not a public sharing URL.

### Replace one fixed clip source

Discover `mioon schema timeline.clip.replaceSource`, then read the current
`timeline get` state and confirm the intended replacement asset. The exact CLI
command preserves the operation's camel-cased final word:

```sh
mioon timeline clip replaceSource --input '{"projectId":"PROJECT_UUID","clipId":"CLIP_UUID","assetId":"REPLACEMENT_ASSET_UUID","expectedRevision":7,"requestId":"replace-clip-0001"}'
```

Substitute actual UUIDs and the current timeline revision. `projectId`,
`expectedRevision`, `requestId`, `clipId` and `assetId` are required.
`versionId` is optional: supply the exact matching generated version only when
intending to pin that version and its shot. An asset-only request does not infer
version provenance; existing source links are cleared. Later shot version
selection cannot change the fixed clip. `timeline clip update` still rejects
source fields in its patch.

Only video→video, audio→audio or image→image is supported. The clip's ID, name,
track, timing, source in-point, rectangle, gain and optional fades remain exact.
A short/incompatible replacement or one without required fade audio rejects;
nothing is automatically clamped or moved. Choosing the current asset is a
`SOURCE_UNCHANGED` conflict with no history entry. A successful replacement is
one undoable edit and returns the entire revised timeline.

Use a mandatory stable key (8–200 characters), either in JSON or via
`--request-id`; the CLI never invents one. Retain the exact request, including
version presence/absence, after a lost result. Replay the same input/key after
restart to recover the original response; changed reuse conflicts and a new
key with an old revision is stale. Malformed or mismatched success data remains
an uncertain `BACKEND_PROTOCOL_ERROR`; preserve the original request/key.
For rejected recovery, only matching `mutationOutcome:"not_applied"` and
`requestId` prove no mutation. Ownership/receipt errors or a later 4xx without
that proof do not settle a previous uncertain request.
Keys use the existing backend-wide timeline
namespace shared by edits/history/renders, not a new workspace-global namespace
for all operations. This edit performs only local timeline/history/replay
writes, with no media processing or provider calls. Full errors and semantics:
[Explicit clip source replacement](API.md#explicit-clip-source-replacement).

### Clip audio fades

Use existing `timeline clip add` or `timeline clip update` commands; inspect
`mioon schema timeline.clip.add` / `mioon schema timeline.clip.update` first.
For an existing 120-frame confirmed-audio clip, after reading its current
revision:

```sh
mioon timeline clip update --input '{"projectId":"PROJECT_UUID","clipId":"CLIP_UUID","expectedRevision":7,"requestId":"clip-fades-0001","patch":{"fadeInFrames":15,"fadeOutFrames":30}}'
```

Replace the IDs/revision with current values. Both fields are optional integer
30fps frame counts, 0–18000; each and their sum must fit the resulting clip
duration. Missing fields mean zero for legacy clips; omitting a field in an
update leaves it unchanged. Set a field to zero to clear it. Positive fades
require an audio/video asset with `hasAudio:true`; no audio is inferred from its
file extension. Duration and fade changes can be submitted in one patch.

`timeline clip split` allows plateau positions and exact fade boundaries, while
still requiring an interior clip frame. Cuts inside a ramp reject with
`SPLIT_FADE_BOUNDS` and leave history unchanged. Successful splits retain the
outer envelopes and zero present inner-edge fields. Rendered preview/export
applies the fades; original-source playback remains dry. This uses the same
revision and stable-key recovery as other timeline edits: preserve the exact
request after a lost response, including the original fade values and revision.
Full bounds and rendering semantics: [Timeline audio fades](TIMELINE.md#audio-fades).

### Local imports and downloads

`asset import --file` reads local bytes in the CLI process, infers supported MIME type from the extension, and defaults the display name to the basename. Pass `name` or `mimeType` in JSON to override those defaults. Maximum input is 30 MiB. Only bytes, display name, MIME type, and project ID are sent. No local path is sent or accepted as a server-side file import. `--file` and `dataBase64` are mutually exclusive.

Downloads support either the export ID or an existing managed asset ID:

```sh
mioon asset download --input '{"assetId":"ASSET_UUID"}' --output ./reference-copy.png
mioon export download --input '{"exportId":"EXPORT_UUID"}' --output ./result.mp4 --timeout-ms 60000 --max-bytes 536870912
```

Only UUID managed-media endpoints on the selected backend are fetched, redirects are refused, and the output path never reaches the server. Creation is exclusive: existing output files and symlinks are never overwritten. Interrupted/failed partial files are removed. The default size limit is 512 MiB; `--max-bytes` can be set up to 2 GiB. An export must already have succeeded.

## Idempotency, recovery, and watch

`shot create/update/reorder`, `node create/update`, and `version select` accept
optional stable request IDs (8–200 characters), through JSON `requestId` or the
existing `--request-id` option. Omission remains valid legacy behavior and offers
no exact-replay guarantee. Preserve a supplied key and the original complete
input, including its original revision, after uncertain output. Exact replay
returns the saved original response; refresh before a later new edit. Changed
operation/project/input under the same key conflicts. The schema's
`requiresRequestId` and effect `idempotent` remain false because the key is
optional; notes explain conditional replay. See [MUTATION-REPLAY.md](MUTATION-REPLAY.md).

The CLI never invents request IDs and never retries submissions automatically. All shared operations that require `requestId` reject an omitted ID locally, before HTTP. You can put it in the exact JSON request or use `--request-id`; specifying conflicting values is an error.

- An uncertain HTTP result may have committed. Re-run the **exact original operation and input with the same requestId**, including original revision and parameters. Do not replace the request ID.
- Changed reuse of a request ID returns a conflict. A genuinely new intended edit needs a new request ID and a current revision.
- Timeline exact replay returns its original response, which may be older than the current timeline. Refresh before deciding another edit.
- `job retry` is an explicit new attempt for a clearly failed job and requires a new caller-owned request ID. Never run it automatically for paid generation.
- `submission_unknown` means the provider may already have accepted and charged for a job. Inspect `job get`; use `job reconcile` only as the appropriate recovery action. Do not resubmit with another ID.
- `job cancel` is a separate explicit RPC action that stops backend local waiting. It does not promise remote cancellation or a refund.

`job watch` and `export watch` only poll `get`. Default timeout is 60 seconds, maximum 24 hours; default poll interval is 500 ms, allowed interval 20–60000 ms. The deadline also bounds a hanging HTTP poll. Watch returns the final succeeded record or a structured failure/timeout/interruption; it never retries, reconciles, submits, or cancels remotely. Ctrl+C stops only the local wait. Start another watch with the same ID to resume observing.

### Stable exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected internal client failure |
| 2 | Invalid command/input/schema or local input-file problem |
| 3 | Revision/idempotency conflict or an existing download output |
| 4 | Connection configuration, authentication, unavailable backend, or invalid backend protocol |
| 5 | Request/watch/download timeout |
| 6 | Business/provider rejection or terminal failed/cancelled operation |
| 130 | Interrupted locally (Ctrl+C/SIGTERM); no remote cancellation |

## Standalone agent use

An agent with shell access can invoke the repository-local bin or the absolute Node entrypoint, with the same private-file environment. No installation into `~/.codex`, no global CLI installation, and no second database are needed. For tool-native integration use the [MCP setup examples](MCP.md), including standalone Codex and Claude Code configuration.

Offline acceptance tests use actual CLI subprocesses, the official MCP SDK stdio client, isolated backends, mock generation, and real local FFmpeg output. No live provider credentials or paid calls are used:

```sh
pnpm test:cli
node --test tests/mcp-v4.test.mjs tests/mcp-discovery.test.mjs
```

### Saved source ranges

Use `mioon asset range get --input <JSON>` and `mioon asset range set --input <JSON>`
(or `rpc asset.range.get/set`). Inspect their current schemas first. Get requires
`projectId` and `assetId`; set additionally requires the independent range
`expectedRevision`, caller-retained `requestId`, and integer `inFrame`/`outFrame`.
No key is invented and no write is automatically retried. The out point is
exclusive in the fixed 30-fps editing timebase. To add a saved selection, copy
those confirmed values into ordinary `timeline clip add` with its separate
revision and key; later marks do not change that clip. See
[SOURCE-RANGES.md](SOURCE-RANGES.md) for bounds, replay scopes and limitations.

### Review asset dispositions

Use `mioon asset disposition list --input <JSON>` and
`mioon asset disposition set --input <JSON>` (or the equivalent `rpc` operation).
Discover their strict inputs with `mioon schema asset.disposition.list` and
`mioon schema asset.disposition.set` before writing.

List takes `{projectId,assetIds}` with 1–100 unique UUIDs and returns
`{projectId,items}` in that exact order. Each item is
`{id:assetId,assetId,projectId,revision,disposition}`. Missing metadata reads as
neutral/revision 0 without creating it; any missing/foreign asset fails the
whole batch without a partial result.

Set takes `{projectId,assetId,expectedRevision,requestId,disposition}`. Use the
item's independent revision and `neutral`, `favorite` or `rejected`. A stable
8–200-character key is mandatory, supplied in JSON or via `--request-id`; the
CLI neither creates it nor retries automatically. Retain the complete request
and repeat it exactly after an uncertain result, even after restart or newer
edits. A historical response is not latest state; list before a new intent.
Neutral reset advances and retains the revision. Keys collide across all eleven
shared local mutations, while timeline/reference/generation journals remain
separate. Existing asset DTOs, original files and in-use clips do not change.
Built-in Agent context/tools are unchanged. Browser UI pending receipts are
session-only; CLI users must keep their own recovery identity. See
[asset dispositions](ASSET-DISPOSITIONS.md).

### Opt-in source waveforms

```sh
mioon schema asset.waveform.request
mioon schema asset.waveform.get
mioon asset waveform request --input '{"projectId":"11111111-1111-4111-8111-111111111111","assetId":"22222222-2222-4222-8222-222222222222"}'
mioon asset waveform get --input '{"projectId":"11111111-1111-4111-8111-111111111111","assetId":"22222222-2222-4222-8222-222222222222","sourceStartFrame":0,"sourceEndFrame":60,"points":256}'
```

Replace the illustrative UUIDs with the intended project's owned asset. Request
starts bounded local analysis only on explicit opt-in and takes optional
`retry:false`. Ordinary duplicate requests reuse queued/running/ready work.
After a lost acknowledgement, get the current cache state first; use
`"retry":true` explicitly for an interrupted or failed attempt. There is no
`requestId`, automatic retry, or immutable historical mutation receipt. Retained
ready cache survives restart; startup does not restart unfinished work. Eviction
can make a later read missing, and rebuilding requires another explicit request.

Get takes an optional 30fps source range with inclusive start (default 0),
exclusive end (default source end), and `points` 1–2048 (default 512). Start is
0–17999, end is 1–18000 and must exceed start and fit the source. Reads never
probe, decode, repair/write cache, touch access times or create a timeline.
Responses report missing/queued/running/ready/interrupted/error/unsupported;
ready reads include normalized 0–1 raw source peaks, or null for a display bin
wholly outside actual decoded coverage. `decodedSampleFrames` records actual
48kHz coverage while duration/sourceFrames retain the asset source clock; no
stretching or fabricated silent tail. They do not include source
paths/hashes or reflect rendered gain, mute or fades. Request runs local media
subprocesses and writes derived SQLite only; no external service or paid
provider is involved. Source, queue and cache limits and full response fields:
[Source waveforms](API.md#opt-in-source-waveforms). Built-in Agent tools and
context remain unchanged.

### Local timeline export preflight

Discover and explicitly check the intended existing revision before a separate
export decision:

```sh
mioon schema timeline.export.preflight
mioon timeline export preflight --input '{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":4}'
# Equivalent generic dispatch:
mioon rpc timeline.export.preflight --input '{"projectId":"11111111-1111-4111-8111-111111111111","expectedRevision":4}'
```

Both forms accept only a project UUID and positive integer timeline revision;
no paths, credentials, commands, request key or export options are accepted.
The command streams managed source hashes and runs bounded local ffprobe
metadata checks. It never creates a timeline, export or cache, writes SQLite
or output files, fully decodes media, or contacts providers. Output remains
720×1280 at 30fps. Limits are 100 assets, 512MiB/source, 1GiB total hashed bytes,
30 seconds and 128 issues. The ordinary success envelope can contain any of
`ready`, `blocked`, `incomplete` or `stale`; check `data.status`, not just the
process exit code. `checks.fullDecode` is always false.
Checks may stop at the first blocking/incomplete condition; `checkedAssets`
reports completed coverage, and `issues` is not an exhaustive source audit.
This command's shared client has a 35-second default HTTP deadline for the
backend's 30-second analysis budget plus best-effort child cleanup; other
commands retain their existing 30-second default. These are not hard real-time
filesystem/event-loop guarantees. Ctrl+C stops observation; no automatic POST
retry or export follows. The shared client rejects malformed reports.
Preflight ownership metadata has an aggregate 4MiB/1024-record safety bound; budget
exhaustion reports `incomplete`/`PREFLIGHT_SNAPSHOT_BUDGET` with no digest until
ownership is verified. Before file I/O, rendering verifies each distinct
clip/source lineage independently with the same per-lineage safety bound,
without a whole-composition metadata ceiling. Many independent valid sources
can therefore render despite incomplete aggregate preflight. This per-lineage
security bound also constrains rendering; preflight file/time caps do not.

`ready` means no known blocker at the check time, not guaranteed future media
availability. Fix known blockers, refresh stale state, and disclose incomplete
checks. A cap/timeout is `incomplete`, not a failed export or automatic export
ban; the user can explicitly choose to try. Preflight alone never queues work.
See the [strict report contract](API.md#local-timeline-export-preflight).

For an authorized export, pass a non-null report `snapshotHash` unchanged as
`preflightSnapshotHash` with the report's project/revision and a fresh retained
render request key. For example, replace the placeholders with actual values:

```sh
mioon timeline render --input '{"projectId":"PROJECT_UUID","expectedRevision":4,"requestId":"approved-export-0001","purpose":"export","preflightSnapshotHash":"REPORT_SHA256"}'
```

The digest is optional, exactly 64 lowercase hexadecimal characters, and has no
default. Legacy omission preserves the old input and response. New renders
validate a supplied digest; exact replay returns its original response first.
For an `incomplete` report without a digest, obtain a separate explicit decision
to try the current saved timeline without completed preflight. Refresh its
project/revision, use a fresh render key, and omit `preflightSnapshotHash`.
Label the one-use attempt as unchecked; never invent a digest or silently
fall back from a checked export. Known blockers/error issues or stale reports
require attention first. The worker still verifies ownership and media.
After uncertainty, replay the whole exact render request with its original
revision, digest (or original omission), and key. Never generate a new key just
because observation failed. Watch/download the existing export as usual.
This external command adds no built-in Agent tool or media context.

### Timeline recovery validation

The shared client validates all eleven timeline-write acknowledgements, including
undo/redo and render. Invalid success is `BACKEND_PROTOCOL_ERROR` with the original
request identity and uncertainty guidance; no POST is automatically retried.
Timeline/reference 4xx errors without a matching rollback proof are also
ambiguous. Preserve the original operation/input/key, inspect state, then explicitly
replay those exact bytes. A new request ID is a new intent, never a recovery method.
Valid old responses and command schemas remain unchanged. See
[TIMELINE-RECOVERY.md](TIMELINE-RECOVERY.md).

### Reference acknowledgement recovery

`reference attach` and `reference detach` now validate the complete historical
shot/typed-edge response, preserving valid existing-binding no-ops and detached
edge replays. Invalid success retains the original request as unknown. A fresh
rollback proof must match this operation, project and request ID; generic errors
never justify a replacement key. Commands, successful wire shapes and journal
namespace are unchanged. See [reference recovery](REFERENCE-RECOVERY.md).

### UI task discovery boundary

The new [durable UI task slice](TASK-RECOVERY.md) covers ten non-rendering timeline
edits and two reference operations. The implemented subject extension adds exactly
`subject.create`, `subject.version.add` and `subject.binding.set`, for fifteen
operations in total. It adds no CLI task-execution command and
does not change existing command inputs, original receipts or journal key scopes.
CLI callers must continue retaining their complete original request and key.
Native UI restart discovery does not imply durable storage of arbitrary external
client requests, generation submissions or timeline render intentions.

### Local versioned subject library

This narrow increment is implemented. Focused checks, final web/desktop builds
and Linux native acceptance passed; the independent full-suite release gate
passed. Discover current shared schemas before using it. The commands map directly to
`subject.create`, `subject.version.add`, `subject.binding.set`, `subject.list`,
`subject.version.list` and `subject.binding.list`:

```sh
mioon schema subject.create
mioon schema subject.binding.set
mioon subject list --input '{"projectId":"PROJECT_UUID","limit":20}'
mioon subject create --input '{"projectId":"PROJECT_UUID","kind":"product","name":"Hero product","assetId":"IMAGE_ASSET_UUID","requestId":"subject-create-0001"}'
mioon subject version list --input '{"projectId":"PROJECT_UUID","subjectId":"SUBJECT_UUID","limit":20}'
mioon subject version add --input '{"projectId":"PROJECT_UUID","subjectId":"SUBJECT_UUID","expectedRevision":1,"assetId":"NEW_IMAGE_ASSET_UUID","requestId":"subject-version-0001"}'
mioon subject binding list --input '{"projectId":"PROJECT_UUID","shotId":"SHOT_UUID","limit":20}'
mioon subject binding list --input '{"projectId":"PROJECT_UUID","subjectId":"SUBJECT_UUID","limit":20}'
mioon subject binding set --input '{"projectId":"PROJECT_UUID","shotId":"SHOT_UUID","subjectId":"SUBJECT_UUID","role":"subject","subjectVersionId":"CHOSEN_SUBJECT_VERSION_UUID","expectedRevision":0,"expectedSubjectRevision":2,"requestId":"subject-binding-0001"}'
```

These are templates, not a blind replay script. Replace IDs, revisions and keys
with the intended project's current state. `kind` is `character`, `product`,
`location` or `look`; name is nonblank and 1–120 characters. Use an existing owned
managed PNG/JPEG/WebP asset: these commands neither import nor copy bytes.
Create returns a subject with immutable version 1; version-add returns its new
head and revision. The head's current asset is rejected as `SUBJECT_NO_CHANGE`.

Bindings use `style` for `look`, `subject` for other kinds, and at most eight
active rows per shot. `expectedRevision` is the binding's independent revision,
not the shot's; 0 is valid only before that binding identity exists.
`expectedSubjectRevision` always checks the current subject head. To adopt latest,
set `subjectVersionId` to its current head. To keep an older selection while
acknowledging latest, explicitly set the same older version with both current
revisions and a new key. Both save the current `reviewedHeadVersionId` and clear
`needsReview`; later head changes can flag active rows again. To unlink, explicitly
set `subjectVersionId:null`. A clear retains a revisioned tombstone; use that
revision for later reattachment. No choice changes provider inputs or existing clips.

All lists return `{projectId,items,nextCursor}`. Default page size 20, maximum 50;
binding-list requires exactly one shot or subject filter and includes cleared
rows. Reuse only the returned cursor (maximum 768 characters), same scope/filter/
limit; restart invalidates cursors. Cross-page results are not a frozen snapshot.
Frozen version metadata takes its hash from the existing asset record without
rehashing or probing media. Provenance exposes only backend-validated local IDs
and metadata, not paths, URLs or provider task IDs. DTOs: [subject library](SUBJECT-LIBRARY.md).

Every write requires a caller-retained 8–200-character key. The subject companion
joins the existing eight local mutation operations as operations nine through
eleven; timeline/reference/generation/export keys keep their separate scopes.
After uncertainty, preserve the exact operation/input/key, including both original
revisions, and explicitly replay it. An old success is historical; refresh before
a new intent. Malformed success and generic 4xx remain unknown without matching
operation/project/request rollback proof. The CLI never invents keys or retries.

The three writes are also the only additions to the UI durable allowlist, now
fifteen, under `subject:mutation`. Direct CLI requests do not automatically become
UI tasks. Local metadata is ordinary SQLite, not vault-encrypted: keep secrets out
of names and inputs. This is local planning without provider calls, paid work,
Blender or built-in Agent catalog/context changes. Actual `first_frame` continues
through `reference attach`; last-frame/motion support is future work.
