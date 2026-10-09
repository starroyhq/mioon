# CLI and MCP operations

All CLI responses are JSON envelopes: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": { "code": ..., "message": ... } }`. Diagnostics and watch progress use stderr. Do not parse progress lines as JSON results. Run `--help` for current flags and documented exit codes.

```sh
node apps/cli/src/index.mjs --help
node apps/cli/src/index.mjs doctor
node apps/cli/src/index.mjs capabilities
node apps/cli/src/index.mjs schema generation.submit
node apps/cli/src/index.mjs project list --input '{}'
node apps/cli/src/index.mjs project create --input '{"name":"Agent video study"}'
```

Use IDs from actual responses. All business operations are available as space-separated words (`timeline track add`) or `rpc timeline.track.add`; `--input` is a JSON object. Inspect `schema <operation>` for exact required fields instead of guessing. `--input-file` can hold larger requests; keep local request files private when they include sensitive user material.

- Projects/assets: `project create/list/get`, `asset import/list`. Import uses `--file <explicit-local-file>` and JSON `projectId`; the client reads and uploads bytes.
- Canvas/shots: `shot create/update/reorder`, `node create/update`, `edge create/delete`.
- Generation: `provider list`, `generation submit`, `job get/list/retry/cancel/reconcile`.
- Results: `version list/select`.
- Timeline: `timeline get`, `timeline track add/update`, `timeline clip add/update/remove`, `timeline seed`, `timeline render`.
- Export: `export create/get`; local convenience commands include `job watch`, `export watch` and `export download`.

MCP tool names replace dots with underscores: `generation_submit`, `timeline_clip_add`, etc. These are actual SDK tools whose schemas use the same contracts as HTTP and CLI. MCP sends ordinary `asset_import` with bytes, not a local path. Use CLI for local-file conveniences and bounded watch/download when the MCP host cannot read or save files directly.

A mutation's `expectedRevision` comes from the record being edited: shot revision for shot update/version select/generation, project revision for shot reorder, timeline revision for all track/clip/render operations. They are independent. A generation or export replay may return the original response; read its job/export ID for fresh status.

Timeline output is fixed 30fps, 720×1280. Positions, trims and lengths use integer frames; same-track overlaps are rejected, cross-track layers are allowed. Asset IDs refer to immutable imported or generated files. `timeline seed` only works on an empty timeline; it copies currently selected shot versions once. Later timeline edits are independent of the shot list.
