# Mioon approved product roadmap

Updated: 2026-10-10 UTC. This is approved iteration scope, not a completion claim.
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
  The approved decoupled subject/keyframe/motion workflow below defines the staged scope.
- Scene/shot purpose, planned duration and dialogue/voiceover; timed still-frame animatics
  and explicit transfer of the chosen storyboard sequence into Editing.
- Visible generation provenance and reusable recipes/one-parameter variants, built on existing
  job snapshots. Saved seeds/configuration do not guarantee cloud-model pixel reproducibility.

Acceptance: plan a six-shot film cheaply, reuse a consistent product reference, replace one
weak shot while preserving deliberate timeline timing, and inspect the recipe for each output.

#### Decoupled subject, keyframe and motion workflow (approved 2026-10-10)

The first narrow subject-library increment is implemented. Focused checks, final
web/desktop builds and Linux native acceptance passed; the independent full-suite
release gate passed as recorded in [SUBJECT-LIBRARY.md](SUBJECT-LIBRARY.md). Image
generation has an accepted local Mock slice and fixed-OpenAI activation checkpoint
`4e66a96` (2026-10-10), including its affected/build/Linux synthetic-native checks
and full suite (2758 total, 2756 passed, 0 failed, 2 skipped). The current
[custom Images increment](IMAGE-COMPATIBLE.md) is implemented with its
own passed focused/build/Linux synthetic-native and full-suite gate (2857 total,
2855 passed, 0 failed, 2 skipped). Its one independent HTTPS/JSON/PNG slot does not establish
all-vendor compatibility. Motion-reference adapters and Blender integration remain
planned. [Images activation](IMAGE-ACTIVATION.md) preserves the earlier evidence;
it does not establish this custom gate or real-provider acceptance.
Existing managed assets, saved versions, explicit reference bindings and fixed
timeline replacement are reusable foundations. The first usable Linux trial is
already available independently of these stages; native macOS/Windows and live
providers remain unverified. Continued iteration does not block that limited trial.

1. **Versioned subject library and typed bindings.** Add project-scoped, versioned
   character/product/location/look entities backed by selected managed assets.
   Represent subject, style, first frame, last frame and motion as distinct roles,
   with explicit shot/version bindings and saved provenance. A later reference
   version flags affected shots for review; it never silently changes an existing
   clip, frozen job snapshot or generated result. Acceptance: bind one subject to
   multiple shots, change its reference version, review affected bindings, and
   reproduce the exact older selection after restart without hidden propagation.

   **Current narrow stage:** three project-scoped local writes (`subject.create`,
   `subject.version.add`, `subject.binding.set`) and three bounded reads, using one
   existing managed PNG/JPEG/WebP image per immutable version. Only `subject` and
   `style` planning bindings are added, with independent revisions, explicit
   adopt-latest/keep-old review and retained unlink tombstones. Existing
   `reference.attach` remains the separate actual `first_frame` input. Last-frame,
   motion and provider input integration are future stages; there is no automatic
   regeneration, identity-lock claim, name editing, delete or new media import.
   Required stable keys extend the local eight-operation namespace to eleven;
   durable UI preparation adds these three writes to the explicit fifteen-operation
   allowlist. Eight independent schema-preservation cases, focused checks, final
   web/desktop builds and Linux native restart acceptance passed; the independent
   full release gate passed. This does not expand built-in Agent tools/
   context or depend on Blender, paid calls or live-provider approval.

2. **Capability-checked inputs and reviewed keyframe-to-video stages.** Subject
   references and first/last images can be uploaded, extracted from managed video,
   generated as images, or imported from external rendering. Motion references
   can come from any supported managed video source. Validate each provider/model's
   supported role combinations, number/type/size/duration limits and region before
   preparing a request; unsupported combinations require an explicit user choice,
   never silently dropped references or substituted providers. Offer an optional
   two-stage flow: produce/select keyframes, review them, then separately approve
   the exact video input and its cost limits. Acceptance: reject unsupported
   combinations consistently in UI/API/CLI/MCP, retain exact approved assets and
   request identity across interruption, and never submit stage two automatically
   merely because stage one completed. Mock verification is not live certification.

   **Historical first image slice (2026-10-10, baseline `82c70f3`):** a separate
   image composer, shared project-scoped
   image task/group/version/request operations, exact-request recovery and real
   deterministic Mock 1024×1024 PNG assets. The named standard OpenAI image
   preset had an offline-tested adapter and stayed hard-disabled at that checkpoint.
   No image key setting, custom endpoint, live activation, model-tool authority
   or automatic second-stage video submission was added by that slice. Existing library assets
   are reused through explicit timeline/reference/subject edits. Secure image
   configuration and reviewed activation were its immediate follow-on, now the
   active implementation below. See [Image generation](IMAGE-GENERATION.md) for
   the preserved initial evidence and unchanged local/unknown recovery.

   **Accepted Images activation checkpoint (2026-10-10, `4e66a96`):** dedicated fixed OpenAI
   settings and an independent credential, retained exact request reviews and
   explicit visible paid-button approval for at most one POST are implemented.
   The 461-test affected gate, fresh builds and Linux native synthetic-network
   acceptance passed; the independent final full suite passed
   (2758 total, 2756 passed, 0 failed, 2 skipped). This
   is not live-provider or macOS/Windows acceptance. Public API/CLI/MCP gains only
   review prepare/get/list, never approval, credential tools or paid Agent authority.
   Usage-based unknown cost is disclosed rather than represented as a currency
   cap. A live canary still needs its separate exact configuration/media/fees
   approval. See [Images activation](IMAGE-ACTIVATION.md).

   **Current custom Images increment (2026-10-10, offline gate passed):** one separate
   `openai-compatible` / `custom` connection with private settings/key/file,
   canonical public-DNS HTTPS:443 base URL, configured ASCII model and fixed
   single-`b64_json` PNG profile. It reuses the settings/codec/lifecycle and exact
   one-POST UI-approval fence. Saving does not probe; official settings stay
   untouched. Custom v2 reviews retain full immutable configuration/destination;
   schema 18 rebuilds only the review table with raw historical values preserved.
   No new Agent authority, public approval tool, URL download, local ComfyUI,
   model negotiation or automatic fallback is added. No real key/live call/output
   is verified. The affected gate passed 584/584 tests (0 failed/skipped), and
   fresh web/desktop builds passed. Final Linux synthetic-network native acceptance
   and the independent full suite passed (2857 total, 2855 passed, 0 failed,
   2 skipped). See [custom Images](IMAGE-COMPATIBLE.md), including
   the inherited synchronous Keychain/timeout limit; macOS remains unverified.
   Broader plugin design remains separate from this bounded increment.

3. **Source provenance independent of creation tool.** Track external-file import,
   extracted frame, previs render and generated-version provenance as typed,
   versioned source relationships. Optional original project files, including
   `.blend`, are provenance attachments only; they are never needed to open a
   project, bind reference images/video, generate video or edit/export its timeline.
   Acceptance: perform the same source-selection/version-return workflow with
   uploaded media, extracted frames and externally rendered media, without Blender
   installed, while original bytes and old snapshots remain unchanged.

4. **External result return, then optional Blender adapter.** First expose bounded
   managed-result import and explicit version return through shared MCP/CLI
   business services. Validate project ownership, media content, provenance,
   revision and replay identity; returned media never auto-replaces a timeline
   source. An optional later adapter may ask an externally installed Blender to
   rerender a supported project and return a managed result. Do not embed Blender,
   require `.blend`, or make the earlier stages depend on that adapter. Acceptance:
   a non-Blender external workflow imports a new version exactly once, conflicting
   or foreign returns fail safely, and optional rerender failures/cancellation do
   not damage the prior version. External-tool installation/execution and access
   remain explicitly scoped; a project file cannot grant its own permissions.

Dependencies: shared asset/version provenance and request recovery first; bounded
image/frame extraction and role schemas before the optional two-stage UI; current
official provider capability/model-ID review plus profile-specific fixtures before
live integration; external result import before a tool-specific rerender adapter.
Blender is one optional source adapter, not a shared-service dependency. Provider
capabilities may constrain input combinations; the product modules remain
independent. Reference reuse aims for continuity and does not guarantee absolute
identity locking or cloud-model reproducibility. This roadmap approval grants no
live generation, media upload, credential entry or spending authorization.

#### Reference editing, compositing and replacement (approved 2026-10-10)

Extend the reviewed keyframe/version workflow above in this order:

1. Keyframe edits and product/object/background replacement or removal.
2. Mask-based compositing and tracking, with an explicit deterministic-composite
   path distinguished from AI redraw.
3. Person replacement, retaining source provenance and real-person consent records.
4. Precise-identity face swapping as a separate later stage, with its own review
   and acceptance requirements.

Reuse the right dock: preview and explicit confirmation → generation (or local
composite rendering) → comparison → new immutable version. Preserve originals;
reuse exact-request recovery and approved, bounded media inputs. Provider work
requires explicit model/media scope and total budget approval. AI redraw carries
no exact identity or pixel-preservation promise. The current official Aleph 2.0
video/keyframe input contract exposes no hard spatial-mask input; do not present
it as deterministic masked compositing. Recheck capabilities before integration.
See [Runway's official API types](https://github.com/runwayml/sdk-python/blob/main/src/runwayml/types/video_to_video_create_params.py#L43-L181)
(checked 2026-10-10).

This is approved future scope, not implemented by the current subject-library
increment. It has no Blender dependency and does not block the first usable trial.

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

### Optional extensions and catalog (implementation approved for a later milestone, 2026-10-10)

Follow [EXTENSIONS-ARCHITECTURE.md](EXTENSIONS-ARCHITECTURE.md): keep project data,
assets/versions, task recovery, permissions and paid execution in the stable core;
add bounded connectors, processors, import/export, workflow skills and declarative
right-dock contributions. Start with an extensions manager and official catalog,
then prove the SDK with an optional external ComfyUI connector and a distinct offline
export adapter. Third-party execution needs enforceable isolation and distribution
gates; publishing/review/revocation and a paid marketplace come later. This is planned
work approved for implementation at an appropriate milestone, not an implemented
store. Current Images and trial usability take priority; preserve the existing
delivery order instead of starting an immediate framework rewrite. Third-party
installation/execution, hardware provisioning/access, live calls and store publication
still require separate applicable authorization. This work does not block the first
limited trial or the active image/Agent/editing increments.

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

The bounded audio/performance waveform increment is implemented with opt-in
local raw-source visualization and bounded, disposable derived cache work. Local
verification and the independent release gate passed in `fd49dac`. Limits and acceptance
are tracked in [WAVEFORMS.md](WAVEFORMS.md). This does not complete proxies,
post-mix analysis, loudness checks or the broader audio roadmap.

The bounded delivery increment implements shared read-only timeline export
preflight and an inline right-workspace report. Local browser/native and real
export checks and the independent release gate passed in `168c22d`. It reuses export
rules and source verification without project-format expansion or full upfront
decoding. Scope and acceptance are tracked in [EXPORT-PREFLIGHT.md](EXPORT-PREFLIGHT.md).


## Fixed-source version workflow checkpoint (2026-10-10)

The next bounded version-workflow increment is explicit timeline clip source
replacement with preserved timing, layout and audio fades. It uses the existing
revision/replay/history service, with inline source review in Right Properties.
Implementation and local focused/browser/native/media checks are complete; the
independent release gate remains pending. [CLIP-SOURCE-REPLACEMENT.md](CLIP-SOURCE-REPLACEMENT.md)
tracks scope, acceptance and retained limitations. Visual A/B comparison, automatic propagation and
generation/spending remain outside this increment.


## Original image-generation approval (2026-10-10, historical scope)

The following records the original approved direction. The accepted Mock workflow
and fixed-OpenAI activation checkpoint `4e66a96` have dated evidence, including
activation's affected/build/Linux synthetic-native checks and full suite (2758
total, 2756 passed, 0 failed, 2 skipped). The separate bounded custom slot is now
implemented with its own passed offline/Linux synthetic-native gate. This history is not live-call
approval; current scope is [custom Images](IMAGE-COMPATIBLE.md), with shared
approval/recovery rules in [Images activation](IMAGE-ACTIVATION.md).

After the wired model-input-limit slice, prioritize an independent OpenAI Images
API text-to-image workflow and editable preset. Generated images must enter the
existing managed asset/version storage, with explicit actions to use the chosen
image on the timeline, as a first frame, or in a subject version. Preserve
originals and reuse durable task/recovery, source provenance and budget approval.
A custom base URL is not proof of Images API compatibility. Image editing, masks
and broader reference combinations follow separately; Blender is optional and
this work does not block the verified Linux trial. No live call or credential
configuration is authorized by this roadmap entry.
