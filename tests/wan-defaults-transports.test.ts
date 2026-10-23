import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../packages/business/src/db.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord, ServiceRow} from '../packages/business/src/services.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration, VideoModelEntry} from '../packages/contracts/src/video-providers.ts';
import {generationParameters, generationProviderForModel, videoConnectionProviders} from '../apps/web/src/generation-settings.ts';
import {rpc as webRpc} from '../apps/web/src/api.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const execute = promisify(execFile);
const token = 'synthetic-wan-defaults-local-token';
interface Envelope {ok: boolean; data?: JobRecord; error?: {code: string; message: string}}
interface Scenario {
  name: string;
  modelIndex?: number;
  narrow?: boolean;
  overrides?: Record<string, unknown>;
  expected: Record<string, unknown>;
}
const defaults = {durationSeconds:5, resolution:'720P', aspectRatio:'9:16', generateAudio:true, promptExtend:true, watermark:false};
const scenarios: Scenario[] = [
  {name:'Wan 3.0 defaults', expected:defaults},
  {name:'Wan 3.0 Prime defaults', modelIndex:1, expected:defaults},
  {name:'narrowed model defaults', narrow:true, expected:{...defaults, durationSeconds:2, resolution:'480P', aspectRatio:'1:1'}},
  {name:'explicit partial overrides', overrides:{durationSeconds:10, resolution:'1080P', generateAudio:false, promptExtend:false, watermark:true, seed:42},
    expected:{...defaults, durationSeconds:10, resolution:'1080P', generateAudio:false, promptExtend:false, watermark:true, seed:42}},
];

async function fixture(t: TestContext, scenario: Scenario) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-wan-default-transports-')));
  const store = openStore(root), settings = await createVideoSettings({directory:path.join(root, 'video-settings'), privateRoot:root});
  const registry = createProviderRegistry({db:store.db, root, env:{}});
  let providerCalls = 0;
  // No worker is started. Even if a regression dispatches during submission,
  // this injected transport cannot contact a real supplier.
  const services = createServices(store, registry, {videoSettings:settings, profileNow:()=>Date.UTC(2026,9,23), videoFetch:async()=>{
    providerCalls++;
    throw new Error('Provider dispatch is forbidden in this offline transport test.');
  }});
  let server: http.Server | undefined, client: Client | undefined;
  t.after(async()=>{
    try {await client?.close();}
    finally {
      if (server) {server.closeAllConnections(); await new Promise<void>(resolve=>server!.close(()=>resolve()));}
      await services.drain(); await settings.close(); store.close(); await rm(root, {recursive:true, force:true});
    }
  });
  await services.call('workspace.settings.set', {expectedRevision:0, liveGeneration:true});
  const model = defaultVideoModels('wan').filter(entry=>entry.templateId==='wan30-v1')[scenario.modelIndex ?? 0] as VideoModelEntry;
  if (scenario.narrow) {model.aspectRatios=['1:1']; model.durationResolutionMap=[{duration:[2,10], resolution:['480P']}];}
  const configuration: VideoConnectionConfiguration = {id:randomUUID(), providerId:'wan', name:'Offline Wan defaults', region:'cn-beijing',
    workspaceId:'test-workspace', enabled:true, archived:false, outputHosts:['output.example'], models:[model]};
  await settings.put({action:'save', expectedRevision:0, configuration, secret:{action:'replace', value:'synthetic-wan-key', storage:'session'}});
  const project = await services.call('project.create', {name:'Wan defaults parity'}) as ServiceRow;
  const shot = await services.call('shot.create', {projectId:project.id, title:'Four second shot', prompt:'Synthetic offline generation.',
    duration:4, aspectRatio:'9:16', referenceAssetIds:[]}) as ServiceRow;
  const captured: Array<{operation:string; input:Record<string,unknown>}> = [];
  server = http.createServer(async(request, response)=>{
    try {
      assert.equal(request.url, '/api/rpc'); assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      let raw=''; for await(const chunk of request) {raw+=String(chunk); if (Buffer.byteLength(raw)>16384) throw Error('Request overflow');}
      const body = JSON.parse(raw) as {operation:string; input:Record<string,unknown>}; captured.push(body);
      const data = await services.call(body.operation, body.input);
      response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify({ok:true, data}));
    } catch(error) {
      const value = error as {code?:string; message?:string};
      response.writeHead(400, {'content-type':'application/json'});
      response.end(JSON.stringify({ok:false, error:{code:value.code ?? 'TEST_FAILED', message:value.message ?? 'Offline request failed.', retryable:false, details:{}}}));
    }
  });
  await new Promise<void>(resolve=>server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address==='string') throw Error('Expected a bound TCP address');
  const url = `http://127.0.0.1:${address.port}`;
  const env: Record<string,string> = Object.fromEntries(['PATH','SystemRoot','WINDIR','TMPDIR','TEMP','TMP'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key] as string]]));
  Object.assign(env, {MIOON_BASE_URL:url, MIOON_TOKEN:token, MIOON_ENABLE_LIVE_PROVIDER:'0'});
  const httpSubmit = async(input:Record<string,unknown>): Promise<JobRecord>=>{
    const response = await fetch(url+'/api/rpc', {method:'POST', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json'},
      body:JSON.stringify({operation:'generation.submit',input}), signal:AbortSignal.timeout(10000)});
    const body = await response.json() as Envelope; assert.equal(body.ok,true,JSON.stringify(body)); assert.equal(response.status,200); return body.data!;
  };
  const cliSubmit = async(input:Record<string,unknown>): Promise<JobRecord>=>{
    const result = await execute(process.execPath, [path.join(repo,'apps/cli/src/index.ts'),'generation','submit','--input',JSON.stringify(input)], {cwd:repo, env, timeout:10000});
    const body = JSON.parse(result.stdout) as Envelope; assert.equal(body.ok,true,JSON.stringify(body));
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token)); return body.data!;
  };
  client = new Client({name:'wan-defaults-parity', version:'1.0.0'}, {capabilities:{}});
  const transport = new StdioClientTransport({command:process.execPath, args:[path.join(repo,'apps/mcp/src/index.ts')], cwd:repo, env, stderr:'pipe'});
  (transport.stderr as unknown as import('node:stream').Readable | undefined)?.resume();
  await client.connect(transport);
  const mcpSubmit = async(input:Record<string,unknown>): Promise<JobRecord>=>{
    const result = await client!.callTool({name:'generation_submit',arguments:input}, undefined, {timeout:10000});
    const content = result.content as Array<{type:string; text:string}>;
    const block = content.find(value=>value.type==='text'); assert.ok(block);
    const body = JSON.parse(block.text) as Envelope;
    assert.deepEqual(result.structuredContent,body); assert.equal(body.ok,true,JSON.stringify(body)); assert.equal(Boolean(result.isError),false);
    return body.data!;
  };
  const fetcher: typeof fetch = (input, init)=>fetch(url+String(input), {...init, headers:{...Object.fromEntries(new Headers(init?.headers)), authorization:`Bearer ${token}`}});
  return {store, services, shot, model, configuration, captured, httpSubmit, cliSubmit, mcpSubmit, fetcher, providerCalls:()=>providerCalls};
}

for (const scenario of scenarios) test(`Web, HTTP, CLI and official MCP freeze identical ${scenario.name}`, {timeout:30000}, async(t: TestContext)=>{
  const f = await fixture(t, scenario);
  const connections = await webRpc('video.connection.list', {}, {fetcher:f.fetcher});
  const provider = generationProviderForModel(videoConnectionProviders(connections)[0], f.model.modelId, f.model.id);
  assert.ok(provider);
  const webParameters = generationParameters(f.shot, provider, {parameters:scenario.overrides});
  assert.deepEqual(webParameters, scenario.expected);
  const input = (): Record<string,unknown>=>({shotId:f.shot.id, expectedRevision:f.shot.revision, requestId:randomUUID(), providerId:'wan',
    connectionId:f.configuration.id, configurationRevision:1, modelEntryId:f.model.id,
    ...(scenario.overrides ? {parameters:scenario.overrides} : {})});
  const webInput = {...input(), parameters:webParameters};
  const cliInput = input(), mcpInput = input(), httpInput = input();
  const jobs = [await webRpc<JobRecord>('generation.submit',webInput,{fetcher:f.fetcher}), await f.httpSubmit(httpInput), await f.cliSubmit(cliInput), await f.mcpSubmit(mcpInput)];
  for (const job of jobs) {
    assert.equal(job.status,'queued'); assert.equal(job.submissionCount,0);
    assert.deepEqual(job.snapshot.parameters,scenario.expected);
    assert.deepEqual((f.store.get('jobs',job.id) as JobRecord).snapshot.parameters,scenario.expected);
    assert.equal(job.snapshot.duration,4); assert.equal(job.snapshot.aspectRatio,'9:16');
  }
  // Replaying the exact omitted/partial CLI request through another transport
  // returns its original frozen task instead of creating another paid request.
  assert.deepEqual(await f.mcpSubmit(cliInput),jobs[2]);
  assert.deepEqual(await f.httpSubmit(mcpInput),jobs[3]);
  assert.equal(f.store.list('jobs').length,4); assert.equal(f.providerCalls(),0);
  const savedShot = f.store.get('shots',String(f.shot.id)) as ServiceRow;
  assert.equal(savedShot.duration,4); assert.equal(savedShot.aspectRatio,'9:16'); assert.deepEqual(savedShot.parameters,{});
  const missingParameters = f.captured.filter(value=>value.operation==='generation.submit' && !Object.hasOwn(value.input,'parameters'));
  assert.equal(missingParameters.length,scenario.overrides?0:5);
});
