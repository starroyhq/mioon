# HTTP streaming and disconnect boundaries

Q4 baseline: `d01ea23`; implementation date: 2026-10-10 UTC.
Status: implemented; final affected tests, fresh builds and ordinary Linux
Electron verification passed. Parent independent main suite passed 1,507 tests,
failed zero and explicitly skipped two foreign-owner cases (1,509 total).
Two subsequently added shutdown-edge regressions passed separately; production
source was unchanged. Ready for final source review and local commit.

## File responses

Media and renderer files share `apps/server/src/file-response.mjs`. One opened
FileHandle supplies both regular-file/finite safe-integer size validation and
its bounded read stream. Replacement/deletion of the pathname after open does
not switch the response to a different descriptor. Overwriting the same inode
can still change bytes; this is not an immutable file snapshot or a new
filesystem authorization boundary. Existing managed-media path authorization
and private-workspace policy remain in force.

- Existing authenticated media GET/HEAD, single byte ranges, suffix/open-ended
  ranges, clamping, 416 behavior, download names and private cache headers are
  preserved. Static routes remain GET-only with the existing index fallback and
  no-cache policy. No ETag/304 or multipart-range feature is added.
- Missing managed bytes return a fixed 404 `FILE_UNAVAILABLE`; missing renderer
  fallback returns the existing 503 `BUILD_REQUIRED`. Other pre-header read
  failures use fixed errors without source paths/raw operating-system messages.
- A pipeline owns asynchronous source/destination errors and backpressure.
  Failure after headers destroys that response rather than attempting a second
  JSON response. A short read of the opened size is an incomplete transfer,
  never a successful truncated body. Reads stop at the observed size.
- Disconnect destroys the read source. HEAD, empty files, rejected ranges,
  errors, late-open cancellation and shutdown all close their descriptor.
- Per backend, at most 32 opening/active file responses are admitted. Excess
  requests receive fixed 503 `FILE_RESPONSE_BUSY`; there is no waiting queue.
  Readable and counting-transform high-water marks are 64 KiB. Standard Node
  stream/socket and OS buffers are additional; this is not an OS memory quota.
- A streamed body with no local read progress for 30 seconds is closed. Progress
  refreshes the timer, so there is no new overall duration limit for a healthy
  large file. This timer includes its blocked final body flush but starts after
  open/stat; it cannot forcibly interrupt a nonsettling filesystem syscall.
  Pending open/stat retains its admission slot and can await indefinitely until
  the filesystem returns. Disconnect closes the client side, but does not prove
  that a pending filesystem operation or descriptor has been released.
- HEAD, empty-file and 416 responses have no read stream. They close their
  descriptor immediately without awaiting the tiny header-only response flush,
  then release the file slot. Their socket flush is not covered by this helper's
  30-second body timer or file admission cap. These are not globally bounded
  HTTP connections; the existing server shutdown socket deadline still applies.
- Server shutdown aborts file transports and waits for their cleanup alongside
  the existing bounded server lifecycle. A late open is immediately closed,
  not streamed. Existing five-second shutdown failure behavior bounds the
  caller's wait, not the filesystem operation: it rejects rather than report
  successful cleanup if an open/stat/close promise has not settled. The exact
  active record remains retained until actual cleanup. No automatic replacement
  backend is authorized by that timeout.

## Agent SSE

The SSE transport is independent of durable run state. A socket close, slow
consumer or response error detaches that subscriber only. It does not approve
an edit, cancel business work, Stop a run, acquire credentials or retry a model
POST. Explicit authenticated Stop and server shutdown retain their existing
separate durable semantics.

The small `chat-sse.mjs` transport helper owns response listeners, heartbeat,
write failure, drain timeout and subscription cleanup:

- At most 32 transport clients per backend, including terminal responses until
  actual finish/close. Excess admission uses `AGENT_CHAT_BUSY` (429). Runtime
  subscriber limits remain separate; freeing one does not release an unfinished
  socket's transport slot.
- 256 KiB ordinary pending bytes, including the next UTF-8 SSE frame and HTTP
  chunk framing, plus at most one outstanding large frame of at most 2 MiB.
  This finite allowance preserves valid snapshots: 128 KiB assistant text can
  expand sixfold under JSON escaping. Current public text/edit/tool DTO bounds
  give a conservative serialized size under 1,073,872 bytes. Provider request
  and raw output payloads are not included in that DTO.
- A write returning false pauses further writes; queued events stay within the
  same budget. Heartbeats are sent every 15 seconds only when not blocked and
  do not refresh a stalled deadline. There is no hidden unbounded event queue.
- Pending writes, including small writes returning true, and unfinished end()
  receive a 30-second stall deadline. Real callbacks/drain count as progress;
  stale callbacks cannot extend a later backpressure generation. There is no
  transport duration cap for a healthy run.
- Error, cap overflow and stall destroy the affected response and detach once.
  Synchronous terminal replay before subscribe returns still releases the late
  detach handle. Shutdown permits normal finish callbacks but destroys remaining
  blocked/buffered sockets without awaiting the full stall timeout.

These are application response budgets, not global socket/request admission or
OS memory quotas. File and SSE limits are independent. No new general JSON
request/body-queue, network perimeter or native-platform claim is implied.

## Verification requirements

Use synthetic local fixtures with actual HTTP/raw sockets: full/range reads,
HEAD/416/empty files, before/after-header errors, same-descriptor replacement,
truncation, late-open cancellation, stalled consumers, active admission and
server survival on a new connection. Cover maximum escaped valid Agent
snapshots, terminal socket accounting, response errors, cursor reattachment,
duplicate send and simultaneous SSE/media shutdown for both protocol settings.
Disconnect must preserve durable identity and never create inference or writes.

Ordinary sandboxed Linux Electron QA must use freshly built bundles and show
working native media playback after a missing synthetic asset request. Screenshots
show visible behavior; raw HTTP and database evidence establish failure/replay
claims. No native macOS/Windows certification or external provider call follows.
Evidence directory: `evidence/q4-http-streams/`; native fixture:
`tests/http-streams-qa-native.mjs`.

### Recorded local acceptance, 2026-10-10

- Final combined suite: 166 passed, zero failures/skips, 122.6 seconds,
  `node --test --test-concurrency=1` over the two new transport test files and
  existing Agent HTTP/runtime/journal/crash/edit-wire, mutation-wire,
  server lifecycle/shutdown, integration and timeline-media suites. This is
  affected coverage, not a replacement claim for the parent's full suite.
- New coverage includes 17 file/combined-server cases and 18 SSE cases. Both
  protocol settings retain one run through detach and exact request replay;
  simultaneous media/SSE shutdown and backend restart rediscover the same
  interrupted run without another gateway invocation. Existing actual CLI and
  official MCP mutation replay, lost-response, crash and real-export tests pass.
- Real loopback HTTP/raw sockets exercise read failures before/after headers,
  truncation, descriptor replacement, HEAD/416, late open, stalled consumers,
  caps, cursor reconnect, maximum escaped replay and new-connection health.
  Deterministic timers/callback fixtures cover the full 30-second deadline and
  stale callback fences. No actual provider or credential is used.
  Delayed-open tests release the injected promise and verify late-descriptor
  cleanup; they are not proof that an operating-system syscall which never
  returns can be reclaimed.
- Fresh Vite and desktop builds passed serially using installed entrypoints;
  all 49 output files are hash-recorded. Native launch used main SHA-256
  `01034118c3580ab55ca43e7fa47dc26ae91ae7ff6cfeee7cee9a23b1e1d497e0`
  and backend SHA-256
  `881ceecc186c344a642543135524579229deb4ee06b85f4a1f4f21dd7520bec8`.
- Ordinary sandboxed Electron 44.7.0 development-channel QA requested a missing
  synthetic image, then successfully played a healthy four-second 320×180
  local video and sought back to timeline frame 60. Right-dock navigation stayed
  responsive; ordinary titlebar close exited with code 0. Five screenshots
  establish visible behavior. The missing-image UI is the existing broken-image
  presentation; no new renderer recovery/error surface is claimed.
- After quit, the healthy file remained 165,037 bytes with SHA-256
  `c9fbd6fead11f7712106740496499a0be7c3cca135357082a8e8d6e2a31d74a2`,
  matching its publication. The private fixture retained two asset records and
  zero generation jobs, exports or Agent runs. Native screenshots do not prove
  every transport branch; the HTTP/socket and durable database assertions do.

- After the parent's main suite, two extra focused tests passed (14.0 seconds)
  without production changes. Isolated actual servers hold all 32 synthetic
  open/stat operations unresolved across disconnect and the five-second close
  deadline: admission stays occupied and close rejects `SERVER_STOP_TIMEOUT`,
  with zero claimed descriptor closes. Releasing the injected promise afterward
  closes every late descriptor without starting a stream. Actual HEAD/empty
  responses whose end flush is suppressed close their descriptors immediately;
  server shutdown finishes through the ordinary three-second socket force-drain.
  These two cases were not part of the 1,509-test main run and are reported
  separately, not as a rerun of the expanded full suite.

Read-only final review found no remaining concrete source blocker. All eight
original non-documentation build inputs and all 49 artifacts remain unchanged;
only two unbundled test files and acceptance documentation were added/updated
after the parent main suite. Native testing used no renderer hooks, debugging
ports or security-setting changes. No packet
capture, live provider certification, platform release or global denial-of-
service guarantee is implied.

## Official API references

Reviewed 2026-10-10: [Node FileHandle streams](https://nodejs.org/api/fs.html#filehandlecreatereadstreamoptions),
[Node pipeline](https://nodejs.org/api/stream.html#streampipelinesource-transforms-destination-callback)
and [HTTP response lifecycle](https://nodejs.org/api/http.html#class-httpserverresponse).
These are current documentation; execution is verified on the installed Node 24
and Electron runtimes, not inferred from another version's documentation.
