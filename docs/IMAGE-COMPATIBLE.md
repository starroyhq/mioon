# Custom Images: UUID services and a bounded JSON/PNG profile

## Current generation services

[Settings → Generation services](GENERATION-SERVICES.md) contains one official
OpenAI image service, one local ComfyUI service and up to ten independent custom
image services. Custom settings now use a v2 UUID collection; the fixed
single-PNG provider profile and wire body remain unchanged. The current
settings and web/client preparation contract is described below. The dated
acceptance record is historical evidence, not native acceptance of this change.

## Historical status and evidence: 2026-10-10

The approved custom Images increment is implemented on baseline `4e66a96`.
The focused affected gate passed **584/584 tests, 0 failed, 0 skipped**, and fresh
web/desktop builds passed. Actual Linux Electron acceptance passed on the final
bundle: unmodified production unconfigured/invalid-endpoint checks and an isolated
synthetic-network custom output, credential-destination change, stale approval,
quit/recreation and local-only recovery flow. Main/web bytes match production;
the test backend alone injects synthetic DNS/HTTPS. Its two synthetic POSTs do not
increase on restart or recovery. Fourteen screenshots and exact original schema-17
row/media preservation checks are retained. The independent full suite passed:
**2857 total, 2855 passed, 0 failed, 2 skipped**, exit 0, 619,570.008795 ms.
The retained parent log SHA-256 is
`87a4de39a38892654b7599eafcbf35301107ba129abfccb635c8bffb8b8aa978`. No real key, live provider
call or actual model output has been verified. macOS/Windows native behavior
remains unverified.

The earlier fixed-OpenAI activation gate at `4e66a96` passed 2758 tests total
(2756 passed, 0 failed, 2 skipped), with its own builds and Linux synthetic-network
native evidence. Those results are preserved in [Images activation](IMAGE-ACTIVATION.md);
they are not acceptance of this custom increment or of macOS/Windows behavior.

## Official service and custom v2 collection

The official OpenAI preset keeps its existing URL, pinned model, credential
binding, namespace `mioon.images.openai.v1`, private `/api/images/settings` route
and `image-settings/settings.json` file. Custom services use:

- Provider `openai-compatible`, with a separate lowercase UUID for every service
- Profile `openai-images-json-png-v1`
- Namespace `mioon.images.openai-compatible.v2`
- Private authenticated `GET`/`PUT /api/images/custom-settings`
- Separate private `image-settings/custom-settings.json`

The official service and custom collection retain separate settings owners,
atomic-file protections and the reviewed generation lifecycle. Every custom
service has its own key; the official service, video services and Mio do not
share credentials with it. The page creates a UUID for each new draft and keeps
that ID after saving. The backend rejects duplicate, uppercase and deleted IDs;
deletion removes that service's configuration, ciphertext and session key, leaving
only a UUID tombstone. This is not a plugin loader.

Web keys last for one backend process lifetime, not one tab. Electron persistence
requires explicit selection and available OS-encrypted storage. The narrow
Images-only main/utility codec accepts these two namespaces and exact bindings;
there is no renderer/preload decrypt API, arbitrary vault access or plaintext
fallback. Linux `basic_text` and unavailable secure storage fail closed. Key input
remains in its own password DOM input, outside React state, and is cleared on
submission/navigation; uncertain saves are followed
by a redacted read, never automatic secret replay. Fresh replacement input is
required after uncertainty.

A configured key is bound to the namespace, provider, service UUID, profile and
complete canonical base URL, including its path. Model and options are not key
recipients. Changing a model at the same address keeps the key but advances that
service's configuration revision, invalidating an older review. Changing the
address with `secret.action:"keep"` saves successfully and disconnects only that
service's key; a new key must be entered before new generation. A replacement
entered in that save is bound to the new address. Another service's key and
configuration revision are unaffected.

### Inherited desktop Keychain limitation

The 2026-10-10 acceptance used synchronous Electron `safeStorage` in main. Its
utility Images codec had a default two-second timeout and could not cancel an
OS Keychain prompt or unblock main. Slow or denied startup decryption failed
closed and latched persistent storage as unavailable. Ordinary settings reads
could refresh capability status but did not clear that decryption latch. Recovery
required an explicit application restart after unlocking/allowing OS storage, or
an explicit key replacement/removal through settings.

At that checkpoint, a prolonged main-process block could exceed the utility's
30-second heartbeat lease and cause backend shutdown. Four independent read-only
checks with a fake broker passed; they validate that historical synthetic failure
behavior, not real macOS Keychain prompts, native timing or native acceptance.

The current macOS codec uses the asynchronous `safeStorage` methods in
`apps/desktop/src/secret-store.ts`; Linux retains its strong-keyring branch.
Neither branch falls back to plaintext storage, another service's key, secret
replay or a generation POST. The historical checks above do not establish native
acceptance of the current codec or this v2 settings change.

## Exact private settings contract

The existing loopback Host/Origin checks, bearer/session authentication, no-store
responses, fixed redacted errors and uncompressed JSON requirement apply. Reads
return the normal `{ok:true,data}` envelope with:

```text
{revision,
 connections:[{connectionId,name,configurationRevision,configuration,
               secret:{configured,storage}}],
 storage:{persistentAvailable,sessionScope,reasonCode},notice}
```

`configuration` has exactly
`{enabled,providerId,profileId,baseUrl,model,options}`. The UUID is the entry's
top-level `connectionId`, not a provider/model identifier or configuration field.
`secret.storage` is `none`, `session` or `persistent`; the implemented
`sessionScope` is `server`. Storage reason codes are unchanged from
[official settings](IMAGE-ACTIVATION.md#private-authenticated-http-settings-contract).

PUT uses an explicit action. Creating a service takes
`{action:"create",expectedRevision,connectionId,name,configuration,secret}`.
For example, this keyless, disabled configuration illustrates the syntax only;
the example host and model are not verified services. A real page generates a
fresh lowercase UUID when creating its draft:

```json
{
  "action": "create",
  "expectedRevision": 0,
  "connectionId": "22222222-2222-4222-8222-222222222222",
  "name": "Custom image service",
  "configuration": {
    "enabled": false,
    "providerId": "openai-compatible",
    "profileId": "openai-images-json-png-v1",
    "baseUrl": "https://images.example.com/api/v1",
    "model": "supplier-image-v1",
    "options": {
      "size": "1024x1024",
      "quality": "low",
      "outputFormat": "png",
      "background": "opaque",
      "n": 1
    }
  },
  "secret": {"action": "keep"}
}
```

Use the current nonnegative safe-integer collection revision, not an assumed `0`.
An existing entry uses `action:"put"` with the same fields plus
`expectedConfigurationRevision`. Deleting takes
`{action:"remove",expectedRevision,connectionId,expectedConfigurationRevision}`.
An atomic batch takes `{action:"batch",expectedRevision,operations:[...]}`;
each operation has its own `create`, `put` or `remove` shape without a collection
`expectedRevision`. A batch changes each UUID at most once and publishes once,
with at most twenty operations and ten resulting services. It does not split
itself into separate writes. No cross-file transaction is implied.

`secret` is exactly `{action:"keep"}`, `{action:"remove"}`, or
`{action:"replace",storage:"session"|"persistent",value:<new key>}`. Enter keys
only in the private Images settings UI; never put them in shell examples,
prompts or tool arguments. The custom update limit is 128 KiB, key input 1–4096
non-whitespace printable ASCII bytes, private collection envelope 640 KiB and each encrypted
base64 text at most 49,152 characters. URLs on these local routes accept no query.

The initial collection is empty. A new service may start disabled with both
`baseUrl` and `model` empty and no key; otherwise both fields must be complete,
even when disabled. The collection revision fences an atomic save; each saved
entry has its own `configurationRevision`. Updating B does not invalidate A's
review. A new review requires enabled, configured settings; saving or syntax
validation performs no DNS lookup, compatibility probe, model discovery or
generation and grants no paid approval.

Only a strictly valid old custom v1 envelope is read as empty v2 with
`notice:"LEGACY_CUSTOM_IMAGE_SETTINGS_RESET"`. Reads preserve the old file and
never import or decrypt its key; the first explicit save writes v2. Repeated
GETs do not consume the notice. Corrupt, unsafe and unknown-version files are
refused, and a file changed after loading cannot be overwritten by that owner.
The old v1 file still has its own 64 KiB recognition limit; it is not accepted
under the larger v2 budget. There is no reset or historical-key restoration API.
The session-storage UI warns: “应用退出后，正在进行的生成没法继续查询结果。”

## Destination and wire profile

Since 2026-10-26, the pinned official `openai@7.39.0` SDK's
`images.generate()` assembles this existing JSON profile. The host still owns
the reviewed destination, dedicated credential, DNS/TLS checks, bounded wire
body and final synchronous dispatch fence. SDK retries and environment
credential discovery are disabled, and the fetch boundary allows only one
request to the exact generation URL. No probing, pagination, protocol fallback
or image editing is added to this custom profile.

The saved base URL must be canonical HTTPS on port 443 with a DNS hostname and
optional ASCII path prefix. Canonical form has a lowercase hostname, no explicit
`:443` and no trailing slash; UI normalization may remove those differences
before the strict settings request. Path segments use only `A–Z`, `a–z`, `0–9`,
`.` `_` `~` and `-`. Whole `.`/`..` segments and empty interior segments are
rejected. Credentials, query, fragment, percent encoding, backslashes, IP
literals and any other port are rejected. Base URL plus `/images/generations`
is at most 2048 characters. For the example above, the exact destination is
`https://images.example.com/api/v1/images/generations`.

Syntax alone cannot prove a hostname is safe. Before dispatch, actual DNS lookup
must return 1–64 answers and every answer must be a public address. The transport
pins the selected address, verifies the TLS hostname and actual peer IP/port,
and refuses private, loopback or mixed public/private answers. It does not use
redirects, proxies, environment routing, pooled agents or fallback addresses.
HTTP localhost services and local ComfyUI endpoints are outside this profile.

The model is a user-configured identifier of 1–120 printable non-whitespace ASCII
characters. It is not restricted to OpenAI's model names; it must exactly match
the reviewed custom settings. There is no model lookup, negotiation or proof
that the supplier supports that identifier.

The request is one Bearer-authenticated JSON POST with exactly these body fields:

```json
{
  "model": "supplier-image-v1",
  "prompt": "A quiet opening keyframe.",
  "n": 1,
  "quality": "low",
  "size": "1024x1024",
  "output_format": "png",
  "background": "opaque",
  "moderation": "auto"
}
```

The original prompt is unchanged. These are the same fixed body fields as the
official adapter, with the selected custom model. No `response_format`, custom
headers/options or additional model parameters are negotiated. Success must be
HTTP 200 JSON containing exactly one `data` item whose sole field is canonical
`b64_json`. Optional bounded metadata is allowlisted by the shared decoder;
unknown fields, duplicate JSON keys, URL results and rewritten-prompt fields
are rejected. Returned bytes must pass the shared full PNG validation: exactly
1024×1024, noninterlaced 8-bit RGB or fully opaque RGBA. No URL download occurs.

Existing network bounds remain: 10-second connection timeout, 180-second total
timeout, 16-KiB request/header bounds, 42-MiB JSON response and 30-MiB decoded
PNG maximum. An incompatible response never triggers another request, a model
change or a fallback. This is a conservative wire contract, not a claim that
all “OpenAI-compatible” vendors work. Image edits/masks, reference uploads,
batches, seed/size/quality controls and automatic image-to-video are excluded.
Mock remains a labeled local test card and makes no promise to depict the prompt.

## Public request preparation, private paid approval

The `image.generate` request and original receipt shapes remain unchanged;
`providerId:"openai-compatible"` and its configured model still identify the wire
profile. Endpoint, service UUID, credentials and approval flags are not generation
input fields. The UUID selector belongs to the separate preparation envelope.

### Explicit web and client selection

Send authenticated `POST /api/projects/{projectId}/images/services` with
`{operation,input}`. `image.service.list` takes `{projectId}` and returns
`{projectId,items:[<redacted custom service entries>]}`. Select the exact
`connectionId` and its `configurationRevision`; two services may use the same
model and address and still have independent keys.

An illustrative preparation body is:

```json
{
  "operation": "image.service.review.prepare",
  "input": {
    "input": {
      "projectId": "11111111-1111-4111-8111-111111111111",
      "name": "Opening keyframe",
      "providerId": "openai-compatible",
      "model": "supplier-image-v1",
      "prompt": "A quiet opening keyframe.",
      "options": {
        "size": "1024x1024",
        "quality": "low",
        "outputFormat": "png",
        "background": "opaque",
        "n": 1
      },
      "requestId": "custom-image-opening-0001"
    },
    "connectionId": "22222222-2222-4222-8222-222222222222",
    "configurationRevision": 3
  }
}
```

The project address must match the nested generation `projectId`. Replace the
illustrative UUIDs, model and revision with the actual selected values. The
shared client uses the same route and validates the exact response identity:

```ts
await client.generationImages('image.service.list', {projectId});
await client.generationImages('image.service.review.prepare', {
  input: originalImageInput, connectionId, configurationRevision,
});
```

These operations do not enter fixed RPC, CLI, MCP or Mio tool catalogs.
Preparation retains only the exact local review, without approval, task dispatch
or a provider call. `image.review.get` and `image.review.list` remain read-only.

### Legacy CLI, MCP and Mio without a selector

The existing `image.review.prepare` input remains `{input,settingsRevision}`.
With exactly one custom entry in the collection, the backend resolves that entry's
UUID and checks its configured/enabled state; with two or more entries it rejects before acquiring a key or
retaining a new review. It does not guess by enabled state, model, order or recent
use. Mio reports “有多个自定义图片服务，请在生成面板里选择。” The collection's
total entry count governs this rule, including disabled entries. Explicit custom
service selection in CLI/MCP/Mio is deferred to 0.1.x; this change adds no settings
or approve/reject tool. [Profile discovery](IMAGE-PROFILE-DISCOVERY.md) remains
advisory and does not select a service.

For that single-entry legacy case, `mioon image review prepare --input-file
./image-review.json` and MCP `image_review_prepare` still take
`{input:<complete original generation input>,settingsRevision:<that entry's configuration revision>}`.
The file is that legacy input object, not the explicit web `{operation,input}`
envelope shown above. Never borrow a collection, official or ComfyUI revision.

New UUID-bound custom review intents use backend `schemaVersion:6` and retain
`connectionId`, `configurationRevision`, the full immutable `configuration`,
exact destination, complete input and existing one-POST policy. The public DTO
adds the two identity fields and `configuration` to the
[existing DTO](IMAGE-ACTIVATION.md#shared-public-review-operations);
`settingsRevision` equals that service's `configurationRevision`. It has no public
`schemaVersion` field. Historical custom v2 intents and official v1 intents/DTOs
retain their original serialized shape; clients cannot choose an intent version
or inject its configuration/destination. Intent 32-KiB, row 64-KiB and retained
review limits of 1000/project and 10,000/workspace are unchanged. Full prompts,
reviews and nonsecret configuration remain plaintext local SQLite.

The user must explicitly approve the visible exact prompt/project/model/options,
full custom configuration and actual destination in the Images UI. The private
approve/reject request remains `{projectId,reviewId,expectedRevision}` at
`/api/projects/{projectId}/images/reviews/approve` or the corresponding `/reject`
path. Approval
reserves the existing task/receipt atomically. Just before any credential/header/
body transmission, the shared synchronous fence rechecks that UUID's complete
configuration, configuration revision, enabled/key state and pending writes, commits the
review/task dispatch attempt, and calls network `end()` without an intervening
await. At most one POST is permitted at usage-based unknown cost, not a currency
cap. Settings save and local authentication do not grant paid approval.

Unknown/lost acknowledgements retain the original request/review/task identity.
Use `image.request.get`, then task/review reads; exact replay never reschedules.
There is no automatic approval, POST retry or startup dispatch. Explicit queued
cancellation stays undispatched-only; local result recovery only validates and
publishes existing task-bound staged PNG bytes. It cannot fetch a missing result
or generate another image. A real canary requires separate explicit approval of
its exact configuration, prompt/media and fees.

## Historical provenance and schema 18

The schema-18 migration below describes the original custom v1 settings/custom v2
review increment, not the current UUID collection or G1a native acceptance.
The new v6 review branch and history 10 upgrade gate are described in
[Generation services](GENERATION-SERVICES.md#文件与旧版本).

Task snapshot `schemaVersion:1` remains content-only. It does not record a custom
endpoint and is not the complete custom execution provenance. The backend
validates the retained task-linked review, its full configuration/destination,
request/hash and task binding for that provenance. Never reconstruct a historical
custom destination from current settings, which can change independently.

Schema 18 rebuilds only `image_reviews` because schema 17 restricted it to official
v1 intents. In one migration transaction it permits official v1 and custom v2,
copies raw `rowid` plus all 16 column values, and compares both directions before
replacing the table. Historical pending/approved/rejected/dispatched states are
copied as stored, not replayed through pending-only insertion guards. Its retained
explicit indexes/triggers are recreated from their original SQL and compared;
foreign-key checks run before commit. Other tables, serialized task/receipt bytes,
sequences and history remain untouched. No migration manufactures reviews or
starts work. Migration coverage uses an independently frozen schema-17 fixture;
test presence alone is not a passing release gate.

Current authoritative contracts: `packages/contracts/src/image-compatible.ts`,
`image-settings.ts`, `generation-image-settings.ts`, `generation-image-services.ts`,
`images.ts` and `image-reviews.ts`. The
[shared lifecycle](IMAGE-GENERATION.md) and [approval/recovery rules](IMAGE-ACTIVATION.md)
continue to apply. Broader plugin architecture and built-in Agent authority are
unchanged.
