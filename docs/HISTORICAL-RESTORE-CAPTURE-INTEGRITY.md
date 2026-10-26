# Historical restore capture integrity

## Boundary

The current workspace dispatcher now adds a read-only capture integrity gate after the unchanged fixed historical validator for these exact triples:

| Source | Restored profile | Restored schema | Held families |
| --- | --- | --- | --- |
| 24 | restored-local-v1 | 25 | 29 |
| 26 | restored-local-v2 | 27 | 29 |
| 28 | restored-local-v3 | 29 | 31 |
| 30 | restored-local-v4 | 31 | 31 |
| 32 | restored-local-v5 | 33 | 31 |
| 34 | restored-local-v6 | 35 | 31 |
| 36 | restored-local-v7 | 37 | 33 |
| 38 | restored-local-v8 | 39 | 33 |

The gate binds each held-family query, checks exact bigint row identity, recomputes the historical row digest, and compares all five captured identity fields. It reads held rows only. Legitimate new current-origin rows do not require capture holds merely because the new gate exists. Fixed validators remain responsible for catalog admission, bounds, archives, disabled-family rules and epochs, and their earlier diagnostics remain authoritative.

The dispatcher returns the unchanged historical validator result. Ordinary40 and restored41 paths are unchanged. No historical constructor, schema migration, receipt format, package export, execution callback, UI, origin/ownership/invocation/vacancy check or envelope runtime bridge is changed.

## Compatibility details

Digest inputs preserve SQLite column order, exclude only executionEpoch, and include the exact rowid, column name, SQLite storage class and ordinary BLOB-cast length. Null length is the string `null`. Real content uses SQLite `printf('%!.26g', value)` independently of the ordinary-cast length metadata. Content is read in 1 MiB chunks. Negative, zero and greater-than-safe-integer rowids are not rejected merely for their numeric value.

Export reopening uses the saved namespace/request primary key, not a reverse scan over growing receipts. A valid explicit request key can survive a missing receipt exactly as in the historical recipe. Invalid export identity retains `RESTORE_EXPORT_IDENTITY_UNSUPPORTED`; invalid identity shape retains `RESTORE_IDENTITY_INVALID`; missing live row, changed digest or unequal binding uses `RESTORE_CAPTURE_CHANGED`.

The helper is post-validation machinery, not sufficient admission when called alone. Its descriptors are application-owned constants, not caller-provided SQL. Raw historical validators remain unchanged and directly importable; callers deliberately using them instead of the current boundary do not gain the new check.

## Operational scope

The gate runs before openStore returns consumers and registers the private verified store context. Existing startup pragmas and lock work still precede validation, so this is not a promise of zero startup housekeeping writes. Restore candidates can already have been constructed before their independent read-only reopen; rejection prevents publication, not an atomic rollback of historical constructor work. Observed-publication inspection also uses the current validator.

Protection relies on existing immutable triggers and exclusive ownership during the store lifetime. This is not continuous forensic monitoring against hostile same-user/offline replacement. No per-operation full database scan was added.

## Qualification discipline

Baseline: `dc7a057d582c0ef2a6c5316939f6b42be8735987`. Qualification uses only an isolated checkout and pinned Node 24.21.0. Historical source and independent golden hashes are pinned from accepted git objects, never regenerated from the candidate during tests.

Synthetic offline corruption fixtures restore the exact original trigger SQL before validation. They characterize the historical validators and the new current boundary; they are not application write-path or exploit demonstrations. Missing-pointer coverage is counted separately from actual populated-family digest/content coverage. Standalone digest vectors, when present, are not counted as genuine profile content coverage.

No media tools, provider/network execution, GUI, production build, dependency installation or uninspected broad test suite belongs to this qualification. Canonical foundation/browser compiler checks use the unchanged project configs. Focused test results are not whole-product acceptance or real-provider qualification.

Independent source/test review found no blocking correctness issue. The reviewed frozen profile/vector snapshot subsequently passed its final qualification run; initial failure logs remain retained. This is scoped implementation qualification, not whole-product acceptance.

### Coverage boundaries

The synthetic fixture inventory has 248 version-family combinations. Of those, 168 are genuinely populated across the eight exact profiles; 80 receive absent-pointer coverage only. The 496 pointer negatives use two independently verified absent rowids for every combination and are not content-hash coverage.

Populated wrong-hash checks cover all 168 populated combinations. Type-preserving content mutation checks cover 162 combinations. The six LUT import-request combinations have wrong-hash coverage, not isolated mutable-content coverage. Five-field captured-identity mutations cover timeline_requests in each of the eight profiles (40 mutations), with separate export identity cases; this is not an all-fields/all-families identity matrix.

Digest vectors use genuine schema-permitted job-event values for large TEXT/BLOB payloads. Oversized opaque timeline-receipt payloads were rejected by existing envelope admission during fixture development; that earlier validation was not relaxed. Independent fixed constructors supply the captured digest oracle. Initial fixture failures are retained rather than counted as gate regressions or successful coverage.

### Scoped regression qualifications

The exact source guard passes 76 checks: eight frozen constructors, 45 fixed initializer/constant/validation dependencies and 21 independent historical fixtures. New startup/publication/status tests pass 16/16, and fixed-error precedence tests pass 120/120. The genuine-profile dispatcher fixture passes 42/42. Canonical foundation and browser TypeScript checks pass with unchanged configs and repository-local copies of the existing installed dependencies; no dependency installation or compiler-config weakening was used.

Two selected pre-existing assertions remain non-green. Each was rerun once by exact test name in a separate source snapshot of the accepted baseline, and each reproduced the candidate error:

- The restored execution-policy catalogue assertion omits four currently declared operation names.
- The existing ordinary current-schema reopen fixture raises `WORKSPACE_VOLUME_ENVELOPE_INVALID` before any historical capture gate.

No unrelated fix or broad diagnostic followed. The selected boundary/regression batch is 503 passes and two baseline-equivalent failures, not a wholly green regression suite. Full logs, command provenance, initial fixture failures and baseline contrasts are retained in the qualification evidence.

### Final frozen profile/vector result

On Node 24.21.0, the exact final two-file run passes 1,275/1,275 with exit 0. The reviewed fixture, core and vector hashes were unchanged during that run. Together with the separate boundary/regression selections, final scoped qualification records 1,778 passes and the two explicitly baseline-reproduced failures out of 1,780 tests. Initial attempts and baseline comparison runs are not included in those totals.

Run the new bounded checks with:

```sh
node --test tests/workspace-restore-capture-integrity.test.ts tests/workspace-restore-capture-vectors.test.ts
node --test tests/workspace-restore-integrity-source-guard.test.ts tests/workspace-restore-integrity-boundaries.test.ts tests/workspace-restore-integrity-precedence.test.ts
```

Qualification used the pinned Node executable and canonical foundation/browser compiler commands, not an uninspected all-tests or production-build command.
