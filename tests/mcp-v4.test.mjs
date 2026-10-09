import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rename, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '@video-workbench/server';
import {schemas} from '@video-workbench/contracts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'synthetic-v4-mcp-token-never-live';
function environment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(WB_|RUNWAY|ARK_|VEO_|GOOGLE_|VIDEO_WORKBENCH_)/.test(key)) delete env[key];
  return {...env, VIDEO_WORKBENCH_ENABLE_LIVE_PROVIDER:'0', RUNWAY_MAX_GENERATIONS:'0', ...extra};
}
async function bridge(t, env = {}) {
  const client = new Client({name:'v4-protocol-regression', version:'1.0.0'}, {capabilities:{}});
  const transport = new StdioClientTransport({command:process.execPath, args:[path.join(repo,'apps/mcp/src/index.mjs')], cwd:repo, env:environment(env), stderr:'pipe'});
  let stderr = '';
  transport.stderr.on('data', bytes => stderr += bytes);
  t.after(() => client.close());
  await client.connect(transport);
  return {client, transport, stderr:() => stderr, async call(name, args = {}, errorCode) {
    const result = await client.callTool({name, arguments:args});
    const text = result.content.find(item => item.type === 'text');
    assert.ok(text, `${name} has a text fallback`);
    const envelope = JSON.parse(text.text);
    assert.deepEqual(result.structuredContent, envelope, `${name} structuredContent matches text`);
    assert.equal(envelope.ok, !errorCode, JSON.stringify(envelope));
    assert.equal(Boolean(result.isError), Boolean(errorCode), JSON.stringify(envelope));
    if (errorCode) {
      assert.equal(envelope.error.code, errorCode);
      assert.equal(typeof envelope.error.message, 'string');
      return envelope.error;
    }
    return envelope.data;
  }};
}
function objectShape(schema) {return schema.shape || objectShape(schema._def.schema || schema._def.innerType);}
async function httpRpc(service, operation, input = {}) {
  const response = await fetch(service.url + '/api/rpc', {method:'POST', headers:{authorization:`Bearer ${service.token}`, 'content-type':'application/json'}, body:JSON.stringify({operation,input})});
  return {status:response.status, body:await response.json()};
}

test('MCP initializes offline; discovery schemas exactly cover shared contracts and expose structured errors', {timeout:30_000}, async t => {
  const mcp = await bridge(t);
  assert.equal(mcp.client.getServerVersion().name, 'video-workbench');
  const listing = await mcp.client.listTools();
  const actual = listing.tools.map(tool => tool.name).sort();
  const expected = [...Object.keys(schemas).map(operation => operation.replaceAll('.','_')), 'workbench_doctor','workbench_capabilities','workbench_schema'].sort();
  assert.deepEqual(actual, expected);
  const catalog = await mcp.call('workbench_schema');
  assert.deepEqual(catalog.operations.map(item => item.operation).sort(), Object.keys(schemas).sort());
  for (const operation of Object.keys(schemas)) {
    const definition = catalog.operations.find(item => item.operation === operation);
    const tool = listing.tools.find(item => item.name === operation.replaceAll('.','_'));
    assert.equal(definition.toolName, tool.name);
    assert.equal(definition.command, operation.replaceAll('.',' '));
    assert.deepEqual(tool.inputSchema, definition.inputSchema, `${operation} uses one schema converter`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    const shape = objectShape(schemas[operation]);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), Object.keys(shape).sort());
    const required = Object.entries(shape).filter(([, field]) => !field.safeParse(undefined).success).map(([name]) => name).sort();
    assert.deepEqual([...(tool.inputSchema.required || [])].sort(), required, `${operation} required inputs`);
    assert.equal(definition.requiresRequestId, required.includes('requestId'));
  }
  const submit = await mcp.call('workbench_schema', {operation:'generation.submit'});
  assert.equal(submit.requiresRequestId, true);
  assert.deepEqual(submit, catalog.operations.find(item => item.operation === 'generation.submit'));
  assert.match(catalog.validation, /Zod/);
  await mcp.call('workbench_schema', {operation:'unregistered.operation'}, 'VALIDATION_ERROR');
  await mcp.call('workbench_schema', {unexpected:true}, 'VALIDATION_ERROR');
  await mcp.call('project_create', {name:'must not dispatch', unexpected:true}, 'VALIDATION_ERROR');
  await mcp.call('generation_submit', {shotId:randomUUID(), expectedRevision:1, providerId:'mock'}, 'VALIDATION_ERROR');
  await mcp.call('project_get', {projectId:'not-a-uuid'}, 'VALIDATION_ERROR');
  await mcp.call('unregistered_tool', {}, 'UNKNOWN_OPERATION');
  await mcp.call('project_list', {}, 'CONNECTION_CONFIG_ERROR');
  await mcp.call('workbench_doctor', {}, 'CONNECTION_CONFIG_ERROR');
  await mcp.call('workbench_capabilities', {}, 'CONNECTION_CONFIG_ERROR');
  assert.ok(!mcp.stderr().includes('Bearer'));
});

test('one MCP process follows private desktop descriptor and token rotation, preserving durable state and conflicts', {timeout:30_000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wb-mcp-v4-rotation-'));
  const dataDir = path.join(root, 'data');
  const tokenFile = path.join(root, 'mcp-token');
  const connectionFile = path.join(root, 'mcp-connection.json');
  let service = await startServer({dataDir, port:0, token});
  const publish = async () => {
    await writeFile(tokenFile + '.next', service.token, {mode:0o600});
    await rename(tokenFile + '.next', tokenFile);
    await writeFile(connectionFile + '.next', JSON.stringify({version:1,url:service.url,tokenFile,pid:process.pid}), {mode:0o600});
    await rename(connectionFile + '.next', connectionFile);
  };
  await publish();
  t.after(async () => {await service.close(); await rm(root, {recursive:true, force:true});});
  const mcp = await bridge(t, {WB_CONNECTION_FILE:connectionFile});
  const processId = mcp.transport.pid;
  assert.ok(Number.isSafeInteger(processId) && processId > 0);
  const project = await mcp.call('project_create', {name:'Durable desktop rotation fixture'});
  const shot = await mcp.call('shot_create', {projectId:project.id, title:'Before revision'});
  const updateInput = {shotId:shot.id, expectedRevision:shot.revision, patch:{title:'After revision'}};
  const updated = await mcp.call('shot_update', updateInput);
  const conflict = await mcp.call('shot_update', updateInput, 'REVISION_CONFLICT');
  assert.equal(conflict.details.currentRevision, updated.revision);
  const viaHttp = await httpRpc(service, 'shot.update', updateInput);
  assert.equal(viaHttp.status, 409); assert.equal(viaHttp.body.error.code, conflict.code);
  assert.deepEqual(viaHttp.body.error.details, conflict.details);
  const doctor = await mcp.call('workbench_doctor');
  assert.equal(doctor.ready, true); assert.equal(doctor.connection.source, 'desktop-descriptor');
  assert.equal(doctor.connection.credentialsReloadedPerRequest, true);
  assert.equal(doctor.backend.service, 'video-workbench');
  assert.deepEqual(await mcp.call('workbench_capabilities'), (await httpRpc(service, 'provider.list')).body.data);
  const before = await mcp.call('project_get', {projectId:project.id});
  assert.equal(before.shots[0].title, updated.title);

  await service.close();
  const unavailable = await mcp.call('project_list', {}, 'BACKEND_UNAVAILABLE');
  assert.ok(!JSON.stringify(unavailable).includes(token));
  assert.ok(!JSON.stringify(unavailable).includes(connectionFile));
  service = await startServer({dataDir, port:0, token:token + '-rotated'});
  await publish();
  assert.deepEqual(await mcp.call('project_get', {projectId:project.id}), before);
  assert.equal(mcp.transport.pid, processId, 'rotation must work without restarting the MCP stdio process');
  await mcp.call('shot_update', updateInput, 'REVISION_CONFLICT');

  const direct = await httpRpc(service, 'project.create', {name:'HTTP writes after rotation'});
  assert.equal(direct.body.ok, true);
  assert.ok((await mcp.call('project_list')).some(item => item.id === direct.body.data.id));
  if (process.platform !== 'win32') {
    await chmod(tokenFile, 0o644);
    const unsafe = await mcp.call('project_list', {}, 'CONNECTION_CONFIG_ERROR');
    assert.ok(!JSON.stringify(unsafe).includes(root));
    await chmod(tokenFile, 0o600);
    assert.ok((await mcp.call('project_list')).some(item => item.id === project.id));
  }
  const allOutput = JSON.stringify([doctor, before, unavailable, conflict]) + mcp.stderr();
  assert.ok(!allOutput.includes(token));
  assert.ok(!allOutput.includes(root));
});

test('MCP rejects malformed arguments before backend mutation and sanitizes unsafe backend errors', {timeout:30_000}, async t => {
  const calls = [];
  let mode = 'private-error';
  const fixture = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    calls.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(mode === 'private-error' ? 409 : 200, {'content-type':'application/json'});
    if (mode === 'invalid-json') return res.end(`unexpected private backend text ${token}`);
    res.end(JSON.stringify({ok:false,error:{code:'REVISION_CONFLICT',message:`Rejected Bearer ${token}; raw token ${token}`,details:{token,authorization:token,tokenFile:'/private/hidden-token',safe:'retained',nested:{secret:token,reason:`private ${token}`}}}}));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const mcp = await bridge(t, {WB_BASE_URL:`http://127.0.0.1:${fixture.address().port}`, WB_TOKEN:token});
  await mcp.call('project_list', {unexpected:true}, 'VALIDATION_ERROR');
  await mcp.call('timeline_clip_update', {projectId:randomUUID(), expectedRevision:1, requestId:randomUUID(), clipId:randomUUID(), patch:{}}, 'VALIDATION_ERROR');
  assert.equal(calls.length, 0, 'shared Zod refinement and strictness must run before HTTP');
  const error = await mcp.call('project_list', {}, 'REVISION_CONFLICT');
  assert.equal(error.details.safe, 'retained');
  for (const key of ['token','authorization','tokenFile']) assert.ok(!Object.hasOwn(error.details, key));
  assert.ok(!Object.hasOwn(error.details.nested, 'secret'));
  assert.ok(!JSON.stringify(error).includes(token));
  assert.ok(!JSON.stringify(error).includes('/private/hidden-token'));
  mode = 'invalid-json';
  const malformed = await mcp.call('project_list', {}, 'BACKEND_PROTOCOL_ERROR');
  assert.ok(!JSON.stringify(malformed).includes(token));
  assert.ok(!mcp.stderr().includes(token));
  assert.equal(calls.length, 2);
});
