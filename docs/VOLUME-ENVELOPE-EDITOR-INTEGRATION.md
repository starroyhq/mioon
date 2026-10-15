# Volume-keyframe editor and persistent draft integration

## Checkpoint status

This is a reviewed UI/draft integration checkpoint, **not completed production staging or feature acceptance**. The explicit guarded nonmedia gate passes 519/519 and the exact browser compiler passes. Canonical tooling is blocked by accepted-baseline source-language policy and foundation typecheck failures; the foundation's 721 diagnostics are byte-identical to the pre-edit merge. No production build was launched and no strict policy was weakened. See [qualification evidence](evidence/volume-envelope-editor-integration/qualification.md).

## Baseline and scope

The isolated integration baseline is real merge `b86d0d3f8acd5ead0486ef015114a068e8b4c0c4`, with accepted dormant-editor parent `f8e0873103e918a235a7888052f03600b76bef34` and accepted backend parent `3dd7f10fdb0703ba28d0c419529102fd284c84e2`. No history was flattened. The backend activation contract remains authoritative.

The Inspector mounts a small ordered-row editor beside ordinary audio controls. It uses the existing clip draft controller, existing Save, durable timeline request lane, history and exact-revision sidecar deletion. Opening, typing, composing and restoring do not create a business task, process media or preview audio. A valid replacement curve and duration change are sent atomically; shrinking past a retained anchor is refused unless explicitly replaced or cleared. No auto-sort, crop, clamp or normalization is introduced.

## Compatibility and limits

See [companion format and aggregate qualification](LOCAL-DRAFT-VOLUME-ENVELOPE-FORMAT.md). A frozen legacy v1 and explicit strict v2 share the existing companion filename. Read-only reads never migrate. Only a successful explicit PUT with envelope field presence promotes to v2; other rows, tombstones and revisions are retained. An old reader fails closed and cannot overwrite or repair v2. Unknown data is never represented as an empty clean companion.

The 8192-byte row, 12288-byte HTTP and 2097152-byte raw disk caps are unchanged. Complete outgoing serialization is admitted before fetch, including predicted canonical row and success envelope. The authoritative service still admits actual publication. A refusal retains current form input, displays not-persisted/oversize feedback and keeps close protection. A later refusal cannot erase evidence of a previous unknown write. Transport deadlines, native-close wait and replay rules are unchanged.

## Composition ownership

Transient IME text stays in the input, not the sidecar. The existing controller synchronously tracks pending composition as dirty/in-flight for navigation and native-close admission. Save, row restructuring, restore, ordinary discard, abandonment and close drain cannot pass a pending composition. No blur/unmount event pretends that text was saved or cancelled. Platform composition end performs one lexical decision; invalid text restores the prior field with localized feedback.

Both boundaries are fenced:

1. Controls allocate an opaque composition session and bind rendered event handlers to that session. An old rendered input's change/end cannot adopt a newer same-row session. Start and end before a pending rerender are supported.
2. Inspector maps each session to the controller's opaque owner/generation/serial token. A retained old edit or finish callback cannot commit text or release a newer guard. The controller separately validates token ownership and serial. Ordinary edits retain their render capture.

Capability/connection loss during an already-started composition does not disable the active input or drop its text. Admitted completion remains in memory, and changed unsupported envelope business Save remains blocked. No custom Escape cancellation bypass is introduced.

## External interruption and retained ownership

Auth loss, disconnect or externally replaced workspace cannot unmount the composing editor into a different owner. App retains the original Inspector snapshot in its original JSX slot/key, freezes capability adoption and business entrypoints, and rejects late boot adoption before workspace refs/preferences change. The original input can settle into memory without a sidecar or business write. Retention continues while input is dirty; explicit memory-only abandonment after settlement releases that owner. Login/auth checks are not bypassed: unrelated controls and business dispatch remain blocked. Explicit intentional navigation still follows existing dirty/close protection.

Evidence executes extracted App boot/action entrypoints, the retention function and both event adapters. Fixed subtree position/key is source-checked, not actual DOM reconciliation. No live browser/native IME qualification is claimed.

## Capability, recovery and ACK

Capability discovery is optional, bounded, nonblocking and tied to connection/workspace epoch rather than selected-project boot tickets. Exact profile/workspace inspection is validated. Cached audio/video category and hasAudio are only UI eligibility hints; backend verification remains authoritative. Unsupported recovered curves remain visible and blocked, never stripped. Restored-workspace local companion unsupported status remains separate from established explicit origin-pinned business-operation authorization.

Business ACK validation checks complete expected envelope presence and value even when an unchanged envelope was omitted from the patch. Null differs from absence. Changed text, a later timeline state, a different owner, another-window CAS and a newer sidecar survive late ACKs. Existing unknown-outcome recovery and read-only rechecks retain their request identities and do not retry business mutations.

## Qualification limits

Deterministic React event fixtures, actual controller/service/client/HTTP handler tests and source-bound affected regressions qualify the implemented seams. Native IME event sequencing, live browser layout, keyboard/focus behavior and GUI interactions were not exercised. No native app, real-user import retry, media qualification, provider, installer, download, GitHub or Mac operation is claimed. The initial broad run accidentally executed seven intended synthetic-fixture FFprobe calls during parent seeding; see the explicit [scope incident](evidence/volume-envelope-editor-integration/incidental-fixture-probes.md). That run is not a nonmedia or fully passing qualification.

Review found and corrected two callback-retargeting gaps before acceptance: first the Inspector adapter, then retained Controls handlers. Initial failing fixture runs are retained in evidence; legacy fixtures were extended to supply the new composition API rather than weakening runtime guards. Exact commands, source hashes and final results are recorded in the accompanying evidence directory.
