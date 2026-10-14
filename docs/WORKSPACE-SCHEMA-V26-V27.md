# Ordinary26 / restored27 paired compatibility

This feature adds one ordinary profile and its corresponding restricted restored
profile. It does not alter the frozen `workspace-fixed-schema.mjs` through24 or
`workspace-restore-schema.mjs` restored25 definitions.

| Source | Exact ordinary markers | Restore target | Exact restored markers |
| --- | --- | --- | --- |
| 24 | 1–24 | 25, `restored-local-v1` | 1–25 |
| 26 | 1–24, 26 | 27, `restored-local-v2` | 1–24, 26, 27 |

Version25 is not an ordinary migration. Existing restored25 workspaces remain
restored25. Mixed25/26, incomplete new marker sets, unknown future versions and
partial restore evidence do not acquire ordinary bootstrap eligibility.

## Additive startup safety protections

Completed ordinary24 startup no longer invokes the frozen constructor, because
its marker writes could execute imported triggers. Both its 24-to26 migration
and an existing ordinary26 reopen instead validate pinned dependencies and
restore missing application-owned safety objects in the same write transaction:
the 36 historical additive triggers and the unique active-chat index. This
covers immutable versions/render/history, timeline/reference/mutation receipts,
chat runs/events/steps, reviewed Agent edits, and source-range/disposition
identity and cross-namespace request protections.

Only static trusted definitions are executed. The 30 dependency-table
definitions and their 37 implicit identity indexes must match; missing tables,
missing quota state, changed or colliding reserved objects, temporary shadows,
or duplicate active chat runs fail closed. No receipt or quota row is recreated.
The separate four edit-task triggers and three task indexes retain their strict
fail-closed schema26 check. Unknown non-colliding custom objects are preserved
and are not executed by repair. Performance-only legacy indexes are neither
recreated nor silently promoted to safety guards; this is not a general schema
repair or permission to reconstruct missing application data.

Each guard family and both ordinary startup paths have causal, raw-value and
rollback coverage in `tests/workspace-receipt-protections.test.mjs`. These
checks do not replace the final full regression or exact packaged runtime gate.

## Fixed construction and runtime boundary

`workspace-restore-schema-v27.ts` owns a separate constructor and reference
catalog cache. Its application-only factory is bound to the historical
through24 constructor, then runs the exact schema26 initializer. It never uses
an evolving latest builder to reconstruct restored25. Imported schema SQL is
compared to trusted definitions, never executed as a migration recipe. The new
fixed classifier rejects TEMP objects so they cannot shadow a capture query.

The restored27 definitions preserve original typed raw columns, rowids,
AUTOINCREMENT sequence rows and high-water marks, receipts, and both active and
redo-tail timeline history. The original edit task rows receive the additive
`executionEpoch='captured'` column and immutable holds. All five inherited
`timeline.loudness.apply` states (`prepared`, `dispatching`, `unknown`, `applied`,
`not_applied`) remain held. Restore and reopen do not resume them.

A v27-only insertion guard prohibits new apply tasks even with the correct
current origin. Existing permitted local edits and exports retain their narrow
explicit-origin route. Historical apply receipt reconciliation uses the operation-specific
read-only ACK validator. The current timeline identity, revision and structure,
and historical asset/shot/version database ownership remain mandatory. A
historical clip may have disappeared or changed gain; replay does not read
media files, hash sources or run a decoder. An absent receipt does not
authorize execution.
Neither restored profile can create another recoverable workspace backup.
Cold capture also rejects positive partial-restore evidence with the existing
`RESTORE_BACKUP_UNAVAILABLE` diagnostic before creating an output directory.
This bounded, main-catalog-only artifact check does not assign a role or
execute imported objects: contradictory ordinary26 markers remain invalid for
startup. Unknown markers without restoration evidence retain the ordinary
unsupported-schema backup refusal.

## Offline and public contracts

The existing offline filesystem workflow remains responsible for cold capture,
private destinations, separate locks, fixed file budgets and no-clobber
publication. Only its fixed schema dispatch and version disclosure are extended.
For source26, backup inventory and verification require the exact new marker
set and migration-owned task structure while retaining unrelated unknown
objects byte-for-byte, consistent with historical cold archive semantics.
Offline restore27 separately requires the complete fixed ordinary26 catalog,
so an archive containing an unrelated custom journal may verify successfully
and still be refused for restoration. Verification proves archive integrity,
not restore compatibility or a completed restore exercise. Backup format1 and historical DTO field sets are unchanged;
the source-version union adds only26. Restore result, publication status and
runtime disclosure admit exactly the two pairs above, never their cross-product.

`integrity:'verified'` still means backup integrity was verified;
`restoration:'not_tested'` is unchanged. A restore exercise is a separate result.
No automatic cold-backup orchestration, online backup API, lease handoff,
permission expansion or user-machine execution is added. Stopping the backend,
creating/verifying a backup, and starting the new application remain separate
operations, with no claim of an uninterrupted lease or no intervening writes.

Failure rollback is a logical SQL/raw-value/constraint guarantee. SQLite/WAL
pages or file layout are not promised to be byte-identical after migration.
Offline backup tests separately assert unchanged source and backup tree bytes
and modes because these are copied without opening the original SQLite file.

## Dedicated evidence so far

`tests/workspace-backup-marker-bounds.test.mjs`,
`tests/workspace-backup-restore-evidence.test.mjs`,
`tests/workspace-restore-backup-boundary.test.mjs`,
`tests/workspace-restore-v27.test.mjs` and
`tests/workspace-schema-dispatch.test.mjs` passed 76/76 serially on 2026-10-14,
with no failures or skips. The focused strict TypeScript check also passed.
Coverage includes actual cold create → verify → restore → status → reopen for
both 24→25 and 26→27; typed raw and large-integer preservation; Mock variants;
four injected construction rollback stages; incomplete/mixed marker, unknown
DDL and TEMP rejection; read-only readiness; and recursive backup refusal. A real verify-path observer
confirmed that 2 MiB TEXT/BLOB marker cells become NULL before crossing into
JavaScript. An unrelated unknown journal survived actual 24→26 startup and
both cold archives byte-for-byte; fixed27 restoration still refused it before
creating a destination. The partial-restore diagnostic regression was first
reproduced using an isolated copy of the prior capture decision: current26
incorrectly surfaced `WORKSPACE_BACKUP_IO` instead of the established
`RESTORE_BACKUP_UNAVAILABLE`. The fixed gate retains that original assertion
and adds both 24/26 partial table, case-folded name, guard and epoch evidence
cases, plus unknown-marker and ordinary unknown-journal controls. The causal
red and successful run are both retained in the feature evidence.

Three historical wire validator files are retained byte-for-byte from baseline
`f8b91713af0c8ed3994e32fa57447827a0ab3883` with a committed hash manifest. Tests
check that they still accept old 24/25 results and fail closed on 26/27. This is
source-validator evidence, not a claim that an old packaged desktop binary was
run. The full historical golden suite, aggregate regressions and
production/native gates belong to the enclosing feature gate.

The separate `tests/workspace-restore-apply-replay.test.mjs` gate passed 9/9
with no failures or skips (23.37 seconds). It performs actual stereo-WAV/FFmpeg
measurement and public `createServices` durable apply, removes the historical
clip while keeping valid current database ownership, cleanly stops, creates
and verifies a cold26 backup, restores27, and reads/lists/replays the held task.
The original ACK still replays after deleting the restored media file. Current
timeline absence, identity/revision mismatch and historical asset-owner
mismatch remain failures. Four corrupted ACK envelopes are rejected without
rewriting their retained bytes. Captured execution/reconciliation and fresh
restored apply are refused; the original source and backup trees remain
byte-and-mode identical throughout.
