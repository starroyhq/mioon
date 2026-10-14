import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ToolAnnotationsSchema} from '@modelcontextprotocol/sdk/types.js';
import {schemas, inspectionArgumentSchemas, inspectionSchemas, operationEffects,IMAGE_FIXED_OPTIONS,IMAGE_MODELS,COMFY_IMAGE_OPTIONS,
  operationEffect, assertOperationEffectCoverage, effectAnnotations, parse} from '@mioon/contracts';
import {operationDefinition, discoverSchema, discoveryEffects, jsonSchema} from '@mioon/client';
import {readToolRequestFields, chatToolAccumulator, responseToolSnapshot} from '../packages/business/src/agent/tool-wire.mjs';

const projectId = '11111111-1111-4111-8111-111111111111';
const inspections = ['project.inspect', 'asset.inspect', 'shot.inspect', 'timeline.inspect'];
const paged = new Set(['asset.inspect', 'shot.inspect']);
const repo = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MIOON_|RUNWAY|ARK_|VEO_|MINIMAX_|VIDU_|GOOGLE_|GEMINI_)/.test(name)));

test('inspection arguments are strict and authority-free; RPC project scope is separate', () => {
  assert.deepEqual(Object.keys(inspectionArgumentSchemas).sort(), [...inspections].sort());
  assert.deepEqual(Object.keys(inspectionSchemas).sort(), [...inspections].sort());
  for (const operation of inspections) {
    const args = inspectionArgumentSchemas[operation], rpc = inspectionSchemas[operation];
    const expected = paged.has(operation) ? {limit:10} : {};
    assert.deepEqual(args.parse({}), expected);
    assert.deepEqual(rpc.parse({projectId}), {...expected, projectId});
    assert.deepEqual(parse(operation, {projectId}), {...expected, projectId});
    assert.equal(schemas[operation], rpc);
    assert.equal(args.safeParse({projectId}).success, false);
    assert.equal(rpc.safeParse({}).success, false);
    for (const input of [{projectId:'bad-id'}, {projectId, unknown:true}, {projectId, projectIdOverride:projectId}])
      assert.equal(rpc.safeParse(input).success, false);
    for (const field of ['authority', 'authorization', 'token', 'apiKey', 'userId', 'sessionId', 'scope', 'providerId', 'model', 'requestId', 'path', 'url']) {
      assert.equal(args.safeParse({[field]:'injected'}).success, false, `${operation}: ${field}`);
      assert.equal(rpc.safeParse({projectId, [field]:'injected'}).success, false, `${operation} RPC: ${field}`);
    }
    if (paged.has(operation)) {
      assert.deepEqual(args.parse({limit:1, cursor:'a'.repeat(512)}), {limit:1, cursor:'a'.repeat(512)});
      assert.deepEqual(args.parse({limit:25}), {limit:25});
      for (const limit of [0, -1, 26, 1.5, '10', null, NaN, Infinity])
        assert.equal(args.safeParse({limit}).success, false);
      for (const cursor of ['a'.repeat(513), 1, {}, null])
        assert.equal(args.safeParse({cursor}).success, false);
    } else {
      for (const input of [{limit:10}, {cursor:'opaque'}]) assert.equal(args.safeParse(input).success, false);
    }
    const definition = operationDefinition(operation), rpcSchema = definition.inputSchema;
    assert.equal(rpcSchema.additionalProperties, false);
    assert.deepEqual(rpcSchema.required, ['projectId']);
    assert.equal(rpcSchema.properties.projectId.format, 'uuid');
    assert.deepEqual(Object.keys(jsonSchema(args).properties).sort(), paged.has(operation) ? ['cursor','limit'] : []);
    assert.equal(definition.requiresRequestId, false);
    if (paged.has(operation)) {
      assert.deepEqual(rpcSchema.properties.limit, {type:'integer', minimum:1, maximum:25, default:10});
      assert.deepEqual(rpcSchema.properties.cursor, {type:'string', maxLength:512});
    }
  }
});

test('every shared operation has a complete explicit frozen effect descriptor; unknown operations fail closed', () => {
  assert.deepEqual(Object.keys(operationEffects).sort(), Object.keys(schemas).sort());
  assert.doesNotThrow(() => assertOperationEffectCoverage(schemas));
  assert.throws(() => assertOperationEffectCoverage({...schemas, 'future.get':schemas['project.list']}), /missing: future\.get/);
  assert.throws(() => assertOperationEffectCoverage(schemas, {...operationEffects, 'future.list':operationEffects['project.list']}), /unknown: future\.list/);
  for (const operation of ['future.get', 'future.list', 'future.inspect', 'constructor', '__proto__'])
    assert.throws(() => operationEffect(operation), /not defined/);
  assert.throws(() => effectAnnotations(undefined), /Explicit operation effects/);
  assert.throws(() => effectAnnotations({readOnly:true}), /Explicit operation effects/);
  const readOnly = new Set([...inspections, 'workspace.backup.inspect', 'workspace.restore.inspect', 'frame.request.get', 'frame.task.get', 'frame.task.list', 'image.review.get', 'image.review.list', 'image.profile.list', 'image.request.get', 'image.task.remote.get', 'image.task.get', 'image.task.list', 'image.group.get', 'image.group.list', 'image.version.list', 'subject.list', 'subject.version.list', 'subject.binding.list', 'project.list', 'asset.list', 'asset.range.get', 'asset.disposition.list', 'asset.waveform.get', 'provider.list', 'job.get', 'job.list', 'version.list', 'export.get', 'timeline.history.get', 'timeline.export.preflight', 'timeline.export.capabilities', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.audioPreview.plan', 'timeline.format.get']);
  for (const [operation, effect] of Object.entries(operationEffects)) {
    assert.equal(Object.isFrozen(effect), true);
    assert.equal(effect.notes.length > 20, true);
    for (const field of ['readOnly', 'idempotent', 'destructive', 'openWorld', 'databaseWrite', 'fileWrite', 'externalIO', 'localProcess', 'paidGeneration'])
      assert.equal(typeof effect[field], 'boolean', `${operation}: ${field}`);
    assert.equal(effect.readOnly, readOnly.has(operation), operation);
    assert.deepEqual(operationDefinition(operation).effects, effect);
    assert.deepEqual(discoverSchema({operation}).effects, effect);
    const annotations = effectAnnotations(effect);
    assert.deepEqual(ToolAnnotationsSchema.parse(annotations), annotations);
    assert.equal(annotations.readOnlyHint, effect.readOnly);
    assert.equal(annotations.idempotentHint, effect.idempotent);
    assert.equal(annotations.destructiveHint, effect.destructive);
    assert.equal(annotations.openWorldHint, effect.openWorld);
    if (effect.readOnly) {
      assert.equal(effect.idempotent, true);
      for (const field of ['databaseWrite', 'externalIO', 'paidGeneration', 'destructive', 'openWorld'])
        assert.equal(effect[field], false, `${operation}: ${field}`);
      // Only the explicit v2 capability observation may create bounded, owned
      // synthetic scratch files. Read-only business semantics do not imply zero
      // temporary filesystem effects; no other read receives this exception.
      assert.equal(effect.fileWrite, operation === 'timeline.export.capabilities', `${operation}: fileWrite`);
      assert.equal(effect.localProcess, ['timeline.export.preflight', 'timeline.export.capabilities', 'timeline.export.samplePeak', 'timeline.export.loudness'].includes(operation), `${operation}: localProcess`);
    }
  }
  assert.equal(Object.isFrozen(operationEffects), true);
  for (const operation of ['project.get', 'timeline.get']) {
    assert.equal(operationEffects[operation].readOnly, false);
    assert.equal(operationEffects[operation].databaseWrite, true);
    assert.equal(operationEffects[operation].idempotent, true);
  }
  for (const operation of ['generation.submit', 'job.retry']) {
    for (const field of ['databaseWrite', 'externalIO', 'openWorld', 'fileWrite', 'localProcess', 'paidGeneration', 'idempotent'])
      assert.equal(operationEffects[operation][field], true);
  }
  assert.equal(operationEffects['job.reconcile'].externalIO, true);
  assert.equal(operationEffects['job.reconcile'].idempotent, false);
  assert.equal(operationEffects['job.reconcile'].paidGeneration, false);
  for (const operation of ['export.create', 'timeline.render']) {
    assert.equal(operationEffects[operation].localProcess, true);
    assert.equal(operationEffects[operation].fileWrite, true);
    assert.equal(operationEffects[operation].externalIO, false);
  }
  for (const operation of ['timeline.track.add', 'timeline.clip.add', 'timeline.seed'])
    assert.equal(operationEffects[operation].destructive, true, 'new edits can discard redo history');
  for (const name of ['doctor', 'capabilities', 'schema']) {
    assert.equal(discoveryEffects[name].readOnly, true);
    assert.equal(discoveryEffects[name].externalIO, false);
  }
});

test('offline CLI schema and official MCP list/schema expose identical inspection contracts and effects', {timeout:30_000}, async t => {
  const env = environment();
  const cli = async operation => {
    const {stdout, stderr} = await run(process.execPath, [path.join(repo, 'apps/cli/src/index.mjs'), 'schema', ...(operation ? [operation] : [])], {cwd:repo, env, timeout:10_000});
    assert.equal(stderr, '');
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    return envelope.data;
  };
  const client = new Client({name:'inspection-contracts-offline', version:'1.0.0'}, {capabilities:{}});
  const transport = new StdioClientTransport({command:process.execPath, args:[path.join(repo, 'apps/mcp/src/index.mjs')], cwd:repo, env, stderr:'pipe'});
  transport.stderr?.resume();
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({name, arguments:args});
    const envelope = JSON.parse(result.content.find(item => item.type === 'text').text);
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), !envelope.ok);
    return envelope;
  };
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...Object.keys(schemas).map(operation => operation.replaceAll('.', '_')), 'mioon_doctor', 'mioon_capabilities', 'mioon_schema'].sort());
  const cliCatalog = await cli(), mcpCatalog = await call('mioon_schema');
  assert.equal(mcpCatalog.ok, true);
  assert.deepEqual(mcpCatalog.data, cliCatalog);
  assert.deepEqual(cliCatalog, discoverSchema());
  for (const operation of Object.keys(schemas)) {
    const definition = cliCatalog.operations.find(item => item.operation === operation);
    const tool = tools.find(item => item.name === definition.toolName);
    assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.deepEqual(tool.annotations, effectAnnotations(definition.effects));
  }
  for (const operation of inspections) {
    assert.deepEqual(await cli(operation), operationDefinition(operation));
    assert.deepEqual((await call('mioon_schema', {operation})).data, operationDefinition(operation));
    const toolName = operation.replaceAll('.', '_');
    assert.equal((await call(toolName, {projectId, token:'must-not-dispatch'})).error.code, 'VALIDATION_ERROR');
    assert.equal((await call(toolName, {projectId})).error.code, 'CONNECTION_CONFIG_ERROR');
  }
  for(const [providerId,model,options] of [['mock',IMAGE_MODELS.mock,IMAGE_FIXED_OPTIONS],['openai',IMAGE_MODELS.openai,IMAGE_FIXED_OPTIONS],['openai-compatible','vendor/model',IMAGE_FIXED_OPTIONS],['comfy-local','model.safetensors',COMFY_IMAGE_OPTIONS]]){
    const input={projectId,requestId:'comfy-catalog-request',name:'Schema example',prompt:'One tree',providerId,model,options};
    assert.equal(schemas['image.generate'].safeParse(input).success,true);
    assert.equal((await call('image_generate',input)).error.code,'CONNECTION_CONFIG_ERROR');
    assert.equal((await call('image_generate',{...input,seed:1})).error.code,'VALIDATION_ERROR');
  }
  for (const name of ['doctor', 'capabilities', 'schema'])
    assert.deepEqual(tools.find(tool => tool.name === `mioon_${name}`).annotations, effectAnnotations(discoveryEffects[name]));
  assert.equal((await call('mioon_doctor')).error.code, 'CONNECTION_CONFIG_ERROR');
  assert.equal((await call('mioon_capabilities')).error.code, 'CONNECTION_CONFIG_ERROR');
});

// Public service effects describe I/O, not built-in model authority.
test('shared subject operations cannot enter either protocol built-in Agent catalog or parser', () => {
  const readNames = ['mioon_project_inspect', 'mioon_asset_inspect', 'mioon_shot_inspect', 'mioon_timeline_inspect'];
  const operations = Object.keys(schemas).filter(name => name.startsWith('subject.'));
  assert.equal(operations.length, 6);
  for (const scope of [undefined, 'selected_shot_edit']) {
    const request = {phase:'request', ...(scope ? {scope} : {})};
    for (const protocol of ['chat_completions', 'responses']) {
      const fields = readToolRequestFields({presetId:'openai', protocol}, request);
      assert.deepEqual(fields.tools.map(tool => protocol === 'responses' ? tool.name : tool.function.name),
        scope ? ['mioon_propose_shot_update'] : readNames);
    }
    for (const operation of operations) for (const name of [operation, `mioon_${operation.replaceAll('.', '_')}`]) {
      assert.throws(() => chatToolAccumulator(request).add([{index:0, id:'call-subject', type:'function', function:{name, arguments:'{}'}}]), {code:'AGENT_CHAT_TOOLS_UNSUPPORTED'});
      assert.throws(() => responseToolSnapshot({id:'item-subject', call_id:'call-subject', type:'function_call', name, arguments:'{}', status:'completed'}, 'completed', request), {code:'AGENT_CHAT_TOOLS_UNSUPPORTED'});
    }
  }
});

// Public observation capability is separate from built-in model tool authority.
test('Comfy remote operations have truthful effects and remain outside built-in Agent tools',()=>{
 const read=operationEffects['image.task.remote.get'],observe=operationEffects['image.task.observeRemote'];
 assert.equal(read.readOnly,true);assert.equal(read.externalIO,false);assert.equal(read.databaseWrite,false);
 for(const field of ['databaseWrite','externalIO','fileWrite','openWorld','idempotent'])assert.equal(observe[field],true,field);
 for(const field of ['readOnly','paidGeneration','localProcess','destructive'])assert.equal(observe[field],false,field);
 for(const scope of [undefined,'selected_shot_edit']){const request={phase:'request',...(scope?{scope}:{})};for(const operation of ['image.task.remote.get','image.task.observeRemote'])for(const name of [operation,`mioon_${operation.replaceAll('.','_')}`]){
  assert.throws(()=>chatToolAccumulator(request).add([{index:0,id:'call-comfy',type:'function',function:{name,arguments:'{}'}}]),{code:'AGENT_CHAT_TOOLS_UNSUPPORTED'});
  assert.throws(()=>responseToolSnapshot({id:'item-comfy',call_id:'call-comfy',type:'function_call',name,arguments:'{}',status:'completed'},'completed',request),{code:'AGENT_CHAT_TOOLS_UNSUPPORTED'});
 }}
});
