import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rename, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '@mioon/server';
import {schemas, IMAGE_FIXED_OPTIONS, IMAGE_MODELS, COMFY_IMAGE_OPTIONS} from '@mioon/contracts';
import {operationDefinition} from '@mioon/client';
import {assertOperationInputBranches} from './helpers/catalog-input-branches.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'synthetic-v4-mcp-token-never-live';
interface Bridge {client: Client; transport: StdioClientTransport; stderr: () => string; call: (name: string, args?: Record<string, unknown>, errorCode?: string) => Promise<unknown>}
interface ErrorEnvelope {code?: string; message?: string; details: {currentRevision?: number} & Record<string, unknown>}
interface CatalogOperation {operation: string; toolName: string; command: string; inputSchema: Record<string, unknown>; requiresRequestId?: boolean}
interface CatalogFixture {inputSchema: {anyOf: Array<{additionalProperties?: boolean; properties: Record<string, unknown>; required: string[]}>}; requiresRequestId: boolean}
interface RpcService extends Awaited<ReturnType<typeof startServer>> {}
interface RpcBody {ok?: boolean; data?: Record<string, unknown>; error?: {code?: string; details?: unknown}}
function environment(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {...(process.env as Record<string, string>)};
  for (const key of Object.keys(env)) if (/^(MIOON_|RUNWAY|ARK_|VEO_|GOOGLE_|MIOON_)/.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER:'0', ...extra};
}
async function bridge(t: TestContext, env: Record<string, string> = {}): Promise<Bridge> {
  const client = new Client({name:'v4-protocol-regression', version:'1.0.0'}, {capabilities:{}});
  const transport = new StdioClientTransport({command:process.execPath, args:[path.join(repo,'apps/mcp/src/index.ts')], cwd:repo, env:environment(env), stderr:'pipe'});
  let stderr = '';
  (transport.stderr as unknown as {setEncoding(encoding: string): {on(event: string, listener: (chunk: string) => void): void}} | null)?.setEncoding('utf8').on('data', (bytes: string) => stderr += bytes);
  t.after(() => client.close());
  await client.connect(transport);
  return {client, transport, stderr:() => stderr, async call(name: string, args: Record<string, unknown> = {}, errorCode?: string): Promise<unknown> {
    const result = await client.callTool({name, arguments:args});
    const content = result.content as Array<{type: string; text: string}>;
    const text = content.find(item => item.type === 'text');
    assert.ok(text, `${name} has a text fallback`);
    const envelope = JSON.parse(text.text) as {ok?: boolean; data?: Record<string, unknown>; error?: {code?: string; message?: string}};
    assert.deepEqual(result.structuredContent, envelope, `${name} structuredContent matches text`);
    assert.equal(envelope.ok, !errorCode, JSON.stringify(envelope));
    assert.equal(Boolean(result.isError), Boolean(errorCode), JSON.stringify(envelope));
    if (errorCode) {
      assert.equal(envelope.error?.code, errorCode);
      assert.equal(typeof envelope.error?.message, 'string');
      return envelope.error;
    }
    return envelope.data;
  }};
}
async function httpRpc(service: RpcService, operation: string, input: Record<string, unknown> = {}): Promise<{status: number; body: RpcBody}> {
  const response = await fetch(service.url + '/api/rpc', {method:'POST', headers:{authorization:`Bearer ${service.token}`, 'content-type':'application/json'}, body:JSON.stringify({operation,input})});
  return {status:response.status, body:await response.json() as RpcBody};
}

test('MCP initializes offline; discovery schemas exactly cover shared contracts and expose structured errors', {timeout:30_000}, async (t: TestContext) => {
  const mcp = await bridge(t);
  assert.equal(mcp.client.getServerVersion()?.name, 'mioon');
  const listing = await mcp.client.listTools();
  const actual = listing.tools.map(tool => tool.name).sort();
  const expected = [...Object.keys(schemas).map(operation => operation.replaceAll('.','_')), 'mioon_doctor','mioon_capabilities','mioon_schema'].sort();
  assert.deepEqual(actual, expected);
  const catalog = await mcp.call('mioon_schema') as {operations: CatalogOperation[]; validation: string};
  assert.deepEqual(catalog.operations.map(item => item.operation).sort(), Object.keys(schemas).sort());
  for (const operation of Object.keys(schemas)) {
    const definition = catalog.operations.find(item => item.operation === operation)!;
    const tool = listing.tools.find(item => item.name === operation.replaceAll('.','_'))!;
    assert.equal(definition.toolName, tool.name);
    assert.equal(definition.command, operation.replaceAll('.',' '));
    assert.deepEqual(tool.inputSchema, definition.inputSchema, `${operation} uses one schema converter`);
    assertOperationInputBranches({...definition, inputSchema: tool.inputSchema});
  }
  const submit = await mcp.call('mioon_schema', {operation:'generation.submit'}) as {requiresRequestId?: boolean};
  assert.equal(submit.requiresRequestId, true);
  assert.deepEqual(submit, catalog.operations.find(item => item.operation === 'generation.submit'));
  assert.match(catalog.validation, /Zod/);
  await mcp.call('mioon_schema', {operation:'unregistered.operation'}, 'VALIDATION_ERROR');
  await mcp.call('mioon_schema', {unexpected:true}, 'VALIDATION_ERROR');
  await mcp.call('project_create', {name:'must not dispatch', unexpected:true}, 'VALIDATION_ERROR');
  await mcp.call('generation_submit', {shotId:randomUUID(), expectedRevision:1, providerId:'mock'}, 'VALIDATION_ERROR');
  await mcp.call('project_get', {projectId:'not-a-uuid'}, 'VALIDATION_ERROR');
  const imageCases: Array<[string, unknown, unknown]> = [['mock', IMAGE_MODELS.mock, IMAGE_FIXED_OPTIONS],
    ['openai', IMAGE_MODELS.openai, IMAGE_FIXED_OPTIONS], ['openai-compatible', 'vendor/model', IMAGE_FIXED_OPTIONS],
    ['comfy-local', 'model.safetensors', COMFY_IMAGE_OPTIONS]];
  for (const [providerId, model, options] of imageCases) {
    const input = {projectId: randomUUID(), requestId: randomUUID(), name: 'Offline schema fixture', prompt: 'A red tree', providerId, model, options};
    assert.equal(schemas['image.generate'].safeParse(input).success, true);
    await mcp.call('image_generate', input, 'CONNECTION_CONFIG_ERROR');
    const patches: Array<Record<string, unknown>> = [{unexpected:true}, {seed:1}, {options:{...(options as Record<string, unknown>), unexpected:true}}];
    for (const patch of patches) {
      assert.equal(schemas['image.generate'].safeParse({...input, ...patch}).success, false);
      await mcp.call('image_generate', {...input, ...patch}, 'VALIDATION_ERROR');
    }
  }
  await mcp.call('unregistered_tool', {}, 'UNKNOWN_OPERATION');
  await mcp.call('project_list', {}, 'CONNECTION_CONFIG_ERROR');
  await mcp.call('mioon_doctor', {}, 'CONNECTION_CONFIG_ERROR');
  await mcp.call('mioon_capabilities', {}, 'CONNECTION_CONFIG_ERROR');
  assert.ok(!mcp.stderr().includes('Bearer'));
});

test('catalog assertions reject lost, reordered or weakened image union branches and replay-key claims', () => {
  const definition = operationDefinition('image.generate') as unknown as CatalogFixture;
  const inspected = assertOperationInputBranches(definition) as unknown as {branches: unknown[]; requiresRequestId: boolean; optionalRequestId: boolean};
  assert.equal(inspected.branches.length, 3); assert.equal(inspected.requiresRequestId, true);
  assert.equal(inspected.optionalRequestId, false);
  const changes: Array<(value: CatalogFixture) => void> = [
    value => value.inputSchema.anyOf.pop(),
    value => value.inputSchema.anyOf.reverse(),
    ...[0,1,2].flatMap(index => [
      (value: CatalogFixture) => { value.inputSchema.anyOf[index].additionalProperties = true; },
      (value: CatalogFixture) => { delete value.inputSchema.anyOf[index].properties.model; },
      (value: CatalogFixture) => { value.inputSchema.anyOf[index].required = value.inputSchema.anyOf[index].required.filter(key => key !== 'requestId'); },
      (value: CatalogFixture) => { value.inputSchema.anyOf[index].properties.unexpected = {type:'boolean'}; },
    ]),
    value => { value.requiresRequestId = false; },
  ];
  for (const change of changes) {
    const altered = structuredClone(definition); change(altered);
    assert.throws(() => assertOperationInputBranches(altered), assert.AssertionError);
  }
});

test('one MCP process follows private desktop descriptor and token rotation, preserving durable state and conflicts', {timeout:30_000}, async (t: TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-mcp-v4-rotation-'));
  const dataDir = path.join(root, 'data');
  const tokenFile = path.join(root, 'mcp-token');
  const connectionFile = path.join(root, 'mcp-connection.json');
  let service = await startServer({dataDir, port:0, token});
  const publish = async (): Promise<void> => {
    await writeFile(tokenFile + '.next', service.token, {mode:0o600});
    await rename(tokenFile + '.next', tokenFile);
    await writeFile(connectionFile + '.next', JSON.stringify({version:1,url:service.url,tokenFile,pid:process.pid}), {mode:0o600});
    await rename(connectionFile + '.next', connectionFile);
  };
  await publish();
  t.after(async () => {await service.close(); await rm(root, {recursive:true, force:true});});
  const mcp = await bridge(t, {MIOON_CONNECTION_FILE:connectionFile});
  const processId = mcp.transport.pid;
  assert.ok(Number.isSafeInteger(processId) && Number(processId) > 0);
  const project = await mcp.call('project_create', {name:'Durable desktop rotation fixture'}) as {id: string};
  const shot = await mcp.call('shot_create', {projectId:project.id, title:'Before revision'}) as {id: string; revision: number};
  const updateInput = {shotId:shot.id, expectedRevision:shot.revision, patch:{title:'After revision'}};
  const updated = await mcp.call('shot_update', updateInput) as {revision: number; title: string};
  const conflict = await mcp.call('shot_update', updateInput, 'REVISION_CONFLICT') as ErrorEnvelope;
  assert.equal(conflict.details.currentRevision, updated.revision);
  const viaHttp = await httpRpc(service, 'shot.update', updateInput);
  assert.equal(viaHttp.status, 409); assert.equal(viaHttp.body.error?.code, conflict.code);
  assert.deepEqual(viaHttp.body.error?.details, conflict.details);
  const doctor = await mcp.call('mioon_doctor') as {ready?: boolean; connection: {source?: string; credentialsReloadedPerRequest?: boolean}; backend: {service?: string}};
  assert.equal(doctor.ready, true); assert.equal(doctor.connection.source, 'desktop-descriptor');
  assert.equal(doctor.connection.credentialsReloadedPerRequest, true);
  assert.equal(doctor.backend.service, 'mioon');
  const capabilities = await mcp.call('mioon_capabilities');
  assert.deepEqual(capabilities, (await httpRpc(service, 'provider.list')).body.data);
  assert.doesNotMatch(JSON.stringify(capabilities), /MAX_GENERATIONS|maxGenerations|usedGenerations|remainingGenerations/);
  const before = await mcp.call('project_get', {projectId:project.id}) as {shots: Array<{title: string}>};
  assert.equal(before.shots[0].title, updated.title);

  await service.close();
  const unavailable = await mcp.call('project_list', {}, 'BACKEND_UNAVAILABLE') as ErrorEnvelope;
  assert.ok(!JSON.stringify(unavailable).includes(token));
  assert.ok(!JSON.stringify(unavailable).includes(connectionFile));
  service = await startServer({dataDir, port:0, token:token + '-rotated'});
  await publish();
  assert.deepEqual(await mcp.call('project_get', {projectId:project.id}), before);
  assert.equal(mcp.transport.pid, processId, 'rotation must work without restarting the MCP stdio process');
  await mcp.call('shot_update', updateInput, 'REVISION_CONFLICT');

  const direct = await httpRpc(service, 'project.create', {name:'HTTP writes after rotation'});
  assert.equal(direct.body.ok, true);
  const projects = await mcp.call('project_list') as Array<{id: string}>;
  assert.ok(projects.some(item => item.id === (direct.body.data as {id?: string} | undefined)?.id));
  if (process.platform !== 'win32') {
    await chmod(tokenFile, 0o644);
    const unsafe = await mcp.call('project_list', {}, 'CONNECTION_CONFIG_ERROR') as ErrorEnvelope;
    assert.ok(!JSON.stringify(unsafe).includes(root));
    await chmod(tokenFile, 0o600);
    const recovered = await mcp.call('project_list') as Array<{id: string}>;
    assert.ok(recovered.some(item => item.id === project.id));
  }
  const allOutput = JSON.stringify([doctor, before, unavailable, conflict]) + mcp.stderr();
  assert.ok(!allOutput.includes(token));
  assert.ok(!allOutput.includes(root));
});

test('MCP rejects malformed arguments before backend mutation and sanitizes unsafe backend errors', {timeout:30_000}, async (t: TestContext) => {
  const calls: unknown[] = [];
  let mode = 'private-error';
  const fixture = http.createServer(async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const bytes of req) chunks.push(bytes as Buffer);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(mode === 'private-error' ? 409 : 200, {'content-type':'application/json'});
    if (mode === 'invalid-json') return res.end(`unexpected private backend text ${token}`);
    res.end(JSON.stringify({ok:false,error:{code:'REVISION_CONFLICT',message:`Rejected Bearer ${token}; raw token ${token}`,details:{token,authorization:token,tokenFile:'/private/hidden-token',safe:'retained',nested:{secret:token,reason:`private ${token}`}}}}));
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => fixture.close(() => resolve())));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Expected a bound TCP address');
  const mcp = await bridge(t, {MIOON_BASE_URL:`http://127.0.0.1:${address.port}`, MIOON_TOKEN:token});
  await mcp.call('project_list', {unexpected:true}, 'VALIDATION_ERROR');
  await mcp.call('timeline_clip_update', {projectId:randomUUID(), expectedRevision:1, requestId:randomUUID(), clipId:randomUUID(), patch:{}}, 'VALIDATION_ERROR');
  assert.equal(calls.length, 0, 'shared Zod refinement and strictness must run before HTTP');
  const error = await mcp.call('project_list', {}, 'REVISION_CONFLICT') as {code: string; details: {safe?: string; nested?: Record<string, unknown>; [key: string]: unknown}};
  assert.equal(error.details.safe, 'retained');
  for (const key of ['token','authorization','tokenFile']) assert.ok(!Object.hasOwn(error.details, key));
  assert.ok(!Object.hasOwn(error.details.nested ?? {}, 'secret'));
  assert.ok(!JSON.stringify(error).includes(token));
  assert.ok(!JSON.stringify(error).includes('/private/hidden-token'));
  mode = 'invalid-json';
  const malformed = await mcp.call('project_list', {}, 'BACKEND_PROTOCOL_ERROR');
  assert.ok(!JSON.stringify(malformed).includes(token));
  assert.ok(!mcp.stderr().includes(token));
  assert.equal(calls.length, 2);
});
