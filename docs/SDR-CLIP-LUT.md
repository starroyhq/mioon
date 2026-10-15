# SDR clip LUT: explicit colour-managed editing

This slice implements a deliberately restricted Rec.709 SDR creative-look workflow. It is not Log conversion, HDR tone mapping, HDR output, RAW support or image/ICC colour management. Its status and acceptance evidence are recorded separately from the earlier unresolved source-runtime/CLI issue.

## User flow

1. Select a video clip and open **Rec.709 SDR · 创意 LUT** in the common clip inspector.
2. Inspect the source, explicitly select its known limited/full range, and declare that it is Rec.709 SDR. Missing tags are not automatically assumed to be SDR. Known conflicting tags are rejected.
3. Import a `.cube` file into the current project, or select an existing project resource. Importing a resource does **not** apply it to a clip or save the clip.
4. Declare that the selected LUT is a Rec.709 SDR → Rec.709 SDR creative look, not a technical Log/HDR conversion. Add it to the clip draft, set strength/enabled state, then use the existing **保存片段** action.
5. Render the timeline preview or export. The source player remains explicitly ungraded. There is no live GPU preview disguised as the final effect.

The common clip save retains CAS revision checks, stable request identity, durable clip drafts, history and undo/redo. Splitting copies the complete colour intent. Replacing a source preserves the independently chosen look and strength but sets the source interpretation to `null`; managed rendering remains blocked until reconfirmation. Undo restores the previous source and interpretation together.

## Pending import recovery boundary

Before dispatching an import, the UI reserves at most 2 KiB of canonical v1 recovery metadata under the verified workspace fingerprint and project. It stores the original request ID and exact filename, byte count and SHA, not Cube bytes, source paths, credentials or clip settings. Failures, corrupt records, conflicts or full capacity block new imports rather than inventing a new key.

Desktop recovery uses a dedicated private `userData/lut-import-pending-v1.json` store, separate from app preferences and workspace SQLite. Its maximum is 128 unresolved project/workspace records and 264 KiB overall, with no automatic eviction. A fixed preload bridge offers only read/reserve/verify/complete. The main process serializes compare-and-set access under the existing single-instance app lock, verifies the current owned editor main-frame/project, and independently derives the exact existing build-channel/canonical-root/directory-and-database fingerprint from trusted configuration. It rechecks document, backend and workspace authority before publication and after access; other-workspace hints are not returned. Private atomic publication rejects unsafe permissions, symlinks, hard links, changed directories/files and corrupt/noncanonical contents. This is the existing POSIX other-account boundary, not protection against root or a hostile same-account filesystem racer, encryption, or a power-loss guarantee.

This metadata survives ordinary full desktop app restart despite changed ephemeral localhost ports and nonpersistent Electron partitions. There is no migration from historical browser storage. Missing or failed desktop bridges fail closed rather than silently falling back to browser storage. Browser-only usage is unchanged: same-origin localStorage and Web Locks are required, and clearing browser data or changing the site address loses those browser hints.

After reopening, the user reselects the exact filename/size/SHA file and explicitly retries its original request ID. Opening, rechecking and reselection only read recovery state: they do not import, apply, save or automatically retry. The backend receipt remains authoritative. Removing local app data loses hints; replacing or switching a workspace cannot reuse another workspace's identity. [Issue #2](https://github.com/starroyhq/mioon/issues/2) tracks the desktop restart acceptance gate; implementation is not a claim of native acceptance on untested platforms.

## Versioned scope, not a permanent SDR-only data model

- Clip profile: `mioon-rec709-sdr-clip-v1`.
- Input interpretation profile: `rec709-yuv-sdr-v1`.
- Frozen render profile: `mioon-rec709-sdr-render-v1`.
- Composition profile: `rec709-encoded-rgb8-v1`.
- Output profile: `rec709-yuv420p-limited-v1`.
- LUT algorithm: `cube3d-tetrahedral-premixed-v1`.

The source declaration stores asset SHA, selected stream, range, user provenance and timestamp. It is never presented as measured file evidence. The read-only source inspector returns bounded ffprobe evidence. The worker independently re-derives that evidence from hash-verified source bytes; the original managed source, hash and selected stream bind that observation. A metadata-only probe cannot guarantee discovery of every frame-only HDR SEI or an untagged camera Log encoding. The user declaration is therefore required even when tags are compatible, and no camera identification is inferred from a filename.

Only supported opaque 8/10-bit YUV layouts are admitted. Known non-709 primaries, transfer or matrix, conflicting range, HDR/Dolby Vision side data, RGB, alpha or unsupported pixel layouts are rejected. A new input-transform profile must be introduced and independently validated for Log or HDR, rather than broadening this profile in place.

An absent or `null` clip colour field retains legacy semantics. Explicitly adopting managed colour on any clip selects the new plan for that snapshot. Every visible video must then have a valid interpretation; visible images block this first profile. Hidden visuals do not participate. Audio and the existing subtitle mechanism retain their roles. Disabling or setting a creative look to zero bypasses render-time LUT content consumption, staging and execution, but does **not** revert an explicitly adopted managed-colour pipeline to legacy rendering.

## Shared numerical pipeline

Preview and export use the same production `renderTimeline()` implementation and frozen plan.

1. Explicit BT.709 YUV full/limited → full-range encoded RGB float conversion using zscale. This retains R′G′B′ and does not linearize it.
2. For a positive enabled look, mix identity and the supplied table at each grid vertex, then execute explicit tetrahedral interpolation. `copy` precedes `lut3d` to avoid the independently reproduced raw-float plane-boundary issue in the verified FFmpeg build.
3. Resize the graded clip, quantize to RGBA8, then add transparent contain-padding. Composite with explicit RGB overlay. A clip's look does not affect padding, other clips or subtitles.
4. Add subtitles, optionally scale the completed editing canvas, then explicitly convert RGB → BT.709 limited YUV420p. Encode H.264 and verify primaries/transfer/matrix `bt709` and range `tv` in the actual published output.

The working/compositing profile is 8-bit encoded RGB, despite transient float LUT/conversion buffers. It is not a scene-linear or high-precision HDR compositor.

The creative LUT's normalized domain is `[0,1]`. Positive enabled LUT execution clamps out-of-domain RGB; it does not preserve arbitrary HDR/Log highlights or perform tone/gamut mapping. This is visible in the inspector and frozen as `outOfDomain: clip-lut-domain`. Zero and disabled looks use a true LUT bypass, although the output/composition format still imposes the explicit SDR profile's quantization and range limits.

Numerical acceptance separates interpolation error, YUV conversion/quantization and lossy H.264 output. The independent float oracle uses a 6×10⁻⁷ tolerance; 8/10-bit conversion tests and final-frame codec tolerances are separate. Identical snapshots with identical delivery settings have a decoded-frame preview/export parity test. Different delivery sizes or quality settings are not claimed to be bit-identical.

## Ownership and bounded staging

The original imported Cube bytes remain immutable in project-owned SQLite storage. Its existing resource profile and historical import receipt remain unchanged. In particular, the old resource-admission DTO's `renderBinding: not_implemented` is retained for receipt compatibility; it describes that resource-only contract, not current clip-render capability. Explicit clip binding is separate and still does not certify the LUT's artistic colour compatibility.

Rendering rechecks project ownership, original SHA, resource profile and parsed metadata. Only validated numeric values produce canonical Cube text; titles, filenames, arbitrary paths and filter strings never enter the render graph. The derived file is private, exclusive, no-follow and inode-owned, with a generated safe basename. Filter paths receive both option-value and filtergraph escaping.

- Original shared resource limit: 7 MiB/file, 64 MiB/project, 128 MiB/workspace.
- Canonical render limit: 21 MiB/file, 128 MiB/attempt, at most 100 distinct files.
- Deduplication identity: original SHA + resource profile + algorithm version + exact strength.
- Disabled/zero look: no render-time LUT byte read, parsing or canonical file. The saved project-owned reference still receives metadata integrity checks; this is not a promise of zero database reads.
- Cleanup removes only files/inodes owned by that exact attempt; unknown replacements survive. Unconfirmed media termination retains staging until the owned process is joined.

After source hashing, managed-colour preparation retains the actual source file identity. Existing capability, encoding and publication fences recheck the managed leaf/ancestors plus device, inode, size, mtime and ctime. The final preparation pass also detects an earlier source changing while a later source is checked. This is a stat-based integrity fence, not a cryptographic immutable file handle or a parser sandbox; privileged same-user/root transient pathname swaps are not claimed to be impossible.

The accepted export receipt binds the complete frozen plan and source/LUT identities. Deleting `colourPlan` from a job cannot downgrade it into legacy rendering because the original receipt independently marks the colour-managed identity. Missing, foreign or corrupt active LUTs fail; the renderer never silently substitutes an ungraded success.

## Reopen, backups and restored workspaces

The stored contract uses ordinary schema30 and restored schema31 (`restored-local-v4`). Historical24–29 schema/profile implementations are not rewritten. Old roles reject new colour keys rather than quietly dropping them. Backups retain source files, original LUT bytes, saved colour declarations, snapshots and receipts; restore does not install engines, access providers or run captured work.

Restored31 can read its retained LUT resources and explicitly render valid saved interpretations under the existing origin-bound local-operation policy. New source inspection and LUT import remain unavailable there. Existing origin-bound local edits are not silently removed. If an allowed source replacement invalidates the interpretation, rendering fails clearly; undo restores the prior valid state. No automatic probe or implicit interpretation is granted by restore.

## Packaging and future optional modules

There is no new package dependency, bundled LUT library, model, plugin installer or marketplace. Core owns source interpretation, correctness, transactions, snapshots and render execution. Future creative LUT catalogs and camera-transform data may be optional packs; heavier professional engines require separate reviewed capabilities. Removing a future pack must not delete the original resource bytes already adopted by a project.

Native UI acceptance and final candidate manifest are required before calling this slice ready for user use. Algorithm, service or DOM tests alone do not establish packaged GUI acceptance or Mac/Windows display parity.


## Pending-import restart checkpoint (2026-10-15)

Implementation regression gate: 302/302 tests passed, followed by the actual production build and typechecks. Independent reviews covered host/storage/workspace identity and preload/controller recovery semantics. These are code-contract results, not full native acceptance.

The native check used the existing pinned Electron 44.7.0 **source runtime with the production bundle**, not a packaged Mioon executable. Synthetic committed and undispatched fixtures were prepared through real backend/store contracts under `/workspace/shared/mioon-lut-recovery-{committed,undispatched}-20261015` in the actual GUI-host environment. This was fixture seeding, not a natively captured lost acknowledgement. The test helper refuses existing profiles/labels; historical `/tmp` attempts remain separate.

The committed fixture passed ordinary full close and relaunch: observed localhost port changed from 43507 to 40455 and backend PID from 5439 to 5596. Its original request ID, workspace/project identity, filename, byte size and SHA-256 survived unchanged and the native recovery controls displayed the pending record. Fresh nonpersistent partition semantics are established by source, not direct observation of a partition ID.

Exact-file reselection and explicit original-ID retry remain **unverified**. During the file-chooser attempt, the backend exited at 2026-10-15T11:55:56.009Z with `classification=connection-lost`, `reason=lease-expired`, code 0, no signal, `expected=false`, `forced=false`, and confirmed backend/media exit. The root cause and file-selection callback outcome were not established. No explicit import retry was clicked. Ordinary Quit then completed without force or discard; the undispatched native case was not launched.

Separate read-only audits after the first close and after the interruption found every fixture database table's count/hash unchanged, including the original single LUT resource/receipt, and the same 356-byte pending metadata store. Source bytes, fixture data and diagnostics were preserved. This proves restart survival and no observed import/domain mutation during these attempts; it does not prove native retry acceptance. Full native replay qualification, packaged-app qualification and issue closure remain pending. No broader exit-diagnostics investigation or production fault hook was added.
