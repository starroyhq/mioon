import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.mjs';
import {createClient, operationDefinition} from '../packages/client/src/index.mjs';
import {COMFY_IMAGE_OPTIONS, DEFAULT_COMFY_IMAGE_CONFIGURATION} from '../packages/contracts/src/comfy-images.mjs';
import {COMFY_NODE_CLASSES} from '../packages/business/src/comfy/profile.mjs';
import {hashComfyWorkflow} from '../packages/business/src/comfy/workflow.mjs';
import {startComfyFixture,COMFY_FIXTURE_MODEL} from './helpers/comfy-http-fixture.mjs';

const repo=fileURLToPath(new URL('..',import.meta.url)),token='synthetic-comfy-local-transport-token',model=COMFY_FIXTURE_MODEL;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function childEnvironment(extra={}){
  const clean=Object.fromEntries(['PATH','HOME','TMPDIR','TEMP','LANG','SYSTEMROOT','COMSPEC'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
  return {...clean,TZ:'UTC',MIOON_ENABLE_LIVE_PROVIDER:'0',...extra};
}
function publicOnly(value,root){
  const text=JSON.stringify(value);assert.ok(!text.includes(token)&&!text.includes(root));
  assert.ok(!/"(?:apiKey|authorization|dataBase64|b64_json|relativePath|rawGraph|canonicalInput|stagedReceipt)"\s*:/i.test(text));
}
async function cli(operation,input,env){
  const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.mjs'),'rpc',operation,'--input',JSON.stringify(input)],{cwd:repo,env:childEnvironment(env),stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;if(stdout.length>1024*1024)child.kill('SIGKILL');});
  child.stderr.setEncoding('utf8').on('data',chunk=>{stderr=(stderr+chunk).slice(-20000);});
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000);let result;
  try{result=await once(child,'close');}finally{clearTimeout(timer);}
  assert.equal(result[1],null,stderr);assert.equal(result[0],0,stdout+stderr);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
  const envelope=JSON.parse(stdout);assert.equal(envelope.ok,true,stdout);return envelope.data;
}
async function withMcp(f,run){
  const client=new Client({name:'synthetic-comfy-transport-acceptance',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.mjs')],cwd:repo,env:childEnvironment(f.env),stderr:'pipe'});
  try{
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    assert.ok(tools.some(item=>item.name===operationDefinition('image.task.observeRemote').toolName));
    assert.ok(!tools.some(item=>/comfy.*(?:settings|check)|image_review_approve/i.test(item.name)));
    await run(async(operation,input)=>{
      const result=await client.callTool({name:operationDefinition(operation).toolName,arguments:input});
      assert.equal(result.isError,false,JSON.stringify(result));assert.equal(result.structuredContent.ok,true);publicOnly(result,f.root);return result.structuredContent.data;
    });
  }finally{await client.close();}
}
async function fixture(t,options={}){
  const root=await mkdtemp(path.join(tmpdir(),'mioon-comfy-wire-')),comfy=await startComfyFixture({hold:true,...options});
  let server;
  t.after(async()=>{await server?.close();await comfy.close();await rm(root,{recursive:true,force:true});});
  // Production transport: no fake connector, httpRequest, settings or service.
  server=await startServer({dataDir:root,port:0,token});
  const f={root,comfy,get server(){return server;},get env(){return{MIOON_BASE_URL:server.url,MIOON_TOKEN:token};},get client(){return createClient({env:f.env});},
    async request(route,{method='GET',input,authenticated=true,headers={}}={}){
      const response=await fetch(server.url+route,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',...(authenticated?{Authorization:`Bearer ${token}`}:{ }),...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
      const body=await response.json();publicOnly(body,root);return {status:response.status,body};
    },
    async rpc(operation,input={}){const value=await f.request('/api/rpc',{method:'POST',input:{operation,input}});assert.equal(value.status,200,JSON.stringify(value.body));assert.equal(value.body.ok,true);return value.body.data;},
    async configure(){
      const check=await f.request('/api/images/comfy-check',{method:'POST',input:{baseUrl:comfy.baseUrl}});assert.equal(check.status,200,JSON.stringify(check.body));assert.deepEqual(check.body.data.checkpoints,[model]);
      const configuration={...DEFAULT_COMFY_IMAGE_CONFIGURATION,enabled:true,baseUrl:comfy.baseUrl,model};
      const saved=await f.request('/api/images/comfy-settings',{method:'PUT',input:{expectedRevision:0,configuration}});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.readiness.checked,true);return saved.body.data;
    },
    async approve(review){const result=await f.request('/api/images/reviews/approve',{method:'POST',input:{projectId:review.projectId,reviewId:review.id,expectedRevision:1}});assert.equal(result.status,200,JSON.stringify(result.body));return result.body.data;},
    task(ack){return f.rpc('image.task.get',{projectId:ack.projectId,taskId:ack.id});},
    remote(ack){return f.rpc('image.task.remote.get',{projectId:ack.projectId,taskId:ack.id});},
    async until(read,predicate){const end=Date.now()+10000;let value;while(Date.now()<end){value=await read();if(predicate(value))return value;await pause(10);}assert.fail(`Synthetic local state did not settle: ${JSON.stringify(value)}`);},
    async asset(task){const versions=await f.rpc('image.version.list',{projectId:task.projectId,groupId:task.groupId});assert.equal(versions.items.length,1);const version=versions.items[0];
      const response=await fetch(`${server.url}/media/${version.assetId}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());
      assert.deepEqual(bytes,comfy.png);assert.equal(version.sha256,sha(bytes));assert.equal(version.width,512);assert.equal(version.height,512);assert.equal(version.providerId,'comfy-local');assert.equal(version.isMock,false);
      assert.deepEqual(await readFile(path.join(root,'media',`${version.assetId}.png`)),bytes);return version;},
    async restart(){await server.close();server=await startServer({dataDir:root,port:0,token});},
  };
  return f;
}
const inputFor=projectId=>({projectId,requestId:randomUUID(),name:'Synthetic local Comfy image',providerId:'comfy-local',model,prompt:'  Exact synthetic fox\nunder the moon. 中文  ',options:COMFY_IMAGE_OPTIONS});

test('real loopback Comfy protocol crosses production HTTP, CLI and official MCP without automatic generation or observation retries',{timeout:120000},async t=>{
  const f=await fixture(t),project=await f.rpc('project.create',{name:'Comfy transport acceptance'});
  assert.deepEqual(f.comfy.counts(),{posts:0,jobs:0,views:0,all:0});
  for(const route of ['/api/images/comfy-settings','/api/images/comfy-check'])assert.equal((await f.request(route,{authenticated:false,method:route.endsWith('check')?'POST':'GET',input:route.endsWith('check')?{}:undefined})).status,401);
  assert.equal((await f.request('/api/images/comfy-settings',{headers:{Origin:'http://attacker.invalid'}})).status,403);
  await f.configure();assert.deepEqual(f.comfy.calls.map(c=>c.path),['/system_stats',...COMFY_NODE_CLASSES.map(name=>`/object_info/${name}`)]);
  const configCounts=f.comfy.counts();await f.request('/api/images/comfy-settings');await f.rpc('image.profile.list');assert.deepEqual(f.comfy.counts(),configCounts);
  const input=inputFor(project.id),prepared={input,settingsRevision:1};
  const review=await cli('image.review.prepare',prepared,f.env);assert.equal(review.execution.graph['3'].inputs.text,input.prompt);assert.equal(review.execution.graphHash,hashComfyWorkflow(review.execution.graph));
  assert.deepEqual(await cli('image.review.get',{projectId:project.id,reviewId:review.id},f.env),review);assert.deepEqual(f.comfy.counts(),configCounts);
  await withMcp(f,async call=>assert.deepEqual(await call('image.review.prepare',prepared),review));
  const ack=await f.approve(review);await f.until(()=>f.task(ack),task=>task.state==='receiving');
  assert.deepEqual(f.comfy.counts(),{posts:1,jobs:0,views:0,all:8});
  const submitted=f.comfy.calls.find(c=>c.method==='POST').body;
  assert.equal(submitted.prompt_id,review.execution.promptId);assert.equal(submitted.client_id,review.execution.clientId);assert.deepEqual(submitted.prompt,review.execution.graph);assert.equal(submitted.extra_data.mioon.outputNonce,review.execution.outputNonce);
  assert.deepEqual(await f.approve(review),ack);assert.deepEqual(await cli('image.generate',input,f.env),ack);
  await withMcp(f,async call=>{assert.deepEqual(await call('image.generate',input),ack);const value=await call('image.task.remote.get',{projectId:project.id,taskId:ack.id});assert.equal(value.remote.contentVerified,false);});
  const beforeRestart=f.comfy.counts();await f.restart();await pause(30);assert.deepEqual(f.comfy.counts(),beforeRestart);assert.equal((await f.task(ack)).state,'outcome_unknown');assert.equal((await f.request('/api/images/comfy-settings')).body.data.readiness.checked,false);
  let remote=await f.remote(ack);
  const firstObservation={projectId:project.id,taskId:ack.id,requestId:randomUUID(),expectedRevision:remote.remote.revision};
  const firstAck=await cli('image.task.observeRemote',firstObservation,f.env);
  remote=await f.until(()=>f.remote(ack),value=>value.observation?.state==='finished');assert.equal(remote.remote.state,'queued');assert.equal(remote.remote.contentVerified,false);assert.equal(f.comfy.counts().jobs,1);assert.equal(f.comfy.counts().views,0);
  await withMcp(f,async call=>{assert.deepEqual(await call('image.task.observeRemote',firstObservation),firstAck);assert.deepEqual(await call('image.task.remote.get',{projectId:project.id,taskId:ack.id}),remote);});
  assert.deepEqual(await cli('image.task.observeRemote',firstObservation,f.env),firstAck);assert.equal(f.comfy.counts().jobs,1);
  f.comfy.complete(review.execution.promptId);
  const secondObservation={projectId:project.id,taskId:ack.id,requestId:randomUUID(),expectedRevision:remote.remote.revision};
  const secondAck=await f.rpc('image.task.observeRemote',secondObservation);const finished=await f.until(()=>f.task(ack),task=>task.state==='succeeded');
  remote=await f.until(()=>f.remote(ack),value=>value.observation?.state==='finished');assert.equal(remote.remote.contentVerified,true);assert.equal(remote.remote.state,'completed');assert.equal(remote.remote.resultSha256,sha(f.comfy.png));
  const version=await f.asset(finished);assert.equal(version.sha256,remote.remote.resultSha256);assert.deepEqual(f.comfy.counts(),{posts:1,jobs:2,views:1,all:11});
  await withMcp(f,async call=>assert.deepEqual(await call('image.task.observeRemote',secondObservation),secondAck));
  const finishedCounts=f.comfy.counts();await f.restart();assert.deepEqual(await f.task(ack),finished);assert.deepEqual(await cli('image.generate',input,f.env),ack);assert.deepEqual(await f.rpc('image.task.observeRemote',secondObservation),secondAck);assert.deepEqual(await f.asset(finished),version);assert.deepEqual(f.comfy.counts(),finishedCounts);assert.deepEqual(f.comfy.errors,[]);
});

test('real socket lost POST acknowledgement is recovered only by explicit matching observation after restart',{timeout:60000},async t=>{
  const f=await fixture(t,{dropAck:true}),project=await f.rpc('project.create',{name:'Lost local Comfy ACK'});await f.configure();
  const input=inputFor(project.id),review=await f.rpc('image.review.prepare',{input,settingsRevision:1}),ack=await f.approve(review);
  await f.until(()=>f.task(ack),task=>task.state==='outcome_unknown');assert.equal((await f.remote(ack)).remote.state,'submission_unknown');assert.deepEqual(f.comfy.counts(),{posts:1,jobs:0,views:0,all:8});
  const counts=f.comfy.counts();await f.restart();assert.deepEqual(await f.approve(review),ack);assert.deepEqual(await cli('image.generate',input,f.env),ack);assert.deepEqual(f.comfy.counts(),counts);
  f.comfy.complete(review.execution.promptId);const remote=await f.remote(ack),observation={projectId:project.id,taskId:ack.id,requestId:randomUUID(),expectedRevision:remote.remote.revision};
  let observed;await withMcp(f,async call=>{observed=await call('image.task.observeRemote',observation);});
  const finished=await f.until(()=>f.task(ack),task=>task.state==='succeeded');await f.asset(finished);
  assert.deepEqual(await cli('image.task.observeRemote',observation,f.env),observed);assert.deepEqual(f.comfy.counts(),{posts:1,jobs:1,views:1,all:10});assert.deepEqual(f.comfy.errors,[]);
});
