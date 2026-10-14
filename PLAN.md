# Current execution index — 2026-10-14

The M0–M3 and V2–V4.1 checklists below are historical delivery records, not the
remaining product queue. Current committed baseline is `f8b91713af0c8ed3994e32fa57447827a0ab3883`.
[STATUS](STATUS.md) and dated acceptance reports record the independent project home,
multiple project windows, bounded sound audition, exported-file loudness and complete
current-mix candidates, plus fixed schema/profile prerequisite. Their actual gates
are separate; the [atomic loudness apply slice](docs/TIMELINE-LOUDNESS-APPLY.md) is
currently under integration and its final feature gate is not yet complete.

The limited local Linux trial is available. Follow the [source startup guide](docs/CORE-TRIAL.zh-CN.md)
for commands and [STATUS](STATUS.md) for attributed code/Git observations. Identify
this checkout with `git rev-parse HEAD`; a local checkpoint does not imply remote sync.
Prioritize the current explicit apply/undo/output remeasurement slice, then bounded
stability and useful stages within the [six remaining directions](docs/PRODUCT-ROADMAP.md#current-delivery-and-remaining-work-2026-10-14).
They are feature directions, not six commits or a promised completion date.
New logic uses TS; gradual legacy migration must not become a whole-repository
rewrite. Preserve the user's workbench, original media, shared services and receipts.

Mac/Windows native acceptance and real-provider work remain separately scoped gates.
The dated Git observations in STATUS and the roadmap are historical observations,
not a fresh remote check. No platform candidate, source build or Mock result proves
native/live quality, and later commits do not carry implicit push authority.

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
