import test from 'node:test';
import assert from 'node:assert/strict';
import {browserRpc,BrowserRpcError} from '../apps/web/src/browser-rpc.ts';
const response=(value: unknown,status=200): Response=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('typed browser RPC keeps exact frozen requests and returns unknown for caller validation',async()=>{
 interface CallRecord {url: string; options: RequestInit}
 const calls: CallRecord[]=[],input={requestId:'original-request',projectId:'project',expectedRevision:4,name:'Name'};
 const fetcher=async(url: string,options: RequestInit)=>{calls.push({url,options});return response({ok:true,data:{id:'project'}});};
 await browserRpc('project.rename',input,{fetcher: fetcher as never});await browserRpc('project.rename',input,{fetcher: fetcher as never});
 assert.equal(calls[0]!.url,'/api/rpc');assert.equal(calls[0]!.options.method,'POST');assert.equal(calls[0]!.options.credentials,'same-origin');assert.equal(calls[0]!.options.body,calls[1]!.options.body);assert.deepEqual(JSON.parse(String(calls[0]!.options.body)),{operation:'project.rename',input});
});
test('only valid explicit client rejection carries a definitive result; diagnostics stay private',async()=>{
 const failures = [[409,'REVISION_CONFLICT',true],[503,'PROJECT_DELETE_BUSY',false],[401,'UNAUTHORIZED',true],[400,'RESTORE_OPERATION_UNAVAILABLE',false]] as const;
 for(const [status,code,definitive] of failures) await assert.rejects(browserRpc('project.delete',{}, {fetcher:(async()=>response({ok:false,error:{code,message:'/private/token=secret'}},status)) as never}),(error: unknown)=>{assert.ok(error instanceof BrowserRpcError);assert.equal(error.code,code);assert.equal(error.definitive,definitive);assert.doesNotMatch(error.message,/private|secret/);return true;});
 for(const value of [{ok:true},{ok:true,data:[],error:{code:'UNAUTHORIZED'}},{ok:false,error:{code:'/secret'}}]) await assert.rejects(browserRpc('project.summary.list',{}, {fetcher:(async()=>response(value)) as never}),(error: unknown)=>(error as BrowserRpcError).definitive===false);
 await assert.rejects(browserRpc('provider.list',{}, {fetcher:(async()=>{throw Error('private credential');}) as never}),(error: unknown)=>{const failure=error as BrowserRpcError;return failure.code==='NETWORK'&&!failure.definitive&&!failure.message.includes('credential');});
});
test('closed operation set, cancellation and bounded UTF-8 reads fail before granting result authority',async()=>{
 let calls=0;await assert.rejects(browserRpc('timeline.render' as never,{}, {fetcher:(async()=>{calls++;throw Error();}) as never}),(error: unknown)=>(error as BrowserRpcError).code==='INVALID_OPERATION');assert.equal(calls,0);
 const controller=new AbortController();controller.abort();await assert.rejects(browserRpc('provider.list',{}, {signal:controller.signal,fetcher:(async(_url: string,options: RequestInit)=>{assert.equal(options.signal?.aborted,true);throw new DOMException('Aborted','AbortError');}) as never}),(error: unknown)=>!(error as BrowserRpcError).definitive);
 let cancelled=0;await assert.rejects(browserRpc('project.summary.list',{}, {fetcher:(async()=>({status:200,body:{getReader:()=>({read:async()=>({done:false,value:{byteLength:48*1024*1024+1}}),cancel:async()=>{cancelled++;},releaseLock(){}})}})) as never}),(error: unknown)=>(error as BrowserRpcError).code==='BACKEND_PROTOCOL_ERROR');assert.equal(cancelled,1);
 await assert.rejects(browserRpc('provider.list',{}, {fetcher:(async()=>new Response(new Uint8Array([255]))) as never}),(error: unknown)=>!(error as BrowserRpcError).definitive);
});
