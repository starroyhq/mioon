# Clip audio fades

Updated: 2026-10-10 UTC. Baseline: `374f587`. Local implementation and focused/runtime acceptance are complete; parent independent full-suite review remains the release gate. Native macOS/Windows certification is not implied.

## Scope and shared contract

`timeline.clip.add` and `timeline.clip.update.patch` accept optional `fadeInFrames` and `fadeOutFrames`. Both are integer timeline frames at the existing fixed 30 fps. Omission means zero and remains absent in stored clips, history, immutable render snapshots and original replay responses. Explicit zero disables that edge. There is no database migration, operation expansion or new key namespace.

Each fade must be 0–durationFrames and the sum must not exceed durationFrames. The edges may meet. Positive values require confirmed audio in an audio or video asset; images and videos without audio cannot acquire a nonzero fade. Gain and track mute still apply. Hidden video can still contribute sound, as before. Fades never modify original media or its source-range metadata.

Duration changes revalidate both saved fades atomically. Callers can adjust duration and both fades in one patch. Invalid edits fail with `INVALID_FADE` (or schema validation for malformed input) without a timeline revision/history change; missing audio yields `FADE_AUDIO_UNSUPPORTED`. There is no automatic shortening or overlap.

The existing timeline compare-and-swap, required request key, exact original-response replay, undo/redo and immutable rendering contracts apply unchanged. UI, HTTP, CLI and MCP dispatch through the same services. A lost acknowledgement is recovered with the exact existing request input and key, never a fresh request key.

## Split rule

For a cut offset relative to the clip start, `fadeInFrames <= offset <= durationFrames - fadeOutFrames`. A cut inside an active fade fails with `SPLIT_FADE_BOUNDS`, before any revision or history entry. Cuts exactly at fade boundaries are allowed. The left clip keeps its outer fade-in; the right clip keeps its outer fade-out. New inner edges are zeroed only if the corresponding field existed; absent legacy fields remain absent. This preserves the same mathematical envelope instead of inventing a crossfade or truncating an active fade.

## Rendering and playback

The existing renderer cuts work into segments at every track's clip boundaries. Fades are anchored to the complete clip, not to each segment. After resampling to the existing 48 kHz output, each 30 fps frame is exactly 1600 output samples. The filter gives `afade` integer clip-relative timestamps in a `1/48000` timebase, applies linear ramps, then resets timestamps for segment mixing. Source seek offset is independent of envelope time. The final stream is encoded once to AAC; PCM segment audio avoids per-segment encoder delay.

For clip-relative sample `n`, duration `D`, fade-in length `I` and fade-out length `O`, the gain multiplier is `min(1,n/I)` for a nonzero in-fade and `min(1,(D-n)/O)` for a nonzero out-fade, clamped to 0–1. The out endpoint is exclusive: the last real sample approaches zero and silence begins at `D`. Fades use the timeline/output sample clock; they do not promise source-native or VFR frame accuracy. Zero/missing fades retain the previous audio filter string unchanged.

Right Properties edits fades alongside gain. The source media player remains dry and is labeled accordingly; saved fades are audible in a newly rendered timeline preview and export. Old rendered previews remain old immutable snapshots and use existing stale-revision warnings. No realtime DSP, waveform cache, automatic ducking, loudness limit, crossfade or format/fps expansion is delivered here. Gain/mixing can still clip.

## Context boundary

External timeline operations expose the optional fields through their shared schemas. The built-in Agent's fixed inspection DTO and write allowlist are unchanged: it does not inspect or edit these fades. Its timeline inspection is a bounded projection, not a full audio mix description. No additional project context or model authority is inferred.

## Official references

- [FFmpeg afade options and linear curve](https://ffmpeg.org/ffmpeg-filters.html#afade), checked 2026-10-10.
- [FFmpeg afade source: sample position is derived from frame PTS](https://ffmpeg.org/doxygen/trunk/af__afade_8c_source.html), checked 2026-10-10. The deployed binary is separately checked by real synthetic audio tests; documentation alone is not compatibility evidence.

## Acceptance record

- Final serial affected pass: **115/115**, including new fade rules/UI/transports/PCM and existing timeline/history/split/media acceptance. Source-preview, source-range UI and visibility regressions: **38/38**. Logs: `affected-final.log`, `visibility-regressions.log`.
- Media acceptance: **7/7**. Five exact PCM cases include mono 44.1 kHz resampling, stereo, meeting/one-sided/one-frame fades and adjacent samples at unrelated clip edges. Worst sample error was below **3.73e-9**; allowed-split decoded AAC comparison RMSE was **0.000615**. Real HTTP queued export and preview, fixed historical output hashes, gain/mute/hidden-video/source-trim checks are in `media/acceptance.json` with three MP4s.
- Actual HTTP, CLI and official MCP parity: **2/2**; original optional schemas/effects/catalog remain intact. Initial failures were test-fixture assumptions about JSON Schema `$ref` and transient rejected-add IDs; the initial and corrected terminal outputs are preserved separately.
- Fresh installed-entrypoint web and Electron builds passed serially. Final JS is `index-Co8ea9bJ.js`; the existing large-chunk warning remains. `build-manifest.json` records 49 web/staging files. No bundle was reused from the prior increment.
- Own-cloud browser UI: seven grouped checks passed using supported CUA locators. These cover save, invalid sum/trim, split gating, tab/project draft guards, a competing shared-service update, actual rendered preview and reload. A separate authorized local SQLite/file audit confirms persisted values, unchanged original bytes and no generation/model runs. The polling conflict appeared before a stale Save could be clicked; the UI correctly disabled it and kept the draft.
- Ordinary sandboxed Linux Electron: native keyboard increment changed 29→30, tab switch preserved the draft, Save persisted 30/30, a real 120-frame preview rendered and played, and a complete app recreation retained the same timeline, receipts, render identity and original hash without a new request/export. Both app lifetimes exited **0** (PIDs 24163 and 24360). `native-output-probe.json` verifies 4 s, 120 H264 frames, AAC 48 kHz stereo. Native screenshots 01–09 include the final `native-09-fades-after-restart.jpg`. The screenshot shows UI state; audio correctness is established by decoded PCM/AAC tests, not by an image or subjective listening.
- Browser harness setup encountered separate localhost namespaces, an unsupported compiled module format and a denied `node:process` import. That route was stopped; supported UI actions and separately authorized fixture inspection completed the checks. The unrun bundled harness/failure report remain as evidence, not passing automation. Cleanup navigation to `chrome://newtab/` was denied by URL policy; it was not retried or bypassed, and the supported tab close completed. The fixture server records clean shutdown in `cloud-browser-final/closed.json`.
- The first parent aggregate was **1717 total: 1714 passed, 1 failed, 2 skipped**; it is not a full-pass claim. Its unchanged Q4 HEAD/empty shutdown test measured 5441.615 ms against a total-elapsed upper bound. The unchanged isolated test passed; a test-only causal timer/socket/descriptor regression and deterministic pre-arm-delay case replace that conflated assertion. The final causal suite passed **3/3** in 19.76 seconds; its timer/socket traces are saved in `shutdown-clock-proof.json`. Production shutdown and all fade/build inputs remain unchanged. The historical delay cause is not established; see [HTTP-STREAMS.md](HTTP-STREAMS.md). The initial aggregate and fixture-diagnostic failures remain preserved. Parent final aggregate must be rerun after these test changes.
- Read-only review found no outstanding blocker after fixing split UI eligibility to match fade boundaries. No production source changed after the fresh build; no live provider calls, real credentials, uploads to a provider or platform security changes were part of verification.

Evidence is retained under `evidence/audio-fades/`. Parent independent aggregate/release review is still required; this is one bounded audio editing increment, not completion of the audio roadmap.
