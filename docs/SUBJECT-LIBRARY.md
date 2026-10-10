# Local versioned subject library

Updated: 2026-10-10 UTC. Baseline: `1b08cf2`.
Status: implemented. Focused checks, final web/desktop builds and Linux native
restart acceptance passed. The independent full-suite release gate passed;
The final gate recorded 2,418 total /2,416 pass /0 fail /2 skips. Local commit
and distribution are separate actions.
The first usable Linux trial is already available independently of this work.
Native macOS/Windows and live-provider behavior remain unverified.

## Scope and boundaries

A project can retain named `character`, `product`, `location` and `look` subjects.
Each immutable subject version freezes the metadata of one existing, owned,
managed PNG/JPEG/WebP image. Creating a subject also creates version 1. Adding a
version advances the subject head and its independent revision once; supplying
the current head's asset rejects with `SUBJECT_NO_CHANGE` without a write.

This is local planning metadata. Binding a subject does not supply provider
inputs, promise identity locking or regenerate footage. There are no new media
imports, byte copies, file probes, subprocesses, paid calls or Blender dependency.
Subject names and kinds cannot be edited, and there is no subject/version delete.
Existing `reference.attach` / `reference.detach` still govern the actual
`first_frame` input. Subject bindings support only `subject` and `style`;
`last_frame`, motion references and richer provider-role adapters are future work.
Built-in Agent tools, context, inspection DTOs and approval scope do not expand.

Existing image assets and result lineage stay authoritative. Original media,
shot selections/revisions, timeline clips/history, generated versions and frozen
job snapshots are not changed by these operations. A binding pins a subject
version even after the library head advances.

## Strict shared inputs

The runtime schemas in `packages/contracts/src/subjects.mjs` are authoritative.
All operations require the chosen project's UUID; unknown fields reject.

| Operation | Required fields in addition to `projectId` |
| --- | --- |
| `subject.create` | `kind`, `name`, `assetId`, `requestId` |
| `subject.version.add` | `subjectId`, `expectedRevision`, `assetId`, `requestId` |
| `subject.binding.set` | `shotId`, `subjectId`, `role`, `subjectVersionId`, `expectedRevision`, `expectedSubjectRevision`, `requestId` |
| `subject.list` | none |
| `subject.version.list` | `subjectId` |
| `subject.binding.list` | exactly one of `shotId` or `subjectId` |

- `kind` is `character`, `product`, `location` or `look`; `name` is a nonblank
  string of 1–120 characters. No caller-supplied provenance is accepted.
- Record IDs are UUIDs. All three writes require a stable caller-retained
  `requestId` of 8–200 characters. Subject inputs are capped at 8 KiB and saved
  subject responses at 16 KiB.
- Version-add `expectedRevision` is the positive current subject revision.
- Binding `expectedRevision` is its independent revision, or `0` if that exact
  shot/subject/role identity has never existed. `expectedSubjectRevision` is the
  positive current subject revision. Neither value is a shot revision.
- Binding `subjectVersionId` is required: an owned version UUID selects it;
  explicit `null` clears it. Omission is not a clear operation.
- All three lists accept optional `limit` (integer 1–50; default 20) and `cursor`
  (opaque nonempty string, maximum 768 characters). Binding filters are XOR:
  missing both or supplying both rejects, rather than reading the whole project.

## Response DTOs and provenance

Create and version-add each return a subject directly:

```text
{id, projectId, kind, name, revision, headVersionId, headVersion, createdAt, updatedAt}
```

`headVersion` is a subject-version DTO. Its `id`, `subjectId`, `projectId` and
`number` agree with the subject's `headVersionId`, `id`, `projectId` and
`revision`. A version-list item has the same complete DTO:

```text
{id, projectId, subjectId, number, assetId, sha256, mimeType, width, height,
 provenance: {kind, versionId, shotId, jobId}, createdAt}
```

`sha256` freezes the existing asset record's lowercase 64-character image hash;
subject operations do not independently rehash or probe the file. `mimeType` is
`image/png`, `image/jpeg` or `image/webp`; width and height are positive integers
up to 100,000. The backend derives `provenance.kind` from existing owned asset
metadata: `user-import`, `generated`, `synthetic-mock` or `export`. Validated
result lineage uses the local generated-version, shot and job UUIDs in
`provenance.versionId`, `shotId` and `jobId`; otherwise all three are `null`.
These local IDs are not provider task IDs. The DTO includes no paths, URLs,
provider identifiers, raw snapshots, credentials or media bytes. Metadata/lineage
validation does not read, rehash or probe the image file.

Binding-set returns a binding directly; binding-list items use the same DTO:

```text
{id, projectId, shotId, subjectId, role, revision, subjectVersionId,
 reviewedHeadVersionId, headVersionId, subjectRevision, needsReview,
 createdAt, updatedAt}
```

All list responses are `{projectId,items,nextCursor}` with `nextCursor:null`
at the end. Lists are bounded, non-creating reads, including when no subjects
exist. They do not initialize timelines, repair metadata, update access times,
execute tasks or contact providers. Binding-list includes retained cleared rows.
Pass the returned cursor unchanged with the same operation, project, filter and
limit. Signed cursors expire after backend restart. Each page has a consistent
read transaction; multiple pages are keyset traversal, not a frozen snapshot.
Refresh from the first page after mutation when a fresh complete view is needed.

## Binding review and explicit choices

`look` accepts only `role:'style'`; the other kinds accept only
`role:'subject'`. There is one retained identity per shot/subject/role and at
most eight active bindings per shot across both roles. A cleared row does not
consume an active slot. Role mismatch and a ninth active binding reject with
`SUBJECT_ROLE_MISMATCH` and `SUBJECT_BINDING_LIMIT` respectively.

The selected version and the reviewed library head are separate:

```text
needsReview = subjectVersionId !== null && reviewedHeadVersionId !== headVersionId
```

A new subject head derives review flags without updating every binding or
changing its chosen version. The user can explicitly:

1. Adopt latest: set `subjectVersionId` to the current `headVersionId`.
2. Keep the selected older version and acknowledge latest: send that same older
   `subjectVersionId` with current binding and subject revisions.
3. Select another exact historical version, with those same revision checks.
4. Clear: send `subjectVersionId:null`.

Every successful fresh binding-set advances its binding revision once and saves
`reviewedHeadVersionId` as the current subject head, so its acknowledgement has
`needsReview:false`. A later head can flag an active binding again. Clear retains
a revisioned tombstone rather than deleting identity; clearing an identity that
never existed creates its revision-1 tombstone. Reattaching uses the retained
revision, not `0`. Replay never increments it again. A stale subject or binding
revision rejects; never replace current user choices by silently adopting latest.

## Exact replay and ownership

`subject_requests` is an immutable companion in the existing backend-wide local
mutation key namespace. This extends the eight local operations to eleven:
`shot.create`, `shot.update`, `shot.reorder`, `node.create`, `node.update`,
`version.select`, `asset.range.set`, `asset.disposition.set`, `subject.create`,
`subject.version.add` and `subject.binding.set`. The original six keep their
optional-key and keyless behavior. Timeline, reference, generation and export
journals retain separate namespaces; this is not deduplication across all work.

The business change and saved exact original response commit in one synchronous
transaction. Exact replay rechecks owned project/asset/subject/version/binding
relationships, then returns the historical response before checking revisions
for a new edit. It can therefore return an older head or binding; refresh current
state separately. Changed operation, project or complete input under a retained
key conflicts. Duplicate receipt placement, missing/foreign ownership and
corrupt/oversized retained data fail closed, never becoming a new mutation.
Subject versions, bindings/tombstones and successful receipts are retained;
no cleanup silently deletes them.

After transport loss, malformed success, an ownership/authentication failure or
a generic 4xx, keep the exact operation, full input and original key. Shared
acknowledgement validation binds the result to that operation and input.
Only a verified fresh, pre-write rejection after confirmed rollback may provide
`mutationOutcome:'not_applied'` with the matching `operation`, `projectId` and
`requestId`. An error code alone cannot settle a prior unknown attempt. No client
or startup action automatically retries a POST. A later intended edit needs a
fresh key and freshly read revisions; recovery needs the original complete input.

## Durable UI task admission

The explicit durable allowlist grows from twelve to fifteen operations:

- `timeline.track.add`, `timeline.track.update`
- `timeline.clip.add`, `timeline.clip.update`, `timeline.clip.replaceSource`,
  `timeline.clip.remove`, `timeline.clip.split`
- `timeline.seed`, `timeline.undo`, `timeline.redo`
- `reference.attach`, `reference.detach`
- `subject.create`, `subject.version.add`, `subject.binding.set`

The new `subject:mutation` lane uses the existing prepare-before-dispatch
coordinator. Persist the exact project, operation, full input and original key
before attempting a subject edit; failure to prepare blocks dispatch. Retained
pending tasks can be discovered after a new backend/window lifetime. Listing,
startup, opening a card or reconciling a receipt never executes an edit. Explicit
recovery uses the stored intent and current backend lifetime nonce; acknowledgements
bind the task digest, exact revision and terminal result. No generic RPC/MCP/Agent
task-execution operation is introduced. External callers still retain their own
original input/key; direct RPC does not automatically create a UI task.

The unchanged limits are 8 KiB input, 16 KiB logical reservation per task,
4,096 retained identities and 64 MiB logical total. Capacity failure happens
before business dispatch. There is no silent eviction of unresolved identities,
terminal key bindings or business receipts. A reviewed retention/compaction
policy remains unresolved; this is not a SQLite/WAL disk-size guarantee.
Task parameters and subject metadata are ordinary local SQLite data, not
vault-encrypted. Do not put secrets in names or other local text. User-authored
names remain untrusted text even if they contain paths, URLs or instructions.
The fixed task
allowlist excludes credentials, arbitrary files/paths, provider configuration,
model requests and media bytes. See [task recovery](TASK-RECOVERY.md).

## Schema 15 and acceptance gate

Schema 15 adds `subjects`, `subject_versions`, `subject_bindings` and
`subject_requests`. Extending SQLite's fixed task operation/lane constraints
also requires a transactional `edit_tasks` rebuild. The migration must preserve
all original columns and input bytes, positions and sequence high-water mark,
and restore its immutability, retention and transition protections. Existing
business rows, timeline/reference/local receipts and original response bytes
must not be normalized or rewritten. A failure must roll back the whole schema-15
step; a successful reopen must be idempotent.

Checkpoint: eight independent schema-preservation cases, focused checks, final
web/desktop builds and Linux native acceptance passed. The independent full-suite
release gate passed.

Acceptance coverage and retained release requirements:

- Fresh versus upgraded schema equality; populated legacy task byte/sequence/
  protection preservation; injected migration failure rollback and safe reopen.
- Strict schemas and DTO parity across real HTTP, CLI and official MCP SDK;
  bounded list/cursor behavior, read-only state and unchanged Agent catalog.
- Revision conflicts, eight-binding limit, role checks, tombstones, older-version
  selection and explicit keep-old acknowledgement without hidden propagation.
- Exact replay after later edits/restart; companion-key collisions and retained
  ownership/corruption handling, without returning foreign data or rerecording edits.
- Durable prepare/claim/commit/ACK faults, capacity refusal, app/window recreation
  with pending discovery and no automatic execution, and same-key explicit recovery.
- Current UI draft/navigation fences, unchanged first-frame inputs, immutable media
  hashes, unchanged shots/timeline/jobs, and no provider invocation, media upload
  or paid generation.

### Verification checkpoint

Focused selections passed: domain 132, recovery 86, recovery transports 16,
App 112 and final UI 169. These selections overlap and must not be summed into
a full-suite total. Delayed-acknowledgement monotonicity and UI-preview fixes
passed their regression checks. Eight independent schema-preservation cases
also passed.

Final web and desktop builds passed with identical staged renderer assets.
The final web JavaScript SHA-256 is
`7f8ed0f436be5caa1b6703068346ce474b8c0e46a3ba466e750864c2fad01f78`.

Linux native acceptance created V1 and pinned it to two shots, appended V2, then
explicitly adopted V2 on shot 1 while retaining the older choice on shot 2.
A fixture-injected transaction rollback left an unknown durable task. The original
native process exited with code 0. A new app/backend lifetime rediscovered the
exact retained input and key; audited rows and original media were unchanged
before explicit recovery, with no automatic subject edit. One explicit recovery
created one V3 and one receipt, then the same task became applied and acknowledged.

Shot pins, legacy assets/jobs/versions/exports, reference/history records, the
original timeline and original media remained unchanged by that recovery.
A separate empty timeline arose from the navigation fixture's legacy startup
behavior; it is not evidence of a subject operation changing a timeline.

The isolated native fixture used synthetic media with live providers disabled.
The UI invoked no generation/provider operation, and legacy jobs/versions remained
unchanged. No packet capture was performed: this is not a claim of zero network
attempts; normal loopback HTTP and local media reads remain part of the UI.
Subject business operations themselves perform no file/probe/provider work.
Native macOS/Windows and live-provider behavior remain unverified. The independent full-suite release gate passed;
these results remain separate from platform and live-provider certification.

### Release-gate fixture correction

The first independent aggregate reported 2,417 total /2,413 pass /2 fail /2 skips.
Both failures were obsolete expectations: the global read-effect fixture omitted
the three subject read services, and the Agent Inspector-key fixture assumed JSX
prop ordering. Test-only corrections preserve effect boundaries and evaluate the
unchanged remount key behavior; an added regression verifies both protocol
catalogs and rejects every subject operation through both built-in Agent scopes.
The affected selection passed67/67 with no skips. Production, builds and native
evidence are unchanged. The subsequent independent full-suite gate passed.

The second aggregate reported2,418 total /2,415 pass /1 fail /2 skips in an
existing real-socket SSE test's setup. Its50ms timeout began before socket
saturation and could expire before the test's required precondition; the log
does not establish the exact abort cause. A test-only clock correction preserves
real TCP backpressure/close and adds causal49ms-alive/50ms-destroyed assertions.
The18-case SSE suite passed six serial runs; adjacent HTTP/SSE/shutdown checks
passed33/33 with no skips. Production and native artifacts are unchanged. The
subsequent independent full gate passed.

### Final independent release gate

The third parent aggregate passed: **2,418 total /2,416 pass /0 fail /2 skips**,
exit0,476659.942547ms. The full log is retained as ignored
`evidence/subject-library/parent-final-full.log`; both prior failed aggregates
and the focused corrections remain beside it. Only acceptance documentation and
source seals were updated after this final run; production/tests are unchanged.
