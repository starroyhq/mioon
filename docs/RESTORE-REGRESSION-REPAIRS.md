# Restore catalogue and ordinary reopen regression repairs

Parent: `c2000a1118c57585cc94a42f53ff6febf86bbec9`.

## Findings and bounded changes

The restored operation catalogue was incomplete, not the exact catalogue-equality assertion. `timeline.audioPreview.continuousPlan`, `timeline.colour.source.inspect`, `timeline.colour.image.inspect`, and `timeline.colour.jpeg.inspect` were already explicitly disabled and refused in the service boundary. They now also appear in the fixed denied catalogue, making restore inspection and catalogue-derived handlers complete. This was a policy presentation/coverage defect, not an execution bypass. No operation becomes executable and no origin or approval boundary changes.

The ordinary current-schema reopen test reused a historical fixture containing an opaque BLOB timeline receipt. Current schema40 admission deliberately rejects non-TEXT receipt cells. The historical `seed(db)` function is byte-identical to the parent. A separate ordinary fixture retains its raw rows, receipt identities, history, events, task, and sequence setup, changing only the timeline receipt to TEXT at initial insertion. Reopen verifies exact schema/rows, raw TEXT, ordinary-40 classification, and absent restoration context. A separate negative test retains the original BLOB, checks the exact admission error and verifies unchanged schema/rows using a read-only connection. No production validation was changed.

## Qualification and limits

Pinned Node v24.21.0; existing local dependencies copied, no install.

- Exact parent reproduction: both named original failures reproduced separately, one failing test each.
- Final fixed-catalogue/refusal checks: 2/2 passed.
- Final ordinary reopen/BLOB rejection checks: 2/2 passed.
- Selected no-network execution checks: 6/6 passed.
- Complete restore schema file: 19/19 passed.
- Restore contracts: 5/5 passed.
- Unchanged canonical foundation and browser TypeScript projects: passed with `--noEmit --pretty false`.
- Independent review: no remaining blocking findings; 83 distinct focused tests passed, including 76 frozen-source checks. Legacy seed byte preservation verified independently.

The final four-file scoped gate passed 256/256 (restore schema, frozen sources, current schema40 dispatch and dormant validation). Together with the six selected execution and five contract tests, the final non-overlapping scoped total is 267/267, zero failures. The combined final four-file scoped gate is recorded in `evidence/baseline-regression-repair/focused-regressions.final.log`; repeated subsets are not additive acceptance totals. This is not whole-product qualification. No provider/network access, media subprocesses, GUI, installation, broad suite, production build, public push, or comments were performed. Historical constructors, golden fixtures, source rules, current validation, and compiler configuration remain unchanged.

Evidence retains initial missing local dependency-link failures, the rejected attempt to rewrite an immutable receipt, and the rejected attempt to use a legacy classifier for current schema40. These are not hidden or counted as final passing tests.
