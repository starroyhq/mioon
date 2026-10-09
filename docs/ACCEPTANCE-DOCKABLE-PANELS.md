# Fixed dock panels acceptance — 2026-10-09

Baseline: `821600f` (precise timeline drag snapping). This renderer/layout iteration keeps Mioon 0.4.1, its existing native trust boundary and business operations unchanged.

## Implemented scope

- A continuous Canvas surface with fixed overlay side docks, gutters, rounded borders and restrained shadows. Hiding or resizing a dock never fits, moves or remounts the Canvas.
- Editing reserves independent grid space for the library, preview, inspector and full-width bottom timeline. The preview is not covered by the docks.
- Pointer and keyboard resizing, minus collapse, desktop edge recall, a Base UI Panels menu and current-mode-only default-layout reset. These are fixed docks, not detachable windows.
- Independent project-local Canvas/Editing preferred sizes and side visibility, saved through the existing authenticated preference CAS queue. The strict additive v1 layout whitelist supports only whole-group legacy omission, preserves canonical exact replay and retains the magnet preference. SQLite schema-v5 and the cache key are unchanged.
- Preferred dimensions remain stable when a window constrains effective dimensions. Narrow/short windows present one reachable panel at a time with permanent mobile navigation, including an Editing timeline view.
- Hiding keeps editor instances, dirty drafts, selections and scroll positions. Hidden media pauses without losing its source/time or automatically restarting; hidden controls are inert. Ordinary object selection respects an explicitly hidden Inspector. Selecting another object still uses the existing dirty guard.
- App-local Select/Tooltip composition closes portaled UI when its owner hides, rejects pre-hide callbacks after recall and suppresses stale focus restoration. Shared Base UI primitives remain unchanged.
- Resize gestures remain local until release, cancel on Escape/lost capture/mode/project/window change, and cannot commit into a newer scope. Keyboard and double-click interrupt old pointer gestures. Double-click saves the true preferred default even in a constrained window.
- Panel choices have their own intent generation. They do not invalidate acknowledged business saves or explicitly initiated generation. A delayed Add-to-Timeline acknowledgement retains its accepted clip while a newer panel choice suppresses its automatic workspace reveal.

No new dependency, vendor primitive modification, business RPC/CLI/MCP operation, timeline undo entry, desktop permission, preload, IPC or renderer credential access is added. No paid provider call, original-data modification, installer, publication or deployment is included.

## Automated verification

- Full regression with `node --test --test-concurrency=2 tests/*.test.mjs`: **576/576 passed**, zero skipped, exit 0, on the exact final source including async intent, portal and recall-rail corrections. Evidence: `evidence/dockable-panels/all-tests-bounded-final.log` (102.5 seconds). The preceding bounded run also passed 576/576; an independent earlier regression passed 562/562 before the additional coverage.
- A preceding default-concurrency run was **564/566 passed, two failed**. The reference and timeline-history transport suites observed CLI subprocess `SIGKILL`; both helpers have a 15-second kill timeout. This result does not establish an OS OOM or a browser-crash cause. The complete failure is retained in `evidence/dockable-panels/all-tests-default-concurrency-failure.log`. Both files subsequently passed unchanged, one at a time: **2/2** reference and **8/8** timeline history (`reference-transports-retry.log`, `timeline-history-transports-retry.log`), and passed within the bounded full suite. No timeout or skip was introduced.
- Strict layout/state/preference tests: **69/69 passed**, including actual backend restart, legacy canonical replay, malformed response rejection, independent projects/modes and unchanged business/history tables.
- Final adapters/media/panels/provider/reference/shared-UI focused suite: **97/97 passed** (`controls-focused-tests.log`). Direct App bridge-intent cases: **5/5 passed**, including newer mobile-center navigation (`panel-intent-tests.log`). The complete aggregate includes these checks.
- The responsive transition model covers 2,404 combinations of outer heights 300–900px, both width directions and both modes. Every combination settles within two measurements with one observer. The measured-height policy has stable 64px hysteresis, not a source-model oscillation. This model does not establish a browser-process crash cause.
- Production Web and development Electron staging builds passed after the final async, portal and recall-rail corrections. `evidence/dockable-panels/web-build.log` and `desktop-build.log`. Existing Base UI/use-client/sourcemap and Vite large-chunk warnings remain.
- `git diff --check` passes.

## Actual browser verification

The ordinary production bundle runs against real authenticated HTTP/SQLite services through the supported own-cloud Chromium CUA APIs. All fixtures, generated data and fault controls are isolated under `evidence/dockable-panels/`. Test-only proxies can hold one real accepted response; they do not fabricate successful project data or relax production authentication/CSP.

The report records **24/24 passed checks**: exact Canvas transform/host geometry preservation; Editing non-overlap; all-collapse recovery; independent mode/project sizes; reload and current-mode reset; unchanged business/history snapshots for layout-only actions; exact shot, node and clip draft preservation; hidden-selection Cancel; actual hidden audio/video pause; portal cleanup/focus; repeated scroll restoration; and full navigation at 787×505 and 400×606 CSS viewports. Real held-response checks prove a newer desktop/mobile hide wins over bridge reveal, a held save retains a newer hidden draft, and an explicitly requested local Mock generation completes once while Inspector stays collapsed. A completed native pointer resize emits one preference write; Home/End and double-click defaults pass. Final side rails fill their available height, every label/icon stays inside its button and viewport, and all five Canvas/Editing side/timeline recall actions restore their panels.

Supported CUA could not reliably inject an already-moved pointer's Escape, capture-loss or mode-interruption cancellation. Only no-movement press/Escape is an actual-browser cancellation pass; detailed interruption paths are covered by the deterministic event-handler suite. They are not claimed as real-browser passes.

Primary actual screenshots:

- `evidence/dockable-panels/browser/final-canvas-default.jpg`
- `evidence/dockable-panels/browser/final-canvas-all-collapsed.jpg`
- `evidence/dockable-panels/browser/final-editing-default.jpg`
- `evidence/dockable-panels/browser/final-editing-all-collapsed.jpg`
- `evidence/dockable-panels/browser/final-narrow-canvas.jpg`
- `evidence/dockable-panels/browser/final-narrow-editing-preview.jpg`
- `evidence/dockable-panels/browser/final-narrow-editing-timeline.jpg`
- `evidence/dockable-panels/browser/09-phone-tall-editing.jpg`
- `evidence/dockable-panels/browser/10-phone-tall-timeline.jpg`

Desktop captures are 1180×757 and final narrow captures 787×505. The earlier 400×606 phone-shaped captures predate the popup refinement and remain geometry evidence, not final-popup evidence. Narrow captures were taken fresh with the supported screenshot route after the full-page API was found to crop zoomed captures; they are not resized or composited. JPEG bytes use `.jpg` names. Browser report: `evidence/dockable-panels/browser/report.json`; capture sizes/hash manifest: `image-manifest.json`.

## Native acknowledged quit/relaunch

Ordinary sandboxed development Electron used a separate copied synthetic workspace, without remote debugging or a smoke/IPC hook. Canvas library width 262 and collapsed Inspector, plus Editing widths 292/360 and timeline height 340, were acknowledged at preference revision 10. Normal quit returned exit code 0 and removed descriptor, token and workspace lock. Relaunch used a new backend utility PID and port, restored the exact revision/state, and left domain/history tables unchanged. The relaunched renderer was visually checked against the saved Editing dimensions.

- `evidence/dockable-panels/native-runtime/report.json`
- `evidence/dockable-panels/native-runtime/acknowledged.jpg`
- `evidence/dockable-panels/native-runtime/restored-editing.jpg`

This checks Linux development Electron. New packages, macOS/Windows, forced termination and power loss are not claimed. Unacknowledged saves retain the previously documented lifecycle limitations.

## Native browser-window resize investigation

Two Chromium renderer exits with on-screen code 9 were observed during native-window resizing. Browser diagnostics showed extension metadata errors and no application exception. An unchanged baseline `821600f` tab later displayed the same code 9 at its original wide 1180px/100% viewport, before the matched resize gesture ran. Thus this exit is not exclusive to the new panel implementation. The observations and screenshots are preserved; no cause is inferred from that alone.

A script-free static control, an isolated renderer built from exact baseline `821600f`, and the current bundle all passed a quiet native 1180→500→1180 comparison with subsequent mode interaction. Baseline and current also passed the closer sequence: 1180×757 at 100% → native 500×757 → 400×606 at 125% → Ctrl+0 to 500×757 → native 1180×757, followed by a responsive mode roundtrip. Heavy aggregate tests were deliberately absent from these controls. Current short-height transitions likewise settled in both directions: 541px content/481px workspace (wide), 519px/395px (narrow), then 585px/525px (wide), with repeated identical samples and no exposed ResizeObserver-loop error. Cgroup resource counters were unavailable, so the evidence does not attribute earlier exits to memory pressure.

Evidence: `renderer-crash-observed.jpg`, `renderer-diagnostics.json`, `baseline-post-heavy-native.jpg`, `static-control-*.jpg`, `baseline-*.jpg`, `current-quiet-*.jpg`, `baseline-matched-sequence.json`, `current-matched-sequence.json` and `resize-isolation-result.json` in the browser evidence directory. No sandbox, extension, GPU or browser security settings were changed.

The same height test exposed an application defect separate from process exits: an open Inspector Select portal remained visible after the breakpoint hid its owner. Focus itself moved to the visible mobile recall. `portal-hidden-breakpoint.jpg` and `.json` retain that observation. The corrected visibility-controlled app-level primitive composition passed the same real breakpoint: zero listboxes, trigger no longer expanded, focus on visible mobile recall, and no popup/focus resurrection on reveal. A fresh user-open/Escape returns focus normally; the Asset tooltip also disappears on effective hide. The parent editor and its draft remain mounted. Corrected evidence: `final-portal-hidden.jpg` and `final-portal-regression.json`.

## Final gate

All observed application defects have fixes with focused/runtime verification, including final recall-rail containment and refreshed collapsed screenshots. The exact-final-source bounded regression and final Web/development-desktop builds pass. Earlier renderer exits remain disclosed with their control evidence and unassigned cause; no native/browser security setting was weakened. The explicit native-platform and moved-pointer CUA limits above remain.
