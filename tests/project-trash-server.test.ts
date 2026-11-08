import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {projectDeleteResponseSchema} from '../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDeleteInput, ProjectDeleteResponse} from '../packages/contracts/src/project-lifecycle.ts';
import type {LocalShotTextEnvelope} from '../packages/contracts/src/local-shot-text.ts';
import {createProjectEntryController} from '../apps/web/src/project-entry-state.ts';
import {createProjectHomeNativeActionsController} from '../apps/web/src/project-home-native-actions-state.ts';
import {createProjectEntryDirectoryClient} from '../apps/web/src/project-entry-directory-client.ts';
import {createProjectEntryDirectoryController} from '../apps/web/src/project-entry-directory-state.ts';
import {createProjectEntryIdentityOwner, readProjectEntryIdentity} from '../apps/web/src/project-entry-identity.ts';
import {createLauncherClient} from '../apps/web/src/launcher-state.ts';
import {browserRpc} from '../apps/web/src/browser-rpc.ts';
import type {ProjectWindowBridge, ProjectWindowContext} from '../apps/web/src/desktop-window-client.ts';
import {trashFixture, data, fileTree, logicalState, awaitClosed, token, type Wire} from './helpers/project-trash-server-fixture.ts';

const deny = (result: Wire, code: string, status = 409) => {
  assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.ok, false); assert.equal(result.body.error?.code, code);
};
const retainedApp = (state: ReturnType<typeof logicalState>) => state.map(database => ({...database,
  tables: database.tables.filter(table => !['recent_projects', 'app_operation_receipts'].includes(String(table.name)))}));

test('home trash survives the real departure refresh, requires confirmation and retains every other file and record',async t=>{
  const f=await trashFixture(t),requests:{path:string;method:string}[]=[],submitted:ProjectDeleteInput[]=[];
  // A real prior open/close records the cached summary the home card needs.
  // Capture all preservation baselines afterwards, with no window lease held.
  const previousWindow=randomUUID();await f.native.acquire({projectId:f.sourceId,windowId:previousWindow});
  f.native.release({windowId:previousWindow});await awaitClosed(f.registration);
  // Only the transport address/authentication changes. The directory reader,
  // entry permits, action controller, RPC service and native trash port are real.
  const fetcher:typeof fetch=async(input,init)=>{
    const route=String(input);assert.ok(route==='/api/project-entries'||route==='/api/rpc');
    requests.push({path:route,method:init?.method??'GET'});
    const headers=new Headers(init?.headers);headers.set('authorization',`Bearer ${token}`);
    return fetch(new URL(route,f.server.url),{...init,headers});
  };
  const directoryClient=createProjectEntryDirectoryClient({fetcher});
  const identity=createProjectEntryIdentityOwner({read:directoryClient.list});identity.activate();
  const initial=await readProjectEntryIdentity(identity),context:ProjectWindowContext={version:2,role:'launcher',
    windowId:randomUUID(),contextId:randomUUID(),backendId:initial.instanceId,initialProjectId:null,autoOpen:false,
    editorProjectId:null,editorPhase:'none',editorCount:0,entryMode:null,entryVersion:0,entryReceipt:null,
    settingsSlot:null,settingsVersion:0,selectionProjectId:null,selectionVersion:0,locatorStatus:null,locatorIntent:null,quitting:false};
  const bridge:ProjectWindowBridge={context:async()=>context,
    openProject:async()=>assert.fail('Trash must never open a project window'),
    publishLocatorStatus:async()=>assert.fail('No locator change'),requestLocatorAction:async()=>assert.fail('No locator action'),
    requestProjectEntry:async()=>assert.fail('No new entry'),showProjects:async()=>assert.fail('No other window'),
    showSettings:async()=>assert.fail('No settings'),closeSettings:async()=>assert.fail('No settings'),
    editorStatus:async()=>assert.fail('No editor'),subscribe:()=>()=>{}};
  const entry=createProjectEntryController({context,bridge,identity,manageIdentityLifecycle:false,
    client:createLauncherClient(async()=>assert.fail('No legacy create/list RPC'),{
      parseCreateInput:value=>value,readDirectory:()=>readProjectEntryIdentity(identity)}),confirm:async()=>true});
  entry.activate();
  const directory=createProjectEntryDirectoryController({read:()=>readProjectEntryIdentity(identity),expectedScope:()=>identity.getVerifiedScope()});directory.activate();
  const home=createProjectHomeNativeActionsController({
    ports:()=>({trash:async input=>{submitted.push(input);return browserRpc('project.delete',input,{fetcher});}}),
    owner:()=>{
      const state=directory.getState();
      return entry.getState().catalogReady&&state.phase==='ready'&&state.snapshot
        ?{appLibraryScope:state.snapshot.appLibraryScope,instanceId:state.snapshot.instanceId,epoch:state.epoch}:null;
    },
    canStart:()=>entry.canMutate(),
    readDirectory:async()=>{assert.equal(await directory.refresh(),true);return directory.getState().snapshot;},
    onChange:(_state,metadata)=>entry.reportNativeAction(metadata),
    onRefresh:async()=>{assert.equal(await entry.refresh(),true);assert.equal(await directory.refresh(),true);},
    onOpenCreated:async()=>assert.fail('Trash must never open a project'),
  });home.activate();
  try{
    assert.equal(await entry.boot(),true);assert.equal(await directory.refresh(),true);
    assert.equal(entry.getState().catalogReady,true);
    assert.ok(directory.getState().snapshot?.registered.find(value=>value.project.projectId===f.sourceId)?.project.summary);
    const before=f.retained(),state=f.closedState(),app=f.appState(),registered=f.native.listRecent().registered;
    const binBefore=fileTree(f.bin),gets=()=>requests.filter(value=>value.path==='/api/project-entries'&&value.method==='GET').length;
    const count=gets(),cancelPermit=await entry.prepareHomeNativeDeparture();assert.ok(cancelPermit);
    assert.equal(gets(),count+1,'Departure performs a fresh authenticated GET after home boot');
    assert.equal(await home.prepareTrash(f.sourceId,cancelPermit),true);assert.equal(home.getState().kind,'confirm-trash');
    assert.equal(home.getState().project?.projectId,f.sourceId);assert.equal(submitted.length,0);assert.equal(f.calls.length,0);assert.equal(f.reservations.length,0);
    assert.deepEqual(f.retained(),before);assert.deepEqual(f.closedState(),state);assert.deepEqual(f.appState(),app);assert.deepEqual(fileTree(f.bin),binBefore);
    assert.equal(home.close(),true);assert.equal(await home.confirmTrash(),false);
    assert.equal(submitted.length,0);assert.equal(f.calls.length,0);assert.deepEqual(f.retained(),before);assert.deepEqual(f.closedState(),state);
    assert.deepEqual(f.appState(),app);assert.deepEqual(fileTree(f.bin),binBefore,'Cancellation never invokes the temporary native trash port');

    const confirmPermit=await entry.prepareHomeNativeDeparture();assert.ok(confirmPermit);
    assert.equal(await home.prepareTrash(f.sourceId,confirmPermit),true);assert.equal(home.getState().kind,'confirm-trash');assert.equal(submitted.length,0);
    assert.equal(await home.confirmTrash(),true);assert.equal(submitted.length,1);const input=submitted[0]!;
    assert.deepEqual(input,{...f.input(),requestId:input.requestId});
    assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.requestId,input.requestId);assert.equal(f.reservations.length,1);assert.deepEqual(f.releases,f.reservations);
    const trashed=path.join(f.bin,input.requestId+'.mioon');assert.equal(existsSync(f.sourceFile),false);assert.equal(existsSync(trashed),true);
    const after=f.retained();
    assert.deepEqual(after.source,(before.source as Array<{name:string}>).filter(value=>value.name!==path.basename(f.sourceFile)));
    assert.deepEqual({...after,source:null},{...before,source:null},'Media/history/cache/versions/backups and the other project remain byte-identical');
    assert.deepEqual(f.closedState(trashed),state,'The moved file retains every content/history/Mio row');
    assert.deepEqual(f.native.listRecent().registered,registered.filter(value=>value.project.projectId!==f.sourceId));
    const application=f.appState(),registrationRows=(value:ReturnType<typeof logicalState>)=>value[0]!.tables.find(table=>table.name==='recent_projects')!.rows;
    assert.equal(registrationRows(application).length,registrationRows(app).length-1,'Only one application registration is removed');
    assert.deepEqual(retainedApp(application),retainedApp(app));
    assert.equal(home.getState().kind,'idle');assert.equal(home.getState().notice?.kind,'success');assert.equal(entry.readCloseSnapshot().unknown,false);
    assert.equal(requests.filter(value=>value.path==='/api/rpc'&&value.method==='POST').length,1);
  }finally{home.dispose();directory.dispose();entry.dispose();identity.dispose();}
});

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
