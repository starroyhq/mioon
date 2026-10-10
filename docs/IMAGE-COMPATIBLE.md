# Custom Images: one bounded compatible JSON/PNG profile

## Status and evidence: 2026-10-10

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

## Two independent settings slots

The official OpenAI preset keeps its existing URL, pinned model, credential
binding, namespace `mioon.images.openai.v1`, private `/api/images/settings` route
and `image-settings/settings.json` file. The custom slot adds exactly:

- Provider `openai-compatible`, connection `custom`
- Profile `openai-images-json-png-v1`
- Namespace `mioon.images.openai-compatible.v1`
- Private authenticated `GET`/`PUT /api/images/custom-settings`
- Separate private `image-settings/custom-settings.json`

Both slots reuse the bounded settings engine, atomic-file protections, desktop
codec and generation lifecycle. The custom slot never adopts the official key;
Agent/video keys and environment flags activate neither slot. There is one
custom connection, not a multi-provider registry or a plugin loader.

Web keys last for one backend process lifetime, not one tab. Electron persistence
requires explicit selection and available OS-encrypted storage. The narrow
Images-only main/utility codec accepts these two namespaces and exact bindings;
there is no renderer/preload decrypt API, arbitrary vault access or plaintext
fallback. Linux `basic_text` and unavailable secure storage fail closed. Key input
is write-only and cleared on submission/navigation; uncertain saves are followed
by a redacted read, never automatic secret replay. Fresh replacement input is
required after uncertainty.

A configured key is bound to the complete canonical base URL (including path),
model and fixed profile/options. Changing the base URL or model while keeping a
key is rejected. Explicitly remove it or provide a newly entered replacement in
that same save; a host/path change cannot silently forward the existing key.
The official slot and its settings revision are independent.

### Inherited desktop Keychain limitation

Electron `safeStorage` encryption/decryption runs synchronously in main. The
utility's Images codec request has a default two-second timeout; it cannot cancel
an OS Keychain prompt or unblock main. A slow or denied startup decryption fails
closed and latches persistent storage as unavailable. Ordinary settings reads
can refresh capability status but do not clear that decryption latch. Recovery
requires an explicit application restart after unlocking/allowing OS storage, or
an explicit key replacement/removal through settings. There is no automatic key
fallback, secret replay or generation POST.

A prolonged main-process block can also exceed the utility's 30-second heartbeat
lease and cause backend shutdown. This is an inherited limitation, not a claim
of asynchronous Keychain recovery. Four independent read-only checks with a fake
broker passed; they validate synthetic failure behavior, not real macOS Keychain
prompts, native timing or native acceptance. macOS remains unverified.

## Exact private settings contract

The existing loopback Host/Origin checks, bearer/session authentication, no-store
responses, fixed redacted errors and uncompressed JSON requirement apply. Reads
return the normal `{ok:true,data}` envelope with:

```text
{revision, configuration, secret:{configured,storage},
 storage:{persistentAvailable,sessionScope,reasonCode}}
```

`configuration` has exactly
`{enabled,providerId,connectionId,profileId,baseUrl,model,options}`.
`secret.storage` is `none`, `session` or `persistent`; the implemented
`sessionScope` is `server`. Storage reason codes and limits are unchanged from
[official settings](IMAGE-ACTIVATION.md#private-authenticated-http-settings-contract).

PUT takes exactly `{expectedRevision,configuration,secret}`. For example, this
keyless, disabled configuration illustrates the syntax only; the example host
and model are not verified services:

```json
{
  "expectedRevision": 0,
  "configuration": {
    "enabled": false,
    "providerId": "openai-compatible",
    "connectionId": "custom",
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

Use the current nonnegative safe-integer revision, not an assumed `0`.
`secret` is exactly `{action:"keep"}`, `{action:"remove"}`, or
`{action:"replace",storage:"session"|"persistent",value:<new key>}`. Enter keys
only in the private Images settings UI; never put them in shell examples,
prompts or tool arguments. The update limit remains 16 KiB, key input 1–4096
non-whitespace printable ASCII bytes, private envelope 64 KiB and encrypted
base64 text at most 49,152 characters. URLs on these local routes accept no query.

The initial custom slot is disabled with both `baseUrl` and `model` empty and no
key. Otherwise both fields must be complete, even when disabled. Every successful
save advances that slot's revision. A new review requires enabled, configured
settings; saving or syntax validation performs no DNS lookup, compatibility
probe, model discovery or generation and grants no paid approval.

## Destination and wire profile

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

There are no new public operation names. The `image.generate` request shape and
original receipt shape remain unchanged; `providerId:"openai-compatible"` and
its configured model are additive values. There is no endpoint, connection,
credential or approval override in generation input. Discover `image.profile.list`:
a complete custom configuration adds its profile even when disabled. Availability
is local configuration only, with `offline-tested-not-live` evidence.

For a user-requested custom image, prepare the review with the same public
API/CLI/MCP operation. An illustrative `image-review.json` is:

```json
{
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
  "settingsRevision": 3
}
```

Replace the project, model and revision with the actual selected values. The
positive revision comes from the custom settings UI, not the official slot.
Use `mioon image review prepare --input-file ./image-review.json`, MCP
`image_review_prepare` with that object, or RPC
`{operation:"image.review.prepare",input:<that object>}`. Preparation writes only
a local review. `image.review.get` and `image.review.list` remain read-only.
No CLI/MCP settings, approve/reject or paid Agent tool is introduced.

Backend-created custom review intents use `schemaVersion:2` and retain the full
immutable custom `configuration`, exact destination, complete input, settings
revision and existing one-POST policy. The custom public review DTO adds only
`configuration` to the [existing DTO](IMAGE-ACTIVATION.md#shared-public-review-operations);
it has no public `schemaVersion` field. Official v1 intents/DTOs and historical
serialized receipts remain unchanged. Clients cannot choose an intent version
or inject its configuration/destination. Intent 32-KiB, row 64-KiB and retained
review limits of 1000/project and 10,000/workspace are unchanged. Full prompts,
reviews and nonsecret configuration remain plaintext local SQLite.

The user must explicitly approve the visible exact prompt/project/model/options,
full custom configuration and actual destination in the Images UI. The private
approve/reject request remains `{projectId,reviewId,expectedRevision}`. Approval
reserves the existing task/receipt atomically. Just before any credential/header/
body transmission, the shared synchronous fence rechecks that slot's complete
configuration, revision, enabled/key state and pending writes, commits the
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

Authoritative contracts: `packages/contracts/src/image-compatible.mjs`,
`image-settings.mjs`, `images.mjs` and `image-reviews.mjs`. The
[shared lifecycle](IMAGE-GENERATION.md) and [approval/recovery rules](IMAGE-ACTIVATION.md)
continue to apply. Broader plugin architecture and built-in Agent authority are
unchanged.
