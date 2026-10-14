# WIP checkpoint: atomic loudness application

2026-10-14 UTC. **Not accepted, not a release.**

Tracking issue: https://github.com/starroyhq/mioon/issues/1

This checkpoint preserves 175 reviewed source files on accepted baseline
`f8b91713af0c8ed3994e32fa57447827a0ab3883`, plus this status document.
The original frozen source-inventory SHA-256 is
`c4df88ab68a298363991b067b1e28a8d5b05c971eced9eb596dd5d2ab28f926d`.

## Validation status

- Targeted guard checks: 525 passed. Electron compatibility: 8 passed.
- Native apply, undo, redo, export, close and reopen passed before the
  test-only harness changes. This is not a full-regression pass.
- Standard typecheck on isolated official Node 24.21.0: exit 0.
- Nine-file affected selection on that runtime: 165 tests, 164 passed,
  1 failed, 0 cancelled/skipped; 937.412 seconds; natural exit 1. The gain
  Stop-request scenario exceeded the unchanged 12-second backend-readiness
  limit on its explicit restart. Earlier cancellation assertions passed.
- Latest independent full run was stopped by request at 16:41:08 UTC;
  actual exit 130 and no terminal aggregate. Before stopping, one nested
  inspection-wire CLI termination failure was reported by its wrapper too;
  these are one incident, not two independent failures. SIGKILL was
  observed, but its precise cause was not isolated.

Causal fixture cleanup/restart leaks were repaired and tested. Private
compile-cache and TAP output remain optional. Original assertions and
deadlines remain unchanged. Source-runtime timing variability persists
on Node 24.19 and 24.21; neither a product defect nor an infrastructure-only
cause is established. No further tests or diagnosis are scheduled for this
checkpoint. The issue preserves commands, evidence qualifications and the
remaining acceptance boundary for later human follow-up.

Live databases, runtime tokens, dependency trees, caches, generated builds
and diagnostic bundles are intentionally excluded from this commit.
