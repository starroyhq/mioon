# Selected-clip split acceptance — 2026-10-09

## Increment and semantics

Built on `5ded83d`. `timeline.clip.split` is one shared atomic operation taking
`projectId`, `clipId`, absolute integer `atFrame`, `expectedRevision`, and
caller-owned stable `requestId`. It uses the existing SQLite transaction,
revision check, immutable response store and snapshot history.

Only a strict interior frame is valid. The left half keeps its original ID;
the right gets a new persisted ID. Video/audio source ranges remain contiguous;
image source-in remains zero. Both preserve fixed asset references and clip
properties. Track mute/visibility, unrelated clips and total duration stay
unchanged. One undo restores the unsplit state; redo restores both stable IDs.
This is a non-ripple split, not automatic all-track cutting. No database migration.

Editing has a shared Base UI Split button with explicit selected clip and cut
frame, plus Ctrl/Command+B. The original left half stays selected at the cut
boundary. Invalid/boundary positions, dirty drafts, pending recovery, offline,
loading/synchronization and the 100-clip limit disable the action. The keyboard
handler preserves text editing, IME, repeated input and modal/menu controls.
Canvas ignores the shortcut. Stale writes refresh rather than overwrite.

## Verification

All artifacts are local and ignored under `evidence/split-clips/`.

- Final aggregate: **462/462 passed**, no failures/skips, Node 24.19.0.
  `full-regression-final.tap` (101.3 seconds).

- Service/transport focused: **26/26**. All eight supported media MIME types;
  nonzero trims; copied properties and untouched neighbors; missing/cross-project
  clips; one-frame/boundary/outside positions; invalid schema; 99-to-100 clip
  limit and rejected 101st; frozen asset/version references; exact replay after
  restart, undo, redo and branching; same/different request writer races across
  independent SQLite connections; four injected rollback failure stages.
  Real HTTP, CLI subprocesses and official SDK MCP check schema/tool parity,
  errors, duplicate submissions, process restart, cross-transport replay and a
  committed-but-lost HTTP response with no automatic re-submission.
- Frontend/history focused: **19/19**. Current selection/playhead snapshot,
  boundary/integer/clip limit gating; dirty/pending/busy/offline/stale states;
  text/shadow-DOM/IME/modal/repeat shortcut guards; exact recovery payload;
  accessible shared button rendering; history labels and existing undo controls.
- Production Web and development desktop builds passed. Existing bundle-size
  and upstream `use client` warnings remain. Used the installed tree with
  `pnpm --config.verify-deps-before-run=warn`; no packages or lockfile changed.
- Actual own-cloud CUA Chromium: **9/9**. Strict boundaries, selected-only cut,
  120→60+60 frames, exact Undo, stable-ID Redo, reload, unsaved/text/Canvas
  shortcut guards, new-branch replacement, real independent-writer conflict
  rejection/refresh, unchanged original media/graph/versions/jobs/exports.
  `browser/browser-split-report.json`; repeatable supported-CUA harness:
  `tests/browser_timeline_split.mjs`.
- Actual FFmpeg: `tests/timeline-split-media.test.mjs` passes. Four cuts include
  an alpha image, moving video with embedded audio, trimmed external audio,
  gain/rectangle and muted audio. Before/after exports both have **91 frames**,
  **720×1280**, **30fps**, with **sample-identical decoded audio**, including
  cut boundaries. All decoded frames were compared: full-frame mean RGB error
  0.0858/255; moving-region mean 0.6677/255, worst frame 1.3461/255. Small visual
  differences are expected because new H.264 encoding segments are lossy;
  byte/pixel-identical output is not claimed. Actual MP4s, probes, summary and
  reviewed side-by-side frame are in `media/`.
- `git diff --check` and browser/runtime script syntax checks passed.

## Actual runtime screenshots

All five files are verified JPEG, 1180×757, and contain only synthetic local
media with no credentials.

- `browser/01-split-selected-clip.jpg`: selected original left ID and new right
  half at frame 60, duration unchanged, Undo available.
- `browser/02-undone-split.jpg`: restored original 120-frame clip.
- `browser/03-redone-split.jpg`: stable two-part state after Redo.
- `browser/04-dirty-split-guard.jpg`: unsaved inspector draft disables Split.
- `browser/05-final-split-workspace.jpg`: complete Mioon Editing workspace with
  both 60-frame halves, current clip/playhead, inherited overlay/audio, and the
  successful split confirmation.

## Reproduction and limits

`tests/timeline-split-qa-runtime.mjs` copy-migrates the synthetic
`examples/multitrack-project` to `evidence/split-clips/runtime/workspace`, then
starts the normal authenticated backend at local port 4877, live providers
explicitly disabled. Reuse that copy on restart. Bundle the browser harness
with the installed esbuild, import the bundle in CUA, and call
`runSplitBrowserAcceptance({tab,projectId,dataDir,outDir})` on the signed-in
own-cloud browser tab. The harness refuses a non-disposable data directory.
Save screenshots under the task workspace and copy them into ignored evidence.
The shell backend's loopback namespace was inaccessible to CUA; the verified
browser run used the normal own-cloud host backend launched via native desktop
Application Finder. Chromium sandbox, auth and security settings were unchanged.

No new Electron installer/package, macOS/Windows native runtime verification,
source archive, Library upload, live provider call, external media upload, push
or deployment. Earlier original browser suites are historical evidence, not
claimed as rerun. Existing JPEG filename fixes in the previous workspace-view
acceptance report/script are preserved as the parent requested.
