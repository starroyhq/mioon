# Dormant volume-envelope workspace admission

Based on `72d78150c559a1558580b2288563b7d78e869e18`. This slice enables no
workspace role, migration path, backup source, operation, mutation, capability,
Agent authority, UI or processing dispatch. Existing constructors are unchanged.
Only tests reach the new scanner and exact constructors; the new constructors
form a dormant dependency graph among themselves.

## Scanner interface and evidence

`validateWorkspaceVolumeEnvelopeRows(db, {allowVolumeEnvelopes})` is a read-only,
additive evidence gate. `hasWorkspaceVolumeEnvelopeEvidence(root)` inventories
bounded decoded JSON; it is not a hostile-JavaScript ingress/capture guard.

The scanner reads every retained row in timelines.data, both timeline_history
snapshots, timeline_requests.response, edit_tasks.input, exports.data, both
workspace_restore_timeline_history snapshots, and agent_edit_proposals.definition.
Task status and acknowledgement do not filter the scan.

Positive evidence includes own volumeEnvelope (even null), volumeEnvelopeProfile,
volumeEnvelopeProcessingProfile, volumeEnvelopeSha256 and orphan profileId values
matching the production envelope profile. Envelope-specific error-code namespace
evidence refuses incompatible profiles. Only current INVALID_VOLUME_ENVELOPE and
VOLUME_ENVELOPE_SOURCE_UNSUPPORTED codes are recognized on compatible profiles;
new durable codes must be explicitly registered and reviewed before activation.
Candidate digest, snapshot-wrapper and receipt protocols are not imported.

SQLite finds decoded/duplicate keys before JSON.parse. Cells are projected only
as bounded TEXT, up to the inherited 4 MiB outer ceiling; oversized and non-TEXT
cells refuse without parsing. Relevant schema objects must be real tables, not
views or virtual tables. Malformed unrelated legacy JSON stays with its existing
reader; positive malformed envelope tokens refuse. Complete traversals retain
200,000-node and depth-128 bounds. Envelope-containing timeline/history values
and production frozen snapshot wrappers retain their 256 KiB ceiling.

Complete clip fields use their own retained duration. Historical update intents
can omit duration and use only the fixed lexical frame ceiling (18000), without
requiring a current clip, current duration or source after Undo/removal. Explicit
patch duration still bounds that patch's envelope. Existing strict operation
schemas validate a disposable non-envelope projection. An envelope-only update
uses a validation-only nonempty patch; that projection is never persisted,
hashed, returned or dispatched. Durable arrays are accepted only at the typed
points leaf, with the unchanged 128-node/depth-8/8192-byte limits.

Frozen snapshots require the production profile string, not the candidate
{profileId} wrapper. Frozen MIME/duration/source bounds come from frozen assets;
only current id/project ownership is read. Current cached metadata is not a
probe or source proof. Existing production full/isolated loudness validators
validate retained processing profile/digest identities. All unrelated legacy
record semantics remain the responsibility of the historical readers and exact
schema classifiers; this gate is not a replacement ledger or generic JSON schema.

## Exact dormant profiles

ordinary40 requires exactly 1–24,26,28,30,32,34,36,38,40. Its isolated test-only
initializer accepts source38 only, rejects existing envelope evidence before
inserting40, and preserves all rows, DDL, task sequence storage classes and
immutable receipts. restored41 (`restored-local-v9`) pairs only with source40.
Its independent fixed constructor retains the held evidence, captured epochs,
request vacancies and immutable row-hash/archive rules from fixed38/39.
Historical restored39 is neither reinterpreted nor converted.

## Reuse seams, deliberately not wired

- Pure envelope validation and the production processing-snapshot guard are
  reused as validation, not capability or mutation authority.
- Historical operation schemas provide non-envelope lexical validation. The
  candidate intent capture/digest/receipt module is not reused.
- Existing workspace audio-role, colour, LUT, annotation and receipt-protection
  checks are retained in both fixed new constructors.
- workspace-schema-dispatch.ts still enumerates only through38/restored39; its
  current-role reader, initialize/classify/restore branches, colour options and
  annotation/audio-role assertions do not recognize40/41.
- timeline-audio-role-business.ts still advertises only38/39. The restored
  inspection contract in workspace-restore.mjs still binds audio-role editability
  to39. Neither is widened here.
- workspace-schema-profiles.ts still excludes40 from backup sources and41 from
  restore pairs. Source/restore and inherited annotation/image/colour capability
  lists require a later coordinated activation, not an alias or broad comparison.

## Verification boundary

Only deterministic in-memory SQLite/schema tests and strict scoped no-emit
TypeScript checks run here, using pinned Node v24.21.0. Logs preserve initial
fixture/typecheck failures separately from corrected runs. No actual workspace,
user data, media, GUI, CLI transport, install, build, push or Mac action occurs.
Independent review gave bounded dormant-slice signoff, with 48/48 combined tests
and strict scoped TypeScript passing. This is not activation approval. Integrated
media/resource qualification and full contracts/mutations/history/replay/proof
admission remain separate prerequisites for any activation. The pre-existing
processing combined231/232 result is not replaced by these scoped green tests.

## Inherited frozen-role/colour limitation: activation remains blocked

Independent review reproduced a valid retained render snapshot with envelope +
audioRole:'human', exact production profiles, and frozen video/mp4 metadata. If
the same-owned current asset's cached MIME is now image/png, the new envelope
scanner correctly admits the frozen envelope evidence, but ordinary40's inherited
workspace-audio-role-validation.ts rejects it with WORKSPACE_AUDIO_ROLE_INVALID.
That historical validator traverses snapshot clips and calls getTimelineAudioRoleIssue
using the current assets.data, even after its frozen-snapshot check succeeds.
Unchanged ordinary38 and restored39 call that same validator with roles allowed;
source inspection establishes the same inherited current-cache behavior. No broad
historical diagnostics or old-validator change is needed to establish this seam.

The same independent reproduction confirms colour evidence: valid frozen video/mp4
colour metadata with a same-owned current audio/wav MIME fails the inherited
WORKSPACE_COLOUR_INVALID check. Both production frozen snapshot contracts remain
valid in the repro. See evidence/volume-envelope-scanner/review-frozen-inheritance.log
and its adjacent deterministic in-memory reproduction.

Therefore these dormant constructors are not a claim of full40/41 compatibility.
Before activation, a profile-specific frozen-evidence validation path must preserve
asset/project ownership while interpreting historical audio-role/colour evidence
against the immutable receipt, not today's cache. Do not broaden frozen old
constructors or bypass their validation. This caveat is separate from envelope
scanner correctness and from the separately owned media/resource qualification.
