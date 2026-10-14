# Project-owned LUT resource foundation

Status: candidate resource foundation, not applied visual LUT support or a release.

Provenance: isolated `feat/lut-resources` worktree starts at the unaccepted loudness checkpoint `44c41a7ee7db4b2ac83513adaed1485ff3a14eef`; it includes the standalone parser from `92bf6ba070b1a1096c62e844a3e3ce467ab24c94`, originally based on accepted `f8b91713af0c8ed3994e32fa57447827a0ab3883`. Those are different acceptance states. This work does not resolve or rerun the stopped startup/CLI timing problem tracked in GitHub issue #1. Nothing is merged into main or pushed by this slice.

## What is implemented

Three shared RPC operations are exposed to HTTP, the common Node client, CLI discovery and MCP discovery:

- `lut.import`: `{projectId, requestId, name, dataBase64}`. Imports one normalized 3D Cube resource, with a required caller-owned stable request key. Returns `{requestId, resource}`.
- `lut.list`: `{projectId, limit?: 1..50, after?: resource UUID}`. Default page size25, sorted by immutable ID, returning `{projectId, items, nextAfter}`.
- `lut.inspect`: `{projectId, lutId}`. Verifies the owned source bytes, SHA-256 and parsed metadata and returns `{resource, integrity: "verified"}`. This is stored-resource integrity, not colour or rendering suitability.

Public resource DTOs contain ID, project ID, display name, original byte SHA-256/length, fixed parser profile, bounded parser metadata and creation time. They do not expose source paths, URLs, source text, base64 or byte arrays. They explicitly state `colourCompatibility: "unverified"` and `renderBinding: "not_implemented"`. No generic effect framework, UI import, clip binding, strength setting, grading renderer, preview/export pixel parity or raw-byte download is included. No LUT enters `assets`, playable-media routes, generation inputs or built-in Agent authority.

CLI examples (replace the placeholders with actual IDs and a stable request key):

```sh
node apps/cli/src/index.mjs lut import --file /owned/path/look.cube --input '{"projectId":"PROJECT_UUID","requestId":"CALLER_OWNED_STABLE_KEY"}'
node apps/cli/src/index.mjs lut list --input '{"projectId":"PROJECT_UUID","limit":25}'
node apps/cli/src/index.mjs lut inspect --input '{"projectId":"PROJECT_UUID","lutId":"RESOURCE_UUID"}'
```

`--file` requires a case-insensitive `.cube` extension, defaults the display name to the basename, rejects a simultaneous `dataBase64`, and sends bytes rather than a local path. Safe ordinary owner/root-controlled0755 source parents are supported. Symlinked ancestors/leaves, hard links, foreign owners, nonregular files, other-user-writable paths and observed inode/size/timestamp replacement are refused without repairs. Descriptor reads use NOFOLLOW/NONBLOCK and bounded allocation. The same-user/root pathname-race boundary matches existing managed storage; this is not an OS sandbox. Windows ACL intake remains unavailable.

## Bytes, replay and limits

The parser's independent ceiling remains32MiB. The shared resource-import ceiling is smaller: exactly7MiB (7,340,032 bytes). The current MCP SDK1.32.1 stdio read buffer is10MiB; base64 for7MiB plus the complete JSON-RPC envelope and worst JSON escaping of bounded names/keys fits with over512KiB headroom. Existing42MiB HTTP/CLI JSON limits and the10MiB SDK limit are not widened. Large Cube tables may need a smaller compatible authoring export; the application never silently canonicalizes, truncates or resamples the original bytes.

Base64 must be canonical, with no whitespace or alternate padding bits. Byte size is checked before allocation and strict UTF-8 decoding. BOM, malformed encoding and unsupported Cube profiles are rejected by the strict byte/parser boundary. Accepted lexical bytes, including comments and CRLF, remain exact. The normalized table does not identify SDR, Log, HDR, input primaries or transfer functions. See [the parser reference](CUBE-LUT-REFERENCE.md).

Each import atomically stores one immutable project-owned BLOB and one immutable receipt in SQLite, using the existing exclusively owned private workspace and FULL-synchronous database transaction. The receipt binds operation, project, request key, display name, profile, exact source hash and byte length. Exact same-key replay returns the same resource before quota checks; changed key reuse conflicts, including cross-project reuse. The common Node client independently hashes submitted bytes and checks ACK hash/size. Unknown transport or post-commit outcomes require explicit exact replay, never automatic submission or a fresh invented key.

New request IDs intentionally create independent immutable resources even for identical content. They do not silently rename or deduplicate existing resources. No individual deletion or garbage-collection API is provided in this foundation; resources/receipts remain with the owning project database, and projects currently have no deletion API. A future deletion design must explicitly account for retained replay and render references.

Fixed bounds:128 resources and64MiB source bytes per project;512 resources and128MiB source bytes per workspace. A separate4,096 receipt ceiling is workspace-global; one retained receipt per resource means the512-resource cap dominates it in this slice. All count/byte quotas are rechecked in the same write transaction and enforced by SQL insertion guards. Updates, deletion and replacement are rejected, including with recursive triggers off.

Existing backup/restore database limit remains512MiB. Imports conservatively require current allocated SQLite pages plus twice the new source length and1MiB reserve to fit, without assuming free pages can be reused. Actual page count is checked again before commit and an overflow rolls back both BLOB and receipt. This is not a guarantee that later unrelated project edits cannot grow beyond the backup cap. Boundary/fragmentation tests use a narrow synthetic page-count adapter with real SQLite insert/rollback; they are not a native512MiB stress test.

## Schema and portable recovery

Ordinary28 has markers1–24,26,28 and adds only the resource and receipt tables/protections. Restored29 has1–24,26,28,29 and profile `restored-local-v3`. Historical through24, restored25, ordinary26 and restored27 constructors remain unchanged. New migrations are explicit; unknown, mixed, partial and missing-marker LUT evidence must not fall into older bootstrap repair.

Exact bytes are BLOBs inside the backed-up database, not sidecar media or arbitrary filesystem paths. Existing cold whole-database copying, hashing, manifest verification and no-clobber restore transport them without adding `.cube` payload paths or widening media acceptance. Resource metadata, receipt relationships, quotas and full content integrity are checked by strict backup/restore gates. Ordinary startup checks bounded schema/metadata/receipt ownership without reparsing every stored table; `lut.inspect` and strict offline gates read and validate the actual bytes.

Restore29 captures resources and import receipts as held immutable identities, preserving raw values and rowids. New LUT imports are intentionally unavailable in all restored profiles. Restored29 allows owned list/inspect; older restored25/27 profiles report these new reads unavailable. Inherited LUT rows cannot be changed or replaced, and restored workspaces still cannot create another recoverable backup. Keep the original backup. Import is a synchronous local transaction, so there is no task to resume or staged partial resource to repair.

## Focused verification

New isolated tests cover strict byte/transport bounds, maximum7MiB admitted source, exact-byte retention, Node ACK content binding, project isolation, replay/conflict, project/workspace quotas, interruption/rollback, immutable SQL protections, safe local source intake, real workspace close/reopen, fixed schema28/29 boundaries and actual cold backup/restore portability. The official SDK ReadBuffer is exercised in-process with a maximum complete MCP JSON message. A separate new LUT-specific test runs the actual CLI and official MCP stdio against an isolated guarded backend, including real lost/tampered acknowledgements and explicit cross-transport replay. It does not run or resolve the stopped issue #1 suites. No UI/native acceptance, full-suite success, packaged runtime or rendered-pixel parity is claimed.

Run only the relevant isolated lane:

```sh
node --test --test-concurrency=1 tests/cube-lut.test.mjs tests/lut-import-file.test.mjs tests/lut-resources-business.test.mjs tests/lut-resources-contracts-client.test.mjs tests/lut-resources-backup.test.mjs tests/lut-resources-http.test.mjs tests/lut-resources-transports.test.mjs tests/workspace-schema28.test.mjs
node node_modules/typescript/bin/tsc -p tests/typecheck/tsconfig.lut-resources.json --noEmit
```

The final evidence report names exact commands and outcomes. Existing current-version assertions have narrowly updated28/29 expectations; their historical constructor fixtures remain pinned. This does not replace aggregate application acceptance. The underlying WIP remains explicitly unaccepted; passing this feature lane does not erase its known failures.
