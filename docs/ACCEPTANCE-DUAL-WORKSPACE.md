# Dual-workspace acceptance — 2026-10-09

Baseline: `df0f0ad` (typed references on top of durable timeline history). This is an incremental renderer/layout change, with no version bump, new dependency, new backend operation, deployment, or live-provider call.

## Implemented scope

- The same project has top-level **画板 / 剪辑** modes; only the active workspace mounts.
- Canvas keeps the library, infinite canvas and shot/node inspector. Its storyboard defaults closed and its timeline is absent.
- Editing keeps the library, enlarged preview, clip inspector and full-width bottom timeline. React Flow and storyboard are absent.
- Within the same browser origin/current renderer session, local preferences are isolated per project: mode, Canvas viewport/selection/inspector tab, Editing clip/source selection/playhead/timeline zoom and two-axis scroll, plus shared panel preferences. Malformed or denied preference storage falls back safely.
- “Add to Timeline” is an explicit fixed-asset bridge. “Return to Source” highlights the exact historical source version without changing `selectedVersionId`, a clip's `assetId`, frozen snapshots or durable history.
- Existing typed first-frame edges, idempotent request recovery, immutable versions, CLI/MCP shared state and durable timeline undo/redo remain intact.
- Dirty navigation can be cancelled. Response continuations are scoped to their originating project/navigation context; unmounted form callbacks cannot generate/remove afterward. Newer text typed during an in-flight save remains a draft.

Desktop view-state limit: Electron uses a random nonpersistent session partition and an ephemeral backend port. View preferences survive current-renderer reload and project switching, but **not Electron quit/relaunch**. Project data, immutable versions and durable timeline history remain on disk. This change intentionally does not relax the desktop session/security model.

Not included: clip replacement, splitting, waveforms, variable output ratios, transitions, keyframes, live provider verification or native macOS/Windows QA.

## Final automated checks

| Stage | Result | Evidence |
| --- | --- | --- |
| `node --test tests/*.test.mjs` | **374/374 passed**, 0 skipped | `evidence/dual-workspace/node-tests.log` |
| Project-local workspace state | **13/13 passed** | `tests/workspace-state.test.mjs`, `evidence/dual-workspace/workspace-tests.log` |
| Production Web build | Passed | `evidence/dual-workspace/web-build.log` |
| Development desktop build | Passed; bundles the same final Web renderer | `evidence/dual-workspace/desktop-build.log` |
| Python regression syntax | Passed | `python3 -m py_compile tests/browser_flow.py tests/browser_timeline.py tests/browser_providers_v4.py tests/browser_ui_components.py` |
| Whitespace/error check | Passed | `git diff --check` |

The builds used the already installed Vite/desktop build scripts directly; no package installation was needed. Vite reports its existing large-chunk advisory. A new installer, production desktop package, native Electron UI run or publication is not claimed by this checkpoint.

## Real browser checks

All browser actions used the supported own-cloud CUA Chromium browser, with its sandbox unchanged. The production renderer used the real authenticated loopback HTTP server, SQLite, shared services, FFmpeg and local mock provider. Original workspaces and previous evidence were preserved. Disposable data lives only under `evidence/dual-workspace/runtime/`.

**40/40 browser cases passed:**

1. **Core workspaces: 8/8.** Active-only mounting, Canvas storyboard default, generated-source badges, full-width Editing layout, per-project modes, Canvas viewport/selection and Editing clip/playhead/zoom/horizontal+vertical scroll across unmount/reload, dirty Cancel/Escape/discard, browser Back/Forward, exact V1 source highlight while V2 remains selected, fixed-version Add-to-Timeline, and independent shared-service refresh without navigation.
2. **Recovery/form races: 9/9.** Accepted timeline/reference responses deliberately truncated; exact recovery survives mode/project switches and does not duplicate history. Other projects show no unrelated pending request. Canvas Ctrl+Z leaves timeline history unchanged. Both inspectors retain newer text typed during held saves. Discard/unmount prevents obsolete save-and-generate. Late bridge completion cannot hijack another project. Cancelling dirty browser Back restores the current URL and draft. Restoring a paused source cannot clamp a playhead outside the selected clip.
3. **Playback/lifecycle: 3/3.** Actual video and audio playback began through native controls (`paused=false`, advancing `currentTime`, ready state 4). Switching modes removes the player; a second project's playhead stays at zero; returning leaves playback paused. A held generation submission finishes once without changing project/mode or reopening Jobs. Dismissing a held New Project dialog keeps the current project after the accepted create response arrives.
4. **Durable timeline regression: 10/10.** Real edits, stable IDs, undo/redo/shortcuts, native text Undo isolation, dirty guards, redo-branch replacement, reload cursor recovery, real stale-revision conflict, and unrelated domain-data preservation.
5. **Typed reference regression: 10/10.** Attach/detach, manual-reference protection, dirty guards, reload, actual local mock generation with frozen source provenance, stale detach conflict and original media/node/version/decorative-edge preservation.

An actual CLI `shot.update` and official SDK stdio MCP `shot.update` were also executed against the browser's backend. Both updates appeared in Canvas without changing mode. The MCP operation restored the synthetic metadata after the CLI check. Evidence: `browser/cli-update-result.json` and `browser/mcp-update-result.json`. The aggregate tests additionally cover CLI/MCP contracts and shared immutable-version/timeline semantics.

Reports:
- `evidence/dual-workspace/browser/browser-dual-workspace-report.json`
- `evidence/dual-workspace/browser/browser-races-report.json`
- `evidence/dual-workspace/browser/browser-lifecycle-report.json`
- `evidence/dual-workspace/history/browser-history-report.json`
- `evidence/dual-workspace/references/browser-reference-report.json`

Harness corrections were kept separate from application failures: accessible slider whitespace, textarea DOM value versus HTML attribute, cross-realm JSON comparison and a modal-hidden alert locator. A transient CUA command timeout occurred after all ten reference assertions; the final non-mutating review/cancel capture was resumed and verified, with the original timeout retained in the report. Socket resets could be transparently retried by Chromium, so the final lost-response fixture truncates the accepted JSON response instead; it never fabricates a successful domain result.

## Final screenshots and layout

- `evidence/dual-workspace/final-canvas-overview.jpg`
- `evidence/dual-workspace/final-editing-overview.jpg`

Both full-size captures are **1180×757** from the same project. Canvas uses Fit with separated disposable QA nodes. Editing shows a **304px** full-width timeline, a **194px** scroll viewport, the entire 19-second synthetic sequence and fully visible V2/V1/A1 media lanes. Empty QA tracks added during recovery checks remain above the displayed lanes. The final Editing screenshot shows a fresh, successfully completed local FFmpeg composite of timeline revision 27: 720×1280, 19 seconds, paused at 3 seconds with no media error. It was rendered once after the tests. The prior stale snapshot remains separately preserved in `browser/final-editing-stale-overview.jpg`. Earlier captures retain the exact persistence/source-highlight test states.

Only disposable QA node positions were tidied for the final Canvas image. Original fixture media, historical evidence and user/example workspaces were not rearranged.

## Regression maintenance and limits

The four historical Python browser scripts were updated for explicit Editing entry, Canvas's collapsed storyboard and dirty-mode confirmation. Their original non-layout assertions remain. They were **syntax-checked, not executed** in this checkpoint because all actual browser interaction used the supported CUA path. The CUA history/reference regressions were executed, along with the new dual-workspace/recovery/lifecycle suites. Narrow/mobile breakpoints and fresh native desktop-window behavior were not browser-tested here.

Reproduction entry points are `tests/dual-workspace-server.mjs`, `tests/dual-workspace-seed.mjs`, `tests/browser_dual_workspace.mjs`, `tests/browser_dual_workspace_races.mjs`, `tests/browser_dual_workspace_lifecycle.mjs`, and the adapted history/reference browser harnesses. Prepare a consistent disposable copy of `examples/multitrack-project` under the permitted runtime directory, start the synthetic local server, seed only local mock data, and pass a signed-in supported CUA tab to the exported acceptance functions. The test server can hold/truncate one accepted operation response via its local control file; these controls are not production functionality.
