import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createGeminiOmniClient, getOmniFailure, getOmniTaskFailure} from '../packages/business/src/video/gemini-omni.ts';
import {isOmniTaskLookupFailure} from '../packages/business/src/video/gemini-omni-errors.ts';
import type {VideoAdapterInput} from '../packages/business/src/video/adapters.ts';

const API = 'https://generativelanguage.googleapis.com/v1beta', MODEL = 'gemini-omni-1.2-flash', ID = 'v1_synthetic-123';
const KEY = 'synthetic-omni-not-a-real-key';
const MP4 = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
const FILE = 'synthetic-file';
const URI = API + '/files/' + FILE + ':download?alt=media';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
const interaction = (status = 'in_progress', extra: Record<string, unknown> = {}) =>
  ({id: ID, model: MODEL, object: 'interaction', status, ...extra});
const completed = (video: Record<string, unknown> = {data: MP4.toString('base64')}) =>
  interaction('completed', {steps: [{type: 'user_input', content: [{type: 'video', data: 'ignored-input'}]},
    {type: 'model_output', content: [{type: 'video', mime_type: 'video/mp4', ...video}]}]});
const input = (): VideoAdapterInput => ({prompt: 'A synthetic wooden cube rolls on a white table.', aspectRatio: '16:9', duration: 3,
  parameters: {resolution: '360p'}, images: [], subjectReference: false});
type Queued = Response | Error | ((init: RequestInit) => Promise<Response>);
async function fixture(t: test.TestContext, outputHosts?: string[]) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mioon-omni-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const calls: {url: string; init: RequestInit}[] = [], queue: Queued[] = [];
  let acquisitions = 0, acquireError: Error | undefined;
  const client = createGeminiOmniClient({api: API, model: MODEL, root, outputHosts,
    acquireCredential: async () => {acquisitions++; if (acquireError) throw acquireError; return KEY;},
    fetchImpl: async (url, init) => {
      calls.push({url: String(url), init: init ?? {}});
      const response = queue.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(init ?? {});
      assert.ok(response, 'Real provider HTTP is forbidden');
      return response;
    }});
  return {client, root, calls, queue, acquisitions: () => acquisitions, revoke(error: Error) {acquireError = error;}};
}

test('Omni wire request uses fixed Interactions API and background receipt without submitting again', async t => {
  const f = await fixture(t); let fences = 0;
  f.queue.push(json(interaction()));
  assert.deepEqual(await f.client.submit(input(), {beforeSubmit: () => {fences++;}}), {providerJobId: ID});
  assert.equal(f.calls.length, 1); assert.equal(fences, 1); assert.equal(f.acquisitions(), 1);
  const call = f.calls[0]!;
  assert.equal(call.url, API + '/interactions'); assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error');
  assert.equal(new Headers(call.init.headers).get('x-goog-api-key'), KEY);
  assert.deepEqual(JSON.parse(String(call.init.body)), {model: MODEL, input: [{type: 'text', text: input().prompt}],
    response_format: {type: 'video', delivery: 'uri', duration: '3s', resolution: '360p', aspect_ratio: '16:9'},
    generation_config: {video_config: {task: 'text_to_video'}}, background: true, store: true, stream: false});
});

test('Omni accepts background receipt and GET without optional model/object echoes, rejecting present mismatches', async t => {
  const f = await fixture(t);
  f.queue.push(json({id: ID, status: 'in_progress'}));
  assert.deepEqual(await f.client.submit(input()), {providerJobId: ID});
  f.queue.push(json({id: ID, status: 'in_progress'}));
  assert.deepEqual(await f.client.retrieve(ID), {id: ID, status: 'running', progress: 0});
  for (const badEcho of [{model: 'veo-3.1-generate-preview'}, {model: null}, {object: 'operation'}, {object: null}]) {
    f.queue.push(json({id: ID, status: 'in_progress', ...badEcho}));
    await assert.rejects(f.client.submit(input()), {code: 'SUBMISSION_UNKNOWN', uncertain: true});
    f.queue.push(json({id: ID, status: 'in_progress', ...badEcho}));
    await assert.rejects(f.client.retrieve(ID), {code: 'INVALID_PROVIDER_RESPONSE'});
  }
});

test('Omni first frame preserves raw bytes, MIME and order using explicit image_to_video', async t => {
  const f = await fixture(t), frame = Buffer.from('synthetic-frame');
  const request = input(); request.images = [{role: 'first_frame', mimeType: 'image/png', base64: frame.toString('base64')}];
  f.queue.push(json(interaction()));
  await f.client.submit(request);
  const body = JSON.parse(String(f.calls[0]!.init.body)) as Record<string, unknown>;
  assert.deepEqual(body.input, [{type: 'image', data: frame.toString('base64'), mime_type: 'image/png'}, {type: 'text', text: request.prompt}]);
  assert.deepEqual(body.generation_config, {video_config: {task: 'image_to_video'}});
  assert.doesNotMatch(String(f.calls[0]!.init.body), /generateAudio|previous_interaction_id|files.upload|data:image/);
});

test('Omni local capability validation blocks unsupported mode, role, MIME, duration and empty prompt before I/O', async t => {
  const f = await fixture(t);
  for (const request of [
    {...input(), duration: 2}, {...input(), duration: 16}, {...input(), duration: 3.5},
    {...input(), prompt: ''}, {...input(), aspectRatio: '1:1'},
    {...input(), subjectReference: true}, {...input(), parameters: {seed: 1}},
    {...input(), audios: [{mimeType: 'audio/wav', base64: 'AAAA'}]},
    {...input(), images: [{role: 'last_frame', mimeType: 'image/png', base64: 'AAAA'}]},
    {...input(), images: [{role: 'first_frame', mimeType: 'image/webp', base64: 'AAAA'}]},
    {...input(), images: [{role: 'first_frame', mimeType: 'image/png', base64: 'not base64'}]},
    {...input(), images: Array(2).fill({role: 'first_frame', mimeType: 'image/png', base64: 'AAAA'})},
  ]) await assert.rejects(f.client.submit(request));
  assert.equal(f.calls.length, 0); assert.equal(f.acquisitions(), 0);
});

test('Omni allows documented end durations and resolutions while audio remains native by default', async t => {
  const f = await fixture(t);
  for (const duration of [3, 15]) for (const resolution of ['360p', '720p', '1080p', '4k']) {
    f.queue.push(json(interaction()));
    await f.client.submit({...input(), duration, aspectRatio: '9:16', parameters: {resolution}});
  }
  assert.equal(f.calls.length, 8);
});

for (const id of ['../escape', 'v1_?secret', 'https://evil.example/task', '', 'x'.repeat(201)])
  test('Omni rejects invalid existing interaction ID before credentials or network ' + JSON.stringify(id.slice(0, 30)), async t => {
    const f = await fixture(t);
    await assert.rejects(f.client.retrieve(id), {code: 'INVALID_PROVIDER_TASK_ID'});
    await assert.rejects(f.client.download(id, path.join(f.root, 'result.mp4')), {code: 'INVALID_PROVIDER_TASK_ID'});
    assert.equal(f.acquisitions(), 0); assert.equal(f.calls.length, 0);
  });

test('Omni in-progress and inline completed observations contain no media, prompt or credential', async t => {
  const f = await fixture(t); f.queue.push(json(interaction()), json(completed()));
  assert.deepEqual(await f.client.retrieve(ID), {id: ID, status: 'running', progress: 0});
  assert.deepEqual(await f.client.retrieve(ID), {id: ID, status: 'succeeded', progress: 1});
  assert.equal(f.calls.length, 2); assert.equal(f.acquisitions(), 2);
});

test('Omni retrieves inline MP4 over the previous 1 MiB JSON limit and writes through managed media staging', async t => {
  const f = await fixture(t), bytes = Buffer.concat([MP4, Buffer.alloc(1024 * 1024, 3)]), output = path.join(f.root, 'video.mp4');
  f.queue.push(json(completed({data: bytes.toString('base64')})));
  assert.deepEqual(await f.client.download(ID, output), {mimeType: 'video/mp4', sizeBytes: bytes.length, isMock: false});
  assert.deepEqual(await readFile(output), bytes);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.url, API + '/interactions/' + ID);
  assert.equal(f.acquisitions(), 2, 'The write reacquires permission after receiving media');
  assert.deepEqual(await readdir(f.root), ['video.mp4']);
});

test('Omni URI output waits for ACTIVE file then downloads fixed authenticated media route', async t => {
  const f = await fixture(t), output = path.join(f.root, 'video.mp4');
  f.queue.push(json(completed({uri: URI})), json({name: 'files/' + FILE, state: 'PROCESSING'}),
    json(completed({uri: URI})), json({name: 'files/' + FILE, state: 'ACTIVE'}), new Response(MP4));
  assert.deepEqual(await f.client.retrieve(ID), {id: ID, status: 'running', progress: 0});
  assert.deepEqual(await f.client.download(ID, output), {mimeType: 'video/mp4', sizeBytes: MP4.length, isMock: false});
  assert.deepEqual(f.calls.map(call => [call.url, call.init.method]), [
    [API + '/interactions/' + ID, 'GET'], [API + '/files/' + FILE, 'GET'],
    [API + '/interactions/' + ID, 'GET'], [API + '/files/' + FILE, 'GET'], [URI, 'GET'],
  ]);
  assert.equal(f.acquisitions(), 5);
  assert.equal(new Headers(f.calls[4]!.init.headers).get('x-goog-api-key'), KEY);
});

test('Omni strips the key on every redirect, including a return to the API host', async t => {
  const f = await fixture(t, ['result.example']), output = path.join(f.root, 'video.mp4');
  f.queue.push(json(completed({uri: URI})), json({name: 'files/' + FILE, state: 'ACTIVE'}),
    new Response(null, {status: 302, headers: {location: 'https://result.example/result.mp4'}}),
    new Response(null, {status: 302, headers: {location: URI}}), new Response(MP4));
  await f.client.download(ID, output);
  assert.equal(new Headers(f.calls[2]!.init.headers).get('x-goog-api-key'), KEY);
  assert.equal(new Headers(f.calls[3]!.init.headers).get('x-goog-api-key'), null);
  assert.equal(new Headers(f.calls[4]!.init.headers).get('x-goog-api-key'), null);
});

for (const uri of ['https://evil.example/file', URI + '&key=echoed', URI + '#fragment', API + '/files/../escape:download', API + '/files/x:download?alt=json'])
  test('Omni rejects unapproved result URI without forwarding key ' + uri.split('?')[0], async t => {
    const f = await fixture(t); f.queue.push(json(completed({uri})));
    await assert.rejects(f.client.retrieve(ID));
    assert.equal(f.calls.length, 1);
  });

for (const [status, code, message] of [
  [401, 'authentication', 'Invalid API key'], [403, 'permission_denied', 'Permission denied'],
  [402, 'payment_required', 'Your prepayment credits are depleted'],
  [429, 'quota_exceeded', 'Quota exceeded'], [429, 'rate_limit_exceeded', 'Rate limit exceeded'],
  [404, 'model_not_found', 'Model not found'], [400, 'safety', 'Safety violations blocked the request'],
] as const) test('Omni retains safe documented rejection evidence ' + code, async t => {
  const f = await fixture(t); f.queue.push(json({error: {type: code, code, message: message + ': ' + KEY, details: {private: KEY}}}, status));
  await assert.rejects(f.client.submit(input()), error => {
    const own = error as Error & {code: string; httpStatus: number; uncertain: boolean};
    assert.equal(own.code, 'PROVIDER_HTTP_' + status); assert.equal(own.httpStatus, status); assert.equal(own.uncertain, false);
    assert.deepEqual(getOmniFailure(error), {providerType: code, code, message, httpStatus: status});
    assert.doesNotMatch(String(error) + JSON.stringify(error) + JSON.stringify(getOmniFailure(error)), new RegExp(KEY));
    assert.equal(getOmniFailure({...own}), undefined, 'Only transport-owned evidence can be persisted');
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('Omni unknown error labels, echoed input and unsafe error messages are excluded', async t => {
  const f = await fixture(t); f.queue.push(json({error: {type: KEY, code: KEY, message: 'Echoing private input ' + KEY}}, 400));
  await assert.rejects(f.client.submit(input()), error => {
    assert.deepEqual(getOmniFailure(error), {httpStatus: 400});
    assert.doesNotMatch(String(error) + JSON.stringify(error), new RegExp(KEY));
    return true;
  });
});

test('Omni failed interaction retains safe evidence through the private task helper', async t => {
  const f = await fixture(t); f.queue.push(json(interaction('failed', {error: {code: 'safety', message: 'Content blocked: ' + KEY}})));
  const task = await f.client.retrieve(ID);
  assert.deepEqual(task, {id: ID, status: 'failed'});
  assert.deepEqual(getOmniTaskFailure(task), {code: 'safety', message: 'Content blocked'});
  assert.equal(getOmniTaskFailure({...task}), undefined);
  assert.doesNotMatch(JSON.stringify(task), /Content blocked|synthetic-omni/);
});

test('Omni documented interaction errors array retains the first safe diagnostic only', async t => {
  const f = await fixture(t);
  f.queue.push(json(interaction('failed', {errors: [{code: 'safety', message: 'Content blocked'},
    {code: KEY, message: KEY}]})));
  const task = await f.client.retrieve(ID);
  assert.deepEqual(task, {id: ID, status: 'failed'});
  assert.deepEqual(getOmniTaskFailure(task), {code: 'safety', message: 'Content blocked'});
  f.queue.push(json(interaction('failed', {errors: Array(33).fill({code: KEY, message: KEY})})));
  assert.deepEqual(getOmniTaskFailure(await f.client.retrieve(ID)), {});
  f.queue.push(json(interaction('failed', {errors: [{code: 'https://unverified.example/' + KEY, message: KEY}]})));
  assert.deepEqual(getOmniTaskFailure(await f.client.retrieve(ID)), {});
});

test('Omni failed file processing preserves canonical Files error details', async t => {
  const f = await fixture(t); f.queue.push(json(completed({uri: URI})), json({name: 'files/' + FILE, state: 'FAILED', error: {code: 13, message: 'Internal error: ' + KEY}}));
  const task = await f.client.retrieve(ID);
  assert.deepEqual(task, {id: ID, status: 'failed'});
  assert.deepEqual(getOmniTaskFailure(task), {code: '13', message: 'Internal error'});
});

test('Omni distinguishes missing interaction from missing output-file metadata', async t => {
  const f = await fixture(t);
  f.queue.push(json({error: {code: 'not_found', message: 'Invalid request'}}, 404));
  await assert.rejects(f.client.retrieve(ID), error => {
    assert.equal(isOmniTaskLookupFailure(error), true);
    assert.equal(isOmniTaskLookupFailure({...error as object}), false);
    return true;
  });
  f.queue.push(json(completed({uri: URI})), json({error: {code: 'not_found', message: 'Invalid request'}}, 404));
  await assert.rejects(f.client.retrieve(ID), error => {
    assert.equal(isOmniTaskLookupFailure(error), false);
    assert.equal((error as {httpStatus?: number}).httpStatus, 404);
    return true;
  });
});

test('Omni credential rejection on output download keeps HTTP status for existing-task recovery', async t => {
  const f = await fixture(t); f.queue.push(json(completed({uri: URI})), json({name: 'files/' + FILE, state: 'ACTIVE'}),
    json({error: {code: 'authentication', message: 'Invalid API key'}}, 401));
  await assert.rejects(f.client.download(ID, path.join(f.root, 'video.mp4')), error => {
    assert.equal((error as {httpStatus?: number}).httpStatus, 401);
    assert.deepEqual(getOmniFailure(error), {code: 'authentication', message: 'Invalid API key', httpStatus: 401});
    return true;
  });
  assert.deepEqual(await readdir(f.root), []);
});

for (const reply of [new Error(KEY), json({error: {message: KEY}}, 503), new Response('{broken'), json({id: ID, status: 'unknown'})])
  test('Omni ambiguous POST stays unknown with one dispatch', async t => {
    const f = await fixture(t); f.queue.push(reply);
    await assert.rejects(f.client.submit(input()), {code: 'SUBMISSION_UNKNOWN', uncertain: true});
    assert.equal(f.calls.length, 1);
  });

test('Omni before-submit owner fence and cancellation reject without a POST', async t => {
  const f = await fixture(t), controller = new AbortController(), fence = Object.assign(new Error('owner closed'), {code: 'OWNER_CLOSED'});
  controller.abort();
  await assert.rejects(f.client.submit(input(), {signal: controller.signal}), {code: 'OPERATION_CANCELLED', beforeDispatch: true});
  await assert.rejects(f.client.submit(input(), {beforeSubmit: () => {throw fence;}}), error => error === fence);
  assert.equal(f.calls.length, 0);
});

test('Omni cancellation after POST never authorizes automatic re-submission', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.queue.push(async init => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(Error(KEY)), {once: true});
    queueMicrotask(() => controller.abort());
  }));
  await assert.rejects(f.client.submit(input(), {signal: controller.signal}), {code: 'SUBMISSION_UNKNOWN', uncertain: true});
  assert.equal(f.calls.length, 1);
});

test('Omni rejects oversized declared responses and cleans partial outputs', async t => {
  const f = await fixture(t), maximum = Math.ceil(128 * 1024 * 1024 / 3) * 4 + 64 * 1024;
  f.queue.push(new Response('{}', {headers: {'content-length': String(maximum + 1)}}));
  await assert.rejects(f.client.retrieve(ID), {code: 'INVALID_PROVIDER_RESPONSE'});
  f.queue.push(json(completed({data: Buffer.from('invalid mp4 container').toString('base64')})));
  await assert.rejects(f.client.download(ID, path.join(f.root, 'video.mp4')), {code: 'INVALID_OUTPUT_MEDIA'});
  assert.deepEqual(await readdir(f.root), []);
});

test('Omni oversized streamed error body is cancelled without retaining private details', async t => {
  const f = await fixture(t); let cancelled = false;
  f.queue.push(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1).fill(65));
    },
    cancel() {cancelled = true;},
  }), {status: 400}));
  await assert.rejects(f.client.submit(input()), error => {
    assert.deepEqual(getOmniFailure(error), {httpStatus: 400});
    return true;
  });
  assert.equal(cancelled, true); assert.equal(f.calls.length, 1);
});

test('Omni cancellation of a stalled GET body cancels the stream and writes no file', async t => {
  const f = await fixture(t), controller = new AbortController(); let cancelled = false, chunks = 0;
  f.queue.push(async () => new Response(new ReadableStream<Uint8Array>({
    pull(stream) {
      if (chunks++ === 0) stream.enqueue(Buffer.from('{"id":'));
      else controller.abort();
    },
    cancel() {cancelled = true;},
  })));
  await assert.rejects(f.client.download(ID, path.join(f.root, 'video.mp4'), {signal: controller.signal}));
  assert.equal(cancelled, true); assert.deepEqual(await readdir(f.root), []);
});

test('Omni revoked credentials prevent a later output read and never reuse a cached key', async t => {
  const f = await fixture(t), rejected = Object.assign(new Error('credential removed'), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  f.queue.push(json(completed())); await f.client.retrieve(ID); f.revoke(rejected);
  await assert.rejects(f.client.download(ID, path.join(f.root, 'video.mp4')), error => error === rejected);
  assert.equal(f.calls.length, 1); assert.equal(f.acquisitions(), 2);
});

test('Omni key removal after inline response preserves the exact credential failure before writing', async t => {
  const f = await fixture(t), rejected = Object.assign(new Error('credential removed'), {code: 'VIDEO_SETTINGS_NOT_CONFIGURED'});
  f.queue.push(async () => {
    f.revoke(rejected);
    return json(completed());
  });
  await assert.rejects(f.client.download(ID, path.join(f.root, 'video.mp4')), error => error === rejected);
  assert.equal(f.calls.length, 1); assert.deepEqual(await readdir(f.root), []);
});

test('Omni rejects mismatched model, ID, missing video, ambiguous outputs and forged SDK convenience fields', async t => {
  const f = await fixture(t);
  for (const value of [
    {...completed(), model: 'veo-3.1-generate-preview'}, {...completed(), id: 'other'},
    interaction('completed', {steps: []}), interaction('completed', {output_video: {data: MP4.toString('base64')}}),
    completed({data: MP4.toString('base64'), uri: URI}), completed({mime_type: 'text/html', data: 'AAAA'}),
    interaction('completed', {steps: [{type: 'model_output', content: [1, 2].map(() => ({type: 'video', mime_type: 'video/mp4', data: 'AAAA'}))}]}),
  ]) {
    f.queue.push(json(value));
    await assert.rejects(f.client.retrieve(ID), {code: 'INVALID_PROVIDER_RESPONSE'});
  }
});
