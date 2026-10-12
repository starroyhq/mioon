# One explicit subject-version image for video

Candidate baseline: `4c36bf12755d52fbce49bcf6bfe227fe0d62e299`.
Official documentation reviewed: 2026-10-11 UTC. Implemented candidate: focused
checks, fresh production package and Linux native acceptance passed. The first parent
aggregate passed (4,297 total / 4,295 passed / 0 failed / 2 skipped). The final
copy-only clarification passed fresh build/package and actual Linux native checks;
the final parent aggregate passed on 2026-10-12 UTC: 4,297 total / 4,295 passed /
0 failed / 2 skipped, 965674.340528 ms.
Live-provider verification is separate.

## Small shared contract

`generation.submit` adds only `subjectVersionId?: UUID`. It is an explicit choice
for this submission, not a saved shot property. Omission keeps the historical
request path and does not inspect planning bindings for possible inputs. `null`,
arrays, caller-supplied asset/hash metadata and unknown fields are not accepted.
Existing `shotId`, `expectedRevision`, stable `requestId`, provider/model and
parameter semantics remain authoritative. No database migration, new operation,
task namespace, generic executor or built-in Agent capability is introduced.

Select exactly one immutable `character`, `product` or `location` subject version.
`look` and style associations remain planning-only. A past version can be selected
even after its head advances. The request names that exact version, never "latest".
The server resolves its asset/hash and complete typed lineage; the caller cannot
grant ownership by supplying metadata. Selecting a subject while any saved first
image, last image or first-frame connection remains is rejected. The user must
explicitly clear/save those choices themselves. Nothing is silently discarded.

The right Properties workspace presents a session-only choice, source/version,
scope and confirmation. An unsent choice is not promised across application exit.
Library subject/style bindings stay local until a separate explicit supported
generation choice is made. No automatic generation, prompt optimization or
`@图片1` insertion occurs. The saved shot prompt is the transmitted prompt.

## Frozen source and recovery

A new subject task freezes `snapshot.subjectReference`:
`{subjectVersionId,subjectName,subjectKind,subjectVersion}`. `subjectVersion` is
the complete existing strict version DTO, including project/subject/version
identity, number, asset ID, SHA-256, MIME, dimensions, creation timestamp and
original legacy/image-task/extracted-frame provenance. A short human label is
display data; it does not select media.

It also freezes exactly one `referenceAssetIds` entry, one
`{role:'subject_reference',assetId,sha256}` binding and matching source metadata.
The profile, provider region, shot revision, prompt, duration, aspect ratio and
parameters retain their existing frozen identities. Partial, contradictory or
mixed-role records reject rather than fall back to first-frame semantics.

The generation request hash includes the selected version. Same-key changed or
omitted version conflicts. Exact replay checks retained ownership before returning
a new subject receipt. Explicit retry of a confirmed failed job uses its original
snapshot and selected version, independent of current head/shot/bindings. Unknown
submission is reconciled without another POST. Historical v1/v2 profiles remain
exactly resolvable; archiving does not grant them new subject execution authority.

The renderer saves the complete reviewed source alongside its exact session
request before dispatch. A valid matching acknowledgement or unique validated
read of the original job may settle it. Matching `requestId` alone, a malformed
success or a later generic 4xx does not release this key. This is the existing
session recovery mechanism, not a new durable cross-application intent ledger.
The shared CLI/MCP client checks the selected UUID and complete internally
consistent returned manifest; the renderer additionally compares its reviewed
full source pin. Subject retries retain the complete original public snapshot
beside their unchanged `{jobId,requestId}` wire input. Marked or read-observed
subject retries require that saved proof; missing proof is not reconstructed from
today's source or silently downgraded to legacy recovery. CLI/MCP can validate a
subject-bearing retry response but cannot infer a removed subject marker from
`jobId` alone; the backend still validates the retained original. No client retries
a POST automatically.

The same owned-media graph checks selected versions, assets and typed ancestry
at admission, replay/retry, source preparation, asynchronous read boundaries and
the final provider POST fence. New subject job reads used for settlement also
validate ownership. Current library head media is not needed to validate an older
selected version. Source files still undergo existing bounded managed-byte and
SHA-256 checks before transmission. This is not filesystem immutability.

The shared reader limits returned row bytes/counts and consumes the existing graph
budget. These limits do **not** bound all SQLite work: legacy JSON reverse-owner
and edge-target predicates can scan tables without corresponding expression
indexes. Query plans and representative data-volume checks are part of this
slice's evidence; no general database performance guarantee is claimed. A retained
subject job also reserves its original request key if its ledger row is missing;
it is never repaired or regenerated on that basis. This fallback checks bounded
row projections but scans retained jobs. Malformed or oversized relevant records
and corrupt edge candidates can conservatively block new subject admission.
Arbitrary external deletion of both the job and its receipt is outside this
recovery guarantee.

## Exact provider mapping

Only current Ark `doubao-seedance-2-5-260628` and local Mock implement this slice.
New active profiles are `mioon-input-profiles/3`; old v1/v2 pins retain their
unchanged values and paths. Other providers reject unsupported roles.

Ark uses the existing fixed Beijing endpoint:
`https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`.
The content contains one text item and one `image_url` item with explicit
`role:'reference_image'`, plus top-level `omni_reference_task_type:'reference'`.
The local `subject_reference` role is not sent as a vendor role. The request uses
an explicit 9:16 or 16:9 output ratio, 4/8 seconds, 720p, MP4 and
`generate_audio:false`. First/last-frame mode separately keeps `ratio:'adaptive'`.

Mioon accepts one PNG/JPEG of at most 10 MiB. Ark image sides must be 300–6000 px
and image width/height 0.4–2.5. Reference image and output need not share a ratio;
a square subject image is valid. Mock keeps a workflow-only pattern and does not
depict the selected subject or prove identity/visual consistency.

**Ark's direct-upload real-human-face restriction is displayed at selection and
confirmation.** Current local data-URI inputs do not implement Ark portrait-asset
authorization or trusted same-account generated-content exceptions. Mioon does
not claim to reliably detect or prevent every real-face upload, and does not
promise identity locking. Use non-face synthetic fixtures for offline acceptance.

## Official facts versus application subset

The official pages opened as JavaScript shells. Facts below were verified from
search-indexed text of the official URLs on the date above, not from an account
or live request. Revalidate the exact model before real integration.

- [Create-task API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh):
  reference-image role, reference task type, data URI syntax and mutual exclusion
  with first/last roles. Vendor input bounds include 1–30 images, more image
  formats, 300–6000 px sides, ratio 0.4–2.5, each image below 30 MB and complete
  request at most 64 MB. An asynchronous `TaskTypeMismatch` can still be returned.
- [Exact Seedance 2.5 guide](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)
  and [video guide](https://docs.volcengine.com/docs/ark/video-generation-tutorial?lang=en):
  reference generation supports explicit output ratios; documented durations are
  4–30 integer seconds or automatic, and resolutions include 480p/720p/1080p.
  The one-image, 4/8-second, 720p, PNG/JPEG and 10 MiB choices are Mioon's subset.
- [Portrait restrictions](https://docs.volcengine.com/docs/ark/seedance-portrait-asset-guide?lang=zh)
  and [actor authorization](https://docs.volcengine.com/docs/ark/upload-real-person-portrait-assets?lang=zh):
  directly uploaded real-face references are unsupported; platform portrait
  authorization is a distinct workflow, not implied by a local subject record.
- [Model opening rules](https://docs.volcengine.com/docs/ark/seedance-2-0-model-resource-pack-rules?lang=zh):
  account eligibility and provider limits need separate verification. Configured
  credentials do not prove access or spending approval.

## Release gates

Strict schema/ACK and role/profile compatibility; complete ownership and async
POST fences; exact lost-ACK HTTP/CLI/official-MCP recovery; head-advance/retry and
old snapshot/receipt preservation; malformed/foreign source refusal; right-dock
draft/confirmation/navigation fences; fresh builds and actual packaged Linux
Mock generation, version history, fixed-source export and normal recreation.
Real Ark image conditioning, charges and native macOS/Windows remain unverified.
Executed focused groups include final affected497/497 and transport/UI/recovery55/55
(overlapping gates, not a combined unique total). Fresh production builds, Linux
tar packaging and package byte/license/font/fuse checks passed. The actual package
imported two synthetic PNGs, generated one Mock subject-V1 video, appended library
V2 without changing the old task/version/media, then exported the fixed video as
720×1280,30fps,120frames,4seconds,H264/AAC48kHz. Full decode exited0. Both normal
exits returned0; a new application process retained all24 audited business-table
and4 managed-media hashes, with one provider submission. No live supplier calls.

The original transport test expected an inline UUID schema rather than a valid
shared `$ref`; the exact reference check was corrected and original failure kept.
Default-cache packaging initially failed in this environment; an existing explicit
shared cache completed it. An inspector launched before tar completion correctly
rejected incomplete gzip; the final post-completion inspection passed. Native
transition capture showed temporary overlapping paint; the settled capture was
clear. No graphics/security settings were changed and no rendering fix is claimed.
The parent pre-copy full suite passed: 4,297 total / 4,295 passed / 0 failed /
2 skipped, 927452.620971 ms. Visual review then found stale wording suggesting
the whole subject library was planning-only. Three renderer text-only corrections
now distinguish planning bindings from explicit generation, including the
binding-only usage list. Queries, actions and services are unchanged; desktop
main/backend bundle hashes remain identical. The affected post-copy gate passed
95/95. A fresh corrected package passed inspection; its final native session
showed the corrected library banner, binding-only usage labels, shot planning
notice and adapter disclosure beside the unchanged generated V1. Normal exit
returned0 and all24 audited tables/four media hashes remained unchanged. The
main/backend bundles are identical; only the renderer/ASAR changed. Earlier
full generation/export/restart evidence is retained under its original artifact
hashes rather than claimed as rerun. The final corrected-source parent aggregate passed on 2026-10-12 UTC:
4,297 total / 4,295 passed / 0 failed / 2 skipped, 965674.340528 ms, actual exit0.
The pre-copy full pass and post-copy focused/build/native evidence remain
separately recorded; no live-provider or native macOS/Windows claim is added.
