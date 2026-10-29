# Wired model input limits

Wan SDK update (2026-10-23): UI-configured Wan connections also provide exact
`wan3.0-video` / `wan3.0-video-prime` profiles under `wan30-v1`. The reviewed
model/region table drives local image-only input modes, request controls and
backend checks. Ordered first/last frames or up to ten reference images use
managed Base64 bytes; reference groups never mix with frames. Explicit
`generation.submit.videoInput` replaces saved frame selection for one request,
and remains frozen for recovery. Intelligent duration/adaptive output do not
change saved shot geometry. See [Wan SDK scope and limits](PROVIDERS.md#wan-official-sdk-and-reviewed-model-capabilities-2026-10-23).

Seedance 2.5 update (2026-10-30): the exact `doubao-seedance-2-5-260628` /
`cn-beijing` / `ark-v3` row takes the same explicit `videoInput` with 1–30
ordered reference images, always with the saved shot prompt. Its other modes keep
the saved frame selection in the UI. The encoded images together stay within
60,000,000 bytes because Ark caps the request body at 64 MB. See
[Seedance 2.5 connections](PROVIDERS.md#seedance-25-connections-reviewed-2026-10-30).
The dated baseline and archived profile evidence below remain unchanged.

Date: 2026-10-10. Baseline: `cfbbfd3`. Implementation, final 414-case focused
verification, fresh web/desktop builds and actual Linux native acceptance are
complete. Its independent full aggregate release gate passed (recorded below). No live
provider request, credential entry or upload is authorized by this increment.
The existing Linux trial does not depend on this addition.

## Implemented route, not vendor feature union

The production `provider.list` response adds exact, read-only input profiles,
their version, server UTC evaluation date, server-selected API region and
lifecycle evaluation. UI, HTTP, CLI `capabilities` and MCP `mioon_capabilities`
share this response. The public `generation.submit` / `job.retry` input schemas
were unchanged in the original profile slice. There is no new RPC, task namespace, database migration, region
override or model-authority field.

| Provider / exact model | Server API region | Actual input mapping |
| --- | --- | --- |
| Mock / `mock-motion-v1` | local | Text or one image's workflow metadata; output depicts neither prompt nor image |
| Runway / `gen4_turbo` | global fixed endpoint | Exactly one first-frame image |
| Ark / `doubao-seedance-2-5-260628` | cn-beijing | Text, optionally one first-frame image |
| Gemini Developer / `veo-3.1-generate-preview` | global fixed endpoint | Text, optionally one first-frame image |
| MiniMax / `MiniMax-H3` | global or cn | Text, optionally one first-frame image |
| Vidu / `viduq3-turbo` | global or cn | Text, optionally one first-frame image |

The table above records the original v1 route. The subsequent saved first/last
slice enables one pair for Ark/Mock in v2; the explicit subject-video candidate
adds one chosen subject-version image in v3. Exact archived v1/v2 definitions stay
unchanged. See [first/last scope](VIDEO-FRAME-PAIRS.md) and
[subject-video scope and acceptance status](SUBJECT-VIDEO-INPUTS.md).
Style and motion roles remain unimplemented. A vendor's broader capabilities do
not enable an app route. Subject/style library associations remain local planning.
The old first-frame selection/connection continues to supply actual generation
inputs. No image is pruned, inferred from a subject binding, cropped, uploaded,
or exchanged for a different model to pass validation.

Profiles include the current adapter's durations, ratios, prompt/parameter
bounds, MIME types, image-byte and pixel limits. Runway also checks the complete
base64 data-URI size, including header and encoding rounding. These are app
limits, not a claim of every vendor's maximum capabilities. Existing managed
file/signature/hash/approval checks remain authoritative at actual submission.
Fixed global endpoint labels are not data-residency guarantees.

## Authoritative boundary and replay

1. Existing request replay is checked first. An identical historical request is
   returned without applying new model/date/asset checks or submitting again.
2. A fresh submit retains existing revision, configuration, budget, adapter
   validation and legacy error ordering, then checks the complete owned input
   manifest against the exact profile. Rejection creates no job/event/request
   receipt and cannot spend a generation.
3. New snapshots additionally pin profile version/identity, API region, complete
   ordered role/asset/hash bindings and reference byte sizes. Old jobs, versions,
   assets, timelines and export snapshots are not rewritten. A fresh retry uses
   the old frozen snapshot, validates its current owned source identity, and
   preserves that snapshot's bytes. Old snapshots without byte size resolve it
   only from a matching managed asset; missing metadata fails explicitly.
4. Queued work rechecks before recording an attempt. Shared live HTTP adapters
   invoke a synchronous private fence after asynchronous image preparation and
   immediately before POST, including date, scope, manifest and abort checks.
   A positively identified input-profile fence failure is terminal local
   failure, with no automatic retry or requeue. Before-dispatch shutdown retains
   the existing queued/restart behavior. Once network submission begins,
   existing unknown acceptance handling remains conservative.
5. Accepted-task polling, download and reconciliation do not rerun new-submission
   lifecycle rules. Stopping local work cannot promise a provider refund or no
   charge. `submissionCount` is a local attempt counter, not a packet/POST audit;
   cancellation races can preserve an attempt with no dispatched POST.

Relational ownership is checked before bounded asset metadata is decoded. The
backend rejects missing/foreign or inconsistent identities and explicit role
conflicts rather than relabeling or dropping references. Reference material is
untrusted input; profile metadata does not grant access to assets or paid calls.
Queued attempt claims, local preflight-failure writes, pre-dispatch shutdown
restoration and submitting-at-restart classification validate the original
job/project/shot/request/frozen-snapshot identity and revision inside the same
SQLite transaction as their write. Unverifiable/reassigned rows and events stay
untouched, with a fixed local diagnostic. This is a scoped dispatch safeguard,
not a claim of general database-tampering protection or a rewrite of accepted
provider-task recovery.

### Trusted embedding boundary

Only providers registered by the production registry opt into the new policy.
The registration uses opaque registry/provider identities, captured by services.
A registered Map keeps policy after handle replacement; copied Maps retain it
when they contain registered handles. Trusted server wrappers explicitly call
`registerInputProfileWrapper(wrapper, knownSource)` to inherit the known source's
policy. Unknown objects are never inspected to guess registration: no provider
property, getter, descriptor or prototype access occurs during policy discovery.
Serialized capabilities, project data and RPC fields cannot grant or disable
registration. A fresh worker recreates its production registry and enforcement.

`createServices(store, customProviderMap)` remains an explicit trusted server
embedding/testing extension point. Fresh unregistered custom adapters, including
a directly constructed adapter outside the production registry, retain legacy
validation and are not claimed to be profile-validated. Reserved profile-discovery
fields are removed from unregistered capabilities, so copied profile DTO fields
cannot imply registered enforcement. This requires server
code authority; it is not a user-configurable bypass or a UI setting.

## Veo lifecycle policy

The official Gemini table checked 2026-10-10 lists 2026-10-22 as the earliest
shutdown date for this exact preview. Mioon shows a dated warning now and blocks
new plans/submissions on or after that UTC date until the profile is deliberately
revalidated. This is an application policy, not a guarantee that Google shuts
the endpoint down that day. No replacement model is selected automatically.
Historical replay and accepted-task recovery remain available. [Official
deprecations](https://ai.google.dev/gemini-api/docs/deprecations).

## Properties UI and verification

The existing right-Properties provider controls contain an extracted compact
summary with exact model/API region and expandable per-role limits. Disclosure
callbacks are fenced across selection changes, hidden workspaces and unmount.
Existing draft, project, source, Agent and generation approval behavior remains.
Viewing profiles causes no probe or network generation.

Required release evidence: pure profile versus all six actual adapter validators;
old submit schema/error parity; unknown model/region/metadata rejection; immutable
historical replay/retry; copied/wrapped registry and worker restart; deferred
image/date/scope/abort races; uncertain-after-POST behavior; actual HTTP/CLI/MCP
discovery and local rejection; focused renderer visibility tests; fresh web and
desktop builds; isolated Linux native invalid-input then valid Mock generation.
Live output, billing, account eligibility and native Mac/Windows remain unverified.
Evidence is retained under ignored `evidence/generation-input-limits/`.

Native acceptance verified invalid-duration blocking without business
writes, stable expanded details through polling, keyboard/tab behavior and
draft retention, the dated Veo warning, and one explicit Mock generation. Its
single mock-ledger submit/task produced a 2-second 360×640 video that passed
actual FFmpeg decoding. Existing audited job/version/timeline/export rows and
original managed media hashes remained unchanged. The first parent full gate
found two metadata-only initialization regressions; both original forbidden-provider
tests remain unchanged and now pass after identity-only registration. Final serial
compatibility checks passed 436/436 after the correction, alongside the broad
546/546 metadata/service run. A fresh build retained identical renderer/main hashes
and rebuilt the backend. One additional native Mock job produced a decoded
2-second video while every previous audited row (including the selected shot
version) and managed file stayed unchanged. All three native app lifetimes
closed normally with exit 0. The parent independent final aggregate passed
2507 tests total: 2505 passed, 0 failed and 2 skipped, exit 0
(507184.231269 ms). The original failed aggregate remains preserved. Pre-fix disclosure screenshots, superseded build
and affected-test evidence, and evidence-helper errors are retained. No source
code was changed to accommodate evidence-helper mistakes.

Official background, separately from implemented limits: [Runway inputs](https://docs.dev.runwayml.com/assets/inputs/),
[Runway OpenAPI](https://docs.dev.runwayml.com/openapi.json),
[Ark model](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh),
[Gemini video](https://ai.google.dev/gemini-api/docs/veo?hl=en),
[MiniMax V2](https://platform.minimax.io/docs/api-reference/video-generation-v2-create),
[Vidu image route](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/image-to-video).
