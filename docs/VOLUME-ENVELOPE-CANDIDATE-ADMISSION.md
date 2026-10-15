# Dormant volume-envelope candidate admission

This is a Node-only, standalone contract experiment, not an editable feature.
The candidate modules have no package exports or production callers. Existing
operation schemas, catalogs, workspace markers, migrations, durable coordinator,
render/continuous/analysis responses and all DSP remain unchanged. Ordinary40
and restored41 are still reservations, not installed profiles.

## Candidate intent and task

`captureVolumeEnvelopeCandidateIntent(operation, input, context)` accepts only
clip add/update. It captures enumerable own data properties before any schema
projection or serialization, rejects proxies before reflection, preserves exact
absence/null/value, and never normalizes the returned input. Only the operation's
single `volumeEnvelope.points` or `patch.volumeEnvelope.points` path accepts an
ordinary dense 1–16 element array. All other arrays, nested arrays, custom
prototypes, getters, symbols, undefined, non-finite/-zero numbers and malformed
Unicode fail. The existing 128-node, 8-depth and 8192-byte input ceilings remain.
A non-null update needs the resulting duration (patch duration takes precedence,
otherwise caller-owned prior duration); this is not a source eligibility check.

Historical schemas validate a detached projection without the envelope field.
An envelope-only update uses a temporary scalar sentinel solely to satisfy the
historic nonempty-patch refinement. The sentinel never appears in returned,
hashed, saved or dispatched input. Empty original patches still fail.

`isVolumeEnvelopeCandidateEditTask` validates the complete historical task shell,
original candidate input, project/request/lane/status identity, 16-KiB row budget
and a candidate-domain SHA-256 of the complete canonical input and operation.
That new digest cannot be mistaken for an existing durable ledger digest. No
candidate task is admitted to the live coordinator; its generic `plain()` walker
still refuses every array and its historical schema refuses this new field.
The helper is not a workspace compatibility token or an authority grant.

## Complete evidence

The companion record helpers validate strict detached complete timelines with
only typed tracks/clips/subtitle-cues/envelope-points arrays. They retain the
256-KiB complete record cap, then validate the historical projected record.
The standalone snapshot is exactly `{timeline, volumeEnvelopeProfile?}`;
`volumeEnvelopeProfile` is exactly `{profileId:"mioon-clip-linear-attenuation-v1"}`
and is required iff any clip has non-null automation. It is not a production
render or continuous snapshot schema.

The complete snapshot and receipt wrappers, including their metadata, also stay
within 256 KiB; fitting the inner timeline alone is insufficient.

Candidate mutation-record validation covers add/update/replacement/split and
explicit expected-history undo/redo. It requires the original pre-mutation
record, not a current record after Undo, and checks untouched clips and exact
envelope-derived shapes. A record alone contains no request ID, so its payload
binding is not proof of receipt identity or provenance. Add/update additionally
have `isTimelineVolumeEnvelopeCandidateMutationReceipt(operation,input,value,
{previous})`, a separate candidate receipt envelope with original request ID and
exact candidate intent digest binding. Neither evidence format confers authority.

Aggregate capture throws a candidate budget error with measured bytes and the
unchanged limit, without mutating the input or calling any stateful writer. This
is pure no-effect refusal, NOT proof of a real transaction's atomicity and NOT a
`mutationOutcome: "not_applied"` receipt. Live admission still requires an owned
transaction, exact original request-bound definite rejection, and unchanged
prior state/history/receipt on failure. No such transaction is added here.

## Still required before activation

- Workspace evidence scanning, exact compatible-profile dispatch, historical
  receipts, durable migration/admission, complete replay and transaction proofs.
- Source eligibility: cached metadata is only a conservative hint. No edit-time
  probing or caller-provided inspection tokens. Replacement preserves automation
  and rejects incompatible sources rather than stripping points.
- Actual processing must verify/reject incompatible audio before output, including
  muted, zero-gain, cached-no-audio or all-zero-envelope clips that an audible-voice
  list might otherwise omit. A separately bounded required-verification set is
  needed; source checks cannot depend only on audible voices.
- Frozen legacy V1 audition must explicitly refuse non-null automation. Its old
  schemas/validators are deliberately unchanged here, not made envelope-aware.
- Actual continuous/render/full-mix/isolated response identities and whole-shape
  budgets, source processing, sample algebra, draft raw-text retention and UI.

No media, GUI, CLI transport, production build, installation, push or timed
acceptance loop is part of this slice. Narrow deterministic tests do not claim
live playback, rendering, source verification or durable feature acceptance.

## Local verification

Pinned executable:
`/workspace/scratch/6877817dff0d/toolchains/node24.21/node-v24.21.0-linux-x64/bin/node`
(`v24.21.0`). Both new modules pass `node --check`. The following combined
`node --test` run passes 31/31 with no skips:

- `tests/timeline-volume-envelope-candidate-intent.test.mjs`
- `tests/timeline-volume-envelope-candidate.test.mjs`
- `tests/timeline-volume-envelope-pure.test.mjs`
- `tests/client-timeline-replacement-response.test.mjs`

The fully populated 16-point/colour fixtures measure 4600 bytes, 98 nodes,
depth 4 for add and 4609 bytes, 99 nodes, depth 5 for update. These are measured
fixtures, not a proof that every hypothetical complete record fits. Complete
100-clip records and standalone snapshot/receipt wrappers are separately tested
at 262143, 262144 and 262145 bytes. Direct hostile receipt-boundary probes assert
zero executed getters/proxy traps. Historical replacement client tests remain
passing. Independent read-only review findings on context safety, snapshot
wrapper bytes and request binding were corrected before the final checkpoint.
No whole-repository typecheck or full suite was run; the new code is MJS and
verification here is syntax plus the explicitly listed runtime tests.
