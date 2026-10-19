import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createClient,discoverSchema} from '@mioon/client';
import {TIMELINE_SUBTITLE_OPERATIONS,isTimelineMutationResponse} from '@mioon/contracts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {taskFixture,database,snapshot,taskPath,REPO,TASK_TOKEN} from './helpers/edit-tasks-http-fixture.mjs';

const env=url=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_BASE_URL:url,MIOON_TOKEN:TASK_TOKEN});
async function cli(url,args){
 const child=spawn(process.execPath,[path.join(REPO,'apps/cli/src/index.ts'),...args],{cwd:REPO,env:env(url),stdio:['ignore','pipe','pipe']});
 let out='',err='';
 child.stdout.setEncoding('utf8').on('data',part=>{out+=part;if(out.length>512*1024)child.kill('SIGKILL');});
 child.stderr.setEncoding('utf8').on('data',part=>{err+=part;if(err.length>64*1024)child.kill('SIGKILL');});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
 let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,err);assert.ok(!out.includes(TASK_TOKEN)&&!err.includes(TASK_TOKEN));
 const body=JSON.parse(out);assert.equal(code===0,body.ok,out+err);return body;
}
async function wire(t){
 const f=await taskFixture(t);let loseOperation=null,malformOperation=null,last;const submissions=[];
 const proxy=http.createServer(async(req,res)=>{try{
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>32768)throw Error('fixture input cap');chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw);submissions.push(body);
  const upstream=await fetch(f.backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TASK_TOKEN,'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(10000)});
  const text=await upstream.text();last={body,text,status:upstream.status};
  if(loseOperation===body.operation){loseOperation=null;res.destroy();return;}
  res.writeHead(upstream.status,{'content-type':'application/json'});
  if(malformOperation===body.operation){malformOperation=null;res.end(JSON.stringify({ok:true,data:{malformed:true}}));}else res.end(text);
 }catch{res.destroy();}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const url=`http://127.0.0.1:${proxy.address().port}`;
 const mcp=new Client({name:'manual-subtitle-tests',version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(REPO,'apps/mcp/src/index.ts')],cwd:REPO,env:env(url),stderr:'pipe'});
 // The official SDK owns protocol stdout; stderr is drained, not coerced or parsed.
 transport.stderr?.resume();await mcp.connect(transport);
 t.after(async()=>{await mcp.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));});
 const raw=async(operation,input)=>{try{const r=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TASK_TOKEN,'content-type':'application/json'},body:JSON.stringify({operation,input}),signal:AbortSignal.timeout(10000)});return await r.json();}catch{return {ok:false,error:{code:'LOST_TRANSPORT'}};}};
 return {f,url,mcp,submissions,client:createClient({env:env(url)}),last:()=>last,lose:operation=>{loseOperation=operation;},malform:operation=>{malformOperation=operation;},
  transports:[{name:'HTTP',call:raw},{name:'CLI',call:(operation,input)=>cli(url,[...operation.split('.'),'--input',JSON.stringify(input)])},
   {name:'MCP',call:async(operation,input)=>{const result=await mcp.callTool({name:operation.replaceAll('.','_'),arguments:input},undefined,{timeout:10000});const body=JSON.parse(result.content.find(x=>x.type==='text').text);assert.deepEqual(body,result.structuredContent);assert.equal(Boolean(result.isError),!body.ok);return body;}}]};
}
const base=(projectId,timeline)=>({projectId,expectedRevision:timeline.revision,requestId:randomUUID()});
async function seed(f){return f.rpc('timeline.clip.add',{...base(f.project.id,f.timeline),assetId:f.source.id,trackId:f.timeline.tracks.find(x=>x.kind==='video').id,startFrame:0,durationFrames:90});}

test('subtitle schemas are strict in actual CLI and official MCP and do not grant Agent tool authority',{timeout:60000},async t=>{
 const w=await wire(t),catalog=discoverSchema(),before=snapshot(w.f.root);
 assert.deepEqual((await cli(w.url,['schema'])).data,catalog);
 const tools=(await w.mcp.listTools()).tools;
 for(const operation of TIMELINE_SUBTITLE_OPERATIONS){
  const definition=catalog.operations.find(x=>x.operation===operation);assert.ok(definition);
  const tool=tools.find(x=>x.name===operation.replaceAll('.','_'));assert.ok(tool);
  assert.deepEqual(tool.inputSchema,definition.inputSchema);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(definition.requiresRequestId,true);assert.equal(definition.effects.databaseWrite,true);assert.equal(definition.effects.idempotent,true);
  for(const field of ['fileWrite','externalIO','localProcess','paidGeneration'])assert.equal(definition.effects[field],false);
  const input={...base(w.f.project.id,w.f.timeline),...(operation.endsWith('.add')?{text:'字幕，Hello!',startFrame:0,durationFrames:30}:operation.endsWith('.update')?{cueId:randomUUID(),patch:{text:'字幕'}}:{cueId:randomUUID()})};
  for(const transport of w.transports){
   const extra=await transport.call(operation,{...input,fontPath:'/untrusted/font.otf'});assert.equal(extra.ok,false);assert.equal(extra.error.code,'VALIDATION_ERROR');
   const missing={...input};delete missing.requestId;const rejected=await transport.call(operation,missing);assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'VALIDATION_ERROR');
  }
 }
 assert.ok(!JSON.stringify(READ_TOOL_DEFINITIONS).includes('subtitle'));assert.ok(!JSON.stringify(EDIT_TOOL_DEFINITIONS).includes('subtitle'));
 assert.deepEqual(snapshot(w.f.root),before);
});

test('subtitle HTTP CLI MCP preserve literal text, exact replay, CAS and history across lost acknowledgements and restart',{timeout:120000},async t=>{
 const w=await wire(t),{f}=w;let timeline=await seed(f);
 for(const transport of w.transports){
  const add={...base(f.project.id,timeline),text:'你好，世界！\nHello: 100% \\ []',startFrame:0,durationFrames:30};
  const count=w.submissions.length;w.lose('timeline.subtitle.add');const lost=await transport.call('timeline.subtitle.add',add);assert.equal(lost.ok,false);
  assert.equal(w.submissions.length,count+1,'loss never automatically submits a second mutation');
  const original=JSON.parse(w.last().text);assert.equal(original.ok,true);assert.ok(isTimelineMutationResponse('timeline.subtitle.add',add,original.data));
  const cue=original.data.subtitles.cues[0];assert.equal(cue.text,add.text);
  const receipt=database(f.root,db=>db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(add.requestId));assert.equal(receipt.response,JSON.stringify(original.data));
  await f.restart();let before=snapshot(f.root);const replay=await transport.call('timeline.subtitle.add',add);assert.deepEqual(replay,original);assert.deepEqual(snapshot(f.root),before);
  const conflict=await transport.call('timeline.subtitle.add',{...add,text:'changed'});assert.equal(conflict.ok,false);assert.equal(conflict.error.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(snapshot(f.root),before);
  timeline=original.data;
  const update={...base(f.project.id,timeline),cueId:cue.id,patch:{text:'第二句，Hello!',startFrame:30,durationFrames:30}};
  const changed=await transport.call('timeline.subtitle.update',update);assert.equal(changed.ok,true);assert.ok(isTimelineMutationResponse('timeline.subtitle.update',update,changed.data));timeline=changed.data;
  const stale=await transport.call('timeline.subtitle.update',{...update,requestId:randomUUID(),patch:{text:'stale'}});assert.equal(stale.ok,false);assert.equal(stale.error.code,'REVISION_CONFLICT');
  const remove={...base(f.project.id,timeline),cueId:cue.id};const removed=await transport.call('timeline.subtitle.remove',remove);assert.equal(removed.ok,true);assert.equal(removed.data.subtitles.cues.length,0);timeline=removed.data;
  before=snapshot(f.root);assert.deepEqual(await transport.call('timeline.subtitle.remove',remove),removed);assert.deepEqual(snapshot(f.root),before);
  const undone=await transport.call('timeline.undo',base(f.project.id,timeline));assert.equal(undone.ok,true);assert.deepEqual(undone.data.subtitles,changed.data.subtitles);timeline=undone.data;
  const redone=await transport.call('timeline.redo',base(f.project.id,timeline));assert.equal(redone.ok,true);assert.deepEqual(redone.data.subtitles,removed.data.subtitles);timeline=redone.data;
  before=snapshot(f.root);assert.deepEqual(await transport.call('timeline.subtitle.add',add),original,'historical add receipt survives later edit/removal/undo/redo');assert.deepEqual(snapshot(f.root),before);
 }
});

test('malformed subtitle success retains ambiguity and explicit exact request recovers one committed result',{timeout:60000},async t=>{
 const w=await wire(t),timeline=await seed(w.f),input={...base(w.f.project.id,timeline),text:'确认原句',startFrame:0,durationFrames:30};
 const count=w.submissions.length;w.malform('timeline.subtitle.add');await assert.rejects(w.client.rpc('timeline.subtitle.add',input),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&error.details?.submissionMayHaveSucceeded===true);
 assert.equal(w.submissions.length,count+1);const original=JSON.parse(w.last().text);assert.equal(original.ok,true);
 await w.f.restart();const before=snapshot(w.f.root);assert.deepEqual(await w.client.rpc('timeline.subtitle.add',input),original.data);assert.deepEqual(snapshot(w.f.root),before);
});

test('subtitle durable intent rediscovers after original backend loss without automatic application',{timeout:60000},async t=>{
 const f=await taskFixture(t,{subprocess:true}),timeline=await seed(f),input={...base(f.project.id,timeline),text:'重启后恢复',startFrame:0,durationFrames:30};
 const prepared=await f.prepare('timeline.subtitle.add',input);await f.restart();const before=snapshot(f.root),pending=await f.list();
 assert.equal(pending.items.length,1);assert.equal(pending.items[0].id,prepared.task.id);assert.deepEqual(pending.items[0].input,input);assert.deepEqual(snapshot(f.root),before);
 const route=taskPath(prepared.task.id,'execute'),current=await f.get(prepared.task.id);f.lose(route);
 await assert.rejects(f.viaProxy(route,{method:'POST',input:{projectId:f.project.id,digest:prepared.task.digest,instanceId:current.instanceId}}));
 const receipt=database(f.root,db=>db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId));assert.ok(receipt);
 await f.restart();const committed=snapshot(f.root);const recovered=await f.reconcile(prepared.task);assert.equal(recovered.task.status,'applied');assert.deepEqual(recovered.result,JSON.parse(receipt.response));assert.deepEqual(snapshot(f.root),committed);
 await f.acknowledge(recovered.task);assert.equal((await f.list()).items.length,0);
});
