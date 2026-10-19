import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,existsSync,unlinkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext,classifyCurrentWorkspaceSchema} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProjectLifecycleServices} from '../packages/business/src/project-lifecycle.ts';
import {createLocalDrafts} from '../packages/business/src/local-drafts.ts';
import {createLocalDelivery} from '../packages/business/src/local-delivery.ts';
import {createLocalShotText} from '../packages/business/src/local-shot-text.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.ts';
import {projectRenameInputSchema,projectDeleteInputSchema} from '../packages/contracts/src/project-lifecycle.ts';
import {schemas} from '@mioon/contracts';
import {IMAGE_MODELS,IMAGE_FIXED_OPTIONS,deriveAgentEndpoint} from '@mioon/contracts';
import {setTimeout as pause} from 'node:timers/promises';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createChatRuntime} from '../packages/business/src/agent/chat-runtime.ts';
import {createTestAuthorizations,authorizeTestScope} from './helpers/agent-authorizations.ts';
import {readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile,validateManagedDirectory} from '@mioon/contracts/private-storage';
const storage={readPrivateFile,writePrivateFileAtomic,validatePrivateDirectory,validateManagedFile,validateManagedDirectory};
const stamp='2026-10-19T00:00:00.000Z';
async function fixture(t,{imageAutoRun=false}={}){
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-project-lifecycle-')));let store=openStore(root),services=createServices(store,new Map(),{imageOptions:{autoRun:imageAutoRun}}),lifecycle,companions,fault=()=>{},idle=()=>{};
  const project=await services.call('project.create',{name:'Delete me'}),other=await services.call('project.create',{name:'Keep me'});
  function start(){
    const guards={ownsLock:()=>ownsStoreLock(store),isRestored:()=>Boolean(getWorkspaceRestoreContext(store))};
    const drafts=createLocalDrafts({root,storage,guards:{...guards,readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read(),readClipAsset:(id,clip)=>createTimelineRecoveryBoundary(store.db,{projectId:id}).clipSource(clip)}});
    const delivery=createLocalDelivery({root,storage,guards:{...guards,readTimeline:id=>createTimelineRecoveryBoundary(store.db,{projectId:id}).read({sourceSemantics:false}),isRenderInput:value=>schemas['timeline.render'].safeParse(value).success,isRenderResponse:()=>false,isNotApplied:()=>false,readReceipt:()=>null,render:async()=>{throw Error('must not render');}}});
    const shotText=createLocalShotText({root,storage,guards:{...guards,readShot:(id,shotId)=>{const shot=store.get('shots',shotId);return shot?.projectId===id?shot:null;},readReceipt:()=>null,isNotApplied:()=>false,isShotUpdateInput:value=>schemas['shot.update'].safeParse(value).success,update:async()=>{throw Error('must not update');}}});
    companions={drafts,delivery,shotText};
    lifecycle=createProjectLifecycleServices(store,{storage,ownsLock:guards.ownsLock,isReadOnly:guards.isRestored,assertIdle:()=>idle(),fault:point=>fault(point)});
    lifecycle.setProjectDeletionCompanions({assertDeletable:id=>{drafts.assertProjectDeletable(id);delivery.assertProjectDeletable(id);shotText.assertProjectDeletable(id);},removeProject:id=>{drafts.removeProject(id);delivery.removeProject(id);shotText.removeProject(id);}});
  }
  start();t.after(()=>{if(store.db.isOpen)store.close();rmSync(root,{recursive:true,force:true});});
  return {root,project,other,get store(){return store;},get services(){return services;},get lifecycle(){return lifecycle;},get companions(){return companions;},setFault(fn){fault=fn;},setIdle(fn){idle=fn;},
    removeInput(id=project.id){return {requestId:randomUUID(),projectId:id,expectedRevision:store.get('projects',id).revision,confirmPermanentDeletion:true};},
    restart(){store.close();store=openStore(root);services=createServices(store,new Map(),{imageOptions:{autoRun:imageAutoRun}});start();},
  };
}
async function assetTimeline(f,project=f.project){
  const id=randomUUID(),relativePath=`media/${id}.png`,file=path.join(f.root,relativePath);writeFileSync(file,'managed project bytes',{mode:0o600});
  const asset=f.store.put('assets',{id,projectId:project.id,name:'Managed synthetic source',mimeType:'image/png',width:2,height:2,hasVideo:true,hasAudio:false,sha256:'a'.repeat(64),relativePath,provenance:'user-import',createdAt:stamp});
  let timeline=await f.services.call('timeline.get',{projectId:project.id});
  timeline=await f.services.call('timeline.clip.add',{requestId:randomUUID(),projectId:project.id,expectedRevision:timeline.revision,assetId:id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:90});
  return {asset,timeline,file};
}

test('rename uses CAS and exact retained replay; delete requires an explicit strict dangerous confirmation',async t=>{
  const f=await fixture(t),input={requestId:randomUUID(),projectId:f.project.id,expectedRevision:1,name:'  Renamed  '};
  assert.equal(projectRenameInputSchema.parse(input).name,'Renamed');
  for(const value of [{...f.removeInput(),confirmPermanentDeletion:false},{...f.removeInput(),archive:true},{projectId:f.project.id}])assert.equal(projectDeleteInputSchema.safeParse(value).success,false);
  const result=f.lifecycle.handlers['project.rename'](input);assert.equal(result.name,'Renamed');assert.equal(result.revision,2);
  assert.deepEqual(f.lifecycle.handlers['project.rename'](input),result);
  assert.throws(()=>f.lifecycle.handlers['project.rename']({...input,name:'Different'}),{code:'IDEMPOTENCY_CONFLICT'});
  assert.throws(()=>f.lifecycle.handlers['project.rename']({...input,requestId:randomUUID()}),{code:'REVISION_CONFLICT'});
  assert.equal(f.store.get('projects',f.other.id).name,'Keep me');
});

test('completed project permanently deletes real rows, retained replies and exclusive media while preserving other projects and external files',async t=>{
  const f=await fixture(t),{asset,timeline,file}=await assetTimeline(f),other=await assetTimeline(f,f.other);
  const shot=await f.services.call('shot.create',{projectId:f.project.id,title:'Retained title',prompt:'Private prompt',requestId:randomUUID()});
  const jobId=randomUUID(),versionId=randomUUID();f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,requestId:randomUUID(),status:'succeeded',phase:'completed',submissionCount:1,providerJobId:'finished-provider-task',createdAt:stamp,updatedAt:stamp});
  f.store.put('versions',{id:versionId,projectId:f.project.id,jobId,shotId:shot.id,assetId:asset.id,number:1,createdAt:stamp});
  f.store.db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(jobId,'{"status":"succeeded"}',stamp);
  f.store.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('generation',randomUUID(),'a'.repeat(64),jobId);
  f.store.db.prepare('INSERT INTO reference_requests VALUES(?,?,?)').run(randomUUID(),'b'.repeat(64),JSON.stringify({shot,edge:{id:randomUUID(),projectId:f.project.id}}));
  const exportId=randomUUID();f.store.put('exports',{id:exportId,projectId:f.project.id,status:'failed'});
  const partial=path.join(f.root,'media',`result-${jobId}.mp4.part.mp4`),unpublished=path.join(f.root,'media',`export-${exportId}-${randomUUID()}.mp4`),unrecognized=path.join(f.root,'media','unrecognized-file.txt');for(const target of [partial,unpublished,unrecognized])writeFileSync(target,'local bytes',{mode:0o600});
  const external=path.join(f.root,'external-source.txt');writeFileSync(external,'external untouched');
  assert.throws(()=>f.store.db.prepare('DELETE FROM mutation_requests WHERE projectId=?').run(f.project.id),/retained/);
  const input=f.removeInput(),result=f.lifecycle.handlers['project.delete'](input);assert.deepEqual(result,{requestId:input.requestId,projectId:f.project.id,deleted:true,cleanup:'complete'});
  for(const table of ['assets','shots','jobs','versions','timelines','timeline_history','mutation_requests'])assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE projectId=?`).get(f.project.id).n,0,table);
  assert.equal(f.store.get('projects',f.project.id),null);assert.ok(f.store.get('projects',f.other.id));assert.equal(existsSync(file),false);assert.equal(existsSync(other.file),true);assert.equal(readFileSync(external,'utf8'),'external untouched');
  assert.equal(existsSync(partial),false);assert.equal(existsSync(unpublished),false);assert.equal(existsSync(unrecognized),true);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM reference_requests').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_scope').get().n,0);assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').get(),undefined);
  assert.deepEqual(f.lifecycle.handlers['project.delete'](input),result);assert.throws(()=>f.lifecycle.handlers['project.delete']({...input,expectedRevision:99}),{code:'IDEMPOTENCY_CONFLICT'});
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_receipts').get().n,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_cleanup').get().n,0);
  assert.equal(classifyCurrentWorkspaceSchema(f.store.db).schemaVersion,48);assert.ok(timeline.id);
});

test('running, unknown and locally stopped paid jobs block deletion without removing records or media',async t=>{
  const f=await fixture(t),{file}=await assetTimeline(f),id=randomUUID(),input=f.removeInput();
  for(const value of [{status:'queued'},{status:'submission_unknown'},{status:'running'},{status:'cancelled',submissionCount:1,providerJobId:'possibly-running',cancelScope:'local_only'},{status:'cancelled',phase:'output_review_required'}]){
    f.store.put('jobs',{id,projectId:f.project.id,submissionCount:0,...value});
    assert.throws(()=>f.lifecycle.handlers['project.delete'](input),{code:'PROJECT_DELETE_BUSY'});assert.ok(f.store.get('projects',f.project.id));assert.equal(existsSync(file),true);assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_receipts').get().n,0);
  }
});

test('semantic references from another project reject deletion; a shared file path alone preserves that file',async t=>{
  const f=await fixture(t),{asset,file}=await assetTimeline(f);
  const nodeId=randomUUID();f.store.put('nodes',{id:nodeId,projectId:f.other.id,type:'image',assetId:asset.id});
  assert.throws(()=>f.lifecycle.handlers['project.delete'](f.removeInput()),{code:'PROJECT_DELETE_REFERENCED'});assert.equal(existsSync(file),true);
  f.store.db.prepare('DELETE FROM nodes WHERE id=?').run(nodeId);
  f.store.put('assets',{...asset,id:randomUUID(),projectId:f.other.id});
  assert.equal(f.lifecycle.handlers['project.delete'](f.removeInput()).cleanup,'complete');assert.equal(existsSync(file),true);
});

test('commit failure rolls back rows and scoped authority before any unlink',async t=>{
  const f=await fixture(t),{file}=await assetTimeline(f),input=f.removeInput();f.setFault(point=>{if(point==='beforeCommit')throw Error('interrupted commit');});
  assert.throws(()=>f.lifecycle.handlers['project.delete'](input),/interrupted commit/);assert.ok(f.store.get('projects',f.project.id));assert.equal(existsSync(file),true);assert.equal(f.store.db.isTransaction,false);assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_scope').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_cleanup').get().n,0);
});

test('a crash after committed deletion resumes only local cleanup on reopening',async t=>{
  const f=await fixture(t),{file}=await assetTimeline(f),input=f.removeInput();f.setFault(point=>{if(point==='afterCommit')throw Error('crash after commit');});
  assert.throws(()=>f.lifecycle.handlers['project.delete'](input),/crash after commit/);assert.equal(f.store.get('projects',f.project.id),null);assert.equal(existsSync(file),true);assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_cleanup').get().n,1);
  f.setFault(()=>{});f.restart();assert.equal(existsSync(file),false);assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_cleanup').get().n,0);assert.equal(f.lifecycle.handlers['project.delete'](input).cleanup,'complete');
});

test('replaced files and symlinks never inherit a committed cleanup authority',async t=>{
  const f=await fixture(t),{file}=await assetTimeline(f),input=f.removeInput(),external=path.join(f.root,'external-source');writeFileSync(external,'external');
  f.setFault(point=>{if(point==='afterCommit')throw Error('crash');});assert.throws(()=>f.lifecycle.handlers['project.delete'](input),/crash/);
  unlinkSync(file);symlinkSync(external,file);f.setFault(()=>{});f.restart();
  assert.equal(f.lifecycle.handlers['project.delete'](input).cleanup,'pending');assert.equal(readFileSync(external,'utf8'),'external');assert.equal(f.store.db.prepare('SELECT count(*) n FROM project_deletion_cleanup').get().n,1);
});

test('project-only companion removal preserves other project text and rejects a pending text intent',async t=>{
  const f=await fixture(t),first=await f.services.call('shot.create',{projectId:f.project.id,title:'First',prompt:'Secret first'}),second=await f.services.call('shot.create',{projectId:f.other.id,title:'Second',prompt:'Keep second'});
  for(const shot of [first,second]){const empty=f.companions.shotText.get({projectId:shot.projectId,shotId:shot.id});f.companions.shotText.put({workspaceScope:empty.workspaceScope,instanceId:empty.instanceId,projectId:shot.projectId,shotId:shot.id,expectedDraftRevision:0,draftId:randomUUID(),baseRevision:shot.revision,baseText:{title:shot.title,prompt:shot.prompt},raw:{title:shot.title+' draft',prompt:shot.prompt}});}
  const current=f.companions.shotText.get({projectId:first.projectId,shotId:first.id});
  f.companions.shotText.prepare({workspaceScope:current.workspaceScope,instanceId:current.instanceId,projectId:first.projectId,shotId:first.id,expectedIntentRevision:0,expectedIntentId:null,intentId:randomUUID(),baseRevision:first.revision,baseText:current.draft.baseText,draft:{draftId:current.draft.draftId,revision:current.draftRevision,raw:current.draft.raw},input:{requestId:randomUUID(),shotId:first.id,expectedRevision:first.revision,patch:{title:current.draft.raw.title}}});
  assert.throws(()=>f.lifecycle.handlers['project.delete'](f.removeInput()),{code:'LOCAL_SHOT_TEXT_CONFLICT'});
  const sidecar=path.join(f.root,'local-shot-text-v1.json'),disk=JSON.parse(readFileSync(sidecar,'utf8'));disk.entries=disk.entries.map(row=>row.projectId===first.projectId?{...row,intentRevision:0,intent:null}:row);writeFileSync(sidecar,JSON.stringify(disk),{mode:0o600});
  assert.equal(f.lifecycle.handlers['project.delete'](f.removeInput()).cleanup,'complete');const remaining=JSON.parse(readFileSync(sidecar,'utf8'));assert.equal(remaining.entries.length,1);assert.equal(remaining.entries[0].projectId,f.other.id);assert.equal(remaining.entries[0].draft.raw.prompt,'Keep second');assert.equal(readFileSync(sidecar,'utf8').includes('Secret first'),false);
});

test('a persisted scoped grant cannot survive reopen and cannot authorize another retained row',async t=>{
  const f=await fixture(t);await f.services.call('shot.create',{projectId:f.project.id,title:'Owned',requestId:randomUUID()});await f.services.call('shot.create',{projectId:f.other.id,title:'Other',requestId:randomUUID()});
  const row=f.store.db.prepare('SELECT rowid FROM mutation_requests WHERE projectId=?').get(f.project.id);f.store.db.exec('BEGIN IMMEDIATE');f.store.db.prepare('INSERT INTO project_deletion_scope VALUES(?,?)').run('mutation_requests',row.rowid);
  assert.throws(()=>f.store.db.prepare('DELETE FROM mutation_requests WHERE projectId=?').run(f.other.id),/retained/);f.store.db.exec('ROLLBACK');
  f.store.db.prepare('INSERT INTO project_deletion_scope VALUES(?,?)').run('mutation_requests',row.rowid);f.store.close();assert.throws(()=>openStore(f.root),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
});

test('a completed mock image deletes cyclic immutable groups/tasks/versions and its exact staging receipt',{timeout:60000},async t=>{
  const f=await fixture(t,{imageAutoRun:true}),ack=await f.services.call('image.generate',{projectId:f.project.id,requestId:randomUUID(),name:'Completed mock',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Synthetic local image',options:{...IMAGE_FIXED_OPTIONS}});
  assert.throws(()=>f.lifecycle.handlers['project.delete'](f.removeInput()),{code:'PROJECT_DELETE_BUSY'});
  let result;const deadline=Date.now()+30000;
  while(Date.now()<deadline){result=await f.services.call('image.task.get',{projectId:f.project.id,taskId:ack.id});if(['succeeded','failed','outcome_unknown','local_result_error'].includes(result.state))break;await pause(10);}
  assert.equal(result.state,'succeeded',JSON.stringify(result));await f.services.drain();
  const receipt=path.join(f.root,'image-staging',`${ack.id}.json`),asset=f.store.get('assets',f.store.db.prepare('SELECT assetId FROM image_versions WHERE id=?').get(result.versionId).assetId),file=path.join(f.root,asset.relativePath);assert.equal(existsSync(receipt),true);assert.equal(existsSync(file),true);
  assert.equal(f.lifecycle.handlers['project.delete'](f.removeInput()).cleanup,'complete');
  for(const table of ['image_groups','image_tasks','image_versions','image_requests'])assert.equal(f.store.db.prepare(`SELECT count(*) n FROM ${table} WHERE projectId=?`).get(f.project.id).n,0);
  assert.equal(existsSync(receipt),false);assert.equal(existsSync(file),false);assert.equal(f.store.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').get(),undefined);
});

test('another project’s terminal image state is not parsed as a JSON payload or removed',async t=>{
  const f=await fixture(t),ack=await f.services.call('image.generate',{projectId:f.other.id,requestId:randomUUID(),name:'Other project',providerId:'mock',model:IMAGE_MODELS.mock,prompt:'Queued and explicitly cancelled',options:{...IMAGE_FIXED_OPTIONS}});
  await f.services.call('image.task.cancelQueued',{projectId:f.other.id,taskId:ack.id,expectedRevision:ack.revision,requestId:randomUUID()});
  assert.equal(f.lifecycle.handlers['project.delete'](f.removeInput()).cleanup,'complete');assert.equal(f.store.db.prepare('SELECT state FROM image_tasks WHERE id=?').get(ack.id).state,'cancelled_before_dispatch');assert.ok(f.store.get('projects',f.other.id));
});

test('completed chat journals are removed with correct shared quota accounting while global grants remain',{timeout:30000},async t=>{
  const f=await fixture(t),settings=await createAgentSettings({persistence:{load:async()=>null,save:async()=>{}}});let snapshot=await settings.get();await settings.put({expectedRevision:0,configuration:snapshot.configuration,secret:{action:'replace',storage:'session',value:'SYNTHETIC_PROJECT_DELETE_KEY'}});
  const authorizations=createTestAuthorizations(f.store,settings);await authorizeTestScope(authorizations);const runtime=createChatRuntime({store:f.store,agentSettings:settings,authorizations,mode:'simulated',selfPort:()=>4318,gateway:async function*(){yield {type:'delta',text:'Completed synthetic answer'};yield {type:'done',finishReason:'stop'};}});t.after(async()=>{runtime.close();await settings.close();});
  for(const project of [f.project,f.other]){
    snapshot=await runtime.snapshot(project.id);const input={requestId:randomUUID(),instanceId:snapshot.instanceId,expectedSettingsRevision:snapshot.settings.revision,expectedConversationRevision:snapshot.revision,message:'Only this typed project message',consent:{destination:deriveAgentEndpoint(snapshot.settings.configuration),protocol:snapshot.settings.configuration.protocol,model:snapshot.settings.configuration.model,context:'typed_chat_only'}},sent=await runtime.send(project.id,input);
    const deadline=Date.now()+5000;while(runtime.get(project.id,sent.run.id,sent.instanceId).run.status==='running'&&Date.now()<deadline)await pause(5);assert.equal(runtime.get(project.id,sent.run.id,sent.instanceId).run.status,'completed');
  }
  const before=f.store.db.prepare('SELECT * FROM agent_chat_quota').get(),grants=readFileSync(path.join(f.root,'agent-authorizations-v1.json'));
  assert.equal(f.lifecycle.handlers['project.delete'](f.removeInput()).cleanup,'complete');
  const after=f.store.db.prepare('SELECT * FROM agent_chat_quota').get();assert.equal(after.runs,1);assert.equal(after.reservedBytes,0);assert.ok(after.bytes>0&&after.bytes<before.bytes);assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_runs WHERE projectId=?').get(f.project.id).n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_chat_runs WHERE projectId=?').get(f.other.id).n,1);assert.deepEqual(readFileSync(path.join(f.root,'agent-authorizations-v1.json')),grants);
});
