# Current execution index — 2026-10-16

The M0–M3 and V2–V4.1 checklists below are historical records. The last verified
published application integration is `ff85c9a8daaa35bff080d0979fe2faa3683cd3b5`
on GitHub main. Local-only opacity work began after
`ec01753056c0f31706d29ed279ae1944c822ad94` and includes completed follow-ups
through `256cfd3`: fresh42 and explicitly restored43
development workspaces now connect to the shared App through separate admission.
See the [fresh42 boundary](docs/OPACITY-CANDIDATE-APPLICATION.md) and
[restored43 application scope and evidence](docs/OPACITY-RESTORED-APPLICATION.md).
It is unpushed; identify the exact local commit with `git rev-parse HEAD`.

Implemented slices include the independent Settings center, four-language
presentation, 1–300-frame sample export preview, continuous saved-timeline audio,
and the volume-envelope backend plus integrated ordered-row editor. Do not
restart them from older planning/prototype labels. See [STATUS](STATUS.md) and the
[current delivery index](docs/PRODUCT-ROADMAP.md#current-delivery-and-remaining-work-2026-10-16)
for attributed checkpoints and remaining acceptance. Atomic loudness application
retains its separate WIP/acceptance boundary.

Canonical TypeScript/source-language checks and one production source build
passed on `ff85c9a`; the earlier 721-diagnostic blocker is historical and resolved.
That integration recorded 217 passing focused checks, not a full-suite pass.
The local `25609e9` repair passes the original two test files 53/53 and pure-memory
LUT host checks 11/11. The extra preload bundling case was blocked by its esbuild
subprocess guard and is not a passed gate. Do not add overlapping historical totals.

Volume-envelope native Save/Undo/Redo and normal close passed on `dc7a057`.
Inspector reopen, CJK IME and four-language native acceptance remain unfinished;
this is not all-platform acceptance. Continuous-audio wall-clock/resource gates
and LUT exact-file reselection/restart qualification retain their separate limits.
Clip opacity keyframes now have the isolated fresh42 application slice;
[partial Safari and actual10-frame media acceptance](docs/OPACITY-CANDIDATE-NATIVE-ACCEPTANCE.md)
passed within its stated scope. That earlier42 GUI run stopped at the import
picker after CUA disconnection; the43 slice below has new actual GUI evidence. The [fixed42 cold-backup→offline43 entry](docs/OPACITY-CANDIDATE-BACKUP-RESTORE.md)
is implemented with original guards and explicit v3 draft exclusion. Its
[restored43 application entry](docs/OPACITY-RESTORED-APPLICATION.md) now opens
existing projects and retains the original exact-origin editing/render policy;
old pending tasks stay held. That initial43 slice kept unsaved inputs and views
in memory; source v3 drafts remain excluded and preserved. That slice's
124/124 focused tests, separate12/12 preferences, canonical builds and actual
Safari Save/Cancel/Undo/Redo plus10-frame preview/export/playback and normal
close/reopen passed. HTTP download and RGB checks passed; full four-language/IME
and packaging/platform acceptance remain separate. Explicit ordinary42 reopening
now has [safe internal admission](docs/OPACITY-CANDIDATE-REOPEN.md). Other
visual keyframes, transitions, Full Log/HDR and a general plugin broker/SDK remain
future feature work.

The [opacity language/IME follow-up](docs/OPACITY-LANGUAGE-IME-ACCEPTANCE.md)
repairs two reproduced input/cancellation races, with241/241 targeted and separate
5/5 session/copy checks. GUI stopped after three43 locales when CUA disconnected;
real OS IME, Japanese Inspector, final fixed-build GUI and native close/reopen
remain open. No test service is alive; the lost service exit code/window closure
remain uncertain, and original stale-lock admission released the owned lock.

Completed local follow-ups are [new-origin43 clip drafts](docs/OPACITY-RESTORED-DRAFTS.md)
in `4607947` and [explicit ordinary40→ordinary42 offline copy upgrade](docs/OPACITY-ORDINARY-UPGRADE.md)
in `256cfd3`. Exact43 `localClipDrafts` capability permits cold recovery after
durable acknowledgement; source42 v3 is never migrated. Older43 without that
capability and restored view state keep memory fallback, and unconfirmed or
composing input retains close protection. Upgrade requires an eligible closed40,
its verified backup and a new target;41 and default production admission remain
unchanged. [Batch integration/release review](docs/OPACITY-RELEASE-CHECK.md) is complete:
four product regressions repaired, with6 historical BLOB expectations retained
as failures in the121-file aggregate. Exact-baseline failure is not established.
Node24 strict types passed; its native-addon build was blocked by macOS Team IDs.
Node26 auxiliary builds are separate from formal Node24/product qualification.

The limited local Linux trial remains available. New logic uses TS; preserve the
user's workbench, media, shared services, drafts and receipts. The earlier documentation
alignment ran no tests or build; current opacity qualification is linked above.
The later bounded GUI/HTTP/media run has its own evidence and performs no push. Platform/native,
installer/signing and real-provider gates remain separately scoped; later work
has no implicit spending or publication authority.

## Historical M0–M3 / V2–V4.1 records

# Video Workbench M0 → M3

- [x] Read full HANDOFF; inspect authorized own-cloud workspace/runtime and applicable project rules
- [x] M0: freeze independent Node24/SQLite architecture, strict shared schemas, API/MCP and durable job contracts
- [x] M1: media canvas, managed imports, project/shots/nodes, mock generation, immutable result, UI+HTTP+official MCP round-trip
- [x] M2: restart recovery, request replay/conflict handling, async fences, unknown outcome safety, provider adapter/offline tests
- [x] M3: Chinese UI browser walk, actual playable portrait export,5×2second story example, docs and A1–A10 evidence
- [x] Final aggregate, browser, clean-install and relocated-data verification
- [x] Final package integrity review
- [ ] A9 live provider verification, only after explicit secure configuration/material/budget authorization

No Mac access or original-media modification. No commit/push/deployment or public upload. No paid provider submission. This was the v1 boundary; V3 below explicitly brings Electron desktop packaging into scope. Mac native signing/notarization remain unverified.

# V2 — Functional regions and real multitrack editing

The user's 2026-10-09 request explicitly expands the earlier scope to include a media library, canvas/preview workspace, property inspector and real multitrack timeline.

- [x] Inspect baseline in a new own-cloud Chromium capture; preserve original v1 deliverables
- [x] Freeze integer-frame timeline, layer/audio semantics and shared API/MCP contract
- [x] Add non-destructive persistence migration and revision/idempotency-safe timeline services
- [x] Add audio import and actual layered FFmpeg composition used by preview and export
- [x] Implement labeled/collapsible regions, source preview, canvas/preview switching and timeline editing
- [x] Verify HTTP + real MCP + restart + render semantics + v1 aggregate regression
- [x] Verify actual browser drag/drop, trims, modes, errors, preview/playhead and export
- [x] Produce region guide, screenshots, synthetic multitrack demo and versioned source ZIP

A9 live-provider authorization remains a separate open gate and does not block this local timeline work.

# V3 — Electron + pnpm monorepo + shadcn/ui Base UI

The user's 2026-10-09 architecture request explicitly brings Electron desktop packaging into scope; earlier statements deferring desktop selection are historical.

- [x] Inspect actual source and current official Electron, pnpm and shadcn Base UI documentation
- [x] Capture fresh V2 baseline on copied multitrack data; preserve original v1/v2 deliverables
- [x] Move shared business/contracts and web/server/MCP transports into pnpm workspaces without duplicating business logic
- [x] Extract embeddable backend startup/shutdown; verify dynamic loopback port, auth, lifecycle, persistence and old business regression
- [x] Implement secure Electron utility-process backend and packaged runtime, userData and local discovery
- [x] Replace generic UI controls with official shadcn/ui Base UI registry components in shared UI package
- [x] Verify aggregate API/MCP/recovery/media regression and browser component/interaction acceptance
- [x] Verify actual Linux Electron launch with sandbox intact, package contents and relocated data
- [x] Produce updated architecture/runtime instructions, source ZIP, verifiable Linux artifact and evidence

No commit/push/deployment/publication, no user Mac access, no paid provider submission. macOS configuration is source-only until tested on macOS; no signing/notarization claim. A9 remains separate and blocked on explicit live-provider authorization.

# V4 — Documented providers and agent tooling

- [x] Verify current official provider documents; select Runway, Ark Seedance 2.5, Gemini Veo 3.1, MiniMax H3 and Vidu Q3 Turbo; exclude discontinued Sora API
- [x] Extend registry, model/input validation, secure configuration and durable generation workflow
- [x] Add genuine CLI and preserve official stdio MCP on one shared HTTP client/service
- [x] Make renderer generation controls reflect model-specific capabilities and configuration
- [x] Deliver portable repository skill and independent forward test
- [x] Run offline adapter contracts, CLI/MCP end-to-end, renderer and native Electron regressions
- [x] Package refreshed source and separate evidence within attachment limits

Live generation remains a separately authorized gate. No provider generation/upload, paid test, user-computer access, commit, push, publication or deployment is included in this implementation work. Original V1–V3 artifacts remain frozen.

# V4.1 — Explicit production/development application IDs

- [x] Centralize production `app.starroy.mioon` and development `app.starroy.mioon.dev` build/runtime identities
- [x] Preserve packaged-dev identity, isolate default data/discovery/output paths and reject cross-channel overrides
- [x] Retain old data; document explicit copy-only migration and new CLI/MCP connection paths
- [x] Add identity/migration tests and pass aggregate plus independent regression
- [x] Build both channels, verify actual Linux native identities/coexistence and run fresh-install builds
- [x] Produce versioned source, updated portable Skill and patch-only evidence without changing earlier artifacts

No UI redesign, npm/CLI renaming, live providers, user-computer access, commit/push/deploy or publication. macOS/Windows native verification remains pending.
