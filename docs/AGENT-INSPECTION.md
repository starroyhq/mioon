# Shared scoped inspection boundary

Date: 2026-10-09 (UTC). Baseline: `ce60c97`.

Status: committed as `8341029` after independent **974/974** tests passed. This
historical stage added shared inspection without connecting models to it.
[The following read-tools stage](AGENT-READ-TOOLS.md) adds a separate consented
in-app execution boundary; the shared operation contracts below are unchanged.

## Four additive operations

- `project.inspect`: bounded project identity/text/revision and record counts.
- `asset.inspect`: a bounded page of safe saved asset metadata.
- `shot.inspect`: a bounded page of saved shot metadata, reference IDs and checked
  selected-version metadata. Prompts are explicit excerpts of at most 1,000 UTF-8
  bytes, with `promptTruncated`; the saved prompt itself is never modified.
- `timeline.inspect`: the existing timeline's safe editable fields, or `null`
  when absent. It never initializes a timeline or default tracks.

The authenticated existing RPC surface accepts an explicit project ID. Page
inputs have a default limit of 10 and a maximum of 25. The same shared services
are callable through the existing client used by the UI, CLI and MCP; this stage
does not add or manufacture a new inspection screen.

### Result contracts

All objects below are new allowlisted DTOs, not raw stored records. Optional
metadata is omitted when it is absent; invalid present metadata fails safely.

- Project: `{id,name,description,revision,counts}`, with counts for `assets`,
  `shots`, `nodes`, `edges`, `jobs`, `versions`, `exports` and `timelines`.
- Asset/shot page: `{items,nextCursor}`; the final cursor is `null`.
- Asset item: `{id,name,mimeType}` plus optional `width`, `height`, `duration`,
  `hasAudio`, `hasVideo`, `provenance` and `createdAt`.
- Shot item: `{id,title,prompt,promptTruncated,referenceAssetIds,aspectRatio,
  duration,orderIndex,revision,selectedVersionId,selectedVersion}`. Selection is
  `null` or `{id,number,assetId}` plus optional `providerId`, `model`, `isMock`
  and `createdAt`. Provider identity is not a provider job ID. Pages are ID-ordered;
  `orderIndex` describes saved storyboard order without changing it.
- Timeline: `null` or `{id,revision,fps,width,height,durationFrames,tracks,clips}`.
  Tracks contain `{id,name,kind,orderIndex,hidden,muted}`. Clips contain
  `{id,trackId,assetId,name,startFrame,durationFrames,sourceInFrame,rect,gain}`;
  `rect` contains `{x,y,width,height}`. The existing fixed 30-fps, 720×1280
  timeline limits remain in force; inspection does not normalize or repair it.

Shared RPC schema errors use `VALIDATION_ERROR`. Checked missing/foreign/corrupt
records return `INSPECTION_UNAVAILABLE` (404) with no record details. Cursor
mismatch or expiry returns `INVALID_CURSOR`. The internal boundary additionally
uses `INSPECTION_SCOPE_DENIED` and `INSPECTION_BUDGET_EXCEEDED`.

Existing `project.get` and `timeline.get` keep their responses and legacy
initialization behavior. They are not safe non-creating inspection operations.
Existing mutation request IDs, replay results and conflict semantics are unchanged.

## Trusted scope and untrusted data

A business-layer factory creates opaque, frozen project/capability contexts.
The scoped dispatcher recognizes only contexts issued by its own factory and a
fixed four-operation allowlist. Model-shaped arguments contain no project ID,
authority, capability list or mutation request ID. A serialized or forged context
cannot grant access. The context factory is a trusted backend API, not a substitute
for authenticating or authorizing the caller.

The current local RPC token has its existing workspace-wide privilege: a caller
using it explicitly chooses a project. This increment does not turn that token
into a per-project credential. A future model runner must instead bind its scope
to accepted run consent and pass only validated tool arguments to the dispatcher.
No HTTP endpoint accepts the internal context or a caller-supplied capability grant.

Arguments and stored text are untrusted data. Unknown authority fields, accessors,
forged contexts and operations outside the fixed allowlist must fail closed. Text
that resembles instructions or a URL is retained only as bounded text; it is never
executed, fetched or treated as consent. Structural paths, media URLs/bytes,
provider job IDs, snapshots and credentials are excluded by explicit DTO projection.
This is not a claim to detect every secret a user may have typed into project text.

Every materialized exposed record and checked indirect asset/version/job/shot
relationship must match
both indexed SQL ownership and JSON identity. Missing, foreign and inconsistent
linked records use the same safe unavailable error without returning identifiers
or raw rows. A selected version cannot cross its shot, job or asset boundary.
Timeline clips cannot smuggle foreign assets through an otherwise local aggregate.

This is scoped disclosure, not exhaustive certification of arbitrary database
corruption. The bounded reverse index omits unreadable/oversized version JSON.
Directly selected unreadable versions fail closed, and generated assets require a
valid owner. A correctly owned imported asset can still be returned when an
unreadable blob hides a reverse reference to it; no content from that hidden row
is disclosed. A canonical indexed asset relation or a workspace-wide unreadable-row
denial policy would require a separate migration/availability decision.

## Resource and lifecycle bounds

An additive schema-7 migration creates project/ID indexes and a guarded reverse
version/asset expression index. It does not rewrite existing records or journals.
Initial index construction scans legacy rows once; indexed counts are not a
constant-CPU guarantee for arbitrarily large projects.

Page selection and row-size guards happen in SQL before JSON materialization.
Pages use stable ID ordering, rather than claiming a transactionally frozen view
of concurrently edited data. Cursors bind project, operation, page size and
position to a backend-instance signature; they expire when the service restarts.
They are pagination state, never an authorization credential.

Scoped contexts have ceilings of 16 attempted calls, 128 KiB per result and
512 KiB total output. Trusted callers may lower, never raise, those ceilings.
Each dispatch additionally caps materialized records at 1,024 and their aggregate
raw JSON at 4 MiB; those read limits are separate from per-context output limits.
The existing timeline is bounded to 12 tracks and 100 clips. Reads do not create
project/timeline/journal rows, mutate saved prompts, acquire model credentials,
start provider work or launch media processing.

The inspection module is independent of React and Electron. Native desktop,
HTTP, CLI and MCP use the same business implementation. No preload API, native
security relaxation, external dependency or platform-specific authority path is
needed. macOS/Windows native readiness requires separate native verification.

## Explicit operation effects

Shared operation definitions carry explicit effects. MCP annotations derive
from that metadata, not suffixes such as `.get` or `.list`. Coverage tests require
an entry for every operation, including the potentially creating legacy reads,
external reconciliation, local export work and paid-generation entry points.

Effects and MCP hints describe behavior; they do not authorize it, establish
project scope, guarantee a remote cancellation or override request-ID rules.
Inspection operations have no creation, mutation, network or paid-generation
effect. Discovery documentation must retain that distinction.

## Acceptance gates

1. Strict input/output bounds, opaque-context and capability forgery rejection,
   exhausted budgets, hostile text, corrupt ownership and indirect relationships.
2. SQL pagination and cursor binding; malformed/oversized rows fail safely before
   materializing an unbounded record; absent legacy timelines stay absent.
3. Actual authenticated HTTP, CLI subprocess and official MCP SDK stdio calls
   return the same safe records. All-table snapshots and commit observation show
   zero inspection writes. Provider/model/media work remains uninvoked.
4. Legacy operation responses, replay/conflict tests and complete effects coverage
   remain green. Discovery lists the four additive operations accurately.
5. Serial final builds/tests and native runtime evidence on the final backend.
   Any screenshot of the existing workspace is labeled as regression evidence,
   not a new model-tool feature. Exact source/build/evidence hashes precede review.

### Recorded local acceptance (2026-10-09)

- Focused business tests: **60/60**; contracts/discovery: **3/3**; actual wire
  tests: **9/9**. The wire report records **101 parity cases / 303 interface
  checks** across authenticated HTTP, CLI subprocesses and official MCP SDK
  stdio. Nine checkpoints compare all 25 SQLite tables and `data_version`,
  including legacy timeline absence, corrupt cross-project relationships,
  hostile text, cursor restart expiry and unchanged legacy request replay.
  The fixture's outbound/provider/media guard recorded no forbidden calls.
- Final bounded aggregate: **974/974**, zero skips, 117.55 seconds. Fresh web
  and desktop builds passed serially; desktop and web UI asset hashes match.
  Existing Vite directive/chunk-size warnings remain non-fatal.
- Ordinary sandboxed Linux Electron was launched on the final bundle, without
  remote debugging, smoke hooks, model fixtures or live-provider permission.
  All four real CLI inspection calls reached that desktop's backend and passed;
  application-table hashes were identical and `data_version` stayed **2 → 2**.
  The native fixture ended with zero Agent threads, requests, runs and events,
  then quit normally (exit code 0).
- Five native screenshots record the existing canvas, conversation-only Agent
  dock, dock collapse/recall and Editing view with its timeline visible. They
  demonstrate UI regression checks only. No new inspection UI, model tool
  execution, live-provider certification or macOS/Windows native QA is claimed.

Local evidence is under `evidence/agent-inspection/`: `all-tests-bounded.log`,
`wire-tests.log`, `inspection-wire-report.json`, `build-manifest.json`,
`native-runtime/inspection-report.json`, `native/report.json` and five native
screenshots. `source-manifest.json` and `screenshot-manifest.json` freeze the
review inputs. Two earlier failed wire runs are retained: a fixture guard first
rejected numeric-loopback DNS resolution, and a later run exposed a nested-input
validation-envelope mismatch. The guard was narrowed to literal loopback
resolution, shared validation parity was fixed, and the final full runs passed.

## Following increment

Both-protocol tool requests and continuations require their own accepted run-level
project/context consent and durable tool intent/result semantics. Initial limits
may allow ordinary inspection and a bounded continuation without prompting for
every read. Changed scope or destination, mutations and paid generation retain
their separate approval boundaries. Stop revokes future rounds; restart never
automatically resumes inference.

The right dock currently repeats storage, context and no-tool explanations.
Before adding tool consent, consolidate persistent explanations into a compact
status plus expandable details while preserving explicit destination/context/cost
consent. This increment does not change that UI.
