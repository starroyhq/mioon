import type {Provider} from '../packages/business/src/provider-registry.ts';
import type {FixtureProject} from './helpers/strict-timeline-core-types.ts';
import type {MediaJob,MediaShot} from './helpers/strict-service-responses.ts';
interface BoundaryFixture{root:string;store:TypedStore;env:Record<string,string>;providers:Map<string,Provider>;services:TypedServices;project:FixtureProject;other:FixtureProject;asset:{id:string;projectId:string;mimeType:string;relativePath:string;sha256:string;sizeBytes:number;width:number;height:number};shot:MediaShot;input:{shotId:string;expectedRevision:number;requestId:string;providerId:string};original:Provider;setDate(value:string):string;posts():number;polls():number;submit(patch?:Record<string,unknown>):Promise<MediaJob>;tick():Promise<void>;stop():Promise<void|undefined>}
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry,usesInputProfiles,registerInputProfileWrapper,normalizedCapabilities} from '../packages/business/src/provider-registry.ts';
import {startWorker, type Worker} from '../packages/business/src/jobs.ts';
import {createJsonRequest} from '../packages/business/src/providers/live-common.ts';
import {createVeoProvider} from '../packages/business/src/providers/veo.ts';
import {INPUT_PROFILE_VERSION,getCapabilityProfile,getLegacyCapabilityProfile} from '../packages/contracts/src/index.ts';

// The other project is not in this store; write the damaged row as a corrupt file would hold it.
const withoutForeignKeys=(db: TypedStore['db'],write: () => void)=>{db.exec('PRAGMA foreign_keys=OFF');try{write();}finally{db.exec('PRAGMA foreign_keys=ON');}};
// Another project lives in a store of its own: a store holds one project.
async function foreignProject(t: test.TestContext,name: string){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-input-boundary-foreign-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=(openStore(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices);
 try{return await services.call('project.create',{name});}
 finally{await services.drain();store.close();}
}
async function fixture(t: test.TestContext,{providerId='mock',date='2026-10-10',image=false}={}){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-input-boundary-')),store=(openStore(root) as TypedStore);
 const env={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'inert-fixture',GEMINI_API_KEY:'inert-fixture',MINIMAX_API_KEY:'inert-fixture'};
 const providers=createProviderRegistry({db:store.db,root,env});let current=date,worker: Worker,posts=0,polls=0;
 const services=(createServices(store,providers,{env,profileNow:()=>Date.parse(`${current}T12:00:00Z`)}) as TypedServices);
 const project=await services.call('project.create',{name:'Input boundary synthetic fixture'});
 const asset={id:randomUUID(),projectId:project.id,mimeType:'image/png',relativePath:'media/inert.png',sha256:'a'.repeat(64),sizeBytes:1024,width:360,height:640};
 store.put('assets',asset);await writeFile(path.join(root,asset.relativePath),'Inert managed fixture; never decoded or sent outside this process.');
 const shot=await services.call('shot.create',{projectId:project.id,title:'Input limits',prompt:'Synthetic shape',duration:4,referenceAssetIds:image?[asset.id]:[]});
 const input={shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId};
 const original=providers.get(providerId)!;
 const request=createJsonRequest({api:'https://offline.invalid',headers:{},ensureEnabled:()=>{},name:'Offline',fetchImpl:(async()=>{posts++;return new Response(JSON.stringify({id:'synthetic-task'}),{headers:{'content-type':'application/json'}});}) as unknown as typeof fetch});
 providers.set(providerId,{...original,submit:async(snapshot,context)=>{await request('/submit',{method:'POST',body:{},context:context as unknown as import("../packages/business/src/providers/live-common.ts").ProviderContext});return {providerJobId:'synthetic-task'};},poll:async()=>{polls++;return {status:'running',progress:0.1};},reconcile:async()=>({providerJobId:'synthetic-task'})});
 t.after(async()=>{await worker?.stop();store.close();await rm(root,{recursive:true,force:true});});
 return ({root,store,env,providers,services,project,asset,shot,input,original,setDate:(value: string)=>current=value,posts:()=>posts,polls:()=>polls,
  submit:(patch={})=>services.call('generation.submit',{...input,...patch}),
  async tick(){worker??=startWorker(store,services,providers);await worker.tick();},stop:async()=>worker?.stop()} as unknown as BoundaryFixture);
}
const snapshotBytes=(store: TypedStore,id:string)=>JSON.stringify(store.get('jobs',id)!.snapshot);
const markFailed=(f: Awaited<ReturnType<typeof fixture>>,id: string)=>f.store.put('jobs',{...f.store.get('jobs',id),status:'failed'});

test('production discovery carries exact safe regions, lifecycle results and all role facts',async t=>{
 const f=await fixture(t),caps=await f.services.call('provider.list',{});
 assert.equal(caps.length,6);assert.ok(usesInputProfiles(f.providers));
 for(const c of caps){assert.equal(c.inputProfileVersion,INPUT_PROFILE_VERSION);assert.equal(c.profileEvaluationDate,'2026-10-10');assert.equal(c.inputProfiles.length,1);assert.ok(c.inputProfiles[0].regions.includes(c.providerRegion!));assert.equal(c.inputProfileEvaluations[0].profileId,c.inputProfiles[0].profileId);assert.equal(Object.keys(c.inputProfiles[0].inputs.roles).length,5);assert.equal(c.inputProfiles[0].inputs.roles.last_frame.implemented,['ark','mock'].includes(c.id));if(['ark','mock'].includes(c.id))assert.equal(getLegacyCapabilityProfile(c.id,c.models[0],c.providerRegion)!.inputs.roles.last_frame.implemented,false);}
 assert.equal(caps.find((c: { id: string; })=>c.id==='mock')!.inputProfiles![0].output.depictsPromptOrReferences,false);
 assert.equal(caps.find((c: { id: string; })=>c.id==='ark')!.providerRegion,'cn-beijing');
 assert.ok(!JSON.stringify(caps).includes('inert-fixture'));
 f.setDate('2026-10-22');const veo=(await f.services.call('provider.list',{})).find((c: { id: string; })=>c.id==='veo');
 assert.equal(veo!.inputProfileEvaluations![0].issues[0].code,'MODEL_LIFECYCLE_REVALIDATION_REQUIRED');
});

test('new snapshot pins profile, exact region, complete role identity and byte size',async t=>{
 const f=await fixture(t,{image:true}),job=await f.submit(),saved=f.store.get('jobs',job.id)!;
 assert.equal(saved.snapshot.inputProfileVersion,getCapabilityProfile('mock','mock-motion-v1','local')!.profileVersion);assert.equal(saved.snapshot.providerRegion,'local');
 assert.deepEqual(saved.snapshot.referenceBindings,[{role:'first_frame',assetId:f.asset.id,sha256:f.asset.sha256}]);
 assert.equal(saved.snapshot.referenceAssets[0].sizeBytes,1024);assert.ok(!JSON.stringify(job).includes('relativePath'));
});

for(const [name,mutate,code] of [
 ['missing full saved reference',(f: Awaited<ReturnType<typeof fixture>>)=>f.store.db.prepare('DELETE FROM assets WHERE id=?').run(f.asset.id),'NOT_FOUND'],
 ['foreign relational owner',(f: Awaited<ReturnType<typeof fixture>>)=>withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(f.other.id,f.asset.id)),'INVALID_REFERENCE_OWNERSHIP'],
 ['spoofed JSON identity',(f: Awaited<ReturnType<typeof fixture>>)=>f.store.put('assets',{...f.asset,id:f.asset.id,projectId:f.project.id}),null],
 ['missing size',(f: Awaited<ReturnType<typeof fixture>>)=>{const {sizeBytes,...asset}=f.asset;f.store.put('assets',asset);},'REFERENCE_METADATA_UNAVAILABLE'],
 ['oversize',(f: Awaited<ReturnType<typeof fixture>>)=>f.store.put('assets',{...f.asset,sizeBytes:31*1024*1024}),'REFERENCE_TOO_LARGE'],
 ['unsupported image MIME',(f: Awaited<ReturnType<typeof fixture>>)=>f.store.put('assets',{...f.asset,mimeType:'image/gif'}),'UNSUPPORTED_REFERENCE_MIME'],
 ['oversize metadata row',(f: Awaited<ReturnType<typeof fixture>>)=>f.store.put('assets',{...f.asset,padding:'x'.repeat(66000)}),'INVALID_REFERENCE_METADATA'],
 ] as const) if(code)test(`new submit ${name} has no inserts or POST`,async t=>{
 const f=await fixture(t,{image:true});f.other=await foreignProject(t,'Other project');mutate!(f);
 await assert.rejects(f.submit(),{code});assert.equal(f.store.list('jobs').length,0);assert.equal(f.posts(),0);
});

test('relational owner and JSON owner must agree; no pruning or duplicate IDs',async t=>{
 const f=await fixture(t,{image:true});
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({...f.asset,id:randomUUID()}),f.asset.id);
 await assert.rejects(f.submit(),{code:'INVALID_REFERENCE_METADATA'});
 f.store.put('assets',f.asset);
 for(const ids of [[f.asset.id,f.asset.id],[f.asset.id,randomUUID()],Array.from({length:9},()=>randomUUID())]){
  f.store.put('shots',{...f.store.get('shots',f.shot.id),referenceAssetIds:ids});
  await assert.rejects(f.submit(),error=>['INVALID_REFERENCE_MANIFEST','NOT_FOUND'].includes((error as Failure).code));
 }
 assert.equal(f.store.list('jobs').length,0);assert.equal(f.posts(),0);
});

test('old error order: revision, disabled provider, legacy limits precede new profile checks',async t=>{
 const f=await fixture(t,{providerId:'ark',image:true});
 f.store.put('assets',{...f.asset,sizeBytes:undefined});
 await assert.rejects(f.submit({expectedRevision:2}),{code:'REVISION_CONFLICT'});
 f.providers.set('ark',{...f.providers.get('ark')!,capabilities:{...f.original!.capabilities,enabled:false}});
 await assert.rejects(f.submit(),{code:'PROVIDER_DISABLED'});
 f.providers.set('ark',f.original);f.store.put('shots',{...f.store.get('shots',f.shot.id),duration:2});
 await assert.rejects(f.submit(),{code:'UNSUPPORTED_PARAMETERS'});
 assert.equal(f.store.list('jobs').length,0);
});

test('request replay returns historical response before clock, reference and authorization drift',async t=>{
 const f=await fixture(t,{providerId:'veo',image:true}),job=await f.submit(),before=snapshotBytes(f.store,job.id);
 f.setDate('2026-10-22');f.store.db.prepare('DELETE FROM assets WHERE id=?').run(f.asset.id);
 f.store.put('shots',{...f.store.get('shots',f.shot.id),revision:99});
 assert.deepEqual(await f.submit(),job);assert.equal(snapshotBytes(f.store,job.id),before);
 await assert.rejects(f.submit({requestId:randomUUID()}),{code:'REVISION_CONFLICT'});
 assert.equal(f.store.list('jobs').length,1);assert.equal(f.posts(),0);
});

test('legacy failed retry resolves size from same owned asset without rewriting old snapshot',async t=>{
 const f=await fixture(t,{image:true}),job=await f.submit(),original=f.store.get('jobs',job.id)!;
 const snapshot=structuredClone(original.snapshot);for(const key of ['inputProfileVersion','inputProfileId','providerRegion','referenceBindings'])delete snapshot[key];
 delete snapshot.referenceAssets[0].sizeBytes;delete snapshot.capabilities.inputProfiles;delete snapshot.capabilities.inputProfileVersion;
 f.store.put('jobs',{...original,snapshot,status:'failed'});const before=snapshotBytes(f.store,job.id);
 const request={jobId:job.id,requestId:randomUUID()},retry=await f.services.call('job.retry',request);
 assert.equal(snapshotBytes(f.store,job.id),before);assert.equal(snapshotBytes(f.store,retry.id),before);
 f.store.db.prepare('DELETE FROM assets WHERE id=?').run(f.asset.id);assert.deepEqual(await f.services.call('job.retry',request),retry);
});

test('new retry checks frozen references, manifest and current lifecycle but preserves accepted job',async t=>{
 const f=await fixture(t,{providerId:'veo',image:true}),job=await f.submit();markFailed(f,job.id);const before=snapshotBytes(f.store,job.id);
 f.store.put('assets',{...f.asset,sha256:'b'.repeat(64)});
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'REFERENCE_CHANGED'});
 f.store.put('assets',f.asset);f.setDate('2026-10-22');
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'MODEL_LIFECYCLE_REVALIDATION_REQUIRED'});
 assert.equal(f.store.list('jobs').length,1);assert.equal(snapshotBytes(f.store,job.id),before);
});

for(const [name,alter,code] of [
 ['contradictory role',(s: { referenceBindings: { role: string; }[]; })=>s.referenceBindings[0].role='style_reference','INVALID_REFERENCE_MANIFEST'],
 ['partial manifest',(s: { referenceBindings: never[]; })=>s.referenceBindings=[],'INVALID_REFERENCE_MANIFEST'],
 ['missing pin',(s: { providerRegion: unknown; })=>delete s.providerRegion,'INVALID_REFERENCE_MANIFEST'],
 ['changed profile',(s: { inputProfileId: string; })=>s.inputProfileId='other','INVALID_REFERENCE_MANIFEST'],
 ['unlisted reference',(s: { referenceAssetIds: string[]; })=>s.referenceAssetIds.push(randomUUID()),'INVALID_REFERENCE_MANIFEST'],
 ['frozen mismatch',(s: { referenceAssets: { sha256: string; }[]; })=>s.referenceAssets[0].sha256='b'.repeat(64),'REFERENCE_CHANGED'],
 ] as const)test(`queued ${name} rejected before attempt or POST`,async t=>{
 const f=await fixture(t,{image:true}),job=await f.submit(),saved=f.store.get('jobs',job.id)!;(alter as unknown as (snapshot:typeof saved.snapshot)=>unknown)(saved.snapshot);f.store.put('jobs',saved);const before=snapshotBytes(f.store,job.id);
 await f.tick();await f.stop();const result=f.store.get('jobs',job.id)!;
 assert.equal(result.status,'failed');assert.equal(result.error!.code,code);assert.equal(result.submissionCount,0);assert.equal(f.posts(),0);assert.equal(snapshotBytes(f.store,job.id),before);
});

for(const drift of ['date','region','ownership'])test(`synchronous POST fence catches ${drift} after adapter preparation without counting dispatch`,async t=>{
 const providerId=drift==='region'?'minimax':'veo',f=await fixture(t,{providerId,image:true}),job=await f.submit();
 const provider=f.providers.get(providerId)!,submit=provider!.submit;
 f.providers.set(providerId,{...provider,submit:async(snapshot,context)=>{await Promise.resolve();if(drift==='date')f.setDate('2026-10-22');else if(drift==='region')f.providers.set(providerId,{...provider,capabilities:{...provider!.capabilities,region:'cn'}});else f.store.db.prepare('DELETE FROM assets WHERE id=?').run(f.asset.id);return submit(snapshot,context);}});
 await f.tick();await f.stop();const failed=f.store.get('jobs',job.id)!;
 assert.equal(failed.status,'failed');assert.equal(failed.phase,'input_preflight_failed');assert.equal(failed.submissionCount,0);assert.equal(f.posts(),0);
 assert.equal(failed.error!.code,drift==='date'?'MODEL_LIFECYCLE_REVALIDATION_REQUIRED':drift==='region'?'PROVIDER_REGION_CHANGED':'NOT_FOUND');
});

test('accepted reconciliation and polling are allowed after new-submission cutoff',async t=>{
 const f=await fixture(t,{providerId:'veo'}),job=await f.submit();await f.tick();assert.equal(f.posts(),1);
 f.setDate('2026-10-22');f.store.put('jobs',{...f.store.get('jobs',job.id),status:'submission_unknown',providerJobId:null,nextPollAt:0});
 await f.tick();assert.equal(f.store.get('jobs',job.id)!.status,'running');await f.tick();
 assert.equal(f.posts(),1);assert.equal(f.polls(),1);await f.stop();
});

test('registry wrappers and copied handles retain policy, unknown configured model fails closed',async t=>{
 const f=await fixture(t),original=f.providers.get('mock')!,wrapper=registerInputProfileWrapper({...original},f.original);assert.ok(usesInputProfiles(new Map([['mock',wrapper]])));
 f.providers.set('mock',{...original,capabilities:{...original!.capabilities,models:['unknown-configured-model']},validate:undefined});
 await assert.rejects(f.submit(),{code:'INPUT_PROFILE_UNAVAILABLE'});assert.equal(f.store.list('jobs').length,0);
});

test('trusted direct-factory embedding stays legacy; profiles require production registry ownership',async t=>{
 const f=await fixture(t),provider=createVeoProvider({root:f.root,env:f.env,fetchImpl:(()=>assert.fail('No network')) as unknown as typeof fetch});
 const embedded=new Map([['veo',provider]]),services=(createServices(f.store,(embedded as unknown as Parameters<typeof createServices>[1]),{env:f.env,profileNow:()=>Date.parse('2026-10-23')}) as TypedServices);
 assert.equal(usesInputProfiles(embedded),false);const caps=await services.call('provider.list',{});assert.equal(caps[0].inputProfiles,undefined);
 const job=await services.call('generation.submit',{...f.input,providerId:'veo'});assert.equal(job.status,'queued');assert.equal(job.snapshot.inputProfileVersion,undefined);
});

for(const frozen of ['legacy','pinned'])for(const [field,value,code] of [
 ['role','style_reference',frozen==='pinned'?'INVALID_REFERENCE_MANIFEST':'UNSUPPORTED_INPUT_ROLE'],
 ['role','unknown_role',frozen==='pinned'?'INVALID_REFERENCE_MANIFEST':'UNKNOWN_INPUT_ROLE'],
 ['durationSeconds',2,'UNSUPPORTED_REFERENCE_DURATION'],
 ['duration',2,'UNSUPPORTED_REFERENCE_DURATION'],
] as const)test(`${frozen} frozen explicit ${field}=${value} is never relabeled or dropped`,async t=>{
 const f=await fixture(t,{image:true}),job=await f.submit(),saved=f.store.get('jobs',job.id)!;saved.status='failed';
 if(frozen==='legacy')for(const key of ['inputProfileVersion','inputProfileId','providerRegion','referenceBindings'])delete saved.snapshot[key];
 (saved.snapshot.referenceAssets[0] as unknown as Record<string,unknown>)[field]=value;f.store.put('jobs',saved);const before=snapshotBytes(f.store,job.id);
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code});
 assert.equal(f.store.list('jobs').length,1);assert.equal(snapshotBytes(f.store,job.id),before);assert.equal(f.posts(),0);
});
for(const role of ['style_reference','unknown_role'])test(`managed asset explicit ${role} is not reinterpreted`,async t=>{
 const f=await fixture(t,{image:true});f.store.put('assets',{...f.asset,role});
 await assert.rejects(f.submit(),{code:role==='unknown_role'?'UNKNOWN_INPUT_ROLE':'UNSUPPORTED_INPUT_ROLE'});assert.equal(f.store.list('jobs').length,0);
});

const rawGenerationState=(f: Awaited<ReturnType<typeof fixture>>)=>({jobs:f.store.db.prepare('SELECT id,projectId,data FROM jobs ORDER BY id').all(),shots:f.store.db.prepare('SELECT id,projectId,data FROM shots ORDER BY id').all(),events:f.store.db.prepare('SELECT * FROM job_events ORDER BY id').all()});
for(const target of ['jobs','shots'])test(`POST fence leaves relational ${target} reassignment and events byte-identical`,async t=>{
 const f=await fixture(t,{providerId:'veo',image:true}),job=await f.submit(),other=await foreignProject(t,'Other owner');
 const provider=f.providers.get('veo')!,submit=provider!.submit;let afterTamper;
 const log=t.mock.method(console,'error',()=>{});
 f.providers.set('veo',{...provider,submit:async(snapshot,context)=>{await Promise.resolve();withoutForeignKeys(f.store.db,()=>f.store.db.prepare(`UPDATE ${target} SET projectId=? WHERE id=?`).run(other.id,target==='jobs'?job.id:f.shot.id));afterTamper=rawGenerationState(f);return submit(snapshot,context);}});
 await f.tick();await f.stop();assert.deepEqual(rawGenerationState(f),afterTamper);assert.equal(f.posts(),0);
 assert.deepEqual(log.mock.calls.map(call=>call.arguments),[['Skipped invalid local generation record.']]);
});

test('explicit copied Map wrappers and recreated registry on worker restart retain lifecycle gate',async t=>{
 const f=await fixture(t,{providerId:'veo'}),copied=new Map([...f.providers].map(([id,provider])=>[id,registerInputProfileWrapper({...provider},id==='veo'?f.original:provider)]));
 const wrapped=(createServices(f.store,copied,{env:f.env,profileNow:()=>Date.parse('2026-10-22')}) as TypedServices);
 await assert.rejects(wrapped.call('generation.submit',f.input),{code:'MODEL_LIFECYCLE_REVALIDATION_REQUIRED'});
 const job=await f.submit();const fresh=createProviderRegistry({db:f.store.db,root:f.root,env:f.env}),services=(createServices(f.store,fresh,{env:f.env,profileNow:()=>Date.parse('2026-10-22')}) as TypedServices);
 let posts=0;fresh.set('veo',{...fresh.get('veo')!,submit:async()=>{posts++;throw Error('Unexpected dispatch');}});
 const worker=startWorker(f.store,services,fresh);await worker.tick();await worker.stop();
 assert.equal(f.store.get('jobs',job.id)!.error!.code,'MODEL_LIFECYCLE_REVALIDATION_REQUIRED');assert.equal(f.store.get('jobs',job.id)!.submissionCount,0);assert.equal(posts,0);
});

test('unknown configured model is rejected at queued dispatch',async t=>{
 const f=await fixture(t,{providerId:'minimax'}),job=await f.submit(),provider=f.providers.get('minimax')!;
 f.providers.set('minimax',{...provider,capabilities:{...provider!.capabilities,models:['unknown-model']}});
 await f.tick();await f.stop();assert.equal(f.store.get('jobs',job.id)!.error!.code,'UNSUPPORTED_MODEL');assert.equal(f.posts(),0);
});

test('private fence abort and post-dispatch uncertainty retain existing request semantics',async()=>{
 let posts=0,callbacks=0;const controller=new AbortController();
 const request=createJsonRequest({api:'https://offline.invalid',headers:{},ensureEnabled:()=>{},name:'Offline',fetchImpl:(async()=>{posts++;throw Error('Synthetic lost response');}) as unknown as typeof fetch});
 await assert.rejects(request('/generate',{method:'POST',context:{signal:controller.signal,beforeSubmit:()=>{callbacks++;controller.abort();}}}),error=>(error as Error&{beforeDispatch?:boolean}).beforeDispatch===true&&!(error as Error&{uncertain?:boolean}).uncertain);
 assert.equal(posts,0);assert.equal(callbacks,1);
 await assert.rejects(request('/generate',{method:'POST',context:{beforeSubmit:()=>{callbacks++;}}}),error=>(error as Error&{uncertain?:boolean}).uncertain===true&&(error as Failure).code==='SUBMISSION_UNKNOWN');
 assert.equal(posts,1);assert.equal(callbacks,2);
});

test('local cancellation during adapter preparation preserves cancellation without POST',async t=>{
 const f=await fixture(t,{providerId:'veo'}),job=await f.submit(),provider=f.providers.get('veo')!,submit=provider!.submit;
 f.providers.set('veo',{...provider,submit:async(snapshot,context)=>{await f.services.call('job.cancel',{jobId:job.id});return submit(snapshot,context);}});
 await f.tick();await f.stop();const cancelled=f.store.get('jobs',job.id)!;
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.error!.code,'LOCAL_WAIT_STOPPED');assert.equal(f.posts(),0);
 // Preserve historical attempt accounting when cancellation advances revision.
 // Actual external POST counts are audited independently above.
 assert.equal(cancelled.submissionCount,1);
});

for(const providerId of ['minimax','vidu'])test(`${providerId} invalid server-configured region advertises no exact profile and cannot insert or POST`,async t=>{
 const f=await fixture(t),prefix=providerId.toUpperCase(),env={...f.env,[`${prefix}_API_KEY`]:'inert-fixture',[`${prefix}_REGION`]:'unrecognized-region',VIDU_OUTPUT_HOSTS:'cdn.synthetic.invalid'};
 const registry=createProviderRegistry({db:f.store.db,root:f.root,env});let posts=0;
 const provider=registry.get(providerId)!;registry.set(providerId,{...provider,submit:async()=>{posts++;throw Error('Invalid region must never dispatch');}});
 const services=(createServices(f.store,registry,{env}) as TypedServices),capabilities=(await services.call('provider.list',{})).find((item: { id: string; })=>item.id===providerId);
 assert.equal((capabilities as typeof capabilities&{region:string}).region,'invalid');assert.equal(capabilities!.providerRegion,'invalid');assert.equal(capabilities!.configured,false);assert.equal(capabilities!.enabled,false);
 assert.deepEqual((capabilities!.inputProfiles as unknown),[]);assert.deepEqual((capabilities!.inputProfileEvaluations as unknown),[]);
 await assert.rejects(services.call('generation.submit',{...f.input,providerId}),{code:'PROVIDER_DISABLED'});
 assert.equal(f.store.list('jobs').length,0);assert.equal(posts,0);
});

for(const status of ['queued','submitting'])for(const drift of ['relational-owner','json-owner','shot-owner'])test(`${status} startup ${drift} rejection leaves raw jobs and events unchanged`,async t=>{
 const f=await fixture(t,{providerId:'veo',image:true}),job=await f.submit(),other=await foreignProject(t,'Unrelated owner');
 const saved=f.store.get('jobs',job.id)!;saved.status=status;f.store.put('jobs',saved);
 if(drift==='relational-owner')withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE jobs SET projectId=? WHERE id=?').run(other.id,job.id));
 else if(drift==='json-owner')f.store.put('jobs',{...saved,projectId:other.id});
 else withoutForeignKeys(f.store.db,()=>f.store.db.prepare('UPDATE shots SET projectId=? WHERE id=?').run(other.id,f.shot.id));
 const before=rawGenerationState(f),log=t.mock.method(console,'error',()=>{});
 await f.tick();await f.tick();await f.stop();assert.deepEqual(rawGenerationState(f),before);assert.equal(f.posts(),0);
 assert.deepEqual(log.mock.calls.map(call=>call.arguments),[['Skipped invalid local generation record.']]);
});
for(const drift of ['deleted-job','json-identity','snapshot','revision','coherent-reassignment'])test(`deferred ${drift} cannot authorize preflight-failure persistence`,async t=>{
 const f=await fixture(t,{providerId:'veo',image:true}),job=await f.submit(),other=await foreignProject(t,'Other owner');
 const provider=f.providers.get('veo')!,submit=provider!.submit;let afterTamper;
 const log=t.mock.method(console,'error',()=>{});
 f.providers.set('veo',{...provider,submit:async(snapshot,context)=>{
  await Promise.resolve();const saved=f.store.get('jobs',job.id)!;
  if(drift==='deleted-job')f.store.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
  else if(drift==='json-identity')f.store.put('jobs',{...saved,requestId:randomUUID()});
  else if(drift==='snapshot')f.store.put('jobs',{...saved,snapshot:{...saved.snapshot,prompt:'Different frozen request'}});
  else if(drift==='revision')f.store.put('jobs',{...saved,revision:saved.revision+1});
  else {
   for(const [table,id] of [['jobs',job.id],['shots',f.shot.id],['assets',f.asset.id]] as const){
    f.store.put(table,{...f.store.get(table,id),projectId:other.id});withoutForeignKeys(f.store.db,()=>f.store.db.prepare(`UPDATE ${table} SET projectId=? WHERE id=?`).run(other.id,id));
   }
  }
  afterTamper=rawGenerationState(f);return submit(snapshot,context);
 }});
 await f.tick();await f.stop();assert.deepEqual(rawGenerationState(f),afterTamper);assert.equal(f.posts(),0);
 assert.deepEqual(log.mock.calls.map(call=>call.arguments),[['Skipped invalid local generation record.']]);
});


test('registration and metadata-only initialization trigger no unknown provider Proxy traps',async t=>{
 const f=await fixture(t),counts={get:0,getOwnPropertyDescriptor:0,getPrototypeOf:0,ownKeys:0};
 const traps=Object.fromEntries(Object.keys(counts).map(name=>[name,()=>{counts[(name as keyof typeof counts)]++;throw Error(`Forbidden ${name} trap`);} ]));
 const provider=new Proxy({},traps),mapProxy=new Proxy(new Map(),traps);
 assert.equal(usesInputProfiles(provider),false);assert.equal(usesInputProfiles(mapProxy),false);
 assert.equal(usesInputProfiles(new Map([['mock',provider]])),false);
 const services=(createServices(f.store,(new Map([['mock',provider]]) as unknown as Parameters<typeof createServices>[1])) as TypedServices);
 assert.equal((await services.call('project.inspect',{projectId:f.project.id})).id,f.project.id);
 assert.throws(()=>registerInputProfileWrapper({},provider),TypeError);
 assert.deepEqual(counts,{get:0,getOwnPropertyDescriptor:0,getPrototypeOf:0,ownKeys:0});
});

test('opaque registration cannot be copied or disabled through serialized capability fields',async t=>{
 const f=await fixture(t,{providerId:'veo'}),caps=(await f.services.call('provider.list',{})).find((provider: { id: string; })=>provider.id==='veo');
 const serialized=JSON.parse(JSON.stringify(caps)),unregistered={id:'veo',capabilities:serialized,submit:f.original!.submit};
 assert.equal(usesInputProfiles(serialized),false);assert.equal(usesInputProfiles(unregistered),false);assert.equal(usesInputProfiles(new Map([['veo',unregistered]])),false);
 assert.throws(()=>registerInputProfileWrapper({},unregistered),TypeError);
 assert.equal(usesInputProfiles(new Map([['veo',f.original]])),true);
 // The registered Map remains authoritative even if its handle is replaced by
 // an unregistered server wrapper and serialized flags claim no profile policy.
 f.providers.set('veo',{...f.providers.get('veo')!,capabilities:{...f.original!.capabilities,inputProfiles:[],inputProfileVersion:null,usesInputProfiles:false}});
 f.setDate('2026-10-22');assert.equal(usesInputProfiles(f.providers),true);
 await assert.rejects(f.submit(),{code:'MODEL_LIFECYCLE_REVALIDATION_REQUIRED'});assert.equal(f.store.list('jobs').length,0);assert.equal(f.posts(),0);
});


test('only registered enforcement publishes canonical reserved profile discovery fields',async t=>{
 const f=await fixture(t,{providerId:'veo'}),canonical=(await f.services.call('provider.list',{})).find((provider: { id: string; })=>provider.id==='veo');
 const reserved=['inputProfiles','inputProfileVersion','providerRegion','profileEvaluationDate','inputProfileEvaluations'];
 const copied=JSON.parse(JSON.stringify(canonical)),injected={id:'veo',capabilities:copied,submit:f.original!.submit};
 const unregistered=new Map([['veo',injected]]),embedded=(createServices(f.store,(unregistered as unknown as Parameters<typeof createServices>[1]),{env:f.env}) as TypedServices);
 for(const output of [normalizedCapabilities((injected as unknown as Parameters<typeof normalizedCapabilities>[0]),f.env),(await embedded.call('provider.list',{}))[0]]){
  for(const key of reserved)assert.equal(Object.hasOwn(output,key),false,`${key} must not claim enforcement`);
  assert.equal(output.id,'veo');assert.deepEqual((output as unknown as {models:unknown}).models,canonical!.models);assert.equal(output.configured,true);
 }
 const spoofed={...copied,inputProfiles:[{profileId:'untrusted-profile'}],inputProfileVersion:'untrusted-version',providerRegion:'wrong-region',profileEvaluationDate:'1900-01-01',inputProfileEvaluations:[{ok:true}]};
 f.providers.set('veo',({...injected,capabilities:spoofed} as unknown as Provider));
 const registered=(await f.services.call('provider.list',{})).find((provider: { id: string; })=>provider.id==='veo');
 for(const key of reserved)assert.deepEqual(registered![(key as "id"|"inputModes"|"modelCapabilities"|"configured"|"enabled"|"status"|"liveVerified"|"configuration"|"inputProfileVersion"|"profileEvaluationDate"|"providerRegion"|"inputProfiles"|"inputProfileEvaluations"|"models"|"mock")],canonical![(key as "id"|"inputModes"|"modelCapabilities"|"configured"|"enabled"|"status"|"liveVerified"|"configuration"|"inputProfileVersion"|"profileEvaluationDate"|"providerRegion"|"inputProfiles"|"inputProfileEvaluations"|"models"|"mock")],`${key} must be canonical`);
 assert.equal(f.posts(),0);assert.equal(f.store.list('jobs').length,0);
});


test('archived v1 queued unsupported role retains semantic rejection without dispatch',async t=>{
 const f=await fixture(t,{image:true}),job=await f.submit(),saved=f.store.get('jobs',job.id)!,profile=getLegacyCapabilityProfile('mock','mock-motion-v1','local');
 saved.snapshot.inputProfileId=profile!.profileId;saved.snapshot.inputProfileVersion=profile!.profileVersion;delete saved.snapshot.referenceAssets[0].role;saved.snapshot.referenceBindings![0].role='style_reference';f.store.put('jobs',saved);const before=snapshotBytes(f.store,job.id);
 await f.tick();await f.stop();const failed=f.store.get('jobs',job.id)!;assert.equal(failed.error!.code,'UNSUPPORTED_INPUT_ROLE');assert.equal(failed.submissionCount,0);assert.equal(snapshotBytes(f.store,job.id),before);assert.equal(f.posts(),0);
});
