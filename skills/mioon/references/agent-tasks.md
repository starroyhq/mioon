# Control the built-in assistant through CLI

Use this mode when the user wants Mioon's own assistant to plan and execute a natural-language task. When the user wants the external agent to perform edits itself, keep using the ordinary business CLI or MCP tools. Both modes use the chosen running backend and project. Never start a second writer on its data directory.

The Agent management namespace is absent from RPC/MCP/model tool discovery. Its existence does not authorize changing connection settings, granting sending scopes, approving costs or reading credentials. Follow the user's actual task and previously granted scope; do not invent an extra approval policy.

## Inspect without a model request

```sh
node apps/cli/src/index.ts agent doctor
node apps/cli/src/index.ts agent settings get
node apps/cli/src/index.ts agent policy get
node apps/cli/src/index.ts agent task send --help
```

`agent doctor` contacts the local service and reads safe configuration, credential availability, authorization scopes and structural tool-schema checks. It does not call a model. A valid catalog is not proof that the selected provider accepts its schema.

`agent diagnose --live` explicitly sends a diagnostic task under the normal gateway, authorization, journal and step budget. Profiles are `text`, `read_only` and `catalog`; only catalog accepts a host-selected `toolNames` subset, and catalog probes never execute returned tools. Diagnostic profiles persist on the Run. Shrinking the catalog or succeeding without tools is not acceptance of ordinary full-catalog tasks. Ordinary `agent task send` cannot select a diagnostic profile.

## Send, observe and recover

Discover the exact input with each command's `--help`. Use the real project ID, current settings revision and one caller-owned request ID. For example, `agent task send` metadata contains `projectId`, `expectedSettingsRevision`, `requestId` and `text`; optional `uploads` contains only handles selected for this task.

Use `agent task upload --file <selected-file> --input-file <metadata.json>` for model-accessible attachments. Its metadata contains the project and retained request ID, with optional display name/MIME. The model receives a managed handle, never an arbitrary client/server path or raw bytes. Ordinary business `asset import` remains available for direct external-agent workflows.

After send returns a Run ID, use:

```sh
node apps/cli/src/index.ts agent task status --input-file run-location.json
node apps/cli/src/index.ts agent task watch --input-file run-location.json --timeout-ms 60000
node apps/cli/src/index.ts agent task history --input-file project-location.json
```

Run-location metadata is `{projectId,runId}`; project-location metadata is `{projectId}`. Watch consumes SSE change notices and rereads persisted snapshots. stdout is one JSON envelope; progress goes to stderr. Read the envelope as well as the exit code: watch returns `outcome:"action_needed"` with exit 3 for approval, pause, interruption or an unknown step; timeout is 5, failed/stopped is 6, Ctrl+C is 130. Ctrl+C does not stop the server task. A completed model Run can still have background work pending.

For lost send/upload/policy/control responses, retain the exact request and use the matching `lookup`, `upload-lookup`, policy `lookup` or `action-lookup`. These are reads. Do not automatically repeat the write or invent a new request ID. Settings PUT has no durable receipt: reread settings, preserve an unknown outcome and do not infer that a specific Key was saved merely from `configured:true`.

## Controls and safety boundaries

Use `pause`, `resume`, `stop`, `approve`, `deny`, `undo-change`, `undo-all` and `resolve-unknown` only within the user's delegated task. Every control requires its own retained request ID and the current Run revision. Approval also identifies the exact pending step; it cannot approve different parameters or a changed target. Inspect its tier, arguments and cost evidence first. Unknown model results and generation submissions have different recovery paths; do not resubmit generation as recovery.

The default round is 30 steps. Continuing adds a round to the same Run; it does not replay completed steps. Watch never automatically approves, extends budgets, resumes or disposes of unknown results. Undo retains irreversible products and fee evidence and must stop at external edits rather than overwrite them.

## Configuration and credentials

Use `agent settings set`, `agent settings secret set/remove` and `agent policy set` only when configuration changes are in scope. Settings writes require the current settings revision. Secret input is hidden TTY by default, or an explicitly selected private `--key-file` / exclusive `--key-stdin`; metadata contains configuration and revision only. Never put a Key in chat, JSON metadata, argv or an MCP argument, and never extract a desktop process's saved Key.

Persistent storage is the default; explicit session storage is available. Unavailable persistent storage fails without silently falling back. Linux needs a session D-Bus and unlocked Secret Service. Windows headless needs the separately built native private-storage helper and a supported local NTFS path; missing native protection must remain a refusal. Consult the application CLI/private-storage documentation for current platform acceptance rather than claiming an untested platform is ready.

Paid tool policy remains separate from sending authorization and exact-step approval. A configured Key, successful text diagnostic or saved policy does not grant unrelated generation. The independent raw Images review/approval boundary remains unchanged; do not call its private endpoints to bypass user review.
