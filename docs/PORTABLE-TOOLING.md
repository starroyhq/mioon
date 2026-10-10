# Q6: local portable tooling and build identity

Date: 2026-10-10 UTC. Baseline: `d46d0729fec04cb236411c973b3fac3f8f87dd78`.
Status: implementation, affected/portable checks, fresh builds and artifact comparison complete; parent independent aggregate/review remains the local release gate. This is the first bounded Q6 increment, not native Mac/Windows release certification.

## Commands

After installing the reviewed lockfile dependencies through the existing approved setup workflow, the command launcher needs Node.js ≥24; doctor additionally requires the selected local FFmpeg/ffprobe executables. They do not invoke a package manager, shell scripts, `.cmd` shims, installers or remote CI.

```text
node scripts/tooling.mjs doctor
node scripts/tooling.mjs doctor --native-ready
node scripts/tooling.mjs build --channel=development
node scripts/tooling.mjs build --channel=production
node scripts/tooling.mjs test
node scripts/tooling.mjs test --suite=portable --concurrency=1
node scripts/tooling.mjs test --suite=full --concurrency=1
node scripts/tooling.mjs test --suite=portable --file=agent-protocol.test.mjs
```

`check:local`, `build:local`, `test:local` are optional root package aliases. Existing `pnpm build`, package scripts and test scripts remain available; they have not all been made cross-platform. `node scripts/doctor.mjs` / `pnpm run doctor` now delegates to the same doctor and prints its structured report.

- **Doctor:** checks Node, root/desktop metadata, exact installed dependency versions, in-memory SQLite and bounded FFmpeg/ffprobe version responses. It does not open a workspace, read credentials/user settings, initialize a token, install, repair permissions or call a provider. Explicit `MIOON_FFMPEG_PATH` / `MIOON_FFPROBE_PATH` overrides are honored by the existing media runner; otherwise its ordinary executable lookup applies. Version probes do not verify codecs, render correctness or native Electron runtime availability.
- **Build:** validates prerequisites before invoking the verified local Vite JavaScript entrypoint, then the existing desktop staging build, strictly serially. The Vite heap budget is passed as a Node argument (768 MiB), not an inline shell environment assignment. Failure or interruption stops the sequence; there is no retry, automatic installation, signing or packaging. Ordinary staging output is still replaced as before after preflight passes.
- **Tests:** portable is the default. Files come from a reviewed explicit manifest, or an explicit sorted directory enumeration for the full lane. `--file` accepts only existing basename entries within the chosen lane; no globs, traversal, arbitrary command strings or silently missing tests. Concurrency defaults to 1 and accepts 1–4. The argument budget is 24,000 characters and at most 512 files; select smaller groups if a future suite exceeds it.

### Exit outcomes

Doctor exits **0** when its local prerequisites pass, **1** for prerequisite/usage failure, and **2** when `--native-ready` is requested but native release gates remain unverified/blocked. A default doctor exit 0 is never a native-ready result: always inspect `nativeReadiness`.

Build/test forward the first child failure code. SIGINT/SIGTERM target only the exact owned child, latch interruption even if it exits 0, and produce the conventional nonzero signal outcome (130/143). Test selection of the full lane outside Linux exits 2 before test execution, with `NATIVE_TEST_LANE_BLOCKED`; it is not reported as skipped or passed. Other invalid selections exit 1.

The build/test launcher forwards signals but does not promise a deadline for a stubborn tool that ignores them, nor process-tree termination. Media probes independently retain the shared 10-second probe timeout and bounded termination/reap policy. No numeric PID fallback or automatic replacement is introduced.

## Package and environment boundaries

The tooling resolves Vite relative to `apps/web/package.json`, and esbuild/Electron relative to the root manifest. It requires exact pinned metadata names/versions, verifies regular expected entrypoints and canonical containment within both the package and repository `node_modules`. Ordinary pnpm links into the local `.pnpm` tree are supported. Outside/global fallback, `node_modules` redirected outside the repository, escaped package/entry symlinks and changed Vite `bin` metadata fail before execution. This checks local provenance/consistency; it is not a cryptographic dependency-integrity or vulnerability audit and does not replace the lockfile/install policy. Electron's package metadata is checked without launching its native binary.

Children use `process.execPath` with argument arrays, `shell:false`, `windowsHide:true` and inherited stdout/stderr. The shared minimal media environment supplies only executable-discovery, home/temp and locale values; Windows aliases/SystemRoot are handled there. Local test children additionally retain the two explicit media-path overrides. `MIOON_ENABLE_LIVE_PROVIDER=0` is forced. Credentials, proxies, `NODE_OPTIONS`, `NODE_PATH`, `VITE_*`, Electron injection controls and unrelated environment variables are not inherited. No environment values are printed.

## One application/channel identity

- `apps/desktop/identity.cjs` remains the channel authority. Build arguments choose the channel; runtime environment variables do not.
- Root `package.json` version is the application/staging authority. Desktop manifest must match it before staging cleanup. No manifest is automatically rewritten.
- Root's exact Electron dependency pin supplies builder configuration. Application and dependency checks share one strict SemVer validator.
- `beforePack` now rejects stale version, any mismatched identity field, unexpected package name/main/private/desktopName or nonempty/invalid runtime dependencies. Existing fuses and disabled publication remain unchanged. No package was created in this increment.
- Existing reported client/health/schema/MCP implementation compatibility metadata `0.4.0` remains unchanged; application version is `0.4.1`. These are not a claim about the MCP wire-protocol revision. Connection descriptor version remains integer `1`.

## Reviewed lanes and native gates

The portable manifest initially contains seven files: `agent-protocol`, `mutation-contracts`, `workspace-layout`, `workspace-state`, `workspace-panel-intent`, `desktop-build-metadata`, `local-tooling` (all `.test.mjs`). The first five are pure state/contract/source checks. New tooling cases deliberately create disposable synthetic files using canonical `realpath(tmpdir())`, inspect SQLite only in memory and run synthetic Node children. They do not use app workspaces, real credentials, sockets, browsers, native vaults or FFmpeg. Canonicalizing these newly owned test paths does not change the runtime refusal policy for user-selected symlinked/aliased data paths.

Full-suite selection currently remains Linux-only because existing tests include POSIX paths, private-storage operations and Linux-specific subprocess/packaging assumptions. Native symlink containment tests are in that full lane, not the portable manifest. Cross-platform simulated paths/environment dictionaries and a portable lane passing on Linux do not prove a Mac/Windows run.

| Gate | Current check/result semantics |
| --- | --- |
| Linux | Doctor/source build can pass. Native readiness still requires evidence for the exact artifact, OS and architecture; doctor does not certify it. |
| macOS | Source checks/build hooks are available in principle; native runtime, Keychain, canonical data paths, package/signing/notarization and media/process QA remain unverified. Full lane refuses. |
| Windows | Private-storage ACL backend remains unimplemented and runtime fail-closed. Portable/source checks do not bypass that gate; full lane refuses. Native installer, vault/ACL, media/path/process QA remain unverified. |
| Other OS | No native support claim. Doctor reports an unsupported native platform. |

## Acceptance

Local evidence root: `evidence/q6-portable-tooling/`.

- Independent read-only review checked command, environment, dependency containment, identity and portable-test boundaries. Its findings were addressed: explicit synthetic Linux branch, shared SemVer validator, real link-escape regressions and extra signal/error cleanup cases.
- Affected suite: **45/45 passed**, zero skips, 6.85 seconds (`affected.log`). This includes 35 new checks and 10 existing identity checks.
- Actual portable entrypoint: **66/66 passed**, zero skips, 1.11 seconds (`portable.log`). Windows/macOS were not executed.
- Actual Linux doctor: exit **0**, Node 24.19.0, SQLite 3.53.3, Vite 7.3.1, esbuild 0.27.7, Electron package 44.7.0, FFmpeg/ffprobe 7.1.5. `doctor --native-ready` correctly returned **2**, retaining the unverified exact-artifact gate (`doctor*.json`, `.stderr`, `.exit`).
- Fresh actual `build --channel=development` passed: web 7.77 seconds, followed by desktop staging. Existing Base UI directive/large-chunk warnings are retained in `build.log`. All **49/49 generated files are byte-identical** to the Q5 final/native-tested bundle (`artifact-comparison.json`); native UI evidence is carried forward explicitly, not rerun. Main/backend, web JS/CSS, package metadata and license files all match.
- Parent independent full aggregate remains the release gate; no duplicate full aggregate was run by this worker.

No signing, notarization, installers, publication, remote CI execution, actual credentials or live provider calls were part of this increment. No network packet capture was performed. Remaining Q6 includes native-specific lanes, OS/architecture package layouts and archive inspection, signed-release infrastructure and real Mac/Windows verification; this local runner deliberately does not invent those results.
