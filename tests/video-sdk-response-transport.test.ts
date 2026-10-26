import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeVideoSdkResponse} from '../packages/business/src/video/sdk-response-transport.ts';
import {createCompatibleVideoSdkClient} from '../packages/business/src/video/compatible-sdk.ts';
import {checkCompatibleVideoService} from '../packages/business/src/video/compatible-check.ts';
import {providerError} from '../packages/business/src/providers/live-common.ts';

const api='https://video.example.com/v1',url=api+'/videos/existing_task/content',key='synthetic-bound-key';
const flush=async()=>{for(let index=0;index<30;index++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
function unreadResponse(status=200){
  let reads=0,cancels=0;
  const response=new Response(new ReadableStream<Uint8Array>({pull(controller){reads++;controller.enqueue(new TextEncoder().encode('PRIVATE not JSON or media'));controller.close();},cancel(){cancels++;}},{highWaterMark:0}),{status,headers:{location:'https://cdn.example.com/output.mp4'}});
  return {response,get reads(){return reads;},get cancels(){return cancels;}};
}
function sdk(){return createCompatibleVideoSdkClient({api,model:'custom-video',send:async()=>{throw Error('JSON transport must not download media');}});}

test('real SDK binary downloads preserve raw statuses and untouched media/error streams without SDK retries',async()=>{
  for(const status of [200,302,307,401,404,408,409,429,500,503]){
    const incoming=unreadResponse(status);let calls=0;
    const response=await sdk().downloadContent('existing_task',{headers:{authorization:`Bearer ${key}`},fetchImpl:async(input,init)=>{
      calls++;assert.equal(String(input),url);assert.equal(init?.method,'GET');assert.equal(init.redirect,'manual');
      assert.deepEqual([...new Headers(init.headers)],[['authorization',`Bearer ${key}`]]);assert.ok(init.signal);return incoming.response;
    }});
    assert.equal(response,incoming.response);assert.equal(response.status,status);assert.equal(incoming.reads,0);assert.equal(incoming.cancels,0);assert.equal(calls,1);
    await response.body!.cancel();assert.equal(incoming.cancels,1);
  }
});

test('real SDK model probes inspect status only, cancel unread bodies and never follow redirects or page',async()=>{
  for(const status of [200,201,302,307,401,403,404,405,429,500,503]){
    const incoming=unreadResponse(status);let calls=0;
    const result=await checkCompatibleVideoService({baseUrl:api,apiKey:key,fetchImpl:async(input,init)=>{
      calls++;assert.equal(String(input),api+'/models');assert.equal(init?.method,'GET');assert.equal(init.redirect,'error');
      assert.deepEqual([...new Headers(init.headers)],[['accept','application/json'],['authorization',`Bearer ${key}`]]);return incoming.response;
    }});
    const expected=status<300?{result:'ok'}:[401,403].includes(status)?{result:'unauthorized',httpStatus:status}:[404,405].includes(status)?{result:'unsupported',httpStatus:status}:{result:'http_error',httpStatus:status};
    assert.deepEqual(result,expected);assert.equal(calls,1);assert.equal(incoming.reads,0);assert.equal(incoming.cancels,1);
  }
});

test('binary SDK path, query, method and retry changes are rejected before host dispatch',async()=>{
  for(const [requested,options] of [
    ['https://elsewhere.example/content',{method:'GET'}],
    [url+'?variant=thumbnail',{method:'GET'}],
    [url+'#fragment',{method:'GET'}],
    ['not a URL',{method:'GET'}],
    [url,{method:'POST',body:'private'}],
    [url,{method:'GET',headers:{'x-stainless-retry-count':'1'}}],
  ] as const){
    let calls=0;
    await assert.rejects(invokeVideoSdkResponse({expectedUrl:url,send:async()=>{calls++;return new Response();}},fetch=>fetch(requested,options)),{code:'VIDEO_SDK_REQUEST_INVALID'});
    assert.equal(calls,0);
  }
  let calls=0;
  for(const id of ['../task','task?leak=1','task#fragment','%2Fother'])await assert.rejects(async()=>sdk().downloadContent(id,{fetchImpl:async()=>{calls++;return new Response();}}),{code:'INVALID_PROVIDER_TASK_ID'});
  assert.equal(calls,0);
});

test('a second SDK GET cannot dispatch and releases the first raw response',async()=>{
  const incoming=unreadResponse();let calls=0;
  await assert.rejects(invokeVideoSdkResponse({expectedUrl:url,send:async(_url,options)=>{calls++;assert.equal(options.redirect,'manual');return incoming.response;}},async fetch=>{
    await fetch(url,{method:'GET'});await fetch(url,{method:'GET'});
  }),(error:unknown)=>{assert.equal((error as {code:string}).code,'VIDEO_SDK_REQUEST_INVALID');assert.notEqual((error as {beforeDispatch?:boolean}).beforeDispatch,true);return true;});
  assert.equal(calls,1);assert.equal(incoming.reads,0);assert.equal(incoming.cancels,1);
});

test('host failures retain exact safe evidence while post-fetch SDK failures cancel media and stay generic',async()=>{
  const failure=providerError('VIDEO_CREDENTIAL_UNAVAILABLE','Bound credential is unavailable',{beforeDispatch:true});let calls=0;
  await assert.rejects(invokeVideoSdkResponse({expectedUrl:url,send:async()=>{calls++;throw failure;}},async fetch=>{
    try{await fetch(url,{method:'GET'});}catch{/* Simulate SDK wrapping or attempting to retry. */}
    try{await fetch(url,{method:'GET'});}catch{throw Error('PRIVATE SDK detail');}
  }),error=>error===failure);assert.equal(calls,1);
  const incoming=unreadResponse();
  await assert.rejects(invokeVideoSdkResponse({expectedUrl:url,send:async()=>incoming.response},async fetch=>{
    await fetch(url,{method:'GET'});throw Error('PRIVATE SDK detail');
  }),(error:unknown)=>{assert.equal((error as {code:string}).code,'VIDEO_SDK_REQUEST_FAILED');assert.doesNotMatch(String(error),/PRIVATE/);return true;});
  assert.equal(incoming.reads,0);assert.equal(incoming.cancels,1);
});

test('abort before dispatch makes no GET and abort during a stalled GET releases a late response',async()=>{
  let calls=0;const early=new AbortController();early.abort();
  await assert.rejects(sdk().downloadContent('existing_task',{signal:early.signal,fetchImpl:async()=>{calls++;return new Response();}}),{code:'OPERATION_CANCELLED'});assert.equal(calls,0);
  const held=deferred<Response>(),controller=new AbortController();
  const pending=sdk().downloadContent('existing_task',{signal:controller.signal,fetchImpl:async()=>{calls++;return held.promise;}});
  const rejected=assert.rejects(pending,{code:'OPERATION_CANCELLED'});await flush();assert.equal(calls,1);controller.abort();await rejected;
  const incoming=unreadResponse();held.resolve(incoming.response);await flush();assert.equal(incoming.reads,0);assert.equal(incoming.cancels,1);
});

test('model probe timeout and cancellation do not retry a non-cooperative fetch or expose its body',async()=>{
  let calls=0;const held=deferred<Response>();
  const pending=checkCompatibleVideoService({baseUrl:api,apiKey:key,timeoutMs:10,fetchImpl:async()=>{calls++;return held.promise;}});
  await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(await pending,{result:'unreachable'});assert.equal(calls,1);
  const late=unreadResponse(503);held.resolve(late.response);await flush();assert.equal(late.reads,0);assert.equal(late.cancels,1);
  const controller=new AbortController();controller.abort();
  assert.deepEqual(await checkCompatibleVideoService({baseUrl:api,apiKey:key,signal:controller.signal,fetchImpl:async()=>{calls++;return new Response();}}),{result:'unreachable'});assert.equal(calls,1);
});
