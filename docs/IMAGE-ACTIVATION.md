# Images activation: settings and reviewed dispatch

## Current increment: 2026-10-10

Dedicated Images settings, retained review preparation, the authenticated UI
approval flow and a one-POST OpenAI gateway are implemented in this checkout.
The 461-test affected gate, fresh web/desktop builds and Linux native acceptance
with an isolated synthetic-network backend passed. The first independent full
suite found one shared-control reuse omission (2756 total, 2753 passed, one failed,
two skipped). The shared Label/Input correction passed 72 focused tests, a fresh
build and final Linux native label/Space/Tab verification. The final independent
full suite passed: **2758 total, 2756 passed, 0 failed, 2 skipped**, exit0,
670,585.395827ms. This is not live-provider, macOS or Windows acceptance.
No real provider call is authorized for this acceptance increment: network
validation uses synthetic dependencies and fake credentials only.

The earlier Mock slice and its dated evidence remain in
[Image generation](IMAGE-GENERATION.md). Its schema-16/native/full-suite results
do not establish acceptance of this schema-17 activation increment.

## Fixed scope and everyday use

Images has its own settings page and credential. The only live preset is:

- Provider `openai`, profile `openai-images-v1`
- Base URL `https://api.openai.com/v1`
- Exact destination `https://api.openai.com/v1/images/generations`
- Pinned model `gpt-image-2.5-flare-2026-09-08`
- Exactly `size: "1024x1024"`, `quality: "low"`, `outputFormat: "png"`,
  `background: "opaque"`, `n: 1`

The model and options are unchanged from the first adapter slice. Official
sources were rechecked on 2026-10-10: the
[model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
lists the pinned snapshot, and the
[Images generation reference](https://developers.openai.com/api/reference/resources/images/methods/generate)
documents the request fields. The adapter also fixes `moderation: "auto"`;
this is not a caller override. Source review does not establish account access,
live output or actual charges. Discovery
continues to label provider evidence `offline-tested-not-live`; an enabled
profile means local configuration is available, not verified model access,
current pricing or successful live output. The default configuration is disabled.
Mock remains a visibly labeled deterministic local PNG, never a silent fallback.

The user configures and enables Images once, then explicitly clicks the visible
paid-generation button for each exact request. The composer shows the selected
project, original prompt, fixed model/options, destination, one-POST ceiling and
usage-based unknown cost. The click prepares the immutable review and approves
that same request while the same view and configuration remain current. Submitting the composer with Enter or its shortcut cannot stand in for this
paid button; keyboard activation of the focused paid button is an accessible
explicit confirmation. A changed/hidden
view, project or settings interrupts that continuation and requires an explicit
review action. External prepared requests appear in the review list with their
complete prompt and configuration for explicit approval or rejection.

There is no per-image currency-budget wizard. `maxPostAttempts: 1` is an attempt
bound, not a currency cap or price quote; fees may be charged even if the local
result is unknown. Saving/enabling settings alone sends no prompt, probes no
provider and grants no standing generation approval. A real live canary still
requires a separate approval covering its exact configuration, prompt/media
scope and fees. It is not part of synthetic acceptance.

Custom compatible endpoints remain follow-on work. The dedicated credential
route is now implemented; custom hosts, reference uploads, edits/masks, batches,
seeds, variable sizes, model fallback and automatic image-to-video remain outside
this increment. Agent/video settings and credentials cannot enable Images.

## Dedicated settings and secret boundary

The settings engine is the backend/desktop utility's owner of the Images
configuration, revision and session credential. It does not reuse an Agent or
video key, discover an environment key, or accept an arbitrary endpoint.

- Web mode supports only explicit session storage. Here a session is one backend
  process lifetime, not one browser tab or login: browser reload does not clear
  the key, but backend shutdown/restart does. The nonsecret settings survive.
- Electron main supplies a narrow OS codec over the owned utility channel. Only
  fixed `status`, `encrypt` and `decrypt` messages for the Images namespace and
  exact preset binding are accepted. Main does not own a second Images settings
  engine. The renderer/preload has no decryption API or arbitrary secret proxy.
- Persistent storage requires the user's explicit choice and available secure
  OS storage. Unavailable storage and Linux `basic_text` fail closed; there is
  no plaintext-file fallback. Session-only storage must be selected explicitly.
- The dedicated private settings envelope contains nonsecret configuration and,
  only for persistent storage, OS-encrypted credential bytes. It uses the existing
  ownership, symlink, bounded-file and atomic-publication protections. Plaintext
  credentials are never saved to project SQLite, prompts, chat or logs.
- The API key field is write-only. Read results contain only `configured` and
  storage metadata; no key echo or secret-bearing errors. The UI clears unsaved
  key input on hiding, leaving or changing projects, and clears it at submission.
  Replacement plaintext is not retained in browser storage or recovery state.
  After uncertain saves the UI rereads redacted settings; it does not replay the
  secret update automatically. Replacing a key again requires fresh input.

Every successful settings save advances its revision, including an enable toggle
or a keep-secret save. A review binds that exact revision. Disabling Images,
removing/replacing the key, saving settings, or an admitted but unfinished
settings write invalidates stale dispatch authority. Acquiring a credential is
not itself authorization to send.

### Private authenticated HTTP settings contract

These routes use the existing loopback Host/Origin checks and local bearer token
or HttpOnly session-cookie authentication. They are absent from RPC, CLI, MCP and
model-tool catalogs. Responses use the normal `{ok:true,data}` envelope, no-store
caching and fixed redacted errors. Settings input must be JSON without compressed
content and is limited to 16 KiB; credential input is 1–4096 non-whitespace ASCII
bytes. URLs accept no query arguments.

- `GET /api/images/settings` returns
  `{revision,configuration,secret:{configured,storage},storage:{persistentAvailable,sessionScope,reasonCode}}`.
- `configuration` has exactly
  `{enabled,providerId,profileId,baseUrl,model,options}` with the preset above.
- `PUT /api/images/settings` takes exactly
  `{expectedRevision,configuration,secret}`. `expectedRevision` is a nonnegative
  safe integer. `secret` is exactly `{action:"keep"}`, `{action:"remove"}`, or
  `{action:"replace",storage:"session"|"persistent",value:"..."}`. Do not put a
  real credential in an agent prompt, shell command, fixture or documentation.
- Returned secret `storage` is `none`, `session` or `persistent`.
  `sessionScope` in the implemented server/desktop route is `server`.
  `reasonCode` is `null` when persistent storage is available, otherwise
  `WEB_SESSION_ONLY`, `OS_SECRET_STORE_UNAVAILABLE` or `LINUX_BASIC_TEXT`.

Schemas: `packages/contracts/src/image-settings.mjs`. Implementation:
`packages/business/src/images/settings.mjs`, `settings-file.mjs`,
`apps/server/src/image-http.mjs` and the desktop `image-secret-*` modules.

## Shared public review operations

Exactly three review operations join the existing shared business/API/CLI/MCP
catalog. Strict schemas reject extra fields, including approval flags, secrets,
URLs and execution instructions. The complete nested generation input retains
its original strict schema and required stable `requestId`; there is no second,
top-level request ID.

| Operation | Exact input | Result and effect |
| --- | --- | --- |
| `image.review.prepare` | `{input:<complete OpenAI image.generate input>,settingsRevision:<positive safe integer>}` | Retains a pending review of that exact request/configuration; local database write only, no approval, task, provider call or charge |
| `image.review.get` | `{projectId,reviewId}` | Existing owned review DTO; read-only, missing/foreign reviews fail closed |
| `image.review.list` | `{projectId,limit?,cursor?}` | `{projectId,items,nextCursor}`; bounded, read-only project page |

Preparation requires enabled, configured current settings for a new review.
Exact repeat preparation returns the same review identity with current retained
state, even after settings changes/restart/rejection/dispatch. Changing the
request, project or settings revision under its key conflicts. A request key
already used by the image mutation journal cannot prepare a new review.
Preparation and reading do not approve or queue generation.

The review DTO has exactly:

```text
{id, projectId, requestId, input, inputHash, settingsRevision, destination,
 policy, state, revision, taskId, postAttempts, createdAt, updatedAt,
 approvedAt, rejectedAt, dispatchedAt}
```

`input` is the complete original generation request; `inputHash` is its canonical
SHA-256. `policy` is exactly
`{maxPostAttempts:1,automaticRetry:false,price:"usage-based-unknown",promptStorage:"local-plaintext"}`.
IDs are UUIDs, timestamps are ISO date strings, `taskId` and action timestamps
are nullable. The state progression is `pending` (revision 1) to `approved`
(revision 2) to `dispatched` (revision 3), or `pending` to `rejected` (revision 2).
`approved` reserves one task. `dispatched` records one fenced POST attempt; it
does not prove remote receipt, completion or a particular charge.

Lists default to 20 records, maximum 50; cursors are at most 768 characters and
bind operation/project/limit. Use only the returned cursor unchanged. Cursors
expire across backend restart and pages are not a frozen snapshot.

The original generation input is still capped at 24 KiB, including the existing
2000 UTF-16-code-unit/8000 UTF-8-byte prompt limits. The new complete immutable
review intent is capped at 32 KiB and review rows at 64 KiB. Retained reviews
are capped at 1000 per project and 10,000 per workspace. At capacity, new
preparation fails before insertion; existing reviews are not evicted. Reviews
and prompts are plain local SQLite, visible to authenticated local readers and
potentially present in backups. There is no review cleanup/compaction route.

`image.review.prepare` declares `readOnly:false`, `idempotent:true`,
`databaseWrite:true` and all of `destructive`, `openWorld`, `fileWrite`,
`externalIO`, `localProcess`, `paidGeneration` false. Get/list are read-only,
idempotent, non-destructive and have no write/external/subprocess/paid effects.
`image.generate` now conservatively declares possible external I/O, open-world
and paid generation, plus local database/file writes, to cover separately
approved worker activity. Direct new OpenAI `image.generate` remains blocked
without the private review approval; old accepted exact replay never reschedules.
No effect annotation grants permission to act.

Schemas: `packages/contracts/src/image-reviews.mjs`; authoritative effect map:
`packages/contracts/src/operation-effects.mjs`.

## Private approval, dispatch and recovery

`POST /api/images/reviews/approve` and `/reject` take exactly
`{projectId,reviewId,expectedRevision}`, with a positive review revision, as
JSON up to 1024 bytes. Approval returns the existing generation contract's
original queued task receipt; rejection returns the retained rejected review.
These are authenticated application actions, not public RPC/CLI/MCP/model tools.
Authentication is not cryptographic proof of a physical human click: a holder of
the local token/session must still respect the user's authority and cannot treat
route access as permission to approve. There is no arbitrary executor, approval
flag on `image.generate`, or paid Agent authority.

Approval reserves the exact request and task together in the existing SQLite
acceptance transaction. The request's prompt is sent unchanged; configuration,
review identity and task ownership are rechecked. Immediately before the first
possible HTTP header/body transmission, the gateway synchronously checks the
current settings revision, enabled/key state and pending settings writes, then
commits the review/task dispatch fence in one synchronous boundary and calls
network `end()`, with no intervening await. A changed or in-flight save blocks
that old request before transmission. DNS/TLS setup precedes this final fence;
the credential and prompt do not.

The gateway permits the fixed HTTPS destination only. DNS answers must be public,
the TLS peer must match the pinned address/hostname, and the transport does not
follow redirects, proxy/environment settings or retries. At most one POST
attempt is recorded per approved review, even if connection loss or shutdown
leaves the outcome unknown. Prompt rewriting and model/provider fallback are
not allowed. Output still goes through the existing bounded PNG validation,
managed asset publication and immutable image-version workflow.

Retain the complete original request and stable key after an uncertain approval.
Read `image.request.get`, then the current task and review; do not automatically
approve again, retry, change keys or submit a replacement. Browser reopen,
backend restart, history reads and review preparation replay cannot dispatch.
Restarted undispatched tasks stay `interrupted_before_dispatch`; dispatched
work without durable output evidence stays `outcome_unknown`. The review's
state is an approval/attempt record; task state describes the local outcome.

`image.task.cancelQueued` remains explicit and undispatched-only, with no remote
cancel/refund promise. `image.task.recoverResult` may only validate/publish an
existing task-bound local receipt and staged PNG; it never generates again or
fetches a missing provider result. Existing mutation receipts and exact recovery
semantics are unchanged. Unknown work without a valid local result stays blocked.

## Migration and validation boundary

Schema 17 adds only `image_reviews`, its page index and identity/state/task-binding/
retention triggers, in one migration transaction. It does not rebuild old tables,
rewrite old serialized bytes, renumber sequences, manufacture reviews for old
Mock tasks, or discard history. The schema-16 image tables and earlier records
remain the historical source of truth. Rollback requires a compatible backup,
not manual deletion of review guards.

The final affected serial gate passed 461/461 tests, with zero failures/skips,
in 47.37 seconds on 2026-10-10. Fresh web/desktop builds passed. Focused coverage
includes settings isolation/atomic storage, desktop namespace and vault failure,
strict contract/effect parity, review ownership/replay/capacity/immutability,
additive migration and rollback, synthetic DNS/TLS/one-POST/settings-race gates,
and visible UI approval/interruption/recovery.

### Linux native acceptance: 2026-10-10

The unmodified built main/backend/web production-code path passed its default-disabled,
unconfigured smoke with exit 0 and zero image rows. Both native fixtures used the
`app.starroy.mioon.dev` development channel, not a production-channel release.
Paid-path acceptance used an isolated test copy: main and web artifacts were
hash-identical to that build, while only the backend's trusted DNS/HTTPS dependencies were
replaced with synthetic fixtures. There is no product activation/test flag.
Two complete synthetic application lifetimes ended with exit 0.

- One explicit visible paid-button action retained the exact original prompt and
  published a real validated managed PNG asset and immutable V1 from the fixture.
- External CLI preparation created three pending reviews without a generation
  POST. Explicitly approving one created the second synthetic POST, whose response
  was deliberately held; rejecting another caused no POST. A pending review was
  retained without approval.
- Orderly exit left the held attempt `outcome_unknown`. A complete application
  reopen retained all audited business rows and media bytes without another POST.
  The pending approval was disabled because the backend-lifetime session key had
  gone; it was not recovered from browser or project storage.
- Explicit local result recovery with no durable result was refused without row/
  media changes or another POST. It did not recreate or fetch a missing image.

The observed total was exactly two synthetic POST attempts, not two live OpenAI
calls. These results establish native UI/business/restart behavior under the
stated fixture boundary; they are not a network-capture claim, native OS-keychain
certification, provider-output validation or proof of real fees/model access.
macOS/Windows native and real-provider acceptance remain unestablished. The
independent final full suite passed with 2758 total, 2756 passed, 0 failed and
2 skipped, exit0, 670,585.395827ms. The earlier failed 2756-test aggregate is
retained separately; the earlier baseline's full pass was not used as this
increment's release gate.

Local acceptance evidence is retained under `evidence/image-activation/`:
`affected-final-fixed.tap`, `build-final.log`, `build-artifacts.sha256`,
`native/bundle-equivalence.json`, `native/verification.json`, launcher/audit logs,
`build-control-final.log`, `native/control-fix-verification.json`, and screenshots
01–19. The final build changes only ImageSettings shared-control composition;
main/backend/CSS remain byte-identical. The complete earlier synthetic dispatch
flow is reused under this source/artifact equivalence. Final native runs verified
the changed control and rediscovered the same records/output with two total
synthetic POSTs and no additional submission. Representative earlier captures show the
[unaltered production default](../evidence/image-activation/screenshots/01-production-unconfigured.png),
[exact paid consent](../evidence/image-activation/screenshots/05-synthetic-exact-consent.png),
[managed result](../evidence/image-activation/screenshots/06-synthetic-paid-result.png),
[restart-disabled approval](../evidence/image-activation/screenshots/10-restarted-approval-disabled.png),
and [refused local recovery](../evidence/image-activation/screenshots/14-local-recovery-refused-no-repost.png).
The final-build [review and output](../evidence/image-activation/screenshots/18-final-synthetic-review-and-output.png)
and [session-expired settings](../evidence/image-activation/screenshots/19-final-synthetic-settings-session-expired.png)
remain explicitly synthetic-backend evidence, not live OpenAI results.
These local evidence files may not be included in a source checkout. Final
release-gate status is recorded separately in `STATUS.md`; pending checks are
not described as passed.
