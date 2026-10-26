# Four-language implementation checkpoint — 2026-10-15

The frozen command and results below retain their historical filenames. For current `.test.ts` execution and type checking, see [TYPESCRIPT.md](TYPESCRIPT.md#current-test-migration-2026-10-26).

This checkpoint implements Simplified Chinese, region-neutral Traditional Chinese, English and Japanese throughout the owned GUI, native application copy and display helpers. It is **not an unconditional cross-platform or full native-layout acceptance claim**.

## Covered modules

- Shared typed catalogs, locale normalization, independent language preferences, trusted IPC, multiwindow updates, native menus/warnings, safe diagnostic boundaries and stable mounted providers.
- Shell/project entry, workspace navigation, assets/references, inspector and subject/style workflows.
- Agent, image generation/editing, provider/connection settings, task status, submission/recovery guidance and unknown-result warnings.
- Timeline, preview, color/LUT, audio/loudness, export/history/delivery, subtitles, source ranges, local draft recovery and translated offline-backup guides.

Per-module inventories and exact exception reasons are in `docs/i18n-coverage-*.md` and `docs/i18n-ui-exceptions-*.json`. CLI/MCP human-readable help remains a separate compatibility phase. Machine contracts, status/error codes, receipts, request identity and user-authored content are unchanged.

## Frozen source and tests

- Base commit: `bbdeec445d1ab5bd60ad47784782e621bb341137`.
- Source manifest: 653 files, SHA-256 `88953ca60ae7b6208307a3ea611a39f9d18740651ad9ef9cd28763ba4de0646d`.
- Composed catalog: 3,362 entries with exact four-locale/key/placeholder parity and duplicate-key rejection.
- AST guard: 665 literal occurrences covered by 641 exact reviewed exception records; zero unreviewed or stale records. Counts are a regression guard, not semantic acceptance.
- Final targeted integration run: **365/365**, repeated independently with the same result. Normal `node scripts/tooling.mjs typecheck` passed twice without changing its configuration.
- Production build and Linux directory package passed. Existing bundle-size and ignored dependency `use client` warnings remain warnings.

Reproducible targeted command:

```sh
node --test --test-concurrency=1 tests/*i18n*.test.mjs tests/desktop-language-broadcast.test.mjs tests/desktop-multiple-window-download.test.mjs tests/desktop-security.test.mjs tests/export-history-ui.test.mjs tests/export-loudness-ui.test.mjs tests/export-sample-peak-ui.test.mjs tests/export-settings-ui.test.mjs tests/named-delivery-ui.test.mjs tests/named-delivery-state.test.mjs tests/timeline-loudness-apply-state.test.mjs tests/workspace-task-origin.test.mjs tests/timeline-audio-preview-ui.test.mjs tests/asset-timeline-usage-ui.test.mjs tests/image-generation-ui.test.mjs tests/comfy-image-ui.test.mjs
```

This is not a full-repository test claim. Earlier owner-specific checks are recorded separately, including explicit historical failures and their focused corrected reruns.

## Actual Linux native observations

- All four languages synchronized across editor and independent settings windows. Traditional Chinese is labelled `繁體中文`, without a region suffix.
- Original project names, stored shot title and prompt stayed unchanged. Synthetic unsaved title/prompt and masked, unsaved connection input remained across switching.
- A pending leave-settings confirmation changed from Simplified Chinese to Japanese without accepting or replacing its pending action. Escape canceled it.
- Japanese native reload/quit warnings displayed localized safety meaning and buttons. Reload was canceled; no request was resubmitted.
- Full-size English/Japanese headers fit at 1178×814. The settings scrollport reached the bottom controls, and Japanese settings were inspected at 1050 px wide.
- The same package and helper exited normally, restarted directly in Japanese before interaction, and exited normally again. Both exits were code 0, no signal, no timeout, with workspace locks released and artifact hashes unchanged. `app-preferences.json` survived as private mode 0600.
- Read-only database comparison found no project/shot/prompt/task/request/receipt changes. One workspace-view preference was initialized and two empty mock-provider tables appeared. No provider request, connection save or model execution occurred.

ASAR SHA-256: `e231334172e47b22c363194e140796a7a3e9b5d77e9b57059be4591fc29818c0`.
Executable SHA-256: `24f81f81475856a908ceeda392f0ac366730370ea71bef0fa9fa1de93faf04ac`.

## Explicit limitations and follow-up

- During an attempted editor OS resize, CUA execution timed out/reset and the app displayed its localized renderer-unresponsive warning. Cause is unconfirmed. The investigation stopped without repeated resize, reload or resubmission; evidence and a separate issue draft were preserved. **Editor narrow-layout acceptance is incomplete.** Follow-up: [issue #4](https://github.com/starroyhq/mioon/issues/4).
- Native 200% zoom is unverified: the existing shortcut did not visibly zoom. No new zoom feature or OS setting was added merely to manufacture a pass.
- Native accessibility observation fell back to X11, so full screen-reader acceptance is unverified. Keyboard language selection and confirmation cancellation were exercised.
- Final-package native menus and OS file choosers were not exhaustively exercised in every locale. Wiring/unit checks and intermediate native observations are separate evidence. OS-owned controls follow the OS language; app-owned titles, primary buttons and filters use the selected application language.
- Native unknown-provider-outcome execution was not exercised. Local component/controller tests cover retained identity and no replay on locale switch.
- No macOS, Windows or real-provider acceptance is claimed. Old issues #1/#2/#3 were not re-investigated.

Local ignored evidence is preserved under `evidence/i18n-final-20261015/`, including the source manifest, package/helper hashes, 15 screenshots, read-only audits, both normal exit records, independent test logs and `acceptance-result.json`. The earlier failed intermediate persistence run remains separately preserved; it is not relabelled as success.
