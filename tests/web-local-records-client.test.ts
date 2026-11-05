import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalRecordsClient,LocalRecordsRequestError} from '../apps/web/src/local-records-client.ts';

const identity = {appLibraryScope:'a'.repeat(64),instanceId:randomUUID()};
const item = {projectId:randomUUID(),name:'访谈',projectFile:'/private/missing.mioon',sizeBytes:0,hasSuperJournal:false,hasUnfinishedTasks:false};
const input = {projectId:item.projectId,expectedAppLibraryScope:identity.appLibraryScope,expectedInstanceId:identity.instanceId};
const data = {version:1,...identity,records:[item]};
const reply = (data:unknown) => Response.json({ok:true,data});
const error = (code:string,outcomeUnknown:boolean) => (value:unknown):boolean => value instanceof LocalRecordsRequestError&&value.code===code&&value.outcomeUnknown===outcomeUnknown;

test('local records use exact application bodies and do not select a project or retry',async()=>{
  const calls:Array<{url:string;options:RequestInit}>=[];
  const client=createLocalRecordsClient({fetcher:async(url,options)=>{calls.push({url:String(url),options:options!});return reply(calls.length===1?data:{...identity,projectId:item.projectId,deleted:true});}});
  assert.deepEqual(await client.list(),data);assert.deepEqual(await client.delete(input),{...identity,projectId:item.projectId,deleted:true});
  assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.url,'/api/rpc');assert.equal(call.options.method,'POST');assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.redirect,'error');assert.equal(call.options.cache,'no-store');}
  assert.deepEqual(calls.map(call=>JSON.parse(call.options.body as string)),[{operation:'local.records.list',input:{}},{operation:'local.records.delete',input}]);
});
test('invalid arguments and an already aborted intent never dispatch',async()=>{
  let calls=0;const client=createLocalRecordsClient({fetcher:async()=>{calls++;return reply(data);}}),abort=new AbortController();abort.abort();
  await assert.rejects(client.list({signal:abort.signal}),error('INTERRUPTED',false));
  await assert.rejects(client.delete({...input,expectedInstanceId:'not-an-instance'}),error('VALIDATION_ERROR',false));
  await assert.rejects(client.list({extra:true} as never),error('VALIDATION_ERROR',false));assert.equal(calls,0);
});
test('strict responses reject duplicate records, unknown fields, invalid flags and foreign deletion identities',async()=>{
  for(const invalid of [{...data,records:[item,item]},{...data,extra:true},{...data,records:[{...item,hasUnfinishedTasks:'false'}]}]){
    const client=createLocalRecordsClient({fetcher:async()=>reply(invalid)});await assert.rejects(client.list(),error('BACKEND_PROTOCOL_ERROR',false));
  }
  for(const invalid of [{...identity,projectId:randomUUID(),deleted:true},{...identity,projectId:item.projectId,deleted:true,instanceId:randomUUID()}]){
    const client=createLocalRecordsClient({fetcher:async()=>reply(invalid)});await assert.rejects(client.delete(input),error('BACKEND_PROTOCOL_ERROR',true));
  }
});
test('definite guards retain their exact codes; errors after dispatch cannot claim no deletion',async()=>{
  for(const [code,status] of [['LOCAL_RECORDS_IN_USE',409],['LOCAL_RECORDS_SUPER_JOURNAL',409],['LOCAL_RECORDS_NOT_FOUND',404],['LOCAL_RECORDS_IDENTITY_CHANGED',409]] as const){
    const client=createLocalRecordsClient({fetcher:async()=>Response.json({ok:false,error:{code,message:'rejected'}},{status})});await assert.rejects(client.delete(input),error(code,false));
  }
  const unknown=createLocalRecordsClient({fetcher:async()=>Response.json({ok:false,error:{code:'LOCAL_RECORDS_DELETE_UNCERTAIN',message:'unknown'}},{status:503})});
  await assert.rejects(unknown.delete(input),error('LOCAL_RECORDS_DELETE_UNCERTAIN',true));
  const lying=createLocalRecordsClient({fetcher:async()=>Response.json({ok:false,error:{code:'LOCAL_RECORDS_NOT_FOUND',message:'bad status'}},{status:500})});
  await assert.rejects(lying.delete(input),error('BACKEND_PROTOCOL_ERROR',true));
});
test('stream bounds, content type and malformed UTF-8 never become a successful deletion',async()=>{
  for(const response of [new Response('{}',{headers:{'content-type':'text/plain'}}),new Response(new Uint8Array([0xc3,0x28]),{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':'999999999'}})]){
    let calls=0;const client=createLocalRecordsClient({fetcher:async()=>{calls++;return response;}});await assert.rejects(client.delete(input),value=>value instanceof LocalRecordsRequestError&&value.outcomeUnknown);assert.equal(calls,1);
  }
});
test('timeouts and aborts terminate fetchers or streams that ignore their signal without replay',async()=>{
  let calls=0;const client=createLocalRecordsClient({timeoutMs:15,fetcher:async()=>{calls++;return await new Promise<Response>(()=>{});}});
  await assert.rejects(client.delete(input),error('TIMEOUT',true));assert.equal(calls,1);
  const abort=new AbortController(),readClient=createLocalRecordsClient({fetcher:async()=>new Response(new ReadableStream({start(){}}),{headers:{'content-type':'application/json'}})});
  const pending=readClient.list({signal:abort.signal});abort.abort();await assert.rejects(pending,error('INTERRUPTED',false));
});
