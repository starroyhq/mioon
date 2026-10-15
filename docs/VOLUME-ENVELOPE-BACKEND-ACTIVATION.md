# Volume-envelope backend activation

Baseline: `99c87a1f6a0a78ecf60d4b2137abfbe963c3ca68`, the docs-preserving child of
accepted integration `63ce0f7fc71121663b8c4c3da73d9fe412a00a42`.
This slice activates backend startup, schema/backup/restore dispatch and opt-in
feature disclosure. It adds no UI, raw drafts, operation, Agent tool or authority.
All workspaces used in qualification are disposable synthetic fixtures. No user
workspace was opened or migrated.

## Exact activation map

- `workspace-schema-dispatch.ts` recognizes exactly ordinary40's
  1–24,26,28,30,32,34,36,38,40 chain and restored41's additional41. Unknown,
  missing, contradictory and restore-bearing ordinary chains refuse. Startup
  finishes the historical ordinary chain then calls the existing fixed40
  initializer. Full envelope row admission precedes migration writes.
- Fixed `workspace-schema-v38.ts` and `workspace-restore-schema-v39.ts` are
  unchanged. Source38→39 restore still uses39; restored39 is never upgraded.
  Source38 migration still uses its original current-cache role/colour semantics.
  An invalid old38 frozen receipt does not become valid through migration.
- Only exact new40/41 callers select `workspace40-restored41` frozen bindings.
  Current ownership and immutable resource checks remain required. All seven
  retained envelope evidence families are scanned, including held tasks and
  captured restore history. Frozen historical MIME/hash interpretation does not
  borrow today's cached metadata.
- `workspace-backup-schema-versions.ts`, `workspace-schema-profiles.ts` and
  `workspace-restore.mjs` admit ordinary40 as a backup source and only the exact
  source40 / restored-local-v9 / database41 pair. Restored41 is not a backup
  source. No historical profile constructor is broadened.
- Annotation schema, LUT reads, PNG/JPEG/colour admission and audio-role feature
  checks explicitly include40/41. Unknown profiles never inherit by numeric
  comparison. Existing operation-specific restored restrictions remain intact.
- `timeline-volume-envelope-admission.ts` validates ordinary40 or full restored41
  for compatible retained reads and domain admission. It is not an invocation
  capability. Missing/forged profiles still produce the existing concrete
  `TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED` error.
- `workspace.restore.inspect` accepts optional literal-true
  `includeVolumeEnvelopeCapability`. Empty historical requests retain their old
  response shape. The optional `{profileId, editable}` disclosure requires
  complete exact-profile validation, including the fixed catalog classifier, not
  marker-only recognition. Invalid, incomplete and old profiles return false.
  An unrelated custom table/view also yields conservative false, without
  changing historical initialization or safe domain-admission semantics. This flag cannot authorize an edit.

## Restored execution is not ordinary execution

Restored41 retains the established explicit origin-pinned local-operation
allowlist, rather than a new blanket read-only policy or new operation family.
Captured evidence remains immutable and held. Existing read-only exact receipt
replay can return an old successful result without executing it again.

For new direct mutations, services parse/freeze the request and require the
verified workspace origin before entering `withRestoreInvocation`. The domain
transaction calls `refuseRestoredOperation` before writes and again inside the
transaction, checking the private live invocation and request vacancy. A new
scalar edit preserving an envelope is subject to the same protections.

The durable coordinator also remains restore-aware. Preparation captures exact
input and validates profile read-only, then checks real store ownership,
project, exact origin, new-only intent origin and held request vacancy before
inserting a current-workspace execution epoch. Execution refuses captured or
foreign epochs, missing/wrong origin and stale instances before claiming. Its
`withRestoreTaskInvocation` rereads the exact dispatching row, claim, instance,
input and digest, verifies the production digest, and creates only the existing
scoped live invocation. Completion/abort revokes it. No caller-provided flag or
capability replaces any of these checks.

Restart recovery inspects only current-epoch claims from an earlier lifetime.
It reconciles an existing receipt or marks an unresolved task unknown; it never
automatically resends a mutation. The user must explicitly execute recovery.
Captured tasks/holds remain byte-identical across these operations.

## Data and transaction invariants

The fixed profile, point count, 128-node/depth8/8192-byte intent limits,
16384-byte task row limit and 262144-byte complete timeline/history/response
limits are unchanged. Render outer limits and processing snapshot limits are
unchanged. No candidate digest, receipt, ledger or generic array permission is
introduced. Descriptor capture preserves absence/null/value and zero hostile
getter/proxy traps.

Genuine owned-store tests cover add/update, role/colour inheritance, source
replacement, shrink refusal and atomic replacement/clear, split, Undo/redo,
retained replay and reopen. At the complete 262144-byte boundary, revision growth
rejects before domain writes, preserving timeline, history, redo branch, cursor,
old receipt and request identity. Bound definite rejection still requires an
entered transaction, callback failure, no started writes, completed rollback,
receipt absence and real ownership. A durable not_applied transition changes
only its authorized task ledger state, not domain/history/receipt tables.

## Qualification and retained history

Runtime: `/workspace/scratch/6877817dff0d/toolchains/node24.21/node-v24.21.0-linux-x64/bin/node`
(v24.21.0), SHA256
`7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.
Final commands, counts, source identities and retained failures are recorded in
`evidence/envelope-backend-activation/qualification.json` and adjacent logs.

Initial failures are preserved rather than relabelled: the first genuine41 read
found the ordinary-only shared guard; full41 admission resolved it without
bypassing restore policy. Initial regression failures included stale dormant40
refusal assertions and historical seeded golden non-TEXT cells. Such cells now
correctly fail envelope admission before migration writes. Original golden
bytes and historical fixed-profile tests remain unchanged; current migration
positives use valid inspected fixtures. The old synthetic policy-seam test source
is retained as dated evidence, while new activation tests never use that seam.
An optional inspection-catalog test failed during import because the MCP SDK is
unavailable here; no transport workflow ran, and no dependency was installed.
It was not retried. The pure tests were rerun separately.
The first scoped TypeScript command omitted `--types node`; the corrected strict
scoped check explicitly supplies it. JavaScript runtime tests are not described
as an all-JavaScript static check.

This source activation does not rerun or supersede processing/media acceptance,
including the retained combined231/232 and isolated diagnostic history. No media,
GUI/native app, transport/readiness loop, long60/600-second acceptance, install,
build, provider/network, publication, GitHub push or Mac action ran here.
UI, local raw drafts and release/package readiness remain separate work.

### Captured-row binding correction discovered during activation

The first actual capability-tamper run was21/22: corrupting a retained hold's
row hash incorrectly still advertised editable. In the staged41 validator,
`WHERE h.kind=?` was prepared but `held.iterate()` omitted the argument, silently
selecting no rows. The corrected new41 loop passes `family.table`; it now checks
each held row's live rowid, immutable digest and captured identity metadata.
The initial red log is retained alongside corrected family-specific tests.
Earlier green origin/epoch tests did not establish this integrity property and
are not substituted for the tamper gate.

Read-only audit found no SQL placeholder in `workspace-schema-v40.ts`, so that
constructor has no analogous missing query argument. The historical fixed39
file has the same old pattern at lines459–460. It is intentionally unchanged in
this bounded activation, and is a concrete separate historical-validation issue,
not a claim that old39 tamper validation is sound. No live user database was
used to investigate either finding. Schema/row-hash consistency is not a
cryptographic authenticity guarantee for an entirely rewritten offline database.

The held-binding matrix explicitly distinguishes66 zero/nonexistent-live-row
negatives across all33 declared families from33 hash/identity corruption cases
across eight actually populated captured families. It does not manufacture
provider records or claim populated content-hash coverage for empty families.
Both matrix classes require unchanged post-validation row/schema snapshots, false
capability and shared admission refusal; hash/live-row failures retain their
exact CAPTURE_CHANGED code, while malformed export keys retain the existing
EXPORT_IDENTITY_UNSUPPORTED diagnostic.
