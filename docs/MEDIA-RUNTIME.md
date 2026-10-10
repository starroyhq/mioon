# Local media runtime and shutdown

Implementation: 2026-10-09; acceptance continued 2026-10-10 UTC. Q3 baseline: `dceb8dd`.

Status: implemented; final affected tests, fresh bundles and ordinary Linux
Electron verification passed. Released as `d01ea23`; the parent's independent
final suite passed 1,472 tests, failed zero and explicitly skipped two
foreign-owner cases (1,474 total). This batch changes local process safety, not
Agent tools, generation authorization or media editing semantics.

## Shared execution boundary

`media-environment.mjs`, `media-runtime.mjs`, `media-processes.mjs` and
`media-probe.mjs` own the shell-free media boundary. Import/probe, generated
output validation, mock generation, timeline segments/concat and desktop binary
validation use it. Commands receive generated argument arrays; configured
FFmpeg/ffprobe paths remain absolute and are not shell-quoted or split.

The media environment is an explicit allowlist, not a credential-name denylist:

- POSIX: `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`, `LANGUAGE`, `LC_ALL`,
  `LC_CTYPE`.
- Windows policy seam additionally preserves `SystemRoot`, `WINDIR`,
  `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, with case-insensitive known aliases.
- Provider/Agent keys, unknown environment names, proxy/cloud credentials,
  `NODE_OPTIONS`, `NODE_PATH`, `LD_*` and `DYLD_*` are not passed. Caller-supplied
  environment overlays cannot widen this boundary.

The desktop backend environment still contains explicitly configured provider
variables needed by provider adapters. The separate media boundary removes them
before starting FFmpeg/ffprobe. This does not inspect or print real secrets.
Selected binaries are trusted local executables; environment reduction is not
a sandbox for a malicious executable or an OS CPU/RSS quota.

## Resource policy and compatibility

| Resource | Bound |
| --- | --- |
| Captured stdout | 4 MiB total; callers may lower it |
| Stderr | 1 MiB total; at most 16 KiB retained internally |
| Default tool timeout | 120 seconds |
| Desktop version / encoder checks | 10 seconds; version stdout 1 MiB, encoder stdout 4 MiB |
| Mock render | 60 seconds |
| Stitch / final concat | 300 seconds |
| Timeline segment | Existing `max(120000, frames / 30 * 5000)` milliseconds; up to 50 minutes for the existing ten-minute timeline limit |
| Concurrent probes | Four active probes; ordinary batches queue |
| Probe metadata | At most 256 streams, each dimension at most 16,384, at most 67,108,864 pixels per stream |
| Metadata duration | Finite and nonnegative when present; no new maximum duration or codec ban |

Missing / `N/A` duration remains supported. Audio-only input remains supported.
Landscape, portrait, 4K and ordinary 8K dimensions fit the policy. Unusually
large images/video metadata, excessive streams, or excessive tool output now
fail with a bounded, fixed error. Metadata limits apply after ffprobe has parsed
input, before subsequent full decode/render; they do not prove that a decoder
never allocates memory while probing. Active-probe concurrency is bounded;
this is not a claim of a globally bounded HTTP request queue.

Errors carry fixed codes such as `MEDIA_OUTPUT_LIMIT`, `MEDIA_TIMEOUT`,
`MEDIA_CANCELLED`, `MEDIA_INVALID_METADATA` and `MEDIA_SPAWN_FAILED`. Raw child
output, argv and source paths are not included in outward runtime errors.
Existing timeline filters, encoding settings, fixed snapshots and publication
semantics are preserved.

## Stop and recovery contract

1. Server shutdown aborts its signal before draining HTTP or taking the owned
   child snapshot. Agent SSE and inference are closed before SQLite shutdown.
2. A worker operation has a backend-created cancellation signal. Every awaited
   stage is fenced before starting another provider/media phase or publishing a
   database result. An aborted queued probe never starts a child.
3. Owned direct media children receive TERM, then KILL after two seconds, then
   one further second for observed exit: three seconds total. A sent signal is
   not an exit receipt. Unconfirmed children remain tracked until the exact
   owned handle emits `close`, and produce a shutdown failure. Observing `exit`
   alone does not release retained accounting; no further signal is sent after
   observed exit. While any owned child is unconfirmed, that process refuses
   new media starts through the same central record set. Existing children of
   other owners receive no extra signals. This deliberately pauses all media
   owners in that JS process until actual close; other backend processes are
   unaffected. Such children are never reported as reaped.
4. Worker/server shutdown is bounded to five seconds. SQLite is not closed as
   a successful shutdown if owned work or child termination is unconfirmed.
5. Desktop supervision allows ten seconds of graceful shutdown, two seconds
   after TERM, and one second after KILL for exit confirmation: thirteen seconds
   total for the stop attempt. A missing exit produces an unconfirmed outcome,
   retains the exact child, blocks restart and shows a fixed warning without a
   recursive quit loop. The application can then remain open awaiting actual
   exit; thirteen seconds is not a promise that the whole app will quit. An
   eventual confirmed exit may complete the already-requested cleanup once.
   Startup validation has the same bounded media stop attempt and retained
   exact-handle observation, with no late backend creation after quit.

Terminating direct children is not process-tree containment. After an abnormal
utility exit, remembered numeric media PIDs are not sufficient ownership proof:
main sends no PID-only media signal. Unresolved media cleanup blocks automatic
replacement/restart in that app lifetime. An explicit native “退出应用” warning
allows the user to exit with failure status rather than remain trapped; it does
not certify that old media processes stopped. A later new app lifetime cannot
certify those old processes either, so a manual OS process check may be needed
before resuming work. No persistent cross-platform process-identity framework,
process-group kill or unrelated PID kill is added. Exit/reap timing is not a real-time guarantee
if the host event loop or OS is suspended. Native macOS/Windows process cleanup
still requires platform QA; Node accepting a signal name is not proof of native
Windows behavior.

### Generation and export state

- Reference preparation cancelled before adapter invocation leaves the queued
  generation and zero new submission attempts intact.
- A common live-request preflight can explicitly prove `beforeDispatch:true`.
  Cancellation after a POST may have reached the provider stays
  `submission_unknown`. Stopping local work never proves cancellation of a
  charge or authorizes an automatic new generation POST.
- A 50 ms submit-settlement window can preserve an already received
  accepted task ID or an explicit pre-dispatch rejection. A missing receipt or
  late completion outside that window cannot become a confirmed no-write.
- Poll/download interruption preserves the existing provider task and snapshot.
  Late adapter values cannot publish after cancellation. Built-in adapters
  cooperate with the signal; this is not a sandbox for arbitrary injected code.
- An ordinary media failure with unconfirmed termination latches the worker
  stopped, prevents existing-output download fallback and future queued work,
  and preserves the failure through sibling hash/probe errors and cancellation.
  The affected recoverable task retains a fixed, non-retryable local diagnostic;
  this does not make an ambiguous generation eligible for a new paid retry.
  Later shutdown still reports the unconfirmed outcome rather than success.
- Interrupted local exports retain the original queued snapshot. Restart may
  re-render that same local export; no new export intent is created. Temporary
  output cannot be published as a successful asset after a stopped operation.
- Existing Agent conversations and approved edits retain their own durable
  recovery rules. Restart does not automatically resume Agent inference or
  reapprove/reexecute a reviewed edit.

## Platform limits and acceptance

Windows remains fail-closed at the private-storage ACL gate from Q2. The
environment aliases and stop adapters are testable seams, not Windows release
certification. macOS must verify actual selected binary paths, loader/runtime
requirements and native quit behavior; inherited `DYLD_*` is deliberately not
preserved. No new platform installer or security-setting change is included.

Required evidence:

- Synthetic unknown-secret/proxy/cloud/Node-loader sentinels absent from actual
  child environments; path spaces/Unicode and explicit executable selection.
- Output overflow, invalid metadata, pre-abort, timeout, TERM-ignoring child,
  hard-kill confirmation, unconfirmed termination, scoped worker ownership and
  queued-probe cancellation.
- Stop during reference preparation, submit, poll, download, probe and export;
  late responses cannot spawn/publish; possible POST acceptance remains unknown
  and restart does not create a second submission.
- Actual short portrait/landscape/4K/audio output plus existing real timeline,
  provider, HTTP, CLI and official-MCP export tests.
- Ordinary sandboxed native app: short export succeeds; quit during an actual
  long FFmpeg render exits with no observed owned backend/media child; a new
  app lifetime rediscovers the same frozen local export without duplicate
  publication. Screenshots establish visible behavior; PID/SQLite evidence
  establishes process and recovery claims.
- Serial final build and bounded aggregate; exact source and bundle hashes.

Q3 evidence is stored locally under `evidence/q3-media-runtime/`. The synthetic
native launcher is `tests/media-runtime-qa-native.mjs`; it uses private test
directories and no renderer hooks, remote-debugging flags or live provider.

### Recorded local verification, 2026-10-10

- Final affected suites ran serially: media bounds/probes/paths 26/26; worker,
  HTTP lifecycle, races and provider parity 86/86; desktop lifecycle/storage/
  secrets and real-export shutdown 83/83. These overlapping suites are not a
  combined full-suite result. Synthetic tests cover the unconfirmed-close gate,
  stale numeric PIDs, late callbacks, possible POST acceptance and retained
  durable task diagnostics.
- The earlier full suite passed 1,464 tests, failed zero and explicitly skipped
  two foreign-owner cases (1,466 total). That result predates the final
  unconfirmed-termination corrections and is retained as **pre-fix evidence**,
  not a final aggregate pass. The initial source-review clearance was withdrawn;
  the follow-up review found no remaining blocker after those corrections.
- Fresh Vite and desktop builds passed, serially, using installed entrypoints
  (`node .../vite.js build`, `node apps/desktop/scripts/build.mjs`). No dependency
  change or download was needed. Final native launches used main bundle SHA-256
  `01034118c3580ab55ca43e7fa47dc26ae91ae7ff6cfeee7cee9a23b1e1d497e0`
  and backend bundle SHA-256
  `7095a87fe8dd55739c1c8b73d5210c32b12238e6f3befb42dc21c9eccf1d7e48`.
- Ordinary sandboxed Electron 44.7.0 development-channel QA used three distinct
  app lifetimes on the cloud Linux desktop. A real two-second 720×1280 H.264
  export with audio completed and played in the native UI. Its 7,348 bytes and
  SHA-256 `1e0c62a5a699ebfe02a5092ff5f982aa537eeab4309b9d2300667b140124ecee`
  matched the published asset after every restart.
- The same ten-minute frozen local export resumed across app recreation. The
  final lifetime observed its owned backend, two probes and active FFmpeg; a
  native titlebar close ended the app with code 0 in 574 ms. None of those exact
  PID/start-time identities remained afterward. SQLite still had the same two
  export intents, three assets, queued long export and no long-export asset;
  there were zero generation jobs and zero Agent runs. Seven native screenshots
  record UI behavior; process identities and SQLite/byte audits supply the
  separate shutdown/recovery evidence.
- The first two native observation attempts encountered empty virtualized
  task-child lists. They do not prove media-process cleanup. The final synthetic
  helper was corrected to bounded, read-only PID/parent/start-time metadata and
  rerun successfully; it never signals a PID. This unbundled QA helper alone
  changed after the builds. Production/test behavior and both native bundle
  hashes remained frozen. Original limitation and diagnostic records are kept.

This verifies observed direct children on Linux, not an exhaustive packet
capture, arbitrary grandchildren, native macOS/Windows, or a forced orphan's
cleanup. The abnormal utility-exit uncertainty path is covered by deterministic
owned-handle tests; no unrelated real process was killed to demonstrate it.
EQ-05 HTTP file-stream error handling is tracked separately in [HTTP-STREAMS.md](HTTP-STREAMS.md).

## Official API references

Checked 2026-10-09: [Node child process API](https://nodejs.org/api/child_process.html)
for explicit environments, exit/close distinction and signal semantics (current
documentation; local execution uses Node 24);
[Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
for the owned utility handle and exit event. A successful signal call alone is
not an observed process exit. These references do not substitute for native
platform verification.
