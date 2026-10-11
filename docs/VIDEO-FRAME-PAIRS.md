# Saved first/last-frame video references

Status: implemented candidate on baseline `ddf14ccaf62ddb0008a8c5815cef4182dc801ae9`;
focused, build/package, Linux native and independent final aggregate gates passed.
Reviewed official documentation index: 2026-10-11 UTC. No live provider acceptance.

## Bounded slice

Add a saved optional last-frame image to a shot. The existing first-frame selection
and canvas connection remain first-frame-only. Only the exact Ark Seedance 2.5
adapter and local Mock are being connected end to end. Subject/style library
bindings remain local planning metadata and are not uploaded. There is no automatic
image-to-video second stage, new canvas port, identity-lock promise or Blender dependency.

Ark keeps `doubao-seedance-2-5-260628`, the fixed Beijing task API, 4/8 seconds,
720p, 9:16/16:9, MP4 and `generate_audio:false`. PNG/JPEG files are each limited to
10 MiB, with each width and height in 300–6000 pixels. Both images must individually
match the selected aspect ratio; their pixel dimensions need not be identical.
These selected durations, output settings, formats, byte cap and strict aspect-match
rule are Mioon's narrower supported subset. The vendor supports wider choices.
The retained application duplicate-reference rule rejects the same asset ID in both
slots even though the vendor permits the same image.

Mock remains a moving test pattern, not an image-conditioned video. It can verify
saved roles, frozen provenance and the task/export lifecycle, not the generated
first/last frame adherence, likeness, motion quality or a paid provider connection.
Its previously supported single-image limits and scenarios remain compatible.

## Saved and frozen identities

`shot.create` / `shot.update` gain `lastFrameAssetId?: UUID | null`. Omission keeps
legacy data shape and means no patch change. `null` is an explicit clear. A non-null
ID must be a same-project managed image with valid typed ownership. Existing
`referenceAssetIds` still contains only the saved first-frame selection: a second
legacy array element is never reinterpreted as a last frame.

The shared shot revision and optional stable mutation key keep their existing CAS,
exact-input binding and original-response replay semantics. This does not add shot
undo/history or the separate durable edit-task ledger. Manual shot-edit pending
receipts retain their existing session recovery limit; no new cross-restart pending
edit rediscovery is claimed. A successfully saved tail selection persists normally.

First-frame attach/detach leaves the saved tail untouched. An incomplete saved draft
with only a tail is allowed; generation rejects it. New jobs freeze the complete
ordered first/last ID, role, hash and metadata manifest plus original first-frame
connection provenance. A retry uses that frozen selection, not current shot/library
heads. Legacy absent fields, reference acknowledgements, job/version snapshots and
receipts are not rewritten or populated with defaults. Historical profile identities
remain explicitly resolvable; current discovery advertises a single active profile.

Every fresh save, historical/current mutation replay, generation admission and
final dispatch boundary validates project and typed image/frame ownership. Both
outgoing image buffers must match the approved hashes and supported bytes/dimensions.
The final synchronous provider fence remains after asynchronous source preparation.
Captured bytes are verified; this does not promise filesystem immutability or eliminate
all filesystem races. Unknown submission is not an invitation to POST again.

The existing backend count authorization is not a currency budget, and the video
confirmation is not the separate Images review-token protocol. No new real-call
permission or built-in Agent write/context permission is introduced.

## Official facts and application restrictions

Direct opening of the official Ark pages returned a JavaScript shell. The following
facts were read from the search index of those official URLs on 2026-10-11; the
reported index crawl age was approximately three days, not a publication date.

- [Seedance 2.5 guide](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh):
  the same curl pins the exact model above, includes two `image_url` entries with
  explicit `first_frame` and `last_frame` roles, and sends `ratio:adaptive` to the
  existing `/api/v3/contents/generations/tasks` endpoint. First/last output follows
  the first image's ratio. This is not inferred merely from a broad model feature label.
- [Create task API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1):
  the exact Seedance 2.5 first/last row requires adaptive; two image inputs have
  distinct roles and cannot mix omni-reference input roles. Documented image
  constraints include 300–6000 px sides, ratio 0.4–2.5, each image below 30 MB,
  request no larger than 64 MB, and inline lowercase-format data URIs. PNG/JPEG,
  720p, silent output and MP4 are supported; the application limits above are narrower.
- [Prompt guide](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=en):
  the last image may be transformed if its ratio differs. The guide describes
  stretching while the API index describes cropping; Mioon rejects mismatch and
  does not depend on either interpretation.
- [Model activation conditions](https://docs.volcengine.com/docs/ark/seedance-2-0-model-resource-pack-rules?lang=zh):
  account eligibility must be checked separately; a configured key does not prove
  access. No account, subscription or spending approval was inspected here.

## Acceptance contract

- Exact legacy row/receipt/snapshot/media preservation on schema23 open/restart;
  omitted/null/UUID writes, stale revisions and keyed replays.
- Tail survives first-frame connect/disconnect; current and historical ownership
  checks reject corrupt, mixed and foreign image/frame owners uniformly.
- Canonical roles, archived profiles, old/new retry fidelity, per-image actual
  byte/hash/dimension verification and state/owner changes during source awaits.
- Actual loopback HTTP, CLI and official MCP strict-schema parity; unknown/lost ACK
  recovery, no automatic paid POST, unchanged built-in Agent authority.
- Dirty drafts, project/selection/tab fences and complete human-readable confirmation.
- Fresh builds, Linux packaged Mock creation/export/restart and independent final
  full-suite gate. Live Ark and macOS/Windows acceptance remain separate.

## Verified candidate acceptance — 2026-10-11 UTC

Focused gates passed: contracts 35/35; lifecycle/adapter boundaries 143/143;
existing provider/reference regressions 325/325; renderer and first-party recovery
149/149; real loopback HTTP/CLI/official MCP plus late lineage and UTF-8 inventory
38/38; shared inspection/Agent/mutation/reference/frame compatibility 318/318.
These groups overlap and must not be added into a unique-test total. The independent
read-only review found no remaining concrete source blocker at this checkpoint.

Fresh production Web and desktop builds, Linux x64 tar packaging, and the existing
package inspector exited 0. Staging/ASAR/tar identity, locked Electron 44.7.0 notices,
external pinned font, fixed security fuses and absence of packaged workspace data
were checked. No macOS/Windows build or live Ark acceptance is represented here.

The unmodified packaged Linux backend was exercised through native UI with two
synthetic 360×640 PNGs. Tail-only and same-asset pairs disabled generation, with no
job created. Saving distinct first/last images and a four-second prompt produced
one successful local Mock submission and one version with both frozen roles/hashes.
The version was explicitly added to the timeline, checked and exported. Actual
MP4 probe and full decode passed: H.264, 720×1280, 30 fps, 120 frames, 4 seconds,
AAC stereo 48 kHz (the Mock source is silent; this does not prove generated audio).

Normal application exit, a new process/renderer/backend launch, and a second normal
exit all preserved the exact hashes of 22 audited business tables and all media.
Both exits returned 0, and the Mock provider submission count remained one.
Saved shot selection, fixed timeline source, paired version provenance and export
were rediscovered. Original PNG hashes remained unchanged throughout.

Evidence includes original screenshots, synthetic media, source/build/package
manifests, read-only row audits, export probe/decode and actual exit records. The
published evidence archive excludes userData, SQLite files, token files and settings.
Observed transient Linux dialog/transition ghosting and unavailable AT-SPI text
input were worked around with supported native keyboard/window controls; no GPU or
security settings changed, and no rendering-bug fix is claimed. System-bus warnings
remain in the raw native logs. No packet-capture claim is made.

Earlier focused red logs remain with their corrected reruns: ownership-check error
classification, contradictory frozen tail manifests, exact explicit-tail ACK checking
and test-harness callback/boolean expectations. The initial offline dependency
lookup failed for missing metadata in the default cache; the existing verified
workspace cache succeeded with the lock and supply-chain policy unchanged.

Final independent parent aggregate: **4054 total / 4052 passed / 0 failed / 2 skipped**,
exit 0, 916439.563365 ms, on 2026-10-11 UTC. The two existing skips remain visible
in the full log. Paid Ark behavior, visual conditioning and native macOS/Windows
remain unverified.
