import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';

const repo=fileURLToPath(new URL('..',import.meta.url)),operation='timeline.clip.rippleRemove';
const token='ripple-transports-synthetic-token';
const execute=promisify(execFile),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const request=timeline=>({projectId:timeline.projectId,expectedRevision:timeline.revision,requestId:randomUUID()});

test('ripple HTTP durable tasks, actual CLI and official MCP agree on strict schema, undo and exact replay', {timeout:90000},async t=>{
 const root=await mkdtemp(path.join(await realpath(tmpdir()),'mioon-ripple-transports-'));
 const env={...mediaEnvironment(process.env),MIOON_ENABLE_LIVE_PROVIDER:'0'};
 const store=openStore(root),services=createServices(store,new Map());
 const projectId=(await services.call('project.create',{name:'Ripple transports'})).id,assetId=randomUUID();
 store.put('assets',{id:assetId,projectId,name:'Synthetic image',mimeType:'image/png',width:720,height:1280,sha256:'a'.repeat(64),relativePath:`media/${assetId}.fixture`});
 let timeline=await services.call('timeline.get',{projectId});
 for(const startFrame of [0,30])timeline=await services.call('timeline.clip.add',{...request(timeline),assetId,trackId:timeline.tracks[0].id,startFrame,durationFrames:10});
 const clipId=timeline.clips[0].id,following=timeline.clips[1].id;store.close();
 const backend=spawn(process.execPath,[path.join(repo,'apps/server/src/cli.ts')],{cwd:repo,env:{...env,MIOON_DATA_DIR:root,PORT:'0',MIOON_TOKEN:token},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';
 backend.stdout.setEncoding('utf8').on('data',value=>stdout+=value);backend.stderr.setEncoding('utf8').on('data',value=>stderr+=value);
 t.after(async()=>{
  if(backend.exitCode===null&&backend.signalCode===null){const done=once(backend,'exit');backend.kill('SIGTERM');const timer=setTimeout(()=>backend.kill('SIGKILL'),10000);try{await done;}finally{clearTimeout(timer);}}
  await rm(root,{recursive:true,force:true});
 });
 let url;const deadline=Date.now()+15000;
 while(Date.now()<deadline){assert.equal(backend.exitCode,null,stderr);const match=/Mioon ready at (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout);if(match){url=match[1];break;}await pause(25);}
 assert.ok(url,'owned backend starts before deadline');
 const connection={...env,MIOON_BASE_URL:url,MIOON_TOKEN:token};
 async function post(route,body){const response=await fetch(url+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.ok,true);return result.data;}
 const http=(op,input)=>post('/api/rpc',{operation:op,input});
 async function cli(op,input){const args=op==='schema'?['schema',operation]:[...op.split('.'),'--input',JSON.stringify(input)];const output=await execute(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...args],{cwd:repo,env:connection,timeout:15000,maxBuffer:4*1024*1024});assert.ok(!output.stdout.includes(token));const body=JSON.parse(output.stdout);assert.equal(body.ok,true);return body.data;}
 const mcp=new Client({name:'ripple-tests',version:'1.0.0'},{capabilities:{}}),transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:connection,stderr:'pipe'});
 transport.stderr?.resume();t.after(()=>mcp.close());await mcp.connect(transport);
 const schema=await cli('schema'),tool=(await mcp.listTools()).tools.find(item=>item.name==='timeline_clip_rippleRemove');
 assert.ok(tool);assert.deepEqual(tool.inputSchema,schema.inputSchema);assert.equal(tool.annotations.idempotentHint,true);assert.equal(tool.inputSchema.additionalProperties,false);
 const intent={...request(timeline),clipId},prepared=await post('/api/tasks/prepare',{projectId,operation,input:intent,origin:'new'});
 assert.equal(prepared.task.status,'prepared');assert.equal(prepared.task.operation,operation);
 const done=await post(`/api/tasks/${prepared.task.id}/execute`,{projectId,digest:prepared.task.digest,instanceId:prepared.instanceId});
 assert.equal(done.task.status,'applied');timeline=done.result;assert.equal(timeline.clips.find(c=>c.id===following).startFrame,20);
 assert.deepEqual(await cli(operation,intent),timeline,'CLI replays the exact durable result without a second ripple');
 timeline=await http('timeline.undo',request(timeline));assert.equal(timeline.clips.find(c=>c.id===following).startFrame,30);
 const cliIntent={...request(timeline),clipId};timeline=await cli(operation,cliIntent);assert.equal(timeline.clips.find(c=>c.id===following).startFrame,20);
 timeline=await http('timeline.undo',request(timeline));
 const mcpIntent={...request(timeline),clipId},reply=await mcp.callTool({name:'timeline_clip_rippleRemove',arguments:mcpIntent});
 const body=JSON.parse(reply.content.find(block=>block.type==='text').text);assert.equal(body.ok,true);timeline=body.data;
 assert.equal(timeline.clips.find(c=>c.id===following).startFrame,20);assert.deepEqual(await http(operation,mcpIntent),timeline);
 assert.ok(!stdout.includes(token));assert.ok(!stderr.includes(token));
});
