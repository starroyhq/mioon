# Typed first-frame reference acceptance — 2026-10-09

## Increment

This source increment follows `4d76ae8` (durable timeline undo/redo) and keeps the
application version at 0.4.1. A project-local managed image node can explicitly
own a shot's first-frame image input. It is not a general graph executor.

- `reference.attach` atomically creates a typed edge, sets the shot's actual
  reference image and stores its exact response. Both endpoint revisions are
  checked. One first-frame connection is allowed per shot.
- Existing manual choices are never adopted or overwritten. They must be
  explicitly cleared and saved. A connected shot rejects manual replacement;
  `reference.detach` removes its owned image choice and edge together, retaining
  the source node, managed image and historical jobs.
- Identical current-state attachment produces no duplicate edge or extra
  revision. Exact request replay returns the original result after later edits,
  detach, rebinding and restart. Changed request reuse conflicts. Response
  persistence failures roll back the whole mutation.
- Source asset IDs cannot be changed through node updates; node/asset deletion
  is not exposed. Renaming/moving a node cannot retarget its bound image.
- New generation snapshots freeze connection provenance alongside image IDs,
  hashes, dimensions and provider settings. Queued/running tasks and explicit
  retries continue using their original inputs after disconnection/rebinding.
- Schema-v4 migration only adds reference request-response storage. Historical
  edges remain decorative. No existing asset, shot, timeline history, job,
  version or export is rewritten by migration.

The UI has distinct first-frame handles, explicit image-node attach controls,
visible bound-source details, confirmed detach, manual-clear guidance, locked
connected reference pickers, dirty-draft guards and exact pending-request
recovery. Generic links use separate handles and dashed, visual-only labels.
HTTP, CLI and official SDK MCP use the same strict contracts and service.

## Automated verification

Evidence is local and ignored under `evidence/reference-connections/`.

- Final aggregate: **361/361 passed**, no failures/skips. Node 24.19.0;
  `full-regression-final.tap`.
- New reference tests: **28/28 passed**: 15 core/service/provider cases, 2 real
  CLI/HTTP/MCP cases and 11 frontend state/recovery cases.
  `reference-tests-final.tap`.
- Core coverage includes manual-choice protection, invalid sources/endpoints/
  projects/roles, stale source and shot revisions, no-op reattachment, competing
  and duplicate requests across independent SQLite connections, additive
  migration, fail-closed inconsistent state, immutable response records and
  response-commit rollback for attach and detach.
- Real CLI subprocesses, official MCP SDK stdio and HTTP share strict schema
  discovery, returned results, replay/conflict behavior and a genuine backend
  process restart. No second client-owned database is opened.
- A typed connection reaches the existing Ark adapter's `first_frame` payload
  with the exact synthetic image bytes/hash through an injected HTTP function.
  Incompatible image dimensions reject before queueing. No network request is
  made by that test. A mock-worker adapter receives the original frozen source
  after detach, rebinding, node edits and restart; retry retains that snapshot.
- Frontend checks cover source/project eligibility, manual-selection guidance,
  separate generic/typed handles and labels, image-mode derivation, exact
  attach/detach pending inputs, failed-storage rejection and project isolation.
  A coincident job/export request ID cannot clear a pending reference mutation.
- Production Web build passed: `web-build-final.log`. The existing `use client`
  and large-chunk warnings remain. The installed Vite entrypoint was used
  directly because this copied workspace's pnpm wrapper attempted unnecessary
  dependency-manager setup. No dependency or lockfile changes were made.
- Development desktop bundling passed: `desktop-build.log`; the staged renderer
  JS and index match the Web build byte-for-byte. This is a build, not a new
  package or native desktop runtime acceptance.
- Full regressions include genuine synthetic MP4 generation and FFmpeg export,
  immutable versions, timeline undo/redo, composition, process recovery and
  provider contracts. Copies of their regenerated outputs are retained under
  `regression/` in this increment's evidence folder.
- `git diff --check` passed.
- After the migration assertion was made forward-compatible, the final frozen
  reference/history rerun passed **38/38**: `final-freeze-tests.tap`. The parent
  independently reran the full aggregate with **361/361** passing.

## Runtime browser verification

**10/10 passed** against a new isolated synthetic project in actual own-cloud
Chromium with the browser sandbox unchanged. The repeatable supported-CUA
harness is `tests/browser_references.mjs`; its report is
`browser/browser-reference-report.json`. No renderer state or RPC response is
mocked. The same service reads results and supplies one genuine competing edit.

Covered actual attach and rendered typed edge, locked manual picker/mode,
cancelled detach, dirty shot/node guards, reload persistence, same-image manual
choice protection, explicit manual clear/save, genuine local mock MP4 generation
with frozen connection provenance, detach preserving the generated version,
stale detach rejection and refresh, successful fresh recovery and unchanged
source pixels/nodes/decorative edges.

Screenshots were captured from the running application and visually reviewed:

- `browser/01-connected-first-frame.jpg`: typed connection, actual bound source
  image and locked manual controls. Clear overview recommended for the report.
- `browser/02-manual-selection-guard.jpg`: existing manual selection prevents
  attachment, with a path to explicit clear/save.
- `browser/03-generated-reference-version.jpg`: genuine local mock video result.
- `browser/04-detached-originals-preserved.jpg`: owned reference removed while
  the source image and completed version remain.
- `browser/05-stale-detach-conflict.jpg`: actual revision-conflict rejection and
  refresh, with the newer state preserved.
- `browser/06-final-bound-reference.jpg`: two typed image connections, bound
  source details and the completed mock version.
- `browser/07-mock-sequence-export.jpg`: both bound shots were generated with
  local mock and the real UI exported the sequence. `export-smoke-report.json`
  records ffprobe verification: **4.000 seconds, 720×1280, H.264/AAC**.
- `browser/08-green-port-drag.jpg`: actual direct drag from image output to shot
  input creates the correct typed edge, advances the shot revision from 5 to 6
  and locks the manual controls. Details: `green-port-drag-report.json`.

Direct shell startup exposes an isolated loopback listener to the shell rather
than cloud Chromium. The test backend was therefore launched through the
supported native Application Finder using a wrapper in `/workspace/shared`,
without changing network or browser security settings. Early harness scrolling
and selector failures were corrected; the final clean run is fully reproducible.

## Scope and limits

The source images and videos used for verification are locally generated
synthetic fixtures. No original user/example workspace was modified. There is
no new installer, package, source archive, signing/notarization, macOS/Windows
runtime verification, live generation, provider media upload, push or
deployment. The parent owns the local commit after independent review and a
real runtime screenshot.

Connecting an image is not model validation or paid authorization. Existing
per-model MIME/dimension/ratio/duration validation, approved-media checks and
live-budget gates continue at generation. Character/style identity, generic
DAG execution, prompt propagation and timeline-history undo of reference
connections are outside this bounded slice.
