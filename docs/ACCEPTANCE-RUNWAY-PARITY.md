# Q1 acceptance: Runway provider safety parity

Baseline: `e2db533edf163c7dbd21df74bfa398ea75800ebf` (2026-10-09 UTC).
Scope: EQ-01/EQ-02 and Q1 in [ENGINEERING-QUALITY-ROADMAP.md](ENGINEERING-QUALITY-ROADMAP.md).

This is offline contract and local-runtime acceptance, not live Runway verification. All media is synthetic, all HTTP responses in the adapter tests are injected, and credentials are inert sentinels. No remote provider request, paid generation, upload, install, publication or native-platform certification is part of this increment.

## Changes and boundaries

- Runway uses the existing shared JSON request helper. Exactly one POST is attempted. Only HTTP `400, 401, 402, 403, 404, 405, 413, 415, 422, 429` are definite rejections; every other error status remains unknown acceptance. This conservative set is explicit and must not be expanded without evidence that acceptance cannot have occurred.
- Successful JSON bodies are limited to 1 MiB, including streamed bodies without Content-Length. Malformed JSON, non-object bodies and missing/invalid task identity remain `SUBMISSION_UNKNOWN`; array-to-string coercion cannot pass UUID validation. Provider/network bodies and keys never appear in public errors.
- The fixed API origin, Runway version header, bearer auth, exact request shape, reference approval/checksum/type/size checks, ratios/durations and cancellation/reconciliation limitations are preserved. Existing GET HTTP retryability remains specific to 408, 429 and 5xx through a narrow shared-helper option; transport/unreadable GETs remain retryable.
- Runway uses the common output URL validator and MP4 downloader with its original exact CDN allowlist, 128 MiB limit, no API auth and no redirects. The nearest existing ancestor is checked before recursive mkdir. Acquired streams are cancelled on output-open failure; oversized/invalid/interrupted downloads clean temporary files and invalidate stale task results without creating another generation.
- Shared polling now retains one in-flight GET even if it exceeds the interval, caches success/error results through a cooldown measured from settlement, and does not restore invalidated old entries. Runway uses the advertised five-second interval. This is deliberate backoff, not automatic POST retry.

The shared helper was inspected before reuse, including existing Ark/Veo/MiniMax/Vidu request, download, redirect and cache tests. Its pending-request gap was fixed rather than copied. No Agent, renderer, server, worker or service production source was changed.

## Regression matrix

| Boundary | Assertions |
| --- | --- |
| Definite POST rejection | Every code in the ten-code explicit set; `uncertain: false`, one POST, redacted public error |
| Unknown POST | 302, 408, 409, 410, 418, 425, 499, 500, 599; redirect-fetch failure and abort; no reconciliation POST |
| Success body validation | Malformed JSON, array/scalar/null/empty bodies, missing or invalid IDs, array-coerced ID, non-v4 UUID; unknown acceptance |
| JSON resource limit | More than 1 MiB with and without Content-Length cancels reading; exactly 1 MiB valid JSON succeeds |
| Polling | Original HTTP retryability; cached transient and malformed results; concurrent slow success/failure across the interval; settlement cooldown; invalidation while an old request is pending |
| Local filesystem | Escaping existing symlink plus missing child creates nothing outside root; acquired response cancelled after deterministic output-open failure |
| Download | Declared/streamed oversize, partial stream error, invalid container, redirects; no partial output left; subsequent same-ID GET refresh; no CDN auth |
| Actual worker/services | Injected Runway HTTP 409 persists `submission_unknown`; fresh-request-ID `job.retry` returns `UNSAFE_RETRY`; reconciliation and restart keep one submission, one local job and no version |

Tests: `tests/providers-runway-parity.test.mjs`, existing `tests/providers*.test.mjs`, and shared synthetic fixture `tests/helpers/runway-unknown-fixture.mjs`.

## Verification

Evidence directory: `evidence/q1-runway-parity/` (gitignored).

- New focused suite: **52/52 passed**, `node --test --test-concurrency=1 tests/providers-runway-parity.test.mjs`; `focused.log`.
- All provider contracts: **194/194 passed**, `node --test --test-concurrency=1 tests/providers*.test.mjs`; `providers-final.log` (final rerun includes exact request-body/header assertions; earlier pass retained in `providers.log`).
- Fresh web builds: default, `NODE_OPTIONS=--max-old-space-size=512 pnpm build` and `NODE_OPTIONS=--max-old-space-size=768 pnpm build` each terminated with exit **137**. All three logs are retained (`web-build.log`, `web-build-bounded-heap.log`, `web-build-768.log`); none is counted as a pass.
- Unchanged UI reuse: the three saved `apps/desktop/build/web` files were SHA-256-verified against the previous accepted `evidence/agent-responses/build-manifest.json`. No `apps/web`, `packages/ui`, root package or lockfile diff exists against the baseline. Only missing generated `apps/web/dist` artifacts were restored from that verified copy. `ui-reuse-manifest.json` records this explicitly; it is not a fresh frontend build.
- Fresh current-source development desktop bundle: **passed**, `pnpm desktop:build`; `desktop-build.log`. The main/backend were rebuilt with esbuild and the verified unchanged UI copied into the staging directory. This is a build check, not a fresh native Electron run.
- Actual own-cloud CUA runtime: **4/4 passed**, `browser/report.json`, with three original 1180×757 JPEGs.
- `node --check` on changed modules/runtime/harness and `git diff --check`: passed.
- Parent independently owns full-suite verification, final review and the local commit.

## Actual runtime evidence and reproduction

`tests/runway-parity-qa-runtime.mjs` creates a disposable synthetic project through the real Runway adapter, actual SQLite services and worker with one injected HTTP 409. It then closes that seed worker and starts the ordinary authenticated HTTP server at port 4891 with every live provider disabled. The project and shot names visibly identify the synthetic HTTP 409 fixture. It never manufactures a successful provider result.

Start it from the repository root in the own-cloud graphical host using the documented Application Finder launcher when the shell/browser loopback namespaces differ. Bundle `tests/browser_runway_parity.mjs` with the installed esbuild, sign in to this disposable instance, and call `runRunwayParityBrowserAcceptance({tab,runtime,outDir})` on the supported CUA tab. The browser harness verifies unknown/charge warning and no Retry action, reads the host-runtime's real authenticated HTTP `job.retry` refusal, performs UI reconciliation, and reloads to verify persistence. No production authentication, CSP or browser sandbox setting is changed.

Actual captures (visually reviewed; `screenshots-manifest.json` records types, dimensions and hashes):

- `browser/01-http409-unknown-no-retry.jpg`: synthetic Runway task marked unknown, billing caution, one submission, no retry action.
- `browser/02-reconciled-still-unknown.jpg`: UI reconciliation retains unknown status and the same one-submission count.
- `browser/03-reload-preserves-unknown.jpg`: reload preserves the warning and available existing-task reconciliation.

The first harness attempt reached the correct UI but its Node HTTP fetch could not reach the host loopback namespace. Its report/captures remain in `browser-first-attempt/`; it is not an application failure or a passing acceptance run. The final fixture executes the authenticated HTTP check in the backend host namespace and records `runtime/http-checks.json`; CUA then reads real SQLite state after UI interactions. The final browser report passed all four checks. No response or successful domain result was fabricated to work around that infrastructure separation.

## Remaining limits

- A same-user process can still swap directories between path checks and file operations; this is not an elimination of all filesystem TOCTOU races.
- Contract-injected errors and synthetic local runtime do not verify Runway billing, account behavior or remote availability. Runway remains `liveVerified: false`.
- No macOS/Windows or fresh packaged Electron verification. Screenshots demonstrate the unchanged browser UI consuming the new real worker failure classification, not successful remote generation.
