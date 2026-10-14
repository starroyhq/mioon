# Durable local edit recovery

Updated: 2026-10-10 UTC. Baseline: `837002f`.
Status: the original twelve-operation slice passed its independent release gate.
The fifteen-operation subject extension passed focused checks, fresh builds and
Linux native recreation acceptance; its independent full-suite gate passed.
This is not platform certification.

## Scope

The original released slice covers twelve operations:

- `timeline.track.add`, `timeline.track.update`
- `timeline.clip.add`, `timeline.clip.update`, `timeline.clip.replaceSource`,
  `timeline.clip.remove`, `timeline.clip.split`
- `timeline.seed`, `timeline.undo`, `timeline.redo`
- `reference.attach`, `reference.detach`

The subject-library extension adds three explicit operations and a separate
`subject:mutation` editing lane: `subject.create`, `subject.version.add`, and
`subject.binding.set`. Its implementation and acceptance status is tracked in
[Subject library](SUBJECT-LIBRARY.md). That extension brought the coordinator to fifteen fixed operations. The later [timeline output format](TIMELINE-OUTPUT-FORMATS.md) slice appends `timeline.format.set` under `timeline:mutation`, for sixteen total. The three explicit `timeline.subtitle.add`, `timeline.subtitle.update`, and `timeline.subtitle.remove` operations brought the total to nineteen, sharing `timeline:mutation`. The explicit `timeline.loudness.apply` operation is now the twentieth entry in that lane; its scalar durable intent and exact receipt use the [atomic apply contract](TIMELINE-LOUDNESS-APPLY.md). Its dual CAS/pristine-state gates apply; this grants no model tools or generic service dispatch.

The eight local canvas/asset metadata mutations and `timeline.render` retain their
existing session-based UI recovery paths. Generation, retries, exports, imports,
waveforms and Agent proposal approvals are not routed through this coordinator.
Their existing domain records and authorization rules remain separate. In
particular, no new built-in Agent or MCP execution tool is introduced.

## Durable intent, separate from business replay

A dedicated backend ledger retains the selected project, operation, exact caller
input and original request ID before dispatch. These fields and their digest are
immutable. A task ID identifies the recovery envelope; it does not create a new
workspace-global mutation-key namespace. The existing timeline/reference journals and the subject companion in the
eleven-operation local-mutation key namespace remain authoritative for original
successful response bytes and atomic changes. These are separate namespaces,
not workspace-global deduplication.

Prepare commits before acknowledging or attempting the business mutation. An
admission/persistence failure blocks dispatch. Repeated prepare with the same
identity must match operation, project and exact input. A new intent cannot
silently inherit an unresolved task in its editing lane.

Only explicit execute invokes the existing shared business handler. It runs
outside an outer asynchronous transaction; the existing handler rechecks project
ownership and replay inside its own synchronous transaction. A backend lifetime
nonce prevents delayed callbacks from a former backend from executing into a
new backend lifetime. Explicit recovery obtains the current nonce and uses the
same stored operation/input/key.

Receipt-only lookup validates the exact request hash and the existing historical
ownership boundary. It never invokes a mutator to discover whether it happened.
Historical reference attach no-ops, absent/rebound detached edges, and removed or
changed timeline clips keep their existing valid replay semantics.

### Schema 15 extension

The subject extension creates new metadata tables and transactionally rebuilds
only `edit_tasks` to extend its fixed CHECK lists. The rebuild copies all nineteen
columns without parsing or reserializing input JSON, preserves exact sequence
positions and the SQLite high-water mark (including absence), and recreates the
existing indexes and immutability/state-transition triggers. The version marker
is written last in that same transaction. Failure rolls back the new tables and
rebuild together; startup does not execute an intent. No existing task limit is
raised and no old receipt is rewritten. Older app versions are not certified to
open a workspace after this migration; use a separately retained pre-upgrade copy
when testing an older checkout.

## State and recovery

`prepared` means this coordinator has not dispatched the intent; it cannot prove
that another authenticated interface never used the same original request key.
A claim is persisted before dispatch. An uncertain outcome stays `unknown` unless
a validated original receipt establishes `applied`, or the existing scoped,
request-bound rollback proof establishes `not_applied`.

Startup can reconcile a retained receipt and mark abandoned claims unknown. It
never executes an edit. Listing, opening a task or importing a legacy receipt
never dispatches. GET/list are noncreating and do not persist access timestamps.
Only the active exclusive workspace owner may prepare, claim or reconcile writes.

Every transition has a monotonic revision. Terminal outcomes cannot regress.
Acknowledgement binds task ID, intent digest, exact revision and terminal status,
not the reusable editing-lane key. Late responses cannot clear a newer request,
replace current Inspector drafts, or restore a historical timeline into the view.
Missing/corrupt ownership or receipts remain uncertain and cannot expose foreign
project content. No automatic POST retry follows a transport error.

## Bounds and privacy

Initial admission limits are 8 KiB of exact input, a 16 KiB logical reservation
per retained task, 4,096 retained task identities and 64 MiB total logical
reservation. These are coordinator limits, not new limits on legacy direct RPC
schemas or a guarantee about SQLite/WAL file size. List pages default to 20,
maximum 50; full timeline response copies do not belong in list pages or the new
ledger. Existing family receipt bounds still apply at detail/recovery.

Capacity exhaustion must fail before mutation and identify the retained-record
limit clearly. There is no silent eviction of unresolved identities, terminal
key bindings or existing business receipts. A reviewed completed-task
retention/compaction policy remains a requirement before long-term high-volume
use; it is not implemented by this trial slice.

Task inputs are local ordinary SQLite data, not vault-encrypted. The fixed
allowlist excludes credentials, files, paths, provider configuration, model
requests and media bytes. Existing workspace privacy validation remains in force.

## Task Center and legacy sessions

The existing drawer is extracted into a cohesive Task Center without changing
workspace layout. It distinguishes durable local requests from generation tasks
and session-only recovery. Loading/error states cannot masquerade as an empty
pending list. Opening Tasks, switching project/tab or collapsing the workspace
must preserve the existing draft/navigation fences.

A surviving session receipt in the explicit durable-operation allowlist can be explicitly
adopted under its original complete input and key. Adoption starts conservatively
and performs no dispatch. The session record is removed only after a valid durable
adoption acknowledgement. An already lost legacy session cannot be reconstructed
from current project state; no new key or inferred input may stand in for it.

## Required acceptance

- Migration with existing journals/rows: no rewritten response bytes or history;
  additive ledger invariants agree between fresh and upgraded databases.
- Faults before prepare commit, after prepare, after claim, after domain commit,
  after outcome persistence and before transport ACK; full-ledger/write failures
  cause zero business mutation before durable preparation.
- Lost/malformed/reordered replies, two-window execution/recovery/ACK races,
  stale backend nonce, changed input, project navigation and dirty drafts.
- Strict read-only task discovery; no new mutation, provider, model or media work
  on startup, list, get or legacy adoption. Safe foreign/corrupt metadata handling.
- Exact reference no-op/detach-after-rebind and historical timeline replay; old
  HTTP/CLI/official-MCP responses remain compatible.
- Fresh built Linux Electron: original app and renderer gone, retained task
  discovered in a new backend lifetime, no automatic edit, then explicit same-key
  recovery produces one business change. Audit database counts and original media
  hashes; screenshots demonstrate visible state, not hidden request identity.

## Verification checkpoint

2026-10-10: final backend 21/21, new real-HTTP transport 12/12, existing server
regressions 97/97, renderer/client/App regressions 249/249, storage/migration
regressions 71/71 and an additional schema/history compatibility selection
144/144 passed. These selections overlap; they are not summed as a full-suite
result. Fresh local web and desktop builds passed with matching staged web assets.

Two ordinary sandboxed Linux Electron lifetimes exited normally. The first
retained an unknown reference task after a synthetic fixture-only transaction
abort. The second rediscovered its exact input/key with all audited domain/task
rows and original media hash unchanged before explicit recovery. One Recover
created one original-key reference receipt and edge, advanced the shot once,
and acknowledged the durable task. Opening/dismissing Tasks preserved a dirty
node draft. Screenshots and database audits are recorded separately in ignored
`evidence/task-recovery`. The independent parent full-suite gate passed: 2,341
total / 2,339 pass / 0 fail / 2 skips, exit 0, 480726.086571 ms. The full log is
preserved as `evidence/task-recovery/parent-final-full.log`. Only acceptance
documentation and source seals changed after that run.

Existing Python browser harnesses still need a separate trial-E2E refresh for
Task Center labels and the new transport path. They were not run or claimed green
in this increment. macOS/Windows native readiness and live providers are not
established by Linux synthetic acceptance.

## Subject extension verification

On baseline `1b08cf2`, the schema-15 preservation verifier passed eight independent
cases. Focused domain/contracts/migration checks passed 132/132; recovery checks
86/86 and real HTTP/CLI/official-MCP transport checks 16/16; App compatibility
checks 112/112 and final UI checks 169/169. These overlapping selections are not
a full-suite result. Fresh web/desktop builds used byte-identical staged web assets.

Two ordinary Linux native app lifetimes verified subject creation, immutable
version addition, exact pinned associations, and explicit keep-old/use-new review.
A fixture-only transaction abort retained an unknown version-add task. After
the original app exited, its recreation rediscovered the same input/key with
all audited database rows and media hashes unchanged until explicit recovery.
Recovery produced one new version and one receipt, then acknowledged that same
task. Existing subject pins, historical versions, jobs, original timeline,
exports and media were unchanged. Evidence is in ignored
`evidence/subject-library`; the parent independent full-suite gate passed.

Final subject-extension gate:2,418 total /2,416 pass /0 fail /2 skips, exit0,
476659.942547ms. See the preserved failure/correction history and final evidence
in [Subject library](SUBJECT-LIBRARY.md).
