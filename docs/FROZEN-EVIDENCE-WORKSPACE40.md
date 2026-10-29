# Dormant40/41 frozen role and colour evidence

Later backend activation is documented in [VOLUME-ENVELOPE-BACKEND-ACTIVATION.md](VOLUME-ENVELOPE-BACKEND-ACTIVATION.md). The dated slice evidence below is preserved.

Base: `f6caf840114ca4e1431012a358cca9e8ed5cb8fd`.
This bounded compatibility correction activates no dispatcher, migration, live
mutation, capability, UI, transport or media path. Historical constructors remain
byte-for-byte unchanged. The earlier frozen-inheritance reproduction and review
are retained as dated evidence, not overwritten.

## Exact opt-in and dispatch

The existing role and colour row scanners gain one optional argument:
`frozenEvidenceProfile: 'workspace40-restored41'`. When absent, original SQL,
traversal and current-asset validation branches are retained. Only dormant40
validation at version40 and exact source40/restored41 classification pass it.
Source38 migration preflight deliberately omits it, so an already-invalid38
receipt is still rejected; restored39 is not repaired or reinterpreted.

`frozenReceiptBindingsV40` is a read-only adapter. It receives bounded decoded
JSON after each scanner has used SQLite to reject duplicate decoded keys, including
escaped spellings. It recognizes only a complete root render/export receipt in
`timeline_requests.response` or `exports.data`. The request ID or export ID must
match its physical row. An export's physical project owner must match even when
its bounded SQL projection is null. Root, snapshot timeline, optional frozen asset
project fields, and current asset-row ownership must all agree.

The adapter validates the original envelope/profile, complete strict timeline,
strict render receipt/snapshot/assets, matching revision, typed source metadata,
unique/used asset identities, track/source MIME compatibility and source duration
bounds. It uses existing contracts on disposable projections which remove only
explicitly validated envelope fields and optional validated asset project IDs.
Projection data is never saved, returned, hashed or used as a receipt replacement.
Unknown keys, incomplete wrappers and nested snapshot lookalikes cannot select
this route. The standalone candidate snapshot protocol is not used. The candidate
complete-record validator is reused only to validate envelope-bearing timelines.

The result is an object-identity WeakMap covering only the original snapshot's
actual clips. Every role/colour clip still passes its feature validator. Colour
source hashes and plans must match frozen assets, including hidden clips, and
retained LUT ID, project, SHA and profile checks still use the current immutable
resource store. There is no blanket snapshot-validation bypass.

Current asset-row ID and project ownership remain required. Current cached MIME,
SHA and other `assets.data` fields are neither read nor interpreted by the frozen
binding adapter. Therefore a changed cache is not allowed to rewrite the past.
Editable timelines, history, restored history and non-frozen clips retain current
bindings; unresolved task/proposal intents retain their established lexical rules.

## Limits and assurance boundary

The established maximum is 100 frozen assets, not a smaller invented cap. The
original whole receipt retains its 4 MiB ceiling. Envelope-present snapshots
(including explicit null fields) retain the 256 KiB wrapper ceiling. Historical
no-envelope snapshots retain the existing timeline/whole-receipt limits and may
exceed 256 KiB when valid frozen asset paths make the wrapper larger. Traversal
remains bounded at 200,000 nodes and depth 128; source lookup retains at most 100
bindings per receipt. No current-asset JSON needs materializing for this route.

These are structural, identity and retained-resource consistency checks, not a
signature proving who authored an imported database or an actual-media probe.
A consistently forged entire receipt cannot be authenticated by schema validation
alone. Fixed catalogue/receipt protections and restored capture checks remain
separate requirements; no claim of physical media availability or render safety
is made here.

## Deterministic verification

Pinned Node v24.21.0 SHA256:
`7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.
The focused matrix covers the original repro in both receipt families; absent and
present envelopes; restored41; unchanged38/39 and source38 migration failures;
current cache MIME/hash changes; changed current and frozen ownership; missing,
duplicate and unused assets; frozen hash/profile/plan/source inconsistencies;
strict wrapper and escaped duplicate-key attacks; editable timeline/history
non-bypass; retained LUT ownership/hash/profile; and legacy budget boundaries.

See `evidence/frozen-evidence-v40/` for commands, test counts, scoped strict
TypeScript results and independent review. This is dormant-slice signoff only.
Other processing, admission, mutations, replay, error inventory, media/resource
qualification and activation blockers remain separately owned. The primary 116-test
run uses only in-memory fixtures. The independent initial 154-test run additionally
included the historical38 suite, whose last two cases use disposable synthetic
on-disk workspaces, existing services and backup/restore. No user workspace, media,
install/build, GUI, network push or Mac action was performed.

## Wrapped timeline receipts (2026-10-28)

From schema56 on, shot-sync, scene-split, crossfade, clip-gain, clip-transform
and clip-transition receipts wrap the saved timeline as `{operation, requestId, timeline, ...outcomes}`. The adapter above
treats any receipt with a `timeline` key as a render receipt, so before this
change a wrapped receipt whose timeline had an audio role or a colour made the
role and colour scanners reject the whole workspace. That blocked capability
reads, envelope edits and restore.

The frozen scanners and this adapter are unchanged. For schema56-on roles, the
dispatcher and the restore57–67 classifiers give both scanners
`wrappedTimelineReceiptView` (`workspace-wrapped-timeline-receipts.ts`). That
read-only view shows a wrapped receipt as its bare timeline only when all of the
following hold:

- its `requestId` matches its row;
- its timeline passes the timeline record validator;
- its outcomes carry no role, colour, profile or snapshot keys.

The scanners then check that timeline clip by clip against the current asset rows,
as they check any bare mutation receipt. Any other wrapper is left as stored, so
the scanners still reject it when it carries evidence. Roles before schema56
still read every receipt strictly.
