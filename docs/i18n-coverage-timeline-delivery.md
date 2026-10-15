# Delivery, export, loudness and recovery localization

Status: assigned production scope complete. Four locales: `zh-Hans`, region-neutral `zh-Hant`, `en`, `ja`. The lead normal integrated typecheck passed (exit 0, 2026-10-15). End-to-end browser/device acceptance remains coordinated by the lead; this report does not claim those checks.

## Catalog and presentation

`packages/i18n/src/catalogs/timeline-delivery.ts` exports 610 complete entries under `export.*`, `recovery.*`, and `audio.loudness.*`. The timeline owner integrates the fragment into the shared catalog with duplicate-key validation. Every entry has all four translations with matching parameters. Revision labels use 修订版 / 修訂版 / revision / リビジョン; storyboard and retained-history counts use typed one/other templates with numeric display arguments.

All assigned components use the shared `useI18n` context:

- `apps/web/src/ExportHistoryList.jsx`
- `apps/web/src/ExportLoudness.tsx`
- `apps/web/src/ExportRangeControls.tsx`
- `apps/web/src/ExportRangeSummary.tsx`
- `apps/web/src/ExportSamplePeak.tsx`
- `apps/web/src/TimelineDeliveryHistory.tsx`
- `apps/web/src/TimelineDeliveryName.tsx`
- `apps/web/src/TimelineExportPreflight.jsx`
- `apps/web/src/TimelineExportProfile.tsx`
- `apps/web/src/TimelineExportSettings.jsx`
- `apps/web/src/TimelineLoudnessApply.tsx`
- `apps/web/src/TimelineMixLoudness.tsx`
- `apps/web/src/DeliveryWorkspace.tsx`
- `apps/web/src/WorkspaceBackupPanel.jsx`
- `apps/web/src/RestoredWorkspace.jsx`
- `apps/web/src/RecoveryStorageDetails.tsx`
- `apps/web/src/ClipDraftRecovery.tsx`
- `apps/web/src/DeliveryDraftRecovery.tsx`
- `apps/web/src/ShotTextDraftRecovery.tsx`

Dates and formatted display numbers use locale formatters. Original ISO timestamps, `dateTime` attributes, identifiers, media URLs, hashes, protocol codes and JSON are unchanged. Media units, codec names and `.mp4` remain technical notation. User project names, delivery names, text drafts and filenames are not translated.

## Stable display metadata and helper coverage

- `export-display.ts` (new): closed export status codes map to localized labels.
- `recovery-display.ts` (new): structured recovery error codes and branded local errors produce display descriptors, never source-text matching.
- `clip-draft-state.ts`: `errorDisplay` sidecars preserve original diagnostic `error`; ownership, CAS, unknown outcomes, exact discard and cancellation semantics remain unchanged.
- `local-delivery-state.ts`, `local-shot-text-state.ts`: `draftErrorDisplay` and `intentErrorDisplay` are in-memory metadata. Original records, retries, intent receipts, and raw text remain unchanged. Known local validation and unknown backend errors relabel without executing or replaying anything.
- `export-delivery-state.ts`, `export-settings-state.js`: `rateMessage` is derived from frozen settings, alongside unchanged legacy rate strings. Draft capture/name-validation behavior and immutable history remain unchanged.
- `export-preflight-state.js`: issue, capability and error labels derive from stable codes. Only a closed code set remains for preflight issue recognition; arbitrary backend text is not primary copy.
- `export-loudness-state.ts`, `export-sample-peak-state.ts`, `timeline-mix-loudness-state.ts`: display helpers accept a locale; controller errors retain `errorCode` sidecars. Contract reports and fixed measurement/profile IDs are unchanged.
- `timeline-loudness-apply-state.ts`: confirmations are descriptors and identity failures have stable local codes. Exact target, digest, request key, revalidation, confirmation and late-result fences remain unchanged.
- `workspace-backup-ui.js`: locale count/byte/error display, without changing report fields or backup operations.
- `restored-workspace.js`: exported `RESTORE_DISABLED_MESSAGE` and `RESTORE_BACKUP_MESSAGE` descriptors coexist with compatibility reason strings. The shell owner consumes the descriptor exports.
- `workspace-task-origin.js`: adds a display descriptor to the local task-workspace protocol error while retaining the original code, diagnostic, IDs and parameters. App and TaskCenter display the exact identity/retained-request warning.
- `export-range-state.ts`, `timeline-loudness-apply-rpc.ts`, `timeline-loudness-apply-submit.ts`, `timeline-mix-loudness-rpc.ts`: reviewed diagnostic compatibility; the localized GUI preserves original bounds and operation-specific unknown/reprepare guidance.
- `clip-draft-client.ts`, `local-delivery-client.ts`, `local-shot-text-client.ts`: timeline-owner audit confirmed specific stable-code display metadata preserves timeout uncertainty, non-cancellation, unknown protocol outcomes, network ACK uncertainty and restored-branch restrictions. The transport files are unchanged.
- `workspace-origin.js`: reviewed, not changed. Stable codes are rendered by the shell/task owners; diagnostic/reason strings are not primary UI copy.

Language is not a controller lifecycle dependency, business request field or component key. Switching language does not remount, clear a draft, reissue a preparation, repeat an export or resume a request. Unknown backend messages are replaced by cautious localized primary summaries; arbitrary originals are not exposed because they may contain filesystem paths or credentials.

## Offline backup documentation

`WorkspaceBackupPanel.jsx` selects the bundled guide for the active locale. The timeline owner authored `docs/WORKSPACE-BACKUP-GUIDE.zh-Hant.md`, `.en.md`, and `.ja.md` against the unchanged Chinese guide. The original CLI commands, paths and recovery/security constraints were preserved. Downloaded guide filenames are not localized protocol identifiers.

## Regression and new language tests

Targeted serial suite:

- `tests/export-history-ui.test.mjs`
- `tests/export-loudness-state.test.mjs`
- `tests/export-loudness-ui.test.mjs`
- `tests/export-sample-peak-state.test.mjs`
- `tests/export-sample-peak-ui.test.mjs`
- `tests/export-range-ui.test.mjs`
- `tests/export-settings-ui.test.mjs`
- `tests/named-delivery-state.test.mjs`
- `tests/named-delivery-ui.test.mjs`
- `tests/local-delivery-ui.test.mjs`
- `tests/local-shot-text-ui.test.mjs`
- `tests/clip-draft-ui.test.mjs`
- `tests/timeline-mix-loudness-state.test.mjs`
- `tests/timeline-mix-loudness-ui.test.mjs`
- `tests/timeline-loudness-apply-state.test.mjs`
- `tests/timeline-loudness-apply-ui.test.mjs`
- `tests/workspace-backup-ui.test.mjs`
- `tests/i18n-delivery-recovery.test.mjs` (timeline owner)
- `tests/export-preflight-ui.test.mjs` (timeline owner)

Existing transformed React harnesses now use `tests/helpers/i18n.ts` pinned to Simplified Chinese; `tests/fixtures/export-range-ui-harness.mjs` resolves the same context. Behavioral assertions were retained, including exact requests, no-on-render side effects, cancellation, owner/version fences, unknown outcomes, CAS and immutable original rows. Confirmation assertions render the descriptor instead of requiring a string. Date assertions use the actual locale formatter. Unsafe arbitrary backend error strings are asserted absent while the safe primary summary and unchanged download rules are asserted.

`tests/workspace-task-origin.test.mjs` also checks the original workspace-identity diagnostic/code plus four-language retained-ID/no-replacement guidance without changing the envelope.

The new suite validates the full catalog and switches the actual language store for mounted range controls, delivery naming, workspace navigation, recovery disclosures and restored notices. Four added real-controller cases cover shot-text and delivery local validation plus unknown preparation outcomes, preserving state/capture/raw input and exact I/O counts across all four locales.

Consolidated result before final revision/plural copy cleanup: **493/493 passed** across all 19 files with `node --test --test-concurrency=1` (2026-10-15). The log is `/tmp/mioon-delivery-tests-final.log`. Assigned production `git diff --check` also passed. The lead final consolidated post-copy batch initially passed 277/279; two assertions exposed an unextracted history revision template. ExportHistoryList now uses complete preview/export revision templates with the original strict comparison and inputs preserved. The lead is rerunning those assertions plus task-workspace descriptor and narrow frozen-rate adapter regressions.

## Literal guard and remaining acceptance

`docs/i18n-ui-exceptions-delivery.json` contains 110 deduplicated, exact-hash exceptions in the lead's version-1 format. Each names the technical notation or diagnostic compatibility requirement and its localized GUI consumer. The separate `docs/i18n-ui-exceptions-delivery-clients.json` fragment (timeline owner) adds 14 reviewed client diagnostics. No visible prose is covered by a blanket legacy exception.

No assigned production module remains untranslated. Remaining shared acceptance: final consolidated post-copy regression result, combined literal-ledger validation, and browser/device/native-language review. The lead confirmed normal integrated TypeScript checking passed after the narrow frozen-rate display adapter removed the legacy checkJs dependency; no checker configuration was weakened. No deployment, commit, push, provider request or paid model call was performed for this scope.
