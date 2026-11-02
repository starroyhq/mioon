import type {Provider} from '../packages/business/src/provider-registry.ts';
import type {createMockProvider} from '../packages/business/src/providers/mock.ts';
import type {SQLInputValue} from 'node:sqlite';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createArkProvider} from '../packages/business/src/providers/ark.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {FRAME_PROFILE,FRAME_PROFILE_ID,FRAME_SELECTION_RULE,canonicalFrameInput} from '../packages/contracts/src/frame-extraction.ts';
import {startWorker, type Worker} from '../packages/business/src/jobs.ts';
import {getLegacyCapabilityProfile,isReferenceMutationResponse} from '@mioon/contracts';
import type { BinaryLike } from 'crypto';
import {withoutForeignKeys} from './helpers/project-database.ts';

const sha=(value: Buffer<ArrayBuffer>|BinaryLike)=>createHash('sha256').update(value).digest('hex');
function png(fill: string|number|Uint8Array<ArrayBufferLike>|undefined){
 const chunk=(name: string,data:Uint8Array)=>{const body=Buffer.concat([Buffer.from(name),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(body));return Buffer.concat([head,body,tail]);};
 const head=Buffer.alloc(13);head.writeUInt32BE(360);head.writeUInt32BE(640,4);head[8]=8;head[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.alloc((360*3+1)*640,fill))),chunk('IEND',Buffer.alloc(0))]);
}
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: test.TestContext,name='Foreign project'){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-frame-pair-foreign-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=(openStore(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices);
 try{return await services.call('project.create',{name});}
 finally{await services.drain();store.close();}
}
async function fixture(t: test.TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-frame-pair-')),store=(openStore(root) as TypedStore),env:NodeJS.ProcessEnv={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'inert',GEMINI_API_KEY:'inert',RUNWAYML_API_SECRET:'inert',MINIMAX_API_KEY:'inert',VIDU_API_KEY:'inert',VIDU_OUTPUT_HOSTS:'offline.invalid'};
 const providers=createProviderRegistry({db:store.db,root,env}),services=(createServices(store,providers,{env,profileNow:()=>Date.parse('2026-10-11T12:00:00Z')}) as TypedServices);let worker: Worker,posts=0;
 const call=<O extends string>(op: O,input: unknown)=>services.call(op,input),project=await call('project.create',{name:'Offline frame pair'}),other=await foreignProject(t,'Other owner');
 async function asset<P extends Record<string,unknown> = Record<string,never>>(patch:P={} as P){const bytes=png(store.list('assets').length),id=randomUUID(),record={id,projectId:project.id,name:'Synthetic frame',mimeType:'image/png',relativePath:`media/${id}.png`,sha256:sha(bytes),sizeBytes:bytes.length,width:360,height:640,provenance:'user-import',createdAt:new Date().toISOString(),...patch};store.put('assets',record);await writeFile(path.join(root,record.relativePath),bytes);return record;}
 const first=await asset(),last=await asset(),replacement=await asset();env.ARK_APPROVED_ASSET_SHA256=[first,last,replacement].map(a=>a.sha256).join(',');
 const ark=createArkProvider({root,env,fetchImpl:(async()=>{posts++;return new Response(JSON.stringify({id:'offline-frame-pair'}));}) as unknown as typeof fetch});providers.set('ark',ark as unknown as Provider);
 t.after(async()=>{await worker?.stop();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 return {root,store,env,providers,services,call,project,other,first,last,replacement,asset,posts:()=>posts,
  shot:(patch={})=>call('shot.create',{projectId:project.id,title:'Pair',prompt:'Synthetic shapes',duration:4,...patch}),
  update:(shot: { id: unknown; revision: unknown; },patch: unknown,extra={})=>call('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch,requestId:randomUUID(),...extra}),
  submit:(shot: { id: unknown; revision: unknown; },providerId='mock',extra={})=>call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId,requestId:randomUUID(),...extra}),
  async tick(){worker??=startWorker(store,services,providers);await worker.tick();},stop:async()=>worker?.stop()};
}
const bytes=(f: Awaited<ReturnType<typeof fixture>>,table:string,id:string)=>f.store.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)?.data;
const count=(f: Awaited<ReturnType<typeof fixture>>)=>f.store.list('jobs').length;

test('tail save reuses CAS and original journal replay while absent legacy shape stays absent',async t=>{
 const f=await fixture(t);let shot=await f.shot();assert.equal(Object.hasOwn(shot,'lastFrameAssetId'),false);
 shot=await f.update(shot,{title:'Legacy rename'});assert.equal(Object.hasOwn(shot,'lastFrameAssetId'),false);
 const input={shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),patch:{lastFrameAssetId:f.last.id}},original=await f.call('shot.update',input);
 const newer=await f.update(original,{lastFrameAssetId:f.replacement.id});assert.deepEqual(await f.call('shot.update',input),original);
 assert.equal(f.store.get('shots',shot.id)!.lastFrameAssetId,f.replacement.id);
 await assert.rejects(f.update(original,{lastFrameAssetId:null}),{code:'REVISION_CONFLICT'});
 const cleared=await f.update(newer,{lastFrameAssetId:null});assert.equal(cleared.lastFrameAssetId,null);
 assert.equal((await f.shot({lastFrameAssetId:f.last.id})).lastFrameAssetId,f.last.id);
});

for(const drift of ['foreign-sql','foreign-json','wrong-mime','orphan-frame'])test(`tail create/update reject ${drift} without writing`,async t=>{
 const f=await fixture(t),shot=await f.shot();
 if(drift==='foreign-sql')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,f.last.id));
 if(drift==='foreign-json')f.store.put('assets',{...f.last,projectId:f.other.id});
 if(drift==='wrong-mime')f.store.put('assets',{...f.last,mimeType:'video/mp4'});
 if(drift==='orphan-frame')f.store.put('assets',{...f.last,provenance:'extracted-frame'});
 const before=bytes(f,'shots',shot.id),rows=f.store.list('shots').length;
 await assert.rejects(f.shot({lastFrameAssetId:f.last.id}));await assert.rejects(f.update(shot,{lastFrameAssetId:f.last.id}));
 assert.equal(bytes(f,'shots',shot.id),before);assert.equal(f.store.list('shots').length,rows);
});

for(const target of ['historical','current'])test(`shot replay validates ${target} tail relations even after later selection`,async t=>{
 const f=await fixture(t),shot=await f.shot(),input={shotId:shot.id,expectedRevision:shot.revision,patch:{lastFrameAssetId:f.last.id},requestId:randomUUID()},saved=await f.call('shot.update',input);
 await f.update(saved,{lastFrameAssetId:f.replacement.id});const changed=target==='historical'?f.last:f.replacement;
 withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,changed.id));const before=bytes(f,'shots',shot.id);
 await assert.rejects(f.call('shot.update',input));assert.equal(bytes(f,'shots',shot.id),before);
});

test('first-frame attach/detach and lost ACK replay retain independent tail',async t=>{
 const f=await fixture(t),node=await f.call('node.create',{projectId:f.project.id,type:'image',assetId:f.first.id,position:{x:0,y:0}}),shot=await f.shot({lastFrameAssetId:f.last.id});
 const input={projectId:f.project.id,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,role:'first_frame',requestId:randomUUID()},attached=await f.call('reference.attach',input);
 assert.equal(isReferenceMutationResponse('reference.attach',input,attached),true);assert.equal(attached.shot.lastFrameAssetId,f.last.id);assert.deepEqual(attached.shot.referenceAssetIds,[f.first.id]);
 await assert.rejects(f.update(attached.shot,{referenceAssetIds:[]}),{code:'REFERENCE_CONNECTED'});
 const edited=await f.update(attached.shot,{lastFrameAssetId:f.replacement.id});assert.deepEqual(await f.call('reference.attach',input),attached);
 const remove={projectId:f.project.id,edgeId:attached.edge.id,expectedShotRevision:edited.revision,requestId:randomUUID()},detached=await f.call('reference.detach',remove);
 assert.deepEqual((detached.shot.referenceAssetIds as unknown),[]);assert.equal(detached.shot.lastFrameAssetId,f.replacement.id);assert.deepEqual(await f.call('reference.detach',remove),detached);
 withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,f.last.id));await assert.rejects(f.call('reference.attach',input),{code:'INVALID_REFERENCE_RECORD'});
});

test('tail-only and duplicate saved choices cannot create a generation job',async t=>{
 const f=await fixture(t),tailOnly=await f.shot({lastFrameAssetId:f.last.id}),duplicate=await f.shot({referenceAssetIds:[f.first.id],lastFrameAssetId:f.first.id});
 await assert.rejects(f.submit(tailOnly));await assert.rejects(f.submit(duplicate));assert.equal(count(f),0);assert.equal(f.posts(),0);
});

test('admission freezes explicit complete frame manifest and original first connection',async t=>{
 const f=await fixture(t),node=await f.call('node.create',{projectId:f.project.id,type:'image',assetId:f.first.id,position:{x:0,y:0}}),shot=await f.shot({lastFrameAssetId:f.last.id});
 const attached=await f.call('reference.attach',{projectId:f.project.id,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,role:'first_frame',requestId:randomUUID()});
 const job=await f.submit(attached.shot),saved=f.store.get('jobs',job.id)!;
 assert.deepEqual(saved.snapshot.referenceAssetIds,[f.first.id,f.last.id]);assert.equal(saved.snapshot.lastFrameAssetId,f.last.id);
 assert.deepEqual(saved.snapshot.referenceBindings,[{role:'first_frame',assetId:f.first.id,sha256:f.first.sha256},{role:'last_frame',assetId:f.last.id,sha256:f.last.sha256}]);
 assert.deepEqual(saved.snapshot.referenceAssets.map(a=>[a.id,a.role,a.sizeBytes]),[[f.first.id,'first_frame',f.first.sizeBytes],[f.last.id,'last_frame',f.last.sizeBytes]]);
 assert.equal(saved.snapshot.referenceConnections[0].sourceAssetId,f.first.id);assert.deepEqual(f.store.get('shots',shot.id)!.referenceAssetIds,[f.first.id]);
 await f.tick();await f.stop();assert.equal(f.store.get('jobs',job.id)!.status,'running');
 const ledger=JSON.parse((f.store.db.prepare('SELECT snapshot_json FROM mock_provider_tasks WHERE request_id=?').get(job.requestId)!.snapshot_json as string));assert.deepEqual(ledger.referenceAssets.map((a: { role: unknown; })=>a.role),['first_frame','last_frame']);assert.equal(f.posts(),0);
});

for(const providerId of ['runway','veo','minimax','vidu'])test(`${providerId} never silently drops a saved tail`,async t=>{
 const f=await fixture(t),shot=await f.shot({referenceAssetIds:[f.first.id],lastFrameAssetId:f.last.id});await assert.rejects(f.submit(shot,providerId),{code:'UNSUPPORTED_INPUT_ROLE'});assert.equal(count(f),0);assert.equal(f.posts(),0);
});

for(const pinned of [false,true])test(`${pinned?'archived v1':'unpinned legacy'} retry never acquires a newly saved tail`,async t=>{
 const f=await fixture(t);let shot=await f.shot({referenceAssetIds:[f.first.id]});const job=await f.submit(shot),saved=f.store.get('jobs',job.id)!,legacy=getLegacyCapabilityProfile('mock','mock-motion-v1','local');
 for(const ref of saved.snapshot.referenceAssets)delete ref.role;
 if(pinned){saved.snapshot.inputProfileVersion=legacy!.profileVersion;saved.snapshot.inputProfileId=legacy!.profileId;}
 else for(const key of ['inputProfileVersion','inputProfileId','providerRegion','referenceBindings'])delete saved.snapshot[key];
 saved.status='failed';f.store.put('jobs',saved);const before=JSON.stringify(saved.snapshot);
 shot=await f.update(shot,{lastFrameAssetId:f.last.id});const retry=await f.call('job.retry',{jobId:job.id,requestId:randomUUID()});
 assert.equal(JSON.stringify(f.store.get('jobs',retry.id)!.snapshot),before);assert.equal(JSON.stringify(f.store.get('jobs',job.id)!.snapshot),before);assert.deepEqual(retry.snapshot.referenceAssetIds,[f.first.id]);assert.equal(Object.hasOwn(retry.snapshot,'lastFrameAssetId'),false);
});

test('pair retry retains original tail and rejects changed frozen tail metadata',async t=>{
 const f=await fixture(t);let shot=await f.shot({referenceAssetIds:[f.first.id],lastFrameAssetId:f.last.id});const job=await f.submit(shot),saved=f.store.get('jobs',job.id)!;saved.status='failed';f.store.put('jobs',saved);const before=JSON.stringify(saved.snapshot);
 shot=await f.update(shot,{lastFrameAssetId:f.replacement.id});const retry=await f.call('job.retry',{jobId:job.id,requestId:randomUUID()});assert.equal(JSON.stringify(f.store.get('jobs',retry.id)!.snapshot),before);
 f.store.put('jobs',{...f.store.get('jobs',retry.id),status:'failed'});f.store.put('assets',{...f.last,sha256:'f'.repeat(64)});
 await assert.rejects(f.call('job.retry',{jobId:retry.id,requestId:randomUUID()}),{code:'REFERENCE_CHANGED'});assert.equal(count(f),2);assert.equal(f.posts(),0);
});

for(const drift of ['tail-owner','first-metadata','shot-owner','job-snapshot','cancel'])test(`second-image async fence rejects ${drift} before any actual POST`,async t=>{
 const f=await fixture(t),shot=await f.shot({referenceAssetIds:[f.first.id],lastFrameAssetId:f.last.id}),job=await f.submit(shot,'ark'),provider=f.providers.get('ark')!;let checks=0,rawAfter;
 t.mock.method(console,'error',()=>{});
 f.providers.set('ark',{...provider,submit:(snapshot,context)=>provider!.submit(snapshot,{...context,validateReferenceState:()=>{
  if(++checks===7){
   if(drift==='tail-owner')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,f.last.id));
   if(drift==='first-metadata')f.store.put('assets',{...f.first,sha256:'f'.repeat(64)});
   if(drift==='shot-owner')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(f.other.id,shot.id));
   if(drift==='job-snapshot'){const current=f.store.get('jobs',job.id)!;f.store.put('jobs',{...current,snapshot:{...current.snapshot,prompt:'Changed during preparation'}});}
   if(drift==='cancel'){const current=f.store.get('jobs',job.id)!;f.services.saveJob(current,{status:'cancelled',phase:'cancelled',cancelScope:'local_only'});}
   rawAfter=bytes(f,'jobs',job.id);
  }
  (context.validateReferenceState as ()=>void)();
 }})});
 await f.tick();await f.stop();assert.ok(checks>=7);assert.equal(f.posts(),0);
 if(['shot-owner','job-snapshot','cancel'].includes(drift))assert.equal(bytes(f,'jobs',job.id),rawAfter);
 else{const failed=f.store.get('jobs',job.id)!;assert.equal(failed.status,'failed');assert.equal(failed.phase,'input_preflight_failed');assert.equal(failed.submissionCount,0);}
});

for(const state of ['queued','failed'])for(const pointer of [null,undefined])test(`${state} pair with ${pointer===null?'null':'missing'} frozen tail pointer fails closed`,async t=>{
 const f=await fixture(t),shot=await f.shot({referenceAssetIds:[f.first.id],lastFrameAssetId:f.last.id}),job=await f.submit(shot,'ark'),saved=f.store.get('jobs',job.id)!;
 saved.status=state;if(pointer===undefined)delete saved.snapshot.lastFrameAssetId;else saved.snapshot.lastFrameAssetId=null;f.store.put('jobs',saved);const before=JSON.stringify(saved.snapshot);
 if(state==='queued'){await f.tick();await f.stop();assert.equal(f.store.get('jobs',job.id)!.status,'failed');assert.equal(f.store.get('jobs',job.id)!.submissionCount,0);}
 else await assert.rejects(f.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'INVALID_REFERENCE_MANIFEST'});
 assert.equal(JSON.stringify(f.store.get('jobs',job.id)!.snapshot),before);assert.equal(count(f),1);assert.equal(f.posts(),0);
});


test('historical version tail without legacy reference array is ownership checked and not exposed in Agent DTO',async t=>{
 const f=await fixture(t),shot=await f.shot(),asset=await f.asset({mimeType:'video/mp4',provenance:'generated'}),jobId=randomUUID(),versionId=randomUUID(),snapshot={shotId:shot.id,lastFrameAssetId:f.last.id};
 f.store.put('jobs',{id:jobId,projectId:f.project.id,shotId:shot.id,assetId:asset.id,versionId,status:'succeeded',snapshot});
 f.store.put('versions',{id:versionId,projectId:f.project.id,shotId:shot.id,jobId,assetId:asset.id,sha256:asset.sha256,number:1,snapshot});
 f.store.put('shots',{...shot,selectedVersionId:versionId});
 assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).version(versionId,shot.id).id,versionId);
 const dto=await f.call('shot.inspect',{projectId:f.project.id});assert.doesNotMatch(JSON.stringify(dto),/lastFrameAssetId|last_frame/);
 withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,f.last.id));
 await assert.rejects(f.call('shot.inspect',{projectId:f.project.id}),{code:'INSPECTION_UNAVAILABLE'});
});

// Metadata-only published frame fixture with the same guarded transition and
// original receipt chain as the extraction subsystem; no decoder or provider.
async function typedFrame(f: Awaited<ReturnType<typeof fixture>>){
 const db=f.store.db,projectId=f.project.id,source=await f.asset({mimeType:'video/mp4',duration:3,hasVideo:true,hasAudio:false}),taskId=randomUUID(),requestId=randomUUID(),assetId=randomUUID(),at='2026-10-11T00:00:00.000Z';
 const input={projectId,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,requestId},inputHash=sha(canonicalFrameInput(input));
 const snapshot={schemaVersion:1,projectId,taskId,source:{assetId:source.id,sha256:source.sha256,mimeType:source.mimeType,sizeBytes:source.sizeBytes,relativePath:source.relativePath,duration:source.duration,width:source.width,height:source.height},requested:{sourceFrame:56,fps:30},profile:FRAME_PROFILE};
 const asset={...f.last,id:assetId,relativePath:`media/${assetId}.png`,provenance:'extracted-frame',createdAt:at};
 const receipt={schemaVersion:1,projectId,taskId,inputHash,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,selectionRule:FRAME_SELECTION_RULE,assetId,sha256:asset.sha256,mimeType:asset.mimeType,width:360,height:640,byteLength:asset.sizeBytes,probe:{streamIndex:0,timeBaseNumerator:1,timeBaseDenominator:15360,width:360,height:640,rotation:0,sarNumerator:1,sarDenominator:1}};
 const ack={id:taskId,projectId,requestId,sourceAssetId:source.id,sourceHash:source.sha256,sourceFrame:56,fps:30,profileId:FRAME_PROFILE_ID,state:'queued',revision:1,started:false,result:null,errorCode:null,createdAt:at,updatedAt:at};
 const insert=(table: string,value: { [s: string]: unknown; }|ArrayLike<unknown>)=>{const keys=Object.keys(value);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value) as SQLInputValue[]);};
 f.store.tx(()=>{insert('frame_tasks',{id:taskId,projectId,requestId,inputHash,input:canonicalFrameInput(input),snapshot:canonicalFrameInput(snapshot),state:'queued',revision:1,started:0,stagedReceipt:null,assetId:null,errorCode:null,createdAt:at,updatedAt:at});insert('frame_requests',{requestId,operation:'frame.extract',projectId,taskId,inputHash,canonicalInput:canonicalFrameInput(input),response:canonicalFrameInput(ack)});});
 db.prepare("UPDATE frame_tasks SET state='running',started=1,revision=2 WHERE id=?").run(taskId);
 db.prepare("UPDATE frame_tasks SET state='persisting',revision=3,stagedReceipt=? WHERE id=?").run(canonicalFrameInput(receipt),taskId);
 f.store.tx(()=>{f.store.put('assets',asset);db.prepare("UPDATE frame_tasks SET state='succeeded',revision=4,assetId=? WHERE id=?").run(assetId,taskId);});
 await writeFile(path.join(f.root,asset.relativePath),png(1));return {asset,source,taskId};
}

for(const relation of ['source-owner','source-hash'])test(`typed extracted tail validates full ${relation} lineage on save, replay and queued dispatch`,async t=>{
 const f=await fixture(t),frame=await typedFrame(f),input={projectId:f.project.id,title:'Owned extracted tail',prompt:'Synthetic',duration:4,referenceAssetIds:[f.first.id],lastFrameAssetId:frame.asset.id,requestId:randomUUID()},shot=await f.call('shot.create',input),job=await f.submit(shot);
 assert.equal(createOwnedMediaGraphReader(f.store.db,f.project.id).asset(frame.asset.id).id,frame.asset.id);
 if(relation==='source-owner')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,frame.source.id));else f.store.put('assets',{...frame.source,sha256:'f'.repeat(64)});
 const before=bytes(f,'shots',shot.id);await assert.rejects(f.call('shot.create',input),{code:'IMAGE_SOURCE_INVALID'});await assert.rejects(f.update(shot,{title:'Must remain unchanged'}),{code:'IMAGE_SOURCE_INVALID'});assert.equal(bytes(f,'shots',shot.id),before);
 await f.tick();await f.stop();const failed=f.store.get('jobs',job.id)!;assert.equal(failed.status,'failed');assert.equal(failed.error!.code,'IMAGE_SOURCE_INVALID');assert.equal(failed.submissionCount,0);assert.equal((f.providers.get('mock') as ReturnType<typeof createMockProvider>).stats(job.requestId).submissionCount,0);
});
