import type {SchemaNode} from './helpers/strict-timeline-audio-types.ts';
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

const projectId = '11111111-1111-4111-8111-111111111111';
const inspections = ['project.inspect','asset.inspect','shot.inspect','timeline.inspect'] as const;
const paged = new Set(['asset.inspect', 'shot.inspect']);
const repo = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(MIOON_|RUNWAY|ARK_|VEO_|MINIMAX_|VIDU_|GOOGLE_|GEMINI_)/.test(name)));

test('inspection arguments are strict and authority-free; RPC project scope is separate', () => {
  assert.deepEqual(Object.keys(inspectionArgumentSchemas).sort(), [...inspections].sort());
  assert.deepEqual(Object.keys(inspectionSchemas).sort(), [...inspections].sort());
  for (const operation of inspections) {
    const args = inspectionArgumentSchemas[(operation as keyof typeof inspectionArgumentSchemas)], rpc = inspectionSchemas[operation];
    const expected = paged.has(operation) ? {limit:10} : {};
    assert.deepEqual(args.parse({}), expected);
    assert.deepEqual(rpc.parse({projectId}), {...expected, projectId});
    assert.deepEqual(parse((operation as unknown as Parameters<typeof parse>[0]), {projectId}), {...expected, projectId});
    assert.equal(schemas[(operation as keyof typeof schemas)], rpc);
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
    const definition = operationDefinition(operation), rpcSchema = definition.inputSchema as SchemaNode;
    assert.equal(rpcSchema.additionalProperties, false);
    assert.deepEqual(rpcSchema.required, ['projectId']);
    assert.equal(rpcSchema.properties.projectId.format, 'uuid');
    assert.deepEqual(Object.keys((jsonSchema(args) as SchemaNode).properties).sort(), paged.has(operation) ? ['cursor','limit'] : []);
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
  const readOnly = new Set([...inspections, 'export.activity.get', 'export.output.get', 'workspace.settings.get', 'workspace.backup.status', 'workspace.backup.list', 'task.disposition.list', 'project.summary.list', 'previs.thumbnail.get', 'agent.authorization.list', 'timeline.colour.source.inspect', 'timeline.colour.image.inspect', 'timeline.colour.jpeg.inspect', 'lut.list', 'lut.inspect', 'lut.look.inspect', 'timeline.audioPreview.continuousPlan', 'asset.annotation.list', 'workspace.backup.inspect', 'workspace.restore.inspect', 'frame.request.get', 'frame.task.get', 'frame.task.list', 'scene.request.get', 'scene.task.get', 'scene.task.list', 'scene.result.get', 'image.review.get', 'image.review.list', 'image.profile.list', 'image.request.get', 'image.task.remote.get', 'image.task.get', 'image.task.list', 'image.group.get', 'image.group.list', 'image.version.list', 'subject.list', 'subject.version.list', 'subject.binding.list', 'subject.variants.get', 'subject.variants.list', 'project.list', 'asset.list', 'asset.range.get', 'asset.disposition.list', 'asset.waveform.get', 'provider.list', 'video.connection.list', 'job.get', 'job.list', 'version.list', 'export.get', 'timeline.history.get', 'timeline.export.preflight', 'timeline.export.capabilities', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.loudness.prepare', 'timeline.clip.loudness', 'timeline.audioPreview.plan', 'timeline.format.get']);
  for (const [operation, effect] of Object.entries(operationEffects)) {
    assert.equal(Object.isFrozen(effect), true);
    assert.equal(effect.notes!.length > 20, true);
    for (const field of ['readOnly', 'idempotent', 'destructive', 'openWorld', 'databaseWrite', 'fileWrite', 'externalIO', 'localProcess', 'paidGeneration'])
      assert.equal(typeof effect[(field as keyof typeof effect)], 'boolean', `${operation}: ${field}`);
    assert.equal(effect.readOnly, readOnly.has(operation), operation);
    assert.deepEqual(operationDefinition(operation).effects, effect);
    assert.deepEqual((discoverSchema({operation}) as ReturnType<typeof operationDefinition>).effects, effect);
    const annotations = effectAnnotations(effect);
    assert.deepEqual(ToolAnnotationsSchema.parse(annotations), annotations);
    assert.equal(annotations.readOnlyHint, effect.readOnly);
    assert.equal(annotations.idempotentHint, effect.idempotent);
    assert.equal(annotations.destructiveHint, effect.destructive);
    assert.equal(annotations.openWorldHint, effect.openWorld);
    if (effect.readOnly) {
      assert.equal(effect.idempotent, true);
      for (const field of ['databaseWrite', 'externalIO', 'paidGeneration', 'destructive', 'openWorld'])
        assert.equal(effect[(field as keyof typeof effect)], false, `${operation}: ${field}`);
      // Only the explicit v2 capability observation may create bounded, owned
      // synthetic scratch files. Read-only business semantics do not imply zero
      // temporary filesystem effects; no other read receives this exception.
      assert.equal(effect.fileWrite, operation === 'timeline.export.capabilities', `${operation}: fileWrite`);
      assert.equal(effect.localProcess, ['timeline.colour.source.inspect', 'timeline.colour.jpeg.inspect', 'timeline.export.preflight', 'timeline.export.capabilities', 'timeline.export.samplePeak', 'timeline.export.loudness', 'timeline.loudness.prepare', 'timeline.clip.loudness'].includes(operation), `${operation}: localProcess`);
    }
  }
  assert.equal(Object.isFrozen(operationEffects), true);
  for (const operation of ['project.get', 'timeline.get']) {
    assert.equal(operationEffects[(operation as keyof typeof operationEffects)].readOnly, false);
    assert.equal(operationEffects[(operation as keyof typeof operationEffects)].databaseWrite, true);
    assert.equal(operationEffects[(operation as keyof typeof operationEffects)].idempotent, true);
  }
  for (const operation of ['generation.submit', 'job.retry']) {
    for (const field of ['databaseWrite', 'externalIO', 'openWorld', 'fileWrite', 'localProcess', 'paidGeneration', 'idempotent'])
      assert.equal(operationEffects[(operation as keyof typeof operationEffects)][field as keyof import("../packages/contracts/src/operation-effects.ts").OperationEffect], true);
  }
  assert.equal(operationEffects['job.reconcile'].externalIO, true);
  assert.equal(operationEffects['job.reconcile'].idempotent, false);
  assert.equal(operationEffects['job.reconcile'].paidGeneration, false);
  for (const operation of ['export.create', 'timeline.render']) {
    assert.equal(operationEffects[(operation as keyof typeof operationEffects)].localProcess, true);
    assert.equal(operationEffects[(operation as keyof typeof operationEffects)].fileWrite, true);
    assert.equal(operationEffects[(operation as keyof typeof operationEffects)].externalIO, false);
  }
  assert.equal(operationEffects['export.cancel'].fileWrite, true, 'cancellation cleans only its owned part and unpublished output');
  assert.equal(operationEffects['export.cancel'].localProcess, true, 'cancellation terminates only its owned media process');
  for (const operation of ['timeline.track.add', 'timeline.clip.add', 'timeline.seed'])
    assert.equal(operationEffects[(operation as keyof typeof operationEffects)].destructive, true, 'new edits can discard redo history');
  for (const name of ['doctor', 'capabilities', 'schema']) {
    assert.equal(discoveryEffects[(name as keyof typeof discoveryEffects)].readOnly, true);
    assert.equal(discoveryEffects[(name as keyof typeof discoveryEffects)].externalIO, false);
  }
});

test('offline CLI schema and official MCP list/schema expose identical inspection contracts and effects', {timeout:30_000}, async (t: test.TestContext) => {
  const env = environment();
  const cli = async (operation?: string|undefined) => {
    const {stdout, stderr} = await run(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), 'schema', ...(operation ? [operation] : [])], {cwd:repo, env, timeout:10_000});
    assert.equal(stderr, '');
    const envelope = JSON.parse(stdout);
    assert.equal(envelope.ok, true);
    return envelope.data;
  };
  const client = new Client({name:'inspection-contracts-offline', version:'1.0.0'}, {capabilities:{}});
  const transport = new StdioClientTransport({command:process.execPath, args:[path.join(repo, 'apps/mcp/src/index.ts')], cwd:repo,env:env as Record<string,string>,stderr:'pipe'});
  (transport.stderr as import("node:stream").Readable|null)?.resume();
  t.after(() => client.close());
  await client.connect(transport);
  const call = async (name: string, args = {}) => {
    const result = (await client.callTool({name, arguments:args}) as import("@modelcontextprotocol/sdk/types.js").CallToolResult);
    const envelope = JSON.parse((result.content.find(item=>item.type==='text') as {text:string}).text);
    assert.deepEqual(result.structuredContent, envelope);
    assert.equal(Boolean(result.isError), !envelope.ok);
    return envelope;
  };
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...Object.keys(schemas).map(operation => operation.replaceAll('.', '_')), 'mioon_doctor', 'mioon_capabilities', 'mioon_schema'].sort());
  const cliCatalog = await cli() as Extract<ReturnType<typeof discoverSchema>,{operations:unknown}>, mcpCatalog = await call('mioon_schema');
  assert.equal(mcpCatalog.ok, true);
  assert.deepEqual(mcpCatalog.data, cliCatalog);
  assert.deepEqual(cliCatalog, discoverSchema());
  for (const operation of Object.keys(schemas)) {
    const definition = cliCatalog.operations.find((item: { operation: string; }) => item.operation === operation);
    const tool = tools.find(item => item.name === definition!.toolName);
    assert.deepEqual(tool!.inputSchema, definition!.inputSchema);
    assert.deepEqual(tool!.annotations, effectAnnotations(definition!.effects));
  }
  for (const operation of inspections) {
    assert.deepEqual(await cli(operation), operationDefinition(operation));
    assert.deepEqual((await call('mioon_schema', {operation})).data, operationDefinition(operation));
    const toolName = operation.replaceAll('.', '_');
    assert.equal((await call(toolName, {projectId, token:'must-not-dispatch'})).error.code, 'VALIDATION_ERROR');
    assert.equal((await call(toolName, {projectId})).error.code, 'CONNECTION_CONFIG_ERROR');
  }
  for(const [providerId,model,options] of [['mock',IMAGE_MODELS.mock,IMAGE_FIXED_OPTIONS],['openai',IMAGE_MODELS.openai,IMAGE_FIXED_OPTIONS],['openai-compatible','vendor/model',IMAGE_FIXED_OPTIONS],['comfy-local','model.safetensors',COMFY_IMAGE_OPTIONS]] as const){
    const input={projectId,requestId:'comfy-catalog-request',name:'Schema example',prompt:'One tree',providerId,model,options};
    assert.equal(schemas['image.generate'].safeParse(input).success,true);
    assert.equal((await call('image_generate',input)).error.code,'CONNECTION_CONFIG_ERROR');
    assert.equal((await call('image_generate',{...input,seed:1})).error.code,'VALIDATION_ERROR');
  }
  for (const name of ['doctor', 'capabilities', 'schema'])
    assert.deepEqual(tools.find(tool => tool.name === `mioon_${name}`)!.annotations, effectAnnotations(discoveryEffects[(name as keyof typeof discoveryEffects)]));
  assert.equal((await call('mioon_doctor')).error.code, 'CONNECTION_CONFIG_ERROR');
  assert.equal((await call('mioon_capabilities')).error.code, 'CONNECTION_CONFIG_ERROR');
});

test('Comfy remote operations have truthful effects',()=>{
 const read=operationEffects['image.task.remote.get'],observe=operationEffects['image.task.observeRemote'];
 assert.equal(read.readOnly,true);assert.equal(read.externalIO,false);assert.equal(read.databaseWrite,false);
 for(const field of ['databaseWrite','externalIO','fileWrite','openWorld','idempotent'])assert.equal(observe[(field as keyof typeof observe)],true,field);
 for(const field of ['readOnly','paidGeneration','localProcess','destructive'])assert.equal(observe[(field as keyof typeof observe)],false,field);
});
