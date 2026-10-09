# V4 acceptance — 2026-10-09

## Delivered implementation

- Five real adapters, with current official-source links and deliberately bounded model subsets: Runway `gen4_turbo`, Ark `doubao-seedance-2-5-260628`, Gemini `veo-3.1-generate-preview`, MiniMax `MiniMax-H3`, Vidu `viduq3-turbo`; one local mock provider. See PROVIDERS.md.
- One provider registry, shared per-model input validation, safe readiness/configuration metadata, local count limits, explicit regional boundaries and secure Electron utility environment propagation.
- True `video-workbench` CLI with JSON stdout, stderr progress, schema/doctor/capabilities, all 31 operations, local byte import, bounded job/export watching, private token-file/discovery connection and exclusive authenticated file download.
- Actual official SDK stdio MCP, 31 business tools + 3 discovery tools, sharing the same HTTP client/schema/business service as CLI and UI. No second database or HTTP-MCP facade.
- Portable `skills/video-workbench/` with concise SKILL.md, progressive connection/operation/recovery references and an executable synthetic mock workflow. No global skill or MCP configuration writes.
- Capability-driven renderer with provider/model/input choices, disabled/unconfigured guidance, compact Chinese setup cards and keyboard-accessible disclosure. Canvas and inspector share generation choices. Live generation and retry retain explicit review.

## Verification

### Automated: 291 passed, no failures/skips

`node --test tests/*.test.mjs`

Evidence: `evidence/v4/full-regression.tap`; independently repeated 291/291 aggregate evidence is `evidence/v4/parent-regression.tap`.

The original 146-test coverage remains. New coverage includes 142 total provider tests across legacy and four new adapters; exact request and state mapping; explicit rejection versus unknown acceptance; one POST only; approved image bytes/dimensions/checksums; fixed regional origins; bounded JSON; cached status errors; refresh of expired downloads; real H.264 fixtures; credential stripping across allowed Veo redirects; fail-closed output hosts and symlink paths. Live-region changes are rejected for submit, polling, download, manual reconciliation and retry.

A downloaded live result with a mismatched aspect ratio is paused as `output_review_required`, publishes no version, retains its known provider task and never starts another generation. The compatibility status is local `cancelled`, with distinct UI copy; it is not a remote cancellation or safe-to-retry failure.

CLI tests launch actual subprocesses and MCP uses genuine initialize/list/call wire exchanges. They prove shared state, schema parity, full mock export/download, repeated and lost-response request deduplication with one ledger submission, current-revision conflicts, timeout/Ctrl+C without remote cancellation, no token logging, partial-download cleanup and long-lived client rotation after a desktop restart.

### Actual renderer and native app

- Provider browser: 6 stages, all 6 provider choices, actual CLI shot creation and same-state readback, model constraints/readiness, collapsed and keyboard-expanded configuration, explicit image-clear confirmation, canvas consistency, two immutable mock MP4s, reload and unchanged multitrack playback. `evidence/v4-browser-provider/result.json`.
- Multitrack browser: 13 checkpoints; original browser: 10; official Base UI behavior: 12. All pass with no page errors. Evidence folders: `v4-browser-timeline`, `v4-browser-original`, `v4-browser-components`.
- Native Linux Electron development runtime: 20 checks, app version0.4.0, Electron44.7.0, bundled Node24.21.0 and SQLite3.53.4. Checks include sandbox/no Node bridge, private cookie/discovery, all six safe provider entries, process ownership/recovery, unsaved-exit cancellation, original multitrack render and actual 720×1280 playback. `evidence/v4-desktop/smoke.json`, `electron-workbench.png`.

The initial restricted command runner could not launch Chromium because its `socket()` operation is unavailable. Tests were run in the assistant's supported own-cloud graphical session, without disabling the sandbox. No user computer was accessed. Screenshots were visually reviewed; PNG extensions match actual PNG bytes.

### Portable skill and clean source

- `quick_validate.py skills/video-workbench`: pass; `evidence/v4/skill-validation.txt`.
- Independent forward test with only Skill/raw brief: pass. 15 CLI calls, local synthetic import/generation/export, real media decode, visible SIMULATED MOCK label and MCP same-state readback; `evidence/v4/independent-skill-test.md` with assets alongside.
- Clean checkout: frozen-lockfile offline install with normal approved package lifecycle scripts, Web build, Electron staging build, CLI bin and doctor pass. `evidence/v4-clean-install/`.
- Relocated sample: all five timeline clips and revision preserved, real re-render SHA-256 exactly `569a6408b661921c95ed8b3b93cfe1eec426e8a235898c7d5c80b475952de540`, matching original bytes. Runtime and Skill file hashes are recorded for clean-copy/source parity.

## Artifact boundaries

Source0.4.0, portable Skill and optional evidence are separate ZIPs, each capped at15MB and independently manifest/hash checked. The source includes all three complete synthetic example projects and small browser fixture indexes; it excludes node_modules, credentials, live data, built runtime archives and repeated old evidence. See deliverables/v4-package-result.json for exact filenames/sizes/hashes.

The historical `video-workbench-0.3.0-linux-x64.tar.gz` remains unchanged. It does not include V4; no new packaged installer is claimed. macOS native execution, signing, notarization, updates and distribution remain unverified. FFmpeg/ffprobe are external declared dependencies.

## Live generation boundary

Every real provider is implemented and offline tested, but **live untested**. No generation POST, reference upload, payment, account mutation, remote cancellation, external publication, commit, push or deployment occurred. Mock output is real local MP4 but not prompt-faithful AI output.

Provider availability/eligibility, output quality, current account pricing, regional credentials and fees remain unverified. Vidu additionally requires reviewed exact output hostnames; no guessed CDN is trusted. Sora's discontinued API is documented only as an excluded option.

A9 requires a separate bundled decision on provider/account/region/model, prompt and exact media scope, count and total currency limit, secure backend credentials and approved download hosts. Local count caps are not dollar-spend guarantees. Unknown acceptance stays paused; it does not authorize a second paid request.
