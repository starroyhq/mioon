import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import type {BackupResult,RestoreResult} from './helpers/strict-timeline-backup-types.ts';
import type {TypedServices} from './helpers/strict-service-responses.ts';
import type {StrictTimelineTasks} from './helpers/strict-timeline-handler-types.ts';
import type {TypedStore as FixtureStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/db.ts';
import {openNewOpacityCandidateApplicationStore,openNewRippleOpacityCandidateApplicationStore,openRippleOpacityCandidateStore,getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateServices} from '../packages/business/src/opacity-candidate-services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {classifyWorkspaceSchema42} from '../packages/business/src/workspace-schema-v42.ts';
import {classifyWorkspaceSchema46} from '../packages/business/src/workspace-schema-v46.ts';
import {createRippleOpacityCandidateWorkspaceBackup,restoreRippleOpacityCandidateWorkspaceBackup} from '../packages/business/src/opacity-ripple-candidate-backup.ts';
const operation='timeline.clip.rippleRemove';
const request=<P extends Record<string,unknown>=Record<never,never>>(timeline: FixtureTimeline,fields: P={} as P):P & {projectId:string;expectedRevision:number;requestId:string}=>({projectId:timeline.projectId,expectedRevision:timeline.revision,requestId:randomUUID(),...fields});

test('explicit46 preserves opacity through ripple and47 restore; ordinary and historical42 gates stay closed', {timeout:60000},async t=>{
 const base=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-ripple-opacity-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),backup=path.join(base,'backup'),restored=path.join(base,'restored');
 let store=openNewRippleOpacityCandidateApplicationStore(source),services=(createOpacityCandidateServices(store) as unknown as TypedServices);
 let closed=false;t.after(async()=>{if(!closed){await services.drain();store.close();}});
 const project=(await services.call('project.create',{name:'Explicit opacity ripple'}));const projectId=project.id;
 const bytes=Buffer.from('Synthetic retained image bytes; this metadata-only test never decodes media.'),assetId=randomUUID(),relativePath=`media/${assetId}.png`;
 await writeFile(path.join(source,relativePath),bytes,{mode:0o600,flag:'wx'});
 store.put('assets',{id:assetId,projectId,name:'Synthetic image',mimeType:'image/png',width:32,height:32,duration:0,hasAudio:false,sizeBytes:bytes.length,provenance:'user-import',createdAt:'2026-10-19T00:00:00.000Z',sha256:createHash('sha256').update(bytes).digest('hex'),relativePath});
 let timeline=await services.call('timeline.get',{projectId});
 const envelope={profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:.5},{frame:9,opacity:1}]};
 for(const startFrame of ([0,20] as const))timeline=await services.call('timeline.clip.add',{...request(timeline),assetId,trackId:timeline.tracks[0].id,startFrame,durationFrames:10,opacityEnvelope:envelope});
 const target=timeline.clips[0].id,following=timeline.clips[1],intent=request(timeline,{clipId:target});
 const result=await services.call(operation,intent);assert.deepEqual(result.clips,[{...following,startFrame:10}]);
 timeline=await services.call('timeline.undo',request(result));assert.equal(timeline.clips.length,2);
 assert.equal((getOpacityCandidateAssembly(store))!.rippleRemove,true);assert.equal(classifyWorkspaceSchema46(store.db).schemaVersion,46);
 assert.throws(()=>classifyWorkspaceSchema42(store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 await services.drain();store.close();closed=true;
 assert.throws(()=>(openStore(source) as FixtureStore),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
 const created=await (createRippleOpacityCandidateWorkspaceBackup({source,destination:backup}) as Promise<BackupResult>);assert.equal(created.databaseSchemaVersion,46);
 const restoredInfo=await (restoreRippleOpacityCandidateWorkspaceBackup({directory:backup,destination:restored}) as Promise<RestoreResult>);assert.equal(restoredInfo.databaseSchemaVersion,47);assert.equal(restoredInfo.sourceSchema,46);
 store=openRippleOpacityCandidateStore(restored);services=(createOpacityCandidateServices(store) as unknown as TypedServices);closed=false;
 assert.equal(((getOpacityCandidateAssembly(store))!.getRestoreContext())!.schemaVersion,47);
 const context={expectedWorkspaceOrigin:restoredInfo.workspaceOrigin};
 // Captured timeline receipt holds have no project owner; the existing candidate
 // boundary rejects that ambiguous captured key as unavailable before replay.
 await assert.rejects(services.call(operation,intent,context),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 timeline=await services.call('timeline.get',{projectId});
 const fresh=await services.call(operation,request(timeline,{clipId:target}),context);assert.deepEqual(fresh.clips,[{...following,startFrame:10}]);
 const tasks=(createEditTasks({store,services}) as StrictTimelineTasks);
 try{
  const input=request(fresh,{clipId:following.id}),saved=tasks.prepare({projectId,operation,input,origin:'new'},context);
  const applied=await tasks.execute({projectId,taskId:saved.task.id,digest:saved.task.digest,instanceId:saved.instanceId},context);
  assert.equal(applied.task.status,'applied');assert.equal(applied.task.operation,operation);
  assert.deepEqual(((await services.call('timeline.get',{projectId})).clips as unknown),[]);
 }finally{await tasks.drain();}
 await services.drain();store.close();closed=true;
 store=openRippleOpacityCandidateStore(restored);services=(createOpacityCandidateServices(store) as unknown as TypedServices);closed=false;
 assert.deepEqual(((await services.call('timeline.get',{projectId})).clips as unknown),[]);
 await services.drain();store.close();closed=true;
 const old=openNewOpacityCandidateApplicationStore(path.join(base,'old42')),oldServices=(createOpacityCandidateServices(old) as unknown as TypedServices);
 try{assert.equal((getOpacityCandidateAssembly(old))!.rippleRemove,false);await assert.rejects(oldServices.call(operation,{projectId:randomUUID(),expectedRevision:1,requestId:randomUUID(),clipId:randomUUID()}),{code:'RESTORE_OPERATION_UNAVAILABLE'});}finally{await oldServices.drain();old.close();}
 const db=new DatabaseSync(path.join(source,'workbench.sqlite'),{readOnly:true});try{assert.equal(classifyWorkspaceSchema46(db).schemaVersion,46);}finally{db.close();}
});
