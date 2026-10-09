# Durable workspace preferences acceptance — 2026-10-09

Baseline: `650c04c`. This bounded follow-up persists each project's Canvas/Editing view independently of business data. The same worktree also contains the user-requested Mioon rename and one-time renderer-key migration; its details and separate regression evidence are in [MIOON-MIGRATION.md](MIOON-MIGRATION.md).

## Implemented scope

- Shared single-user view preferences for each project in a schema-v5 additive SQLite table, with their own revisions.
- Dedicated authenticated `GET/PUT /api/workspace-preferences/:projectId`, strict complete whitelist, finite bounds, UUID selections, 16 KiB body limit, Host/Origin protection, CAS conflict rejection and exact-last-write replay.
- Initial authoritative load before workspace mounting/default effects; safe legacy cache import only after confirmed remote absence; no remote overwrite after failed/malformed reads or denied local storage.
- Serialized coalesced frequent updates, prompt discrete saves, bounded exact-body retries, stale-navigation guards, and visible conflict/reload handling.
- A bounded native close drain for in-flight plus latest queued view state, followed by the existing business-draft guard and backend cleanup. A failed/timed-out view save requires the user to choose exit or continue editing.
- Existing random nonpersistent Electron session, ephemeral backend port, no Node/preload/IPC renderer privileges, and development/production data isolation remain unchanged.

Persisted values are mode, viewport, selections, playhead, zoom, scroll, type filter and panel visibility. Search text is memory-only. There are no saved prompts/drafts, credentials, jobs, paths or media; no business RPC/MCP operation, project/shot/timeline revision increment or undo entry is added. [Full state and lifecycle contract](WORKSPACE-PREFERENCES.md).

Each project restores after it is opened. The global last-opened project is not persisted by this change.

## Automated checks

| Stage | Result | Evidence |
| --- | --- | --- |
| Full aggregate | 428/428 passed, 0 skipped; independent parent run also passed | `evidence/mioon-rename/all-tests-final.log` |
| Preference/state/native-close focused tests | 54/54 passed | `evidence/workspace-preferences/focused-tests.log` |
| Web production build | Passed | `evidence/workspace-preferences/web-build.log` |
| Development Electron staging build | Passed; bundles same renderer/shared backend | `evidence/workspace-preferences/desktop-build.log` |
| Whitespace/error check | Passed | `git diff --check` |

The focused tests include strict schema/size/auth/origin, four concurrent SQLite connections, independent projects, malformed successful responses, denied storage, stale/reordered requests, exact replay after lost responses, bounded retries, final flush during an older in-flight request, native close timeout/cancellation, and retention of unsaved-draft confirmation. A real backend process is killed and restarted against the same data directory; acknowledged preferences/revision persist without changing business/history bytes. This is real process restart coverage, not only an in-memory mock.

The dependency rename used the frozen lockfile without dependency-version changes. The existing Vite chunk-size advisory remains. No installer, package, deployment, push or live-provider generation is part of this checkpoint.

## Actual native Electron verification

**6/6 native cases passed.** Report: `evidence/workspace-preferences/native-report.json`.

The ordinary development Electron build ran in the own-cloud Linux graphical session, controlled through supported CUA. No remote-debugging port, smoke bridge or sandbox disabling was added. All data and media were disposable synthetic copies under `evidence/workspace-preferences/`.

- Canvas view was changed and the window closed 237 ms after mode selection, without a debounce wait. Full application exit returned code 0 and removed descriptor, token and workspace lock. Relaunch used a different backend port and utility PID. Reopening the test project restored the Canvas selection, 75% viewport, Versions inspector tab, minimap and collapsed library, plus the independent Editing state.
- Editing mode was then selected and the window closed after 255 ms, again without an explicit wait. A second full relaunch restored selected fixed clip, source preview, playhead frame 137, timeline scale 220 pixels/second (displayed as 289%), horizontal scroll 480 and vertical scroll 174. Business/history snapshots were byte-for-byte unchanged.
- The native “restart local service” menu separately replaced the backend PID/origin and preserved exact saved preferences and domain/history state.
- Pausing only the verified disposable utility process made its API unavailable. Native close reached the save failure prompt with the configured 1.5-second deadline; exact wall-clock prompt appearance was not instrumented. Choosing to exit did not hang indefinitely and cleaned the descriptor/token. Forced termination of that paused utility leaves a stale workspace lock, unlike normal graceful close. A fresh native relaunch recovered that stale lock and restored the exact last acknowledged Editing revision 19; the explicitly discarded outage-time Canvas choice was absent. Domain/history remained identical.

Screenshots inspected from the actual native application:

- `evidence/workspace-preferences/native-restored-canvas.png`
- `evidence/workspace-preferences/native-restored-editing.png`
- `evidence/workspace-preferences/native-unavailable-confirmation.png`

## Actual browser verification

**14/14 browser cases passed.** Report: `evidence/workspace-preferences/browser/report.json`.

The production renderer used the real authenticated backend and SQLite through the supported own-cloud Chromium browser. A test-only same-origin proxy can hold, truncate or reject a preference response and inject a throwing localStorage getter; it does not alter the production bundle or authentication/security policy. Such injected storage denial is distinguished from browser-settings-level denial.

Runtime cases cover Canvas and Editing reload restoration; independent projects; two actual browser windows racing CAS writes; conflict warning and explicit saved-view reload; exact retry of an accepted truncated response; HTTP503 recovery; older in-flight save plus newest queued view; missing entity reconciliation; a delayed project preference load; denied view storage; and byte-for-byte unchanged business/history snapshots. Historical-to-Mioon key migration checks preserve exact pending request JSON bytes and request ID without replaying business operations. Conflicting historical/current keys fail closed. An initial preference GET503 followed by local view edits leaves the saved server state and revision unchanged; explicit saved-view reload restores the authoritative view.

Detailed results and screenshot lists are in `evidence/workspace-preferences/browser/report.json`.

## Limits

- Native Linux development runtime was exercised. New packaged Linux binaries/installers and macOS/Windows native behavior were not tested here.
- Prior reference/history/dual-workspace browser suites are historical evidence, not claimed as rerun by this checkpoint; the full automated regression suite was rerun.
- Browser teardown keepalive is best-effort when a newer state still requires a continuation after an older request. Native close keeps the renderer alive for a bounded drain, but forced kill/crash/power loss, unreachable backend or explicitly exiting after failure can lose unacknowledged view changes.
- No global last-project preference, timeline split, clip replacement, waveform, new output ratio, generation capability or paid-provider work is included.
