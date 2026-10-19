import test, {type TestContext} from 'node:test';
import type {ChildProcess} from 'node:child_process';
import type {IncomingMessage, ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {discoverSchema,createClient,schemas} from '@mioon/client';
import {parse,isExportLoudnessResponse,effectAnnotations,operationEffect,EXPORT_LOUDNESS_PROFILE} from '@mioon/contracts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {callObservedRpc} from '../apps/server/src/rpc-observation.ts';
import {loudnessOperation as operation,loudnessInput as input,loudnessToken as token,readyLoudness,incompleteLoudness,loudnessTarget as target} from './fixtures/export-loudness-fixtures.ts';

const repo=fileURLToPath(new URL('..',import.meta.url));
interface CliBody {ok?: boolean; data?: unknown; error?: {code?: string; details?: Record<string, unknown>}}
interface FixtureCleanup {baseline: {request: number; response: number}; remaining: {request: number; response: number}}
interface TransportFixture {url: string; calls: Array<{operation: string; input: unknown}>; signals: Array<AbortSignal | undefined>; cleanups: FixtureCleanup[]; mode(value: string): void; entered(): Promise<unknown>; settled(): Promise<unknown>}
const env=(url?: string): Record<string, string>=>({PATH:process.env.PATH||'',MIOON_ENABLE_LIVE_PROVIDER:'0',...(url?{MIOON_BASE_URL:url,MIOON_TOKEN:token}:{})});
const deferred=<T = void>(): {promise: Promise<T>; resolve: (value: T) => void}=>{let resolve!: (value: T) => void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
async function bounded<T>(promise: Promise<T>,label: string,ms=10000): Promise<T>{let timer: ReturnType<typeof setTimeout> | undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{clearTimeout(timer);}}
function cli(t: TestContext,url: string | undefined,args: string[]): {child: ChildProcess; result: Promise<{code: number | null; body: CliBody}>}{
  const child=spawn(process.execPath,[repo+'apps/cli/src/index.ts',...args],{cwd:repo,env:env(url),stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',overflow=false;
  child.stdout?.setEncoding('utf8').on('data',(part: string)=>{stdout+=part;if(Buffer.byteLength(stdout)>1024*1024){overflow=true;child.kill('SIGKILL');}});
  child.stderr?.setEncoding('utf8').on('data',(part: string)=>{stderr+=part;if(Buffer.byteLength(stderr)>64*1024){overflow=true;child.kill('SIGKILL');}});
  const close=once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  t.after(async()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(close,'CLI cleanup');});
  const result=(async()=>{const [code,signal]=await close as [number | null, NodeJS.Signals | null];clearTimeout(timer);assert.equal(overflow,false);assert.equal(signal,null,stderr);
    assert.equal(stdout.trim().split('\n').length,1);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
    return {code,body:JSON.parse(stdout) as CliBody};})();
  return {child,result};
}
async function official(t: TestContext,url?: string): Promise<{client: Client; call: (name: string,args: Record<string, unknown>,options?: Record<string, unknown>) => Promise<CliBody>}>{
  const client=new Client({name:'export-loudness-transport-tests',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[repo+'apps/mcp/src/index.ts'],cwd:repo,env:env(url),stderr:'pipe'});
  let stderr='',overflow=false;
  (transport.stderr as unknown as {setEncoding(encoding: string): {on(event: string, listener: (chunk: string) => void): void}} | null)?.setEncoding('utf8').on('data',(part: string)=>{stderr+=part;if(Buffer.byteLength(stderr)>64*1024){overflow=true;void client.close();}});
  t.after(async()=>{await bounded(client.close(),'MCP cleanup');assert.equal(overflow,false);assert.ok(!stderr.includes(token));});
  await bounded(client.connect(transport),'MCP connect');
  async function call(name: string,args: Record<string, unknown>,options: Record<string, unknown>={}): Promise<CliBody>{
    const result=await client.callTool({name,arguments:args},undefined,{timeout:10000,...options});
    const content=result.content as Array<{type: string; text: string}>;
    const blocks=content.filter(value=>value.type==='text');assert.equal(blocks.length,1);
    const body=JSON.parse(blocks[0].text) as CliBody;assert.deepEqual(result.structuredContent,body);assert.equal(Boolean(result.isError),!body.ok);
    assert.ok(!JSON.stringify(body).includes(token));return body;
  }
  return {client,call};
}
type FixtureRequest = NonNullable<Parameters<typeof readyLoudness>[0]>;
async function fixture(t: TestContext,request: FixtureRequest = input as FixtureRequest): Promise<TransportFixture>{
  let mode='ready',entered=deferred(),settled=deferred();const calls: Array<{operation: string; input: unknown}>=[];const signals: Array<AbortSignal | undefined>=[];const cleanups: FixtureCleanup[]=[];
  const server=http.createServer(async(req: IncomingMessage,res: ServerResponse)=>{
    if(req.url==='/health'){res.end('healthy');return;}
    try{
      assert.equal(req.url,'/api/rpc');assert.equal(req.method,'POST');
      assert.equal(req.headers.authorization,'Bearer '+token);
      let raw='';for await(const chunk of req){raw+=String(chunk);if(Buffer.byteLength(raw)>8192)throw Error('Request overflow');}
      const body=JSON.parse(raw) as {operation: string; input: unknown};calls.push(body);const parsed=parse(body.operation as never,body.input);
      const baseline={request:req.listenerCount('aborted'),response:res.listenerCount('close')};
      let result;
      try {result=await callObservedRpc(req,res,{call:async(op: string,actual: unknown,serviceContext: Record<string, unknown> = {})=>{
        const signal=serviceContext.signal as AbortSignal;assert.equal(op,operation);assert.deepEqual(actual,request);signals.push(signal);entered.resolve();
        if(mode==='wait'){
          await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});
          return incompleteLoudness('CANCELLED',request);
        }
        if(mode==='malformed')return {...readyLoudness(request),exportId:request.projectId};
        if(mode==='hash')return {...readyLoudness(request),artifact:{...readyLoudness(request).artifact,sha256:'c'.repeat(64)}};
        if(mode==='suggestion'){const value=readyLoudness(request);(value.suggestion as {applyAllowed: boolean}).applyAllowed=true;return value;}
        return mode==='busy'?incompleteLoudness('BUSY',request):readyLoudness(request);
      }},body.operation,parsed);}finally{
        cleanups.push({baseline,remaining:{request:req.listenerCount('aborted'),response:res.listenerCount('close')}});settled.resolve();
      }
      if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:result}));}
    }catch(error){if(!res.destroyed){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:(error as {code?: string}).code||'TEST_FAILED',message:'Synthetic request rejected.',details:{},retryable:false}}));}}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await bounded(new Promise(resolve=>server.close(resolve)),'HTTP cleanup');});
  const address=server.address();if(!address||typeof address==='string')throw Error('Expected a bound TCP address');const url=`http://127.0.0.1:${(address as AddressInfo).port}`;
  return {url,calls,signals,cleanups,mode(value: string){mode=value;entered=deferred();settled=deferred();},entered:()=>bounded(entered.promise,'Service entry'),settled:()=>bounded(settled.promise,'Service settlement')};
}

test('actual CLI and official MCP discover the exact strict loudness input and unchanged annotations offline',{timeout:30000},async (t: TestContext)=>{
  interface LocalDefinition {operation: string; toolName: string; command: string; description: string; inputSchema: {required: string[]; properties: Record<string, {pattern?: string; const?: unknown}>; additionalProperties: boolean}; requiresRequestId: boolean; effects: {notes: string[]; [key: string]: unknown}}
  const definition=discoverSchema({operation}) as unknown as LocalDefinition;
  const result=await cli(t,undefined,['schema',operation]).result;assert.equal(result.code,0);assert.deepEqual(result.body,{ok:true,data:definition});
  const mcp=await official(t);assert.deepEqual(await mcp.call('mioon_schema',{operation}),{ok:true,data:definition});
  const tools=(await mcp.client.listTools()).tools;
  assert.deepEqual(tools.map(value=>value.name).sort(),[...Object.keys(schemas).map(name=>name.replaceAll('.','_')),'mioon_doctor','mioon_capabilities','mioon_schema'].sort());
  const tool=tools.find(value=>value.name==='timeline_export_loudness');assert.ok(tool);
  assert.ok(tool);assert.deepEqual(tool.inputSchema,definition.inputSchema);assert.deepEqual(tool.annotations,effectAnnotations(operationEffect(operation)));
  assert.deepEqual(definition.inputSchema.required,['projectId','exportId','expectedArtifactSha256','measurementProfile']);assert.equal(definition.requiresRequestId,false);
  assert.deepEqual(Object.keys(definition).sort(),['operation','toolName','command','description','inputSchema','requiresRequestId','effects'].sort());
  assert.deepEqual(Object.keys(tool).sort(),['name','description','inputSchema','annotations'].sort());
  assert.deepEqual(Object.keys(definition.inputSchema.properties),['projectId','exportId','expectedArtifactSha256','measurementProfile','target']);
  assert.equal(definition.inputSchema.additionalProperties,false);
  assert.equal(definition.inputSchema.properties.expectedArtifactSha256.pattern,'^[a-f0-9]{64}$');
  assert.equal(definition.inputSchema.properties.measurementProfile?.const,EXPORT_LOUDNESS_PROFILE);
  assert.deepEqual(definition.inputSchema.properties.target,{type:'object',properties:{
    integratedLufs:{type:'number',minimum:-60,maximum:-5},truePeakCeilingDbtp:{type:'number',minimum:-20,maximum:0}},
    required:['integratedLufs','truePeakCeilingDbtp'],additionalProperties:false});
  assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  const {notes,...effects}=definition.effects;
  assert.deepEqual(effects,{readOnly:true,idempotent:true,destructive:false,openWorld:false,databaseWrite:false,fileWrite:false,externalIO:false,localProcess:true,paidGeneration:false});
  assert.ok(notes.includes('arithmetic-only'));
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(value=>value.name),['mioon_project_inspect','mioon_asset_inspect','mioon_shot_inspect','mioon_timeline_inspect']);
  const catalog=discoverSchema();
  assert.deepEqual((await cli(t,undefined,['schema']).result).body,{ok:true,data:catalog});
  assert.deepEqual(await mcp.call('mioon_schema',{}),{ok:true,data:catalog});
});
test('actual HTTP, CLI and official MCP carry identical ephemeral reports, validate identity and never retry',{timeout:30000},async (t: TestContext)=>{
  const f=await fixture(t),mcp=await official(t,f.url),client=createClient({env:env(f.url)});
  const callCli=async()=>{const result=await cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(input)]).result;return result.body;};
  const callMcp=()=>mcp.call('timeline_export_loudness',input);
  const callHttp=async()=>{const response=await fetch(f.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input})});return response.json();};
  for(const mode of ['ready','busy']){
    f.mode(mode);const expected=mode==='ready'?readyLoudness(input):incompleteLoudness('BUSY',input);
    for(const call of [callHttp,callCli,callMcp]){const before=f.calls.length;const result=await call();assert.deepEqual(result,{ok:true,data:expected});assert.equal(isExportLoudnessResponse(result.data,input),true);assert.equal(f.calls.length,before+1);}
  }
  f.mode('malformed');const before=f.calls.length;
  await assert.rejects(client.rpc(operation,input),{code:'BACKEND_PROTOCOL_ERROR'});
  for(const call of [callCli,callMcp]){const result=await call();assert.equal(result.ok,false);assert.equal(result.error?.code,'BACKEND_PROTOCOL_ERROR');assert.equal(Object.hasOwn(result.error?.details ?? {},'submissionMayHaveSucceeded'),false);}
  assert.equal(f.calls.length,before+3);
  assert.ok(f.calls.every(body=>JSON.stringify(body)===JSON.stringify({operation,input})));
  assert.ok(f.cleanups.every(({baseline,remaining})=>JSON.stringify(baseline)===JSON.stringify(remaining)));
});
for(const transport of ['HTTP','CLI','MCP'])test(`actual ${transport} cancellation disconnects only loudness observation and leaves server healthy`,{timeout:30000},async (t: TestContext)=>{
  const f=await fixture(t);f.mode('wait');let stop,finished;
  if(transport==='HTTP'){
    const controller=new AbortController();stop=()=>controller.abort();
    finished=fetch(f.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input}),signal:controller.signal}).then(()=>assert.fail('Cancelled HTTP must not succeed'),()=>{});
  }else if(transport==='CLI'){
    const invocation=cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(input)]);stop=()=>invocation.child.kill('SIGINT');
    finished=invocation.result.then(({code,body})=>{assert.equal(code,130);assert.equal(body.error?.code,'INTERRUPTED');});
  }else{
    const mcp=await official(t,f.url),controller=new AbortController();stop=()=>controller.abort();
    finished=mcp.call('timeline_export_loudness',input,{signal:controller.signal}).then(()=>assert.fail('Cancelled MCP must not succeed'),()=>{});
  }
  await f.entered();assert.equal(f.signals[0]?.aborted,false);stop();await bounded(finished,'Caller cancellation');await f.settled();
  assert.equal(f.signals[0]?.aborted,true);assert.equal(f.calls.length,1);
  assert.deepEqual(f.cleanups[0].remaining,f.cleanups[0].baseline);
  assert.equal(await (await fetch(f.url+'/health')).text(),'healthy');
});

test('actual HTTP, CLI and official MCP preserve explicit custom target and reject altered source or suggestion',{timeout:30000},async (t: TestContext)=>{
  const request={...input,target},f=await fixture(t,request),mcp=await official(t,f.url),client=createClient({env:env(f.url)});
  const callCli=async()=>{const result=await cli(t,f.url,['rpc',operation,'--input',JSON.stringify(request)]).result;return result.body;};
  const callMcp=()=>mcp.call('timeline_export_loudness',request);
  const report=readyLoudness(request);
  const suggestion=report.suggestion as {conflictsWithCeiling: boolean; currentTimelineValidated: boolean; applyAllowed: boolean};
  assert.equal(suggestion.conflictsWithCeiling,true);
  assert.equal(suggestion.currentTimelineValidated,false);assert.equal(suggestion.applyAllowed,false);
  assert.deepEqual(await client.rpc(operation,request),report);
  for(const call of [callCli,callMcp])assert.deepEqual(await call(),{ok:true,data:report});
  for(const mode of ['hash','suggestion']){
    f.mode(mode);const before=f.calls.length;
    await assert.rejects(client.rpc(operation,request),{code:'BACKEND_PROTOCOL_ERROR'});
    for(const call of [callCli,callMcp]){const result=await call();assert.equal(result.ok,false);assert.equal(result.error?.code,'BACKEND_PROTOCOL_ERROR');assert.deepEqual(result.error?.details,{});}
    assert.equal(f.calls.length,before+3);
  }
  assert.ok(f.calls.every(body=>JSON.stringify(body)===JSON.stringify({operation,input:request})));
});
test('HTTP rejects extra paths and authority while CLI/MCP reject before dispatch, including arbitrary filename flags',{timeout:30000},async (t: TestContext)=>{
  const f=await fixture(t),mcp=await official(t,f.url);
  for(const extra of [{filename:'arbitrary.mp4'},{path:'/private/export.mp4'},{sourceHash:'c'.repeat(64)},
    {requestId:'forbidden-request-id'},{applyAllowed:true},{target:{...target,standard:'broadcast'}}]){
    const request={...input,...extra},before=f.calls.length;
    const cliResult=await cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(request)]).result;
    assert.equal(cliResult.code,2);assert.equal(cliResult.body.error?.code,'VALIDATION_ERROR');
    const mcpResult=await mcp.call('timeline_export_loudness',request);
    assert.equal(mcpResult.error?.code,'VALIDATION_ERROR');assert.equal(f.calls.length,before);
    const response=await fetch(f.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input:request})});
    assert.equal(response.status,400);assert.equal((await response.json()).ok,false);assert.equal(f.calls.length,before+1);
  }
  for(const flag of ['--file','--output']){
    const result=await cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(input),flag,'/private/arbitrary.mp4']).result;
    assert.equal(result.code,2);assert.equal(result.body.error?.code,'VALIDATION_ERROR');
  }
  assert.equal(f.signals.length,0);assert.equal(f.cleanups.length,0);
});
