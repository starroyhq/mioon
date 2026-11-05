import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {projectDeleteResponseSchema} from '../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDeleteResponse} from '../packages/contracts/src/project-lifecycle.ts';
import type {LocalShotTextEnvelope} from '../packages/contracts/src/local-shot-text.ts';
import {trashFixture, data, fileTree, logicalState, awaitClosed, token, type Wire} from './helpers/project-trash-server-fixture.ts';

const deny = (result: Wire, code: string, status = 409) => {
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.ok, false); assert.equal(result.body.error?.code, code);
};
const retainedApp = (state: ReturnType<typeof logicalState>) => state.map(database => ({...database,
  tables: database.tables.filter(table => !['recent_projects', 'app_operation_receipts'].includes(String(table.name)))}));

test('native trash moves only the closed project file and replays its fixed receipt without touching a later file', async t => {
  const f = await trashFixture(t), input = f.input(); assert.ok(f.native.trash);
  const before = f.retained(), state = f.closedState(), app = f.appState(), parent = lstatSync(f.sourceDir, {bigint:true});
  const peers = f.native.listRecent().registered.filter(entry => entry.project.projectId !== f.sourceId);
  const history = state.find(database => database.database === 'history')!;
  assert.ok(history.tables.find(table => table.name === 'project_versions')!.rows.length > 0);
  assert.ok(history.tables.find(table => table.name === 'mio_conversation_policies')!.rows.length > 0);
  assert.equal(existsSync(f.backupFile),true,'the retained set includes a validated native project backup, not only sentinel files');
  assert.equal(history.tables.find(table => table.name === 'mio_runs')!.rows.find(row => row.id === f.seeded.runId)!.status, 'completed');
  const response = projectDeleteResponseSchema.parse(await f.native.trash(input));
  assert.deepEqual(response, {requestId:input.requestId,projectId:f.sourceId,projectFile:f.sourceFile,trashed:true,records:'retained'});
  assert.equal(f.calls.length, 1); assert.equal(f.reservations.length, 1); assert.deepEqual(f.releases, f.reservations);
  assert.equal(existsSync(f.sourceFile), false); const trashed = path.join(f.bin, input.requestId + '.mioon'); assert.equal(existsSync(trashed), true);
  const after = f.retained();
  assert.deepEqual(after.source, (before.source as Array<{name:string}>).filter(item => item.name !== path.basename(f.sourceFile)));
  assert.deepEqual({...after,source:null}, {...before,source:null}, 'media, local history/cache/versions/backups/imports, fork archive and the other project stay byte-identical');
  assert.deepEqual(f.closedState(trashed), state, 'content, versions, retained Mio and terminal policy rows are not cascaded away');
  assert.equal(lstatSync(f.sourceDir, {bigint:true}).ino, parent.ino); assert.equal(lstatSync(f.sourceDir, {bigint:true}).dev, parent.dev);
  assert.deepEqual(f.native.listRecent().registered, peers); assert.deepEqual(retainedApp(f.appState()), retainedApp(app));
  const receipt = f.appState()[0]!.tables.find(table => table.name === 'app_operation_receipts')!.rows.filter(row => row.operation === 'project.delete');
  assert.equal(receipt.length, 1); assert.equal(receipt[0]!.requestId, input.requestId);
  const replacement = Buffer.from('A later file at the original pathname must never be opened or trashed'); writeFileSync(f.sourceFile, replacement);
  assert.deepEqual(data(await f.rpc<ProjectDeleteResponse>('project.delete', input)), response);
  assert.deepEqual(await f.native.trash(input), response); assert.equal(f.calls.length, 1); assert.equal(f.reservations.length, 1);
  assert.deepEqual(readFileSync(f.sourceFile), replacement);
  deny(await f.rpc('project.delete', {...input,expectedRevision:input.expectedRevision + 1}), 'REQUEST_ID_REUSED');
  assert.deepEqual(readFileSync(f.sourceFile), replacement); assert.equal(f.calls.length, 1);
});

test('headless has no native trash capability and HTTP refuses without changing project or application state', async t => {
  const f = await trashFixture(t, {headless:true}), before = f.retained(), state = f.closedState(), app = f.appState();
  assert.equal(f.native.trash, undefined); assert.equal(Object.hasOwn(f.native, 'trash'), false);
  deny(await f.rpc('project.delete', f.input()), 'PROJECT_TRASH_UNAVAILABLE');
  assert.equal(f.calls.length, 0); assert.equal(f.reservations.length, 0);
  assert.deepEqual(f.retained(), before); assert.deepEqual(f.closedState(), state); assert.deepEqual(f.appState(), app);
});

test('an actual window lease refuses trash and stays bound without closing the window or interrupting its host', async t => {
  const f = await trashFixture(t), windowId = randomUUID(), window = await f.native.acquire({projectId:f.sourceId,windowId});
  let revocations = 0; const stop = f.native.onWindowRevoked(() => {revocations++;}); t.after(stop);
  const state = f.inspect(db => logicalState(db, [['project','project'],['history','main']])), app = f.appState();
  const listed = f.native.listRecent(); assert.equal(listed.registered.find(entry => entry.project.projectId === f.sourceId)!.availability.state, 'open');
  deny(await f.rpc('project.delete', f.input()), 'PROJECT_HOST_BUSY');
  await assert.rejects(f.native.trash!(f.input()), {code:'PROJECT_HOST_BUSY',status:409});
  assert.equal(f.calls.length, 0); assert.equal(f.reservations.length, 0); assert.equal(revocations, 0);
  assert.deepEqual(f.inspect(db => logicalState(db, [['project','project'],['history','main']])), state);
  assert.deepEqual(f.appState(), app); assert.deepEqual(f.native.listRecent(), listed);
  assert.deepEqual(await f.native.acquire({projectId:f.sourceId,windowId}), window, 'the original window owner still owns its original host');
  f.native.release({windowId}); await awaitClosed(f.registration);
});

test('HTTP authentication, strict confirmation, revision and registration mismatches reject before OS and preserve all records', async t => {
  const f = await trashFixture(t), before = f.retained(), state = f.closedState(), app = f.appState(), input = f.input();
  deny(await f.rpc('project.delete', input, false), 'UNAUTHORIZED', 401);
  const {confirmTrash:_confirm,...unconfirmed} = input;
  for (const bad of [unconfirmed,{...input,confirmTrash:false},{...input,confirmPermanentDeletion:true},
    {requestId:input.requestId,projectId:f.sourceId,expectedRevision:1,confirmPermanentDeletion:true},
    {...input,projectFile:'relative.mioon'},{...input,fileIdentity:{dev:1,ino:2}},{...input,extra:true}]) {
    deny(await f.rpc('project.delete', bad), 'VALIDATION_ERROR', 400);
  }
  deny(await f.rpc('project.delete', {...input,projectFile:path.join(f.sourceDir,'unconfirmed.mioon')}), 'PROJECT_TRASH_SOURCE_CHANGED');
  deny(await f.rpc('project.delete', {...input,fileIdentity:{...input.fileIdentity,ino:String(BigInt(input.fileIdentity.ino)+1n)}}), 'PROJECT_TRASH_SOURCE_CHANGED');
  deny(await f.rpc('project.delete', {...input,expectedRevision:input.expectedRevision+1}), 'REVISION_CONFLICT');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.releases, f.reservations);
  assert.deepEqual(f.retained(), before); assert.deepEqual(f.closedState(), state); assert.deepEqual(f.appState(), app);
});

test('real S8 pending shot-text intent does not block HTTP trash and all unapplied draft rows remain in history', async t => {
  const f = await trashFixture(t), projectId=f.sourceId, windowId=randomUUID(); await f.native.acquire({projectId,windowId});
  const shot=f.shot, shotId=String(shot.id), raw={title:'Keep this unapplied draft',prompt:String(shot.prompt)}, draftId=randomUUID();
  const json=async(tail:string,method='GET',body?:unknown):Promise<Wire<LocalShotTextEnvelope>>=>{
    const response=await fetch(`${f.server.url}/api/projects/${projectId}${tail}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as Wire<LocalShotTextEnvelope>['body']};
  };
  const initial=data(await json(`/local-shot-text?projectId=${projectId}&shotId=${shotId}`));assert.equal(initial.supported,true);if(!initial.supported)throw Error('Expected a real S8 draft owner');
  const authority={workspaceScope:initial.workspaceScope,instanceId:initial.instanceId};
  const saved=data(await json('/local-shot-text/draft','PUT',{...authority,projectId,shotId,expectedDraftRevision:0,draftId,
    baseRevision:shot.revision,baseText:{title:shot.title,prompt:shot.prompt},raw}));assert.equal(saved.supported,true);if(!saved.supported)throw Error('Expected stored draft');
  const pending=data(await json('/local-shot-text/prepare','POST',{...authority,projectId,shotId,expectedIntentRevision:0,expectedIntentId:null,intentId:randomUUID(),
    baseRevision:shot.revision,baseText:{title:shot.title,prompt:shot.prompt},draft:{draftId,revision:saved.draftRevision,raw},
    input:{requestId:randomUUID(),shotId,expectedRevision:shot.revision,patch:{title:raw.title}}}));
  assert.equal(pending.supported,true);if(!pending.supported)throw Error('Expected pending intent');assert.equal(pending.intent?.outcome.status,'pending');
  f.native.release({windowId});await awaitClosed(f.registration);
  const before=f.retained(), state=f.closedState(), drafts=state.find(database=>database.database==='history')!.tables.find(table=>table.name==='local_shot_text_drafts')!.rows;
  assert.equal(drafts.length,1);assert.equal(drafts[0]!.intentStatus,'pending');
  const input=f.input(), response=projectDeleteResponseSchema.parse(data(await f.rpc<ProjectDeleteResponse>('project.delete',input)));
  assert.equal(response.trashed,true);assert.equal(f.calls.length,1);
  assert.deepEqual(f.closedState(path.join(f.bin,input.requestId+'.mioon')),state);
  const after=f.retained();assert.deepEqual({...after,source:null},{...before,source:null});
  assert.deepEqual(after.source,(before.source as Array<{name:string}>).filter(item=>item.name!==path.basename(f.sourceFile)));
});

for (const mode of ['awaiting_answer','awaiting_approval'] as const) {
  test(`real Mio ${mode} older than 100 runs refuses HTTP/native trash without changing any row or file`, async t => {
    const f=await trashFixture(t,{mode,bury:true}), before=f.retained(), state=f.closedState(), app=f.appState();
    assert.deepEqual(state,f.seeded.state,'starting the server without opening the project does not interrupt the persisted waiting run');
    const runs=state.find(database=>database.database==='history')!.tables.find(table=>table.name==='mio_runs')!.rows;
    assert.equal(runs.length,102);assert.equal(runs.find(row=>row.id===f.seeded.runId)!.status,mode);
    assert.equal(f.seeded.modelCalls,mode==='awaiting_answer'?2:3,'one real failed model is retried into the persisted wait');
    deny(await f.rpc('project.delete',f.input()),'PROJECT_HOST_BUSY');
    await assert.rejects(f.native.trash!(f.input()),{code:'PROJECT_HOST_BUSY',status:409});
    assert.equal(f.calls.length,0);assert.deepEqual(f.releases,f.reservations);
    assert.deepEqual(f.retained(),before);assert.deepEqual(f.closedState(),state);assert.deepEqual(f.appState(),app);
  });
}
