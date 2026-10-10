# Mioon approved product roadmap

Updated: 2026-10-09 UTC. This is approved iteration scope, not a completion claim.
Baseline: `66a0193`. Verified deliverables remain in STATUS.md and their acceptance reports.

## Product direction

Local-first, single-user AI creation and editing workbench: review assets, plan shots,
generate and select versions, assemble a timeline, and export real media. Canvas and
Editing are complementary views of shared project data. External agents use MCP/CLI;
an optional in-app Agent uses the same business services. Keep an editable handoff
to established finishing tools in scope rather than duplicating an entire professional NLE.

## Current committed foundations

- Electron monorepo, shadcn/Base UI, durable local assets/jobs/versions and real FFmpeg export.
- Shared UI/API/MCP/CLI business services; split, snapping and durable timeline undo/redo.
- Independent collapsible/resizable Canvas and Editing layouts, with draft/media lifecycle guards.
- Agent provider presets and write-only connection settings. Chat and tool execution are NOT
  delivered by the settings commit. Real provider connectivity is NOT certified.

## Ordered delivery groups

### 1. Finish the in-app Agent workflow

Follow [AGENT-ITERATION.md](AGENT-ITERATION.md): secure compatible transport, streamed
responses and cancellation, durable scoped conversations/read tools, shared mutation replay,
reviewable local edits and explicit paid-generation approval. Common-provider presets remain
editable and carry documentation/mock/live verification status. Codex OAuth is deferred.

Acceptance: an agent can read only its selected project, propose a real edit, execute once,
recover after interruption and surface a conflict without overwriting newer user work.
Do not stop at a settings dialog or chat-only demonstration.

### 2. Make selection and editing dependable

- Source in/out ranges, favorite/reject states, notes/tags, unused filters and jump-to-usage.
- Audio waveforms, aspect/timebase project specifications, useful clip/keyboard operations.
- Import capability reporting; original/proxy mapping, preview-quality controls and bounded
  cancellable cache jobs. Add selected-range render caching where measurements justify it.
- Audio fades/crossfades, voice/music roles, editable ducking and peak/loudness warnings.
  Existing clip gain and mute are foundations, not new features to reimplement.
- Explicit SDR/color metadata handling and preview/export consistency before richer exposure,
  white-balance/contrast/saturation controls. Unsupported HDR/log paths need clear treatment.
- Export preflight, selected-range test exports and playback of the produced artifact.
  Reuse existing immutable render snapshots, fingerprints and output probing.

Acceptance: a representative multilayer project remains usable on a stated laptop target;
select a useful subrange, mix speech/music without clipping, and export the checked range
and full cut using originals with matching timing and sound.

### 3. Connect planning, continuity and generation

- Image generation through the existing managed-asset/job/provider architecture.
- Version comparison, explicit replacement of a timeline source, and video-frame references.
- Reusable versioned character/product/location/look reference entities linked to shots.
  Changed references flag affected shots for review; they never silently regenerate footage.
- Scene/shot purpose, planned duration and dialogue/voiceover; timed still-frame animatics
  and explicit transfer of the chosen storyboard sequence into Editing.
- Visible generation provenance and reusable recipes/one-parameter variants, built on existing
  job snapshots. Saved seeds/configuration do not guarantee cloud-model pixel reproducibility.

Acceptance: plan a six-shot film cheaply, reuse a consistent product reference, replace one
weak shot while preserving deliberate timeline timing, and inspect the recipe for each output.

### 4. Finish and deliver several versions safely

- Unified generation/render/export task states, including unknown submission; no blind retry.
- Count/parameter/available cost disclosure; never label a count cap as enforced currency budget.
- Backup/restore, missing-media checks and portable project bundles.
- One explicitly limited editable timeline interchange format, validated in a chosen NLE.
  Report unsupported effects and baked segments; no universal lossless round-trip claim.
- Named deliverable sequences sharing source assets: landscape/portrait and short/long cuts,
  framing overrides, safe areas and explicit propagation/override rules; batch export later.
- Text/subtitle layers, then optional editable code-based motion templates with sandboxed rendering.

Acceptance: restore a project independently, export two intentional delivery variants, and
open a supported editable cut in the target editor without rebuilding its basic edit by hand.

## Cross-cutting engineering requirements

These apply to every group, not just a final cleanup phase.

- macOS and Windows readiness: isolate paths, process lifecycle, media-tool discovery,
  secret storage, package identity/output, signing/notarization and future update policy.
  Linux tests or a cross-build alone cannot establish native-platform readiness.
- Security: least-privilege Electron, bounded/validated inputs, scoped Agent tools, safe
  network destinations, protected credentials, managed file boundaries and dependency review.
- Structure: identify actual duplicated semantics and oversized components; extract cohesive
  services, hooks and UI components incrementally with behavior tests. Avoid speculative generic
  frameworks and a wholesale rewrite. Keep UI/MCP/CLI on shared business behavior.
- Verification: interrupted/repeated flows, conflicts, process restart, real media outputs and
  runtime screenshots. Record passed, failed and never-run checks separately.
- Every local commit is reviewed and reported with changes/evidence; UI or feature changes include
  actual screenshots. No automatic push, deployment, publication or source-bundle delivery.
- Live inference/generation, real credentials and material uploads require the agreed configuration,
  media scope and budget before integration. Credentials are entered through secure app setup,
  never requested in chat. Signing, release and update publication remain separate approvals.

The concrete code/platform audit is maintained in ENGINEERING-QUALITY-ROADMAP.md.

## Research references and limits

Sources checked 2026-10-09. They inform workflow decisions, not claims of feature parity.

- [Final Cut range keywords](https://support.apple.com/guide/final-cut-pro/add-keywords-ver68416335/mac)
- [Runway reusable references](https://help.runwayml.com/hc/en-us/articles/52963720640275-Using-reference-media-to-guide-your-generations)
- [LTX storyboards](https://ltx.io/studio/platform/ai-storyboard-generator)
- [Kdenlive proxies](https://docs.kdenlive.org/en/project_and_asset_management/project_settings/proxy_settings.html)
- [Kdenlive rendering](https://docs.kdenlive.org/en/exporting/render.html)
- [Shotcut features](https://www.shotcut.org/features/)
- [Premiere color management](https://helpx.adobe.com/ca/premiere/desktop/correct-color/set-up-color-management/how-color-management-works.html)
- [Kdenlive timeline exchange](https://docs.kdenlive.org/en/user_interface/menu/file_menu.html)
- [OpenCut](https://github.com/OpenCut-app/OpenCut): approximately 93.3k stars when checked;
  main is a rewrite and some advertised API/Agent capabilities remain future work.
- [LosslessCut](https://github.com/mifi/lossless-cut): approximately 44.4k stars; study behavior,
  assess licensing before any source reuse.
- [Remotion](https://github.com/remotion-dev/remotion): approximately 62.7k stars;
  special source-available license, not unrestricted MIT reuse.

Stars are approximate observations, not a maturity or security guarantee. Direct code reuse,
dependencies and distribution licenses require a version-specific review before integration.

## Selection delivery checkpoint (2026-10-10)

The first bounded selection increment is saved per-asset video/audio source
ranges, an independent range revision, and explicit copying of the confirmed
range into a new timeline clip. Verification and limitations are tracked in
[SOURCE-RANGES.md](SOURCE-RANGES.md). The broader selection/editing group above
remains open; one saved range is not a favorites/tags, proxy, waveform, or
native-timebase implementation.

The next bounded selection increment is independent favorite/拒选/neutral asset
metadata and explicit local library filtering. Its current implementation and
verification status is in [ASSET-DISPOSITIONS.md](ASSET-DISPOSITIONS.md). Tags,
notes, unused filters and jump-to-usage remain open.

## Audio editing delivery checkpoint (2026-10-10)

The first bounded audio edit is optional clip-local fade-in/fade-out using the
existing timeline revision, replay and history contracts. Right Properties
controls target audio files or embedded video audio, with matching local rendered
preview/export. Source playback remains dry. Current validation and limits are in
[AUDIO-FADES.md](AUDIO-FADES.md); waveform/cache work, crossfades, ducking,
roles, loudness checks and project-format expansion remain open.
