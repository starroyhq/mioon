# Selected-range timeline test export

## Scope

This increment adds an optional selected interval to an intentional **timeline export**. It does not cut the saved timeline or its sources, change preview playback, create another sequence, or change the supported encoder/output profiles. Focused acceptance, Linux packaged native verification and the independent parent full-suite gate are complete.

The right-hand Delivery compose tab has Whole timeline / Selected range controls. The clock is the existing fixed 30 fps timeline clock. Start is included and end is excluded. A selection must contain at least one frame and fit inside the saved timeline. An output of `[15,75)` contains 60 frames, or 2 seconds. These are composition frames, not a claim of source-native/VFR frame accuracy.

Unsubmitted range choices are session-only, like existing encoding selections. They survive switching right-dock tabs, but must be selected again after reopening the project/application. The existing autosaved delivery-name draft remains name-only. Opening the tab or changing the range does not check, export or call a model.

After explicit confirmation, the existing fixed-purpose export intent durably retains the complete request, including the range and its original request key. Recovery displays and uses that retained input even when the current form shows another range. A timeout/lost response does not permit a new key or an automatic full-timeline fallback.

## Shared contract and compatibility

`timeline.render` accepts optional `exportRange:{startFrame,endFrame}` only with `purpose:'export'`. `timeline.export.preflight` accepts the same optional field. Both integers are finite and bounded by the existing 18000-frame maximum; `0 <= startFrame < endFrame`. A fresh request additionally requires `endFrame <= saved durationFrames`. Extra fields, explicit null/undefined, negative/fractional values and preview ranges are rejected.

The original **complete** timeline and asset snapshot remain frozen. `snapshot.exportRange` and `summary.exportRange` preserve the selected interval; summary duration/counts describe the complete saved composition. Output duration is derived from `endFrame-startFrame`. No clips, fades, subtitles, geometry, source offsets or original bytes are rebased or rewritten.

Omission preserves the existing request/snapshot/receipt representation and full-render path. An explicitly supplied full-span range is a distinct intent from omission. The old response is replayed before comparing with a newer revision or shorter current timeline. Current ownership and immutable source identity checks still apply. Changing or removing the range under the original key conflicts.

The preflight digest binds range, name, encoding selection and full source graph. Preflight still checks every referenced source, including sources outside the selected range or on hidden/muted tracks. Existing byte/time budgets are unchanged. A stale revision is reported before fresh range-length rejection; an invalid range cannot receive a ready digest. Capabilities remain a separate bounded local encoder check and accept neither range nor display name.

There is no database migration, new RPC operation, task namespace, state file or built-in Agent tool. UI, HTTP, CLI and external MCP share the same services and strict schemas. A restored workspace may create a fresh origin-bound local export via its existing route; inherited captured work remains held, and local delivery-name/intent companion support is still unavailable there.

## Rendering and failure boundaries

The renderer selects intersecting original full-timeline segments. Each retained segment keeps its original source seek, fps/resampler phase, clip-relative fade envelope and globally timed subtitle intersections. Final graph outputs are trimmed at relative video frames and 1600 audio samples per 30fps frame, then start at presentation time zero. The selected frames are encoded and concatenated; source decoding/filtering can include preroll. A short range is not promised proportional runtime savings.

Final verification checks exact video frame count, 30fps, dimensions, MP4/H.264/AAC format, bounded duration, audio sample rate/channel layout and zero presentation origin. Lossy H.264/AAC exports from independently encoded intervals need not have byte-identical compressed data; real acceptance compares decoded frame identities, subtitle edges and audio envelopes with an independent full reference. Source and stored timeline bytes remain unchanged.

Range-only exports retain immutable receipt discrimination even if a stored range is altered/removed before the first worker read. Source ownership, current accepted identity and owned staging are rechecked across asynchronous media work and immediately before actual spawn/publication. Cleanup only removes retained owned staging identities; unknown replacements are preserved. This is not a filesystem sandbox or a guarantee against every same-process/path race.

There is no new export-cancel RPC. Aborting a read-only preflight detaches/cancels that observation's bounded local work without creating an export. Existing worker shutdown preserves accepted exports for the existing local restart behavior; it does not create another request. Exact replay never creates a second export merely to discover status.

## Validation status

Verified on the isolated `4089b1926aeed90506f1ac959d4ab9d8d7954814` baseline plus this change set:

- Strict typecheck and fresh Web/shared-backend/Electron production build pass. Linux x64 directory packaging passes with the locked Electron 44.7.0 and electron-builder 26.15.3.
- Contracts/business/actual-App UI/UTF-8 inventory gate: **162/162**. Existing delivery/replay/preflight/restored-media regressions: **283/283**. Real HTTP, actual CLI and official MCP plus durable request recovery: **10/10**. Real media/range-plan/legacy fades/subtitles/export-settings: **44/44**, no skips in these gates.
- The transport tests deliberately lose responses and recreate the real SQLite store/services. They are separate from the native test; they do not claim to kill the entire native application.
- The final Linux package was operated through supported native UI: reject `[15,15)`, retain `[15,75)` across dock tabs, run explicit preflight, confirm exactly one export, inspect burned Chinese/English subtitles, normally quit/reopen, and rediscover the same completed history and frozen original request. Both native exits are confirmed exit 0 with the backend lock released; the restarted backend used a different port.
- The original 90-frame timeline and managed source remain unchanged. The selected output is exactly **60 frames / 2 seconds / 1280×720 / 30 fps**, AAC 48 kHz stereo, zero presentation origin and complete decode exit 0. Native MP4 SHA-256: `dae7f390033fd1c81d4c0ded14ee3d5364c442baaf5ff394737260ca3f842a75`. Against the independent full-export slice, maximum decoded tiny-frame MAE was 0.001736 and audio RMSE 0.001310. Dedicated tests additionally prove exact pre-AAC PCM slicing and frame/subtitle boundaries.
- Original failed test/build/helper evidence is retained. A 44.1 kHz ideal-amplitude oracle was corrected against independent resampled PCM without relaxing its tolerance. A scaled lossy-output crop comparison was supplemented with causal original-frame/color-mask checks; native-resolution phase thresholds remained unchanged. The initial package attempt used an unwritable default cache; a documented writable cache argument fixed only the invocation. The initial native schema audit omitted the ordinary Mock provider bootstrap; the corrected audit verifies its exact empty tables/index and all previous schema/data identities.
- Actual-App testing found that hidden restored-workspace compose callbacks could consume preflight bindings. Both confirmation paths now check visibility without clearing the retained binding; hiding/reopening remains passive. This narrow safety fix has causal tests.

Independent source and native evidence reviews found no blocker. The final parent gate completed with strict typecheck exit 0 and **5,598 total / 5,596 passed / 0 failed / 2 skipped**, test-process exit 0, in 952,379.496894 ms. The original full log is preserved as `parent-full.tap` in the portable synthetic evidence bundle. Synthetic managed media only; there is no real provider or Mac/Windows native verification in this increment. Unsent range controls are intentionally session-only; normal native reopen is not described as crash acceptance. Native audio correctness was decoded and measured, not verified through a physical sound device.
