import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from './helpers/test-server.ts';
import {projectLocation, serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {openProjectStore} from '../packages/business/src/project-file/store.ts';
import {freezeStoryboardOutputGeometry} from '../packages/business/src/storyboard-output.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
import applicationPackage from '../package.json' with {type: 'json'};
const run=promisify(execFile),repo=fileURLToPath(new URL('../',import.meta.url));
test('home summaries agree over HTTP and CLI while MCP rejects cross-project listing without HTTP; preferences survive restart',{timeout:60000},async (t: test.TestContext)=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-home-wire-')),token='synthetic-home-transports-token';let server=await startServer({dataDir:root,port:0,token});const client=new Client({name:'home-offline-test',version:'1'},{capabilities:{}});
 let mcpHttpRequests=0;
 const mcpBackend=createServer((_request,response)=>{mcpHttpRequests++;response.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:{code:'INTERNAL_ERROR'}}));});
 await new Promise<void>(resolve=>mcpBackend.listen(0,'127.0.0.1',resolve));
 const mcpAddress=mcpBackend.address();assert.ok(mcpAddress&&typeof mcpAddress!=='string');
 t.after(async()=>{await client.close();mcpBackend.closeAllConnections();await new Promise<void>((resolve,reject)=>mcpBackend.close(error=>error?reject(error):resolve()));await server.close();await rm(root,{recursive:true,force:true});});
 const request=async(url: string,input?: unknown,method=input?'POST':'GET')=>{const response=await fetch(server.url+url,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value.data;};
 const rpc=(operation: string,input={})=>request('/api/rpc',{operation,input}),project=await rpc('project.create',{name:'Wide',timelinePresetId:'landscape_1080'});
 const env={PATH:process.env.PATH||'',MIOON_BASE_URL:server.url,MIOON_TOKEN:token,};
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env:{...env,MIOON_BASE_URL:`http://127.0.0.1:${mcpAddress.port}`},stderr:'ignore'}));
 const summary=await rpc('project.summary.list'),cli=await run(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),'project','summary','list','--input','{}'],{cwd:repo,env,timeout:15000});assert.deepEqual(JSON.parse(cli.stdout).data,summary);assert.deepEqual([summary[0].width,summary[0].height],[1920,1080]);
 assert.equal((await client.listTools()).tools.some(tool=>tool.name==='project_summary_list'),false);
 const denied=await client.callTool({name:'project_summary_list',arguments:{}});
 assert.equal(denied.isError,true);assert.equal((denied.structuredContent as {error:{code:string}}).error.code,'UNKNOWN_OPERATION');assert.equal(mcpHttpRequests,0);
 const before=await request('/api/ui-preferences'),put={expectedRevision:before.revision,requestId:randomUUID(),preferences:{...before.preferences,theme:'light',homeView:'list',homeSort:'name',scalePercent:110}};
 const saved=await request('/api/ui-preferences',put,'PUT');assert.deepEqual(await request('/api/ui-preferences',put,'PUT'),saved);const opened=await request('/api/ui-preferences/opened',{projectId:project.id});assert.equal(opened.revision,saved.revision);assert.ok(opened.recentOpened[project.id]);
 const info=await request('/api/workspace-info');assert.equal(info.dataDirectory,root);assert.equal(info.version,applicationPackage.version);assert.equal(info.channel,'web');
 await client.close();await server.close();server=await startServer({dataDir:root,port:0,token});const restarted=await request('/api/ui-preferences');assert.deepEqual(restarted,opened);assert.equal((await rpc('project.summary.list'))[0].lastOpenedAt,opened.recentOpened[project.id]);
});

test('format 6 inspection and the recent-project summary return the saved clock across transports', {timeout:60000}, async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-home-fps-wire-')), token='synthetic-home-fps-wire-token';
 const prior=process.env.MIOON_FORMAT6_DEV;
 process.env.MIOON_FORMAT6_DEV='1';
 t.after(async()=>{
  if(prior===undefined)delete process.env.MIOON_FORMAT6_DEV;
  else process.env.MIOON_FORMAT6_DEV=prior;
  await rm(root,{recursive:true,force:true});
 });
 const server=await startServer({dataDir:root,port:0,token,localDraftChannel:'development',projectFormatForTest:undefined});
 const client=new Client({name:'format-six-inspection-test',version:'1'},{capabilities:{}});
 const env={PATH:process.env.PATH||'',MIOON_BASE_URL:server.url,MIOON_TOKEN:token};
 const rpc=async(operation:string,input:unknown,route='/api/rpc')=>{
  const response=await fetch(server.url+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body.data;
 };
 const project=await server.projectEntries.create({name:'25 fps workspace',timelineFps:25,timelinePresetId:'landscape_1080'});
 try{
  const input={projectId:project.projectId};
  const route=projectRpcPath(project.projectId);
  const timeline=await rpc('timeline.inspect',input,route);
  assert.deepEqual([timeline.fps,timeline.width,timeline.height],[25,1920,1080]);
  const [summary]=await rpc('project.summary.list',{});
  assert.deepEqual([summary.fps,summary.presetId],[25,'landscape_1080']);
  const cli=await run(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),'timeline','inspect','--input',JSON.stringify(input)],{cwd:repo,env,timeout:15000});
  assert.deepEqual(JSON.parse(cli.stdout).data,timeline);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env,stderr:'ignore'}));
  const tool=await client.callTool({name:'timeline_inspect',arguments:input});
  assert.deepEqual(tool.structuredContent,{ok:true,data:timeline});
  const nodeId=randomUUID();
  const preview=await rpc('sequence.preview',{...input,requestId:randomUUID(),
   previsIntent:{side:'board',operation:{kind:'previs-create',nodeId,label:'Opening',position:{x:20,y:30}}}},route);
  const committed=await rpc('sequence.commit',{...input,envelope:preview.envelope,expectedPlanDigest:preview.planDigest},route);
  assert.equal(committed.status,'applied');
  const thumbnails=await rpc('previs.thumbnail.get',{...input,nodeId,slots:['card'],framePresetId:'landscape_1080'},route);
  assert.deepEqual(thumbnails,{...input,nodeId,framePresetId:'landscape_1080',items:[]});
 }finally{
  await client.close();
  await server.close();
 }
 const store=openProjectStore({allowFormat6:true,projectFile:project.projectFile,locate:id=>projectLocation(serverAppDirectories(root),id)});
 try{assert.deepEqual(freezeStoryboardOutputGeometry(store.db,project.projectId),{fps:30,width:1920,height:1080});}
 finally{store.close();}
});
