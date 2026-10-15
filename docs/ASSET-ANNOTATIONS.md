# Project asset tags and notes: backend checkpoint

Baseline: `41f09c3`. Date: 2026-10-15 UTC.
Status: reviewed and focused-tested backend checkpoint; integration/release is a separate gate. No annotation editor, library tag
filter or native interaction acceptance is delivered by this checkpoint.

## Scope and ownership

One user-authored plain-text note and bounded tag list belong to an existing
project-owned asset. Annotation identity is `(projectId, assetId)`, not filename,
file hash, immutable generation version, shot, clip or range. A second asset does
not inherit another asset's annotations. All media kinds use the same metadata
contract. Annotations never rewrite asset JSON, source bytes, immutable versions,
source ranges, dispositions, timeline history, render snapshots or fingerprints.
No model enrichment, provider calls, cloud synchronization, rich text or taxonomy
is included. The built-in Agent read/write allowlists are unchanged.

## Authenticated API

`asset.annotation.list({projectId, assetIds})` reads 1–100 unique UUIDs in exact
request order. Every target must belong to the requested project in both SQL and
bounded JSON. Missing and foreign targets fail the complete batch uniformly.
A positively checked asset without a row returns `{id, assetId, projectId,
revision: 0, tags: [], note: ""}`. Reads never create rows, timelines or receipts.
Corrupt state is not silently interpreted as empty metadata.

`asset.annotation.set({projectId, assetId, expectedRevision, requestId, tags,
note})` atomically replaces the small annotation aggregate under its own CAS
revision. Success returns the strict single-item response at expectedRevision+1.
An explicit empty save retains its row and advances revision. Even a same-value
new intent is a revisioned save; exact replay does not write again.

Limits:
- At most 20 distinct, case-sensitive tags.
- A tag has 1–40 Unicode code points, at most 160 UTF-8 bytes, and no controls.
  Tags must already be trimmed NFC strings. The API rejects noncanonical input
  rather than silently changing the caller's exact intent. A future editor can
  offer normalization before creating the immutable save request.
- A note has at most 4,000 Unicode code points and 16 KiB UTF-8. Tabs and LF
  newlines are allowed; other C0/C1 controls, NUL and unpaired surrogates are not.
  Note whitespace and literal markup are preserved as text, not interpreted.
- The serialized command is at most 24 KiB; requestId is required and retains the
  existing 8–200 UTF-16-code-unit key convention. Revision is a safe integer.
- Database cells and imported ownership/receipt identities are projected with
  byte/type bounds before crossing into JavaScript.

HTTP RPC, CLI and the official MCP transport use the same operation contracts
and business service. Operation descriptions exist in zh-Hans, zh-Hant, en and ja.
This exposes no new built-in Agent tool or permission.

## Exact replay and conflicts

Mutation, annotation row and immutable receipt commit in one transaction. The
new receipt companion shares the existing local key namespace with
mutation_requests, asset_range_requests, asset_disposition_requests and
subject_requests. All writers and recovery readers recognize the fifth family;
SQL guards reject collisions in both directions. Old receipts are never rewritten.

An exact retry returns its original acknowledgement before CAS, even after later
edits or restart, but current project/asset ownership is still checked. A changed
operation, target, project or exact input conflicts. Fresh stale revision writes
fail without merge or overwrite. A transaction failure rolls back both writes.
Revision overflow fails. Metadata/receipts cannot be replaced or deleted through
normal SQL guards; annotation revisions must advance exactly one step.

There is no annotation timeline undo/redo. Future UI must retain dirty text on
conflict, keep the exact original request after an unknown outcome, recover only
explicitly, and reread current metadata after historical replay. Server receipts
alone do not rediscover a client intent lost during renderer recreation. This
checkpoint does not implement a client draft or durable intent store.

## Workspace schema and restoration

Ordinary schema36 is an additive34→36 migration. Existing SQL, raw row bytes,
rowids and sequence values remain unchanged. It creates asset_annotations,
asset_annotation_requests and fixed protections. No historical constructor,
restored profile or receipt-protection definition is widened. Startup performs a
negative annotation-object/dependency preflight before any older migration can
commit. Missing/partial markers, reserved-name collisions, TEMP shadows and
unknown dependencies fail closed.

New cold backups identify source36. Its independent fixed restoration pair is
restored-local-v7, source36, schema37. Both annotations and receipts are captured
as held records with byte/rowid preservation. Restore37 allows annotation reads
but denies annotation writes, including replay and new direct insert identities.
Captured receipt keys still reserve the local-mutation namespace. Existing LUT
reads and colour admission retain the explicitly registered restored capabilities.

Historical restored25/27/29/31/33/35 are never upgraded. They can confirm empty
annotations only through their verified frozen profile and positive asset
ownership; there is no catch-all missing-table fallback. Ordinary36 or restored37
with missing/corrupt annotation tables fails. Old local replay/recovery readers
use four companions, while verified36/37 roles use five.

## Verification and limits

Tests cover contract limits, ordered noncreating reads, foreign/missing ownership,
CAS/clear/replay/restart, all legacy writer collisions, rollback, malformed state,
independent process races, additive migration preservation, hostile schema and
interruption rollback, exact backup36→restore37, historical frozen restores,
restored write denial and unrelated LUT reads. Actual authenticated HTTP, CLI and
official MCP exercise one shared journal without external media/provider work.

Focused counts and final source-freeze results are recorded in the implementation
handoff. Focused tests are not an independent full-suite release gate. No native
GUI, editor interaction, browser build, provider, media render, audible playback,
macOS or Windows acceptance is claimed. The UI/library slice remains separate.

### Checkpoint verification record

- Final serial feature/transport/schema/i18n/delivery-backup acceptance: **174/174
  passed**, zero skips (90.84 s). Includes actual two-process annotation CAS and
  exact replay races, authenticated HTTP/CLI/official MCP, cold backup36→restore37
  and exact historical34/35 restoration tests.
- The preceding broader mutation/dispatcher group completed **270/272**. Its two
  failures were old test assumptions that36 was an unsupported future schema.
  The explicit registered-pair matrix now includes36/37, rejects38/39, and both
  corrected tests passed in the final174-test acceptance. Historical fixed
  profiles and golden fixtures were not modified.
- Foundation and browser typechecks, source-language policy and whitespace checks
  passed. No application build or native GUI acceptance is claimed here.
- Independent read-only review identified startup preflight ordering and bounded
  imported-cell projections; both were corrected and re-reviewed with no remaining
  blocking finding. The same review checked frozen files and exact test fixture
  preservation. Local commit/publication is separate from these test results.

Final acceptance output: `evidence/asset-annotations/backend-acceptance.txt`.
