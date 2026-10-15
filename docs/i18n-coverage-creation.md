# Creation, Agent, generation and task localization

## Covered renderer surfaces

- AgentPanel, AgentRunActivity, AgentEditProposal, AgentTimelineGain, AgentWorkspace: chat consent and scope, historical/recovery notices, read-only tool activity, immutable proposed before/after content, selection/dirty fences, gain and timeline proposal summaries, buttons, ARIA labels and tooltips.
- ImageGeneration, ComfyImageDetails: local/mock and paid image preparation/approval/recovery, exact immutable source disclosure, known connection rejection codes, disabled Comfy connector, observation state, history and previews.
- GenerationInputSummary and ProviderSettings: model role limits, format/size/count guidance, provider readiness and server configuration instructions; stable provider/model/API identifiers remain unchanged.
- TaskCenter, TaskWorkspace, PendingSubmission: task status, recovered/restored-workspace holds, unknown outcomes, reconcile/cancel/retry controls, dynamically rendered confirmation descriptors and safe diagnostic summaries.
- Connection settings surfaces and regression checks are detailed separately in `i18n-coverage-connections.md`.

## Helper boundaries and reviewed exceptions

- `agent-chat.js`, `agent-edits.js`, `agent-timeline-context.js`, `agent-timeline-gain-context.ts`, `image-generation.js`, and `comfy-image-observation.js` expose display descriptors alongside the original controller messages. Original messages are retained for compatibility, never used as translation keys and never substituted into persisted requests.
- `creation-i18n.ts` maps known statuses and safe error codes. Unknown third-party diagnostic text is not primary UI; only validated stable error codes may be shown under an explicit original-code label.
- User prompts, model output, chat text, project/shot/asset names, model names, provider IDs, protocols, URLs, request identities, hashes, frozen workflow JSON, tool results and backend payloads are not translated or rewritten.
- Model API limits/metadata are rendered from authoritative numeric fields; source profile audit dates retain their precise ISO representation. Provider instructions are selected by stable provider ID, not by matching source-language prose. Backend configuration objects remain unchanged. Missing-variable names are shown only when they are bounded uppercase environment identifiers; arbitrary backend instructions are never primary UI.
- `AgentTimelineGain` owns only Agent proposals. Timeline edit/export/recovery UI and their controllers are owned by the timeline scope.
- All current locale-dependent rendering is outside controller/session construction and effect dependency lists. Confirmations and later completion notices carry descriptors, not frozen translated strings.

## Catalog and tests

- `creation.ts` composes 1129 complete four-locale UI/state/connection/extra entries and runs duplicate-key preflight before spreading. Catalogs use `zh-Hans`, regionless `zh-Hant`, `en`, and `ja`.
- Existing action/payload/safety tests are retained. Legacy transform fixtures use pinned Simplified Chinese presentation; new locale-switch tests use the actual language store and committed component harness lifetimes.
- Clean renderer/behavior run: **250/250 passed, exit 0**, across Agent chat/proposal/gain, image generation/edit, generation input, task center/recovery and `i18n-creation.test.mjs`. This includes actual language-store hot switches with retained drafts/consent/immutable approval targets, no extra controller requests, and actual-provider four-language SSR. Earlier interrupted SSR exploration is superseded by this clean run.
- Subsequent eight-file task-error/mutation/task/generation regression: 84/85 passed; the only remaining failure was a new test fixture using the wrong language-store option name. Corrected to `systemLanguages`; the complete affected TaskCenter dock and sidecar suites then passed **12/12, exit 0**. The other seven files were green in the 85-test run. Source-copy tests now assert exact descriptor calls plus unchanged Simplified Chinese meaning; behavioral assertions were retained.
- Connection worker: 89 targeted checks passed, including draft/password preservation and no automatic load/check/save on language changes.
- Parent verified normal typecheck and Vite/desktop production compile before the latest ProviderSettings coverage expansion. Final integrated checks remain parent-owned.

## Pending verification

- All creation-owned targeted regressions are complete. Final cross-owner checks remain below.
- Full integrated typecheck/catalog integrity and native/browser overflow verification are coordinated by the implementation lead; this scope makes no native screenshot claim.

## Explicit retained-helper display ledger

The fail-closed AST exception fragment is `docs/i18n-ui-exceptions-creation.json`. Its 345 deduplicated records cover 353 current owned source literal occurrences. A fresh inventory comparison reports no unexplained or stale owned records. This is a regression guard, not a claim of semantic/native-layout acceptance. Each record identifies its exact presentation boundary; no blanket "legacy helper" allowance is used.

- `agent-chat.js`: AgentPanel renders `state.displayMessage` and `history.displayMessage`; `agentChatErrorDescriptor` and `agentChatPromptIssueDescriptor` handle known error/validation codes. Original timeline blocking strings remain consent fences; the matching descriptor props provide display guidance.
- `agent-edits.js`: AgentEditProposal uses `state.displayMessage`, `agentEditStatusDescriptor`, and timeline approval issue descriptors. Original messages support existing state-machine/error contracts without becoming translation keys.
- `agent-timeline-context.js` and `agent-timeline-gain-context.ts`: approval/block descriptors and `agentTimelineFrameDisplay` / `agentTimelineGainDisplay` supply the Agent UI. Original strings preserve validation decisions and consent-invalidation identity only.
- `agent-settings.js`: AgentSettings uses descriptor arrays, `agentSettingsIssueDescriptor`, and ID-based preset/platform descriptions. Original diagnostic fields and documentation metadata retain compatibility; documentation UI uses `agent.settings.officialDocs`.
- `image-settings.js`: ImageSettings renders descriptor arrays; key validation has `imageKeyIssueDescriptor`. Unknown save outcomes, key clearing and saved/session storage distinctions retain their full localized meaning.
- `comfy-image-settings.js`: ComfyImageSettings renders descriptor arrays, `comfyConnectorAvailabilityDescriptor`, and `comfyImageCheckDescriptor`. Fixed startup connector availability is not confused with new-generation admission or remote/model compatibility.
- `generation-settings.js`: ProviderSettings consumes provider/input-mode descriptors; GenerationInputSummary renders `selection.displayMessage` and issue descriptors; App/Inspector consume `generationInputIssueDescriptor`. Stable codes and issue paths, not source prose, preserve first/last-frame and subject specificity.
- `image-generation.js`: ImageGeneration uses state, task-status, task-message, connection and validation descriptors. The complete unknown-outcome, billing, cancellation, preparation/approval and no-automatic-retry warnings are localized. Source data, immutable approvals and original request records are not rewritten.
- `image-review.js`: original local approval errors retain their code/message contract. The `approveSaved` caller emits `image.state.paidApprovalUnknown`, `image.state.comfyApprovalUnknown`, or `image.state.editApprovalSourceInvalid`; rejection emits `image.state.rejectionUnknown`. ImageGeneration renders complete uncertainty and no-automatic-reapprove/regenerate guidance, not the raw approval diagnostic.
- `comfy-image-observation.js`: its emitted `displayMessage` is rendered by ImageGeneration. The original message remains diagnostic metadata; query receipt identity and read-only observation scope are unchanged.
- `api.js`: retained `statusText`, `jobStatusText`, and `outputReviewMessage` are superseded at GUI consumers by `statusDescriptor`, `jobStatusDescriptor`, and `outputReviewDescriptor`. ApiError original message/code/details remain diagnostic/protocol data. App.readableError and TaskCenter's stable-code safe summary prevent arbitrary bodies from becoming primary UI; validated original codes are explicitly labelled.
- `submissions.js`, `mutation-submissions.js`, `edit-task-client.js`, `edit-task-controller.js`: local Error/ApiError instances now carry explicit `error.displayMessage`, consumed by App.readableError and live-locale toast rendering. Original error messages/codes, request IDs, mutation outcome proof, receipts and stored bytes remain unchanged. TaskCenter displays localized task-list phase messages plus the explicit local `tasks.error.displayMessage` detail, never raw controller errors. The detail retains workspace identity/original ID/parameter meaning and relabels without a reload.
- Shared `workspace-origin.js` / `workspace-task-origin.js` consumer audit only: TaskCenter forwards stable hold codes and PendingSubmission renders `tasks.unverifiedWorkspace` / `tasks.heldReason`; legacy reason strings only gate controls. DurableTask held rows use `workspaceHeldDescriptor`. App.readableError also maps storage-migration and workspace-origin/restore error codes to their specific safe descriptors. Shared `restored-workspace.js` is owned by delivery: creation surfaces use restored flags and their own localized hold/paused notices, not raw restore constants. These shared files intentionally do not appear in the creation exception fragment.
- Technical JSX exceptions are narrowly identified: Agent and ComfyUI brands/version; exact URL examples; Base URL/Model ID API notation beside localized primary labels; PNG, KB, SHA-256, version marker V and SI second suffix. Hashes, endpoint examples and version identity must not be translated.

## Reproducible bounded checks

- Clean 250-test renderer command: `node --test --test-concurrency=1 --test-reporter=tap tests/agent-chat-ui.test.mjs tests/agent-edit-renderer.test.mjs tests/agent-timeline-gain-renderer.test.mjs tests/image-generation-ui.test.mjs tests/image-edit-ui.test.mjs tests/generation-input-ui.test.mjs tests/task-center-dock-ui.test.mjs tests/task-center-app.test.mjs tests/task-recovery-disclosure.test.mjs tests/i18n-creation.test.mjs`.
- Focused local task-error suite is synthetic and local only. It verifies descriptor parity with original Simplified Chinese diagnostics, all four renderings, original error fields, exact pending input/storage preservation, and absence of additional task calls while relabeling.

- Subsequent regression command: `node --test --test-concurrency=1 --test-reporter=tap tests/i18n-task-errors.test.mjs tests/client-mutation-recovery.test.mjs tests/edit-task-client.test.mjs tests/subject-recovery-client.test.mjs tests/i18n-creation.test.mjs tests/agent-timeline-gain-renderer.test.mjs tests/generation-input-ui.test.mjs tests/task-center-dock-ui.test.mjs`. Final corrected fixture command: `node --test --test-concurrency=1 --test-reporter=tap tests/task-center-dock-ui.test.mjs tests/i18n-task-errors.test.mjs` (12/12).
- `git diff --check` on owned changed renderer/controller/test/catalog/doc files passed. No full parallel typecheck/build or real-provider operation was started by this scope.

- Final visible-template guard review: ImageGeneration's inline revision shorthand now uses the complete four-language `image.studio.savedGenerationRevision` phrase with the exact original revision value. The `/prompt` and `/images/generations` suffixes have separate exact technical exceptions because they expose the actual saved connection destination; no revision shorthand exception was added.
