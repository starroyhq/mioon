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
- `timeline_clip_add`, `timeline_clip_update`, `timeline_clip_remove`, `timeline_clip_split`
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

## Offline verification

```sh
node --test tests/mcp-discovery.test.mjs tests/mcp-v4.test.mjs
node --test tests/mcp.test.mjs tests/timeline-mcp.test.mjs
pnpm test:cli
```

The acceptance tests launch the official SDK `Client` with `StdioClientTransport`, perform real initialize/list/call exchanges, and compare state against the same HTTP backend. Coverage includes strict schema parity, CLI/MCP/HTTP visibility, mock generation, exact replay, lost-response recovery, conflict handling, bounded watch/SIGINT without cancellation, file download, and a long-lived MCP process across desktop descriptor/token/port rotation. Tests use isolated temporary data and synthetic mock media; no live credentials or paid generations are used.
