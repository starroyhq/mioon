# Asset favorites and rejection marks

Updated: 2026-10-10 UTC. Baseline: `fb42f88`.
Status: implemented and locally verified; independent final aggregate and
release review are separate gates.

## Bounded product scope

One independent local disposition per project-owned asset: `neutral`, `favorite`
or `rejected`. The UI calls rejected **拒选**. It is an organizational mark,
not deletion, a ban on use, or removal from a timeline, canvas or shot reference.
All supported asset kinds can be marked. Original files, asset records, versions,
saved source ranges, existing clips and their revisions remain unchanged.
Tags, notes, unused filters and jump-to-usage are separate roadmap increments.

The existing shared Asset Library gains small status controls and an explicit
All/Favorites/Rejected/Neutral filter. Filtering only changes visible cards;
source selection and any unsaved range draft remain intact. All/reset remains
visible, and a selected source outside the filter is identified. Known filtered
uses are disclosed without modifying those uses. Filter preference is local to
the current renderer session and does not modify saved workspace preferences.

## Shared API and trust boundary

- `asset.disposition.list({projectId, assetIds})` accepts 1–100 unique UUIDs.
  It is an explicit bounded batch, not a silently truncated project listing.
  Successful output is `{projectId, items}` in exactly the requested ID order.
  Each item is `{id:assetId, assetId, projectId, revision, disposition}`.
  The read never creates metadata, a timeline, or a receipt. A successfully
  checked asset with no metadata row is `neutral` at revision 0. Failed,
  missing, incomplete or loading responses must not be presented as confirmed
  neutral state. All requested assets must belong to the project before any
  result is returned; missing and foreign targets share a nonrevealing error.
- `asset.disposition.set({projectId, assetId, expectedRevision, requestId,
  disposition})` requires a stable 8–200-character key and safe-integer revision.
  Its revision is independent of asset, project, range and timeline revisions.
  Explicit neutral resets retain the metadata row and advance its revision.
  Success returns the exact single-item envelope at `expectedRevision + 1`.
- Project/asset identities are checked in relational columns and bounded JSON.
  Corrupt owned metadata fails closed. No paths, URLs, media bytes, provider IDs,
  or arbitrary asset JSON appear in disposition responses.
- HTTP RPC, CLI and official MCP call the same business service. List has a
  genuinely noncreating read-only effect. Set changes local database metadata
  only, with required-key replay and no media process or external call.
- Existing Agent inspection DTOs, consent categories, read tool catalogs and
  reviewed-edit proposal allowlists intentionally remain unchanged. Being
  available to an authenticated external CLI/MCP client does not expose a new
  built-in model tool or add these marks to model context.

## Durable mutation semantics

Schema v12 adds `asset_dispositions` and an immutable single-purpose
`asset_disposition_requests` companion in a startup transaction. Historical
six-operation and source-range receipt tables are retained. All eight supported
local mutation writers check all three receipt tables under the same
`BEGIN IMMEDIATE`; insertion guards reject collisions across companions.
Duplicate or misplaced receipts fail closed rather than picking one.

Mutation and original response commit atomically. Exact replay precedes CAS,
returns the immutable historical acknowledgement even after later edits or
restart, and still checks current target/project ownership before exposing it.
Changed operation, project or exact canonical caller input conflicts. Existing
six optional-key operations retain their wire behavior; range and disposition
writes require keys. This shared namespace is limited to those eight operations.
Timeline, reference, generation and export journals retain their separate scopes.

The UI reads its already-loaded asset IDs in serial batches. Loading, partial
and error states remain visible; counts describe those loaded assets and known
metadata rather than claiming a complete server-side search. Epoch and monotonic
revision fences prevent stale GET/POST responses changing another project or
lowering confirmed state. Replaying a saved acknowledgement triggers a separate
current metadata read instead of displaying that historical mark as latest.

Unknown submissions keep the exact original request for explicit task-panel
recovery. No automatic mutation retry is introduced. Pending first-party
receipts remain session-scoped, as in the existing shared mutation client;
application recreation can lose an unacknowledged UI intent. Persisted marks
and server receipts survive restart. This increment does not claim full native
unknown-intent rediscovery, and does not authorize Agent writes to these marks.

## Acceptance boundary

- Fresh/upgraded schema parity, no legacy receipt rewrite, all three companion
  collision directions, rollback and cross-process CAS/replay races.
- Bounded noncreating list, malformed/duplicate/foreign IDs, relational/JSON
  ownership drift, corruption, revision overflow, unchanged original bytes,
  assets/ranges/timelines and built-in Agent schemas.
- Actual authenticated HTTP, CLI children and official MCP SDK: discovery and
  effect metadata, lost acknowledgement/restart/exact replay, changed key
  conflicts, revision conflict and neutral reset retaining revision.
- Renderer partial/error reads, unknown metadata under restrictive filters,
  duplicate clicks, stale reads/acknowledgements, project change, exact-key
  recovery, selected source outside filter and preserved dirty range.
- Fresh web/desktop builds and ordinary sandboxed Linux native mark/filter/
  reset/app-recreation flow, with screenshots and database/file assertions.
- Independent parent full-suite release gate after final source freeze.

## Verification record

- Final backend/contracts and affected legacy regressions: **117/117 passed**,
  zero skips, 10.48 s. Includes 24 new business tests and 4 contract tests,
  four real two-process races, all eight writer collision directions, faithful
  v11 upgrade/fresh schema parity, ownership drift, rollback, corruption,
  Unicode/NUL request keys, and unchanged six/range semantics.
- Final UI/Agent/range/visibility/mutation regression group: **136/136 passed**,
  zero skips, 0.85 s, including 17 new UI tests. It covers ordered serial
  batches, partial/error states, monotonic reads, stale target/project handlers,
  exact-key recovery, unrelated pending-receipt recovery, selected/used asset
  notices, dirty range retention and scroll placement.
- Final actual HTTP/CLI/official MCP SDK group: **10/10 passed**, zero skips,
  16.33 s. This includes exact response loss, a later metadata edit, actual
  backend restart and historical replay; no-write reads/replays, bounded batch
  ownership, eight-operation collisions, separate older journal namespaces,
  byte sentinels and existing clips. A fixture guard rejects outbound work;
  this is not packet-capture evidence or live provider certification.
- Final fresh web and desktop builds passed serially; web took **8.59 s**.
  The existing large-chunk warning remains. All **49** web/desktop artifact
  hashes were unchanged through native acceptance and final shutdown.
- Ordinary sandboxed Linux Electron on synthetic managed MP4 assets verified
  favorite/拒选/neutral marking, all four filters and explicit reset. Marking an
  already-used source did not change its fixed timeline clip. A dirty `[1,180)`
  source range stayed intact through mark/filter/reset, selected-source exclusion,
  Properties/Agent tabs, library collapse and cancelled project navigation.
  An explicit discard later removed that unsaved draft without saving a range.
- Full native application/backend recreation used a new process (23770 to
  23946). After explicitly reopening the project, marks were rediscovered as
  favorite revision 1, neutral revision 3 and rejected revision 1. The session
  filter reset to All; five receipts remained byte-for-byte identical, with no
  additional mark write or retry. Both final native process exits were code 0.
- Read-only database and managed-file assertions confirm unchanged project and
  asset rows, all three original hashes/byte sizes, the existing source-in 60 /
  duration 60 timeline clip and its revision 2, source-range rows and old
  timeline receipts. Counts remained three assets, one pre-existing timeline
  receipt, five disposition receipts, zero range receipts, generation jobs,
  exports and Agent runs. The initial legacy `project.get` opened the empty
  comparison project's default timeline before marking; that existing creating
  read is not attributed to the new noncreating batch operation.
- Native evidence includes **16 final-build screenshots** and 3 superseded
  pre-layout screenshots. The default Editing height exposed overly tall fixed
  status blocks; a bounded correction moved details/excluded-source controls
  into the scroll area and kept filter/count/reset controls compact. Focused
  checks and both builds were rerun before final native verification.
- Retained initial failures are test/acceptance-harness issues: a UUID schema
  reference expected inline, one test syntax bracket, a deliberately unsafe
  integer snapshot requiring BigInt, and a runtime assertion comparing SQLite
  null-prototype rows to parsed JSON. Corrected checks passed; failure logs are
  not represented as passing runs. The initial PATH-based native launcher made
  no app launch record; the existing explicit installed Node path was used for
  the successful launches. No application security flags were weakened.
- Native evidence is mouse/scroll based; no new keyboard, audible playback,
  browser automation, FFmpeg export, or native macOS/Windows acceptance is
  claimed for this metadata-only increment. The prior real source-range export
  remains its own release evidence. Windows ACL readiness stays gated.
- Parent independent full-suite/release review is the remaining release gate.

Evidence is retained under `evidence/asset-dispositions/`. The built-in Agent
has no new disposition authority. No live provider call or real credential was
part of this verification.
