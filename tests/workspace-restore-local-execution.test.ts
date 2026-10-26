import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {WorkspaceServices as FixtureServices} from './helpers/strict-workspace-boundary-types.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {createWorkspacePreferences} from '../packages/business/src/workspace-preferences.ts';
import {defaultWorkspaceState} from '../apps/web/src/workspace-state.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,unlinkSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {installCurrentWorkspaceRestoreSchema, openStore, type WorkspaceStore} from '../packages/business/src/db.ts';
import {createServices,hash,canonical,now, type OrdinaryServices} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';
import {createTimelineServices} from '../packages/business/src/timeline.ts';
import {createMutationReplay,NO_MUTATION_REPLAY} from '../packages/business/src/mutation-replay.ts';
import {withRestoreInvocation,restoreEffectFence,freezeRestoreInput} from '../packages/business/src/workspace-restore-invocation.ts';
import {matchesRestoredExport,restoreExportIdentity} from '../packages/business/src/workspace-restore-exports.ts';
import {startWorker, type Worker} from '../packages/business/src/jobs.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {createAgentEditService} from '../packages/business/src/agent/edit-proposals.ts';
import {editToolPolicy} from '../packages/business/src/agent/edit-tool-policy.ts';
import {timelineEditToolPolicy} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';

const code=(value: string|{ expectedWorkspaceOrigin?: undefined; }|{ expectedWorkspaceOrigin: `${string}-${string}-${string}-${string}-${string}`; })=>(error: { code: unknown; })=>(error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure)?.code===value;
const captured=(db: DatabaseSync)=>JSON.stringify(db.prepare('SELECT * FROM workspace_restore_holds ORDER BY kind,id').all());
function agentIntent(store: FixtureStore,services: FixtureServices,project: import('./helpers/strict-timeline-core-types.ts').FixtureProject,shot: import('./helpers/strict-service-responses.ts').MediaShot,timeline: import('./helpers/strict-timeline-core-types.ts').FixtureTimeline,operation: string){
 const edits=(createAgentEditService({store,services}) as unknown as import('./helpers/strict-agent-workspace-types.ts').TypedEdits<'shot'|'move'>),timelineMode=operation==='timeline.clip.update';
 const target=timelineMode?edits.pinTimelineTarget(project.id,{timelineId:timeline.id,clipId:timeline.clips[0].id,expectedRevision:timeline.revision}):edits.pinTarget(project.id,{shotId:shot.id,expectedRevision:shot.revision});
 const runId=randomUUID(),requestId=randomUUID(),toolId=randomUUID(),tid=store.db.prepare('SELECT id FROM agent_chat_threads WHERE projectId=?').get(project.id)?.id??randomUUID();
 if(!store.db.prepare('SELECT 1 FROM agent_chat_threads WHERE id=?').get(tid))store.db.prepare('INSERT INTO agent_chat_threads VALUES(?,?,0,1)').run(tid,project.id);
 const position=(store.db.prepare('SELECT count(*) n FROM agent_chat_runs WHERE projectId=?').get(project.id)!.n! as number)+1;
 const run={id:runId,projectId:project.id,requestId,threadId:tid,status:'running',contextMode:timelineMode?'selected_timeline_clip_move':'selected_shot_edit',editTarget:target,modelRequestState:'dispatch_started',activity:[]};
 const acceptance={version:1,execution:{version:1,target,policy:timelineMode?timelineEditToolPolicy(project.id):editToolPolicy(project.id)}};
 store.db.prepare('INSERT INTO agent_chat_requests VALUES(?,?,?,?,?,?,?)').run(requestId,project.id,tid,runId,'fixture',JSON.stringify(acceptance),100);
 store.db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?,?,?,?,?,?)').run(runId,project.id,tid,requestId,position,run.status,JSON.stringify(run),100);
 const changes=timelineMode?{startFrame:60}:{title:'Captured proposal',prompt:null};
 const toolCall={id:'call_'+randomUUID(),name:timelineMode?'mioon_propose_timeline_clip_move':'mioon_propose_shot_update',arguments:changes,argumentsJson:JSON.stringify(changes)};
 const tool={id:toolId,projectId:project.id,runId,position:2,kind:'tool',ordinal:1,status:'dispatch_started',intent:{toolCall,provenance:{category:timelineMode?'project_selected_timeline_timing':'project_selected_shot_text',projectId:project.id,operation}}};
 store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(toolId,runId,project.id,2,'tool',tool.status,JSON.stringify(tool),100);
 const proposal=store.tx(()=>edits.createInside(({run,tool,target,changes,toolCall,projectId:project.id,runId} as unknown as Parameters<typeof edits.createInside>[0])));
 run.status='completed';run.modelRequestState='completed';store.db.prepare('UPDATE agent_chat_runs SET status=?,data=? WHERE id=?').run('completed',JSON.stringify(run),runId);
 return JSON.parse(((store.db.prepare('SELECT definition FROM agent_edit_proposals WHERE id=?').get(proposal.id)!.definition as string))).input;
}
async function fixture(t: test.TestContext,{exportOptions,agent=false,media=false,subjectTask=false}:{exportOptions?:import('../packages/business/src/services.ts').CreateServicesOptions['exportOptions'];agent?:boolean;media?:boolean;subjectTask?:boolean}={}){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-restore-local-'));
 let store=(openStore(root) as unknown as FixtureStore),services=(createServices(store,new Map()) as unknown as FixtureServices),tasks=(createEditTasks({store,services}) as unknown as import("./helpers/strict-opacity-fixture-types.ts").OpacityTasks);
 const project=await services.call('project.create',{name:'Local restore'}),empty=await services.call('project.create',{name:'No timeline'});
 const savedInput={projectId:project.id,title:'Saved before restore',requestId:randomUUID()},saved=await services.call('shot.create',savedInput);
 const sourceBytes=Buffer.from('synthetic frozen source');if(media)writeFileSync(path.join(root,'media','synthetic.mp4'),sourceBytes);
 const asset=store.put('assets',{id:randomUUID(),projectId:project.id,name:'Synthetic source',mimeType:'video/mp4',duration:10,width:720,height:1280,hasAudio:false,hasVideo:true,provenance:'user-import',sha256:media?createHash('sha256').update(sourceBytes).digest('hex'):'a'.repeat(64),relativePath:'media/synthetic.mp4',createdAt:now()});
 let timeline=await services.call('timeline.get',{projectId:project.id});
 timeline=await services.call('timeline.clip.add',{projectId:project.id,requestId:randomUUID(),expectedRevision:timeline.revision,assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30,sourceInFrame:0});
 const pending=tasks.prepare({projectId:project.id,operation:'timeline.track.add',input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),kind:'audio'},origin:'new'});
 let capturedSubject;if(subjectTask){const image=store.put('assets',{id:randomUUID(),projectId:project.id,name:'Subject source',mimeType:'image/png',width:1,height:1,sha256:'b'.repeat(64),sizeBytes:32,relativePath:'media/subject.png',provenance:'user-import'});capturedSubject=tasks.prepare({projectId:project.id,operation:'subject.create',input:{projectId:project.id,requestId:randomUUID(),name:'Captured subject',kind:'character',assetId:image.id},origin:'new'});}
 if(media){const jobId=randomUUID(),versionId=randomUUID();store.put('jobs',{id:jobId,projectId:project.id,shotId:saved.id,status:'succeeded',versionId});store.put('versions',{id:versionId,projectId:project.id,shotId:saved.id,jobId,assetId:asset.id,sha256:asset.sha256,number:1});store.put('shots',{...saved,selectedVersionId:versionId});}
 const heldExport=await services.call('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'preview'});
 const intents=agent?['shot.update','timeline.clip.update'].map(operation=>({operation,input:agentIntent(store,services,project,saved,timeline,operation)})):[];
 await tasks.drain();await services.drain();store.close();
 const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:now()};
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{installCurrentWorkspaceRestoreSchema(db,metadata);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
 store=(openStore(root) as unknown as FixtureStore);services=(createServices(store,new Map(),{exportOptions}) as unknown as FixtureServices);tasks=(createEditTasks({store,services}) as unknown as import("./helpers/strict-opacity-fixture-types.ts").OpacityTasks);
 const f={root,store,services,tasks,project,empty,savedInput,saved,asset,timeline,pending,heldExport,intents,capturedSubject,metadata,context:{expectedWorkspaceOrigin:metadata.workspaceOrigin}};
 t.after(async()=>{await tasks.drain();await services.drain();if(store.db.isOpen)store.close();rmSync(root,{recursive:true,force:true});});return f;
}

test('explicit origin admits shared fresh local mutations; immutable old receipts replay without origin or writes',async t=>{
 const f=await fixture(t),before=captured(f.store.db),raw=f.store.db.prepare('SELECT response FROM mutation_requests WHERE requestId=?').get(f.savedInput.requestId)!.response;
 assert.deepEqual(await f.services.call('shot.create',f.savedInput),f.saved);
 assert.equal(f.store.db.prepare('SELECT response FROM mutation_requests WHERE requestId=?').get(f.savedInput.requestId)!.response,raw);
 for(const [context,expected] of [[{},'RESTORE_WORKSPACE_ORIGIN_REQUIRED'],[{expectedWorkspaceOrigin:randomUUID()},'RESTORE_WORKSPACE_ORIGIN_MISMATCH']] as const)await assert.rejects(f.services.call('shot.update',{shotId:f.saved.id,expectedRevision:1,patch:{title:'Fresh'},requestId:randomUUID()},context),code(expected));
 const result=await f.services.call('shot.update',{shotId:f.saved.id,expectedRevision:1,patch:{title:'Fresh'},requestId:randomUUID()},f.context);assert.equal(result.title,'Fresh');assert.equal(result.revision,2);
 assert.equal(captured(f.store.db),before);
});

test('captured prepared task and Agent proposal keys cannot bypass holds through a new direct invocation',async t=>{
 const f=await fixture(t,{agent:true}),before=captured(f.store.db);
 await assert.rejects(f.services.call('timeline.track.add',f.pending.task.input,f.context),code('RESTORED_RECORD_HELD'));
 for(const intent of f.intents){
  await assert.rejects(f.services.call(intent.operation,intent.input,f.context),code('RESTORED_RECORD_HELD'));
  const operation=intent.operation==='shot.update'?'node.create':'timeline.track.add';
  const input=intent.operation==='shot.update'?{projectId:f.project.id,type:'text',position:{x:0,y:0},requestId:intent.input.requestId}:{projectId:f.project.id,expectedRevision:f.timeline.revision,kind:'audio',requestId:intent.input.requestId};
  await assert.rejects(f.services.call(operation,input,f.context),code('RESTORED_RECORD_HELD'));
  await assert.rejects(f.services.call(operation,{...input,projectId:f.empty.id},f.context),code('RESTORE_OPERATION_UNAVAILABLE'));
 }
 assert.equal(f.store.get('shots',f.saved.id)!.title,f.saved.title);assert.equal(f.store.get('timelines',f.timeline.id)!.revision,f.timeline.revision);assert.equal(captured(f.store.db),before);
});

test('fresh durable tasks use current epoch and shared nested dispatch; held lane rows never block or mutate',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(f.pending.task.id));
 const made=f.tasks.prepare({projectId:f.project.id,operation:'timeline.track.add',input:{...f.pending.task.input,requestId:randomUUID()},origin:'new'},f.context);
 assert.equal(made.restore!.executionEpoch,f.metadata.workspaceOrigin);assert.equal(made.restore!.held,false);
 const done=await f.tasks.execute({projectId:f.project.id,taskId:made.task.id,digest:made.task.digest,instanceId:made.instanceId},f.context);
 assert.equal(done.task.status,'applied');assert.equal(done.result!.revision,f.timeline.revision+1);
 f.tasks.acknowledge({projectId:f.project.id,taskId:done.task.id,digest:done.task.digest,expectedRevision:done.task.revision,status:'applied'},f.context);
 assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM edit_tasks WHERE id=?').get(f.pending.task.id)),before);
 assert.equal(f.tasks.list({projectId:f.project.id}).items.length,0);
});

test('missing restored timeline remains absent on reads and explicit format initialization creates it',async t=>{
 const f=await fixture(t);assert.equal((await f.services.call('project.get',{projectId:f.empty.id})).timeline,null);
 const format=await f.services.call('timeline.format.get',{projectId:f.empty.id});assert.equal(format.timelineRevision,0);
 const result=await f.services.call('timeline.format.set',{projectId:f.empty.id,expectedProjectRevision:f.empty.revision,expectedRevision:0,presetId:format.presetId,requestId:randomUUID()},f.context);
 assert.equal(result.projectId,f.empty.id);assert.ok((await f.services.call('timeline.get',{projectId:f.empty.id})).id);
});

test('read-only replay never enters apply without a receipt and cannot manufacture not-applied proof',async t=>{
 const f=await fixture(t);let effects=0;
 const mutate=createMutationReplay(f.store,{canonical,readOnly:true});
 assert.equal(mutate('shot.create',{projectId:f.project.id,requestId:randomUUID()},{resolve:()=>({projectId:f.project.id}),apply:()=>{effects++;},replay:()=>{effects++;}}),NO_MUTATION_REPLAY);assert.equal(effects,0);
});

test('invocation capabilities expire on settlement and abort, retain exact frozen input, and cannot delegate another operation',async t=>{
 const f=await fixture(t),input=freezeRestoreInput({projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),kind:'audio'});
 const timeline=createTimelineServices((f.store as unknown as Parameters<typeof createTimelineServices>[0]),({required:f.services.required,check:f.services.check,hash,now} as unknown as Parameters<typeof createTimelineServices>[1]));let late!:()=>unknown,fence!:()=>void;
 await withRestoreInvocation(f.store,'timeline.track.add',input,{},async()=>{fence=restoreEffectFence(f.store)!;late=()=>timeline.handlers['timeline.track.add'](((input) as unknown as Parameters<typeof timeline.handlers['timeline.track.add']>[0]));fence!();await assert.rejects(f.services.call('project.create',{name:'Unexpected'}),code('RESTORE_OPERATION_UNAVAILABLE'));});
 assert.throws(fence!,code('RESTORE_OPERATION_UNAVAILABLE'));assert.throws(late!,code('RESTORE_OPERATION_UNAVAILABLE'));assert.ok(Object.isFrozen(input));
 const controller=new AbortController();await withRestoreInvocation(f.store,'timeline.track.add',input,{signal:controller.signal},async()=>{const check=restoreEffectFence(f.store);controller.abort();assert.throws(check!,code('RESTORE_OPERATION_UNAVAILABLE'));});
});

test('new export seals receipt hash and immutable identity atomically; worker ignores held, unbound and replaced rows',async t=>{
 const f=await fixture(t),input={projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),purpose:'preview'},before=f.store.db.prepare('SELECT count(*) n FROM exports').get()!.n;
 f.store.db.exec("CREATE TRIGGER reject_test_origin BEFORE INSERT ON workspace_restore_export_origins BEGIN SELECT RAISE(ABORT,'origin fail');END;");
 await assert.rejects(f.services.call('timeline.render',input,f.context),/origin fail/);assert.equal(f.store.db.prepare('SELECT count(*) n FROM exports').get()!.n,before);assert.equal(f.store.db.prepare('SELECT 1 FROM timeline_requests WHERE requestId=?').get(input.requestId),undefined);
 f.store.db.exec('DROP TRIGGER reject_test_origin');
 const value=await f.services.call('timeline.render',input,f.context),binding=f.store.db.prepare('SELECT * FROM workspace_restore_export_origins WHERE exportId=?').get(value.id);
 assert.equal(binding!.requestHash,hash({operation:'timeline.render',input}));assert.equal(binding!.identityHash,restoreExportIdentity((f.store.get('exports',value.id)! as FixtureExport)));assert.ok(matchesRestoredExport(f.store,(f.store.get('exports',value.id)! as FixtureExport)));assert.deepEqual(await f.services.call('timeline.render',input),value);
 const privateValue=(f.store.get('exports',value.id)! as FixtureExport);
 const changed={...privateValue,snapshot:{...privateValue!.snapshot,timeline:{...privateValue!.snapshot.timeline,width:999}}};assert.throws(()=>f.store.put('exports',changed),/snapshots are immutable/);assert.equal(matchesRestoredExport(f.store,changed),false);
 f.store.put('exports',{...privateValue,status:'failed',error:{code:'SYNTHETIC_FINISHED',message:'Fixture terminal',retryable:false}});
 const unbound={...privateValue,id:randomUUID(),requestId:randomUUID()};f.store.put('exports',unbound);
 let spawns=0;const off=onMediaProcess(event=>{if(event.type==='started')spawns++;});const raw=JSON.stringify(f.store.db.prepare('SELECT * FROM exports ORDER BY id').all());
 const worker=startWorker(f.store,f.services,new Proxy(new Map(),{get(){throw Error('provider access');}}));try{await worker.tick();await worker.tick();}finally{await worker.stop();off();}
 assert.equal(spawns,0);assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM exports ORDER BY id').all()),raw);
});

test('import path replacement after native observation is never adopted or removed as owned output',async t=>{
 const f=await fixture(t),binary=path.join(f.root,'synthetic-probe.mjs'),previous=process.env.MIOON_FFPROBE_PATH;
 writeFileSync(binary,`#!${process.execPath}\nprocess.stdout.write(JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'png',width:1,height:1}],format:{duration:'1'}}));\n`,{mode:0o700});
 process.env.MIOON_FFPROBE_PATH=binary;t.after(()=>{if(previous===undefined)delete (process.env as unknown as Record<PropertyKey,unknown>).MIOON_FFPROBE_PATH;else process.env.MIOON_FFPROBE_PATH=previous;});
 let replaced!:string,spawns=0;const off=onMediaProcess(event=>{if(event.type!=='started')return;spawns++;const name=readdirSync(path.join(f.root,'media')).find(name=>name.endsWith('.png'));if(name){replaced=path.join(f.root,'media',name);unlinkSync(replaced);writeFileSync(replaced,'foreign replacement');}});t.after(off);
 const before=f.store.list('assets',f.project.id).length;
 await assert.rejects(f.services.call('asset.import',{projectId:f.project.id,name:'One pixel',mimeType:'image/png',dataBase64:Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64')},f.context),code('RESTORE_OPERATION_UNAVAILABLE'));
 assert.equal(spawns,1);assert.equal(f.store.list('assets',f.project.id).length,before);assert.equal(readFileSync(replaced,'utf8'),'foreign replacement');
});

for(const drift of ['same-inode bytes','project JSON owner'] as const)test(`import ${drift} drift while probe awaits cannot publish an asset`,async t=>{
 const f=await fixture(t),binary=path.join(f.root,'synthetic-probe.mjs'),previous=process.env.MIOON_FFPROBE_PATH;
 writeFileSync(binary,`#!${process.execPath}\nsetTimeout(()=>process.stdout.write(JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'png',width:1,height:1}],format:{duration:'1'}})),20);\n`,{mode:0o700});
 process.env.MIOON_FFPROBE_PATH=binary;t.after(()=>{if(previous===undefined)delete (process.env as unknown as Record<PropertyKey,unknown>).MIOON_FFPROBE_PATH;else process.env.MIOON_FFPROBE_PATH=previous;});
 const before=f.store.list('assets',f.project.id).length;let spawns=0;
 const off=onMediaProcess(event=>{if(event.type!=='started')return;spawns++;if(drift==='same-inode bytes'){const name=readdirSync(path.join(f.root,'media')).find(name=>name.endsWith('.png'));writeFileSync(path.join(f.root,'media',name!),'rewritten in place');}else f.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...f.project,id:randomUUID()}),f.project.id);});t.after(off);
 await assert.rejects(f.services.call('asset.import',{projectId:f.project.id,name:'One pixel',mimeType:'image/png',dataBase64:Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64')},f.context),code('RESTORE_OPERATION_UNAVAILABLE'));
 assert.equal(spawns,1);assert.equal(f.store.list('assets',f.project.id).length,before);
});

test('captured subject task reserves its shared local key across operations, while unrelated namespaces remain usable',async t=>{
 const f=await fixture(t,{subjectTask:true}),key=f.capturedSubject!.task.requestId;
 await assert.rejects(f.services.call('shot.create',{projectId:f.project.id,title:'Blocked',requestId:key},f.context),code('RESTORED_RECORD_HELD'));
 await assert.rejects(f.services.call('node.create',{projectId:f.empty.id,type:'text',position:{x:0,y:0},requestId:key},f.context),code('RESTORE_OPERATION_UNAVAILABLE'));
 const node=await f.services.call('node.create',{projectId:f.project.id,type:'text',position:{x:0,y:0},requestId:f.pending.task.requestId},f.context);assert.equal(node.type,'text');
});

test('positive current-origin timeline and storyboard exports publish through the shared worker without touching held exports',async t=>{
 const f=await fixture(t,{media:true}),binary=path.join(f.root,'synthetic-media.ts'),old={MIOON_FFMPEG_PATH:process.env.MIOON_FFMPEG_PATH,MIOON_FFPROBE_PATH:process.env.MIOON_FFPROBE_PATH};
 const video={index:0,codec_type:'video',codec_name:'h264',width:720,height:1280,r_frame_rate:'30/1',avg_frame_rate:'30/1',nb_frames:'30'},renderedVideo={...video,width:f.timeline.width,height:f.timeline.height},audio={index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2};
 writeFileSync(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const args=process.argv.slice(2);if(args.includes('-show_streams')){const source=args.at(-1).endsWith('synthetic.mp4');process.stdout.write(JSON.stringify({streams:source?[${JSON.stringify(video)}]:[${JSON.stringify(renderedVideo)},${JSON.stringify(audio)}],format:{duration:source?'10':'1'}}));}else writeFileSync(args.at(-1),'synthetic rendered bytes',{flag:args.includes('-n')?'wx':'w'});\n`,{mode:0o700});
 process.env.MIOON_FFMPEG_PATH=binary;process.env.MIOON_FFPROBE_PATH=binary;t.after(()=>{for(const [key,value]of Object.entries(old))if(value===undefined)delete (process.env as unknown as Record<PropertyKey,unknown>)[key];else process.env[key]=value;});
 const heldBefore=JSON.stringify(f.store.db.prepare('SELECT * FROM exports WHERE id=?').get(f.heldExport.id));
 const timeline=await f.services.call('timeline.render',{projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),purpose:'preview'},f.context);
 const storyboard=await f.services.call('export.create',{projectId:f.project.id,requestId:randomUUID()},f.context);
 assert.equal(f.store.db.prepare('SELECT requestScope FROM workspace_restore_export_origins WHERE exportId=?').get(storyboard.id)!.requestScope,'export');
 f.store.put('exports',{...(f.store.get('exports',timeline.id)! as FixtureExport),status:'running'});
 const worker=startWorker(f.store,f.services,new Proxy(new Map(),{get(){throw Error('Provider execution is disabled');}}));try{await worker.tick();}finally{await worker.stop();}
 for(const value of [timeline,storyboard] as const){const result=(f.store.get('exports',value.id)!);assert.equal(result!.status,'succeeded',JSON.stringify(result!.error));assert.ok(result!.assetId);assert.ok(matchesRestoredExport(f.store,result!));const asset=f.store.get('assets',result!.assetId),output=value.mode==='timeline'?value.snapshot.timeline:value.outputGeometry;assert.equal(asset!.provenance,'export');assert.deepEqual({width:asset!.width,height:asset!.height},{width:output.width,height:output.height});}
 assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM exports WHERE id=?').get(f.heldExport.id)),heldBefore);
});

test('fresh import pins caller name, MIME and bytes while its native probe awaits',async t=>{
 const f=await fixture(t),binary=path.join(f.root,'synthetic-probe.mjs'),previous=process.env.MIOON_FFPROBE_PATH;
 writeFileSync(binary,`#!${process.execPath}\nsetTimeout(()=>process.stdout.write(JSON.stringify({streams:[{index:0,codec_type:'video',codec_name:'png',width:1,height:1}],format:{duration:'1'}})),20);\n`,{mode:0o700});
 process.env.MIOON_FFPROBE_PATH=binary;t.after(()=>{if(previous===undefined)delete (process.env as unknown as Record<PropertyKey,unknown>).MIOON_FFPROBE_PATH;else process.env.MIOON_FFPROBE_PATH=previous;});
 const bytes=Buffer.from([137,80,78,71,13,10,26,10,0]),input={projectId:f.project.id,name:'Pinned image',mimeType:'image/png',dataBase64:bytes.toString('base64')};
 const off=onMediaProcess(event=>{if(event.type==='started'){input.name='Changed caller';input.mimeType='audio/wav';input.dataBase64='AAAA';}});t.after(off);
 const result=await f.services.call('asset.import',input,f.context);assert.equal(result.name,'Pinned image');assert.equal(result.mimeType,'image/png');assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.deepEqual(readFileSync(path.join(f.root,f.store.get('assets',result.id)!.relativePath)),bytes);
});

test('deferred export admission keeps its parsed input and revokes inherited callbacks after settlement',async t=>{
 let release,enteredResolve: (value?: unknown) => void,late!:()=>void;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enteredResolve=resolve);
 const f=await fixture(t,{exportOptions:{inspect:async(_delivery: unknown,{beforeEffect}: {beforeEffect:(()=>void)|undefined})=>{late=beforeEffect!;enteredResolve();await gate;return {status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'};}}});
 const input={projectId:f.project.id,expectedRevision:f.timeline.revision,requestId:randomUUID(),purpose:'export',exportSettings:{profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}}};
 const original=structuredClone(input),pending=f.services.call('timeline.render',input,f.context);await entered;input.exportSettings.rateControl.quality='high';input.requestId=randomUUID();release!();
 const result=await pending,stored=(f.store.get('exports',result.id)! as FixtureExport);assert.equal(stored!.requestId,original.requestId);assert.deepEqual(stored!.snapshot.delivery!.exportSettings,original.exportSettings);assert.throws(late,code('RESTORE_OPERATION_UNAVAILABLE'));
 let resolveLate: (value?: unknown) => void;const finished=new Promise(resolve=>resolveLate=resolve);
 await withRestoreInvocation(f.store,'project.create',(freezeRestoreInput({name:'Pinned'}) as unknown as Parameters<typeof withRestoreInvocation>[2]),{},()=>{setImmediate(()=>{assert.throws(()=>restoreEffectFence(f.store),code('RESTORE_OPERATION_UNAVAILABLE'));resolveLate();});});await finished;
});

test('restored preference writes require explicit origin and share the existing strict revision boundary',async t=>{
 const f=await fixture(t),preferences=(createWorkspacePreferences(f.store) as unknown as import('./helpers/strict-workspace-boundary-types.ts').PreferenceService),state=defaultWorkspaceState();delete (state.shared as unknown as Record<PropertyKey,unknown>).assetSearch;
 const input={expectedRevision:0,state};assert.throws(()=>preferences.put(f.project.id,input),code('RESTORE_WORKSPACE_ORIGIN_REQUIRED'));
 const accepted=preferences.put(f.project.id,input,f.context);assert.equal(accepted.revision,1);assert.deepEqual(preferences.put(f.project.id,input,f.context),accepted);
});

for(const scenario of ['timeline after first segment','storyboard source probe','storyboard final output probe'] as const)test(`restored ${scenario} owner drift blocks all later effects and publication`,async t=>{
 const f=await fixture(t,{media:true}),binary=path.join(f.root,'synthetic-media.ts'),old={MIOON_FFMPEG_PATH:process.env.MIOON_FFMPEG_PATH,MIOON_FFPROBE_PATH:process.env.MIOON_FFPROBE_PATH};
 const metadata={streams:[{index:0,codec_type:'video',codec_name:'h264',width:720,height:1280,r_frame_rate:'30/1',avg_frame_rate:'30/1',nb_frames:'30'},{index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',channels:2}],format:{duration:'1'}};
 writeFileSync(binary,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const args=process.argv.slice(2);if(args.includes('-show_streams')){const value=${JSON.stringify(metadata)};if(args.at(-1).endsWith('synthetic.mp4'))value.format.duration='10';process.stdout.write(JSON.stringify(value));}else writeFileSync(args.at(-1),'synthetic rendered bytes',{flag:args.includes('-n')?'wx':'w'});\n`,{mode:0o700});
 process.env.MIOON_FFMPEG_PATH=binary;process.env.MIOON_FFPROBE_PATH=binary;t.after(()=>{for(const [key,value]of Object.entries(old))if(value===undefined)delete (process.env as unknown as Record<PropertyKey,unknown>)[key];else process.env[key]=value;});
 let value;
 if(scenario.startsWith('timeline')){
  const timeline=await f.services.call('timeline.clip.add',{projectId:f.project.id,requestId:randomUUID(),expectedRevision:f.timeline.revision,assetId:f.asset.id,trackId:f.timeline.tracks[0].id,startFrame:30,durationFrames:30,sourceInFrame:0},f.context);
  value=await f.services.call('timeline.render',{projectId:f.project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'preview'},f.context);
 }else value=await f.services.call('export.create',{projectId:f.project.id,requestId:randomUUID()},f.context);
 let probes=0,encodes=0,changed=false;
 const off=onMediaProcess(event=>{
  if(event.type==='started'){if(event.kind==='ffprobe')probes++;if(event.kind==='ffmpeg')encodes++;}
  const drift=scenario==='timeline after first segment'?event.type==='exited'&&event.kind==='ffmpeg'&&encodes===1:event.type==='started'&&event.kind==='ffprobe'&&probes===(scenario==='storyboard source probe'?1:4);
  if(!changed&&drift){changed=true;f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.empty.id,f.asset.id);}
 });t.after(off);
 const before=f.store.db.prepare('SELECT count(*) n FROM assets').get()!.n,worker=startWorker(f.store,f.services,new Map());try{await worker.tick();}finally{await worker.stop();}
 const result=(f.store.get('exports',value.id)!);assert.equal(changed,true);assert.equal(result!.status,'failed');assert.equal(result!.assetId,null);assert.equal(f.store.db.prepare('SELECT count(*) n FROM assets').get()!.n,before);
 assert.equal(encodes,scenario==='storyboard source probe'?0:1);assert.equal(readdirSync(path.join(f.root,'media')).filter(name=>name.startsWith('export-')).length,0);
});

test('ordinary v24 actual Mock download decodes and publishes a selected version', {timeout:15000},async t=>{
 const root=mkdtempSync(path.join(tmpdir(),'mioon-normal-mock-')),store=(openStore(root) as unknown as FixtureStore),mock=createMockProvider({db:store.db,root}),providers=new Map([['mock',mock]]),services=(createServices(store,(providers as unknown as Parameters<typeof createServices>[1])) as unknown as FixtureServices);let worker: Worker;
 t.after(async()=>{await worker?.stop();await services.drain();store.close();rmSync(root,{recursive:true,force:true});});
 const project=await services.call('project.create',{name:'Ordinary Mock'}),shot=await services.call('shot.create',{projectId:project.id,title:'Mock download',prompt:'Synthetic geometric movement',duration:2});
 const job=await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID(),parameters:{delayMs:0}});
 worker=startWorker(store,services,(providers as unknown as Parameters<typeof startWorker>[2]));await worker.tick();await worker.tick();
 const result=store.get('jobs',job.id);assert.equal(result!.status,'succeeded',JSON.stringify(result!.error));assert.ok(result!.versionId);
 const version=store.get('versions',result!.versionId),asset=store.get('assets',version!.assetId);assert.equal((version as typeof version&{isMock:boolean}).isMock,true);assert.equal(asset!.provenance,'synthetic-mock');assert.equal(store.get('shots',shot.id)!.selectedVersionId,version!.id);assert.ok(readFileSync(path.join(root,asset!.relativePath)).length>0);
});
