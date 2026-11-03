import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createMioProjectMedia} from '../packages/business/src/agent/mio-project-media.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-media-host-'));
  const store = openStore(path.join(root, 'project')), application = openAppLibrary({dataDir: path.join(root, 'app')});
  t.after(() => {store.close(); application.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId, name: 'Working directory', createdAt: '2026-11-04T00:00:00.000Z'});
  return {root, store, application, media: createMioProjectMedia({store}), context: {beforeEffect() {}}};
}
function childWrite(file: string): unknown {
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    let db;
    try {db = new DatabaseSync(process.argv[1], {timeout:0});db.exec('BEGIN IMMEDIATE;ROLLBACK');process.stdout.write(JSON.stringify({ok:true}));}
    catch(error){process.stdout.write(JSON.stringify({ok:false,errcode:error.errcode}));}
    finally{db?.close();}
  `, file], {encoding: 'utf8', timeout: 60_000});
  assert.equal(probe.status, 0, probe.stderr); return JSON.parse(probe.stdout);
}

for (const kind of ['project', 'history', 'cache', 'application'] as const) {
  test(`real host excludes a hard link of the held ${kind} before opening it and preserves its cross-process write lock`, async t => {
    const f = fixture(t);
    const baseline = (await f.media.list(f.store.projectId, {}, f.context)).entries;
    assert.ok(baseline.every(entry => entry.kind === 'folder'));
    const files = {project: f.store.projectFile, history: path.join(f.store.localDir, 'history.db'), cache: path.join(f.store.cacheDir, 'cache.db'), application: f.application.databaseFile};
    linkSync(files[kind], path.join(f.store.projectDir, `${kind}.png`));
    writeFileSync(path.join(f.store.projectDir, 'visible.png'), PNG);
    assert.deepEqual(childWrite(files[kind]), {ok: false, errcode: 5});
    const before = f.store.db.prepare('SELECT total_changes() AS n').get()?.n;
    const page = await f.media.list(f.store.projectId, {}, f.context);
    assert.deepEqual(page.entries, [...baseline, {name: 'visible.png', kind: 'image', mimeType: 'image/png', sizeBytes: PNG.length, durationSeconds: null}]);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()?.n, before);
    assert.deepEqual(childWrite(files[kind]), {ok: false, errcode: 5});
    assert.ok(!JSON.stringify(page).includes(f.root));
  });
}

test('host fixes the exact project root, rejects copied stores, foreign owners and outside aliases', async t => {
  const f = fixture(t), baseline = (await f.media.list(f.store.projectId, {}, f.context)).entries;
  mkdirSync(path.join(f.root, 'outside')); writeFileSync(path.join(f.root, 'outside', 'outside.png'), PNG);
  symlinkSync(path.join(f.root, 'outside'), path.join(f.store.projectDir, 'outside'));
  assert.throws(() => createMioProjectMedia({store: {...f.store}}), {code: 'MEDIA_CHANGED_DURING_READ'});
  await assert.rejects(f.media.list('22222222-2222-4222-8222-222222222222', {}, f.context), {code: 'MEDIA_CHANGED_DURING_READ'});
  await assert.rejects(f.media.list(f.store.projectId, {directory: 'outside'}, f.context), {code: 'MEDIA_LIST_PATH_INVALID'});
  await assert.rejects(f.media.list(f.store.projectId, {directory: '../outside'}, f.context), {code: 'MEDIA_LIST_PATH_INVALID'});
  assert.deepEqual((await f.media.list(f.store.projectId, {}, f.context)).entries, baseline);
});

test('project identity and host/caller lifetimes fence each effect, including replacements and late results', async t => {
  const f = fixture(t), controller = new AbortController(), host = createMioProjectMedia({store: f.store, signal: controller.signal});
  writeFileSync(path.join(f.store.projectDir, 'visible.png'), PNG);
  const caller = new AbortController(); caller.abort(new Error('caller ended'));
  await assert.rejects(host.list(f.store.projectId, {}, {...f.context, signal: caller.signal}), /caller ended/u);
  let calls = 0;
  await assert.rejects(host.list(f.store.projectId, {}, {beforeEffect() {if (++calls === 3) controller.abort(new Error('host ended'));}}), /host ended/u);
  const moved = path.join(f.root, 'moved-project');
  renameSync(f.store.projectDir, moved); mkdirSync(f.store.projectDir); writeFileSync(f.store.projectFile, 'replacement');
  await assert.rejects(f.media.list(f.store.projectId, {}, f.context), {code: 'MEDIA_CHANGED_DURING_READ'});
});

test('a closed store and changed physical project row cannot authorize another listing', async t => {
  const f = fixture(t);
  await f.media.list(f.store.projectId, {}, f.context);
  f.store.db.prepare('UPDATE project.projects SET data=? WHERE id=?').run(JSON.stringify({id: f.store.projectId, createdAt: 'replacement'}), f.store.projectId);
  await assert.rejects(f.media.list(f.store.projectId, {}, f.context), {code: 'MEDIA_CHANGED_DURING_READ'});
  f.store.close();
  await assert.rejects(f.media.list(f.store.projectId, {}, f.context), {code: 'MEDIA_CHANGED_DURING_READ'});
});
