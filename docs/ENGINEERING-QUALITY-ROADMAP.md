# Engineering quality and native-platform roadmap

Audit date: 2026-10-09 UTC. Inspected baseline: `66a01932700075f3fc15c0af83e5107e409dadbc`.

This is a source-backed audit and delivery plan, not a security certification or a claim of macOS/Windows support. It complements [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md) and [AGENT-ITERATION.md](AGENT-ITERATION.md). Product scope lives in those documents; this document owns concrete engineering findings, bounded refactors and release gates.

## Scope and evidence

- Read production source, manifests and relevant existing tests. No repository `AGENTS.md` was present in the repository or the checked ancestor locations.
- No production edits, dependency changes, build/test execution, credentials, real provider requests, installers, commits or publication were part of this audit. Findings below are source-confirmed unless explicitly described as a native verification gap or hardening proposal.
- Line references refer to the inspected baseline. Streamed-chat implementation was in progress separately; its new/uncommitted transport and settings changes were not evaluated as completed code. Revalidate affected references and interfaces after that increment lands.
- Existing test cases are identified as coverage already present in source, not as tests rerun during this audit. Historical Linux evidence does not verify a new commit or another OS.

## What should be preserved

The code already has meaningful boundaries. Keep them during cleanup:

- Renderer sandbox, context isolation, no Node/preload bridge, same-origin network/navigation restrictions, denied permissions and guarded downloads: `apps/desktop/src/security.mjs:41–98`.
- Loopback-only server, Host/Origin checks, timing-safe token comparison and CSP: `apps/server/src/index.mjs:13–17,74–89,157–165`.
- Shell-free generated media argument arrays: `packages/business/src/media-processes.mjs:5–12`.
- OS-encrypted Agent credentials, channel binding and fail-closed Linux `basic_text` rejection: `apps/desktop/src/secret-store.mjs:15–59`. Do not replace this with portable plaintext storage.
- Bounded private Agent-settings envelopes, no-follow/inode checks and atomic replacement: `packages/business/src/agent/settings-file.mjs:15–85`.
- Immutable version/render snapshots, exact timeline/reference replay, and unknown-submission recovery. Refactors must retain the existing public contracts and historical responses.
- Explicitly selected external media binaries and no automatic FFmpeg download: `apps/desktop/src/config.mjs:37–59`; `apps/desktop/src/main.mjs:31–49`.
- Explicit channel identity, staged-identity check and hardened Electron fuses: `apps/desktop/builder-config.cjs:7–30`. Packaged contents exclude workspace data and runtime dependencies.

## Prioritized findings

Remediation update (Q1, baseline `e2db533`): EQ-01/02 implementation now routes Runway through the shared bounded request/download/cache helpers, with unknown-submission and escaping-symlink regressions. Parent aggregate 846/846 and synthetic browser 4/4 passed. See [Q1 acceptance](ACCEPTANCE-RUNWAY-PARITY.md) for build reuse and remaining live/native/TOCTOU limitations. The findings below retain their original audit evidence; other batches remain open.

Priority is delivery order: P1 before extending paid-generation/native distribution exposure; P2 in the next quality batches; P3 when the dependent capability is implemented. No confirmed unauthenticated remote compromise was established by this read-only review.

### EQ-01 · P1 · Runway submission classification drift can make an inconclusive submission retryable

Type: actual behavioral divergence in a safety boundary; no live billing incident observed.

`providers/runway.mjs:49–56` marks only POST 5xx, 408 and 3xx as uncertain. A POST 409, for example, becomes an ordinary failure. The newer `providers/live-common.mjs:57–69` instead allows only `[400,401,402,403,404,405,413,415,422,429]` as definite rejection and treats all other non-success statuses as unknown acceptance. `jobs.mjs:50–53` turns the former into `failed`; `services.mjs:92` allows a new-request-ID retry only for that state. This is an unsafe difference even though the worker does not automatically resend the POST.

Runway additionally calls unbounded `response.json()` at `runway.mjs:55`; the shared reader bounds JSON to 1 MiB, validates object shape and cancels oversized bodies at `live-common.mjs:10–26,64–69`.

Bounded fix: route Runway JSON requests through `createJsonRequest`; preserve API origin, `X-Runway-Version`, auth header, ratios, durations, approved-reference behavior and task-ID validation. Keep a documented explicit rejection-code set. Do not broaden it without provider-specific evidence that acceptance cannot have occurred.

Required regressions:

1. Parameterize Runway POST results over all explicit rejection codes above; exactly one POST and `uncertain:false`.
2. 408, 409, 410, 425, 500 and an unexpected error status; exactly one POST and `SUBMISSION_UNKNOWN`. A redirect rejected by fetch is also unknown.
3. Success with malformed JSON, an array/scalar/null, missing/invalid task ID, and JSON over 1 MiB with and without Content-Length; unknown acceptance with no raw response/key in error.
4. Worker integration: POST 409 persists `submission_unknown`; `job.retry` refuses a fresh generation; reconciliation never creates a new remote task.
5. Preserve GET retryability and all existing Runway request/capability tests. Extend `tests/providers.test.mjs:167–181`, which currently omits 409 and the oversized response; compare `tests/providers-additional.test.mjs:102–109`.

### EQ-02 · P1 · Duplicate Runway download path has weaker pre-write checks

Type: actual local-filesystem side-effect bug in the adapter helper, conditional on an escaping output-directory symlink. Normal worker destinations are generated managed paths; this is not a public arbitrary-path API.

`providers/runway.mjs:144–148` recursively creates the output directory before checking its real path. A destination under `root/escape/new-directory/out.mp4`, with `escape` pointing outside root, can create `new-directory` outside managed storage before rejection. The shared helper checks the nearest existing ancestor first at `live-common.mjs:158–180`.

The duplicate downloader also opens its temporary file before entering its cleanup `try` (`runway.mjs:162–165`), whereas the common helper includes open/fetch/read in the cleanup scope (`live-common.mjs:183–231`). This can leave an acquired response body uncancelled when file creation fails.

Bounded fix: use shared `outputUrl`/`downloadMp4` with Runway's exact allowlist, no CDN Authorization header, no redirect permission and cache invalidation. Preserve its output size cap and MP4 verification. The common helper is an improvement, not a claim to eliminate same-user directory-swap TOCTOU races.

Required regressions: escaping existing symlink plus nonexistent child must leave the outside directory unchanged; output-open failure must cancel the stream; partial/oversized/invalid media must clean up; CDN fetch must never receive API auth. Port the no-outside-mkdir assertion from `tests/providers-additional.test.mjs:157–161` to Runway.

### EQ-03 · P1 · Existing workspace/token privacy is assumed rather than validated

Type: actual validation gap for an existing or user-overridden data directory; not a claim that a newly created default POSIX directory is public.

`db.mjs:5–8` creates root with mode 0700 only if creation is needed; it does not validate an existing root, media directory or SQLite path. Imported media use default creation permissions at `services.mjs:71–72`. `apps/server/src/index.mjs:52–59` reads an existing access-token with ordinary `readFile`, without checking ownership, mode, type, symlinks or size. Desktop setup similarly uses creation modes without validating an existing `userData` directory (`main.mjs:23–25`; `config.mjs:22,63,81–89`).

Consequences depend on filesystem permissions: a pre-existing broadly readable workspace can expose project/media contents, and a broadly readable token exposes full local API access. A token symlink or unexpectedly large token file is accepted/read rather than rejected. This is stricter in the client reader (`packages/client/src/connection.mjs:19–41`) and Agent settings file than in server startup.

Bounded fix: introduce an explicitly scoped private-storage verifier before opening the DB or accepting a token. Validate root/media/token metadata and bounded reads; define whether non-private existing roots produce an actionable startup error or an explicit repair workflow. Do not silently chmod, change ownership or rewrite a user's unrelated directory. Preserve supported deliberate path overrides and channel separation.

Tests: existing 0755/0777 roots, broad token modes, token symlink/non-regular/oversized/hardlinked files, foreign owner where testable, existing valid workspace, symlinked media/database, partial initialization, and no external path creation on refusal. Windows needs the ACL implementation in EQ-07, not a POSIX-mode assertion.

### EQ-04 · P2 · Media subprocesses inherit credentials and have incomplete resource bounds

Type: concrete least-privilege/resource-hardening gap; no FFmpeg exploit demonstrated.

Desktop `utilityEnvironment` deliberately retains video-provider environment keys (`config.mjs:69–78`). `spawnMedia` does not supply a reduced child environment (`media-processes.mjs:6–7`), so media binaries inherit the backend environment, including provider secrets when configured. `media.mjs:6` bounds stderr but accumulates stdout without a byte cap. Imported bytes are capped, but decoded dimensions/stream metadata and concurrent probing have no centralized resource policy (`services.mjs:55–78`; `media.mjs:7–10`).

Bounded fix: a media runtime module owns executable selection, required OS/temp/locale environment, `shell:false`, `windowsHide`, timeout, stdout/stderr byte limits and cancellation. Exclude provider/Agent credentials and Node injection variables. Preserve intentional binary-support variables only through an explicit platform policy. Add input/probe limits based on accepted product capabilities, rather than a guessed blanket codec ban.

Tests: fake secret sentinels absent in child environment; executable paths with spaces/non-ASCII; bounded stdout/stderr; timed-out/aborted probe; corrupt/extreme metadata; cleanup after spawn error. Keep real synthetic media decode/render checks for behavior. Review decoder/network protocol policy before supporting additional manifest or URL-based media formats.

### EQ-05 · P2 · HTTP file stream errors are outside the request try/catch

Type: actual reliability gap, with a race-triggered crash risk rather than an established remote exploit.

`apps/server/src/index.mjs:126–140,145–151` stats files and later pipes a new `createReadStream` without an error handler. An asynchronous open/read error after headers are written is not caught by the surrounding async `try/catch`; the source stream's unhandled error can terminate the backend. Missing-media recovery, external file changes and rebuilds make this worth covering.

Bounded fix: use one guarded stream/pipeline helper, preferably opening the file once and using its metadata, and cancel the source on client disconnect. Send an appropriate error only before headers; otherwise close the response safely. Do not change auth/range semantics.

Tests: deletion/change between metadata and read, injected read error, client abort during full/range downloads, valid HEAD, invalid range, missing file, and server still answering the next request.

### EQ-06 · P2 · Shutdown budget and media/process ownership need explicit contracts

Type: existing lifecycle mismatch plus native-platform verification gap.

`jobs.mjs:13` constructs provider context without a cancellation signal. Worker stop sets `stopped`, interrupts the currently known media set, then waits for `busy` (`jobs.mjs:87–88`). An in-flight provider await can subsequently reach another media spawn; the stopped flag is not checked between all phases. Meanwhile desktop supervision requests graceful stop, kills at 10 seconds and forces again after two seconds (`supervisor.mjs:87–103`), while individual provider requests can last 30–60 seconds and media runs longer. Forced shutdown and later unknown-submission recovery are therefore plausible even for a routine quit.

Media cleanup tracks direct child PIDs only (`media-processes.mjs:3–24`; `supervisor.mjs:50–55,75–79`). This is not proof that descendant processes or native Windows termination behave correctly. Avoid casually adding process-group signals, which are platform-specific and can kill unrelated processes if ownership is wrong.

Bounded fix: give each worker operation an AbortController; prevent any new media operation after stop; define safe checkpoints and the preservation of `submission_unknown` when aborting a possibly accepted POST. Place platform termination behind a small owned-child adapter with explicit graceful/hard-stop outcomes. The active Agent stage must independently close its SSE connections before the server drain finishes.

Tests: stop during POST, polling, download, between await and spawn, probe, multi-segment export and HTTP/SSE streaming; lost utility process; parent crash; orphan check; relaunch without double publication. Verify on each actual OS. Do not interpret a signal name accepted by Node as proof of graceful termination on Windows.

### EQ-07 · P1 native release gate · Windows private storage has no ACL verification

Type: deferred platform capability, backed by explicit code gaps.

`agent/settings-file.mjs:9` unconditionally accepts Windows ownership/privacy, and `packages/client/src/connection.mjs:29–32` skips credential owner/mode validation on Windows. Passing 0600/0700 to file APIs does not establish that this application's Windows ACL requirement has been checked. `desktopSecretStorage` allows non-Linux platforms based on encryption availability (`secret-store.mjs:15–25`); existing tests pass fake `darwin`/`win32` values (`tests/desktop-agent-secrets.test.mjs:72`), not a native account/keychain.

Required hook: platform-private-storage operations to create/check current-user-only directories and credential/discovery files, reject dangerous inherited grants or offer explicit repair, and report a safe unavailable reason. Validate encrypted secret storage and plaintext MCP token protection separately. Treat network/UNC, removable/FAT-style, redirected-profile and junction/reparse-point storage as explicit supported/unsupported cases; do not silently certify them.

Native gate: another local user cannot read token/config/DB/media; invalid ACL startup fails safely; encrypted credentials survive normal restart, reject wrong-channel copies, and fail safely after unavailable vault/account context. The same-owner process is outside an OS-user-isolation guarantee.

### EQ-08 · P2 · Release/test infrastructure is Linux-oriented; Mac and Windows are unverified

Type: deferred capability, not a regression in an advertised tested installer.

- macOS has DMG arm64/x64 configuration with `identity:null` and `gatekeeperAssess:false`, but no completed signing/notarization path (`builder-config.cjs:40–48`). Hardened-runtime configuration alone is not a signed/notarized release.
- No Windows target or package script exists (`builder-config.cjs:32–48`; `apps/desktop/package.json:8–18`). Define per-user install behavior, app/channel identity, executable name, x64/arm64 support decision and native signing before claiming readiness.
- Packaged QA assumes `linux-unpacked` (`scripts/packaged-qa.mjs:17`; `scripts/inspect-package.mjs:20–22`; `scripts/identity-packaged-qa.mjs:47–59`). Some tests assume `/tmp`, `/bin/sh` and Unix symlinks (`tests/media-runtime-paths.test.mjs:11–16`), and desktop smoke asserts numeric POSIX modes (`src/smoke-checks.mjs:98–99`). These need native equivalents, not unconditional skips.
- FFmpeg concat files embed platform-native absolute paths (`timeline-media.mjs:77–83`). Drive letters, backslashes, apostrophes, Unicode and network locations need actual FFmpeg validation; Linux success does not prove either a Windows defect or Windows compatibility. Prefer a tested relative-entry/working-directory contract if portability is problematic.
- Export publication uses a filesystem hardlink (`jobs.mjs:80–82`). State supported filesystem requirements or provide an equally non-overwriting fallback before advertising arbitrary external/network storage. Do not replace it with an overwriting rename.
- `publish:null` and `--publish never` correctly leave update distribution disabled. There is no current updater implementation. Keep updates explicitly unsupported until signed-feed/channel verification, downgrade policy, migration compatibility and rollback tests exist.

### EQ-09 · P2 · High-coupling UI and duplicated semantics should be extracted incrementally

Type: maintainability risk with measured source evidence, not a request for a rewrite.

At the baseline, `App.jsx` is 669 lines / 90,133 bytes, and `styles.css` is 460 lines / 114,424 bytes. Long minified-style lines conceal substantially more work than line counts suggest. `App` owns auth, polling, navigation epochs, preference draining, panels, generation, reference mutations, timeline/history/splitting and modal composition.

Suggested sequence, after the streamed-chat integrator releases the hot files:

1. Extract presentational `Login`, `ProjectCreateDialog`, `VersionComparisonDialog` and later export/project/job dialogs from `App.jsx:45–71,627–669`. Props carry state and callbacks; extraction must not change focus/dirty-state behavior.
2. Extract a project-session hook from `App.jsx:113–150,186–208,220–309`: selection epochs, refresh, browser history and preferences drain. Preserve project identity and stale-completion guards together; do not scatter them across arbitrary hooks.
3. Extract generation/reference actions (`App.jsx:361–388,453–491`) and timeline commands (`App.jsx:505–597`) around the existing shared mutation runner (`311–350`). Preserve request IDs, reconciliation, navigation guards and draft retention. Do not unify these into a generic command framework prematurely.
4. Build memoized project lookup maps and a canvas view-model selector around `App.jsx:620–625`. Repeated `.find`/`.filter` for every shot repeatedly scans assets, versions, jobs and edges. This is a measurable optimization opportunity, not a current performance failure claim.
5. Split styles by stable surface/component after a no-behavior formatting pass and screenshots. Preserve cascade order and specificity; do not re-theme while extracting.

Other duplication boundaries:

- Runway/common provider networking/download/caching is the first substantive consolidation because it already caused divergence (EQ-01/02). Shared poll caching also deduplicates pending/error GETs (`live-common.mjs:74–85`), while Runway caches only successful responses (`runway.mjs:58–65`). Preserve its documented minimum poll interval under transient failures.
- Timeline constants occur in contracts (`packages/contracts/src/index.mjs:5–10`), service (`timeline.mjs:4–7,24`) and renderer (`timeline-media.mjs:5,12–32`). Centralize pure limits/timebase helpers; retain separate validation at public API and recovered-render boundaries as intentional defense in depth.
- `services.mjs` is 16,676 bytes in 102 lines. Extract asset import and generation/job orchestration after characterization tests; retain transaction boundaries and public projections. Keep a narrow registration surface rather than introducing a new business layer alongside the existing one.
- Health/client versions are literal `0.4.0` (`apps/server/src/index.mjs:81`; `packages/client/src/index.mjs:8`) while root/desktop manifests are `0.4.1`. Tests currently assert the former (`tests/server-lifecycle.test.mjs:23`). Decide whether this is protocol version or app version; name it explicitly and generate consistent app/build identity metadata instead of mechanically changing compatibility versions.

### EQ-10 · P3 · Repository/release hygiene needs a small final gate

Type: preventive packaging/credential hygiene.

`.gitignore` ignores `access-token`, `desktop-token` and `mcp-connection.json`, but not the currently written `mcp-token` (`apps/desktop/src/config.mjs:82–87`). Default app-data locations are outside the repository and `/data*` is ignored, so this is not evidence that any real token is tracked. Add the exact current filename to exclusions and use synthetic-file packaging tests for custom repo-local userData. Never scan or print real secrets as part of QA.

The repository has a lockfile and license collection (`apps/desktop/scripts/build.mjs:26–58`), but no checked-in cross-platform CI directory was found in this audit. Introduce portable unit/contract lanes and separate native smoke/package lanes; record dependency/advisory review against the actual release lockfile. No dependency vulnerability assessment was executed here, so no vulnerability-free claim follows from this audit.

## Native-platform verification matrix

Every result must record OS/version, architecture, app/channel, exact commit/package hash, media-tool versions and whether credentials were synthetic, session-only or OS-encrypted. `Configured`, `unit-tested`, `native-runtime-tested` and `release-verified` are distinct states.

| Area | Linux baseline / carry-forward | macOS required verification | Windows required verification |
| --- | --- | --- | --- |
| App/runtime | Existing implementation and historical evidence; rerun final commit | arm64 and x64 policy; real utility Node/SQLite; close-last-window, Dock reopen, Cmd+Q, single instance | Chosen x64/arm64 scope; real utility Node/SQLite; single instance, taskbar identity, close/logoff behavior |
| Paths/filesystem | Spaces, Unicode, apostrophes, read-only/disk-full; owner/mode validation | Application Support and selected-volume paths, normalization/case behavior, approved symlink policy, atomic save | Drive/space/Unicode/long paths; junction/reparse policy; explicit UNC/removable support; ACLs and atomic publication |
| Media tools | Explicit absolute paths; empty-PATH regression; encoder capability check | Selected Intel/Apple Silicon executable compatibility, missing/quarantined tools, encoder/decode/concat real outputs | `.exe` discovery/selection, restricted PATH, no console flashes, concat paths, codec checks and DLL/runtime failures |
| Secrets/discovery | Available keyring and unavailable/basic_text fail-closed; 0600/0700 | Real Keychain store/restore/deny/lock behavior; signature/channel change handling; private token files | Real OS encryption lifecycle and current-user ACL protection; wrong-user/channel files and bad inherited ACL refusal |
| Processes | Graceful stop, force-kill and orphan check | Quit/sleep/wake/backend crash during media and SSE; no orphan; WAL recovery | Native quit/forced termination/parent exit; no orphan; locks released; WAL recovery |
| UI | Existing browser/Linux UI suites rerun | Native Save As/overwrite, focus, shortcuts, scaling, media decode and permission blocks | Native Save As/overwrite, Ctrl shortcuts, scaling/multiple displays, media decode and permission blocks |
| Package | Current Linux identity/fuses/ASAR/contents checks rerun | Per-channel signed DMG, notarization/stapling/Gatekeeper, install/relaunch/upgrade/uninstall data preservation | Per-user installer choice, signature verification, install/upgrade/uninstall, app/channel separation and data preservation |
| Update policy | Disabled today | Keep disabled until signed channel manifest, migration/rollback and failure handling proven | Same gate; install-directory write privileges and relaunch/rollback tested |

No signing identities, certificates, credentials or update feeds should be invented or embedded in source. Configuration hooks can land before release credentials exist. Signing/publication remains a separately approved operation.

## Bounded implementation batches and acceptance

| Batch | Scope / dependency | Required evidence before local commit |
| --- | --- | --- |
| Q1: Provider parity | EQ-01/02, after current stream stage; provider helper and focused tests only | Exact request fixtures unchanged; rejection matrix, unknown worker state, bounded bodies, escaping-symlink/no-write, cleanup/redaction, provider aggregate suite |
| Q2: Private storage | EQ-03/07/10; separate portable policy from platform backend | Synthetic safe/unsafe directory/token matrix; no destructive repair; Windows ACL native tests before enabling a supported Windows claim; no token in package/source fixture |
| Q3: Process/media lifecycle | EQ-04/06; coordinate with SSE shutdown owner | Environment sentinels, output bounds, abort checkpoints, no late spawn/orphan, normal/forced restart, real synthetic render/hash/frame/audio checks |
| Q4: Transport reliability | EQ-05; server owner released hot file | Stream failure/disconnect/range/HEAD cases; next request healthy; auth/origin/CSP regressions; bounded SSE shutdown if applicable |
| Q5: UI structure | EQ-09, one cohesive extraction per commit | Existing dual-workspace races, drafts, navigation, panels, preferences-close and timeline/history/reference suites; browser/native screenshots demonstrate unchanged UI and interactions |
| Q6: Portable tests and packaging hooks | EQ-08; no installers published | OS/arch-aware paths/output layout, platform-specific permission assertions, consistent build identity, CI lane definitions and explicit not-run states |
| Q7: Native release rehearsal | Depends on Q2/Q3/Q6 and separately available native environments | Complete matrix for exact artifact; installation/upgrade/recovery; native vault/ACL; real media playback; signing verification only when authorized |

Do not mix Q1's safety fix with an App rewrite or signing work. Preserve the active streamed-chat increment, its file ownership and its tests. Further product work should use these hooks rather than duplicating path, network, storage or process policy again.

## Follow-through gates for the approved product roadmap

- Before Agent local editing: project-scoped direct/indirect-ID checks, durable exact replay and reviewed mutation/approval binding from AGENT-ITERATION. A passing text stream does not satisfy these gates.
- Before richer media import/proxies/cache: shared bounded subprocess policy, source-to-proxy integrity, cancellable jobs and explicit decoder/color capability reporting.
- Before backup/restore/portable bundles: private-storage validation, versioned manifest, path traversal/link defense, hash verification and interrupted restore without overwriting the original.
- Before aspect/timebase/delivery variants: replace duplicated fixed constants deliberately; retain deterministic frame arithmetic and cross-layer validation. Do not quietly change old snapshot interpretation.
- Before code-based motion templates: a separately reviewed execution/network/filesystem sandbox and resource budget. The existing trusted FFmpeg child wrapper is not a general untrusted-code sandbox.
- Before installers or automatic updates: native matrix, signed artifact policy, migration/rollback verification and explicitly approved release action.

## Audit completion status

Completed: read-only platform/security/structure review and this roadmap. Not performed: production remediation, aggregate/focused test runs, dependency advisory audit, runtime browser/Electron QA, macOS/Windows native verification, builds/signing/notarization, release/update publication or real provider compatibility tests.
