import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {EventEmitter, once} from 'node:events';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {createClient} from '../packages/client/src/index.ts';
import {IMAGE_FIXED_OPTIONS, IMAGE_MODELS, isImageTaskResponse} from '../packages/contracts/src/images.ts';
import {DEFAULT_IMAGE_CONFIGURATION, DEFAULT_CUSTOM_IMAGE_CONFIGURATION,
  CUSTOM_IMAGE_SETTINGS_NAMESPACE, IMAGE_SETTINGS_NAMESPACE} from '../packages/contracts/src/image-settings.ts';
import {isImageReviewResponse} from '../packages/contracts/src/image-reviews.ts';
import {renderMockImagePng} from '../packages/business/src/images/png.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const token = 'synthetic-custom-images-local-http-token';
const officialKey = 'SYNTHETIC_OFFICIAL_SLOT_NOT_A_REAL_KEY';
const customKey = 'SYNTHETIC_CUSTOM_SLOT_NOT_A_REAL_KEY';
const rotatedKey = 'SYNTHETIC_ROTATED_CUSTOM_SLOT_NOT_A_REAL_KEY';
const customConfiguration = {...DEFAULT_CUSTOM_IMAGE_CONFIGURATION, enabled: true,
  baseUrl: 'https://images.example.test/tenant-a/api/v9', model: 'vendor/art-v3:synthetic'};
const changedUrlConfiguration = {...customConfiguration, baseUrl: 'https://other-images.example.test/tenant-b/v2'};
const changedModelConfiguration = {...changedUrlConfiguration, model: 'another-vendor/draw-v4:synthetic'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const approvalFor = review => ({projectId: review.projectId, reviewId: review.id, expectedRevision: 1});
const inputFor = (projectId, configuration = customConfiguration) => ({projectId, requestId: randomUUID(),
  name: 'Synthetic custom transport fixture', providerId: configuration.providerId, model: configuration.model,
  prompt: 'A synthetic PNG test card; no live provider is contacted.', options: {...IMAGE_FIXED_OPTIONS}});
const wireBody = input => ({model: input.model, prompt: input.prompt, n: 1, quality: 'low', size: '1024x1024',
  output_format: 'png', background: 'opaque', moderation: 'auto'});

function publicOnly(value, root) {
  const text = JSON.stringify(value);
  for (const secret of [token, officialKey, customKey, rotatedKey, root]) assert.ok(!text.includes(secret), 'private data must not appear in a response');
  assert.ok(!/"(?:apiKey|authorization|canonicalInput|canonicalIntent|stagedReceipt|b64_json|relativePath)"\s*:/i.test(text));
}
function childEnvironment(env) {
  // Allowlist only basic process execution settings. Never inherit provider keys,
  // connection descriptors, proxy variables, NODE_OPTIONS, or print the child env.
  const clean = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'LANG', 'SYSTEMROOT', 'COMSPEC']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  return {...clean, TZ: 'UTC', MIOON_ENABLE_LIVE_PROVIDER: '0', ...env};
}
async function cli(args, env, expectedCode) {
  const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...args],
    {cwd: repo, env: childEnvironment(env), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk; if (stdout.length > 1024 * 1024) child.kill('SIGKILL');});
  child.stderr.setEncoding('utf8').on('data', chunk => {stderr = (stderr + chunk).slice(-20000);});
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  let result; try {result = await once(child, 'close');} finally {clearTimeout(timer);}
  for (const secret of [token, officialKey, customKey, rotatedKey]) assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
  assert.equal(result[1], null, stderr);
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, !expectedCode, stdout);
  if (expectedCode) {assert.notEqual(result[0], 0); assert.equal(envelope.error.code, expectedCode);}
  else assert.equal(result[0], 0, stderr);
  return envelope.data;
}
async function filesContain(directory, needles) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {if (await filesContain(filename, needles)) return true;}
    else {const bytes = await readFile(filename); if (needles.some(needle => bytes.includes(Buffer.from(needle)))) return true;}
  }
  return false;
}
async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: `http://127.0.0.1:${server.address().port}`,
    async close() {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}};
}

function fakeNetwork(responseBody) {
  const started = performance.now(), events = [];
  const trace = (phase, detail = {}) => {
    events.push({phase, atMs: Math.round(performance.now() - started), ...detail});
    if (events.length > 64) events.shift();
  };
  const destinations = new Map([
    ['api.openai.com/v1/images/generations', {key: officialKey, models: [IMAGE_MODELS.openai]}],
    ['images.example.test/tenant-a/api/v9/images/generations', {key: customKey, models: [customConfiguration.model]}],
    ['other-images.example.test/tenant-b/v2/images/generations', {key: rotatedKey,
      models: [changedUrlConfiguration.model, changedModelConfiguration.model]}],
  ]);
  const state = {lookups: [], requests: [], posts: [], holdResponse: false};
  const lookup = async (hostname, options) => {
    assert.ok([...destinations.keys()].some(value => value.startsWith(`${hostname}/`)), 'unexpected DNS destination');
    assert.deepEqual(options, {all: true, verbatim: true}); state.lookups.push(hostname);
    trace('lookup', {number: state.lookups.length});
    return [{address: '8.8.8.8', family: 4}];
  };
  const httpsRequest = (options, callback) => {
    const destination = destinations.get(options.hostname + options.path);
    assert.ok(destination, 'unexpected HTTPS destination');
    assert.equal(options.protocol, 'https:'); assert.equal(options.port, 443); assert.equal(options.method, 'POST');
    assert.equal(options.servername, options.hostname); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
    assert.equal(options.headers.Authorization, `Bearer ${destination.key}`);
    state.requests.push({hostname: options.hostname, path: options.path});
    const number = state.requests.length; trace('request', {number});
    const request = new EventEmitter(); let ended = false;
    request.destroy = () => {};
    request.end = payload => {
      assert.equal(ended, false, 'each request gets only one POST'); ended = true;
      assert.equal(options.headers['Content-Length'], String(Buffer.byteLength(payload)));
      const body = JSON.parse(payload); assert.ok(destination.models.includes(body.model));
      assert.deepEqual(body, wireBody(body));
      state.posts.push({hostname: options.hostname, path: options.path, key: destination.key, body});
      trace('post', {number});
      if (state.holdResponse) {trace('response-held', {number}); return;}
      const response = Readable.from([responseBody]);
      Object.assign(response, {statusCode: 200, complete: true,
        headers: {'content-type': 'application/json', 'x-request-id': `synthetic-custom-${state.posts.length}`}});
      response.once('end', () => trace('response-end', {number}));
      trace('response-callback', {number}); callback(response);
    };
    queueMicrotask(() => {
      const socket = new EventEmitter();
      Object.assign(socket, {remoteAddress: '8.8.8.8', remotePort: 443, authorized: true, destroy() {}});
      request.emit('socket', socket); socket.emit('secureConnect');
    });
    return request;
  };
  // This pair is always passed together to BOTH production gateway instances.
  // The fixture has no real DNS resolver, TLS socket, or provider credential.
  return {state, trace, events, dependencies: {lookup, httpsRequest}};
}
async function fixture(t) {
  const png = await renderMockImagePng();
  const responseBody = Buffer.from(JSON.stringify({data: [{b64_json: png.toString('base64')}]}));
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-custom-image-transports-')), network = fakeNetwork(responseBody);
  assert.equal(typeof network.dependencies.lookup, 'function'); assert.equal(typeof network.dependencies.httpsRequest, 'function');
  const options = {dataDir: root, port: 0, token, imageNetwork: network.dependencies};
  let server = await startServer(options), db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});
  const failedSettlements = new Set();
  const lifecycle = id => {
    try {return db.prepare('SELECT state, revision, dispatched, errorCode, createdAt, updatedAt FROM image_tasks WHERE id=?').get(id) ?? null;}
    catch {return {unavailable: true};}
  };
  const f = {root, png, network: network.state, get server() {return server;}, get db() {return db;},
    get env() {return {MIOON_BASE_URL: server.url, MIOON_TOKEN: token};}, get client() {return createClient({env: f.env});},
    counts() {return [f.network.lookups.length, f.network.requests.length, f.network.posts.length];},
    async request(route, {method = 'GET', input, authenticated = true, headers = {}, base = server.url} = {}) {
      const response = await fetch(base + route, {method, redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {'content-type': 'application/json', ...(authenticated ? {authorization: `Bearer ${token}`} : {}), ...headers},
        ...(input !== undefined ? {body: JSON.stringify(input)} : {})});
      const body = await response.json(); publicOnly(body, root); return {status: response.status, body};
    },
    async rpc(operation, input = {}, expectedCode) {
      const response = await f.request('/api/rpc', {method: 'POST', input: {operation, input}});
      assert.equal(response.body.ok, !expectedCode, JSON.stringify(response.body));
      if (expectedCode) assert.equal(response.body.error.code, expectedCode); else assert.equal(response.status, 200);
      return response.body.data;
    },
    async settings(configuration, expectedRevision, secret, expectedCode) {
      const route = configuration.providerId === 'openai' ? '/api/images/settings' : '/api/images/custom-settings';
      const response = await f.request(route, {method: 'PUT', input: {configuration, expectedRevision, secret}});
      assert.equal(response.body.ok, !expectedCode, JSON.stringify(response.body));
      if (expectedCode) assert.equal(response.body.error.code, expectedCode); else assert.equal(response.status, 200);
      return response.body.data;
    },
    async prepare(input, settingsRevision = 1) {return f.client.rpc('image.review.prepare', {input, settingsRevision});},
    async approve(review, expectedCode, patch = {}) {
      network.trace('approval-start', {providerId: review.input.providerId});
      const response = await f.request('/api/images/reviews/approve', {method: 'POST', input: {...approvalFor(review), ...patch}});
      network.trace('approval-ack', {providerId: review.input.providerId, ok: response.body.ok});
      assert.equal(response.body.ok, !expectedCode, JSON.stringify(response.body));
      if (expectedCode) assert.equal(response.body.error.code, expectedCode); else assert.ok(isImageTaskResponse(response.body.data));
      return response.body.data;
    },
    async settled(ack, state = 'succeeded') {
      // Diagnostics only: retain the original deadline, polling, and assertions.
      // No payload, credential, request body, path, or arbitrary error is logged.
      const started = performance.now(), wallStarted = Date.now(), observations = [];
      let polls = 0, lastPoll = started, maximumPollGapMs = 0, maximumReadMs = 0, reached = false;
      network.trace('settle-start', {providerId: ack.providerId, wanted: state});
      const deadline = Date.now() + 10000;
      try {
        while (Date.now() < deadline) {
          const beforeRead = performance.now();
          maximumPollGapMs = Math.max(maximumPollGapMs, beforeRead - lastPoll); lastPoll = beforeRead; polls++;
          const task = await f.client.rpc('image.task.get', {projectId: ack.projectId, taskId: ack.id});
          maximumReadMs = Math.max(maximumReadMs, performance.now() - beforeRead);
          if (observations.at(-1)?.revision !== task.revision || observations.at(-1)?.state !== task.state) {
            observations.push({atMs: Math.round(performance.now() - started), state: task.state,
              revision: task.revision, dispatched: task.dispatched, errorCode: task.errorCode,
              createdAt: task.createdAt, updatedAt: task.updatedAt});
            if (observations.length > 16) observations.shift();
          }
          if (task.state === state) {reached = true; return task;}
          assert.ok(['queued', 'dispatching', 'receiving', 'persisting'].includes(task.state), JSON.stringify(task)); await pause(10);
        }
        assert.fail(`Image task did not reach ${state}`);
      } finally {
        if (!reached) failedSettlements.add(ack.id);
        t.diagnostic('image settlement ' + JSON.stringify({providerId: ack.providerId, wanted: state, reached, polls,
          elapsedMs: Math.round(performance.now() - started), wallElapsedMs: Date.now() - wallStarted,
          maximumPollGapMs: Math.round(maximumPollGapMs), maximumReadMs: Math.round(maximumReadMs),
          observations, networkCounts: f.counts(), ...(!reached ? {lifecycle: lifecycle(ack.id), phases: network.events} : {})}));
      }
    },
    snapshot() {return JSON.stringify(['image_groups', 'image_tasks', 'image_versions', 'image_requests', 'image_reviews', 'assets']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));},
    retained(task) {return JSON.stringify([
      db.prepare('SELECT * FROM image_tasks WHERE id=?').get(task.id),
      db.prepare('SELECT * FROM image_requests WHERE requestId=?').get(task.requestId),
      db.prepare('SELECT * FROM image_groups WHERE id=?').get(task.groupId),
      db.prepare('SELECT * FROM image_versions WHERE taskId=? ORDER BY rowid').all(task.id),
      db.prepare('SELECT * FROM assets WHERE id IN (SELECT assetId FROM image_versions WHERE taskId=?) ORDER BY rowid').all(task.id),
    ]);},
    async asset(task) {
      const versions = await f.client.rpc('image.version.list', {projectId: task.projectId, groupId: task.groupId});
      assert.equal(versions.items.length, 1); const version = versions.items[0];
      const response = await fetch(`${server.url}/media/${version.assetId}`, {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(10000)});
      assert.equal(response.status, 200); const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), version.sha256); return {version, bytes};
    },
    async restart() {db.close(); db = null; await server.close(); server = await startServer(options); db = new DatabaseSync(path.join(root, 'workbench.sqlite'), {readOnly: true});},
    async loseApproval(review) {
      let calls = 0, dropped;
      const proxy = await localServer(async (request, response) => {
        try {
          calls++; assert.equal(request.url, '/api/images/reviews/approve');
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const upstream = await fetch(server.url + request.url, {method: 'POST',
            headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: Buffer.concat(chunks), signal: AbortSignal.timeout(10000)});
          dropped = await upstream.json(); response.destroy();
        } catch {response.destroy();}
      });
      try {
        await assert.rejects(f.request('/api/images/reviews/approve', {method: 'POST', input: approvalFor(review), base: proxy.url}));
        assert.equal(calls, 1); assert.equal(dropped?.ok, true); publicOnly(dropped, root); return dropped.data;
      } finally {await proxy.close();}
    },
  };
  t.after(async () => {
    for (const id of failedSettlements) t.diagnostic('failed settlement at teardown ' + JSON.stringify({lifecycle: lifecycle(id), networkCounts: f.counts()}));
    db?.close(); await server.close(); await rm(root, {recursive: true, force: true});
  });
  // Keep transport-loss tests behind the real persistent workspace opt-in;
  // both production gateways continue to use the rejecting/synthetic network.
  await f.client.rpc('workspace.settings.set', {expectedRevision: 0, liveGeneration: true});
  return f;
}

test('custom Images isolation and one-attempt recovery through real local HTTP, CLI and official MCP', {timeout: 120000}, async t => {
  const f = await fixture(t), project = await f.rpc('project.create', {name: 'Synthetic two-slot image transport acceptance'});
  let officialInput, officialReview, officialAck, officialFinished, officialRows, officialAsset, officialFile;
  let mockInput, mockAck, mockFinished, mockRows, mockAsset, customInput, customReview, customAck, customFinished, stale;

  await t.test('custom settings and private review actions require authentication; no public approval or settings operation exists', async () => {
    for (const [route, method, input] of [
      ['/api/images/custom-settings', 'GET'], ['/api/images/custom-settings', 'PUT', {}],
      ['/api/images/reviews/approve', 'POST', {}], ['/api/images/reviews/reject', 'POST', {}],
    ]) {
      assert.equal((await f.request(route, {method, input, authenticated: false})).status, 401);
      assert.equal((await f.request(route, {method, input, headers: {origin: 'https://untrusted.example.test'}})).status, 403);
    }
    for (const operation of ['image.review.approve', 'image.review.reject', 'image.customSettings.get', 'image.customSettings.put', 'image.settings.get'])
      await f.rpc(operation, {}, 'UNKNOWN_OPERATION');
    assert.equal((await f.request('/api/images/custom-settings?unexpected=1')).status, 400);
    assert.equal((await f.request('/api/images/custom-settings', {method: 'POST', input: {}})).status, 405);
    assert.deepEqual(f.counts(), [0, 0, 0]);
  });

  await t.test('official and Mock receipts and managed assets exist before custom-slot activation', async () => {
    mockInput = inputFor(project.id, {providerId: 'mock', model: IMAGE_MODELS.mock});
    mockAck = await f.client.rpc('image.generate', mockInput); mockFinished = await f.settled(mockAck);
    mockRows = f.retained(mockAck); mockAsset = await f.asset(mockAck); assert.equal(mockAsset.version.isMock, true);
    const emptyCustom = (await f.request('/api/images/custom-settings')).body.data;
    assert.deepEqual(emptyCustom.configuration, DEFAULT_CUSTOM_IMAGE_CONFIGURATION); assert.equal(emptyCustom.revision, 0);
    assert.equal(emptyCustom.secret.configured, false);
    const official = await f.settings({...DEFAULT_IMAGE_CONFIGURATION, enabled: true}, 0, {action: 'replace', storage: 'session', value: officialKey});
    assert.equal(official.revision, 1); assert.equal(official.secret.storage, 'session'); assert.deepEqual(f.counts(), [0, 0, 0]);
    officialFile = await readFile(path.join(f.root, 'image-settings/settings.json'), 'utf8');
    assert.equal(JSON.parse(officialFile).namespace, IMAGE_SETTINGS_NAMESPACE);
    officialInput = inputFor(project.id, DEFAULT_IMAGE_CONFIGURATION); officialReview = await f.prepare(officialInput);
    assert.ok(!Object.hasOwn(officialReview, 'configuration'));
    officialAck = await f.approve(officialReview); officialFinished = await f.settled(officialAck);
    officialRows = f.retained(officialAck); officialAsset = await f.asset(officialAck);
    assert.deepEqual(officialAsset.bytes, f.png); assert.equal(officialAsset.version.isMock, false);
    assert.deepEqual(f.network.posts, [{hostname: 'api.openai.com', path: '/v1/images/generations', key: officialKey, body: wireBody(officialInput)}]);
  });

  await t.test('custom GET/save makes no DNS or provider POST and cannot consume or alter the official slot', async () => {
    const counts = f.counts(), official = (await f.request('/api/images/settings')).body.data;
    const saved = await f.settings(customConfiguration, 0, {action: 'replace', storage: 'session', value: customKey});
    assert.equal(saved.revision, 1); assert.deepEqual(saved.configuration, customConfiguration); assert.equal(saved.secret.storage, 'session');
    assert.deepEqual((await f.request('/api/images/custom-settings')).body.data, saved);
    assert.deepEqual((await f.request('/api/images/settings')).body.data, official);
    assert.equal(await readFile(path.join(f.root, 'image-settings/settings.json'), 'utf8'), officialFile);
    const persisted = JSON.parse(await readFile(path.join(f.root, 'image-settings/custom-settings.json'), 'utf8'));
    assert.equal(persisted.namespace, CUSTOM_IMAGE_SETTINGS_NAMESPACE); assert.equal(persisted.secret, null);
    const profiles = await f.client.rpc('image.profile.list');
    assert.deepEqual(profiles.items.map(value => value.providerId).sort(), ['mock', 'openai', 'openai-compatible']);
    assert.equal(profiles.items.find(value => value.providerId === 'openai-compatible').model, customConfiguration.model);
    const wrongSlot = await f.request('/api/images/settings', {method: 'PUT', input: {expectedRevision: 1, configuration: customConfiguration, secret: {action: 'keep'}}});
    assert.equal(wrongSlot.body.ok, false); assert.equal(wrongSlot.body.error.code, 'IMAGE_SETTINGS_VALIDATION');
    assert.deepEqual(f.counts(), counts); assert.equal(await filesContain(f.root, [officialKey, customKey, rotatedKey]), false);
  });

  await t.test('CLI and official MCP can prepare/read immutable v2 reviews but cannot approve, reveal keys, or POST', async () => {
    const counts = f.counts(); customInput = inputFor(project.id);
    customReview = await cli(['image', 'review', 'prepare', '--input', JSON.stringify({input: customInput, settingsRevision: 1})], f.env);
    assert.ok(isImageReviewResponse(customReview)); assert.equal(customReview.state, 'pending');
    assert.deepEqual(customReview.configuration, customConfiguration);
    assert.equal(customReview.destination, `${customConfiguration.baseUrl}/images/generations`);
    assert.deepEqual(await cli(['image', 'review', 'get', '--input', JSON.stringify({projectId: project.id, reviewId: customReview.id})], f.env), customReview);
    const catalog = await cli(['schema'], f.env);
    assert.ok(catalog.operations.some(value => value.operation === 'image.review.prepare'));
    assert.ok(!catalog.operations.some(value => /image\.(?:review\.(?:approve|reject)|(?:custom)?settings\.)/i.test(value.operation)));
    for (const verb of ['approve', 'reject']) await cli(['image', 'review', verb, '--input', JSON.stringify(approvalFor(customReview))], f.env, 'UNKNOWN_OPERATION');
    const client = new Client({name: 'synthetic-custom-images-acceptance', version: '1.0.0'}, {capabilities: {}});
    const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')],
      cwd: repo, env: childEnvironment(f.env), stderr: 'pipe'});
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      assert.ok(tools.some(value => value.name === 'image_review_prepare'));
      assert.ok(!tools.some(value => /image_(?:review_(?:approve|reject)|(?:custom_?)?settings_)/i.test(value.name)));
      for (const [name, args] of [['image_review_prepare', {input: customInput, settingsRevision: 1}],
        ['image_review_get', {projectId: project.id, reviewId: customReview.id}]]) {
        const result = await client.callTool({name, arguments: args});
        assert.equal(result.isError, false); assert.deepEqual(result.structuredContent, {ok: true, data: customReview}); publicOnly(result, f.root);
      }
      const listed = await client.callTool({name: 'image_review_list', arguments: {projectId: project.id}});
      assert.equal(listed.isError, false); assert.ok(listed.structuredContent.data.items.some(value => value.id === customReview.id)); publicOnly(listed, f.root);
      for (const name of ['image_review_approve', 'image_review_reject', 'image_custom_settings_put']) {
        const denied = await client.callTool({name, arguments: approvalFor(customReview)});
        assert.equal(denied.isError, true); assert.equal(denied.structuredContent.error.code, 'UNKNOWN_OPERATION'); publicOnly(denied, f.root);
      }
    } finally {await client.close();}
    const raw = f.db.prepare('SELECT canonicalIntent FROM image_reviews WHERE id=?').get(customReview.id).canonicalIntent;
    const intent = JSON.parse(raw); assert.equal(intent.schemaVersion, 2); assert.deepEqual(intent.configuration, customConfiguration);
    const before = f.snapshot();
    await f.rpc('image.generate', customInput, 'IMAGE_REVIEW_REQUIRED');
    assert.equal(f.snapshot(), before); assert.deepEqual(f.counts(), counts);
    stale = await f.prepare(inputFor(project.id));
  });

  await t.test('private rejection and immutable same-key intent do not authorize a custom POST', async () => {
    const counts = f.counts(), rejected = await f.prepare(inputFor(project.id));
    const result = await f.request('/api/images/reviews/reject', {method: 'POST', input: approvalFor(rejected)});
    assert.equal(result.body.data.state, 'rejected');
    await f.approve(rejected, 'IMAGE_REVIEW_REVISION_CONFLICT');
    await f.approve(customReview, 'IMAGE_REVIEW_REVISION_CONFLICT', {expectedRevision: 2});
    await f.rpc('image.review.prepare', {input: {...customInput, model: 'different/model'}, settingsRevision: 1}, 'IMAGE_REVIEW_CONFLICT');
    assert.deepEqual(f.counts(), counts);
  });

  await t.test('concurrent exact HTTP approvals reserve one task and send one custom-key POST to the exact prefix', async () => {
    const counts = f.counts(), approvals = await Promise.all(Array.from({length: 5}, () => f.approve(customReview)));
    customAck = approvals[0]; for (const ack of approvals) assert.deepEqual(ack, customAck);
    assert.equal(customAck.state, 'queued'); customFinished = await f.settled(customAck);
    assert.deepEqual(f.counts(), counts.map(value => value + 1));
    assert.deepEqual(f.network.posts.at(-1), {hostname: 'images.example.test', path: '/tenant-a/api/v9/images/generations', key: customKey, body: wireBody(customInput)});
    const result = await f.asset(customAck); assert.deepEqual(result.bytes, f.png);
    assert.equal(result.version.providerId, 'openai-compatible'); assert.equal(result.version.model, customConfiguration.model); assert.equal(result.version.isMock, false);
    const retained = await f.client.rpc('image.review.get', {projectId: project.id, reviewId: customReview.id});
    assert.equal(retained.state, 'dispatched'); assert.equal(retained.postAttempts, 1); assert.equal(retained.taskId, customAck.id);
    const before = f.snapshot();
    assert.deepEqual(await f.approve(customReview), customAck);
    assert.deepEqual(await f.client.rpc('image.generate', customInput), customAck);
    assert.deepEqual((await f.client.rpc('image.request.get', {projectId: project.id, requestId: customInput.requestId})).response, customAck);
    assert.equal(f.snapshot(), before); assert.deepEqual(f.counts(), counts.map(value => value + 1));
  });

  await t.test('dropped HTTP approval ACK is recovered by the original key and exact approval without another attempt', async () => {
    const counts = f.counts(), input = inputFor(project.id), review = await f.prepare(input), ack = await f.loseApproval(review);
    await f.settled(ack); assert.deepEqual(f.counts(), counts.map(value => value + 1));
    const before = f.snapshot();
    for (let index = 0; index < 3; index++) {
      assert.deepEqual((await f.client.rpc('image.request.get', {projectId: project.id, requestId: input.requestId})).response, ack);
      assert.deepEqual(await f.approve(review), ack);
    }
    const retained = await f.client.rpc('image.review.get', {projectId: project.id, reviewId: review.id});
    assert.equal(retained.postAttempts, 1); assert.equal(retained.taskId, ack.id);
    assert.equal(f.snapshot(), before); assert.deepEqual(f.counts(), counts.map(value => value + 1));
  });

  await t.test('changing recipient or model cannot keep the original key or approve old pending intent', async () => {
    const counts = f.counts(), previous = (await f.request('/api/images/custom-settings')).body.data;
    await f.settings(changedUrlConfiguration, 1, {action: 'keep'}, 'IMAGE_SETTINGS_CONFLICT');
    assert.deepEqual((await f.request('/api/images/custom-settings')).body.data, previous);
    const changed = await f.settings(changedUrlConfiguration, 1, {action: 'replace', storage: 'session', value: rotatedKey});
    assert.equal(changed.revision, 2); await f.approve(stale, 'IMAGE_REVIEW_SETTINGS_CHANGED');
    assert.deepEqual(await f.prepare(stale.input, 1), stale);
    const pending = await f.prepare(inputFor(project.id, changedUrlConfiguration), 2);
    await f.settings(changedModelConfiguration, 2, {action: 'keep'}, 'IMAGE_SETTINGS_CONFLICT');
    assert.deepEqual((await f.request('/api/images/custom-settings')).body.data, changed);
    const updated = await f.settings(changedModelConfiguration, 2, {action: 'replace', storage: 'session', value: rotatedKey});
    assert.equal(updated.revision, 3); await f.approve(pending, 'IMAGE_REVIEW_SETTINGS_CHANGED');
    assert.deepEqual(await f.prepare(pending.input, 2), pending);
    assert.equal(await readFile(path.join(f.root, 'image-settings/settings.json'), 'utf8'), officialFile);
    assert.deepEqual(f.counts(), counts);
  });

  await t.test('official and Mock task keys, original ACK bytes and assets survive custom configuration changes', async () => {
    const counts = f.counts();
    for (const [input, ack, finished, rows, asset] of [[officialInput, officialAck, officialFinished, officialRows, officialAsset],
      [mockInput, mockAck, mockFinished, mockRows, mockAsset]]) {
      assert.deepEqual(await f.client.rpc('image.generate', input), ack);
      assert.deepEqual((await f.client.rpc('image.request.get', {projectId: project.id, requestId: input.requestId})).response, ack);
      assert.deepEqual(await f.client.rpc('image.task.get', {projectId: project.id, taskId: ack.id}), finished);
      assert.equal(f.retained(ack), rows); assert.deepEqual(await f.asset(ack), asset);
    }
    assert.deepEqual(await f.approve(officialReview), officialAck); assert.deepEqual(await f.approve(customReview), customAck);
    assert.deepEqual(f.counts(), counts);
  });

  await t.test('strict client rejects malformed custom ACK and review identities over local HTTP without automatic retry', async () => {
    const counts = f.counts(); let calls = 0, responseData;
    const backend = await localServer(async (request, response) => {
      calls++; for await (const _chunk of request) {};
      response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({ok: true, data: responseData}));
    });
    try {
      const client = createClient({env: {MIOON_BASE_URL: backend.url, MIOON_TOKEN: token}});
      for (const patch of [{projectId: randomUUID()}, {requestId: randomUUID()}, {name: 'Changed'}, {prompt: 'Changed'},
        {providerId: 'openai', model: IMAGE_MODELS.openai}, {model: 'other/model'}, {options: {...IMAGE_FIXED_OPTIONS, n: 2}},
        {state: 'dispatching', revision: 2, dispatched: true}, {configuration: customConfiguration}]) {
        responseData = {...customAck, ...patch}; const before = calls;
        await assert.rejects(client.rpc('image.generate', customInput), error => {
          assert.equal(error.code, 'BACKEND_PROTOCOL_ERROR'); assert.equal(error.details.submissionMayHaveSucceeded, true);
          assert.equal(error.details.requestId, customInput.requestId); return true;
        }); assert.equal(calls, before + 1);
      }
      for (const [operation, input, data] of [
        ['image.review.prepare', {input: customInput, settingsRevision: 1}, {...customReview, configuration: changedUrlConfiguration}],
        ['image.review.get', {projectId: project.id, reviewId: customReview.id}, {...customReview, id: randomUUID()}],
        ['image.review.get', {projectId: project.id, reviewId: customReview.id}, {...customReview, destination: 'https://other-images.example.test/images/generations'}],
        ['image.request.get', {projectId: project.id, requestId: customInput.requestId},
          {projectId: project.id, requestId: customInput.requestId, operation: 'image.generate', response: {...customAck, requestId: randomUUID()}}],
      ]) {
        responseData = data; const before = calls;
        await assert.rejects(client.rpc(operation, input), {code: 'BACKEND_PROTOCOL_ERROR'}); assert.equal(calls, before + 1);
      }
    } finally {await backend.close();}
    assert.deepEqual(f.counts(), counts);
  });

  await t.test('restart drops both session keys and retains pending and unknown custom work without re-POST or implicit approval', async () => {
    const pendingInput = inputFor(project.id, changedModelConfiguration), pending = await f.prepare(pendingInput, 3);
    const input = inputFor(project.id, changedModelConfiguration), review = await f.prepare(input, 3), counts = f.counts();
    f.network.holdResponse = true; const ack = await f.approve(review); await f.settled(ack, 'dispatching');
    assert.deepEqual(f.counts(), counts.map(value => value + 1));
    assert.deepEqual(f.network.posts.at(-1), {hostname: 'other-images.example.test', path: '/tenant-b/v2/images/generations', key: rotatedKey, body: wireBody(input)});
    await f.restart(); f.network.holdResponse = false;
    for (const route of ['/api/images/settings', '/api/images/custom-settings']) {
      const settings = (await f.request(route)).body.data; assert.equal(settings.secret.configured, false); assert.equal(settings.secret.storage, 'none');
    }
    const unknown = await f.client.rpc('image.task.get', {projectId: project.id, taskId: ack.id});
    assert.equal(unknown.state, 'outcome_unknown'); assert.equal(unknown.dispatched, true);
    const retained = await f.client.rpc('image.review.get', {projectId: project.id, reviewId: review.id});
    assert.equal(retained.state, 'dispatched'); assert.equal(retained.postAttempts, 1); assert.equal(retained.taskId, ack.id);
    const before = f.snapshot(), restartedCounts = f.counts();
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(await f.approve(review), ack);
      assert.deepEqual((await f.client.rpc('image.request.get', {projectId: project.id, requestId: input.requestId})).response, ack);
      assert.deepEqual(await f.client.rpc('image.generate', input), ack);
      assert.deepEqual(await f.prepare(input, 3), retained);
      assert.deepEqual(await f.prepare(pendingInput, 3), pending);
    }
    await f.approve(pending, 'IMAGE_SETTINGS_NOT_CONFIGURED');
    await f.client.rpc('image.profile.list'); await f.client.rpc('image.review.list', {projectId: project.id});
    await f.client.rpc('image.task.list', {projectId: project.id}); await pause(30);
    assert.equal(f.snapshot(), before); assert.deepEqual(f.counts(), restartedCounts);
    assert.deepEqual(await f.approve(officialReview), officialAck); assert.deepEqual(await f.approve(customReview), customAck);
    assert.deepEqual(await f.client.rpc('image.task.get', {projectId: project.id, taskId: customAck.id}), customFinished);
    assert.equal(f.retained(officialAck), officialRows); assert.equal(f.retained(mockAck), mockRows);
    assert.deepEqual(await f.asset(officialAck), officialAsset); assert.deepEqual(await f.asset(mockAck), mockAsset);
    assert.equal(await filesContain(f.root, [officialKey, customKey, rotatedKey]), false); assert.deepEqual(f.counts(), restartedCounts);
  });
});
