import type {TypedStore} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {openStore} from '../packages/business/src/db.ts';
const repo=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);

test('HTTP, CLI and MCP share rename CAS and permanent-delete receipts',{timeout:60000},async (t: test.TestContext)=>{
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-project-wire-'))),token='synthetic-project-lifecycle-token';
  const server=await startServer({dataDir:root,port:0,token}),client=new Client({name:'project-lifecycle-test',version:'1'},{capabilities:{}});
  t.after(async()=>{await client.close();await server.close();rmSync(root,{recursive:true,force:true});});
  const env={PATH:process.env.PATH||'',MIOON_BASE_URL:server.url,MIOON_TOKEN:token,MIOON_ENABLE_LIVE_PROVIDER:'0'},transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'apps/mcp/src/index.ts')],cwd:repo,env,stderr:'pipe'});(transport.stderr as import("node:stream").Readable|null)?.resume();await client.connect(transport);
  const http=async(operation: string,input={})=>{const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({operation,input})}),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.ok,true);return body.data;};
  const cli=async(operation: string,input: { requestId: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; expectedRevision: unknown; name?: string; confirmPermanentDeletion?: boolean; })=>{const result=await run(process.execPath,[path.join(repo,'apps/cli/src/index.ts'),...operation.split('.'),'--input',JSON.stringify(input)],{cwd:repo,env,timeout:20000});const body=JSON.parse(result.stdout);assert.equal(body.ok,true,JSON.stringify(body));return body.data;};
  const mcp=async(operation: string,input: { requestId: `${string}-${string}-${string}-${string}-${string}`; projectId: unknown; expectedRevision: unknown; name?: string; confirmPermanentDeletion?: boolean; })=>{const result=(await client.callTool({name:operation.replaceAll('.','_'),arguments:input}) as import("@modelcontextprotocol/sdk/types.js").CallToolResult);assert.equal(result.isError,false,JSON.stringify(result));return result.structuredContent!.data;};
  const project=await http('project.create',{name:'Original'}),rename={requestId:randomUUID(),projectId:project.id,expectedRevision:1,name:'Renamed through CLI'},renamed=await cli('project.rename',rename);
  assert.equal(renamed.name,rename.name);assert.deepEqual(await mcp('project.rename',rename),renamed);assert.deepEqual(await http('project.rename',rename),renamed);
  const input={requestId:randomUUID(),projectId:project.id,expectedRevision:renamed.revision,confirmPermanentDeletion:true},deleted=await mcp('project.delete',input);
  assert.deepEqual(deleted,{requestId:input.requestId,projectId:project.id,deleted:true,cleanup:'complete'});assert.deepEqual(await cli('project.delete',input),deleted);assert.deepEqual(await http('project.delete',input),deleted);
  assert.deepEqual((await http('project.summary.list') as unknown),[]);
  const second=await http('project.create',{name:'Delete over HTTP'}),secondInput={requestId:randomUUID(),projectId:second.id,expectedRevision:1,confirmPermanentDeletion:true};assert.equal((await http('project.delete',secondInput)).cleanup,'complete');
  const third=await http('project.create',{name:'Delete over CLI'});assert.equal((await cli('project.delete',{...secondInput,requestId:randomUUID(),projectId:third.id})).cleanup,'complete');
  const tools=(await client.listTools()).tools;assert.equal(tools.find(value=>value.name==='project_delete')!.annotations!.destructiveHint,true);assert.equal(tools.find(value=>value.name==='project_delete')!.annotations!.idempotentHint,true);
});

test('SIGKILL after the delete commit leaves a durable cleanup manifest that ordinary server startup resumes',{timeout:60000},async (t: test.TestContext)=>{
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'mioon-project-kill-'))),projectId=randomUUID(),assetId=randomUUID(),requestId=randomUUID(),relativePath=`media/${assetId}.png`,file=path.join(root,relativePath);let store=(openStore(root) as TypedStore);
  store.put('projects',{id:projectId,name:'Private terminal project',description:'',revision:1,createdAt:'2026-10-19T00:00:00.000Z',updatedAt:'2026-10-19T00:00:00.000Z'});store.put('assets',{id:assetId,projectId,name:'Managed file',relativePath,sha256:'a'.repeat(64),mimeType:'image/png',createdAt:'2026-10-19T00:00:00.000Z'});writeFileSync(file,'exclusive managed bytes',{mode:0o600});store.close();
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=`import {existsSync} from 'node:fs';import path from 'node:path';
import {openStore,ownsStoreLock,getWorkspaceRestoreContext} from './packages/business/src/db.ts';
import {createProjectLifecycleServices} from './packages/business/src/project-lifecycle.ts';
import {validateManagedFile,validateManagedDirectory} from '@mioon/contracts/private-storage';
const root=process.env.PROJECT_TEST_ROOT,store=openStore(root);
const service=createProjectLifecycleServices(store,{storage:{validateManagedFile,validateManagedDirectory},ownsLock:()=>ownsStoreLock(store),isReadOnly:()=>Boolean(getWorkspaceRestoreContext(store)),assertIdle(){},fault(point){if(point==='afterCommit')process.kill(process.pid,'SIGKILL');}});
service.setProjectDeletionCompanions({assertDeletable(){for(const name of ['local-drafts-v1.json','local-delivery-v1.json','local-shot-text-v1.json'])if(existsSync(path.join(root,name)))throw Error('unexpected companion fixture');},removeProject(){throw Error('crash must precede cleanup');}});
service.handlers['project.delete']({requestId:process.env.PROJECT_TEST_REQUEST,projectId:process.env.PROJECT_TEST_ID,expectedRevision:1,confirmPermanentDeletion:true});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:repo,env:{PATH:process.env.PATH||'',PROJECT_TEST_ROOT:root,PROJECT_TEST_ID:projectId,PROJECT_TEST_REQUEST:requestId},stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});const outcome=await once(child,'exit');assert.equal(outcome[1],'SIGKILL',stderr);assert.equal(existsSync(file),true);
  // A cold observer proves the commit independently before normal startup.
  store=(openStore(root) as TypedStore);assert.equal(store.get('projects',projectId),null);assert.equal(store.db.prepare('SELECT count(*) n FROM project_deletion_scope').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM project_deletion_cleanup').get()!.n,1);store.close();
  const token='synthetic-project-recovery-token',server=await startServer({dataDir:root,port:0,token});try{
    assert.equal(existsSync(file),false);const response=await fetch(server.url+'/api/rpc',{method:'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({operation:'project.delete',input:{requestId,projectId,expectedRevision:1,confirmPermanentDeletion:true}})});assert.equal(response.status,200);assert.equal((await response.json()).data.cleanup,'complete');
  }finally{await server.close();}
});
