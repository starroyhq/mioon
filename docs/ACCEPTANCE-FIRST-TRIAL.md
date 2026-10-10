# First local trial acceptance

Date: 2026-10-10 UTC. Production baseline: `7b85186`.

## Result and scope

The complete first-use workflow passed in the ordinary sandboxed Linux Electron
development application: fresh project, native image import, typed first-frame
reference, two local mock versions, comparison, fixed-source timeline insertion,
trim, undo/redo, real composition preview, read-only export preflight, actual
FFmpeg export, native Save As, complete quit and a new application lifetime.

This increment changes documentation, one package script alias and a portable
Python acceptance harness. It does not change production source, Node tests,
dependencies, permissions or the built application. The existing independent
full gate remains applicable to the unchanged production/Node-test baseline:
2,341 total / 2,339 passed / 0 failed / 2 skipped, exit 0, 480726.086571 ms.
That gate is not presented as a new aggregate of the documentation increment.

The Python harness `tests/browser_first_trial.py` was syntax/static checked but
**not executed**. Actual UI actions in this run used supported CUA native controls.
The old Python browser suites remain historical evidence, with known selector
and transport assumptions needing refresh. No browser-suite pass is inferred.

## Observed workflow

1. The app opened a fresh isolated private workspace. The project and its single
   shot were created in the UI; no project, asset, job or timeline was seeded.
2. Native Open imported the checked-in synthetic PNG. Its managed hash matched
   the original file: `4d4dfd575ca4c100be7e2338f59dacfcdb5154e14e367b78fca9416fa66c1720`.
3. The image was placed on the canvas and explicitly connected as the shot's
   first-frame reference. One acknowledged durable attachment task and one edge
   were retained. A native drag arranged the image node without changing media.
4. The mock provider produced V1 with prompt `mock v1`. Its actual local MP4
   played in the native renderer and its immutable snapshot retained the reference.
5. Save-and-generate produced V2 with prompt `mock v2`. Both videos appeared in
   the version-comparison UI. The complete V1 database row and media hash survived.
6. The already-selected V1 was added as a fixed 60-frame clip. Return to Source
   highlighted V1. Explicitly selecting V2 afterward left the complete timeline
   database row byte-identical; the clip did not follow the selected shot version.
7. A first real composition preview was rendered. Saving source-in 15 and duration
   45 made it visibly stale. Undo restored 0/60; redo restored 15/45 without an
   additional clip. Five durable local edit identities were applied/acknowledged.
8. A new preview at timeline revision 5 rendered and played. The paused native
   playhead control sought to frame 15. These are fixed 30fps timeline coordinates,
   not a claim about source-native or VFR frame accuracy.
9. Preflight showed the saved 45-frame/1.5-second snapshot as passed. All audited
   domain rows and managed hashes were unchanged by the check; only the two
   preview exports existed. Explicit Confirm Export created one final export.
   Its own Download button opened the native 保存视频 dialog. Explicit Save wrote
   a new MP4, then a separate local probe and full decode verified its bytes.
10. The original native app exited normally (PID 26705, code 0). A separate
    lifetime (PID 27076) reopened the same editing mode, clip, playhead and
    current preview. Discovery showed no pending local edits and the original
    two completed mock jobs. Startup, subsequent UI refresh and final normal exit
    audits retained every inspected domain/task row and all managed hashes.

The startup observation covers this bounded run, not an unlimited future-activity
guarantee. Existing view preferences are separate from the audited domain rows.
The task-recovery fault matrix and unknown-outcome recreation gate are recorded
separately in [Task recovery](TASK-RECOVERY.md).

## Saved output

- Native Save As completed; the downloaded file contains 258,963 bytes.
- SHA-256: `329e1a26eac788c40d362d7fa8ec68517a43b13468ddd278572061e6963f9eb4`.
- That hash equals the final managed export, independently of its chosen filename.
- H.264 video, 720×1280, 30/1 fps, exactly 45 decoded video frames, 1.5 seconds.
- AAC audio stream; the mock source is silent and the compositor supplies silence.
- Full FFmpeg decode exited 0. An external desktop video player was not tested;
  native in-app V1/composition playback and saved-file full decode were tested.

## Evidence and reproducibility

Ignored evidence lives in `evidence/first-trial-native/`: source/build hashes,
read-only SQLite/media audits, owned-process launch/exit records, screenshots,
the saved synthetic MP4, probe/decode output and an independent evidence review.
The launch helper only creates an isolated private userData directory and starts
the existing final bundle; it does not seed business records. The audit opens
SQLite read-only. Generated runtime credentials were not read or entered in UI.

The reused web/desktop build hashes are verified against the preceding fresh
build. All `apps`, `packages` and `scripts` production source stays unchanged.
The portable harness has a separate static-only result and cannot substitute for
the actual native run. A future local run should use a new evidence directory.

CUA capability failures are retained honestly: Electron AT-SPI text entry was
unavailable; supported native key events entered synthetic text. Early chooser
Return actions did not import the file; explicit visible Open succeeded. A seek
attempt while playing did not reach the intended field value; paused explicit
replacement reached frame 15. No product change or security bypass was made to
hide these harness observations. Superseded screenshots are labeled as attempts.

## Remaining delivery boundaries

- These are original synthetic fixtures and local mock jobs. There are no real
  provider calls, user-media uploads or live credentials in this acceptance.
  The mock flag disables live video providers, not arbitrary Agent network access;
  this fresh fixture had no Agent configuration and made no Agent request.
- No packet capture was performed. Database/job evidence is not a blanket proof
  about every host network attempt.
- macOS native startup, tool installation, Keychain, Save As, window/quit behavior
  and packaging remain separate gates. Windows ACL readiness remains blocked.
  This Linux run does not certify either platform or a distributable installer.
- Twelve edit operations have durable UI intent recovery. Eight other local
  edits and render submission intents retain their documented session limits.
- The 4,096 retained-task identity cap and future compaction requirement remain.
- Provider/model/region readiness and future paid-call approval are documented
  separately; documentation and this mock run grant no paid-call authority.

See [first-use guide](WORKSPACE-GUIDE.zh-CN.md), [Mac source trial](MAC-SOURCE-TRIAL.zh-CN.md),
[provider readiness](PROVIDER-TRIAL-READINESS.zh-CN.md) and
[future live verification approval](LIVE-VERIFICATION-APPROVAL.zh-CN.md).
