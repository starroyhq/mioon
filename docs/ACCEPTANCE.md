> Historical V1/V2 acceptance record. The commands and paths below describe those delivered versions. For the current V3 monorepo use `pnpm install --frozen-lockfile`, `pnpm run doctor`, and `pnpm build`; see [ACCEPTANCE-V3.md](ACCEPTANCE-V3.md).

# Acceptance report — 2026-10-09

Scope: user-provided HANDOFF.md M0→M3, independent single-user local-first application on the authorized cloud computer. No user Mac files were accessed. All media is synthetic. No commit, push, deployment, public upload or paid model request was performed.

A9 remains BLOCKED / 待真实验证. Final aggregate: 59/59 tests passed, zero failed; clean install/build and relocated sample generation passed. Actual Chromium final run passed10 checkpoints with zero page errors, including a response deliberately dropped after accepted generation plus a double-click. Frozen MCP proof and the UI screenshot use the same project ID. Details and artifact hashes are recorded under evidence/.

| ID | Result | Reproducible evidence |
|---|---|---|
| A1 | PASS | `npm ci`, `npm run doctor`, `npm run build`, actual loopback health/login; `evidence/clean-install/commands.log`, `evidence/runtime.json`, `evidence/browser/A1-empty-workbench.png` |
| A2 | PASS | HTTP integration creates≥3shots, imports image+video, changes prompt/order/XY, SIGKILL/restarts backend, verifies equality; `tests/integration.test.mjs`, `evidence/integration/acceptance.json` |
| A3 | PASS | Official MCP Client+StdioClientTransport initialize/list/call, shared HTTP state, UI screenshot of exact project; frozen `evidence/mcp-demo/` and `evidence/browser/A3-mcp-project-in-ui.png`, matching project ID in browser steps |
| A4 | PASS | 20 concurrent exact replays=1 provider invocation/accepted task, running restart=1, submitting barrier/no accepted task stays unknown with0 submits, accepted-response-lost reconciles; independent durable mock ledger and actual SIGKILL in integration evidence |
| A5 | PASS | Stale shot/order/selection/node mutations409 with current revision, newest content preserved; integration conflict responses; asynchronous job race regressions `tests/races.test.mjs` |
| A6 | PASS | Two versions, immutable prompt/reference snapshot and MP4 hashes after later edits, selectV2; integration evidence and `evidence/browser/A6-version-comparison.png` |
| A7 | PASS | Definitive reject/failure, unresolved submission, recoverable polling timeout, accepted-response loss, one failed download, local-only cancellation; provider/integration/race tests and `evidence/browser/A7-unknown-submission.png` |
| A8 | PASS | Three real clips export6.000s720×1280H.264; full decode exit0. Separate story demo10.000s720×1280H.264+AAC. `evidence/integration/export-probe.json`, `evidence/demo-ffprobe.json`, actual MP4 deliverables |
| A9 | BLOCKED | Runway Gen-4 Turbo adapter implemented and offline contract-tested. No authorized live submit/query/download/UI run. Requires secure credential, approved image hashes, explicit model/material scope/count and currency budget. See PROVIDERS.md |
| A10 | PASS | Actual Chromium UI import→3shots/edit→generate→play→double-click/version compare/select→reorder→text node→refresh→unknown warning→export/download; screenshots, steps and zero JS page errors under `evidence/browser/` |

## Commands

- `npm test`: provider contracts, HTTP/process recovery, official MCP protocol, client request retention, deterministic async races
- `npm run test:browser`: actual Chromium suite, starts backend itself and records screenshots/download
- `npm run doctor`: exact Node, embeddedSQLite, FFmpeg and ffprobe versions
- `npm run demo`: five2-second story seed against running backend

The checked-in browser test ran successfully on the authorized cloud computer using actual Chromium. Application loopback binding, authentication and Origin controls remained enabled. Initial browser harness was corrected to close the auto-opened job drawer and dismiss an acknowledged network-error toast before the next action; these were test-navigation corrections, not skipped functionality.

## Reliability issues found and fixed

1. Async reconciliation could overwrite a newer local cancellation/completion. Persisted job revision/CAS fencing now rejects stale writes; deferred-provider tests verify it.
2. Failure persisting an accepted task ID could have mislabeled a paid task as definitively failed. It now stays uncertain and retains the ID if possible; no blind resubmission.
3. MCP reconstructing a schema from its shape could silently strip unknown fields. Full strict Zod schema is registered; actual-wire parity test verifies no mutation.
4. Manual reconciliation could steal another local job's task ID, including concurrent claims. Ownership is rechecked after awaits; mock request-ID ownership is verified.
5. Reconciliation of queued/submitting/definitively failed jobs could abandon work. These states now remain unchanged; optional binding in those states is rejected.
6. Repeated retry clicks could create concurrent retry children. Backend rejects a second active/unknown child, UI disables the original retry, exact key replay still succeeds.
7. Browser lost responses could discard submission identity. Exact input/requestId is persisted before dispatch and reconciled with server jobs; uncertain transport retains it across refresh.
8. Export now checks actual input bytes against the frozen version hash before FFmpeg, and managed reference resolution supports relocated complete data directories.

## Known limits

- A9 has not run. Offline adapter success and mock media are not evidence of real AI output or cost.
- Demo graphics are synthetic test patterns; original Stanley/Maltese product images were not available in this cloud environment. Product/brand accuracy is not reviewed.
- Localhost is usable only on the computer running the app. No public/cloud preview URL or hosting is supplied.
- No Mac desktop packaging/signing/notarization, cloud sync, multiuser accounts, complex transitions, keyframes or speed effects. V2 adds the bounded multitrack timeline described below.
- Base64 import is bounded to30MiB/file; larger files need a later streaming upload interface.
- The chosen Runway cancel endpoint can also delete completed outputs, so this version only stops local waiting and never claims remote cancellation.
- Node24 and FFmpeg are installation prerequisites; browser tests additionally need Chromium+PythonPlaywright.


# V2 acceptance — 2026-10-09

The later user instruction explicitly expands scope to real multitrack editing and four clearly named functional regions. The original v1 ZIP/MP4 remain unchanged. All media is original procedural/test media; no user Mac, original product files, live provider, paid API, commit, push or deployment was used.

- Aggregate regression:84/84 passing, zero failures (`evidence/v2-full-tests.tap`). The original 59 tests remain included.
- Actual V2 Chromium:13/13 checkpoints, zero page errors (`evidence/v2-browser/steps.json`). Covers named regions, guide, source/audio playback and WAV import, actual pointer library→canvas and library→timeline drop, cross-track movement, exact trim/source frames, state-preserving modes/panel collapse, stale preview, overlap/incompatible-target errors, hide/mute, accepted-response loss plus reload/exact replay, actual preview seek/playback, real export/download and reload persistence.
- Actual original Chromium flow:10/10 checkpoints still pass (`evidence/v2-v1-browser/steps.json`). Import, generations, version comparison/selection, order, unknown-submission recovery, legacy export and original MCP/story samples remain working.
- Backend:non-destructive stable migration, all mutation operations, exact replay after later edits/restart, concurrent duplicate and conflicting requests, strict nested schema rejection, immutable request responses and render snapshots, source bounds and track/clip/duration limits.
- Real MCP:official SDK wire invokes all 8 timeline tools;12 concurrent duplicate requests;10 original responses replay exactly after real backend restart;HTTP state matches. WAV/MP3/M4A imports verified (`evidence/v2-tests/mcp/`).
- Actual composition:pixel/frame/audio checks verify layer priority, transparent contain, source alpha, leading/interior gaps, single-frame edges,71-frame non-whole-second ending, video/audio source trims, mixed/gain/muted sound, hidden-but-audible video, audio-only output, snapshot changes while queued/running, byte-tamper rejection, actual SIGKILL recovery and separate v1 export (`evidence/v2-tests/media/`).
- Preview/export parity:10-second demo preview and export have identical SHA-256; independent media tests also compare all decoded video-frame fingerprints and audio PCM. Both use the same compositor.
- Maximum bounds:100 clips / 10 minutes produces exactly 18000 frames and600.000 seconds. Verified 234-second cloud runtime, reported max child RSS 129328 KiB.12 simultaneous layers also passed (`evidence/v2-tests/stress/`).
- UI sizing:1600×1050 and1366×900 real screenshots. Region guide and selected-clip inspector captured. These checks are not a claim of full WCAG compliance.

## V2 semantics and limitations

Output is fixed 720×1280 at 30fps with stereo 48kHz AAC. At most 12 tracks, 100 clips, 10 minutes. Same-track overlaps reject; cross-track overlaps composite higher video tracks over lower ones. Video visibility and audio mute are independent. Gain mixes additively, so loud overlapping sources may need reduced gain. Preview is an explicitly rendered snapshot; later edits make it stale until re-rendered. No transitions, keyframe animations or speed changes.

Timeline clip sources do not follow later shot-version changes. Old projects acquire an empty timeline; only the explicit empty-timeline seed operation copies current shot selections. Original sequence exports remain available.

A9 live-provider verification remains BLOCKED / 待真实验证 and is independent of these completed local editing/composition checks. Localhost is only available on the machine running the backend; no hosted preview or Mac package is supplied.


## V2 reproducibility and delivery

A clean copied checkout installed 132 locked packages offline from the previously downloaded cache, built successfully and reported Node 24.19.0, SQLite 3.53.3 and FFmpeg/ffprobe 7.1.5. A second relocated copy of the multitrack project loaded identical IDs/revision/clip timing and rendered byte-identical output from its managed relative paths (`evidence/v2-clean-install/`). V2 normal installation used `npm ci`; current V3 installation uses `pnpm install --frozen-lockfile`. The offline cache is a verification detail, not a prerequisite.

The new V2 ZIP has a per-file SHA-256 manifest and keeps the original V1 ZIP unchanged. It includes source, production build, tests, portable synthetic samples, Chinese region guide and accepted evidence. Runtime access-token files, lock files, WAL/SHM files, dependencies, private credentials and transient failure screenshots are excluded.

### Requested model configuration

Production development and the final review used GPT-6 Astra ultra. One initial nested media-test draft used inherited GPT-6 Astra at xhigh before it was stopped. That test file had no production edits; it was independently reviewed and expanded at ultra, including additional source-alpha and audio-only cases, and the complete assertions were rerun successfully. The exception is recorded rather than claiming every substep used ultra.


# V4 final acceptance — 2026-10-09

This historical V1/V2 record is preserved. Current V4 evidence and implementation scope are in [ACCEPTANCE-V4.md](ACCEPTANCE-V4.md), superseding earlier statements that only Runway is implemented or that no CLI exists.

- 291/291 aggregate automated tests pass, independently repeated by the parent reviewer; no skips.
- 142 provider contract tests cover Runway/mock and new Ark Seedance, Gemini Veo, MiniMax H3 V2 and Vidu Q3 Turbo, all using injected HTTP rather than live providers.
- Actual provider renderer acceptance passes six stages with six provider choices, compact configuration disclosure, CLI-created shot → UI generation → CLI same-state readback, two local mock MP4s and preserved multitrack state.
- Original browser regressions pass13 timeline +10 original +12 Base UI cases with no page errors.
- Fresh final Linux Electron0.4.0 native development smoke passes20 checks, including sandbox/security, six-provider readiness, crash recovery and real multitrack video playback.
- Clean frozen-lockfile offline install, Web/Electron builds, real CLI bin, byte-identical relocated rendering, Skill validator and independent Skill→CLI→MCP→MP4 forward test pass.

All five real-provider adapters are implemented but live untested. A9 remains separately gated by provider/account/region/model, prompt/media scope, generation-count and total-currency-budget approval plus secure backend configuration. Vidu requires a reviewed exact output-host list. No paid call or provider reference upload occurred. Mac native execution, packaging/signing/notarization and updates remain unverified. Historical Linux0.3.0 binary remains unchanged; V4 ships source, reusable Skill and evidence rather than a falsely relabeled installer.
