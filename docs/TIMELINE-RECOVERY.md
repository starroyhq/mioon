# Timeline mutation recovery consistency

Updated: 2026-10-10 UTC. Baseline: `0b102e4`.
Implementation, focused/runtime verification and the parent-owned independent
full release gate are complete. Commit remains parent-owned.

## Scope and failure model

The eleven existing keyed timeline writes share recovery semantics: track add and
update; clip add, update, remove, split and source replacement; seed; undo; redo;
and render. Reads such as `timeline.history.get` and export preflight are excluded.
A response lost after commit is an unknown outcome. A later HTTP 4xx can reflect
changed ownership, damaged data, authentication, or changed key reuse; it cannot
prove that the original request was never applied.

The existing timeline request-key namespace, input schemas, canonical hashes,
receipt rows, history format and successful wire responses stay unchanged. This
is not workspace-global idempotency and does not merge the separate reference,
generation or local-mutation journals.

## Recovery contract

- Persist the original operation, exact input and request ID before dispatch.
  An ordinary new edit cannot silently resend an unresolved old request. Recovery
  is an explicit user action using the same operation, input and key.
- Stale Tasks callbacks cannot cross projects. An explicit replay requires the
  existing matching receipt; a missing, changed or wrong-owner record cannot
  create a new request or trigger even a refresh RPC.
- A valid successful acknowledgement is checked against the operation, project,
  reviewed revision and observable input fields before a client releases its
  pending receipt. It is a historical acknowledgement, not today's aggregate.
- A rejection releases recovery only when its matching `not_applied` proof is
  credible: the backend observed no prior receipt under the same transaction,
  a known pre-write business rejection occurred, and rollback completed. Auth,
  scope, ownership, protocol, receipt or uncertain write failures retain the key.
- Any retained receipt is replay or error; malformed/falsy JSON never authorizes
  a fresh execution. Replay rechecks current relational ownership while keeping
  the original response intact. It does not require the historical clip to still
  exist or the current revision to equal the old result.
- Historical source checks are local metadata checks. Replaying a render does not
  probe source bytes, render again, or recheck a newer preflight digest. Under the
  same validated owner, source identity, hash, MIME and retained path, later
  duration/audio/dimension metadata drift does not invalidate the historical
  response: the frozen DTO is validated against its own metadata. Actual new
  renders and worker validation remain separate.
- Undo/redo restores only editable history fields. A damaged history snapshot
  cannot replace project/timeline identity, revision or timestamps.
- Pending render recovery always requires explicit exact replay. A public export
  record cannot establish current receipt/source ownership, even if its fixed
  project/request/purpose/revision and snapshot look valid. Digest-bound requests
  additionally cannot be verified from public snapshots that omit private source
  paths. Refreshing a newer or completed export never releases the pending key.

No schema migration or retained-receipt rewrite is required. Validators are
read-only and preserve omitted legacy fields instead of inserting defaults.
Generic aggregate, history and response JSON is bounded at 256 KiB: the existing
100-clip/12-track schema remains within this budget even with maximum-length
JSON-escaped control-character names. The later manual-subtitle slice unifies
replacement responses and timeline rows at the same 256 KiB bound; all 100
maximum-text cues still fit with the maximum escaped legacy shape. Original
receipt bytes are not rewritten. Render records are bounded at 4 MiB. The smaller
inspection/preflight read budget is separate and cannot invalidate generic replay.

## Reference boundary and persistence limits

Reference attach/detach errors now conservatively retain pending recovery without
matching backend proof. Their subsequent receipt validation and ownership hardening are described in
[REFERENCE-RECOVERY.md](REFERENCE-RECOVERY.md); the timeline increment itself did
not implement that follow-on. In particular, a historical detach response can describe an edge that
no longer exists, and attach can validly return an existing binding.

Pending UI receipts use the existing session storage. Project navigation and
same-session reload retain them. This does not promise discovery after the entire
native renderer/session is destroyed. Applied business responses and history are
persisted in SQLite; recovering an unknown operation still requires its original
key. No automatic resubmission occurs on startup, reload or navigation.

## Acceptance

Focused gates cover all eleven operations, exact historical response bytes,
fresh versus prior-receipt errors, malformed success, scope/JSON identity damage,
rollback boundaries, history corruption, render reconciliation, project/draft
fences, and reference error retention. Real loopback HTTP/CLI/official-MCP tests
drop committed acknowledgements at a proxy, then change retained data and verify
safe rejection, exact replay and backend recreation. Native UI uses an isolated
synthetic workspace and the final built bundle. No live providers or real keys
are used; the parent-owned full aggregate is the release gate.

### Verification checkpoint

- Backend/preflight: 251/251 passed, including metadata drift, bounded large
  timelines, rollback and exact historical replay.
- Shared contracts/client: 25/25 passed. UI/recovery: 119/119 passed, including
  pre-dispatch stale callbacks, missing/changed receipts and operation-substitution
  fences.
- Earlier failed focused/affected runs remain in local evidence. Their fixture
  corrections preserve business assertions; they are not counted as passes.
- Actual HTTP/CLI/official-MCP and media rerun: 191/191 passed. Fresh web and
  desktop builds passed; both contain the identical final JS asset.
- Final Linux Electron UI: ambiguous owner error retains the request through
  same-session reload and project navigation; another project exposes no foreign
  recovery action. Explicit recovery after restoring the synthetic row advances
  one revision with one receipt. All other clip fields and original/export bytes
  remain unchanged. The app closes normally with exit 0. Native recreation also
  preserves a previously applied response without a new request.
- Lost **committed** responses are exercised at the actual HTTP proxy boundary,
  including CLI/MCP and backend recreation. The unmodified native app exercises
  an owner-error/unknown result, not a simulated lost committed acknowledgement.
  Screenshots show the recovery affordance; DB and transport assertions prove
  keys/revisions. No packet capture or broader network-absence claim is made.

### Final fixture compatibility correction

The first parent aggregate reported 2142 total / 2138 pass / 2 fail / 2 skip.
The two failure counts were one source-range subtest plus its parent. Isolated
reproduction confirmed that its inherited preservation fixture manually seeded
`tracks: []`; service-created timelines start with three tracks and no public
operation removes tracks. Only the source-range fixture now supplies those
default tracks. A new regression proves ordinary service-created empty timelines
remain writable and zero-track corruption fails without writes or replay. The
source-range actual-transport plus recovery-boundary rerun passed 67/67.
Production code and built artifact hashes are unchanged; prior native evidence
still matches the final build. The failed aggregate remains preserved and is not
reported as a pass.

### Causal preflight settlement acceptance

The second parent aggregate reported 2143 total / 2140 pass / 1 fail / 2 skip.
Its preflight admission test assumed that releasing a probe gate and awaiting two
event-loop ticks meant all preparation had settled; it did not even await probe
entry before the 20 ms deadline. The isolated file passed 46/46, but this timing
assumption is invalid when file hashing/close is still pending.

The test now waits for real probe entry, advances only the normal deadline timer,
asserts admission stays busy through explicitly held probe cleanup, then boundedly
observes ready admission from the same service. Probe counts, maximum concurrency,
unchanged returned report and zero DB writes are asserted. Preflight business,
actual transports and timeline recovery reran 109/109 successfully. This is a
test-only synchronization correction; production cleanup and admission rules,
build bytes and native runtime evidence remain unchanged. The second failed
aggregate is also retained and is not reported as a pass.

### Final independent release gate

The third parent aggregate passed: 2143 total / 2141 pass / 0 fail / 2 skips,
506216.852807 ms, exit 0. Its full log is preserved as
`evidence/timeline-recovery/parent-final-full.log`. Both earlier failed aggregates
remain preserved with their diagnoses above. Since that successful run, only
this acceptance documentation and the evidence manifest have changed; production,
tests, built artifacts and native runtime evidence are unchanged.


## Durable UI follow-on

The original increment above covered same-session UI recovery. The follow-on [Task recovery slice](TASK-RECOVERY.md) adds backend-persisted intent and cold-start UI discovery for ten non-rendering timeline edits. `timeline.render` stays on its existing session-based UI recovery path. Business journal semantics and original response bytes are unchanged; see the follow-on document for separate acceptance status and limits.
