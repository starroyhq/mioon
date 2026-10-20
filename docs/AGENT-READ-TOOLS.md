# Bounded project inspection in Agent conversations

Date: 2026-10-09 (UTC). Baseline: `8341029`.

Status: committed as `dbf3b93` after independent acceptance. This stage adds read-only saved
project inspection to both Chat Completions and Responses. It does not add
editing, media perception, generation, shell/file tools, OAuth or live-provider
certification. All acceptance uses synthetic localhost model-shaped services.
The later [reviewed-edit increment](AGENT-EDITS.md) has separate consent and
approval boundaries; this read-only mode retains the scope documented here.

## Explicit scope and limits

The right dock defaults to **typed chat only**. Project inspection is a separate
choice, followed by explicit consent for that send. Consent pins the project,
complete endpoint, protocol, model, settings/conversation revisions, tool schema
version, catalog SHA-256 and limits. Changing any accepted field requires fresh
consent. Opening settings, selecting a mode and reading history do not call a model.

One approved inspection run allows at most **two model requests and one local
read tool call**. The first model can answer without reading, or request one of:

| Model function | Shared business operation |
| --- | --- |
| `mioon_project_inspect` | `project.inspect` |
| `mioon_asset_inspect` | `asset.inspect` |
| `mioon_shot_inspect` | `shot.inspect` |
| `mioon_timeline_inspect` | `timeline.inspect` |

The answer request has an empty tool catalog and rejects further tool output.
There is no third request, automatic pagination, retry, protocol fallback or
model substitution. Ordinary approved reads need no separate per-tool prompt.
Hiding the dock, switching tabs or changing projects can let this already
approved bounded run finish. Stop revokes future steps; it cannot retract data
already sent, guarantee remote cancellation or undo charges.

Only the backend creates project authority and step/request IDs. Arguments have
no project ID, credentials, path, authority or request-ID field. Project/timeline
arguments are exactly `{}`. Asset/shot arguments require `limit` (1–10) and
`cursor` (null or a bounded returned cursor). Duplicate JSON properties, unknown
fields, multiple calls and unknown functions fail before a business read.

The runtime directly uses the same `services.inspection.createContext/dispatch`
boundary used by the external inspection operations, not legacy creating reads
or a new business fork. Existing deep indirect ownership checks and uniform
safe errors remain in force. DTOs omit structural paths, media URLs/bytes,
provider job IDs, snapshots and credential fields. Saved text may still contain
URLs, instructions or sensitive text; it is data, never permission or code.

Tool arguments are capped at 2 KiB. The result envelope is capped at 8 KiB, with
a lower shared-DTO allowance reserving envelope space. Initial text selection
is at most 20 KiB for inspection mode. A combined protocol request can still
exceed its serialized-input limit, for example through JSON escaping or a long
first-round prelude; it fails explicitly instead of silently truncating or
issuing another read. Typed-chat limits remain unchanged.

## Provenance and durable execution

An additive schema-8 migration adds `agent_chat_steps` and immutable-field guards.
It does not rewrite previous conversations or business records. Accepted policy,
selected source-run IDs, exact key-free outbound request bodies and context are
saved before credential acquisition, acknowledgement and the first POST.

Each model dispatch has a backend-created identity and committed boundary before
the gateway runs. A boundary means local dispatch began, not that a provider
accepted or billed the request. Completed output, including exact function-call
IDs and wire artifacts, is persisted before a tool intent can be recorded.

Tool execution has three boundaries:

1. Commit the validated intent and its originating completed model step.
2. Commit a non-retryable dispatch-started marker.
3. Perform the synchronous shared inspection and commit its checked exact result
   in one SQLite transaction, then publish the saved activity/result.

The runtime rechecks the persistent authorization after the first response,
after intent publication, and inside the capture callback immediately before
the synchronous tool effect. A committed revocation at any of these boundaries
prevents the read or proposal and the answer request. Authorization denial
fails only that run; a dispatch-started tool without a result remains unknown
and is never retried on replay or restart.

The next request is reconstructed only from committed artifacts, saved before
dispatch, and compared against the original profile/context and tool result.
Replaying an observed tool returns its saved observation, never re-reads current
project data. A crash or rollback after the dispatch marker leaves an unknown
observation and is never retried. Thus there is at most one observed read for a
run; a crash can produce no committed result. This does not promise distributed
exactly-once inference at the provider.

Startup only marks unfinished runs/steps interrupted or unknown. Lookup,
history and SSE replay cannot acquire credentials, inspect a project or invoke
a model. Stop, storage faults, shutdown and late callbacks retain existing
fences. Events are committed before publication; reentrant Stop during a
published step prevents subsequent steps. Existing storage quotas account for
steps and reserve terminal capacity without deleting replay protection.

Every inspection-mode run retains project provenance, even if the model answered
without a tool. Later **typed-chat-only** sends exclude that entire run from
automatic context. Inspection context may include bounded earlier completed
typed or inspection turns from the same project, with source-run IDs retained.
Reading older history never enlarges this selection. Genuine legacy accepted
typed-chat records remain readable; missing provenance on a new inspection
acceptance fails closed rather than downgrading it to typed chat.

## Both protocols and compatibility

- Chat Completions accumulates one complete `assistant.tool_calls` object and
  requires the expected finish, `[DONE]` and clean framing before admitting it.
  Continuation replays the assistant message and a `tool` message with the exact
  `tool_call_id`. Nonempty refusal combined with a call is rejected.
- Responses validates item/argument events against completed item and response
  snapshots. Output item `id` and function `call_id` stay distinct. Continuation
  preserves the complete output item array and appends `function_call_output`
  with the exact `call_id`; `store:false` remains mandatory. No server-side
  previous-response reference substitutes for local context.
- Incomplete/error/unknown streams, mismatched final snapshots and partial
  arguments never execute. Reasoning output remains unsupported until its
  complete protocol/history semantics are implemented.
- Named profile fixtures cover the existing nine CC and five Responses profiles.
  Controls are profile-specific: undocumented `tool_choice`/parallel switches
  are omitted, while the local single-call limit always applies. Preset support
  means documentation-backed plus mock-tested behavior, not interchangeable
  providers or a live account/model certification. Custom endpoints remain
  editable and retain the existing HTTPS/DNS/IP-pinning policy.

Official references checked 2026-10-09: [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events),
[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/),
[DeepSeek CC](https://api-docs.deepseek.com/api/create-chat-completion/),
[Ollama compatibility source](https://raw.githubusercontent.com/ollama/ollama/main/docs/api/openai-compatibility.mdx),
[Qwen Responses](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses),
[Zhipu chat](https://docs.z.ai/api-reference/llm/chat-completion),
[Kimi K2.6](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart),
[MiniMax OpenAI-compatible API](https://platform.minimax.io/docs/api-reference/text-openai-api),
[OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling).

## UI, privacy and platform boundaries

The shared right dock retains its tabs, collapse/recall, draft guards and inline
settings. Compact status and expandable details replace repeated disclosures.
Each saved run displays its own context provenance and durable model/read steps,
with an expandable inert-text result. Changing the current mode does not relabel
older project-derived answers. Result HTML/URLs cannot become rendered actions.

Sent text, selected project data, tool arguments/results and exact outbound
context are stored in the local application database, **not encrypted by the
credential vault**. The UI warns against entering secrets. No key is stored in
these records, renderer state or logs; credentials remain behind the existing
backend broker. Existing private default directories are reused; Q2 permission,
backup and migration hardening remains separate. No preload API or OS security
relaxation is added. Linux native evidence does not certify macOS/Windows.

## Acceptance

Required: both-protocol actual HTTP tool/result/answer flows; profile fixtures;
four shared operations; malformed/incomplete/foreign tool denial; two-window and
lost-ack replay; exact request/result hashes; no business mutation; no project
provenance in later typed context; Stop and hide/navigation policy; real crash
after intent, after read before result commit, and before continuation; zero
startup read/inference; final serial builds/full suite plus browser/native UI.

### Recorded local acceptance (2026-10-09)

- Full bounded suite: **1084/1084**, zero skips, 115.5 seconds. After the two
  settings-only disclosure corrections, affected renderer suites: **114/114**,
  zero skips. The final independent aggregate run belongs to parent release review.
- Protocol fixtures cover all fourteen current profiles (nine CC, five Responses)
  and actual loopback HTTP on both fixed endpoints. Real child-process SIGKILL
  tests cover both protocols at intent, after read/before result commit, and
  before continuation. Recovery performs no acquisition, read or inference.
- Browser: **10 groups, 16 screenshots**, including all four shared operations
  on both protocols, hostile result text, exact wire/journal hashes, typed-context
  exclusion of project-derived history, draft/tab/collapse/settings/mode retention,
  approved hidden-run continuation, Stop, lost acknowledgement/two windows, and
  restart during the second request. **28 synthetic POSTs**; business records
  unchanged; no live calls.
- Native Linux Electron: **8 groups, 16 screenshots**. Actual CC and Responses
  project reads/answers, Stop before function completion, answer timeout, a
  verified owned-backend SIGKILL after the committed read, recovery and normal
  quit/relaunch. Before/after crash recovery and subsequent app relaunch the
  cumulative POST count remains **9**. One final explicit user-style synthetic
  send then raises it to **11**, with six runs and five committed observations.
  All eleven model-body hashes and all five result hashes match the durable
  journal. Business-domain hash is unchanged; both normal exits are code 0;
  active upstream SSE count is 0. Native screenshot 13 shows interruption;
  12 shows final corrected settings; 15 shows the editing workspace.
- Final serial web build: **9.01 seconds**; desktop build passed. Web and staged
  desktop UI hashes match. Final JS is `index-DqvQTGn1.js`; backend/main bytes are
  unchanged from the full/browser runs. Browser evidence predates only the two
  settings-copy corrections; final native screenshots 12–15 use the final bundle.

Evidence is under ignored `evidence/agent-tools/`: `all-tests-bounded.log`,
`copy-ui-regressions-final.log`, `web-build-copy-final.log`,
`desktop-build-copy-final.log`, `build-manifest.json`, `browser/report.json`,
`native/report.json`, native launch/exit/crash/audit records, and the screenshots.
`source-manifest.json`, `source-sha256.txt` and `screenshot-manifest.json` freeze
review inputs. Screenshots supplement, rather than replace, wire/journal checks.

Preserved attempts: the first browser harness clicked Save while the already
selected CC protocol had no changes; the fixture was corrected to respect the
existing disabled Save control. The first native crash-helper attempt arrived
only after normal stream timeout and safely refused to kill any process. Its
log remains; a second explicit synthetic run exercised the validated active
crash boundary. Old settings-copy screenshots and original build manifests are
retained. Native screenshot 10 has an earlier completed-history viewport; its
filename is not evidence of interruption. Use screenshots 11 or 13 instead.

Limits remain: no live provider/model certification, no reasoning histories,
editing or generation tools, media perception, secret entry, OAuth, or native
macOS/Windows QA. Chat/inspection persistence is local database storage, not
vault-encrypted. No replay tombstone pruning or automatic resume was added.
