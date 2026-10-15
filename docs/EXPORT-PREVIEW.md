# Sample export preview: bounded first increment

This increment adds a **real sample export**, not a live final-quality preview or
an upgrade to the editing preview. It uses the current per-export settings and
its own explicit half-open range of 1–300 frames (at 30 fps, at most 10 seconds).
The sample range is separate from the final export range. A convenience action
uses the current selected range or playhead, capped at 300 frames; both endpoints
remain editable. Changes never write global settings or the saved timeline.

## Workflow and safety boundaries

1. Open Delivery, choose the current export settings, then select a short sample
   range or enter its start/end frames.
2. Run the sample's own capability/source check. Blocking errors, incomplete
   checks and stale observations remain visible. An unchecked sample cannot be
   submitted; incomplete checks permit only their explicit checked binding.
3. Generate the sample. The normal durable local-delivery intent and immutable
   `timeline.render` receipt own this request, with `purpose: 'export'` and the
   exact checked range/settings. There is no parallel raw-RPC submission path.
4. The dedicated player follows only this exact request/export/output asset.
   Settings, sample range, saved timeline, workspace or referenced source changes
   remove playback and mark the result stale. Late or duplicate observations
   cannot substitute a different export. No automatic playback or retry occurs.

Closing the player or leaving the panel **does not cancel** the export. There is
no cancellation RPC. A real file and export-history record remain; reopening a
project does not silently restore the preview selection or start playback.
Unknown submissions must be reconciled as the original request in the existing
task/recovery interface. Short samples may still require expensive full-source
checks or preroll; the 10-second cap is an output cap, not a latency promise.

The exact output route uses a strict `preview=1` and `exportId` query with a
managed asset ID. It verifies export/asset/project ownership, immutable receipt,
published-path provenance and a late open-file ownership fence. It supports
HTTP Range and never weakens named-download query validation. Stale, disconnected,
held or malformed results do not obtain a playable URL.

Sample playback revokes timeline sound and pauses native source/editor playback.
Starting timeline sound or a source/editor player pauses the sample. Hidden,
closed, detached, background and unmounted players reject late play events.
Selected-range outputs no longer replace the full timeline's editing preview.

All added labels and safety messages are available in Simplified Chinese,
region-neutral Traditional Chinese, English and Japanese.

## Acceptance boundary (2026-10-15)

Base: `41f09c3dbb7fa6f05175651af8aff24d0598ea30`. This is an isolated local
feature checkpoint, not a Mac/Windows release or proof that all earlier WIP
features have passed their outstanding gates. No user profile, provider account,
public issue or remote branch is modified by this work.

- Pinned Node 24.21.0; existing lockfile dependencies only. Typecheck and local
  development web/desktop build passed. Existing third-party `use client`, source
  map and bundle-size warnings remain; these are not native acceptance.
- Independent review reran 18 state, App seam, component and route tests with no
  failures. The component lifecycle harness uses mocked React hooks, not real
  DOM/media playback.
- Genuine synthetic-media acceptance used a generated PNG plus a 440 Hz WAV,
  real HTTP services, worker and FFmpeg. A sample of frames 30–90 produced 60
  frames; the separate whole export produced 120 frames. Both were H.264,
  360×640, 30 fps, with 48 kHz stereo AAC. Exact receipt replay, distinct export
  and asset identities, HTTP 200/206 byte checks and full FFmpeg decode passed.
  The saved timeline remained byte-equivalent. This proves real artifacts and
  route behavior, not perceptual playback or GUI acceptance.
- An initial broader run had 475 tests: 455 passed, 20 failed. Nineteen failures
  were stale extraction/localization fixtures (new reciprocal player callback,
  changed JSX attribute order, and pre-i18n `rev 8`/`rev 2` expectations); these fixtures
  were corrected without weakening their assertions. The remaining existing
  cold-backup test expects restored schema 27 while the unified base produces 35.
  That separate historical test was left unchanged and is not counted as passed.
- Final affected-suite rerun: **475/475 passed**, 0 failed, 0 skipped, across
  32 test files, including genuine-media acceptance and the corrected fixtures.
  The known cold-backup case is excluded, not silently counted as passing.
  This is one run, not a sum of repeated test results. A successful unit test
  or build must never be reported as GUI playback proof.

No HDR/Log/P3/RAW correctness, full-film live preview, perceptual colour matching,
AAC loudness guarantee, export cancellation, or platform release readiness is
claimed by this increment.

### Native development-build attempt

A separately isolated fresh development profile was launched with the exact
hash-checked artifact (`app.starroy.mioon.dev`). The native window displayed the
empty Project Home and opened the create-project form. Text entry failed because
its AT-SPI provider was unavailable; a supported text-entry fallback failed with
the same error. No project or import was created, no export was started, and no
player behavior was observed. The attempt stopped without changing accessibility,
sandbox or browser-debugging flags, or relaunching.

Normal Quit returned exit code 0 and removed the profile's connection file. No
media job was started. Backend-process absence was not independently checked;
launcher exit alone is not claimed as proof of all child-process cleanup.

Consequently, actual GUI sample playback, visible stale/close behavior and mutual
audio exclusion remain unaccepted in this environment. The automated lifecycle
and integration checks cover these contracts but are not substitutes for native
playback. A production-channel build and platform acceptance are still required
before any production-release claim.

### Reproducible identity

`EXPORT-PREVIEW-IDENTITY.json` records the unified base, changed production-source
hashes, development artifact hashes and runtime hashes without local profile
paths or credentials. The source identity is
`04f2b56b5decf96bf8b65d0388850a9bf20de313dfcf8f8bcdfcc9ccd508d637`.
No production source changed after that final development build; subsequent
changes were acceptance documentation and localized test-fixture maintenance.
