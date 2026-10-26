import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry,normalizedCapabilities,providerEnvironmentKeys} from '../packages/business/src/provider-registry.ts';
import {getGenerationIssue,findModelCapabilities} from '../packages/contracts/src/index.ts';
import {utilityEnvironment} from '../apps/desktop/src/config.ts';

async function fixture(t: test.TestContext,env={}){
 const root=await mkdtemp(path.join(tmpdir(),'wb-v4-caps-')),store=(openStore(root) as TypedStore);
 const providers=createProviderRegistry({db:store.db,root,env}),services=(createServices(store,providers,{env}) as TypedServices);
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const project=await services.call('project.create',{name:'V4 isolated model contracts'});
 return {store,providers,services,project,
  shot:(input: Record<string, unknown>)=>services.call('shot.create',{projectId:project.id,title:'Synthetic test',prompt:'Original geometric shapes moving gently',...input}),
  submit:(shot: { id: unknown; revision: unknown; })=>services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'ark'}),
 };
}
const env={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'synthetic-not-a-real-credential',GEMINI_API_KEY:'synthetic-not-a-real-google-key'};

test('provider registry exposes model-specific safe readiness without credential values',async t=>{
 const f=await fixture(t),caps=await f.services.call('provider.list',{});
 assert.ok(['mock','runway','ark','veo','minimax','vidu'].every(id=>caps.some((c: { id: string; })=>c.id===id)));
 assert.equal(caps.find((c: { id: string; })=>c.id==='mock')!.status,'available');
 for(const c of caps.filter((c)=>!c.mock)){assert.equal(c.status,'not_configured');assert.equal(c.liveVerified,false);assert.equal(c.enabled,false);assert.ok(c.modelCapabilities.length);assert.ok(c.configuration.missing.length);}
 const live=createProviderRegistry({db:f.store.db,root:f.store.root,env});
 const enabled=normalizedCapabilities((live.get('ark')! as unknown as Parameters<typeof normalizedCapabilities>[0]),env,0);assert.equal(enabled.status,'available');
 assert.equal(normalizedCapabilities((live.get('ark')! as unknown as Parameters<typeof normalizedCapabilities>[0]),env,Number.MAX_SAFE_INTEGER).status,'available');
 assert.equal(Object.hasOwn(enabled,'budget'),false);
 assert.doesNotMatch(JSON.stringify(caps),/MAX_GENERATIONS|maxGenerations|usedGenerations|remainingGenerations/);
 assert.ok(!JSON.stringify(enabled).includes(env.ARK_API_KEY));assert.ok(!JSON.stringify(caps).includes('apiKey'));
});

test('unsupported duration, reference mode and parameters fail before any job exists',async t=>{
 const f=await fixture(t,env);
 const shot=await f.shot({duration:2,referenceAssetIds:[]});
 await assert.rejects(f.submit(shot),{code:'UNSUPPORTED_PARAMETERS'});
 const updated=await f.services.call('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{duration:4,parameters:{seed:1}}});
 await assert.rejects(f.submit(updated),{code:'UNSUPPORTED_PARAMETER'});
 assert.equal(f.store.list('jobs').length,0);
});

test('Seedance first-frame ratio validation is shared and snapshots retain immutable dimensions',async t=>{
 const f=await fixture(t,env);
 const asset={id:randomUUID(),projectId:f.project.id,mimeType:'image/png',sha256:'a'.repeat(64),relativePath:'media/synthetic.png',sizeBytes:1024,width:360,height:640};
 f.store.put('assets',asset);
 let shot=await f.shot({duration:4,referenceAssetIds:[asset.id],aspectRatio:'16:9'});
 await assert.rejects(f.submit(shot),{code:'UNSUPPORTED_INPUT'});
 const c=normalizedCapabilities((f.providers.get('ark')! as unknown as Parameters<typeof normalizedCapabilities>[0]),env);
 assert.equal(getGenerationIssue({...shot,model:(c as typeof c & {models:string[]}).models[0],referenceAssets:[asset]},c)!.code,'UNSUPPORTED_INPUT');
 shot=await f.services.call('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{aspectRatio:'9:16'}});
 const job=await f.submit(shot);assert.equal(job.status,'queued');assert.equal(job.submissionCount,0);
 assert.equal(job.snapshot.referenceAssets[0].width,360);assert.equal(job.snapshot.referenceAssets[0].height,640);
 assert.ok(!JSON.stringify(job).includes('relativePath'));
});

test('text input has no generation count limit and exact requests still deduplicate',async t=>{
 const f=await fixture(t,{...env,ARK_MAX_GENERATIONS:'1'}),shot=await f.shot({duration:4,referenceAssetIds:[]});
 const input={shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'ark'};
 const first=await f.services.call('generation.submit',input);
 assert.equal(first.snapshot.referenceAssets.length,0);assert.equal(first.submissionCount,0);
 assert.equal((await f.services.call('generation.submit',input)).id,first.id);
 const second=await f.services.call('generation.submit',{...input,requestId:randomUUID()});
 assert.notEqual(second.id,first.id);
 assert.equal(f.store.list('jobs').length,2);
 const caps=await f.services.call('provider.list',{});assert.equal(caps.find((c: { id: string; })=>c.id==='ark')!.status,'available');
 assert.doesNotMatch(JSON.stringify(caps),/MAX_GENERATIONS|maxGenerations|usedGenerations|remainingGenerations/);
});

test('obsolete count settings do not affect readiness and are excluded from the desktop allowlist',()=>{
 for(const value of ['', '-1','NaN','1.5','Infinity','1e3','0','1','9007199254740992']){
  const configuration={...env,ARK_MAX_GENERATIONS:value};
  const capabilities={configured:true,enabled:true,models:['offline'],aspectRatios:['9:16'],durations:[4]};
  const result=normalizedCapabilities(({id:'ark',capabilities} as unknown as Parameters<typeof normalizedCapabilities>[0]),configuration,Number.MAX_SAFE_INTEGER);
  assert.equal(result.status,'available');assert.equal(Object.hasOwn(result,'budget'),false);
  assert.doesNotMatch(JSON.stringify(result),/MAX_GENERATIONS/);
 }
 const source=Object.fromEntries(providerEnvironmentKeys.map(k=>[k,'test-value']));
 const forwarded=utilityEnvironment({...source,ARK_MAX_GENERATIONS:'1',NODE_OPTIONS:'bad',UNRELATED_API_KEY:'not-forwarded'}, {ffmpeg:'/bin/ffmpeg',ffprobe:'/bin/ffprobe'});
 for(const key of providerEnvironmentKeys)assert.equal(forwarded[key],'test-value');
 assert.ok(!providerEnvironmentKeys.some(key=>key.endsWith('_MAX_GENERATIONS')));
 assert.equal(forwarded.ARK_MAX_GENERATIONS,undefined);
 assert.equal(forwarded.NODE_OPTIONS,undefined);assert.equal(forwarded.UNRELATED_API_KEY,undefined);
});

test('removing the count cap retains the explicit live switch and credential gates',async t=>{
 for(const configuration of [{},{MIOON_ENABLE_LIVE_PROVIDER:'1'},{ARK_API_KEY:'inert-offline-key',ARK_MAX_GENERATIONS:'999'}]){
  const f=await fixture(t,configuration),shot=await f.shot({duration:4,referenceAssetIds:[]});
  await assert.rejects(f.submit(shot),{code:'PROVIDER_DISABLED'});
  assert.equal(f.store.list('jobs').length,0);
 }
});

test('reopening a workspace retains unlimited admission, exact request replay and unknown-result protection',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-unlimited-generation-'));
 let store=(openStore(root) as TypedStore),calls=0;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const configuration={...env,ARK_MAX_GENERATIONS:'0'};
 const create=()=>{
  const providers=createProviderRegistry({db:store.db,root,env:configuration});
  const original=providers.get('ark')!;
  providers.set('ark',{...original,reconcile:async requestId=>{calls++;assert.equal(requestId,input.requestId);return null;}});
  return (createServices(store,providers,{env:configuration}) as TypedServices);
 };
 let services=create();
 const project=await services.call('project.create',{name:'No count limit after restart'});
 const shot=await services.call('shot.create',{projectId:project.id,title:'Offline only',prompt:'Synthetic shapes',duration:4});
 const input={shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'ark'};
 const accepted=await services.call('generation.submit',input);
 store.put('jobs',{...store.get('jobs',accepted.id),status:'submission_unknown'});
 await services.drain();store.close();store=(openStore(root) as TypedStore);services=create();
 assert.equal((await services.call('generation.submit',input)).id,accepted.id);
 assert.equal((await services.call('job.reconcile',{jobId:accepted.id})).status,'submission_unknown');
 assert.equal(calls,1);
 await assert.rejects(services.call('job.retry',{jobId:accepted.id,requestId:randomUUID()}),{code:'UNSAFE_RETRY'});
 assert.equal(store.list('jobs').length,1);
 const next=await services.call('generation.submit',{...input,requestId:randomUUID()});
 assert.notEqual(next.id,accepted.id);assert.equal(calls,1);
 await services.drain();
});

test('unknown model never falls back and provider-specific seed is rejected',async t=>{
 const f=await fixture(t,env),caps=await f.services.call('provider.list',{}),veo=caps.find((c: { id: string; })=>c.id==='veo');
 assert.equal(findModelCapabilities(veo,'retired-model'),null);
 assert.equal(getGenerationIssue({model:'retired-model'},veo)!.code,'UNSUPPORTED_MODEL');
 assert.equal(getGenerationIssue({model:veo!.models[0],duration:4,aspectRatio:'9:16',prompt:'Geometric shapes',referenceAssets:[],parameters:{seed:2}},veo)!.code,'UNSUPPORTED_PARAMETER');
});


test('every advertised provider ratio is representable in the shared shot schema',async t=>{
 const f=await fixture(t),caps=await f.services.call('provider.list',{});
 for(const ratio of new Set(caps.flatMap((provider)=>provider.modelCapabilities.flatMap((model)=>model.aspectRatios)))){
  const shot=await f.shot({aspectRatio:ratio});assert.equal(shot.aspectRatio,ratio);
 }
});


test('manual reconciliation and explicit retry preserve the original regional account boundary',async t=>{
 const f=await fixture(t,{MIOON_ENABLE_LIVE_PROVIDER:'1',MINIMAX_API_KEY:'synthetic-fixture-only',MINIMAX_REGION:'global'});
 const shot=await f.shot({duration:4});
 const job=await f.services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'minimax'});
 const original=f.providers.get('minimax')!;let seen;
 f.providers.set('minimax',{...original,capabilities:{...original!.capabilities,region:'cn'},poll:async(id,context)=>{seen=context;throw Object.assign(Error('Restore the original provider region'),{code:'PROVIDER_REGION_CHANGED'});}});
 f.store.put('jobs',{...f.store.get('jobs',job.id),status:'cancelled',providerJobId:'known-regional-task'});
 await assert.rejects(f.services.call('job.reconcile',{jobId:job.id}),{code:'PROVIDER_REGION_CHANGED'});
 assert.equal(seen,undefined);
 f.providers.set('minimax',{...original,poll:async(id,context)=>{seen=context;return {status:'running'};}});
 await f.services.call('job.reconcile',{jobId:job.id});assert.equal(seen!.providerRegion,'global');
 f.providers.set('minimax',{...original,capabilities:{...original!.capabilities,region:'cn'}});
 f.store.put('jobs',{...f.store.get('jobs',job.id),status:'failed'});
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'PROVIDER_REGION_CHANGED'});
 assert.equal(f.store.list('jobs').length,1);
});
