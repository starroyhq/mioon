# Timeline MP4/H.264 export settings

## 改版：导出记录文件恢复

普通工作区的导出记录通过受认证的 `GET /api/export-files?projectId=…&exportId=…` 检查托管文件是否存在。文件丢失时，用户可显式选择原文件，以同一身份 `POST` 原始字节。后端核对已保存导出、素材及回执的归属，流式校验原大小与 SHA-256，只用不覆盖链接恢复原托管路径，不修改导出/素材记录或历史快照。错误文件、符号链接、共享路径与其他项目身份均拒绝。已有文件不覆盖；关闭界面或丢失回复后再次检查即可确认状态。恢复与 opacity 候选工作区保留既有下载边界，不开放文件写回。

失败或取消后的“重新导出”回到当前导出配置与重新预检，使用新的业务请求；它不重新发送历史 requestId。导出弹窗关闭不会取消正在运行的导出，任务入口仍可查询进度。

Baseline: `733ed9306de9d5ac813afffc01fd55f947241b32` (2026-10-11).
Implemented and focused-tested; fresh production Web/desktop/package and Linux
packaged native acceptance passed. The independent parent full gate passed
3,852 total / 3,850 passed / 0 failed / 2 skipped.
No macOS/Windows or live-provider evidence is implied.

## Bounded user workflow

The right Delivery workspace offers settings for one timeline export. Opening
it or choosing a setting performs no probe or export. An explicit check runs a
bounded local encoder proof and then the saved-source preflight. The user can
review the effective dimensions and rate control before confirming export.
Settings are session-local; the accepted render freezes them in its snapshot.
Existing clips, timeline geometry, source bytes, selected generated versions,
subtitles, undo/redo and past exports are unchanged. New storyboard exports
freeze the project output size (1080×1920 if absent); historical queued records
without geometry retain their old size. Editing preview uses project geometry;
playing an actual delivered artifact uses that artifact's frozen dimensions.

The closed `mp4_h264_v1` profile accepts:

- Resolution: `native`, `short_720`, `short_360`, or legacy-compatible `short_1080`.
- CRF quality: `compact` = 28, `standard` = 23, `high` = 18; or
- Single-pass average target video bitrate: 2000, 4000 or 8000 kb/s.

New portrait outputs are natively 1080×1920, with 720×1280 and 360×640 downscales.
Landscape outputs are natively 1920×1080, with 1280×720 and 640×360 downscales.
Square outputs are natively 1080², with 720² and 360² downscales.
The UI offers native/720/360 for 1080 projects. Old 720 projects keep
native/360/1080; their 1080 option is an explicit 1.5× upscale and cannot restore
additional source detail. Both v1 and float-v2 resolve from the saved native
short edge, never a fixed 720 intermediate. Scaling occurs after video
composition and subtitle burn-in, with Lanczos sampling. Text is not reflowed.

Container MP4, software libx264, yuv420p, veryfast, 30fps, GOP 60/no B frames,
AAC 128 kb/s, 48kHz stereo and faststart remain fixed. CRF output sizes depend
on content. A target bitrate is neither an exact file size nor a strict bandwidth
ceiling. No arbitrary dimensions, fps, codecs, container, hardware encoder,
FFmpeg arguments, command, path, URL or font parameters are accepted.

## Shared public contract

`timeline.render` optionally accepts `exportSettings`, only with
`purpose:'export'`. `timeline.export.preflight` optionally accepts the same
settings to bind its digest to the exact delivery snapshot. Every nested field
is required when settings are present; parsing adds no defaults.

```json
{"profileId":"mp4_h264_v1","resolution":"short_360","rateControl":{"mode":"crf","quality":"high"}}
```

The alternative rate control is `{"mode":"bitrate","targetKbps":4000}`.

`timeline.export.capabilities` takes exactly
`{projectId,expectedRevision,exportSettings}`. It does not initialize a missing
timeline. Its strict report contains the requested project/revision/settings,
saved timeline ID/revision (or null), deterministic `delivery` (or null),
`checkedAt`, `status` and at most one bounded safe issue. Status is `available`,
`unavailable`, `incomplete`, `stale` or `blocked`. No raw subprocess output,
local path, executable, secret or user-media bytes are returned.

HTTP RPC, CLI `timeline export capabilities` and MCP
`timeline_export_capabilities` use this same service. Discover the exact schema
first. The shared effect descriptor is business-read-only with `localProcess:true`
and `fileWrite:true`: v1's proof has no file writes, while float-v2 creates and
cleans bounded private synthetic files. Neither path writes the project,
database or cache, decodes user media, or performs external I/O.
It is distinct from source preflight and does not grant export authority.
Built-in Agent tools and automatic model context are unchanged.

## Capability and cancellation boundaries

The capability helper uses the existing owned-child media runner. There is one
active proof per Node process, no queue and no persistent capability cache.
A recognizable, bounded FFmpeg encoder listing must advertise libx264 and AAC;
the selected dimensions and rate-control arguments then encode three synthetic
frames plus stereo silence to a bounded fragmented MP4 pipe. Only fixed argv
is constructed. The proof checks the expected H.264/AAC sample entries and
geometry. It does not decode user media or fully certify a later exported file.

Caps: 12-second compute budget plus the runner's existing 3-second termination
budget; 128KiB encoder listing; 1MiB binary proof output; 64KiB stderr per child.
Timers are best-effort scheduling bounds, not hard real-time guarantees.
An unconfirmed child exit remains tracked and prevents replacement media work.
Fragmented pipe output tests encode/mux capability; it does not prove seekable
faststart placement. Actual completed exports are separately probed/decoded in
acceptance. No silent fallback substitutes another encoder or rate mode.

Unavailable means verified absence of a required tool/encoder. Failed,
unrecognized, timed-out, cancelled or over-budget proofs cannot be labeled
available. A report can become stale immediately after it is returned. Fresh
custom render admission rechecks capability and the worker rechecks before
encoding. UI media-preflight incompleteness can offer an explicit unchecked
source export only after capability is available; known blockers cannot be
bypassed through that action.

HTTP disconnection cancels only the explicitly classified advisory capability
or preflight observation. It never cancels/retries a submitted render. A local
client timeout or lost acknowledgement can leave a render outcome unknown.
The generic client keeps its existing 30-second default; source preflight keeps
35 seconds. Explicit caller deadlines win. No automatic retries are introduced.

## Snapshot, replay and recovery

A custom render freezes `delivery.exportSettings` and exact deterministic
`delivery.effective` values in its existing export snapshot. No DB migration or
new request namespace is introduced. Omitting settings retains the legacy
input, snapshot and receipt shape, without inserting a delivery object or
changing the old encoder argument path.

The existing exact receipt is checked before fresh timeline CAS, capability
work or new snapshot checks. Fresh async capability work runs outside SQLite;
the accepting transaction repeats replay, ownership, revision and snapshot
checks before recording the export. Pending inputs/keys cannot be silently
replaced when a control changes. Recovery uses the original input and key, not
a fresh render or a status-changing probe. Historical exports retain their own
profile after edits, undo/redo, restart or future default changes.

Custom workers recheck bounded source ownership/retained lineage and hash/MIME/path
identity after capability work and before publication, including the commit
transaction. This does not rehash bytes or eliminate filesystem pathname races.
A rejected publication cleans only a confirmed unpublished output inode created
by that attempt. Changed identity, uncertain database reads or a durably accepted
result preserve the file; cleanup uncertainty is not proof that nothing remains.

`timeline.render` remains outside the 20 durable edit-task operations. Its
first-party session receipt is not a new cross-restart intent journal. Successful
exports and timeline receipts persist; callers must retain unresolved exact
render inputs. Malformed success and unproven errors retain ambiguity. Only a
valid operation/project/key-bound not-applied proof establishes rejection.

## Acceptance (2026-10-11)

Verified: strict contract/effect parity, real HTTP/CLI/official MCP calls,
lost-acknowledgement/restart/CAS replay, stale settings and late response UI
fences, capability busy/abort/timeout/overflow/owned-child cleanup, all three
aspect ratios/resolutions, actual CRF/bitrate argv and output probes, subtitle
post-scaling/frame boundaries, sound preservation, legacy omitted-settings
compatibility, fresh web/desktop/package and Linux native export/reopen.

Final domain 28/28, custom worker/publication races 18/18, real client/transport
8/8; prior new media/capability 21/21, legacy media 33/33, UI 177/177 and shared
compatibility 427/427 passed. These overlapping groups are not a full-suite total.
The formal Linux package produced 360×640 at 4 Mb/s target and 1080×1920 at
CRF18; both were 60-frame, 30fps, 2-second H.264/AAC files with full decode exit0
and identical decoded PCM. Native Save As matched the larger output hash.
Normal exit/recreation preserved 12 table hashes and every media hash, with
exactly two exports and no automatic new render. Both processes exited0.
The first parent aggregate had 3,852 tests: 3,849 passed, 1 failed and 2 skipped.
Its only failure was an obsolete replacement UI test extractor that included
the newly inserted export-settings hook. The test boundary was corrected, with
all original guard assertions retained; the four affected UI suites then passed
140/140. Production/build/native hashes are unchanged. The final parent aggregate passed
3,852 total / 3,850 passed / 0 failed / 2 skipped, 898,271.860107ms, actual exit0
(parent session23068, 2026-10-11). Both aggregate logs and the focused red/green
correction remain in the synthetic acceptance archive.


## Later opt-in backend float profile

The original profile, default UI controls and acceptance above remain v1. The
additive backend-only `mp4_h264_float_checked_v2` profile is documented in
[FLOAT-CHECKED-EXPORT.md](FLOAT-CHECKED-EXPORT.md), with its own current gate
status. It creates bounded private capability-proof files, unlike v1's in-memory
proof. The shared capability effect therefore advertises possible temporary file
writes. No new UI selector is included in that increment. Legacy/omitted exports
keep their original signed-16-bit behavior; no automatic conversion is made.
