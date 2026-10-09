# Agent settings increment: implementation and acceptance

Date: 2026-10-09 (UTC)
Baseline: `ed23ef7` (panel release)
Status: local settings-only implementation; independent parent regression passed; local commit pending.

## Delivered scope

The header's **Agent** control opens a dedicated connection-settings dialog. This increment configures one active connection. It does **not** implement model requests, a connectivity test, chat, streaming, tool execution, project-context sharing, paid generation approval or OAuth. The UI and API consistently say `settings_only` and `not_tested`.

- Nine editable presets: OpenAI, DeepSeek, Qwen, Zhipu/Z.ai, Kimi, MiniMax, OpenRouter, custom compatible and local Ollama. Platform/region choices stay separate. Qwen workspace endpoints require the user's workspace ID; the field stays blank rather than saving a placeholder. See [official-source research and caveats](AGENT-PROVIDERS.md).
- Presets populate editable base URL/model fields, with an explicit reset-to-platform-default control. Official documentation URLs are selectable text; the desktop's external-navigation restriction is unchanged.
- Agent credentials are separate from existing video-generation provider configuration.
- Settings are local to the workspace/server instance in web mode and to the app's user-data directory in desktop mode, not per-project. They cannot execute operations or reveal projects. Future project-scoped runs require the boundaries in [the iteration plan](AGENT-ITERATION.md).

## Storage and request contract

Authenticated `GET /api/agent/settings` returns only the revision, non-secret configuration, key-present/storage flags, safe storage status and the documentation-backed catalog. `PUT` accepts exactly:

- `expectedRevision`: the revision the user reviewed;
- `configuration`: `presetId`, `platformId`, `baseUrl`, `model`;
- `secret`: `keep`, `remove`, or `replace` with a newly entered value and explicit `session`/`persistent` storage.

There is no secret-read API or secret-export tool. These routes are not added to the shared CLI/MCP business-method catalog. Existing server token/session, origin and CSRF protections apply; the settings body is independently bounded at 16 KiB. Errors and successes use explicit allowlists at the engine, desktop broker and HTTP boundary.

Every successful write increments the revision. Mutations are serialized, and stale revisions fail with 409. RAM changes commit only after the atomic file replacement succeeds. A repeated request with the old revision cannot overwrite a newer one. This is settings CAS, **not** the future durable business-operation replay journal.

A key is bound to the exact normalized base URL, preset and platform. Changing any of these clears the previous key; a model-only change can preserve it. The renderer warns about the change, but the backend enforces the rule independently.

### Web

Keys are held only in server memory and are lost on server restart. A browser reload does not restart the server. Only revision and non-secret configuration are persisted under `dataDir/agent-settings/settings.json`; no key is written to SQLite, browser storage or the settings file.

### Desktop

Electron main owns the settings engine for the whole app session. The existing trusted main/utility channel carries a narrow settings broker; renderer preload/IPC permissions are unchanged. A utility restart retains a session key; ordinary app quit expires it.

Persistent storage uses Electron `safeStorage` only when encryption is available. Linux `basic_text`, unknown storage backends, unavailable keyrings and encryption failures fail closed. The user must explicitly choose a session-only replacement when persistent storage is unavailable; the application never silently persists plaintext.

The single envelope at `userData/agent-settings/settings.json` contains metadata plus an encrypted, app-channel/profile-bound value when persistent storage is selected. Owner-only directories/files, bounded reads, symlink/hardlink checks, file fsync and atomic rename are enforced. Corrupt or unsafe settings stop only settings operations, so unrelated editing still starts.

If old ciphertext exists but the vault cannot read it, `configured: true`/`storage: persistent` means **ciphertext remains stored**, not that it is usable. Persistence is disabled for that engine, the file remains intact, and explicit removal or a newly entered session replacement remains possible. A future gateway must check usable-key capability separately.

### Renderer lifetime

The masked password input necessarily holds newly typed text transiently. It is uncontrolled and is cleared synchronously on submit, destination change and dismissal. The key is never copied into React state, recovery drafts, localStorage, sessionStorage or logs, and is never refilled. Save response validation checks the requested configuration, revision and key/storage outcome before showing success.

Unknown outcomes and conflicts trigger a safe read, retain only the non-secret draft and require explicit review. There is no automatic write retry. Closing a pending save does not claim to revoke a request already accepted by the backend; callbacks from that old dialog cannot alter a reopened dialog.

## Endpoint boundary

Current validation is **syntax-only and performs no DNS or provider request**. Remote configurations require HTTPS and reject URL credentials, query/fragment components, disallowed path forms, local-looking hostnames and forbidden literal IP ranges. Local Ollama is an explicit loopback-only `/v1` exception and rejects the current backend port on save.

This is not an SSRF-safe transport implementation. Before sending any model request, the next increment must resolve and validate all destination addresses, pin the actual connection, enforce redirect/proxy policy, recheck self-service ports and key binding, and deny private/metadata destinations outside the exact Ollama exception. A stored URL is not permission to send secrets to it. No saved setting currently initiates a request.

## Acceptance evidence

All runtime work used disposable copies of the synthetic multitrack project and clearly dummy key strings. No real key, model request, provider probe, media upload, OAuth or live generation was used. Ordinary application security remained enabled; the native fixture used no remote debugging or smoke hooks.

### Automated

- Focused implementation/regression run: **107/107 passed**, including new settings suites and existing desktop/preferences HTTP tests. Log: `evidence/agent-settings/focused-tests.log`.
- Independent security review: **62/62 focused cases passed**, plus queued-write/failure probes; no open blocking finding on the frozen implementation.
- Aggregate regression: **638/638 passed**, no failures/skips, `--test-concurrency=2`, 97.3 s. Log: `evidence/agent-settings/all-tests-bounded-final.log`.
- Independent parent aggregate: **638/638 passed**, no skips, 105 s. Log: `evidence/agent-settings/parent-independent-tests.log`.
- Final web/development-desktop builds: **passed**. Logs: `evidence/agent-settings/{web-build-final,desktop-build-final}.log`. Web assets `index-Dd4XZpd2.js` / `index-DX_hrGR8.css` match the runtime-tested UI. The final UI was reloaded and checked again.
- One concurrent web-build attempt was killed with exit 137 and cleared `dist`; its log is retained as `web-build-attempt-137.log`. After the parent suite ended, serial `NODE_OPTIONS=--max-old-space-size=768 pnpm build` restored the same assets successfully. No source, build configuration, timeout or security change was made. Existing bundle-size and dependency directive warnings remain.
- `git diff --check`: passed.

Coverage includes schema/URL bounds, origin/region invalidation, serialized competing writes, failed persistence, corruption isolation, symlinks/hardlinks/unsafe modes, response redaction, fake-vault encrypt/decrypt/channel binding, unavailable/basic_text fallback, IPC lifecycle, auth/origin checks, 16 KiB HTTP bounds, no-probe traps, session expiry and UI recovery/state-machine behavior.

### Actual own-cloud Chromium

`evidence/agent-settings/browser/report.json` records 12 passed checks. Every settings workflow was rerun after refreshing the fixture onto frozen backend source. The unchanged UI build was also resized through the native window manager to a 500 × 757 viewport and restored.

- Every preset and platform populates the expected editable fields without saving or probing.
- Save/keep/replace/remove, immediate key clearing, origin change and rejected private literal URL.
- Real second-writer CAS conflict; accepted PUT with a dropped response; accepted PUT held while the dialog closes/reopens. Drafts survive and no blind retry occurs.
- Browser reload preserves server-session availability without refilling the password.
- Narrow dialog fits the viewport, with accessible storage choices and visible footer controls.
- All project, media, job, timeline and history records remain unchanged; no plaintext dummy marker in the persisted settings.

Screenshots, captured from the running application:

| Path under `evidence/agent-settings/browser/` | Evidence |
| --- | --- |
| `01-settings-openai-unverified.jpg` | Settings-only scope and unverified connection |
| `02-regional-preset-editable.jpg` | Editable regional preset |
| `03-session-key-saved-unverified.jpg` | Key present, empty input, no connectivity claim |
| `04-private-endpoint-rejected.jpg` | Backend URL validation |
| `05-cas-conflict-preserved-draft.jpg` | Conflict and preserved draft |
| `06-lost-response-reread-no-retry.jpg` | Unknown save outcome and explicit review |
| `07-held-save-dismiss-new-draft-preserved.jpg` | New dialog unaffected by old completion |
| `08-reload-session-state-no-key-refill.jpg` | Reload without secret refill |
| `09-narrow-storage-footer.jpg` | Real 500 px viewport, storage/footer layout |

The repeated preset harness initially outran a select transition. The helper now waits for the observed selected label and collapsed control; the full repeated pass succeeded. No application change or arbitrary fixed sleep was used to hide a failure.

### Actual Linux Electron

`evidence/agent-settings/native/report.json` and `native-runtime/{before,saved,restarted,relaunched}.json` record five passed checks against the ordinary sandboxed development build (`app.starroy.mioon.dev`).

- The real environment's unavailable OS vault disabled persistent storage. Explicit app-session storage saved the dummy key through native UI.
- Settings file: 0600, metadata only, no plaintext dummy key.
- Existing application-menu restart replaced utility PID 360928/port 35931 with PID 361094/port 38783. The main-owned session key remained configured and the input stayed empty.
- Normal quit/relaunch created a new main/utility process. Saved revision/configuration survived; session key was absent. Domain data remained unchanged across all snapshots.

| Path under `evidence/agent-settings/native/` | Evidence |
| --- | --- |
| `01-vault-unavailable-session-only.jpg` | Persistent option disabled on real unavailable vault |
| `02-saved-session-no-key-refill.jpg` | Native save without secret refill |
| `03-utility-restart-key-retained.jpg` | Key retained across utility replacement |
| `04-app-relaunch-session-key-expired.jpg` | Key expires on app quit/relaunch |

All images are original runtime JPEG captures, not generated or composited images. Evidence is intentionally gitignored and can be delivered separately with the local commit report.

## Reproduction and file ownership

- Business: `packages/business/src/agent/{presets,config,settings,settings-file}.mjs`.
- Desktop: `apps/desktop/src/{secret-store,secret-broker}.mjs`, narrow main/backend/supervisor integration.
- HTTP: `apps/server/src/index.mjs`.
- UI: `apps/web/src/{AgentSettings.jsx,agent-settings.js}`, minimal `App.jsx` and scoped stylesheet integration using existing app-local controls.
- Automated tests: `tests/{agent-settings,agent-settings-file,agent-settings-http,agent-settings-ui,desktop-agent-secrets}.test.mjs`.
- Runtime helpers: `tests/agent-settings-qa-{runtime,client,native,native-report}.mjs`, `tests/browser_agent_settings.mjs`. They only operate on disposable local fixture copies; browser actions use supported CUA, native actions use supported screenshots/mouse/keys.

Run `node --test --test-concurrency=2 tests/*.test.mjs` when browser/native QA is idle. The established concurrency bound avoids unrelated CLI helper timeouts; existing test deadlines/security are unchanged. Run `pnpm build` and `pnpm desktop:build` for final bundles. Start fixture helpers from the same desktop namespace as the browser/Electron; this environment's shell and graphical sessions have separate process/network namespaces and share `/workspace/shared`, not `/tmp`.

No dependencies, schemas, installers, OAuth flows, provider manifests, CLI/MCP tool catalog or video-provider configuration changed.

## Remaining limitations

- Working Linux encrypted keyring and native macOS/Windows keychains are not runtime-certified. Fake crypto tests are not platform certification; Windows ACL behavior also needs native validation.
- Same-user compromised processes/renderer compromise are outside a perfect secret-isolation guarantee. Newly typed secrets necessarily traverse the authenticated local write path. JavaScript memory is not guaranteed securely zeroizable.
- The file layer is hardened against unsafe existing paths but is not a defense against an attacker already controlling the same OS account and racing directory mutations. Atomic rename is the commit point; directory fsync is best effort on unsupported filesystems.
- Presets are documentation-backed only. Account/region/model availability, live protocol compatibility, billing and response quality remain unverified.
- No stream, scoped dispatcher, durable operation journal, model-context/permission boundary or generation approval has been delivered. Those remain required follow-on stages before a writable in-app Agent can be claimed.
