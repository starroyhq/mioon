# Timeline delivery preflight

Updated: 2026-10-10 UTC. Baseline: `fd49dac`.
Status: implemented and locally verified; independent release review is pending.

## Bounded increment

The shared `timeline.export.preflight` operation checks an existing saved timeline
before an explicit timeline export. The right workspace has a delivery-check tab;
opening it does not discard the property/source/Agent drafts. Reports concern the
saved snapshot only. No export, cache, project, history, mutation receipt or model
task is created by checking. The built-in Agent's fixed tool allowlist and context
consent are unchanged.

The report pins project, existing timeline ID/revision and a SHA-256 snapshot
fingerprint. Known errors, incomplete checks and stale reports are distinct.
Successful checks are advisory: media can change after checking, complete decode
has not run, and final render/output validation remains authoritative. Disk space,
encoder availability and later filesystem availability are not certified.

## Shared rules and checks

Preflight and actual timeline rendering reuse the renderer's existing validator:
720×1280 at 30 fps, at most 12 tracks/100 clips/18,000 frames, track/media
compatibility, integer source bounds, rectangles, gain/fades, overlap, unsupported
effects and duration consistency. Editing validation is not replaced. Original
snapshot field absence and legacy replay receipts remain compatible.

Both paths use shared managed-source preparation: ownership and frozen metadata
binding, safe managed-file identity, incremental byte hashes and one bounded
local ffprobe per unique source. This does not decode the complete media. Local
protocol/demuxer restrictions cover existing supported images/video/audio and
exclude playlist-driven remote reads. FFprobe still parses untrusted media; it
is not a complete decoder sandbox. Same-account/root pathname races remain
outside the private-storage boundary.

Preflight-only limits: 100 unique assets, 512 MiB per source, 1 GiB total hashed
bytes and 30 seconds including waits. Work is serial and admission bounded.
Budget/time exhaustion is **incomplete**, not proof of corrupt input and not a
new export-size ban. A user can explicitly choose to try exporting an incomplete
check when no known blocking issue exists; the actual worker still runs its
mandatory checks. Known blocking/stale reports cannot present a successful pass.

Ownership graph reads also have a 4 MiB / 1,024-record bound, with individual
SQL row-size limits. Preflight checks the composition under that aggregate budget;
an early exhausted read returns incomplete with no fabricated timeline binding,
digest or partial summary. The actual worker validates distinct clip/source
lineages independently before file I/O, avoiding a new composition-wide limit
(for example, 42 independent valid sources with 100 KiB job rows). Each lineage
retains the 4 MiB / 1,024-record safety bound: a single unusually large lineage
can still be refused. This is a separately disclosed render-time security bound,
not one of the advisory source-byte/time limits.

The worker also retains each export row’s relational ID/project before recovery
or status writes. All export identities must be UUIDs matching their relational
IDs/projects, so changing the payload mode cannot bypass this ownership gate.
Timeline-export JSON is limited to 4 MiB before materialization; duplicate mode
keys and non-object records are refused. Malformed or mismatched records are left
untouched with a fixed local diagnostic rather than rewritten as failed under an
untrusted ID. Valid storyboard payload handling remains otherwise unchanged,
including its unbounded JSON materialization. This increment does not claim
generic database integrity or generation-worker identity hardening.

An incomplete report without a usable checked digest offers a separately labeled
explicit attempt against the current saved project/revision. That action has no
`preflightSnapshotHash`, does not invent a successful report, and is independently
fenced against project/revision changes and duplicate submission. Known blocking
issues and stale reports cannot use this path. Normal checked export continues
to use the report's immutable digest.

## State, replay and transport

- Missing timelines stay missing; no lazy `ensure` or write transaction.
- Capture bounded project/timeline/asset records consistently, then release the
  read snapshot before asynchronous file work; recheck ownership/content after.
- Reports omit filesystem paths, source bytes, probe output and provider data.
- Changed project/revision/snapshot invalidates a report. Old responses cannot
  replace a newer report or authorize export in a different project.
- Optional `preflightSnapshotHash` binds a new `timeline.render` request. Exact
  original replay happens first, before current revision/digest checks. Existing
  callers without this field retain their existing request semantics.
- Export still requires an explicit user action and the original stable request
  identity. Checking, tab changes, disconnects and recovery never submit an export.
- Check cancellation stops observation/read work through the shared lifecycle;
  it is not cancellation of a separate business task. Only this explicit read-only
  operation opts into HTTP observer cancellation, additionally guarded by its
  effect metadata; generation and render disconnect semantics are unchanged.
- The shared CLI/MCP client defaults to 35 seconds for this new operation only,
  allowing best-effort cleanup/delivery after its 30-second work budget. Explicit
  caller deadlines always win; existing operation defaults remain 30 seconds.
  Pending filesystem work stays owned until settlement and can prevent confirmed
  shutdown. Timers do not establish a hard real-time guarantee.
- HTTP, CLI and official MCP share the operation and effect metadata. Read-only
  includes local metadata probing, not only database reads.

## Acceptance gates

1. Shared validation and actual export parity, including legacy snapshots/replay.
2. Missing/corrupt/foreign/oversized source and metadata, safe paths/identity,
   disguised playlists, finite bounds, budgets, shutdown and queued cancellation.
3. Zero database/media writes across success, failure, repeated checks and absence.
4. Snapshot drift and post-check file mutation remain safely rejected; old exact
   export receipts remain recoverable.
5. Actual authenticated HTTP, CLI and official MCP checks against synthetic data.
6. Dock draft/context fences, stale/reordered responses, incomplete consent and
   explicit export; no hidden automatic render on report/open/reload.
7. Fresh builds, ordinary native missing-media report, known-valid real FFmpeg
   export, screenshots and unchanged-source proof.
8. Independent parent aggregate and exact source-hash review before release.

## Verification

- The first 25-file affected run recorded 456 tests: 454 passed and two failed
  (one legacy hash-error text assertion plus its containing suite). The source
  tamper was correctly refused. Its original fixed, path-free message was restored;
  the failed log is retained rather than described as a passing aggregate.
- Final backend/real-media/shutdown rerun: 76/76 passed, including all nine existing
  multi-track media cases, actual backend SIGKILL recovery, legacy storyboard
  decode, guarded row reassignment and the single escaped discriminator case.
- Final compact-report UI suite: 44/44 passed. Earlier HTTP/CLI/official MCP,
  observer disconnect, inspection, waveform, fade, client and draft regressions
  passed in the affected run. No duplicate local full aggregate was run; the
  parent’s independent full suite remains the release gate.
- Fresh web and desktop builds passed. Existing >500 kB chunk-size advice remains.
  The final 49-file build manifest matches observed browser script/style URLs and
  both ordinary native process launches.
- Cloud browser: explicit-only checking; visible missing-media block; retained
  unsaved clip draft and navigation confirmation; save invalidates the old report;
  explicit recheck/export succeeds; reload returns to idle without resubmission.
- Ordinary sandboxed Electron: visible missing-media block, project-context reset,
  ready report retained across dock collapse, explicit successful export, normal
  shutdown and full app recreation. Recreated reports stay idle. Two native PIDs
  exited normally; export/task counts and frozen snapshots stayed unchanged.
- Browser and native each produced exactly one local export. Both outputs fully
  decode as 720×1280 H.264 video, 60 frames / 2 seconds with audio. Original
  imported source hashes remain unchanged; there are no generation jobs, Agent
  runs, waveform entries or range/disposition requests in either fixture. The
  browser has one deliberately saved clip-name edit; native timelines are unchanged.

Evidence is retained under `evidence/export-preflight/`: original failure logs,
`final-compatibility.log`, `ui-compact-final.log`, `build-final.log`, runtime audit
JSON, screenshots, and final source/build manifests. Screenshots 01–02 are the
superseded tall-disclosure layout. Final native 08 shows the blocking reason;
10–11 show a ready report; 12 shows completion; 15 shows recreated idle state.

No live-provider, real-key entry, Mac/Windows native, packaging, full-decoder
security or generic database-integrity claim is made.
