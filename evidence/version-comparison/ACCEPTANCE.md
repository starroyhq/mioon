# Fixed shot-video comparison: source acceptance

Date: 2026-10-15 UTC.
Base: accepted annotation UI commit `128c8fbcd3324698602c5a0486857ffb628fec1c`,
preserved as an ancestor. Runtime: existing pinned Node 24.21.0 and installed
repository dependencies. No dependency installation, live provider invocation,
GUI attempt, push, publication or user-computer change was performed.

## Scope

The existing A/B shot-video dialog is enriched, not duplicated. Two distinct
versions must be explicitly chosen; fixed identifiers and snapshot metadata are
shown. No new generation, automatic selection, timeline source replacement,
schema migration or file-content hash verification is added.

The authenticated read-only comparison media route retains existing origin and
session policy, ordinary-workspace/store-lock authority, bounded owned graph
inspection, exact published MP4 path, managed file checks and GET/HEAD/range
handling. It rechecks recorded graph/file identity across asynchronous boundaries.
Restored workspaces are refused. Recorded SHA-256 consistency is not a claim of
rehashing all served bytes. Independent images/audio version schemas and richer
visual diff/synchronized playback remain outside this slice.

Media ownership covers each comparison side, the main source/timeline preview,
trial export and timeline audio. Existing background `Media` instances receive
false workspace visibility while the dialog is open, including queued-play
fencing. Playback does not automatically resume on close. Removed/foreign opener
callbacks do nothing; a shot removed while comparing leaves a closable unavailable
dialog with its retained explicit choices, not a hidden workbench or fallback.

## Final source gate

- `final-regression-files.txt`: 29 distinct affected test files.
- `final-regression.log`: 458 total, 458 passed, 0 failed/cancelled/skipped.
  Elapsed 96.27 seconds.
- Command: `node --test --test-concurrency=1 $(cat evidence/version-comparison/final-regression-files.txt)`
  with `MIOON_ENABLE_LIVE_PROVIDER=0` and the pinned Node executable.
- `final-source-sha256.txt`: 1,507 runtime/config/script/test source entries.
  Verified unchanged after the final regression and production build.
- Coverage includes actual App callbacks and conditional dialog rendering,
  component lifecycle/late callbacks/Strict Mode, explicit distinct selection,
  stale/offline/project/source fencing, all four locales, native same-origin
  request policy, exact authenticated media routes, export/media/named download
  regressions, annotation UI/native close, source/frame preview and existing
  background media visibility behavior.
- Both foundation and browser strict typechecks passed as mandatory pre-build
  steps in `scripts/tooling.mjs build --channel=production`.
- `production-build.log`: production-channel build exited 0. The desktop staging
  identity is `app.starroy.mioon`; its shared backend and matching web UI were
  bundled without node_modules or data directories.
- `production-staging-sha256.txt`: all 53 files under `apps/desktop/build`, verified
  against the generated staging artifacts. Standard dependency directive,
  sourcemap-location and bundle-size warnings remain visible in the build log.
- Independent actual-diff review and `git diff --check` found no remaining source
  blocker. Native behavior remains explicitly unverified below.

This is an affected-set source acceptance, not a full repository suite or combined
native qualification. Real offline Mock publication verifies the local publication
and serving path, not real-model quality.

## Earlier observations retained

1. Initial combined route/export/file-response run: 33/34. The export preview
   corruption fixture observed its active worker change a deliberately queued
   export to failed (`MANAGED_SOURCE_INVALID`) during a no-write assertion.
   Exact command, timestamps and subsequent standalone passes are preserved in
   `docs/VERSION-COMPARISON.md`. This is a timing-sensitive observed outcome,
   not a baseline-proven pre-existing failure. No assertion/timeout was weakened.
2. `typecheck-initial-failed.log`: new TSX CSS side-effect import lacked a module
   declaration. The stylesheet import was moved to existing App.jsx's stylesheet
   boundary, matching current application practice. Later strict checks passed.
3. `pre-fix-regression-failed.log`: 454/455. The localization ledger caught the
   raw SHA-256 label. Trailing whitespace in this saved log was normalized
   for repository hygiene; diagnostic content is unchanged. A four-locale semantic key fixed it without an exception.
   The independent retained-opener/deleted-shot lockout fix was made after this
   frozen run, not during it. `pre-fix-source-sha256.txt` preserves that source.
4. `orphan-copy-fix.log`: 22/22 targeted checks, followed by the final refrozen
   458/458 affected-set gate. Discovery logs are retained separately, not summed
   into the final total.

## Unverified and excluded

No GUI run or screenshot is included. The known AT-SPI prerequisite blockage was
not retried. Native decoder output, focus/keyboard behavior, visual appearance,
200% zoom/responsive GUI observations, macOS/Windows qualification and live
provider quality remain separate gates. Existing schema/authority and export
business semantics remain unchanged. No release or publication claim follows
from these source checks.
