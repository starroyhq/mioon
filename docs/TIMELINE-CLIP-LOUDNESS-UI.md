# Selected saved-clip loudness UI

The clip inspector now has a separate, collapsed, read-only loudness panel beside
its gain/fade controls. Only an explicit Analyze action starts observation.
Selecting a clip, opening the panel, reconnecting, restoring visibility or
returning to a prior selection never starts a measurement.

The initial increment measures the entire saved clip, up to the shared contract's
60-second / 1800-frame limit. Longer clips are explicitly unavailable, never
trimmed or replaced with a selected subrange. The saved source and timeline can
be longer. This is not a performance guarantee: the backend processing budget
remains 120 seconds, with the existing 125-second client observation deadline.
Full decoding can take time, and Cancel stops this observation only.

The panel shows the existing measurement profile's integrated LUFS, sample peak
in dBFS and estimated true peak in dBTP, including separate silence, too-short
and below-gate states. It identifies exact saved timeline and source frame
ranges, the local measurement range, saved gain/fades, revision and source hash.
The stage is isolated clip post-gain/fades and pre-mix. It is not the existing
full-timeline mix/candidate workflow or an exported-file measurement. There is
no target, gain suggestion, apply action, normalization, batch analysis, media
output or persisted report. Independent clip peaks cannot guarantee mix or
AAC-encoded peaks.

Admission requires an audio/video asset, an unmuted track,
positive saved gain, a connected verified workspace and a visible inspector.
Cached hasAudio false/unknown does not establish no-audio in the UI; the backend
verifies source metadata and the actual stream. Images remain unavailable.
Unsaved/conflicted/recovered/loading/uncertain drafts and pending mutations block
analysis. The renderer captures selection generation, draft serial/generation,
project/workspace, revision, full public saved audio graph, selected source and
saved signal fields. A→B→A cannot restore a previous result. Changes, hide,
comparison/source overlays, page visibility, pagehide and unmount revoke active
observation and clear results; retained callbacks cannot act in a newer context.

The web RPC branch reuses the shared client 8 KiB stream envelope reader with one
bounded deadline covering headers and body. It does not use response.json() for
this operation, add a native permission or create another native resource owner.
The existing server audio resource slot and owner admission remain authoritative.

Verification includes state/controller, actual hook and component callbacks,
static React rendering, actual App-context bindings, bounded RPC cancellation,
four-locale catalog integrity, strict TypeScript consumers and web production
build. GUI interaction was not run because of the existing accessibility tooling
blocker. This document does not claim GUI acceptance or a longer-duration
performance qualification. The separate backend 60-second boundary evidence is
not repeated by the frontend tests.
