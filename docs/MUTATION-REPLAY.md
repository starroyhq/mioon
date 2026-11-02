# Shared local mutation replay

Date: 2026-10-09 (UTC). Baseline: `dbf3b93`.

Status: committed as `2ba58ee` after independent 1,160-test acceptance. This is a
shared business-service foundation for existing UI, HTTP, CLI and MCP callers.
That release exposed only the built-in Agent's four approved read operations.
The later reviewed-edit increment separately adds its durable
proposal and approval boundary.

## Original six operations

`shot.create`, `shot.update`, `shot.reorder`, `node.create`, `node.update` and
`version.select` gain an optional `requestId`, using the existing stable-key
format (8–200 characters). Existing inputs without a key retain their previous
behavior and response shapes. Optional does not mean safe to omit when a caller
needs recovery. CLI/MCP callers must create and retain their own stable key;
clients do not invent keys or retry POSTs automatically.

The new journal does not replace timeline/reference journals or generation and
export recovery. `project.create` remains workspace-global and unjournaled;
decorative edges retain their existing identity/delete behavior; asynchronous
asset import is outside this transaction-only change. No model write tools,
new generation permission, filesystem/media operation or provider call is added.

## Atomicity, scope and original responses

One synchronous `BEGIN IMMEDIATE` transaction owns the business mutation and its
immutable original-response receipt. Its key binds to the operation, resolved
project and canonical parsed input, retaining the difference between omitted
and explicitly supplied optional JSON fields. It does not hash a completed
record or collapse optional fields into application defaults.

An exact replay validates the retained project binding and current ownership
before exposing the saved response, then returns that response before checking
current revisions. It never returns a freshly reread mutable record. Generated
IDs, timestamps and original revisions therefore remain stable across lost
responses, later edits and process restarts. A response can be historical;
refresh editing state before a new intent. Changed operation, project or input
under the same key conflicts without returning the earlier response. Missing,
deleted or corrupt targets cannot reveal a saved foreign record.

The six handlers live in a separate business module. Existing reference guards,
revision checks and managed-asset relationships remain authoritative. No outer
async transaction wraps existing transactions. An exception rolls back both
business changes and receipt; failed operations are not recorded as success.
Receipts are retained and not silently pruned.

## Explicit client recovery

The UI admits a new intent by assigning its key once and saving the exact request
before sending. While a local mutation has an unresolved outcome in a project,
new local mutation intents are blocked. An edited Inspector draft is not
silently replaced with the older request, and a recovered old result is not an
acknowledgement that the current draft was saved.

Only explicit recovery in the task panel resends the retained operation/input.
Reload, tab changes, project navigation and restart do not resubmit. The existing
three-shot shortcut records each admitted step, stops at an uncertain result,
and reports partial progress; it is not a resumable batch that reconstructs the
remaining shots on startup.

Unreadable/malformed success responses, connection loss, authentication/policy
failures and request-key conflicts do not prove the previous attempt failed.
The receipt remains. A keyed business error may include
`details.mutationOutcome:'not_applied'` with the same `requestId` only when the
backend observed no prior receipt and completed rollback. This is bounded
no-commit evidence, not a generic interpretation of HTTP 4xx. A confirmed new
intent after a resolved failure gets a new key; a replay keeps the original key.

Recovery receipts are ordinary project text/parameters in browser session
storage; the server journal is ordinary local SQLite data. Neither is encrypted
by the credential vault. Do not put credentials in mutation fields. Client
recovery storage does not imply persistence after the browser/Electron session
is destroyed; callers must retain their keys for the recovery lifetime they need.

Before any future built-in Agent write proposal is enabled, its approved intent,
exact request ID/input and approval scope must be persisted by the backend before
dispatch and rediscoverable after restart. Acceptance must prove app/window
recreation cannot lose an unknown write identity or invent a replacement key.
This increment alone does not meet that future Agent-write readiness gate.

## Metadata and acceptance gates

The shared schemas advertise `requestId` as optional for these six operations.
`requiresRequestId` remains false. Effect `idempotent` and MCP `idempotentHint`
remain false because unkeyed legacy calls can still create records or advance
revisions. Notes explain the conditional exact-replay guarantee; annotations
never grant mutation authority.

Verified on 2026-10-09, with builds, aggregate tests and UI runs serialized:

- Final aggregate: **1,160/1,160**, zero failures/skips, 143.5 seconds using
  `node --test --test-concurrency=2 tests/*.test.mjs`. Final web build (9.31
  seconds) and desktop build passed; both use identical renderer assets.
- Contract/replay/wire focused checks: **50/50**. These cover exact original
  responses after intervening edits, zero replay writes, keyless legacy behavior,
  omitted-field distinctions, changed-key/cross-project conflicts, rollback,
  deleted/corrupt relationships, two writer processes, and pre/post-commit
  process termination. Foreign version selection retains legacy `INVALID_VERSION`
  without decoding or exposing foreign data.
- Actual HTTP response loss, CLI and official MCP SDK replay after restart:
  **14/14 wire tests**, included in the above focused and full totals. Database
  snapshots and change counters prove the replay does not mutate business data.
- Cloud browser: **5 acceptance groups, 7 screenshots**. All six UI operations
  supplied stable keys. Eleven mutation POSTs produced seven receipts, including
  four exact replays. Dropped/malformed committed responses, backend restart and
  renderer reload, blocking a new intent, preserving a newer Inspector draft,
  and stopping the partial three-shot shortcut were exercised. No Agent/model
  or generation submission occurred; normal GET conversation-history reads did.
- Ordinary Linux Electron: **4 acceptance checks, 9 screenshots**. Native create
  and save produced two receipts. App/backend recreation retained the selected
  shot, saved prompt and revision with no new business writes or receipts. Both
  native exits were code 0. This does not test pending session-receipt discovery
  after native recreation; that limitation remains explicit above.

Local evidence is under `evidence/mutation-replay/`: final build logs,
`all-tests-final.log`, `compatibility-focused.log`, `build-manifest.json`,
`browser/report.json`, `native/report.json` and final source hashes. The earlier
incomplete aggregate log is retained: it exposed the legacy version-error
regression corrected before the final builds/full pass. Runtime audit corrections
are also retained (GET history classification, SQLite row prototypes and the
intentional project revision increment on create); these changed acceptance
checks only, with no application changes after the final builds.

No live providers or real credentials were used. Linux evidence does not certify
native macOS/Windows. Independent review and a release commit remain separate
from this local acceptance record.

## Additive source-range extension (2026-10-10)

The subsequent source-range increment adds `asset.range.set` as a seventh local
operation with a **required**, rather than optional, request key. The original
six schemas/responses and keyless behavior above stay unchanged. Schema v11
adds a single-purpose `asset_range_requests` companion while retaining every
original `mutation_requests` row and trigger. At that increment, all seven
operations used the same helper and checked both tables inside one synchronous
write transaction; duplicate presence or wrong operation/table placement fails closed. This shared key space
is not a workspace-wide deduplication namespace: existing timeline, reference,
generation and export journals keep their previous scopes. See
[SOURCE-RANGES.md](SOURCE-RANGES.md) for independent range revisions and client
recovery constraints. No built-in model tool authority is added.

## Additive asset-disposition extension (2026-10-10)

Schema v12 adds `asset.disposition.set` as the eighth supported local mutation,
also with a required stable key. The original six optional keys, response shapes
and keyless semantics remain intact. `asset_disposition_requests` is a new
single-purpose immutable companion; no previous receipt or journal is rewritten.
The shared helper checks all three local receipt tables inside one synchronous
transaction. Duplicate key presence or wrong operation/table placement fails
closed. Keys still do not collide with timeline, reference, generation or export
journals, whose separate recovery semantics are unchanged.

The disposition row and exact original result commit atomically. Replay checks
current ownership before exposing the retained result, then returns that result
before CAS even if the current state has advanced or been reset to neutral.
Changed input, operation or project under a retained key conflicts. Missing or
foreign ownership yields uniform `NOT_FOUND` without a saved/current response or
`mutationOutcome:'not_applied'`, so clients preserve any pending identity.

`asset.disposition.list` is a strict bounded non-creating read, and neutral reset
retains the independent revision rather than deleting the metadata row. Only
disposition metadata/receipts change: no original bytes, source marks, in-use
clips, business revisions, Agent context or model tool catalog changes. Browser
pending requests use the existing session-only recovery mechanism. Backend
receipts survive restart, but the browser/Electron session's destruction may
lose the pending request identity; no cross-session discovery guarantee is
claimed. See [asset dispositions](ASSET-DISPOSITIONS.md).
