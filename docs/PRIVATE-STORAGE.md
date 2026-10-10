# Q2: private local storage

Date: 2026-10-09 UTC. Implementation baseline: `dcc69aa`.

Status: released as `dceb8dd` after local synthetic acceptance and independent parent final verification (1,399 passed, zero failed, two explicit skips; 1,401 total). This is not a native Windows/macOS release certification.

## Boundary and compatibility

Mioon stores project metadata, saved chat, reviewed edit proposals and exact replay receipts in ordinary SQLite, and managed media in ordinary files. They are **not vault-encrypted**. OS-encrypted Agent keys are a separate facility; an available keyring does not establish filesystem privacy for the database or the local API token.

Q2 validates only explicitly selected app-owned storage paths and their ancestry. It does not search unrelated workspace files, repair permissions, take ownership, migrate data automatically or rotate an existing credential to hide an error. A refusal leaves existing app data and modes unchanged.

- Newly created private app roots and intermediate app directories request `0700`; new credential/discovery/config files request `0600`. Creation is followed by validation. These modes do not certify Windows ACLs.
- Existing workspace and desktop user-data roots must be owned by the current OS user and exclude group/other access. An existing `0755` or `0777` root is refused, even if a token inside it is `0600`.
- Existing legacy media directories (`0755`) and SQLite files (`0644`) can remain unchanged inside a verified private root, provided they are owned by the same user and are not group/other-writable. This preserves the former creation behavior without making the enclosing directory public.
- Credential, discovery and settings envelopes require stricter owner-only file permissions, a regular single-linked file and a bounded read. Symbolic links, special files and multiply linked credential/database files are rejected.
- Existing SQLite database, WAL, SHM and rollback-journal entries, workspace lock, media directory and local token are checked before SQLite opens or creates journal files. Supplying a token explicitly does not certify an unsafe existing app-owned token file. It may still override unused malformed stored contents, preserving the prior explicit-token recovery behavior; those contents are neither read nor rewritten.
- Parent directories are inspected, never modified. Ordinary `0755` parents are allowed only when owned by the current user or root; another unprivileged owner could replace the child subtree. A group/other-writable, non-sticky ancestor can permit replacement of the private root and is refused. The defined trusted sticky-directory case supports normal shared temporary-directory usage.

The initial policy refuses **all symbolic-link ancestors**, including otherwise legitimate platform aliases. Select the actual canonical directory explicitly; the application never silently resolves a user-selected alias and continues under a different path. On macOS this includes `/var` and `/tmp` aliases; canonical-path behavior and native filesystems still require native QA. This is a deliberate compatibility limit, not evidence that macOS is release-ready.

The OS administrator/root and another process running as the same OS user are outside this OS-user-isolation boundary. Token reads open with no-follow protection where supported, compare the opened inode against the inspected entry and remain byte-bounded. SQLite's pathname API is not an arbitrary concurrent same-user directory-swap sandbox. Network, unusual/removable filesystems and extended access policies are not certified by a POSIX mode check.

## Refusal and recovery

Errors identify a safe category and the next step without echoing token contents or credential paths. Refusal happens before reading a credential, opening SQLite, writing a channel marker or initializing the selected Electron user-data directory.

1. Close Mioon and every backend using the affected workspace. Preserve a complete backup, including SQLite state and managed media. Do not delete a token, database journal or replay receipt just to pass startup.
2. Check the explicitly selected data directory rather than changing a home directory or shared parent. Select a canonical, private directory belonging to the current user. A symlink, wrong owner, unusual filesystem or unverified ACL needs review; the app does not guess a repair.
3. If retaining the existing directory, the owner/administrator must deliberately review and correct its access policy outside Mioon. There is no automatic chmod/chown or “ignore security” option.
4. If moving old data, use a reviewed copy into a new private destination after a clean shutdown; retain the original. The existing desktop copy helper excludes credentials and requires closed/checkpointed source data. It is not a general repair tool for unsafe links, wrong ownership or corrupt databases. Never merge into an existing target or discard unknown Agent/mutation receipts.
5. Reopen and inspect the preserved projects. Agent runs do not automatically infer, approve or re-execute edits after restart. Unknown approved edits remain discoverable and require the existing explicit recovery action.

For a desktop startup refusal, a verified private temporary **diagnostic-only** profile may show the error dialog. It never becomes a fallback workspace and does not open the backend, settings or connection token. If even diagnostic storage cannot be verified, startup exits before readiness with the platform's early error reporting. Cleanup is restricted to the owned diagnostic directory. If discovery files become unsafe during normal shutdown, the backend stops and cleanup preserves those files with one sanitized warning instead of repeatedly invoking a fatal dialog. Restart still revalidates the directory and refuses it.

## Windows readiness gate

There is no native ACL backend in this increment. Windows persistent workspace/token/settings access fails closed with an explicit unavailable reason. The trusted code-level policy seam is not an environment variable, HTTP field, renderer option or generic “trust this platform” flag. POSIX test fixtures cannot enable a supported Windows claim.

A future Windows adapter must verify the actual current-user security identity, directory/file ownership and effective inherited grants, create private objects without a public intermediate state, handle reparse points and file identity, and specify UNC, redirected profiles and removable/non-ACL filesystems. Native tests must show a second OS user cannot read the token, configuration, database or media, and unsafe ACLs cause non-destructive refusal. Vault encryption, channel binding and plaintext MCP-token privacy each need their own native acceptance.

## Shared interfaces and repository hygiene

The storage policy is a Node-only explicit `@mioon/contracts/private-storage` subpath, never re-exported by the browser contract entrypoint. Business/server, desktop/settings and CLI/MCP connection readers share it rather than maintaining different definitions of a private file. Public operation schemas, mutation replay semantics and both Agent protocols remain unchanged.

CLI/MCP file-based credentials now also require a verified private parent directory. A former `0600` token placed directly in a shared/broad parent will be refused with recovery guidance. Explicit environment-token connection mode retains its existing semantics; it does not read a token file or bypass backend workspace validation.

Git exclusions cover the actual `mcp-token` filename, runtime token/discovery temporary names and Agent-settings envelope paths. Synthetic `git check-ignore` and package-scope checks prove these patterns without scanning, printing or generating real credentials. An ignore rule neither removes an already tracked secret nor replaces package-content review. The developer timeline-demo helper uses the same private-directory gate before creating data or starting a backend. Sample instructions copy closed fixtures into a fresh private workspace rather than changing existing sample permissions.

## Acceptance record

- Final affected-file run: **166 passed, 0 failed, 2 explicit skips** (168 tests, 5.3 s). Includes both reviewed-edit protocol/runtime suites, shared storage/server, desktop/settings, client, actual HTTP/CLI/official MCP and secret exclusions. Skips require native Windows and privileged real ownership changes; deterministic foreign-owner/inode fixtures passed. Log: `evidence/q2-private-storage/affected-tests.log`.
- Shared-policy/server focused 43/43 and desktop/settings focused 71/71 passed separately; these overlap the affected run and are not additive totals. The final demo-helper regression passed **2/2**, exercising the actual script with a test-only backend-spawn guard: unsafe existing permissions and alias/nonexistent descendants both fail without a backend spawn or outside creation. Log: `demo-focused.log`.
- The concurrency1 aggregate started at 23:09 UTC, but its execution session became unavailable and the preserved log ends at 23:12:54 without a terminal summary. No failing assertion is present in that log. It is **incomplete, not a full pass**; see `all-tests-interrupted.log` and its explicit status JSON. The first independent parent aggregate then completed with **1397 passed, 0 failed, 2 skips** (1399 tests, 272 s). After the demo-helper correction and two new regressions, the parent final aggregate completed with **1,399 passed, 0 failed, 2 skips** (1,401 tests, 252 s), and released `dceb8dd`. The incomplete earlier log remains preserved.
- Fresh serial Vite and desktop builds passed. The initial pnpm wrapper attempted a local workspace-link refresh and failed at its unavailable default store path; a bounded offline attempt then failed on missing cached supply-chain metadata. Both failures are retained. No dependency version changed, package policy was disabled or download performed. The successful builds used the existing installed Vite entrypoint and `node apps/desktop/scripts/build.mjs`. Standard existing source-map/use-client/bundle-size warnings remain.
- Final web assets are `index-BvLko4-q.js` and `index-C0iThKkj.css`, byte-identical to the preceding UI bundle; the desktop contains the new privacy checks. `build-sha256.json` records all 49 built files. After these builds/native runs, only the non-bundled demo helper, its new regression and documentation were refined; no bundled app source changed. The final native fixture itself also asserts its intended disposable directory mode.
- Native Linux, ordinary sandboxed Electron 44.7.0 development build: **3 grouped checks, 4 screenshots**. An actual 0755 disposable userData was refused with actionable Chinese guidance and exit 1; original bytes, modes and entries were unchanged, with no DB/token/identity creation. Safe 0700 data opened normally; two distinct full app lifetimes (PIDs 21846/21990) preserved the saved shot/revision and exited 0, removing discovery files. Read-only audits show zero jobs, Agent requests and proposals. This is workspace/regression evidence, not a new model-tool runtime test. See `native/report.json`, `native-safe/*audit.json` and `native-unsafe/before.json` / `after.json`.
- Native screenshot `native/01-unsafe-root-refused.jpg` shows the refusal. `native/04-private-workspace-after-app-recreation.jpg` shows the preserved project after recreation; screenshots alone do not prove unchanged database contents.
- The first native fixture requested 0755 but inherited GUI umask 077, making it 0700; startup correctly succeeded. Its archived evidence is not counted as a refusal. The corrected fixture explicitly sets and asserts permissions only on its newly created disposable directory. No existing user-directory permissions were changed.

Synthetic fixtures only. No real provider/credential entry, installer, automatic user-permission repair, commit or publication was performed. Native launch creates only its ordinary ephemeral local-auth material within the isolated synthetic profile. No packet capture was performed, and this record makes no blanket claim about all network attempts.

Covered boundaries (native Windows/macOS gates remain open):

- private new root; unchanged valid legacy media/database; unsafe root/token/owner/type/size/link cases; partial initialization; no outside creation through aliases;
- bounded no-follow credential reads and entry/opened-inode identity; existing SQLite sidecars and lock validation; denied startup leaves bytes, modes and entry lists unchanged;
- desktop validation before Electron writes; diagnostic refusal and clean exit; safe app recreation; no workspace fallback;
- client descriptor/token rotation and local-origin rules; actual CLI/MCP/HTTP behavior; environment-token compatibility;
- Windows unavailable and trusted adapter readiness contract; no fake native-pass claim;
- synthetic secret exclusions; unchanged shared transports, durable proposals/replay and both-protocol reviewed-edit tests.

Official references checked 2026-10-09: [Electron early error dialog](https://www.electronjs.org/docs/latest/api/dialog#dialogshowerrorboxtitle-content), [Electron app paths and readiness](https://www.electronjs.org/docs/latest/api/app). In particular, Linux's pre-ready `showErrorBox` emits stderr rather than a GUI dialog.
