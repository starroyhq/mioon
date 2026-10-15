# Explicit clip audio roles: backend slice

Scope: user-authored editorial classification on timeline clips. This slice adds
no UI editor, DSP, audio probing, routing, ducking, automatic normalization or
built-in Agent capability. Human (`human`), music (`music`) and sound effects
(`sfx`) are stable wire values. A label does not establish that a source contains
audio: supported audio/video clips may be classified even when cached `hasAudio`
is false. Still-image clips cannot carry the field, including explicit null.

## Editing and identity

The role belongs to the clip, not its asset or track. Two uses of the same asset
may have different roles. `timeline.clip.add` and `timeline.clip.update` accept
optional nullable `audioRole` through the existing strict timeline contract.
Omitted input preserves the old shape/value; null explicitly clears and remains
stored as null. No defaults are added to old rows, history or acknowledgements.

Edits use existing timeline CAS, stable requestId, atomic history/cursor/receipt
transaction and exact original-response replay. No second revision or receipt
namespace is introduced. Undo/Redo restores the exact omitted/null/value shape.
Split clones role and presence to both children. Move/trim, gain/fades, mute and
same-kind source replacement preserve it. Adding another use of an asset without
an explicit role does not inherit classification. There is no new copy command.

The role advances timeline revision and updatedAt just like other clip edits.
Revision-bound preflight, playback and analysis results become stale. This is
intentional and does not mean role assignment changes audio processing.

## Frozen snapshot profile

Any frozen timeline with an own audioRole key (including null) must declare
`audioRoleProfile: "mioon-clip-audio-role-v1"`. Role-free snapshots omit that key.
Missing, unknown or unnecessary declarations are rejected. The declaration
records classification semantics only; existing render/audio processing profiles,
filter graphs, source bytes, gain, fades and mute remain unchanged.

Role edits change subsequent snapshot hashes. Old saved snapshots and request
receipts are never rewritten. Decoded PCM/pixel equivalence is a distinct causal
acceptance gate; schema/filter tests alone do not prove rendered equivalence.

## Workspace and recovery

Ordinary38 is a marker-only additive migration from36. It validates complete
trusted receipt protections before any marker write; missing guards fail closed
rather than leaving an unprotected database. Existing raw rows, rowids, sequence
values and historic schema constructors remain unchanged. Source38 restores into
fixed schema39 / restored-local-v8. Historical restored25–37 are never upgraded.

Bounded role-evidence scanning rejects keys/profiles in incompatible workspaces
before earlier migrations can write. It covers saved timelines, timeline history,
receipts, exports, durable task inputs and archived history/proposals. Escaped keys,
duplicates and role-specific rejection evidence are not compatibility loopholes.
Runtime gates also cover mutation, replay and durable intent preparation, so an
old restored profile cannot persist an unsupported role intent and poison restart.
Existing restored origin/invocation and captured-record restrictions remain.

`workspace.restore.inspect({})` keeps its prior response shape. Explicit
`{includeAudioRoleCapability:true}` adds `audioRoleCapability` with the fixed
profileId and server-derived editable boolean. Missing capability means unsupported
for UI admission. This is advisory presentation, not authority to bypass runtime
profile/origin checks. `canEditTimelineAudioRole` validates the disclosure.

## Acceptance boundaries

Focused contract, business, schema, replay, transport, locale and causal-media
results are recorded separately. No native GUI, macOS/Windows, provider, complete
release or general media-quality acceptance is implied by this backend slice.

## Local acceptance record (2026-10-15)

Base: `7b0de4a8baf9068db03b35ccf63324d2287c3a40`. Independent compatibility
review found no remaining source blocker after exact rejection-proof binding,
old-profile durable-intent guards, historical snapshot checks, complete receipt
protections, restored39 allowlists and opt-in capability validation were fixed.

Serial evidence in local `evidence/audio-roles/` (generated, intentionally ignored):
- Schema/legacy dispatch group: 106/106. Expanded actual backup38→restore39 suite:
  49/49, including origin restrictions, held receipts, Undo/Redo and restart.
- Broad regression: 175/176. Its one synthetic legacy fixture had removed receipt
  guards; it now restores the exact original SQL before restart. The focused
  legacy omission/byte-preservation test passed. Production guards were not relaxed.
- Contract/transport group: 24/26. The complete explicit accepted-operation catalog
  correction later passed its focused schema fixture. The other failure remains
  the qualification gap below. Foundation typecheck passed separately.
- Role business tests (8), acknowledgement contracts (10), restored contracts (5),
  locale coverage and the existing fades mutation transport passed in the recorded
  groups. This is not a claim that the complete suite passed on final source.

### Unresolved transport qualification

The new role HTTP/CLI/MCP test had an earlier 15-second-budget passing run, but
its later CLI `timeline clip update` request was closed with SIGKILL after the
helper budget. That failing run did not preserve the exact generated request IDs,
child PID, exit code or server mutation outcome. Fixture cleanup completed without
reported errors; it is not detailed process-retirement or non-commit evidence.
A diagnostic 30-second-helper run passed. It does not establish root cause or
15-second responsiveness. Final source restores the original 15-second budget,
with no rerun and no production deadline changes. Preserve both failed and
diagnostic logs; do not treat the latter as final gate acceptance.

### Role-only causal evidence

Exactly three serial production float-v2 renders used generated local two-second
fixtures, unchanged two-thread production encoders, and 30-second whole-render
AbortSignals. Fixture generation/decoding was single-threaded. Omitted roles,
human/music/sfx roles, then explicit null clears produced revisions 6/9/12 and
three distinct snapshots. All decoded PCM buffers were byte-identical at the
observed 770,048 bytes, including container/codec padding; this is not a claim of
exactly 768,000 decoded bytes. All 60 decoded frame pixel hashes matched.
Source hashes and all non-role timeline parameters remained unchanged. The ledger
records all 50 owned tool processes with close code 0, null signal and no kill
requests; no render deadline aborted. No additional render or retry was executed.

PCM SHA256: `f705a421a80b80cec8fdb73cb07530bac06043133de366ca928e336fa26b0cad`.
Frame-list SHA256: `6f42ab6307a064fa5d00dfcf89408f9be784f58adf5a2a336f7516f21ef9be10`.
Exact source/snapshot hashes, generated paths, command arguments and process
identities are retained in `evidence/audio-roles/causal-media.json`.
After this run, the qualification script's unused kill wrapper was tightened to
forward the exact argument list, and source identity recording was automated;
these harness-only refinements were not re-executed. No production source changed.

Retained source identities (SHA256):
- sine.wav: `ef7a304db53a4a1389aa450b90c701a1b575b44d4b587d8912969c7fed0a5cc5`.
- pattern.mp4: `4f6778b9fddf29508fa56f63d33ab2b9d3cf9e097eb46337c0cda959bfe19dfa`.

Snapshot identities (SHA256):
- absent / revision 6: `1fb624a548dc6d73f249c38e671892e6eda30dac6e1c218f6f6b6f12235616ce`.
- roles / revision 9: `ff088383c5b4747249b5554dd3e4ec67e1bf522ad441eea96d8d61f02cf89a3f`.
- clear / revision 12: `39a2b6bf06ea753f368a82f0a3836e72227d472b1c5ba1bc91516198e08b8332`.

Exact observed process PID sequence: 26, 41, 60, 61, 93, 125, 126, 127, 128, 134, 149, 162, 163, 164, 170, 185, 186, 201, 207, 208, 240, 272, 273, 274, 275, 281, 296, 309, 310, 311, 317, 332, 333, 348, 354, 355, 387, 419, 420, 421, 422, 428, 443, 456, 457, 458, 464, 479, 480, 495. All 50 closes were clean; the command ledger remains in the retained evidence archive.

Internal evidence archive: `mioon-audio-role-evidence-20261015.tar.gz`, 16,702
bytes / 15 text log or JSON files, SHA256
`d4b47f740493c6f9d6925bccc1440f13599a17142c2d7c96cf5ef2a85c4e91dd`.
The archive manifest includes per-file hashes. Its UTF-8/extension and credential
pattern scan passed; generated media, databases and dependencies are excluded.
This archive is retained internally, not a user deliverable.
