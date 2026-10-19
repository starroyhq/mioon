import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {startWorker} from '../../packages/business/src/jobs.ts';

interface Deferred<T> {readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void}
export function deferred<T = unknown>(): Deferred<T> {
 let resolve!: (value: T)=>void,reject!: (error: unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
export const settle=(): Promise<void>=>new Promise(resolve=>setImmediate(resolve));

/** Synthetic trusted adapters only; no network, user assets, or credentials. */
export async function shutdownFixture(t: unknown,methods: Record<string, unknown> = {}, {reference=false,signal}: {reference?: boolean; signal?: AbortSignal} = {}) {
 const root=await mkdtemp(path.join(tmpdir(),'mioon-worker-shutdown-'));
 const store=openStore(root),workers: {stop(): Promise<unknown>}[]=[],calls: Record<string,number>={submit:0,poll:0,reconcile:0,download:0};
 let closed=false,closedTouches=0;
 const storeRecord=store as unknown as Record<string, unknown>;
 for(const name of ['get','put','list','tx']) {
  const original=storeRecord[name] as (...args: unknown[])=>unknown;
  storeRecord[name]=(...args: unknown[])=>{if(closed)closedTouches++;return original(...args);};
 }
 const close=()=>{if(!closed){store.close();closed=true;}};
 const provider: Record<string, unknown>={
  ...{},
  id:'mock',capabilities:{inputModes:['text','image'],models:['shutdown-fixture'],aspectRatios:['9:16'],durations:[2,4,8],enabled:true,configured:true,mock:true},
  submit:async()=>({providerJobId:'existing-provider-task'}),
  poll:async()=>({status:'running',progress:0.2}),
  reconcile:async()=>null,
  download:async()=>{throw Error('Unconfigured synthetic download');},
  ...methods,
 };
 for(const name of Object.keys(calls)) {
  const original=provider[name] as (...args: unknown[])=>unknown;
  provider[name]=(...args: unknown[])=>{calls[name]=(calls[name]??0)+1;return original(...args);};
 }
 const providers=new Map<never,never>([['mock',provider]] as never),services=createServices(store,providers as never,{signal});
 const project=await services.call('project.create',{name:'Synthetic shutdown fixture'}) as {id: string};
 const assets: {id: string; projectId: string; mimeType: string; relativePath: string; sha256: string}[]=[];
 if(reference) {
  const asset={id:randomUUID(),projectId:project.id,mimeType:'image/png',relativePath:'media/inert-reference.png',sha256:'a'.repeat(64)};
  await writeFile(path.join(root,asset.relativePath),'Inert bytes; never decoded or transmitted.');store.put('assets',asset);assets.push(asset);
 }
 const shot=await services.call('shot.create',{projectId:project.id,title:'Shutdown fixture',referenceAssetIds:assets.map(a=>a.id)}) as {id: string; revision: number};
 const job=await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'mock',requestId:randomUUID()}) as {id: string};
 (t as never as {after(callback: ()=>Promise<void>): void}).after(async()=>{await Promise.all(workers.map(worker=>worker.stop().catch(()=>{})));close();await rm(root,{recursive:true,force:true});});
 return {root,store,services,provider,providers,project,assets,job,calls,close,closedTouches:()=>closedTouches,
  read:()=>store.get('jobs',job.id),
  transition:(patch: Record<string, unknown>)=>services.saveJob(store.get('jobs',job.id) as never,patch as never),
  start:(options?: Record<string, unknown>)=>{const worker=startWorker(store,services,providers as never,options as never);workers.push(worker);return worker;},
 };
}
