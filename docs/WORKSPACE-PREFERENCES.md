# Durable workspace view preferences

Mioon remembers one shared local-user view per project. Browser windows and the Electron renderer connected to the same backend share that saved view. This is intentionally not a per-browser account preference: the server has a single local-user trust boundary. Independent project IDs and development/production data directories remain isolated. Each project restores its view after it is opened; this change does not persist a global last-opened project, so a fresh desktop launch may initially choose the first project in the list.

## Stored data

The additive SQLite schema version 5 creates `workspace_preferences(projectId, revision, state)` with a project foreign key. It does not change project records, shot revisions, timeline revisions, undo/redo history, immutable versions, job snapshots, media, or idempotency records.

The version-1 state has a strict, complete whitelist:

- Active Canvas/Editing mode
- Canvas viewport, node/shot and edge selections, inspector tab, highlighted version, storyboard and minimap visibility
- Editing clip/source selection, preview kind, playhead, timeline zoom, two-axis scroll, collapsed timeline
- Asset type filter and collapsed library/inspector panels

Free-text search remains renderer-memory only. Draft text, prompts, credentials, tokens, jobs, file paths, arbitrary object fields and media are never accepted as view preferences. Selections may reference a removed entity; the renderer reconciles them against current project data without changing that data.

## UI-only HTTP contract

These endpoints require the same authenticated loopback token/session and Host/Origin checks as other APIs. They are separate from business RPC, CLI command schemas, MCP tools and the durable business request-recovery log.

- `GET /api/workspace-preferences/:projectId` returns `{ok:true,data:{projectId,revision,state}}`. A project without preferences returns revision `0` and state `null`.
- `PUT` on the same path accepts exactly `{expectedRevision,state}`. The body limit is 16 KiB. The full state must have exactly the documented version-1 fields, correct primitive types, bounded finite numbers and nullable valid entity UUIDs.
- Successful writes atomically advance only the preference revision. A stale different state returns HTTP 409 `PREFERENCES_CONFLICT` with the current revision.
- Only an exact retry of the latest accepted state with its original expected revision is replayable. It returns the existing revision without another write. An older historical state cannot overwrite a newer view.

All responses are non-cacheable. Unsupported methods, missing projects and malformed input fail explicitly.

A complete state has this shape (the nullable viewport instead accepts exactly `x`, `y`, `zoom`):

```json
{
  "version": 1,
  "activeMode": "canvas",
  "canvas": {
    "viewport": null,
    "selectedId": null,
    "selectedEdgeId": null,
    "inspectorTab": "settings",
    "highlightedVersionId": null,
    "storyboardOpen": false,
    "miniMap": false
  },
  "editing": {
    "selectedClipId": null,
    "quickAssetId": null,
    "previewKind": "timeline",
    "playhead": 0,
    "pixelsPerSecond": 76,
    "scrollLeft": 0,
    "scrollTop": 0,
    "timelineCollapsed": false
  },
  "shared": {
    "assetFilter": "all",
    "assetsCollapsed": false,
    "inspectorCollapsed": false
  }
}
```

`activeMode` is `canvas|editing`; `inspectorTab` is `settings|versions`; `previewKind` is `timeline|source`; `assetFilter` is `all|image|video|audio`. Coordinates are within ±1,000,000; Canvas zoom is 0.2–1.75. Playhead is an integer 0–18,000; timeline scale is 28–220 pixels/second; horizontal scroll is 0–10,000,000 and vertical scroll is 0–1,000,000. Revisions are nonnegative safe integers. No value is coerced or silently clamped by the server.

## Loading, migration and recovery

The renderer waits for an authoritative preference load before mounting the project workspace and allowing viewport/selection defaults to save. Saved backend state wins over an old renderer cache. Existing local preferences are imported only after the backend positively confirms that no saved record exists. Storage access denial, malformed cache or a failed API read never becomes permission to overwrite remote state.

During API failure, the view still works using a bounded local fallback. A visible status explains that view positions are not synchronized. Loading the saved view is an explicit action because it replaces current view choices. A stale concurrent window stops saving and shows that another window updated the view; it does not silently take ownership or retry an overwrite. The user can load the saved view and then make a new choice.

Each project has a serialized compare-and-swap queue. Repeated movement, playhead and scroll updates are coalesced with a 250 ms trailing delay and 1 second maximum wait. Discrete mode, selection and panel changes flush promptly. Transient errors retry the exact submitted body with bounded backoff before sending a newer queued state. Conflicts and non-retryable failures require an explicit reload. Project activation epochs prevent delayed loads from applying to a different or newer navigation.

## Closing and desktop security

Ordinary browser lifecycle events request a keepalive flush. Browser termination can still interrupt the JavaScript continuation needed to send a newer state after an in-flight older save; this is best-effort, not a crash/power-loss guarantee.

On native Electron window close, the main process calls one fixed unprivileged page function that only flushes normal same-origin HTTP requests. The window and backend stay alive while it drains the current and latest queued state, capped at 1.5 seconds. A failure or timeout asks whether to continue editing or exit without the latest view position. The existing unsaved-business-draft confirmation still runs. The main process receives only a boolean; no preload, IPC, Electron API, native file access, token or new permission is exposed to the renderer.

The random nonpersistent Electron session partition and ephemeral backend port remain unchanged. Preferences survive normal quit/relaunch because they live in the existing channel-isolated workspace database. Forced process kill, renderer crash, unreachable backend or choosing to exit after a failed save can lose the most recent unsaved view changes. Already acknowledged writes use the same durable SQLite store as before.
