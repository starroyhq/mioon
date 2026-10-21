# Manual timeline subtitles

Date: 2026-10-11. Candidate based on `be27199b1d72b8e825adc0c953eecdf9b5a751ae`.
Implementation, focused checks, fresh production build, actual Linux package
inspection and packaged native workflow have passed. The independent parent full
gate exited0:3,742total/3,740passed/0failed/2skipped,796,456.344993ms.
Final commit is owned by the parent integration thread.

## Scope

Manual cue add/update/remove, one fixed bottom-centred profile, timeline render
preview/export, existing undo/redo and exact-key recovery. There is no automatic
speech recognition, SRT import/export, arbitrary font/style, animated captions or
new built-in Agent tool. Dry source playback stays unchanged. Storyboard exports
retain their separate legacy output behavior.

The optional saved field is `subtitles:{profileId:'bottom_cjk_v1',cues:[...]}`.
Each cue is `{id,text,startFrame,durationFrames}`. The backend supplies IDs and
profile. Three shared strict operations are exposed through UI, HTTP, CLI and MCP:

| Operation | Required input in addition to projectId / expectedRevision / requestId |
| --- | --- |
| timeline.subtitle.add | text, startFrame, durationFrames |
| timeline.subtitle.update | cueId, nonempty patch containing only those three fields |
| timeline.subtitle.remove | cueId |

Replies are complete saved timelines. Request identity uses the existing timeline
journal, not a new namespace. Exact historical replay occurs before fresh CAS;
changed reuse conflicts. A malformed success or ambiguous transport error keeps
the original request. Only authoritative acknowledgement or matching rollback
proof resolves it. UI preparation persists exact intent before dispatch and the
three writes join `timeline:mutation`, bringing the fixed local edit list to 19.
Full cues are available via `timeline.get`/`project.get`; `timeline.inspect`
deliberately omits them, preserving the existing bounded model context.
Startup/read/list never execute pending work. CLI/MCP remain responsible for
retaining their original key; this does not grant them generic task authority.

## Text and time limits

- 100 cues per timeline; integer 30 fps frames, exclusive ends; nonoverlapping
 intervals, adjacency permitted. Cues cannot extend media-derived duration.
- 1–2 explicitly entered nonblank lines, 20 Unicode scalars per line, 161 UTF-8 bytes.
 No normalization, automatic wrapping or silent truncation.
- Printable ASCII, Han U+4E00–9FEF and the explicit punctuation set in the shared
 profile. Unsupported code points identify a one-based line/column and U+code.
 Emoji, arbitrary scripts, combining sequences and bidirectional layout are not
 supported by this first fixed profile.
- 28px glyph size, 2px outline, 8px box padding, 48px outer horizontal/bottom margin,
 maximum 120px outer height. Actual outlined ink is measured before rendering;
 it must fit the selected 720/1280-wide canvas. Text-count validation alone does
 not claim exact glyph fit.

Media trims/removals that strand a cue reject the entire mutation; users must
explicitly shorten or remove that cue first. Cues do not introduce media segment
boundaries. Global intervals are intersected with existing segments, preserving
half-open frame semantics at cuts.

## Historical and migration guarantees

Old timeline/history/receipt records without `subtitles` keep that absence.
Undoing into old history removes the live optional field, rather than inheriting
new cues. Removing the final cue may retain an empty container. Frozen render
snapshots include `{subtitleProfile:{profileId,fontSha256}}` only when cues are
nonempty. Historical replay does not access the font or run FFmpeg. Old exports
and source media are never overwritten.

Schema22 appends precisely three allowed edit-task operation strings. It creates
no subtitle table and copies original rows/raw input strings/sequence positions
without rewriting them; original indexes and triggers are recreated. Migration
runs in the existing startup transaction. Timeline records/history and ordinary
acknowledgements consistently allow 256 KiB of valid schema. Model inspection
output remains 128 KiB per result, with its separate cumulative context limit;
those model budgets do not invalidate a legal timeline or receipt.

## Font and renderer boundary

The packaged fixed OpenType font is 16,437,296 bytes,
SHA-256 `7b13c45bba411924f99c1ee26e1a5ee1ea7fc768503a4d03987d587e16a72e99`.
It was reproducibly extracted from face 2 of the already installed Noto CJK 2.004
collection. Source hash, extraction script, upstream copyright and complete
OFL 1.1 text are retained beside it. See
[font provenance](../packages/business/resources/subtitles/README.md).
The package copies exactly five allowlisted resources outside ASAR. Font and
notice hashes are checked with bounded reads before/after packaging. This is
license-notice preservation, not a comprehensive legal compliance opinion.

Each captioned render stages one verified font copy and literal UTF-8 cue files
in its existing private work directory. Font paths are backend-owned; the public
schema cannot supply font paths, filters, scripts or arbitrary decoder commands.
Literal text uses `textfile` with `expansion=none`; generated paths are escaped
for FFmpeg option/filter syntax without a shell. One bounded font-only FFmpeg
process measures all distinct cue texts, up to 100 frames at 4096×256 pixels (100 MiB
cumulative, streaming counters/bounds rather than a full output buffer), 30s
process deadline and 64 KiB stderr. Truncated/extra output, guard-edge ink,
unsupported geometry and overflow fail before publication. Existing media child
abort/shutdown ownership applies. Composition uses the same staged font/text.

Before measurement, one bounded `ffmpeg -h filter=drawtext` inspection checks
the required options. Both measurement and composition explicitly use
`text_shaping=0` when available. FFmpeg exposes that option and its FriBidi
pre-reordering only in builds with `--enable-libfribidi`; a complete valid help
response without the option therefore uses the equivalent already-disabled
behavior. Unrecognized or truncated help never enables this compatibility path.
The fixed Chinese/ASCII character rules and unsupported RTL/combining-text
boundary remain unchanged. See the [official filter documentation](https://ffmpeg.org/ffmpeg-filters.html#drawtext-1)
and [conditional option/processing implementation](https://ffmpeg.org/doxygen/8.1/vf__drawtext_8c_source.html).

An old snapshot or empty cue list returns before any font read/measurement.
Preflight remains read-only, checks the same renderer options and can report font
verification with `inkMeasured:false`; actual glyph measurement belongs to render.
Missing drawtext/options blocks the check; unverified capability is incomplete.
A passing
preflight cannot promise future file stability or final rendering success.

## UI and verification status

The timeline subtitle lane opens extracted right-Properties controls, without a
modal. Drafts survive right-tab/collapse changes. Project/selection changes use
existing dirty guards, stale revisions retain drafts, and task recovery cannot
apply an old acknowledgement to a different current project or selection.
Rendered preview identifies stale snapshots separately from saved edits.

Verification covers domain38/38 and expanded migration/history156/156;
rendering/resources/preflight11/11; existing desktop regressions60/60; actual
HTTP/CLI/official-MCP lost-acknowledgement/restart/replay cases; and focused UI,
recovery, package and compatibility checks. Earlier failing fixture assumptions
and corrected runs are retained in the acceptance evidence rather than hidden.
These overlapping focused sets are not a substitute for the parent aggregate.

The fresh production Linux x64 tar was inspected for ASAR identity, runtime
notices, fuses and the five exact external font files. The unmodified packaged
app then imported a synthetic video, precisely rejected an unsupported emoji,
saved Chinese/ASCII two-line text, rendered a preview, updated text, undid/redid,
and exported an actual 1280×720/30fps/60-frame MP4. Full decode passed; preview and
export decoded PCM were byte-identical. The old preview stayed frozen at revision
4 while the final export used revision7. Normal exit, a new app/backend process,
and a second normal exit retained all12 audited table hashes, source/media bytes,
subtitles and two render records. No automatic rerender occurred.

The native final output is376,261bytes, SHA-256
`f4bde9732dd37b5816a4ab583a4890763179942fd8d96cc47f50a37da7ece364`.
Independent source/evidence review found no remaining blocker and verified all
324 production source inputs and build hashes. The independent parent full gate
passed3,742total/3,740passed/0failed/2skipped (exit0,796,456.344993ms).
Mac/Windows native-font and live-provider behavior are unverified.

## Follow-on

The user approved configurable exports after subtitles. The next bounded slice
will retain MP4/H264 defaults while adding explicit quality/rate/resolution
presets shared by UI/CLI/MCP. See [approved roadmap](PRODUCT-ROADMAP.md); this
subtitle slice does not change CRF 23/AAC 128k, container, codec or project timebase.
