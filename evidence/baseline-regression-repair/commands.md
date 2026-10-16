# Command provenance

All tests ran in `/workspace/scratch/6877817dff0d/mioon-baseline-regression-repair` using `NODE=/workspace/scratch/6877817dff0d/toolchains/node24.21/node-v24.21.0-linux-x64/bin/node`.

Checkout: local `git clone --no-hardlinks --no-checkout` from the sealed historical-restore-integrity checkout, detached at c2000a1118c57585cc94a42f53ff6febf86bbec9. Root and workspace node_modules copied locally with symlinks preserved. No install or network.

- policy.before.log: parent bytes restored with `git show HEAD:path`, then `$NODE --test --test-name-pattern='^restored profile has fixed catalogue coverage with no hint-based or suffix-based authority$' tests/workspace-restore-execution.test.mjs`; exit 1, expected catalogue mismatch.
- reopen.before.log: same parent bytes, then `$NODE --test --test-name-pattern='^ordinary current-schema reopen keeps raw schema/rows/receipts and source profile classification intact$' tests/workspace-restore-schema.test.mjs`; exit 1, expected WORKSPACE_VOLUME_ENVELOPE_INVALID.
- policy.after.log: `$NODE --test --test-name-pattern='^restored (profile has fixed catalogue coverage with no hint-based or suffix-based authority|catalogue reports four disabled media operations and refuses calls without writes)$' tests/workspace-restore-execution.test.mjs`; exit 0.
- reopen.after.log: `$NODE --test --test-name-pattern='^ordinary current-schema reopen' tests/workspace-restore-schema.test.mjs`; exit 0. Final schema file also includes explicit ordinary-40 assertion.
- execution-focused.log: `$NODE --test --test-name-pattern='^restored (profile has fixed catalogue coverage with no hint-based or suffix-based authority|catalogue reports four disabled media operations and refuses calls without writes|composition and automatic/manual workers leave all captured rows exact)$|^captured task reads stay exact|^exact saved timeline acknowledgement|^direct shared local mutation' tests/workspace-restore-execution.test.mjs`; exit 0. Server/network cases excluded.
- schema-final.log: `$NODE --test tests/workspace-restore-schema.test.mjs`; exit 0.
- contracts-final.log: `$NODE --test tests/workspace-restore-contracts.test.mjs`; exit 0.
- focused-regressions.final.log: `$NODE --test --test-concurrency=1 tests/workspace-restore-schema.test.mjs tests/workspace-restore-integrity-source-guard.test.mjs tests/workspace-schema40-dispatch.test.mjs tests/workspace-schema40-dormant.test.mjs`; exit 0, 256/256 passed.
- typecheck-foundation.log and typecheck-browser.log: `$NODE node_modules/typescript/lib/tsc.js --project tests/typecheck/tsconfig.foundation.json --noEmit --pretty false` and same with tsconfig.browser.json; both exit 0, unchanged canonical configs.

Initial attempts are retained under explicit initial-import-failure, immutable-receipt-attempt and legacy-classifier-attempt names, including the combined gate that began before classifier correction. Final source hashes and original seed byte identity are recorded in source-provenance.json.
