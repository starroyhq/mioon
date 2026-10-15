# Source-bound qualification

Baseline: `b86d0d3f8acd5ead0486ef015114a068e8b4c0c4` (real two-parent merge).
Runtime: `/workspace/scratch/6877817dff0d/toolchains/node24.21/node-v24.21.0-linux-x64/bin/node` (24.21.0).
Working directory: isolated `mioon-volume-envelope-editor-integration` checkout.
Source/test manifest: `final-source-test-manifest.json`, SHA256 `4f2a71149d4e39142909c6d04d052963ed81ff96f01af384ff7a8f22b05462b2` (27 files).

## Final nonmedia gate

Command: pinned Node `--import ./tests/helpers/envelope-editor-nonmedia-preload.mjs --experimental-test-module-mocks --test --test-concurrency=1` followed by the exact ordered 27 filenames in `nonmedia-tests.json`.

Result: **519/519 passed**, zero skipped, 84.188 seconds. Full output: `nonmedia-final-519-green.log`. Audit: `nonmedia-spawn-audit.jsonl`, 27 installed guards and 274 allowed cached esbuild `execFileSync` calls, zero disallowed calls. Node workers inherit the preload; shell, fork and non-allowlisted subprocesses throw before spawning. `ESBUILD_WORKER_THREADS=0` keeps synchronous transforms under that guard. This gate excludes the importer transport suite.

First attempt was 516/519, retained as `nonmedia-initial-516-of-519.log`. Two legacy extracted runner fixtures lacked the new `clipConnectionBlocked` ref; one source assertion named `chosenClip` instead of retained `displayedClipInspector.clip`. Only fixture dependencies/assertion changed. The corrected source-replacement suite independently passed 43/43 (`source-fixture-correction-43-green.log`) before the full replay. No runtime guard was weakened.

## Other retained evidence

- Initial controller 156/168 fixture failures and corrected 171/171 are retained separately.
- Session callback fences passed 33/33 before the external-interruption follow-up.
- Initial broad affected run was 504/522, **not nonmedia and not passing**. Its importer seeding incident is described without PID-retirement claims in `incidental-fixture-probes.md`; that importer suite was not rerun.
- Scoped browser TypeScript check passed with `--checkJs false --target ES2024 --skipLibCheck`; this is not equivalent to canonical project typechecks.
- Independent review initially passed 52/52, then reopened for external auth/workspace interruption. The final interruption review passed 37/37 and found no remaining confirmed source blocker. Evidence covers adapters, extracted App boot/action entrypoints and source-fixed subtree position/key, not DOM reconciliation or native IME.

Canonical production staging result is recorded separately when run. No native app, GUI, installer, provider, external network, real-media qualification or macOS verification is implied.

## Canonical production preparation (not a successful build)

Existing reviewed cached dependency trees from the accepted audio-role checkout were copied locally with relative symlinks preserved, after verifying lockfile/dependency declarations. The materialization report records 20,363 identical regular-file hashes (547,216,490 bytes), no external/dangling symlinks and local workspace resolution. Original links were preserved outside the checkout. No package installation, download or lockfile change occurred. Production no-media dependency preflight reports buildReady=true.

The canonical typecheck command failed before compilation: the source-language guard rejects two accepted-backend `.d.mts` declarations. Initial output is preserved. Diagnostic direct invocation of the exact compiler commands (not a canonical pass or preflight bypass) shows browser exit 0 without overrides, foundation exit 2 with 721 errors in 43 files. None names integration-edited files; baseline equivalence is being checked separately. No production build has been launched at this checkpoint.

Source-bound baseline replay at clean detached `b86d0d3` proves foundation failure equivalence: exactly 721 diagnostics before and after; full normalized logs byte-identical, SHA256 `671973a109b264ae6e148361dbd65bb684c199e495fa91f5543836946fdeaaeb`. Baseline workspace aliases resolve to baseline source. See `baseline-typecheck-comparison.json` and the separate baseline/current diagnostic logs. This does not turn the canonical gate green: repair or explicit scope resolution is still required before production staging.
