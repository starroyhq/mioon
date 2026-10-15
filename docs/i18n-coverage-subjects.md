# Subject workflow localization coverage

## Covered presentation

- `SubjectLibrary.jsx`: local library, search/type filters, create and append-version forms, empty/loading/error states, page controls, version details, planning-linked shots, accessible names, and image alternatives.
- `ShotSubjectBindings.jsx`: pinned and candidate version review, explicit keep/use/unlink controls, incomplete/unknown links, historical version selection, draft conflict and capacity notices, accessible names.
- `SubjectVideoSelection.jsx`: session-only selection, independently pinned versions, provider/first-frame conflicts, Ark face restrictions, Mock limitations, exact input constraints, and disabled-state explanations.
- `SubjectVideoSummary.jsx`: pinned historical image, latest-version comparison, source description, checksums, IDs, and provenance labels.
- `subject-state.js`: frozen display descriptors for app-owned read/mutation notices. Original error messages are retained only as separate diagnostics; unknown original diagnostics are not primary UI text. Legacy subject kind labels remain stable with a new descriptor counterpart.
- `subject-video.js`: display-only descriptors for warnings, conflict/reference validation and source labels, with legacy raw helper results retained byte-for-byte.
- `use-subjects.js`: reviewed; it has no presentation strings and remains unchanged. Language is not a controller, effect, or interaction identity dependency.

`packages/i18n/src/catalogs/subjects.ts` exports `subjectsMessages`: 147 explicitly authored semantic entries with exactly `zh-Hans`, region-neutral `zh-Hant`, `en`, and `ja`. The shell owner aggregates this fragment with duplicate-key checks. The existing shell tab key `subjects.subjects` remains outside this fragment.

## Preserved boundaries

- Subject and asset names, user drafts, prompts, IDs, original paths, MIME types, version numbers, hashes, raw provenance JSON, immutable snapshots and historical receipts are not translated or rewritten.
- No locale is added to API inputs, persisted business objects, version/provenance records, or request identity. No automatic version selection is introduced.
- Drafts, filters, selected subjects, review actions, unknown outcomes, current request IDs, and existing interaction guards survive a display-language change.
- `subjectKinds`, `subjectKindLabel`, `ARK_SUBJECT_WARNING`, `MOCK_SUBJECT_WARNING`, `subjectVideoConflictIssue`, `subjectVideoReferenceIssue`, and `subjectVideoSourceLabel` retain their legacy semantics. New display callers use descriptor sidecars.
- Raw protocol-error text remains an internal diagnostic with stable `SUBJECT_RESPONSE_INVALID` classification; safe app-owned descriptions render late.
- No provider requests, commits, pushes, deployments, security changes, migrations, or investigation of previous issues #1/#2/#3 were performed.

## Validation

Passed on 2026-10-15: 55/55 tests, 0 failures, 0 skipped, in 4.56 seconds.

Command: `node --test --test-concurrency=1 tests/subjects-i18n.test.mjs tests/subjects-ui.test.mjs tests/subject-video-ui.test.mjs tests/subject-video-recovery-ui.test.mjs`.

Coverage:

- `tests/subjects-i18n.test.mjs`: four-locale key/placeholder parity, catalog integration, and unchanged legacy kind-label behavior.
- `tests/subjects-ui.test.mjs`: original scope/epoch, CAS, pagination, mutation, hidden-callback, and draft-retention tests; new live relabeling tests for drafts/filters, read diagnostics, pending request identity, and retained pinned-version review actions.
- `tests/subject-video-ui.test.mjs`: original immutable-selection, source-content, paid-review, frozen-retry and selector guard tests; new four-locale live selection/provenance rendering and exact descriptor/legacy parity tests.
- `tests/subject-video-recovery-ui.test.mjs`: original exact-acknowledgement, stored-original-request, read-only reconciliation, unknown-outcome and frozen retry behavior; source-extracted App fixture now supplies localization helpers.

The existing custom React fixtures now supply the pinned `zh-Hans` i18n test context. Live cases change only that context while keeping the same component hook slots and controller/request objects.

No unresolved implementation files in the assigned subject scope. Assigned-source `git diff --check` is clean. No build or typecheck was started by this worker; shared integration validation is coordinated separately.
