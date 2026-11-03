import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient, discoverSchema, modelOperationDefinition, operationDefinition} from '../packages/client/src/index.ts';
import {schemas as modelSchemas} from '../packages/contracts/src/index.ts';
import {assetImportSchema, toAssetMediaDto} from '../packages/contracts/src/asset-media.ts';
import {isPrevisPublicationResponse, previsPublicationIdentity, previsPublicationInputSchema} from '../packages/contracts/src/previs-publication.ts';
import {publishPrevisOutput} from '../apps/web/src/previs/previs-publication.ts';

const projectId = '11111111-1111-4111-8111-111111111111', nodeId = '22222222-2222-4222-8222-222222222222', assetId = '33333333-3333-4333-8333-333333333333';
const sha256 = 'a'.repeat(64), input = {projectId, nodeId, keyframeId: 'k1', sceneRevision: 2, requestId: 'previs-output-request', name: 'K1.png', sha256, width: 64, height: 96, dataBase64: 'cG5n'};
const identity = previsPublicationIdentity(input), asset = toAssetMediaDto({id: assetId, projectId, name: input.name, mimeType: 'image/png', provenance: 'generated', width: input.width, height: input.height,
  referenceRevision: 1, sha256, sizeBytes: 3, reference: {pathForm: 'relative', path: '生成/previs.png', volume: null, sizeBytes: 3, mtimeMs: 1, sampledSha256: sha256, fullSha256: sha256}});
const response = {...identity, asset};

test('previs publication is discoverable only through the public registry and fixes all output authority', () => {
  assert.equal(Object.hasOwn(modelSchemas, 'previs.output.publish'), false);
  assert.throws(() => modelOperationDefinition('previs.output.publish'), {code: 'UNKNOWN_OPERATION'});
  const operations = (discoverSchema() as {operations: {operation: string}[]}).operations.map(item => item.operation);
  assert.ok(operations.includes('previs.output.publish')); assert.ok(operations.includes('previs.output.lookup'));
  const publish = operationDefinition('previs.output.publish'), lookup = operationDefinition('previs.output.lookup');
  assert.equal(publish.requiresRequestId, true); assert.equal(publish.effects.paidGeneration, false); assert.equal(publish.effects.fileWrite, true);
  assert.equal(lookup.effects.readOnly, true); assert.equal(lookup.effects.databaseWrite, false); assert.equal(lookup.effects.fileWrite, false);
  for (const extra of [{targetKind: 'exports'}, {sourcePath: '/other/image.png'}, {provenance: 'generated'}, {publicationId: assetId}, {assetId}, {mimeType: 'image/png'}])
    assert.equal(previsPublicationInputSchema.safeParse({...input, ...extra}).success, false);
  assert.equal(assetImportSchema.safeParse({projectId, name: input.name, mimeType: 'image/png', dataBase64: input.dataBase64, provenance: 'generated'}).success, false);
});

test('previs acknowledgements bind the complete saved scene and exact request rather than equal image hashes', () => {
  assert.equal(isPrevisPublicationResponse('previs.output.publish', input, response), true);
  assert.equal(isPrevisPublicationResponse('previs.output.lookup', identity, response), true);
  assert.equal(isPrevisPublicationResponse('previs.output.publish', input, null), false);
  assert.equal(isPrevisPublicationResponse('previs.output.lookup', identity, null), true);
  for (const changed of [{requestId: 'other-request'}, {nodeId: assetId}, {projectId: assetId}, {keyframeId: 'k2'}, {sceneRevision: 3}, {sha256: 'b'.repeat(64)}, {width: 65}, {height: 97}, {name: 'other.png'}])
    assert.equal(isPrevisPublicationResponse('previs.output.publish', input, {...response, ...changed}), false, JSON.stringify(changed));
  assert.equal(isPrevisPublicationResponse('previs.output.publish', input, {...response, asset: {...asset, provenance: 'user-import'}}), false);
});

test('client addresses previs by project and rejects an unrelated acknowledgement even with the same PNG hash', async () => {
  const calls: {url: string; body: Record<string, unknown>}[] = [];
  let reply: unknown = response;
  const client = createClient({env: {MIOON_BASE_URL: 'http://127.0.0.1:12345', MIOON_TOKEN: 'synthetic-local-token'}, fetchImpl: async (url, options) => {
    calls.push({url: String(url), body: JSON.parse(String(options?.body)) as Record<string, unknown>}); return Response.json({ok: true, data: reply});
  }});
  assert.deepEqual(await client.rpc('previs.output.publish', input), response);
  assert.equal(calls[0]!.url, `http://127.0.0.1:12345/api/projects/${projectId}/rpc`);
  reply = {...response, requestId: 'other-request'};
  await assert.rejects(client.rpc('previs.output.publish', input), {code: 'BACKEND_PROTOCOL_ERROR'});
  reply = null; assert.equal(await client.rpc('previs.output.lookup', identity), null);
  await assert.rejects(client.rpc('previs.output.publish', {...input, provenance: 'generated'}), {code: 'VALIDATION_ERROR'});
  assert.equal(calls.length, 3, 'invalid caller authority never reaches transport');
});

test('lost previs ACK uses only exact lookup and never retries publication or searches the library', async () => {
  const calls: {operation: string; input: Record<string, unknown>}[] = [];
  const rpc = async (operation: string, value: Record<string, unknown>): Promise<unknown> => {
    calls.push({operation, input: value}); if (operation === 'previs.output.publish') throw new Error('lost acknowledgement'); return response;
  };
  assert.deepEqual(await publishPrevisOutput(input, rpc), {status: 'imported', assetId});
  assert.deepEqual(calls, [{operation: 'previs.output.publish', input}, {operation: 'previs.output.lookup', input: identity}]);
  assert.deepEqual(await publishPrevisOutput(input, async operation => operation === 'previs.output.publish' ? {...response, requestId: 'someone-else'} : null), {status: 'unknown'});
  assert.deepEqual(await publishPrevisOutput(input, async operation => operation === 'previs.output.publish' ? {...response, requestId: 'someone-else'} : {...response, keyframeId: 'k2'}), {status: 'unknown'});
});

test('definite previs rejection does not query or publish again', async () => {
  let calls = 0;
  const outcome = await publishPrevisOutput(input, async () => {calls++; throw {definitive: true, status: 409, code: 'REVISION_CONFLICT'};});
  assert.deepEqual(outcome, {status: 'failed', code: 'REVISION_CONFLICT'}); assert.equal(calls, 1);
});
