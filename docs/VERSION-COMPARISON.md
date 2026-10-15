# Fixed shot-video comparison

This slice enriches the existing Versions → Compare dialog. It does not add a
second comparison entry point or generate/render new content.

## Workflow and limits

- Select two distinct existing shot-video versions explicitly. Neither side is
  automatically selected, and playback starts only through native controls.
- Both selections remain fixed across new versions, list ordering, language
  changes and changes to the shot's current version.
- Inspect the frozen prompt, duration/aspect ratio, provider/model, timestamp,
  project/shot/version/asset identifiers and recorded SHA-256. Missing metadata
  reads “Not recorded”, never the current mutable shot settings.
- One side plays at a time, initially muted. No synchronized seek, alignment,
  visual diff, wipe, frame-quality measurement or perceptual quality claim.
- “Use version” remains a separate explicit action through existing version.select
  revision rules. Existing timeline sources and exports are never replaced.
- Unsupported media, missing/foreign records, changed identity, offline state or
  project/workspace changes stop playback. Clear and explicitly reselect after
  invalidation. A newer version never substitutes for an unavailable choice.
- This first slice covers ordinary-workspace managed MP4 shot versions only.
  Restored workspaces, separate image-generation groups and generated-audio
  comparison are not added by this change.

## Media authority

The renderer retains exact scope/project/shot/version/asset/hash bindings and
constructs only the dedicated same-origin comparison route. Raw asset/version
URL fields do not confer authority.

Authenticated GET/HEAD `/api/version-comparison/media` requires exactly
projectId, shotId, versionId, assetId, sha256 and workspaceOrigin query values.
The ordinary-workspace sentinel is `normal`. This is a stale-scope check, not a
new read permission. Existing authentication, Host/Origin policy and native
request boundaries continue to apply; restored comparison is refused.

The server resolves the owned project graph and exact published managed shot
result. Graph validation and managed-file identity are checked again at the
response boundary. GET, HEAD and byte ranges reuse bounded file serving. No
provider access, model call, output retrieval, download retry, schema mutation or
asset write is performed by comparison.

Matching SHA-256 values establish consistency between the saved version and
asset records. This route does not rehash the complete file on each request and
does not claim cryptographic verification of bytes served. Managed path/file
identity guards do not replace that distinct content-hash guarantee.

## Acceptance boundary

Source-level state/component and authenticated media-route tests cover explicit
identity, invalidation, late callbacks, ownership, range handling and four-locale
copy. Exact source test/build results are recorded with the implementation
checkpoint; passing focused tests is not full-repository or native acceptance.

No GUI run is included in this slice's initial source acceptance. The known
AT-SPI prerequisite block is not retried here. Actual dialog appearance, native
keyboard/focus behavior, responsive layout/200% zoom, native media decoder output
and cross-platform acceptance remain unverified until their independent gates.
No screenshots, real-provider quality, publication or release acceptance are
implied.

### Initial source-check observations (before App integration)

Pinned runtime: Node 24.21.0. Commands use the existing installed dependencies.

- `node --test tests/version-comparison-media.test.mjs tests/export-preview-media.test.mjs tests/http-file-response.test.mjs`
  first returned 33 passed / 1 failed, exit 1, in 18.40 seconds.
  The failed export-preview test was “preview exact ownership requires matching
  export receipt and owned published asset” (`tests/export-preview-media.test.mjs:107`).
  Its unchanged-row assertion observed the active worker transition a deliberately
  queued fixture export to failed with `MANAGED_SOURCE_INVALID`, between
  2026-10-15T19:28:48.516Z and 2026-10-15T19:28:48.823Z. This is an observed
  timing-sensitive fixture outcome, not a baseline-proven pre-existing failure.
- New route dispatch was narrowed to its exact pathname, preserving the absence
  of any added await on unrelated routes. No assertion, timeout or worker rule
  was weakened.
- A standalone `node --test tests/export-preview-media.test.mjs` then passed 5/5
  in 6.26 seconds. This is a later result, not erasure of the first failure.
- Final standalone `node --test tests/version-comparison-media.test.mjs` passed
  12/12 in 13.17 seconds, including exact UUID/hash length validation, real offline
  Mock publication, restored refusal, late file/graph identity and range checks.
- Foundation strict typecheck and the runtime source-language guard passed.

The initial tool stdout was not saved as a separate file. The observations above
retain the command, failed assertion, changed state and subsequent gates. The final post-integration serial gate passed 458/458 across 29 affected files,
including both exact comparison and existing export routes. Both strict
typechecks and the production-channel build passed. The 1,507-entry source
manifest remained unchanged through both gates; a 53-entry manifest binds the
produced desktop staging artifacts. See
`evidence/version-comparison/ACCEPTANCE.md` for commands, logs, retained earlier
failures and explicit native/GUI limitations.
