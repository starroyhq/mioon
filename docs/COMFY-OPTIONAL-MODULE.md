# Optional official ComfyUI connector admission

Status: implemented with bounded synthetic acceptance, 2026-10-15. This increment is a fixed first-party
startup composition seam, not an extension store, dynamic loader, sandbox, model
installer, or real ComfyUI/GPU compatibility acceptance. See
[the existing connector](COMFY-CONNECTOR.md) and
[extension boundaries](EXTENSIONS-ARCHITECTURE.md).

## Fixed composition and local status

The host may construct the bundled reviewed connector once (`load`, default),
leave it unconstructed (`skip`), or explicitly compose a distribution without it
(`not-provided`, trusted backend/distribution argument only). No runtime hot swap
or unload is supported. The source still statically imports the reviewed factory;
this increment does **not** shrink the distribution or claim lazy code loading.
The ~63 KB existing connector source is not a bundled Python/model stack.

The supported launcher opt-out is `MIOON_COMFY_MODULE=skip`. The ordinary server
launcher and desktop utility read it at startup; the desktop forwards only this
fixed value through its existing environment allowlist. `load` or an absent value
keeps the default. Unknown values fail startup rather than selecting code. No
RPC, settings document, project, manifest, URL or user-controlled import path can
select an implementation. `not-provided` is not an environment value: it describes
trusted distribution composition, not an invented missing-package claim.

`GET /api/images/comfy-availability` is an authenticated local read after the
existing Host, Origin and session/token gates. It makes no external request and
returns the strict shape below inside the ordinary `{ok:true,data:...}` envelope:

- `schemaVersion: 1`, `connectorId: "mioon.comfy-local"`,
  `implementationVersion: "1"`, `fixedForSession: true`.
- State/reason pairs only: `available`/`ready`,
  `not_loaded`/`startup_not_loaded`,
  `not_provided`/`distribution_not_provided`.

`available` means only that this process constructed the reviewed implementation.
It does not assert a running external service, installed checkpoint, node safety,
free/offline execution, or successful generation. The implementation version is a
current-session descriptor, not newly invented provenance for historical tasks.
The fixed workflow/profile identities retained in old records are unchanged.

The endpoint has no write method. Existing Comfy settings and connection checks
remain HTTP-only; they are not added to CLI/MCP/Agent administrative authority.
Existing static RPC/MCP schemas remain discoverable even when the module is absent.
The shared backend makes the runtime admission decision. No dependencies, lockfile,
runtime bundle version, schema number or historical record format change.

## Settings are not module authority

`configuration.enabled` keeps its original meaning: permit preparation/approval
of **new generation** when all other checks pass. Turning it off does not cancel
remote work, deny explicit observation of an already frozen run when the module is
available, or delete results. It is not silently repurposed as a full network kill
switch. Module availability is a separate lifecycle-fixed host decision.

The Comfy tab displays availability and saved configuration. Missing or unreadable
availability disables new connection checks, preparation, approval and new remote
observations. It does not hide existing images, task details, original review
metadata, local recovery, or the editing/export core. Saving a local configuration
is still local-only and cannot load a module or contact ComfyUI.

## Durable recovery and missing modules

The core still owns projects, image reviews, request receipts, remote journals,
settings CAS, endpoint policy, history, managed output validation and asset bytes.
An unavailable connector rejects **new** check/prepare/submit/observe with
`COMFY_MODULE_UNAVAILABLE` (503), before any durable admission or external I/O.
Previously accepted exact requests are checked **before** availability: their
original generation/preparation/approval/observation acknowledgements still replay
without rescheduling work. Changed reuse keeps the existing conflict behavior.
An observation proven not accepted may return the existing exact
operation/project/task/request/input-hash bound nonacceptance proof after rollback;
a generic unavailable/network error is not such a proof.

Startup performs only existing local reconciliation. It cannot infer remote
completion, cancel GPU work, regenerate, retry a POST, swap providers, or fetch
results because a module is missing. Unknown remote outcomes remain unknown.
Local-only staged-result recovery is still independent of the connector. Imported
original images, retained versions and already rendered outputs remain core-owned
and available for preview/timeline use/export. Opening or restoring a project
cannot automatically install, load, download or execute an external runtime.

## Verification scope

The frozen implementation passed a deduplicated **1,277/1,277** scoped regression run
(zero failures, cancellations or skips), including synthetic business/protocol,
UI/settings, desktop environment/security and native-close source tests. A later
test-only addition exercises the actual CLI: unavailable preparation exits with
code 4 without adding any review/task/receipt/journal rows, while exact generation
and observation receipts replay in both unavailable modes with zero fixture I/O.
The entire updated HTTP/CLI/MCP file independently passed **7/7**. These overlapping
runs are not added together or presented as a full release-suite result.

Normal type checking, the public contract consumer check and the frozen production
build passed. A production Linux unpacked package was built from the existing
local Electron distribution, without downloading a runtime. All 607 production
source files remain equal to the final freeze; the late narrow client classifier
change only accepts an exact request-bound module-unavailable nonacceptance proof.
Missing, mismatched or wrongly status-coded proofs retain conservative uncertainty
and never cause an automatic retry. Independent review found no blocking defect.

The frozen production **Linux native acceptance passed** using the supported
native UI, with no browser substitution or debugger injection. A completed
synthetic Comfy PNG and unresolved remote task survived normal close and reopening
the same workspace with `skip`. Settings showed the module was not loaded while
the independent allow-new-generation setting remained enabled. New connection
checks, complete-draft preparation and unresolved-task observations were disabled;
old images, completed/unknown task details and frozen identities remained readable.
All seven image-history tables retained their exact raw cell values, and original
PNG bytes, saved configuration and timeline were unchanged. The disabled session
made **zero** additional requests to the owned literal-loopback fixture.

Native timeline preview and export both succeeded at 1280×720, 30 fps, 90 frames
and 3 seconds. Preview playback visibly reached its end. Both files fully decoded
successfully and had identical output and first-frame hashes. Both owned desktop
processes exited normally with code 0, no signal, and the workspace lock released;
no security fuses or sandbox controls were changed. Source and package hashes were
unchanged throughout. This proves the bounded synthetic fixture flow, not global
network tracing or compatibility with an actual external ComfyUI runtime.

An optional source Node connection-discovery probe rejected before HTTP with
`CONNECTION_CONFIG_ERROR: Desktop backend is not running` while the native window
was visibly running. Its cause is **not established**; the probe was not retried
or used as acceptance evidence. Native UI, exact storage comparisons, owned
fixture counters and complete media decoding independently establish the required
flow. This limitation is preserved rather than reclassifying it as a proven cause
or investigating the previously stopped startup/timing issue.

This increment tests reopening the same workspace, not an actual backup-to-restore
round trip. The existing restored-workspace branch intentionally does not construct
the image service or Comfy HTTP routes; its guarded behavior is unchanged. No new
backup/restore acceptance is claimed. macOS/Windows, a real ComfyUI/GPU/model,
third-party code isolation, package size savings and full release readiness remain
outside this increment. Previously stopped or deferred issues were not reopened.
