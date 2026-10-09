# Video Workbench CLI (V4)

The CLI is a local HTTP client for the **same running backend and database** used by the browser, Electron, and MCP. It never starts a second service or reads backend database/media paths. Node.js 24+ and the source workspace dependencies are required; this is not a bundled standalone executable.

From the source checkout:

```sh
pnpm install --frozen-lockfile
pnpm exec video-workbench --help
# Equivalent launchers, without a global install:
pnpm cli --help
node apps/cli/src/index.mjs --help
```

`video-workbench` is the bin of `@video-workbench/cli`. These instructions do not install globally, edit your agent configuration, open accounts, or enable paid generation.

## Connect securely

Choose one connection mode in the environment of the CLI process.

### Electron

Start the desktop app. Set `WB_CONNECTION_FILE` to its owner-only `mcp-connection.json` descriptor (see [DESKTOP.md](DESKTOP.md) for the userData location). Do not set direct credentials in this mode.

```sh
export WB_CONNECTION_FILE='/absolute/path/to/userData/mcp-connection.json'
pnpm exec video-workbench doctor
```

Every HTTP request re-reads the descriptor and adjacent private token, checks the running PID and local origin, and follows token/port rotation after a desktop restart. A disappeared descriptor returns a safe connection error; no fallback backend is selected.

### V4.1 渠道对应的连接文件

正式版 ID 为 `app.starroy.mioon`，开发版 ID 为 `app.starroy.mioon.dev`，包括打包后的开发版。Linux 默认连接文件分别为 `$HOME/.config/app.starroy.mioon/mcp-connection.json` 与 `$HOME/.config/app.starroy.mioon.dev/mcp-connection.json`；macOS 对应 `$HOME/Library/Application Support/` 下的同名目录。实际位置受 Electron appData / `WB_DESKTOP_USER_DATA` 影响。JSON/TOML 中使用展开后的绝对路径。

源码默认构建开发版。两个渠道独立运行、轮换令牌；客户端只连明确配置的那一个，不自动猜测或回退。旧 `video-workbench/` 数据及历史连接配置保留；迁移项目后需手动把客户端连接路径改为目标渠道，详见 [数据迁移](DESKTOP.md#数据位置与单实例)。descriptor 的 `appId` / `channel` 是附加非敏感元数据，协议版本仍为 1。

### Direct Web backend

Start the normal backend separately (`pnpm dev`). Point to its existing owner-only token file rather than copying a token into a shell command, process argument, or agent prompt:

```sh
export WB_BASE_URL='http://127.0.0.1:4318'
export WB_TOKEN_FILE='/absolute/path/to/video-workbench/data/access-token'
pnpm exec video-workbench doctor
```

The token file must be a small regular file owned by the current user and, on POSIX, readable/writable only by that user (`0600`). Symlinks are rejected. Direct token files are re-read for each request. Only `http://127.0.0.1` or `http://localhost` origins are allowed, with no URL credentials, path, query, fragment, or redirects.

Legacy `WB_TOKEN` environment configuration still works, with default origin `http://127.0.0.1:4318`. Legacy explicit token configuration takes precedence over a desktop descriptor, preserving V3 behavior; avoid mixing modes. `WB_TOKEN_FILE` cannot be combined with `WB_TOKEN`, and a descriptor cannot be mixed with direct token-file/base-URL configuration. There is deliberately no `--token` option. Provider API credentials belong only in the separately authorized backend configuration, never CLI inputs or agent config.

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
video-workbench --help
video-workbench --version
video-workbench doctor
video-workbench capabilities
video-workbench schema
video-workbench schema generation.submit
video-workbench generation submit --help
```

`--help`, `--version`, and `schema` work offline. `doctor` authenticates against the backend and reports safe readiness metadata and provider capabilities; it neither submits generation nor exposes secret locations. `capabilities` returns the current `provider.list` data, including legacy fields and per-model `modelCapabilities`. Use enabled/configured/model constraints from that response rather than assuming a provider is ready. Current provider IDs are `mock`, `runway`, `ark`, `veo`, `minimax`, and `vidu`; live providers stay disabled without explicit backend opt-in and an authorized budget.

`schema [operation]` converts the actual exported Zod input schema to JSON Schema. It returns the operation, natural command, MCP tool name, description, `inputSchema`, and `requiresRequestId`. Custom refinements (such as rectangle containment) still run in the shared Zod validator even where JSON Schema cannot represent them.

Every shared operation is available in either form:

```sh
video-workbench project create --input '{"name":"Agent demo"}'
video-workbench rpc project.create --input '{"name":"Agent demo"}'
video-workbench timeline track add --input-file ./track-request.json
cat ./request.json | video-workbench generation submit --input -
```

The command covers projects, assets, shots, canvas nodes/edges, providers, generation, jobs, versions, timeline tracks/clips, and exports automatically from the contracts. `--input-file` and `--input -` read only explicitly requested client-side input. `--input` and `--input-file` are mutually exclusive. Unknown fields, including nested fields, are rejected. `--json` may be specified but JSON is already the default.

## Safe mock workflow

The following commands show the contract. Replace UUID placeholders with IDs returned by previous commands. Preserve each complete intended mutation request in a JSON file before submitting it.

```sh
video-workbench project create --input '{"name":"Offline mock video"}'
video-workbench asset import --file ./reference.png --input '{"projectId":"PROJECT_UUID"}'
video-workbench shot create --input '{"projectId":"PROJECT_UUID","title":"Opening","prompt":"A calm opening shot","referenceAssetIds":["ASSET_UUID"],"aspectRatio":"9:16","duration":2}'
video-workbench generation submit --input '{"shotId":"SHOT_UUID","expectedRevision":1,"requestId":"demo-shot-001-v1","providerId":"mock"}'
video-workbench job watch --input '{"jobId":"JOB_UUID"}' --timeout-ms 60000 --interval-ms 500
video-workbench version list --input '{"shotId":"SHOT_UUID"}'
video-workbench project get --input '{"projectId":"PROJECT_UUID"}'
video-workbench version select --input '{"shotId":"SHOT_UUID","versionId":"VERSION_UUID","expectedRevision":2}'
video-workbench timeline get --input '{"projectId":"PROJECT_UUID"}'
video-workbench timeline seed --input '{"projectId":"PROJECT_UUID","expectedRevision":1,"requestId":"demo-seed-001-v1"}'
video-workbench timeline render --input '{"projectId":"PROJECT_UUID","expectedRevision":2,"requestId":"demo-render-001-v1","purpose":"export"}'
video-workbench export watch --input '{"exportId":"EXPORT_UUID"}' --timeout-ms 60000
video-workbench export download --input '{"exportId":"EXPORT_UUID"}' --output ./agent-result.mp4
```

Revisions above are illustrative for a fresh, otherwise unmodified project. Read the current shot revision from `project get` immediately before `version select`; the first successful generation can auto-select a version and increment the shot revision. Timeline revisions are independent of shot/project revisions; read `timeline get` before new timeline edits. A stale revision is a conflict, never an automatic overwrite.

For simple shot-order export use `export create` with `projectId` and a stable `requestId`; use `export watch` and `export download` on the returned export ID. `timeline render` freezes the independent multitrack timeline. The returned media URL is a relative authenticated local resource, not a public sharing URL.

### Local imports and downloads

`asset import --file` reads local bytes in the CLI process, infers supported MIME type from the extension, and defaults the display name to the basename. Pass `name` or `mimeType` in JSON to override those defaults. Maximum input is 30 MiB. Only bytes, display name, MIME type, and project ID are sent. No local path is sent or accepted as a server-side file import. `--file` and `dataBase64` are mutually exclusive.

Downloads support either the export ID or an existing managed asset ID:

```sh
video-workbench asset download --input '{"assetId":"ASSET_UUID"}' --output ./reference-copy.png
video-workbench export download --input '{"exportId":"EXPORT_UUID"}' --output ./result.mp4 --timeout-ms 60000 --max-bytes 536870912
```

Only UUID managed-media endpoints on the selected backend are fetched, redirects are refused, and the output path never reaches the server. Creation is exclusive: existing output files and symlinks are never overwritten. Interrupted/failed partial files are removed. The default size limit is 512 MiB; `--max-bytes` can be set up to 2 GiB. An export must already have succeeded.

## Idempotency, recovery, and watch

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
