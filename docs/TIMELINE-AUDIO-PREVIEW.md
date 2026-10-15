# Saved-timeline sound audition

## Continuous preview checkpoint (15 October 2026)

The record below describes the original V1 twenty-second audition and remains
historical evidence. The editor now uses a separate V2 continuous pull session;
V1's public plan/resource and the frozen export behavior remain supported.
See [continuous design and verification](TIMELINE-AUDIO-CONTINUOUS.md) for the
new protocol, resource accounting, integrity policy, and qualification limits.

Implementation and qualification record for the first sound-audition slice, based on commit `1398eaa7e99b751357bf2888c9c213db2efdccbb`. Focused checks, actual browser PCM comparisons, a fresh production Linux package, and native controls/export/restart have completed as described below. Independent full-suite qualification completed successfully on 14 October 2026. No physical-device or subjective listening certification is claimed.

## What the controls audition

The user explicitly prepares the current saved timeline interval:

`[startFrame, min(startFrame + 600, timeline.durationFrames))`

The editing clock remains 30 fps, so one preparation covers at most 20 seconds. The start is included and the end is excluded. The controls show both endpoints, the saved revision, and that playback is sound only. Finishing this interval does not mean the whole timeline has been checked or played.

Preparation and playback are separate explicit actions. Opening a project, mounting a panel, refreshing metadata, reconnecting, or returning to a previously hidden panel does not prepare or play sound automatically. Pause, resume, and seeking inside the admitted interval use the retained preparation. Seeking outside it releases the audition and requires a new explicit preparation; it never silently extends or shortens the interval.

Unsaved clip, subtitle, and format drafts remain owned by their existing editors. A warning explains that audition uses the saved timeline. Audition neither applies those drafts nor treats a proposed Agent edit or pending recovery candidate as saved content.

Existing rendered video and source-media playback remain separate players. The UI labels rendered video as independently played and unsynchronized with sound audition. Starting audition pauses the native media player; starting the native player revokes audition. There is no real-time video composition, loop mode, playback-speed control, output-device selector, loudness normalization, or limiter in this slice.

## Public metadata operation

`timeline.audioPreview.plan` is the only new shared JSON operation. Its strict input contains exactly:

- `projectId`: UUID of the owned project
- `timelineId`: UUID of its existing saved timeline
- `expectedRevision`: positive safe integer revision
- `startFrame`: integer editing frame within the supported timeline bounds

HTTP RPC, CLI, MCP, and the renderer use the same schema and business service. The CLI command is `timeline audioPreview plan`; the public MCP tool is `timeline_audioPreview_plan`.

The operation validates a bounded saved timeline and its owned source graph. It returns a typed, bounded plan with the exact revision, half-open interval, plan digest, source identities, voice timing/gain/fade metadata, and resource accounting. It does not initialize a missing timeline, read source media bytes, start a decoder, write the database or files, create a job or receipt, call a model or provider, or grant mutation authority. A successful plan means the interval has been planned, not that it has been decoded or is playable.

The shared client rejects malformed response structure, wrong requested identity, and inconsistent sample/resource accounting. The renderer additionally verifies the canonical plan SHA-256 before preparing sources.

This public operation is not a built-in Agent tool. The existing explicitly scoped Agent catalogs and their consent boundaries are unchanged.

## Fixed authenticated PCM resource

The renderer explicitly obtains each admitted source through:

`GET /api/timeline-audio-preview/pcm`

The query contains the four plan-input fields plus `clipId`, `sourceHash`, and `planHash`. Every key is required exactly once. Extra keys, repeated keys, noncanonical numeric strings, request bodies, other methods, and path-selected resource variants are rejected. Callers cannot select a file path, URL, asset substitute, source offset, stream, codec, filter, timeout, or output format.

This is a same-origin resource behind the server's existing Host/Origin checks and session-cookie or bearer authentication. It creates no new credential or durable source handle. Unlike metadata planning, an admitted resource request performs bounded local media reads and decoding. It still creates no database record, durable job, receipt, cache file, or export artifact.

The server rederives the plan from current saved data and selects the saved clip's intersection with the requested interval. It checks owned source metadata, source SHA-256, managed-file identity, and saved graph/revision before and after decoding and immediately before response publication. Stale bindings or replacement bytes revoke publication.

Successful output is raw, interleaved, little-endian float32 PCM with the fixed profile `saved-timeline-audio-f32le-48k-stereo-v1`: 48,000 sample frames per second, two channels, and 1,600 sample frames per editing frame. One stereo sample frame occupies eight bytes. The resource supplies:

- `Content-Type: application/octet-stream`
- Exact `Content-Length` and `Cache-Control: no-store`
- `X-Mioon-Audio-Profile`
- `X-Mioon-Audio-Plan-Hash`
- `X-Mioon-Audio-Source-Hash`
- `X-Mioon-Audio-Clip-Id`
- `X-Mioon-Audio-Sample-Frames`

The decoder chooses the first identified audio stream using the existing probe-selection convention. It preserves the exporter’s original global composition segments, including boundaries contributed by muted clips, images, and gaps. Each selected source is decoded from those original segment starts, then trimmed to the admitted interval. This includes any original prefix before the selected start. Fixed 48 kHz resampling, mono/stereo conversion, silence-first padding, and exact sample trims preserve the exporter’s seek/resampling semantics. A short identified audio stream may end in silence; a missing, unidentified, or corrupt stream is still rejected. Admission is deliberately limited to supported local containers and mono/stereo layouts; unknown or unsupported audio fails closed. Source PCM is returned before the saved clip's gain and fades.

The renderer consumes sources serially and streams PCM into the exact stereo AudioBuffer. Fetch byte streams use one reusable BYOB view of at most 1 MiB; each read consumes the returned view and reuses its returned backing memory, since the submitted view is detached. Non-byte-stream compatibility falls back only to the original reader with the same visible and backing-allocation cap. Unsupported large fallback chunks fail closed rather than increasing the memory budget. It checks all identity headers, exact byte/sample counts, and finite values. It does not use full-body base64, concatenate an entire response, or invoke a browser media decoder. A truncated, extra, corrupt, cancelled, or partially received body never becomes a playable prepared interval. Failure on any source rejects the complete interval.

## Resource and lifetime limits

All sources are admitted before any source decode. Limits include:

- At most 600 editing frames per prepared interval and per source request
- Existing limits of 12 tracks and 100 clips
- At most 200 original source decode segments and 18,000 decoded source frames across all distinct prepared sources, counting prefixes, repeated decoding, and the existing one-frame input lookahead per segment, even when only a small selected suffix is retained
- At most 512 MiB and 600 seconds for each source file
- At most 1 GiB of planned double-hash reads across distinct prepared source requests
- A 120-second complete preparation deadline; individual decoding uses the remaining attempt budget
- One active backend PCM preparation/consumer per native database, with no queue

The decoded-frame counter bounds requested original source-time spans, including their explicit one-frame lookahead; it is not a measurement of codec-internal preroll or CPU instructions. Source-byte limits and the wall-clock deadline remain independent constraints.

The conservative application-owned PCM admission budget is 96 MiB per prepared audition. This release has at most one native editor; the separately planned multiple-editor design requires application-wide reservation before allowing another retained audition. Its calculation is:

`2 × retained AudioBuffer PCM bytes + 2 × largest in-flight source PCM bytes + 2 MiB transport/staging reserve`

This accounts for simultaneously retained application copies and one serially prepared source. It is not a bound on total Chromium, FFmpeg, operating-system, or hidden native-decoder memory. Actual intersected source sample counts determine the budget; track count alone is insufficient. Exact duplicate source identities may share one prepared source only when asset ID, source hash, source interval, profile, and original decode-segment plan all match. Different offsets into one asset remain distinct requests. An over-budget interval is rejected in full, with the existing rendered-preview path remaining available.

The backend permit spans hashing, decoding, confirmed exact child-process termination, and response consumption. Cancellation requests response destruction, but `destroy()` returning is not proof of consumer close. A pending consumer or unconfirmed child termination cannot release admission for another attempt. The service retains cleanup work after the public caller has already observed cancellation. A fresh explicit attempt is allowed only after the prior owned resources are confirmed released; unconfirmed cleanup remains a visible blocking failure.

On the renderer, project/workspace/source/revision changes, disconnection, loss of visibility, page hiding, unmounting, and native-player start revoke the current generation. Revocation aborts fetches, stops owned voices, and closes the owned AudioContext. Late acknowledgments cannot revive an old generation. Pending context retirement or preparation settlement blocks a new context, and failed retirement is surfaced rather than assumed complete.

## Sample clock, gain, and fades

One 48 kHz AudioContext schedules all voices against one context-time origin. The renderer verifies the context sample rate. Animation frames only paint an ephemeral playhead; automatic playback ticks never call the saved-view playhead setter. Only explicit seek or stop actions use the existing saved-view position callback; pause itself remains local to the sound clock. Splitting during audition samples the current audition position, revokes sound, then uses the existing durable split operation.

Clip intervals are half-open. Gain remains in the existing range 0 through 2. Fade evaluation uses the original clip-local sample position, including after an interval starts inside a clip or the user seeks. Track mute silences audio; hiding a video track does not silence its audio. Mixing is floating-point summation with no automatic normalization or limiting. Mono-to-stereo conversion follows the fixed FFmpeg conversion, rather than browser-default channel duplication.

The shared pure sample derivation also supplies the existing export fade helper. Its emitted legacy filter strings must remain byte-identical for every valid legacy input, including omitted or explicit-zero fades. The frozen compatibility fixture protects this boundary.

## Relationship to existing export profiles

Sound audition is not a bit-identical simulation of every existing export path. Its floating-point mix can retain values beyond full scale before the output device. The legacy 16-bit export path writes integer intermediate PCM, so its quantization and full-scale clipping at that conversion can differ from floating-point audition. FFmpeg’s mix filter itself uses floating-point samples. The existing float-v2 export path performs its own complete float-audio check and refuses an over-full-scale mix. Audition does not replace that export check or claim loudness, true-peak, or final encoded-file conformance.

The shared pure composition-segment helper preserves the existing exporter’s exact boundaries and filter/trim argument strings. Audition follows these original segments rather than continuously decoding through them. The initial continuous implementation produced a material 44.1 kHz AAC seam error (maximum left-channel absolute difference 0.380662292); that red evidence is retained. After the segmented correction, actual-renderer comparisons for AAC whole output, a selected window, a sample-precise seek suffix, and short embedded-audio boundaries are byte-identical in the tested synthetic fixtures. This is measured qualification for those cases, not a promise that floating-point audition equals final encoded AAC, legacy S16 clipping, or every possible device. Original media, old render snapshots, export settings/profiles, historical acknowledgments, and receipts remain unchanged.

## Restored workspaces and backup

This first slice is disabled in restored workspaces. Both the metadata service and fixed resource reject before source/payload access. Ordinary restored editing, historical reads, and existing export behavior retain their existing policy and pinned-origin rules.

Audition adds no SQL migration or durable state. Disposable PCM and AudioBuffers are memory-only and are not backup contents. Backup and restoration continue to preserve their existing raw database, source, receipt, and retained-unknown-work guarantees; audition must neither repair nor discard those records.

## Verification boundaries

The dedicated tests cover strict contracts, resource accounting, shared transport discovery, real local source decoding, exact PCM headers/counts/values, authorization and stale-input rejection, response cancellation, consumer-close admission, zero durable writes, and source preservation. Separate engine/UI suites cover clock ownership, complete preparation, lifecycle revocation, draft retention, and native-player exclusion.

Qualification distinguishes focused tests, numeric browser evidence, the actual packaged renderer, and the independent full regression suite. A passing synthetic or headless test is not a subjective listening result or physical output-device check. The independent parent run passed formal typecheck and the complete serial suite: 6,891 total tests, 6,889 passed, zero failed or cancelled, and two existing skips (1,166,781.793935 ms).

The initial packaged preparation exposed a transport assumption that small numeric fixtures had missed. A real Chrome HTTP diagnostic receiving a single 7,680,000-byte response delivered a 1,358,308-byte chunk; a second diagnostic using the actual packaged backend through a fixed synthetic-workspace proxy delivered a 1,226,923-byte chunk. Plan identity, digest, headers and AudioBuffer dimensions passed before the former 1 MiB default-reader chunk gate rejected both. These failed diagnostics and the original package are retained. The bounded BYOB correction does not increase the 96 MiB admission budget. The proxy is separate browser evidence. The freshly rebuilt final package was subsequently exercised directly through native controls as recorded below.

## Qualification completed on 14 October 2026

- The first 57-file affected run reported 689 tests / 688 passed / 1 failed. Its copied compiler fixture omitted the new shared segment source. The precise fixture repair and all actual App consumers subsequently passed 1,018 tests. No negative compiler or runtime assertion was removed. Separate final BYOB client tests passed 34/34, including real transfer/detachment, partial views, EOF, abort and cleanup acknowledgment; the preceding four-file client/UI/HTTP/App run passed 87/87. Formal typecheck passed.
- The final Chrome numeric harness passed all eight checks. Five actual-FFmpeg reference cases have maximum absolute error at most 6.56e-7 against a 2e-6 tolerance; fractional scheduling origin and real-time pre-destination pause/resume/seek are separately covered. Five serial real HTTP bodies retained 38,400,000 PCM bytes with a conservative application reservation of 94,257,152 bytes; the sixth source was refused before fetch/allocation. These are allocation counters and admission accounting, not a total-process RSS measurement.
- Fresh production `package:dir`, archive creation and the existing package inspector passed. Final ASAR SHA-256 is `1d341bc2ff1f47f59070c47074061f8308fcbab8e55019009d9b3cfaab36384e`. Build entrypoints, source staging, fonts/notices and archive contents were independently checked. No sandbox, GPU or system-security options changed.
- At the ordinary 1178 × 814 Linux editor size, the unmodified package completed explicit preparation/play/pause/seek, original interval retirement, a 23-frame tail ending at frame 750, and refusal to prepare at frame 787 beyond the saved end. Preparing and playing/pausing preserved all 47 database tables and managed media hashes exactly, including saved view preferences. Explicit seek/stop alone used the existing saved-position path.
- A native gain input changed from 0.50 to 0.55 using its ordinary increment control. The unsaved draft remained visibly excluded; saving advanced revision 4 to 5 and released the old preparation. Track mute/unmute advanced revisions 6/7 and released prepared audio. Returning from the board did not prepare or play automatically.
- Native UI created one real full-length timeline export at revision 7. It is 457,241 bytes, SHA-256 `335afd8c7e6cf3febdc7f72a84be46109bd55dc7a31b71fcf2fd4ea8b5c15ef4`; probe verified 750 H.264 frames, 720 × 1280, 30 fps, exactly 25 seconds, and stereo 48 kHz AAC. Full decode completed with exit 0. The original synthetic WAV hash stayed unchanged.
- Two normal final-package quits returned exit 0. Reopening the same package/workspace retained the saved revision and exported file; audition was idle until another explicit prepare/play. This is a normal-restart test, not a crash-recovery claim. Native preparation cancellation was not reliably captured before this short fixture became ready; deterministic HTTP/client cancellation tests cover that boundary. The attempted late cancel clicked the newly visible play action and is labeled as explicit playback evidence, not cancellation success.
- The cloud input provider could not paste into the native numeric field (AT-SPI provider unavailable), and one digit-key attempt left its value unchanged. Actual ruler/slider and increment controls provided the successful native seek/gain paths; no DOM injection or accessibility/security change substituted for native input.

The retained evidence separates the initial real HTTP/native preparation failure, the bounded BYOB red/green correction, numeric fixture results, final package hashes, and final native screenshots/audits. Independent source/artifact review found no production blocker. The source manifest is sealed only after these final checks; earlier candidate hashes remain historical evidence.

## Primary technical references

References consulted on 14 October 2026:

- [W3C Web Audio API 1.1, AudioParam computation of value](https://www.w3.org/TR/webaudio-1.1/#computation-of-value), Working Draft dated 22 September 2026. The parameter’s intrinsic value and automation events both participate in DSP value computation. Envelope qualification must include the first rendered sample and the initially assigned gain, not only the scheduled fade endpoint. This is a working draft, not a claim of final W3C Recommendation status or uniform browser behavior.
- [WHATWG Streams, ReadableStreamBYOBReader](https://streams.spec.whatwg.org/#byob-reader-class): successful reads transfer the supplied view and return a new view over its backing memory; cancellation and EOF have distinct results. Actual browser and packaged tests must verify the used implementation.
- [FFmpeg afade filter](https://ffmpeg.org/ffmpeg-filters.html#afade-1): sample-indexed start and length provide the reference for clip-relative fade boundaries and the preserved export filter strings.
- [FFmpeg amix filter](https://ffmpeg.org/ffmpeg-filters.html#amix): mixing uses float samples; normalization is configurable. The existing timeline graph explicitly disables normalization. The legacy S16 limitation above comes from the integer intermediate output conversion, not from a claim that amix performs integer arithmetic.

These references explain the comparison targets. They do not substitute for measured output from the installed FFmpeg build, the production Web Audio graph, or native runtime qualification.
