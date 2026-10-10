# First-frame reference recovery

Updated: 2026-10-10 UTC. Baseline: `7625112`.
Implementation, focused verification, final-bundle Linux native checks and the
independent parent full aggregate are complete. The parent-owned commit remains
the release gate. This increment covers only `reference.attach` and
`reference.detach`, with no new model tools or generation authorization.

## Exact historical acknowledgements

Keep the original operation, complete input and mandatory `requestId` through an
unknown outcome. The existing reference journal is independent of timeline and
local-mutation journals; this is not workspace-global deduplication. Changed key
reuse conflicts. The transaction returns the saved original response after
validating its identity and current ownership, before new revision checks.

- Attach still returns `{edge,shot}`. A new connection advances the shot once;
  attaching the same existing binding with a fresh key and current revisions is
  a valid no-op and retains the shot revision.
- Detach still returns `{edge,shot,detached:true}`. Its historical edge is naturally
  absent after success. A later new binding or unrelated node/shot edit does not
  invalidate an otherwise safe historical response.
- Replay does not require the current shot selection, revision or edge presence
  to equal the historical state. A present edge under the historical ID must not
  have changed identity or ownership. Returned data is historical, not a fresh
  project view; refresh the current project separately.
- No missing/falsy/malformed/oversized receipt becomes a new write. Current
  project, source node, image asset, target shot, referenced assets and selected
  version lineage are checked with relational/JSON identity agreement before
  disclosure. Missing, foreign and damaged retained ownership fails safely.

A shared read-only, non-normalizing acknowledgement validator binds operation,
project, source/target/edge IDs, revisions, role and saved reference selection.
It is used by business services, the CLI/MCP shared client and UI. The receipt cap
is 64 KiB, including complete shot and typed edge; the maximum escaped 5,000-char
prompt plus 150-char title requires 30,900 bytes, with room for every remaining
bounded field. Per-row metadata reads are bounded before JSON materialization;
reference binding queries materialize at most two candidate edges. This does not
promise an indexed constant-time scan of an arbitrarily large legacy graph.

## Unknown versus proven rejection

A lost response, malformed success, generic HTTP 4xx, ownership failure,
corrupt receipt or changed-key conflict remains unknown. The shared client
reports `BACKEND_PROTOCOL_ERROR` for an invalid successful payload and retains
the exact request identity. Neither client nor UI automatically repeats a POST.

Only a fresh, receipt-absent, pre-write business rejection after confirmed
transaction rollback may carry:

```json
{"mutationOutcome":"not_applied","operation":"reference.attach","projectId":"<same project>","requestId":"<same request>"}
```

Proof classification is reference-operation-specific; a timeline-only error code,
wrong operation/project/key, authentication error or database/commit uncertainty
cannot clear a reference receipt. Eligible codes are revision conflict, already
connected/manual-selection conflict, invalid source/edge and safe revision limit,
only after the relevant ownership checks. Inconsistent binding state is not a
proof. Post-write failures remain conservatively unknown even when rollback was
attempted. Successful receipt and mutation publication are in one synchronous
SQLite transaction with post-write identity/read-back verification.

## Receipt retention and compatibility

Bootstrap adds two `CREATE TRIGGER IF NOT EXISTS` guards to the existing
`reference_requests` table: prevent replacement of an existing key on INSERT,
and prevent DELETE. The existing UPDATE guard remains. No table columns, schema
version, stored response bytes, request hash or key namespace are rewritten.
Existing legacy receipts remain readable if valid. Production has no reference
receipt cleanup or project-delete operation that needs these rows removed, and
this table has no cascade relationship. Failed transactions still roll back newly
inserted receipts and domain changes normally.

An older application opening the same DB may still encounter these retained
triggers; reverting code does not remove them. A future legitimate purge/migration
requires an explicit data/recovery policy. These guards defend normal application
SQL, not an external actor who can alter the raw DB or remove triggers.

## UI and privacy limits

The existing right workspace and Tasks recovery UI are preserved. A fresh click
cannot inherit a different pending same-key reference request. Only the explicit
recovery action may resend the exact saved operation/input/key. Missing, changed,
misfiled or foreign-project receipts are blocked before RPC; late callbacks do not
change another project's draft or selection. Successful data is checked before
pending state is cleared. No live provider call follows attach/detach.

Pending UI requests still use session storage. Navigation and same-session reload
are covered; destruction of the entire renderer/session can lose an unknown key.
This increment does not promise cold-start rediscovery of unknown UI submissions.
The applied business response is durable in SQLite. The next task-center/recovery
increment must address broader rediscovery explicitly.

## Acceptance scope

Focused business and shared-client/UI tests cover historical/no-op responses,
owner/JSON damage, malformed success, strict rejection proof, immutable retention,
rollback and concurrent replay. Real loopback HTTP, CLI and official MCP tests
lose committed attach/detach responses, corrupt/reassign synthetic retained data,
recreate the backend and replay the original response after rebind. Runtime QA
uses only isolated synthetic source pixels in the final Linux Electron bundle.
Focused gates passed: backend 123/123, contracts/client 24/24, affected App harnesses
113/113, and actual transports/related regression batch 104/104. Fresh web and
desktop builds passed with identical UI bytes. Native attach, dirty-source guard,
detach cancellation, retained owner-error outcome, same-session reload, project
isolation and explicit recovery were verified. Recovery adds one receipt and one
shot revision while preserving other saved fields and source bytes. Two Electron
lifetimes closed normally; recreation preserved the already applied state.

Native tests use an owner-error/unknown flow, not a native lost-commit proxy.
Actual HTTP/CLI/MCP tests prove lost committed acknowledgements and exact keys;
screenshots show the recovery UI, not the request UUID. Full-session destruction
of an unknown pending UI request remains outside this increment. The independent
parent final aggregate passed 2277 total / 2275 pass / 0 fail / 2 skips
(479346.311817 ms, exit 0). macOS/Windows native behavior and live providers are
not verified by these checks.

### Parent aggregate fixture correction

The first parent aggregate reported 2277 total / 2274 pass / 1 fail / 2 skips
(468924.00422 ms). Its only failure was an old App source-regex expectation
requiring an inline timeline/reference condition after that condition had become
the equivalent `requestBound` alias. The test now evaluates the actual App flag
declarations and rejection expression: local/timeline proof compatibility is
retained, and reference operation/project/key/code binding is checked explicitly.
No production source, built artifact or native flow changed. The affected
six-file rerun passed 74/74; the failed full log remains preserved. The subsequent
parent final full gate passed with the counts above. Both aggregate logs are
retained in the acceptance evidence; no production, test or built artifact
changed after the final gate.
