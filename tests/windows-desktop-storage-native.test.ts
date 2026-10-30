import * as storage from '@mioon/contracts/private-storage';
import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {linkSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {initializeNodePrivateStorage} from '../packages/node-host/src/private-storage-bootstrap.ts';
import {appendWindowsDiagnostic} from '../apps/desktop/src/diagnostic-append-windows.ts';
import {createDesktopLutRecoveryStore} from '../apps/desktop/src/lut-recovery-store.ts';
import {createWorkspaceNativeHost} from '../apps/desktop/src/workspace-native-host.ts';

// The desktop modules' Windows branches against the real ACL helper. The
// helper is loaded through the headless entry, which shares the backend code
// the desktop entry registers inside Electron.
const windows = process.platform === 'win32';
const SYSTEM = 'S-1-5-18', EVERYONE = 'S-1-1-0';
async function fixture(t: TestContext): Promise<string> {
  await initializeNodePrivateStorage();
  const root = storage.createPrivateTemporaryDirectory(tmpdir(), 'mioon-native-desktop-');
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
interface Dacl {readonly protected: boolean; readonly sids: readonly string[]}
interface ReportedDacl {readonly protected: boolean; readonly sids: string | string[]}
/** The operating system's own report, independent of the helper's verdict. */
function dacls(targets: readonly string[]): {user: string; entries: Dacl[]} {
  const script = "$ErrorActionPreference='Stop';$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
    '$entries=@(($env:MIOON_DACL_TARGETS | ConvertFrom-Json) | ForEach-Object { $target=$_; $acl=Get-Acl -LiteralPath $target; ' +
    '[pscustomobject]@{protected=$acl.AreAccessRulesProtected; sids=@($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)} });' +
    '[pscustomobject]@{user=$user; entries=$entries} | ConvertTo-Json -Depth 4 -Compress';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', env: {...process.env, MIOON_DACL_TARGETS: JSON.stringify(targets)}});
  assert.equal(result.status, 0, result.stderr);
  // Windows PowerShell may emit a one-element array as its only element.
  const value = JSON.parse(result.stdout) as {user: string; entries: ReportedDacl | ReportedDacl[]};
  return {user: value.user, entries: ([] as ReportedDacl[]).concat(value.entries).map(entry => ({protected: entry.protected, sids: ([] as string[]).concat(entry.sids)}))};
}
function assertPrivate(targets: readonly string[]): void {
  const {user, entries} = dacls(targets);
  entries.forEach((entry, index) => assert.deepEqual({...entry, sids: [...entry.sids].sort()}, {protected: true, sids: [user, SYSTEM].sort()}, targets[index]));
}
function grantEveryoneRead(target: string): void {
  const acl = spawnSync('icacls.exe', [target, '/grant', `*${EVERYONE}:(R)`], {encoding: 'utf8'});
  assert.equal(acl.status, 0, 'Native ACL mutation prerequisite failed; do not count Windows ACL tests as passed');
}

test('native Windows diagnostics append, rotate and drop oversized slots with private ACLs', {skip: !windows}, async t => {
  const dataDir = path.join(await fixture(t), 'workspace'), directory = path.join(dataDir, 'diagnostics'), file = path.join(directory, 'backend-exit.jsonl');
  const limits = {maxBytes: 32, fileCount: 3}, line = (text: string) => Buffer.from(`${text}\n`);
  const append = (text: string) => appendWindowsDiagnostic(dataDir, directory, file, line(text), limits);
  const content = (target: string) => storage.readPrivateFile(target, {root: dataDir, maxBytes: 64, allowMissing: true, encoding: 'utf8'});
  const slots = () => [content(file), content(`${file}.1`), content(`${file}.2`)];
  for (const text of ['one-123456', 'two-123456', 'three-1234', 'four-12345', 'five-12345', 'six-123456']) append(text);
  // Two 11-byte lines fill a 32-byte slot; three slots hold six lines.
  assert.deepEqual(slots(), ['five-12345\nsix-123456\n', 'three-1234\nfour-12345\n', 'one-123456\ntwo-123456\n']);
  // The oldest slot leaves first; every newer slot moves up once.
  append('seven-1234');
  assert.deepEqual(slots(), ['seven-1234\n', 'five-12345\nsix-123456\n', 'three-1234\nfour-12345\n']);
  assert.deepEqual(readdirSync(directory).sort(), ['backend-exit.jsonl', 'backend-exit.jsonl.1', 'backend-exit.jsonl.2'], 'rotation leaves no staging file');
  assertPrivate([directory, file, `${file}.1`, `${file}.2`]);
  // An oversized slot is dropped, as on POSIX, instead of being moved.
  storage.writePrivateFileAtomic(`${file}.1`, Buffer.alloc(64), {root: dataDir, maxBytes: 64});
  storage.writePrivateFileAtomic(file, 'eight-1234\nnine-12345\n', {root: dataDir, maxBytes: 32});
  append('ten-123456');
  assert.deepEqual(slots(), ['ten-123456\n', 'eight-1234\nnine-12345\n', null]);
  assert.throws(() => appendWindowsDiagnostic(dataDir, directory, file, Buffer.alloc(40), limits), {reason: 'SIZE_LIMIT'}, 'a line larger than a slot is refused');
  // A foreign grant fails closed and is left exactly as found.
  append('eleven-123');
  grantEveryoneRead(file);
  assert.throws(() => append('twelve-123'), {reason: 'UNSAFE_ACL'});
  assert.equal(readFileSync(file, 'utf8'), 'eleven-123\n');
  assert.ok(dacls([file]).entries[0]!.sids.includes(EVERYONE), 'the foreign grant is not repaired');
});

const lutRecord = (change: Record<string, unknown> = {}) => ({version: 1, workspaceScope: 'a'.repeat(64), projectId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222', name: 'look.cube', sizeBytes: 30, sha256: 'b'.repeat(64), ...change});
const lutCode = (value: string) => (error: unknown) => (error as {code?: string}).code === `LUT_RECOVERY_${value}`;
type LooseStore = {read(value: unknown): unknown; reserve(value: unknown): void; verify(value: unknown): void; complete(value: unknown): void};

test('native Windows LUT recovery records replace by rename, keep their full identity and stay private', {skip: !windows}, async t => {
  const userData = await fixture(t), file = path.join(userData, 'lut-import-pending-v1.json');
  const create = (options: {beforePublish?: () => void} = {}): LooseStore => createDesktopLutRecoveryStore({userData, guard() {},
    storage: storage as unknown as Parameters<typeof createDesktopLutRecoveryStore>[0]['storage'], ...options}) as unknown as LooseStore;
  const a = lutRecord(), b = lutRecord({workspaceScope: 'c'.repeat(64)}), store = create();
  assert.equal(store.read(a), null);
  store.reserve(a); store.verify(a);
  // The second publish renames its staged file over the first record file.
  store.reserve(b);
  assert.deepEqual([create().read(a), create().read(b)], [a, b]);
  assert.deepEqual(readdirSync(userData), ['lut-import-pending-v1.json'], 'no staged file is left behind');
  assertPrivate([file]);
  store.complete(a);
  assert.deepEqual([create().read(a), create().read(b)], [null, b]);
  // Another writer between staging and publish is a conflict; the staged file is removed.
  const contender = create({beforePublish: () => storage.writePrivateFileAtomic(file, '{"version":1,"records":[]}', {root: userData, maxBytes: 4096})});
  assert.throws(() => contender.reserve(a), lutCode('CONFLICT'));
  assert.deepEqual(readdirSync(userData), ['lut-import-pending-v1.json']);
  // A foreign grant fails closed and is left exactly as found.
  grantEveryoneRead(file);
  assert.throws(() => create().read(b), lutCode('UNAVAILABLE'));
  assert.ok(dacls([file]).entries[0]!.sids.includes(EVERYONE), 'the foreign grant is not repaired');
});

test('native Windows export open and reveal hash managed bytes through the ACL helper handle', {skip: !windows}, async t => {
  const root = await fixture(t), media = path.join(root, 'media');
  storage.ensurePrivateDirectory(media, {create: true});
  const projectId = randomUUID(), exportId = randomUUID(), assetId = randomUUID(), file = path.join(media, `${assetId}.mp4`);
  // Larger than one 1 MiB chunk, so the read yields between chunks. Written
  // like backend media: it inherits the closed workspace ACL.
  const bytes = Buffer.alloc(2.5 * 1024 * 1024, 0x6d);
  bytes.write('synthetic export', 0);
  writeFileSync(file, bytes);
  const output = {projectId, exportId, assetId, fileLocation: file, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: `/media/${assetId}`};
  const identity = {projectId, exportId}, calls: unknown[][] = [];
  let current: Record<string, unknown> = output, checks = 0, retireAt = Infinity;
  const host = createWorkspaceNativeHost({
    ownerForEvent: () => ({projectId, isCurrent: () => ++checks < retireAt}),
    chooseDirectory: async () => null,
    setBackupDirectory: async () => { throw new Error('unused'); },
    readSettings: async () => { throw new Error('unused'); },
    readWorkspaceRoot: async () => root,
    readExport: async value => { calls.push(['readExport', value]); return current; },
    openPath: async target => { calls.push(['open', target]); return ''; },
    revealPath: target => { calls.push(['reveal', target]); },
    restart: async () => false,
  });
  assert.equal(await host.dispatch({}, {action: 'openExport', identity}), true);
  assert.equal(await host.dispatch({}, {action: 'revealExport', identity}), true);
  assert.deepEqual(calls, [['readExport', identity], ['open', file], ['readExport', identity], ['reveal', file]]);
  const unavailable = (error: unknown) => (error as {code?: string}).code === 'WORKSPACE_NATIVE_UNAVAILABLE';
  for (const change of [{sha256: 'f'.repeat(64)}, {sizeBytes: bytes.length - 1}]) {
    current = {...output, ...change};
    await assert.rejects(host.dispatch({}, {action: 'openExport', identity}), unavailable);
  }
  current = output;
  const alias = path.join(media, 'alias.mp4');
  linkSync(file, alias);
  await assert.rejects(host.dispatch({}, {action: 'openExport', identity}), {reason: 'HARD_LINK'});
  rmSync(alias);
  // Three checks precede the read, so the owner retires after two chunks.
  checks = 0; retireAt = 6;
  await assert.rejects(host.dispatch({}, {action: 'openExport', identity}), unavailable);
  assert.equal(calls.filter(([kind]) => kind === 'open').length, 1, 'no shell effect after a failed verification');
  // The helper opens without delete sharing, so this fails if the handle leaked.
  rmSync(file);
});
