# Mixed SDR images acceptance

Baseline: local Look-pack checkpoint `53c42fa620742ae0730d9ddc9d4a9ca33951c57a`,
isolated branch `feat/mixed-sdr-images`. No commit, push or publication yet.

The [profile](MIXED-SDR-IMAGES.md) records the narrow PNG-only contract and limits.
Numerical correctness, durable business lifecycle, native UI and cross-platform
acceptance are distinct; a passed automated test is not a native UI claim.

Status on 2026-10-15 UTC: automated acceptance, production build and the bounded
final-package **Linux native UI workflow passed**. This is not a released feature
or a native macOS/Windows acceptance claim. A separate post-restore service
rerender regression also passed; restored GUI rerender was not run.

## Final candidate identity

Product source is frozen in `evidence/mixed-images/product-source-final.sha256`:
568 files under `apps/` and `packages/`, manifest SHA-256
`3595ff930dfb34dc0d9d4ddf3022dd84cc749b69c3fcc978008215588e61b53d`.
Both the implementer and independent parent verified every entry. Earlier
`product-source.sha256`, build and test evidence is supporting, not this final
candidate.

Production artifacts are recorded in `evidence/mixed-images/production-artifact.sha256`:

- `release/desktop/production/linux-unpacked/mioon`:
  `24f81f81475856a908ceeda392f0ac366730370ea71bef0fa9fa1de93faf04ac`.
- `release/desktop/production/linux-unpacked/resources/app.asar`:
  `a27420f3f43b86741c33b6d4f1affde2f2d89c9101eabc416f0849d72a54ad97`.

The final build used `node scripts/tooling.mjs build --channel=production`.
Directory packaging used the repository's existing electron-builder and installed
Electron, `--linux --dir --publish never`, with no dependency, runtime, sandbox
or fuse changes. Both exited 0; logs are `build-final.log` and `package-final.log`
under `evidence/mixed-images/`.

## Automated acceptance

The independent final focused run passed **563/563**, with zero failures,
skips or cancellations, in 136.59 seconds. Its normal full typecheck exited 0.
Logs: `parent-final-focused.log` and `parent-final-typecheck.log`.

Implementer final lanes also passed:

- Image admission, aggregate budget, business lifecycle, contracts, filter,
  renderer, source identity, transports and schema 32/33: **173/173**, 89.51 seconds;
  `images-final-tests.log`.
- Loudness transactions/apply contracts/business/state plus image contracts:
  **112/112**, 58.11 seconds; `loudness-budget-regression.log`.
- Existing clip colour UI and image transport guards: **37/37**, 7.06 seconds;
  `ui-transports-final.log`.
- Dedicated managed PNG input concurrency: **9/9**, 10.8 seconds;
  `tests/timeline-image-concurrency.test.mjs`, SHA-256
  `67f208815687bc73264aaba62e8c3ec04e8c62a6ceca22ef93b562d464c875d4`.
- Full typecheck: exit 0; `typecheck-final.log`.

These lanes overlap; their counts must not be added as independent coverage.
The independent parent separately passed the late-added concurrency lane
**9/9**, exit 0 in 12.36 seconds, rather than assuming it was included in the
earlier glob. Log: `parent-concurrency.log`.

Boundary regressions retain the historical 262,144-byte timeline ceiling. A
mixed-image edit is rejected before writes with an operation/project/request-bound
not-applied proof. Exact-limit, revision-width and timestamp growth, undo/redo,
replay, rollback, reopen and cold restore are covered. Loudness preserves its
existing `TIMELINE_LOUDNESS_APPLY_UNSAFE` vocabulary. Schema roles 24–31 do not
retroactively admit the new image budget error or image/render branches.

Concurrency tests inspect actual FFmpeg arguments: twelve sequential PNG clips
produce twelve segments with one PNG input each, while two visible PNGs plus a
hidden PNG open exactly two. They also cover third-input rejection, same-asset
clips, end-exclusive boundaries, selected-range bypass rejection, preflight before
probes/writes and restored 33 export/receipt validation. Existing legacy/video
paths keep their historical limits.

## Numerical and resource evidence

The independent display-referred reference proof passed **18/18** on the parent
rerun. It establishes the sRGB EOTF followed by relative zero-black gamma 2.4
reference transform, not application or monitor acceptance. The implementation's
fixed table identity and alpha behavior are independently tested. The earlier
BT.709 source-OETF experiment is not the normal sRGB image default.

`evidence/mixed-images/performance/summary.json` and its README retain both success
and failure evidence. Twelve sequential 1920×1080 source derives with a 65³ Cube
passed at a maximum 270.51 MiB RSS and 2.271 seconds per child. Two simultaneous
720p derived image inputs passed at 202.06 MiB RSS. A twelve-input diagnostic
exceeded a 512 MiB RSS watchdog under a separate 2 GiB virtual-address cap;
the exact child was killed and joined and partial output rejected. Earlier
1 GiB virtual-address thread-stack failures are not physical-memory proofs.
Owned temporary staging was cleaned only after exact child joins.

These are bounded, short Linux diagnostics on the preceding source freeze,
not endurance, platform-wide or final native claims. The final change adds the
conservative two-open-PNG segment guard, not a resource-limit increase or a
new renderer optimization. The first slice retains the measured 2,073,600-pixel
source ceiling and explicitly rejects unsupported source metadata.

## Native workflow acceptance

The native QA helper `tests/timeline-image-qa-native.mjs` is frozen at SHA-256
`b84ce66d68d11b4593d208d2c673a60f818fc1c4d4cc91daaced3f483b095252`.
The fixture combines an untagged RGBA PNG, explicitly declared Rec.709 video
and a timed subtitle. The final packaged app was launched normally through the
supported native desktop, with no injected RPC, debug, sandbox or fuse changes.
All three launches used the exact frozen artifacts and exited normally with code
0 and backend locks released.

The final verifier exited 0. Its primary report is
`evidence/mixed-images/native/report/summary.json`, with actual UI observations,
screenshots and separate read-only storage/media audits:

- Inspection did not adopt or save image colour at revision 5.
- Explicit sRGB declaration and Save Clip produced revision 6 and a durable,
  acknowledged edit task with exact source evidence and `look: null`.
- Undo at revision 7 removed the declaration; redo at revision 8 restored it exactly.
- Actual native timeline preview and full export both succeeded.
- Source replacement at revision 9 retained the colour profile with `source: null`
  and displayed the invalidation warning. Undo at revision 10 restored the source
  and exact declaration.
- Original normal reopen retained revision 10 and had no stale draft.
- Offline cold create/verify/restore captured schema 32 into schema 33 without
  changing original database/media or backup bytes. Immediate original cells,
  captured history and held rows were checked exactly.
- Restored normal GUI reopen retained the image/video declarations and subtitle
  timeline and displayed read-only colour controls. Captured rows and original
  source bytes remained exact after closing. **This is a restored GUI inspection,
  not a restored GUI rerender.**

Useful screenshots in the same report directory are `01-inspect-untagged.png`,
`02-saved-srgb.png`, `05-preview.png`, `06-export.png`,
`07-replaced-invalid.png`, `09-reopen.png` and
`11-restored-image-declaration.png`. Fixture imports and the video declaration
were prepared before launch; the image adoption and all listed editing/rendering
actions were performed through the UI. No live provider was involved.

Both native outputs fully decode as 90 frames, 1280×720, 30 fps, yuv420p,
Rec.709 limited. Their 13,141-byte MP4 files are byte-identical at SHA-256
`e228da8d43c024d983524acec7a69419bd042d253ebcbdf04410bdc9db7e054d`.
The helper independently verifies frames 0 and 45: alpha-zero and background
pixels are both `[21,191,86]`, semitransparent gray is `[78,163,112]`, and subtitle
white-pixel counts are `[0,993]`. These checks distinguish hidden RGB, the relative
display transform and subtitle timing rather than only checking file existence.

A separate bounded, read-only full-sequence check compares every decoded RGB24
frame, not just those samples: all 90 frames and 248,832,000 decoded bytes per
output match. The canonical frame-row SHA-256 is
`880ec6ad67df149a4099a3331e1c5372c188c6f7f2bec0a9dab66bf149d3eaf0`.
Evidence is `full-sequence-parity.json`, `preview-all90-rgb.framehash` and
`export-all90-rgb.framehash` in the native report directory. This hashes decoded
frame data without retaining a 249 MB raw-video buffer or modifying the outputs.

## Separate post-restore service rerender

`tests/timeline-image-restored-render.test.mjs` passed **1/1**, exit 0 in
48.41 seconds, with test-file SHA-256
`53291ea636d1f2286cd652792b983070ce67f87a8f4aea2ddbf322fefcdb7259`.
This runs real production services and the local render worker in a separate
disposable workspace. It renders ordinarily, closes the store, genuinely creates
and verifies a cold backup, restores 32 → 33, then submits a fresh correct-origin
render. Missing/wrong restore origins reject without a receipt; a captured queued
export remains held and never resumes. Exact original rows/source bytes survive,
and restored schema validation passes before/after rendering and cold reopen.

The six 720×720 decoded RGB frames match exactly, including transparent/gray image
pixels and subtitle presence only on frames 2–3: 9,331,200 bytes, SHA-256
`288837fe28c048d5a78d90188b2ccfd293c3935a457e057797d6c9b81d76d7be`.
Both MP4s also share SHA-256
`90e8020c32877fda8f8eaa1caff6e8e97d2aed411878abc93829b8166237d4bc`.
This supplements, and must not be relabeled as, restored native GUI rerender.

## Remaining scope and known issues

JPEG, ICC/P3, HDR/Log, linear-light composition and native macOS/Windows are
deferred. This is deliberately the smallest useful static RGB8/RGBA8 PNG slice.
There is no new provider call, arbitrary script engine, ICC dependency, runtime
bundle or persistent proxy cache. Existing Look-pack/Cube semantics remain intact.

Issues #1 (stopped source-runtime investigation), #2 (cross-restart intake
recovery) and #3 (unknown packaged exit) remain open and are not fixed by this
increment. No commit, push, merge or publication is implied by these results.
