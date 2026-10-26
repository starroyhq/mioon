import type {ComfyImageSettingsResult} from '../packages/contracts/src/comfy-images.ts';
import type {RpcEnvelope} from './helpers/strict-timeline-audio-types.ts';
interface CheckArgs{config:{baseUrl:string};signal:AbortSignal}
interface MockHttpResponse extends EventEmitter{writableEnded:boolean;writableFinished:boolean;destroyed:boolean;destroy():void}
interface HttpTestResult{headers:Record<string,unknown>;code:number|null;text:string|null;handled:boolean;body:RpcEnvelope<ComfyImageSettingsResult>|null}
interface RequestOptions{method?:string;input?:unknown;bytes?:Buffer;headers?:Record<string,string|undefined>;onStart?:(controls:{req:Readable;res:MockHttpResponse})=>void}
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createComfyHttp} from '../apps/server/src/comfy-http.ts';
import {startServer} from '../apps/server/src/index.ts';
import {createComfySettings} from '../packages/business/src/comfy/settings.ts';
import {DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.ts';

const baseUrl='http://127.0.0.1:8188',model='example.safetensors';
const configuration={...DEFAULT_COMFY_IMAGE_CONFIGURATION,enabled:true,baseUrl,model};
const checked={ok:true,baseUrl,comfyVersion:'0.39.0',checkpoints:[model],selectedCheckpointAvailable:false,nodeClasses:['CheckpointLoaderSimple','EmptyLatentImage','CLIPTextEncode','KSampler','VAEDecode','SaveImage']};
const memory=()=>{let value:unknown=null;return{load:async()=>structuredClone(value),save:async (next: unknown)=>{value=structuredClone(next);}};};
async function fixture(t:test.TestContext,{check,signal}:{check?:(args:CheckArgs)=>unknown;signal?:AbortSignal}={}){
  const settings=await createComfySettings({persistence:memory(),reservedPorts:()=>[4318]}),calls:CheckArgs[]=[];
  t.after(()=>settings.close());
  const connector={check:async (args:CheckArgs)=>{calls.push(args);return check?check(args):structuredClone(checked);}};
  const route=createComfyHttp(({settings,connector,signal} as unknown as Parameters<typeof createComfyHttp>[0]));
  return {settings,calls,async request(path='/api/images/comfy-settings',{method='GET',input,bytes,headers={},onStart}:RequestOptions={}){
    const req=Readable.from(bytes?[bytes]:input===undefined?[]:[Buffer.from(JSON.stringify(input))]) as Readable&Pick<http.IncomingMessage,"url"|"method"|"headers">;req.url=path;req.method=method;req.headers={'content-type':'application/json',...headers};
    const result={headers:{},code:null,text:null} as HttpTestResult,res=new EventEmitter() as MockHttpResponse;
    Object.assign(res,{setHeader(name:string,value:unknown){result.headers[name]=value;},writeHead(code:number,headers:Record<string,unknown>){result.code=code;Object.assign(result.headers,headers);},end(text:string){result.text=text;res.writableEnded=true;res.writableFinished=true;},destroy(){res.destroyed=true;res.emit('close');}});
    const pending=route(req as unknown as Parameters<typeof route>[0],res as unknown as Parameters<typeof route>[1],new URL(path,'http://127.0.0.1:4318'));onStart?.({req,res});
    result.handled=await pending;result.body=result.text?JSON.parse(result.text):null;return result;
  }};
}
test('Comfy settings GET and PUT never check a connection; explicit check caches only matching bounded evidence',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.request()).body!.data.configuration,DEFAULT_COMFY_IMAGE_CONFIGURATION);assert.equal(f.calls.length,0);
  const saved=await f.request(undefined,{method:'PUT',input:{expectedRevision:0,configuration}});
  assert.equal(saved.code,200);assert.equal(saved.body!.data.readiness.checked,false);assert.equal(f.calls.length,0);
  const result=await f.request('/api/images/comfy-check',{method:'POST',input:{baseUrl}});
  assert.equal(result.code,200);assert.deepEqual(result.body!.data,checked);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].config,{baseUrl});
  const ready=await f.request();assert.equal(ready.body!.data.readiness.checked,true);assert.equal(ready.headers['Cache-Control'],'no-store');
  assert.equal((await f.request('/api/images/settings')).handled,false);
  assert.equal((await f.request('/api/images/comfy-settings/')).handled,false);
});
test('Comfy HTTP methods, queries, JSON, media type, compression, unknown authority fields and byte limits fail closed',async t=>{
  const f=await fixture(t);
  const badMethod=await f.request('/api/images/comfy-check',{method:'GET'});assert.equal(badMethod.code,405);assert.equal(badMethod.headers.Allow,'POST');
  assert.equal((await f.request('/api/images/comfy-settings',{method:'POST'})).code,405);
  assert.equal((await f.request('/api/images/comfy-check?token=PRIVATE',{method:'POST',input:{baseUrl}})).code,400);
  for(const args of [{headers:{'content-type':'text/plain'},input:{}},{headers:{'content-encoding':'gzip'},input:{}},{headers:{'content-length':'01'},input:{}},{headers:{'content-length':'3'},input:{}},{bytes:Buffer.from([0xff])},{input:[]},{input:{baseUrl,apiKey:'PRIVATE'}},{input:{baseUrl,workflow:{}}},{input:{baseUrl:'http://localhost:8188'}}]){
    const result=await f.request('/api/images/comfy-check',{method:'POST',...args});assert.equal(result.code,400);assert.ok(!result.text!.includes('PRIVATE'));
  }
  for(const args of [{headers:{'content-length':'16385'}},{bytes:Buffer.from('x'.repeat(16385))}]){
    const result=await f.request('/api/images/comfy-check',{method:'POST',...args});assert.equal(result.code,413);assert.equal(result.headers.Connection,'close');
  }
  assert.equal(f.calls.length,0);assert.equal((await f.settings.get()).revision,0);
});
test('self-owned destinations never reach check and missing/bad provider results cannot manufacture readiness',async t=>{
  const f=await fixture(t);
  const denied=await f.request('/api/images/comfy-check',{method:'POST',input:{baseUrl:'http://127.0.0.1:4318'}});assert.equal(denied.code,400);assert.equal(f.calls.length,0);
  const g=await fixture(t,{check:()=>({...checked,baseUrl:'http://127.0.0.1:9999'})});
  const mismatch=await g.request('/api/images/comfy-check',{method:'POST',input:{baseUrl}});assert.equal(mismatch.code,502);assert.equal(mismatch.body!.error.code,'COMFY_RESPONSE_INVALID');assert.equal((await g.settings.get()).readiness.checked,false);
});
test('upstream errors never expose arbitrary provider payloads, paths or credentials',async t=>{
  const f=await fixture(t,{check:()=>{throw Object.assign(Error('PRIVATE /home/example/credential'),{code:'COMFY_CONNECTION_FAILED',details:{secret:'PRIVATE'}});}});
  const result=await f.request('/api/images/comfy-check',{method:'POST',input:{baseUrl}});assert.equal(result.code,502);assert.equal(result.body!.error.code,'COMFY_CONNECTION_FAILED');assert.deepEqual(result.body!.error.details,{});assert.ok(!result.text!.includes('PRIVATE'));assert.ok(!result.text!.includes('/home'));
});
test('disconnect and shutdown abort only the current explicit check and prevent stale check caching',async t=>{
  for(const kind of ['disconnect','shutdown']){
    const shutdown=new AbortController();let started: (value?: unknown) => void;
    const ready=new Promise(resolve=>{started=resolve;});
    const f=await fixture(t,{signal:shutdown.signal,check:({signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(Object.assign(Error('PRIVATE'),{code:'COMFY_ABORTED'})),{once:true});})});
    let controls!:{req:Readable;res:MockHttpResponse};
    const request=f.request('/api/images/comfy-check',{method:'POST',input:{baseUrl},onStart:(value:{req:Readable;res:MockHttpResponse})=>{controls=value;}});
    await ready;if(kind==='disconnect')controls!.res.destroy();else shutdown.abort();
    const result=await request;assert.equal(f.calls[0].signal.aborted,true);assert.equal((await f.settings.get()).readiness.checked,false);
    if(kind==='disconnect')assert.equal(result.body,null);else assert.equal(result.body!.error.code,'COMFY_ABORTED');
  }
});
test('actual server preserves authentication/origin gates and excludes its ephemeral backend port before Comfy I/O',async t=>{
  const dataDir=await mkdtemp(path.join(tmpdir(),'mioon-comfy-http-'));
  let server:Awaited<ReturnType<typeof startServer>>,networkCalls=0;
  t.after(async()=>{await server?.close();await rm(dataDir,{recursive:true,force:true});});
  server=await startServer({dataDir,port:0,token:'synthetic-comfy-http-access-token',comfyNetwork:{httpRequest(){networkCalls++;throw Error('Synthetic unavailable transport');}}});
  const headers={Authorization:`Bearer ${server.token}`,'Content-Type':'application/json'};
  assert.equal((await fetch(`${server.url}/api/images/comfy-settings`)).status,401);
  assert.equal((await fetch(`${server.url}/api/images/comfy-settings`,{headers:{...headers,Origin:'http://attacker.invalid'}})).status,403);
  // fetch owns its Host header; use the HTTP wire API to exercise a forged Host.
  const wrongHost=await new Promise((resolve,reject)=>{
    const request=http.request(`${server.url}/api/images/comfy-settings`,{headers:{...headers,Host:'attacker.invalid'}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});
    request.on('error',reject);request.end();
  });
  assert.equal(wrongHost,403);
  const settings=await fetch(`${server.url}/api/images/comfy-settings`,{headers});assert.equal(settings.status,200);assert.equal((await settings.json()).data.configuration.enabled,false);assert.equal(networkCalls,0);
  const check=await fetch(`${server.url}/api/images/comfy-check`,{method:'POST',headers,body:JSON.stringify({baseUrl:server.url})});assert.equal(check.status,400);assert.equal((await check.json()).error.code,'COMFY_SETTINGS_DESTINATION_DENIED');assert.equal(networkCalls,0);
  const ownSettings={...configuration,baseUrl:server.url};
  const put=await fetch(`${server.url}/api/images/comfy-settings`,{method:'PUT',headers,body:JSON.stringify({expectedRevision:0,configuration:ownSettings})});assert.equal(put.status,400);assert.equal((await put.json()).error.code,'COMFY_SETTINGS_DESTINATION_DENIED');assert.equal(networkCalls,0);
});
