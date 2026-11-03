import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {withoutForeignKeys} from './helpers/project-database.ts';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices, canonical} from '../packages/business/src/services.ts';

interface ScopeFixture {
  root: string; store: ReturnType<typeof openStore>; services: ReturnType<typeof createServices>;
  project: {id: string}; other: {id: string}; shot: {id: string; revision: number};
}
interface ShotRecordView {projectId: string; title: string; revision: number; prompt: string}
async function fixture(t: TestContext): Promise<ScopeFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-edit-scope-'));
  const store = openStore(root), services = createServices(store, new Map());
  t.after(async () => { store.close(); await rm(root, {recursive: true, force: true}); });
  const project = await services.call('project.create', {name: 'Approved project'}) as {id: string};
  const foreign=openStore(path.join(root,'foreign'));
  const foreignServices=foreign?createServices(foreign,new Map()):services;
  const other = await foreignServices.call('project.create', {name: 'Other private project'}) as {id: string};
  t.after(async()=>{if(foreign){await foreignServices.drain();foreign.close();}await services.drain();});
  const shot = await services.call('shot.create', {projectId: project.id, title: 'Original saved title'}) as {id: string; revision: number};
  return {root, store, services, project, other, shot};
}
async function reassignWhileLocked(t: TestContext, f: ScopeFixture, corrupt = false): Promise<void> {
  // The kernel excludes a second connection. Fault injection uses its actual
  // owner, then observes that the scoped lookup still happens inside tx.
  const shot = f.store.get('shots', f.shot.id) as unknown as ShotRecordView;
  withoutForeignKeys(f.store.db, () => f.store.db.prepare('UPDATE shots SET projectId=?,data=? WHERE id=?')
    .run(f.other.id, corrupt ? '{' : JSON.stringify({...shot, projectId:f.other.id, title:'FOREIGN_SCOPE_SECRET'}), f.shot.id));
  const prepare = f.store.db.prepare, reads: boolean[] = [];
  t.mock.method(f.store.db, 'prepare', function(this: typeof f.store.db, sql: string) {
    if (/^SELECT id,projectId,data FROM shots WHERE id=/u.test(sql)) reads.push(this.isTransaction);
    return prepare.call(this, sql);
  });
  t.after(() => {assert.ok(reads.length > 0);assert.ok(reads.every(Boolean), 'foreign-owner reads happen inside the real kernel transaction');});
}
const inputFor = (f: ScopeFixture) => ({shotId: f.shot.id, expectedRevision: f.shot.revision,
  patch: {prompt: 'Approved prompt'}, requestId: randomUUID()});
const noForeign = (error: unknown): boolean => {const failure = error as {code?: string; status?: number; message?: string}; return failure.code === 'NOT_FOUND' && failure.status === 404 && !JSON.stringify(error).includes('FOREIGN_SCOPE_SECRET');};

for (const replay of [false, true]) test(`scoped shot update checks owner inside the SQLite lock on ${replay ? 'exact replay' : 'new dispatch'} after trusted owner-connection reassignment`, async (t: TestContext) => {
  const f = await fixture(t), input = inputFor(f);
  let original: {revision: number} | undefined;
  if (replay) original = await f.services.updateShotInProject(f.project.id, input) as {revision: number};
  const priorCount = (f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get() as {n: number}).n;
  // This genuine preflight snapshot becomes obsolete before BEGIN IMMEDIATE.
  assert.equal((f.store.get('shots', f.shot.id) as unknown as ShotRecordView).projectId, f.project.id);
  const ended = await reassignWhileLocked(t, f);
  const changes = (f.store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n;
  await assert.rejects(f.services.updateShotInProject(f.project.id, input), noForeign);
  await ended;
  assert.equal((f.store.db.prepare('SELECT total_changes() AS n').get() as {n: number}).n, changes);
  const foreign = f.store.get('shots', f.shot.id) as unknown as ShotRecordView;
  assert.equal(foreign.projectId, f.other.id); assert.equal(foreign.title, 'FOREIGN_SCOPE_SECRET');
  assert.equal(foreign.revision, replay ? original!.revision : f.shot.revision);
  assert.equal(foreign.prompt, replay ? 'Approved prompt' : '');
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get() as {n: number}).n, priorCount);
  if (replay) {
    await assert.rejects(f.services.updateShotInProject(f.other.id, input), (error: unknown) => (error as {code?: string}).code === 'NOT_FOUND');
    const receipt = f.store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(input.requestId) as {projectId: string; canonicalInput: string; response: string} | undefined; assert.ok(receipt);
    const {requestId, ...fields} = input;
    assert.equal(receipt.projectId, f.project.id); assert.equal(receipt.canonicalInput, canonical(fields));
    assert.deepEqual(JSON.parse(receipt.response), original);
  }
});

test('scoped foreign target rejects before decoding corrupt foreign text; helper is absent from RPC handlers', async (t: TestContext) => {
  const f = await fixture(t), input = inputFor(f), ended = await reassignWhileLocked(t, f, true);
  await assert.rejects(f.services.updateShotInProject(f.project.id, input), noForeign); await ended;
  assert.equal(Object.hasOwn(f.services.handlers, 'updateShotInProject'), false);
  await assert.rejects(f.services.call('updateShotInProject', input), (error: unknown) => (error as {code?: string}).code === 'UNKNOWN_OPERATION');
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get() as {n: number}).n, 0);
});

test('scoped and ordinary shared shot.update preserve one exact journal and historical response', async (t: TestContext) => {
  const f = await fixture(t), input = inputFor(f);
  const original = await f.services.updateShotInProject(f.project.id, input) as {revision: number};
  await f.services.call('shot.update', {shotId: f.shot.id, expectedRevision: original.revision, patch: {title: 'Later ordinary edit'}});
  assert.deepEqual(await f.services.call('shot.update', input), original);
  assert.deepEqual(await f.services.updateShotInProject(f.project.id, input), original);
  assert.equal((f.store.db.prepare('SELECT count(*) AS n FROM mutation_requests').get() as {n: number}).n, 1);
  assert.equal((f.store.get('shots', f.shot.id) as unknown as ShotRecordView).title, 'Later ordinary edit');
});
