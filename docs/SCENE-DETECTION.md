# Reference scene detection

2026-10-23. Detector and decoder only:
`packages/business/src/scene-detection.ts` (pure, frames in, cuts out) and
`packages/business/src/scene-detection-decoder.ts` (managed source → FFmpeg →
detector). Nothing calls them yet: there is no operation, HTTP route, CLI, MCP or
Mio tool, no UI and no storage. The background task, the stored result, "建分镜",
"按切点分割" and the panel come in a later increment.

## Result

- `cuts`: `{frame, score}` on the 30 fps editing grid (`SOURCE_RANGE_FPS`).
  Frame N is the first frame of the new shot. A clip starting at N begins with
  that shot under the frame capture rule (first frame at or after N/30).
  - Exact for sources up to 30 fps: N = floor(30 × native cut frame / rate).
  - Above 30 fps a cut between two editing frames rounds down. The segment can
    then start up to one source frame early, for example 1/60 s at 60 fps.
- `score`: the combined difference at the cut, 0–1.
- `segments`: consecutive `{startFrame, endFrame}` ranges covering the source.
- `frameCount`: `sourceFrameCount` of the probed duration, the length the editor
  uses for the same source.
- Also returned: the normalized `options`, `profileId` (`scene-cuts-v1`, to be
  bumped whenever scoring or selection changes), `sourceHash` and the analysis
  frame size.

## Algorithm

- **Decode.** FFmpeg runs `fps=30:round=down,scale=W:H:flags=area,format=rgb24`.
  The longest edge is at most 256 pixels, never upscaled. Frames stream through
  a pipe and are never written to disk.
- **Score.** Each frame pair scores 0.75 × the mean absolute RGB difference plus
  0.25 × the mean per-channel histogram distance (total variation). Histograms
  use 16 linearly weighted bins per channel, so a small brightness change moves
  little weight.
- **Candidate.** A frame is a candidate when all of these hold:
  - its score is a local peak: above the previous score and not below the next;
  - it clears the threshold. Adaptive mode uses the excess over the median of
    the previous 1.2 s (36 scores); fixed mode uses the score itself;
  - it is not a flash. A flash is any frame before the change that matches any
    frame after it, at most 0.2 s (6 frames) apart. Matching means below half
    the change and below what a cut across that span would need:
    span × background + threshold in adaptive mode, the threshold in fixed mode.
- **Minimum shot** (default 0.6 s, 18 frames).
  - Candidates closer than that to the start or to the end are dropped, so a
    short tail merges into the previous segment.
  - Of the rest, stronger cuts win (then earlier ones), and no two kept cuts
    are closer than the minimum shot.
- **Sensitivity** 0–100: threshold = base × 2^(−sensitivity / 20), so every 20
  points halve it. The base is 0.64 (adaptive) or 0.8 (fixed), so the default
  of 60 means 0.08 and 0.1.

## Calibration

These checks used synthetic clips only; no real footage was available. The
thresholds need re-checking against real reference films.

At the default (adaptive, 60, 0.6 s):
- Every cut was found at its exact frame:
  - cuts between distinct sources and shot/reverse-shot;
  - wide to close-up in the same scene;
  - a cut during a fast pan;
  - two dim shots;
  - a CRF 34 encode.
- None of these produced a cut: static noise, moving test patterns, Mandelbrot
  zoom, slow pan, zoom-in, handheld shake, fast pan, hue drift, 1- and 3-frame
  white flashes, and a lightning strike with a decaying afterglow.
- A 1 s dissolve produced no cut. A fade through black produced one cut inside
  the transition.

Trade-offs:
- At 70 and above, false cuts appear in two clips: a flat colour brightening in
  compressed steps, and a 0.4 s whip pan.
- At 50 and below, the dim cut and the same-scene cut are missed.

On the separation measure (excess over the median), the weakest true cut scored
0.096 and the strongest non-cut 0.074.

## Source profile and limits

- **Source profile.** Frame capture's own profile and limits: detection calls
  `frameDecodePlan`, so it accepts exactly the sources whose keyframes can be
  captured.
  - managed MP4/WebM with one H.264/VP8/VP9 8-bit yuv420p progressive stream;
  - zero start, square pixels, no rotation, 1/D time base;
  - at most 600 s, 512 MiB, an edge of 4096 and 8 Mi pixels.
- **Why 600 s.** Frame capture decodes from the start of the file rather than
  seeking, and hashes the whole source twice per capture. Raising the limit for
  long reference films would mean changing frame capture first. Longer sources
  can be trimmed before detection.
- **Speed.** Decoding and filters run single-threaded. 60 s of synthetic 1080p
  took 2.4 s on the development Mac (about 25× real time); real footage decodes
  slower.
- **Source checks.** Hash and pathname/descriptor identity checks bracket probe
  and decode, as for frame capture.
- **Timeouts.**
  - Hashing and probing: 2 min.
  - Decode: a further 2 min plus 1.5× the source duration.
  - 120 s without decoded output stops FFmpeg.
- **Frame count.** The decoded frame count must match the probed length within
  3 frames (0.1 s); otherwise the attempt fails with `SCENE_DECODE_INCOMPLETE`.
- **Progress.** Reported at most once per source second, with provisional cuts.
  A cut is reported once a full minimum shot follows it. A throwing progress
  callback stops the attempt.
- **Error codes.**
  - Options: `SCENE_DETECTION_INVALID`.
  - Source: `SCENE_PROFILE_UNSUPPORTED`, `MANAGED_SOURCE_CHANGED` / `_INVALID` /
    `_LIMIT`.
  - Decoding: `SCENE_DECODE_INCOMPLETE`, `SCENE_ATTEMPT_TIMEOUT`,
    `SCENE_FRAMES_INVALID`, `SCENE_FRAME_LIMIT`.
  - Cancellation: `MEDIA_CANCELLED`.
  - Plus the shared media runner's errors.

## Tests

`tests/scene-detection.test.ts`:
- **Synthetic frames:**
  - options and thresholds;
  - hard cuts in both modes;
  - chunking invariance;
  - no cut, slow pan and slow brightening;
  - flashes and lightning;
  - a flash leading into a new shot;
  - minimum shot at the head, at the tail and between cuts;
  - a two-frame transition;
  - adaptive versus fixed under sustained motion;
  - sensitivity;
  - progress;
  - limits and terminal failures.
- **Probe profile:** the decode plan, and parity with frame capture.
- **Real FFmpeg on managed sources:**
  - cut frames at 24, 25, 30 and 60 fps;
  - flashes, slow pan and a cutless source;
  - progress;
  - cancellation, with FFmpeg stopped;
  - changed, misdescribed and unsupported sources failing before the decoder
    starts.
