# Independent frozen-evidence review

Reviewed the uncommitted dormant40/41 compatibility slice against base
`f6caf840114ca4e1431012a358cca9e8ed5cb8fd` on 2026-10-15.

## Outcome

Bounded approval for this dormant40/41 role/colour frozen-receipt adapter.
No remaining blocking issue was found in the final reviewed source. This is not
approval for activation, live processing, admission, render/media safety, or an
authentication claim about imported receipt authorship.

The review found and independently reproduced an export-owner projection bypass:
a physical export owned by a short project ID was projected to a null owner and
could select a frozen receipt for another valid project. Both feature paths and
both ordinary validation/classification accepted it before the fix, without
schema or foreign-key bypass. The final helper now requires physical owner
equality for every export, including a null bounded projection. Short TEXT,
foreign UUID and BLOB owner regressions pass for both features. The owner tests
use no-envelope receipts to isolate this guard rather than depend on envelope
scanner rejection order.

## Source conclusions

- Only explicit dormant40/41 call sites select the new option. Source38 preflight
  and historical38/39 retain the original SQL and current-cache branches.
- Only actual original clips in a complete root render receipt receive frozen
  bindings. Nested/partial wrappers cannot authorize them; strict original
  envelope validation precedes the historical render projection check.
- Current assets supply existence and project ownership only. Frozen MIME/hash
  remain the source for role/colour checks; retained LUT ownership, hash and
  profile checks remain active. Hidden clips are not exempted.
- Original JSON is not mutated or persisted. Decoded duplicate keys are rejected
  before JSON.parse; original wrapper/receipt and traversal limits remain bounded.
  No-envelope wrappers retain their historical budget, while envelope-present
  wrappers retain the 256 KiB cap.

## Independent verification

Pinned runtime: Node v24.21.0, binary SHA256
`7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.

1. Initial combined run: 154/154 pass, including
   `workspace-frozen-evidence-v40.test.mjs`, `workspace-schema40-dormant.test.mjs`,
   `workspace-volume-envelope-validation.test.mjs`, and
   `workspace-schema38.test.mjs`. This run preceded the final owner regressions;
   its complete output is `independent-initial-154.tap`.
2. Final frozen suite: 68/68 pass, exit 0. Output:
   `independent-final-frozen.tap`.
3. Additional executable probes: 38/38 pass, exit 0. Source:
   `independent-review-probes.mjs`; output: `independent-review-probes.log`.
   These cover optional frozen asset project-ID omission, explicit-null envelope,
   progressed export statuses, nested wrappers, escaped duplicate asset keys,
   hidden invalid sources, and physical export-owner mismatches.
4. `git diff --check` passed. Final reviewed source/test hashes are in
   `independent-source-sha256.txt`.

Commands, from the repository root, using the pinned binary as `$NODE`:

```sh
$NODE --test tests/workspace-frozen-evidence-v40.test.mjs tests/workspace-schema40-dormant.test.mjs tests/workspace-volume-envelope-validation.test.mjs tests/workspace-schema38.test.mjs
$NODE --test tests/workspace-frozen-evidence-v40.test.mjs
$NODE evidence/frozen-evidence-v40/independent-review-probes.mjs
git diff --check
```

The separate implementation gate recorded successful scoped strict TypeScript
and the final combined 116 checks; this review does not count those as independently rerun.
The final 68-test frozen suite and 38 additional probes used synthetic in-memory
SQLite fixtures. The earlier 154-test run was broader: the historical38 suite's
last two tests created disposable on-disk synthetic workspaces, invoked local
service and edit-task APIs, and exercised backup/restore into temporary paths.
Those fixtures used generated IDs and metadata-only synthetic assets, not actual
media. Their cleanup hooks removed the disposable roots. They were not rerun
after verification was narrowed to the frozen suite and independent probes. No user workspace or user media was touched, and no build, install,
network, GUI or Mac action was performed. The broad initial run is preserved as
separate evidence and is not described as an in-memory-only verification.
