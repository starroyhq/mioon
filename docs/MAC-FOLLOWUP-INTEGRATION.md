# Mac follow-up integration — 2026-10-11

Baseline: `03bfc9969f47cebcdad4f154cad2e4f313a10aed`. This checkpoint integrates four independently developed Mac lanes; it does not establish native macOS/Windows acceptance. The discovered storyboard stream-selection blocker has been repaired and reverified below. The parent full-suite release gate passed on this final combined source: 3,211 total / 3,209 passed / 0 failed / 2 skipped, exit 0 (532,741.196656 ms).

## Delivered scope

- Tooling resolves the real script entry identity, so a directory alias or script symlink still executes command validation instead of silently exiting successfully. Normal Node module resolution is covered; `--preserve-symlinks-main` is not a delivered mode.
- The shared external client retains the exact nested request key for uncertain `image.review.prepare` acknowledgements and limits write-recovery guidance to explicit keyed mutations. Read-only `image.request.get` errors no longer imply a write occurred. No automatic retry, replacement request key, permission expansion or successful-response change is introduced.
- The executable Mock Skill records complete request inputs and fresh stable keys for `shot.create`, `node.create`, and `version.select` before dispatch. Project creation and asset import remain outside that keyed guarantee. A failed workflow stops; its working directory is not automatically resumed or rerun.
- Six real-process exit boundaries exercise the existing edit-task journal and exact-key recovery. The tests own all 23 child handles and await their cleanup; production recovery and schema are unchanged.
- Media probing skips absent, empty, or `unknown` codec descriptors and continues to later identified streams. Timeline preparation/rendering and the corrected storyboard stitch path use those explicit selected indices. An unknown-only source is blocked; unknown optional audio may be omitted. An identified codec is not a full-decoding guarantee, and preflight continues to report `fullDecode: false`.

## Verification in the restored Linux cloud environment

All incoming changes matched the source hashes of the five received patches across the four development lanes. An independent read-only review found no blocker in the initial 16-file integration; the two-file storyboard repair also received an independent Mac review and cloud source review.

- Independent parent full suite: **3,211 total / 3,209 passed / 0 failed / 2 skipped**, 532.741 s, exit 0. The actual terminal result was confirmed on 2026-10-11; the original full log is retained in the delivery evidence.
- CLI/MCP/client/tooling affected checks: **279 total / 277 passed / 0 failed / 2 skipped**, 22.737 s.
- Skill Python checks: **3/3 passed**.
- Process-recovery/media/preflight/export/fade/replacement/split/waveform checks: **181/181 passed**, 90.152 s. The three earlier Mac environment failures (libwebp and temporary-path fixtures) are preserved as historical results; Linux success does not convert them into Mac passes.
- Final storyboard/media/preflight/shutdown regression checks: **79/79 passed**, 50.095 s, after the repair.
- Fresh Web + Electron build passed. All 49 artifacts except `backend.cjs` match the preceding `03bfc996` build byte-for-byte; the final backend SHA-256 is `3ba70833e61c361b68b7f0777973e4fc4ef062a5f10c7ee688a5cc9934355c5f`.
- Actual CLI Skill workflow completed all 15 steps through the real local backend, Mock generation and FFmpeg. Six distinct keyed inputs were recorded. Its final MP4 fully decodes, contains 60 frames at 30 fps, and lasts 2 seconds.
- Actual Linux Electron acceptance used the unmodified final backend and synthetic media with unidentified first streams and valid later blue H.264 / 880 Hz AAC streams. Timeline preview, saved-revision preflight and explicit final export succeeded. Final output: 30 frames, 720×1280, 30 fps, 1 second; center RGB `[0,0,254]`; measured 880 Hz amplitude 0.12494 versus 440 Hz 0.00000768. Full decode passed and source SHA-256 remained unchanged. Normal application exit returned code 0.
- The output export SHA-256 is `a912b037e3de5f9ca80d981ac8ec068c9c632af40ebaab50ba9a40d209318e70` (20,786 bytes). Audio was verified by decoding/signal analysis, not a claim of audible desktop playback.

Acceptance-harness failures are retained separately: strict test selection rejected nonexistent filenames and then a space-separated option spelling before any tests; the initial Skill invocation used the wrong environment variable and failed its first capabilities read before mutations. Corrected runs used documented filenames/options and `MIOON_BASE_URL`. Storyboard fixture preparation checked workspace-wide Mock counts as if they were project-local and reported failure after successful publication. A read-only reconciliation proved exactly one successful job/version in that project; generation was not repeated. None required a product change.

## Storyboard blocker and closure

The original integration expanded the accepted media domain while legacy `stitch()` still chose the first video/audio type. A synthetic three-stream reproduction passed the worker's default full decode. Replaying its raw probe result through the exact `03bfc996` parser selected unknown video0 at32×32, causing the non-Mock9:16 publication gate to reject `OUTPUT_ASPECT_RATIO_MISMATCH`. The candidate selected H.264 video1 at72×128 and passed, but old stitch failed `MEDIA_EXIT_FAILED`. This was treated as a release blocker, not deferred as documentation.

The repair maps the shared probe's exact video/audio indices, keeps ordinary silent-video synthesis, ignores attached covers as visual sources, and rejects inputs with no selected video before FFmpeg. No worker retries, permission changes or original-file rewrites were added.

The new real-worker regression simulates only download bytes at the trusted Mock adapter boundary: actual submission, polling, download validation, immutable version publication, automatic initial selection and storyboard export run through existing business services. It verifies one submission/download, blue pixels/880Hz, full decode, and unchanged historical asset/version records/hashes. The 79-case cloud regression includes it and ordinary audio, silent video and cover cases.

Final native acceptance used the rebuilt unmodified backend: an already published synthetic selected version was exported by clicking “导出分镜”. The completed output has30frames,720×1280,30fps,1s, H.264/AAC; RGB[0,0,254],880Hz amplitude0.12473. SHA-256`e0cbb2a9dae08c69f7d82dc02f83858a8ca4254caa33f8b89abce921668dd3a5`,21,113bytes. Then the native timeline route was rerun; its newly created export is byte-identical to the earlier20,786-byte timeline output. Published source/shot/version records remained unchanged, and final normal exit returned0. Screenshots06–10 use the final backend;01–05 retain the superseded pre-stitch stage. These are Linux/synthetic results, not live-provider or macOS/Windows evidence.

## Evidence and release

The local `evidence/mac-followup-integration/` report retains source/build hashes, original and corrected logs, independent review, native screenshots and decoded synthetic outputs. The delivery archive is allowlisted: runtime databases, tokens, settings, browser profiles and connection files are excluded. A Library copy is required before considering this evidence persistently delivered; its confirmed ID is recorded in the final handoff. Old evidence lost with the earlier environment remains lost, as recorded in [FLOW-RECOVERY.md](FLOW-RECOVERY.md); historical pass counts are not fresh reruns.

No schema migration, live provider call, real credential entry or platform readiness claim is part of this checkpoint. The separate source-frame worktree is unmerged and excluded from this release gate.
