# Connect to the user's application

Use the authorized repository path as your working directory. Requirements are Node.js 24+, pnpm 11.25.0 and FFmpeg/ffprobe. An already-running Electron app owns its backend; do not run `pnpm start` against its workspace.

If the user requests starting an isolated local Web service, prepare dependencies and renderer as needed:

```sh
pnpm install --frozen-lockfile
pnpm build
MIOON_DATA_DIR=/absolute/new/local/data PORT=4318 pnpm start
```

Choose an unused port and a fresh or explicitly selected data directory. Keep the process running. The service only listens on loopback and creates `access-token` with owner-only permissions. In another shell, connect without putting the secret in a command argument:

```sh
export MIOON_BASE_URL=http://127.0.0.1:4318
export MIOON_TOKEN_FILE=/absolute/new/local/data/access-token
node apps/cli/src/index.mjs doctor
```

For an existing Electron desktop, use its actual `mcp-connection.json` (V4.1 production userData folder `app.starroy.mioon`, development `app.starroy.mioon.dev`; custom locations are possible):

```sh
export MIOON_CONNECTION_FILE=/absolute/to/userData/mcp-connection.json
node apps/cli/src/index.mjs doctor
```

On Linux these folders are normally under `$HOME/.config/`; on macOS under `$HOME/Library/Application Support/`. Source builds default to development; packaged development retains `.dev`. Configure the exact expanded absolute path for the intended channel. Legacy `video-workbench` data stays untouched and must be explicitly copied using the documented migration helper; never silently redirect or start a second writer.

Do not combine descriptor discovery with another service's base URL or token. The client re-reads private discovery and token files on every request, following desktop port/token rotation. Do not share the descriptor or token, copy them into prompts, or loosen their permissions. A stopped desktop must be reopened; stale discovery is not permission to start a replacement writer.

## MCP configuration

Use the host client's normal MCP configuration location only if the user requests configuring that client. Installation of the skill alone does not authorize changing global settings. Both Codex and Claude Code can launch the real stdio server with command `node`, argument `/absolute/path/mioon/apps/mcp/src/index.mjs`, and environment `MIOON_CONNECTION_FILE=/absolute/to/userData/mcp-connection.json`.

For direct Web service use `MIOON_BASE_URL` and `MIOON_TOKEN_FILE` instead. No secret belongs in the configuration. The source bridge needs installed workspace dependencies and Node 24+; it is not bundled in the historical Linux desktop archive. `docs/MCP.md` in the application repository has host-specific configuration examples.
