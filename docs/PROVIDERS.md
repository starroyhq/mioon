# Video provider adapters

Implementation and official documentation checked 2026-10-09. No live generation, external reference upload, account mutation, paid call, or remote cancellation has been performed for any real provider. Live verification remains **pending separate authorization**. Passing injected-HTTP tests does not establish account eligibility, real provider availability, output quality, price, or end-to-end generation.

The production registry now publishes and enforces [exact model input limits](GENERATION-INPUT-LIMITS.md), including the dated Veo lifecycle policy. These implemented app profiles do not enable broader vendor reference modes.

## Shared behavior

Factories are `createMockProvider({ db, root })`, `createRunwayProvider({ root })`, `createArkProvider({ root })`, `createVeoProvider({ root })`, `createMinimaxProvider({ root })`, and `createViduProvider({ root })`. All implement the adapter interface in `CONTRACT.md`, including synchronous `validate(snapshot)` with no network and no dependency on resolved local paths. Submission independently validates actual managed reference bytes. `root` is the managed application data root, not a user-selected upload path. Adapters return **fractional progress from 0 to 1**; the job/UI layer converts it to a percentage.

A successful submit returns `{ providerJobId }`. An error tagged `uncertain: true` means acceptance cannot be excluded. Persist that state and reconcile; do not submit again. A `null` reconciliation result never authorizes resubmission. Known task IDs can be polled and downloaded repeatedly without another generation POST. Snapshots and references belong to the application; no secret is copied into them.

### Implemented model subsets

These are deliberately smaller than the providers' full catalogs. The UI and service use per-model `modelCapabilities`; legacy `models`, `inputModes`, `aspectRatios`, and `durations` remain available. Configuration exposes only names/reasons, never values. `available` means local configuration and approved count permit a request; it is not a live-verified claim.

| Provider ID | Exact model | Inputs | Implemented ratios | Seconds | Resolution |
| --- | --- | --- | --- | --- | --- |
| mock | mock-motion-v1 | Text / simulated image workflow | 9:16 | 2, 4, 8 | 360×640 |
| runway | gen4_turbo | One first-frame image | See Runway below | Integer 2–10 | Ratio-dependent |
| ark | doubao-seedance-2-5-260628 | Text / one first-frame image | 9:16, 16:9 | 4, 8 | 720p |
| veo | veo-3.1-generate-preview | Text / one first-frame image | 9:16, 16:9 | 4, 6, 8 | 720p |
| minimax | MiniMax-H3 | Text / one first-frame image | 9:16, 16:9 | 4, 8 | 768P |
| vidu | viduq3-turbo | Text / one first-frame image | 9:16, 16:9 | 4, 8 | 720p |

New adapters deliberately accept PNG/JPEG only, at most one image, and a nonblank prompt of at most 1000 UTF-16 code units. That prompt cap is a conservative application limit, not a claim about the provider's full limit. They expose no seed, arbitrary URL, reference-video, first/last-frame pair, audio option, webhook, batch count, or other advanced parameter. Resolution is fixed per adapter. Veo audio is always on; Ark/Vidu explicitly disable it. MiniMax uses the selected model's default audio behavior.

### Required server settings

Every real provider needs `MIOON_ENABLE_LIVE_PROVIDER=1`, the corresponding server key, and a separately approved application-level generation count. None are implied by installing the app or having a ChatGPT plan.

| ID | Credential name | Approved-image checksum list | Generation count | Additional settings |
| --- | --- | --- | --- | --- |
| runway | RUNWAYML_API_SECRET | RUNWAY_APPROVED_ASSET_SHA256 | RUNWAY_MAX_GENERATIONS | RUNWAY_OUTPUT_HOSTS |
| ark | ARK_API_KEY | ARK_APPROVED_ASSET_SHA256 | ARK_MAX_GENERATIONS | ARK_OUTPUT_HOSTS |
| veo | GEMINI_API_KEY | VEO_APPROVED_ASSET_SHA256 | VEO_MAX_GENERATIONS | VEO_OUTPUT_HOSTS |
| minimax | MINIMAX_API_KEY | MINIMAX_APPROVED_ASSET_SHA256 | MINIMAX_MAX_GENERATIONS | MINIMAX_OUTPUT_HOSTS; MINIMAX_REGION=global or cn |
| vidu | VIDU_API_KEY | VIDU_APPROVED_ASSET_SHA256 | VIDU_MAX_GENERATIONS | VIDU_OUTPUT_HOSTS required; VIDU_REGION=global or cn |

`*_APPROVED_ASSET_SHA256` is a comma-separated list of exact reviewed image hashes; text-only generation does not need an image approval. `*_OUTPUT_HOSTS` contains exact independently verified output CDN hostnames, never URLs, wildcard suffixes or hosts copied blindly from a provider response. Vidu has no verified default output CDN and stays unconfigured until its output host list is supplied. MiniMax/Vidu region defaults to `global`; keys must belong to that selected regional account. Invalid region settings fail closed. API origins cannot be overridden by request input or arbitrary environment URLs.

The generation-count limit is enforced by the shared service against jobs in the local data directory, before queuing. It is not a provider-account credit limit or a currency price guarantee. All queued attempts conservatively count, including later rejected submissions. Deleting/resetting the local data directory is not an authorized budget reset.

### Shared live-adapter safeguards

`live-common.mjs` provides fixed-origin authenticated JSON requests, approved local image reads, PNG/JPEG byte/dimension parsing, ten-second success/error/in-flight polling cache, and atomic MP4 downloads for Ark, Veo, MiniMax and Vidu. No SDK or hidden POST retry wrapper is used. Network loss, abort, HTTP 408/5xx, redirects/conflict, unreadable JSON, and successful create responses without valid task identities remain uncertain. Explicit request/auth/billing/quota rejection HTTP codes are failed safely. Provider bodies, failure reasons, signed URLs and credentials are not returned to clients. Known-task GET failures never authorize a new generation.

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

Requests use the fixed `https://api.dev.runwayml.com` origin, Bearer authentication and `X-Runway-Version: 2024-11-06`. There is no configurable request-supplied API base, SDK retry wrapper, automatic POST retry, or undocumented idempotency header. [Official getting-started guide](https://docs.dev.runwayml.com/guides/using-the-api/)

`PENDING`, `THROTTLED`, and `RUNNING` map to running. `SUCCEEDED`, `FAILED`, and `CANCELLED` map to their application outcomes. Status reads are cached for five seconds. No documented create-request-ID lookup is assumed; `reconcile(requestId)` returns null and a missing provider ID remains unresolved. Raw provider error bodies and failure text are not returned to clients. [Official task interface](https://github.com/runwayml/sdk-node/blob/main/src/resources/tasks.ts)

### Server-only safety configuration

Live calls require all applicable gates, configured only after separate user authorization:

1. `MIOON_ENABLE_LIVE_PROVIDER=1`
2. `RUNWAYML_API_SECRET` supplied to the server environment through a secure credential route
3. `RUNWAY_APPROVED_ASSET_SHA256`: comma-separated hashes of the exact approved synthetic reference files
4. Any additional application-level budget/authorization gate, including the backend's `RUNWAY_MAX_GENERATIONS`

The provider never reads credentials from browser input, project JSON or a URL. Construction, capability listing, reconciliation of an unknown request, and local-only cancellation make no network calls. A credential alone does not enable live calls. Capability `configured` reports presence only; `enabled` reflects the explicit enable switch and key, while per-reference approval is still mandatory.

Only managed local reference files are read. The adapter resolves symlinks beneath `root`, checks the snapshot checksum, accepts PNG/JPEG/WebP signatures, and sends an inline data URI to Runway. Arbitrary source URLs, GIFs and additional references are rejected. Encoded data URI length is capped at 5 MiB; large files fail before transmission. There is no separate upload POST. [Official input requirements](https://docs.dev.runwayml.com/assets/inputs/)

### Download and cancellation boundaries

Successful task output URLs are ephemeral; Runway recommends retrieving fresh URLs and saving outputs into application storage. The adapter downloads to a private temporary file, checks MP4 container bytes and atomically renames it. The backend additionally probes and decodes before publishing a version. Failed/expired downloads invalidate the cached task response so a later attempt fetches a fresh URL. [Official output requirements](https://docs.dev.runwayml.com/assets/outputs/)

Output downloads never receive the API authorization header. HTTPS, no credentials/ports, no redirects, a 128 MiB limit and an exact server-side hostname allowlist protect the download boundary. The default hostname is the CDN shown in the official example, `dnznrvs05pmza.cloudfront.net`. If a future task returns another CDN, verify it and configure `RUNWAY_OUTPUT_HOSTS`; the adapter fails closed until then. No signed URL is exposed in adapter results.

Remote cancellation is intentionally unavailable. Runway's task DELETE endpoint also permanently deletes finished tasks and their outputs. A preliminary GET cannot eliminate the completion race. `cancel()` therefore reports `remoteCancelled: false` and `scope: local` without sending DELETE. Remote work and charges may continue after local waiting stops. The UI must preserve that warning. [Official cancellation semantics](https://github.com/runwayml/sdk-node/blob/main/src/resources/tasks.ts)

## Offline verification and next real check

Run `node --test tests/providers.test.mjs tests/providers-v4.test.mjs tests/providers-additional.test.mjs`. Tests use Node's built-in test runner and injected fetch responses; no real network request is made. Coverage includes:

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

Before any A9 run, confirm all of these together with the owner: Runway organization/account and `gen4_turbo` model; exact reference image scope (server-side SHA256 allowlist) and prompt; 9:16 duration; maximum generation count and total currency budget; secure local credential configuration method. Do not paste credentials into conversation. Configure the approved count using `RUNWAY_MAX_GENERATIONS`; rejected/local validation attempts can conservatively consume a count because jobs are counted. The application cannot guarantee a dollar price from account balance, and no budget/real-generation approval is implied by a Pro plan or the offline adapter tests.

The same bundled approval is required independently for each additional provider: exact account/region/model, text and optional reference-image scope, duration/ratio, maximum count and total currency budget, verified download hosts, and secure server credential configuration. No cross-provider fallback submission is automatic. If acceptance is unknown, stop and investigate the provider account rather than spending again.

## Ark Seedance 2.5

The mainland-China Ark adapter uses the fixed `https://ark.cn-beijing.volces.com/api/v3` origin with Bearer `ARK_API_KEY`, `POST /contents/generations/tasks`, and `GET /contents/generations/tasks/{id}`. The create body contains the exact model, a text content item, optional inline PNG/JPEG `image_url` with `role: first_frame`, duration, `resolution: 720p`, `output_format: mp4` and `generate_audio: false`. Text requests send the selected `ratio`. Image requests must send `ratio: adaptive`, so the adapter verifies both snapshot metadata and actual image bytes are 300–6000 pixels per side and exactly match the selected ratio. It does not silently stretch or crop the image. [Official create API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh), [Seedance 2.5](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh).

`queued`/`running` map to running; `succeeded` to succeeded; `failed`/`cancelled`/`expired` to failed, with sanitized outcome codes. Output is `content.video_url`. Tasks are retained seven days; output links are documented as valid for 24 hours. Seedance 2.5 also documents a download-count limit, so successful downloads are stored locally. Default trusted example hosts are `ark-content-generation-cn-beijing.tos-cn-beijing.volces.com` and `ark-acg-cn-beijing.tos-cn-beijing.volces.com`; these are verified examples, not an exhaustive future CDN list. [Official task retrieval](https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh).

No configurable seed is exposed: current create documentation restricts that request option to older model families, even though newer model responses may contain a seed. No undocumented request-ID lookup is inferred from task listing. `reconcile()` returns null; cancellation is local-only. [Official list API](https://docs.volcengine.com/docs/ark/list-video-generation-tasks-api?lang=zh).

## Gemini Veo 3.1 preview

This adapter targets the **Gemini Developer API**, not Vertex AI. It uses `GEMINI_API_KEY` in `x-goog-api-key` against `https://generativelanguage.googleapis.com/v1beta`. Create is `POST /models/veo-3.1-generate-preview:predictLongRunning`; the body contains one `instances` element with prompt and optional `image: {bytesBase64Encoded, mimeType}`, plus `parameters: {aspectRatio, durationSeconds, resolution: 720p, sampleCount: 1}`. Inline bytes are raw base64, without a data-URI prefix. The complete returned `name` is persisted and polled at `GET /v1beta/{name}`. [Official Veo guide](https://ai.google.dev/gemini-api/docs/veo?hl=en), [official REST-field converter](https://raw.githubusercontent.com/googleapis/js-genai/main/src/converters/_models_converters.ts).

`done: false` or omitted means running. `done: true` plus `error` is terminal failure. Generated video is read from `response.generateVideoResponse.generatedSamples[0].video.uri`. A completed safety-filtered response with no samples is terminal filtered failure; empty completed output is terminal no-output. Raw safety reasons are not exposed. Videos have always-on audio, and documented retention is two days. No `seed`, `generateAudio` or regional `personGeneration` override is sent: Gemini and Vertex options differ, and the selected API's official converter rejects the seed/audio controls. Provider policy/account/region restrictions may still reject a request.

Authenticated media retrieval is limited to `https://generativelanguage.googleapis.com/v1beta/files/{id}:download?alt=media`. The route is reconstructed, matching the official downloader, instead of forwarding a key to arbitrary returned URLs or query strings. Additional direct CDN hosts and redirect destinations must be explicitly reviewed through `VEO_OUTPUT_HOSTS`. A redirect to an unknown host fails closed; a configured host never receives the key. The first key-bearing request uses only the exact official download route. [Official Node downloader](https://raw.githubusercontent.com/googleapis/js-genai/main/src/node/_node_downloader.ts).

There is no documented client request-ID reconciliation or guaranteed create idempotency in the reviewed API. Missing operation identity stays unresolved; local cancellation makes no remote request.

## MiniMax H3 V2

The adapter explicitly implements **MiniMax-H3 with V2**, not a guessed Hailuo V1 payload. `MINIMAX_REGION=global` uses `https://api.minimax.io`; `cn` uses `https://api.minimax.cn`, each with its corresponding account's Bearer key. `POST /v2/video_generation` receives `model`, text/optional first-frame content items, `duration`, `resolution: 768P` and `ratio`. It sends a data URI for approved images and `ratio: adaptive` for first-frame input, requiring actual image dimensions of 256–5760 per side and exact requested ratio. Text uses the selected ratio. This subset omits 2K, longer durations, last-frame inputs and unsupported seed settings. [Official V2 create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create), [China V2 create](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create), [official V2 schema](https://platform.minimax.io/docs/api-reference/video/generation/api/v2-video-generation.json).

Create returns string `task_id`; `GET /v2/query/video_generation/{task_id}` returns `task.id`, `task.status` and successful `task.content.url`. Queued/running, succeeded, failed/cancelled map to the shared lifecycle. Query retention is seven days. Signed output URLs can expire; a failed download invalidates the cache for a fresh query. Official example output hosts `cdn.hailuoai.com` and `video-product.cdn.minimax.io` are trusted by default, with no Bearer header on downloads. [Official V2 query](https://platform.minimax.io/docs/api-reference/video-generation-v2-query).

Cancellation stays local because the documented DELETE endpoint also deletes succeeded/failed records; a preceding status check cannot remove that race. V2 real HTTP errors are used instead of incorrectly treating the legacy V1 `base_resp` wrapper as this protocol. No undocumented idempotency/reconciliation is claimed. [Official V2 delete](https://platform.minimax.io/docs/api-reference/video-generation-v2-delete).

## Vidu Q3 Turbo

`VIDU_REGION=global` uses `https://api.vidu.com`; `cn` uses `https://api.vidu.cn`. Auth is **`Authorization: Token ...`**, not Bearer. Text generation is `POST /ent/v2/text2video` with exact model `viduq3-turbo`, prompt, duration, `resolution: 720p`, selected `aspect_ratio`, `audio: false`, `off_peak: false`. Image generation is `POST /ent/v2/img2video`, with one inline data URI in `images` and `is_rec: false`; it does **not** send an undocumented image-to-video `aspect_ratio` parameter. The first-frame image must exactly match the desired ratio. Exact generated dimensions are still unverified for this image subset and are checked by the application before publication. [Official image-to-video](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/image-to-video), [official text-to-video](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/text-to-video), [China text-to-video](https://platform.vidu.cn/docs/api-reference/video-models/vidu-q3/text-to-video).

Create returns `task_id`; poll is `GET /ent/v2/tasks/{id}/creations`. `created`/`queueing`/`processing` are running, `success` succeeds, and `failed` fails; documented `err_code: UserCancelled` becomes a cancelled failure code. Download comes from `creations[0].url` with no Token header. URLs expire after 24 hours. No production output hostname was established from official examples, so `VIDU_OUTPUT_HOSTS` is mandatory before even submitting a generation. Do not substitute input-example hosts or a broad wildcard. [Official task detail](https://platform.vidu.com/docs/api-reference/task-management/task-detail).

The narrow adapter omits seed because the reviewed docs did not establish an exact bounded range. Q4 preview, references/first-last frames, smart recommendation, off-peak work, and remote cancellation are outside the implemented subset. Cancellation remains local-only, and unknown acceptance is never resubmitted.

## Explicit exclusions and remaining verification

OpenAI Sora is not added: its API shutdown date was September 24, 2026, before this implementation review. Model names copied from older examples are not evidence of a working endpoint. [Official OpenAI deprecations](https://platform.openai.com/docs/deprecations).

Real-provider smoke tests remain unrun for all five real adapters. A future authorized check must confirm the exact regional account/model, actual media acceptance, task lifecycle, CDN/auth behavior, decoded dimensions/duration/audio, credit charge and output quality. Vidu additionally needs independent evidence for the precise production CDN host before enabling any paid request. Offline contract tests do not remove these blockers.
