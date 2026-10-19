import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices, canonical} from '../packages/business/src/services.ts';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-edit-scope-'));
  const store = openStore(root), services = createServices(store, new Map());
  t.after(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
  const project = await services.call('project.create', {name: 'Approved project'});
  const other = await services.call('project.create', {name: 'Other private project'});
  const shot = await services.call('shot.create', {projectId: project.id, title: 'Original saved title'});
  return {root, store, services, project, other, shot};
}
async function reassignWhileLocked(t, f, corrupt = false) {
  const child = fork(fileURLToPath(new URL('./helpers/agent-edit-scope-writer.ts', import.meta.url)),
    [path.join(f.root, 'workbench.sqlite'), f.shot.id, f.other.id, corrupt ? 'yes' : 'no'],
    {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', bytes => { stderr += bytes; });
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 && signal === null ? resolve() : reject(Error(stderr || `writer ${code}/${signal}`))); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await ended.catch(() => {}); });
  await Promise.race([new Promise(resolve => child.once('message', message => { assert.equal(message.type, 'locked'); resolve(); })), ended.then(() => { throw Error('writer exited before lock'); })]);
  return ended;
}
const inputFor = f => ({shotId: f.shot.id, expectedRevision: f.shot.revision,
  patch: {prompt: 'Approved prompt'}, requestId: randomUUID()});
const noForeign = error => error.code === 'NOT_FOUND' && error.status === 404 && !JSON.stringify(error).includes('FOREIGN_SCOPE_SECRET');

for (const replay of [false, true]) test(`scoped shot update checks owner inside the SQLite lock on ${replay ? 'exact replay' : 'new dispatch'} after a separate writer reassigns it`, async t => {
  const f = await fixture(t), input = inputFor(f);
  let original;
  if (replay) original = await f.services.updateShotInProject(f.project.id, input);
  const priorCount = f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get().n;
  // This genuine preflight snapshot becomes obsolete before BEGIN IMMEDIATE.
  assert.equal(f.store.get('shots', f.shot.id).projectId, f.project.id);
  const ended = await reassignWhileLocked(t, f);
  const changes = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(f.services.updateShotInProject(f.project.id, input), noForeign);
  await ended;
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, changes);
  const foreign = f.store.get('shots', f.shot.id);
  assert.equal(foreign.projectId, f.other.id); assert.equal(foreign.title, 'FOREIGN_SCOPE_SECRET');
  assert.equal(foreign.revision, replay ? original.revision : f.shot.revision);
  assert.equal(foreign.prompt, replay ? 'Approved prompt' : '');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get().n, priorCount);
  if (replay) {
    await assert.rejects(f.services.updateShotInProject(f.other.id, input), error => error.code === 'IDEMPOTENCY_CONFLICT');
    const receipt = f.store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(input.requestId);
    const {requestId, ...fields} = input;
    assert.equal(receipt.projectId, f.project.id); assert.equal(receipt.canonicalInput, canonical(fields));
    assert.deepEqual(JSON.parse(receipt.response), original);
  }
});

test('scoped foreign target rejects before decoding corrupt foreign text; helper is absent from RPC handlers', async t => {
  const f = await fixture(t), input = inputFor(f), ended = await reassignWhileLocked(t, f, true);
  await assert.rejects(f.services.updateShotInProject(f.project.id, input), noForeign); await ended;
  assert.equal(Object.hasOwn(f.services.handlers, 'updateShotInProject'), false);
  await assert.rejects(f.services.call('updateShotInProject', input), error => error.code === 'UNKNOWN_OPERATION');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get().n, 0);
});

test('scoped and ordinary shared shot.update preserve one exact journal and historical response', async t => {
  const f = await fixture(t), input = inputFor(f);
  const original = await f.services.updateShotInProject(f.project.id, input);
  await f.services.call('shot.update', {shotId: f.shot.id, expectedRevision: original.revision, patch: {title: 'Later ordinary edit'}});
  assert.deepEqual(await f.services.call('shot.update', input), original);
  assert.deepEqual(await f.services.updateShotInProject(f.project.id, input), original);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get().n, 1);
  assert.equal(f.store.get('shots', f.shot.id).title, 'Later ordinary edit');
});
