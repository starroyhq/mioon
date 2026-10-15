# Canonical-conformance repair

Base: `f9e431cc01539ab883fa54887944e1b822f67ded`, tree `43e1844cf49d5f797c43105db73f0b65e6b2bbf4`.
Isolated checkout: `mioon-envelope-canonical-repair`.
Pinned runtime: `/workspace/scratch/6877817dff0d/toolchains/node24.21/node-v24.21.0-linux-x64/bin/node`, version 24.21.0, SHA256 `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`.

## Product repair

- Live curve algebra and filter compiler migrated to checked `.ts`. Redundant `.d.mts` removed. Frozen original source text fixtures plus emitted executable-AST comparison establish type-only equivalence, including exact numeric operators, branches and filter strings. Pure/golden tests retain absent/null identity.
- Dormant candidate prototypes moved unchanged, except import paths, to `tests/helpers`. Production frozen receipts now use a narrow typed record extraction with the actual production timeline predicate. Descriptor/proxy/prototype checks, typed arrays, traversal caps, malformed Unicode, negative zero, complete-record budget and owner checks remain intact. Existing receipt/profile/wrapper checks remain in the production scanner.
- Typed envelope scanner, admission and capability paths use narrow fail-closed runtime dependencies, installed from actual legacy predicates only in existing `db.mjs`. Schema40 initialization requires these dependencies before migration writes. Missing runtime never advertises editable capability. Historical25–39 constructors are byte-identical.
- Existing `AppError` moved to a typed leaf. The legacy barrel imports and reexports the same constructor, preserving local `parse` usage, `instanceof`, defaults, own fields/order and serialization. No duplicate error class is introduced.
- New runtime Unicode checks use the existing ES2022-compatible expression. Tests compare every UTF-16 code unit with Node's well-formed check and verify paired/lone surrogate boundaries.

No allowlist, compiler configuration, `checkJs`, target/lib, lockfile or package declarations changed. No broad suppression or `any` was added. No production feature is hidden in a new JavaScript file. New legacy-file edits are minimal import/assembly wiring.

## Preserved failures and fixture-only changes

The pre-edit foundation diagnostic baseline remains 721 normalized identical diagnostics before/after UI integration; this repair does not attribute those failures to UI changes. Historical evidence is in the original integration evidence directory.

The first repaired canonical command passed the source guard but failed foundation with 630 diagnostics. Static inspection found two additional transitive edges: capability→fixed-schema, and admission→contracts barrel via AppError. The bounded fixes above removed those edges. `canonical-typecheck-first.log` retains the complete failure. `canonical-typecheck-final.log` and `.exit` record the unchanged canonical command exiting 0, with the exact foundation/browser commands in `canonical-commands.json`.

Exploratory worker runs were not subprocess-guarded and are NOT qualification gates. Their logs and initial failures are preserved separately. One transient compiler output was truncated before capture; `algebra-in-progress-diagnostics.txt` explicitly preserves only available excerpts rather than inventing a complete log.

First guarded replay: 736/737, sole failure was the frozen pre-v2 fixture's bare `zod` resolution in the isolated dependency tree. The fixture import alone now points at the existing contracts workspace's declared cached Zod entry. Schema content is unchanged; no dependency installation, download or lock edit occurred. The targeted fixture + AppError identity replay passed 21/21 guarded.

Candidate helper moves and test import suffixes are fixture changes, separate from product validation changes. `dependency-materialization.json` verifies 20,363 identical cached regular files (547,216,490 bytes), 1,050 repository-local resolved links, and unchanged lockfile.

## Qualification boundary

The explicit test manifest excludes `local-drafts-transports` and real-import/media/CLI transport suites. Source tests use synthetic in-memory/on-disk workspaces only. Existing media proof is historical and was NOT rerun on this repair. No FFmpeg/FFprobe, GUI/native app, provider/network, GitHub/push, installer or macOS verification is claimed.

Independent read-only review found no blocking source-semantic issue. A later qualification-helper review identified an unnecessarily broad inherited Node test-argv allowance; its tightening and final audit are recorded with the final gate below.

## Build scope

The separately approved next stage is exactly one canonical `scripts/tooling.mjs build --channel=production` after the reviewed guarded gates and local source commit. The unchanged build entry uses media=false preflight and real typechecks before Web and Desktop staging. It does not invoke the doctor media probes. Build evidence will identify the sealed commit/tree and source hashes; a build is not native release/media acceptance.

Broad repaired-source replay passed **765/765**, zero skips (`nonmedia-broad.log`), including all original UI test selections and impacted backend tests. Review then removed the qualification helper's inherited test-filename-in-argv allowance entirely. The helper now permits only the exact pinned esbuild service and pinned TypeScript with six fixed arguments aimed at the existing repository-local, realpath-checked copied compiler fixture. Shell/fork and all other process launches are rejected before execution.

`guard-selftest.log` records six expected refusals: Node eval with an approved filename, a direct Node test launch, shell, fork, and fake FFmpeg/FFprobe requests. No media executable ran. Those intentional denial records are isolated in `guard-selftest-audit.jsonl`. Final strict-helper replay uses the 21 filenames in `nonmedia-final-tests.json`, not a wildcard or a media/transport suite. It rechecks all impacted backend/new tests, the existing compiler fixture and the corrected pre-v2 fixture; source hashes are in `final-source-test-manifest.json`.

Final strict-helper replay: **265/265 passed**, zero skipped, 226.327 seconds. Source/test manifest includes 1523 files and remained byte-identical during the replay. Audit: {'guard-installed': 21, 'spawnSync': 5}, zero unexpected/denied actual subprocess calls. Canonical unchanged typecheck exit 0 and independent final static review pass. See `final-gates.json`.
