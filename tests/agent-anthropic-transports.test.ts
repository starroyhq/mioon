import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startServer} from '../apps/server/src/index.ts';
import {AGENT_PROTOCOLS, deriveAgentEndpoint} from '../packages/contracts/src/agent-protocol.ts';
import {agentAuthorizationListSchema} from '../packages/contracts/src/agent-authorization.ts';
import type {AgentAuthorizationList} from '../packages/contracts/src/agent-authorization.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import type {AgentSettingsSnapshot} from '../packages/business/src/agent/settings.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {parseReadToolArguments} from '../packages/business/src/agent/read-tool-policy.ts';
import {parseEditToolArguments} from '../packages/business/src/agent/edit-tool-policy.ts';
import {parseTimelineEditToolArguments} from '../packages/business/src/agent/timeline-edit-tool-policy.ts';
import {parseTimelineGainEditToolArguments} from '../packages/business/src/agent/timeline-gain-tool-policy.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
type Envelope = {ok: true; data: unknown} | {ok: false; error: {code: string}};
function envelope(value: unknown): Envelope {
  assert.ok(object(value));
  if (value.ok === true && Object.hasOwn(value, 'data')) return {ok: true, data: value.data};
  assert.equal(value.ok, false); assert.ok(object(value.error)); assert.equal(typeof value.error.code, 'string');
  return {ok: false, error: {code: value.error.code as string}};
}
function data(value: Envelope): unknown {assert.equal(value.ok, true, JSON.stringify(value)); if (!value.ok) assert.fail(); return value.data;}

test('Anthropic settings, targets and scoped authority stay consistent across real HTTP, CLI and MCP', {timeout: 45000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-anthropic-transports-'));
  const token = 'synthetic-anthropic-transport-token';
  let chatCalls = 0, taskCalls = 0, attemptedGrant: Record<string, AgentTaskJson> = {};
  const server = await startServer({dataDir: root, port: 0, token,
    chatGateway: async function* () {chatCalls++; yield {type: 'done', finishReason: 'stop'};},
    taskGatewayV2: async function* (request) {
      taskCalls++; assert.equal(request.configuration.protocol, 'anthropic_messages');
      const call = {id: 'tool_self_authorization', name: 'mioon_agent_authorization_grant', arguments: attemptedGrant};
      yield {type: 'done', output: {text: '', toolCalls: [call], providerOutput: {role: 'assistant', content: [{type: 'tool_use', id: call.id, name: call.name, input: call.arguments}]}}};
    },
  });
  const client = new Client({name: 'anthropic-offline-transports', version: '1'}, {capabilities: {}});
  t.after(async () => {await client.close(); await server.close(); await rm(root, {recursive: true, force: true});});
  const env = {PATH: process.env.PATH ?? '', TMPDIR: process.env.TMPDIR ?? tmpdir(), MIOON_BASE_URL: server.url, MIOON_TOKEN: token, MIOON_ENABLE_LIVE_PROVIDER: '0'};
  const transport = new StdioClientTransport({command: process.execPath, args: [path.join(repo, 'apps/mcp/src/index.ts')], cwd: repo, env, stderr: 'pipe'});
  if (transport.stderr instanceof Readable) transport.stderr.resume();
  await client.connect(transport);
  async function http(route: string, method = 'GET', input?: unknown) {
    const response = await fetch(server.url + route, {method, headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, ...(input === undefined ? {} : {body: JSON.stringify(input)})});
    return {status: response.status, body: envelope(await response.json())};
  }
  async function rpc(operation: string, input: Record<string, unknown> = {}) {
    const response = await http('/api/rpc', 'POST', {operation, input}); assert.equal(response.status, 200, JSON.stringify(response.body)); return data(response.body);
  }
  async function cli(operation: string, input: Record<string, unknown> = {}) {
    const child = spawn(process.execPath, [path.join(repo, 'apps/cli/src/index.ts'), ...operation.split('.'), '--input', JSON.stringify(input)], {cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {stdout += chunk;});
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {stderr += chunk;});
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {child.kill('SIGKILL'); reject(Error('Offline CLI fixture timed out'));}, 15000);
      child.once('error', error => {clearTimeout(timer); reject(error);});
      child.once('close', code => {clearTimeout(timer); resolve(code);});
    });
    assert.equal(stdout.includes(token) || stderr.includes(token), false);
    return {code, body: envelope(JSON.parse(stdout))};
  }
  async function mcp(operation: string, input: Record<string, unknown> = {}) {
    const result = await client.callTool({name: operation.replaceAll('.', '_'), arguments: input});
    return envelope(result.structuredContent);
  }
  const settings = async () => data((await http('/api/agent/settings')).body) as AgentSettingsSnapshot;
  async function targets(): Promise<AgentAuthorizationList> {
    const fromHttp = agentAuthorizationListSchema.parse(await rpc('agent.authorization.list'));
    const fromCli = await cli('agent.authorization.list'); assert.equal(fromCli.code, 0, JSON.stringify(fromCli.body));
    assert.deepEqual(agentAuthorizationListSchema.parse(data(fromCli.body)), fromHttp);
    assert.deepEqual(agentAuthorizationListSchema.parse(data(await mcp('agent.authorization.list'))), fromHttp);
    return fromHttp;
  }
  async function grant(via: 'http' | 'cli' | 'mcp', scope: 'typed_chat_only' | 'project_agent') {
    const state = await targets();
    const input = {requestId: randomUUID(), expectedRevision: state.revision, expectedSettingsRevision: state.currentTarget.settingsRevision,
      destination: state.currentTarget.destination, model: state.currentTarget.model, scope};
    if (via === 'http') return rpc('agent.authorization.grant', input);
    if (via === 'cli') {const result = await cli('agent.authorization.grant', input); assert.equal(result.code, 0); return data(result.body);}
    return data(await mcp('agent.authorization.grant', input));
  }

  const native: AgentConfiguration = {protocol: 'anthropic_messages', presetId: 'anthropic', platformId: 'global', baseUrl: 'https://api.anthropic.com', model: 'claude-haiku-4-5'};
  const saved = await http('/api/agent/settings', 'PUT', {expectedRevision: (await settings()).revision, configuration: native,
    secret: {action: 'replace', storage: 'session', value: 'synthetic-offline-native-key'}});
  assert.equal(saved.status, 200); assert.deepEqual((await settings()).configuration, native);
  const fromCli = await cli('agent.settings.get'); assert.equal(fromCli.code, 0, JSON.stringify(fromCli.body));
  assert.deepEqual(data(fromCli.body), await settings());
  const preset = (await settings()).presets.find(item => item.id === 'anthropic'); assert.ok(preset);
  assert.equal(preset.defaultProtocol, 'anthropic_messages'); assert.deepEqual(preset.availableProtocols, Object.keys(AGENT_PROTOCOLS));
  assert.equal(preset.platforms[0]?.baseUrl, 'https://api.anthropic.com');
  const firstTarget = await targets(); assert.equal(firstTarget.currentTarget.destination, 'https://api.anthropic.com/v1/messages');
  assert.equal(firstTarget.currentTarget.model, native.model);
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['agent_settings_get', 'agent_settings_set', 'agent_settings_secret_set', 'agent_task_send']) assert.equal(tools.includes(name), false);
  const hidden = await mcp('agent.settings.get'); assert.equal(hidden.ok, false); if (hidden.ok) assert.fail(); assert.equal(hidden.error.code, 'UNKNOWN_OPERATION');
  await grant('mcp', 'typed_chat_only'); await grant('cli', 'project_agent');

  const project = await rpc('project.create', {name: 'Offline native protocol authority'}); assert.ok(object(project) && typeof project.id === 'string');
  const projectId = project.id, prefix = `/api/agent/tasks/v2/${projectId}`;
  const beforeAttempt = await targets();
  attemptedGrant = {requestId: randomUUID(), expectedRevision: beforeAttempt.revision, expectedSettingsRevision: beforeAttempt.currentTarget.settingsRevision,
    destination: beforeAttempt.currentTarget.destination, model: beforeAttempt.currentTarget.model, scope: 'project_inspection'};
  const sent = await http(prefix, 'POST', {requestId: randomUUID(), expectedSettingsRevision: (await settings()).revision, text: 'Offline fixture attempts an unlisted authorization tool'});
  assert.equal(sent.status, 200); const accepted = data(sent.body); assert.ok(object(accepted) && object(accepted.run) && typeof accepted.run.id === 'string');
  let ended: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 200; attempt++) {
    const snapshot = data((await http(`${prefix}/${accepted.run.id}`)).body); assert.ok(object(snapshot) && object(snapshot.run));
    if (snapshot.run.status !== 'running') {ended = snapshot.run; break;}
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(ended?.status, 'failed'); assert.equal(taskCalls, 1); assert.deepEqual(await targets(), beforeAttempt);
  for (const parser of [parseReadToolArguments, parseEditToolArguments, parseTimelineEditToolArguments, parseTimelineGainEditToolArguments]) {
    assert.throws(() => parser('mioon_agent_authorization_grant', JSON.stringify(attemptedGrant)));
  }

  async function assertInactive(configuration: AgentConfiguration) {
    const current = await settings(), listed = await targets();
    assert.equal(listed.currentTarget.destination, deriveAgentEndpoint(configuration)); assert.equal(listed.currentTarget.settingsRevision, current.revision);
    const fromCli = await cli('agent.task.list', {projectId}); assert.equal(fromCli.code, 0, JSON.stringify(fromCli.body));
    const httpPage = data((await http(prefix)).body), cliPage = data(fromCli.body);
    assert.ok(object(httpPage) && object(cliPage)); assert.deepEqual(cliPage.settings, httpPage.settings); assert.deepEqual(cliPage.authorization, httpPage.authorization);
    assert.ok(object(httpPage.authorization)); assert.deepEqual(httpPage.authorization.scopes, []);
    const input = {expectedSettingsRevision: current.revision, text: 'Must remain unauthorized'};
    const blocked = await http(prefix, 'POST', {requestId: randomUUID(), ...input});
    assert.equal(blocked.status, 409); assert.equal(blocked.body.ok, false); if (blocked.body.ok) assert.fail(); assert.equal(blocked.body.error.code, 'AGENT_TASK_CONSENT_REQUIRED');
    const blockedCli = await cli('agent.task.send', {projectId, requestId: randomUUID(), ...input});
    assert.notEqual(blockedCli.code, 0); assert.equal(blockedCli.body.ok, false); if (blockedCli.body.ok) assert.fail(); assert.equal(blockedCli.body.error.code, 'AGENT_TASK_CONSENT_REQUIRED');
    assert.equal(taskCalls, 1);
  }
  const movedEndpoint = {...native, baseUrl: 'https://api.anthropic.com/compat'};
  const moved = await cli('agent.settings.set', {expectedRevision: (await settings()).revision, configuration: movedEndpoint});
  assert.equal(moved.code, 0, JSON.stringify(moved.body)); assert.deepEqual(data(moved.body), await settings());
  await assertInactive(movedEndpoint); await grant('http', 'project_agent');
  const switched: AgentConfiguration = {...movedEndpoint, presetId: 'custom', platformId: 'custom', protocol: 'responses'};
  const changed = await cli('agent.settings.set', {expectedRevision: (await settings()).revision, configuration: switched});
  assert.equal(changed.code, 0, JSON.stringify(changed.body)); await assertInactive(switched);
  assert.equal(chatCalls, 0); assert.equal(taskCalls, 1);
});
