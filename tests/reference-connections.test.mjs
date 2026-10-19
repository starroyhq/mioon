import test from 'node:test';
import {openLegacyWorkspaceStore} from './helpers/legacy-workspace-store.mjs';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {crc32, deflateSync} from 'node:zlib';
import {Worker} from 'node:worker_threads';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createArkProvider} from '../packages/business/src/providers/ark.ts';

// All inputs are locally constructed pixels; no original media or live providers.
function png(width=36,height=64,color=85) {
 const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc32(body));return Buffer.concat([head,body,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc((width*3+1)*height,color);for(let y=0;y<height;y++)pixels[y*(width*3+1)]=0;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
const clone=value=>JSON.parse(JSON.stringify(value));
async function fixture(t,env={},{open=openStore}={}) {
 const root=await mkdtemp(path.join(tmpdir(),'wb-reference-'));
 let store,services,providers;
 const start=(openStoreForStart=openStore)=>{store=openStoreForStart(root);providers=createProviderRegistry({db:store.db,root,env});services=createServices(store,providers,{env});};start(open);
 const f={root,get store(){return store;},get services(){return services;},get providers(){return providers;},call:(op,input)=>services.call(op,input),restart(){store.close();start();},
  state(){return Object.fromEntries(['projects','assets','shots','nodes','edges','jobs','versions','exports'].map(table=>[table,clone(store.list(table))]));},
  async image(projectId=this.projectId,color=85,width=36,height=64){const asset=await this.call('asset.import',{projectId,name:'Synthetic local reference.png',mimeType:'image/png',dataBase64:png(width,height,color).toString('base64')});const node=await this.call('node.create',{projectId,type:'image',assetId:asset.id,label:'Synthetic reference',position:{x:100,y:100}});return {asset,node};},
  shot(projectId=this.projectId,extra={}){return this.call('shot.create',{projectId,title:'Reference target',prompt:'Synthetic shapes move gently',...extra});}
 };
 f.projectId=(await f.call('project.create',{name:t.name})).id;
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return f;
}
const attach=(f,node,shot,extra={})=>({projectId:f.projectId,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,requestId:randomUUID(),role:'first_frame',...extra});
const detach=(f,edge,shot,extra={})=>({projectId:f.projectId,edgeId:edge.id,expectedShotRevision:shot.revision,requestId:randomUUID(),...extra});
async function rejectsUnchanged(f,op,input,code) {
 const before=f.state();await assert.rejects(f.call(op,input),error=>{assert.ok(error.code&&error.code!=='UNKNOWN_OPERATION'&&error.code!=='INTERNAL_ERROR',String(error));if(code)assert.equal(error.code,code);return true;});assert.deepEqual(f.state(),before,`${op} rejection must be atomic`);
}

test('reference attach binds one managed image and detach removes only its owned reference',async t=>{
 const f=await fixture(t),{asset,node}=await f.image(),shot=await f.shot(),outside=f.state();
 const result=await f.call('reference.attach',attach(f,node,shot));
 assert.deepEqual(Object.keys(result).sort(),['edge','shot']);
 assert.equal(result.edge.kind,'reference');assert.equal(result.edge.role,'first_frame');assert.equal(result.edge.source,node.id);assert.equal(result.edge.target,shot.id);assert.equal(result.edge.sourceAssetId,asset.id);assert.equal(result.edge.projectId,f.projectId);
 assert.deepEqual(result.shot.referenceAssetIds,[asset.id]);assert.equal(result.shot.revision,shot.revision+1);
 assert.deepEqual(f.store.get('nodes',node.id),outside.nodes[0]);assert.deepEqual(f.state().assets,outside.assets);
 const released=await f.call('reference.detach',detach(f,result.edge,result.shot));
 assert.equal(released.detached,true);assert.deepEqual(released.edge,result.edge);assert.equal(released.shot.revision,result.shot.revision+1);assert.deepEqual(released.shot.referenceAssetIds,[]);
 assert.equal(f.store.list('edges').length,0);assert.deepEqual(f.state().assets,outside.assets);assert.deepEqual(f.state().nodes,outside.nodes);
 assert.equal(createHash('sha256').update(await readFile(path.join(f.root,f.store.get('assets',asset.id).relativePath))).digest('hex'),asset.sha256);
});

test('exact reference request responses survive detach, new bindings and store restart',async t=>{
 const f=await fixture(t),first=await f.image(),second=await f.image(f.projectId,140),shot=await f.shot();
 const addInput=attach(f,first.node,shot),added=await f.call('reference.attach',addInput);
 const noOpInput=attach(f,first.node,added.shot),before=f.state(),same=await f.call('reference.attach',noOpInput);
 assert.deepEqual(same,added);assert.deepEqual(f.state(),before,'Fresh repeated attach must not increment the revision or create an edge');
 const removeInput=detach(f,added.edge,added.shot),removed=await f.call('reference.detach',removeInput);
 const next=await f.call('reference.attach',attach(f,second.node,removed.shot)),latest=f.state();f.restart();
 for(const [op,input,result] of [['reference.attach',addInput,added],['reference.attach',noOpInput,same],['reference.detach',removeInput,removed]])assert.deepEqual(await f.call(op,input),result);
 assert.deepEqual(f.state(),latest);assert.deepEqual(f.store.get('shots',shot.id).referenceAssetIds,[second.asset.id]);assert.notEqual(next.edge.id,added.edge.id);
 await rejectsUnchanged(f,'reference.attach',{...addInput,expectedShotRevision:next.shot.revision},'IDEMPOTENCY_CONFLICT');
 await rejectsUnchanged(f,'reference.detach',{...detach(f,next.edge,next.shot),requestId:addInput.requestId},'IDEMPOTENCY_CONFLICT');
 await rejectsUnchanged(f,'reference.attach',{...attach(f,second.node,next.shot),requestId:removeInput.requestId},'IDEMPOTENCY_CONFLICT');
});

test('manual selections are protected even when the same asset is being attached',async t=>{
 const f=await fixture(t),{asset,node}=await f.image();
 for(const ids of [[asset.id],[asset.id,asset.id]]){const shot=await f.shot(f.projectId,{referenceAssetIds:ids});await rejectsUnchanged(f,'reference.attach',attach(f,node,shot));}
 const other=await f.image(f.projectId,180),manual=await f.shot(f.projectId,{referenceAssetIds:[other.asset.id]});await rejectsUnchanged(f,'reference.attach',attach(f,node,manual));
 const cleared=await f.call('shot.update',{shotId:manual.id,expectedRevision:manual.revision,patch:{referenceAssetIds:[]}});
 assert.deepEqual((await f.call('reference.attach',attach(f,node,cleared))).shot.referenceAssetIds,[asset.id]);
});

test('typed binding prevents hidden reference changes but permits exact refs and unrelated shot edits',async t=>{
 const f=await fixture(t),first=await f.image(),second=await f.image(f.projectId,190),shot=await f.shot();
 let {edge,shot:current}=await f.call('reference.attach',attach(f,first.node,shot));
 for(const referenceAssetIds of [[],[second.asset.id],[first.asset.id,second.asset.id],[first.asset.id,first.asset.id]])await rejectsUnchanged(f,'shot.update',{shotId:shot.id,expectedRevision:current.revision,patch:{referenceAssetIds}});
 current=await f.call('shot.update',{shotId:shot.id,expectedRevision:current.revision,patch:{referenceAssetIds:[first.asset.id],prompt:'Edited without unlinking'}});
 assert.deepEqual(current.referenceAssetIds,[first.asset.id]);assert.equal(current.prompt,'Edited without unlinking');
 await rejectsUnchanged(f,'reference.attach',attach(f,second.node,current));await rejectsUnchanged(f,'edge.delete',{edgeId:edge.id});
 await rejectsUnchanged(f,'node.update',{nodeId:first.node.id,expectedRevision:first.node.revision,patch:{assetId:second.asset.id}},'VALIDATION_ERROR');
 assert.deepEqual((await f.call('reference.detach',detach(f,edge,current))).shot.referenceAssetIds,[]);
});

test('legacy decorative edges do not bind, collide with, or detach a typed reference',async t=>{
 const f=await fixture(t),{node}=await f.image(),shot=await f.shot();
 const created=await f.call('edge.create',{projectId:f.projectId,source:node.id,target:shot.id});assert.equal(created.kind,'decorative');
 const {kind:ignored,...decorative}=created;f.store.put('edges',decorative);assert.deepEqual(f.store.get('shots',shot.id).referenceAssetIds,[]);
 await rejectsUnchanged(f,'reference.detach',detach(f,decorative,shot));
 const bound=await f.call('reference.attach',attach(f,node,shot));assert.notEqual(bound.edge.id,decorative.id);assert.equal(f.store.list('edges').length,2);
 assert.deepEqual(await f.call('edge.create',{projectId:f.projectId,source:node.id,target:shot.id}),decorative);
 await f.call('edge.delete',{edgeId:decorative.id});assert.deepEqual(f.store.get('shots',shot.id),bound.shot);
 await f.call('reference.detach',detach(f,bound.edge,bound.shot));
 const boundAgain=await f.call('reference.attach',attach(f,node,f.store.get('shots',shot.id)));
 const decorationAfter=await f.call('edge.create',{projectId:f.projectId,source:node.id,target:shot.id});assert.notEqual(decorationAfter.id,boundAgain.edge.id);assert.notEqual(decorationAfter.kind,'reference');
});

test('reference source and target must be existing same-project image node and shot',async t=>{
 const f=await fixture(t),{node,asset}=await f.image(),shot=await f.shot();
 const text=await f.call('node.create',{projectId:f.projectId,type:'text',text:'Not an image',position:{x:0,y:0}});
 const otherProject=(await f.call('project.create',{name:'Other project'})).id,foreign=await f.image(otherProject),otherShot=await f.shot(otherProject);
 for(const patch of [{sourceNodeId:text.id},{sourceNodeId:shot.id},{sourceNodeId:randomUUID()},{targetShotId:node.id},{targetShotId:randomUUID()},{sourceNodeId:foreign.node.id},{targetShotId:otherShot.id},{projectId:otherProject}])await rejectsUnchanged(f,'reference.attach',attach(f,node,shot,patch));
 for(const mimeType of ['video/mp4','audio/wav']){const id=randomUUID(),badAsset=f.store.put('assets',{...f.store.get('assets',asset.id),id,mimeType});const badNode=await f.call('node.create',{projectId:f.projectId,type:mimeType.split('/')[0],assetId:badAsset.id,position:{x:0,y:0}});await rejectsUnchanged(f,'reference.attach',attach(f,badNode,shot));}
 for(const corrupt of [{assetId:randomUUID()},{assetId:foreign.asset.id}]){const invalid=f.store.put('nodes',{...node,id:randomUUID(),...corrupt});await rejectsUnchanged(f,'reference.attach',attach(f,invalid,shot));}
});

test('attach checks both expected revisions; detach checks current target revision and project',async t=>{
 const f=await fixture(t),{node}=await f.image(),shot=await f.shot();
 const moved=await f.call('node.update',{nodeId:node.id,expectedRevision:node.revision,patch:{position:{x:900,y:200}}});
 await rejectsUnchanged(f,'reference.attach',attach(f,node,shot),'REVISION_CONFLICT');
 const updated=await f.call('shot.update',{shotId:shot.id,expectedRevision:shot.revision,patch:{prompt:'Current'}});
 await rejectsUnchanged(f,'reference.attach',attach(f,moved,shot),'REVISION_CONFLICT');
 const bound=await f.call('reference.attach',attach(f,moved,updated));
 await rejectsUnchanged(f,'reference.attach',attach(f,node,bound.shot),'REVISION_CONFLICT');
 await rejectsUnchanged(f,'reference.detach',detach(f,bound.edge,updated),'REVISION_CONFLICT');
 const other=(await f.call('project.create',{name:'Foreign detach'})).id;await rejectsUnchanged(f,'reference.detach',detach(f,bound.edge,bound.shot,{projectId:other}));
 const movedAgain=await f.call('node.update',{nodeId:moved.id,expectedRevision:moved.revision,patch:{label:'Later label'}});
 assert.equal(movedAgain.revision,moved.revision+1);assert.equal((await f.call('reference.detach',detach(f,bound.edge,bound.shot))).detached,true);
});

test('concurrent duplicate requests apply once and competing bindings reject without mixed state',async t=>{
 const f=await fixture(t),first=await f.image(),second=await f.image(f.projectId,180),shot=await f.shot(),input=attach(f,first.node,shot);
 const results=await Promise.all(Array.from({length:16},()=>f.call('reference.attach',input)));results.forEach(value=>assert.deepEqual(value,results[0]));assert.equal(f.store.list('edges').length,1);
 const removed=await f.call('reference.detach',detach(f,results[0].edge,results[0].shot));
 const race=await Promise.allSettled([first,second].map(({node})=>f.call('reference.attach',attach(f,node,removed.shot))));
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.find(r=>r.status==='rejected').reason.code,'REVISION_CONFLICT');
 const bound=race.find(r=>r.status==='fulfilled').value;assert.equal(f.store.list('edges').length,1);assert.deepEqual(f.store.get('shots',shot.id).referenceAssetIds,[bound.edge.sourceAssetId]);
 const release=detach(f,bound.edge,bound.shot),releases=await Promise.all(Array.from({length:16},()=>f.call('reference.detach',release)));releases.forEach(value=>assert.deepEqual(value,releases[0]));assert.equal(f.store.list('edges').length,0);
});

test('independent SQLite connections serialize the exact reference request without double mutation',async t=>{
 const f=await fixture(t),{node}=await f.image(),shot=await f.shot(),input=attach(f,node,shot);
 const source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {openStore}=await import(workerData.db);const {createServices}=await import(workerData.services);const store=openStore(workerData.root,{lock:false});parentPort.postMessage({ready:true});parentPort.once('message',async()=>{try{parentPort.postMessage({result:await createServices(store,new Map(),{env:{}}).call('reference.attach',workerData.input)});}catch(error){parentPort.postMessage({error:error.code||error.message});}finally{store.close();}});})();`;
 const workers=Array.from({length:4},()=>new Worker(source,{eval:true,workerData:{root:f.root,input,db:new URL('../packages/business/src/db.ts',import.meta.url).href,services:new URL('../packages/business/src/services.ts',import.meta.url).href}}));
 t.after(()=>Promise.all(workers.map(worker=>worker.terminate())));
 await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);})));const pending=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));workers.forEach(worker=>worker.postMessage('go'));
 const results=await Promise.all(pending);results.forEach(value=>{assert.ok(!value.error,value.error);assert.deepEqual(value.result,results[0].result);});assert.equal(f.store.list('edges').length,1);assert.equal(f.store.get('shots',shot.id).revision,shot.revision+1);
});

test('generation freezes connection provenance and adapter inputs across detach, rebinding, edits and retry',async t=>{
 const f=await fixture(t),first=await f.image(),second=await f.image(f.projectId,170),shot=await f.shot();
 const bound=await f.call('reference.attach',attach(f,first.node,shot));
 const input={shotId:shot.id,expectedRevision:bound.shot.revision,requestId:randomUUID(),providerId:'mock'},job=await f.call('generation.submit',input);
 const frozen={edgeId:bound.edge.id,sourceNodeId:first.node.id,sourceAssetId:first.asset.id,role:'first_frame'};
 assert.deepEqual(job.snapshot.referenceAssetIds,[first.asset.id]);assert.deepEqual(job.snapshot.referenceConnections,[frozen]);
 assert.equal(job.snapshot.referenceAssets[0].sha256,first.asset.sha256);assert.equal(job.snapshot.referenceAssets[0].width,36);assert.equal(JSON.stringify(job).includes('relativePath'),false);
 const removed=await f.call('reference.detach',detach(f,bound.edge,bound.shot));const rebound=await f.call('reference.attach',attach(f,second.node,removed.shot));
 await f.call('node.update',{nodeId:first.node.id,expectedRevision:first.node.revision,patch:{label:'Changed later',position:{x:600,y:800}}});
 const stored=clone(f.store.get('jobs',job.id));f.restart();assert.deepEqual(f.store.get('jobs',job.id),stored);assert.deepEqual((await f.call('generation.submit',input)).snapshot,job.snapshot);
 let received,context;const original=f.providers.get('mock');f.providers.set('mock',{...original,submit:async(snapshot,ctx)=>{received=clone(snapshot);context=ctx;return {providerJobId:'synthetic-reference-capture'};},poll:async()=>({status:'failed',error:'Synthetic terminal result'})});
 const worker=startWorker(f.store,f.services,f.providers);t.after(()=>worker.stop());
 const deadline=Date.now()+5000;while(!received&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(received,'The worker must deliver the frozen reference to the adapter');await worker.stop();
 assert.deepEqual(received.referenceConnections,[frozen]);assert.deepEqual(received.referenceAssetIds,[first.asset.id]);assert.equal(received.referenceAssets[0].id,first.asset.id);assert.equal(context.requestId,input.requestId);
 assert.equal(createHash('sha256').update(await readFile(received.referenceAssets[0].path)).digest('hex'),first.asset.sha256);
 f.store.put('jobs',{...f.store.get('jobs',job.id),status:'failed'});const retry=await f.call('job.retry',{jobId:job.id,requestId:randomUUID()});assert.deepEqual(retry.snapshot,job.snapshot);
 const newest=await f.call('generation.submit',{...input,expectedRevision:rebound.shot.revision,requestId:randomUUID()});assert.deepEqual(newest.snapshot.referenceConnections,[{edgeId:rebound.edge.id,sourceNodeId:second.node.id,sourceAssetId:second.asset.id,role:'first_frame'}]);
});

test('manual generation references keep working without invented connection provenance',async t=>{
 const f=await fixture(t),{asset}=await f.image(),shot=await f.shot(f.projectId,{referenceAssetIds:[asset.id]});
 const job=await f.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:'mock'});assert.deepEqual(job.snapshot.referenceAssetIds,[asset.id]);assert.deepEqual(job.snapshot.referenceConnections,[]);
});

test('durable response failures roll back attach and detach together with their shot changes',async t=>{
 const f=await fixture(t),{node}=await f.image(),shot=await f.shot();
 const state=()=>({domain:f.state(),requests:f.store.db.prepare('SELECT * FROM reference_requests ORDER BY requestId').all()});
 const fail=()=>f.store.db.exec("CREATE TRIGGER fail_reference_response BEFORE INSERT ON reference_requests BEGIN SELECT RAISE(ABORT,'injected reference response failure');END;");
 fail();let before=state();await assert.rejects(f.call('reference.attach',attach(f,node,shot)),/injected reference response failure/);assert.deepEqual(state(),before);f.store.db.exec('DROP TRIGGER fail_reference_response');
 const bound=await f.call('reference.attach',attach(f,node,shot));fail();before=state();await assert.rejects(f.call('reference.detach',detach(f,bound.edge,bound.shot)),/injected reference response failure/);assert.deepEqual(state(),before);f.store.db.exec('DROP TRIGGER fail_reference_response');
 assert.throws(()=>f.store.db.prepare('UPDATE reference_requests SET response=?').run('{}'),/immutable/);
});

test('inconsistent stored bindings fail closed without erasing manual data or queuing a generation',async t=>{
 const f=await fixture(t),first=await f.image(),second=await f.image(f.projectId,120),shot=await f.shot();
 const bound=await f.call('reference.attach',attach(f,first.node,shot));
 f.store.put('shots',{...bound.shot,referenceAssetIds:[first.asset.id,second.asset.id]});
 await rejectsUnchanged(f,'reference.detach',detach(f,bound.edge,bound.shot),'REFERENCE_STATE_CONFLICT');
 await rejectsUnchanged(f,'generation.submit',{shotId:shot.id,expectedRevision:bound.shot.revision,requestId:randomUUID(),providerId:'mock'},'REFERENCE_STATE_CONFLICT');
 f.store.put('shots',bound.shot);f.store.put('edges',{...bound.edge,id:randomUUID()});
 await rejectsUnchanged(f,'reference.detach',detach(f,bound.edge,bound.shot),'REFERENCE_STATE_CONFLICT');
 await rejectsUnchanged(f,'generation.submit',{shotId:shot.id,expectedRevision:bound.shot.revision,requestId:randomUUID(),providerId:'mock'},'REFERENCE_STATE_CONFLICT');
});

test('additive reference migration does not rewrite legacy decorative edges or manual selections',async t=>{
 const f=await fixture(t,{},{open:openLegacyWorkspaceStore}),{asset,node}=await f.image(),shot=await f.shot(f.projectId,{referenceAssetIds:[asset.id]});
 f.store.put('edges',{id:randomUUID(),projectId:f.projectId,source:node.id,target:shot.id});
 const before=f.state();f.store.db.exec('DROP TABLE reference_requests; DELETE FROM schema_version WHERE version=4;');f.restart();assert.deepEqual(f.state(),before);
 assert.equal(f.store.db.prepare('SELECT version FROM schema_version WHERE version=4').get().version,4);assert.deepEqual(f.store.db.prepare('SELECT * FROM reference_requests').all(),[]);
});

test('bound image reaches the real Ark adapter first-frame payload through an injected HTTP transport only',async t=>{
 const env={MIOON_ENABLE_LIVE_PROVIDER:'1',ARK_API_KEY:'synthetic-never-transmitted-credential'};
 const f=await fixture(t,env),small=await f.image(),valid=await f.image(f.projectId,110,360,640),shot=await f.shot(f.projectId,{duration:4});
 const smallBound=await f.call('reference.attach',attach(f,small.node,shot));
 await rejectsUnchanged(f,'generation.submit',{shotId:shot.id,expectedRevision:smallBound.shot.revision,requestId:randomUUID(),providerId:'ark'},'UNSUPPORTED_INPUT');assert.equal(f.store.list('jobs').length,0);
 const cleared=await f.call('reference.detach',detach(f,smallBound.edge,smallBound.shot)),bound=await f.call('reference.attach',attach(f,valid.node,cleared.shot)),calls=[];
 f.providers.set('ark',createArkProvider({root:f.root,env:{...env,ARK_APPROVED_ASSET_SHA256:valid.asset.sha256},fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(init.method==='POST'?{id:'cgt-synthetic-reference-qa'}:{id:'cgt-synthetic-reference-qa',status:'running'}),{status:200,headers:{'content-type':'application/json'}});}}));
 const job=await f.call('generation.submit',{shotId:shot.id,expectedRevision:bound.shot.revision,requestId:randomUUID(),providerId:'ark'});
 await f.call('reference.detach',detach(f,bound.edge,bound.shot));
 const worker=startWorker(f.store,f.services,f.providers);t.after(()=>worker.stop());const deadline=Date.now()+5000;while(!calls.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));await worker.stop();
 assert.equal(calls.filter(call=>call.init.method==='POST').length,1);const request=calls.find(call=>call.init.method==='POST');assert.ok(request,'Injected adapter transport must receive the submission');assert.equal(request.url,'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks');
 const body=JSON.parse(request.init.body),image=body.content.find(item=>item.role==='first_frame');assert.ok(image);assert.equal(image.image_url.url,`data:image/png;base64,${png(360,640,110).toString('base64')}`);assert.equal(body.model,job.model);assert.equal(body.duration,4);assert.equal(body.ratio,'adaptive');assert.deepEqual(job.snapshot.referenceConnections,[{edgeId:bound.edge.id,sourceNodeId:valid.node.id,sourceAssetId:valid.asset.id,role:'first_frame'}]);
 assert.equal(createHash('sha256').update(Buffer.from(image.image_url.url.split(',')[1],'base64')).digest('hex'),valid.asset.sha256);
});
