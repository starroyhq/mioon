# Mioon approved product roadmap

Updated: 2026-10-16 UTC. Current index checked against application integration
`ff85c9a8daaa35bff080d0979fe2faa3683cd3b5`, last verified on GitHub main,
and local-only test-fixture repair `25609e98b8990eaa121124f35242f0bcf4a4b3ae`.
The local opacity index below includes completed follow-ups through `256cfd3`.
Earlier accepted integration ancestry is preserved. This document distinguishes implemented
slices, their actual acceptance boundaries and remaining approved scope. It does
not promote a WIP checkpoint, certify the combined native application, or grant
new execution, spending or publication authority. The earlier documentation-only
review reran no product tests; current local opacity qualification is linked below.
Later bounded Safari/short-media evidence is indexed below; stopped issue investigations remain stopped.

## Current UI iteration (2026-10-16)

- **Clip opacity keyframes: local fresh42 application slice after `ec01753`.**
  The same App now has an explicit independent development entry with project
  creation/import, durable task ACKs, Inspector v3 drafts, raw opacity saves,
  preview/export preparation and guarded media delivery. Default40/41 and
  historical constructors remain unchanged. [Application scope and evidence](OPACITY-CANDIDATE-APPLICATION.md)
  separate pure/synthetic qualification from [partial Safari and actual10-frame
  media acceptance](OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md): login/project creation
  passed, while CUA disconnected at the import picker. Actual HTTP persistence,
  Undo/Redo, FFmpeg preview/export and guarded downloads passed; later GUI items
  in that earlier42 run remain unverified. It also records [explicit ordinary42 reopening](OPACITY-CANDIDATE-REOPEN.md)
  and the implemented [fixed42 cold-backup→offline43 entry](OPACITY-CANDIDATE-BACKUP-RESTORE.md),
  with raw evidence/held/epoch/origin retained and v3 drafts explicitly excluded.
  The subsequent [restored43 application entry](OPACITY-RESTORED-APPLICATION.md)
  now supports existing-project editing/Undo/Redo and new preview/export requests
  under the original origin/held/epoch rules. That initial43 slice kept unsaved
  input and views in memory; source42 v3 drafts remain excluded and preserved.
  Its124/124 focused tests and separate12/12 preference checks, canonical builds,
  actual Safari Save/Cancel/Undo/Redo,10-frame preview/export/playback and normal
  close/reopen passed. Guarded HTTP download and RGB decode passed; full
  four-language/IME and packaging/platform gates remain. Ordinary42 creation/import
  permissions and40/41 migration are not granted to43. No push or release.
  A later [language/IME follow-up](OPACITY-LANGUAGE-IME-ACCEPTANCE.md) repairs
  composition-Enter and Cancel/Save races (241/241 plus separate5/5 checks).
  Its partial43 GUI covers three locales on the prior build; CUA disconnected
  after Japanese settings. Real IME and final fixed-build/native acceptance
  remain open; no push or release.
  The subsequent [new-origin43 clip-draft slice](OPACITY-RESTORED-DRAFTS.md)
  (`4607947`) permits explicit cold recovery after durable ACK only with exact
  `localClipDrafts` capability; source42 v3 is not migrated. Older43 without
  that capability and restored view state retain memory fallback; unconfirmed
  input and composition still block safe close. The [explicit ordinary40→42
  offline copy upgrade](OPACITY-ORDINARY-UPGRADE.md) (`256cfd3`) preserves an
  eligible source and verified backup, refuses unresolved tasks/active drafts,
  and requires a new target.41 and default production admission remain unchanged.
  [Batch integration/release checks](OPACITY-RELEASE-CHECK.md) repaired four
  product regressions; the final121-file aggregate retains6 historical BLOB
  expectation failures. The [isolated baseline follow-up](BLOB-ADMISSION-BASELINES.md) reproduced
  them before a7 and on ff85/d52; historical BLOB startup compatibility still
  requires a frozen-boundary decision. Node24 strict types passed, its native build was blocked by
  macOS Team IDs, and Node26 auxiliary builds do not qualify the product runtime.

- **Settings center: implemented in `92add7e`, integrated through `ff85c9a`.** One explicit Settings
  entry now groups General, Models & services, and Extensions in all four GUI
  languages. Existing connection forms, retained drafts, transient-secret
  handling, busy/recovery guards and close confirmation are preserved; project,
  clip and export options remain contextual. This is not plugin install,
  uninstall or dynamic-loading support, nor full native/platform acceptance.
- **Sample export preview: implemented in `5a3751b`, integrated through `ff85c9a`.** A
  separate 1–300-frame trial range uses current export settings, its own checks,
  the existing durable export path and an exact-output player with stale-result
  blocking. It does not change the final range or cancel a render when closed.
  Focused checks and genuine 60-frame/120-frame synthetic MP4 proof are recorded
  in [the feature acceptance boundary](EXPORT-PREVIEW.md). Native GUI acceptance
  remains separate; this is not a live final-quality or HDR preview.

- **Fixed shot-video comparison: implemented locally in `7115279`.** Existing A/B UI now
  uses explicit distinct immutable selections, exact local media identity,
  frozen metadata and stale/offline playback fencing in four languages. The
  read-only exact-version route and source acceptance are documented in
  [version comparison](VERSION-COMPARISON.md). Native GUI remains unverified;
  image-group comparison, synchronized/wipe/diff views and live generation are
  not included.

- **Local media tags/notes: backend `fc40d80`, UI `128c8fb`.** Project-owned
  tags/plain-text notes and composed saved-tag filtering have explicit save,
  independent annotation revisions, exact session replay and retained draft/close
  protection in four languages. They do not modify timeline undo, source ranges
  or favorite/reject semantics. [UI workflow](ASSET-ANNOTATIONS-UI.md) and
  [combined acceptance](../evidence/asset-annotation-ui/ACCEPTANCE.md) distinguish
  source/service verification from unaccepted interactive native behavior.
- **Selected saved-clip loudness: implemented locally through `7b0de4a`.** The
  [opt-in read-only panel](TIMELINE-CLIP-LOUDNESS-UI.md) analyzes the entire saved
  clip only, up to 60 seconds / 1800 frames; longer clips are refused, not trimmed.
  There is no gain recommendation/application, normalization or batch matching.
  [Backend evidence](TIMELINE-CLIP-LOUDNESS.md) preserves the failed 600-second
  offline experiment and both successful 60-second boundary runs, including the
  accidental second run. None qualifies 600-second real-time playback.
- **Clip audio roles: backend `e5bf880`, integrated UI `ad72c8f`.** Explicit
  Unclassified / Human voice / Music / Sound effects labels use ordinary clip
  Save, revision/CAS, draft recovery, Undo/Redo and split inheritance in four
  languages. [Backend semantics](TIMELINE-AUDIO-ROLES.md) cover optional/null
  preservation and ordinary schema38 → restored schema39 compatibility; the
  [editor acceptance](TIMELINE-AUDIO-ROLE-UI-ACCEPTANCE.md) records bounded,
  fail-closed capability admission. These are editorial metadata, not automatic
  classification, audio processing, routing or ducking. The backend's final
  15-second CLI qualification failure remains unresolved; a diagnostic 30-second
  pass is not acceptance of that gate.

- **Four-language presentation: implemented and integrated.** GUI/native copy,
  main-CLI and bounded backup/MCP diagnostics retain the distinct scopes below.
  Exhaustive four-language native acceptance is unfinished.
- **Volume-envelope backend and row editor: implemented and integrated through
  `dc7a057` and `ff85c9a`.** Existing Save/history/replay/draft ownership carries
  ordered points; there is no second persistence owner. The earlier
  [editor checkpoint](VOLUME-ENVELOPE-EDITOR-INTEGRATION.md) and its 721 TS
  diagnostics are historical: [canonical conformance repair](evidence/volume-envelope-canonical-repair/qualification.md)
  resolved the blocker, and canonical TS plus a production source build passed
  on `ff85c9a`. Native Save/Undo/Redo and normal close passed on `dc7a057`;
  Inspector reopen, CJK IME and four-language native acceptance remain unfinished.
  The [fade-preset follow-up](AUDIO-EFFECTS-PLAN.md) is locally implemented:
  a 15/30/60-frame selector (30fps, default 30) and explicit Replace with fade-in /
  fade-out buttons replace all draft points before ordinary Save; manual editing,
  Cancel, local drafts and Undo/Redo retain their existing ownership. Oversized
  presets are refused. This slice covers ordinary 40/restored 41 only, preserves
  audio/capability/IME guards and existing gain/fade multiplication, and adds no
  DSP, schema or 42/43 capability. Node24 focused tests passed 51/51 plus 40/40
  related regressions; canonical strict types and the auxiliary Node26 default
  Web/development Desktop source build passed. Independent review found no
  blocker. [Evidence and limits](evidence/volume-fade-presets/qualification.json)
  retain previous release-check failures and formal Node24 build/GUI/native gaps;
  this is not a completed release qualification.
  Manual interval reduction is locally implemented: user-set
  start/end frames, target linear multiplier (0 mute, 1 unity), and entry/recovery
  lengths generate at most four existing envelope points. The selected interval
  includes both ramps; invalid, overlapping or discontinuous interior ramps are
  refused without clamping. Only an explicit Apply to draft and replace all
  keyframes action replaces the curve, which remains editable through the same
  Save/Cancel, draft recovery and Undo/Redo flow. Tool parameters are temporary
  panel input until applied and may be lost on switch/close. This ordinary 40 /
  restored 41 slice retains audio/capability/IME/owner guards and gain/fade
  multiplication; it adds no voice detection, loudness analysis, DSP, schema,
  frozen-history change or 42/43 permission. Node24 focused tests passed 82/82
  (21 new), with 73/73 disjoint related regressions and no skips; canonical
  strict types and the auxiliary Node26 default Web/development Desktop source
  build passed. Independent review found no remaining issue. [Evidence](evidence/manual-ducking/qualification.json)
  preserves actual GUI, OS IME and listening gaps, the formal Node24 Team ID
  blocker and six historical compatibility failures. Source-driven voice-range
  analysis and candidate review remain later ducking work; manual editing does
  not complete automatic detection or dialogue loudness matching.

## Current delivery and remaining work (2026-10-16)

1. **Editing, audio and loudness.** Independent project home/windows, managed
   media/source ranges, favorite/reject and current-timeline usage, raw-source
   waveforms, clip fades and the three 30fps canvas presets have their earlier
   bounded deliveries. [Saved-timeline sound audition](TIMELINE-AUDIO-PREVIEW.md)
   retains its legacy 20-second interface. [Continuous timeline audio](TIMELINE-AUDIO-CONTINUOUS.md)
   is now integrated: original user commit `70d9bb6` is preserved through merge
   `670edd8`, with four-locale discovery adaptation `77b4c8e`; `41f09c3` also
   merges the reviewed LUT recovery work. Historical [audio acceptance](TIMELINE-AUDIO-CONTINUOUS-ACCEPTANCE.md)
   and [review fixes](TIMELINE-AUDIO-CONTINUOUS-REVIEW-FIXES.md) retain their own
   evidence boundaries: actual 25-second audio-clock playback and accelerated
   two-/ten-minute PCM comparisons are not a 600-second wall-clock qualification.
   A later Linux 600-second qualification attempt stopped at its cancellation
   prerequisite after a harness 30 ms observation window; the 600-second case
   never ran. That observation does not establish a product defect. The repaired
   harness has been rebuilt and statically reviewed with 19 focused checks
   passing, but has not passed rebuilt media/GUI runtime acceptance. Positive
   GUI-host RSS observation and cancellation evidence with at least one observed
   FFmpeg start and no remaining owned FFmpeg processes remain runtime gates. [Exported-file loudness observation](EXPORT-LOUDNESS.md)
   and [full-current-mix candidates](TIMELINE-MIX-LOUDNESS.md) have separate
   read-only acceptance. [Atomic gain application](TIMELINE-LOUDNESS-APPLY.md),
   undo/redo and explicit float-v2 UI selection exist in `44c41a7`, but their
   [WIP checkpoint](ATOMIC-LOUDNESS-WIP-CHECKPOINT.md) remains unaccepted after
   incomplete/failing regression evidence. Do not describe these as wholly
   unimplemented or as fully accepted. Selected-clip read-only measurement and
   explicit editorial roles are now delivered within the limits indexed above;
   they do not complete per-clip/dialogue loudness matching. The volume-envelope
   backend and row editor are implemented and integrated; their remaining native
   acceptance is indexed above. Do not restart the earlier pure prototype.
   Opacity keyframes now have the isolated fresh42 and restored43 slices above,
   including fixed cold backup/restore and explicit separate application admission.
   Exact-capability43 new clip drafts now support explicit cold recovery after
   durable ACK, while source42 v3 stays excluded and older43/views keep memory
   fallback; see [draft scope](OPACITY-RESTORED-DRAFTS.md). The explicit
   [ordinary40→42 copy upgrade](OPACITY-ORDINARY-UPGRADE.md) and remaining
   [release gates](OPACITY-RELEASE-CHECK.md) retain their separate boundaries. Other visual
   keyframes/transitions, audio crossfades, source-driven ducking analysis, limiter/EQ/noise
   reduction and scoped proxy performance
   remain separate work; local media tags/notes are no longer pending. No automatic
   target or AAC loudness/true-peak guarantee is implied.
2. **Colour and Looks.** Project-owned LUT resources (`a78abb0`) and the versioned
   [Rec.709 SDR clip LUT workflow](SDR-CLIP-LUT.md) (`16b7b4d`) are implemented;
   the latter commit records focused tests and packaged Linux feature acceptance,
   not general release acceptance. The later [single-Look data pack](LOOK-PACK-ACCEPTANCE.md)
   (`53c42fa`), [bounded mixed SDR PNG workflow](MIXED-SDR-IMAGES-ACCEPTANCE.md)
   (`93a0575`) and [restricted JFIF JPEG inputs](JFIF-SDR-IMAGES-ACCEPTANCE.md)
   (`75ad276`) have their own focused, production and synthetic Linux native
   evidence. They are not general ICC/P3/Log/HDR/RAW support or a professional
   colour compositor. Bounded desktop pending-LUT recovery metadata is implemented
   in `f50f1a8` and merged in `41f09c3`. Native restart survival has partial
   evidence, but exact-file reselection/explicit retry and the complete native
   restart gate remain unaccepted. This is not verified closure of
   [issue #2](https://github.com/starroyhq/mioon/issues/2).
3. **Export, creation and versions.** Preflight, MP4/H.264 settings, named export
   history, selected-range export, decoded sample-peak checks and backend opt-in
   float-checked export retain their own evidence. Further codecs/containers,
   hardware encoders, one bounded editable interchange format and multiple
   editable delivery sequences still need separate implementation/acceptance.
   Immutable generated versions, explicit source replacement, frame extraction,
   versioned subjects and the bounded Images/PNG-editing/reference-input flows
   are delivered within their documented limits. Richer comparison, motion/style
   references and reviewed multistage creation remain open; synthetic protocols
   do not establish real-model quality.
4. **Agent and extensions.** Bounded project reads and reviewed shot-text,
   selected-clip move/gain proposals use shared business/history/replay services.
   Any further Agent action needs its own exact review and authority boundary.
   The fixed Comfy connector now has [optional startup admission](COMFY-OPTIONAL-MODULE.md)
   (`bbdeec4`), including bounded synthetic Linux native evidence. This is not a
   dynamic plugin loader, installer, smaller distribution or real Comfy/GPU
   acceptance. The bounded broker/SDK, second extension class, general external
   result/version return and later optional Blender/catalog/store milestones
   remain as scoped in [EXTENSIONS-ARCHITECTURE.md](EXTENSIONS-ARCHITECTURE.md).
5. **Languages and interaction acceptance.** [Four-language GUI/native-copy
   implementation](I18N-ACCEPTANCE.md) (`45da4df`) covers Simplified Chinese,
   region-neutral Traditional Chinese, English and Japanese, with isolated
   preferences, 365/365 targeted checks and bounded Linux native observations.
   The separate [CLI/MCP presentation checkpoint](i18n-coverage-cli-mcp.md)
   (`1794006`) delivers explicit four-language main-CLI help/parser diagnostics
   and MCP instructions/tool descriptions, preserving legacy default output and
   machine protocols. The later `5d9774f` slice delivers four-language offline
   backup help/owned diagnostics and MCP-owned launch/stdio startup diagnostics;
   [I18N.md](I18N.md) records its explicit-locale and unchanged-machine-protocol
   boundaries. Development, doctor and server-startup script copy remains outside
   that slice. Narrow editor layout ([issue #4](https://github.com/starroyhq/mioon/issues/4)),
   native 200% zoom, full screen-reader coverage and exhaustive native menus/file
   choosers remain unverified. No repeated resize investigation is implied.
6. **Reliability and delivery.** Local integration includes the user's
   [source-process lifecycle/timeout diagnostics](SOURCE-PROCESS-TIMEOUTS.md)
   (`630348f`), bounded backend-exit diagnostics (`64506e9`) and diagnostic-storage
   identity hardening (`e87fa30`). The source-process report distinguishes the
   reproduced fixture IPC race from the still-unproven cause of historical
   readiness/CLI failures. These commits do not establish closure of historical
   [issue #1](https://github.com/starroyhq/mioon/issues/1) or combined native
   acceptance; additional diagnostics alone do not prove the earlier exit symptom
   resolved. Do not restart stopped investigations merely to update this index.
   Backup/restore, fixed schema roles, shared contracts and Linux packaging retain
   their documented boundaries. Native macOS/Windows storage/vault/installer/
   signing, real-provider configuration/media/budget gates and release publication
   remain separate. Incremental TS migration or safety-boundary extraction should
   address a concrete reproduced need, not duplicate completed features.

The current `ff85c9a` source integration passed 217 focused checks, canonical
TypeScript/source-language guards and one production source build. Its known
44 LUT fixture failures were reproduced on clean `a7fcf741`; local-only
`25609e9` subsequently repairs the two stale test fixtures, passing 53/53 original
checks plus 11/11 pure-memory host checks. The extra preload bundling case was
blocked by an esbuild subprocess guard (command exit 1), not passed. No current
full-suite, new installer or all-platform gate is claimed. `ff85c9a` was pushed
and verified on GitHub main; `25609e9` remains unpushed. No CI runs/checks/statuses
were visible at the publication query; this documentation refresh does not requery.

The earlier combined `41f09c3` integration has 915/915 focused checks across 63 files,
strict typecheck and an actual production-channel build passing. Source hashes
were verified unchanged after the provenance commits. This is not the full
repository suite, combined native acceptance or release certification; do not
sum historical test totals into a new gate. No push or Mac synchronization was
performed for this integration. Remote main and the user's Mac checkout were not
queried by this documentation review. A proposed public
[issue #3](https://github.com/starroyhq/mioon/issues/3) comment remains awaiting
approval and is not recorded as published or as issue closure.

The accepted local descendants retain separate, scoped gates, not a new full-suite
or release acceptance total:
- `5a3751b`: 475/475 affected checks and a development web/desktop build, plus the
  bounded synthetic export artifacts in [EXPORT-PREVIEW.md](EXPORT-PREVIEW.md).
- `fc40d80` → `128c8fb`: 711/711 affected checks and a production build, with
  retained initial failures and exact source/staging manifests in the
  [annotation checkpoint](../evidence/asset-annotation-ui/ACCEPTANCE.md).
- `7115279`: 458/458 affected checks, strict typechecks and a production build;
  [comparison evidence](../evidence/version-comparison/ACCEPTANCE.md) retains the
  earlier route-fixture failure and native limitations.
- `7b0de4a`: 337/337 affected nonmedia checks, a separate 12/12 pure gate and a
  production build; [UI verification](qualification/clip-loudness-ui/README.md)
  does not rerun the backend media boundary or establish GUI acceptance.
- `e5bf880` → `ad72c8f`: 468/468 affected checks, an independent 88/88 check,
  strict typechecks and a production build. These do not close the unresolved
  backend CLI gate or establish native acceptance.

Do not sum these counts or their overlapping checks. The role production build
records Node 24.19.0, not pinned 24.21.0. The historical 468/88 test logs do not
independently attest their executable/version. Earlier slice reports retain their
own runtime claims, not a blanket Node 24.21.0 attestation for the chain.

The separate one-shot native attempt in a fresh cloud profile ended normally at
21:32:16 UTC on 2026-10-15. Exact-window q/a keyboard input and creation of project
qa passed. Selecting v.mp4 and pressing Return closed the chooser, but produced
zero assets and no error toast. Read-only postmortem cannot distinguish chooser
cancellation/no FileList, an early frontend return or rejection. No retained HTTP
trace establishes that asset.import reached the backend; this is not evidence of
a backend bug. Role Save/Undo, annotations and trial export were not exercised,
and general native acceptance remains pending. The backend-exit.jsonl record
reports expected normal shutdown with forced=false, exitConfirmed=true,
mediaExitConfirmed=true, shutdownFailed=false and code 0; independent descendant-
process absence was not audited. This is not proof of complete process retirement.

This documentation refresh runs no tests, media qualification, builds or GUI,
performs no push or Mac synchronization, and does not publish the approval-pending
issue #3 comment.

The current index takes precedence over historical "pending", "next" and
"current" wording below. Future work does not authorize paid calls, credential
configuration, third-party installation, platform changes, push or publication.

## Next independent feature slices

Continue approved local feature work when a separate acceptance or publication
step is blocked; a blocked item does not pause the whole project. Preserve each
item's evidence and permission boundary rather than silently treating it as done.

1. Preserve the implemented volume-envelope backend/row editor and its documented
   remaining acceptance gates. The earlier pure prototype is historical; its
   production integration is complete, while full native acceptance remains open.
2. Keep the completed bounded export preview, tags/notes, shot-video A/B,
   selected-clip measurement and audio-role slices closed at their documented
   source gates; do not restart them because older roadmap entries say pending.
   Broader comparison modes, loudness matching/application and effects need their
   own bounded implementation and acceptance.
3. Keep native results attributed to their exact builds: `dc7a057` covers
   Save/Undo/Redo and normal close, while Inspector reopen, CJK IME and four-language
   native acceptance remain open. The earlier one-shot import outcome, 600-second
   real-time audio qualification, role CLI gap and LUT reselection/restart remain
   independent unresolved gates. Do not infer a cause, restart stopped
   investigations or widen deadlines from this queue.

The dated feature checkpoints record each slice’s actual implementation and
acceptance; this queue grants no permission for broader external actions. Audio
qualification and native LUT reselection remain independent acceptance work;
issue publication, platform changes and real-provider gates retain their own
approval requirements.

## Historical roadmap snapshot (2026-10-14)

The following preserves the earlier roadmap and approvals. Its implementation
status, test totals and Git observations are historical, not the current queue.
In particular, later LUT/Look/image, optional Comfy and language checkpoints are
indexed above; loudness application remains WIP rather than newly accepted.

Updated: 2026-10-14 UTC. This is approved iteration scope, not a completion claim.
Original roadmap baseline: `66a0193`; current status wording was checked against
committed baseline `f8b9171`; the separate [atomic apply integration](TIMELINE-LOUDNESS-APPLY.md) is in progress and has not yet passed its final feature gate. Verified deliverables and historical test totals remain
in STATUS.md and their dated acceptance reports. The latest independently completed full gate is the [fixed schema/profile prerequisite](WORKSPACE-SCHEMA-PROFILES.md): 7,399 total / 7,397 passed / 0 failed / 0 cancelled / 2 existing skips, with strict typecheck exit 0. Older feature gates retain their own baselines.
The documentation check itself does not rerun product or platform acceptance.

## Historical delivery and remaining work (2026-10-14)

Independent project home, per-project native windows with one shared backend,
and bounded [20-second sound audition](TIMELINE-AUDIO-PREVIEW.md) have since been
delivered. [Complete exported-file loudness observation](EXPORT-LOUDNESS.md)
has passed its independent implementation/acceptance gate. Measurement and arithmetic advice
do not complete loudness normalization. [Frozen full-current-mix candidates](TIMELINE-MIX-LOUDNESS.md)
have passed their separate read-only implementation/acceptance gate; explicit atomic gain application,
undo, float-v2 UI selection and remeasurement remain the next separate stage.

The core local Linux engineering trial is available; it does not wait for every
item below. [STATUS](../STATUS.md) records the user-UI merge `4858642` and
backend-only float-checked export `dc3bbe8`, their distinct actual gates, and the
historical Git boundary. Later [user-flow integration](USER-FLOW-INTEGRATION.md)
and [empty-workspace clarification](EMPTY-WORKSPACE-MODE.md) have their own
committed evidence. This is a current index over the historical approvals below,
not new implementation, external-service authority or a fixed number of commits.

1. **Editing experience.** Delivered: managed media, source ranges, favorite/reject,
   current-timeline usage/filter/location, raw-source waveforms, clip fades,
   three 30fps canvas presets, bounded draft/restart recovery, independent project
   home/windows, saved-timeline sound audition up to20seconds and complete exported-file loudness observation. Complete current-mix candidates are also delivered. The current implementation work is explicit loudness gain application, followed by the bounded audio/effects
   stages below. Existing user workbench design is preserved. Reproduced reliability defects remain actionable; scoped proxy
   performance and tags/notes remain separate open work. Ducking/crossfades,
   color/HDR and later effects are not made complete by their inclusion in the plan.
2. **Export extensions.** Delivered: preflight, MP4/H.264 settings, frozen named
   history, selected-range export, explicit final-file decoded sample peaks and
   backend opt-in float-checked pre-AAC rejection. These are distinct features;
   neither peak operation is loudness/true-peak certification. The approved
   [loudness plan](AUDIO-EFFECTS-PLAN.md) separates read-only analysis, per-clip
   matching and explicit whole-mix target application. Float-v2 already exists
   backend-only; UI selection and default/compatibility choices remain separate.
   Further work:
   additional codec/container and hardware capabilities, plus one bounded editable
   interchange format. Each needs actual encoder/NLE/platform verification; no
   silent fallback or universal compatibility promise.
3. **Creation and versions.** Delivered: immutable generated versions, explicit
   timeline source replacement, managed frame extraction, versioned subject
   library, fixed/compatible Images and single-PNG editing, first/last-frame and
   explicitly selected subject-version video inputs. Local Mock and protocol
   tests do not verify real generation quality. Open: richer comparison,
   motion/style references, reviewed multistage generation and multiple editable
   delivery sequences. Named exports from one timeline are not multiple sequences.
4. **Agent extensions.** Delivered: bounded project reads, reviewed shot text,
   selected-clip move and gain proposals with shared business/history/replay.
   Further actions must be selected individually with immutable review, exact
   target/revision and approval; do not expose the whole CLI or infer payment
   authority. Real model connectivity/quality remains separately unverified.
5. **Extension ecosystem.** Delivered: one fixed local ComfyUI T2I connector and
   explicit result observation/recovery, tested against a synthetic service.
   The real Comfy/GPU/workflow gate remains open. Next architectural milestone:
   only the bounded broker/SDK and second extension class described in
   [EXTENSIONS-ARCHITECTURE.md](EXTENSIONS-ARCHITECTURE.md), when prioritized.
   General external result/version return, third-party distribution/store and
   optional Blender stay later; installation/execution has separate permission
   boundaries. Codex OAuth is an independent deferred integration, not a required
   plugin dependency.
6. **Delivery and engineering.** Delivered: shared contracts/services, Linux
   packaging freshness, backup creation/verification and restricted safe restore,
   crash/replay boundaries, mixed JS/TS tooling and the current Linux checkpoints.
   Next local work should fix a reproduced reliability gap or remove a concrete
   duplicate safety boundary with characterization tests. Legacy TS migration is
   incremental. Mac/Windows native storage/vault/installer/signing, real-provider
   configuration/material/budget approval and later publication remain external
   gates. A source-only Windows candidate is not merged runtime support.

Some next items can be implemented locally without paid calls; their exact slices
still need compatibility and acceptance boundaries. Platform/security changes,
third-party installation, credentials, live calls, signing and publication retain
their applicable approvals. Future work is not a new spending or push authorization.
The latest read-only Mac observation, completed at 14:20 UTC on 2026-10-13,
confirmed main `6f6bba78abed27cf75766d1a787e0479dedab738`. Remote main `ccfaab5`
remains the earlier last verified observation and was not rechecked this time.
Historical reports retain their original Git observations. Completed subfeatures
must not be reopened merely because a broader heading or old checkpoint says open.

## Audio, loudness and effects sequence (approved 2026-10-13)

The user approved adding the proposed audio/effects stages to the iteration queue
and explicitly added unified loudness. [AUDIO-EFFECTS-PLAN.md](AUDIO-EFFECTS-PLAN.md)
defines current capabilities, remaining work, dependency order and acceptance.
[Project home](PROJECT-HOME-PLAN.zh-CN.md) comes first, then real-time audio preview
and loudness. Those documents began as planning-only records. Project home/windows, bounded saved-timeline sound audition, final-file loudness observation and full-current-mix candidates now have their separate dated acceptance reports above. Remaining effects and application stages are not made complete by the original plan.

1. **Audible and reviewable audio.** Real-time timeline mixing must implement saved
   gain/mute/fades/source ranges and overlap, with the same versioned effects,
   clock and snapshot semantics as offline rendering. Implementations may differ;
   source HTML playback does not establish mixed-preview parity. Add local
   loudness/true-peak analysis, then separately reviewed clip/dialogue matching
   and whole-program or selected-range loudness targeting. Do not impose an
   unverified universal LUFS target, equate loudness with peak normalization,
   apply one gain to every source, or silently insert dynamics processing.
2. **Everyday audio and picture controls.** Voice/music/effects roles, volume
   keyframes, crossfades and editable ducking; explicit limiter, basic EQ/noise
   reduction. For pictures, position/scale/opacity animation and fades/dissolves
   precede crop/rotation/exposure/contrast/saturation/blur. Existing static layout,
   gain, fades, waveforms, sample-peak checks and manual subtitles are reused.
3. **Later creation and compositing.** TTS, recording and sound-effect generation
   with replaceable providers and managed immutable results; text motion,
   masks/tracking, keying and advanced compositing. None is delivered now.
   Each external input, permission, installation or paid execution keeps its
   own approval boundary; adding it to the queue does not authorize a live run.

Analysis and application are separate operations. Bind reports and candidates to
source hashes, effect stage, timeline revision, exact range and snapshot; provide
per-item batch review/A-B preview before explicit atomic application. Preserve
originals, undo/redo, exact-key replay and interruption recovery across shared
UI/API/CLI/MCP. Silence, short/invalid media, large boosts and loudness/peak
conflicts need explicit unsupported/risk states, never hidden gain changes or a
false pass. Real PCM, seek, overlap/mute/fade and output measurements are required;
existing Linux gates do not certify these planned features or other platforms.

## Product direction

Local-first, single-user AI creation and editing workbench: review assets, plan shots,
generate and select versions, assemble a timeline, and export real media. Canvas and
Editing are complementary views of shared project data. External agents use MCP/CLI;
an optional in-app Agent uses the same business services. Keep an editable handoff
to established finishing tools in scope rather than duplicating an entire professional NLE.

## Historical committed foundations

- Electron monorepo, shadcn/Base UI, durable local assets/jobs/versions and real FFmpeg export.
- Shared UI/API/MCP/CLI business services; split, snapping and durable timeline undo/redo.
- Independent collapsible/resizable Canvas and Editing layouts, with draft/media lifecycle guards.
- Agent provider presets, write-only connection settings, bounded chat/project inspection
  and explicitly reviewed shot-text/clip-move/clip-gain edits. Each was delivered in
  a separate stage; the original settings-only commit did not include chat/tools.
  Real provider connectivity is NOT certified.

## Ordered delivery groups

### 1. Finish the in-app Agent workflow

Follow [AGENT-ITERATION.md](AGENT-ITERATION.md): secure compatible transport, streamed
responses and cancellation, durable scoped conversations/read tools, shared mutation replay,
reviewable local edits and explicit paid-generation approval. Common-provider presets remain
editable and carry documentation/mock/live verification status. Codex OAuth is deferred.

Acceptance: an agent can read only its selected project, propose a real edit, execute once,
recover after interruption and surface a conflict without overwriting newer user work.
Do not stop at a settings dialog or chat-only demonstration.

Current bounded implementation: [reviewed selected-clip moves](AGENT-TIMELINE-MOVE.md),
one saved clip start-frame patch through existing timeline history/replay after
an immutable human review. This does not authorize arbitrary timeline tools,
ripple edits, generation or paid actions; release status is recorded in that report.

The bounded [reviewed selected-clip gain](AGENT-TIMELINE-GAIN.md) increment
is implemented and accepted at local checkpoint `c3c1031` (2026-10-13). It proposes only one
saved known-audio clip's 0–2 linear gain, then uses the existing timeline mutation
and undo/redo after a separate immutable review. It does not measure loudness,
normalize, unmute, render automatically or expand the older Agent catalogs.
Its dated report records the passed final aggregate, synthetic-provider native
and real local media gates. That evidence does not establish a live-model result.

### 2. Make selection and editing dependable

- Source in/out ranges, favorite/reject states, notes/tags, unused filters and jump-to-usage.
- Audio waveforms, aspect/timebase project specifications, useful clip/keyboard operations.
- Import capability reporting; original/proxy mapping, preview-quality controls and bounded
  cancellable cache jobs. Add selected-range render caching where measurements justify it.
- Audio fades/crossfades, voice/music roles, editable ducking and peak/loudness warnings.
  Existing clip gain and mute are foundations, not new features to reimplement.
- Explicit SDR/color metadata handling and preview/export consistency before richer exposure,
  white-balance/contrast/saturation controls. Unsupported HDR/log paths need clear treatment.
  The user confirmed LUT support as a later iteration on 2026-10-14: start with project-managed
  `.cube` 3D LUT files, explicit per-clip enable/strength, persistent source identity, and matching
  preview/export results for a defined SDR input path. Creative looks and Log conversion are
  distinct; complete Log/HDR color management remains a separate scope. LUT support is planned,
  not implemented by the current loudness work, and does not change the agreed iteration order.
- Export preflight, selected-range test exports and playback of the produced artifact.
  Reuse existing immutable render snapshots, fingerprints and output probing.

Acceptance: a representative multilayer project remains usable on a stated laptop target;
select a useful subrange, mix speech/music without clipping, and export the checked range
and full cut using originals with matching timing and sound.

#### Crash recovery and local drafts (approved 2026-10-12)

The user confirmed this iteration on 2026-10-12. The first isolated implementation
now covers [local clip-property drafts](LOCAL-CLIP-DRAFTS.md), verified by the final
independent typecheck/full suite and a rebuilt Linux package crash/recovery/export run.
Origin-independent [last-project selection](LAST-PROJECT.md),
[delivery-name drafts and exact export intent](DELIVERY-DRAFTS.md), and
[shot title/prompt drafts](SHOT-TEXT-DRAFTS.md) have also passed their independent
acceptance stages. The [domain-by-domain scope](RECOVERY-STORAGE-SCOPE.md) records
capacity, plain-local privacy, backup exclusion and unsupported fields; it is not
a claim that all forms or every final keystroke are recoverable.
See the [bounded recovery plan](CRASH-RECOVERY-PLAN.zh-CN.md).

- Persist explicitly supported unsent drafts locally, with bounded capacity, private
  permissions, retention/cleanup controls and visible saved/pending/failed status.
  Exclude credentials, connection tokens and authentication configuration; prompt
  text can still be sensitive. Do not promise every final keystroke survives a crash.
- Restore last-project/editing context through stable workspace/channel identity,
  not a desktop backend's changing HTTP origin. Preserve explicit project selection
  precedence and distinguish saved projects, view state and unsent drafts.
- Present a recovery choice after restart. Bind drafts to target/source identity
  and base revision; compare current data before applying. Reject stale or foreign
  restores and late multi-window overwrites. Preserve the original request ID for
  uncertain submissions; restoring a draft never submits or retries generation,
  spends money, approves an Agent edit, or replaces the existing task ledgers.
- Prove crash boundaries with real owned-process termination, lost acknowledgements,
  changed revisions, corrupt/full storage, channel isolation and subsequent real
  edit/export checks. Keep normal quit evidence separate from forced-exit evidence.

Ship narrow TS/TSX increments after their contracts are reviewed. Mac/Windows
native checks and live-provider verification retain their separate gates.

#### Export configuration, after manual subtitles (approved 2026-10-11)

The user approved this iteration on 2026-10-11.
It followed manual subtitles as a separate delivery slice; it did not expand the
subtitle implementation. The current compatible default remains MP4, H.264
(`libx264`, CRF 23), AAC 128 kb/s, 48 kHz stereo and 30 fps.

1. **First bounded MP4/H.264 settings.** The current implementation slice is
   [EXPORT-SETTINGS.md](EXPORT-SETTINGS.md), with local media checks, fresh production
   builds/package, Linux native acceptance and the independent full gate completed;
   see the [dated acceptance](EXPORT-SETTINGS.md#acceptance-2026-10-11).
   Explicit output presets, quality/rate controls and output resolution now use
   the same UI/API/CLI/MCP services.
   Discover the actual installed encoder's capabilities and reject unavailable
   choices with a useful explanation. Timeline canvas geometry/editing timebase
   and delivery scaling are separate: a delivery-size choice must not rewrite
   clip rectangles, source ranges or stored timeline timing. Frame-rate changes
   require their own explicit conversion semantics; this approval is not a claim
   that arbitrary project frame rates already work.
2. **Additional codecs and containers.** Assess HEVC, AV1 and ProRes; MOV/WebM;
   audio-only and image-sequence delivery; alpha-capable output; and hardware
   encoders independently. Admission depends on the actual encoder/container
   combination, platform, licensing/distribution constraints and native evidence.
   Do not promise every combination or platform, substitute another codec
   silently, or treat an installed binary's name as proof of a working encoder.

Freeze all accepted delivery options in each render snapshot and replay binding.
Absent options preserve old snapshots, receipts and default output semantics.
Unknown outcomes, cancellation and restart must retain the original request key;
recovery must not turn into an implicit fresh export. Acceptance requires real
encoded artifacts and full decode/probe checks for dimensions, frame count,
duration, codec/container and sound, plus explicit unsupported-capability cases.
This work does not require a paid model call. macOS/Windows delivery remains
subject to its separate native gates.

### 3. Connect planning, continuity and generation

- Image generation through the existing managed-asset/job/provider architecture.
- Version comparison, explicit replacement of a timeline source, and video-frame references.
- Reusable versioned character/product/location/look reference entities linked to shots.
  Changed references flag affected shots for review; they never silently regenerate footage.
  The approved decoupled subject/keyframe/motion workflow below defines the staged scope.
- Scene/shot purpose, planned duration and dialogue/voiceover; timed still-frame animatics
  and explicit transfer of the chosen storyboard sequence into Editing.
- Visible generation provenance and reusable recipes/one-parameter variants, built on existing
  job snapshots. Saved seeds/configuration do not guarantee cloud-model pixel reproducibility.

Acceptance: plan a six-shot film cheaply, reuse a consistent product reference, replace one
weak shot while preserving deliberate timeline timing, and inspect the recipe for each output.

#### Decoupled subject, keyframe and motion workflow (approved 2026-10-10)

The first narrow subject-library increment is implemented. Focused checks, final
web/desktop builds and Linux native acceptance passed; the independent full-suite
release gate passed as recorded in [SUBJECT-LIBRARY.md](SUBJECT-LIBRARY.md). Image
generation has an accepted local Mock slice and fixed-OpenAI activation checkpoint
`4e66a96` (2026-10-10), including its affected/build/Linux synthetic-native checks
and full suite (2758 total, 2756 passed, 0 failed, 2 skipped). The current
[custom Images increment](IMAGE-COMPATIBLE.md) is implemented with its
own passed focused/build/Linux synthetic-native and full-suite gate (2857 total,
2855 passed, 0 failed, 2 skipped). Its one independent HTTPS/JSON/PNG slot does not establish
all-vendor compatibility. Motion-reference adapters and Blender integration remain
planned. [Images activation](IMAGE-ACTIVATION.md) preserves the earlier evidence;
it does not establish this custom gate or real-provider acceptance.
Existing managed assets, saved versions, explicit reference bindings and fixed
timeline replacement are reusable foundations. The first usable Linux trial is
already available independently of these stages; native macOS/Windows and live
providers remain unverified. Continued iteration does not block that limited trial.

1. **Versioned subject library and typed bindings.** Add project-scoped, versioned
   character/product/location/look entities backed by selected managed assets.
   Represent subject, style, first frame, last frame and motion as distinct roles,
   with explicit shot/version bindings and saved provenance. A later reference
   version flags affected shots for review; it never silently changes an existing
   clip, frozen job snapshot or generated result. Acceptance: bind one subject to
   multiple shots, change its reference version, review affected bindings, and
   reproduce the exact older selection after restart without hidden propagation.

   **Current narrow stage:** three project-scoped local writes (`subject.create`,
   `subject.version.add`, `subject.binding.set`) and three bounded reads, using one
   existing managed PNG/JPEG/WebP image per immutable version. Only `subject` and
   `style` planning bindings are added, with independent revisions, explicit
   adopt-latest/keep-old review and retained unlink tombstones. Existing
   `reference.attach` remains the separate actual `first_frame` input. Later
   first/last and explicit single-subject generation stages are linked below;
   style/motion consumption remains future work. There is no automatic
   regeneration, identity-lock claim, name editing, delete or new media import.
   Required stable keys extend the local eight-operation namespace to eleven;
   durable UI preparation adds these three writes to the explicit fifteen-operation
   allowlist. Eight independent schema-preservation cases, focused checks, final
   web/desktop builds and Linux native restart acceptance passed; the independent
   full release gate passed. This does not expand built-in Agent tools/
   context or depend on Blender, paid calls or live-provider approval.

Implemented separately: [saved first/last video frames](VIDEO-FRAME-PAIRS.md),
limited to Ark Seedance 2.5 and Mock. The current
[one explicit subject-version video input](SUBJECT-VIDEO-INPUTS.md) accepted
increment adds a mutually exclusive per-submit choice for those same adapters. It does not
consume planning bindings automatically. Style/motion consumption and automated
two-stage workflows remain future work; real-provider verification is separate.

2. **Capability-checked inputs and reviewed keyframe-to-video stages.** Subject
   references and first/last images can be uploaded, extracted from managed video,
   generated as images, or imported from external rendering. Motion references
   can come from any supported managed video source. Validate each provider/model's
   supported role combinations, number/type/size/duration limits and region before
   preparing a request; unsupported combinations require an explicit user choice,
   never silently dropped references or substituted providers. Offer an optional
   two-stage flow: produce/select keyframes, review them, then separately approve
   the exact video input and its cost limits. Acceptance: reject unsupported
   combinations consistently in UI/API/CLI/MCP, retain exact approved assets and
   request identity across interruption, and never submit stage two automatically
   merely because stage one completed. Mock verification is not live certification.

   **Historical first image slice (2026-10-10, baseline `82c70f3`):** a separate
   image composer, shared project-scoped
   image task/group/version/request operations, exact-request recovery and real
   deterministic Mock 1024×1024 PNG assets. The named standard OpenAI image
   preset had an offline-tested adapter and stayed hard-disabled at that checkpoint.
   No image key setting, custom endpoint, live activation, model-tool authority
   or automatic second-stage video submission was added by that slice. Existing library assets
   are reused through explicit timeline/reference/subject edits. Secure image
   configuration and reviewed activation were its immediate follow-on, now the
   active implementation below. See [Image generation](IMAGE-GENERATION.md) for
   the preserved initial evidence and unchanged local/unknown recovery.

   **Accepted Images activation checkpoint (2026-10-10, `4e66a96`):** dedicated fixed OpenAI
   settings and an independent credential, retained exact request reviews and
   explicit visible paid-button approval for at most one POST are implemented.
   The 461-test affected gate, fresh builds and Linux native synthetic-network
   acceptance passed; the independent final full suite passed
   (2758 total, 2756 passed, 0 failed, 2 skipped). This
   is not live-provider or macOS/Windows acceptance. Public API/CLI/MCP gains only
   review prepare/get/list, never approval, credential tools or paid Agent authority.
   Usage-based unknown cost is disclosed rather than represented as a currency
   cap. A live canary still needs its separate exact configuration/media/fees
   approval. See [Images activation](IMAGE-ACTIVATION.md).

   **Current custom Images increment (2026-10-10, offline gate passed):** one separate
   `openai-compatible` / `custom` connection with private settings/key/file,
   canonical public-DNS HTTPS:443 base URL, configured ASCII model and fixed
   single-`b64_json` PNG profile. It reuses the settings/codec/lifecycle and exact
   one-POST UI-approval fence. Saving does not probe; official settings stay
   untouched. Custom v2 reviews retain full immutable configuration/destination;
   schema 18 rebuilds only the review table with raw historical values preserved.
   No new Agent authority, public approval tool, URL download, local ComfyUI,
   model negotiation or automatic fallback is added. No real key/live call/output
   is verified. The affected gate passed 584/584 tests (0 failed/skipped), and
   fresh web/desktop builds passed. Final Linux synthetic-network native acceptance
   and the independent full suite passed (2857 total, 2855 passed, 0 failed,
   2 skipped). See [custom Images](IMAGE-COMPATIBLE.md), including
   the inherited synchronous Keychain/timeout limit; macOS remains unverified.
   Broader plugin design remains separate from this bounded increment.

3. **Source provenance independent of creation tool.** Track external-file import,
   extracted frame, previs render and generated-version provenance as typed,
   versioned source relationships. Optional original project files, including
   `.blend`, are provenance attachments only; they are never needed to open a
   project, bind reference images/video, generate video or edit/export its timeline.
   Acceptance: perform the same source-selection/version-return workflow with
   uploaded media, extracted frames and externally rendered media, without Blender
   installed, while original bytes and old snapshots remain unchanged.

4. **External result return, then optional Blender adapter.** First expose bounded
   managed-result import and explicit version return through shared MCP/CLI
   business services. Validate project ownership, media content, provenance,
   revision and replay identity; returned media never auto-replaces a timeline
   source. An optional later adapter may ask an externally installed Blender to
   rerender a supported project and return a managed result. Do not embed Blender,
   require `.blend`, or make the earlier stages depend on that adapter. Acceptance:
   a non-Blender external workflow imports a new version exactly once, conflicting
   or foreign returns fail safely, and optional rerender failures/cancellation do
   not damage the prior version. External-tool installation/execution and access
   remain explicitly scoped; a project file cannot grant its own permissions.

Dependencies: shared asset/version provenance and request recovery first; bounded
image/frame extraction and role schemas before the optional two-stage UI; current
official provider capability/model-ID review plus profile-specific fixtures before
live integration; external result import before a tool-specific rerender adapter.
Blender is one optional source adapter, not a shared-service dependency. Provider
capabilities may constrain input combinations; the product modules remain
independent. Reference reuse aims for continuity and does not guarantee absolute
identity locking or cloud-model reproducibility. This roadmap approval grants no
live generation, media upload, credential entry or spending authorization.

#### Reference editing, compositing and replacement (approved 2026-10-10)

Extend the reviewed keyframe/version workflow above in this order:

1. Keyframe edits and product/object/background replacement or removal.
2. Mask-based compositing and tracking, with an explicit deterministic-composite
   path distinguished from AI redraw.
3. Person replacement, retaining source provenance and real-person consent records.
4. Precise-identity face swapping as a separate later stage, with its own review
   and acceptance requirements.

Reuse the right dock: preview and explicit confirmation → generation (or local
composite rendering) → comparison → new immutable version. Preserve originals;
reuse exact-request recovery and approved, bounded media inputs. Provider work
requires explicit model/media scope and total budget approval. AI redraw carries
no exact identity or pixel-preservation promise. The current official Aleph 2.0
video/keyframe input contract exposes no hard spatial-mask input; do not present
it as deterministic masked compositing. Recheck capabilities before integration.
See [Runway's official API types](https://github.com/runwayml/sdk-python/blob/main/src/runwayml/types/video_to_video_create_params.py#L43-L181)
(checked 2026-10-10).

This is approved future scope, not implemented by the current subject-library
increment. It has no Blender dependency and does not block the first usable trial.

### 4. Finish and deliver several versions safely

- Unified generation/render/export task states, including unknown submission; no blind retry.
- Count/parameter/available cost disclosure; never label a count cap as enforced currency budget.
- Backup/restore, missing-media checks and portable project bundles.
- One explicitly limited editable timeline interchange format, validated in a chosen NLE.
  Report unsupported effects and baked segments; no universal lossless round-trip claim.
- Named deliverable sequences sharing source assets: landscape/portrait and short/long cuts,
  framing overrides, safe areas and explicit propagation/override rules; batch export later.
- Text/subtitle layers, then optional editable code-based motion templates with sandboxed rendering.

Acceptance: restore a project independently, export two intentional delivery variants, and
open a supported editable cut in the target editor without rebuilding its basic edit by hand.

## Cross-cutting engineering requirements

These apply to every group, not just a final cleanup phase.

- macOS and Windows readiness: isolate paths, process lifecycle, media-tool discovery,
  secret storage, package identity/output, signing/notarization and future update policy.
  Linux tests or a cross-build alone cannot establish native-platform readiness.
- Security: least-privilege Electron, bounded/validated inputs, scoped Agent tools, safe
  network destinations, protected credentials, managed file boundaries and dependency review.
- Structure: identify actual duplicated semantics and oversized components; extract cohesive
  services, hooks and UI components incrementally with behavior tests. Avoid speculative generic
  frameworks and a wholesale rewrite. Keep UI/MCP/CLI on shared business behavior.
- Verification: interrupted/repeated flows, conflicts, process restart, real media outputs and
  runtime screenshots. Record passed, failed and never-run checks separately.
- Every local commit is reviewed and reported with changes/evidence; UI or feature changes include
  actual screenshots. No automatic push, deployment, publication or source-bundle delivery.
- Live inference/generation, real credentials and material uploads require the agreed configuration,
  media scope and budget before integration. Credentials are entered through secure app setup,
  never requested in chat. Signing, release and update publication remain separate approvals.

The concrete code/platform audit is maintained in ENGINEERING-QUALITY-ROADMAP.md.

### Optional extensions and catalog (implementation approved for a later milestone, 2026-10-10)

Follow [EXTENSIONS-ARCHITECTURE.md](EXTENSIONS-ARCHITECTURE.md): keep project data,
assets/versions, task recovery, permissions and paid execution in the stable core;
add bounded connectors, processors, import/export, workflow skills and declarative
right-dock contributions. Start with an extensions manager and official catalog,
then prove the SDK with an optional external ComfyUI connector and a distinct offline
export adapter. Third-party execution needs enforceable isolation and distribution
gates; publishing/review/revocation and a paid marketplace come later. This is planned
work approved for implementation at an appropriate milestone, not an implemented
store. Current Images and trial usability take priority; preserve the existing
delivery order instead of starting an immediate framework rewrite. Third-party
installation/execution, hardware provisioning/access, live calls and store publication
still require separate applicable authorization. This work does not block the first
limited trial or the active image/Agent/editing increments.

## Research references and limits

Sources checked 2026-10-09. They inform workflow decisions, not claims of feature parity.

- [Final Cut range keywords](https://support.apple.com/guide/final-cut-pro/add-keywords-ver68416335/mac)
- [Runway reusable references](https://help.runwayml.com/hc/en-us/articles/52963720640275-Using-reference-media-to-guide-your-generations)
- [LTX storyboards](https://ltx.io/studio/platform/ai-storyboard-generator)
- [Kdenlive proxies](https://docs.kdenlive.org/en/project_and_asset_management/project_settings/proxy_settings.html)
- [Kdenlive rendering](https://docs.kdenlive.org/en/exporting/render.html)
- [Shotcut features](https://www.shotcut.org/features/)
- [Premiere color management](https://helpx.adobe.com/ca/premiere/desktop/correct-color/set-up-color-management/how-color-management-works.html)
- [Kdenlive timeline exchange](https://docs.kdenlive.org/en/user_interface/menu/file_menu.html)
- [OpenCut](https://github.com/OpenCut-app/OpenCut): approximately 93.3k stars when checked;
  main is a rewrite and some advertised API/Agent capabilities remain future work.
- [LosslessCut](https://github.com/mifi/lossless-cut): approximately 44.4k stars; study behavior,
  assess licensing before any source reuse.
- [Remotion](https://github.com/remotion-dev/remotion): approximately 62.7k stars;
  special source-available license, not unrestricted MIT reuse.

Stars are approximate observations, not a maturity or security guarantee. Direct code reuse,
dependencies and distribution licenses require a version-specific review before integration.

## Selection delivery checkpoint (2026-10-10)

The first bounded selection increment is saved per-asset video/audio source
ranges, an independent range revision, and explicit copying of the confirmed
range into a new timeline clip. Verification and limitations are tracked in
[SOURCE-RANGES.md](SOURCE-RANGES.md). The broader selection/editing group above
remains open; one saved range is not a favorites/tags, proxy, waveform, or
native-timebase implementation.

Independent favorite/拒选/neutral asset metadata and explicit local library
filtering were delivered separately; evidence is in [ASSET-DISPOSITIONS.md](ASSET-DISPOSITIONS.md).
The later [current-timeline asset usage](TIMELINE-ASSET-USAGE.md) increment adds
read-derived counts, explicit clip location and an unused-in-this-saved-timeline
filter. It does not count every project or unsaved draft. Tags and notes remain open.
The separate [asset annotation backend checkpoint](ASSET-ANNOTATIONS.md) prepares
bounded project-owned tags/notes with independent revision/replay and schema36/37
backup/restoration. It has no editor or tag-filter UI yet and does not close this
user-facing roadmap item.

## Audio editing delivery checkpoint (2026-10-10)

The first bounded audio edit is optional clip-local fade-in/fade-out using the
existing timeline revision, replay and history contracts. Right Properties
controls target audio files or embedded video audio, with matching local rendered
preview/export. Source playback remains dry. Current validation and limits are in
[AUDIO-FADES.md](AUDIO-FADES.md). The later waveform and three-preset 30fps
[canvas-specification](TIMELINE-OUTPUT-FORMATS.md) increments have separate evidence.
Crossfades, ducking, roles, postmix/loudness checks and arbitrary frame-rate or
resolution expansion remain open.

The bounded audio/performance waveform increment is implemented with opt-in
local raw-source visualization and bounded, disposable derived cache work. Local
verification and the independent release gate passed in `fd49dac`. Limits and acceptance
are tracked in [WAVEFORMS.md](WAVEFORMS.md). This does not complete proxies,
post-mix analysis, loudness checks or the broader audio roadmap.

The bounded delivery increment implements shared read-only timeline export
preflight and an inline right-workspace report. Local browser/native and real
export checks and the independent release gate passed in `168c22d`. It reuses export
rules and source verification without project-format expansion or full upfront
decoding. Scope and acceptance are tracked in [EXPORT-PREFLIGHT.md](EXPORT-PREFLIGHT.md).


## Fixed-source version workflow checkpoint (2026-10-10)

The delivered bounded version-workflow increment is explicit timeline clip source
replacement with preserved timing, layout and audio fades. It uses the existing
revision/replay/history service, with inline source review in Right Properties.
Implementation, local focused/browser/native/media checks and the independent
release gate passed as recorded in [STATUS](../STATUS.md). [CLIP-SOURCE-REPLACEMENT.md](CLIP-SOURCE-REPLACEMENT.md)
tracks scope, acceptance and retained limitations. Visual A/B comparison, automatic propagation and
generation/spending remain outside this increment.


## Original image-generation approval (2026-10-10, historical scope)

The following records the original approved direction. The accepted Mock workflow
and fixed-OpenAI activation checkpoint `4e66a96` have dated evidence, including
activation's affected/build/Linux synthetic-native checks and full suite (2758
total, 2756 passed, 0 failed, 2 skipped). The separate bounded custom slot is now
implemented with its own passed offline/Linux synthetic-native gate. This history is not live-call
approval; current scope is [custom Images](IMAGE-COMPATIBLE.md), with shared
approval/recovery rules in [Images activation](IMAGE-ACTIVATION.md).

After the wired model-input-limit slice, prioritize an independent OpenAI Images
API text-to-image workflow and editable preset. Generated images must enter the
existing managed asset/version storage, with explicit actions to use the chosen
image on the timeline, as a first frame, or in a subject version. Preserve
originals and reuse durable task/recovery, source provenance and budget approval.
A custom base URL is not proof of Images API compatibility. Image editing, masks
and broader reference combinations follow separately; Blender is optional and
this work does not block the verified Linux trial. No live call or credential
configuration is authorized by this roadmap entry.

## Single-PNG editing checkpoint (2026-10-11)

The approved image-editing slice after subtitles/export settings is implemented:
one managed PNG, fixed official OpenAI and Mock, explicit
right-Properties source/prompt review, preserved originals and a new immutable
version. [The exact scope](IMAGE-EDITING.md) excludes masks, multiple sources,
custom-compatible/Comfy editing and identity guarantees. Focused, production
build/package and Linux native checks passed, followed by the final parent gate
(3960 total,3958 passed,0 failed,2 skipped). The first timeout failures and unknown
latency cause are retained in acceptance. Real-provider and Mac/Windows
verification remain separate. Broader image editing, compositing and provider capability work remains
on the existing roadmap rather than being declared complete by this slice.

### Asset annotation editor integration

- Selected-asset tag/plain-text note editor, explicit Save/Discard/Clear/Refresh,
  composed tag filter and four-locale error/status descriptors are implemented.
- Dirty drafts are bounded and retained across selection/filter/navigation;
  uncertain session receipts retain exact request identity and independent
  native-close protection. No automatic conflict merge or timeline undo coupling.
- See [asset annotation UI boundaries](ASSET-ANNOTATIONS-UI.md). Validation is
  component/service based; no new native GUI verification is implied.
