# Video provider adapters

## UI-configured provider connections (2026-10-20)

Open **Settings → Model services** to add named connections for Ark Seedance,
Google Veo, MiniMax, Vidu, Kling and Alibaba Wan. Each connection has
its own regional credentials and model directory. The application derives API
addresses from official region templates. The one exception is a **compatible
service** (below), which names its own https base URL; executable provider
scripts are not supported. Wan also accepts an official workspace ID. Multiple
accounts of the same provider remain separate.

Runway is omitted from the UI's connection and generation choices. Its stored
configuration and adapter remain readable for historical task recovery; removing
it from the choices does not delete data or silently switch an existing selection.

Add or edit a model's request ID, label, protocol template, input modes, ratios,
duration/resolution combinations, audio policy and seed support. These are bounded
by the implemented template, not a declaration that every vendor model is
compatible. Custom entries remain **not live verified**. The directory is managed
manually; saving does not discover models, probe accounts or generate media.
Kling initially uses the current API-Key protocol with `kling-3.0`. New Wan
connections offer `wan3.0-video` and `wan3.0-video-prime`; existing Wan 2.7
connections and their text/first-frame templates remain unchanged. Reference
video/audio and arbitrary workflow import are outside this increment. Existing
Ark frame-pair and one-image subject modes are retained.

### Seedance 2.5 connections (reviewed 2026-10-30)

A UI-configured Ark connection whose model entry is exactly
`doubao-seedance-2-5-260628` on the `ark-v3` template in `cn-beijing` uses the
wider Seedance 2.5 range. Other Ark model IDs, including custom entries on the
same template, keep shot-only duration and ratio.

- **Duration:** 4–30 seconds, or automatic (`-1`, the model chooses within that
  range). Shots still store at most 20 seconds, so the generation duration is a
  request parameter, `parameters.durationSeconds`, frozen with the task. When it is
  omitted the generation uses the shot duration. The shot is never rewritten.
- **Ratio:** 9:16, 16:9, 1:1, 3:4, 4:3 or 21:9, or adaptive, through
  `parameters.aspectRatio`; omitted means the shot ratio. First/last-frame tasks
  always send `ratio: adaptive`, as Ark requires, and the output follows the first
  frame. With a fixed ratio both frames must still match it exactly; with adaptive
  they only need Ark's 0.4–2.5 width/height range.
- **Resolution:** 480p and 720p (8-bit) or 1080p. Ark returns 1080p as 10-bit
  H.265/HEVC. Such results can be placed on the timeline and exported, but frame
  capture, cut detection and breakdown accept only 8-bit H.264/VP8/VP9, and some
  environments cannot preview HEVC.
- **Sound:** new model entries use the `optional` audio policy, so each generation
  can turn `generateAudio` on. It stays off unless chosen, although Ark's own
  default is on. Entries saved with `off` remain silent.
- **Prompt:** up to the shot field's 5000 characters. Ark sets no hard limit and
  recommends at most 500 Chinese characters or 1000 English words.
- **Output check:** the downloaded ratio must be within 2% of the requested one
  (Ark's 480p 21:9 size is 992×432) and the duration within 0.25 seconds of a fixed
  request, or 4–30 seconds for automatic. A mismatch pauses the task for review
  instead of publishing a version or resubmitting.

Connections saved before this change keep their earlier combinations (4 or 8
seconds, 720p, silent). Edit the model's duration/resolution combinations and
audio policy, or add a new connection, to use the wider range. The
environment-configured `ARK_API_KEY` adapter below is unchanged. Sources:
[create task API](https://ark.volcengine.com/region:cn-beijing/docs/create-video-generation-task-api),
[Seedance 2.5 guide](https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5).

### Official SDK coverage (reviewed 2026-10-23)

Video submission and task queries use the following pinned official Node.js
SDKs wherever they cover the application's existing protocol. The legacy
environment-configured Runway, Ark, Veo and MiniMax entry points use the same SDK bridges
as UI-configured connections; their separate credentials and enable/approval
gates remain in effect.

| Provider/protocol | Package and pinned version | Submission and query methods |
| --- | --- | --- |
| Runway | `@runwayml/sdk@4.22.0` | `imageToVideo.create()`, `tasks.retrieve()` |
| Ark Seedance | `@volcengine/ark-runtime@1.0.12` | `createContentGenerationTask()`, `getContentGenerationTask()` |
| Gemini Veo | `@google/genai@2.30.0` | `models.generateVideos()`, `operations.getVideosOperation()` |
| MiniMax H3 | `mmx-cli@1.0.28`, public `mmx-cli/sdk` entry point | `video.generate({async: true})`, `video.getTask()` |
| OpenAI-compatible Videos | Existing `openai@7.39.0` dependency | `videos.create()`, `videos.retrieve()` |
| Alibaba Wan | Existing `dashscope-sdk-official@1.27.0` dependency | `VideoSynthesis.asyncCall()`, `fetch()` |

Version review uses the published package source and type declarations, rather
than assuming a package named after a vendor is official. Sources:
[Runway package](https://registry.npmjs.org/@runwayml/sdk/4.22.0) and
[official SDK repository](https://github.com/runwayml/sdk-node),
[Ark package and publisher](https://registry.npmjs.org/@volcengine/ark-runtime/1.0.12),
[Google package](https://registry.npmjs.org/@google/genai/2.30.0) and
[official SDK repository](https://github.com/googleapis/js-genai),
[MiniMax package](https://registry.npmjs.org/mmx-cli/1.0.28) and
[official SDK guide](https://github.com/MiniMax-AI/cli/blob/main/SDK.md),
[OpenAI package](https://registry.npmjs.org/openai/7.39.0) and
[official SDK repository](https://github.com/openai/openai-node), and
[DashScope official implementation](https://github.com/dashscope/dashscope-sdk-nodejs/blob/v1.27.0/src/aigc/videoSynthesis/index.ts).
Google's package is pinned to 2.30.0 to satisfy this repository's minimum release
age policy; the newer package available on the review date is not installed.

The SDKs construct protocol paths, parameters and serialization. New MiniMax
submissions now require the official SDK's `2K` resolution; the existing 4/8-second
duration choices and text/first-frame modes remain unchanged. Other providers'
model capabilities, accepted parameters and defaults are unchanged. Public
interfaces and persisted snapshots are not expanded. Custom model IDs remain bounded by their
selected protocol template. Existing task identities, original connection and
credential bindings, response interpretation and historical snapshots remain
valid without migration. SDK automatic retries are disabled; the new bridges
also permit at most one transport dispatch per operation. Lost, timed-out or
otherwise uncertain submissions retain their existing unknown-acceptance state
and never trigger a hidden generation retry.

The application retains the final submit fence, credential acquisition, bounded
timeouts, cancellation, sanitized errors, redirect restrictions, polling,
recovery and safe output download/publication. SDK blocking wait, SDK-managed
file writes and remote-cancel helpers are not used. Cancellation retains each
provider's existing local-only behavior. Only injected offline transport tests
have been performed; no paid generation or live-service verification is implied.

Desktop notices collect the SDK packages' supplied licenses. `mmx-cli@1.0.28`
declares MIT in its published README but omits the LICENSE text and manifest
license field; the desktop package records that upstream declaration and
omission in a provenance notice, without fabricating a license text.

#### Compatible auxiliary requests (2026-10-26)

Compatible connection checks now use the same pinned OpenAI SDK's
`models.list().asResponse()`. They inspect only the original HTTP status, without
parsing model metadata or following pagination. The application's existing
reachable/authentication/rate-limit status mapping is preserved.

The first authenticated compatible video content request is assembled by
`videos.downloadContent()`. A separate single-request bridge retains the real
HTTP response for the host downloader; the SDK sees only a synthetic successful
response and cannot interpret errors, consume media or follow redirects. The
destination is checked before the request, and all later redirects are handled
by the host with authentication permanently removed, including a return to the
original host. Size/MP4 validation, partial-file cleanup, fsync and atomic
publication remain host responsibilities. Veo file downloads and CDN downloads
continue to use the host transport. No video submission/query behavior,
historical task binding, public contract or stored snapshot changes here.

MiniMax uses its official TypeScript SDK without a REST fallback. The reviewed
SDK rejects H3 resolutions other than `2K`, and that validator remains active.
It accepts only the exact `MiniMax-H3` model ID for new generation. Unsupported
custom IDs fail generation preflight before creating or dispatching a job;
historical custom-model bindings remain readable for task queries and downloads.
New MiniMax model entries and the legacy environment entry point use `2K`.
Existing `768P` configurations, original task bindings and snapshots are not
rewritten or silently upgraded: new submissions through those configurations
are rejected before dispatch, while accepted tasks retain their original
identities and can still be queried and safely downloaded. To generate at `2K`,
explicitly review and save a supported model configuration. See the
[official SDK validator](https://github.com/MiniMax-AI/cli/blob/main/src/video/v2.ts)
and [service video capabilities](https://platform.minimax.io/docs/guides/video-generation).

Only Vidu and Kling retain their current REST implementations:

- **Vidu:** no official Node SDK covering the current Q3 asynchronous video API
  was identified in the [official API documentation](https://docs.platform.vidu.com/)
  or [integration help](https://platform.vidu.com/help-center). Official MCP and
  Vidu S real-time RTC examples implement other integration paths and do not
  replace this protocol.
- **Kling:** no official Node SDK covering the current API-Key video protocol
  was identified in the [official API documentation](https://kling.ai/document-api).
  The [official CLI/MCP client](https://kling.ai/app/mcp/guide) uses a different
  account-login integration; callback signature examples are not a video API
  SDK. Community packages are not substituted for an official SDK.

### Wan official SDK and reviewed model capabilities (2026-10-23)

Wan submission and task retrieval use the pinned official Node.js package
`dashscope-sdk-official@1.27.0`, through `VideoSynthesis.asyncCall()` and `fetch()`.
The SDK builds the request body and service route; its protected request seam
uses Mioon's transport for the final dispatch fence, cancellation, 30-second
timeout, credential acquisition, redirect rejection and sanitized errors. The
SDK's blocking `call()`/wait loop is not used. Accepted or uncertain tasks are
never automatically submitted again. Output downloads retain the shared exact
host policy, unauthenticated CDN requests and decoded-media publication checks.

The exact model/region/protocol capability table is maintained in
`packages/contracts/src/wan-video.ts`, with official source and review date.
SDK model metadata describes modalities but does not supply the complete video
parameter limits. The same reviewed table drives the UI, connection discovery,
CLI/MCP schemas and backend validation. A custom model ID cannot gain Wan 3.0
features merely by resembling an official name. Protocol fixtures remain
**offline-tested, not live verified**.

Wan 3.0 supports text, one first frame, an ordered first/last-frame pair, or
1–10 ordered reference images. Frames cannot be mixed with reference images.
All image bytes come from project-owned managed assets and are sent as Base64
data URIs. Implemented imports are PNG/JPEG/WebP, at most 20,000,000 bytes per
image, sides 240–8000 pixels, at most an 8:1 aspect ratio, and no transparency.
BMP import, remote URLs, uploads/OSS, reference video/audio, documents, webpages,
video editing and extension are not implemented.

For the reviewed Wan 3.0 models, controls include 480P/720P/1080P, fixed 2–30
seconds or intelligent duration, six fixed aspect ratios or adaptive output,
audio, seed, prompt rewriting and watermark. Defaults for new selections are
720P, five seconds, audio on, prompt rewriting on and watermark off. These
generation options do not rewrite the shot's saved duration or aspect ratio.
The backend fills omitted options for every new Wan 3.0 request and freezes
them in its task snapshot, using the same defaults as Web, CLI and MCP. Narrowed
model configurations use their first available duration/resolution when the
preferred default is unavailable. Historical tasks and their explicit retries
retain their original snapshots and parameter interpretation.
Adaptive results retain their actual decoded dimensions and duration; fixed
requests retain output review checks. Original Wan 2.7 behavior remains bounded
by its original templates.

`generation.submit` optionally accepts a versioned `videoInput` for Wan 3.0:

```json
{
  "videoInput": {
    "version": 1,
    "mode": "reference_images",
    "images": [{ "role": "reference_image", "assetId": "<project asset UUID>" }],
    "prompt": "图1中的人物在草地上散步。"
  },
  "parameters": {
    "durationSeconds": 5,
    "aspectRatio": "16:9",
    "resolution": "720P",
    "generateAudio": true,
    "promptExtend": true,
    "watermark": false
  }
}
```

Modes are `text`, `first_frame`, `first_last_frame`, and `reference_images`.
The explicit input replaces saved frame choices for this generation only; it
does not merge with them or with subject reference. Omission keeps the legacy
input path. Selection order, asset identities/hashes, optional prompt (up to
20,000 code units), parameters and original connection are frozen into the
existing job snapshot. Explicit retry retains that snapshot. Intelligent
duration uses `durationSeconds: -1`; adaptive output uses `aspectRatio:
"adaptive"`. No new SQL table or migration is required.

Enter the API key, choose its storage scope and explicitly enable the connection.
The workspace **Real generation** switch must also be enabled in Model services.
It is checked again immediately before dispatch; disabling it prevents new paid
submissions and explicit retries, while accepted tasks can still be observed and
downloaded with their original binding.
Web keys last for the backend lifetime. Desktop can use the existing supported OS
encrypted storage; unavailable secure storage has no plaintext fallback. Settings
reads disclose only configuration and storage status. Video keys are isolated from
Agent and Images credentials and never enter jobs, versions, logs or backups.
For Vidu, Kling and Wan, configure independently reviewed exact output hostnames
under Advanced before submitting; no output host is inferred from a generation
response. Existing providers retain their existing default output-host policy.

The generation panel selects an explicit connection and directory entry. The
existing paid-generation confirmation reviews the selected destination, model,
parameters and references. This confirmation authorizes the frozen managed image
hashes for that task, so UI connections do not need the legacy environment flags
or hash lists. Actual bytes, ownership, MIME type, dimensions, hashes and output
media continue to be checked. Configuration alone grants no generation request.

Every accepted task pins its connection revision, protocol/model configuration,
region, endpoint and an opaque credential reference. Editing, disabling or
archiving a connection never retargets an existing task. Removed/session-expired
credentials pause the task; explicitly restore the corresponding historical
credential to resume. Replacing the current key does not silently change old
tasks. Recovery also supports the current missing reference and, with explicit
session storage and re-entered credentials, an unavailable OS store. Recovering a
credential preserves unsaved connection/model edits for a separate save. Each
download request and redirect rechecks the task's original credential binding.
Unknown acceptance is never resubmitted, and download recovery does not
create another paid task. Kling can reconcile an existing external request ID;
an empty lookup still does not authorize a POST. Successful outputs use the
existing decode checks, asset publication and immutable version transaction.

Connection configuration and encrypted credentials live in the private
`video-settings/settings.json` sidecar, excluded from business backups. No SQL
tables or historical schema constructors change. Restored/candidate workspaces
cannot configure or execute these connections. The five environment-configured
adapters remain independent: old requests and jobs never acquire a UI connection.

Private management uses `GET/PUT /api/video-providers/settings`, with
`expectedRevision` on writes. Read-only `video.connection.list` returns safe
connection/model capabilities; `provider.list` retains its previous response.
New generation submissions supply `connectionId`, `configurationRevision` and
`modelEntryId` together, optionally selecting supported `resolution` and
`generateAudio` parameters. The shared CLI/MCP schemas can read the directory and
select an existing connection; configuration management is available only through
the private UI route and never exposes credentials to these tools or the Agent.

An unreadable or invalid video directory disables its configured connections and
shows a persistent status notice; project loading, local editing and legacy
environment providers remain available. Refreshing after recovery clears the
notice. Authentication failures still invalidate the session.

## Compatible services, OpenAI video format (2026-10-23)

Choose **Compatible service (OpenAI video format)** when adding a connection to use
a service or aggregator that implements the OpenAI Videos API shape, using
protocol template `openai-video-v1`.

Submission and status queries use the official `openai@7.39.0` SDK with the
connection's frozen base URL. The SDK creates the multipart request and first-
frame file; the application still controls result downloads and all network
boundaries below. Reusing this SDK does not certify an aggregator's model
availability or compatibility beyond the implemented template.

The preserved protocol is:

- create: `POST {base}/videos`, `multipart/form-data` with `model`, `prompt`,
  `seconds` and `size` (`WIDTHxHEIGHT`, derived from the aspect ratio and the
  short-edge resolution, e.g. 9:16 at 720p is `720x1280`), plus the optional first
  frame as `input_reference`;
- status: `GET {base}/videos/{id}`; `queued`/`in_progress` are running,
  `completed` succeeded, `failed`/`cancelled` failed, `progress` is 0-100;
- result: `GET {base}/videos/{id}/content` with the key. A redirect may only reach
  a declared output host, and authentication is dropped on every redirect.

Base URL and key:
- The base URL must be https with a DNS host name and a plain path: no IP literal,
  port, query, fragment or account part. It is saved normalized (lower-case host,
  no trailing slash).
- The key is bound to that exact base URL. Changing the base URL requires entering
  a new key; the old key is never sent to the new address.
- The service host is always an allowed output host. Other CDN hosts must be added
  under **Other result hosts**.

Network:
- Every request to the service and to its result hosts goes through a pinned
  transport. DNS answers must all be public addresses. The socket is pinned to the
  checked address and TLS is verified for the original host name.
- Nothing is written until the pinned peer is confirmed. There is no proxy,
  environment variable, pooled agent or automatic redirect.
- A request that provably never left the process fails plainly (it can be retried
  by hand without a duplicate charge). An ambiguous submission still becomes
  "submission unknown" and is never resubmitted automatically.

**Test connection** (`POST /api/video-providers/compatible-check`, private route
like the settings route):
- It reads `GET {base}/models` with either the typed draft key (sent only to the
  typed base URL) or the saved key of the current revision (sent only to the base
  URL it was saved with).
- It never creates a video, never follows a redirect and returns only an outcome:
  `ok`, `unauthorized`, `unsupported` (no model list), `http_error`, `denied`
  (private or local address) or `unreachable`, plus the HTTP status.

Limits of this increment:
- Text-to-video and first-frame only.
- No audio switch: the service decides.
- No remote cancellation or reconciliation.
- Platform presets that adjust paths and fields for specific aggregators are
  **not implemented yet**. Each needs a real-account check before it is offered.
- Like the other UI protocols, the template is offline tested, not live verified.

The notes below describe the original environment-configured adapter baseline;
their enable flags and image approval lists still apply to that legacy path.
The supported UI protocols remain offline tested rather than real-account verified.

Implementation and official documentation checked 2026-10-09. No live generation, external reference upload, account mutation, paid call, or remote cancellation has been performed for any real provider. Live verification remains **pending separate authorization**. Passing injected-HTTP tests does not establish account eligibility, real provider availability, output quality, price, or end-to-end generation.

The production registry now publishes and enforces [exact model input limits](GENERATION-INPUT-LIMITS.md), including the dated Veo lifecycle policy. These implemented app profiles do not enable broader vendor reference modes.

## Separate image profiles

Images remain independent of the video registry. `image.profile.list` returns
local Mock `mock-image-v1`, the fixed OpenAI `gpt-image-2.5-flare-2026-09-08`
preset, and the custom `openai-compatible` profile when its base URL/model are
complete. All use fixed 1024×1024, low quality, opaque PNG, one result. Mock creates
deterministic visibly labeled local bytes and is not prompt-conditioned. At the accepted first-slice checkpoint `82c70f3` on
2026-10-10, OpenAI was hard-disabled and had only injected offline fixtures;
that dated evidence is preserved in [Image generation](IMAGE-GENERATION.md).

The accepted 2026-10-10 checkpoint `4e66a96` implemented dedicated OpenAI Images
settings/credentials, retained exact request reviews and explicit UI-approved one-POST dispatch to
`https://api.openai.com/v1/images/generations`. The preset model/options are
unchanged. The 461-test affected gate, fresh builds and Linux native
synthetic-network acceptance passed; the independent final full suite passed
(2758 total, 2756 passed, 0 failed, 2 skipped). No real provider call is authorized for this acceptance, and neither
macOS/Windows nor live-provider acceptance is established. The evidence label stays
`offline-tested-not-live`; local configured/enabled status is not model access,
pricing or output certification.

Web secrets are session-only for the backend lifetime. Electron supports
explicit OS-encrypted persistence through a narrow Images-only main-process
codec, without renderer/preload decryption or plaintext fallback. Agent/video
keys and environment flags cannot enable Images. Saving settings grants no
request approval. Each visible paid-generation/review button confirms the exact
project, prompt, selected model/fixed options and destination for at most one POST at
unknown usage-based cost; the bound is not a currency cap. Settings/approve/reject
are private authenticated UI routes, not CLI/MCP/model tools. Public review
prepare/get/list cannot approve or dispatch.

The current [custom Images increment](IMAGE-COMPATIBLE.md) is implemented,
with focused/build/Linux synthetic-native and independent full-suite acceptance
(2857 total, 2855 passed, 0 failed, 2 skipped). Its independent `custom` slot uses profile
`openai-images-json-png-v1`, private `/api/images/custom-settings`, a canonical
public-DNS HTTPS:443 base URL and a configured ASCII model (1–120 characters).
It reuses the exact fixed body, including `moderation:"auto"`, and strict single
`b64_json` PNG decoder. There is no response URL download, model negotiation,
fallback, local ComfyUI or all-vendor compatibility claim. Saving does not probe.
Base URL/model changes with a key require explicit removal or new key input;
the official preset/key are unaffected. Earlier activation tests are not this
custom gate. Official model and Images request docs were rechecked
2026-10-10: [model and pinned snapshot](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare),
[Images generation fields](https://developers.openai.com/api/reference/resources/images/methods/generate).
This source review does not establish account eligibility, actual charges or live
output. A live canary still requires one separate exact configuration/prompt/media/
fees approval. Image reads, review preparation/replay and startup do not submit;
explicit result recovery only publishes existing task-bound local staged bytes.
See [Images activation](IMAGE-ACTIVATION.md) for the dispatch fence, secret boundary,
official review contracts and historical schema-17 evidence; [custom Images](IMAGE-COMPATIBLE.md)
describes custom v2 provenance, the narrow schema-18 migration and exact acceptance.

## Shared behavior

Factories are `createMockProvider({ db, root })`, `createRunwayProvider({ root })`, `createArkProvider({ root })`, `createVeoProvider({ root })`, `createMinimaxProvider({ root })`, and `createViduProvider({ root })`. All implement the adapter interface in `CONTRACT.md`, including synchronous `validate(snapshot)` with no network and no dependency on resolved local paths. Submission independently validates actual managed reference bytes. `root` is the managed application data root, not a user-selected upload path. Adapters return **fractional progress from 0 to 1**; the job/UI layer converts it to a percentage.

A successful submit returns `{ providerJobId }`. An error tagged `uncertain: true` means acceptance cannot be excluded. Persist that state and reconcile; do not submit again. A `null` reconciliation result never authorizes resubmission. Known task IDs can be polled and downloaded repeatedly without another generation POST. Snapshots and references belong to the application; no secret is copied into them.

### Implemented model subsets

These are deliberately smaller than the providers' full catalogs. The UI and service use per-model `modelCapabilities`; legacy `models`, `inputModes`, `aspectRatios`, and `durations` remain available. Configuration exposes only names/reasons, never values. `available` means local configuration permits a request; it is not a live-verified claim.

| Provider ID | Exact model | Inputs | Implemented ratios | Seconds | Resolution |
| --- | --- | --- | --- | --- | --- |
| mock | mock-motion-v1 | Text / simulated image workflow | 9:16 | 2, 4, 8 | 360×640 |
| runway | gen4_turbo | One first-frame image | See Runway below | Integer 2–10 | Ratio-dependent |
| ark | doubao-seedance-2-5-260628 | Text / one first-frame image | 9:16, 16:9 | 4, 8 | 720p |
| veo | veo-3.1-generate-preview | Text / one first-frame image | 9:16, 16:9 | 4, 6, 8 | 720p |
| minimax | MiniMax-H3 | Text / one first-frame image | 9:16, 16:9 | 4, 8 | 2K for new submissions; historical 768P tasks remain readable |
| vidu | viduq3-turbo | Text / one first-frame image | 9:16, 16:9 | 4, 8 | 720p |

New adapters deliberately accept PNG/JPEG only, at most one image, and a nonblank prompt of at most 1000 UTF-16 code units. That prompt cap is a conservative application limit, not a claim about the provider's full limit. They expose no seed, arbitrary URL, reference-video, first/last-frame pair, audio option, webhook, batch count, or other advanced parameter. Resolution is fixed per adapter. Veo audio is always on; Ark/Vidu explicitly disable it. MiniMax uses the selected model's default audio behavior.

### Required server settings

Every real provider needs `MIOON_ENABLE_LIVE_PROVIDER=1` and the corresponding server key. Image input also requires approved reference hashes; output-host and regional checks remain enforced. Installing the app or having a ChatGPT plan does not enable live calls.

| ID | Credential name | Approved-image checksum list | Additional settings |
| --- | --- | --- | --- |
| runway | RUNWAYML_API_SECRET | RUNWAY_APPROVED_ASSET_SHA256 | RUNWAY_OUTPUT_HOSTS |
| ark | ARK_API_KEY | ARK_APPROVED_ASSET_SHA256 | ARK_OUTPUT_HOSTS |
| veo | GEMINI_API_KEY | VEO_APPROVED_ASSET_SHA256 | VEO_OUTPUT_HOSTS |
| minimax | MINIMAX_API_KEY | MINIMAX_APPROVED_ASSET_SHA256 | MINIMAX_OUTPUT_HOSTS; MINIMAX_REGION=global or cn |
| vidu | VIDU_API_KEY | VIDU_APPROVED_ASSET_SHA256 | VIDU_OUTPUT_HOSTS required; VIDU_REGION=global or cn |

`*_APPROVED_ASSET_SHA256` is a comma-separated list of exact reviewed image hashes; text-only generation does not need an image approval. `*_OUTPUT_HOSTS` contains exact independently verified output CDN hostnames, never URLs, wildcard suffixes or hosts copied blindly from a provider response. Vidu has no verified default output CDN and stays unconfigured until its output host list is supplied. MiniMax/Vidu region defaults to `global`; keys must belong to that selected regional account. Invalid region settings fail closed. API origins cannot be overridden by request input or arbitrary environment URLs.

The application does not impose a generation-count limit. Legacy count environment settings are ignored and are no longer forwarded to the desktop backend. Capability discovery returns no generation-count budget fields. This does not provide an account credit or currency-spending limit; verify billing and any spending controls with the provider.

### Shared live-adapter safeguards

`live-common.ts` provides fixed-origin authenticated transport, approved local image reads, PNG/JPEG byte/dimension parsing, ten-second success/error/in-flight polling cache, and atomic MP4 downloads for Ark, Veo, MiniMax and Vidu. Ark, Veo and MiniMax use official SDK protocol builders over that transport; Vidu retains its REST implementation. SDK automatic retries are disabled, and no hidden POST retry wrapper is used. Network loss, abort, HTTP 408/5xx, redirects/conflict, unreadable JSON, and successful create responses without valid task identities remain uncertain. Explicit request/auth/billing/quota rejection HTTP codes are failed safely. Provider bodies, failure reasons, signed URLs and credentials are not returned to clients. Known-task GET failures never authorize a new generation.

Only managed files resolving beneath `root` are read; checksum approval is checked before reading, actual checksum/signature/dimensions before transmission. Inputs are locally limited to 10 MiB for Ark/Veo/MiniMax and less than 10,000,000 bytes for Vidu. There is no standalone upload POST. Reference asset URLs are never fetched.

Downloads are private temporary files followed by atomic rename, with an HTTPS exact-host check, no URL credentials/non-default ports, a 128 MiB streamed size limit, and MP4 `ftyp` verification. The service subsequently probes/decodes the result before publication. Output path checks reject symlinks escaping managed storage before creating directories. CDN requests receive no provider authentication. Failed downloads clear the task cache so the next attempt can GET a fresh output URL without another create POST. Ark/MiniMax/Vidu reject redirects. Veo supports at most three explicitly allowlisted redirects, stripping credentials after the first response, including same-origin hops.

## Durable simulated provider

Mock creates independent provider-ledger tables in the supplied Node 24 SQLite database:

- `mock_provider_tasks`: remote task identity, request ID, canonical immutable snapshot/checksum, scenario, ready time, poll count, download attempts, cancellation state
- `mock_provider_submissions`: every adapter submission invocation, its outcome, request ID and provider task ID

`provider.stats(requestId?)` returns `submissionCount`, `taskCount`, `downloadAttempts`, and `pollCount`. Inspecting task count alone would hide duplicate submit attempts; acceptance tests should inspect submission count too. Reusing an identical request ID returns the same mock task but adds a detectable submission audit row. Reusing it with different snapshot content fails.

`accepted_then_response_lost` durably writes the task and audit row before throwing an uncertain error. Closing/reopening SQLite and reconciling the request ID recovers the same task. No resubmission is needed. Savepoints protect ledger updates. Call adapters outside an uncommitted application transaction so their ledger commits are durable before handling the result.

Scenarios:

| Scenario | Result |
| --- | --- |
| `success` | Runs briefly, then succeeds |
| `delay` | Succeeds after `delayMs`; default 2 seconds |
| `failure`, `terminal_failure` | Definitive failed remote task |
| `reject`, `rejected_before_accept` | Definitive submission rejection, no remote task |
| `timeout`, `poll_timeout_then_recover` | First two polls fail transiently; third poll resumes the same task |
| `unknown` | Unresolved submission with no discoverable task; never automatically retry |
| `accepted_then_response_lost` | Durable remote acceptance followed by a lost response; reconcile by request ID |
| `download_fail_once` | First download fails; subsequent download of the same task succeeds |

`delayMs` is bounded to 0–120000ms. Mock supports 9:16 and 2/4/8 seconds. It produces a moving 360×640, 24fps H.264/yuv420p MP4 using local FFmpeg with an argument array and no shell. A permanent on-frame SIMULATED MOCK label and file metadata identify the result. The moving test pattern is a workflow simulation; it does not depict the prompt or image. No external provider is contacted. Cancellation can positively confirm a running mock task was cancelled; completed outputs are preserved.

## Runway implementation

The adapter targets `gen4_turbo`, using `POST /v1/image_to_video`, then `GET /v1/tasks/{id}`. It maps UI 9:16 to provider `720:1280`, accepts one first-frame image and optional unsigned 32-bit `seed`, and validates duration as an integer 2–10 seconds. Other supported adapter ratio labels map to the provider's documented resolutions. The current machine-readable OpenAPI is the source of truth; older Runway billing documentation still describes 5/10-second choices. [Official OpenAPI](https://docs.dev.runwayml.com/openapi.json)

The official `@runwayml/sdk@4.22.0` builds create and task-query requests using the fixed `https://api.dev.runwayml.com` origin, Bearer authentication and `X-Runway-Version: 2024-11-06`. There is no configurable request-supplied API base, automatic POST retry, or undocumented idempotency header; SDK retries are explicitly disabled. [Official getting-started guide](https://docs.dev.runwayml.com/guides/using-the-api/)

`PENDING`, `THROTTLED`, and `RUNNING` map to running. `SUCCEEDED`, `FAILED`, and `CANCELLED` map to their application outcomes. Status reads are cached for five seconds. No documented create-request-ID lookup is assumed; `reconcile(requestId)` returns null and a missing provider ID remains unresolved. Raw provider error bodies and failure text are not returned to clients. [Official task interface](https://github.com/runwayml/sdk-node/blob/main/src/resources/tasks.ts)

### Server-only safety configuration

Live calls require all applicable gates, configured only after separate user authorization:

1. `MIOON_ENABLE_LIVE_PROVIDER=1`
2. `RUNWAYML_API_SECRET` supplied to the server environment through a secure credential route
3. `RUNWAY_APPROVED_ASSET_SHA256`: comma-separated hashes of the exact approved synthetic reference files
4. Independently verified output hosts and the separately agreed scope and cost of the live call; the application has no generation-count or currency-spending cap

The provider never reads credentials from browser input, project JSON or a URL. Construction, capability listing, reconciliation of an unknown request, and local-only cancellation make no network calls. A credential alone does not enable live calls. Capability `configured` reports presence only; `enabled` reflects the explicit enable switch and key, while per-reference approval is still mandatory.

Only managed local reference files are read. The adapter resolves symlinks beneath `root`, checks the snapshot checksum, accepts PNG/JPEG/WebP signatures, and sends an inline data URI to Runway. Arbitrary source URLs, GIFs and additional references are rejected. Encoded data URI length is capped at 5 MiB; large files fail before transmission. There is no separate upload POST. [Official input requirements](https://docs.dev.runwayml.com/assets/inputs/)

### Download and cancellation boundaries

Successful task output URLs are ephemeral; Runway recommends retrieving fresh URLs and saving outputs into application storage. The adapter downloads to a private temporary file, checks MP4 container bytes and atomically renames it. The backend additionally probes and decodes before publishing a version. Failed/expired downloads invalidate the cached task response so a later attempt fetches a fresh URL. [Official output requirements](https://docs.dev.runwayml.com/assets/outputs/)

Output downloads never receive the API authorization header. HTTPS, no credentials/ports, no redirects, a 128 MiB limit and an exact server-side hostname allowlist protect the download boundary. The default hostname is the CDN shown in the official example, `dnznrvs05pmza.cloudfront.net`. If a future task returns another CDN, verify it and configure `RUNWAY_OUTPUT_HOSTS`; the adapter fails closed until then. No signed URL is exposed in adapter results.

Remote cancellation is intentionally unavailable. Runway's task DELETE endpoint also permanently deletes finished tasks and their outputs. A preliminary GET cannot eliminate the completion race. `cancel()` therefore reports `remoteCancelled: false` and `scope: local` without sending DELETE. Remote work and charges may continue after local waiting stops. The UI must preserve that warning. [Official cancellation semantics](https://github.com/runwayml/sdk-node/blob/main/src/resources/tasks.ts)

## Offline verification and next real check

Run `node --test tests/providers.test.ts tests/providers-v4.test.ts tests/providers-additional.test.ts`. Tests use Node's built-in test runner and injected fetch responses; no real network request is made. Coverage includes:

- SQLite restart recovery after accepted-then-response-lost
- Submission-attempt counts, duplicate detection and request-content conflict
- Recoverable polling/download failures and unresolvable unknown outcomes
- FFprobe codec/dimensions/duration plus decoded frame hashes proving all mock durations actually move
- Request body/header mapping, capability validation and one POST on every tested failure path
- No credential/raw-error disclosure; reference approval/checksum/path/size/type checks
- Five-second poll caching, all task statuses, safe output hosts and partial-file cleanup
- Expired-link refresh without generation resubmission; local-only cancellation without DELETE
- Ark/Veo/MiniMax/Vidu text/first-frame request mapping, model metadata and preflight validation
- Regional fixed-origin selection and missing-configuration behavior, including Vidu's mandatory reviewed output host
- New adapter status caches covering transient errors/concurrent polls, typed terminal/safety-filter outcomes
- Veo authenticated fixed file route, key stripping across approved redirects, and three-hop redirect bound
- Actual playable H.264 fixtures, signed-URL refresh, decoded image dimensions and output symlink rejection

A9 remains pending. An authorized real smoke test should use one reviewed synthetic image, its approved checksum, an explicit total spending limit and bounded generation count. Submit once, retain the task ID durably, poll to terminal state, download/probe/decode, and confirm provider model, duration, dimensions and result provenance. Do not use mock success or offline contract tests as evidence of real generation. Unknown acceptance must remain paused for provider-account investigation.

## One bundled live-verification decision

Before any A9 run, confirm all of these together with the owner: Runway organization/account and `gen4_turbo` model; exact reference image scope (server-side SHA256 allowlist) and prompt; 9:16 duration; maximum generation count and total currency budget; secure local credential configuration method. Do not paste credentials into conversation. The application does not enforce a generation-count cap or guarantee a dollar price from account balance, and no budget/real-generation approval is implied by a Pro plan or the offline adapter tests.

The same bundled approval is required independently for each additional provider: exact account/region/model, text and optional reference-image scope, duration/ratio, maximum count and total currency budget, verified download hosts, and secure server credential configuration. No cross-provider fallback submission is automatic. If acceptance is unknown, stop and investigate the provider account rather than spending again.

## Ark Seedance 2.5

The mainland-China Ark adapter uses official `@volcengine/ark-runtime@1.0.12` against the fixed `https://ark.cn-beijing.volces.com/api/v3` origin with Bearer `ARK_API_KEY`, `POST /contents/generations/tasks`, and `GET /contents/generations/tasks/{id}`. The SDK receives the exact model, a text content item, optional inline PNG/JPEG `image_url` with `role: first_frame`, duration, `resolution: 720p`, `output_format: mp4` and `generate_audio: false`; its injected Axios transport keeps protocol serialization inside the SDK and dispatch inside the application. Text requests send the selected `ratio`. Image requests must send `ratio: adaptive`, so the adapter verifies both snapshot metadata and actual image bytes are 300–6000 pixels per side and exactly match the selected ratio. It does not silently stretch or crop the image. Existing explicit first/last-frame pairs and subject-reference mappings remain unchanged. [Official create API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh), [Seedance 2.5](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh).

`queued`/`running` map to running; `succeeded` to succeeded; `failed`/`cancelled`/`expired` to failed, with sanitized outcome codes. Output is `content.video_url`. Tasks are retained seven days; output links are documented as valid for 24 hours. Seedance 2.5 also documents a download-count limit, so successful downloads are stored locally. Default trusted example hosts are `ark-content-generation-cn-beijing.tos-cn-beijing.volces.com` and `ark-acg-cn-beijing.tos-cn-beijing.volces.com`; these are verified examples, not an exhaustive future CDN list. [Official task retrieval](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh).

No configurable seed is exposed: current create documentation restricts that request option to older model families, even though newer model responses may contain a seed. No undocumented request-ID lookup is inferred from task listing. `reconcile()` returns null; cancellation is local-only. [Official list API](https://docs.volcengine.com/docs/ark/list-video-generation-tasks-api?lang=zh).

## Gemini Veo 3.1 preview

This adapter targets the **Gemini Developer API**, not Vertex AI, using official `@google/genai@2.30.0`. It uses `GEMINI_API_KEY` in `x-goog-api-key` against `https://generativelanguage.googleapis.com/v1beta`. The SDK converts `models.generateVideos()` inputs into `POST /models/veo-3.1-generate-preview:predictLongRunning`; the body contains one `instances` element with prompt and optional `image: {bytesBase64Encoded, mimeType}`, plus `parameters: {aspectRatio, durationSeconds, resolution: 720p, sampleCount: 1}`. Inline bytes are raw base64, without a data-URI prefix. The complete returned `name` is persisted and queried through `operations.getVideosOperation()`. The bridge returns the raw transport response to the existing parser, preserving historical operation shapes even though the SDK's public result converter uses different field names. [Official Veo guide](https://ai.google.dev/gemini-api/docs/veo?hl=en), [official REST-field converter](https://raw.githubusercontent.com/googleapis/js-genai/main/src/converters/_models_converters.ts).

`done: false` or omitted means running. `done: true` plus `error` is terminal failure. Generated video is read from `response.generateVideoResponse.generatedSamples[0].video.uri`. A completed safety-filtered response with no samples is terminal filtered failure; empty completed output is terminal no-output. Raw safety reasons are not exposed. Videos have always-on audio, and documented retention is two days. No `seed`, `generateAudio` or regional `personGeneration` override is sent: Gemini and Vertex options differ, and the selected API's official converter rejects the seed/audio controls. Provider policy/account/region restrictions may still reject a request.

Authenticated media retrieval is limited to `https://generativelanguage.googleapis.com/v1beta/files/{id}:download?alt=media`. The route is reconstructed, matching the official downloader, instead of forwarding a key to arbitrary returned URLs or query strings. Additional direct CDN hosts and redirect destinations must be explicitly reviewed through `VEO_OUTPUT_HOSTS`. A redirect to an unknown host fails closed; a configured host never receives the key. The first key-bearing request uses only the exact official download route. [Official Node downloader](https://raw.githubusercontent.com/googleapis/js-genai/main/src/node/_node_downloader.ts).

There is no documented client request-ID reconciliation or guaranteed create idempotency in the reviewed API. Missing operation identity stays unresolved; local cancellation makes no remote request.

## MiniMax H3 V2

The adapter implements **MiniMax-H3 V2** through official `mmx-cli/sdk@1.0.28` (`mmx-cli@1.0.28`). `video.generate({async: true})` runs the SDK's parameter validation and returns immediately after creating the task; there is no REST fallback. `MINIMAX_REGION=global` uses `https://api.minimax.io`; `cn` uses `https://api.minimax.cn`, each with its corresponding account's Bearer key. The SDK builds `POST /v2/video_generation` with `model`, text/optional first-frame content items, the existing 4/8-second `duration`, `resolution: 2K` and `ratio`. It sends a data URI for approved images and `ratio: adaptive` for first-frame input, requiring actual image dimensions of 256–5760 per side and exact requested ratio. Text uses the selected ratio. Longer durations, last-frame inputs and unsupported seed settings remain outside this subset. [Official SDK guide](https://github.com/MiniMax-AI/cli/blob/main/SDK.md), [official V2 create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [China V2 create](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create).

`768P` remains present only in historical configurations, task bindings and snapshots. It is not silently replaced with `2K`: new submissions or retries retaining that old resolution fail before dispatch. Accepted historical tasks still use their original ID/credentials for queries and downloads, and their actual output resolution remains intact. The bridge instantiates the SDK only during an operation and replaces its derived CLI configuration before calling the protected request seam; local CLI credentials, OAuth and environment defaults cannot retarget a frozen task.

Create returns string `task_id`; SDK `video.getTask()` builds `GET /v2/query/video_generation/{task_id}`. The bridge preserves the original raw wrapper with `task.id`, `task.status` and successful `task.content.url` for existing parsers and historical recovery. Queued/running, succeeded, failed/cancelled map to the shared lifecycle. Query retention is seven days. Signed output URLs can expire; a failed download invalidates the cache for a fresh query. Official example output hosts `cdn.hailuoai.com` and `video-product.cdn.minimax.io` are trusted by default, with no Bearer header on downloads. [Official V2 query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query).

The `cn` region additionally permits the exact output bucket `algeng-video-infer.oss-cn-shanghai.aliyuncs.com`, reviewed from an authenticated SDK task query against the fixed `https://api.minimax.cn` origin on 2026-10-23. This is observed API evidence, not a claim that the static documentation lists that bucket. The configured and environment entry points share this regional policy; existing tasks retain their original snapshots and credential bindings. Other OSS buckets, subdomains and lookalike suffixes are not implicitly trusted. Rejected addresses disclose only protocol, hostname, port and whether user information was present, never signed paths, queries or user information. HTTPS, no URL credentials/non-default ports, unauthenticated CDN downloads and redirect rejection remain enforced.

Live verification on 2026-10-23 covered one CN H3 text-to-video request at `2K`, nominal 4 seconds and 9:16. The original task resumed after credential restoration and the host-policy update, with one submission and one published version; its snapshot and provider task identity stayed unchanged. The downloaded H.264/AAC video decoded fully at 1440×2560 with an actual duration of 4.459 seconds, retained as returned rather than trimmed. This verifies only that tested combination, not every input mode, region or model.

On 2026-10-24 (Asia/Taipei), an authorized Mio desktop workflow submitted exactly one additional request with the same CN H3 `2K`/4-second/9:16 combination. It completed and downloaded a second 1440×2560 H.264/AAC asset of 4.459 seconds without resubmission. Mio created nodes and edited both managed sources into a verified 8-second 1080×1920/30fps export; the original asset hash was unchanged. This adds one tested workflow, not coverage of other modes or regions. See [Mio protocol evidence and remaining issues](AGENT-PROVIDERS.md#minimax).

Cancellation stays local because the documented DELETE endpoint also deletes succeeded/failed records; a preceding status check cannot remove that race. V2 real HTTP errors are used instead of incorrectly treating the legacy V1 `base_resp` wrapper as this protocol. No undocumented idempotency/reconciliation is claimed. [Official V2 delete](https://platform.minimax.io/docs/api-reference/video-generation-v2-delete).

## Vidu Q3 Turbo

`VIDU_REGION=global` uses `https://api.vidu.com`; `cn` uses `https://api.vidu.cn`. Auth is **`Authorization: Token ...`**, not Bearer. Text generation is `POST /ent/v2/text2video` with exact model `viduq3-turbo`, prompt, duration, `resolution: 720p`, selected `aspect_ratio`, `audio: false`, `off_peak: false`. Image generation is `POST /ent/v2/img2video`, with one inline data URI in `images` and `is_rec: false`; it does **not** send an undocumented image-to-video `aspect_ratio` parameter. The first-frame image must exactly match the desired ratio. Exact generated dimensions are still unverified for this image subset and are checked by the application before publication. [Official image-to-video](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/image-to-video), [official text-to-video](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video), [China text-to-video](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/text-to-video).

Create returns `task_id`; poll is `GET /ent/v2/tasks/{id}/creations`. `created`/`queueing`/`processing` are running, `success` succeeds, and `failed` fails; documented `err_code: UserCancelled` becomes a cancelled failure code. Download comes from `creations[0].url` with no Token header. URLs expire after 24 hours. No production output hostname was established from official examples, so `VIDU_OUTPUT_HOSTS` is mandatory before even submitting a generation. Do not substitute input-example hosts or a broad wildcard. [Official task detail](https://platform.vidu.com/docs/api-reference/task-management/task-detail).

The narrow adapter omits seed because the reviewed docs did not establish an exact bounded range. Q4 preview, references/first-last frames, smart recommendation, off-peak work, and remote cancellation are outside the implemented subset. Cancellation remains local-only, and unknown acceptance is never resubmitted.

## Explicit exclusions and remaining verification

OpenAI Sora is not added: its API shutdown date was September 24, 2026, before this implementation review. Model names copied from older examples are not evidence of a working endpoint. [Official OpenAI deprecations](https://platform.openai.com/docs/deprecations).
The compatible-service protocol reuses the official OpenAI SDK without adding a direct OpenAI Sora integration or certifying any particular service/model.

Except for the exact MiniMax CN H3 text-to-video checks recorded above, real-provider smoke tests remain unrun. A future authorized check must confirm the exact regional account/model, actual media acceptance, task lifecycle, CDN/auth behavior, decoded dimensions/duration/audio, credit charge and output quality. Account billing totals were not independently audited in the MiniMax checks. Vidu additionally needs independent evidence for the precise production CDN host before enabling any paid request. Offline contract tests do not remove these blockers.
