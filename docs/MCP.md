# MCP agent integration (V4)

Mioon exposes an **official MCP SDK stdio server**. It talks to the same authenticated local HTTP operation layer as the Web app, Electron, and [CLI](CLI.md); it does not open a database or start another backend. Streamable HTTP MCP is not implemented or required. Start the normal backend or Electron separately before calling stateful tools.

Node.js 24+ and installed source workspace dependencies are required for this optional source bridge. The Electron app itself uses bundled Node, but it does not bundle a standalone MCP executable.

```sh
pnpm install --frozen-lockfile
node /absolute/path/mioon/apps/mcp/src/index.mjs
# Existing compatibility entrypoint remains supported:
node /absolute/path/mioon/server/mcp.mjs
```

The MCP client launches this command with the selected environment. Do not run it through a launcher that prints banners to stdout; stdout is exclusively the MCP wire protocol. The bridge can initialize and list tools while the backend is stopped. Calling `mioon_doctor` then explains readiness through a safe structured error.

## Connection modes

Prefer private connection files, not token literals in client configuration:

- **Electron:** `MIOON_CONNECTION_FILE=/absolute/path/to/userData/mcp-connection.json`. The desktop writes this descriptor and adjacent `mcp-token` atomically; both are owner-only and removed at graceful exit. See [DESKTOP.md](DESKTOP.md).
- **Direct Web backend:** `MIOON_BASE_URL=http://127.0.0.1:4318` and `MIOON_TOKEN_FILE=/absolute/path/to/data/access-token`. Start `pnpm dev` separately using the appropriate data directory.
- **Explicit token:** `MIOON_TOKEN` in the process environment is supported; avoid mixed configurations. No secret belongs in a tool argument, a URL, or command-line argument.

Connection files are read again on every HTTP request. A long-lived MCP process follows desktop restarts and direct token-file rotation without restarting itself. Files must be small regular files owned by the current user; POSIX permissions must be `0600` or stricter, and symlinks are rejected. Desktop token location must be beside the descriptor, with a live PID. Origins are restricted to local HTTP (`127.0.0.1` or `localhost`), and redirects, embedded URL credentials, paths, queries, and fragments are refused. No token or credential path is returned by doctor.

Q2 also validates the private parent directory and canonical ancestry and rejects multiply linked credentials. Existing unsafe files/directories are preserved rather than repaired or replaced. Windows persistent-file access is unavailable until a native ACL backend is implemented and verified. See [private storage and recovery](PRIVATE-STORAGE.md); no new MCP authority or operation is introduced.

Do not mix a desktop descriptor with `MIOON_BASE_URL`/`MIOON_TOKEN_FILE`. Explicit `MIOON_TOKEN` takes precedence when no token file is supplied; `MIOON_TOKEN_FILE` plus `MIOON_TOKEN` is rejected. New setups should choose exactly one mode.

### V4.1 渠道对应的连接文件

正式版 ID 为 `app.starroy.mioon`，开发版 ID 为 `app.starroy.mioon.dev`，包括打包后的开发版。Linux 默认连接文件分别为 `$HOME/.config/app.starroy.mioon/mcp-connection.json` 与 `$HOME/.config/app.starroy.mioon.dev/mcp-connection.json`；macOS 对应 `$HOME/Library/Application Support/` 下的同名目录。实际位置受 Electron appData / `MIOON_DESKTOP_USER_DATA` 影响。JSON/TOML 中使用展开后的绝对路径。

源码默认构建开发版。两个渠道独立运行、轮换令牌；客户端只连明确配置的那一个，不自动猜测或回退。旧 `video-workbench/` 数据及历史连接配置保留；迁移项目后需手动把客户端连接路径改为目标渠道，详见 [数据迁移](DESKTOP.md#数据位置与单实例)。descriptor 的 `appId` / `channel` 是附加非敏感元数据，协议版本仍为 1。

## Standalone Codex configuration

This is a configuration example for the user's review, not an installer. No files under `~/.codex` are modified by this repository. In a trusted project, the user may place this block in a project-scoped `.codex/config.toml`. Replace the absolute paths:

```toml
[mcp_servers.video_workbench]
command = "node"
args = ["/absolute/path/mioon/apps/mcp/src/index.mjs"]
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
      "args": ["/absolute/path/mioon/apps/mcp/src/index.mjs"],
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
- `export_create`, `export_get`

Three additional read-only discovery tools are available:

- `mioon_schema({})`: all operation definitions, actual JSON Schemas, natural CLI commands, `requiresRequestId` flags, and advisory `effects`. `mioon_schema({"operation":"generation.submit"})` narrows to one operation. This tool works offline.
- `mioon_capabilities({})`: the current `provider.list` data, including per-model `modelCapabilities`, enabled/configured gates, supported durations/aspect ratios, and limits. It does not submit generation.
- `mioon_doctor({})`: authenticated readiness, client/backend version metadata, connection mode, and provider capabilities. It does not return credential paths or token values.

Provider IDs currently include `mock`, `runway`, `ark`, `veo`, `minimax`, and `vidu`. Discover each configured provider's actual model options before use; adding an adapter does not authorize live generation or mean a credential is configured.

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
acceptance status in [reviewed selected-shot edits](AGENT-EDITS.md).
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
`node --test tests/timeline-replacement-transports.test.mjs`.

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
node --test tests/mcp-discovery.test.mjs tests/mcp-v4.test.mjs
node --test tests/mcp.test.mjs tests/timeline-mcp.test.mjs
node --test tests/timeline-fades-transports.test.mjs
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
Changed key reuse conflicts across all eight local mutations. Existing timeline,
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

Offline transport acceptance: `node --test tests/waveforms-transports.test.mjs`.

### Local timeline export preflight

`timeline_export_preflight` exposes the shared strict
`timeline.export.preflight` contract: `{projectId,expectedRevision}` with a
project UUID and positive integer existing-timeline revision. Discover its
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

Checks cover existing 720×1280/30fps output, streamed managed-source hashes and
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
`node --test tests/timeline-preflight-transports.test.mjs`.

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
It does not register a generic execute/recover MCP tool or expand built-in Agent
authority. Existing MCP tools still use the same shared business handlers and
strict historical acknowledgements; retain exact arguments and request IDs.
UI cold-start discovery does not automatically persist every external-agent intent.
