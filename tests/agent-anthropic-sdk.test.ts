import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createAnthropicSdkTransport} from '../packages/business/src/agent/anthropic-sdk-transport.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentTransportDependencies} from '../packages/business/src/agent/network-policy.ts';
import type {MockRequestState, MockRequest, MockIncoming} from './helpers/strict-agent-workspace-types.ts';

const configuration: AgentConfiguration = {protocol: 'anthropic_messages', presetId: 'custom', platformId: 'custom', baseUrl: 'https://fixture.example.com/anthropic', model: 'synthetic-text-model'};
const messages = [{role: 'user', content: 'Synthetic text, never a real provider request.'}];
// Key-free streaming Messages intent; each call has its own configuration because one test mutates it.
const anthropicRequest = () => ({configuration: {...configuration}, body: JSON.stringify({model: configuration.model, max_tokens: 2048, stream: true, messages})});
const frame = (type: string, fields: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...fields})}\n\n`;
const start = () => frame('message_start', {message: {id: 'msg_fixture', type: 'message', role: 'assistant', model: configuration.model, content: [], stop_reason: null, stop_sequence: null, usage: {input_tokens: 3, output_tokens: 1}}});
const finish = (reason = 'end_turn') => frame('message_delta', {delta: {stop_reason: reason, stop_sequence: null}, usage: {output_tokens: 3}}) + frame('message_stop');
const textBody = (reason = 'end_turn') => start() + frame('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + frame('content_block_delta', {index: 0, delta: {type: 'text_delta', text: '你好，Mio 🙂'}}) + frame('content_block_stop', {index: 0}) + finish(reason);

function socketFixture({body = textBody(), status = 200, peer = '8.8.8.8', authorized = true, noConnect = false, responseStream, rejectAfterEnd = false}: {body?: string; status?: number; peer?: string; authorized?: boolean; noConnect?: boolean; responseStream?: Readable; rejectAfterEnd?: boolean} = {}) {
  const state = {calls: 0, ends: 0, destroyed: false} as MockRequestState;
  state.request = (options, callback) => {
    state.calls++; state.options = options as MockRequestState['options'];
    const request = new EventEmitter() as MockRequest;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    request.setTimeout = (milliseconds, handler) => {readTimer = setTimeout(() => handler?.(), milliseconds);};
    request.destroy = () => {clearTimeout(readTimer); state.destroyed = true;};
    request.end = payload => {
      state.ends++; state.payload = payload;
      if (rejectAfterEnd) {queueMicrotask(() => request.emit('error', Error('synthetic-private-network-marker'))); return;}
      const response = (responseStream ?? Readable.from([Buffer.from(body)])) as MockIncoming;
      response.statusCode = status; response.headers = {'content-type': 'text/event-stream', 'x-private-provider': 'synthetic-header-marker'};
      state.response = response; callback(response);
    };
    queueMicrotask(() => {
      const socket = Object.assign(new EventEmitter(), {remoteAddress: peer, remotePort: 443, authorized, destroy() {state.destroyed = true;}});
      request.emit('socket', socket); assert.equal(state.ends, 0);
      if (!noConnect) socket.emit('secureConnect');
    });
    return request;
  };
  const dependencies: AgentTransportDependencies = {lookup: (async () => [{address: '8.8.8.8', family: 4}]) as unknown as AgentTransportDependencies['lookup'], httpsRequest: state.request as unknown as AgentTransportDependencies['httpsRequest']};
  return {state, dependencies};
}

test('real Anthropic SDK works from an isolated desktop-style static bundle', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-anthropic-sdk-bundle-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const outfile = path.join(root, 'backend.cjs');
  await build({entryPoints: [fileURLToPath(new URL('../packages/business/src/agent/anthropic-sdk-transport.ts', import.meta.url))], outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', define: {'import.meta.url': '__mioon_import_meta_url'},
    banner: {js: 'const __mioon_import_meta_url = require("node:url").pathToFileURL(__filename).href;'}, logLevel: 'silent'});
  const bundled = createRequire(import.meta.url)(outfile) as {createAnthropicSdkTransport: typeof createAnthropicSdkTransport};
  const f = socketFixture(), request = anthropicRequest();
  const response = await bundled.createAnthropicSdkTransport(f.dependencies)({...request, apiKey: 'synthetic-bound-key'});
  let received = '';
  for await (const chunk of response.body) received += Buffer.from(chunk).toString('utf8');
  assert.equal(received, textBody()); assert.equal(f.state.calls, 1); assert.equal(f.state.ends, 1);
  assert.equal(f.state.payload, request.body); assert.equal(f.state.options.path, '/anthropic/v1/messages');
  assert.equal(f.state.options.headers['x-api-key'], 'synthetic-bound-key'); assert.equal(f.state.options.headers['anthropic-version'], '2023-06-01');
});

test('SDK environment defaults, extra headers, credentials and telemetry cannot reach host dispatch', async t => {
  const environment: Record<string, string> = {ANTHROPIC_API_KEY: 'synthetic-env-key', ANTHROPIC_AUTH_TOKEN: 'synthetic-env-token', ANTHROPIC_PROFILE: 'synthetic-missing-profile', ANTHROPIC_BASE_URL: 'https://private.invalid', ANTHROPIC_WEBHOOK_SIGNING_KEY: 'synthetic-webhook-key', ANTHROPIC_CUSTOM_HEADERS: 'Cookie: synthetic-env-cookie\nx-api-key: synthetic-env-header\nanthropic-version: wrong-version', ANTHROPIC_LOG: 'debug', ANTHROPIC_OPEN_TELEMETRY: 'true'};
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  t.after(() => {for (const [key, value] of previous) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}});
  Object.assign(process.env, environment);
  const f = socketFixture(), response = await createAnthropicSdkTransport(f.dependencies)({...anthropicRequest(), apiKey: 'synthetic-bound-key'});
  for await (const _chunk of response.body) {}
  assert.equal(f.state.calls, 1); assert.equal(f.state.options.hostname, 'fixture.example.com');
  const serialized = JSON.stringify(f.state.options);
  for (const marker of ['synthetic-env', 'synthetic-webhook', 'private.invalid', 'wrong-version']) assert.equal(serialized.includes(marker), false);
  assert.equal(f.state.options.headers.Cookie, undefined); assert.equal(f.state.options.headers.Authorization, undefined);
});

test('real SDK request transformations fail before any socket when they differ from frozen intent', async () => {
  const f = socketFixture();
  const body = JSON.stringify({...JSON.parse(anthropicRequest().body), user_profile_id: 'sdk-would-move-this-to-headers'});
  await assert.rejects(createAnthropicSdkTransport(f.dependencies)({configuration, body, apiKey: 'synthetic-key'}), {code: 'AGENT_CHAT_VALIDATION'});
  assert.equal(f.state.calls, 0); assert.equal(f.state.ends, 0);
});

test('an SDK dispatch freezes the original body and credential before asynchronous hooks', async () => {
  const f = socketFixture(), request = anthropicRequest();
  const options = {...request, apiKey: 'synthetic-bound-key'};
  const opening = createAnthropicSdkTransport(f.dependencies)(options);
  options.body = '{}'; options.apiKey = 'synthetic-changed-key';
  options.configuration.protocol = 'chat_completions';
  const response = await opening;
  for await (const _chunk of response.body) {}
  assert.equal(f.state.payload, request.body); assert.equal(f.state.options.headers['x-api-key'], 'synthetic-bound-key');
  assert.equal(f.state.options.headers.Authorization, undefined); assert.equal(f.state.calls, 1);
});
