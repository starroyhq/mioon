# Selected saved-clip loudness UI

The clip inspector has a loudness card beside its gain/fade controls. Technical
details are collapsed; the current Inspector enables explicit target matching. Only an explicit Analyze action starts observation.
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
an optional LUFS/dBTP target with a real second measurement of the scaled float
signal. The Inspector starts with editable -14 LUFS / -1 dBTP values; these are
not sent until Analyze. Match stages only a validated supported gain in the
existing clip draft; Save clip uses the existing mutation and undo/redo. The
read operation grants no mutation authority, and there is no limiter, batch
normalization, media output or persisted report. The delivery panel's dialogue
loudness match reuses this operation for every clip marked human voice, one at a
time, and applies the gains the user keeps in one edit through
`timeline.clip.setGains` ([API](API.md#clip-gains-2026-10-29)); it adds no limiter
or normalization either. LRA uses complete three-second windows at 100ms hops, with no synthetic
padding; shorter clips show an unavailable range, not a fabricated zero.
Independent clip peaks cannot guarantee mix or
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
observation and clear results; target edits and composition also retire old
candidates. Retained callbacks cannot act in a newer context, and matching cannot
bypass dirty, recovered, pending, restored or composition fences.

The web RPC branch reuses the shared client 8 KiB stream envelope reader with one
bounded deadline covering headers and body. It does not use response.json() for
this operation, add a native permission or create another native resource owner.
The existing server audio resource slot and owner admission remain authoritative.

Current implementation and actual validation are recorded in
[the third-round matching report](verification/project-open-design-fixes/round3/clip-match/README.md).
Historical qualification evidence remains separate; the new UI does not claim
mix/AAC peak safety or a new 60-second performance qualification.
