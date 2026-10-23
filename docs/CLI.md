# Mioon CLI (V4)

工作区开关、应用内备份、任务处置和导出控制也通过同一后端提供。具体范围见[工作区设置](WORKSPACE-SETTINGS.md)、[任务处置](TASK-DISPOSITIONS.md)和[导出控制](EXPORT-CONTROLS.md)，使用 `schema` 查询当前参数，避免拼接服务器文件路径

The CLI is a local HTTP client for the **same running backend and database** used by the browser, Electron, and MCP. It never starts a second service or reads backend database/media paths. Node.js 24+ and the source workspace dependencies are required; this is not a bundled standalone executable.

## Mio 的独立管理命令

`mioon agent` 将现有 Mio v2 REST 接到 CLI，使用与界面相同的 Run、审批、预算、工具和回执，不运行第二套执行循环。这些命令不加入业务 RPC schema 或 MCP 工具目录。现有 `agent authorization list/grant/revoke` 继续使用原公共授权接口；连接令牌只证明本地连接身份，不能代替 `project_agent` 发送授权。

后端的 Chat Completions 和 Responses 请求使用官方 `openai@7.39.0` SDK；自定义 fetch 固定接回 Mioon 网关，不改变配置中的服务地址或凭据绑定。SDK 不自动重试，不继承 OpenAI 环境凭据，不输出请求日志；harness 保留有界流解析、工具准入及发送前授权复查。此依赖不增加另一套执行循环，也不默认启用深度思考。

| 命令 | 输入与行为 |
| --- | --- |
| `agent settings get` | `{}`；只返回配置、revision 和密钥 configured/storage 元数据 |
| `agent settings set` | `{expectedRevision, configuration}`；保留同一凭据绑定下的密钥，不接收密钥值 |
| `agent settings secret set/remove` | `{expectedRevision, configuration}`；set 使用下面的安全输入，remove 显式移除 |
| `agent doctor` | `{projectId?}`；连接本地后端，读取公开设置、策略、授权和目录检查摘要，不发送模型请求 |
| `agent diagnose --live` | 与 send 相同，必须包含 `diagnostic`；显式允许诊断模型请求 |
| `agent policy get/set/lookup` | get 为 `{}`；set 为 `{requestId, expectedRevision, stepLimit, modes, acknowledgePaid?}`；lookup 为 `{requestId}` |
| `agent task list/history` | `{projectId}`；history 按对话返回 `conversations`，另接受原样返回的 `cursor`，不含诊断运行 |
| `agent task conversation` | `{projectId, conversationId, cursor?}`；升序分页读取本对话轮次摘要，逐轮详情使用 status |
| `agent task status` | `{projectId, runId}`；读取持久快照 |
| `agent task send/lookup` | send 为 `{projectId, requestId, expectedSettingsRevision, text, conversationId?, locale?, uploads?}`；lookup 为 `{projectId, requestId}` |
| `agent task upload/upload-lookup` | upload 为 `{projectId, requestId, name?, mimeType?}` 加 `--file`；返回托管句柄。lookup 为 `{projectId, requestId}` |
| `agent task pause/resume/stop/approve/deny/skip` | `{projectId, runId, requestId, expectedRevision, stepId?}`；approve/deny 使用快照中的精确 stepId |
| `agent task note` | `{projectId, runId, requestId, expectedRevision, text}`；运行、等待确认或已暂停时，先持久保存补充说明，下一次新模型请求使用。最多排队 5 条，单条同 send 的 32 KiB UTF-8 上限；已知上下文（含已落库的流式回复）与说明组合超过原历史／请求容量时返回 `AGENT_TASK_NOTE_CAPACITY` 和持久 rejected 回执，不改变原执行 |
| `agent task undo-change/undo-all` | 同一控制身份和 revision；undo-change 另传 `changeId` |
| `agent task resolve-unknown` | 同一控制身份和 revision，另传 `stepId, resolution`；仅接受服务端已有的 `discard` / `accept_result` 边界 |
| `agent task action-lookup` | `{projectId, runId, requestId}`；只查询原控制回执 |
| `agent task watch/events` | `{projectId, runId, after?}`；有界观察，默认 60 秒，可设 `--timeout-ms` 和 `--interval-ms` |

`status`、`lookup` 和控制回执返回的公开快照可包含 Step / Change 的 `display` 安全投影；原始 before/after 与补偿数据不因此开放。新版 CLI 与 HTTP 共用 contracts，独立旧版严格客户端需同步升级。内置 Mio 的 `_mio_step` 说明仅存在于模型工具包装，不是 CLI/MCP 业务参数。

终态快照的可选 `executionEndedAt` 是执行结束时间的只读投影；后续撤销的 `run.updatedAt` 仍表示最后更新时间，不能当作执行用时的终点。旧记录没有可靠终态证据时省略该字段；CLI 不推算或补写它。

对话首次发送省略 `conversationId`，由服务端生成并在 `snapshot.run.conversationId` 返回；后续轮次显式传回。不存在、跨项目或诊断身份会被拒绝。省略该参数始终表示新对话，不再把同项目其他对话的最近执行加入上下文。发送 requestId 的重放必须保留原来的对话参数，不能改为另一对话或改变省略状态。响应丢失仍只调用原 `agent task lookup`，不能通过新建对话重发。

`agent task history` 返回标题、更新时间、最后一轮状态、变化条数及轮次数，`cursor` 只用于原项目。`agent task conversation` 的成员 cursor 同时绑定项目与对话，不能跨对话复用。旧 v2 执行各自作为单轮对话；v1 仍按原只读接口读取。诊断运行不进入列表、历史或普通对话上下文，其原始审计记录仍能按 runId／requestId 查询。

`agent task skip` 只用于目标冲突或手动编辑导致的暂停：保留实际冲突目标，本轮之后显式涉及它的工具都返回 `TARGET_SKIPPED`，不产生 Change，也不释放用户草稿。其他目标和新一轮不受跳过名单限制。普通 `resume` 不能绕过此选择，会返回 `AGENT_TASK_SKIP_REQUIRED`；预算和用户暂停仍使用 `resume`。重启中断前还有未处理冲突时，`resume` 只恢复到冲突暂停，随后必须明确 `skip` 或 `stop`；未知结果仍须先按原 `resolve-unknown` 边界处置。选择 `stop` 不写跳过记录。

补充说明属于当前轮，不创建新轮、不增加步骤。已持久化的模型 intent 和已发出的请求不会被改写；最终回复期间到达的补充说明会在同一 Run 预算内继续下一模型步骤，预算不足时保留排队记录，等待明确继续。结束后再发送应使用同对话的 `send`。note/skip 响应丢失后，只查询原 `agent task action-lookup`；回执中的 `result.state=rejected` 是已确定的拒绝，不能换请求 ID 自动重发。

自然语言命令、`schema agent.task.send` 和 `schema agent task send` 均可查看严格参数；`agent --help` 列出独立目录。help、version、schema 不连接后端。`agent doctor` 的“离线诊断”指不调用模型，仍会读取所选本地服务；没有连接时会报告连接不可用。

配置中的 `configuration` 应从公开 settings/presets 读取后编辑，保持完整的 presetId、platformId、baseUrl、model、protocol 五字段。写设置需要当前 revision，发送需要当前 settings revision。配置保存不测试供应商，也不自动授权发送。

`send` 和显式诊断输入中的 `locale` 只接受 `zh-Hans`、`zh-Hant`、`en`、`ja`。省略时沿用简体中文；它固定本轮 Mio 的回复及工具调用说明语言，继续或恢复时不随界面语言变化。同一 requestId 的不同语言会冲突，省略与显式 `zh-Hans` 等价；响应未知时仍只查询原请求。现有 `--locale` 只控制 CLI 呈现，不替代 JSON 中的本轮语言。旧执行记录没有语言标记时沿用简体中文。 本轮传给模型的托管附件说明也使用该语言；四种语言均保留同样的句柄范围限制。

密钥默认使用 **persistent**。安全存储不可用会拒绝；只有明确传 `--storage session` 才存于后端本次生命周期，不自动降级。密钥不能放在 `--input`、argv、模型提示或输出中：

```sh
# metadata.json 只包含 expectedRevision 与 configuration，不包含密钥
mioon agent settings secret set --input-file ./metadata.json
# 在真实终端隐藏输入；也可选择以下其中一种，不得混用
mioon agent settings secret set --input-file ./metadata.json --key-stdin
mioon agent settings secret set --input-file ./metadata.json --key-file /absolute/private/key-file
mioon agent settings secret set --input-file ./metadata.json --key-stdin --storage session
```

`--key-stdin` 消费原始密钥，不能与 `--input -` 共用 stdin。`--key-file` 必须是私有目录内的当前用户独占普通文件，遵循共享私有存储策略；不会自动修权限。Windows 独立 Node 入口需要显式构建并验证完整原生私有存储 helper，缺失时拒绝，不将 chmod 或环境开关当作 ACL 证明。持久密钥属于所选 headless/desktop 服务的独立配置，不读取或复制另一实例的密钥。

诊断使用 `agent diagnose --live`，输入中另传 `diagnostic:{profile:"text"|"read_only"|"catalog",toolNames?:[...]}`；普通 `agent task send` 拒绝该字段并指向明确的诊断入口。底层客户端和 REST 仍复用同一发送接口。text 不提供工具；read_only 只提供只读工具；catalog 可选唯一工具名子集，仅验证目录接受情况，绝不执行模型返回的工具。诊断仍检查 requestId、settings revision、`project_agent` 授权和步数预算，可能产生文本模型费用。诊断成功不能替代完整工具目录下的真实回复、只读往返和自主剪片验收。

每轮执行、上传、策略和控制写入必须保留调用者自己的 requestId；CLI 不生成它，也不自动提交第二次。响应丢失或无法验证时返回 UNKNOWN 与对应 GET lookup；只查原操作，不换 ID、不自动重发。settings PUT 没有 requestId/持久回执，因此未知时在同一个已绑定本地连接上只追加一次有界 GET，错误仍报告未知，并附 revision、配置是否匹配、configured/storage 的公开观察值；不能把 configured=true 当作新密钥已经保存的证明。读回失败也只报告观察不可用，不重发 PUT；Ctrl+C 不再发起读回。后续可手动 `agent settings get` 核对。

所有 Agent 命令仍只向 stdout 输出一个 JSON envelope；watch/events 的持久快照进度写到 stderr。SSE `after` 是序列游标，流中只有 changed 通知，CLI 会重新读取持久快照；断线也只 GET 恢复。events 是同一观察方式，不声称导出完整原始事件日志。等待审批、预算暂停、中断或未知时退出 3 并返回 `action_needed`；失败/停止退出 6，成功退出 0，期限退出 5，Ctrl+C 退出 130 且仅停止本地观察，不停止 Run。继续、批准、停止和未知处置均需要新的明确控制命令。`--workspace-origin` 不适用于这些管理 REST，明确拒绝，不能被当作 HTTP Origin 或静默丢弃。

From the source checkout:

```sh
pnpm install --frozen-lockfile
pnpm exec mioon --help
# Equivalent launchers, without a global install:
pnpm cli --help
node apps/cli/src/index.ts --help
```

`mioon` is the bin of `@mioon/cli`. These instructions do not install globally, edit your agent configuration, open accounts, or enable paid generation.

## Offline whole-workspace backup

`node apps/cli/src/backup.ts` (also `pnpm backup`) is a separate local filesystem
command. It never starts the
backend, resolves a connection descriptor, reads token configuration, contacts a
provider, or resumes a task. Node.js 24+ and the source workspace dependencies
are required. Stop every backend/desktop instance using the selected workspace
before capture, then use explicit canonical absolute paths:

Windows source CLI supports this flow on fixed local NTFS after explicitly
building the complete [Node-API helper](../packages/node-host/README.md). Offline
commands initialize the same verified backend and require its managed streaming
capability; a missing or incomplete helper refuses before locks or destination
creation. Copies use bounded chunks and opaque verified handle leases, with full
file identities, directory flushes and no-clobber publication. Native Windows 11
ARM64 create/verify/restore/status and bundle evidence is recorded in
[CLI acceptance](verification/ai-workflows-acceptance/CLI-SDK-ACCEPTANCE.md).

The legacy manual-draft store remains unavailable on Windows; its draft-protected
`project.delete` flow consequently refuses too. The separate v2 SQLite editing
claims and CLI task controls remain available. Windows desktop packaging and
native x64 certification are outside this delivery.

```sh
node apps/cli/src/backup.ts --help
node apps/cli/src/backup.ts --version
node apps/cli/src/backup.ts create --source /absolute/workspace --destination /absolute/new-backup
node apps/cli/src/backup.ts verify --directory /absolute/backup
# Equivalent source-checkout launcher:
pnpm backup --help
```

The destination must not exist, its direct parent must already exist, and source
and destination must not overlap. Existing locks, uncheckpointed SQLite WAL or
journal contents, unsafe permissions/links and unsupported storage privacy are
refused without repair. Creation uses only its own temporary workspace lock and
does not migrate or initialize the database. SIGINT/SIGTERM request cancellation
and wait for local cleanup attempts; unconfirmed source lock release is reported
explicitly. Incomplete files may remain in the new destination. There is no
overwrite, automatic retry or destination deletion.

This captures the whole workspace across all projects, including the database
and supported managed media/staging payloads. The database includes chats,
prompts, request/replay caches and other user text that may contain secrets.
App credential, settings and connection files are excluded, but this is not a
secret-redacted export. Backups are private plaintext, not encrypted. Keep them
private, and do not upload or share one without reviewing its contents.

Every invocation produces one JSON envelope on stdout, including offline help,
version and errors. Successful capture/verification returns the shared backup
result with `integrity:"verified"`, `restoration:"not_tested"`, payload counts and
bounded inventory issues. Inspect `inventory.complete` and `inventory.issues`:
verified bytes do not imply every referenced media item was present or that
pending work is resolved. Verification does not repair, import or resume work.
Verification alone does not restore data or grant execution. The separate guarded restore workflow below supports fixed schema24 original backups.

Errors contain only a safe code/message, allowlisted details and `retryable:false`;
concise diagnostics go to stderr. Exit codes are 0 for success, 2 for invalid
arguments/paths, 1 for operational refusal/failure, 130 for SIGINT cancellation,
and 143 for SIGTERM cancellation. Flags must be exact and unique; no stdin,
credential, destination-reuse or server options are accepted. Each offline command accepts only its own strict options. The
ordinary authenticated `mioon workspace backup inspect` operation is a separate
bounded read of running-backend metadata; it cannot select filesystem paths or
create a backup.

If source lock cleanup cannot be confirmed, a successfully published backup
remains successful with `warnings:["SOURCE_LOCK_RELEASE_UNCONFIRMED"]`. A failed
or cancelled operation keeps its original error code and adds only
`details.sourceLockRelease:"unconfirmed"`. Preserve the reported outcome and
inspect the source lock before starting another capture; release is not
silently assumed, and no existing lock is automatically reclaimed. Always
inspect result warnings and inventory alongside the exit status; exit 0 alone
does not establish source lock cleanup or inventory completeness.

`WORKSPACE_BACKUP_PUBLICATION_UNCONFIRMED` means final publication durability or
rollback could not be confirmed: a complete marker may already exist. Preserve
that destination and run the separate `verify` command. Marker presence alone
is not proof of a complete backup;
do not assume capture failed without publishing or overwrite/retry in place.

## Guarded offline restoration

From a verified original schema24 backup, use a new independent destination:

```sh
node apps/cli/src/backup.ts restore --directory /absolute/original-backup --destination /absolute/new-workspace
# Read-only discovery when the original restore stdout was completely lost:
node apps/cli/src/backup.ts restore-status --directory /absolute/original-backup --destination /absolute/new-workspace
```

The target's parent must exist. Existing targets, locks, partial publication and
unsupported privacy/schema are never repaired or overwritten. For the exact-ID
status mode, use all four returned `--restoration-id`, `--backup-id`,
`--manifest-hash`, `--source-db-hash` flags with `--destination`; do not mix that
mode with `--directory`. Status returns only `observed_guarded` and
`durability:"not_reconfirmed"`, not proof of the previous command's successful
completion or crash durability. Preserve uncertain targets and original backups.

A restored branch permits explicit fresh local imports/edits/previews/exports.
Captured tasks, approvals, unknown outcomes and requests remain held, unchanged.
New provider/image/Agent/Comfy/frame/waveform execution and recursive backup
creation are unavailable in this first profile. Keep the original backup. No
backend starts automatically. Web can explicitly select `MIOON_DATA_DIR`; for
Desktop restore into a new root's `workspace` child and select that root with
`MIOON_DESKTOP_USER_DATA`. Never copy old credentials/session files into it.
See [the exact restore contract and validation status](WORKSPACE-RESTORE.md).

For a running restored backend, `mioon workspace restore inspect` takes `{}` and
reads the safe origin/restriction summary. Explicit fresh local effects require
`--workspace-origin UUID`; omission or another origin refuses. Pin the value once
for that intended branch; do not automatically adopt a different origin on
reconnect. Original domain inputs/keys/CAS and exact old receipts stay unchanged.
This origin is a mismatch guard, not paid-generation permission. Ordinary
workspaces retain their existing commands and default wire shape.

## Connect securely

Choose one connection mode in the environment of the CLI process.

### Electron

Start the desktop app. Set `MIOON_CONNECTION_FILE` to its owner-only `mcp-connection.json` descriptor (see [DESKTOP.md](DESKTOP.md) for the userData location). Do not set direct credentials in this mode.

```sh
export MIOON_CONNECTION_FILE='/absolute/path/to/userData/mcp-connection.json'
pnpm exec mioon doctor
```

Every HTTP request re-reads the descriptor and adjacent private token, checks the running PID and local origin, and follows token/port rotation after a desktop restart. A disappeared descriptor returns a safe connection error; no fallback backend is selected.

File-based credentials also require a current-user-owned private parent directory, bounded regular single-linked files and a safe canonical ancestry. A `0600` token directly inside a broadly accessible parent is refused. There is no automatic permission repair or fallback to another token. See [private storage and recovery](PRIVATE-STORAGE.md), including the explicit Windows native-helper readiness requirements.

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
for local deterministic Mock PNG test cards. New official/custom/local-ComfyUI requests
cannot be approved through the CLI. Fixed-OpenAI activation at `4e66a96`
(2026-10-10) passed its affected/build/Linux synthetic-native checks and full
suite (2758 total, 2756 passed, 0 failed, 2 skipped). The current
[custom Images increment](IMAGE-COMPATIBLE.md) is implemented with its
own passed focused/build/Linux synthetic-native gates and full suite
(2857 total, 2855 passed, 0 failed, 2 skipped). These do not establish live-provider
or macOS/Windows acceptance. No real provider call is authorized by these checks.

A review file contains exactly `{input:<complete official/custom/local-ComfyUI image.generate input>,
settingsRevision:<current positive settings revision>}`. Obtain that revision
with `mioon image profile list --input '{"includeSettingsRevision":true}'`
and use the selected provider item's `settingsRevision`. Missing/zero/unreadable
revisions are omitted; stop for configuration help rather than guess a number or
borrow another slot's value. Mock never has this field. The ordinary empty-input
call remains byte-compatible; `false` also keeps the old output. This read
returns no keys/settings/endpoint and never approves, probes or dispatches.
A later settings change is still rejected by existing CAS; never silently replace
an already retained intent's revision or key. The complete nested `input` retains the existing field shape,
stable `requestId`, prompt/project, selected model, fixed options and optional
group/revision pair. Custom input uses `providerId:"openai-compatible"` and that
slot's configured model; see the
[exact example](IMAGE-COMPATIBLE.md#public-request-preparation-private-paid-approval).
There is no top-level request key, approval flag, key input or destination override. Prepare only retains this
immutable intent locally. Get/list read retained reviews; none dispatches or
charges. Only the user's explicit application review/approval button may continue
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

If a prepare request loses its response, times out, is interrupted in flight or
receives an invalid response, the client preserves the nested `input.requestId`
in its uncertainty details. Replay the complete original prepare input, including
`settingsRevision`; this does not approve or dispatch generation. A failed
`image request get` is only a failed receipt read: it carries no submission-outcome
claim or mutation-replay instruction and proves nothing about the earlier write.

See [Image generation](IMAGE-GENERATION.md) and
[Images activation](IMAGE-ACTIVATION.md) for shared inputs/limits. Custom review
DTOs additionally retain full immutable configuration and actual destination;
official v1 DTOs and original task/receipt shapes remain intact.
Image discovery is `image profile list`, separate from video `capabilities`.
Enabled means local configuration is present, not live verification or permission
to spend. The `image.generate` effects conservatively include separately approved
paid/external worker work; prepare writes local records and validates the selected
local PNG for edits, while get/list remain read-only.
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

### Local ComfyUI and explicit result retrieval

The first-party `comfy-local` increment is implemented and has been checked with
synthetic fixtures only; see its linked guide for the current full-gate status. It supports ComfyUI `0.39.0`, a selected installed checkpoint and
one fixed seven-node 512×512 PNG workflow. Its no-secret settings and explicit
connection check are private application actions. No CLI operation installs or
starts ComfyUI, downloads models, probes on discovery, or approves generation.
See [the fixed connector contract](COMFY-CONNECTOR.md) for exact local review
input/options, endpoint limits and remaining acceptance gates.

After the user has approved the frozen review in the application, the shared
remote operations are available through the normal catalog:

```sh
mioon schema image.task.remote.get
mioon schema image.task.observeRemote
mioon image task remote get --input '{"projectId":"PROJECT_UUID","taskId":"TASK_UUID"}'
mioon image task observeRemote --input-file ./comfy-observation.json
```

The observation file contains exactly
`{projectId,taskId,expectedRevision,requestId}`. Set `expectedRevision` to the
current `remote.revision` returned by `remote get`, not the image task revision.
Retain the complete input with a distinct 8–200-character observation key.
`remote get` only reads local records; it makes no ComfyUI request. An accepted
`observeRemote` returns its original queued acknowledgement and schedules one
bounded job GET plus, on verified terminal success, one fixed PNG GET and managed
publication. It never submits a prompt. `finished` observation state alone is not
success; inspect the remote evidence and image task.

Lost ACK: replay the exact observation input/key to recover the original ACK
without another GET, then read current local records. A later explicit query
requires a new observation key and current remote revision after the old query
is no longer active. There is no automatic runtime polling or GET/POST on startup;
a prompt UUID is not generation idempotency. The old `recoverResult` operation
still only publishes task-bound local bytes. Stopping the CLI or local observation
cannot cancel ComfyUI work; remote cancellation is not implemented. These
operations add no built-in Agent authority. Do not infer offline, safe or free
computation from a loopback address or reported model/class name.

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

### Refresh stale clips and append new shots

`timeline clip refreshSources` switches clips whose shot now selects another
version to that version; `timeline shots append` adds shots that have no clip
yet to the end of the first video track. Read `timeline get` first:

```sh
mioon timeline clip refreshSources --input '{"projectId":"PROJECT_UUID","clipIds":["CLIP_UUID"],"expectedRevision":7,"requestId":"refresh-clips-0001"}'
mioon timeline shots append --input '{"projectId":"PROJECT_UUID","expectedRevision":8,"requestId":"append-shots-0001"}'
```

Each is one undoable edit. The result wraps the timeline with `refreshed` /
`appended` and `skipped` rows and their reasons. When nothing applies, the
request writes nothing and fails with `NOTHING_TO_REFRESH` /
`NOTHING_TO_APPEND`. Keys and replay follow the timeline edit rules above.
Full semantics: [Canvas → timeline bridges](API.md#canvas--timeline-bridges-2026-10-23).

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

Built-in Agent [selected-clip move proposals](AGENT-TIMELINE-MOVE.md) use the
same `timeline.clip.update` CAS/replay/history service as this CLI. Their human
approval/rejection/recovery routes are not CLI commands or new external-agent
authority. An external caller still supplies its own explicitly authorized
exact input and stable timeline request key.

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
one of the three [30fps timeline output presets](TIMELINE-OUTPUT-FORMATS.md). Limits are 100 assets, 512MiB/source, 1GiB total hashed bytes,
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
`subject.create`, `subject.version.add` and `subject.binding.set`, for fifteen operations. `timeline.format.set` is now the sixteenth explicit operation, in the timeline lane. The three explicit `timeline.subtitle.add`, `timeline.subtitle.update`, and `timeline.subtitle.remove` operations brought the total to nineteen, sharing `timeline:mutation`. The explicit `timeline.loudness.apply` operation is now the twentieth entry in that lane; its scalar durable intent and exact receipt use the [atomic apply contract](TIMELINE-LOUDNESS-APPLY.md). It adds no CLI task-execution command and
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
fifteen at that stage, under `subject:mutation`; the later format operation makes sixteen, and three subtitle writes made nineteen, and explicit `timeline.loudness.apply` now makes twenty. Direct CLI requests do not automatically become
UI tasks. Local metadata is ordinary SQLite, not vault-encrypted: keep secrets out
of names and inputs. This is local planning without provider calls, paid work,
Blender or built-in Agent catalog/context changes. Actual `first_frame` continues
through `reference attach`. Later [saved first/last frames](VIDEO-FRAME-PAIRS.md)
and [explicit subject-version input](SUBJECT-VIDEO-INPUTS.md) are separate
generation choices, never implicit planning-binding uploads. Motion remains
future work.

## Local source-frame extraction

The six `frame` commands use the same existing backend and strict
[frame RPC contract](API.md#local-source-frame-extraction). The feature is under
acceptance; check [current scope/gates](SOURCE-FRAMES.md). Discover exact fields:

```sh
mioon schema frame.extract
mioon schema frame.task.recoverResult
mioon frame task list --input '{"projectId":"11111111-1111-4111-8111-111111111111","limit":20}'
```

Replace illustrative IDs with actual project-owned IDs. `frame extract` takes
`{projectId,sourceAssetId,sourceHash,sourceFrame,requestId}`. Read the managed
source's actual hash; do not accept client paths, output names, timestamps,
provider choices or decoder arguments. `sourceFrame` is a 30fps editing mark,
not a native frame/PTS. The fixed profile selects the first PTS at or after the
mark, returning a new local PNG with longest edge 1024 and no upscaling.
It does not modify or automatically bind existing media, timeline or references.

Read `frame request get` with `{projectId,requestId}` for the original receipt,
`frame task get` with `{projectId,taskId}` for current state, and `frame task list`
with `{projectId,limit?,cursor?}` for read-only history. Lists default to 20/max 50;
pass only a returned cursor unchanged with the same project/limit. Restart
invalidates cursors. No `frame watch` command or hidden read-to-write retry exists.

`frame task cancelQueued` and `frame task recoverResult` each require
`{projectId,taskId,expectedRevision,requestId}`. Use the current task revision and
a new key for a new explicit control intent. Cancellation covers only provably
unstarted work; recovery publishes an already-staged complete PNG/manifest,
without re-decoding. Missing/corrupt local results never cause new extraction.
Restart/list/get/replay do not execute unfinished tasks.

Retain the exact operation, full input and caller-owned 8–200-character key until
known. The three writes share only the frame request namespace, separate from
image/timeline/reference/local edits. Exact replay returns the immutable original
ACK, even when a later task read says succeeded/interrupted. Changed input,
operation or project under the same key conflicts. Control task DTOs retain the
initial extraction key; their receipt lookup uses the control request's key.

Timeout, connection loss or a malformed/mismatched 200 response retains the
original key with `submissionMayHaveSucceeded:true`; the CLI never replaces it
or automatically retries. Only the exact operation/input/project/key/SHA-bound
backend `frameOutcome` proof under the API's code/status whitelist permits
`false`. A code, message, generic 4xx or absent lookup alone is insufficient.
The request journal is plaintext local SQLite, not encrypted durable CLI intent
storage; retain any not-yet-accepted request outside the short-lived CLI process.
The local limits and supported video profile are in the API contract. No paid
provider call, Blender dependency or built-in Agent catalog expansion is added.


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

## Per-export MP4/H.264 settings

Discover `mioon schema timeline.export.capabilities` and `mioon schema timeline.render`.
The capability operation requires `{projectId,expectedRevision,exportSettings}`;
settings are a strict `mp4_h264_v1` profile, for example
`{"profileId":"mp4_h264_v1","resolution":"short_360","rateControl":{"mode":"crf","quality":"high"}}`.
Call `mioon timeline export capabilities --input '<JSON>'` explicitly; it runs
bounded local synthetic encoding without creating an export. Then optionally
include the same settings in source preflight and in an explicitly authorized
`timeline render` with `purpose:'export'`, the saved revision and stable key.
Retain the exact input through unknown outcomes; never change settings/key on
an unresolved retry. See [scope and recovery](EXPORT-SETTINGS.md).

## Saved video frame pairs

`mioon schema shot update` exposes optional `patch.lastFrameAssetId`. Save a
same-project image UUID with the existing shot revision and stable request ID;
send `null` to clear it, or omit the property to leave it unchanged. Existing
`referenceAssetIds` and first-frame connection commands still own only the first
slot. Read the resulting shot and the exact `provider.list` profile before
explicitly invoking `generation.submit`. Ark Seedance 2.5 and Mock implement the
paired route; unsupported roles/providers fail rather than silently discard input.
A saved tail without a first image is an incomplete draft, not a ready request.

The job snapshot contains the complete first/last binding and source hashes.
`job.retry` on a confirmed failed job reuses that frozen selection, not the latest
shot tail. An unknown submission must be reconciled without a new POST. Existing
manual shot mutation recovery retains its session-only pending receipt limitation.
See [VIDEO-FRAME-PAIRS.md](VIDEO-FRAME-PAIRS.md); Mock does not depict the references
and this documentation does not authorize a paid call.
## Explicit subject-version video submission

Discover `generation.submit` and `provider.list`, then read the chosen project's
`subject.list` / `subject.version.list`. Select a fixed version UUID explicitly;
neither the head nor planning bindings are inferred. Save the exact request JSON
and stable key before sending. Example for local workflow testing:

```sh
mioon generation submit --input '{"shotId":"SHOT_UUID","expectedRevision":1,"requestId":"subject-video-0001","providerId":"mock","subjectVersionId":"SUBJECT_VERSION_UUID"}'
```

The shot must have no saved first/last images or first-frame connection. These
are not removed by submission. Inspect the returned full frozen subject source;
on uncertainty reuse only the exact original key/input, never reselect a newer
head. `job.retry` of a confirmed failure retains the old snapshot. Mock does not
render reference likeness. Ark is a separately authorized paid action and direct
real-human-face uploads are unsupported. See [the scope and validation status](SUBJECT-VIDEO-INPUTS.md).


## Named timeline deliveries

Discover `mioon schema timeline.render` and `mioon schema timeline.export.preflight`. Include the identical optional `deliveryName` in preflight and a separately intended export request. Do not pass it to `timeline export capabilities` or a preview. Read `export get` for the frozen name/settings. Existing `export download` keeps its explicitly selected local destination; a display title never grants filesystem authority.
See [scope and acceptance](NAMED-DELIVERIES.md).


## Selected-range timeline test export

Discover `mioon schema timeline.render` and `mioon schema timeline.export.preflight`. For a separately authorized export, pass identical `exportRange:{startFrame:15,endFrame:75}` to source preflight and render alongside the saved revision, optional name/settings and stable request key. This means60 composition frames at30fps; frame75 is excluded. Keep the report's exact digest or clearly use the existing unchecked path. Do not send range to capabilities or preview.

On a lost response, retain the original complete JSON and key; do not rebuild it from a newer range or timeline. `export get` exposes the frozen full snapshot plus selected range. The CLI's explicit output destination is unchanged. See [limits and acceptance](SELECTED-RANGE-EXPORT.md).


### 已导出文件解码样本峰值

Discover `mioon schema timeline.export.samplePeak`, then explicitly call `mioon timeline export samplePeak --input '{"projectId":"11111111-1111-4111-8111-111111111111","exportId":"22222222-2222-4222-8222-222222222222"}'`. This checks an existing succeeded timeline MP4; no request ID, file path or caller hash is accepted. It can consume local CPU/file reads for a bounded 120-second attempt (shared-client default125s unless explicitly overridden). Ctrl+C cancels this observation, not the original export. Output loss does not trigger an automatic retry.

This is decoded sample peak of the final artifact, not loudness or true peak. Reports are ephemeral; unsupported/incomplete/stale checks leave existing downloads usable. Restored-v1 branches explicitly refuse the new analysis. See [contract and limits](EXPORT-SAMPLE-PEAK.md).


## Explicit exported-file loudness check

Discover `mioon schema timeline.export.loudness`, then use `mioon timeline export loudness --input '<JSON>'` with the selected project's succeeded export ID, its actual expected output SHA-256 and fixed measurement profile from the schema. The optional LUFS/dBTP target is explicitly user-chosen; omission only measures. This resource-intensive read shares the samplePeak slot and fixed120s budget; client default125s remains overridable. Ctrl+C stops only this check. It does not normalize, render or queue edits, and lost output is no reason to automatically retry. Full JSON, validity states and source-bound advisory limits are in [EXPORT-LOUDNESS](EXPORT-LOUDNESS.md).

## Explicit saved-timeline full-mix candidate

Discover `mioon schema timeline.loudness.prepare`, then use `mioon timeline loudness prepare --input '<JSON>'` (or `mioon rpc timeline.loudness.prepare`). Supply the owned `projectId`, saved `expectedRevision`, fixed `mixProfile:"timeline-float-mix-v1"`, fixed `measurementProfile:"bs1770-5-48k-stereo-fir4x-v1"` and explicit user-selected `target:{integratedLufs,truePeakCeilingDbtp}`. No target/profile is defaulted; no request ID, path, URL, export ID, arbitrary file flag or permission flag is accepted.

This complete pre-encode float-mix observation returns the original measurement and, if every resulting gain is representable, a separately measured fixed-multiplier candidate. Passing target/true-peak checks leaves `applyAllowed:false`; nothing is edited, queued or exported. The bounded local work uses120s with125s shared-client grace and a64KiB response reader. Ctrl+C retires only its owned observation; response loss never triggers an automatic retry. Restored-v1 refuses it. See [exact report boundary](API.md#saved-timeline-full-mix-loudness-preparation).

## Explicit atomic fixed-gain application

Discover `mioon schema timeline.loudness.apply`. After an explicitly reviewed current prepare report, call `mioon timeline loudness apply --input '<JSON>'` with its project/revision/profiles/target, snapshot hash, versioned candidate digest and one stable requestId. There is no client gain list. The server repeats full measurement before committing one gain group, revision and undo entry. A same-key retry returns the immutable original ACK first; changed content conflicts. Ctrl+C or output loss does not cancel an accepted edit. Preserve the exact key/input and reconcile; never invent a replacement key from a timeout. The operation has no model/network/payment effects and is not a built-in Agent tool. See [atomic application](TIMELINE-LOUDNESS-APPLY.md).

## LUT resource foundation

`mioon lut import --file /owned/path/look.cube --input '{"projectId":"PROJECT_UUID","requestId":"STABLE_REQUEST_KEY"}'` reads bounded local bytes, not a backend path. `mioon lut list` and `mioon lut inspect` use the same RPC input shapes. The shared source limit is7MiB, not the standalone parser's32MiB ceiling. No LUT is yet applied to a clip or rendered. See [LUT resources, replay and recovery](LUT-RESOURCES.md).


## 项目文件（.mioon）

`mioon project export|import|duplicate` 走专门的管理接口，不在业务 RPC schema 和 MCP 工具目录里，详见 [PROJECT-PACKAGE.md](PROJECT-PACKAGE.md)。

| 命令 | 输入 |
| --- | --- |
| `project export` | `--input '{"projectId":"…","media":"all"\|"used"}' --output <新文件>`；不覆盖已有文件，进度写到 stderr |
| `project import` | `--file <文件.mioon> --request-id <id>`，可选 `--input '{"name":"…"}'`；先完整校验再创建 |
| `project duplicate` | `--request-id <id> --input '{"projectId":"…","name":"…"}'` |

导入和复制要求调用方提供 requestId；用同一个 requestId 重试时，返回同一个项目。
