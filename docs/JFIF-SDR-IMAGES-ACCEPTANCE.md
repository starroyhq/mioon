# Restricted JFIF JPEG acceptance

Scope: synthetic local Linux x64 evidence for the closed subset documented in
`JFIF-SDR-IMAGES.md`. This is not general JPEG/EXIF/ICC/P3/Log/HDR support, not
macOS or Windows acceptance, and not a fix for existing issues #1, #2 or #3.
No source CLI-startup suites, live provider or paid network calls were used.

## Source and build identity

Base: `93a0575d3ac8558265ccbeb1a7bfb3cdcc46c1e8` (accepted PNG increment).
Frozen product source manifest: `evidence/jfif-images/product-source-freeze.json`.
Its `files` map lists 601 application/package/script source files and SHA-256s.
The product identity is SHA-256 of sorted `SHA256 + two spaces + path + newline`:
`6f283c57768d60f041f7fc7ea313078e93f46bf7a52fec9b5ecc6c4eb9a95aaa`.
The JSON file itself has SHA-256
`53e3ae2cee132cad8b74bbc146183de337e8d584218d3d9029b207ebfb812b51`.
Tests, documentation and evidence are outside that product identity.

Strict TypeScript and the normal production build passed. Production packaging
used the existing installed Electron 44.7.0 distribution, with normal production
fuses, ASAR integrity and sandbox behavior unchanged. No dependency was added and
no lockfile changed. The first packaging attempt encountered a read-only default
cache; the supported local distribution/cache configuration completed instead.

- Native executable SHA-256: `24f81f81475856a908ceeda392f0ac366730370ea71bef0fa9fa1de93faf04ac`
- app.asar SHA-256: `a7f3a8b3f3112807dc10954eb9a1a10fea88be3716444587a0f65a6d1fd9b679`
- Backend bundle SHA-256: `41426c8baf5656bd18a51d0c5b260195cde3880ac7b13f6625457db672bffe69`

## Focused backend and contract evidence

The final focused JPEG run passes **191/191** (Node 24.19). It includes strict
admission, real source inspection and decoder validation, save/replay/replacement
and undo, authenticated HTTP, CLI, official MCP stdio, UI state, schema 34/35,
restore rollback/corruption and historical closed-role tests.

A separate parent review rerun at the earlier freeze passes **251/251**, including the focused JPEG
suite, new contracts/concurrency and essential real restore/resource/budget
boundaries. It independently verified the 601 product-source hashes and passed
strict TypeScript. Its log is `evidence/jfif-images/parent-focused.log`.

Additional suites pass:

- **5/5** JPEG metadata-probe regression: exact 2592-byte native fixture, old
  autodetection failure, strict-prepared `jpeg_pipe` success, rejection before
  effects, and unchanged generic PNG/video argv.
- **21/21** affected source/decode/media/cold-restore checks pass after the
  metadata-probe correction, with identical decoded RGB and MP4 hashes.
- **9/9** JPEG contracts: strict fields, explicit declaration, v3/v2/v1 routing,
  copied frozen evidence and rejection of changed decoder/alpha/transfer policy.
- **6/6** combined concurrency: actual PNG+JPEG render, third-image denial before
  effects, hidden sources that do not even exist on disk, and six nonoverlapping
  alternating inputs. The cap is two combined image inputs, never two per format.
- **34/34** historical PNG budget/concurrency and genuine cold 32→33 rerender.
- **123/123** prior video/PNG source, contracts, business, transport, filter,
  media and existing clip UI tests.
- **281/281** historical workspace dispatch/schema/migration and video rendering
  regressions, including the explicitly preserved schema 32→33 worker fixture.
- **92/92** Cube/Look resources, manifest inspection, UI and portability. Both
  old 32→33 and new 34→35 retain original bytes, import receipts, read policy and
  Look inspection; restore does not grant new resource import authority.

Historical tests which specifically target generation 32/33 explicitly construct
that marker-only fixture rather than silently expecting the new default workspace
to remain 32. Historical schema constructors and PNG parser/filter source bytes
are unchanged. JPEG timeout fault injection verifies the termination-unconfirmed
flag, single-flight permit and actual-child join, including drain begun before
that join is installed.

## Independent numerical checks

All 4:4:4, 4:2:2 and 4:2:0 fixtures run through the actual fixed RGB24 decoder
using system FFmpeg/ffprobe 7.1.5-0+deb13u1 (Debian Linux x64).
Transfer oracle comparisons start from those decoded samples, not the uncompressed
fixture. Float transform maximum error is below `1.5e-7`; staged RGB8 differs by
at most one quantization code, and JPEG opaque alpha is exactly 255.

The independent 4:4:4 Y/Cb/Cr-to-RGB oracle agrees with full-range BT.601 within
2 codes. Substituting BT.709 is detectably wrong by at least 10 codes. Actual
fixture decoded RGB hashes are:

- 444: `d13115f31b354670daa00ea7b6f98b94f730172289fd7ac342bb5083f47b38dd`
- 422: `ea08092c0fe8dd9f5c2a1fd9f8ac223828d24b77bfeb8629f0bec0203faf6488`
- 420: `5c7150c288895e5dde3334e58ad899eed9795757aae5c469cf7040cd4fc3c759`

The deliberately high-frequency RGB fixture has JPEG codec/chroma loss relative
to its original pixels: maximum/mean errors 22/4.7903, 154/26.1961 and 179/35.6380
respectively. Those are separately reported codec errors, not transfer errors.
These observed hashes are Linux FFmpeg-build evidence, not a promise that an
unvalidated future/platform decoder version is numerically identical.

The sRGB display table remains exactly 14,738 bytes, SHA-256
`383f159aebd6758ead128a3f1291ec70275bbd6bf60aef603e17d2d3726c303c`.
128/255 maps to 0.527924914041446 before quantization. The ordinary PNG alpha graph,
encoded RGB compositor, video-v1 path and output delivery remain unchanged.

## Genuine cold 34→35 mixed rerender

`tests/timeline-jpeg-restored-render.test.mjs` runs the real local service and
worker, captures a cold schema 34 backup, restores 35, and explicitly acknowledges
a fresh origin-bound export. Its timeline combines video, JPEG, half-alpha PNG
and a two-frame subtitle. Retained LUT reads work; new source inspections remain
unavailable. A captured queued export remains held and never resumes implicitly.
Original source files, receipts, history and backup SQLite bytes remain exact.

Six 720×720 frames decode identically before and after restore:

- RGB bytes: 9,331,200; SHA-256 `deec7dffb81343b299d3f0052595070a38bf9dc1410d9860885d103af011e4ce`
- Ordinary and restored MP4 SHA-256: `7895f1595f46142a45868df55b47de4c2aa154f15fe93412f44768cfbb031809`

Pixels verify transformed JPEG gray, transparent contain padding, PNG blending
and subtitle timing. Output tags are Rec.709 limited-range yuv420p. The equivalent
historical PNG-only cold 32→33 regression still produces RGB SHA-256
`288837fe28c048d5a78d90188b2ccfd293c3935a457e057797d6c9b81d76d7be`.

## Native metadata-probe correction

The first native preview exposed a real gap missed by tiny fixtures: a valid
320×180 JFIF autodetected as `image2`, which the generic metadata-probe whitelist
correctly refused. Exact isolated replay reproduced that stderr after successful
hash verification, strict JPEG admission and RGB24 decode. No live render was
blindly retried. The failed native workspace, screenshot, snapshot and old package
were retained separately.

The narrow fix forces only `jpeg_pipe` metadata probing after successful managed
JFIF verification. It does not globally admit `image2`, modify the pixel decoder,
change protocol restrictions or alter PNG/video probing. New regressions prove
both the old failure and the fixed path, including rejection before effects. The
exact isolated native snapshot now renders all 90 frames at 1280×720, SHA-256
`8517f26e750a37f00bc517be17380d06485b6f1b1821969fe7c21c5fe1bfa2f9`.
The product and test manifests were refrozen and production artifacts rebuilt
before final native reacceptance. The parent independently reran the final
affected lane: **26/26** passed in 94.50 seconds, normal strict TypeScript passed,
and all 601 refrozen source hashes matched. See `parent-probe-fixed.log` and
`parent-probe-fixed-typecheck.log` under `evidence/jfif-images/`.

## Native UI acceptance

Final production native acceptance passed on Linux x64. The unchanged dedicated
helper `tests/timeline-jpeg-qa-native.mjs` completed with exit 0 and empty stderr.
Its SHA-256 is `ebedb3ee7684d0213d22e2fbcb293059ea6040e74fd44b2d77ed3ea3c4f21960`.
The final report is `evidence/jfif-images/native/report/summary.json`, SHA-256
`188a30e5ef1d360c62ffbe0a573d6c52ab28749310fc2f51e7c45b21ad432955`.

All 10 required native actions have actual screenshots: inspect the untagged JFIF,
explicitly declare and Save, Undo, Redo, preview, export, replace the source and
observe invalidation, Undo replacement, ordinary cold reopen, and restored cold
reopen. Post-preparation product edits came only from supported native input.
SQLite checks were read-only; cold backup/restore used the public offline CLI.
Inspection and staged declaration left revision 7 unchanged; Save/Undo/Redo used
revisions 8/9/10, replacement/Undo 11/12. The final saved timeline and original
source files remained exact through ordinary reopen and schema 34→35 restoration.
The restored view did not perform new source inspections or edits.

Preview and export each contain 90 frames at 1280×720/30fps, Rec.709 limited-range
yuv420p. Both full decode checks pass; both MP4s are 12,687 bytes with identical
SHA-256 `8517f26e750a37f00bc517be17380d06485b6f1b1821969fe7c21c5fe1bfa2f9`.
Sampled frames 0/45 produce 5,529,600 RGB bytes, identically hashed
`f5387a0ac1c6ee8d7a61536bf7f11a596aa2cd85714e9be589473ed4b217047c`.

- JPEG decoded gray 128 is display-transformed to theoretical code 135; delivery
  round-trip measures 134 in every channel, within the stated quantization bound.
- Transparent contain padding equals the tagged green video exactly: 21/191/86.
- PNG alpha 0 leaves JPEG gray 134 unchanged; half-alpha gray measures 165 versus
  independent expected 165.117647. Hidden magenta does not leak.
- Subtitle white-pixel counts are 0 outside its interval and 868 inside it.

All three native launches closed normally (exit 0, no signal), released backend
locks and used the same frozen executable, ASAR, bundles and helper. Captured
restored original rows, history/archive, restore metadata/evidence and source
hashes are exact. No sandbox/fuse/debugging changes were made. The initial
executor-sandbox socket failure was avoided through supported native keyboard
launch, not by disabling application security.

Earlier failed preparation and the explicitly incomplete pre-fix native attempt
remain separately preserved; neither is represented as a success. Native
restored reopening is a read-only durability proof. Actual restored re-rendering
is proved separately by the cold backend/worker test above. macOS/Windows,
OS-wide network tracing and live providers remain unverified.
