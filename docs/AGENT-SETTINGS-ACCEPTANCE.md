# Mio 连接设置（X6a / X6b）

当前实现使用严格 v3 集合，公共契约见 `packages/contracts/src/agent-connection-settings.ts`。九家内置服务各自保存配置与密钥，自定义服务最多十个；Mio 单独保存 `{serviceKey, modelId}` 选择，无选择时不自动选默认模型。设置属于应用/服务实例，不属于项目。

## 保存与修订

`GET /api/agent/settings` 只返回无密钥的条目、条目修订、Mio 选择、执行投影、目录、存储状态和迁移通知。`PUT` 接受 `{expectedRevision, services, mioSelection, secretActions}`，其中 secretActions 按 serviceKey 提交 keep/remove/replace；不接受旧 configuration/secret 单槽写法。九家内置项不可删除或改成另一家，自定义项使用 UUID，改名不换身份；当前已保存的 Mio 项须先改选并保存才能删除。

整页只有一个 CAS 和一次原子文件保存，全局 revision 每次成功加一。每条内容或密钥实际改变才递增自己的 revision；Mio 二元选择改变递增选择修订。执行投影的 revision 是只随当前连接变化的单调 token，配合 `{serviceKey, entryRevision, selectionRevision}` 及完整五字段配置冻结到 run_context；不是整页 revision。每次模型派发前通过可信 acquire 精确核对：改 B 不影响使用 A，改 A（包括仅换密钥）、A→B→A 或配置改后还原拒绝旧见证。恢复旧记录不得从今天的快照补签见证。

先校验全体，暂存加密结果和 session Map，最终完整公私投影均通过后只写一次 envelope，成功才发布 RAM。任何项校验/加密/文件保存失败整批不提交；丢 ACK 仍为 unknown，只读核对，不重发。`settings_only`/`not_tested` 表示保存本身没有做网络验证。

## 地址与密钥

固定平台按服务、平台、协议精确查目录，地址只读；工作空间只输入受限 DNS label 的 ID，区域及协议路径由目录拼出；本机只输入回环 origin，再按协议推导路径；自定义保留完整远程 HTTPS base，并继续执行已有 SSRF/DNS/连接钉住规则。目录的 blockedReason 不可运行，出现官方文档不等于当前 wire 已支持。

密钥先按 serviceKey 隔离，再绑定固定平台、workspace ID、本机 origin 或自定义完整 base。工作空间同 ID、本机同 origin 切协议可保留密钥；换区域、ID、origin、自定义路径只清本条。两个相同 URL 的自定义项也不共用密钥。目的地授权仍按最终推理 URL 和模型确认。

v1/v2 只适用于发布前开发数据：只在内存投影合法元信息，旧密钥全部作废且从不解密；GET 保持原文件逐字节不变，首次显式保存才写 v3。不安全、损坏或未知版本保持原件并拒绝设置操作。持久密文使用 v3 的命名空间、serviceKey、接收者绑定包装，可信取钥时再解密并校验；不可用的系统密钥库不降级明文。

设置请求、公开回包（含 IPC 包装）、最终加密文件均独立检查完整 UTF-8 序列化大小，保持 64 KiB。DTO 预算 62 KiB 给包装留余量；单 key 8192 字节、每家手填型号最多50个且每个200字符、最多19个条目，维度上限不能同时填满。broker 仍32 pending、7秒；不新增 renderer 取钥能力、CLI/MCP 模型工具或任意 headers。

## 页面和验证

左栏沿用当前分类；中栏为常规、九家服务、自定义；详情和保存底栏复用 `SettingsServicesLayout`。各详情稳定挂载、hidden/inert，单条 password DOM/ref 保留本条输入，切中栏不清其他密码。共享草稿和 React 状态不存密码；提交第一次 await 前同步清所有密码，放弃、整页隐藏和关闭清空，失败或 unknown 不回填。详情中的连接测试使用当前模型和连接，确认后发出一条固定测试消息。页面在密钥旁显示结果。用户保存后才替换原设置。常规页原有的已保存连接诊断仍有独立的授权和记录。

## 列表、缓存与检查

`POST /api/agent/models/list` 接受条目 key、集合修订、无模型的四字段选择和 saved/input/none 凭据来源。`POST /api/agent/models/test` 在同一请求形状上加当前 `model`，只返回测试状态和固定原因码。两者使用同一受限密钥通道，saved 只用于匹配的已保存接收者。input 只在本次请求中使用，结果不写缓存。测试不打开项目，不生成项目诊断，也不记录服务商原始回复。`POST /api/agent/models/cache` 只读同一选择的缓存，读取不联网、不取钥、不创建文件。桌面仍使用现有的可信 broker 获取保存密钥。

打开详情先显示匹配缓存，空的完整缓存也算命中。已有连接在缓存缺失时可自动获取。新输入的密钥仅在明确点击“获取”“检查”或“测试连接”时发送。获取和检查只读取当前打开的服务。观察到的列表和手动型号分别保留，草稿选择仍需保存。仅完整列表缺少实际 Mio 模型时警告“列表里已没有”。获取和检查不改变设置修订、dirty 或 `verification`。

独立私有缓存目录为应用数据目录的 `agent-settings/model-list-cache/`，桌面端同样由应用宿主写入该目录；它不进入设置 envelope、项目、SQL应用库或Mio记录。严格版本1按 serviceKey、带类型接收者绑定、版本化列表 descriptor 摘要分文件，只保存安全列表、时间、完整性和来源。每文件264 KiB，最多57个、专用目录16 MiB；读取/枚举均有界。坏JSON、未知版本、超限、链接或不安全权限视为miss，不锁住设置页；安全的成功/部分结果才原子重写。读取时按当前静态 profile 重算适配标记。

网络期间不持保存锁。应用宿主把所有设置保存（含桌面可信代理和项目借用的端口）与缓存最终核验/发布放进同一 admission 队列；最终核对集合修订、条目仍存在、绑定、descriptor、epoch及生命周期后，持队列直到写完。删除自定义项或改变绑定后清其缓存；清理失败不回滚设置，残件仍因匹配检查不可见。旧设置投影、新增未保存的自定义项或尚未保存的绑定/协议，只显示临时列表。切详情、保存、删除、放弃、隐藏、关闭和取消使旧请求失效，迟到结果不得重建缓存或条目。

聚焦验收覆盖：多项原子保存/回滚/CAS、A/B 隔离与 ABA、条目/包/UTF-8 边界、旧文件不写、broker 取消/迟到隔离、三栏回调/密码生命周期、CLI/client/HTTP。两套既有99条请求指纹保持原 fixture 逐字节不变；新增通用模板独立204条原始请求夹具，不改旧99预期。不使用真实密钥或供应商流量。

共用外壳只接受分组、稳定 panels、选择、整页可见性及统一 footer；`useSettingsServicesPanel()` 返回 selected/pageVisible/active。业务、密钥、CAS 和多文件部分成功由使用方管理，G1b 直接复用，不形成另一套保存状态。

---

## 以下为早期单槽版本的历史验收记录（不代表当前契约）

# Agent settings increment: implementation and acceptance

Acceptance results and original file ownership below retain their historical names. Current `.test.ts` execution is documented in [TYPESCRIPT.md](TYPESCRIPT.md#current-test-migration-2026-10-26) and the reproduction command below.

Date: 2026-10-09 (UTC)
Baseline: `ed23ef7` (panel release)
Status: historical settings-only acceptance, committed as `66a0193` after independent parent regression passed. Current conversation/tool scope is tracked in [bounded read tools](AGENT-READ-TOOLS.md).

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

For the current checkout, run `node --test --test-concurrency=2 tests/*.test.ts` when browser/native QA is idle. The established concurrency bound avoids unrelated CLI helper timeouts; existing test deadlines/security are unchanged. Run `pnpm build` and `pnpm desktop:build` for final bundles. Start fixture helpers from the same desktop namespace as the browser/Electron; this environment's shell and graphical sessions have separate process/network namespaces and share `/workspace/shared`, not `/tmp`.

No dependencies, schemas, installers, OAuth flows, provider manifests, CLI/MCP tool catalog or video-provider configuration changed.

## Remaining limitations

- Working Linux encrypted keyring and native macOS/Windows keychains are not runtime-certified. Fake crypto tests are not platform certification; Windows ACL behavior also needs native validation.
- Same-user compromised processes/renderer compromise are outside a perfect secret-isolation guarantee. Newly typed secrets necessarily traverse the authenticated local write path. JavaScript memory is not guaranteed securely zeroizable.
- The file layer is hardened against unsafe existing paths but is not a defense against an attacker already controlling the same OS account and racing directory mutations. Atomic rename is the commit point; directory fsync is best effort on unsupported filesystems.
- Presets are documentation-backed only. Account/region/model availability, live protocol compatibility, billing and response quality remain unverified.
- No stream, scoped dispatcher, durable operation journal, model-context/permission boundary or generation approval has been delivered. Those remain required follow-on stages before a writable in-app Agent can be claimed.
