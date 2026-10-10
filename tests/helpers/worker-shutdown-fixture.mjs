import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../../packages/business/src/db.mjs';
import {createServices} from '../../packages/business/src/services.mjs';
import {startWorker} from '../../packages/business/src/jobs.mjs';

export function deferred() {
 let resolve,reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
export const settle=()=>new Promise(resolve=>setImmediate(resolve));

/** Synthetic trusted adapters only; no network, user assets, or credentials. */
export async function shutdownFixture(t,methods={}, {reference=false,signal}={}) {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-worker-shutdown-'));
 const store=openStore(root),workers=[],calls={submit:0,poll:0,reconcile:0,download:0};
 let closed=false,closedTouches=0;
 for(const name of ['get','put','list','tx']) {
  const original=store[name];
  store[name]=(...args)=>{if(closed)closedTouches++;return original(...args);};
 }
 const close=()=>{if(!closed){store.close();closed=true;}};
 const provider={
  id:'mock',capabilities:{inputModes:['text','image'],models:['shutdown-fixture'],aspectRatios:['9:16'],durations:[2,4,8],enabled:true,configured:true,mock:true},
  submit:async()=>({providerJobId:'existing-provider-task'}),
  poll:async()=>({status:'running',progress:0.2}),
  reconcile:async()=>null,
  download:async()=>{throw Error('Unconfigured synthetic download');},
  ...methods,
 };
 for(const name of Object.keys(calls)) {
  const original=provider[name];
  provider[name]=(...args)=>{calls[name]++;return original(...args);};
 }
 const providers=new Map([['mock',provider]]),services=createServices(store,providers,{signal});
 const project=await services.call('project.create',{name:'Synthetic shutdown fixture'});
 const assets=[];
 if(reference) {
  const asset={id:randomUUID(),projectId:project.id,mimeType:'image/png',relativePath:'media/inert-reference.png',sha256:'a'.repeat(64)};
  await writeFile(path.join(root,asset.relativePath),'Inert bytes; never decoded or transmitted.');store.put('assets',asset);assets.push(asset);
 }
 const shot=await services.call('shot.create',{projectId:project.id,title:'Shutdown fixture',referenceAssetIds:assets.map(a=>a.id)});
 const job=await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID()});
 t.after(async()=>{await Promise.all(workers.map(worker=>worker.stop().catch(()=>{})));close();await rm(root,{recursive:true,force:true});});
 return {root,store,services,provider,providers,project,assets,job,calls,close,closedTouches:()=>closedTouches,
  read:()=>store.get('jobs',job.id),
  transition:patch=>services.saveJob(store.get('jobs',job.id),patch),
  start:options=>{const worker=startWorker(store,services,providers,options);workers.push(worker);return worker;},
 };
}
