# CLI/MCP presentation localization

Base: `e87fa309ed0a604657dcdf6bddc768c1c10eb2a1`. This is a local implementation checkpoint; the exact commit is recorded in Git.

## Scope and compatibility

- Main CLI help options, connection guidance and safety copy; detailed errors owned by its argument parser.
- MCP initialization instructions, three discovery-tool descriptions, and all 96 operation descriptions.
- Four explicit launch locales: `zh-Hans`, `zh-Hant`, `en`, `ja`; Traditional Chinese is labelled 繁體中文 without regional variants.
- No locale supplied means exact legacy output, including mixed-language descriptions. `--locale en` opts into English. The new option is documented in `I18N.md` and explicitly localized help; legacy help is intentionally unchanged.
- Locale is not persisted or inferred from OS/environment settings. It never enters RPC input or workspace identity and does not cause a retry or replay.
- Machine JSON keys, input schemas (including embedded prose), schema discovery, effect annotations, identifiers, call-result envelopes, receipts, statuses and exit codes are unchanged.
- Main CLI parser errors after a valid locale option have localized detail. Other CLI stderr errors have a localized safe summary plus labelled, unchanged sanitized original diagnostic. Parser errors before the locale option remain legacy English. No arbitrary backend text is used as a translation key.
- MCP launch/transport diagnostics remain English, including invalid workspace-origin errors with an explicit locale. MCP call errors remain unchanged protocol JSON.
- The separate backup command and developer/doctor scripts are not localized in this phase.
- No audio module, `audio.preview` message, timeline audio catalog or `App.jsx` change.

## Validation and exact-candidate relationship

- Pure parser/help tests: 4/4 passed. Exact default-help byte snapshot; all locale forms; JSON/input identity; invalid locale rejection; localized parser errors without machine-error changes; all operation descriptions without mutation of definitions.
- Main CLI transport compatibility and RPC non-replay tests passed with 30-second per-process ceilings. CLI parity case took 160.6 seconds across repeated launches. The fixture observed exactly one project-create request per locale and unchanged user content, with no locale field in the request.
- MCP final frozen-candidate offline transport test: 1/1 passed, 5.7 seconds total. Checks all four locales, tool names, schemas, effects, initialization instructions and unchanged schema-call envelopes.
- Existing i18n catalog/AST integrity suite: 5/5 passed after terminology corrections. Checks complete four-locale/placeholder parity, no CJK in English, unchanged UI exception ledger and semantic-key coverage.
- Standard `node scripts/tooling.mjs typecheck`: passed both normal projects.
- Final `node scripts/tooling.mjs build --channel=production`: passed, including both typecheck projects, web build and desktop production staging. Existing-style module directive/sourcemap and large-chunk warnings remain; a source build is not native packaging/signing/UI acceptance.
- `git diff --check`: passed.

The initial new transport harness used 5-second startup budgets (3 seconds for its RPC fixture), below the observed baseline startup under host scheduling delays. Three transport cases timed out; the catalog case passed. These attempts are not claimed as regression acceptance. The bounded budgets were corrected to 30 seconds with no change to any historical test.

A subsequent combined run passed 7/8 tests. The MCP comparison held an earlier in-memory Japanese catalog while its child read a just-corrected file, causing a real string mismatch. Source was then frozen and only that MCP test was rerun, passing. The final catalog-only changes affected MCP Japanese descriptions, not previously passing CLI outputs. No whole mixed-snapshot run is represented as all-passing.

Dependency preparation reused only existing pinned dependencies. Repository guards rejected external compiler links and new `.mjs` application paths; helpers were converted to typed `.ts`, and the reviewed dependency tree was copied inside the isolated clone. No dependency versions, package installs or downloads were added.

## Review and size

Independent description review covered 96/96 operations and safety/numerical qualifiers. Five Japanese replay phrases were corrected to mean reproduction of the original result rather than re-execution. English frame-result recovery now refers to a task receipt rather than authentication credentials.

Final web JavaScript is 3,274,352 bytes. Compared with the pre-existing baseline workspace artifact (not rebuilt in this task), this is +85,497 bytes; consistent gzip level-6 measurements are +26,891 bytes. This is an artifact comparison, not a controlled baseline rebuild. The two new source catalogs total 90,210 bytes. No bundle optimization rewrite was attempted.
