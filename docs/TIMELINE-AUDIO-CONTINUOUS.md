# Continuous saved-timeline audio preview — V2

Implementation baseline: `e87fa309ed0a604657dcdf6bddc768c1c10eb2a1`.
Work lives in the independent `codex/continuous-audio-preview` checkout. The
source checkout and its worktree were only read to import the verified bundle.
No commit, push, deployment, schema migration, or production dependency was
authorized by the user's direct request; the implementation is an uncommitted
reviewable diff.

## Playback and saved-state policy

The editor's Play action prepares one complete two-second mixed block and then
plays continuously from the selected frame to the saved timeline end. It does
not render an MP4 or decode the entire timeline into memory. One 48 kHz stereo
AudioContext schedules adjacent blocks on the same absolute sample clock.
The next block is scheduled before its predecessor ends; a block callback
retires consumed data and requests another block. RAF only displays position.

Pause synchronously stops all scheduled sources and cancels the outstanding
prefetch. Current and already completed next PCM can be retained. No new pull
is made while paused. Resume preserves the exact sample cursor. Buffered seeks
reuse retained blocks; other seeks revoke old nodes and wait for the previous
request to settle before resetting the source cursor. Only the newest seek
intent can publish or schedule audio. Seeking while the first preparation is
pending also replaces that preparation after its resources settle.

If the next complete mix is late, playback stops at the exact consumed block
boundary and visibly enters buffering. It resumes from that boundary with a
new clock origin. It never omits a track, jumps samples, or treats an exhausted
buffer as the timeline end. Decode/output failures stop the whole owner.

Only saved data participates. Clip, subtitle, and format drafts remain owned
by their existing editors and stay visibly excluded. Saved revision, source
identity, workspace/project epoch, actual panel visibility, restore state, and
connection status bind the session. Changing them first stops old output and
requires a new explicit Play. Locale and draft presentation changes do not
recreate audio or replay a request. Audio ticks never persist a playhead;
explicit seek/stop use the existing saved-view callback once. Split samples the
ephemeral audio position and revokes sound before editing.

Source and rendered video players remain separately labelled and mutually
exclusive with sound preview. No claim of synchronized composed video is made.
Native focus loss, occlusion, and minimization do not transfer sound ownership.
Restored workspaces reject this lane before accessing media or starting work.
Restart does not restore live audio handles or autoplay.

## Protocol and integrity

V1 `timeline.audioPreview.plan`, its schema/profile, and `/pcm` retain their
twenty-second semantics. V2 adds the metadata-only shared JSON operation
`timeline.audioPreview.continuousPlan`, registered through contracts, business,
client, HTTP RPC, CLI and MCP discovery. It is not a built-in Agent tool and
grants no editing, model, provider, or automatic playback authority.

The strict V2 manifest binds the project, timeline, revision, start and saved
end, complete snapshot hash, fixed PCM profile, 60-frame block size, and one
96 MiB reservation. A canonical SHA-256 binds the manifest itself.

`GET /api/timeline-audio-preview/continuous` accepts only the canonical identity
query: plan input, planHash, sessionId, generation, sequence, and blockStartFrame.
It returns exactly one complete raw interleaved float32 stereo mix with exact
sample and identity headers. No caller can supply a path, URL, source substitute,
decoder/filter argument, output format, or destination. DELETE with the same
session identity joins resource retirement. Authentication and Host/Origin
checks remain in the existing server path. New clients reject malformed,
misbound, compressed, extra, truncated or non-finite PCM before publication.

Request sequence numbers strictly increase within a session; gaps are allowed
because a local cancellation may happen before the request reaches the host or
server. Generation only increases, and resets source cursors after a seek or
cancelled pull. A discarded response may already have advanced the server, so
the client never guesses whether it can retry in the old generation. Both are
bounded and signed by the native host; neither can revive an old renderer.

Every audible source uses the original global composition segments, including
edges introduced by muted clips, images, and gaps. Each source cursor starts at
the original segment offset with the existing one-frame lookahead, fixed
resampling/channel conversion, silence-first padding, and exact output trims.
Pull boundaries do not restart FFmpeg/resampling. Gain and fades use the shared
original clip-local sample envelope. Hidden video remains audible; track mute
silences it. Float summation is additive, with no normalization or limiter.

The integrity cache is memory-only, per session, and bound to asset/hash plus
path, device, inode, size, mtime and ctime. Before the first source contribution
is published, one complete hash precedes decode and a second complete hash
follows its first decoded portion. Further contributions reuse that proof only
while every effect boundary confirms the exact file identity. Replacement or
saved graph changes revoke publication. This is an explicit V2 integrity
policy; V1 retains its two full hashes per window. No persistent PCM/source
cache, copied media, database record, receipt, or job is created.

## Ownership, backpressure, and limits

The backend admits one continuous session per database. It holds at most one
active block and one replaceable pending intent, never an unbounded queue.
There is at most one original-segment cursor per track, at most twelve FFmpeg
children. Each pipe pauses while the consumer has no demand. A callback and its
backing allocation are each capped at 1 MiB. The legacy synchronous streaming
runner is unchanged; the new awaited runner is checked in
`media-streaming-runtime.ts` and is only used by continuous audio. The legacy
runtime module supplies its narrow process dependencies and compatibility export.
The checked `timeline-audio-preview-coordinator.ts` owns V1/V2 admission and
their shared saved-snapshot reader. Native resource/transport/invocation proof
settlement uses one private helper for V1 GET and V2 GET/DELETE.

The renderer retains at most two mixed blocks, each at most 768,000 bytes. It
does not keep a fulfilled client promise pointing at consumed PCM. The backend
uses one mixed output and bounded source reads; source pipes, staging copies,
transport, AudioBuffer acquisition copies, and unfinished retirement are covered
by the same application reservation. The conservative bound is:

`12 × (768,000 + 3 × 1 MiB) + 6 × 768,000 + 2 MiB = 53,669,888 bytes`

The native lease reserves the full **100,663,296 bytes (96 MiB)** for the complete
session, including handoff and retirement. This is application-owned PCM
accounting, not total Electron/FFmpeg/native/OS RSS. The six mixed copies cover
current + next retained buffers/acquisition, one server output and transfer
staging. Each cursor's three MiB covers one callback backing allocation and two
MiB of paused readable-pipe allowance. Instrumented allocation observations and this conservative bound are
reported separately from RSS or device latency.

Preserved or redefined limits:

| Limit | V2 scope |
| --- | --- |
| 30 fps, 48 kHz, 1,600 samples/frame | Unchanged; half-open intervals |
| 18,000 frames / 12 tracks / 100 clips | Unchanged saved timeline limits |
| 512 MiB / 600 s per source | Unchanged source admission |
| 1 GiB hash reads | Cumulative per session; distinct assets share verified identity; cancelled/partial work remains charged |
| Original decode work | Full graph admission at most 218,400 source frames, including segment lookahead; cumulative conservative execution charge at most 873,600 per session |
| Original segments | At most 2,400 runs in one complete graph; restarts also consume work |
| Preparation deadline | 120 s per active block; whole first client preparation also has a 120 s deadline |
| Idle/backpressure | Does not spend decoder's active-output timeout; session still has an absolute 30 min lifetime |
| Request/seek identities | At most 10,000 requests and generation 256 per session |

Each opened cursor charges its actual original-segment seek/trim prefix, the
one-frame lookahead and a fixed three-MiB read-ahead allowance before starting.
Produced stdout then increases that charge, capped at the original unit's full
work. Cancelled and partial work is never refunded. This is a conservative
source-frame execution bound, not a measurement of codec-internal preroll or
CPU instructions. It avoids repeatedly charging an unread ten-minute suffix
when a user pauses an early prefetch. Repeated long-prefix seeks can still
exhaust the explicit cumulative work budget and fail visibly.

Cancellation aborts the exact worker and joins confirmed process close. A
native lease also waits for renderer/context closure, backend resources, HTTP
finish/close, and invocation completion. Sending kill or destroy, or reaching
a timeout, is not a release acknowledgment. Cleanup doubt stays visibly blocked.
One native lease covers all pulls and seeks; every proof signs the method and
complete block identity. Cross-window handoff waits for the preceding owner.
The legacy and V2 backend I/O lanes exclude each other. Ordinary legacy Web
clients still lack the native application-wide cross-tab renderer lease; that
existing V1 boundary is not expanded into a new cross-browser coordination service.

## Compatibility and verification

The old export filters, segment helper, s16/default/v1/v2 profiles, history,
receipts, source files, and restored-workspace policy remain unchanged. V2
floating-point preview does not promise parity with legacy s16 clipping or final
AAC encoding. The existing frozen compatibility tests remain the regression gate.

New deterministic tests cover 25 s, 2 min and 10 min blocks, original fade
positions, rapid seeks, fifty pause/resume rounds, late resume/PCM/plan replies,
sequence gaps, exact resource barriers, memory collection, hostile PCM, and
native single-owner handoff. Fake-clock tests are labelled as such and are not
real-time or subjective listening evidence.

On macOS, use a canonical temporary root (for example `TMPDIR=/private/tmp`)
for tests creating protected workspaces. The default `/var/folders/...` ancestor
is a symlink and correctly fails the storage policy. This is an environment
selection, not a relaxed storage check.

Actual numeric/native evidence and final command results are recorded in
[the qualification record](TIMELINE-AUDIO-CONTINUOUS-ACCEPTANCE.md). Until that
record explicitly marks a check passed, it remains unverified.
