# Reviewed selected-shot edits

Date: 2026-10-09 (UTC). Baseline: `2ba58ee`.

Status: implemented with local synthetic runtime acceptance; independent final
aggregate/release review is pending. This is not live-provider verification.

## Scope and consent

The only proposed business operation is `shot.update`, restricted to `title`
and `prompt`. The user chooses a saved shot in the current project, then selects
the explicit `selected_shot_edit` conversation mode. Before accepting the run,
the backend verifies ownership and the saved revision and freezes that shot's
title/prompt. The exact outbound request, selected target and provenance are
durable before credential acquisition or a model POST.

Consent binds the destination, protocol, model, project, selected shot/revision,
schema/catalog and limits. It explicitly includes complete bounded saved shot
text, rather than implying typed-chat-only context. Viewing/selecting a shot or
opening the Agent does not transmit it. Changing the selection or configuration
invalidates unsent consent. Existing typed-only and project-inspection modes
retain their separate authority and context boundaries. Edit-derived history
can never later be relabeled pure typed chat.

Both Chat Completions and Responses use at most two model requests and one tool
call. Responses remains stateless with `store:false`. The first request exposes
only `mioon_propose_shot_update`; the answer request disables all tools. The model
supplies exactly `{title:string|null,prompt:string|null}`. Null means unchanged;
an empty prompt clears it; an empty/whitespace title is invalid. Both-null,
unchanged and oversized proposals are rejected. The model cannot supply IDs,
revisions, request keys, operation names or authority.

Title/prompt limits match the shared contract: 150/5,000 JavaScript string
characters, additionally bounded to 600/20,000 UTF-8 bytes. Tool arguments are
capped at 24 KiB, results at 8 KiB. Malformed, incomplete, unknown or extra tool
calls never create a proposal. Text and tool results remain untrusted data.

## Proposal is not application

A proposal stores immutable original and proposed field values, target revision,
project/run/call provenance, operation, exact patch and a backend-generated
mutation request key. The right dock presents the exact before/after diff and
base revision separately from model prose. Complete outbound saved text starts
expanded; after an explicitly accepted send it can compact into a target/revision
summary with a keyboard-accessible details control. Changing the saved target,
revision, scope or settings reopens the disclosure. Proposal cards retain a
readable review viewport in the default dock, while outer scrolling keeps
consent and the composer reachable. A model claiming an edit happened
does not change the authoritative proposal status.

Approve, Reject and Recover are authenticated user endpoints, not model tools or
MCP/CLI business operations. Approval is allowed only for a matching successful
completed proposal-bearing run. Failed, stopped or interrupted runs cannot be
approved. Stop invalidates unapproved proposals durably. Hidden controls are
not the authorization check; the backend enforces every condition.

Approval binds the immutable digest and target, and is committed with the exact
operation/input/request key before dispatch. Application then calls the existing
shared `shot.update` service through a backend-only project-scoped entry. The
scope check runs inside the same `BEGIN IMMEDIATE` transaction on fresh calls
and exact replay, closing the separate-writer target-reassignment race. That
entry is absent from RPC handlers and discovery. No second editing engine or
async outer database transaction is introduced. Duplicate approval returns the same current outcome;
it does not silently redispatch. Approval versus rejection is atomic. Stale
revision leaves the original diff intact and never rebases or reapproves it.

## Recovery and privacy

Proposal discovery is stored in local SQLite, independent of renderer
sessionStorage and the most recent conversation page. The default paged view
selects unresolved rows before SQL pagination so newer resolved proposals cannot
bury them. An explicit all/history view is also available.

Restart performs only local reconciliation against the shared mutation receipt.
It never repeats inference, creates a proposal, approves or dispatches a write.
A committed receipt proves the exact business response. Without one, an
approved/dispatched outcome remains uncertain rather than being called failed.
Explicit Recover uses the previously approved exact request key/input; it cannot
invent a new key or refresh the original revision. Native app/window recreation
must rediscover this state without relying on the former renderer session.

If an approval response is lost before acceptance and a fresh detail GET still
shows pending, the user can explicitly retry the same approval request. The
proposal, digest and backend request key remain identical; the client never
automatically approves again. Reordered responses cannot downgrade an observed
approved/applied outcome to pending or clear uncertainty using generic HTTP
error status alone.

All reads and actions recheck project/target ownership before returning a saved
record. Proposal/approval journals and original mutation receipts are bounded
and retained; capacity failure must not silently delete replay protection.
The proposal store allows at most 2,048 retained rows and 64 MiB including a
reserved approval allowance. If a retained target is deleted, foreign or
corrupt, its detail/page fails closed rather than omitting the unresolved edit;
repair is required before that page can be read safely.
Saved chat/proposal text is ordinary local database data, not encrypted by the
credential vault. Do not put credentials in prompts or titles. No arbitrary
files, paths, media bytes, tools, generation, spending or provider configuration
is authorized by an edit approval.

## HTTP surface

All routes retain local authentication and Host/Origin checks. Responses use the
existing `{ok:true,data:...}` envelope; errors are bounded safe constants.

- `GET /api/agent/chat/:projectId/edits?view=unresolved|all&limit=1..50&cursor=...`
  returns `{instanceId,projectId,proposals,nextCursor}`. Default view is unresolved.
- `GET /api/agent/chat/:projectId/edits/:proposalId` returns
  `{instanceId,projectId,proposal}` without model access.
- `POST /api/agent/chat/:projectId/edits/:proposalId/approve|reject|recover`
  accepts exactly `{instanceId,digest}` and returns the detail envelope. The
  request body is capped at 1 KiB. IDs in the route and current server epoch are
  checked; fetching a new epoch after restart does not grant a new approval.
  The renderer bounds streamed JSON responses to 4 MiB before strict UTF-8/JSON
  decoding, then validates and projects the proposal envelope.

These routes are deliberately absent from generic business RPC, MCP tool
discovery and CLI operation aliases. External clients retain their existing
explicitly authorized shared `shot.update` contract and optional replay key.

## Acceptance gates

Required before release: both protocol mock HTTP/SSE flows; immutable diff and
no preapproval write; two-window approval/rejection races; stale revisions;
altered digests and scope; dropped acknowledgements; process crashes around
approval/dispatch/domain commit; receipt-only startup; rejection/Stop/late
callbacks; typed-only context exclusion; read-only unresolved pagination;
renderer reload and actual native app recreation; final serial builds, bounded
full suite, source hashes and runtime screenshots. Test counts and final status
are recorded only after those checks finish. No live calls or real credentials
are authorized; Linux testing does not certify macOS/Windows native readiness.

## Recorded local verification (2026-10-09 UTC)

- The pre-layout aggregate passed 1,309/1,309. After the narrow disclosure/layout
  correction, 120 focused UI tests passed and the final bounded aggregate passed
  1,313/1,314 with zero skips. Its sole failure was the unchanged official-MCP
  export test: FFmpeg exited with a null code and empty stderr. The exact test
  passed unchanged in isolation (actual three-shot export; 217 SDK messages).
  This final aggregate is **not** recorded as a full pass; independent serial
  aggregate acceptance remains the release gate. No unrelated FFmpeg behavior
  was changed to hide the unproven process termination.
- Both fresh web and development-desktop builds passed serially. The staged
  desktop web tree is byte-identical to the browser tree. Final served assets:
  `index-BvLko4-q.js` and `index-C0iThKkj.css`. Existing use-client/source-map and
  bundle-size warnings remain; no installer or platform certification is implied.
- Final cloud-browser acceptance passed seven grouped checks with ten screenshots:
  both native protocol flows, explicit consent and unapplied proposals, approved
  shared writes, preserved unsaved Inspector text, rejection, stale revision,
  lost acknowledgement resolved by GET, backend restart/reload, Stop/late output,
  typed-history isolation, bounded review viewport and keyboard disclosure.
  Its synthetic session made 13 model requests, with two Agent writes and one
  separate manual Inspector save; unrelated domain tables remained unchanged.
- Ordinary sandboxed Linux Electron passed five grouped checks with 17 screenshots.
  The original app/renderer exited normally. A separate owned real HTTP backend
  was killed after durable approval, before dispatch. A newly created ordinary
  app discovered the original pending and approved-unknown proposals, making zero
  model requests or domain writes. Explicit Recover reused the approved exact
  key for the second shot while the first shot remained selected; separate
  approval then applied the original pending first-shot proposal. Exactly two
  mutation receipts were added, unrelated tables stayed unchanged, all mock SSE
  streams closed, and the recreated app exited with code 0.

Evidence: `evidence/agent-edits/` contains preserved first-copy assertion failures,
the pre-layout full pass, the final aggregate failure and isolated MCP retry,
build logs, browser/native reports, source/build SHA-256 manifests, complete
synthetic wire captures and read-only database audits. The native preparation
uses `tests/agent-edits-qa-prepare-unknown.mjs`; browser/native launch fixtures
are `tests/agent-edits-qa-runtime.mjs` and `tests/agent-edits-qa-native.mjs`.
Supported-CUA browser scenarios live in `tests/browser_agent_edits.mjs`.

The first native recovery click occurred while a scroll was settling and hit an
inert heading; the preserved observation showed unchanged unknown state. A fresh
screenshot identified the actual control before successful explicit recovery.
Screenshot 09 shows unknown state, 14 the pending immutable diff and approval,
and 15 the confirmed applied diff beside the updated canvas. Audit records, not
screenshot filenames alone, establish recovery and exact-once outcomes.

An early protocol-test fixture supplied `request` instead of the transport's
`httpsRequest`/`httpRequest` injection keys. The default HTTPS transport attempted
TCP to the fixture's public test address `8.8.8.8:443` and failed with
`ENETUNREACH`; it is not a reserved IP. No successful connection was observed.
The transport defers HTTP headers/body until verified TLS connection, so the
observed failure preceded HTTP or synthetic-credential transmission according
to the error and code ordering, not a packet capture. The failed output survived
only in the execution transcript. The corrected injection preceded all final
mock suites and graphical acceptance; no real credential was involved.
