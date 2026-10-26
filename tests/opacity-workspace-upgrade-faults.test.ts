import test, {after, mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {upgradeOpacityWorkspace40To42 as upgrade} from '../packages/business/src/opacity-upgrade.ts';
import {createWorkspaceBackup, verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {calculateWorkspaceScope} from '../packages/contracts/src/workspace-scope.ts';
import {opacityUpgradeFixture as seedFixture, upgradeFixtureStamp} from './helpers/opacity-upgrade-fixture.ts';
import {tree, hash} from './helpers/opacity-backup-fixture.ts';
import type { URL } from 'url';

// Each fault runs against a new synthetic40 project and its actual verified40
// archive. No listener, subprocess, codec, provider or network can participate.
let childAttempts = 0, listenAttempts = 0, fetchAttempts = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const)
  mock.method(cp, name, () => {childAttempts++; throw Error('No child process is allowed in offline upgrade faults');});
mock.method(net.Server.prototype, 'listen', ((() => {listenAttempts++; throw Error('No listener is allowed in offline upgrade faults');}) as unknown as typeof net.Server.prototype.listen));
mock.method(globalThis, 'fetch', ((() => {fetchAttempts++; throw Error('No fetch is allowed in offline upgrade faults');}) as unknown as typeof globalThis.fetch));
syncBuiltinESMExports();
const mediaEvents: unknown[] = [], stopMedia = onMediaProcess(event => mediaEvents.push(event));
after(() => {
  stopMedia(); mock.restoreAll(); syncBuiltinESMExports();
  assert.equal(childAttempts, 0); assert.equal(listenAttempts, 0); assert.equal(fetchAttempts, 0); assert.deepEqual(mediaEvents, []);
});

const phases = ['afterValidation', 'afterDatabase', 'afterMedia', 'beforePublish'];
const args = (f: Awaited<ReturnType<typeof fixture>>) => ({source: f.source, backup: f.backup, destination: f.destination, channel: 'web' as const});
const code = (reason: string) => `WORKSPACE_UPGRADE_${reason}`;
async function fixture(t: unknown) {
  const f = await (seedFixture(t) as unknown as Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityUpgradeFixture>);
  f.remembered = path.join(f.source, 'last-project-v1.json');
  fs.writeFileSync(f.remembered, JSON.stringify({version: 1, workspaceScope: calculateWorkspaceScope({channel: 'web', root: f.source,
    directory: fs.statSync(f.source), db: fs.statSync(f.database)}), revision: 3, projectId: f.projectId, updatedAt: upgradeFixtureStamp}) + '\n', {mode: 0o600});
  await (createWorkspaceBackup({source: f.source, destination: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>);
  assert.equal((await (verifyWorkspaceBackup({directory: f.backup}) as Promise<import('./helpers/strict-workspace-boundary-types.ts').WorkspaceBackupResult>)).databaseSchemaVersion, 40);
  f.sourceBefore = tree(f.source); f.backupBefore = tree(f.backup); return f;
}
function unchanged(f: Awaited<ReturnType<typeof fixture>>, source = f.sourceBefore) {
  assert.deepEqual(tree(f.source), source, 'the upgrade must not edit source bytes or foreign changes');
  assert.deepEqual(tree(f.backup), f.backupBefore, 'the verified original40 archive is never rewritten');
  assert.equal(fs.existsSync(path.join(f.source, 'server.lock')), false, 'only the acquired source lease is released');
}
function noPublication(f: Awaited<ReturnType<typeof fixture>>) {assert.equal(fs.existsSync(path.join(f.destination, 'workbench.sqlite')), false, 'no launchable42 pathname is published');}
function cleaned(f: Awaited<ReturnType<typeof fixture>>) {noPublication(f); assert.equal(fs.existsSync(f.destination), false, 'all verified owned staging files and target directory are removed');}
async function refusal(promise: Promise<{ publication: "confirmed"; sourceBackupId: string; manifestHash: string; sourceDbHash: string; targetDbHash: string; sourceVersion: 40; targetVersion: 42; profile: "ordinary"; fileCount: number; payloadBytes: number; preferencePolicy: "preserved"; draftPolicy: "excluded-empty-only"; taskPolicy: "settled-only"; sourcePolicy: "unchanged"; warnings?: ("SOURCE_LOCK_RELEASE_UNCONFIRMED"|"DESTINATION_LOCK_RELEASE_UNCONFIRMED")[]|undefined; }>, reason: string): Promise<import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure> {
  try {await promise; assert.fail('the guarded operation must refuse');}
  catch (error) {if ((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code === 'ERR_ASSERTION') throw error; if (reason) assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code, code(reason)); return (error as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure);}
}
const boom = () => {throw Error('Owned synchronous test fault');};
const io = (syscall: string) => Object.assign(Error(`Owned synthetic ${syscall} failure`), {code: 'EIO', syscall});
function replaceSameBytes(file: string) {
  const bytes = fs.readFileSync(file), original = fs.statSync(file), replacement = file + '.owned-replacement';
  fs.writeFileSync(replacement, bytes, {mode: original.mode & 0o777}); fs.renameSync(replacement, file);
  assert.notEqual(fs.statSync(file).ino, original.ino, 'the race must replace the inode, not only bytes');
}
function candidate(f: Awaited<ReturnType<typeof fixture>>) {
  const names = fs.readdirSync(f.destination).filter(name => /^\.upgrade-.*\.sqlite$/u.test(name));
  assert.equal(names.length, 1); return path.join(f.destination, names[0]);
}
function patchFs<K extends 'fsyncSync'|'linkSync'|'unlinkSync'|'readSync'>(t: test.TestContext, name: K, implementation: (original:typeof fs[K],...args:Parameters<typeof fs[K]>)=>ReturnType<typeof fs[K]>) {
  const original = fs[name], stub = mock.method(fs, name, ((...values:Parameters<typeof fs[K]>)=>implementation(original,...values)) as unknown as typeof fs[K]);
  syncBuiltinESMExports(); t.after(() => {stub.mock.restore(); syncBuiltinESMExports();}); return stub;
}
function publicationProof(f: Awaited<ReturnType<typeof fixture>>, error: unknown) {
  assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).code, code('PUBLICATION_UNCONFIRMED')); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication.state, 'unconfirmed');
  const proof = JSON.parse((fs.readFileSync(path.join(f.destination, 'UPGRADE.json'), 'utf8') as string));
  assert.equal(proof.record, 'prepared-provenance'); assert.equal(Object.hasOwn(proof, 'publication'), false, 'prepared metadata must not claim a publication ACK');
  for (const key of ['sourceBackupId', 'manifestHash', 'sourceDbHash', 'targetDbHash'] as const) assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication[key], proof[key]);
  assert.equal(proof.sourceDbHash, hash(fs.readFileSync(f.database)));
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false); return proof;
}

for (const phase of phases) test(`synchronous ${phase} failure publishes nothing and removes only owned staging`, async t => {
  const f = await fixture(t); let hits = 0;
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === phase) {hits++; boom();}}}), 'IO');
  assert.equal(hits, 1); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, undefined); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication, undefined);
  cleaned(f); unchanged(f);
});

test('an afterPublish failure preserves the published42 bytes and exact uncertainty proof', async t => {
  const f = await fixture(t); let hits = 0;
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === 'afterPublish') {hits++; boom();}}}), 'PUBLICATION_UNCONFIRMED');
  const proof = publicationProof(f, error); assert.equal(hits, 1);
  assert.equal(hash(fs.readFileSync(path.join(f.destination, 'workbench.sqlite'))), proof.targetDbHash);
  assert.equal(fs.readdirSync(f.destination).some(name => name.startsWith('.upgrade-')), false);
  unchanged(f);
});

for (const phase of ['afterValidation', 'beforePublish'] as const) for (const resource of ['database', 'media', 'companion'] as const)
  for (const mutation of ['same-inode-change', 'same-bytes-new-inode'] as const)
    test(`${phase} ${resource} ${mutation} is detected before publication and the external change is preserved`, async t => {
      const f = await fixture(t); let changed;
      const filename = resource === 'database' ? f.database : resource === 'media' ? path.join(f.source, f.relativePath) : f.remembered;
      const error = await refusal(upgrade({...args(f), fault: at => {
        if (at !== phase) return;
        if (mutation === 'same-bytes-new-inode') replaceSameBytes(filename);
        else {const bytes = fs.readFileSync(filename); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(filename, bytes);}
        changed = tree(f.source).filter(([name]) => name !== 'server.lock');
      }}), 'CHANGED');
      assert.ok(changed); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication, undefined); cleaned(f); unchanged(f, changed);
    });

for (const phase of ['afterValidation', 'beforePublish'] as const) for (const name of [
  'local-drafts-v1.json', 'local-delivery-v1.json', 'local-shot-text-v1.json', 'local-drafts-v3.json', 'local-drafts-restored43-v1.json',
] as const)
  test(`${phase} detects previously missing ${name} appearing without migrating or deleting it`, async t => {
    const f = await fixture(t); let changed;
    await refusal(upgrade({...args(f), fault: at => {
      if (at !== phase) return;
      fs.writeFileSync(path.join(f.source, name), 'owned newly appeared input\n', {mode: 0o600});
      changed = tree(f.source).filter(([file]) => file !== 'server.lock');
    }}), 'CHANGED');
    cleaned(f); unchanged(f, changed); assert.equal(fs.readFileSync(path.join(f.source, name), 'utf8'), 'owned newly appeared input\n');
  });

test('a replaced target staging database is retained while cleanup refuses the foreign inode', async t => {
  const f = await fixture(t); let foreign!:string, bytes!:Buffer, ino!:number;
  const error = await refusal(upgrade({...args(f), fault: at => {
    if (at !== 'afterDatabase') return;
    foreign = candidate(f); bytes = fs.readFileSync(foreign); replaceSameBytes(foreign); ino = fs.statSync(foreign).ino; boom();
  }}), 'IO');
  noPublication(f); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, true);
  assert.equal(fs.statSync(foreign).ino, ino); assert.deepEqual(fs.readFileSync(foreign), bytes);
  assert.equal(fs.existsSync(path.join(f.destination, 'server.lock')), false); unchanged(f);
});

test('cleanup retains an unknown target file and marks incomplete removal instead of deleting foreign contents', async t => {
  const f = await fixture(t), unknown = path.join(f.destination, 'unrelated-owned-sentinel'); let ino;
  const error = await refusal(upgrade({...args(f), fault: at => {
    if (at !== 'afterMedia') return;
    fs.writeFileSync(unknown, 'foreign target bytes\n', {mode: 0o600}); ino = fs.statSync(unknown).ino; boom();
  }}), 'IO');
  noPublication(f); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, true); assert.equal(fs.statSync(unknown).ino, ino);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'foreign target bytes\n');
  assert.deepEqual(fs.readdirSync(f.destination), ['unrelated-owned-sentinel']); unchanged(f);
});

test('the final publication fence refuses an unknown target file appearing at beforePublish', async t => {
  const f = await fixture(t), unknown = path.join(f.destination, 'late-foreign-file');
  const error = await refusal(upgrade({...args(f), fault: at => {
    if (at === 'beforePublish') fs.writeFileSync(unknown, 'late target content\n', {mode: 0o600});
  }}), 'CHANGED');
  noPublication(f); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, true);
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'late target content\n'); unchanged(f);
});

for (const kind of ['candidate', 'media', 'proof'] as const) test(`the final fence refuses a same-bytes replacement of the target ${kind} inode`, async t => {
  const f = await fixture(t); let foreign!:string, inode!:number, bytes!:Buffer;
  const error = await refusal(upgrade({...args(f), fault: at => {
    if (at !== 'beforePublish') return;
    foreign = kind === 'candidate' ? candidate(f) : kind === 'media' ? path.join(f.destination, f.relativePath) : path.join(f.destination, 'UPGRADE.json');
    bytes = fs.readFileSync(foreign); replaceSameBytes(foreign); inode = fs.statSync(foreign).ino;
  }}), 'CHANGED');
  noPublication(f); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, true); assert.equal(fs.statSync(foreign).ino, inode);
  assert.deepEqual(fs.readFileSync(foreign), bytes); unchanged(f);
});

test('a competing destination lease is retained after the owned lease is revoked', async t => {
  const f = await fixture(t), lock = path.join(f.destination, 'server.lock'); let inode;
  const error = await refusal(upgrade({...args(f), fault: at => {
    if (at !== 'afterDatabase') return;
    const replacement = lock + '.owned-replacement';
    fs.writeFileSync(replacement, 'foreign lease token', {mode: 0o600}); fs.renameSync(replacement, lock); inode = fs.statSync(lock).ino;
  }}), 'LOCK_LOST');
  noPublication(f); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, true); assert.equal(fs.statSync(lock).ino, inode);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'foreign lease token'); unchanged(f);
});

test('a replaced destination root is retained without deleting files in the foreign directory', async t => {
  const f = await fixture(t), moved = path.join(f.base, 'owned-displaced-target'), sentinel = path.join(f.destination, 'sentinel'); let foreign;
  const error = await refusal(upgrade({...args(f), fault: at => {
    if (at !== 'afterMedia') return;
    fs.renameSync(f.destination, moved); fs.mkdirSync(f.destination, {mode: 0o700});
    fs.writeFileSync(sentinel, 'foreign replacement directory\n', {mode: 0o600}); foreign = tree(f.destination);
  }}), 'LOCK_LOST');
  noPublication(f); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, true); assert.deepEqual(tree(f.destination), foreign);
  assert.equal(fs.existsSync(path.join(moved, 'workbench.sqlite')), false); assert.ok(fs.existsSync(candidate({...f, destination: moved})));
  unchanged(f);
});

test('candidate fsync failure before publication removes verified owned staging and leaves source and archive intact', async t => {
  const f = await fixture(t); let armed = false, inode: number, hits = 0;
  patchFs(t, 'fsyncSync', (original, fd) => {
    if (armed && fs.fstatSync(fd).ino === inode) {hits++; throw io('fsync');}
    return original(fd);
  });
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === 'afterMedia') {inode = fs.statSync(candidate(f)).ino; armed = true;}}}), 'IO');
  assert.equal(hits, 1); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication, undefined); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, undefined); cleaned(f); unchanged(f);
});

test('proof-file fsync failure before publication removes the file created by this operation', async t => {
  const f = await fixture(t), proof = path.join(f.destination, 'UPGRADE.json'); let armed = false, hits = 0;
  patchFs(t, 'fsyncSync', (original, fd) => {
    const proofFiles = armed ? fs.readdirSync(f.destination).filter(name => name === path.basename(proof) || /^\.UPGRADE\.json\.[a-f0-9]+\.tmp$/u.test(name)) : [];
    if (proofFiles.some(name => fs.fstatSync(fd).ino === fs.statSync(path.join(f.destination, name)).ino)) {hits++; throw io('fsync');}
    return original(fd);
  });
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === 'afterMedia') armed = true;}}), 'IO');
  assert.equal(hits, 1); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication, undefined); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, undefined); cleaned(f); unchanged(f);
});

test('publication directory fsync failure retains42 with uncertainty proof and no automatic retry', async t => {
  const f = await fixture(t); let armed = false, inode: number, hits = 0;
  patchFs(t, 'fsyncSync', (original, fd) => {
    if (armed && fs.fstatSync(fd).isDirectory() && fs.fstatSync(fd).ino === inode) {hits++; throw io('fsync');}
    return original(fd);
  });
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === 'beforePublish') {inode = fs.statSync(f.destination).ino; armed = true;}}}), 'PUBLICATION_UNCONFIRMED');
  assert.equal(hits, 1); const proof = publicationProof(f, error);
  assert.equal(hash(fs.readFileSync(path.join(f.destination, 'workbench.sqlite'))), proof.targetDbHash); unchanged(f);
});

for (const afterLink of [false, true] as const) test(`publication link ${afterLink ? 'succeeds then reports failure' : 'reports EIO before linking'} remains uncertain and preserves evidence`, async t => {
  const f = await fixture(t); let armed = false, hits = 0;
  patchFs(t, 'linkSync', (original, from, to) => {
    if (armed && to === path.join(f.destination, 'workbench.sqlite')) {
      hits++; if (afterLink) original(from, to); throw io('link');
    }
    return original(from, to);
  });
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === 'beforePublish') armed = true;}}), 'PUBLICATION_UNCONFIRMED');
  assert.equal(hits, 1); publicationProof(f, error);
  assert.equal(fs.existsSync(path.join(f.destination, 'workbench.sqlite')), afterLink); assert.ok(fs.existsSync(candidate(f)));
  if (afterLink) assert.equal(fs.statSync(path.join(f.destination, 'workbench.sqlite')).ino, fs.statSync(candidate(f)).ino);
  unchanged(f);
});

test('no-clobber EEXIST retains the competing canonical file and never overwrites or unlinks it', async t => {
  const f = await fixture(t), canonical = path.join(f.destination, 'workbench.sqlite'); let armed = false, hits = 0, inode;
  patchFs(t, 'linkSync', (original, from, to) => {
    if (armed && to === canonical) {hits++; fs.writeFileSync(canonical, 'foreign canonical bytes\n', {mode: 0o600}); inode = fs.statSync(canonical).ino;}
    return original(from, to);
  });
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === 'beforePublish') armed = true;}}), 'DESTINATION_EXISTS');
  assert.equal(hits, 1); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication, undefined); assert.equal(fs.statSync(canonical).ino, inode);
  assert.equal(fs.readFileSync(canonical, 'utf8'), 'foreign canonical bytes\n'); assert.ok(fs.existsSync(candidate(f))); unchanged(f);
});

test('publication unlink failure leaves both same-inode paths and reports uncertainty without rollback', async t => {
  const f = await fixture(t); let armed = false, hits = 0;
  patchFs(t, 'unlinkSync', (original, filename) => {
    if (armed && path.dirname(filename as string) === f.destination && path.basename(filename as string).startsWith('.upgrade-')) {hits++; throw io('unlink');}
    return original(filename);
  });
  const error = await refusal(upgrade({...args(f), fault: at => {if (at === 'beforePublish') armed = true;}}), 'PUBLICATION_UNCONFIRMED');
  assert.equal(hits, 1); publicationProof(f, error);
  assert.equal(fs.statSync(candidate(f)).ino, fs.statSync(path.join(f.destination, 'workbench.sqlite')).ino);
  assert.equal(fs.statSync(candidate(f)).nlink, 2); unchanged(f);
});

test('already aborted input creates no destination and does not touch the source or archive', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await refusal(upgrade({...args(f), signal: controller.signal}), 'CANCELLED'); cleaned(f); unchanged(f);
});

for (const phase of phases) test(`cancellation at ${phase} stops before publication and removes owned staging`, async t => {
  const f = await fixture(t), controller = new AbortController(); let hits = 0;
  const error = await refusal(upgrade({...args(f), signal: controller.signal, fault: at => {if (at === phase) {hits++; controller.abort();}}}), 'CANCELLED');
  assert.equal(hits, 1); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, undefined); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).publication, undefined); cleaned(f); unchanged(f);
});

test('cancellation during streamed media copying closes and removes the partially copied owned file', async t => {
  const f = await fixture(t), controller = new AbortController(); let armed = false, hits = 0;
  const input = fs.statSync(path.join(f.backup, 'payload', f.relativePath)).ino;
  patchFs(t, 'readSync', (original, fd, ...values) => {
    const result = original(fd, ...values);
    if (armed && result > 0 && fs.fstatSync(fd).ino === input) {hits++; controller.abort();}
    return result;
  });
  const error = await refusal(upgrade({...args(f), signal: controller.signal, fault: at => {if (at === 'afterDatabase') armed = true;}}), 'CANCELLED');
  assert.equal(hits, 1); assert.equal((error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure).cleanupUnconfirmed, undefined); cleaned(f); unchanged(f);
});

test('cancellation after durable publication does not roll back the completed target', async t => {
  const f = await fixture(t), controller = new AbortController(); let hits = 0;
  const result = await upgrade({...args(f), signal: controller.signal, fault: at => {if (at === 'afterPublish') {hits++; controller.abort();}}});
  assert.equal(hits, 1); assert.equal(result.publication, 'confirmed');
  assert.equal(hash(fs.readFileSync(path.join(f.destination, 'workbench.sqlite'))), result.targetDbHash); unchanged(f);
});
