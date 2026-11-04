import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createImageHttp} from '../apps/server/src/image-http.ts';
import {projectHandlerTarget} from '../apps/server/src/project-host/request.ts';
import {parseProjectApiPath,projectApiPath} from '../packages/contracts/src/project-file.ts';
import {IMAGE_FIXED_OPTIONS} from '../packages/contracts/src/images.ts';
import {IMAGE_REVIEW_LIMITS} from '../packages/contracts/src/image-reviews.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {startServer} from '../apps/server/src/index.ts';

const projectId=randomUUID(),connectionId=randomUUID();
const generation={projectId,name:'Image',providerId:'openai-compatible',model:'custom-image',prompt:'Synthetic scene',options:IMAGE_FIXED_OPTIONS,requestId:randomUUID()};
async function fixture() {
  const calls:Array<{operation:string;input:unknown}>=[];
  const handler=createImageHttp({approve:()=>assert.fail('Preparation must not approve'),reject:()=>assert.fail('Preparation must not reject'),
    generationServices:(operation,input)=>{calls.push({operation,input});return {operation,prepared:true};}});
  return {calls,async request({pathname='/api/images/services',method='POST',input,headers={},raw,address={projectId}}:
    {pathname?:string;method?:string;input?:unknown;headers?:Record<string,string>;raw?:Buffer;address?:{projectId:string}|null}={}) {
    const req=Readable.from(raw?[raw]:input===undefined?[]:[Buffer.from(JSON.stringify(input))]) as IncomingMessage;
    req.url=pathname;req.method=method;req.headers={'content-type':'application/json',...headers};
    let status=0,body='';const responseHeaders:Record<string,unknown>={};
    const res={setHeader(name:string,value:unknown){responseHeaders[name]=value;},writeHead(code:number,values:Record<string,unknown>){status=code;Object.assign(responseHeaders,values);},
      end(value:string){body=value;},destroy(){assert.fail('Unexpected destruction');}} as unknown as ServerResponse;
    const handled=await handler(req,res,new URL(pathname,'http://localhost'),address??undefined);
    return {handled,status,headers:responseHeaders,data:body?JSON.parse(body) as {error?:{code:string};data?:unknown}:null};
  }};
}

test('only exact project images/services is forwarded to the dedicated image service handler',()=>{
  const route=parseProjectApiPath(projectApiPath(projectId,'images','services'));assert.ok(route);
  assert.deepEqual(projectHandlerTarget(route),{projectId,pathname:'/api/images/services'});
  for(const segments of [['images','services','extra'],['images','settings'],['images','custom-settings']]) {
    const candidate=parseProjectApiPath(projectApiPath(projectId,segments[0],...segments.slice(1)));assert.ok(candidate);assert.equal(projectHandlerTarget(candidate),null);
  }
});

test('dedicated project service POST accepts only list or explicit-ID preparation, without approval or RPC dispatch',async()=>{
  const f=await fixture();
  const list={operation:'image.service.list',input:{projectId}},prepare={operation:'image.service.review.prepare',input:{input:generation,connectionId,configurationRevision:1}};
  for(const input of [list,prepare]) {const result=await f.request({input});assert.equal(result.status,200);assert.equal(result.headers['Cache-Control'],'no-store');}
  assert.deepEqual(f.calls,[list,prepare]);
  for(const input of [{operation:'image.generate',input:generation},{...list,extra:true},{operation:'image.service.list',input:null},
    {operation:'image.service.review.prepare',input:{}},{operation:'image.service.list',input:{}},
    {operation:'image.review.approve',input:{projectId}}])assert.equal((await f.request({input})).status,400);
  assert.equal(f.calls.length,2);
  assert.equal((await f.request({input:list,address:null})).status,404);
  assert.equal((await f.request({input:list,pathname:'/api/images/services/extra'})).status,404);
  const method=await f.request({input:list,method:'GET'});assert.equal(method.status,405);assert.equal(method.headers.Allow,'POST');
});

test('service inputs cannot name another project and invalid bodies never reach a domain callback',async()=>{
  const f=await fixture(),foreign=randomUUID();
  for(const input of [{operation:'image.service.list',input:{projectId:foreign}},
    {operation:'image.service.review.prepare',input:{input:{...generation,projectId:foreign},connectionId,configurationRevision:1}}]) {
    const result=await f.request({input});assert.equal(result.data?.error?.code,'PROJECT_ID_MISMATCH');
  }
  const invalidOptions:Array<{headers?:Record<string,string>;raw?:Buffer;input?:unknown;pathname?:string}>=[{headers:{'content-type':'text/plain'}},{headers:{'content-encoding':'gzip'}},
    {headers:{'content-length':'01'}},{raw:Buffer.from([0xff])},{input:[]},{pathname:'/api/images/services?unexpected=1'}];
  for(const options of invalidOptions)
    assert.equal((await f.request(options)).status,400);
  const large=await f.request({headers:{'content-length':String(IMAGE_REVIEW_LIMITS.intentBytes+1)}});
  assert.equal(large.status,413);assert.equal(large.headers.Connection,'close');assert.equal(f.calls.length,0);
});

test('actual project HTTP serves explicit service lists behind authentication while new preparation operations remain outside RPC',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'g1-image-service-http-'));let providerCalls=0;
  const server=await startServer({dataDir:root,port:0,comfyModule:'skip',imageNetwork:{lookup:async()=>{providerCalls++;throw Error('No provider lookup');},
    httpsRequest:()=>{providerCalls++;throw Error('No provider request');}}});
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  const send=async(route:string,input:unknown,method='POST',headers:Record<string,string>={})=>fetch(server.url+route,{method,
    headers:{Authorization:`Bearer ${server.token}`,'content-type':'application/json',...headers},body:JSON.stringify(input)});
  const created=await send('/api/rpc',{operation:'project.create',input:{name:'Image service HTTP'}});assert.equal(created.status,200);
  const project=(await created.json() as {data:{id:string}}).data,route=projectApiPath(project.id,'images','services'),list={operation:'image.service.list',input:{projectId:project.id}};
  assert.equal((await fetch(server.url+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(list)})).status,401);
  assert.equal((await send(route,list,'POST',{Origin:'https://foreign.example.com'})).status,403);
  const ids=[randomUUID(),randomUUID()];
  for(let i=0;i<ids.length;i++) {
    const configured=await send('/api/images/custom-settings',{action:'create',expectedRevision:i,connectionId:ids[i],name:`Service ${i}`,
      configuration:{...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2,enabled:true,baseUrl:`https://service-${i}.example.com/v1`,model:'same-model'},
      secret:{action:'replace',storage:'session',value:`synthetic-service-key-${i}`}},'PUT');assert.equal(configured.status,200);
  }
  const response=await send(route,list);assert.equal(response.status,200);
  const data=await response.json() as {data:{projectId:string;items:Array<{connectionId:string;configuration:{model:string}}>} };
  assert.equal(data.data.projectId,project.id);assert.deepEqual(data.data.items.map(item=>item.connectionId),ids);
  assert.deepEqual(data.data.items.map(item=>item.configuration.model),['same-model','same-model']);assert.equal(JSON.stringify(data).includes('synthetic-service-key'),false);
  const malformed=await send(route,{operation:'image.service.review.prepare',input:{input:{...generation,projectId:project.id},connectionId:ids[0],configurationRevision:0}});assert.equal(malformed.status,400);
  const foreign=await send(route,{operation:'image.service.list',input:{projectId:randomUUID()}});assert.equal((await foreign.json() as {error:{code:string}}).error.code,'PROJECT_ID_MISMATCH');
  for(const operation of ['image.service.list','image.service.review.prepare']) {
    const rpc=await send('/api/rpc',{operation,input:{projectId:project.id}});assert.equal((await rpc.json() as {error:{code:string}}).error.code,'UNKNOWN_OPERATION');
  }
  assert.equal(providerCalls,0);
});
