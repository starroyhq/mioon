# Mixed JavaScript and TypeScript foundation

Date: 2026-10-12. Baseline: `8552803c1fb6ade99b6f6ee8f4d6ec8a80764b5c`. Implementation, focused checks, actual Linux bundled runtime acceptance and independent parent aggregate complete. This is not a claim that the existing repository has been migrated.

## Development rule

New application/domain logic must be written in `.ts`; new browser components in `.tsx`. Existing JavaScript bug fixes and minimal compatibility/wiring changes may remain JavaScript. Do not hide a new feature's implementation inside a grandfathered JavaScript file to evade this rule. Migrate older modules incrementally in separately reviewed changes; runtime input validation, ownership, approval, replay and persistence checks remain mandatory.

The first actual migration is the dependency-free `packages/contracts/src/agent-protocol.ts`. The previous `.mjs` path explicitly re-exports the same two runtime symbols. The package barrel and public operations are unchanged. Erased executable equivalence and unchanged rejection cases are tested against the frozen baseline, rather than a hand-authored declaration that merely promises compatibility.

## Commands and checked surface

Run `node scripts/tooling.mjs typecheck` or `pnpm typecheck`. Both fixed projects run serially with strict checking, no emit, no unchecked library skipping, and no caller-provided project/command flags. The standalone command does not require media, Electron, a workspace, settings or provider access. It never installs dependencies or falls back to a global compiler.

- `tests/typecheck/tsconfig.foundation.json`: all new `.ts` under application/package `src` roots except browser/UI roots, plus the actual protocol compatibility seam and compile consumer. Uses real Node24 declarations, ES2022 and DOM URL types.
- `tests/typecheck/tsconfig.browser.json`: browser/UI `.ts` and `.tsx`, plus a consumer using actual React19/ReactDOM declarations and the typed protocol. The 19 pre-existing UI files in `config/typecheck-legacy-typed-exclusions.json` are not initial root entries. If a checked new module imports one, TypeScript follows its real source; the exclusion is not a fake ambient declaration.
- The new-source guard scans fixed `apps/*/src` and `packages/*/src` roots. Existing284 JavaScript paths are recorded in `config/typecheck-legacy-sources.json`; a new JS/JSX/MJS/CJS path fails. Runtime `.mts`/`.cts` and TSX outside browser/UI fail explicitly because this configuration does not cover them. Symlinked source trees cannot silently evade the scan. This file-level guard cannot detect new functionality inserted inside an existing JS file; source review enforces that part of the rule.
- Type checking is included before the shared build sequence, before the ordinary Web build, and before direct Desktop build/staging replacement. There is no environment-variable bypass. Direct low-level invocation of Vite/esbuild is transpilation, not this verified build workflow.

This does not typecheck the existing contracts/client barrels or every legacy JS module. New typed code must use checked leaf contracts or a genuinely checked narrow adapter. Broad `any`, wildcard/fabricated ambient declarations, `@ts-ignore` and `@ts-nocheck` must not be used to make an untyped boundary appear safe. Specific `@ts-expect-error` assertions belong only in negative compile tests and fail if they become unused.

## Runtime and packaging

Desktop bundles now trace the fixed local `createRequire(import.meta.url)` adapters through an AST-checked build transform. The transform is limited to repository-owned business/contracts/server TypeScript leaves, rejects dynamic or escaped require calls, and keeps each relative literal at its original resolve directory. Source-level `unknown` validation and the exact legacy schema catalogs remain unchanged. A runtime test executes the resulting CJS outside the source tree and verifies ordinary48, explicit46, backup/restore47, and refusal by the ordinary/old42 openers. Native source execution still uses Node's normal local require semantics.

The repository's Node24 source workflow uses native type erasure for `.ts`, with explicit extensions and `import type`. The observed pnpm workspace symlinks resolve to real source paths outside `node_modules`; actual CLI/MCP entrypoints are tested. Node deliberately refuses native type stripping for TS physically inside `node_modules`. Publishing bare-TS npm packages or using `--preserve-symlinks` is not supported by this slice.

`erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedModules` and explicit import extensions keep the supported syntax narrow. Runtime enums, parameter properties, namespaces with values, TS import aliases, decorators and path-alias-dependent imports are outside this source-runtime contract. Node ignores tsconfig and does not typecheck. Compiler success alone does not prove Node parser/runtime compatibility; real entrypoint tests remain required. Node cannot execute `.tsx` directly.

Vite and the existing esbuild Desktop build erase types into JavaScript. Electron receives ordinary bundled main/backend CJS and built web assets; it does not need the TypeScript compiler or raw application TS in its archive. React TSX is separately compiled/rendered against the installed React implementation. Existing UI wrapper provenance rules still apply when a future imported wrapper needs a type correction.

## Exact dependencies and sources

- `typescript@6.0.3`, Apache-2.0: deliberately selects the official classic JavaScript compiler, not the current latest native-compiler major. Exact version/integrity is recorded in the lockfile. Local execution verifies package identity/version and canonical `bin/tsc`, `lib/tsc.js` and `lib/_tsc.js` layout before running it. This is bounded entrypoint validation, not a claim of detecting arbitrary post-install dependency tampering.
- `@types/node@24.19.1`, `@types/react@19.2.18`, `@types/react-dom@19.2.7`: exact root development pins. Runtime React19.2.4 and the other existing runtime versions remain unchanged; type-peer lockfile identities change because declarations are now present.
- Registry metadata was read from the official npm registry on2026-10-12. The reviewed lockfile was installed with existing supply-chain policies; none was disabled. An initial default store path failed with ENOENT; the existing authorized workspace store was then used. Electron binary download was skipped for this source worktree, and the existing exact official locked runtime is used for Linux package acceptance.

Official sources checked2026-10-12:
- [Node24 TypeScript support and dependency restriction](https://nodejs.org/docs/latest-v24.x/api/typescript.html)
- [TypeScript erasable syntax](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)
- [Type-only import behavior](https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html)
- [Checking legacy JavaScript](https://www.typescriptlang.org/docs/handbook/type-checking-javascript-files.html)
- [TypeScript registry metadata](https://registry.npmjs.org/typescript)
- [Node declaration registry metadata](https://registry.npmjs.org/@types%2fnode/24.19.1)
- [React declaration registry metadata](https://registry.npmjs.org/@types%2freact/19.2.18)
- [ReactDOM declaration registry metadata](https://registry.npmjs.org/@types%2freact-dom/19.2.7)

## Acceptance and next work

Acceptance requires genuine compiler success, exact-union/non-any/readonly consumers, an unsuppressed intentional error in a copy of the real TS implementation producing failure, restoration producing success, no emitted files, unchanged runtime semantics, real Node workspace CLI/official MCP startup, actual React TSX rendering, fresh Web/Desktop build and bundled Linux runtime evidence. Synthetic resolver fixtures alone are insufficient.

The next approved feature is named rendered deliveries/export history, implemented as new typed modules/components. Existing contracts/client migration follows useful boundaries rather than delaying features for a whole-repository rewrite. No database migration, generation permission, provider calls, Mac/Windows acceptance or platform readiness is conferred by the type system.


### Verification checkpoint

- Frozen-baseline executable equivalence, strict real compiler, intentional unsuppressed wrong-return error and recovery/noEmit tests passed. Actual Node24.19.0 package-barrel/shim/TS identity, CLI version/schema and official MCP initialization/discovery passed.
- Final affected suite:168/168, zero skipped. A subsequent test-only build-order assertion tightening passed5/5. Actual portable launcher:95/95, zero skipped. These overlap and are not a unique full-suite count.
- An earlier affected run had104/105 passing: the React server-rendering test bundled CommonJS React dependencies as ESM and hit a dynamic require error. That fixture was corrected to CJS, matching the Node/desktop format; its real render then passed. No product behavior was changed to hide this test failure.
- Fresh verified build and Linux directory packaging passed; GNUtar archived that exact directory, and the existing package inspector checked49 ASAR entries, fuses, licenses, external subtitle font and archive identity. No raw application `.ts`/`.tsx`, compiler or node_modules is inside the ASAR.
- Final ASAR SHA256: `68682c70100099ced26d3cc88aa56cadc7eb0116712fc047077b214e95356403`. Web JS/CSS are byte-identical to the preceding verified renderer. Main/backend are newly built from the typed source graph.
- Supported cloud native input launched the actual package, opened the existing synthetic project and Agent settings, visibly verified both protocol choices without saving a setting or submitting a request, and exited normally with code0. Selected project/assets/shots/versions/jobs/exports/timeline row digests were unchanged. Actual terminal typecheck and CLI commands also exited0. This is Linux startup/regression evidence; no new export, Mac/Windows or live-model verification is claimed. No OS-wide packet trace was collected.

The final independent parent aggregate exited0:4802 total,4800 passed,0 failed,2 skipped,1305657.795489ms (`/tmp/mioon-types-parent-full.tap`, SHA256 `a82b95fce620065673bd3e105d53216c02e40225be6dcc6c88bbc20ef1075b99`). Parent installation first could not finish offline policy verification because official registry metadata for `@babel/runtime` was absent; normal frozen installation fetched the missing metadata and all472 policy entries passed without disabling the policy. Parent typecheck then exited0. This installation prerequisite failure and all earlier install/test failures remain in the acceptance evidence. Only this factual documentation was updated after the passing aggregate; production and tests stayed frozen.
