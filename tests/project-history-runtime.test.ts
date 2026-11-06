import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProjectHistoryClient, ProjectHistoryError} from '../apps/web/src/project-history-client.ts';
import type {ProjectHistoryClient} from '../apps/web/src/project-history-client.ts';
import {createProjectHistoryRuntime,projectHistoryRuntime} from '../apps/web/src/project-history-runtime.ts';
import type {ProjectVersionPreviewResponse} from '../packages/contracts/src/project-version-operations.ts';
import type {ProjectBackupRestoreInput, ProjectBackupRestoreResponse} from '../packages/contracts/src/project-backups.ts';

const projectId = randomUUID(), versionId = randomUUID(), backupId = randomUUID(), timestamp = '2026-11-04T12:00:00.000Z';
const summary = {id: versionId, projectId, trigger: 'manual' as const, name: 'First', mioRunId: null, contentSequence: 1, createdAt: timestamp};
const preview = (patch: Partial<ProjectVersionPreviewResponse> = {}): ProjectVersionPreviewResponse => ({projectId, version: summary, contentSequence: 8,
  contentToken: 'a'.repeat(32), previewDigest: 'b'.repeat(64), totalChanges: 0, keptCurrentCount: 0, changes: [], nextCursor: null, restoreAvailable: true, ...patch});
const backup = {backupId, projectId, contentSequence: 1, contentToken: 'a'.repeat(32), createdAt: timestamp, reason: 'open' as const, sizeBytes: 4096};
const inspection = {...backup, projectName: 'First', sourceProjectDir: '/projects/original', tableCounts: {projects: 1, assets: 3, timelines: 1}};
const restoredProjectId = randomUUID();
const backupResult = (input: ProjectBackupRestoreInput): ProjectBackupRestoreResponse => ({requestId: input.requestId, sourceProjectId: input.projectId, backupId: input.backupId,
  project: {projectId: restoredProjectId, projectFile: input.projectFile, name: 'Recovered', summary: null, fileIdentity: {dev: '1', ino: '2'}, lastOpenedAt: null}});
function fake(patch: Partial<ProjectHistoryClient> = {}): ProjectHistoryClient {
  return {list: async () => ({projectId, versions: [summary], nextCursor: null}), save: async input => ({projectId, requestId: input.requestId, version: {...summary, name: input.name ?? null}}),
    preview: async () => preview(), restore: async input => ({projectId, requestId: input.requestId, versionId: input.versionId, beforeVersionId: randomUUID(), contentSequence: 9,
      contentToken: 'c'.repeat(32), totalChanges: 0, appliedChanges: [], keptCurrent: []}), backups: async () => ({projectId, backups: [backup]}),
    status: async () => ({projectId, state: 'idle', lastAttemptAt: null, lastCompletedAt: null, lastError: null}), inspect: async () => inspection,
    restoreBackup: async input => backupResult(input), ...patch};
}
async function settle() {for (let i = 0; i < 25; i++) await Promise.resolve();}
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}

test('history adapter uses the project and application RPC boundaries and rejects foreign replies and invalid inputs', async () => {
  const sent: Array<{url: string; input: unknown}> = [];
  const client = createProjectHistoryClient(async (url, init) => {
    const body = JSON.parse(String(init?.body)); sent.push({url: String(url), input: body.input});
    return Response.json({ok: true, data: body.operation === 'project.version.list' ? {projectId, versions: [summary], nextCursor: null} : {projectId, backups: [backup]}});
  });
  await client.list({projectId}); await client.backups({projectId});
  assert.deepEqual(sent.map(item => item.url), [`/api/projects/${projectId}/rpc`, '/api/rpc']);
  await assert.rejects(client.backups({projectId, source: '/private/source.db'} as never), error => error instanceof ProjectHistoryError && error.definitive);
  assert.equal(sent.length, 2);
  const wrong = createProjectHistoryClient(async () => Response.json({ok: true, data: {projectId: randomUUID(), versions: [summary], nextCursor: null}}));
  await assert.rejects(wrong.list({projectId}), {code: 'BACKEND_PROTOCOL_ERROR', definitive: false});
});

test('history adapter distinguishes definitive refusal from uncertain acknowledgements and never automatically repeats a write', async () => {
  for (const status of [409, 503]) {
    let calls = 0; const client = createProjectHistoryClient(async () => {calls++; return Response.json({ok: false, error: {code: 'PROJECT_HOST_BUSY'}}, {status});});
    await assert.rejects(client.save({projectId, requestId: randomUUID()}), {code: 'PROJECT_HOST_BUSY', definitive: status === 409}); assert.equal(calls, 1);
  }
  let calls = 0; const client = createProjectHistoryClient(async () => {calls++; throw Error('lost acknowledgement');});
  await assert.rejects(client.save({projectId, requestId: randomUUID()}), {code: 'BACKEND_UNAVAILABLE', definitive: false}); assert.equal(calls, 1);
  const malformed = createProjectHistoryClient(async () => new Response(new Uint8Array([0xff]), {status: 200}));
  await assert.rejects(malformed.list({projectId}), {code: 'BACKEND_UNAVAILABLE', definitive: false});
});

test('version pagination retains every page and refuses duplicate identities instead of claiming a complete list', async () => {
  const second = {...summary, id: randomUUID()}; const inputs: unknown[] = [];
  const runtime = createProjectHistoryRuntime(projectId, fake({list: async input => {inputs.push(input); return {projectId, versions: input.cursor ? [second] : [summary], nextCursor: input.cursor ? null : 'next'};}}));
  runtime.open(); await settle(); assert.equal(runtime.snapshot().versionCursor, 'next');
  await runtime.loadVersions(true); const state = runtime.snapshot(); assert.equal(state.versions.kind, 'ready');
  if (state.versions.kind === 'ready') assert.deepEqual(state.versions.value.map(item => item.id), [versionId, second.id]);
  assert.deepEqual(inputs, [{projectId, limit: 100}, {projectId, limit: 100, cursor: 'next'}]); runtime.close();
  const duplicate = createProjectHistoryRuntime(projectId, fake({list: async input => ({projectId, versions: [summary], nextCursor: input.cursor ? null : 'next'})}));
  duplicate.open(); await settle(); await duplicate.loadVersions(true); assert.equal(duplicate.snapshot().versions.kind, 'error'); duplicate.close();
});

test('preview pagination keeps actual attribution, retained reasons and full-plan identity and refuses a changed digest', async () => {
  const first = {table: 'shots' as const, key: 'shot-a', action: 'change' as const, source: 'user-or-other' as const, fields: ['title'], reason: null};
  const second = {table: 'assets' as const, key: 'asset-b', action: 'keep-current' as const, source: 'mio' as const, fields: [], reason: 'Referenced by a retained result'};
  let changed = false; const runtime = createProjectHistoryRuntime(projectId, fake({preview: async input => preview({totalChanges: 2, keptCurrentCount: 1,
    changes: input.cursor ? [second] : [first], nextCursor: input.cursor ? null : 'next', previewDigest: changed ? 'c'.repeat(64) : 'b'.repeat(64)})}));
  runtime.open(); await settle(); await runtime.select(versionId); await runtime.select(versionId, true);
  const ready = runtime.snapshot().preview; assert.equal(ready.kind, 'ready'); if (ready.kind === 'ready') {assert.deepEqual(ready.value.changes, [first, second]); assert.equal(ready.value.totalChanges, 2);}
  await runtime.select(versionId); changed = true; await runtime.select(versionId, true);
  const stale = runtime.snapshot().preview; assert.equal(stale.kind, 'error'); if (stale.kind === 'error') assert.equal(stale.code, 'PROJECT_VERSION_PREVIEW_CHANGED'); runtime.close();
});

test('closing and reopening retires old reads without losing another project or the new selected version', async () => {
  const pending = deferred<ReturnType<typeof preview>>(); const otherId = randomUUID();
  const runtime = createProjectHistoryRuntime(projectId, fake({preview: async input => input.versionId === versionId ? pending.promise : preview({version: {...summary, id: otherId}})}));
  runtime.open(); await settle(); const old = runtime.select(versionId); runtime.close(); runtime.open(); await runtime.select(otherId);
  pending.resolve(preview()); await old; const state = runtime.snapshot(); assert.equal(state.selected, otherId);
  if (state.preview.kind === 'ready') assert.equal(state.preview.value.version.id, otherId); else assert.fail('New selection was lost'); runtime.close();
});

test('version restore keeps the exact pair, digest and request through an unknown acknowledgement and closed view', async () => {
  const sent: unknown[] = []; let fail = true;
  const runtime = createProjectHistoryRuntime(projectId, fake({restore: async input => {sent.push(structuredClone(input)); if (fail) throw new ProjectHistoryError('BACKEND_UNAVAILABLE'); return fake().restore(input);}}));
  runtime.open(); await settle(); await runtime.select(versionId); await runtime.restoreVersion();
  const original = runtime.snapshot().attempt; assert.equal(original?.phase, 'unknown'); assert.equal(original?.kind, 'version');
  if (original?.kind !== 'version') assert.fail('Wrong mutation');
  assert.deepEqual(original.input, {projectId, versionId, requestId: original.input.requestId, expectedContentSequence: 8, expectedContentToken: 'a'.repeat(32), previewDigest: 'b'.repeat(64)});
  await runtime.select('current'); await runtime.save('different'); assert.equal(sent.length, 1); assert.equal(runtime.snapshot().selected, versionId);
  runtime.close();
  assert.equal(runtime.snapshot().versions.kind, 'loading'); assert.equal(runtime.snapshot().preview.kind, 'loading');
  assert.equal(runtime.snapshot().inspection, null); assert.equal(runtime.snapshot().backupSelection, null);
  assert.deepEqual(runtime.snapshot().attempt?.input, original.input, 'only the unresolved write survives closing');
  runtime.open(); await settle(); fail = false; await runtime.retry();
  assert.equal(runtime.snapshot().attempt?.phase, 'complete'); assert.deepEqual(sent[0], sent[1]); assert.equal(sent.length, 2); runtime.close();
});

test('manual save preserves its original name and request while unresolved, then permits a separate explicit request', async () => {
  const sent: unknown[] = []; let fail = true;
  const runtime = createProjectHistoryRuntime(projectId, fake({save: async input => {sent.push(structuredClone(input)); if (fail) throw new ProjectHistoryError('BACKEND_UNAVAILABLE'); return fake().save(input);}}));
  runtime.open(); await settle(); await runtime.save(' original '); await runtime.save('new'); assert.equal(sent.length, 1);
  runtime.close(); runtime.open(); fail = false; await runtime.retry(); assert.deepEqual(sent[0], sent[1]);
  runtime.dismissAttempt(); await runtime.save('new'); assert.notDeepEqual(sent[1], sent[2]); runtime.close();
  assert.equal(runtime.snapshot().attempt, null, 'completed receipts do not become an unbounded closed-project cache');
});

test('native backup cancellation and late picker results cannot issue a restore or cross an owner epoch', async () => {
  let writes = 0; const runtime = createProjectHistoryRuntime(projectId, fake({restoreBackup: async input => {writes++; return backupResult(input);}}));
  runtime.open('backups'); await settle(); await runtime.inspect(backupId); await runtime.chooseBackup(async () => null); assert.equal(writes, 0);
  const pending = deferred<ProjectBackupRestoreInput | null>(); let identity!: {projectId: string; backupId: string; requestId: string};
  const choosing = runtime.chooseBackup(async input => {identity = input; return pending.promise;}); runtime.close(); runtime.open('backups');
  pending.resolve({...identity, projectFile: '/projects/new.mioon'}); await choosing; assert.equal(writes, 0); assert.equal(runtime.snapshot().choosing, false); runtime.close();
});

test('native backup input must bind the selected source and request; unknown recovery reuses the entire original input', async () => {
  const sent: ProjectBackupRestoreInput[] = []; let fail = true;
  const runtime = createProjectHistoryRuntime(projectId, fake({restoreBackup: async input => {sent.push(structuredClone(input)); if (fail) throw new ProjectHistoryError('BACKEND_UNAVAILABLE'); return backupResult(input);}}));
  runtime.open('backups'); await settle(); await runtime.inspect(backupId);
  await assert.rejects(runtime.chooseBackup(async input => ({...input, backupId: randomUUID(), projectFile: '/projects/new.mioon'})), {code: 'BACKEND_PROTOCOL_ERROR'}); assert.equal(sent.length, 0);
  await runtime.chooseBackup(async input => ({...input, projectFile: '/projects/new.mioon'})); assert.equal(runtime.snapshot().attempt?.phase, 'unknown');
  await runtime.inspect(randomUUID()); await runtime.chooseBackup(async () => assert.fail('Unknown request cannot ask for a new path')); assert.equal(sent.length, 1);
  runtime.close(); runtime.open('backups'); await settle(); fail = false; await runtime.retry();
  assert.deepEqual(sent[0], sent[1]); assert.equal(runtime.snapshot().attempt?.phase, 'complete'); runtime.close();
});

test('a definitive restore refusal permits a new chosen target only with a fresh request, while backup reads never claim errors are empty', async () => {
  const sent: ProjectBackupRestoreInput[] = []; const runtime = createProjectHistoryRuntime(projectId, fake({restoreBackup: async input => {sent.push(input); throw new ProjectHistoryError('PROJECT_FILE_EXISTS', true);}}));
  runtime.open('backups'); await settle(); await runtime.inspect(backupId);
  await runtime.chooseBackup(async input => ({...input, projectFile: '/projects/existing.mioon'})); assert.equal(runtime.snapshot().attempt?.phase, 'rejected');
  await runtime.chooseBackup(async input => ({...input, projectFile: '/projects/new.mioon'})); assert.equal(sent.length, 2);
  assert.notEqual(sent[0]!.requestId, sent[1]!.requestId); assert.notEqual(sent[0]!.projectFile, sent[1]!.projectFile); runtime.close();
  const unavailable = createProjectHistoryRuntime(projectId, fake({backups: async () => {throw new ProjectHistoryError('PROJECT_BACKUP_INDEX_INVALID', true);}}));
  unavailable.open('backups'); await settle(); assert.equal(unavailable.snapshot().backups.kind, 'error'); assert.equal(unavailable.snapshot().attempt, null); unavailable.close();
});


test('captured history admission blocks old callbacks and discards late version and app-only backup reads',async()=>{
  for(const tab of ['versions','backups'] as const){let allowed=true,reads=0,writes=0;const pending=deferred<Awaited<ReturnType<ProjectHistoryClient['list']>>>(),backups=deferred<Awaited<ReturnType<ProjectHistoryClient['backups']>>>();
    const runtime=createProjectHistoryRuntime(projectId,fake({list:async()=>{reads++;return pending.promise;},backups:async()=>{reads++;return backups.promise;},save:async input=>{writes++;return fake().save(input);}}),undefined,{scope:'a'.repeat(64),key:'library-A:instance-A:project',isCurrent:()=>allowed});
    runtime.open(tab);await settle();const before=runtime.snapshot();allowed=false;await runtime.save('stale');await runtime.loadVersions();await runtime.loadBackups();await runtime.inspect(backupId);await runtime.retry();assert.equal(writes,0);assert.equal(reads,1);
    pending.resolve({projectId,versions:[summary],nextCursor:null});backups.resolve({projectId,backups:[backup]});await settle();assert.equal(runtime.snapshot(),before,'late data does not replace the retained view');runtime.close();
  }
});

test('lease loss during the OS picker prevents restore and a dispatched late ACK preserves the exact unknown intent',async()=>{
  let allowed=true,writes=0;const picker=deferred<ProjectBackupRestoreInput|null>(),ack=deferred<Awaited<ReturnType<ProjectHistoryClient['save']>>>();
  const runtime=createProjectHistoryRuntime(projectId,fake({restoreBackup:async input=>{writes++;return backupResult(input);},save:async()=>{writes++;return ack.promise;}}),undefined,{scope:'a'.repeat(64),key:'library-A:instance-A',isCurrent:()=>allowed});
  runtime.open('backups');await settle();await runtime.inspect(backupId);let input!:ProjectBackupRestoreInput;const choosing=runtime.chooseBackup(async value=>{input={...value,projectFile:'/projects/recovered.mioon'};return picker.promise;});allowed=false;picker.resolve(input);await choosing;assert.equal(writes,0);runtime.close();allowed=true;runtime.open();await settle();const saving=runtime.save('exact original');const original=runtime.snapshot().attempt;assert.ok(original);allowed=false;ack.resolve({projectId,requestId:original.input.requestId,version:summary});await saving;
  assert.equal(runtime.snapshot().attempt?.phase,'unknown');assert.deepEqual(runtime.snapshot().attempt?.input,original.input);await runtime.retry();assert.equal(writes,1);runtime.close();
});

test('retained unknown history for the same UUID is isolated by application scope and instance',async t=>{
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('synthetic lost ACK');};t.after(()=>{globalThis.fetch=originalFetch;});
  const id=randomUUID(),a=projectHistoryRuntime(id,{scope:'a'.repeat(64),key:'scope-A:instance-A',isCurrent:()=>true});a.open();await settle();await a.save('original');const pending=a.snapshot().attempt;assert.equal(pending?.phase,'unknown');a.close();
  const b=projectHistoryRuntime(id,{scope:'a'.repeat(64),key:'scope-B:instance-B',isCurrent:()=>true});assert.notEqual(a,b);assert.equal(b.snapshot().attempt,null);assert.equal(projectHistoryRuntime(id,{scope:'a'.repeat(64),key:'scope-A:instance-A',isCurrent:()=>true}),a);assert.deepEqual(a.snapshot().attempt?.input,pending?.input);b.close();
});
