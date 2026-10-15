# Continuous synthetic Electron qualification

Run explicitly from the repository root, with a fresh output directory:

```sh
node tests/fixtures/timeline-audio-continuous/launch.mjs /tmp/mioon-continuous-numeric-unique
```

The launcher creates only synthetic media and a separate disposable workspace. It bundles a test shell with the production continuous client/engine and native bridge, and launches the installed Electron with sandbox, context isolation and web security enabled. The harness enables autoplay only for this controlled test shell. It uses the production native owner/proofs, managed media validation, continuous service, decoder and HTTP adapter. Its limited local metadata/static shell is test plumbing, not evidence of the complete product UI.

The 25-second case plays on the actual AudioContext clock, crossing the former 20-second boundary. A bounded test AudioWorklet captures the output before the destination and emits silence downstream. The independent FFmpeg reference reconstructs original global composition segments, including muted edges, with independent volume, sample-count fades and unnormalized additive mixing. The AAC 44.1 kHz case separately checks segmented resampling at two-second transport boundaries. Two-minute and ten-minute cases compare one production client block at a time without whole-timeline retention. All numerical cases use 2e-6 maximum absolute error and report RMSE/sample counts/boundaries.

`report.json` preserves environment, cases, renderer retention, underruns, application readiness/seek timing and observed backend work/media-child events. `electron.log` captures bounded runtime diagnostics. Generated assets, reference files and workspace stay under the chosen output root. Additional test capture allocations are reported separately from production admission; this is not an RSS bound. Cold means the first explicit fixture preparation; filesystem cache is not flushed. Warm timing has four samples, so p95 is descriptive of this small synthetic run. No physical listening, device latency certification or production UI acceptance is claimed.

For a deliberate repeat against this fixture's existing synthetic data, first preserve the previous report/bundles, then add `--reuse-fixtures`. `MIOON_CONTINUOUS_CASES=controlled-25s` limits a diagnostic repeat to one named case; a final qualification runs without this filter. Each rebuild records current source and actual bundle hashes. `workFrames` is the service's conservative charged work, including original segment seek prefixes and bounded pipe/filter read-ahead; it is reported separately from exact output sample counts. A worklet capture reserves at most 28 seconds of test PCM and each independent reference is consumed in a block of at most 768,000 bytes.

Capture alignment uses the observed production `AudioBufferSource.start(when)` absolute integer sample origin. It never searches the output for a favorable offset or treats the first exact nonzero as the source start. The latter produced a retained false red at an origin where a theoretical zero first sample became a 2.87e-19 interpolation residual; a deterministic OfflineAudioContext reproduction matched the original spurious 0.00873565673828125 error exactly. Correct absolute alignment keeps that residual inside the unchanged 2e-6 sample comparison. No production engine timing change was needed.
