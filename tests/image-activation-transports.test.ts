import type {FixtureImageReview,FixtureImageTask,ServiceResponse} from './helpers/strict-service-responses.ts';
import type {RpcEnvelope} from './helpers/strict-timeline-audio-types.ts';
interface ActivationRequest extends EventEmitter{destroy():void;end(payload:string):void}
interface ActivationRequestOptions{method?:string;input?:unknown;raw?:BodyInit;authenticated?:boolean;headers?:Record<string,string>;base?:string}
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import type {TypedClient} from './helpers/strict-service-responses.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {createClient} from '../packages/client/src/index.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, isImageTaskResponse} from '../packages/contracts/src/images.ts';
import {DEFAULT_IMAGE_CONFIGURATION} from '../packages/contracts/src/image-settings.ts';
import {isImageReviewResponse} from '../packages/contracts/src/image-reviews.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';
import type { PathLike } from 'fs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'synthetic-image-activation-http-token';
const syntheticKey = 'SYNTHETIC_IMAGE_ACTIVATION_NOT_A_REAL_KEY';
const delay = (ms: number|undefined) => new Promise(resolve => setTimeout(resolve, ms));
const inputFor = (projectId: unknown) => ({projectId, requestId: randomUUID(), name: 'Synthetic activation fixture',
  providerId: 'openai', model: IMAGE_MODELS.openai, prompt: 'A local synthetic transport fixture, never a live model test.', options: {...IMAGE_FIXED_OPTIONS}});
const approvalFor = (review: Pick<FixtureImageReview,"projectId"|"id">) => ({projectId: review.projectId, reviewId: review.id, expectedRevision: 1});
function publicOnly(value: unknown, root: string) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(syntheticKey) && !text.includes(token) && !text.includes(root), 'no private credential or path in response');
  assert.ok(!/"(?:apiKey|authorization|canonicalInput|canonicalIntent|stagedReceipt|b64_json|relativePath)"\s*:/i.test(text));
}
function childEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(?:MIOON_|RUNWAY|ARK_|VEO_|GEMINI_|GOOGLE_|MINIMAX_|VIDU_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|NODE_OPTIONS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)) delete env[key];
  return {...env, MIOON_ENABLE_LIVE_PROVIDER: '0', ...extra};
}
async function cli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...args], {cwd: repo,
    env: childEnvironment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGKILL');});
  child.stderr.setEncoding('utf8').on('data', chunk => {stderr = (stderr + chunk).slice(-20000);});
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  let result; try {result = await once(child, 'close');} finally {clearTimeout(timer);}
  assert.deepEqual(result, [0, null], stderr); assert.ok(!stdout.includes(syntheticKey) && !stderr.includes(token));
  const envelope = JSON.parse(stdout); assert.equal(envelope.ok, true, stdout); return envelope.data;
}
// The same recursive scan, as CommonJS for node -e. It runs in a child process:
// the server holds workbench.sqlite in this process, and opening and closing the
// file here would drop the server's SQLite locks.
const scanFiles = `const fs=require('node:fs'),path=require('node:path'),[directory,needle]=process.argv.slice(1),bytes=Buffer.from(needle);
const contains=dir=>fs.readdirSync(dir,{withFileTypes:true}).some(entry=>{const file=path.join(dir,entry.name);return entry.isDirectory()?contains(file):fs.readFileSync(file).includes(bytes);});
process.send(contains(directory),()=>process.disconnect());`;
async function filesContain(directory:string, needle: string): Promise<boolean> {
  const child = spawn(process.execPath, ['-e', scanFiles, '--', directory, needle], {stdio: ['ignore', 'ignore', 'inherit', 'ipc'], signal: AbortSignal.timeout(30000)});
  const found = new Promise<unknown>(resolve => {child.once('message', resolve); child.once('disconnect', () => resolve(undefined));});
  const [result, [code, signal]] = await Promise.all([found, once(child, 'exit')]);
  if (code !== 0 || typeof result !== 'boolean') throw Error(`The file scan child failed: ${code ?? signal}`);
  return result;
}

// Both production network dependencies are replaced together. Nothing in this
// fixture resolves DNS, creates a TLS socket, or calls the real Images API.
function fakeNetwork(body: Buffer<ArrayBuffer>) {
  const state = {lookups: 0, requests: 0, posts: 0, holdConnect: false, holdResponse: false, payloads:[] as Record<string,unknown>[]};
  const lookup = async (hostname: unknown, options: unknown) => {
    state.lookups++; assert.equal(hostname, 'api.openai.com'); assert.deepEqual(options, {all: true, verbatim: true});
    return [{address: '8.8.8.8', family: 4}];
  };
  const httpsRequest = (options: { hostname: unknown; path: unknown; method: unknown; headers: { Authorization: unknown; }; }, callback: (arg0: Readable) => void) => {
    state.requests++;
    assert.equal(options.hostname, 'api.openai.com'); assert.equal(options.path, '/v1/images/generations');
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, `Bearer ${syntheticKey}`);
    const request=new EventEmitter() as ActivationRequest; let ended = false;
    request.destroy = () => {};
    request.end = (payload: string) => {
      assert.equal(ended, false, 'one end per request'); ended = true; state.posts++; state.payloads.push(JSON.parse(payload));
      if (state.holdResponse) return;
      const response = Readable.from([body]);
      Object.assign(response, {statusCode: 200, complete: true, headers: {'content-type': 'application/json', 'x-request-id': `synthetic-${state.posts}`}});
      callback(response);
    };
    queueMicrotask(() => {
      const socket = new EventEmitter(); Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}});
      request.emit('socket', socket); if (!state.holdConnect) socket.emit('secureConnect');
    });
    return request;
  };
  return {state, dependencies: {lookup, httpsRequest}};
}
async function fixture(t: test.TestContext) {
  const png = await renderMockImagePng(), body = Buffer.from(JSON.stringify({created: 1, data: [{b64_json: png.toString('base64')}],
    background: 'opaque', output_format: 'png', quality: 'low', size: '1024x1024', usage: {input_tokens: 2, output_tokens: 3, total_tokens: 5}}));
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-live-wire-')), network = fakeNetwork(body);
  // Each server that starts hands over its own connection.
  let inspect!: InspectProject;
  const options = {dataDir: root, port: 0, token, imageNetwork: network.dependencies, inspectProject: (received: InspectProject) => {inspect = received;}};
  let server = await startServer((options as unknown as Parameters<typeof startServer>[0]));
  let proxy: http.Server<typeof http.IncomingMessage,typeof http.ServerResponse>, dropped: RpcEnvelope<FixtureImageTask>|null = null, proxyCalls = 0;
  const f = {root, png, network: network.state, get server() {return server;},
    get env() {return {MIOON_BASE_URL: server.url, MIOON_TOKEN: token};},
    get client() {return (createClient({env: f.env}) as TypedClient);},
    async request(route: string, {method = 'GET', input, raw, authenticated = true, headers = {}, base = server.url}: ActivationRequestOptions = {}) {
      const response = await fetch(base + route, {method, redirect: 'error', headers: {'content-type': 'application/json',
        ...(authenticated ? {authorization: `Bearer ${token}`} : {}), ...headers},
        ...(input !== undefined || raw !== undefined ? {body: raw ?? JSON.stringify(input)} : {}), signal: AbortSignal.timeout(10000)});
      const result = await response.json(); publicOnly(result, root);
      return {status: response.status, headers: response.headers, body: result};
    },
    async rpc<O extends string>(operation:O, input = {}, expectedCode?: string|undefined) {
      const response = await f.request('/api/rpc', {method: 'POST', input: {operation, input}});
      assert.equal(response.body.ok, !expectedCode, JSON.stringify(response.body));
      if (expectedCode) assert.equal(response.body.error.code, expectedCode); else assert.equal(response.status, 200);
      return response.body.data as ServiceResponse<O>;
    },
    async approve(review:Pick<FixtureImageReview,"projectId"|"id">, patch = {}, expectedCode?: string|undefined) {
      const response = await f.request('/api/images/reviews/approve', {method: 'POST', input: {...approvalFor(review), ...patch}});
      assert.equal(response.body.ok, !expectedCode, JSON.stringify(response.body));
      if (expectedCode) assert.equal(response.body.error.code, expectedCode); else assert.ok(isImageTaskResponse(response.body.data));
      return response.body.data;
    },
    async prepare(input: unknown, settingsRevision = 1) {return f.client.rpc('image.review.prepare', {input, settingsRevision});},
    async saveKey(expectedRevision: number) {
      const response = await f.request('/api/images/settings', {method: 'PUT', input: {expectedRevision,
        configuration: {...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, secret: {action: 'replace', storage: 'session', value: syntheticKey}}});
      assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data;
    },
    async settled(ack: { projectId: unknown; id: unknown; }, state = 'succeeded') {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const task = await f.client.rpc('image.task.get', {projectId: ack.projectId, taskId: ack.id});
        if (task.state === state) return task;
        assert.ok(['queued', 'dispatching', 'receiving', 'persisting'].includes(task.state), JSON.stringify(task)); await delay(10);
      }
      assert.fail(`Image task did not reach ${state}`);
    },
    // The server holds the project while it runs: read on its own connection.
    snapshot(projectId: string) {
      return inspect(projectId, db => JSON.stringify(['image_groups', 'image_tasks', 'image_versions', 'image_requests', 'image_reviews'].map(name =>
        [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])));
    },
    async restart() {await server.close(); server = await startServer((options as unknown as Parameters<typeof startServer>[0]));},
    async loseApproval(review:Pick<FixtureImageReview,"projectId"|"id">) {
      proxy = http.createServer(async (request, response) => {
        try {
          proxyCalls++; const chunks:Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
          const upstream = await fetch(server.url + '/api/images/reviews/approve', {method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: Buffer.concat(chunks)});
          dropped = await upstream.json(); response.destroy();
        } catch {response.destroy();}
      });
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(proxy.address()! as import('node:net').AddressInfo).port}`;
      await assert.rejects(f.request('/api/images/reviews/approve', {method: 'POST', input: approvalFor(review), base}));
      assert.equal(proxyCalls, 1); assert.equal(dropped?.ok, true); publicOnly(dropped, root); return dropped.data;
    },
  };
  t.after(async () => {
    if (proxy) {proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));}
    await server.close(); await rm(root, {recursive: true, force: true});
  });
  // The persisted workspace gate is independent from this synthetic official
  // slot. Opt in without approving a request or changing the fake network.
  await f.client.rpc('workspace.settings.set', {expectedRevision: 0, liveGeneration: true});
  return f;
}

test('reviewed live-image boundary through actual local HTTP, strict client, CLI and official MCP', {timeout: 90000}, async (t: test.TestContext) => {
  const f = await fixture(t);
  const project = await f.rpc('project.create', {name: 'Synthetic live-image boundary'}), other = await f.rpc('project.create', {name: 'Foreign project'});
  let review:FixtureImageReview,input:ReturnType<typeof inputFor>,accepted:FixtureImageTask,finished:FixtureImageTask,pending:FixtureImageReview;
  await t.test('private routes require local authentication and reject wrong origin, methods, query, media type and body size', async () => {
    for (const route of ['/api/images/settings', '/api/images/reviews/approve', '/api/images/reviews/reject']) {
      const method = route.endsWith('settings') ? 'GET' : 'POST', body = method === 'POST' ? {} : undefined;
      assert.equal((await f.request(route, {method, input: body, authenticated: false})).status, 401);
      assert.equal((await f.request(route, {method, input: body, headers: {origin: 'https://untrusted.invalid'}})).status, 403);
    }
    const route = '/api/images/reviews/approve';
    assert.equal((await f.request(route)).status, 405);
    assert.equal((await f.request(`${route}?unexpected=1`, {method: 'POST', input: {}})).status, 400);
    assert.equal((await f.request(route, {method: 'POST', input: {}, headers: {'content-type': 'text/plain'}})).status, 400);
    assert.equal((await f.request(route, {method: 'POST', raw: '{'})).status, 400);
    assert.equal((await f.request(route, {method: 'POST', raw: '{}'.padEnd(1025, ' ')})).status, 413);
    for (const operation of ['image.review.approve', 'image.review.reject', 'image.settings.get', 'image.settings.put']) await f.rpc(operation, {}, 'UNKNOWN_OPERATION');
    assert.equal(f.network.posts, 0); assert.equal(f.network.lookups, 0);
  });

  await t.test('session configuration is separate, contains no credential response, and direct live RPC stays denied', async () => {
    const initial = (await f.request('/api/images/settings')).body.data;
    assert.equal(initial.revision, 0); assert.equal(initial.configuration.enabled, false); assert.equal(initial.secret.configured, false);
    const saved = await f.saveKey(0); assert.equal(saved.revision, 1); assert.equal(saved.secret.storage, 'session');
    assert.equal(saved.storage.sessionScope, 'server');
    const persisted = JSON.parse(await readFile(path.join(f.root, 'image-settings/settings.json'), 'utf8'));
    assert.equal(persisted.secret, null); assert.equal(await filesContain(f.root, syntheticKey), false);
    const before = f.snapshot(project.id);
    await f.rpc('image.generate', inputFor(project.id), 'IMAGE_REVIEW_REQUIRED');
    await assert.rejects(f.client.rpc('image.generate', {...inputFor(project.id), approved: true}), {code: 'VALIDATION_ERROR'});
    assert.equal(f.snapshot(project.id), before); assert.equal(f.network.lookups, 0); assert.equal(f.network.posts, 0);
  });

  await t.test('external clients prepare/read pending reviews without an approval tool or provider call', async () => {
    input = inputFor(project.id); review = await f.prepare(input); assert.ok(isImageReviewResponse(review)); assert.equal(review.state, 'pending');
    assert.deepEqual(await cli(['image', 'review', 'prepare', '--input', JSON.stringify({input, settingsRevision: 1})], f.env), review);
    const catalog = await cli(['schema'], f.env);
    assert.ok(catalog.operations.some((value: { operation: string; }) => value.operation === 'image.review.prepare'));
    assert.ok(!catalog.operations.some((value: { operation: string; }) => /image\.(?:review\.(?:approve|reject)|settings\.)/.test(value.operation)));
    const client = new Client({name: 'synthetic-image-review-acceptance', version: '1.0.0'}, {capabilities: {}});
    const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')],
      cwd: repo, env: childEnvironment(f.env), stderr: 'pipe'});
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert.ok(tools.some(value => value.name === 'image_review_prepare'));
      assert.ok(!tools.some(value => /image_(?:review_(?:approve|reject)|settings_)/.test(value.name)));
      const result = (await client.callTool({name: 'image_review_get', arguments: {projectId: project.id, reviewId: review.id}}) as import("@modelcontextprotocol/sdk/types.js").CallToolResult);
      assert.equal(result.isError, false); assert.deepEqual(result.structuredContent, {ok: true, data: review}); publicOnly(result, f.root);
    } finally {await client.close();}
    pending = await f.prepare(inputFor(project.id));
    assert.equal((await f.client.rpc('image.review.list', {projectId: project.id})).items.length, 2);
    assert.equal(f.network.lookups, 0); assert.equal(f.network.posts, 0);
  });

  await t.test('project, revision and rejected-review substitution fail closed before any POST', async () => {
    const before = f.snapshot(project.id);
    await f.approve(review, {projectId: other.id}, 'IMAGE_REVIEW_NOT_FOUND');
    await f.approve(review, {reviewId: randomUUID()}, 'IMAGE_REVIEW_NOT_FOUND');
    await f.approve(review, {expectedRevision: 2}, 'IMAGE_REVIEW_REVISION_CONFLICT');
    await f.rpc('image.review.prepare', {input: {...input, prompt: 'Changed same-key intent'}, settingsRevision: 1}, 'IMAGE_REVIEW_CONFLICT');
    assert.equal(f.snapshot(project.id), before);
    const rejected = await f.prepare(inputFor(project.id));
    const response = await f.request('/api/images/reviews/reject', {method: 'POST', input: approvalFor(rejected)});
    assert.equal(response.body.data.state, 'rejected');
    await f.approve(rejected, {}, 'IMAGE_REVIEW_REVISION_CONFLICT');
    assert.equal(f.network.posts, 0); assert.equal(f.network.lookups, 0);
  });

  await t.test('concurrent exact approval and later receipt replay create one task, one POST and one valid managed PNG', async () => {
    const approvals = await Promise.all(Array.from({length: 5}, () => f.approve(review)));
    accepted = approvals[0]; for (const value of approvals) assert.deepEqual(value, accepted);
    assert.equal(accepted.state, 'queued'); finished = await f.settled(accepted);
    assert.equal(f.network.posts, 1); assert.equal(f.network.requests, 1); assert.equal(f.network.lookups, 1);
    assert.deepEqual(f.network.payloads[0], {model: IMAGE_MODELS.openai, prompt: input.prompt, n: 1, quality: 'low', size: '1024x1024', output_format: 'png', background: 'opaque', moderation: 'auto'});
    const before = f.snapshot(project.id);
    assert.deepEqual(await f.approve(review), accepted);
    assert.deepEqual(await f.client.rpc('image.generate', input), accepted);
    assert.deepEqual((await f.client.rpc('image.request.get', {projectId: project.id, requestId: input.requestId}))!.response, accepted);
    const retained = await f.client.rpc('image.review.get', {projectId: project.id, reviewId: review.id});
    assert.equal(retained.state, 'dispatched'); assert.equal(retained.postAttempts, 1); assert.equal(retained.taskId, accepted.id);
    const versions = await f.client.rpc('image.version.list', {projectId: project.id, groupId: accepted.groupId});
    assert.equal(versions.items.length, 1); assert.equal(versions.items[0].isMock, false);
    const asset = await fetch(`${f.server.url}/media/${versions.items[0].assetId}`, {headers: {authorization: `Bearer ${token}`}});
    assert.equal(asset.status, 200); const bytes = Buffer.from(await asset.arrayBuffer());
    assert.deepEqual(bytes, f.png); assert.equal(createHash('sha256').update(bytes).digest('hex'), versions.items[0].sha256);
    assert.equal(f.snapshot(project.id), before); assert.equal(f.network.posts, 1);
  });

  await t.test('a genuinely lost private approval response recovers the original request key without another POST', async () => {
    const original = inputFor(project.id), prepared = await f.prepare(original), ack = await f.loseApproval(prepared);
    await f.settled(ack); assert.equal(f.network.posts, 2);
    const before = f.snapshot(project.id);
    const recovered = await f.client.rpc('image.request.get', {projectId: project.id, requestId: original.requestId});
    assert.deepEqual(recovered!.response, ack);
    const retained = await f.client.rpc('image.review.get', {projectId: project.id, reviewId: prepared.id});
    assert.equal(retained.taskId, ack.id); assert.equal(retained.postAttempts, 1);
    assert.deepEqual(await f.approve(prepared), ack); assert.equal(f.snapshot(project.id), before); assert.equal(f.network.posts, 2);
  });

  await t.test('strict client rejects forged review data without retries or converting it into authorization', async () => {
    for (const [operation, args, data] of [
      ['image.review.get', {projectId: project.id, reviewId: review.id}, {...review, id: randomUUID()}],
      ['image.review.prepare', {input, settingsRevision: 1}, {...review, input: {...input, prompt: 'Changed'}}],
      ['image.review.list', {projectId: project.id}, {projectId: other.id, items: [], nextCursor: null}],
    ] as const) {
      let calls = 0;
      const client = (createClient({env: f.env, fetchImpl: (async () => {calls++; return new Response(JSON.stringify({ok: true, data}), {status: 200});}) as unknown as typeof fetch}) as TypedClient);
      await assert.rejects(client.rpc(operation, args), error => {
        assert.equal((error as Failure).code, 'BACKEND_PROTOCOL_ERROR');
        if (operation === 'image.review.prepare') {
          assert.equal((error as Failure).details.submissionMayHaveSucceeded, true); assert.equal((error as Failure).details.requestId, input.requestId);
        }
        return true;
      }); assert.equal(calls, 1);
    }
    assert.equal(f.network.posts, 2);
  });

  await t.test('restart before POST stops queued work, loses backend-session key and never auto-approves pending intent', async () => {
    f.network.holdConnect = true;
    const original = inputFor(project.id), prepared = await f.prepare(original), ack = await f.approve(prepared);
    await delay(30); assert.equal(f.network.posts, 2);
    await f.restart(); f.network.holdConnect = false;
    const settings = (await f.request('/api/images/settings')).body.data;
    assert.equal(settings.revision, 1); assert.equal(settings.configuration.enabled, true); assert.equal(settings.secret.configured, false);
    const task = await f.client.rpc('image.task.get', {projectId: project.id, taskId: ack.id});
    assert.equal(task.state, 'interrupted_before_dispatch'); assert.equal(task.dispatched, false);
    const retained = await f.client.rpc('image.review.get', {projectId: project.id, reviewId: prepared.id});
    assert.equal(retained.state, 'approved'); assert.equal(retained.postAttempts, 0);
    const before = f.snapshot(project.id), networkBefore = {...f.network};
    assert.deepEqual(await f.approve(prepared), ack); assert.deepEqual(await f.client.rpc('image.generate', original), ack);
    await f.approve(pending, {}, 'IMAGE_SETTINGS_NOT_CONFIGURED');
    await f.client.rpc('image.review.list', {projectId: project.id});
    await f.client.rpc('image.task.list', {projectId: project.id}); await delay(30);
    assert.equal(f.snapshot(project.id), before); assert.equal(f.network.posts, networkBefore.posts); assert.equal(f.network.requests, networkBefore.requests);
    assert.deepEqual(await f.client.rpc('image.task.get', {projectId: project.id, taskId: accepted.id}), finished);
  });

  await t.test('restart after POST preserves unknown result and consumed attempt; key replacement cannot refresh stale intent', async () => {
    const saved = await f.saveKey(1); assert.equal(saved.revision, 2);
    await f.approve(pending, {}, 'IMAGE_REVIEW_SETTINGS_CHANGED');
    const original = inputFor(project.id), prepared = await f.prepare(original, 2);
    f.network.holdResponse = true; const ack = await f.approve(prepared); await f.settled(ack, 'dispatching');
    assert.equal(f.network.posts, 3); await f.restart(); f.network.holdResponse = false;
    const task = await f.client.rpc('image.task.get', {projectId: project.id, taskId: ack.id});
    assert.equal(task.state, 'outcome_unknown'); assert.equal(task.dispatched, true);
    const retained = await f.client.rpc('image.review.get', {projectId: project.id, reviewId: prepared.id});
    assert.equal(retained.state, 'dispatched'); assert.equal(retained.postAttempts, 1);
    const before = f.snapshot(project.id), posts = f.network.posts, requests = f.network.requests;
    assert.deepEqual(await f.approve(prepared), ack);
    assert.deepEqual((await f.client.rpc('image.request.get', {projectId: project.id, requestId: original.requestId}))!.response, ack);
    assert.deepEqual(await f.prepare(original, 2), retained);
    await f.client.rpc('image.profile.list'); await f.client.rpc('image.review.list', {projectId: project.id}); await delay(30);
    assert.equal(f.snapshot(project.id), before); assert.equal(f.network.posts, posts); assert.equal(f.network.requests, requests);
    assert.equal((await f.request('/api/images/settings')).body.data.secret.configured, false);
    assert.equal(await filesContain(f.root, syntheticKey), false);
  });
});
