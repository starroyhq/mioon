# Current execution index — 2026-10-13

The M0–M3 and V2–V4.1 checklists below are historical delivery records, not the
remaining product queue. Current committed code is `dc3bbe8cf664017f4c1a3d0dbb56d3ece5e1e374`:
user UI merge `4858642` and backend-only opt-in float-checked exports are verified
in [STATUS](STATUS.md), with separately attributed full-suite and runtime evidence.
This documentation-only update does not repeat those tests.

The limited local Linux trial is available. Follow the [source startup guide](docs/CORE-TRIAL.zh-CN.md)
for commands and [STATUS](STATUS.md) for the newer code/Git boundary. To identify
this checkout and the accepted UI merge history without running the application:

```sh
git rev-parse HEAD
git show --format='%H%n%P%n%s' --no-patch 48586426d4a5e52a2a4daf7ef84fbd5f5c26e02b
```

Prioritize stability and useful bounded slices within the [six remaining directions](docs/PRODUCT-ROADMAP.md#current-delivery-and-remaining-work-2026-10-13).
They are feature directions, not six commits or a promised completion date.
New backend work must preserve the user's UI, existing shared contracts, original
media and historical receipts. New logic uses TS; gradual legacy migration must
not become a whole-repository rewrite. Do not start another feature solely to
keep a queue busy or treat distant roadmap completion as a prerequisite for trial.

Mac/Windows native acceptance and real-provider work remain separate, specifically
scoped gates. The last verified GitHub `ccfaab5` / Mac `08890b7` observations were
not refreshed here; later local commits are not implicitly approved for push.
No platform candidate, ordinary source build or Mock result establishes those gates.

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
