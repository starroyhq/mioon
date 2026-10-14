# Production graph numeric fixture

This fixture is synthetic and test-only. It never runs on app startup/import.
Reserve the serial media/browser test slot before executing it.

1. From the repository root run:
   `node tests/fixtures/timeline-audio-preview/numeric-harness.mjs /tmp/mioon-audio-numeric`
2. Open the printed loopback URL in a real Chromium browser with normal sandbox settings.
3. Click **Run numeric checks**. The page uses actual `OfflineAudioContext` and the same exported graph as production, then an actual realtime `AudioContext` routed through a bounded test-only pre-destination recorder.
4. Save the complete `#report` JSON and a screenshot. Passed evidence requires `data-status=passed`, all five independent FFmpeg comparisons, the actual-client allocation check, the 93-origin gain-boundary sweep, and the realtime capture check. A prepared fixture or passing fake-node suite is not browser/audio proof.
5. Stop the fixture server. No generated WAV/PCM files belong in production or in a workspace backup.

Production graph input comes from bounded, actual FFmpeg-generated canonical 48 kHz stereo PCM. Independent FFmpeg `volume`, sample-count `afade`, sample-count `adelay`, additive `amix` with normalization disabled, and exact `atrim` generate the reference. The page reports per-channel maximum absolute error, exact sample counts and nonzero boundaries for onset/end, overlap, original fade positions after a sample-precise seek, window cuts, silence, and above-one float headroom. Tolerance is 2e-6 per channel. This is not a tolerance for 44.1 kHz/AAC reseek seams.

The realtime ramp is a separate test-only sample-identity fixture. Three isolated nonzero runs must start at sample zero, the exact retained pause sample, and the explicit seek sample. Per-channel numeric error is below 2e-6, silence separates generations, and context closure is verified. The recorder is placed before the physical destination and emits silence downstream. Physical output-device availability and subjective listening remain unclaimed.

Every capture reserves explicit bounded PCM capacity in addition to the production plan's conservative application-buffer admission. The report is not total Chromium/native/OS RSS. The engine never calls `getChannelData` on a scheduled production input buffer.

Above-one float summation is intentionally retained. This does not establish parity with the legacy s16 export, which can clip, or the float-v2 export, which rejects values above one.

Pure causality suite:
`node --test tests/timeline-audio-preview-engine.test.mjs`

## Observed gain-boundary regression and correction

The first actual Chromium run passed all five independent FFmpeg comparisons but failed realtime seek capture: the first seek sample decoded as source sample 12000 instead of 24000. A retry happened to pass; that retry was not treated as a fix.

A deterministic production-graph sweep reproduced the cause at origin time 0.020000000000000222 s (960.0000000000107 sample frames). The BufferSource began at frame 960 while its first gain automation event was infinitesimally later. Two gain-two voices, each containing constant left 0.25/right -0.125 PCM, produced first-sample left 0.5/right -0.25 instead of left 1/right -0.5; subsequent samples were correct. The first sample used GainNode's default intrinsic gain of one. The red report is `evidence/timeline-audio-preview/numeric/browser-third-causal-red.json`; pre-fix engine and browser bundle are preserved beside it.

The minimal production correction initializes AudioParam.value to the exact original-clip envelope value before scheduling the first automation event. No timing shift, limiter, tolerance change, or new channel-copy operation was introduced. The added unit assertion failed before the change (intrinsic gain 1 versus expected 2); the corrected engine suite passed 23/23.

Actual Chromium recheck passed all seven checks: all five independent FFmpeg comparisons retained the original 2e-6 per-channel tolerance, all 93 fractional-origin probes had zero gain error, and realtime capture resumed at exact retained sample 3776 and sought to sample 24000. Evidence: `evidence/timeline-audio-preview/numeric/browser-fourth-causal-green.json`. This is numeric pre-destination evidence, with no subjective listening claim.

## Actual client allocation observation

The browser entry also invokes the real production preparation client against the already-served fixed synthetic f32 files. A test-only adapter validates the client's fixed endpoint query and adds matching identity headers around the unchanged streamed response; this is explicitly not proof of the production HTTP route. It observes native AudioBuffer allocation counts and payload bytes, actual transport-chunk maxima, serial requests, exact repeated-source deduplication, complete finite PCM and digest validation, conservative copy/staging reservations, and confirmed closure of each owned context. The check must pass before the combined report can pass. It does not report total Chromium/native/OS RSS or a physical output device.
