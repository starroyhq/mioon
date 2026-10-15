# Canonical-conformance repair handoff (read-only inventory)

The UI integration is frozen at 595e7d97ab9824c5911826cd7d6b5f76180cc4e4. No repair below has been implemented. Strict source policy, checkJs, compiler libraries and legacy allowlists remain unchanged. Canonical production staging was not launched.

## Runtime language inventory

Exactly four current runtime `.mjs` paths are absent from `config/typecheck-legacy-sources.json`; all predate the integration and were already present at 99c87a1:

- `packages/contracts/src/timeline-volume-envelope.mjs`: live pure algebra used by many runtime modules, with a `.d.mts` pair. Candidate correction: migrate implementation/types to `.ts`, update imports and remove redundant declaration.
- `packages/business/src/timeline-volume-envelope-filter-candidate.mjs`: actually live through `timeline-audio-filter-graph.ts`, with a `.d.mts` pair. Candidate correction: migrate live typed implementation, update imports/tests and remove redundant declaration.
- `packages/contracts/src/timeline-volume-envelope-candidate.mjs`: production caller is `workspace-frozen-evidence-v40.ts`, despite its dormant header.
- `packages/contracts/src/timeline-volume-envelope-candidate-intent.mjs`: imported by that candidate helper. Candidate correction for both prototypes: replace the frozen runtime caller with existing production validation or a narrow typed helper; move genuinely test-only prototypes under test helpers and update tests. Do not grandfather new runtime JavaScript.

## Validation and boundary cautions

Production `isTimelineRecord` in `timeline-replacement.mjs` already validates envelopes and aggregate timeline size; existing `isTimelineRenderRecord` and `isVolumeEnvelopeProcessingSnapshot` validate receipt/processing evidence. Replacement must preserve negative-zero, malformed-Unicode, bounded-array and 256-KiB record rejection over decoded scanner JSON. Differential frozen-evidence fixtures are required; this is not a blind predicate substitution.

The broad legacy strict-check graph enters through:

- `workspace-volume-envelope-validation.ts`: direct contracts `index.mjs` schemas and `timeline-replacement.mjs` imports.
- `workspace-frozen-evidence-v40.ts`: direct acknowledgement and candidate imports.
- `timeline-volume-envelope-admission.ts`: `workspace-fixed-schema.mjs`, which reaches legacy schema initializers.

Existing typed dependency-injection patterns include `createWorkspaceRestoreProfileV41(initializeThrough24)`, `local-shot-text.ts` validator guards, and `media-streaming-runtime.ts` typed runtime dependencies. A separate repair can pass narrow actual predicates/initializers from existing legacy assembly without replacing validators or adding broad compiler exclusions.

For ES2022 compatibility, the existing well-formed Unicode regex in local-draft/shot-text code is an alternative to new `String.isWellFormed` usage. Preserve lone-high/lone-low-surrogate rejection and valid-pair behavior with explicit fixtures; do not widen global compiler libraries merely to hide the mismatch.

## Preserved diagnostic proof

`baseline-foundation-exact-diagnostic-failure.log` and `foundation-exact-diagnostic-failure.log` each contain 721 diagnostics from the exact foundation compiler command. Clean source-bound b86d0d3 baseline and integration normalized logs are byte-identical (SHA256 671973a109b264ae6e148361dbd65bb684c199e495fa91f5543836946fdeaaeb), with no changed integration file carrying an error. See `baseline-typecheck-comparison.json`. Exact browser compilation passes. Language-policy failure occurs before canonical compiler execution and is separately preserved.
