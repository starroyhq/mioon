# Timeline drag snapping acceptance

Baseline: `a1be920` (selected-clip split). This bounded iteration adds renderer-only
placement assistance. It does not change explicit integer-frame CLI/MCP operations,
shared business schemas, compositor behavior, clip resizing or ripple editing.

## Behavior

- The Editing toolbar has an accessible pressed-state magnet toggle, default on.
  Its value is saved per project through the existing independent preference CAS
  queue. Holding Alt temporarily bypasses snapping; it never changes the saved flag.
- Moving start or end edges can snap to any other clip's start/end, the playhead,
  or timeline zero. The pickup offset is retained at subframe precision until the
  final integer placement. The moving clip excludes both of its own boundaries.
- The radius is 8 screen pixels at every zoom. Ties resolve by distance, moving
  start before end, earlier target frame, zero/playhead/clip, then stable clip ID.
  Full clip duration is clamped within frames 0–18,000.
- A dashed prospective span displays the exact integer start/end. A labeled guide
  identifies the matched boundary. The destination turns red and explains overlap,
  incompatible track, missing source or limits. Invalid destinations never search
  for another lane or a different gap, and never submit.
- The drop sends exactly the visible frame with the gesture's project/revision.
  A no-op drop, canceled drag, unmounted project, changed timeline revision or invalid
  payload causes no business/history mutation. Existing shared mutation replay and
  Undo/Redo remain authoritative. A late result cannot select a newer project's clip.
- Image asset insertion intentionally uses 90 frames (3 seconds), stated in the
  live status. Audio/video uses the known source duration, floored to 30fps. Missing
  duration shows an explicitly invalid 60-frame illustration with no snap guide;
  it cannot be added by dragging or the Add button. No source duration is invented.

## Preference compatibility

The existing state version 1 and SQLite version 5 remain. Only the new boolean
`editing.snappingEnabled` may be absent in a legacy record, in which case it defaults
to true. All other missing/unknown fields and incorrect types remain rejected.
Backend reads normalize without rewriting rows or revisions. Legacy exact replays
compare canonical states without writing. The client accepts the complete old GET
shape without scheduling a migration write; PUT acknowledgements remain strict.
See [workspace preferences](WORKSPACE-PREFERENCES.md).

## Verification

All evidence is local and ignored under `evidence/timeline-snapping/`.

- 31 focused snapping tests: all four edge pairings, all media/track targets,
  exclusion, stable ties and ordering, exact 8px radius at 28/76/220px/s, floating
  pickup/scroll geometry, duration-aware bounds, Alt/toggle, collisions and invalid
  types, unknown durations, no-op and exact-preview mutation wiring.
- 55 focused workspace-state/preference tests, including legacy raw SQLite rows,
  denied storage, strict HTTP validation, false persistence, restart/isolation,
  lost-response CAS replay and zero database changes during reads/replays.
- Actual own-cloud CUA Chromium acceptance: 14 cases. Native pointer drag plus
  read-only live DOM geometry and SQLite verification cover exact preview/drop,
  Undo/Redo, Alt, persisted toggle/reload/project isolation, overlap and cross-kind
  invalidity, outside-lane cancellation, image/known-video/unknown-duration assets,
  minimum and maximum zoom, a truly committed-but-lost HTTP response and exact
  recovery, plus a held accepted response across project navigation.
- Final aggregate: **500/500 passed**, zero failures/skips, Node 24.19.0
  (`full-regression-final.tap`, 60.2 seconds), plus an independent parent 500/500
  run. Final Web and development-desktop builds passed; existing upstream
  `use client` and bundle-size warnings remain. Both use the installed tree with
  `pnpm --config.verify-deps-before-run=warn`; no dependency/lockfile change.
- The final checked-in browser runner was itself replayed successfully: **14/14**,
  with ten fresh screenshots and `browser/browser-snapping-report.json`. A further
  clean source-preview guide capture was canceled and verified to leave exact
  timeline/history unchanged (`clean-guide-cancel-report.json`).
- `git diff --check` and all three browser/fixture script syntax checks passed.

The Linux Xfce desktop reserves Alt+mouse-down for moving windows. The native Alt
case therefore uses Alt+Shift to deliver Alt to Chromium without that OS binding;
Shift has no timeline drag semantics. Runtime Escape interception was not claimed:
the supported native input serializes gestures, so the cancellation test ends the
actual pointer drag outside a lane. Unit/source checks cover the Escape cleanup.

## Screenshots and reproduction

All eleven screenshots are actual JPEG (1180×757), not PNG bytes under JPEG names.
Useful review images in `browser/`:

- `11-clean-live-snap-guide.jpg`: recommended user-facing image; source preview, live
  120f guide and 120→240f ghost, then canceled without changing timeline/history
- `01-live-snap-preview.jpg`: native center pickup, exact 120→240f ghost and 120f guide
- `02-snapped-result.jpg`: acknowledged move with selection and one history entry
- `03-alt-free-drag.jpg`: Alt at 122f with no guide
- `04-overlap-rejected.jpg`, `05-incompatible-lane.jpg`: visible red invalid states
- `06-image-default-duration.jpg`, `07-end-edge-playhead.jpg`: image convention and end snap
- `08-unknown-duration-rejected.jpg`: explicit unknown-duration rejection
- `09-lost-response-recovery.jpg`: preserved exact pending move
- `10-final-snapping-workspace.jpg`: acknowledged final Editing state

`tests/timeline-snapping-qa-seed.mjs` copy-migrates only the synthetic
`examples/multitrack-project` into the new evidence runtime, adds two practice lanes,
a second project and one synthetic missing-duration asset, and writes its fixture.
`tests/timeline-snapping-qa-runtime.mjs` starts the normal authenticated backend with
live providers disabled behind a strict local-origin fault proxy at 127.0.0.1:4878.
Only explicitly armed synthetic `.clip.update` responses are held/dropped after
real backend acceptance; successful domain responses are never fabricated.

`tests/browser_timeline_snapping.mjs` exports `runSnappingAcceptance`. Use it from
the supported CUA runtime with the signed-in own-cloud tab, Sky native input, the
fixture, a screenshot directory in the current task workspace and the browser
content offset measured from a fresh desktop screenshot. Start with the copied
baseline project in Editing at 76px/s and zero timeline scroll. The harness requires
this exact disposable evidence path. The verified run uses normal own-cloud host
startup because the shell and browser have different loopback namespaces.

No original workspaces/media, installers, packages, external uploads, paid/live
provider calls, push, deployment or macOS/Windows native validation are included.
