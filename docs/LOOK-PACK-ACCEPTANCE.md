# Single-Look data pack acceptance — 2026-10-15

Baseline: `16b7b4de75e19e4166742ace52e68357d99eefd1`, isolated
`feat/look-pack` worktree. This is a local engineering increment, not a pushed
release. The [format and user flow](LOOK-PACK-FORMAT.md) describe its narrow
contract: one self-contained `.mioon-look.cube`, no executable plugin loader,
catalog, remote download, preset installation, model or runtime.

## Delivered boundary

- Preview a user-selected file locally, validate the bounded manifest and the
  existing Cube profile, and show publisher/version/source/license as inert,
  explicitly unverified declarations. Structural and hash validity do not
  certify provenance, licensing, colour suitability or creative quality.
- Only explicit acknowledgement and adoption submit the unchanged `lut.import`
  transaction. Store the entire exact original file, including its manifest,
  in the existing project-owned immutable resource. No new database table,
  migration, receipt shape, dependency, lockfile or persistent permission.
- Select and apply the resource through the existing SDR controls. Adoption
  neither applies a Look nor saves a clip. Plain Cube intake remains supported;
  the UI refuses to bypass pack preview through the ordinary Cube input.
- Read saved declarations through bounded, read-only `lut.look.inspect` after
  resource integrity/ownership verification. Existing restored profiles 29/31
  can inspect; they still cannot import. No new embedded-Agent authority.
- Cancel, scope change and stale reads cannot adopt a preview. Once submitted,
  an unknown result belongs to the existing original-request recovery flow,
  never a newly minted automatic retry. Desktop cross-restart same-origin
  recovery remains limited as recorded in issue #2; this slice does not fix it.

## Automated and build evidence

Under Node 24.21.0, final independent focused validation passed **71/71**,
zero failures/cancellations/skips, exit 0 (12,289.51449 ms):

```sh
node --test tests/look-pack.test.mjs tests/look-pack-ui.test.mjs \
  tests/look-pack-inspection.test.mjs tests/look-pack-portability.test.mjs \
  tests/clip-lut-ui.test.mjs
node scripts/tooling.mjs typecheck
node scripts/tooling.mjs build --channel=production
```

Normal typecheck and production build exited 0. `git diff --check` was clean.
The earlier combined 68-test run predates the parser's final three additional
boundary cases; it is not the final count. No full-suite, Mac or Windows claim.
Logs: `evidence/look-pack/parent-tests.log`, `parent-typecheck.log`, `build.log`.

Coverage includes malformed/duplicate/escaped manifest keys, reserved markers,
unknown profile/fields, bounds, exact LF/CRLF body hashing without canonicalizing,
plain Cube compatibility, preview/adopt cancellation and scope races, repeated
adopt prevention, immutable input snapshots, selected-resource response binding,
original-request replay and read-only restored-resource inspection.

`look-pack-portability.test.mjs` independently creates a real synthetic video
and project, imports exact pack bytes, replays the original request without a
duplicate resource, saves a Look, removes the selected source pack, closes and
reopens the store, and runs real FFmpeg. Existing cold backup profile 30 and
restore profile 31 preserve the exact bytes, declarations and rendering. This
is automated business-layer backup/restore evidence, not native backup GUI QA.

Production Linux directory packaging used the already installed pinned Electron
distribution and workspace-owned build caches with `--publish never`. The
normal default-cache attempt failed on a read-only home cache; no dependency or
security setting was changed to resolve it. Pack examples are repository-only
synthetic data and are not in the production bundle. This is modular content
intake, not a claim that the current executable or JS bundle became smaller.

## Actual production Linux GUI

The same final production artifact was used for both native launches:

- Executable SHA-256:
  `24f81f81475856a908ceeda392f0ac366730370ea71bef0fa9fa1de93faf04ac`.
- `app.asar`, 6,226,910 bytes, SHA-256:
  `e9ba9810165a3cf529674f8f037a82e6f3e83d09aa3b5b062c5e5eafad8d2bcc`.

An isolated workspace contained one original synthetic 320×180 Rec.709 video,
a 90-frame 1280×720 timeline and the repository-authored nonlinear test Look.
`tests/look-pack-qa-native.mjs` prepared this fixture and performed read-only
audits; after preparation, all user flow changes were actual native UI input,
not injected RPCs or renderer scripts. No live provider, paid call or deployment.

Observed and audited:

1. Before preview, after preview, and after cancelling preview: **zero LUT
   resources and zero LUT receipts**, original clip unchanged at revision 2.
   The preview showed exact body hash and synthetic license; unchecked copying
   acknowledgement kept adoption disabled.
2. Explicit acknowledgement/adoption created **one resource and one receipt**,
   with all 1,214 original bytes intact, whole-file SHA-256
   `f5f686e07d8c0290c342d47fc5d86a882bcbb1591de28653b740e418d98bdf3c`.
   It did not apply or save the clip. Project-only declaration inspection worked.
3. Separately declared Limited Rec.709 source and creative purpose, applied the
   Look at 65%, saved revision 3, undid to revision 4 with no colour object, then
   redid revision 5 with the exact saved colour object. Original media unchanged.
4. Actual UI timeline preview succeeded. Both project window and launcher were
   normally closed; process exited **0** and backend lock was released.
5. Moved the actual selected source pack out of its selected path into an
   evidence-only filename. The source path stayed absent. Reopened the same
   production app and project, observed the saved 65% Look and re-read its
   declaration from project-owned bytes without selecting or reimporting a file.
6. Actual UI export was created **after source removal** and succeeded. Preview
   and export were each 9,486 bytes, 90 frames, `yuv420p`, bt709 primaries,
   transfer and matrix, Limited range. Both fully decoded with FFmpeg exit 0
   and had identical file SHA-256
   `8e7e2ae929090334fb110d3543654601527b9510ab4aa99e1c1856ab7dc05095`.
   This demonstrates deterministic synthetic continuity, not aesthetic accuracy.
7. Second normal application exit was **0**, lock released. Final read-only
   audit found the same single resource and receipt, exact original BLOB bytes,
   cleared clip draft and unchanged source video.

Evidence: `evidence/look-pack/native/report/summary.json` and
`look-pack-summary.json`; individual `*-audit.json`, `*-launch.json` and
`*-exit.json` files. Native screenshots include `preview-manifest.png`,
`preview-unacknowledged.png`, `adopted.png`, `project-metadata.png`,
`draft-strength.png`, `preview-succeeded.png`, `reopened-look.png`,
`reopened-metadata.png` and `reopened-export-succeeded.png`.

The first shell-sandbox launch could not create Chromium's singleton socket,
and an escalated shell initialization failed before execution. Both were kept
as environment evidence. The supported ordinary desktop Terminal launch then
worked, without sandbox/debug/fuse changes. These failures were not treated as
new product bugs or used to reopen the stopped issue #1 investigation.

## Limits still open

Native Mac/Windows, signed distribution, real licensed artistic presets, HDR /
Log conversion, image-in-SDR timelines and other plugin categories remain
separate increments. There is no automatic download/update/marketplace and no
license authenticity verification. Known issues #1/#2/#3 were not investigated
or claimed fixed. No push, merge, deployment or publication was performed.
