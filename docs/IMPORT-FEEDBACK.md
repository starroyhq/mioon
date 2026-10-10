# Batch import feedback

Updated: 2026-10-10. Baseline: `c8a30f21cfcff0c43522025feafc14cd6820ab8e`.

## Scope

The renderer imports selected files sequentially and stops at the first error. Its result now separates confirmed imports, the current rejected/unconfirmed file, and files never attempted, with human-readable filenames. This is feedback and lifecycle fencing; it adds no import journal, idempotency key, automatic retry, or backend/schema change.

- Confirmation requires the existing successful RPC envelope and an asset identity matching the selected project, exact filename and normalized MIME type.
- A local validation/read error is labelled **not submitted**. A structured HTTP 4xx rejection is labelled **server rejected** using the transport's status/definitive fields, not an error-message guess.
- A disconnect, HTTP 5xx, invalid envelope, or invalid asset acknowledgement is **unknown**: the asset may already exist. Check the asset list first; do not select the entire batch again blindly. Importing a file again can create another asset.
- Counts remain exact. Each category shows at most three names, each bounded to 64 Unicode characters with control/bidi characters removed; extra names are counted explicitly. Error details are bounded to 160 characters and rendered as text.
- A newer selection, navigation or unmount fences late notices/input cleanup and prevents further files in the old batch from being submitted. An already sent import can still complete. Busy imports are never queued or retried automatically. The existing visible/non-dragging 2.5-second project refresh, or visibilitychange refresh on returning, discovers saved assets independently of the superseded callback; the old result cannot replace the newer notice/input.
- Feedback belongs to the current renderer session. Closing/recreating the app does not restore this notice or prove an ambiguous import outcome; inspect saved assets.

## Verification

The pre-fix regression extracts and runs the actual `App.importFiles` function: valid/broken/valid submitted two files, confirmed the first, but omitted the rejected filename and untouched third filename. Its failing log is retained in local evidence.

Focused regression: 27/27 passed, including actual App-function lifecycle fences and three real loopback HTTP transport cases. Independent review repeated all 27 successfully. Adjacent App/UI/renderer checks: 619/619 passed, 0 skipped (17,045 ms); this includes the 27 and is not an additional independent aggregate. Seven later test-only regressions execute the actual polling effect and refresh for successful/unknown superseded requests; final focused suite: 34/34 passed, 0 skipped. Production was unchanged after the 619-case check.

Fresh development build passed. The unmodified Linux desktop imported an ordered valid/broken/valid synthetic PNG batch: one confirmed asset, one server rejection, one unattempted file, with all names visible. Two complete native process lifetimes exited normally; the sole asset ID and byte hash survived recreation unchanged. The malformed temporary file was removed. Native acceptance covers real local decode/rejection and restart; forced transport loss is tested separately over loopback HTTP. No live generation or user media was used.

Parent independent full-suite release gate passed with actual process exit 0: **3,133 total / 3,131 passed / 0 failed / 2 skipped**, 655,025.711395 ms. Build/source hashes and original screenshots are retained in local evidence; screenshot 03 shows the partial-import outcome and screenshot 05 shows recreation.

The five uncompiled Windows NTFS proof files are unrelated, frozen and excluded from this slice. Windows execution remains blocked by its current PowerShell policy; this change makes no Windows readiness claim.
