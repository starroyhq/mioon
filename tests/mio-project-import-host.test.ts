import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createMioProjectImport} from '../packages/business/src/agent/mio-project-import.ts';
import {publishProjectOutput, setProjectOutputPublicationTestHooks} from '../packages/business/src/project-output-publication.ts';
import {ensurePrivateDirectory} from '../packages/contracts/src/private-storage.ts';
import {png} from './helpers/timeline-image-fixtures.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-project-import-host-'));
  const store = openStore(root), services = createServices(store, new Map());
  await services.call('project.create', {name: 'Project file import host'});
  const app = testProjectAppLibrary(store); assert.ok(app);
  const source = path.join(root, 'source.png'), bytes = png({width: 32, height: 24, rgba: false});
  writeFileSync(source, bytes); const time = new Date('2026-11-01T00:00:00.000Z'); utimesSync(source, time, time);
  const privateDirectories = [app.dataDir, store.cacheDir, store.tempDir];
  const port = createMioProjectImport({store, services, privateDirectories});
  t.after(async () => {await services.drain(); store.close(); rmSync(root, {recursive: true, force: true});});
  const context = {requestId: randomUUID(), beforeEffect() {}};
  const prepare = (file = 'source.png') => port.prepare(store.projectId, {path: file}, {...context, requestId: randomUUID()});
  return {root, store, services, app, source, bytes, time, privateDirectories, port, context, prepare};
}

function writeLock(file: string): unknown {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    let db;
    try {db = new DatabaseSync(process.argv[1], {timeout:0}); db.exec('BEGIN IMMEDIATE;ROLLBACK'); process.stdout.write(JSON.stringify({ok:true}));}
    catch(error) {process.stdout.write(JSON.stringify({ok:false,errcode:error.errcode}));}
    finally {db?.close();}
  `, file], {encoding: 'utf8', timeout: 60_000});
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}

for (const kind of ['project', 'history', 'cache', 'application'] as const) {
  test(`host refuses a held ${kind} hard link without disturbing the other process write lock`, async t => {
    const f = await fixture(t), files = {project: f.store.projectFile, history: path.join(f.store.localDir, 'history.db'),
      cache: path.join(f.store.cacheDir, 'cache.db'), application: f.app.databaseFile};
    const target = files[kind]; linkSync(target, path.join(f.root, `${kind}.png`));
    const before = f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
    assert.deepEqual(writeLock(target), {ok: false, errcode: 5});
    await assert.rejects(f.prepare(`${kind}.png`), {code: 'AGENT_TASK_INVALID_TARGET'});
    assert.equal(f.store.list('assets', f.store.projectId).length, 0);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n, before);
    assert.deepEqual(writeLock(target), {ok: false, errcode: 5});
  });
}

test('host imports a real source by reference and reuses the original key without rereading a deleted source', async t => {
  const f = await fixture(t), before = lstatSync(f.source, {bigint: true}), prepared = await f.prepare();
  const changes: unknown[] = [];
  const result = await f.port.execute(prepared, {beforeEffect() {}, recordCreatedInside(proof) {
    assert.equal(f.store.db.isTransaction, true); assert.ok(f.store.get('assets', proof.assetId)); changes.push(proof);
  }});
  assert.equal(result.disposition, 'created'); assert.equal(changes.length, 1); assert.equal(f.store.list('assets', f.store.projectId).length, 1);
  assert.deepEqual(readFileSync(f.source), f.bytes); assert.equal(lstatSync(f.source, {bigint: true}).ino, before.ino);
  assert.equal(lstatSync(f.source, {bigint: true}).mtimeNs, before.mtimeNs);
  assert.ok(!JSON.stringify(result.asset).includes(f.root));
  unlinkSync(f.source);
  const replay = await f.port.execute(prepared, {beforeEffect() {}, recordCreatedInside() {assert.fail('A reused key has no creation callback');}});
  assert.equal(replay.disposition, 'reused'); assert.equal(replay.asset.id, result.asset.id); assert.equal(changes.length, 1);
  const lookup = await f.port.lookup(prepared, {beforeEffect() {}}); lookup.assertCurrent(); assert.equal(lookup.outcome, 'applied');
  assert.equal(existsSync(f.source), false); assert.equal(f.store.list('assets', f.store.projectId).length, 1);
});

test('preparation excludes private directory aliases and foreign or copied project owners', async t => {
  const f = await fixture(t), privateFile = path.join(f.store.tempDir, 'private.png'); writeFileSync(privateFile, f.bytes);
  symlinkSync(f.store.tempDir, path.join(f.root, 'private-alias'));
  const outside = path.join(path.dirname(f.root), path.basename(f.root) + '-outside'); mkdirSync(outside); t.after(() => rmSync(outside, {recursive: true, force: true}));
  writeFileSync(path.join(outside, 'outside.png'), f.bytes); symlinkSync(outside, path.join(f.root, 'outside-alias'));
  for (const file of ['private-alias/private.png', 'outside-alias/outside.png', '.mioon-store/private.png', '../outside.png']) await assert.rejects(f.prepare(file));
  assert.throws(() => createMioProjectImport({store: {...f.store}, services: f.services, privateDirectories: f.privateDirectories}), {code: 'MEDIA_CHANGED_DURING_READ'});
  await assert.rejects(f.port.prepare(randomUUID(), {path: 'source.png'}, f.context), {code: 'AGENT_TASK_INVALID_TARGET'});
  assert.equal(f.store.list('assets', f.store.projectId).length, 0); assert.deepEqual(readFileSync(privateFile), f.bytes);
});

for (const mutation of ['replacement', 'same-inode'] as const) test(`source ${mutation} with the old size and timestamp cannot replace an approved proof`, async t => {
  const f = await fixture(t), prepared = await f.prepare(), before = lstatSync(f.source, {bigint: true});
  if (mutation === 'replacement') {renameSync(f.source, f.source + '.original'); writeFileSync(f.source, f.bytes); assert.notEqual(lstatSync(f.source, {bigint: true}).ino, before.ino);}
  else {const changed = Buffer.from(f.bytes); changed[changed.length - 1] ^= 1; writeFileSync(f.source, changed); assert.equal(lstatSync(f.source, {bigint: true}).ino, before.ino);}
  utimesSync(f.source, f.time, f.time); const changed = lstatSync(f.source, {bigint: true}); assert.equal(changed.size, before.size); assert.equal(changed.mtimeNs, before.mtimeNs);
  await assert.rejects(f.port.prepare(f.store.projectId, {path: 'source.png'}, {...f.context, requestId: prepared.input.requestId, retained: prepared}), {code: 'AGENT_TASK_TARGET_CHANGED'});
  await assert.rejects(f.port.execute(prepared, {beforeEffect() {}, recordCreatedInside() {assert.fail('A changed proof cannot create');}}), {code: 'AGENT_TASK_TARGET_CHANGED'});
  assert.equal(f.store.list('assets', f.store.projectId).length, 0);
});

test('publication metadata excludes an unfinished real output and all of its visible inode aliases', async t => {
  const f = await fixture(t), directory = path.join(f.store.tempDir, 'publication-fixture'); ensurePrivateDirectory(directory, {create: true});
  const stageFile = path.join(directory, 'complete.png'); writeFileSync(stageFile, f.bytes, {mode: 0o600});
  let relativePath: string | undefined; const stop = new Error('Before database registration');
  const remove = setProjectOutputPublicationTestHooks(f.store, {fault(point, proof) {if (point === 'after_final') {relativePath = proof.relativePath; throw stop;}}});
  t.after(remove);
  await assert.rejects(publishProjectOutput(f.store, {owner: {kind: 'image', id: randomUUID(), requestId: randomUUID(), inputHash: 'a'.repeat(64)},
    assetId: randomUUID(), targetKind: 'generated', stageFile, mimeType: 'image/png', sha256: createHash('sha256').update(f.bytes).digest('hex'), sizeBytes: f.bytes.length}), error => error === stop);
  remove(); assert.ok(relativePath); linkSync(path.join(f.root, relativePath), path.join(f.root, 'visible-alias.png'));
  const before = readFileSync(path.join(f.root, relativePath));
  await assert.rejects(f.prepare(relativePath), {code: 'AGENT_TASK_INVALID_TARGET'});
  await assert.rejects(f.prepare('visible-alias.png'), {code: 'AGENT_TASK_INVALID_TARGET'});
  assert.deepEqual(readFileSync(path.join(f.root, relativePath)), before); assert.equal(f.store.list('assets', f.store.projectId).length, 0);
});

test('caller, host and exact live project identities are rechecked before registration', async t => {
  const f = await fixture(t), host = new AbortController(), port = createMioProjectImport({store: f.store, services: f.services, privateDirectories: f.privateDirectories, signal: host.signal});
  const caller = new AbortController(); caller.abort(new Error('Caller ended'));
  await assert.rejects(port.prepare(f.store.projectId, {path: 'source.png'}, {...f.context, signal: caller.signal}), /Caller ended/u);
  const prepared = await port.prepare(f.store.projectId, {path: 'source.png'}, f.context); host.abort(new Error('Host ended'));
  await assert.rejects(port.execute(prepared, {beforeEffect() {}, recordCreatedInside() {assert.fail('A closed host cannot register');}}), {name: 'AbortError', code: 'OPERATION_CANCELLED'});
  const old = await f.prepare();
  const project = f.store.get('projects', f.store.projectId); assert.ok(project); f.store.put('projects', {...project, createdAt: '2026-11-04T00:00:00.000Z'});
  await assert.rejects(f.port.execute(old, {beforeEffect() {}, recordCreatedInside() {assert.fail('A replacement project cannot register');}}), {code: 'MEDIA_CHANGED_DURING_READ'});
  assert.equal(f.store.list('assets', f.store.projectId).length, 0); assert.deepEqual(readFileSync(f.source), f.bytes);
});
