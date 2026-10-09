# Status — 2026-10-09 — V4.1

Current source/desktop is 0.4.1: production `app.starroy.mioon`, development `app.starroy.mioon.dev`. Build-time channel metadata is fixed in the application; packaged development stays `.dev`. Data/discovery and package output paths are isolated, and legacy data is preserved for explicit copy-only migration. CLI/npm/UI names remain compatible.

Current verification: 301/301 aggregate and independent rerun; 36/36 focused desktop; Web and both channel builds; 21/21 real Linux development Electron checks; 9/9 real two-channel packaged coexistence checks. Fresh official-registry frozen install, both clean desktop builds and clean desktop tests pass. Exact details and limits: [ACCEPTANCE-V4.1.md](docs/ACCEPTANCE-V4.1.md).

V4.1 source, updated Skill and patch-only evidence are separate ≤15MB ZIPs. Historical V1–V4 artifacts and original data are unchanged. Local Linux unpacked packages were built for QA only; no new published installer, macOS/Windows native verification, signing, notarization or live-provider verification is claimed.

## Historical V4 baseline

V4 implements five documented real-provider adapters plus a local mock provider, a genuine CLI, a shared authenticated agent client, the official SDK stdio MCP bridge, and a portable repository Skill. Electron + pnpm + official shadcn/ui Base UI, the canvas, immutable versions, and the real multitrack FFmpeg compositor are preserved.

Providers: Runway Gen-4 Turbo; Ark Seedance 2.5; Gemini Veo 3.1 preview; MiniMax H3 V2; Vidu Q3 Turbo. Per-model capabilities and safe configuration status drive UI/CLI/MCP. MiniMax/Vidu have explicit global/CN settings with no cross-region fallback; Vidu also needs a separately verified exact output-host list. Unsupported model/input/seed/ratio/duration requests fail locally. Secrets remain backend-only. No live generation has been performed.

Historical V4 automated verification: 291/291 tests, including 142 provider tests with injected HTTP, real CLI subprocess + MCP SDK flows, stable request replay, lost-response recovery, count/revision conflicts, bounded watch/Ctrl+C, safe media transfer and auth rotation. Actual Chromium provider acceptance verifies all six choices, compact Chinese configuration disclosures, text/image mock MP4s and preserved timeline. Original browser regressions pass 13 timeline + 10 original + 12 Base UI cases. Native Linux Electron 0.4.0 development-runtime smoke checks all six provider entries together with sandbox/auth/process recovery and actual video playback. Exact final evidence is in docs/ACCEPTANCE-V4.md.

The Skill passes the official quick validator and an independent forward test: a fresh consumer used only the Skill/instructions, completed import → shot → mock generation → selection → timeline → MP4 export/download, decoded the video and read the same state through real MCP. Clean frozen-lockfile offline installation, both builds, CLI bin, doctor and byte-identical relocated multitrack rendering pass.

V4 baseline source was version 0.4.0. The previously verified Linux 0.3.0 binary archive remains unchanged and does not contain V4. V4 delivery consists of source, the reusable Skill and separate evidence; no new installer, signing, notarization, update or publication claim. macOS native testing remains unverified. FFmpeg/ffprobe remain explicit external requirements.

All original V1–V3 deliverables are preserved. No user Mac access, commit, push, deployment, external reference upload or paid provider call occurred. Live-provider/A9 verification still requires separate provider/model/region/media/count/currency-limit approval and secure backend configuration.
