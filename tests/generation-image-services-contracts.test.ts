import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClient, discoverSchema} from '../packages/client/src/index.ts';
import {IMAGE_FIXED_OPTIONS, canonicalImageInput} from '../packages/contracts/src/images.ts';
import {IMAGE_REVIEW_POLICY, imageReviewIntentSchema, imageReviewResponseSchema, imageReviewSchemas} from '../packages/contracts/src/image-reviews.ts';
import {DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2} from '../packages/contracts/src/generation-image-settings.ts';
import {generationImageServiceSchemas, isGenerationImageServiceResponse} from '../packages/contracts/src/generation-image-services.ts';

const generation = () => ({projectId: randomUUID(), requestId: randomUUID(), providerId: 'openai-compatible' as const,
  name: 'Synthetic service image', prompt: 'A synthetic contract fixture', model: 'same-model', options: {...IMAGE_FIXED_OPTIONS}});
function fixture() {
  const input = generation(), connectionId = randomUUID(), configurationRevision = 1;
  const configuration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION_V2, enabled: true, baseUrl: 'https://images.example.com/v1', model: input.model};
  const request = {input, connectionId, configurationRevision};
  const timestamp = '2026-11-04T00:00:00.000Z', reviewId = randomUUID();
  const intent = {schemaVersion: 6, reviewId, input, settingsRevision: configurationRevision, connectionId, configurationRevision,
    configuration, destination: 'https://images.example.com/v1/images/generations', policy: {...IMAGE_REVIEW_POLICY}};
  const response = {id: reviewId, projectId: input.projectId, requestId: input.requestId, input, inputHash: 'a'.repeat(64),
    settingsRevision: configurationRevision, connectionId, configurationRevision, configuration, destination: intent.destination,
    policy: intent.policy, state: 'pending', revision: 1, taskId: null, postAttempts: 0, createdAt: timestamp, updatedAt: timestamp,
    approvedAt: null, rejectedAt: null, dispatchedAt: null};
  return {request, intent, response};
}

test('new intent freezes the UUID and per-service revision without relaxing the retained custom branch', () => {
  const {request, intent, response} = fixture();
  assert.equal(imageReviewIntentSchema.safeParse(intent).success, true);
  assert.equal(imageReviewResponseSchema.safeParse(response).success, true);
  assert.equal(isGenerationImageServiceResponse('image.service.review.prepare', request, response), true);
  for (const patch of [{schemaVersion: 7}, {connectionId: 'custom'}, {connectionId: request.connectionId.toUpperCase()},
    {configurationRevision: 2}, {configuration: {...intent.configuration, connectionId: 'custom'}},
    {configuration: {...intent.configuration, model: 'another-model'}}, {destination: 'https://another.example.com/v1/images/generations'},
    {apiKey: 'synthetic-untrusted-key'}]) assert.equal(imageReviewIntentSchema.safeParse({...intent, ...patch}).success, false);
  const {connectionId: ignored, configurationRevision: ignoredRevision, ...legacy} = intent; void ignored; void ignoredRevision;
  assert.equal(imageReviewIntentSchema.safeParse({...legacy, schemaVersion: 2, configuration: {...intent.configuration, connectionId: 'custom'}}).success, true);
  assert.equal(imageReviewIntentSchema.safeParse({...legacy, schemaVersion: 2, configuration: {...intent.configuration, connectionId: request.connectionId}}).success, false);
  for (const patch of [{connectionId: randomUUID()}, {configurationRevision: 2, settingsRevision: 2},
    {input: {...response.input, requestId: randomUUID()}}, {input: {...response.input, projectId: randomUUID()}}])
    assert.equal(isGenerationImageServiceResponse('image.service.review.prepare', request, {...response, ...patch}), false);
  assert.equal(imageReviewSchemas['image.review.prepare'].safeParse({input: request.input, settingsRevision: 1, connectionId: request.connectionId}).success, false);
});

test('shared client uses the strict project HTTP path, keeps caller identity and leaves RPC discovery unchanged', async () => {
  const {request, response} = fixture(), calls: {url: string; options: RequestInit}[] = [];
  const client = createClient({env: {MIOON_TOKEN: 'synthetic-g1-client-token'}, fetchImpl: async (url, options) => {
    calls.push({url: String(url), options: options!});
    return new Response(JSON.stringify({ok: true, data: response}), {headers: {'content-type': 'application/json'}});
  }});
  const before = canonicalImageInput(request);
  assert.deepEqual(await client.generationImages('image.service.review.prepare', request), response);
  assert.equal(canonicalImageInput(request), before);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, `/api/projects/${request.input.projectId}/images/services`);
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(String(calls[0].options.body)), {operation: 'image.service.review.prepare', input: request});
  await assert.rejects(client.generationImages('image.service.review.prepare', request, {projectId: randomUUID()}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(client.generationImages('image.service.review.prepare', {...request, approved: true}), {code: 'VALIDATION_ERROR'});
  await assert.rejects(client.rpc('image.service.review.prepare', request), {code: 'UNKNOWN_OPERATION'});
  assert.throws(() => discoverSchema({operation: 'image.service.review.prepare'}));
  assert.equal(calls.length, 1);
});

test('shared client refuses another same-model same-revision service ACK without retrying the preparation', async () => {
  const {request, response} = fixture(); let calls = 0;
  const client = createClient({env: {MIOON_TOKEN: 'synthetic-g1-client-token'}, fetchImpl: async () => {
    calls++; return new Response(JSON.stringify({ok: true, data: {...response, connectionId: randomUUID()}}));
  }});
  await assert.rejects(client.generationImages('image.service.review.prepare', request), (error: unknown) => {
    const value = error as {code: string; details: {requestId: string; submissionMayHaveSucceeded: boolean}};
    assert.equal(value.code, 'BACKEND_PROTOCOL_ERROR'); assert.equal(value.details.requestId, request.input.requestId);
    assert.equal(value.details.submissionMayHaveSucceeded, true); return true;
  });
  assert.equal(calls, 1);
  const query = {projectId: request.input.projectId};
  assert.equal(generationImageServiceSchemas['image.service.list'].safeParse({...query, connectionId: request.connectionId}).success, false);
  assert.equal(isGenerationImageServiceResponse('image.service.list', query, {projectId: randomUUID(), items: []}), false);
});
