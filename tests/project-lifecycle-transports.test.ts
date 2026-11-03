







import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';



import {startServer} from '../apps/server/src/index.ts';
const repo=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);

test('HTTP, CLI and MCP share real registry rename CAS and exact receipts',{timeout:60000},async (t: test.TestContext)=>{
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-project-wire-'))),token='synthetic-project-lifecycle-token';
  const server=await startServer({dataDir:root,port:0,token}),client=new Client({name:'project-lifecycle-test',version:'1'},{capabilities:{}});
  t.after(async()=>{await client.close();await server.close();rmSync(root,{recursive:true,force:true});});
  const env={PATH:process.env.PATH||'',MIOON_BASE_URL:server.url,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0'},transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env,stderr:'pipe'});(transport.stderr as import("node:stream").Readable|null)?.resume();await client.connect(transport);
  const http=async(operation: string,input={})=>{const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({operation,input})}),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.ok,true);return body.data;};
  const cli=async(operation: string,input: { requestId: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; expectedRevision: unknown; name?: string; confirmPermanentDeletion?: boolean; })=>{const result=await run(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...operation.split('.'),'--input',JSON.stringify(input)],{cwd:repo,env,timeout:20000});const body=JSON.parse(result.stdout);assert.equal(body.ok,true,JSON.stringify(body));return body.data;};
  const mcp=async(operation: string,input: { requestId: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; expectedRevision: unknown; name?: string; confirmPermanentDeletion?: boolean; })=>{const result=(await client.callTool({name:operation.replaceAll('.','_'),arguments:input}) as import("@modelcontextprotocol/sdk/types.js").CallToolResult);assert.equal(result.isError,false,JSON.stringify(result));return result.structuredContent!.data;};
  const project=await http('project.create',{name:'Original'}),rename={requestId:randomUUID(),projectId:project.id,expectedRevision:1,name:'Renamed through CLI'},renamed=await cli('project.rename',rename);
  assert.equal(renamed.name,rename.name);assert.deepEqual(await mcp('project.rename',rename),renamed);assert.deepEqual(await http('project.rename',rename),renamed);
  const listed=await http('project.list');assert.equal(listed[0].id,project.id);assert.equal(listed[0].name,rename.name);
  const denied=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({operation:'project.delete',input:{requestId:randomUUID(),projectId:project.id,expectedRevision:renamed.revision,confirmPermanentDeletion:true}})});
  assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'PROJECT_DELETE_UNAVAILABLE');
  assert.deepEqual(await http('project.list'),listed);
  const tools=(await client.listTools()).tools;assert.equal(tools.find(value=>value.name==='project_delete')!.annotations!.destructiveHint,true);assert.equal(tools.find(value=>value.name==='project_delete')!.annotations!.idempotentHint,true);
});


