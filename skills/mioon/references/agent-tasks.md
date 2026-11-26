# Use the built-in Mio assistant

Use this CLI-only mode only when the user wants Mioon's own assistant to take a natural-language task. Use ordinary Mioon CLI or MCP business tools if the user wants you to edit directly.

```sh
"{{MIOON_COMMAND}}" agent doctor
"{{MIOON_COMMAND}}" agent settings get
"{{MIOON_COMMAND}}" agent policy get
"{{MIOON_COMMAND}}" agent task send --help
```

The readiness check reads configuration, authorization and the catalog without sending a model request. It does not grant sending authorization. Do not change settings, enroll credentials or run a live diagnostic just to complete an ordinary task.

Send with the real `projectId`, the current `expectedSettingsRevision`, a stable `requestId` and the requested `text`. If the user selected an attachment for the task, use `"{{MIOON_COMMAND}}" agent task upload --help` to discover the explicit file and metadata contract. Use only the resulting managed handle.

```sh
"{{MIOON_COMMAND}}" agent task send --input-file task.json
"{{MIOON_COMMAND}}" agent task status --input-file run.json
"{{MIOON_COMMAND}}" agent task watch --input-file run.json --timeout-ms 60000
"{{MIOON_COMMAND}}" agent task history --input-file project.json
```

`run.json` has `projectId` and `runId`. `project.json` has `projectId`. Watch rereads snapshots; an interrupted or timed-out watch stops local observation. A completed conversation can still have pending background work. Report an approval request or unknown result to the user instead of continuing automatically.

If a send response is lost, retain the exact request and use `"{{MIOON_COMMAND}}" agent task lookup` with the project and original request ID. For an uncertain control response use `"{{MIOON_COMMAND}}" agent task action-lookup` with the project, run and original control request ID. Any deliberate control binds the latest run revision and the exact step if applicable. Do not approve, resume or discard under a different request without verifying the user's intent.
