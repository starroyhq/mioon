import type {RpcEnvelope} from './helpers/strict-timeline-audio-types.ts';
import type {OrdinaryDeliveryEnvelope} from './helpers/strict-timeline-audio-draft-types.ts';
import type {LocalShotTextSupported} from '../apps/web/src/local-shot-text-state.ts';
import type {FixtureExport} from './helpers/strict-timeline-core-types.ts';
import type {MediaShot} from './helpers/strict-service-responses.ts';
type WireEnvelope=OrdinaryDeliveryEnvelope;
type WireExecution={envelope:WireEnvelope;response:FixtureExport|null};
type WireResponse<T=WireEnvelope>={status:number;body:RpcEnvelope<T>};
interface WireOptions{method?:string;input?:unknown;headers?:Record<string,string>;authenticated?:boolean}
import type {TypedStore, TypedServices} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,readFile,stat,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {startServer} from '../apps/server/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import {schemas,isTimelineMutationResponse} from '@mioon/contracts';
import {createLocalDeliverySchemas} from '@mioon/contracts/local-delivery';
import type { BinaryLike } from 'crypto';

const token='synthetic-local-delivery-http-token';
const route='/api/local-delivery';
const sha=(value: import("node:crypto").BinaryLike)=>createHash('sha256').update(value).digest('hex');
const contract=createLocalDeliverySchemas(value=>schemas['timeline.render'].safeParse(value).success);
const authority=(value: WireEnvelope)=>({workspaceScope:value.workspaceScope,instanceId:value.instanceId,projectId:value.projectId});
const execution=(value: WireEnvelope)=>({...authority(value),intentId:value.intent!.intentId,expectedIntentRevision:value.intentRevision});
function request<T=WireEnvelope>(url: string,suffix: string|undefined,{method='GET',input,headers={},authenticated=true}: WireOptions={}){
  const payload=input===undefined?undefined:JSON.stringify(input);
  return new Promise<WireResponse<T>>((resolve,reject)=>{
    const req=http.request(url+suffix,{method,agent:false,headers:{'content-type':'application/json',...(authenticated?{authorization:`Bearer ${token}`} : {}),...(payload?{'content-length':Buffer.byteLength(payload)}:{}),...headers}},res=>{
      let text='',bytes=0;res.setEncoding('utf8');
      res.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>4*1024*1024+12*1024){res.destroy(Error('Synthetic response limit'));return;}text+=chunk;});
      res.once('error',reject);res.once('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(text)});}catch(error){reject(error);}});
    });
    req.setTimeout(10000,()=>req.destroy(Error('Synthetic HTTP deadline')));req.once('error',reject);req.end(payload);
  });
}
async function fixture(t: test.TestContext){
  const parent=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-delivery-wire-'))),root=path.join(parent,'workspace');
  let server:Awaited<ReturnType<typeof startServer>>,proxy: http.Server<typeof http.IncomingMessage,typeof http.ServerResponse>;const store=(openStore(root) as TypedStore),services=(createServices(store,new Map()) as TypedServices);let project,timeline;
  try{
    project=await services.call('project.create',{name:'Synthetic local export recovery'});
    const asset=await services.call('asset.import',{projectId:project.id,name:'Synthetic PNG',mimeType:'image/png',dataBase64:(await renderMockImagePng()).toString('base64')});
    timeline=await services.call('timeline.get',{projectId:project.id});
    timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30});
  }finally{await services.drain();store.close();}
  t.after(async()=>{try{if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await server?.close();}finally{await rm(parent,{recursive:true,force:true});}});
  const start=async()=>server=await startServer({dataDir:root,port:0,token,chatGateway:async function*(){throw Error('No model calls in local export fixture');}});
  await start();
  const call=async<T=WireEnvelope>(suffix:string,options?: WireOptions)=>{const result=await request<T>(server.url,suffix,options);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.ok,true);return result.body.data;};
  const get=()=>call(`${route}?projectId=${project.id}`);
  const name=(value: WireEnvelope,title: unknown)=>({...authority(value),expectedDraftRevision:value.draftRevision,draftId:value.draft?.draftId??randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,raw:{deliveryName:title}});
  const prepare=(value: WireEnvelope)=>({...authority(value),expectedIntentRevision:value.intentRevision,expectedIntentId:value.intent?.intentId??null,intentId:randomUUID(),timelineId:timeline.id,baseRevision:timeline.revision,
    draft:value.draft?{draftId:value.draft.draftId,revision:value.draftRevision,raw:value.draft.raw}:null,
    input:{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',...(value.draft?.raw.deliveryName?{deliveryName:value.draft.raw.deliveryName}:{})}});
  const rows=()=>{const db=new DatabaseSync(path.join(root,'workbench.sqlite'),{readOnly:true});try{return {exports:db.prepare('SELECT id,data FROM exports ORDER BY rowid').all(),receipts:db.prepare('SELECT requestId,response FROM timeline_requests ORDER BY rowid').all()};}finally{db.close();}};
  return {root,project,timeline,get,call,name,prepare,rows,get url(){return server.url;},file:path.join(root,'local-delivery-v1.json'),
    async restart(){await server.close();await start();},
    async dropNextExecution(){
      const observed=Promise.withResolvers<WireResponse<WireExecution>>();
      proxy=http.createServer(async(req,res)=>{
        try{let raw='';req.setEncoding('utf8');for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>12*1024)throw Error('Synthetic request limit');}
          const result=await request<WireExecution>(server.url,req.url,{method:req.method,input:JSON.parse(raw)});observed.resolve(result);res.destroy();
        }catch(error){observed.reject(error);res.destroy();}
      });
      await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve);});
      return {url:`http://127.0.0.1:${(proxy.address()! as import('node:net').AddressInfo).port}`,observed:observed.promise};
    },
  };
}

test('actual authenticated HTTP persists only title and exact export input; GET is noncreating',{timeout:30000},async t=>{
  const f=await fixture(t),before=f.rows(),initial=await f.get();assert.equal(initial.draft,null);assert.equal(initial.intent,null);
  await assert.rejects(stat(f.file),{code:'ENOENT'});
  const raw='恢复名称\nraw invalid for export';const saved=await f.call(route+'/draft',{method:'PUT',input:f.name(initial,raw)});
  assert.equal(saved.draft!.raw.deliveryName,raw);assert.deepEqual(f.rows(),before);
  const bytes=await readFile(f.file),info=await stat(f.file);assert.equal(info.mode&0o777,0o600);await f.get();assert.deepEqual(await readFile(f.file),bytes);
  const bad=f.prepare(saved);const refused=await request(f.url,route+'/prepare',{method:'POST',input:bad});assert.equal(refused.status,400);assert.deepEqual(f.rows(),before);assert.deepEqual(await readFile(f.file),bytes);
  for(const options of [{authenticated:false},{headers:{origin:'https://foreign.example'}}]){const denied=await request(f.url,`${route}?projectId=${f.project.id}`,options);assert.ok([401,403].includes(denied.status));assert.equal(JSON.stringify(denied.body).includes(raw),false);}
  for(const suffix of [`${route}?projectId=${f.project.id}&extra=1`,`${route}?projectId=${f.project.id}&projectId=${f.project.id}`])assert.equal((await request(f.url,suffix)).status,400);
});

test('real HTTP lost execution ACK plus backend recreation discovers the same immutable intent and one export',{timeout:45000},async t=>{
  const f=await fixture(t),initial=await f.get();let current=await f.call(route+'/draft',{method:'PUT',input:f.name(initial,'交付 · 重启原请求')});
  const input=f.prepare(current);current=await f.call(route+'/prepare',{method:'POST',input});const frozen=structuredClone(current.intent),before=f.rows();
  assert.equal(current.intent!.outcome.status,'pending');assert.equal(f.rows().exports.length,0);
  const proxy=await f.dropNextExecution();await assert.rejects(request(proxy.url,route+'/execute',{method:'POST',input:execution(current)}));
  const upstream=await proxy.observed;assert.equal(upstream.status,200);assert.ok(contract.execution.safeParse(upstream.body.data).success);
  const accepted=upstream.body.data;assert.equal(accepted.envelope.intent!.outcome.status,'accepted');assert.ok(isTimelineMutationResponse('timeline.render',input.input,accepted.response));
  const receipt=f.rows().receipts.find(row=>row.requestId===input.input.requestId);assert.ok(receipt);assert.equal(f.rows().exports.length,1);assert.equal(f.rows().receipts.length,before.receipts.length+1);
  await f.restart();const rediscovered=await f.get();assert.equal(rediscovered.workspaceScope,initial.workspaceScope);assert.notEqual(rediscovered.instanceId,initial.instanceId);
  assert.equal(rediscovered.intent!.intentId,frozen!.intentId);assert.deepEqual(rediscovered.intent!.input,frozen!.input);assert.equal(rediscovered.draft,null);
  const recovered=await f.call<WireExecution>(route+'/recover',{method:'POST',input:execution(rediscovered)});assert.deepEqual(recovered.response,accepted.response);
  assert.equal(f.rows().exports.length,1);assert.deepEqual(f.rows().receipts.find(row=>row.requestId===input.input.requestId),receipt);
  assert.equal(sha(JSON.stringify(recovered.response)),sha(JSON.stringify(accepted.response)));
  const stale=await request(f.url,route+'/execute',{method:'POST',input:execution(current)});assert.equal(stale.status,409);assert.equal(f.rows().exports.length,1);
});

test('two real HTTP windows share one fixed export dispatch and cannot replace pending identity',{timeout:45000},async t=>{
  const f=await fixture(t),initial=await f.get(),input=f.prepare(initial);
  const pending=await f.call(route+'/prepare',{method:'POST',input});
  const alternative={...input,intentId:randomUUID(),input:{...input.input,requestId:randomUUID()}};
  assert.equal((await request(f.url,route+'/prepare',{method:'POST',input:alternative})).status,409);
  const results=await Promise.all([request(f.url,route+'/execute',{method:'POST',input:execution(pending)}),request(f.url,route+'/recover',{method:'POST',input:execution(pending)})]);
  assert.ok(results.some(result=>result.status===200));for(const result of results)assert.ok([200,409].includes(result.status));
  const observed=await f.get();assert.equal(observed.intent!.input.requestId,input.input.requestId);assert.equal(observed.intent!.outcome.status,'accepted');assert.equal(f.rows().exports.length,1);
  assert.equal(f.rows().receipts.filter(row=>row.requestId===input.input.requestId).length,1);
});
