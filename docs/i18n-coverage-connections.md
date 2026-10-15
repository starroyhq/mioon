# Four-language connection settings coverage

Date: 2026-10-15. Local implementation and synthetic tests only; no provider/network calls, installation, deployment, or real credential use.

## Covered presentation surfaces

- `AgentSettings.jsx`: all headings, fields, ARIA labels, tooltips, placeholders, key-clear notices, storage availability/reasons, save intent, recovery actions, and read-only/approval/compatibility disclosures.
- `ImageSettings.jsx`: official/custom slots, endpoint restrictions, dedicated-key/storage policy, payment admission scope, key-clear notices, current state, save intent, and reconciliation notices.
- `ComfyImageSettings.jsx`: module availability versus new-generation admission, explicit read-only checks, checkpoint selection, fixed workflow/options, unsandboxed-runtime and compatibility limitations, save/recovery scope.
- `agent-settings.js`, `image-settings.js`, `comfy-image-settings.js`: transient `displayMessages` descriptors alongside unchanged legacy `message` diagnostics. All controller notice branches have descriptors; no translated strings are stored in controller state.
- Agent preset names, regions, descriptions, Qwen protocol caveat, and platform warnings are selected by stable provider/platform/protocol IDs. Documentation links retain original verified URLs and use localized generic “Official documentation” labels. Brand and protocol names remain technical names.
- `generation-settings.js`: new descriptor exports for provider availability/status, input modes, profile selection state, input issue codes, generation-input validation, and subject-input validation. Existing string APIs and diagnostic messages remain intact for compatibility. `generationProfileSelection` adds a display descriptor without rewriting evaluation/receipt objects.
- `packages/i18n/src/catalogs/creation-connections.ts`: 321 four-locale entries, semantic connection/Agent-settings/image-settings namespaces; complete zh-Hans, region-neutral zh-Hant, English, Japanese.

## Lifecycle and data boundaries

- `useI18n` is presentation-only; locale/t/renderMessage are not dependencies of sessions, visibility lifetimes, saves, checks, or request handlers. No locale-keyed remount.
- New key-clear notices are descriptors. Changing locale does not clear or replace password input DOM; existing hide/leave/project-change clear behavior is unchanged.
- Source content, user names/models, endpoint URLs, model/checkpoint IDs, provider IDs, protocol values, numeric inputs, request bodies, configuration revision/CAS, immutable receipts and historical diagnostics are not translated or mutated.
- Unknown generation issue codes display a localized safe summary plus a bounded uppercase machine code. Arbitrary diagnostic text is not used as a translation key or echoed through this descriptor API.
- Removed one Agent settings fallback branch comparing Chinese diagnostic text; it now checks stable known error codes.
- Legacy source strings remain intentionally in helper diagnostic APIs. Their presence is not an untranslated UI path in these three settings pages.

## Validation

- `node --test tests/agent-settings-ui.test.mjs tests/image-settings-ui.test.mjs tests/comfy-image-ui.test.mjs`: 84/84 passed, including three new four-language lifecycle tests.
- `node --test tests/i18n-connections.test.mjs`: 5/5 passed. Complete locales/placeholder parity, all catalog entries render, secret-free validation descriptors, provider/platform ID-based text mapping, unknown-code bounds, no untranslated CJK literals in the three components, no locale lifecycle dependency/remount.
- Existing harnesses now use shared `tests/helpers/i18n.ts` with zh-Hans pinned by default. Source-copy assertions read localized catalog text; safety/behavior assertions remain on original source and controllers.
- Full `node scripts/tooling.mjs typecheck` was run once; completed with no reported diagnostics. Final all-owner typecheck/build belongs to integration lead.
- An exploratory combined generation-input run had 92/97 passing before harness adaptation. Remaining `generation-input-ui.test.mjs` failures were handed to the creation integration owner: provider/summary harness imports and SSR error output. Do not count that run as final passing generation UI QA.

## Remaining integration and QA

- Integration complete: App/Inspector/ProviderSettings and GenerationInputSummary now consume the generation descriptor exports. The settings worker made no App/main/desktop edits; integration was performed by their owners.
- Broader ImageGeneration and generation-input helper wiring is completed in creation integration; its clean 250/250 renderer/behavior run supersedes the exploratory 92/97 generation-input run above. See `i18n-coverage-creation.md` for the exact command and additional error/consumer boundaries.
- Real-browser layout, 200% zoom, native-window language synchronization, native accessibility, and real-provider behavior were not exercised in this subtask. No external service compatibility or real generation is claimed.
- Known stopped issues #1/#2/#3 were not re-diagnosed.
