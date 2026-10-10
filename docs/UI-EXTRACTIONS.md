# Q5: export-history presentation extraction

Date: 2026-10-10 UTC. Baseline: `10291b80984a644c1917ca31f740c0a266be7de2`.
Status: implementation, affected checks, fresh builds and Linux native regression complete; parent independent aggregate/review is the local release gate.

## Boundary and benefit

`ExportHistoryList.jsx` now owns only the export-list presentation previously embedded in `App.jsx`: empty state, ordered rows, status/error text, immutable snapshot labels and download links. Three props carry already-selected data: `orderedExports`, `projectName`, `timelineRevision`. It has no hooks, requests, mutations, sorting or new framework/dependency.

App still owns project identity, ordering, polling, `showExports`, the accessible controlled `Modal`, its original title/description, and the exact close callback that increments `navigationEpoch`. Project-switch cleanup, request/draft fences, right-dock tabs, workspace modes and CSS are unchanged. The extraction removes 1,231 bytes from the dense App file (93,690 → 92,459 bytes); the readable new component is 36 lines. This is a small independent characterization seam, not a whole-App simplification or a completed Q5 roadmap.

Preserved deliberately:

- All three downloadable statuses, URL-before-asset fallback, percent-encoded URLs and existing download attributes. The existing Electron download/security policy is unchanged; this component is not a new arbitrary-URL sanitizer.
- React escaping, string/object error messages, pending spinners, failed badge and locale date formatting.
- Strict revision equality and preview/export/storyboard labels. Display fallback `成片.mp4` and download fallback `film.mp4` remain distinct.
- Supplied order, row keys, DOM wrappers/classes and control semantics.

## Acceptance evidence

Evidence root: `evidence/q5-export-history/` (local, ignored generated artifacts).

- New real-React/browser-SSR characterization: 8/8 pass. Frozen fixtures prove no mutation; the SSR fixture forbids fetch. App assertions pin controlled dialog/accessibility, sorting, project cleanup and close epoch ownership.
- Serial affected UI suite: 247/247 pass, zero skips, 5.1 seconds. Includes workspace visibility/layout/state/panels, Agent chat/settings, reference UI, timeline history/split and UI components. Logs: `focused/initial.log`, `focused/affected.log`.
- Independent read-only baseline comparison found no markup, branching, escaping, revision, ordering or lifetime change. No business services, HTTP/MCP/CLI contracts or model tools changed.
- Fresh installed-entrypoint web build passed (14.88 seconds; existing large-chunk warning retained), followed by desktop build. No dependency install was needed. Web asset: `index-HVXTqUgW.js`; CSS unchanged `index-C0iThKkj.css`. `builds/artifact-manifest.json` hashes all 49 generated web/desktop files.
- Actual ordinary sandboxed Linux Electron 44.7.0 UI, final bundle, private synthetic fixture: empty history; real local FFmpeg export queued → succeeded; current revision label; old-snapshot label after a timeline change; close button/Escape and keyboard reopen; separate project has no stale rows; same export is visible across canvas/editing modes. Native Save As opens and cancellation returns safely. Native text entry into that GTK dialog was unavailable in the automation adapter, so no completed native Save As download is claimed.
- Native quit exited 0. Read-only DB/output audit: one succeeded export, zero generation jobs and zero Agent runs; four-second 720×1280 video with audio, 441,453 bytes, SHA-256 `9445bc3df26a6051cc094e18ba87bec4cae640330f4ba4b7c8201ac520019369`, matching its published asset. Export snapshot stays revision 2 while the timeline becomes revision 3.
- Screenshots `native/01-empty-history.jpg`, `02-ready-history.jpg`, `03-old-snapshot.jpg`, `04-project-isolation.jpg`, `05-canvas-history.jpg` are unchanged-UI regression evidence, not new functionality. `02` or `03` is the clearest delivery image. Native launcher/fixture and launch/exit/output audit records are retained beside the screenshots.

No separate full aggregate or standalone browser end-to-end suite was rerun by this worker; parent owns the final aggregate. Native runtime is Linux development evidence only, not macOS/Windows or packaged-release verification. No live provider request or real credential was used. No network packet capture was performed.

## Still open

EQ-09 remains open for other dialogs, the project-session hook, generation/reference/timeline orchestration, repeated lookups and styles. Extract each cohesive boundary with its existing fences intact; avoid generic command/modal frameworks or simultaneous redesign. Q6 portable checks/build hooks are a separate increment. Native Windows support remains blocked by the explicit ACL gate; neither this extraction nor configuration-only platform hooks establish release readiness.
