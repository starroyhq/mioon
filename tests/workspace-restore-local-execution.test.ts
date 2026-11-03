





import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {WorkspaceServices as FixtureServices} from './helpers/strict-workspace-boundary-types.ts';
import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';


import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,unlinkSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import { installCurrentWorkspaceRestoreSchema, openLegacyWorkspaceStore as openStore } from '../packages/business/src/db.ts';

import {createServices, hash, now} from '../packages/business/src/services.ts';
import {createEditTasks} from '../packages/business/src/edit-tasks.ts';


import {withRestoreInvocation,restoreEffectFence,freezeRestoreInput} from '../packages/business/src/workspace-restore-invocation.ts';
import {matchesRestoredExport,restoreExportIdentity} from '../packages/business/src/workspace-restore-exports.ts';
import {startWorker, type Worker} from '../packages/business/src/jobs.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';

const code=(value: string|{ expectedWorkspaceOrigin?: undefined; }|{ expectedWorkspaceOrigin: `${string}-${string}-${string}-${string}-${string}`; })=>(error: { code: unknown; })=>(error as unknown as import('./helpers/strict-opacity-fixture-types.ts').OpacityFailure)?.code===value;
const captured=(db: DatabaseSync)=>JSON.stringify(db.prepare('SELECT * FROM workspace_restore_holds ORDER BY kind,id').all());
async function fixture(t: test.TestContext,{exportOptions,media=false,subjectTask=false}:{exportOptions?:import('../packages/business/src/services.ts').CreateServicesOptions['exportOptions'];media?:boolean;subjectTask?:boolean}={}){
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
 await tasks.drain();await services.drain();store.close();
 const metadata={restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:now()};
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));try{installCurrentWorkspaceRestoreSchema(db,metadata);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}finally{db.close();}
 store=(openStore(root) as unknown as FixtureStore);services=(createServices(store,new Map(),{exportOptions}) as unknown as FixtureServices);tasks=(createEditTasks({store,services}) as unknown as import("./helpers/strict-opacity-fixture-types.ts").OpacityTasks);
 const f={root,store,services,tasks,project,empty,savedInput,saved,asset,timeline,pending,heldExport,capturedSubject,metadata,context:{expectedWorkspaceOrigin:metadata.workspaceOrigin}};
 t.after(async()=>{await tasks.drain();await services.drain();if(store.db.isOpen)store.close();rmSync(root,{recursive:true,force:true});});return f;
}













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
