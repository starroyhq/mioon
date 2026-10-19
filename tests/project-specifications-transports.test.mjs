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
import {isTimelineFormatReadResponse,operationEffects} from '@mioon/contracts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {EDIT_TOOL_DEFINITIONS} from '../packages/business/src/agent/edit-tool-policy.ts';
import {taskFixture,database,snapshot,taskPath,REPO,TASK_TOKEN} from './helpers/edit-tasks-http-fixture.mjs';

const env=url=>({...mediaEnvironment(),MIOON_ENABLE_LIVE_PROVIDER:'0',MIOON_BASE_URL:url,MIOON_TOKEN:TASK_TOKEN});
async function cli(url,args){
 const child=spawn(process.execPath,[path.join(REPO,'apps/cli/src/index.ts'),...args],{cwd:REPO,env:env(url),stdio:['ignore','pipe','pipe']});
 let out='',err='';
 child.stdout.setEncoding('utf8').on('data',s=>{out+=s;if(out.length>512*1024)child.kill('SIGKILL');});
 child.stderr.setEncoding('utf8').on('data',s=>{err+=s;if(err.length>64*1024)child.kill('SIGKILL');});
 const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
 let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timer);}
 assert.equal(signal,null,err);assert.ok(!out.includes(TASK_TOKEN)&&!err.includes(TASK_TOKEN));
 const body=JSON.parse(out);assert.equal(code===0,body.ok,out+err);return body;
}
async function wire(t){
 const f=await taskFixture(t);let drop=false,malformed=false,last;const submissions=[];
 const proxy=http.createServer(async(req,res)=>{try{
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>32768)throw Error('fixture input cap');chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8'),body=JSON.parse(raw);submissions.push(body);
  const upstream=await fetch(f.backend.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TASK_TOKEN,'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(10000)});
  const text=await upstream.text();last={body,text,status:upstream.status};
  if(drop&&body.operation==='timeline.format.set'){drop=false;res.destroy();return;}
  res.writeHead(upstream.status,{'content-type':'application/json'});
  if(malformed){malformed=false;res.end(JSON.stringify({ok:true,data:{malformed:true}}));}else res.end(text);
 }catch{res.destroy();}});
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const url=`http://127.0.0.1:${proxy.address().port}`;
 const mcp=new Client({name:'timeline-format-tests',version:'1.0.0'},{capabilities:{}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(REPO,'apps/mcp/src/index.ts')],cwd:REPO,env:env(url),stderr:'pipe'});
 transport.stderr?.setEncoding('utf8');transport.stderr?.resume();await mcp.connect(transport);
 t.after(async()=>{await mcp.close();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));});
 const raw=async(operation,input)=>{try{const r=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+TASK_TOKEN,'content-type':'application/json'},body:JSON.stringify({operation,input}),signal:AbortSignal.timeout(10000)});return await r.json();}catch{return {ok:false,error:{code:'LOST_TRANSPORT'}};}};
 return {f,url,mcp,submissions,client:createClient({env:env(url)}),last:()=>last,drop:()=>{drop=true;},malform:()=>{malformed=true;},
  transports:[{name:'HTTP',call:raw},{name:'CLI',call:(operation,input)=>cli(url,[...operation.split('.'),'--input',JSON.stringify(input)])},
   {name:'MCP',call:async(operation,input)=>{const result=await mcp.callTool({name:operation.replaceAll('.','_'),arguments:input},undefined,{timeout:10000});const body=JSON.parse(result.content.find(x=>x.type==='text').text);assert.deepEqual(body,result.structuredContent);assert.equal(Boolean(result.isError),!body.ok);return body;}}]};
}
const formatInput=(state,presetId)=>({projectId:state.projectId,expectedProjectRevision:state.projectRevision,expectedRevision:state.timelineRevision,requestId:randomUUID(),presetId});

test('format reads are noncreating and schemas/effects discoverable through actual CLI and official MCP, without Agent authority',{timeout:60000},async t=>{
 const w=await wire(t),{f}=w;
 const before=snapshot(f.root),read=await w.client.rpc('timeline.format.get',{projectId:f.foreign.id});
 assert.ok(isTimelineFormatReadResponse(read,{projectId:f.foreign.id}));assert.equal(read.timelineId,null);assert.equal(read.timelineRevision,0);assert.equal(read.presetId,'portrait_1080');assert.equal(read.eligible,true);assert.deepEqual(snapshot(f.root),before);
 assert.equal(operationEffects['timeline.format.get'].readOnly,true);assert.equal(operationEffects['timeline.format.set'].idempotent,true);
 for(const field of ['fileWrite','externalIO','localProcess','paidGeneration'])assert.equal(operationEffects['timeline.format.set'][field],false);
 const catalog=discoverSchema(),cliCatalog=await cli(w.url,['schema']);assert.deepEqual(cliCatalog.data,catalog);
 const tools=(await w.mcp.listTools()).tools;
 for(const operation of ['timeline.format.get','timeline.format.set']){
  const definition=catalog.operations.find(x=>x.operation===operation)||catalog.operations.find(x=>x.name===operation);assert.ok(definition);
  const tool=tools.find(x=>x.name===operation.replaceAll('.','_'));assert.ok(tool);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(tool.annotations.readOnlyHint,operation.endsWith('.get'));
 }
 assert.ok(!JSON.stringify(READ_TOOL_DEFINITIONS).includes('timeline.format'));assert.ok(!JSON.stringify(EDIT_TOOL_DEFINITIONS).includes('timeline.format'));
 for(const transport of w.transports){const invalid=await transport.call('timeline.format.set',{...formatInput(read,'landscape_720'),fps:60});assert.equal(invalid.ok,false);assert.equal(invalid.error.code,'VALIDATION_ERROR');}
 assert.deepEqual(snapshot(f.root),before);
});

test('HTTP CLI and official MCP lost acknowledgements recover the exact format receipt after real backend restart, never retry implicitly',{timeout:90000},async t=>{
 const w=await wire(t),{f}=w;const presets=['landscape_720','square_720','portrait_720'];
 for(const [index,transport] of w.transports.entries()){
  const state=await w.client.rpc('timeline.format.get',{projectId:f.project.id}),input=formatInput(state,presets[index]);
  const count=w.submissions.filter(x=>x.operation==='timeline.format.set').length;w.drop();const lost=await transport.call('timeline.format.set',input);assert.equal(lost.ok,false);
  assert.equal(w.submissions.filter(x=>x.operation==='timeline.format.set').length,count+1,'no automatic retry after lost response');
  const original=JSON.parse(w.last().text);assert.equal(original.ok,true);
  const row=database(f.root,db=>db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId));assert.equal(row.response,JSON.stringify(original.data));
  await f.restart();const before=snapshot(f.root),replayed=await transport.call('timeline.format.set',input);assert.equal(replayed.ok,true);assert.deepEqual(replayed.data,original.data);assert.deepEqual(snapshot(f.root),before);
  const changed=await transport.call('timeline.format.set',{...input,presetId:presets[(index+1)%3]});assert.equal(changed.ok,false);assert.equal(changed.error.code,'IDEMPOTENCY_CONFLICT');assert.deepEqual(snapshot(f.root),before);
 }
 const before=snapshot(f.root);w.malform();await assert.rejects(w.client.rpc('timeline.format.get',{projectId:f.project.id}),error=>error.code==='BACKEND_PROTOCOL_ERROR'&&!error.details?.submissionMayHaveSucceeded);assert.deepEqual(snapshot(f.root),before);
});

test('format durable task survives lost execute response and restart with one exact intent and explicit recovery',{timeout:60000},async t=>{
 const f=await taskFixture(t,{subprocess:true});const state=await f.rpc('timeline.format.get',{projectId:f.project.id});const input=formatInput(state,'landscape_720');const saved=await f.prepare('timeline.format.set',input);
 const route=taskPath(saved.task.id,'execute');f.lose(route);await assert.rejects(f.viaProxy(route,{method:'POST',input:{projectId:f.project.id,digest:saved.task.digest,instanceId:saved.instanceId}}));
 const receipt=database(f.root,db=>db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId));assert.ok(receipt);
 await f.restart();const before=snapshot(f.root);const pending=await f.list();assert.equal(pending.items.length,1);assert.equal(pending.items[0].id,saved.task.id);assert.deepEqual(pending.items[0].input,input);assert.deepEqual(snapshot(f.root),before);
 const recovered=await f.reconcile(saved.task);assert.equal(recovered.task.status,'applied');assert.deepEqual(recovered.result,JSON.parse(receipt.response));assert.deepEqual(snapshot(f.root),before);
 await f.acknowledge(recovered.task);assert.equal((await f.list()).items.length,0);
});
