import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {mediaEnvironment} from '../packages/business/src/media-environment.ts';
import {createClient,operationDefinition} from '@mioon/client';
import type {TestContext} from 'node:test';
type Loose = Record<string, unknown>;
interface CliEnvelope {code: number|null; signal: string|null; envelope: Loose}
const root=fileURLToPath(new URL('..',import.meta.url)),token='synthetic-backup-inspection-token-only';
const bounded=async<T>(promise: Promise<T>,label: string,ms=10000): Promise<T>=>{let timer: ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{if(timer)clearTimeout(timer);}};
async function cli(args: string[],env: NodeJS.ProcessEnv): Promise<CliEnvelope> {
 const child=spawn(process.execPath,['apps/cli/src/index.ts',...args],{cwd:root,env:{...mediaEnvironment(),...env} as Record<string,string>,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',error: Error|undefined;child.on('error',(value: Error)=>{error=value;});
 const closed=new Promise<{code: number|null; signal: string|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 child.stdout.setEncoding('utf8').on('data',(text: string)=>{stdout+=text;if(Buffer.byteLength(stdout)>256*1024){error=Error('CLI stdout bound');if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}});
 child.stderr.setEncoding('utf8').on('data',(text: string)=>{stderr+=text;if(Buffer.byteLength(stderr)>64*1024){error=Error('CLI stderr bound');if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');}});
 try{const end=await bounded(closed,'inspection CLI');if(error)throw error;assert.equal(end.signal,null);assert.equal(stdout.includes(token)||stderr.includes(token),false);return {...end,envelope:JSON.parse(stdout) as Loose};}
 finally{if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');const timer=setTimeout(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');},1000);try{await bounded(closed,'owned CLI cleanup',3000);}finally{clearTimeout(timer);}}}
}
test('actual authenticated HTTP, CLI and official MCP share exact non-path inspection and perform no DB writes',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'mioon-backup-inspect-wire-'));let server: Awaited<ReturnType<typeof startServer>>|undefined,db: DatabaseSync|undefined,client: Client|undefined,transport: StdioClientTransport|undefined;
 try{
  server=await startServer({dataDir:directory,port:0,token});db=new DatabaseSync(path.join(directory,'workbench.sqlite'),{readOnly:true});
  const capture=()=>db!.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map((value: unknown)=>{const name=(value as {name: string}).name;return [name,db!.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()];});
  const before=capture();
  const rpc=async(input: Loose,authenticated=true)=>{const response=await fetch(server!.url+'/api/rpc',{method:'POST',headers:{'content-type':'application/json',...(authenticated?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({operation:'workspace.backup.inspect',input})});return {status:response.status,envelope:await response.json() as Loose};};
  const result=await rpc({});assert.equal(result.status,200);assert.equal(result.envelope.ok,true);assert.equal((result.envelope.data as Loose).captureReady,false);
  assert.equal((await rpc({},false)).status,401);assert.equal((await rpc({source:'SYNTHETIC_PRIVATE_PATH'})).status,400);
  const env={MIOON_BASE_URL:server!.url,MIOON_TOKEN:token};const output=await cli(['workspace','backup','inspect'],env);assert.equal(output.code,0);assert.deepEqual(output.envelope,result.envelope);
  const schema=await cli(['schema','workspace.backup.inspect'],{});assert.equal(schema.code,0);assert.deepEqual(schema.envelope.data,operationDefinition('workspace.backup.inspect'));
  const invalid=await cli(['workspace','backup','inspect','--input','{"directory":"SYNTHETIC_PRIVATE_PATH"}'],env);assert.equal(invalid.code,2);assert.equal(invalid.envelope.ok,false);
  client=new Client({name:'backup-inspection-test',version:'1.0.0'},{capabilities:{}});
  transport=new StdioClientTransport({command:process.execPath,args:['apps/mcp/src/index.ts'],cwd:root,env:{...mediaEnvironment(),...env},stderr:'pipe'});let stderr='';
  (transport.stderr as unknown as NodeJS.ReadableStream|undefined)?.setEncoding('utf8').on('data',(text: string)=>{stderr=(stderr+text).slice(-65536);});
  await bounded(client.connect(transport),'MCP connect');const listed=await client.listTools();const tool=listed.tools.find((value: {name: string})=>value.name==='workspace_backup_inspect') as {annotations?: {readOnlyHint?: boolean}; inputSchema: {additionalProperties?: boolean}}|undefined;assert.ok(tool);assert.equal(tool.annotations?.readOnlyHint,true);assert.equal(tool.inputSchema.additionalProperties,false);
  assert.equal(listed.tools.some((value: {name: string})=>/^workspace_backup_(create|verify|restore)$/.test(value.name)),false);
  const called=await client.callTool({name:'workspace_backup_inspect',arguments:{}},undefined,{timeout:10000});assert.deepEqual(called.structuredContent,result.envelope);assert.equal(stderr.includes(token),false);
  assert.deepEqual(capture(),before,'no schema, journal, task, counter, receipt or project writes');
 }finally{if(client)await bounded(client.close(),'MCP close');if(transport)await transport.close();db?.close();await server?.close();rmSync(directory,{recursive:true,force:true});}
});
test('shared client refuses malformed inspection ACK without implying an uncertain mutation',async()=>{
 const client=createClient({env:{MIOON_BASE_URL:'http://127.0.0.1:4318',MIOON_TOKEN:token},fetchImpl:async()=>new Response(JSON.stringify({ok:true,data:{captureReady:true,source:'/private'}}),{status:200,headers:{'content-type':'application/json'}})});
 await assert.rejects(client.rpc('workspace.backup.inspect',{}),(error: unknown)=>{const view=error as {code?: string; details?: {submissionMayHaveSucceeded?: boolean}};return view.code==='BACKEND_PROTOCOL_ERROR'&&!view.details?.submissionMayHaveSucceeded;});
});
