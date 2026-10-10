import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/db.mjs';
import {createServices} from '../packages/business/src/services.mjs';
import {createProviderRegistry,normalizedCapabilities,generationLimit,providerEnvironmentKeys} from '../packages/business/src/provider-registry.mjs';
import {getGenerationIssue,findModelCapabilities} from '../packages/contracts/src/index.mjs';
import {utilityEnvironment} from '../apps/desktop/src/config.mjs';

async function fixture(t,env={}){
 const root=await mkdtemp(path.join(tmpdir(),'wb-v4-caps-')),store=openStore(root);
 const providers=createProviderRegistry({db:store.db,root,env}),services=createServices(store,providers,{env});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const project=await services.call('project.create',{name:'V4 isolated model contracts'});
 return {store,providers,services,project,
  shot:input=>services.call('shot.create',{projectId:project.id,title:'Synthetic test',prompt:'Original geometric shapes moving gently',...input}),
  submit:shot=>services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'ark'}),
 };
}
const env={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'synthetic-not-a-real-credential',GEMINI_API_KEY:'synthetic-not-a-real-google-key',ARK_MAX_GENERATIONS:'2',VEO_MAX_GENERATIONS:'2'};

test('provider registry exposes model-specific safe readiness without credential values',async t=>{
 const f=await fixture(t),caps=await f.services.call('provider.list',{});
 assert.ok(['mock','runway','ark','veo','minimax','vidu'].every(id=>caps.some(c=>c.id===id)));
 assert.equal(caps.find(c=>c.id==='mock').status,'available');
 for(const c of caps.filter(c=>!c.mock)){assert.equal(c.status,'not_configured');assert.equal(c.liveVerified,false);assert.equal(c.enabled,false);assert.ok(c.modelCapabilities.length);assert.ok(c.configuration.missing.length);}
 const live=createProviderRegistry({db:f.store.db,root:f.store.root,env});
 const enabled=normalizedCapabilities(live.get('ark'),env,0);assert.equal(enabled.status,'available');assert.equal(enabled.budget.remainingGenerations,2);
 assert.equal(normalizedCapabilities(live.get('ark'),env,2).status,'disabled');
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
 const c=normalizedCapabilities(f.providers.get('ark'),env);
 assert.equal(getGenerationIssue({...shot,model:c.models[0],referenceAssets:[asset]},c).code,'UNSUPPORTED_INPUT');
 shot=await f.services.call('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{aspectRatio:'9:16'}});
 const job=await f.submit(shot);assert.equal(job.status,'queued');assert.equal(job.submissionCount,0);
 assert.equal(job.snapshot.referenceAssets[0].width,360);assert.equal(job.snapshot.referenceAssets[0].height,640);
 assert.ok(!JSON.stringify(job).includes('relativePath'));
});

test('text input queues with zero references and local count cap deduplicates before exhaustion',async t=>{
 const f=await fixture(t,{...env,ARK_MAX_GENERATIONS:'1'}),shot=await f.shot({duration:4,referenceAssetIds:[]});
 const input={shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'ark'};
 const first=await f.services.call('generation.submit',input);
 assert.equal(first.snapshot.referenceAssets.length,0);assert.equal(first.submissionCount,0);
 assert.equal((await f.services.call('generation.submit',input)).id,first.id);
 await assert.rejects(f.services.call('generation.submit',{...input,requestId:randomUUID()}),{code:'LIVE_BUDGET_REQUIRED'});
 assert.equal(f.store.list('jobs').length,1);
 const caps=await f.services.call('provider.list',{});assert.equal(caps.find(c=>c.id==='ark').status,'disabled');
});

test('budget parser rejects malformed limits and desktop allowlist carries only provider settings',()=>{
 for(const value of ['-1','NaN','1.5','Infinity','1e3','0','9007199254740992'])assert.equal(generationLimit('ark',{ARK_MAX_GENERATIONS:value}),0);
 assert.equal(generationLimit('ark',{ARK_MAX_GENERATIONS:'3'}),3);
 const source=Object.fromEntries(providerEnvironmentKeys.map(k=>[k,'test-value']));
 const forwarded=utilityEnvironment({...source,NODE_OPTIONS:'bad',UNRELATED_API_KEY:'not-forwarded'}, {ffmpeg:'/bin/ffmpeg',ffprobe:'/bin/ffprobe'});
 for(const key of providerEnvironmentKeys)assert.equal(forwarded[key],'test-value');
 assert.equal(forwarded.NODE_OPTIONS,undefined);assert.equal(forwarded.UNRELATED_API_KEY,undefined);
});

test('unknown model never falls back and provider-specific seed is rejected',async t=>{
 const f=await fixture(t,env),caps=await f.services.call('provider.list',{}),veo=caps.find(c=>c.id==='veo');
 assert.equal(findModelCapabilities(veo,'retired-model'),null);
 assert.equal(getGenerationIssue({model:'retired-model'},veo).code,'UNSUPPORTED_MODEL');
 assert.equal(getGenerationIssue({model:veo.models[0],duration:4,aspectRatio:'9:16',prompt:'Geometric shapes',referenceAssets:[],parameters:{seed:2}},veo).code,'UNSUPPORTED_PARAMETER');
});


test('every advertised provider ratio is representable in the shared shot schema',async t=>{
 const f=await fixture(t),caps=await f.services.call('provider.list',{});
 for(const ratio of new Set(caps.flatMap(provider=>provider.modelCapabilities.flatMap(model=>model.aspectRatios)))){
  const shot=await f.shot({aspectRatio:ratio});assert.equal(shot.aspectRatio,ratio);
 }
});


test('manual reconciliation and explicit retry preserve the original regional account boundary',async t=>{
 const f=await fixture(t,{MIOON_ENABLE_LIVE_PROVIDER:'1',MINIMAX_API_KEY:'synthetic-fixture-only',MINIMAX_MAX_GENERATIONS:'2',MINIMAX_REGION:'global'});
 const shot=await f.shot({duration:4});
 const job=await f.services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'minimax'});
 const original=f.providers.get('minimax');let seen;
 f.providers.set('minimax',{...original,capabilities:{...original.capabilities,region:'cn'},poll:async(id,context)=>{seen=context;throw Object.assign(Error('Restore the original provider region'),{code:'PROVIDER_REGION_CHANGED'});}});
 f.store.put('jobs',{...f.store.get('jobs',job.id),status:'cancelled',providerJobId:'known-regional-task'});
 await assert.rejects(f.services.call('job.reconcile',{jobId:job.id}),{code:'PROVIDER_REGION_CHANGED'});
 assert.equal(seen,undefined);
 f.providers.set('minimax',{...original,poll:async(id,context)=>{seen=context;return {status:'running'};}});
 await f.services.call('job.reconcile',{jobId:job.id});assert.equal(seen.providerRegion,'global');
 f.providers.set('minimax',{...original,capabilities:{...original.capabilities,region:'cn'}});
 f.store.put('jobs',{...f.store.get('jobs',job.id),status:'failed'});
 await assert.rejects(f.services.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'PROVIDER_REGION_CHANGED'});
 assert.equal(f.store.list('jobs').length,1);
});
