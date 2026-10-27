# MCP agent integration (V4)

工作区开关、应用内备份、任务处置和导出控制已进入官方工具发现与四语言描述，见[工作区设置](WORKSPACE-SETTINGS.md)、[任务处置](TASK-DISPOSITIONS.md)和[导出控制](EXPORT-CONTROLS.md)。通过 `mioon_schema` 查询严格参数；这些管理操作不会自动成为Mio的模型工具

Mioon exposes an **official MCP SDK stdio server**. It talks to the same authenticated local HTTP operation layer as the Web app, Electron, and [CLI](CLI.md); it does not open a database or start another backend. Streamable HTTP MCP is not implemented or required. Start the normal backend or Electron separately before calling stateful tools.

Node.js 24+ and installed source workspace dependencies are required for this optional source bridge. The Electron app itself uses bundled Node, but it does not bundle a standalone MCP executable.

```sh
pnpm install --frozen-lockfile
node /absolute/path/mioon/apps/mcp/src/index.ts
# Existing compatibility entrypoint remains supported:
node /absolute/path/mioon/server/mcp.ts
```

The MCP client launches this command with the selected environment. Do not run it through a launcher that prints banners to stdout; stdout is exclusively the MCP wire protocol. The bridge can initialize and list tools while the backend is stopped. Calling `mioon_doctor` then explains readiness through a safe structured error.

## Connection modes

Prefer private connection files, not token literals in client configuration:

- **Electron:** `MIOON_CONNECTION_FILE=/absolute/path/to/userData/mcp-connection.json`. The desktop writes this descriptor and adjacent `mcp-token` atomically; both are owner-only and removed at graceful exit. See [DESKTOP.md](DESKTOP.md).
- **Direct Web backend:** `MIOON_BASE_URL=http://127.0.0.1:4318` and `MIOON_TOKEN_FILE=/absolute/path/to/data/access-token`. Start `pnpm dev` separately using the appropriate data directory.
- **Explicit token:** `MIOON_TOKEN` in the process environment is supported; avoid mixed configurations. No secret belongs in a tool argument, a URL, or command-line argument.

Connection files are read again on every HTTP request. A long-lived MCP process follows desktop restarts and direct token-file rotation without restarting itself. Files must be small regular files owned by the current user; POSIX permissions must be `0600` or stricter, and symlinks are rejected. Desktop token location must be beside the descriptor, with a live PID. Origins are restricted to local HTTP (`127.0.0.1` or `localhost`), and redirects, embedded URL credentials, paths, queries, and fragments are refused. No token or credential path is returned by doctor.

Q2 also validates the private parent directory and canonical ancestry and rejects multiply linked credentials. Existing unsafe files/directories are preserved rather than repaired or replaced. The standalone Node MCP entry point now explicitly initializes the complete, locally built [Node-API private-storage helper](../packages/node-host/README.md) on Windows, restricted to fixed local NTFS; missing or incompatible protection still fails closed. Current native acceptance covers Windows 11 ARM64 and does not certify Electron support or Windows distribution. See [private storage and recovery](PRIVATE-STORAGE.md); no new MCP authority or operation is introduced.

Do not mix a desktop descriptor with `MIOON_BASE_URL`/`MIOON_TOKEN_FILE`. Explicit `MIOON_TOKEN` takes precedence when no token file is supplied; `MIOON_TOKEN_FILE` plus `MIOON_TOKEN` is rejected. New setups should choose exactly one mode.

### V4.1 渠道对应的连接文件

正式版 ID 为 `app.starroy.mioon`，开发版 ID 为 `app.starroy.mioon.dev`，包括打包后的开发版。Linux 默认连接文件分别为 `$HOME/.config/app.starroy.mioon/mcp-connection.json` 与 `$HOME/.config/app.starroy.mioon.dev/mcp-connection.json`；macOS 对应 `$HOME/Library/Application Support/` 下的同名目录。实际位置受 Electron appData / `MIOON_DESKTOP_USER_DATA` 影响。JSON/TOML 中使用展开后的绝对路径。

源码默认构建开发版。两个渠道独立运行、轮换令牌；客户端只连明确配置的那一个，不自动猜测或回退。旧 `video-workbench/` 数据及历史连接配置保留；迁移项目后需手动把客户端连接路径改为目标渠道，详见 [数据迁移](DESKTOP.md#数据位置与单实例)。descriptor 的 `appId` / `channel` 是附加非敏感元数据，协议版本仍为 1。

## Standalone Codex configuration

This is a configuration example for the user's review, not an installer. No files under `~/.codex` are modified by this repository. In a trusted project, the user may place this block in a project-scoped `.codex/config.toml`. Replace the absolute paths:

```toml
[mcp_servers.video_workbench]
command = "node"
args = ["/absolute/path/mioon/apps/mcp/src/index.ts"]
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.video_workbench.env]
MIOON_CONNECTION_FILE = "/absolute/path/to/userData/mcp-connection.json"
```

For direct Web mode, replace the environment block with:

```toml
[mcp_servers.video_workbench.env]
MIOON_BASE_URL = "http://127.0.0.1:4318"
MIOON_TOKEN_FILE = "/absolute/path/to/mioon/data/access-token"
```

Codex documents project-scoped MCP configuration and the command/args/env fields in its [official MCP configuration guide](https://developers.openai.com/codex/mcp/). Respect client/workspace trust and tool approvals; do not bypass them. No persistent configuration has been applied by merely reading or testing these examples.

## Standalone Claude Code configuration

The user may review this project `.mcp.json` example and configure it in their own trusted project. Paths are placeholders, and no token value is stored:

```json
{
  "mcpServers": {
    "mioon": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/mioon/apps/mcp/src/index.ts"],
      "env": {
        "MIOON_CONNECTION_FILE": "/absolute/path/to/userData/mcp-connection.json"
      }
    }
  }
}
```

For direct Web mode, replace `env` with:

```json
{
  "MIOON_BASE_URL": "http://127.0.0.1:4318",
  "MIOON_TOKEN_FILE": "/absolute/path/to/mioon/data/access-token"
}
```

Claude Code's [official MCP guide](https://code.claude.com/docs/en/mcp) describes project `.mcp.json`, stdio commands, and the trust/approval flow. The user should review that flow and keep their normal approvals. These examples neither install globally nor modify an existing Claude Code configuration.

## Discovery and schema parity

`tools/list` is generated from the runtime schemas exported by `@mioon/contracts`; the identical converter powers CLI `schema`. Shared Zod validation, including nonempty patches and rectangle refinements, runs before a business call. Unknown fields are rejected instead of silently stripped. There is one implementation of business operations and one backend writer.

All RPC operation names replace dots with underscores. For example:

- `project_create`, `project_list`, `project_get`, `project_inspect`
- `asset_import`, `asset_list`, `asset_inspect`
- `shot_create`, `shot_update`, `shot_reorder`, `shot_inspect`
- `node_create`, `node_update`, `edge_create`, `edge_delete`
- `provider_list`, `generation_submit`
- `job_get`, `job_list`, `job_retry`, `job_cancel`, `job_reconcile`
- `version_list`, `version_select`
- `timeline_get`, `timeline_inspect`, `timeline_history_get`, `timeline_undo`, `timeline_redo`
- `timeline_track_add`, `timeline_track_update`
- `timeline_clip_add`, `timeline_clip_update`, `timeline_clip_remove`, `timeline_clip_split`, `timeline_clip_replaceSource`
- `timeline_seed`, `timeline_render`
- `timeline_clip_refreshSources`, `timeline_shots_append`
- `timeline_clip_splitAtScenes`
- `export_create`, `export_get`

Three additional read-only discovery tools are available:

- `mioon_schema({})`: all operation definitions, actual JSON Schemas, natural CLI commands, `requiresRequestId` flags, and advisory `effects`. `mioon_schema({"operation":"generation.submit"})` narrows to one operation. This tool works offline.
- `mioon_capabilities({})`: the current `provider.list` data, including per-model `modelCapabilities`, enabled/configured gates, supported durations/aspect ratios, and limits. It does not submit generation. Production discovery also includes exact model/region `inputProfiles` and server-dated lifecycle evaluations; unsupported roles never become tools or silently disappear. See [model input limits](GENERATION-INPUT-LIMITS.md).
- `mioon_doctor({})`: authenticated readiness, client/backend version metadata, connection mode, and provider capabilities. It does not return credential paths or token values.

Provider IDs currently include `mock`, `runway`, `ark`, `veo`, `minimax`, and `vidu`. Discover each configured provider's actual model options before use; adding an adapter does not authorize live generation or mean a credential is configured.

### Image tools
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



The shared catalog exposes `image_profile_list`, `image_generate`,
`image_request_get`, `image_task_get`, `image_task_list`, `image_group_get`,
`image_group_list`, `image_version_list`, `image_task_cancelQueued`,
`image_task_recoverResult`, `image_task_remote_get`, `image_task_observeRemote`,
plus exactly `image_review_prepare`, `image_review_get` and `image_review_list`. Preserve the camel case. Use
`mioon_schema` with the dotted name for the exact inputs and advisory effects.

Mock produces deterministic local 1024×1024 PNG test cards without synthesizing
the prompt. Fixed-OpenAI activation at `4e66a96` (2026-10-10) passed its
affected/build/Linux synthetic-native checks and full suite (2758 total,
2756 passed, 0 failed, 2 skipped). The current [custom Images increment](IMAGE-COMPATIBLE.md)
passed its own focused/build/Linux synthetic-native gates and full suite
(2857 total, 2855 passed, 0 failed, 2 skipped). These do not establish live-provider
or macOS/Windows acceptance. Image discovery is
separate from video `mioon_capabilities`; enabled means local configuration is
available, not verified output, compatibility or spending permission.

- `image_review_prepare` takes exactly
  `{input:<complete official/custom/local-ComfyUI image.generate input>,settingsRevision}`. The positive
  settings revision can be discovered by `image_profile_list` with
  `{"includeSettingsRevision":true}`. Use only the selected provider item's
  positive `settingsRevision`; Mock/missing/invalid/unreadable values are omitted.
  No endpoint/keys/settings are exposed, and the read never probes, decrypts,
  prepares or approves. Empty input (or false) keeps the legacy response unchanged.
  This is freshness metadata, not authority; changed settings still fail existing
  CAS. The original stable `requestId` is nested in `input`. Preparation only writes a retained
  immutable intent to local SQLite. It neither approves nor creates a task.
- `image_review_get` takes `{projectId,reviewId}` and returns an existing owned
  review. `image_review_list` takes `{projectId,limit?,cursor?}` and returns
  `{projectId,items,nextCursor}`, default 20/max 50. Both are read-only. Pass
  returned cursors unchanged with the same project/limit; restart expires them.
- The generation request/receipt shapes stay unchanged, with additive provider
  `openai-compatible` and the configured custom ASCII model. No secret, approval
  flag, raw executor or endpoint is a tool argument. New direct official/custom/local-ComfyUI
  `image_generate` is blocked; accepted exact replay only returns its receipt.
- Custom review DTOs add the backend-retained full immutable `configuration`
  and use its actual `destination`; official v1 DTOs remain unchanged. See the
  [exact custom prepare example](IMAGE-COMPATIBLE.md#public-request-preparation-private-paid-approval).

Settings and approve/reject routes are private authenticated application actions,
not MCP/CLI/model tools. The user approves the exact visible project/prompt/model/
options/destination and at most one POST from the application. Official/custom
fees are usage-based and unknown; local ComfyUI has unknown local compute cost.
This is not a currency cap or a per-image budget wizard. Local
session authentication is not cryptographic proof of a human click; knowing a
route/token does not authorize an external agent to approve. Built-in Agent
catalogs and paid-generation authority do not expand.

Effects now conservatively mark `image_generate` as possible external/paid,
open-world work with database/file writes but no local subprocess, covering
separately approved worker activity. `image_review_prepare` is idempotent,
non-destructive and local-database-only; review get/list have read-only effects.
Annotations are advisory, never permission to spend.

A successful generate result is the original queued receipt; read
`image_task_get` for the current result and `image_request_get` after lost ACK or
restart. Never automatically reapprove, resubmit or replace the uncertain key.
An uncertain `image_review_prepare` response retains its nested `input.requestId`
and exact-input replay guidance, including for in-flight timeout or interruption.
Repeat only the original preparation input and settings revision; preparation
does not approve or dispatch. A failed `image_request_get` carries no write-outcome
claim or mutation-replay guidance and does not establish the earlier write's result.
Cancellation is undispatched-only; result recovery only publishes existing
task-bound local staged bytes and never contacts the provider. Changed settings
and pending saves block stale authority at the final synchronous dispatch fence.

The image journal is separate from older request namespaces; all review reads
are project-scoped. Full prompts and exact review requests remain plain local
SQLite, visible to authorized readers. Review intent/row limits are 32/64 KiB,
retention 1000/project and 10,000/workspace with no cleanup; the nested generation
input still has its original 24-KiB cap. DTOs omit credentials, raw/base64 results
and filesystem paths. See [Image generation](IMAGE-GENERATION.md) and
[Images activation](IMAGE-ACTIVATION.md) for current contracts and validation.

### Local ComfyUI observation tools (synthetic validation)

`comfy-local` uses the fixed ComfyUI `0.39.0` seven-node text-to-image profile,
with one selected installed checkpoint and one 512×512 PNG. Use the
[exact preparation contract](COMFY-CONNECTOR.md#review-and-one-submission) and
fixed local options; never pass a graph, endpoint, seed or credentials as tool
arguments. Full configuration/graph/seed/prompt-client UUIDs/output nonce are
frozen by the backend before user review. Local settings/check and review approval
remain application-only; no tool installs or starts a runtime, downloads a model,
uploads an image, or executes an arbitrary workflow. Only synthetic fixtures have
been used for this increment; full/native/live acceptance is not established.

- `image_task_remote_get` takes exactly `{projectId,taskId}` and reads the existing
  local `{projectId,taskId,remote,observation}`. It is read-only, does not contact
  ComfyUI and cannot start or resume observation.
- `image_task_observeRemote` takes exactly
  `{projectId,taskId,expectedRevision,requestId}`. Use the current `remote.revision`
  and a distinct caller-retained 8–200-character observation key. It admits a
  durable request before I/O, then makes one bounded job GET and at most one fixed
  PNG GET after complete terminal graph/client/nonce/status verification. Result
  descriptor/hash/bytes are pinned before managed staging/publication.
- The accepted result is the original queued observation ACK, not completion.
  Exact replay returns that ACK without another GET; read local remote/task
  records for current progress. A later explicitly requested query needs a new
  observation key and current remote revision. `finished` does not imply success.
  `image_request_get` remains the original image-mutation lookup, not an
  observation lookup.

`observeRemote` has local database/file-write and external-I/O effects, but no
new generation, POST, paid submission or local subprocess effect. Annotations
are advisory. No new operation enters the built-in Agent allowlist. Neither
startup nor ordinary reads poll the runtime; no automatic retry is permitted.
Prompt UUID reuse is not ComfyUI idempotency. `image_task_recoverResult` keeps its
local-only semantics, and `cancelQueued` remains undispatched-only. Closing a
client or stopping observation does not cancel remote work. A literal loopback
address and declared version/node names are not runtime safety/offline/free
attestation. See [connector limits and recovery](COMFY-CONNECTOR.md).

### Bounded, non-creating inspection

Use the four inspection tools for safe project-scoped metadata. These exact
argument examples use an illustrative UUID; substitute the chosen project's ID:

```text
project_inspect({"projectId":"11111111-1111-4111-8111-111111111111"})
asset_inspect({"projectId":"11111111-1111-4111-8111-111111111111","limit":10})
shot_inspect({"projectId":"11111111-1111-4111-8111-111111111111","limit":25})
timeline_inspect({"projectId":"11111111-1111-4111-8111-111111111111"})
```

Only asset/shot inspection accepts `limit` (integer 1–25, default 10) and optional
`cursor` (at most 512 characters). Pass the returned `nextCursor` unchanged with the same limit;
cursors bind to the project/operation/limit and expire across backend restarts.
Inspection never creates empty tracks, edits revisions/history, reads media,
runs local media processes or contacts providers. Missing timelines remain
missing. Results omit structured paths, URLs and raw media; shot `prompt` excerpts
are capped at 1000 UTF-8 bytes with `promptTruncated`. User-authored text is
untrusted and can still contain URL-like strings. Full response contracts and
scope behavior: [Agent inspection](AGENT-INSPECTION.md).

Existing authenticated standalone MCP clients can call these operations
explicitly. Built-in Agent read tools use the same business boundary under
[separate run-level consent](AGENT-READ-TOOLS.md); MCP discovery does not grant
that consent. Legacy `project_get` and `timeline_get` keep their original
responses and can lazily create a timeline; both correctly advertise
`readOnlyHint:false`.

### Advisory effects and MCP annotations

Every shared operation has an explicit effect descriptor. The MCP bridge derives
`readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint` from that
descriptor rather than guessing from suffixes. `mioon_schema` exposes it as
`effects`, including database/file writes, external I/O, local subprocesses and
potential new paid generation. Missing/new operations fail effect coverage.
The SDK's annotations are hints, not authorization or permission to skip client
approval. Unspecified internal effect fields default conservatively; no unknown
operation receives a guessed safe annotation.

Effects cover later worker activity too: generation submit/retry can incur
charges; reconciliation contacts an existing provider task and can resume
downloads but does not submit new generation; exports can run local FFmpeg and
write managed files. New timeline edits, including add/seed, can discard a redo
branch, so they are conservatively destructive. Read-only discovery remains
truthful: schema needs no backend, while doctor/capabilities read only the local
backend without contacting a provider. `idempotentHint:true` describes repeat
effects, not fresh responses; preserve exact stable request IDs and inputs.

## Results, safety, and recovery

Tools return both a text content block containing JSON and the same envelope in `structuredContent`:

```json
{"ok":true,"data":{}}
```

```json
{"ok":false,"error":{"code":"REVISION_CONFLICT","message":"...","details":{},"retryable":false}}
```

Errors set `isError: true`; invalid business inputs, unavailable backends, auth failures, and conflicts all use structured safe errors. The bridge does not print raw exceptions or headers. `retryable:false` means the bridge never automatically retries the call; recovery still depends on the operation and current backend state. MCP protocol-level malformed messages are handled by the SDK.

A recommended sequence is `mioon_doctor`, `provider_list`, `project_create`, `asset_import`, `shot_create`, `generation_submit`, repeated bounded `job_get`, `version_list`, `project_get`, `version_select`, `timeline_get`, `timeline_seed`, `timeline_render`, and bounded `export_get`. Use mock for no-cost verification. [CLI.md](CLI.md) includes the full runnable command workflow and authenticated local file download.

`asset_import` takes explicitly authorized bytes (`dataBase64`), never a server filesystem path. An MCP client that has local file access can read those bytes itself; the CLI also provides `asset import --file`. MCP does not expose an arbitrary path read/write helper. To save a completed export locally, use CLI `export download` with an explicit new output path. Relative `/media/UUID` URLs are authenticated local resources, not public sharing links.

The six tools `shot_create`, `shot_update`, `shot_reorder`, `node_create`,
`node_update` and `version_select` additionally accept an **optional** `requestId`
(8–200 characters). Supply one for recoverable edits and keep the exact arguments
until the outcome is known. Their schema still has `requiresRequestId:false`, and
MCP `idempotentHint:false` remains truthful for unkeyed calls. Exact keyed replay
returns the original response even after later revisions/restart, provided current
ownership remains valid. Changed operation/project/arguments under a key conflict.
This external MCP capability does not authorize built-in Agent writes. Its
separate reviewed-edit workflow exposes only a proposal tool and authenticated
human review endpoints, absent from the MCP catalog; see the scope and current
acceptance status in [reviewed selected-shot edits](AGENT-EDITS.md) and
[reviewed selected-clip moves](AGENT-TIMELINE-MOVE.md). The latter delegates an
approved `{startFrame}` patch to the existing `timeline_clip_update`; model
proposal and human approval are not MCP tools.
See [shared mutation replay](MUTATION-REPLAY.md).

For every mutation that requires `requestId`, the caller owns a stable ID. After a lost HTTP or MCP result, repeat the exact original operation and complete input with the **same requestId**, preserving its original revision. The bridge never invents IDs or automatically re-submits paid tasks. Changed reuse of an ID conflicts. A fresh intended edit uses a fresh ID and current revision.

Timeline operations share a namespace and return the original response on exact replay, even if newer edits exist. Do not overwrite a newer local view with an older replay result. Re-read `timeline_get` before another edit. Timeline revisions are separate from shot/project revisions. `timeline_render` freezes track/clip state and asset hashes into an export job; its result is observed with `export_get`.

A generation in `submission_unknown` may already be accepted and billable. Inspect/reconcile that existing job rather than submitting with another ID. `job_retry` is an explicit new attempt for a failed job and needs a new stable request ID. `job_cancel` stops backend local waiting only; it does not guarantee remote cancellation or a refund. MCP request cancellation and disconnect never call `job_cancel` or a provider cancellation API.

No blocking MCP watch helper is exposed. Agent clients should poll `job_get`/`export_get` with a reasonable interval and explicit deadline, or use the CLI's bounded watch. A timeout/disconnect stops observation; it does not imply a remote task stopped or justify a fresh paid submit.

### Explicit fixed-source replacement

`timeline_clip_replaceSource` maps to `timeline.clip.replaceSource`; case is
significant. Discover with
`mioon_schema({"operation":"timeline.clip.replaceSource"})`. The strict input is
`{projectId,expectedRevision,requestId,clipId,assetId,versionId?}`. All IDs except
the stable key are UUIDs; revision is a positive integer. Project, revision,
clip, replacement asset and a caller-retained `requestId` (8–200 characters) are
required; only the exact generated `versionId` is optional. Unknown fields and
source changes via legacy `timeline_clip_update` patches reject.

The source category must stay video, audio or image. All editable clip fields
and optional fade presence remain exact; bounds/audio incompatibility rejects
without clamping or moving neighbors. Success advances one revision and records
one undoable edit. Current-asset replacement rejects with `SOURCE_UNCHANGED`
without history. Explicit version input validates and pins the matching version
and canonical shot; asset-only input clears old lineage without inferring new
links. Later shot selection never replaces the clip.

The actual SDK annotations are `readOnlyHint:false`, `idempotentHint:true`,
`destructiveHint:true`, `openWorldHint:false`. Effects include database writes
for timeline/history/exact replay and possible redo-branch removal, with no
managed-file writes, source-byte reads, subprocesses, external I/O or paid generation.
These hints do not authorize the edit. No built-in Agent catalog, inspection
DTOs, media context or approval scope expands.

Keep the original operation and complete arguments/key through uncertain
responses, newer revisions and process restart. Exact replay returns the saved
original response, not current state. Malformed/mismatched success data produces
`BACKEND_PROTOCOL_ERROR` with `submissionMayHaveSucceeded:true`; keep the exact
request for recovery. A later ownership/receipt/auth/idempotency 4xx does not
settle an earlier uncertain attempt. Only exact matching
`mutationOutcome:"not_applied"` / `requestId` proof on a checked fresh-key
business rejection establishes no commit. Changing arguments, version omission,
operation or project under a used timeline key conflicts. Keys share the
existing backend-wide timeline edit/undo/redo/render namespace, not a new
workspace-global namespace for all operation families. Refresh before a new
intent with a new key. Full errors and preservation rules:
[Explicit clip source replacement](API.md#explicit-clip-source-replacement).

Offline official SDK/CLI/HTTP acceptance:
`node --test tests/timeline-replacement-transports.test.ts`.

### Clip audio fades

`timeline_clip_add` and `timeline_clip_update` expose optional `fadeInFrames`
and `fadeOutFrames` through their existing shared schemas; update fields belong
in `patch`. Discover with `mioon_schema({"operation":"timeline.clip.update"})`.
Values are integer 30fps frame counts from 0 to 18000, each and together bounded
by the resulting clip duration. Omitted legacy fields mean zero without record
normalization; omitted patch fields stay unchanged, and explicit zero clears a
fade. Positive values require an audio/video source with `hasAudio:true`.

The same timeline revision, mandatory caller-owned request ID, atomic history,
and exact original-response replay apply. Keep the complete original arguments
after uncertainty or restart. `INVALID_FADE`, `FADE_AUDIO_UNSUPPORTED`, schema
`VALIDATION_ERROR` and `SPLIT_FADE_BOUNDS` do not commit changes. Split offsets
must be outside ramp interiors; exact fade boundaries are accepted if interior
to the clip. A valid split preserves outer envelopes and zeros only present
inner-edge fade fields.

Fades affect rendered preview/export with existing gain/mute, while source
playback stays dry. This adds no new tool family, effect category, inspection
DTO fields or built-in Agent permission. Existing `timeline_get` creation
behavior remains unchanged. See [Timeline audio fades](TIMELINE.md#audio-fades).

## Offline verification

```sh
node --test tests/mcp-discovery.test.ts tests/mcp-v4.test.ts
node --test tests/mcp.test.ts tests/timeline-mcp.test.ts
node --test tests/timeline-fades-transports.test.ts
pnpm test:cli
```

The acceptance tests launch the official SDK `Client` with `StdioClientTransport`, perform real initialize/list/call exchanges, and compare state against the same HTTP backend. Coverage includes strict schema parity, CLI/MCP/HTTP visibility, mock generation, exact replay, lost-response recovery, conflict handling, bounded watch/SIGINT without cancellation, file download, and a long-lived MCP process across desktop descriptor/token/port rotation. Tests use isolated temporary data and synthetic mock media; no live credentials or paid generations are used.

### Saved source-range metadata

`asset_range_get` and `asset_range_set` expose the same shared contracts as HTTP
and CLI. Get is non-creating/read-only; set writes only local range metadata and
its immutable receipt, with a required `requestId` and independent range
`expectedRevision`. In/out are the fixed 30-fps editing timebase with exclusive
out, not native/VFR source frame numbers. Saving marks never edits existing
clips. Copy the explicitly chosen saved values into a separate
`timeline_clip_add` intent with its own timeline revision/key. See
[SOURCE-RANGES.md](SOURCE-RANGES.md). External MCP discovery does not grant the
built-in conversational Agent any additional tools or context.

### Asset review dispositions

`asset_disposition_list` and `asset_disposition_set` are discoverable external
SDK tools sharing the HTTP/CLI contracts. List accepts `{projectId,assetIds}`
with 1–100 unique UUIDs, returning `{projectId,items}` in exactly requested order.
Each item is `{id:assetId,assetId,projectId,revision,disposition}`. It is
non-creating/read-only; absent metadata is neutral/revision 0. A missing/foreign
asset fails the entire batch with uniform `NOT_FOUND`, without partial data.

Set accepts `{projectId,assetId,expectedRevision,requestId,disposition}` with
`neutral`, `favorite` or `rejected`. It requires a retained 8–200-character key
and the independent disposition revision; it writes only local metadata and its
receipt. Both tools advertise `idempotentHint:true`, `openWorldHint:false` and
no file/provider/process/paid work. Only list has `readOnlyHint:true`. These
hints grant no authorization. Original optional-key tools still advertise
`idempotentHint:false` for legacy keyless calls.

Exact set replay returns the historical result after checking current ownership
and before current CAS, including after restart or a later neutral reset.
Changed key reuse conflicts across all eleven local mutations. Existing timeline,
reference and generation key scopes remain separate. Neutral reset retains its
revision; rejection never edits existing clips or asset bytes. Legacy inspection
DTOs and built-in Agent model tools/context do not gain disposition fields or
authority. Caller recovery identity must be retained; browser UI pending receipts
are session-only. See [asset dispositions](ASSET-DISPOSITIONS.md).

### Opt-in source waveforms

`asset_waveform_request` and `asset_waveform_get` share the strict HTTP and CLI
schemas. Request takes `{projectId,assetId,retry?}` (UUIDs; retry defaults false).
Get takes `{projectId,assetId,sourceStartFrame?,sourceEndFrame?,points?}` with a
30fps inclusive start / exclusive end, default full source and 512 points;
points are bounded to 1–2048. Start is 0–17999, end is 1–18000 and must exceed
start and fit the source. No hash, path, URL, command, credential or request ID
is accepted. Uniform `NOT_FOUND` covers missing/foreign assets.

Request is an explicit local-analysis opt-in, not a metadata read. It advertises
`readOnlyHint:false`, `idempotentHint:false`, `destructiveHint:true`,
`openWorldHint:false`: scheduled work may run local subprocesses and write
derived SQLite cache, but never output media files, external I/O or paid
provider generation. The destructive hint covers replacement/eviction of
terminal disposable cache entries only, never source or business records. Get advertises `readOnlyHint:true`, `idempotentHint:true`,
`destructiveHint:false`, `openWorldHint:false`, and no subprocess/database/file/
external/paid work. It never probes, repairs or touches cache access times.
Hints describe effects; they do not grant authorization.

Ordinary duplicate requests reuse retained queued/running/ready work. After an
uncertain acknowledgement, get status first. Use explicit `retry:true` only for
an interrupted/failed attempt. Startup reconciles unfinished entries as
interrupted without automatic execution. Ready cache survives restart while
retained; eviction can return missing and a later explicit request can rebuild.
This is not a durable exact-mutation replay journal. Ready get returns at most
2048 normalized raw source peaks (or null for bins wholly beyond actual decoded
coverage), before timeline gain/mute/fades, and safe
state/reason fields. Ready `decodedSampleFrames` is actual 48kHz coverage;
duration/sourceFrames retain the asset clock, without stretching or fabricated
silent tails. No built-in Agent allowlist or inspection DTO expands.
Full limits and response: [Source waveforms](API.md#opt-in-source-waveforms).

Offline transport acceptance: `node --test tests/waveforms-transports.test.ts`.

### Local timeline export preflight

`timeline_export_preflight` exposes the shared strict
`timeline.export.preflight` contract: `{projectId,expectedRevision}` with optional
closed `exportSettings`, a project UUID and positive integer existing-timeline revision. Discover its
schema with `mioon_schema({"operation":"timeline.export.preflight"})`.
It rejects unknown fields, including credentials, paths, commands and request
keys. It returns the strict bounded report documented in
[Local timeline export preflight](API.md#local-timeline-export-preflight).

The actual SDK annotations are `readOnlyHint:true`, `idempotentHint:true`,
`destructiveHint:false`, `openWorldHint:false`. Its explicit effects additionally
state `localProcess:true`: bounded local ffprobe metadata work is permitted.
There are no SQLite/cache/file writes, timeline initialization, export creation,
full decode, provider calls or paid generation. These hints are advisory and do
not authorize work. Read idempotency does not promise identical report bytes:
subsequent calls can observe source or timeline changes.

Checks cover the three closed [30fps timeline output presets](TIMELINE-OUTPUT-FORMATS.md), streamed managed-source hashes and
bounded metadata, with limits of 100 assets, 512MiB/source, 1GiB total bytes,
30 seconds and 128 issues. Inspect `status` even when `isError` is false:
`ready` found no known blocker at the check time; `blocked` requires attention;
`stale` requires a fresh view/check; `incomplete` means a cap or timeout left
checks unfinished. Incomplete is not an export failure or ban; an explicitly
informed user may still choose to try export. No report guarantees future file
availability or successful full decoding. `checks.fullDecode` is always false.
Checks stop at the first blocking/incomplete condition; report `checkedAssets`
as completed coverage rather than treating the issue list as exhaustive.
The bridge's shared HTTP client defaults to 35 seconds for this operation only,
allowing grace after the backend's 30-second budget and best-effort cleanup.
Other operations keep their 30-second default; explicit client/request deadlines
win. Event-loop/filesystem delays are not hard real-time guarantees. A host may
also impose its own earlier MCP deadline. No timeout triggers an automatic POST
retry. Malformed or mismatched reports become `BACKEND_PROTOCOL_ERROR`, without
an uncertain-mutation claim.
Preflight's aggregate ownership-metadata safety budget is 4MiB/1024 records,
independent of source bytes. Exhaustion returns `incomplete`/
`PREFLIGHT_SNAPSHOT_BUDGET` with a null digest until ownership is verified.
The render worker validates distinct clip/source lineages independently before
file I/O, with that same safety bound per lineage and no whole-composition
metadata ceiling. Many independent valid sources can render despite incomplete
aggregate preflight. The per-lineage bound is an additional rendering security
limit; the preflight-only aggregate/source-byte/time budgets do not apply there.

For a separate authorized `timeline_render`, the optional lowercase SHA-256
`preflightSnapshotHash` pins the report's `snapshotHash` alongside its
project/revision. A new render verifies the supplied digest. Omission has no
default and preserves legacy request/response bytes. Exact replay is resolved
before freshness checks: retain the complete original render arguments/key,
including digest presence, after a lost response. Do not silently replace a
digest or retry the same intent with a new key. The preflight tool itself never
renders; observe accepted renders through `export_get`. External discovery does
not expand built-in Agent tools, context, inspection DTOs or approval scope.

With an `incomplete` report lacking a digest, a separate explicit user decision
may authorize a one-use attempt to export the freshly read current saved
project/revision without `preflightSnapshotHash`. Clearly label it unchecked
and use a fresh render key. Never fabricate a checked binding, automatically
fall back, or use known blockers/error issues or stale reports to justify it.
Worker validation still applies. An uncertain render remains its own exact
request and must retain its original digest or omission on replay.

Offline official SDK/CLI/HTTP acceptance:
`node --test tests/timeline-preflight-transports.test.ts`.

### Timeline recovery validation

All eleven existing timeline-write tools now share complete acknowledgement and
request-bound rollback-proof checks with the CLI and UI. A malformed successful
payload produces a protocol error with uncertainty guidance. A later 4xx does not
prove a prior call failed; preserve its original arguments/request ID. The bridge
never automatically resubmits. Reference errors also conservatively retain
uncertainty unless a matching reference-specific rollback proof is verified. No new tool,
input schema, authorization or journal namespace is introduced. See
[TIMELINE-RECOVERY.md](TIMELINE-RECOVERY.md).

### Reference acknowledgement recovery

`reference_attach` and `reference_detach` use the same bounded acknowledgement
validator and transactional ownership/receipt boundary as UI/CLI. The bridge
rejects malformed successful payloads without retrying; preserve exact arguments
and request ID. A historical detached edge may no longer exist, and an attach
can acknowledge an existing binding without a new shot revision. No new tools,
authority, generation call or namespace are introduced. See
[reference recovery](REFERENCE-RECOVERY.md).

### UI task discovery boundary

[Durable UI task recovery](TASK-RECOVERY.md) is a dedicated authenticated UI
coordinator for ten non-rendering timeline edits and two reference operations.
The implemented subject extension adds only `subject.create`, `subject.version.add`
and `subject.binding.set` in a dedicated subject lane, for fifteen at that stage. `timeline.format.set` adds the sixteenth fixed operation. The three explicit `timeline.subtitle.add`, `timeline.subtitle.update`, and `timeline.subtitle.remove` operations brought the total to nineteen, sharing `timeline:mutation`. The explicit `timeline.loudness.apply` operation is now the twentieth entry in that lane; its scalar durable intent and exact receipt use the [atomic apply contract](TIMELINE-LOUDNESS-APPLY.md).
It does not register a generic execute/recover MCP tool or expand built-in Agent
authority. Existing MCP tools still use the same shared business handlers and
strict historical acknowledgements; retain exact arguments and request IDs.
UI cold-start discovery does not automatically persist every external-agent intent.

### Local subject planning tools

The narrow subject increment is implemented. Focused checks, final web/desktop
builds and Linux native acceptance passed; the independent full-suite release gate
passed. Discover its strict schemas with `mioon_schema({"operation":"subject.binding.set"})`.
The external catalog adds these shared tools:

- `subject_create({projectId,kind,name,assetId,requestId})`
- `subject_version_add({projectId,subjectId,expectedRevision,assetId,requestId})`
- `subject_binding_set({projectId,shotId,subjectId,role,subjectVersionId,expectedRevision,expectedSubjectRevision,requestId})`
- `subject_list({projectId,limit?,cursor?})`
- `subject_version_list({projectId,subjectId,limit?,cursor?})`
- `subject_binding_list({projectId,shotId?,subjectId?,limit?,cursor?})`, exactly one filter
- `subject_variants_create({projectId,subjectId,sourceVersionId,kind,items,providerId,model,requestId})`
- `subject_variants_retry({projectId,batchId,position,expectedRevision,requestId})`
- `subject_variants_undo({projectId,batchId,expectedRevision,requestId})`
- `subject_variants_get({projectId,batchId})`
- `subject_variants_list({projectId,subjectId,limit?,cursor?})`

The five `subject_variants_*` tools (schema 62) record angle and lighting
batches for character and product subjects. `create` returns each item's exact
image edit input and submits nothing; submit those inputs with the image tools,
and official ones still need in-app approval. Finished images become variant
versions that never replace the default version; `undo` hides them. Rules and
error codes are in [API.md](API.md#angle-and-lighting-variants-schema-62).

All IDs are project-owned UUIDs except stable `requestId` (8–200 characters).
`kind` is `character|product|location|look`; name is nonblank and at most 120
characters. Versions select one existing managed PNG/JPEG/WebP image, with no
import/copy operation. All writes require a retained key. Version-add checks the
subject revision. Binding-set checks independent binding revision (0 only for a
never-created identity) plus `expectedSubjectRevision`; `look` uses `style`,
other kinds use `subject`. Maximum eight active bindings per shot.

A required `subjectVersionId` UUID pins that exact version; `null` clears and
retains a tombstone. An explicit set acknowledges the current head through
`reviewedHeadVersionId`, including when keeping an older selected version.
Later heads derive `needsReview` without changing the selection or shot. Lists
return `{projectId,items,nextCursor}`, include binding tombstones, default to 20
items and cap at 50. Pass returned cursors unchanged with the same filter/limit;
cursors cap at 768 characters and expire after backend restart. Pages are not
a frozen multi-call snapshot. DTO fields and backend-derived local provenance
are documented in [subject contracts](SUBJECT-LIBRARY.md#response-dtos-and-provenance).
Structured source fields omit paths, URLs, provider task IDs and media bytes.
A user-authored subject name remains untrusted text and may contain such strings.
Version hashes come from existing asset records, without rehashing or probing media.

Read tools advertise `readOnlyHint:true`, `idempotentHint:true`,
`destructiveHint:false`, `openWorldHint:false`. Create/version-add advertise
`readOnlyHint:false`, `idempotentHint:true`, `destructiveHint:false`,
`openWorldHint:false`; binding-set differs with `destructiveHint:true` because it
can change or clear a selection. Writes affect local metadata/receipts only;
none of these tools read source bytes, write files, run subprocesses, contact
providers or generate paid media. Annotations never grant authority.

Subject writes share the existing local mutation namespace, extended from eight
to eleven operations through `subject_requests`; timeline/reference/generation/
export namespaces are separate. Recover uncertain results with the original
operation/full input/key, never a new key or automatic POST retry. Exact replay
is historical and ownership-checked. Malformed success or generic 4xx stays
unknown without matching operation/project/request rollback proof.

UI durable preparation adds only these three writes under `subject:mutation`,
bringing its explicit allowlist to fifteen at that stage; the later format operation makes sixteen, and three subtitle writes made nineteen, and explicit `timeline.loudness.apply` now makes twenty. External calls do not automatically
create UI tasks, and no generic task-execution MCP tool is added. This external
catalog does not expand built-in Agent tools/context. Subject/style bindings are
local planning only: actual `first_frame` still uses `reference_attach`. Later
[saved first/last frames](VIDEO-FRAME-PAIRS.md) and
[explicit subject-version input](SUBJECT-VIDEO-INPUTS.md) are separate generation
choices. Motion and identity-lock guarantees remain unsupported. No Blender or
live-generation step is needed. See [scope and current release gate](SUBJECT-LIBRARY.md).

## Local frame extraction tools

The existing official SDK bridge exposes exactly six strict frame tools from
shared runtime schemas: `frame_extract`, `frame_request_get`, `frame_task_get`,
`frame_task_list`, `frame_task_cancelQueued`, `frame_task_recoverResult`.
Discover them through `tools/list` or `mioon_schema`; this is external tool
availability, not extra authority for the built-in conversational Agent.
[Source-frame acceptance](SOURCE-FRAMES.md) is still in progress.

- `frame_extract`: `{projectId,sourceAssetId,sourceHash,sourceFrame,requestId}`.
  Pins a project-owned managed video/hash and integer 30fps editing mark. The
  fixed local decoder selects the first PTS at or after the mark; it does not
  claim native/VFR frame accuracy. The new PNG is at most 1024×1024, no upscale.
- `frame_request_get`: `{projectId,requestId}`; returns the immutable original
  operation acknowledgement or `null`, never starts work.
- `frame_task_get`: `{projectId,taskId}`; current task state, no execution.
- `frame_task_list`: `{projectId,limit?,cursor?}`; pages default 20/max 50. Keep a
  returned cursor unchanged with the same scope/limit; backend restart expires it.
- Both controls: `{projectId,taskId,expectedRevision,requestId}`. Cancel only
  provably unstarted work; recover only complete already-staged local bytes.
  Recovery never decodes again, even when its checkpoint is missing or corrupt.

IDs are UUIDs, hashes lowercase SHA-256 and write request IDs 8–200 characters.
No local path, output name, decoder command, provider, profile override or generic
executor is accepted. Effects describe local database/file writes and, only for
extraction, scheduled local media processes. All six have no provider/network/
paid-generation effect. Schema metadata remains advisory, never authorization.
Outputs do not automatically change clips, versions, references or subject plans.

Preserve the full original input/key yourself across an unknown response. Only
three frame writes join client uncertainty tracking; receipt reads remain reads.
Exact replay returns the old ACK without scheduling extraction; read current
state separately. Changed operation/input/project reuse conflicts in the frame
namespace, which remains separate from image and older journals. Task DTOs retain
the original extraction key even when a control uses a different receipt key.

The shared client rejects malformed/foreign 200 DTOs without normalization and
never silently retries or invents a replacement ID. Only a strictly verified
`frameOutcome` nonacceptance proof for the exact operation/project/key/canonical
input SHA and the [API code/status whitelist](API.md#local-source-frame-extraction)
can clear uncertainty. Generic status/message, ownership failure or missing
lookup cannot. Startup, schema discovery, task reads and historical replay never
resume work. Request/task metadata is stored in plaintext local SQLite; PNG and
manifest files are ordinary private local files, not vault-encrypted. This is
backend-durable accepted work, not durable preparation of an unsent MCP request.


## Scene detection tools

Nine strict tools share the runtime schemas of the
[scene RPCs](API.md#reference-film-scene-detection-2026-10-24): `scene_detect`,
`scene_request_get`, `scene_task_get`, `scene_task_list`, `scene_task_cancel`,
`scene_result_get`, `scene_cuts_save`, `scene_shots_create` and `scene_shots_undo`.

- `scene_detect`: `{projectId,sourceAssetId,sourceHash,options?,requestId}`. Queues
  one local decode of an owned video; a finished run saves its cuts (first frames
  of new shots on the 30 fps grid) as the video's newest result.
- `scene_task_get` / `scene_task_list`: current state and live `progress`; reads
  never resume work.
- `scene_result_get`: `{projectId,assetId}`; the newest result and whether it is
  still current.
- `scene_task_cancel` and `scene_cuts_save` are explicit user writes with their
  own keys; `scene_cuts_save` must start from the current result.
- `scene_shots_create`: `{projectId,sourceAssetId,sourceHash,resultId,segments,titlePrefix?,position?,requestId}`.
  Queues one local decode that captures each chosen segment's middle keyframe,
  then creates a shot per segment with that image as its first-frame reference.
  Cancelled or failed storyboards leave no shots.
- `scene_shots_undo`: `{projectId,taskId,expectedRevision,requestId}`. Deletes a
  built storyboard's shots while `scene_task_get` reports `undo.available`; the
  keyframe images stay.

Only a verified `sceneOutcome` proof for the exact operation, project, key and
canonical input hash clears an uncertain write. No path, decoder argument,
provider or network access is involved. Use `timeline_clip_splitAtScenes` to
split timeline clips at a result's cuts.

## Timeline output presets (schema 21)

`timeline.format.get` is noncreating and returns the current project/timeline revision fences, saved/effective preset and bounded eligibility reasons. `timeline.format.set` requires `projectId`, `expectedProjectRevision`, `expectedRevision` (0 means no timeline), a stable `requestId`, and a preset from the current schema. Current presets are `portrait_1080` (1080×1920), `landscape_1080` (1920×1080) and `square_1080` (1080×1080); new projects default to `portrait_1080`. The contract also retains `portrait_720` (720×1280), `landscape_720` (1280×720) and `square_720` (720×720) for existing projects. All use 30 fps. The setter returns the exact full timeline acknowledgement; historical replay precedes fresh CAS checks. Existing same-preset new-key requests reject without a successful mutation.

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

## Per-export delivery profile

`timeline_export_capabilities` exposes the same strict project/revision/settings
schema as HTTP and CLI. It is explicitly read-only, `localProcess:true`: one
bounded synthetic encode, no persistent writes or external I/O. Discovery does
not execute the check. `available` is an observation, not export approval.
For an authorized timeline export, pass the identical closed `exportSettings`
to optional source preflight and `timeline_render` (`purpose:'export'`). Preserve
the original key/input after an unknown result. Omission retains historical
responses and preview rejects custom settings. See [EXPORT-SETTINGS.md](EXPORT-SETTINGS.md).
No built-in Agent tool is added by this external MCP operation.

## Saved first/last-frame selection

The shared `shot_create` / `shot_update` schemas expose optional
`lastFrameAssetId` (inside `patch` for update): UUID selects a same-project image,
`null` clears it, omission preserves the old shape/no-change semantics. Keep the
existing first-frame `referenceAssetIds` / `reference_attach` / `reference_detach`
meaning; disconnecting first does not implicitly clear last. Paired submission is
implemented only by the exact current Ark and Mock input profiles. A lone tail or
unsupported/mixed role selection is rejected before dispatch. Subject/style
planning metadata is not converted into provider inputs.

Use the existing stable mutation key/CAS, reread after an unknown result, and
inspect the job's frozen role/source hashes. Retrying a confirmed failed job uses
its original snapshot. No new model tool, paid authority, generic dispatcher or
cross-restart manual-shot pending ledger is introduced. See
[VIDEO-FRAME-PAIRS.md](VIDEO-FRAME-PAIRS.md) for limits and validation status.
## Explicit one-subject video input

The existing `generation_submit` schema adds optional non-null UUID
`subjectVersionId`. Read the shared subject/version lists and explicitly choose
one version. This adds no model tool or generic authority. The server freezes its
complete owned source and the `subject_reference` role; local subject/style
bindings are not automatic input. Saved first/last selections or connections must
be explicitly cleared separately, otherwise submission rejects.

Discover the exact Ark/Mock v3 profile. Keep original input/key after uncertainty;
changed versions conflict, and confirmed-failure retry uses its original source.
Only a validated original acknowledgement/read settles the request. Mock proves
workflow only; Ark real-face direct uploads are unsupported and no live call is
approved by schema discovery. See [SUBJECT-VIDEO-INPUTS.md](SUBJECT-VIDEO-INPUTS.md).

## Workspace backup status and offline boundary

`workspace_backup_inspect` is an authenticated, strict-empty-input, read-only
workspace DB summary. Null counts mean unknown or bounded inspection incomplete,
not zero. It never checks/copies media, stops the backend, reads credentials or
resumes work. The result always explains that a running backend must close
before cold capture. This is an external discovery tool, not an added built-in
Agent capability.

There is no MCP backup create/verify/restore tool or filesystem-path executor.
For explicitly requested local backup creation, use the documented offline CLI
in [the guide](WORKSPACE-BACKUP-GUIDE.zh-CN.md) after normal backend shutdown.
A verified package is not evidence that restoring or repeating old tasks is safe.


## Restored-branch discovery and origin pin

`workspace_restore_inspect` is an authenticated strict-empty read-only tool. It
returns `{restored:false}` for ordinary workspaces; restored ones disclose safe
origin/profile, source hashes, bounded held counts and explicit restrictions.
There are no filesystem paths or added built-in Agent capabilities.

For an explicitly chosen restored branch, launch MCP with `--workspace-origin`
and its exact inspected UUID. The bridge pins this outer invocation context;
ordinary tool input schemas and replay keys are unchanged. It never updates the
pin on backend reconnect. Missing/foreign origins refuse fresh effects. Discovery
does not approve execution, restore old tasks or give a model paid authority.

Captured tasks/approvals/unknown requests remain held, including when callers
supply a new outer origin or another key. Only supported new local edits/imports
and previews/exports are enabled in restored v1; disabled calls return the same
structured business refusal as UI/CLI. Do not interpret it as confirmed rollback.
Offline restore/status has no MCP filesystem executor; use the explicitly
requested local CLI described in [CLI.md](CLI.md#guarded-offline-restoration).


## Named timeline deliveries

`timeline_render` (export only) and `timeline_export_preflight` expose optional `deliveryName` through shared strict discovery. Preserve its exact presence/value and all quality settings when replaying an unknown original request. `timeline_export_capabilities` still excludes display names. Read `export_get` for accepted historical metadata. This adds no built-in Agent tool or generation permission.
See [scope and acceptance](NAMED-DELIVERIES.md).


## Selected-range timeline test export

`timeline_render` (export only) and `timeline_export_preflight` expose optional strict `exportRange:{startFrame,endFrame}` through shared discovery. Use integer30fps composition frames, start included/end excluded, at least one frame inside the saved duration. Preserve the exact optional range, name, settings, revision and request key after uncertainty. Do not pass range to `timeline_export_capabilities` or preview. The full original snapshot is retained; preflight still checks all referenced media. This adds no built-in Agent tool, generic executor or generation permission. See [behavior and acceptance](SELECTED-RANGE-EXPORT.md).


### 已导出文件解码样本峰值

`timeline_export_samplePeak` exposes shared `timeline.export.samplePeak` with strict `{projectId,exportId}`. Discover through `mioon_schema` first. The explicit read-only operation hashes and decodes one owned succeeded timeline MP4, so `localProcess:true` honestly signals CPU/file work; it creates no render, task, cache or stored report. SDK cancellation stops only that observation. Do not automatically check on listing or repeat a lost response. No caller path/hash/request ID or permission flag is accepted. Restored-v1 explicitly denies it before media access.

Ready measurements refer to the immutable export/output identity and actual verified bytes at check time. They are decoded sample peaks, not true peak/LUFS or proof that earlier mixing did not clip. This external tool does not enter the built-in Agent catalog or grant generation permissions. See [contract and limits](EXPORT-SAMPLE-PEAK.md).


## Exported-file loudness observation

`timeline_export_loudness` exposes the strict shared `timeline.export.loudness` schema; discover it first with `mioon_schema`. The expected hash fixes the selected artifact but is independently verified by the server. `readOnly:true/localProcess:true/fileWrite:false` describes full bounded local decoding, not an authorization to run automatically. The custom LUFS/dBTP target is optional and has no platform default. Reports bind actual hash, profile, original range/revision and target; invalid/short/silent/below-gate signals never receive a usable gain instruction. Suggestions cannot approve mutations, replace source audio or add a limiter. SDK cancellation stops only this measurement. Restored-v1 rejects it and the built-in Agent tool list is unchanged. See [precise measurement and resource boundary](EXPORT-LOUDNESS.md).

## Explicit saved-timeline full-mix candidate

`timeline_loudness_prepare` exposes `timeline.loudness.prepare` through the existing schema-driven catalog. Discover with `mioon_schema`. Require the owned project, saved `expectedRevision`, explicit fixed mix/measurement profiles and user-selected LUFS/dBTP target. No request ID, arbitrary path/URL, selected range or approval flag is accepted, and discovery alone never starts decoding.

Effects are `readOnly:true`, `localProcess:true`, `fileWrite:false`, with no database writes, network or paid work. This is resource-intensive local computation:120s server budget,125s default shared-client deadline,64KiB streaming response cap. The original full float mix and actual fixed-multiplier candidate are measured independently; returned comparisons and gains never grant application authority (`applyAllowed:false`). Do not treat an exported-file arithmetic suggestion as this current-timeline measurement, infer a target, apply edits, call a model or retry lost output automatically. SDK cancellation retires only this observation's owned work. Restored-v1 denies it, and the internal Agent's four metadata tools and permission defaults remain unchanged. See [exact report boundary](API.md#saved-timeline-full-mix-loudness-preparation).

## Explicit atomic fixed-gain application

`timeline_loudness_apply` exposes the same strict `timeline.loudness.apply` contract. It is `readOnly:false`, `databaseWrite:true`, `localProcess:true`, `idempotent:true`, with no file/network/model/payment effects. Discovery is not authorization to apply. Require the user-selected target and explicit action, retain the original requestId and exact scalar binding, and never treat `applyAllowed:false` from prepare as an application token. The server remeasures before a single atomic edit; same-key historical replay does not rerun media. Local cancellation/output loss remains unknown. No internal Agent catalog expansion is included. See [contract and restored restrictions](TIMELINE-LOUDNESS-APPLY.md).

## LUT resource foundation

Discovery now includes `lut_import`, `lut_list` and `lut_inspect`. Import requires an explicit project, stable request ID, name and canonical base64 source bytes (maximum7MiB); no local path or URL parameter is accepted. Metadata includes explicit unverified-colour/not-implemented-rendering status. The current SDK's10MiB stdio limit is unchanged, and a maximum complete LUT message is checked against its actual ReadBuffer. A new bounded LUT-only lane also exercises actual official MCP stdio import/replay/list/inspect and lost/tampered ACK recovery. It does not rerun issue #1 or change built-in Agent authority. See [LUT resources](LUT-RESOURCES.md).
