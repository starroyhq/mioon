# Mioon extensions architecture and catalog plan

Date: 2026-10-10 UTC. Status: **planned; approved for implementation at an
appropriate milestone; not implemented**.
Inspected repository HEAD: `bd76c724de757e68b2683ca7928316a5c4f92174`.
Concurrent image-activation work is outside this document's implementation and
verification scope. This increment adds documentation only, not an SDK, extension
loader, store, installation, external execution or paid-provider authorization.

## Decision and existing foundations

Keep a stable creation/editing core and add bounded extension points around it.
Start with an extensions manager and an official catalog. A third-party registry
and paid marketplace are later products with separate security and operating gates.
Extensions do not block the already available limited Linux trial or the ongoing
image, Agent and editing increments in [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md).
The 2026-10-10 approval explicitly leaves timing to the existing delivery plan:
prioritize current Images and trial usability work, then schedule bounded extension
implementation at a suitable milestone. Do not interrupt that work for an immediate
framework rewrite. This documentation increment does not begin implementation.

Existing shared business services, managed assets, immutable versions, job/render
snapshots, replay/conflict handling and the right dock are reusable foundations.
They are not an extension SDK. Do not generalize all existing providers or rewrite
the application before two concrete extension categories prove the boundary.

The core continues to own:

- Project identity/schema, ownership, revisions, timeline semantics and migrations.
- Original assets, immutable generated versions, provenance and render snapshots.
- Task admission, durable request identity, recovery, cancellation and output import.
- Permissions, trusted approval UI, secret storage, endpoint policy and paid execution.
- UI/API/CLI/MCP business behavior. No extension-specific alternate editing engine.

## Proposed extension points

1. **Connector:** a bounded adapter to an approved external service, including
   capability discovery, request preparation, status and result mapping. The core
   broker controls destinations, approved inputs, credentials and submission.
2. **Processor:** transform explicitly selected managed inputs into new managed
   outputs. Require declared formats/resource limits and a bounded task; never edit
   originals in place. Arbitrary executable processors await the security gate.
3. **Import/export adapter:** parse or serialize a stated format with a capability
   and loss report. The core validates imports and commits approved changes; exports
   use frozen snapshots. No universal lossless round-trip promise.
4. **Workflow skill:** versioned instructions/recipes that propose sequences of
   existing permitted operations. A skill grants no authority, adds no tools by
   itself, and cannot approve spending, uploads, installs or permission changes.
5. **Declarative right-dock contribution:** host-rendered forms, status, comparison
   and result actions described by a bounded schema. No arbitrary JavaScript,
   HTML, iframe, Electron preload, filesystem bridge or secret-bearing field reads.
   The trusted host always owns consent and paid-generation controls.

These are separate contracts. A connector may contribute a dock form, but a UI or
skill contribution must not silently acquire that connector's execution rights.
Extension identity/content is untrusted input, including its labels, descriptions,
recipes, returned errors and model-generated output.

## Manifest, SDK and broker contract

Before implementing a loader, specify and fixture-test a versioned manifest with:

- Stable publisher/extension ID, package version, package digest, license and origin;
  signer/review/revocation metadata when a distribution system exists.
- Manifest/SDK versions, compatible core versions, extension categories, supported
  OS/architecture/runtime combinations, entry points and explicit unsupported cases.
- Required and optional dependencies with allowed versions; installation resolves
  exact versions and digests into a lockfile, including transitive dependencies.
  External runtimes/models are declared prerequisites, never implicit downloads.
- Input/output/configuration schemas, namespaced data-schema version, migration
  compatibility, declared effects and CPU/memory/disk/time/output limits.
- Individually reviewable permissions: project metadata reads, selected asset-byte
  access, proposed writes, approved endpoint/route access, managed output creation,
  and any future process capability. Default is deny; unknown permissions fail closed.

Manifest claims and operation-effect annotations are descriptions, not enforcement.
The host builds execution context from the authenticated user action and granted
capabilities. Extensions cannot self-assert a project ID, trusted caller or approval.

The broker exposes typed operations and opaque, short-lived handles bound to the
extension digest, run, project, selected asset/version, permitted operation and
size limits. It validates ownership and revisions on every access, including
replays. Handles cannot be used to enumerate another project or outlive revocation.
No raw SQLite/database handles, arbitrary SQL, managed-storage paths, generic RPC,
shell, unrestricted filesystem/network client or credential getter are exposed.

Result bytes enter a bounded staging area. Core import validates type, size,
decodability, provenance, request identity and ownership before publishing a new
asset/version atomically. A result never automatically replaces a timeline source.
Retain originals and earlier versions; invalid or partial output cannot become a
successful version. Configuration and extension data remain namespaced, bounded
and core-managed; migrations do not get unrestricted access to project tables.

Network calls use an approved endpoint profile and allowed route templates through
the broker. Bind credentials to that profile; do not hand keys to extension code.
Reject redirects, arbitrary callback/download destinations and private-network
escapes except a separately defined user-selected local connector profile. Apply
the existing connection-destination checks and media limits at the real I/O boundary.

Paid work is prepared as an immutable proposal and approved in the core UI with
exact destination/model/media/parameters and an enforceable spending limit, or an
honest disclosure that a currency limit cannot be enforced. The SDK cannot convert
a count cap into a budget guarantee, bypass existing live gates or approve its own
proposal. Model/skill text and project files never authorize execution.

## Isolation and distribution security gate

A worker process improves fault containment; **process isolation is not a sandbox**.
A same-user executable can otherwise bypass an SDK and read files, credentials or
the network. Package signatures establish origin/integrity, not harmless behavior.
Review and catalog inclusion reduce risk but do not prove a package safe.

Initially admit only individually reviewed, bundled first-party implementations
and bounded declarative data. Keep arbitrary third-party executable code disabled.
Before enabling it on any platform, demonstrate enforceable filesystem/network/
process restrictions, broker-only capabilities, no inherited secrets or ambient
project access, resource limits, secure IPC, permission revocation and adversarial
escape tests. Native binaries, dependency lifecycle scripts and dynamically fetched
code are part of that boundary. Fail closed on unsupported platforms; do not
advertise a cross-platform sandbox from Linux-only evidence.

Review supply-chain integrity, archive traversal/symlink handling, dependency
confusion, vulnerable parsers, SSRF, credential leakage and deceptive consent UI.
Treat external ComfyUI/Blender runtimes as separately trusted systems with their
own permissions; a connector does not sandbox those systems or their custom nodes.

## Versions, upgrades, recovery and removal

- Pin an exact extension/dependency lock to each accepted task and save the SDK,
  data-schema, workflow/configuration digest and selected input hashes with its
  provenance. Record external model/runtime versions when available and explicitly
  mark unknowns. A saved recipe does not guarantee pixel-identical reruns.
- Install/update into a staged slot, validate compatibility and show permission
  changes. New permissions, destinations or data categories require reapproval;
  no silent grant inheritance. No project open triggers an install or network call.
- Switch the active version only after affected tasks finish or the user explicitly
  cancels/drains them. Never hot-swap a running task's implementation. Keep its old
  package available for reconciliation. A revoked/compromised package instead loses
  new dispatch immediately; stop at a safe boundary where possible, retain evidence
  and report any external work whose final state cannot be established.
- Journal intent before dispatch and reconcile a known external task by its saved
  identity after crash/restart. If submission may have succeeded, expose an unknown
  state; do not issue a fresh request or silently repeat uploads/paid work. Cancellation
  does not prove a remote task stopped or that charges were refunded.
- Missing/disabled plugins do not prevent opening the core project, viewing imported
  results or playing an old rendered artifact. Preserve opaque namespaced data and
  explain unavailable controls. Rerun requires the recorded compatible dependency;
  no silent substitution. Existing rendered bytes stay independent of that plugin.
- Before data migration, back up the affected project and extension state, validate
  the candidate and apply transactionally. Restore/forward-compatibility fixtures
  are required. A package rollback is not a generic data downgrade guarantee; block
  unsupported downgrades and offer a verified backup restore with a clear data-loss
  warning rather than rewriting newer data.
- Uninstall revokes future access and removes executable availability after safe
  task handling. Preserve original assets, results, provenance and project data.
  Purging orphaned data/cache is a separate, previewed cleanup approval, never an
  automatic consequence of uninstall or catalog delisting.

## First two proof cases

**First: optional external ComfyUI standard-API connector.** Connect only to an
explicitly selected, already installed/running instance. Begin with one reviewed
minimal text-to-image workflow using known built-in nodes and a fixed input/output
schema. Its declared model/node dependencies must already exist; missing dependencies
produce actionable errors. Do not install ComfyUI, Python, models or custom nodes, launch an embedded
inference stack, or require Blender. A loopback profile must exclude Mioon's own
ports and cannot become a general localhost/LAN proxy.

The two-workflow target is sequential: prove text-to-image first, then add one
reviewed local MiniMax-H3 image-to-video workflow using an explicitly selected
managed first frame. Keep its local model identity separate from the existing
MiniMax cloud API profile. Before that expansion, recheck the exact checkpoint,
ComfyUI/native-node versions, model/dependency licenses (including commercial-use
rights), GPU/VRAM/RAM/disk requirements and supported input/output limits. Pin the
validated configuration and fail clearly when prerequisites are missing; do not
automatically download, install or switch to a hosted model. The official H3 model
card distinguishes open H3-Base from hosted Context-IR and Regenerate-2K components;
the complete official pipeline is not fully open. Local H3 output does not carry a
cloud-quality/2K parity guarantee. Each workflow gets separate acceptance evidence.

Use the documented submission, task-history and progress APIs; pin the submitted
workflow and correlate every event/output to the saved task. Import validated
results through the shared managed-asset/version path. Allow only approved input
uploads and bounded output retrieval. For the first scope, reject arbitrary
workflows, custom nodes and paid Partner Nodes; a local endpoint is not proof that
execution stays local or is free. Do not call a server-wide interrupt on a shared
instance as if it were per-task cancellation. Unknown submission remains unresolved
until task ownership can be established; a WebSocket disconnect is not a retry signal.

**Second: offline cut-list/source-manifest export adapter.** Export a selected
timeline snapshot and bounded source metadata into a documented JSON/CSV format,
through a core-owned output handle, without copying media or exposing absolute
paths. Report unsupported timeline constructs. It needs no network, credentials,
model or ComfyUI fields. This distinct import/export category tests whether the SDK,
permissions, lifecycle and right-dock schema are general without claiming NLE import
compatibility or creating a second editing engine.

## Delivery order and acceptance gates

All stages below are planned and need separate implementation tasks and acceptance
evidence. Ordinary coding within the approved roadmap does not require fresh user
approval for each stage. Third-party installation/execution, hardware provisioning
or access, external access/media transfer, live calls, paid actions and store
publication remain subject to separate applicable authorization.

1. **Manager and official catalog, no third-party loader.** Show available/installed/
   disabled/incompatible states, pinned version, publisher, verification scope,
   permissions, dependencies and task blockers. Keep catalog browsing separate from
   installation/enablement. Acceptance: core editing works with all extensions absent;
   invalid/unknown manifests fail safely; listing/opening makes no execution request.
2. **Broker/SDK and official ComfyUI proof.** Depends on manifest fixtures, scoped
   handles, durable task/result import and reviewed endpoint/media policy. Acceptance:
   synthetic API fixtures prove permission denial, cross-project rejection, exactly
   correlated outputs, crash/unknown recovery, cancelled dispatch and no secret leak.
   Prove the text-to-image workflow before the conditional H3 image-to-video
   expansion; validate managed image/video results and retained originals separately.
   Any later real-instance test requires explicit access/media/execution approval.
3. **Distinct exporter and lifecycle proof.** Depends on stage 2's shared contract.
   Acceptance: both categories use one SDK with different minimal rights; an exporter
   cannot call a connector; update-during-task waits; permission additions pause for
   consent; missing plugin, uninstall, backup/restore and failed migration preserve
   the project and old playable output. Verify each supported OS independently.
4. **Third-party publishing, signing, review, revocation and rollback.** Depends on
   the enforceable security gate, two-category evidence and an operated incident
   process. Add immutable packages, publisher verification, dependency/license review,
   malware/security screening, permission diffs, staged updates and revocation notices.
   Acceptance: tampered/revoked packages cannot start; affected tasks recover honestly;
   rollback follows data compatibility. No community execution before these gates.
5. **Paid marketplace.** Later, with separate commercial/distribution gates:
   seller/payment identities, licensing, billing/refunds, regional/legal obligations,
   support and moderation.
   Installing a paid extension and authorizing that extension's per-use generation
   are separate commitments. A catalog alone is not a marketplace implementation.

Do not add this sequence as a first-trial release gate. Prioritize current usable
image/Agent/editing work; extract shared contracts from the proof cases rather than
building a speculative universal plugin framework.

## Research evidence and limits

Official sources checked 2026-10-10; no source was installed or executed:

- [DeepSeek Harness official page](https://deepseek.com/harness/) demonstrates
  composable tools, skills, UI and plugin management. This informs discoverability
  and lifecycle design; it does not require making Mioon's safety-critical core replaceable.
- [Official repository](https://github.com/deepseek-ai/deepseek-harness) describes
  its Cordis-based plugin architecture and warns of developer-preview breaking changes.
  Inspiration is not an SDK dependency or a promise of Harness binary/API compatibility.
- [Official SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
  states that the project is unaudited experimental software, can expose host resources
  through commands/plugins, and must not be the sole isolation control. Its current
  default branch is `master`; the `main/SAFETY.md` URL returned 404 when checked.
- [ComfyUI server overview](https://docs.comfy.org/development/comfyui-server/comms_overview)
  documents programmatic workflows and notes paid Partner Nodes.
  [Official routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
  document `/prompt`, `/ws`, `/history/{prompt_id}`, uploads/output retrieval and a
  current-execution interrupt. Revalidate the chosen server version before integration.
- [Official MiniMax-H3 model card](https://huggingface.co/MiniMaxAI/MiniMax-H3)
  identifies the open base checkpoints, the Community License and hosted components.
  [ComfyUI's official H3 guide](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)
  documents native image-to-video support and version/model prerequisites, and flags
  commercial licensing. These are planning references, not local execution evidence.

The architectural choices and acceptance gates above are Mioon proposals, not
upstream security guarantees. Read-only source review and documentation checks do
not certify plugin isolation, live provider compatibility or platform readiness.
