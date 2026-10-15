# Clip audio-role editor acceptance

## Scope and implementation

The selected audio/video clip inspector now exposes Unclassified, Human voice,
Music, and Sound effects in Simplified Chinese, region-neutral Traditional
Chinese, English, and Japanese. These are editorial labels, not a claim that a
clip contains audible audio. Muted, zero-gain, and silent-video clips remain
eligible. Image clips do not expose this control.

The field uses the existing clip draft, local recovery, explicit Save clip,
timeline revision/CAS, pending-request recovery, and Undo/Redo paths. Split
inheritance and role-only snapshot invalidation come from the accepted backend.
There is no separate business metadata save, DSP, routing, normalization, or
inferred classification. Absent legacy fields remain absent until explicitly
edited; clearing a prior role writes null.

Workspace identity keeps its default inspection request. An independent opt-in
capability probe is nonblocking, abortable after five seconds, and cancelled on
reconnect or unmount. Its own connection generation and retained workspace
identity prevent late results from enabling another workspace without confusing
project selection with workspace lifetime. Loading, confirmed unsupported, and
unreadable capability states have distinct localized copy. Missing, malformed,
foreign, or unavailable capability disables only role writes. Unrelated edits
omit an unchanged role rather than injecting new metadata. A recovered role
change remains retained and blocked when unsupported.

Every save acknowledgement checks captured role presence and value even when an
unchanged role was omitted from the outgoing patch. A missing, normalized, or
changed role in an acknowledgement cannot silently clear the draft.

## Source identities

- Qualified backend: e5bf880c766cc2b1ffc1ebe0b6293e28b1c6d28c.
- Real integration merge: 9d458e9890f2669541d952e094aeb121e1ae6c92, with both histories preserved and no conflicts.
- Frozen source used for final runtime/type/build gates: aa364d75d482981287711312abc6344eb48642c6.
- Frozen source tree: ef8cb3b5ac0783d54dc48487e0b45ea79e688d8f.
- This acceptance record is a documentation-only follow-up; production source and generated artifacts are unchanged.

## Verification

- Initial focused role/actual-inspector checks: 33/33 passed.
- Final explicit, deduplicated affected set: 468/468 passed across 24 files; no skips.
- Independent role/inspector/draft check: 88/88 passed on the frozen source.
- Reviewed strict foundation and browser typechecking: passed.
- Reviewed production build: passed, including web and desktop main/backend/preload staging. Production identity is app.starroy.mioon; build runtime was Node 24.19.0 with Electron pinned to 44.7.0.
- Existing Base UI directive and bundle-size warnings remain warnings, not failed gates.

Coverage includes role values/null/absence, actual selector handlers, ordinary
Save/CAS, explicit clearing, dirty draft recovery/discard, unavailable capability
with unrelated edits, mismatched/unknown/late acknowledgements, captured stale
handlers, muted/silent sources, image exclusion, supported restored editing,
legacy restored rejection, exact workspace/source identity mismatch, bounded
hung probes, ignored abort, reconnect, and all four locales.

### Retained failed evidence and fixture repairs

The first affected run was 453/468: fifteen failures were reproduced unchanged
on the backend-only checkpoint. They were stale localization fixtures, not
production behavior changes. The native close fixture expected removed literal
Chinese; the JPEG renderer omitted its actual localization/message bindings;
App callback extraction omitted the actual message descriptor function.

Only those three fixtures were repaired. The close fixture now executes the
actual localized callback across four locales while retaining and expanding
explicit-proceed, safe-default/cancel, unconfirmed-draft/view, and no-cancellation
assertions. Original interrupted-navigation, failure, and pending-request
assertions remain intact. The repaired subset passed 39/39 before the final
468/468 run. The fixture delta received independent review.

Retained logs: audio-role-ui-focused.log, audio-role-ui-affected.log,
audio-role-ui-baseline-drift.log, audio-role-ui-fixture-repair.log,
audio-role-ui-typecheck.log, audio-role-ui-final-affected.log, and
 audio-role-ui-production-build.log. The exact affected file list is
 audio-role-ui-affected-files.txt. Source and production manifests bind these
results and artifact bytes by SHA-256.

## Qualification limits

The accepted backend's final 15-second CLI transport helper qualification gap
remains explicitly unresolved. It was not retried or widened here. The earlier
three-render causal evidence is inherited, not rerun.

This is source/controller/type/build acceptance, not a full-suite pass, GUI
acceptance, signed package, installed release, or user-Mac validation. No native
GUI, provider, media qualification rerun, push, or user-computer operation was
performed. A prepared native acceptance packet does not authorize its execution.
