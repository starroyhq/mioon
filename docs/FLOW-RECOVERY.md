# Source preview and image-history recovery

Date: 2026-10-11. Baseline: `8a97492a3323cbc6c6a1b0deb87c30efd6537ca5`.

## Implemented scope

Two renderer fixes; no backend, schema, provider, request-key, authorization, or timeline mutation changes.

1. **Source video/audio seeking.** A requested source position remains pending until the current visible media binding can apply and publish it. A render before metadata readiness no longer consumes that request or lets an older metadata callback reset it. Re-renders, hidden views, new sources, and native playback/scrubbing retain their separate ownership fences. Positions use the existing 30 fps editing clock, not a claim of source-native/VFR frame accuracy.
2. **Image history identity.** Changing selected image group/version page clears the previous group's preview and page cursor immediately. Loading and read errors are explicit. A matching same-page read failure can retain its verified previews. Captured asset-reveal actions validate current group/version/asset membership. Group-page changes also clear the previous next-page cursor. This applies to direct selection and accepted/recovered task flows; it neither submits nor retries generation.

## Actual acceptance in the restored cloud environment

- Source-seek regression: actual compiled Preview component initially **14 tests / 12 passed / 2 failed**; final worker checks **65/65 passed**, including adjacent visibility/range checks.
- Image-history regression: initial eight cases **1 passed / 7 failed**; independent review found a separate group-pagination reset failure, reproduced **1/1 failed** before its fix. Final focused history cases **10/10 passed**.
- Final combined affected gate: **316/316 passed, zero skipped**, 3,711 ms. The first command named a nonexistent test file and the strict launcher rejected the selection before running tests; that log is retained separately.
- Fresh development Web + Electron build: **exit 0**, Web asset `index-CFi26ToE.js`; the native application used the unmodified bundled backend and that built Web UI. Existing third-party directive/chunk-size warnings remain in the build log.
- Linux native, synthetic workspace: source video **150 → 151 → 150** frames and preview-tab return at frame 150; source audio **90 → 91 → 90**; persisted A/B Mock history selection; explicit read-error and recovery; correct B asset reveal; normal application exit and recreation; saved history read after recreation. Audio position/UI was checked; the cloud host has no usable ALSA playback device, so no audible-output claim.
- Fault evidence: only the isolated B asset's metadata width was temporarily changed. No trigger, application code, or source media was changed. The formal backend rejected the inconsistent history; the right dock displayed B + read error without A's old version preview. The exact original metadata byte string was restored before explicit re-read. All **4 asset rows, 2 groups, 2 tasks, 2 versions, 2 request receipts** and all **4 media hashes** matched before fault, after restoration, after exit, and after recreation.
- Independent read-only reviewer verified the five production/test hashes, screenshots 06–08, and pre-fault/restoration/exit audits with no remaining blocker. Both Mock outputs intentionally have identical pixels; the evidence uses group labels, asset IDs, and database hashes rather than inferring identity from the picture.
- **Parent independent full suite: exit 0; 3,169 total / 3,167 passed / 0 failed / 2 skipped**, 520,623.250536 ms. This was a new full run in the restored environment, using bounded concurrency 1; the parent verified the actual process terminal state.

The deferred-metadata and late-event races were controlled in actual-component tests. Native evidence demonstrates ordinary seek/visibility behavior and an actual backend read refusal; it does not claim to force the exact metadata timing race. No real provider call or Mac/Windows native acceptance was performed in this slice.

## Evidence continuity and delivery

The old cloud execution environment no longer contained the repository or ignored evidence. Source/history were restored with ordinary Git clone and verified at the exact baseline above. A frozen-lockfile install succeeded with a workspace-local pnpm store; the first default-store attempt failed because its parent directory was absent. The pinned Electron 44.7.0 official package installer then completed. The historical pass counts recorded elsewhere remain historical, not results rerun after restoration.

Old ignored evidence and the five uncommitted Windows proof draft files were **not recovered**. They are not present in this diff and are not claimed as preserved. Any future reconstruction must be identified as such.

Current raw acceptance is under `evidence/flow-recovery/`, `evidence/source-seek-recovery/`, and `evidence/image-history-selection/`. A separate allowlisted evidence archive contains this report, source/build manifests, red/green logs, original screenshots, and sanitized row/media audits for durable Library delivery. It excludes the runtime workspace, SQLite files, desktop configuration, local authentication token/connection files, and credentials. The parent records the returned Library ID after upload; local archive creation alone is not durable delivery. Future blocked source drafts require an explicit WIP checkpoint rather than an uncommitted-only copy; the accepted main line remains separately reviewed.

Screenshot 06 is the actual B read-error state; 08 is recovered B + its library result; 11 is saved A history after full native recreation. Screenshots 09–10 show the initial Images form after restart, not the saved-version section.

## Follow-on

The approved source-video single-frame extraction workflow remains a separate next increment. It is not implemented by these fixes and will use shared business services, explicit source/hash/timepoint binding, stable local-task recovery, and existing explicit asset reuse actions.
