import type {ClipDraftRaw} from '../apps/web/src/clip-draft-state.ts';
import type {ClipDraftFailure} from '../apps/web/src/clip-draft-client.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createClipDraftClient, createOpacityCandidateClipDraftClient, isOpacityCandidateClipDraftClient, admitClipDraftRequest, clipDraftFailure}
  from '../apps/web/src/clip-draft-client.ts';
import {LOCAL_DRAFT_LIMITS, clipDraftEnvelopeSchema} from '../packages/contracts/src/local-drafts.ts';
import {clipDraftOpacityCandidateEnvelopeSchema, clipDraftOpacityCandidateSlotSchema} from '../packages/contracts/src/local-drafts-opacity-candidate.ts';

const id = (n: number) => `db000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const key = {projectId: id(1), timelineId: id(2), clipId: id(3)};
const authority = {workspaceScope: 'a'.repeat(64), instanceId: id(4)};
const source = {assetId: id(5), assetSha256: 'b'.repeat(64)};
const raw: ClipDraftRaw = {name: '尚未送出 🎬', trackId: id(6), startFrame: '001', durationFrames: '120', sourceInFrame: '', rect: {x: 0, y: 0, width: 720, height: 1280}, gain: '0.50',
  volumeEnvelope: {profileId: 'mioon-clip-linear-attenuation-v1', points: [{frame: '', multiplier: '1e-'}]},
  opacityEnvelope: {profileId: 'mioon-clip-linear-opacity-v1', points: [{frame: '10', opacity: '.'}, {frame: '', opacity: '1e-'}, {frame: '10', opacity: ''}]}};
const input = () => ({...key, ...authority, expectedRevision: 7, baseRevision: 11, source: structuredClone(source), raw: structuredClone(raw)});
const removal = {...key, ...authority, expectedRevision: 7};
const envelope = (patch = {}) => ({supported: true, ...authority, key, revision: 8, targetStatus: 'matching',
  draft: {baseRevision: 11, source, raw: structuredClone(raw), updatedAt: '2026-10-16T00:00:00.000Z'}, ...patch});
const response = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify({ok: true, data}), init);
const failure = (code: string, status: number | null, kind: ClipDraftFailure['kind']) => (error: unknown) => {assert.deepEqual(clipDraftFailure(error), {code, status, kind});return true;};
const turn = () => new Promise(resolve => setImmediate(resolve));

test('the explicit candidate client preserves unfinished opacity text and unchanged HTTP authority on GET/PUT/DELETE', async () => {
  const calls: {url: Parameters<typeof fetch>[0]; init: RequestInit}[] = [], client = createOpacityCandidateClipDraftClient(async (url, init) => {calls.push({url, init: init!});return response(envelope());});
  assert.equal(isOpacityCandidateClipDraftClient(client), true);
  assert.deepEqual(await client.get(key), envelope());
  assert.deepEqual(await client.put(input()), envelope());
  assert.deepEqual(await client.remove(removal), envelope());
  assert.equal(calls[0].url, `/api/local-drafts/clip?${new URLSearchParams(key)}`);
  assert.equal(calls[0].init.body, undefined);
  assert.deepEqual(JSON.parse(calls[1].init.body as string), input());assert.deepEqual(JSON.parse(calls[2].init.body as string), removal);
  for (const {init} of calls) {assert.equal(init.credentials, 'same-origin');assert.equal(init.cache, 'no-store');}
  assert.deepEqual(JSON.parse(calls[1].init.body as string).raw.opacityEnvelope.points, raw.opacityEnvelope!.points, 'raw drafts do not canonicalize incomplete, repeated or unordered points');
});

test('legacy construction and public admission keep rejecting opacity before fetch, irrespective of payload or option flags', async () => {
  let calls = 0;
  const client = createClipDraftClient(async () => {calls++;return response(envelope());}, {opacityCandidate: true, profile: 3, mode: true} as unknown as NonNullable<Parameters<typeof createClipDraftClient>[1]>);
  assert.equal(isOpacityCandidateClipDraftClient(client), false);
  assert.throws(() => admitClipDraftRequest('PUT', input()), failure('LOCAL_DRAFT_VALIDATION', 400, 'refused'));
  await assert.rejects(client.put(input()), failure('LOCAL_DRAFT_VALIDATION', 400, 'refused'));
  assert.equal(calls, 0);
  await assert.rejects(client.get(key), failure('LOCAL_DRAFT_PROTOCOL_UNKNOWN', 200, 'unknown'));
  assert.equal(calls, 1);assert.equal(clipDraftEnvelopeSchema.safeParse(envelope()).success, false);
});

test('candidate identity cannot be copied, wrapped, proxied or manufactured by a payload', () => {
  const candidate = createOpacityCandidateClipDraftClient(async () => response(envelope()));
  for (const value of [{...candidate}, Object.create(candidate), new Proxy(candidate, {}),
    {candidate: true, version: 3, get: candidate.get, put: candidate.put, remove: candidate.remove}, input(), null, false] as const)
    assert.equal(isOpacityCandidateClipDraftClient(value), false);
  assert.equal(isOpacityCandidateClipDraftClient(candidate), true);
});

test('candidate write/envelope schemas remain closed, seven-point bounded, and preserve optional absent/null semantics', async () => {
  const candidates: ((value: ReturnType<typeof input>) => void)[] = [value => {(value.raw.opacityEnvelope! as unknown as {profileId: string}).profileId = 'unreviewed-opacity';},
    value => {value.raw.opacityEnvelope!.points = Array.from({length: 8}, () => ({frame: '', opacity: ''}));},
    value => {(value.raw.opacityEnvelope!.points[0] as unknown as {extra: boolean}).extra = true;}, value => {value.raw.opacityEnvelope!.points[0].opacity = 'NaN';},
    value => {(value.raw as unknown as {unknown: boolean}).unknown = true;}, value => {(value as unknown as {version: number}).version = 3;}];
  for (const modify of candidates) {
    let calls = 0;const value = input();modify(value);
    const client = createOpacityCandidateClipDraftClient(async () => {calls++;return response(envelope());});
    await assert.rejects(client.put(value), failure('LOCAL_DRAFT_VALIDATION', 400, 'refused'));assert.equal(calls, 0);
  }
  for (const opacity of ['absent', null] as const) {
    const value = input();if (opacity === 'absent') delete value.raw.opacityEnvelope;else value.raw.opacityEnvelope = null;
    const ack = envelope({draft: {...envelope().draft, raw: value.raw}});
    const client = createOpacityCandidateClipDraftClient(async () => response(ack));
    assert.deepEqual(await client.put(value), ack);
  }
});

test('candidate responses retain the complete row budget and inclusive streamed HTTP limit', async () => {
  const value = envelope(), slot = {...key, revision: value.revision, draft: value.draft};
  const spare = LOCAL_DRAFT_LIMITS.rowBytes - Buffer.byteLength(JSON.stringify(slot));
  assert.ok(spare > 0);value.draft.updatedAt = `2026-10-16T00:00:00.${'0'.repeat(3 + spare)}Z`;
  assert.equal(Buffer.byteLength(JSON.stringify(slot)), LOCAL_DRAFT_LIMITS.rowBytes);
  assert.equal(clipDraftOpacityCandidateSlotSchema.safeParse(slot).success, true);
  assert.equal(clipDraftOpacityCandidateEnvelopeSchema.safeParse(value).success, true);
  const base = JSON.stringify({ok: true, data: value}), serialized = base + ' '.repeat(LOCAL_DRAFT_LIMITS.httpBytes - Buffer.byteLength(base)), data = new TextEncoder().encode(serialized);
  const client = createOpacityCandidateClipDraftClient(async () => new Response(new ReadableStream({start(controller) {
    for (let i = 0; i < data.length; i += 97) controller.enqueue(data.subarray(i, i + 97));controller.close();
  }}), {headers: {'Content-Length': String(data.length)}}));
  assert.deepEqual(await client.get(key), value);
  value.draft.updatedAt = value.draft.updatedAt.replace('Z', '0Z');
  const oversizedRow = createOpacityCandidateClipDraftClient(async () => response(value));
  await assert.rejects(oversizedRow.get(key), failure('LOCAL_DRAFT_PROTOCOL_UNKNOWN', 200, 'unknown'));
  for (const declared of [String(LOCAL_DRAFT_LIMITS.httpBytes + 1), '01'] as const) {
    const oversizedHTTP = createOpacityCandidateClipDraftClient(async () => response(envelope(), {headers: {'Content-Length': declared}}));
    await assert.rejects(oversizedHTTP.get(key), failure('LOCAL_DRAFT_PROTOCOL_UNKNOWN', 200, 'unknown'));
  }
  const excessive = createOpacityCandidateClipDraftClient(async () => new Response(JSON.stringify({ok: true, data: envelope()}).padEnd(LOCAL_DRAFT_LIMITS.httpBytes + 1, ' ')));
  await assert.rejects(excessive.get(key), failure('LOCAL_DRAFT_PROTOCOL_UNKNOWN', 200, 'unknown'));
});

test('candidate outgoing complete serialized row and HTTP budgets refuse before fetch without pruning fields', async () => {
  let calls = 0;const client = createOpacityCandidateClipDraftClient(async () => {calls++;return response(envelope());});
  const row = input();row.raw.name = '\u0000'.repeat(1400);
  assert.ok(Buffer.byteLength(JSON.stringify(row)) < LOCAL_DRAFT_LIMITS.httpBytes);
  await assert.rejects(client.put(row), failure('LOCAL_DRAFT_LIMIT', 413, 'refused'));
  const http = input();http.raw.name = '\u0000'.repeat(2200);
  await assert.rejects(client.put(http), failure('LOCAL_DRAFT_LIMIT', 413, 'refused'));
  assert.equal(calls, 0);assert.equal(row.raw.name.length, 1400);
});

test('candidate transport preserves exact error evidence and unsupported handling', async () => {
  for (const [code, status, kind] of [['LOCAL_DRAFT_CONFLICT', 409, 'conflict'], ['LOCAL_DRAFT_VALIDATION', 400, 'refused'],
    ['LOCAL_DRAFT_CONFLICT', 400, 'unknown'], ['LOCAL_DRAFT_SAVE_UNCERTAIN', 503, 'unknown']] as const) {
    const client = createOpacityCandidateClipDraftClient(async () => new Response(JSON.stringify({ok: false,
      error: {code, message: 'Synthetic refusal evidence', details: {}, retryable: false}}), {status}));
    await assert.rejects(client.put(input()), failure(code, status, kind));
  }
  const unsupported = {supported: false, reason: 'RESTORED_WORKSPACE_UNSUPPORTED'}, client = createOpacityCandidateClipDraftClient(async () => response(unsupported));
  assert.deepEqual(await client.get(key), unsupported);
  await assert.rejects(client.put(input()), failure('LOCAL_DRAFT_WRITE_UNSUPPORTED', null, 'unknown'));
  const network = createOpacityCandidateClipDraftClient(async () => {throw Error('No synthetic acknowledgement');});
  await assert.rejects(network.put(input()), failure('LOCAL_DRAFT_NETWORK_UNKNOWN', null, 'unknown'));
});

for (const body of [false, true] as const) test(`candidate deadline covers hanging ${body ? 'body' : 'headers'} without retries or accepting late evidence`, async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: Date.now()});
  const gate = Promise.withResolvers<Response>();let calls = 0, signal!: AbortSignal, cancelled = 0;
  const hanging = new Response(new ReadableStream({start(controller) {if (body) controller.enqueue(new TextEncoder().encode('{"ok":true,'));}, cancel() {cancelled++;}}));
  const client = createOpacityCandidateClipDraftClient(async (_url, init) => {calls++;signal = init!.signal!;return body ? hanging : gate.promise;}, {timeoutMs: 25});
  const outcome = client.put(input());const rejected = assert.rejects(outcome, failure('LOCAL_DRAFT_TIMEOUT_UNKNOWN', null, 'unknown'));
  await turn();t.mock.timers.tick(25);await rejected;
  assert.equal(signal.aborted, true);assert.equal(calls, 1);
  if (!body) {gate.resolve(hanging);await turn();}
  assert.equal(cancelled, 1);assert.equal(calls, 1);
});
