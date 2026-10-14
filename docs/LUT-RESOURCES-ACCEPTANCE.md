# LUT resource foundation: candidate evidence

This is a resource import/persistence candidate, not a release or applied visual LUT feature. It remains uncommitted pending independent review. No main merge, push, provider request, Mac operation, rendering or issue #1 investigation was performed here.

## Provenance and scope

- Working branch: `feat/lut-resources`, isolated from WIP checkpoint `44c41a7ee7db4b2ac83513adaed1485ff3a14eef`.
- The five parser files are byte-identical to `92bf6ba070b1a1096c62e844a3e3ce467ab24c94`, whose base was accepted `f8b91713af0c8ed3994e32fa57447827a0ab3883`.
- Through24, restored25, ordinary26 and restored27 fixed schema source files are unchanged.
- The underlying loudness WIP retains its known, unaccepted timing failures. This feature's passes do not promote that base to accepted status or supersede issue #1.
- New logic is TypeScript. Existing JavaScript changes are narrow shared-service/discovery/client/restore/CLI wiring; the source-language allowlist is unchanged.

## Dependency identity

All `@mioon` resolutions from the worktree root, business, client, CLI, MCP and server resolve to this worktree's own sources. Third-party packages were initially shared from the existing installation; the worktree's containment gate correctly refused that layout. An exact local copy of the existing541MiB pinned `.pnpm` installation was then materialized, without registry requests, install scripts, dependency/version or lockfile changes. The normal local compiler gate now resolves TypeScript6.0.3 inside this worktree, and the standard foundation/browser typecheck succeeds. Runtime Node version:24.19.0.

## Focused checks already passed

One combined run of the following files passed100/100, zero failures, cancellations or skips, in25,781.899ms:

- `tests/cube-lut.test.mjs`:21
- `tests/lut-import-file.test.mjs`:19
- `tests/lut-resources-business.test.mjs`:18
- `tests/lut-resources-contracts-client.test.mjs`:7
- `tests/lut-resources-backup.test.mjs`:2
- `tests/lut-resources-http.test.mjs`:1
- `tests/workspace-schema28.test.mjs`:32

The checked behaviors include maximum7MiB exact source retention; canonical base64 and strict decoding; hash-bound ACKs; durable same-key replay and changed-payload conflict; project ownership and metadata-only pagination; project/workspace count and byte quotas; rollback at each precommit interruption; postcommit unknown-result replay; immutable SQL replacement/delete protection; safe CLI byte intake; a genuine authenticated HTTP route; frozen schema preservation; and actual cold backup28→restore29→reopen with exact bytes and receipts.

The actual official SDK ReadBuffer accepted a complete9,789,311-byte maximum test message, leaving696,449 bytes under its unchanged10MiB ceiling. Parser32MiB, transport7MiB and database512MiB limits are deliberately distinct.

The512MiB headroom/fragmentation boundary tests use a narrowly controlled page-count adapter with real SQLite insertion/rollback. They are not a native512MiB stress test. The64/128MiB resource byte-quota guard test does allocate actual bounded SQLite BLOBs, but deliberately does not treat its quota-only zero blobs as valid Cube resources.

Normal `node scripts/tooling.mjs typecheck` exited0 after contained dependency materialization. The isolated new-LUT strict consumer and no-new-JavaScript guard also passed. `git diff --check` passed.

## Correction history and limits

- The first strict check caught never-return control-flow typing in the new validator and CLI helper. The implementation was fixed without suppressions; the subsequent strict checks passed.
- The first client test used an invalid short synthetic token; the fixture was corrected, then all client cases passed. Product token validation was not weakened.
- A first new schema test used a metadata-field typo; the fixture was corrected and the complete schema lane passed.
- The initial worktree dependency-containment refusal is retained above rather than counted as a pass.

Fresh package builds, GUI/native acceptance, Mac/Windows behavior, full application regression, grading, clip binding, raw-byte download and preview/export rendered-pixel parity remain untested or unimplemented. No colour compatibility is inferred from normalized LUT content.

The final feature lane, now including actual CLI/official-MCP stdio, passed105/105 with zero failures, cancellations or skips in33,013.788ms. This repeats rather than adds to the earlier100-case run. The first actual CLI/official-MCP stdio test run passed5/5 in10.84s. Actual CLI `--file` retained original CRLF and missing final newline. Cross-transport replay, changed-payload conflict, metadata-only list/inspect, foreign-project denial, empty playable-media results and unchanged non-LUT database rows all passed. A proxy dropped a real committed CLI response and forged a real MCP ACK hash; both clients reported uncertainty, sent exactly one request, and explicitly recovered the original receipt through the other transport. All owned children closed and the backend exited0; forbidden-effects audit was empty. The five authorized existing current-runtime regression files were narrowly updated and passed126/126 in31,819ms (dispatcher41, profiles56, fixed restore-v27 16, backup marker bounds4, desktop migration9), zero failures, cancellations or skips. They use direct SQLite/store and offline migration/backup operations, not the stopped source-runtime readiness or CLI timeout paths. Historical goldens, fixtures and fixed-profile assertions remain unchanged. Historical fixtures stay fixed. No stopped issue #1 suite is part of this evidence.
