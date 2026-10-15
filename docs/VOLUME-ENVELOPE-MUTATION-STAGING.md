# Volume-envelope mutation staging (not activation)

This bounded slice adds structural contracts and the existing mutation/history/durable-intent integration. It does **not** enable ordinary40 startup/migration, live workspace dispatch, restored41 writes, capability advertisement, editor/UI controls, or a candidate receipt protocol. Baseline is real local merge `388a0667db0df194b0f12049a58bb003736311fd` of dormant scanner `f6caf840114ca4e1431012a358cca9e8ed5cb8fd` and media-evidence checkpoint `2afd797851f92ffbddec6b923042fc5cf025e9ad`.

## Closed authority boundary

Every envelope-containing intent and aggregate requires the full exact dormant ordinary40 validator, not merely a marker or caller token. Current ordinary38 rejects even explicit null before a durable task insert. Restored41 cannot satisfy this guard. The production dispatcher and restore policy remain unchanged, so a new live timeline service/coordinator on ordinary40 still refuses with `RESTORE_STORE_UNVERIFIED`. A test-only restore-policy exemption is restricted to a WeakSet of fresh synthetic stores and revalidates full ordinary40 each time; it never exempts restored profiles. No ownership check is mocked. The independent real-policy negative verifies no timeline/history/cursor/receipt/task writes.

Durable positive preparation uses a genuine owned disposable store with a coordinator constructed on38, then an explicit test-only40 migration. That demonstrates typed capture and ledger identity, **not supported ordinary40 startup, restart, or a new public execution epoch**. Live restart/unknown recovery, restored execution epochs, inherited role/colour mixed-feature dispatch, and full activation remain later integration gates. Existing legacy recovery regressions still pass.

## Exact contracts and transaction semantics

- `timeline.clip.add` and `timeline.clip.update` preserve absent/null/value and the fixed envelope profile. Update syntax is lexical when duration is omitted; the original clip supplies execution context.
- Durable descriptor-only capture allows dense arrays only at add `volumeEnvelope.points` and update `patch.volumeEnvelope.points`, including the outer preparation shell. Unknown keys, symbols, getters, proxies, custom/sparse arrays, malformed Unicode, undefined and invalid point numbers refuse. Existing 8192-byte input, 128-node, depth8, 16384-byte task-row limits remain.
- Production `hash({operation,input:exact})` remains unchanged. Candidate task/receipt/digest domains are not used. JSON-round-tripped ACK checks compare typed points without generic array acceptance. Split children must agree on presence/null and their exact cut multiplier, not identical point arrays.
- Existing mutation/history/receipt engine handles add, envelope-only update, move/slip, expansion, atomic shrink+replacement or clear, split, replacement, Undo/redo and retained replay. Source replacement preserves points and refuses incompatible metadata; no edit-time probes or verification tokens are introduced.
- Split retains existing fade-cut restrictions and uses the original pure partition/interpolation helper. The inserted cut value is exact; evaluation of a repartitioned line can differ by ordinary IEEE-754 rounding, covered at 1e-15 in the service test.
- Scalar loudness apply preserves envelope evidence and budgets its actual response wrapper. The historical scanner distinguishes the exact existing loudness ACK from a frozen render snapshot at the **root**, before traversal, using canonical ACK validation and retained SQL owner/request/operation bindings wherever present. Payload self-consistency is not independent authentication. Malformed/null/missing application or nested render lookalikes cannot fall back to snapshot validation.

## Pre-write budgets and proofs

Complete final timeline, before/after editable history, and actual response wrapper remain capped at 262144 UTF-8 bytes. Checks include final revision/timestamp growth and also run on ordinary edits retaining envelopes, clear/removal, Undo/redo and scalar loudness. The 256-KiB complete frozen render snapshot guard remains inside the existing render outer cap.

The four concrete durable error codes are `TIMELINE_VOLUME_ENVELOPE_INVALID`, `TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED`, `TIMELINE_VOLUME_ENVELOPE_LIMIT`, and `TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED`. Scanner detection remains broader than the exact admitted code set; unknown namespace codes refuse. Pure/processing error identities remain unchanged and are mapped only at the mutation boundary.

A new definite rejection requires an entered transaction, callback failure, original receipt absence, no started writes, completed rollback, fresh receipt absence and actual store ownership both before and after the final absence check. Its operation/project/request binding is mandatory. Early profile refusal is not a definite not-applied proof. Legacy lazy ensure still writes early; rollback does not erase that fact, and no new proof is produced after it. No legacy proof vocabulary is silently broadened.

## Qualification and retained failures

Runtime: `/workspace/scratch/6877817dff0d/toolchains/node24.21/node-v24.21.0-linux-x64/bin/node`, v24.21.0, SHA-256 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`. No media/GUI/transport/install/build/network/public action was run for this slice.

- Pure envelope/candidate/algebra plus existing timeline contracts:45/45.
- Targeted existing durable-intent/replacement business regressions:64/64. Independent-process/SQLite-writer tests were excluded; no timing retry was used.
- Final reviewed synthetic mutation/scanner/owned-ingress gate:36/36 after the root/family discrimination fix. Focused corrected loudness gate:3/3; full scanner gate:19/19.
- Scoped strict TypeScript checks only the new admission module and changed scanner/loudness TypeScript roots, with `allowJs:true`, `checkJs:false` for imported legacy JavaScript. This is not an all-JavaScript static check; JavaScript changes have runtime coverage.

All persisted gate outputs, including failures, are retained under `docs/evidence/envelope-mutation-checkpoint/`. Initial1/6 was the intended closed live40 restore dispatcher; a specifically authorized test-only seam followed. Subsequent test corrections preserved existing legacy proof behavior, supplied required expectedRevision, and corrected an unjustified bit-exact interpolated-line assertion. The7/8 scalar-loudness failure exposed and fixed real scanner misclassification; it rolled back without definite proof. The100-clip byte test initially changed `muted:false` to true, whose one-byte shrink offset revision9→10; it now uses a size-preserving edit. A mechanical TypeScript conversion typo and an ES2022 library mismatch were corrected, with original logs retained. Independent review further found generic snapshot fallback and nested-snapshot bypasses; root-level canonical discrimination and adversarial regressions close those cases. An intermediate review correction incorrectly applied SQL loudness discrimination to timeline_history; the reviewer reproduced0/1 (chunk a31d29, no file edits), and restricting SQL discrimination to timeline_requests restored genuine loudness history/replay. Independent review then reported no remaining bounded-slice source blockers.

A worker's initial3/3 old38 disposable fixture run completed before a pause reached it, outside the initial in-memory-only gate. It used OS temporary directories and cleaned them; it is nonqualifying evidence retained in coordination output only (session49746/chunk6ca8e9), not relabelled as an approved gate. Subsequently approved checkout-local owned fixtures passed5/5 (session8162/chunkf1840d) and are included in the persisted36-case gate. The earlier34-case pure gate is retained in coordination output (session48695/chunkdf448f) and superseded by the persisted45-case expanded gate.

The separately preserved media checkpoint's combined231/232 evidence and isolated diagnostic remain unchanged. This document is not a release, capability claim, complete mixed-feature acceptance, or permission to enable ordinary40 creation.

## Integrated frozen-compatibility checkpoint

Real merge `63ce0f7fc71121663b8c4c3da73d9fe412a00a42` (tree `be0eed3a2c0e9f7925d09fd1f22a3026123ff4b7`) preserves mutation checkpoint `9240f01c5adaf9516a7238c5f043dec7e53d81c0` and frozen-compatibility checkpoint `4d74c192a1a61a79e5a4354b9edf92927d551d97` without conflicts. Final mutation/scanner/owned-ingress, frozen role/colour, and exact40/41 profile tests passed136/136 on that merged source. Integrated scoped strict TypeScript passed. All six frozen implementation/test hashes match the original compatibility manifest. Source hashes, exact commands and logs are in `docs/evidence/envelope-integrated-checkpoint/`.

This merge makes no dispatcher, ordinary startup, capability or UI change. The historical38/39 constructors, production dispatcher and services remain byte-identical to the pre-feature merge baseline. Frozen historical role/colour compatibility is qualified; live mixed-feature mutation dispatch and live40 coordinator startup/restart are still closed gates. No media, transport, broad suite, or failed-fixture repetition was used for this integration. Raw evidence whitespace is preserved separately from clean source/test/document checks.
