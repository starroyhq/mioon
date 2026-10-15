# Shell, projects, assets, and inspector localization coverage

Four display locales: `zh-Hans`, region-neutral `zh-Hant`, `en`, and `ja`. User-authored text and native capability contracts are not translated. This is an uncommitted, root-reviewed implementation checkpoint, not final native acceptance.

## Current verification status

- The latest combined 30-file shell/UI/navigation run executed **534 cases: 533 passed and 1 failed**. The failure was a source-only assertion expecting a prop-free `ConfirmationProvider`, not a behavioral regression. After updating that assertion to verify localized labels and the descriptor renderer, the **complete affected `ui-components.test.mjs` suite passed 29/29**. All 534 distinct targeted cases have passing evidence across those two runs; there was **not** a single clean 534-case run. Logs: `/tmp/mioon-shell-final-targeted.log` and `/tmp/mioon-shell-ui-final.log`.
- Subject-owned independent tests passed **55/55**. Parent reported the normal integrated typecheck passing on 2026-10-15 at 08:55 UTC.
- After the 534-case checkpoint, three catalog entries (`assets.usage.savedRevision`, `assets.usage.locationDetails`, `subjects.binding.revision`) were aligned to fully localized revision labels; the English duration tooltip was made count-neutral, and two exact display assertions were updated. Parent is running the consolidated final-copy/all-i18n/native regression batch. Its outcome is not claimed here.
- Production sources and tests are frozen. Final artifact build and real native wide/narrow/200% header/settings verification remain parent-owned and pending. Earlier screenshots are not acceptance evidence for the final artifact.
- No old issue #1/#2/#3 diagnosis or retest was performed. No commit, push, merge, deployment, provider call, or security change was made by this scope.

## Covered surfaces

All filenames in the following lists are under `apps/web/src/` unless stated otherwise.

- `App.jsx`: authentication, project creation/selection/open errors, navigation confirmations, workspace menus and guide, canvas/storyboard chrome, version comparison, generation approval disclosure, import outcome notices, timeline action notices, and task/recovery handoff labels. Language controls occupy existing authentication/editor headers. Stored notices and open confirmations hold descriptors rather than resolved translations.
- Native/Web entry: `DesktopRoot.tsx`, `ProjectHome.tsx`, `ProjectEntry.tsx`, `ProjectHomeConnections.tsx`, `SettingsRoot.tsx`, `EditorWindowOpening.tsx`, `LastProjectStatus.tsx`, `NativeLocatorStatus.tsx`, `TopbarSaveStatus.tsx`. Project/settings language controls preserve mounted form ownership. `LauncherRoot.tsx` and `NativeEditorRoot.tsx` were reviewed and have no own display copy.
- Workspace/canvas: `WorkspacePanels.jsx`, `Nodes.jsx`, `Inspector.jsx`. Controls, ARIA, tooltips, empty states, version history, reference selection, and safe generation status descriptors are localized. `WorkspaceControls.jsx` was reviewed and renders supplied labels without its own copy.
- Asset/reference: `AssetLibrary.jsx`, `AssetDispositionControls.jsx`, `AssetTimelineUsage.tsx`, `ReferenceConnections.jsx`, `reference-connections.js`, `asset-disposition-state.js`, `timeline-asset-usage.ts`, `import-feedback.js`.
- Entry helper messages: `project-entry-state.ts`, `settings-window-state.ts`, `launcher-state.ts`, `last-project-navigation.ts`, `editor-native-window.ts`.
- Subject implementation: `SubjectLibrary.jsx`, `ShotSubjectBindings.jsx`, `SubjectVideoSelection.jsx`, `SubjectVideoSummary.jsx`, `subject-state.js`, `subject-video.js`. See `i18n-coverage-subjects.md` for its separate detailed coverage and tests.
- Catalogs: `packages/i18n/src/catalogs/shell.ts` and `subjects.ts`, aggregated with a duplicate-key assertion. Shell/project/asset/storyboard/inspector/subject messages have explicit four-locale values.
- ProviderSettings and stable provider-ID name mapping are creation-owned; App/Nodes integration is complete. Timeline/export/recovery components are tracked in their owners' coverage documents, not claimed as shell-authored implementation.

## State, content, and diagnostic invariants

- Language is not part of controller, consent, request, draft, scene, selection, pending-outcome, or recovery identity. No `key={locale}` or language-triggered controller recreation was introduced.
- UI-created default shot/note names translate once at creation. Existing names, prompts, project/shot/asset descriptions, subject content, model identifiers, filenames, paths, JSON provenance, hashes, receipts, and history remain unchanged.
- Reference helpers accept an optional display locale while preserving node/asset/shot identity and full user content. Legacy issue strings remain pinned compatibility outputs where needed; GUI consumers use descriptor counterparts.
- Stored import notices preserve confirmed/current/unattempted filenames, counts and uncertainty distinctions. Display sanitization and bounded filename lists do not modify imported filenames or requests. Unknown provider/server diagnostics are not primary UI copy; localized uncertainty-safe summaries are used.
- App error branches use stable codes. Known workspace/storage failures retain migration, original-request, branch-origin and no-auto-retry meaning. Native invalid-project errors carry a display-message sidecar without changing their raw diagnostic or native capability contract.
- `docs/i18n-ui-exceptions-shell.json` contains **55 deduplicated AST literal exceptions**. Each names an exact brand/technical-token reason, or a preserved original diagnostic and its localized GUI consumer. It includes subject helpers plus audited `desktop-window-client.ts`, `editor-window-inputs.ts`, `last-project-client.ts`, and `storage-migration.js`; shared recovery helpers belong to the timeline ledger.
- Mioon branding, provider/model identifiers, file-format abbreviations, SHA-256, KB, seconds-unit notation and version-number prefixes are explicit technical exceptions. Dates and human-readable numeric sizes are display-formatted; wire timestamps and frame/gain/duration payloads are unchanged.
- Missing legacy clip names carry a `clipNameMissing` presentation flag. Only this flag triggers `assets.usage.unnamedClip`; an identical user-authored name is not translated. Clip/request/source identity is unchanged.

## Localization layout follow-through

- `styles.css`: the editor retains its fixed dock header height. Secondary actions use one always-present, localized Actions dropdown with their original callbacks, enabled/disabled semantics and test IDs. Language has explicit narrow-grid placement. Save/recent-project status remains mounted in a compact disclosure. Resizing does not reparent settings or draft owners.
- `project-home.css`: native settings has an explicit flex/min-height/overflow scrollport, making long translated forms reachable without remounting inputs.
- The initial native artifact showed header clipping and missing settings scrolling at 1178×814. Those findings prompted the focused fixes above. Final artifact wide/narrow/200% verification is still pending.
- Source verification of the earlier Traditional Chinese screenshot: `ShotSubjectBindings.jsx` uses `subjects.binding.title` (`主體與風格`); `ShotTextDraftRecovery.tsx` uses `recovery.text.synced` (`標題與提示詞已同步`) and `recovery.text.save` (`儲存標題與提示詞`); `RecoveryStorageDetails.tsx` uses `recovery.common.storageTitle` (`本機儲存哪些內容？`). The old screenshot predates these migrations. Recovery-owned diagnostic sidecars are tracked by that owner.

## Current targeted test coverage

The 30-file combined run covered: `i18n-shell`, `project-home-panel`, `project-entry-dialog`, `last-project-ui`, `workspace-panels`, `project-home-app`, `import-feedback`, `desktop-launcher-root`, `asset-disposition-ui`, `asset-timeline-usage-ui`, `reference-labels`, `reference-ui`, `reference-recovery-ui`, `video-first-last-ui`, `topbar-save-status`, `empty-workspace-mode`, `editor-project-create`, `last-project-app`, `workspace-panel-intent`, `user-flow-navigation`, `right-dock-layout`, `mioon-branding`, `timeline-asset-usage`, `workspace-visibility`, `web-layout-polish`, `asset-usage-navigation`, `client-mutation-app`, `ui-components`, `editor-window-remember`, and `workspace-controls` (all `.test.mjs`).

- Custom JSX/TSX harnesses use pinned zh-Hans contexts without removing behavioral/protocol assertions.
- `i18n-shell` tests catalog and placeholder parity, singular/plural text, preserved reference records/user content, uncertainty notices, stable-code diagnostic mapping and header/settings reachability contracts.
- `project-home-panel` changes language during pending creation and after an unknown/rejected result while preserving input IDs, drafts, metadata versions and request counts.
- `video-first-last-ui` changes all four locales while frame-clear/text-mode approval is pending. Draft title/prompt, revision, frame selection, consent and one-save/no-extra-generation semantics are preserved.
- `workspace-visibility` verifies that language-only updates retain the exact media decoder, playback position and source identity.
- Dialog vendoring tests retain exact pinned upstream hashes. Only documented portal-lifetime and localized-close-label edits are reversed for byte comparison.

### Historical checkpoints (superseded, not outstanding failures)

- Initial project/shell slice: 158/158 passed.
- First integrated shell run: 270/271 passed. The genuine creation-owned first/last-frame descriptor-specificity issue was fixed and subsequently passed in the later combined run.
- Intermediate header/navigation/frame run: 179/182 passed. Three fixture-only mismatches were corrected and are covered by the later combined run. No adaptation remains pending from that intermediate run.

## Source-only browser adapters and explicit exclusions

- New helpers `tests/browser_workbench_actions.py` and `tests/browser-workbench-actions.mjs` open Actions before selecting an existing semantic action ID.
- Updated callers: `browser_flow.py`, `browser_timeline.py`, `browser_ui_components.py`, `browser_dual_workspace_lifecycle.mjs`, `browser_dual_workspace_races.mjs`, `browser_mutation_replay.mjs`, `browser_runway_parity.mjs`, and `browser_timeline_snapping.mjs`.
- Only UI reachability/readiness/focus expectations changed. Startup, CLI, server/process and business fixture helpers were not changed. Python AST and Node syntax checks passed. **None of those historical browser QA scripts was executed.**
- `tests/browser_first_trial.py` remains untouched. Its exact future UI-only adaptation is to open `workbench-actions` before `export-timeline` at line 424 and `jobs-button` at lines 463 and 478. This is an explicit pending source adaptation, not permission to diagnose or rerun the old issues.
