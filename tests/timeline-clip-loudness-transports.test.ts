import type {TestContext} from 'node:test';
import type {Readable} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import type {AddressInfo} from 'node:net';
import type {OperationDefinition} from '@mioon/client';
import type {Failure, RpcEnvelope, SchemaNode} from './helpers/strict-timeline-audio-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {discoverSchema,createClient,schemas} from '@mioon/client';
import {parse,isTimelineClipLoudnessResponse,effectAnnotations,operationEffect,EXPORT_LOUDNESS_PROFILE,TIMELINE_CLIP_LOUDNESS_PROFILE} from '@mioon/contracts';
import {matchInput,matchedClipLoudness} from './fixtures/clip-loudness-match-fixtures.ts';
import {READ_TOOL_DEFINITIONS} from '../packages/business/src/agent/read-tool-policy.ts';
import {callObservedRpc} from '../apps/server/src/rpc-observation.ts';
import {clipLoudnessOperation as operation,clipLoudnessInput as input,clipLoudnessToken as token,readyClipLoudness,silentClipLoudness} from './fixtures/timeline-clip-loudness-fixtures.ts';

const repo=fileURLToPath(new URL('..',import.meta.url));
const env=(url?: string)=>({PATH:process.env.PATH||'',MIOON_ENABLE_LIVE_PROVIDER:'0',...(url?{MIOON_BASE_URL:url,MIOON_TOKEN:token}:{})});
const deferred=()=>{let resolve!: () => void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function bounded<T>(promise: Promise<T>,label: string,ms=10000){let timer: ReturnType<typeof setTimeout> | undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(label+' timed out')),ms);})]);}finally{clearTimeout(timer);}}
function cli(t: TestContext,url: string | undefined,args: string[]){
  const child=spawn(process.execPath,[repo+'apps/cli/src/index.ts',...args],{cwd:repo,env:env(url),stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',overflow=false;
  child.stdout.setEncoding('utf8').on('data',part=>{stdout+=part;if(Buffer.byteLength(stdout)>1024*1024){overflow=true;child.kill('SIGKILL');}});
  child.stderr.setEncoding('utf8').on('data',part=>{stderr+=part;if(Buffer.byteLength(stderr)>64*1024){overflow=true;child.kill('SIGKILL');}});
  const close=once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),15000);
  t.after(async()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(close,'CLI cleanup');});
  const result=(async()=>{const [code,signal]=await close;clearTimeout(timer);assert.equal(overflow,false);assert.equal(signal,null,stderr);
    assert.equal(stdout.trim().split('\n').length,1);assert.ok(!stdout.includes(token)&&!stderr.includes(token));
    return {code,body:JSON.parse(stdout)};})();
  return {child,result};
}
async function official(t: TestContext,url?: string){
  const client=new Client({name:'timeline-clip-loudness-transport-tests',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[repo+'apps/mcp/src/index.ts'],cwd:repo,env:env(url),stderr:'pipe'});
  let stderr='',overflow=false;
  (transport.stderr as Readable | null)?.setEncoding('utf8').on('data',part=>{stderr+=part;if(Buffer.byteLength(stderr)>64*1024){overflow=true;void client.close();}});
  t.after(async()=>{await bounded(client.close(),'MCP cleanup');assert.equal(overflow,false);assert.ok(!stderr.includes(token));});
  await bounded(client.connect(transport),'MCP connect');
  async function call(name: string,args: Record<string, unknown>,options: Parameters<Client['callTool']>[2]={}){
    const result=await client.callTool({name,arguments:args},undefined,{timeout:10000,...options});
    const blocks=(result.content as {type: string; text: string}[]).filter(value=>value.type==='text');assert.equal(blocks.length,1);
    const body=JSON.parse(blocks[0].text);assert.deepEqual(result.structuredContent,body);assert.equal(Boolean(result.isError),!body.ok);
    assert.ok(!JSON.stringify(body).includes(token));return body;
  }
  return {client,call};
}
async function fixture(t: TestContext,request: typeof input & {target?: typeof matchInput.target}=input){
  let mode='ready',entered=deferred(),settled=deferred();const calls: {operation: string; input: unknown}[]=[],signals: AbortSignal[]=[],cleanups: {baseline: {request: number; response: number}; remaining: {request: number; response: number}}[]=[],owned: ChildProcess[]=[];
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/health'){res.end('healthy');return;}
    try{
      assert.equal(req.url,'/api/rpc');assert.equal(req.method,'POST');
      assert.equal(req.headers.authorization,'Bearer '+token);
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8192)throw Error('Request overflow');}
      const body=JSON.parse(raw);calls.push(body);const parsed=parse(body.operation,body.input);
      const baseline={request:req.listenerCount('aborted'),response:res.listenerCount('close')};
      let result;
      try {result=await callObservedRpc(req,res,{call:async(op,actual,{signal}={})=>{
        assert.equal(op,operation);assert.deepEqual(actual,request);signals.push(signal as AbortSignal);entered.resolve();
        if(mode==='wait'){
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});owned.push(child);
          const closed=once(child,'close'),stop=()=>child.kill('SIGTERM');
          (signal as AbortSignal).addEventListener('abort',stop,{once:true});if((signal as AbortSignal).aborted)stop();
          try{await closed;}finally{(signal as AbortSignal).removeEventListener('abort',stop);}
          throw Object.assign(Error('Observation cancelled.'),{code:'OPERATION_CANCELLED'});
        }
        if(mode==='malformed')return {...readyClipLoudness(request),expectedRevision:request.expectedRevision+1};
        return request.target?matchedClipLoudness(request as typeof matchInput):mode==='silence'?silentClipLoudness(request):readyClipLoudness(request);
      }},body.operation,parsed);}finally{
        cleanups.push({baseline,remaining:{request:req.listenerCount('aborted'),response:res.listenerCount('close')}});settled.resolve();
      }
      if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,data:result}));}
    }catch(error){if(!res.destroyed){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:{code:(error as Failure).code||'TEST_FAILED',message:'Synthetic request rejected.',details:{},retryable:false}}));}}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();for(const child of owned)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await bounded(new Promise<void>(resolve=>server.close(resolve as (error?: Error) => void)),'HTTP cleanup');});
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {url,calls,signals,cleanups,owned,mode(value: string){mode=value;entered=deferred();settled=deferred();},entered:()=>bounded(entered.promise,'Service entry'),settled:()=>bounded(settled.promise,'Service settlement')};
}

test('actual CLI and official MCP discover the exact strict loudness input and unchanged annotations offline',{timeout:30000},async t=>{
  const definition=discoverSchema({operation}) as OperationDefinition & {inputSchema: SchemaNode};
  const result=await cli(t,undefined,['schema',operation]).result;assert.equal(result.code,0);assert.deepEqual(result.body,{ok:true,data:definition});
  const mcp=await official(t);assert.deepEqual(await mcp.call('mioon_schema',{operation}),{ok:true,data:definition});
  const tools=(await mcp.client.listTools()).tools;
  assert.deepEqual(tools.map(value=>value.name).sort(),[...Object.keys(schemas).map(name=>name.replaceAll('.','_')),'mioon_doctor','mioon_capabilities','mioon_schema'].sort());
  const tool=tools.find(value=>value.name==='timeline_clip_loudness');
  assert.ok(tool);assert.deepEqual(tool.inputSchema,definition.inputSchema);assert.deepEqual(tool.annotations,effectAnnotations(operationEffect(operation)));
  assert.deepEqual(definition.inputSchema.required,['projectId','timelineId','expectedRevision','clipId','expectedAssetSha256','measurementProfile']);assert.equal(definition.requiresRequestId,false);
  assert.deepEqual(Object.keys(definition).sort(),['operation','toolName','command','description','inputSchema','requiresRequestId','effects'].sort());
  assert.deepEqual(Object.keys(tool).sort(),['name','description','inputSchema','annotations'].sort());
  assert.deepEqual(Object.keys(definition.inputSchema.properties),['projectId','timelineId','expectedRevision','clipId','expectedAssetSha256','measurementProfile','target']);
  assert.equal(definition.inputSchema.additionalProperties,false);
  assert.equal(definition.inputSchema.properties.expectedRevision.minimum,1);
  assert.equal(definition.inputSchema.properties.measurementProfile.const,EXPORT_LOUDNESS_PROFILE);
  assert.deepEqual(tool.annotations,{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false});
  const {notes,...effects}=definition.effects;
  assert.deepEqual(effects,{readOnly:true,idempotent:true,destructive:false,openWorld:false,databaseWrite:false,fileWrite:false,externalIO:false,localProcess:true,paidGeneration:false});
  assert.ok(notes!.includes('one complete selected saved clip'));
  assert.ok(notes!.includes('no implicit target or apply authority'));
  assert.deepEqual(READ_TOOL_DEFINITIONS.map(value=>value.name),['mioon_project_inspect','mioon_asset_inspect','mioon_shot_inspect','mioon_timeline_inspect']);
  const catalog=discoverSchema();
  assert.deepEqual((await cli(t,undefined,['schema']).result).body,{ok:true,data:catalog});
  assert.deepEqual(await mcp.call('mioon_schema',{}),{ok:true,data:catalog});
});
test('actual HTTP, CLI and official MCP carry identical ephemeral reports, validate identity and never retry',{timeout:30000},async t=>{
  const f=await fixture(t),mcp=await official(t,f.url),client=createClient({env:env(f.url)});
  const callCli=async()=>{const result=await cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(input)]).result;return result.body;};
  const callMcp=()=>mcp.call('timeline_clip_loudness',input);
  const callHttp=async()=>{const response=await fetch(f.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input})});return response.json();};
  for(const mode of ['ready','silence']){
    f.mode(mode);const expected=mode==='ready'?readyClipLoudness():silentClipLoudness();
    for(const call of [callHttp,callCli,callMcp]){const before=f.calls.length;const result=await call();assert.deepEqual(result,{ok:true,data:expected});assert.equal(isTimelineClipLoudnessResponse(result.data,input),true);assert.equal(f.calls.length,before+1);}
  }
  f.mode('malformed');const before=f.calls.length;
  await assert.rejects(client.rpc(operation,input),{code:'BACKEND_PROTOCOL_ERROR'});
  for(const call of [callCli,callMcp]){const result=await call();assert.equal(result.ok,false);assert.equal(result.error.code,'BACKEND_PROTOCOL_ERROR');assert.equal(Object.hasOwn(result.error.details,'submissionMayHaveSucceeded'),false);}
  assert.equal(f.calls.length,before+3);
  assert.ok(f.calls.every(body=>JSON.stringify(body)===JSON.stringify({operation,input})));
  assert.ok(f.cleanups.every(({baseline,remaining})=>JSON.stringify(baseline)===JSON.stringify(remaining)));
});
for(const transport of ['HTTP','CLI','MCP'])test(`actual ${transport} cancellation disconnects only loudness observation and leaves server healthy`,{timeout:30000},async t=>{
  const f=await fixture(t);f.mode('wait');let stop,finished;
  if(transport==='HTTP'){
    const controller=new AbortController();stop=()=>controller.abort();
    finished=fetch(f.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input}),signal:controller.signal}).then(()=>assert.fail('Cancelled HTTP must not succeed'),()=>{});
  }else if(transport==='CLI'){
    const invocation=cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(input)]);stop=()=>invocation.child.kill('SIGINT');
    finished=invocation.result.then(({code,body})=>{assert.equal(code,130);assert.equal(body.error.code,'INTERRUPTED');});
  }else{
    const mcp=await official(t,f.url),controller=new AbortController();stop=()=>controller.abort();
    finished=mcp.call('timeline_clip_loudness',input,{signal:controller.signal}).then(()=>assert.fail('Cancelled MCP must not succeed'),()=>{});
  }
  await f.entered();assert.equal(f.signals[0].aborted,false);stop();await bounded(finished,'Caller cancellation');await f.settled();
  assert.equal(f.signals[0].aborted,true);assert.equal(f.calls.length,1);
  assert.equal(f.owned.length,1);assert.ok(f.owned[0].exitCode!==null||f.owned[0].signalCode!==null,'Exact owned process has retired');
  assert.deepEqual(f.cleanups[0].remaining,f.cleanups[0].baseline);
  assert.equal(await (await fetch(f.url+'/health')).text(),'healthy');
});

test('HTTP rejects extra paths and authority while CLI/MCP reject before dispatch, including arbitrary filename flags',{timeout:30000},async t=>{
  const f=await fixture(t),mcp=await official(t,f.url);
  for(const extra of [{filename:'arbitrary.mp4'},{path:'/private/export.mp4'},{sourceHash:'c'.repeat(64)},
    {requestId:'forbidden-request-id'},{applyAllowed:true},{target:{}},{candidate:{}},{clipId:undefined},{measurementProfile:undefined}]){
    const request={...input,...extra},before=f.calls.length;
    const cliResult=await cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(request)]).result;
    assert.equal(cliResult.code,2);assert.equal(cliResult.body.error.code,'VALIDATION_ERROR');
    const mcpResult=await mcp.call('timeline_clip_loudness',request);
    assert.equal(mcpResult.error.code,'VALIDATION_ERROR');assert.equal(f.calls.length,before);
    const response=await fetch(f.url+'/api/rpc',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({operation,input:request})});
    assert.equal(response.status,400);assert.equal((await response.json()).ok,false);assert.equal(f.calls.length,before+1);
  }
  for(const flag of ['--file','--output']){
    const result=await cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(input),flag,'/private/arbitrary.mp4']).result;
    assert.equal(result.code,2);assert.equal(result.body.error.code,'VALIDATION_ERROR');
  }
  assert.equal(f.signals.length,0);assert.equal(f.cleanups.length,0);
});


test('explicit target and measured candidate travel unchanged through real HTTP, CLI and official MCP', {timeout:30000}, async t => {
  const f=await fixture(t,matchInput),mcp=await official(t,f.url),client=createClient({env:env(f.url)});
  const expected=matchedClipLoudness();
  assert.deepEqual(await client.rpc(operation,matchInput),expected);
  const cliResult=await cli(t,f.url,[...operation.split('.'),'--input',JSON.stringify(matchInput)]).result;
  assert.equal(cliResult.code,0);assert.deepEqual(cliResult.body,{ok:true,data:expected});
  assert.deepEqual(await mcp.call('timeline_clip_loudness',matchInput),{ok:true,data:expected});
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(body=>JSON.stringify(body.input)===JSON.stringify(matchInput)));
  assert.equal(expected.applyAllowed,false);assert.equal(expected.candidate.applyAllowed,false);
});
