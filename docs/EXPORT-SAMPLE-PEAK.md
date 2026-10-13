# 已导出文件解码样本峰值

Implemented and validated on Linux, 2026-10-13. Baseline: `f83254321d2b28c60d818a8cbdda68301609dc27`. Focused checks, strict types, the final Linux production package/native gates and the independent final full suite below have passed. This result belongs to the exact 50-file source manifest; prior guide/topbar totals are not evidence for this increment.

## Scope

An explicit action in the right-side Delivery → Export history checks one existing, successfully delivered timeline MP4. The shared operation is `timeline.export.samplePeak({projectId, exportId})`. Named, unnamed and selected-range exports keep their own frozen identity. Preview and storyboard outputs are outside this first slice. Ordinary workspaces only: restored-v1 refuses this optional process operation before inspecting its payload or starting media work; supported export/download actions remain available.

The check reads the original succeeded export, its immutable queued receipt and owned published output. Current timeline revisions, renamed projects and removed editable source clips do not redefine an old artifact. It verifies actual managed bytes with a streaming SHA-256 pass before decoding and another pass afterward, with scope/file-identity checks across asynchronous boundaries. A report is bound to export ID, output asset ID, hash, original revision and optional frozen name/range. It is a time-bounded observation, not a promise that a future download cannot change.

No render, task transition, new output, schema, cache, sidefile or durable report is created. Opening history, completing a render, polling, reconnecting and restarting do not start the check. A new click is required. Report state is transient; closing/hiding history or changing project/artifact cancels and fences an outstanding observation. A late result cannot overwrite another row or reopen a tab. Existing downloads and render recovery keys are unchanged.

## What is measured

Only the delivered file's validated AAC, 48 kHz, stereo stream is supported. Decode to floating-point PCM without changing rate, mixing channels, applying gain/normalization, trimming or padding the audio. Natural end-of-stream is required. For each channel, take the largest absolute finite sample. The overall value is the larger channel peak. For amplitude P > 0, dBFS is `20 * log10(P)`; all-zero audio has `peakDbfs:null`, displayed as `−∞ dBFS（数字静音）`. Empty audio is not silence. Nonfinite samples, trailing partial PCM frames, unsupported format or incomplete decode produce no measurement. Values above 1 are retained and flagged, never clipped to 1.

This is **已导出文件解码样本峰值**. It is not loudness, LUFS, true peak, a clipping count, perceptual quality certification or a guarantee about players/DACs. The current render pipeline includes s16le intermediate segments before AAC encoding: a final decoded value below 0 dBFS cannot prove the original source or earlier mix avoided clipping. AAC decoding can itself yield samples above full scale. A warning never silently normalizes or rerenders the file.

## Fixed limits and lifecycle

- One active attempt per exclusive workspace owner/store; no queue and no automatic retry. Multiple wrappers share admission.
- Input at most 512 MiB. Two sequential full hash passes account for at most 1 GiB; that counter does not include FFmpeg's own compressed-input reads.
- Positive nominal delivered duration at most 600 seconds. At 48 kHz stereo, at most 28,800,000 decoded sample frames or 230,400,000 PCM bytes. These are cumulative stream limits, not resident buffers.
- Retained PCM is less than one 8-byte stereo sample frame plus scalar counters/peaks; no whole-PCM buffer or waveform array. Hashing uses the existing bounded 64 KiB buffer.
- Probe stdout is limited to 128 KiB and each media stderr stream to 64 KiB (the shared diagnostic tail remains at most 16 KiB and is not returned). Probe has a subdeadline of at most 10 seconds or the remaining attempt budget.
- One 120-second absolute attempt budget includes hashing, probe admission, probe, decode and final validation. Existing owned-child termination/reap rules still apply; filesystem/OS scheduling is not a hard real-time promise.
- Final probe/decoded duration must be consistent with the frozen delivered interval within 100 ms, allowing bounded AAC priming/padding/rounding. Business, shared result and UI guards compare the saved 30 fps interval in integer sample frames (1,600 samples per timeline frame; at most 4,800 samples discrepancy), including the exact 600-second boundary. Exact decoded sample count is reported. A tail beyond the absolute PCM limit is **incomplete**, even for a nominal 600-second export. No truncation is reported as success.
- Response at most 8 KiB with two channel entries. Strict shared validation checks identity, finite numeric relationships, silence/null consistency, overall maximum and full hash accounting.
- Only this shared client operation defaults to 125 seconds; an explicit caller deadline takes precedence. Existing operation defaults do not change.

Cancel, HTTP disconnect, CLI interruption or MCP cancellation stops only this advisory read/process work. It does not cancel, fail or retry the existing export. Unknown transport outcome is not a durable receipt; another explicit check can be requested. A pending file operation or unconfirmed child close keeps resource ownership/admission until actual settlement, and shutdown must not claim safe SQLite closure early. An unconfirmed media cleanup latches this service unavailable for the current backend lifetime even after a late close; restart is required after checking cleanup. No numeric-PID-only kill or replacement is used.

The existing private managed-storage boundary rejects unsafe paths, links and foreign ownership. Pre/post hashes are not a sandbox or a complete defense against a hostile same-UID/root process racing FFmpeg's pathname open. No stronger guarantee is claimed.

## Shared external use

Discover the exact schema first. CLI:

```sh
mioon schema timeline.export.samplePeak
mioon timeline export samplePeak --input '{"projectId":"11111111-1111-4111-8111-111111111111","exportId":"22222222-2222-4222-8222-222222222222"}'
```

MCP exposes `timeline_export_samplePeak`; its input is the same strict two IDs. Paths, URLs, caller hashes, request IDs, media bytes, arbitrary FFmpeg arguments, credentials and permission flags are rejected. Effects are read-only but resource-intensive/local-process; discovery does not itself start work. This is not a built-in Agent tool, and no result is automatically added to model context.

## Acceptance

The serial affected set passed **610/610**, no failures or skips, in 110.673 seconds. It covers this operation's contract/client/controller, real final-MP4 PCM and format changes, managed ownership/double-hash and lifecycle fences, actual HTTP/CLI/official MCP, existing named GET/HEAD/Range/downloads, restored refusals, old preflight/Inspector adapters and continuous UTF-8 catalogue transport. Strict typecheck passed; fresh Web, desktop production build and Linux x64 unpacked package completed. Package inspection verified ASAR/staging equality, existing hardened fuses, pinned subtitle resources and Electron/Chromium notices. No runtime-source edits followed these builds.

Actual Linux native acceptance used only a private synthetic workspace and the unmodified production package (ASAR SHA-256 `01d29f6cd6bac0205cd0adc4b757f66dd9f76b7cb97586461b463d1c8a66dd50`). Three real shared-worker outputs were checked by explicit UI actions: a two-second full export, first-second high-amplitude range and second-second low-amplitude range. The high/full checks showed **+6.2232 dBFS** and the advisory; the low range showed **−8.5772 dBFS** left/overall and **−14.6736 dBFS** right. These values match independent floating-PCM references, not a claimed live-provider or audible listening test.

A real native Save As retained the safe suggested name plus short export ID; an explicitly chosen synthetic destination received **70,191 bytes**, SHA-256 `b11d1748519909b3fbb7cd96da219136a83e137de9e39a52472247a835b29cd3`. Those downloaded bytes equal the managed low-range artifact and independently decode to 48,128 stereo sample frames with exact channel peaks `0.3725099563598633` / `0.1846369057893753`. This download check is separate from the real-service transport test, whose reference reads the managed disk file.

Per-check native audits kept all 47 database tables, SQLite `data_version`, and all five managed media byte hashes/modes unchanged. View-layout preferences can legitimately change when the user resizes or collapses panels; those actions were outside the per-check audit windows. Normal exit and same-package restart preserved all saved rows/media exactly. History reopened without a restored numeric report or automatic check; Tab then Return explicitly ran a new check. Both native lifetimes ended with observed exit 0. Default 310 px and minimum 240 px right-dock layouts, short-height scrolling, check/details/download reachability, keyboard activation and normal shutdown were inspected. This is normal restart evidence, not a crash or power-loss claim.

Earlier failures and limitations remain recorded: the first strict pass had two real `unknown`-narrowing errors, now corrected; independent review found and verified fixes for restored runtime construction, close-error masking, sparse-array serialization capacity and the inclusive floating-duration edge. The initial real-media format-change fixture did not actually preserve its intended change after remux; the corrected final fixture independently proves stereo→mono before requiring rejection. A direct shell launch had socket EPERM/SIGTRAP without the desktop display environment. Supported CUA desktop startup then succeeded with unchanged executable/arguments and no GPU/sandbox/security alteration. CUA Paste/AT-SPI capability failures and a global-key focus misrouting are preserved separately; subsequent window-bound keys succeeded. No claim of zero network attempts or OS-wide syscall tracing is made. Cloud audio-device warnings mean actual listening was not certified. Native Mac/Windows and real providers were not exercised.

The first independent parent aggregate ended with **5,951 total / 5,942 passed / 7 failed / 2 skipped** (1,065.907 seconds). Its original log is preserved. The seven failures were test integration boundaries: two historical gain-validator dependency pins, two range/history component loader cases and three strict compiler configuration/copied-consumer cases. Five existing test/fixture files were repaired without application-source changes. Historical c3a0a57 policy, effects and contracts-barrel bytes were preserved exactly; all prior fixture rows, receipts, catalogs and original dependency hashes remain unchanged. The range loader admits only the real new subpath. Compiler checks retain strict lists and genuine implementation mutation/recovery, plus a negative proof that the public sample-peak consumer resolves its isolated real-source copy. That new negative initially expected TS2459, while pinned TypeScript 6.0.3 correctly produced TS2724; this assertion mismatch and its log are retained.

The repaired serial groups passed **79/79** history/UI checks and **130/130** preservation/contracts/compiler/runtime/restore/UTF-8 checks, with no failures or skips. Production source and the previously exercised native artifacts remain byte-identical; their acceptance is reused, not described as a new native run. The first failed aggregate is not a final pass.

Independent final parent gate: **5,952 total / 5,950 passed / 0 failed / 2 skipped**, **1,063.568 seconds**, actual exit **0**; its preceding strict typecheck also exited **0**. The final source remains the repaired 50-file set; only this external acceptance document gained terminal-result facts afterward. The one added frozen-catalog isolation regression explains the increase from 5,951 to 5,952 tests. The earlier failed aggregate and first-red diagnostics remain preserved, and Linux package/native evidence is reused by exact unchanged production/artifact hashes. No native Mac/Windows or live-provider verification is implied.
