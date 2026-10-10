# Recovery without duplicate charges

- `submission_unknown`: acceptance may have occurred. Keep the original job and request. Call `job reconcile`; if the provider cannot find the request, investigate the provider account and bind the verified existing task ID only to its matching local job. Never use `job retry` or a new generation request to guess whether it worked.
- Known provider task, transient poll/download failure: keep polling/reconciling that task. Do not create a replacement generation. Download URLs can expire; the backend refreshes them from the same task.
- Definite `failed`: `job retry` submits a new paid request from the original snapshot, requiring a new request ID and applicable authorization. It is not a free download retry. To change prompt or media, edit/create a shot and make an explicitly authorized new generation.
- `REVISION_CONFLICT`: read the current record, compare it with the user's requested change and merge only that change. Retain unrelated edits. A new intended edit needs its current revision and a new request ID. Do not repeatedly overwrite using stale revisions.
- `IDEMPOTENCY_CONFLICT`: that ID already identifies different input. Recover the original request/outcome first. Do not change the ID until certain you are performing a distinct intended operation.
- Uncertain `reference attach/detach`: replay the exact operation/input with its original request ID and endpoint revisions. Do not infer success from an unrelated generation/export using the same ID. The saved response may be historical after later edits; refresh `project get` before doing anything new.
- `REFERENCE_SELECTION_EXISTS` / `REFERENCE_CONNECTED`: a manual image or typed first-frame connection already owns the target shot's input. Preserve it unless changing it is explicitly intended. Clear/save a manual choice or use revision-safe `reference detach` as appropriate; generic `edge delete` cannot remove typed connections. `REFERENCE_STATE_CONFLICT` indicates inconsistent stored input and fails closed; do not repair it by editing database rows.
- CLI watch timeout / interruption: the job continues. Reconnect and watch the same ID. `job cancel` stops backend local waiting but does not guarantee provider cancellation or refund. Provider work may continue; reconciliation can resume the same task.
- `output_review_required` / `OUTPUT_ASPECT_RATIO_MISMATCH`: the provider completed, but decoded output differs from the requested ratio. Local publication is paused and no version is exposed; the existing task and file are retained. Inspect/reconcile that same task. Its compatibility status is `cancelled`, which does not mean remote cancellation. Do not propose a fresh paid generation as recovery.
- `PROVIDER_DISABLED` / `LIVE_BUDGET_REQUIRED`: check safe capabilities and backend setup. Do not change enable flags or increase caps merely to bypass a block; obtain missing authorization first.
- A provider may have been retired, preview access may be unavailable, quotas may be exhausted, and offline tests do not establish account entitlement. Report the actual blocker; never claim live generation on the basis of mock success.

Stop a bounded watch with a clear pending status and ID when its window ends; continue only within the user's requested monitoring scope. Do not remove service locks, delete job rows, open the SQLite database as another writer, or edit immutable media to recover a generation.

## Local ComfyUI image recovery

For `comfy-local` use the image operations, not video `job reconcile/retry`.
The connector has fixture-only validation; consult its linked guide for the
current full regression gate. No real runtime or GPU compatibility is verified.

- Retain the original generation review/task/key after an ambiguous POST.
  Never reapprove, resubmit or invent a replacement generation key. ComfyUI's
  prompt UUID is correlation, not deduplication.
- `image task remote get` reads existing local evidence without runtime I/O.
  To explicitly query/retrieve the existing execution, use `observeRemote` with
  its current `remote.revision` and a distinct stable observation key.
- After a lost observation ACK, replay the identical request/key/original revision.
  It returns the saved queued ACK without another GET. Read the current local
  remote/task records. `finished` does not imply successful generation; preserve
  errors and `contentVerified`. A later deliberate query needs a new observation
  key/current remote revision after the prior query is no longer active.
- Restart never repeats POST or GET. A missing remote job, timeout or interrupted
  observation cannot establish that generation did not run. Do not clear history
  or reclaim keys. Capacity/ownership failures must be reported, not repaired by
  modifying database rows.
- Terminal success needs the frozen full graph, client UUID, nonce and actual
  execution status. Descriptor/hash/byte count are immutable before local staging.
  After a crash at that boundary, a new explicit observation can only retrieve
  the same verified output; different bytes cannot replace it.
- If an eligible task-bound local receipt/staged PNG already exists,
  `image task recoverResult` uses the original local-only recovery path. It does
  not fetch missing bytes. Neither recovery path authorizes new generation.
- `cancelQueued` only cancels undispatched tasks. Closing the app/panel/client or
  stopping local observation does not cancel ComfyUI GPU work; remote cancellation
  is not implemented.

See [the fixed connector's recovery contract](../../../docs/COMFY-CONNECTOR.md#terminal-evidence-publication-and-restart).
