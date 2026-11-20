# SP-I0 speed-interpolation phase prototype

Prototype-only measurement of curve-speed optical flow (`minterpolate`), frame
blending (`framerate`) and chunked proxies. It does not touch product code,
project formats, dependencies or the UI.

Run with the application-same FFmpeg 7.1.5:

```sh
MIOON_FFMPEG_PATH=/path/to/ffmpeg-7.1.5 MIOON_FFPROBE_PATH=/path/to/ffprobe-7.1.5 \
  node scripts/speed-interp-phase/run-prototype.mjs --output ./sp-i0-results
```

Without the environment overrides the script downloads the public
`media-tools-7.1.5-1` darwin-arm64 release, verifies the pinned manifest, gzip
and unpacked SHA-256 hashes, then runs. All test media is generated locally
(testsrc2/color/overlay); no downloaded or committed media. `--skip-bench`
skips the 1080x1920 three-mode benchmark, `--quick` removes the scratch media
after the run.

Outputs: `results.json` (full evidence), `summary.json` (CI summary) and
`status.log`. Methods, results and the SP-I recommendation are in
`docs/verification/speed-interp-phase.md`.

CI runs this script only when `scripts/speed-interp-phase/` changes (macOS
arm64 pull-request job) and uploads `checks-sp-i0` evidence artifacts.
