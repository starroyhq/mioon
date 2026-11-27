# Speed interpolation verification

## Phase prototype

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

## D9 product measurements

```sh
node scripts/speed-interp-phase/run-product.mjs --output /tmp/mioon-sp-i-results
```

The product benchmark uses the same pinned media tools and generates exact
30 fps synthetic sources. It measures export-video staging and a common
libx264 encode for 1080×1920 off, blend and optical deliveries. The optical time
includes generating and verifying the lossless proxy before export staging.
Each 0.25× delivery must contain exactly 600 frames.

A separate 120-second, 64×64 source checks the real optical proxy at each
2-second block boundary against a single continuous filter run. Synthetic scene
cuts and 120 fps occlusion and fast-motion references exercise the same product
paths. Known cut positions are injected into the proxy worker, so this does not
measure scene detection. Peak RSS is sampled from the worker process tree
every 100 ms. The sum can count shared pages more than once and can miss peaks
between samples. The summary also records system load.

The macOS arm64 pull-request step runs the prototype with `--skip-bench --quick`
and the product benchmark when `scripts/speed-interp-phase/` changes. The
`checks-sp-i0` artifact contains the prototype evidence and the product summary
and status logs. Working media is removed.
