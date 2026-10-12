# Named timeline deliveries and export history

Date: 2026-10-12. Baseline: `a2b5836d959894f1bae31161689f26c1a3138557`.
Status: core engineering trial checkpoint passed. Strict typecheck, focused checks, fresh Linux package/native acceptance and the final independent aggregate passed. The first aggregate and its four exact test-harness corrections remain documented below. This does not certify native Mac/Windows or live providers.

## Bounded scope

A timeline export may carry an explicit `deliveryName`, visible in the right-side delivery workspace and frozen in that export's snapshot. This is naming and historical delivery, not multiple editable sequences, automatic variants or batch rendering. Storyboard export and preview keep their existing behavior.

The new domain, download and renderer modules are checked TypeScript/TSX. Existing JavaScript files only connect those modules to the established render, recovery, preflight, media and UI paths. There is no database migration, provider/model request or new Agent permission.

## Exact shared request and snapshot

- `timeline.render` accepts optional `deliveryName` only for `purpose:'export'`.
- `timeline.export.preflight` accepts the same optional name and binds its exact presence/text in the frozen snapshot digest and report.
- `timeline.export.capabilities` continues to accept encoding settings only. A name does not cause an additional encoding option or alter the old omitted-settings render path.
- The name is nonblank, 1–120 UTF-16 code units, valid Unicode, without control or line characters. It is not trimmed, normalized, inferred from the current project, or rewritten by a service.
- A blank UI draft explicitly means omission. The UI displays validation errors for other invalid text instead of submitting a transformed name.
- `snapshot.deliveryName` is independent of the existing `snapshot.delivery` encoding profile. Omitted old fields remain absent, including in saved acknowledgement bytes.
- The existing exact request hash includes the optional name. Reusing a key with a changed, added or removed name/quality conflicts. Original successful acknowledgements replay before current revision checks and never create another render.
- A name-only export uses the old encoder defaults but receives the same immutable receipt/identity checks as other named deliveries. Removing a name from an accepted row cannot disguise it as a legacy request.

Preflight is still a bounded observation, not a successful-export receipt. A changed name, quality or saved timeline invalidates the current UI confirmation. Unknown render submissions retain their original key and complete input; there is no automatic retry, name substitution or new intent after reconnect.

## Historical display and download authority

Named history rows use the accepted name, creation time, timeline revision and frozen dimensions/encoding settings. Editing or renaming the current project does not rename these records. The managed output uses its existing unique asset identity/path; no user title becomes a filesystem path. Old unnamed records retain the existing compatibility display/default rather than inventing a persisted historical name.

The named link is `/media/{assetId}?download=1&exportId={exportId}`. The authenticated server checks the bounded export row, immutable acknowledgement, relational/JSON ownership and output identity before sending a filename. Named downloads additionally require the existing worker-generated `media/export-{exportId}-{uuid}.mp4` path binding; same-project pointer swaps cannot substitute another delivery output. Missing, mismatched or corrupt bindings do not expose a foreign export or source path. Metadata is rechecked at the response publication boundary after asynchronous file preparation. GET/HEAD/Range retain the existing file-stream lifecycle. This read validates owned output and matching frozen receipt; it does not reconstruct or authenticate the original optional preflight input from a receipt hash alone. The existing business replay still performs exact caller-input hash checking. The publication digest detects changes during this response, not arbitrary pre-existing database tampering.

Display names and filenames are separate. A shared deterministic policy creates a bounded MP4 basename with a short stable export identifier, handles path separators, Windows reserved names, controls/bidirectional controls, trailing dots/spaces and extension-like titles. The title shown in history remains the original accepted text. Suggested short identifiers are not a promise of globally unique filenames: managed outputs remain distinct, and saving over a chosen existing destination requires the native overwrite confirmation.

Electron checks the current live window, backend initiator origin, allowed navigation, nonempty same-origin URL chain, unchanged export/output identity and MP4 MIME. It derives the suggested basename from the current download's canonical server `Content-Disposition`, not a renderer filename/path or a separate unbound metadata fetch. It only sets Save As options; the user chooses the actual destination. Cancellation and overwrite confirmation remain in the native flow.

Official runtime source checked 2026-10-12: [Electron DownloadItem](https://www.electronjs.org/docs/latest/api/download-item). The locked Electron44.7 supports `getInitiatorOrigin()` and `getContentDisposition()`; native origin checking is additional to URL/window checks.

## Recovery, restored workspaces and limits

The existing timeline render journal remains session-recoverable in the UI as documented; this slice does not add durable render intent discovery or rename an unresolved request. Renderer name drafts survive tab/collapse changes and require the existing project-navigation discard confirmation when unsent. A matching strict render acknowledgement may mark its captured name clean; stale scope/name responses cannot clear a newer draft.

Restored held exports remain historical records and are not re-enqueued. Fresh local exports in a restored workspace continue to require the existing explicit workspace origin and immutable origin binding. Naming does not lift any restored-workspace restrictions or enable another backup.

No current Mac/Windows native, live provider, new codec/container, immutable-inode bytes, or all-platform filename behavior is claimed by Linux/synthetic tests. Existing stream checks cannot guarantee that another process never overwrites the same opened inode.

## Acceptance gates

1. Exact omitted-field/legacy bytes, same-key conflict, title-only receipt tampering and frozen worker/replay inputs; no unwanted capability probe.
2. HTTP/real CLI/official MCP strict schema and original-key recovery, restart, rename/edit immutability, and restored held/fresh exports.
3. Project/name/quality/draft/late-response and two-window boundaries; first-project navigation and matching acknowledgement cleanup.
4. Authenticated GET/HEAD/Range plus wrong export/output/project, malformed query/header, path/reserved/control/Unicode/length tests.
5. Strict compiler and new-module boundaries, fresh packaged build, actual Linux named export and native Save As with file-hash verification, normal restart/exit and final independent aggregate.

## Measured acceptance (2026-10-12)

- Final strict typecheck exited 0; the explicit 35-file affected run passed **584/584**, no skips, in **157845.882662 ms**. This includes contracts/business/replay, real HTTP/CLI/official MCP, renderer guard and legacy fixture coverage, desktop download security, restore-origin regression, compiler guard and UTF-8 listener inventory.
- The separate real transport/UTF-8 gate passed **10/10**. Focused UI and download gates passed **181/181** and final **24/24** respectively. These overlap the 584-test run and must not be added to it.
- The first-stage fresh production build, locked Electron 44.7 Linux directory packaging, GNU tar archive and package inspection all exited 0. Inspection retained the existing fuses, runtime notices, external font and no-secret/no-development-files checks. Mac/Windows packages were not rebuilt or tested here.
- The actual packaged Linux app exported two explicitly requested **trial delivery** records, frozen at timeline revision 2, 1280×720/30 fps, CRF 23 and CRF 18. Native Save As suggested distinct server-bound filenames `trial delivery-dbc60023e311.mp4` and `trial delivery-a6222453cd24.mp4`; saved bytes exactly matched the corresponding managed assets (57,220 and 57,234 bytes).
- Both actual saved MP4s passed full decode and FFprobe: H.264, 90 frames, 3 seconds; AAC, 48 kHz, two channels. One-second decoded audio windows retained the synthetic approximately 880 Hz signal. This is a synthetic local-media acceptance, with no provider call.
- Both normal app exits were 0. Reopening the same final package retained the named history and frozen quality labels, created no new export, and preserved all captured project/timeline/job/version records and original asset/export rows/media hashes.
- Changing the name after preflight visibly disabled the old export confirmation. The exact typed history and native filenames were captured in original screenshots. These screenshots record the earlier UI stage. Parent review required history to share the right dock as well; the final UI now uses the keep-mounted “本次导出 / 导出记录” pages under “交付检查”. The final container received separate fresh-build/native acceptance as recorded below.

Evidence lives under `evidence/named-deliveries/`, with source/build hashes, original logs, screenshots and portable candidate archive. The parent records the independent aggregate and durable Library copy separately before commit.

Earlier evidence is retained honestly: the first contract batch reported 46/47 due to an expected-object property-order test mistake (tool result only; no raw log was saved); corrected focused and final coverage passed. Initial strict checking found six narrowing errors, fixed before final build. A preliminary native verification script used the nonexistent `outputAssetId` instead of the existing `assetId`; it failed before probing and was corrected without changing product data or code. A Save As click and bound-window Quit actions that did not visibly complete were not counted as successes; subsequent supported UI actions and actual file/exit observations established completion. No GPU/security setting was changed. No new rendering anomaly was established during this bounded acceptance; this does not close earlier unrelated graphics limitations.

### Final right-dock acceptance

The final typed `DeliveryWorkspace` replaces the export-history Modal with the existing right dock's **本次导出 / 导出记录** subpages. Both use the established keep-mounted/inert visibility boundary. Hiding the compose page cancels its read observer; opening history does not submit or poll for a new job. Name/quality drafts remain owned by the same controller. Successful callbacks only reveal history when the accepted name capture and captured project/panel choice still match; a newer selection wins. Other unrelated dialogs are unchanged.

Strict typecheck passed again. Final UI/guard/legacy-history/shared-control/UTF-8 checks passed **228/228**, zero skips, in **8234.368391 ms**. Initial dock test fixture failures (one expected-event list and four SSR CSS setup hook failures) are retained in evidence; corrections did not relax business assertions. A second fresh production build, package and inspector passed; desktop main/backend hashes are unchanged from the first media acceptance, while final renderer/ASAR hashes are separately recorded.

In the final packaged Linux UI, an unsent **right dock delivery** name survived history/compose switching and dock collapse/reopen. Read-only observation confirmed no new export before explicit check/confirmation. A new explicit export completed in the right-side history. Native Save As wrote `right dock delivery-b3908921e153.mp4` (57,220 bytes), exactly matching its managed output; full decode/probe and the 880 Hz audio check passed again. Two final normal exits were 0; after recreation all four historical exports and original business/media records were preserved with no new task. Final screenshot: `evidence/named-deliveries/native-dock/06-final-reopened-right-history.png`. Earlier centered-history screenshots are retained as superseded UI evidence.

Some bound-window keyboard actions unexpectedly returned the interface to Properties, and native text insertion reported an unavailable AT-SPI provider. Those attempts were not counted as draft-retention success. The documented Sky desktop key/mouse path completed the same synthetic acceptance; no product/GPU/security setting was changed. Their tooling cause is not established.

### First aggregate and final closeout correction

The first independent parent run exited1: **4,849 total / 4,843 passed / 4 failed / 2 existing platform skips**, **1406385.673302 ms**. One import-only secrets fixture rejected the newly introduced fixed TypeScript download dependency before registering its cases. Three existing output-format App harnesses omitted the new independent delivery-name controller reference. The original log is retained; neither issue is described as an environment failure.

Only the two test harnesses are corrected: the secrets loader adds one exact reviewed source, real strip-only TypeScript erasure, and a counted unused parser double with a final zero-call assertion; unknown paths/imports and runtime Electron remain refused. The format harness retains every prior assertion and adds actual-controller joint format/name cancellation, changed-back text, replacement-owner and unload regressions. The corrected affected run passed **191/191**, zero skips, **6573.325286 ms**. Its standalone secrets gate passed **36/36**; these counts overlap.

A bounded guide closeout corrects stale backup-restore and preflight instructions, documents the right-side named-delivery flow and provides a current core-trial entry. The backup guide is bundled as renderer raw text, so this change requires fresh Web/desktop packaging and a final limited native reopen, rather than being labelled external documentation only. Functional application sources remain unchanged from the earlier full/native snapshot. The final guide/UI/dock/UTF-8 check passed **45/45**, zero skips, **2226.118680 ms**; 89 local documentation links and source command/control references were separately checked. Fresh production build (including strict typecheck), Linux directory packaging, GNU tar and package inspection all exited0. Desktop main/backend and the Electron binary are byte-identical to the preceding native-media acceptance; the bundled backup-guide text changes Web/ASAR hashes.

The final exact package was reopened through supported cloud native controls. Its inline backup guide displays the corrected restricted-restore instructions; the right-dock history retains all named records and quality labels. Normal exit0 at 2026-10-12T09:10:37.751Z preserved every captured business row/media hash from the preceding final-dock session, with no new export. `native-guide/01-corrected-inline-backup-guide.png` and `02-final-packaged-named-history.png` are the final-package screenshots. The earlier actual export/SaveAs/decoded-media evidence remains valid for the unchanged business/download runtime and is labelled with its own prior ASAR, rather than falsely claiming another export was performed after a documentation change.

The final source scope is **56 files: 28 production, 11 documentation, 17 tests**. The new [core trial entry](CORE-TRIAL.zh-CN.md) describes the shortest local source-Web route and current limits. The final independent parent typecheck and aggregate both exited0: **4,890 total / 4,888 passed / 0 failed / 2 existing platform skips**, **1351955.840735 ms**. Original first-run evidence is retained. The total is 41 higher than the first run: the formerly failed file-level placeholder is replaced by its 36 registered secrets tests (+35), and six joint format/name regressions are added. No business assertion, deadline or platform skip was removed to obtain this result.

This is a verified **core engineering trial checkpoint**, scoped to the implemented local workflow and stated Linux evidence. The final fact-only update changes this document and the external core-trial entry, not bundled guide text or product/test code; final build/native hashes remain valid. After commit, identify this exact checkout with `git rev-parse HEAD` and the corresponding `STATUS.md` entry, rather than an invented pre-commit SHA. Remaining platform/live-provider decisions are listed in the core-trial guide; no new functional slice is automatically started by this checkpoint.
