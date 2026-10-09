# V4.1 application identity acceptance — 2026-10-09

## Delivered change

Source/desktop version `0.4.1` fixes the requested IDs:

- Production: `app.starroy.mioon`
- Development: `app.starroy.mioon.dev`

One checked-in identity definition drives Electron runtime identity, builder config, Linux desktop name / WM_CLASS, package metadata, artifact names and default data roots. Production and development packaging explicitly rebuild their own channels and refuse opposite-channel staging. A packaged development app retains `.dev`; `NODE_ENV` or `WB_DESKTOP_CHANNEL` at launch cannot change the embedded identity. Windows AppUserModelID is assigned in source; macOS bundle ID is configured. Neither platform has native validation in this delivery.

`pnpm desktop:build` defaults to development. `pnpm desktop:build:production` builds production staging. Linux package commands are `pnpm desktop:package:linux` and `pnpm desktop:package:linux:dev`; `package:dir` / `package:dir:dev` create unpacked applications. New outputs use separate `release/desktop/production/` and `release/desktop/development/` directories.

The original UI, npm workspace names, public CLI command and shared backend remain intact. The Dev system application name and `-dev` executable suffix make the two applications distinguishable. No provider behavior or business schema changed.

## Data and client safety

Default userData is Electron appData plus the exact application ID. Each channel has its own workspace, tool config, Chromium state, single-instance lock and private discovery/token files. Explicit userData overrides still require absolute paths; a private `desktop-identity.json` marker refuses reuse by the other channel.

The former `video-workbench/` data root stays untouched. No automatic move, delete, merge or import occurs. First launch in the new root starts a fresh workspace. Use the existing copy-only migration helper after closing both versions, with a backed-up source and a nonexistent destination workspace. It rejects active locks, pending WAL, symlink paths and existing destinations. Old project/media bytes remain intact. See [DESKTOP.md](DESKTOP.md) for exact paths and recovery instructions.

CLI/MCP continue using the same protocol. Set `WB_CONNECTION_FILE` explicitly to the desired channel's descriptor. There is no automatic fallback between channels or redirect from the historical root. Descriptor version remains 1 with additive, non-secret `appId` and `channel` metadata. The portable Skill's connection reference is updated accordingly.

## Current verification

All current evidence is under `evidence/v4.1-app-id/` in the optional V4.1 evidence ZIP.

- Aggregate: **301/301 passed**, zero failures/skips; `full-regression.tap`. Independent parent rerun: **301/301**, `parent-regression.tap`.
- Focused desktop: **36/36 passed**, including 10 new identity/channel, mismatch rejection, data/discovery isolation, explicit-override guard and non-destructive legacy migration tests; `desktop-tests.tap`.
- Shared Web build and both production/development Electron staging builds: pass. Matching `production-metadata.json` / `development-metadata.json` record IDs and channels.
- Actual Linux Electron development runtime: **21/21 passed**, version 0.4.1, Electron 44.7.0, bundled Node 24.21.0 and SQLite 3.53.4. Includes embedded identity/data ownership, six provider entries, sandbox/no Node bridge, private cookie/discovery, restart/auth rotation, process crash recovery, dirty-exit cancellation and actual 720×1280 FFmpeg output/playback; `smoke.json`, `electron-workbench.png`.
- Both real unsigned Linux unpacked packages built successfully with electron-builder 26.15.3 using the already-installed official Electron distribution. **9/9 black-box package checks passed**: exact ASAR identity/desktop metadata and security fuses; correct bundled utility executable; default ID-based data roots; launch-time opposite-channel environment values ignored; same-channel second launch reuses its existing instance; production/development run simultaneously with independent projects/backends; legacy folder retention; normal exit clears only its own private connection/lock files and preserves project data. See `packaged-runtime.json` and `*-package.log`.
- Own-cloud native window inventory identified both `app.starroy.mioon` and `app.starroy.mioon.dev` at once. CUA screenshots `packaged-production.png` / `packaged-development.png` and `native-window-identities.json` were visually reviewed. No user computer was accessed.
- A fresh isolated source copy installed from the official registry with `pnpm install --frozen-lockfile`, normal approved lifecycle scripts and supply-chain checks enabled. Then normal pnpm Web, production desktop and development desktop builds passed, and all 36 desktop tests passed again. `clean-install.log`, `clean-*-build.log`, `clean-desktop-tests.tap`. The first offline attempt lacked registry metadata; a normal fresh install resolved it without bypassing checks. Lockfile and workspace policy remain byte-identical to V4.

The initial package QA harness checked utility argv[0], which Electron can rewrite; it was corrected to compare `/proc/PID/exe`, as in the prior package QA. This was a harness assertion, not an application identity defect. Final reports reflect the corrected real-process verification.

## Artifacts and limits

Run `python3 scripts/package-v4.py --app-id-patch` for the V4.1 source, updated portable Skill and patch-only evidence. Every ZIP is capped at 15,000,000 bytes, checked for ZIP integrity and verified against per-file manifest sizes/SHA-256 hashes. Exact output hashes are recorded in `deliverables/v4.1-package-result.json`. Historical V1–V4 deliverables, including `video-workbench-v4-source.zip` and the 0.3.0 Linux binary, remain unchanged.

The source archive contains all ten workspaces and original synthetic examples; it excludes dependencies, built packages, private tokens, live workspace data and repeated old evidence. The two new Linux unpacked builds are local QA outputs; no new installer archive is delivered or published. The historical 0.3.0 binary does not gain these identities.

macOS/Windows native execution, installation/upgrades, signing, notarization, registration and distribution are unverified. FFmpeg/ffprobe remain declared external dependencies. Browser-only broad regression was not rerun for this identity-only patch; the current aggregate and native checks cover the affected paths, while prior UI acceptance remains historical V4 evidence. No live provider call, remote upload, credentials/account access, payment, commit, push, deployment or publication occurred.
