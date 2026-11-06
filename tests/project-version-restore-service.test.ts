import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';
import {pruneProjectVersionsInside} from '../packages/business/src/project-versions/retention.ts';
import {captureProjectDocumentInside,canonicalJson} from '../packages/business/src/project-versions/document.ts';
import {buildRestorePlan,projectVersionDifferenceForDisplay} from '../packages/business/src/project-versions/preview.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'version-restore-service-'));
  const {store, projectId} = createServerProject(root, {name: 'Original'});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  let guard: () => void = () => {};
  let busy = false;
  const api = createProjectVersions(store, {assertMutationAllowed: () => guard(), assertRestoreAllowed: () => {
    if (busy) throw Object.assign(Error('Busy'), {code: 'PROJECT_HOST_BUSY'});
  }});
  const save = () => api.save({projectId, requestId: randomUUID()});
  const rename = (name: string) => store.put('projects', {...(store.get('projects', projectId) as {id: string; name: string}), name});
  const select = (versionId: string) => {
    const preview = api.preview({projectId, versionId});
    return {projectId, versionId, requestId: randomUUID(), expectedContentSequence: preview.contentSequence, expectedContentToken: preview.contentToken, previewDigest: preview.previewDigest};
  };
  const state = () => Object.fromEntries(['project.projects', 'project.project_file', 'project.agent_task_target_revisions_v2',
    'main.project_versions', 'main.project_version_blobs', 'main.project_version_requests', 'main.project_version_capture_marks']
    .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return {store, projectId, api, save, rename, select, state, guard: (fn: () => void) => {guard = fn;}, busy: (value: boolean) => {busy = value;}};
}

test('restore atomically saves its before-state, advances revisions and replays its exact ACK after later changes', t => {
  const f = fixture(t), saved = f.save();
  f.rename('Changed');
  const input = f.select(saved.version.id), result = f.api.restore(input);
  assert.equal((f.store.get('projects', f.projectId) as {name: string}).name, 'Original');
  assert.ok(result.contentSequence > input.expectedContentSequence);
  assert.equal(result.totalChanges, 1); assert.deepEqual(result.keptCurrent, []);
  const before = f.api.list({projectId: f.projectId}).versions.find(row => row.id === result.beforeVersionId)!;
  assert.equal(before.trigger, 'restore'); assert.equal(before.contentSequence, input.expectedContentSequence);
  assert.equal(f.api.preview({projectId: f.projectId, versionId: result.beforeVersionId}).changes.length, 1);
  f.rename('A later user change'); f.busy(true);
  const state = f.state();
  assert.deepEqual(f.api.restore(input), result, 'ACK replay precedes the busy check and baseline check');
  assert.deepEqual(f.state(), state);
  assert.throws(() => f.api.restore({...input, previewDigest: 'a'.repeat(64)}), {code: 'REQUEST_ID_REUSED'});
  assert.deepEqual(f.state(), state);
  const refusal = Error('Owner stopped'); f.guard(() => {throw refusal;});
  assert.throws(() => f.api.restore(input), error => error === refusal);
  assert.deepEqual(f.state(), state, 'even ACK retry cannot revive an invalid write owner');
});

test('restore refuses stale sequence, changed full digest and busy owner without history or content writes', t => {
  const f = fixture(t), saved = f.save(); f.rename('Changed');
  const input = f.select(saved.version.id), before = f.state();
  assert.throws(() => f.api.restore({...input, previewDigest: 'a'.repeat(64)}), {code: 'PROJECT_VERSION_PREVIEW_CHANGED'});
  assert.deepEqual(f.state(), before);
  f.busy(true); assert.throws(() => f.api.restore(input), {code: 'PROJECT_HOST_BUSY'}); f.busy(false);
  assert.deepEqual(f.state(), before);
  f.rename('Changed again'); const newer = f.state();
  assert.throws(() => f.api.restore(input), {code: 'PROJECT_VERSION_BASELINE_CHANGED'});
  assert.deepEqual(f.state(), newer);
  assert.throws(() => f.api.restore({...input, projectId: randomUUID()}), {code: 'PROJECT_ID_MISMATCH'});
  assert.deepEqual(f.state(), newer);
});

test('failure after application rolls back content, target revisions, before-version and request receipt together', t => {
  const f = fixture(t), saved = f.save(); f.rename('Changed');
  const input = f.select(saved.version.id), before = f.state();
  const remove = registerProjectTransactionObserver(f.store.db, () => {throw Error('Injected restore COMMIT failure');});
  assert.throws(() => f.api.restore(input), /Injected restore COMMIT failure/u); remove();
  assert.deepEqual(f.state(), before);
  const result = f.api.restore(input); assert.equal(result.requestId, input.requestId);
  assert.equal((f.store.get('projects', f.projectId) as {name: string}).name, 'Original');
});

test('a full receipt beyond the existing 64 KiB bound fails without applying or truncating the plan', t => {
  const f = fixture(t), saved = f.save();
  f.store.tx(() => {for (let index = 0; index < 500; index++) f.store.put('shots', {id: randomUUID(), projectId: f.projectId,
    title: `New ${index}`, revision: 1, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z'});});
  const input = f.select(saved.version.id), before = f.state(), shots = f.store.list('shots', f.projectId);
  assert.equal(f.api.preview({projectId: f.projectId, versionId: saved.version.id}).totalChanges, 500);
  assert.throws(() => f.api.restore(input), {code: 'PROJECT_VERSION_RECEIPT_LIMIT', status: 413});
  assert.deepEqual(f.state(), before); assert.deepEqual(f.store.list('shots', f.projectId), shots);
});

test('confirmation and the complete successful receipt cover differences beyond the first two hundred', t => {
  const f = fixture(t), saved = f.save();
  const ids = Array.from({length: 205}, () => randomUUID()).sort();
  f.store.tx(() => {for (const id of ids) f.store.put('shots', {id, projectId: f.projectId,
    title: 'New', revision: 1, createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z'});});
  const original = f.select(saved.version.id), tail = ids.at(-1)!;
  f.store.put('shots', {...(f.store.get('shots', tail) as Record<string, unknown>), title: 'Changed beyond the first two pages'});
  const current = f.select(saved.version.id), before = f.state();
  assert.notEqual(original.previewDigest, current.previewDigest);
  assert.throws(() => f.api.restore({...original, expectedContentSequence: current.expectedContentSequence, expectedContentToken: current.expectedContentToken}), {code: 'PROJECT_VERSION_PREVIEW_CHANGED'});
  assert.deepEqual(f.state(), before); assert.equal(f.store.list('shots', f.projectId).length, 205);
  const result = f.api.restore(current);
  assert.equal(result.totalChanges, 205); assert.equal(result.appliedChanges.length, 205);
  assert.ok(result.appliedChanges.some(change => change.key.includes(tail)));
  assert.deepEqual(result.keptCurrent, []); assert.deepEqual(f.store.list('shots', f.projectId), []);
  assert.deepEqual(f.api.restore(current), result);
});

test('an automatic target may be pruned after success while the original restore receipt remains replayable', t => {
  t.mock.timers.enable({apis: ['Date'], now: new Date('2026-10-01T00:00:00.000Z')});
  const f = fixture(t), original = f.save(); f.rename('Changed');
  const first = f.api.restore(f.select(original.version.id));
  const automatic = first.beforeVersionId, input = f.select(automatic), restored = f.api.restore(input);
  t.mock.timers.tick(40 * 24 * 60 * 60 * 1000);
  f.store.tx(() => pruneProjectVersionsInside(f.store.db, {projectId: f.projectId, timeZone: 'UTC'}));
  // Twenty newer automatic versions evict the selected automatic target.
  for (let index = 0; index < 22; index++) {
    f.rename(`Later ${index}`); f.api.restore(f.select(original.version.id));
  }
  assert.equal(f.store.db.prepare('SELECT 1 FROM main.project_versions WHERE id=?').get(automatic), undefined);
  const before = f.state(); assert.deepEqual(f.api.restore(input), restored); assert.deepEqual(f.state(), before);
});

test('localized preview codes do not alter confirmation digest or stored restoration receipts', t => {
  const f=fixture(t),savedDocument=f.store.tx(()=>captureProjectDocumentInside(f.store)),saved=f.save(),assetId=randomUUID();
  f.store.put('assets',{id:assetId,projectId:f.projectId,name:'Retained asset'});
  f.store.db.prepare('INSERT INTO project.asset_annotations(assetId,projectId,revision,tags,note) VALUES(?,?,1,?,?)').run(assetId,f.projectId,'["current"]','Current annotation');
  const before=f.state();
  const confirmed=f.store.tx(()=>{
    const current=captureProjectDocumentInside(f.store),stamp=readProjectContentStamp(f.store.db);
    const row=f.store.db.prepare('SELECT blobHash,mioChangeRowid FROM main.project_versions WHERE id=?').get(saved.version.id)!;
    const plan=buildRestorePlan(f.store,savedDocument,current,Number(row.mioChangeRowid),saved.version.createdAt),raw=JSON.stringify(plan.changes);
    const digest=createHash('sha256').update(canonicalJson({versionId:saved.version.id,blobHash:row.blobHash,current,contentToken:stamp.contentToken,changes:plan.changes})).digest('hex');
    const displayed=plan.changes.map(projectVersionDifferenceForDisplay);
    assert.ok(displayed.some(row=>row.reasonCode==='PROJECT_VERSION_ANNOTATION_IDENTITY_CURRENT'));
    assert.equal(JSON.stringify(plan.changes),raw);
    return {digest,displayed};
  });
  const preview=f.api.preview({projectId:f.projectId,versionId:saved.version.id});
  assert.equal(preview.previewDigest,confirmed.digest);assert.deepEqual(preview.changes,confirmed.displayed);assert.deepEqual(f.state(),before);
  const input=f.select(saved.version.id),restored=f.api.restore(input);
  const response=String(f.store.db.prepare('SELECT response FROM main.project_version_requests WHERE requestId=?').get(input.requestId)!.response);
  assert.equal(response,JSON.stringify(restored));
  assert.equal(response.includes('reasonCode'),false);
  assert.ok(restored.keptCurrent.some(row=>row.reason!==null));
  f.rename('Later edit');f.busy(true);const after=f.state();
  assert.deepEqual(f.api.restore(input),restored);assert.deepEqual(f.state(),after);
  assert.equal(f.store.db.prepare('SELECT response FROM main.project_version_requests WHERE requestId=?').get(input.requestId)!.response,response);
});

test('a historical reason-only ACK replays verbatim without assigning a new reason code or writing state', t => {
  const f=fixture(t),input={projectId:f.projectId,requestId:randomUUID(),versionId:randomUUID(),expectedContentSequence:0,expectedContentToken:'a'.repeat(32),previewDigest:'b'.repeat(64)};
  const receipt={projectId:f.projectId,requestId:input.requestId,versionId:input.versionId,beforeVersionId:randomUUID(),contentSequence:1,contentToken:'c'.repeat(32),
    totalChanges:1,appliedChanges:[],keptCurrent:[{table:'assets',key:JSON.stringify([randomUUID()]),action:'keep-current',source:'user-or-other',fields:[],
      reason:'素材文件定位及其引用修订保持当前，其他可变内容按版本恢复。'}]};
  const response=JSON.stringify(receipt),digest=createHash('sha256').update(canonicalJson({operation:'project.version.restore',...input})).digest('hex');
  f.store.db.prepare("INSERT INTO main.project_version_requests(projectId,requestId,operation,inputDigest,response) VALUES(?,?,'project.version.restore',?,?)").run(f.projectId,input.requestId,digest,response);
  f.busy(true);const before=f.state(),changes=f.store.db.prepare('SELECT total_changes() n').get()!.n,result=f.api.restore(input);
  assert.deepEqual(result,receipt);assert.equal(JSON.stringify(result),response);assert.equal(Object.hasOwn(result.keptCurrent[0]!,'reasonCode'),false);
  assert.equal(f.store.db.prepare('SELECT response FROM main.project_version_requests WHERE requestId=?').get(input.requestId)!.response,response);
  assert.deepEqual(f.state(),before);assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);
});
