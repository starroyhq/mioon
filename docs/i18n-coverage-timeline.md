# Timeline, colour, audio, delivery and recovery localization

Status: core timeline and delivery/recovery presentation extraction complete; final copy-regression rerun and product-wide final-copy/native/browser acceptance remain in progress. The normal integrated TypeScript check passed (2026-10-15). This document does not claim whole-product completion.

## Covered core components

Every listed component uses the four-locale catalog for static and dynamic UI, accessibility labels, tooltips, statuses, empty states, confirmations, validation, and owned safety notices:

- `Timeline.jsx`, `TimelineInspector.jsx`, `TimelineHistoryControls.jsx`, `TimelineSplitControls.jsx`, `TimelineFormatPanel.jsx`.
- `ClipLutControls.tsx`, `LookPackControls.tsx`, `ClipSourceReplacement.jsx`.
- `ClipAudioControls.jsx`, `TimelineWaveform.jsx`, `TimelineAudioPreview.tsx`.
- `SourceRangeInspector.jsx`, `FrameExtractionPanel.jsx`, `Preview.jsx`, `VideoFrameControls.jsx`.
- `SubtitleInspector.jsx`, `SubtitleLane.jsx`.
- `TimelineSourceBanner.tsx` and the canvas ↔ timeline status on shot nodes, the storyboard strip, the shot inspector and the export content choice; their messages are in `packages/i18n/src/catalogs/canvas-timeline.ts`.

Core messages are in `packages/i18n/src/catalogs/timeline.ts`; every entry has exact `zh-Hans`, region-neutral `zh-Hant`, `en`, and `ja` fields. The core and delivery fragments are checked for duplicate keys before spreading, using `assertNoDuplicateMessageKeys`.

## Covered core state and display boundaries

- `clip-lut-recovery.ts`: typed application-owned `ClipLutRecoveryError` with closed stable codes replaces Chinese-prefix exception classification. Recovery record schema, identity, locking, and storage behavior remain unchanged.
- `timeline-notices.ts`: typed display-only descriptors alongside compatibility diagnostics; no addition to business requests or persistent recovery metadata.
- `clip-lut-state.ts`, `look-pack-intake.ts`: validation and retained error descriptors; explicit Log/HDR/ICC/EXIF/alpha/domain/adoption restrictions retained in all languages. Unknown raw reasons do not select behavior or appear as the primary UI summary.
- `clip-audio-state.js`, `waveform-state.js`, `use-timeline-audio-preview.ts`: render-time validation/status/error mapping with stable codes. Waveform duration restriction no longer inspects arbitrary backend text. Audio preview transport and resource ownership are unchanged.
- `timeline-history.js`, `timeline-split.js`, `timeline-snapping.js`, `timeline-source-freshness.ts`: message descriptors alongside compatibility fields; missing shot names use explicit missing-name metadata, never user-name matching.
- `clip-source-replacement.js`: blocked, review, and error descriptor adapters. Immutable candidate review and replacement inputs remain unchanged.
- `source-range-state.js`, `subtitle-state.js`, `frame-extraction.js`, `timeline-format-state.js`: display-only error/reason descriptors without locale dependencies in lifecycle effects. Original request identity, unknown outcome versus confirmed rejection, explicit same-request replay, queued-only cancellation, frame/profile constraints, and draft retention remain unchanged.

## Offline backup guide

- The existing `docs/WORKSPACE-BACKUP-GUIDE.zh-CN.md` remains the Simplified Chinese source.
- Added `docs/WORKSPACE-BACKUP-GUIDE.zh-Hant.md`, `.en.md`, and `.ja.md`.
- Exact CLI commands, example paths, codes, file names, capacity limits, permission modes, restoration scope, fsync limitations, uncertain cleanup, no-overwrite, and no-provider/no-replay warnings are preserved.
- Commands and numerical/security tokens are checked across all three translations. These files are documentation only; no commands were executed.

## Reviewed exceptions

`docs/i18n-ui-exceptions-timeline.json` is the per-literal, SHA-256-bound exception ledger for this core scope. Each reviewed diagnostic identifies its descriptor-rendering consumer and compatibility purpose; technical tokens have individual reasons. The current inventory has 91 unique reviewed core exceptions and no stale or unreviewed records in those files. Delivery/recovery owns its separate ledger. `docs/i18n-ui-exceptions-delivery-clients.json` adds 14 exact transport-diagnostic exceptions with stable code → descriptor → GUI paths and preserved timeout/cancellation, unknown-outcome, protocol-integrity and restored-branch restrictions.

- User-created clip, track, project, asset, source, subtitle and reference names/text remain unchanged. Paths, filenames, IDs, SHA-256 values, request IDs, historical input, operation codes, media pixels, profile IDs, technical format labels, units (`f`, `fps`, `px`, `KB`), subtitle-track glyph `T`, timecode, and numeric form values remain unchanged.
- The literal supported Chinese punctuation sample in the subtitle inspector is font-profile evidence, not translatable prose. Localization does not expand supported subtitle glyphs or change burned-in pixels.
- Backend/client diagnostic strings may remain in internal compatibility fields. Display uses owned descriptors or a safe localized main summary; stable safe error codes may be shown as labelled technical evidence. There is no runtime source-text lookup or translated-string control flow.
- Original backup CLI example paths are retained verbatim in every language. The guide links to the existing technical Desktop/restore documents; those broad repository documents are outside this UI extraction.
- `framesLabel` remains an invariant editing timecode, not a localized business value. Display-only duration formatting never flows into RPC input.
- Controller-related `key` values still use source/project/clip identity, never locale. No business lifecycle effect gains a language dependency.

## Delivery/recovery companion scope

`docs/i18n-coverage-timeline-delivery.md` records export settings/history/download, loudness/preflight, backup/restored workspace, and clip/delivery/shot-text draft recovery components and helper controllers. Those messages are composed from `timeline-delivery.ts` after duplicate checking. The companion source is integrated and its final consolidated baseline passed 493/493 tests. Product-wide acceptance remains separate from targeted results.

## Tests and checks

Completed checkpoints (some suites overlap):

- Typed LUT recovery plus existing LUT UI: 34/34.
- Look-package UI: 9/9.
- Timeline fades/history/snapping/source-freshness plus Look-package checkpoint: 69/69.
- Waveform and timeline split checkpoint: 33/33.
- Source replacement UI: 43/43.
- Timeline audio preview UI: 31/31.
- Subtitle, frame extraction, source range UI and source preview checkpoint: 79/79.
- Combined core checkpoint: 118/118 passed (catalog/switching, preview/capture, format, fades, waveform).
- Latest combined core and delivery-switching/preflight checkpoint: 151/151 passed (`i18n-delivery-recovery`, `export-preflight-ui`, `i18n-timeline`, `source-range-ui`, `clip-source-replacement-ui`, `source-range-preview`, `frame-extraction-preview`).
- New `tests/i18n-delivery-recovery.test.mjs` mounts real delivery range/name controllers and workspace/recovery surfaces, switches all four locales with a real language store, and checks unchanged raw number drafts, user delivery names, capture identity, project/recovery evidence, child/page identity and action counters. Four additional cases drive actual local delivery and shot-text controllers into local-validation and unknown-preparation failures, then verify retained descriptor errors relabel without changing state/capture/input identity or invoking any additional transport calls. Offline backup-guide commands and security tokens are checked across translations.
- The final copy review replaces English revision shorthand with localized revision labels (not user-content version names), and uses typed one/other templates for clip, shot and retained-history counts. Count-one/count-two tests cover all locales, including an actual restored-workspace panel with numeric count.
- New `tests/i18n-timeline.test.mjs` validates all four catalog fields/placeholders and drives a real language store through the same mounted subtitle inspector and unknown frame/output-format controllers. It checks exact retained state/input identity, literal user text, unchanged request count, unchanged draft, and no duplicate submission or business-effect restart.
- Existing custom component harnesses receive explicit localization dependencies; Chinese safety assertions are retained against rendered zh-Hans catalog text, alongside key-presence assertions, rather than removed.

Normal integrated typecheck: passed exit 0 after narrow typed delivery display-adapter and error-code fixes. Count-only interpolation uses locale-aware number formatting without modifying backend numbers or non-count technical parameters.

Pending acceptance: final revision/plural copy-regression rerun, lead-owned build, and native/browser layout plus live switching in all four languages. No provider calls, paid models, commit, push, merge, or deployment performed here.
