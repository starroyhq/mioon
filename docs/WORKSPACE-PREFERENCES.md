# Durable workspace view preferences

Mioon remembers one shared local-user view per project. Browser windows and the Electron renderer connected to the same backend share that saved view. This is intentionally not a per-browser account preference: the server has a single local-user trust boundary. Independent project IDs and development/production data directories remain isolated. Each project restores its view after it is opened; this change does not persist a global last-opened project, so a fresh desktop launch may initially choose the first project in the list.

## Stored data

The additive SQLite schema version 5 creates `workspace_preferences(projectId, revision, state)` with a project foreign key. It does not change project records, shot revisions, timeline revisions, undo/redo history, immutable versions, job snapshots, media, or idempotency records.

The version-1 state has a strict, complete whitelist, with narrowly optional additive fields for legacy compatibility:

- Active Canvas/Editing mode
- Canvas viewport, node/shot and edge selections, inspector tab, highlighted version, storyboard and minimap visibility
- Editing clip/source selection, preview kind, playhead, timeline zoom, two-axis scroll, collapsed timeline, and timeline magnet (`snappingEnabled`, default `true`)
- Shared asset type filter and legacy collapsed library/inspector flags
- Independent Canvas and Editing panel widths and collapsed library/inspector flags, plus Editing timeline height

Free-text search remains renderer-memory only. Draft text, prompts, credentials, tokens, jobs, file paths, arbitrary object fields and media are never accepted as view preferences. Selections may reference a removed entity; the renderer reconciles them against current project data without changing that data.

## UI-only HTTP contract

These endpoints require the same authenticated loopback token/session and Host/Origin checks as other APIs. They are separate from business RPC, CLI command schemas, MCP tools and the durable business request-recovery log.

- `GET /api/workspace-preferences/:projectId` returns `{ok:true,data:{projectId,revision,state}}`. A project without preferences returns revision `0` and state `null`.
- `PUT` on the same path accepts exactly `{expectedRevision,state}`. The body limit is 16 KiB. The full state must have exactly the documented version-1 fields, correct primitive types, bounded finite numbers and nullable valid entity UUIDs. Legacy v1 callers may omit `editing.snappingEnabled` (meaning `true`), the entire top-level `layout`, or both. A missing `layout` uses default sizes and seeds both modes' collapsed flags from the existing shared flags. A supplied layout must contain exactly both modes and all their documented fields; partial, null, extra and malformed layouts are rejected. An explicit magnet value must be a boolean. All other missing and unknown fields remain invalid.
- Successful writes atomically advance only the preference revision. A stale different state returns HTTP 409 `PREFERENCES_CONFLICT` with the current revision.
- Only an exact canonical retry of the latest accepted state with its original expected revision is replayable. It returns the existing revision without another write. Canonical comparison treats the legacy omitted magnet field as `true` and an omitted layout as the default sizes with shared collapsed flags. It never equates omission with different preferences. An older historical state cannot overwrite a newer view.

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
    "timelineCollapsed": false,
    "snappingEnabled": true
  },
  "shared": {
    "assetFilter": "all",
    "assetsCollapsed": false,
    "inspectorCollapsed": false
  },
  "layout": {
    "canvas": {
      "assetsWidth": 242,
      "inspectorWidth": 310,
      "assetsCollapsed": false,
      "inspectorCollapsed": false
    },
    "editing": {
      "assetsWidth": 242,
      "inspectorWidth": 310,
      "assetsCollapsed": false,
      "inspectorCollapsed": false,
      "timelineHeight": 320
    }
  }
}
```

`activeMode` is `canvas|editing`; `inspectorTab` is `settings|versions`; `previewKind` is `timeline|source`; `assetFilter` is `all|image|video|audio`. Coordinates are within ±1,000,000; Canvas zoom is 0.2–1.75. Playhead is an integer 0–18,000; timeline scale is 28–220 pixels/second; horizontal scroll is 0–10,000,000 and vertical scroll is 0–1,000,000. Revisions are nonnegative safe integers. No value is coerced or silently clamped by the server.

Panel sizes are preferred CSS pixels, allowing finite fractional values: library width defaults to 242 and is bounded to 180–480; inspector width defaults to 310 and is bounded to 240–560; Editing timeline height defaults to 320 and is bounded to 160–800. Each mode's side-panel flags are independent. Once a layout exists, legacy shared flags do not override it. Bottom-panel visibility stays in `canvas.storyboardOpen` and `editing.timelineCollapsed`; it is not duplicated in the layout.

`workspace-layout.js` separates durable preferred sizes from effective viewport geometry. A smaller window can constrain visible widths and height while reserving center space; growing it restores the saved preferred sizes. Viewport resizing never writes those effective sizes or changes saved collapse flags. Explicit panel resizing changes preferred sizes within the documented bounds. The effective helper is pure and does not mutate its input.

## Loading, migration and recovery

The renderer waits for an authoritative preference load before mounting the project workspace and allowing viewport/selection defaults to save. Saved backend state wins over an old renderer cache. Existing local preferences are imported only after the backend positively confirms that no saved record exists. Storage access denial, malformed cache or a failed API read never becomes permission to overwrite remote state.

The magnet and panel-layout preferences retain state version 1, SQLite schema version 5 and the `mioon.workspace.v1:` renderer-cache key. Legacy database records and cache entries without the magnet field load with snapping enabled; an explicit `false` survives normalization, persistence and project switching. Entire layout omission seeds both modes from shared collapsed flags and the default sizes, without sharing mutable mode objects. Backend reads return canonical fields without rewriting stored rows or advancing revisions. Exact replays of legacy stored records likewise leave their bytes and revisions untouched. The renderer accepts an otherwise complete legacy GET with only these documented omissions, without scheduling a migration write. PUT acknowledgements must contain the complete submitted state, including layout and magnet fields; malformed acknowledgements keep the exact CAS request pending for retry. Cache entries with a supplied malformed or partial layout are rejected rather than imported as repaired defaults. No broader partial-state fallback is allowed.

During API failure, the view still works using a bounded local fallback. A visible status explains that view positions are not synchronized. Loading the saved view is an explicit action because it replaces current view choices. A stale concurrent window stops saving and shows that another window updated the view; it does not silently take ownership or retry an overwrite. The user can load the saved view and then make a new choice.

Each project has a serialized compare-and-swap queue. Repeated movement, playhead and scroll updates are coalesced with a 250 ms trailing delay and 1 second maximum wait. Discrete mode, selection and panel changes flush promptly. Transient errors retry the exact submitted body with bounded backoff before sending a newer queued state. Conflicts and non-retryable failures require an explicit reload. Project activation epochs prevent delayed loads from applying to a different or newer navigation.

## Closing and desktop security

Ordinary browser lifecycle events request a keepalive flush. Browser termination can still interrupt the JavaScript continuation needed to send a newer state after an in-flight older save; this is best-effort, not a crash/power-loss guarantee.

On native Electron window close, the main process calls one fixed unprivileged page function that only flushes normal same-origin HTTP requests. The window and backend stay alive while it drains the current and latest queued state, capped at 1.5 seconds. A failure or timeout asks whether to continue editing or exit without the latest view position. The existing unsaved-business-draft confirmation still runs. The main process receives only a boolean; no preload, IPC, Electron API, native file access, token or new permission is exposed to the renderer.

The random nonpersistent Electron session partition and ephemeral backend port remain unchanged. Preferences survive normal quit/relaunch because they live in the existing channel-isolated workspace database. Forced process kill, renderer crash, unreachable backend or choosing to exit after a failed save can lose the most recent unsaved view changes. Already acknowledged writes use the same durable SQLite store as before.
