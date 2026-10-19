import test from 'node:test';
import assert from 'node:assert/strict';
import {browserRpc,BrowserRpcError} from '../apps/web/src/browser-rpc.ts';
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('typed browser RPC keeps exact frozen requests and returns unknown for caller validation',async()=>{
 const calls=[],input={requestId:'original-request',projectId:'project',expectedRevision:4,name:'Name'},fetcher=async(url,options)=>{calls.push([url,options]);return response({ok:true,data:{id:'project'}});};
 await browserRpc('project.rename',input,{fetcher});await browserRpc('project.rename',input,{fetcher});
 assert.equal(calls[0][0],'/api/rpc');assert.equal(calls[0][1].method,'POST');assert.equal(calls[0][1].credentials,'same-origin');assert.equal(calls[0][1].body,calls[1][1].body);assert.deepEqual(JSON.parse(calls[0][1].body),{operation:'project.rename',input});
});
test('only valid explicit client rejection carries a definitive result; diagnostics stay private',async()=>{
 for(const [status,code,definitive]of [[409,'REVISION_CONFLICT',true],[503,'PROJECT_DELETE_BUSY',false],[401,'UNAUTHORIZED',true],[400,'RESTORE_OPERATION_UNAVAILABLE',false]])await assert.rejects(browserRpc('project.delete',{}, {fetcher:async()=>response({ok:false,error:{code,message:'/private/token=secret'}},status)}),error=>{assert.ok(error instanceof BrowserRpcError);assert.equal(error.code,code);assert.equal(error.definitive,definitive);assert.doesNotMatch(error.message,/private|secret/);return true;});
 for(const value of [{ok:true},{ok:true,data:[],error:{code:'UNAUTHORIZED'}},{ok:false,error:{code:'/secret'}}])await assert.rejects(browserRpc('project.summary.list',{}, {fetcher:async()=>response(value)}),error=>error.definitive===false);
 await assert.rejects(browserRpc('provider.list',{}, {fetcher:async()=>{throw Error('private credential');}}),error=>error.code==='NETWORK'&&!error.definitive&&!error.message.includes('credential'));
});
test('closed operation set, cancellation and bounded UTF-8 reads fail before granting result authority',async()=>{
 let calls=0;await assert.rejects(browserRpc('timeline.render',{}, {fetcher:async()=>{calls++;throw Error();}}),error=>error.code==='INVALID_OPERATION');assert.equal(calls,0);
 const controller=new AbortController();controller.abort();await assert.rejects(browserRpc('provider.list',{}, {signal:controller.signal,fetcher:async(_url,options)=>{assert.equal(options.signal.aborted,true);throw new DOMException('Aborted','AbortError');}}),error=>!error.definitive);
 let cancelled=0;await assert.rejects(browserRpc('project.summary.list',{}, {fetcher:async()=>({status:200,body:{getReader:()=>({read:async()=>({done:false,value:{byteLength:48*1024*1024+1}}),cancel:async()=>{cancelled++;},releaseLock(){}})}})}),error=>error.code==='BACKEND_PROTOCOL_ERROR');assert.equal(cancelled,1);
 await assert.rejects(browserRpc('provider.list',{}, {fetcher:async()=>new Response(new Uint8Array([255]))}),error=>!error.definitive);
});
