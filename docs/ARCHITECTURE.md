# V4 architecture: one business service, desktop and web hosts

## Workspace boundaries

- `apps/desktop`: Electron main process, sandboxed renderer host, backend utility-process lifecycle and platform packaging. It bundles the server and its dependencies into the desktop app; installed users do not need host Node.js.
- `apps/web`: React 19 + Vite renderer, React Flow canvas and specialized timeline interactions. It uses `@mioon/ui` for common controls.
- `apps/server`: loopback HTTP transport and static renderer serving. `startServer({dataDir, port, distDir, token})` returns an owned lifecycle; CLI signals are handled only in `cli.mjs`.
- `apps/mcp`: official SDK stdio MCP bridge. Uses the shared client to call the running service; never opens another database.
- `apps/cli`: real `mioon` executable, schema discovery, local file import/download and bounded watch commands.
- `packages/client`: one rotating loopback-auth resolver and HTTP/schema/watch implementation shared by CLI and MCP.
- `packages/business`: SQLite store, service operations, idempotency, jobs/recovery, immutable assets/versions/timeline snapshots, media handling, FFmpeg compositor and provider adapters.
- `packages/contracts`: strict Zod request schemas and public error/value contract, shared by service and MCP.
- `packages/ui`: checked-in official shadcn/ui Base UI component sources and project design tokens. No Radix UI substitute.

Dependency direction: hosts/transports → business → contracts; renderer → shared UI. Business imports no Electron, React or transport module. Providers stay inside the business package to avoid introducing artificial cross-package cycles with media and job contracts.

`server/index.mjs` and `server/mcp.mjs` remain tiny compatibility launchers for previous command lines. There is no duplicate implementation in that directory. Tests and active business imports use the new workspace source.

## Why pnpm

pnpm's explicit `workspace:*` dependencies ensure internal packages cannot silently resolve to public registry packages. One root `pnpm-lock.yaml` pins the complete graph, and the manager is pinned to 11.25.0. Existing v2 npm lock files are preserved only as historical verification material, outside active install configuration. No Turborepo is necessary for ten small packages; explicit root commands are sufficient.

## Runtime ownership

Web mode requires Node.js 24+ plus FFmpeg/ffprobe and runs the same exported server directly. Electron starts a separate utility process using the Node runtime included in Electron. It owns startup, local session bootstrap, renderer security, shutdown and a stable userData directory. The renderer does not receive an API token or provider credentials and does not have Node integration. FFmpeg/ffprobe remain external declared tools; their paths are explicitly selected/validated for desktop. They are not covertly downloaded or treated as bundled.

Desktop backend ports are allocated by binding to loopback port zero, preventing a fixed-port collision. Host and Origin checks use the actual assigned port. Authentication, media containment, request revision checks, request replay, recovery fences and live-provider authorization gates remain in the common business/transport stack.

## Data compatibility

The workspace move does not change media filenames. In web mode the default remains the repository's `data/`; `MIOON_DATA_DIR` continues to select a complete existing data directory. The additive v2 timeline migration is retained, and never rewrites v1 selected versions or materializes a new timeline from old shots implicitly. Schema v3 adds durable timeline history; schema v4 adds immutable first-frame connection request responses. Both leave historical records intact.

For desktop migration, stop all processes using the source data directory and use the explicit desktop data import path described in `DESKTOP.md`. Original data remains intact. A data directory must never be opened by two backend processes. Copy all managed media along with the database, never a live SQLite database alone.

## Primary references

Verified during implementation on 2026-10-09:

- Electron process model: https://www.electronjs.org/docs/latest/tutorial/process-model
- Electron utility process: https://www.electronjs.org/docs/latest/api/utility-process
- Electron security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- pnpm workspaces: https://pnpm.io/workspaces
- shadcn/ui monorepo and `base-nova`: https://ui.shadcn.com/docs/monorepo
- shadcn/ui manual installation: https://ui.shadcn.com/docs/installation/manual

For exact tested versions, use the lockfile and the V3 acceptance evidence. Source configuration for macOS does not establish native macOS compatibility or signing/notarization.

## V4 provider and agent contracts

The provider registry constructs mock, Runway, Ark Seedance, Gemini Veo, MiniMax and Vidu without network calls. `provider.list` returns per-model input modes, reference constraints, durations, ratios and safe configuration state; no secret values are included. The pure contract capability checker is shared with the renderer, then provider-specific validation and backend authorization gates run before a job is queued. Reference byte hashes, approved-media checks and fixed provider origins are enforced at dispatch.

MiniMax/Vidu regions are explicit fixed-origin choices, never fallback destinations. Environment names are maintained by the registry and used in the desktop utility allowlist. Credentials remain only in the backend environment. The generation count cap is scoped to this data directory, conservative and separate from a financial spending limit.

CLI, MCP and UI all observe the same immutable jobs, versions and timelines. CLI asset paths are read only by the local client; the HTTP backend receives bytes. Known task polling/downloads cannot generate another paid request. A downloaded live result with the wrong aspect ratio is quarantined in `output_review_required`: no public version is published and no generation is repeated.

## Typed reference inputs

`references.mjs` owns the atomic first-frame binding between one managed image node and one shot. It writes the typed edge, the shot's actual image ID and the exact request response in one SQLite transaction. Endpoint revisions prevent stale edits; a manually chosen image or another bound source is never overwritten. The source image ID is fixed; the node can only be renamed or moved, not retargeted through the public API. Detach removes the owned slot and edge without deleting assets or touching jobs. Generic/legacy edges remain decorative.

New generation snapshots include typed connection provenance alongside existing immutable image metadata and hashes. Dispatch continues to read the frozen snapshot, so disconnecting the canvas does not change an in-flight provider request. Explicit retries also retain the old snapshot. No topological scheduling, prompt propagation, style/character identity guarantee or additional provider capability is introduced. Provider validation and live-media authorization remain at their existing boundaries.
