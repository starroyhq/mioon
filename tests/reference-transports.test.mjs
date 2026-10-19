import test from 'node:test';
import assert from 'node:assert/strict';
import {assertClientRecoveryError} from './recovery-transport-assertions.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {crc32,deflateSync} from 'node:zlib';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const repo=fileURLToPath(new URL('..',import.meta.url)),token='references-offline-synthetic-test-token';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function environment(extra={}){const env={...process.env};for(const name of Object.keys(env))if(/^(MIOON_|MIOON_|ARK_|VEO_|RUNWAY|MINIMAX_|VIDU_|GEMINI_|GOOGLE_)/.test(name))delete env[name];return {...env,MIOON_ENABLE_LIVE_PROVIDER:'0',...extra};}
async function cli(args,env={},error){
 const child=spawn(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],{cwd:repo,env:environment(env),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',b=>stdout+=b);child.stderr.setEncoding('utf8').on('data',b=>stderr+=b);const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);let code,signal;try{[code,signal]=await once(child,'close');}finally{clearTimeout(timeout);}
 assert.equal(signal,null,stderr);assert.equal(stdout.trim().split('\n').length,1);const body=JSON.parse(stdout);assert.equal(body.ok,!error,stdout+stderr);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
 if(error){assert.equal(body.error.code,error);assert.equal(code,error==='VALIDATION_ERROR'?2:3);return body.error;}assert.equal(code,0,stderr);return body.data;
}
async function mcp(t,env={}){
 const client=new Client({name:'reference-parity-qa',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:environment(env),stderr:'pipe'});transport.stderr?.resume();t.after(()=>client.close());await client.connect(transport);
 return {client,async call(name,input={},error){const result=await client.callTool({name,arguments:input}),body=JSON.parse(result.content.find(item=>item.type==='text').text);assert.deepEqual(result.structuredContent,body);assert.equal(Boolean(result.isError),Boolean(error));assert.equal(body.ok,!error,JSON.stringify(body));if(error){assert.equal(body.error.code,error);return body.error;}return body.data;}};
}
const validAttach=()=>({projectId:randomUUID(),sourceNodeId:randomUUID(),targetShotId:randomUUID(),expectedSourceRevision:1,expectedShotRevision:1,requestId:randomUUID(),role:'first_frame'});
const validDetach=()=>({projectId:randomUUID(),edgeId:randomUUID(),expectedShotRevision:1,requestId:randomUUID()});
test('reference CLI and official MCP expose the same strict contracts and caller-owned request identities',{timeout:60000},async t=>{
 const client=await mcp(t),catalog=await cli(['schema']),tools=(await client.client.listTools()).tools;
 for(const [operation,valid] of [['reference.attach',validAttach()],['reference.detach',validDetach()]]){
  const schema=await cli(['schema',operation]),tool=tools.find(item=>item.name===operation.replaceAll('.','_'));
  assert.deepEqual(schema,catalog.operations.find(item=>item.operation===operation));assert.deepEqual(await client.call('mioon_schema',{operation}),schema);assert.ok(tool);assert.deepEqual(tool.inputSchema,schema.inputSchema);
  assert.equal(schema.requiresRequestId,true);assert.equal(schema.inputSchema.additionalProperties,false);assert.equal(tool.annotations.idempotentHint,true);assert.equal(tool.annotations.readOnlyHint,false);assert.equal(tool.annotations.openWorldHint,false);assert.equal(tool.annotations.destructiveHint,operation==='reference.detach');
  assert.deepEqual([...schema.inputSchema.required].sort(),Object.keys(valid).sort());
  const invalid=[...Object.keys(valid).map(key=>Object.fromEntries(Object.entries(valid).filter(([name])=>name!==key))),{...valid,unexpected:true},{...valid,projectId:'bad-uuid'},{...valid,expectedShotRevision:0},{...valid,expectedShotRevision:'1'},{...valid,requestId:'short'},...(operation==='reference.attach'?[{...valid,role:'last_frame'},{...valid,expectedSourceRevision:1.5}]:[])];
  for(const input of invalid){const a=await cli([...operation.split('.'),'--input',JSON.stringify(input)],{},'VALIDATION_ERROR'),b=await client.call(tool.name,input,'VALIDATION_ERROR');assert.deepEqual(b,a);}
  await cli([...operation.split('.'),'--input',JSON.stringify(valid),'--request-id','different-stable-key'],{},'VALIDATION_ERROR');
 }
});

async function backend(t){
 const root=await mkdtemp(path.join(tmpdir(),'wb-reference-transport-'));let child,url,port=0;
 async function stop(){if(!child||child.exitCode!==null||child.signalCode)return;const end=once(child,'exit');child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),10000);try{await end;}finally{clearTimeout(timeout);}}
 async function start(){let stdout='',stderr='';child=spawn(process.execPath,[path.join(repo,'apps/server/src/cli.ts')],{cwd:repo,env:environment({MIOON_DATA_DIR:root,MIOON_TOKEN:token,PORT:String(port)}),stdio:['ignore','pipe','pipe']});child.stdout.setEncoding('utf8').on('data',b=>stdout+=b);child.stderr.setEncoding('utf8').on('data',b=>stderr+=b);const deadline=Date.now()+10000;while(Date.now()<deadline){assert.equal(child.exitCode,null,stderr);const ready=/Mioon ready at (http:\/\/127\.0\.0\.1:(\d+))/.exec(stdout);if(ready){url=ready[1];port=Number(ready[2]);assert.equal((await fetch(url+'/health')).status,200);return child.pid;}await pause(25);}throw Error(stderr||'Backend did not start');}
 t.after(async()=>{await stop();await rm(root,{recursive:true,force:true});});await start();
 return {root,get url(){return url;},get pid(){return child.pid;},get env(){return {MIOON_BASE_URL:url,MIOON_TOKEN:token};},restart:async()=>{await stop();return start();},async http(operation,input,error,status=409){const response=await fetch(url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})}),body=await response.json();assert.equal(response.status,error?status:200,JSON.stringify(body));assert.equal(body.ok,!error,JSON.stringify(body));if(error){assert.equal(body.error.code,error);return body.error;}return body.data;}};
}
function imageBytes(){const chunk=(name,data)=>{const body=Buffer.concat([Buffer.from(name),data]),h=Buffer.alloc(4),f=Buffer.alloc(4);h.writeUInt32BE(data.length);f.writeUInt32BE(crc32(body));return Buffer.concat([h,body,f]);};const h=Buffer.alloc(13);h.writeUInt32BE(36);h.writeUInt32BE(64,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.alloc((36*3+1)*64))),chunk('IEND',Buffer.alloc(0))]);}
test('CLI attach, MCP detach, HTTP replay and real backend restart retain one durable result',{timeout:60000},async t=>{
 const f=await backend(t),client=await mcp(t,f.env),project=await f.http('project.create',{name:'Cross-transport synthetic references'}),projectId=project.id;
 const asset=await f.http('asset.import',{projectId,name:'Locally generated.png',mimeType:'image/png',dataBase64:imageBytes().toString('base64')}),node=await f.http('node.create',{projectId,type:'image',assetId:asset.id,position:{x:20,y:20}}),shot=await f.http('shot.create',{projectId,title:'Reference parity target',prompt:'Synthetic pixels only'});
 const input={projectId,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,requestId:randomUUID(),role:'first_frame'};
 const added=await cli(['reference','attach','--input',JSON.stringify(input)],f.env);assert.equal(added.edge.kind,'reference');assert.deepEqual(added.shot.referenceAssetIds,[asset.id]);assert.deepEqual(await client.call('reference_attach',input),added);assert.deepEqual(await f.http('reference.attach',input),added);
 let snapshot=await f.http('project.get',{projectId});assert.equal(snapshot.edges.length,1);assert.equal(snapshot.shots[0].revision,shot.revision+1);
 const stale={...input,requestId:randomUUID()},httpConflict=await f.http('reference.attach',stale,'REVISION_CONFLICT');assertClientRecoveryError(await client.call('reference_attach',stale,'REVISION_CONFLICT'),httpConflict,{operation:'reference.attach',input:stale});assertClientRecoveryError(await cli(['reference','attach','--input',JSON.stringify(stale)],f.env,'REVISION_CONFLICT'),httpConflict,{operation:'reference.attach',input:stale});
 const remove={projectId,edgeId:added.edge.id,expectedShotRevision:added.shot.revision,requestId:randomUUID()},removed=await client.call('reference_detach',remove);assert.equal(removed.detached,true);assert.deepEqual(removed.shot.referenceAssetIds,[]);
 const before=await f.http('project.get',{projectId}),pid=f.pid;assert.notEqual(await f.restart(),pid);assert.deepEqual(await f.http('project.get',{projectId}),before);
 for(const [operation,params,result] of [['reference.attach',input,added],['reference.detach',remove,removed]]){assert.deepEqual(await f.http(operation,params),result);assert.deepEqual(await cli([...operation.split('.'),'--input',JSON.stringify(params)],f.env),result);assert.deepEqual(await client.call(operation.replaceAll('.','_'),params),result);}
 assert.deepEqual(await f.http('project.get',{projectId}),before);
 const conflict={...remove,requestId:input.requestId};await f.http('reference.detach',conflict,'IDEMPOTENCY_CONFLICT');await client.call('reference_detach',conflict,'IDEMPOTENCY_CONFLICT');await cli(['reference','detach','--input',JSON.stringify(conflict)],f.env,'IDEMPOTENCY_CONFLICT');
 snapshot=await f.http('project.get',{projectId});assert.deepEqual(snapshot,before);assert.equal(snapshot.assets.length,1);assert.equal(snapshot.nodes.length,1);assert.equal(snapshot.jobs.length,0);
});
