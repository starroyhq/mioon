# Four-language foundation and native-host coverage

Status: implemented and frozen in the current uncommitted integration branch; **native layout acceptance has explicit remaining limitations**. The 2026-10-15 final candidate includes all owned GUI modules and 3,362 composed four-language entries. The final source manifest covers 653 source/configuration/guide files; the final package and actual Linux observations match that manifest. See `I18N-ACCEPTANCE.md` for exact results and limitations.

## Covered behavior

- One shared, dependency-free typed message catalog with exact locale IDs `zh-Hans`, `zh-Hant`, `en`, and `ja`. Traditional Chinese has no resource-region variants. Self-labels are 简体中文, 繁體中文, English, 日本語.
- System-language normalization accepts script/region OS input while keeping the application locale region-neutral; explicit preference wins and unsupported system languages fall back to English.
- Native language preferences use the existing owner-private bounded atomic-file functions in a separate `app-preferences.json`. Tool configuration saves cannot erase the preference. Projects, databases, backups, task inputs and receipts do not receive locale fields.
- Fixed narrow IPC read/set/subscribe messages; validation rejects extra fields, accessors and unsupported prototypes before reading values. Main validates the current owned main frame and exact committed URL before accepting a request. Native updates are broadcast to trusted windows and rebuild translated native menus.
- Web-only fallback uses one independent application preference key and storage events. Storage failures preserve the session language and display an honest warning; native bridge failures never silently write a separate web preference.
- React updates context and HTML `lang` without locale-keyed remounts. Font families are local display-only stacks, not downloads or exported subtitle/font changes.
- Shared confirmation and dialog close controls render current-language message descriptors without replacing pending confirmation callbacks.
- Native app menus, file-picker titles, app-owned primary button and filter labels, startup/tool configuration messages, storage failure warnings, draft/unknown-outcome/quit/reload/restart/renderer failure confirmations are four-language templates. Button order, default/cancel indexes and action callbacks remain unchanged. Built-in menu roles preserve role-owned shortcuts.
- App-owned transient descriptors render at the view boundary. User text and diagnostic bytes are not rewritten. Unexpected raw diagnostic text is displayed only under a translated “Original diagnostic details” label in native error details, not as the primary message.

## Validation completed so far

- Foundation and native preference tests: 28/28 at the current foundation checkpoint, including malformed preferences, getter/prototype rejection, duplicate catalog keys, exact placeholders, live OS-language refresh, stale broadcasts, real private files, restart and read-only failures.
- Native recovery safety copy: 4/4, retaining original generation reconciliation and no automatic Agent resubmission assertions.
- Focused desktop host/lifecycle/security/secret tests: 253/253 after adapting explicit IPC/bridge allowlists and native text test fixtures. No action or confidentiality assertion was removed.
- Foundation, real native-preference cleanup/restart, and asynchronous-secret allowlist suites passed 67/67 after the shutdown preference defect was fixed. Expanded foundation/catalog/broadcast checks passed 75/75. The post-fix consolidated suite passed 365/365, including all i18n suites, native preference/broadcast/security, export history/settings/delivery/recovery, image generation and Comfy UI. This is a targeted integration run, not a claim that every repository test ran.
- A baseline optional-Comfy lifecycle mock omitted its new environment-mode helper. The test fixture now imports the real helper with an empty synthetic environment; product backend behavior was not changed.
- Typed caller fixtures reject unknown locales/keys and missing/wrong placeholders for both web and native messages.

## Raw-text exceptions and remaining work

- `renderMessage` intentionally passes strings through for user content and staged legacy diagnostic APIs. That behavior is **not** proof of translated coverage. Every remaining app-owned UI string must be migrated or recorded in the per-module ledger.
- The remaining Chinese strings in `main.mjs` are internal exception diagnostics used under the labelled details boundary; backend fixed protocol messages remain unchanged.
- Legacy pure helper diagnostics in business/client modules remain byte-compatible where descriptor sidecars are used by their GUI consumers. The module owner must verify every GUI consumer, not merely count descriptors.
- Full composed catalogs and the strengthened AST ledger passed at freeze: all four locales and placeholders match, with no duplicate keys, unreviewed literals or stale exceptions. This guard is not a substitute for semantic or native layout review.
- Intermediate Linux native package demonstrated all four locale switches across editor and settings windows, translated Japanese restart warning, and Escape cancellation. Its normal quit exposed incorrect deletion of app-preferences.json by transient connection cleanup. The source fix and all-four/system real-filesystem regressions passed, and the rebuilt exact-package Japanese restart subsequently passed with mode 0600 preferences preserved through both normal exits. Evidence from that failed intermediate run is preserved, not relabelled as success.
- Final native multiwindow switching, persistence after restart, dirty/password drafts, pending confirmation behavior and unchanged durable business state passed against frozen final source/package hashes. The first run showed an unresponsive warning during attempted editor resize; that limitation is preserved separately and was not used as a reason to reload or resubmit.
- English/Japanese full-size headers and Japanese narrow settings/scrolling were inspected. Editor narrow layout, native 200% zoom and full screen-reader acceptance remain unverified. No macOS or Windows execution is claimed; available native environment is Linux.
- OS-owned file chooser navigation, system Cancel/overwrite controls and platform services remain native OS UI; application-supplied titles, primary buttons, filters and warnings follow the selected app locale. No custom replacement weakens native cancellation or overwrite checks.
- CLI/MCP human-readable help is a separate compatibility phase. Machine schemas, JSON, identifiers, statuses, retryability, outcomes and receipts remain unchanged.
