import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mock} from 'node:test';
import {fileURLToPath} from 'node:url';
import {ensurePrivateDirectory, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {openStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from '../../packages/business/src/agent/presets.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {AGENT_TASK_CONVERSATION_TOOLS, AGENT_TASK_TOOLS_LOAD_NAME} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {TASK_MODEL_LIMITS} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway, TaskModelItem, TaskModelOutput, TaskModelRequest} from '../../packages/business/src/agent/task-gateway-v2.ts';
import {anthropicMessages} from '../../packages/business/src/agent/anthropic-wire.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson, AgentTaskLocale, AgentTaskSnapshot, AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {authorizeTestScope, createTestAuthorizations} from './agent-authorizations.ts';
import {png} from './timeline-image-fixtures.ts';

export const FINGERPRINT_PROTOCOLS = ['chat_completions', 'responses', 'anthropic_messages'] as const;
export const FINGERPRINT_SCENARIOS = [
  'single_reply', 'read_edit_roundtrip', 'note_during_reply', 'conflict_skip_replan',
  'tool_failure_retry', 'unknown_discard_resume', 'conversation_history_trim',
  'attachment_en', 'diagnostic_text', 'diagnostic_read_only', 'diagnostic_catalog',
  'single_reply_ja', 'single_reply_en', 'single_reply_zh_hant',
] as const;
export const OFFICIAL_FINGERPRINT_SCENARIOS = ['official_single_reply', 'official_read_edit_roundtrip'] as const;
export const FINGERPRINT_PRELOAD_SCENARIOS = ['read_edit_roundtrip', 'conflict_skip_replan', 'tool_failure_retry', 'official_read_edit_roundtrip'] as const;
export type FingerprintScenario = typeof FINGERPRINT_SCENARIOS[number] | typeof OFFICIAL_FINGERPRINT_SCENARIOS[number];
export interface TaskRequestFingerprint {
  scenario: FingerprintScenario;
  protocol: AgentProtocol;
  index: number;
  bytes: number;
  sha256: string;
}
export interface TaskRequestFingerprintFile {
  formatVersion: 1;
  note: string;
  requests: TaskRequestFingerprint[];
}
export const taskRequestFingerprintFixture = new URL('../fixtures/agent-task-request-fingerprints-v2.json', import.meta.url);
const projectId = '00000000-0000-4000-8000-000000000001';
const shotId = '00000000-0000-4000-8000-000000000002';
const uploadId = '00000000-0000-4000-8000-000000000003';
const fixtureTime = '2026-10-27T00:00:00.000Z';

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function call(name: string, args: AgentTaskJson = {}, id = 'call_read'): AgentTaskToolCall {
  return {id, name, arguments: args};
}
function output(protocol: AgentProtocol, calls: AgentTaskToolCall[] = [], text = 'Synthetic reply'): TaskModelOutput {
  let providerOutput: AgentTaskJson;
  if (protocol === 'anthropic_messages') {
    providerOutput = {role: 'assistant', content: [
      {type: 'text', text}, ...calls.map(item => ({type: 'tool_use', id: item.id, name: item.name, input: item.arguments})),
    ]};
  } else if (protocol === 'responses') {
    providerOutput = [
      {type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text}]},
      ...calls.map(item => ({type: 'function_call', call_id: item.id, name: item.name, arguments: JSON.stringify(item.arguments), status: 'completed'})),
    ];
  } else {
    providerOutput = {role: 'assistant', content: text, ...(calls.length ? {tool_calls: calls.map(item => ({
      id: item.id, type: 'function', function: {name: item.name, arguments: JSON.stringify(item.arguments)},
    }))} : {})};
  }
  return {text, toolCalls: calls, providerOutput};
}

/** Check the real assembled request, including call/result pairing. No JSON
 * reserialization, ID replacement or timestamp scrubbing precedes hashing. */
function assertRequest(body: string, protocol: AgentProtocol): void {
  assert.ok(Buffer.byteLength(body) <= TASK_MODEL_LIMITS.requestBytes);
  const request = object(JSON.parse(body));
  if (protocol === 'anthropic_messages') {
    assert.ok(Array.isArray(request.messages));
    anthropicMessages(request.messages as AgentTaskJson[]);
    return;
  }
  const history = request[protocol === 'responses' ? 'input' : 'messages'];
  assert.ok(Array.isArray(history));
  const pending = new Set<string>();
  for (const item of history) {
    const row = object(item);
    if (protocol === 'responses' && row.type === 'function_call') {
      assert.equal(typeof row.call_id, 'string');
      assert.equal(pending.has(String(row.call_id)), false);
      pending.add(String(row.call_id));
    } else if (protocol === 'responses' && row.type === 'function_call_output') {
      assert.equal(pending.delete(String(row.call_id)), true);
    } else if (protocol === 'chat_completions' && row.role === 'assistant') {
      assert.equal(pending.size, 0);
      if (Array.isArray(row.tool_calls)) for (const value of row.tool_calls) {
        const id = object(value).id;
        assert.equal(typeof id, 'string');
        assert.equal(pending.has(String(id)), false);
        pending.add(String(id));
      }
    } else if (protocol === 'chat_completions' && row.role === 'tool') {
      assert.equal(pending.delete(String(row.tool_call_id)), true);
    } else {
      assert.equal(pending.size, 0, 'An ordinary message cannot interrupt a tool call/result group');
    }
  }
  assert.equal(pending.size, 0);
}

type Script = (index: number, request: TaskModelRequest) => AsyncGenerator<TaskModelItem, void, undefined>;
/** Keep each original scripted response at its old relative index. The extra
 * first model turn loads canvas through the same durable path as a real model. */
function withCanvasLoad(protocol: AgentProtocol, script: Script): Script {
  return async function* (index, request) {
    if (index === 1) yield {type: 'done', output: output(protocol,
      [call(AGENT_TASK_TOOLS_LOAD_NAME, {groups: ['canvas']}, 'call_load_canvas')], 'Load the canvas tools.')};
    else yield* script(index - 1, request);
  };
}
function assertCanvasLoaded(snapshot: AgentTaskSnapshot): void {
  const loads = snapshot.steps.filter(step => step.kind === 'tool' && step.toolCall?.name === AGENT_TASK_TOOLS_LOAD_NAME);
  assert.equal(loads.length, 1);
  assert.equal(loads[0]!.status, 'completed');
  assert.deepEqual(object(loads[0]!.result).groups, ['canvas']);
}
async function fixture(protocol: AgentProtocol, official = false) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-request-fingerprint-'));
  const store = openStore(root), services = createServices(store, new Map());
  // Seed complete, fixed domain rows. Runtime/journal/control UUIDs remain
  // genuine; they must never accidentally become part of these request bodies.
  store.put('projects', {id: projectId, name: 'Fingerprint project', description: '', revision: 1, createdAt: fixtureTime, updatedAt: fixtureTime});
  store.put('shots', {id: shotId, projectId, title: 'First shot', prompt: 'Original prompt', referenceAssetIds: [],
    aspectRatio: '9:16', duration: 2, parameters: {}, position: {x: 80, y: 100}, orderIndex: 0, revision: 1,
    selectedVersionId: null, createdAt: fixtureTime, updatedAt: fixtureTime});
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const anthropic = AGENT_PRESETS.find(preset => preset.id === 'anthropic')?.platforms.find(platform => platform.id === 'global');
  assert.ok(anthropic);
  const configuration = official ? protocol === 'anthropic_messages' ? {
    presetId: 'anthropic', platformId: anthropic.id, baseUrl: anthropic.baseUrl, model: anthropic.model, protocol,
  } : {...DEFAULT_AGENT_CONFIGURATION, protocol} : {presetId: 'ollama', platformId: 'local', protocol,
    model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
  // This disposable credential stays only in the real settings session. It is
  // deliberately nondeterministic: only the model-facing body is fingerprinted.
  const sessionSecret = official ? randomUUID() : null;
  const assertNoSessionSecret = (value: string): void => {
    assert.ok(sessionSecret === null || !value.includes(sessionSecret), 'Session credentials must not enter request artifacts');
  };
  await settings.put({expectedRevision: 0, configuration, secret: sessionSecret === null ? {action: 'remove'} : {
    action: 'replace', storage: 'session', value: sessionSecret,
  }});
  const authorizations = createTestAuthorizations(() => ({...store}), settings);
  await authorizeTestScope(authorizations, 'project_agent');
  const tools = createAgentTaskTools({store, services}), requests: string[] = [];
  let script: Script = async function* () {yield {type: 'done', output: output(protocol)};};
  const gateway: TaskGateway = async function* (request) {
    request.beforeSubmit?.();
    if (official) {
      assert.ok(request.apiKey === sessionSecret, 'Official preset must use its synthetic session credential');
      assert.equal(request.configuration.presetId, protocol === 'anthropic_messages' ? 'anthropic' : 'openai');
      assert.equal(request.configuration.model, configuration.model);
      assert.equal(request.configuration.baseUrl, configuration.baseUrl);
    }
    assertNoSessionSecret(request.body);
    assertRequest(request.body, protocol);
    const run = runtime.journal.list(projectId).find(value => value.status === 'running');
    assert.ok(run);
    const model = runtime.journal.snapshot(run.id).steps.filter(value => value.kind === 'model').at(-1);
    assert.ok(model);
    assertNoSessionSecret(JSON.stringify(model.request));
    assert.equal(object(model.request).body, request.body, 'The fingerprint must cover the already durable intent');
    requests.push(request.body);
    yield* script(requests.length, request);
  };
  const createRuntime = (): ReturnType<typeof createAgentTaskRuntime> => createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318});
  let runtime = createRuntime();
  const runtimes = [runtime];
  return {
    store, services, tools, requests, assertNoSessionSecret,
    get runtime() {return runtime;},
    restart() {runtime.close(); runtime = createRuntime(); runtimes.push(runtime);},
    setScript(value: Script) {script = value;},
    async send(text = 'Inspect this project.', options: Record<string, unknown> = {}) {
      return runtime.send(projectId, {requestId: randomUUID(), expectedSettingsRevision: (await settings.get()).revision, text, ...options});
    },
    async settle(runId: string) {await runtime.drain(); return runtime.get(projectId, runId);},
    action(snapshot: AgentTaskSnapshot, action: string, extra: Record<string, unknown> = {}) {
      return runtime.action(projectId, snapshot.run.id, {requestId: randomUUID(), expectedRevision: snapshot.run.revision, action, ...extra});
    },
    stageAttachment() {
      const bytes = png(), relativePath = `agent-imports/${uploadId}.bin`;
      ensurePrivateDirectory(path.join(root, 'agent-imports'), {create: true});
      writePrivateFileAtomic(path.join(root, relativePath), bytes, {root, maxBytes: 30 * 1024 * 1024, replace: false});
      store.db.prepare("INSERT INTO agent_task_imports_v2(id,projectId,requestId,name,mimeType,relativePath,sha256,status,assetId,createdAt) VALUES(?,?,?,?,?,?,?,'selected',NULL,?)")
        .run(uploadId, projectId, 'fingerprint-selected-image', 'Selected image.png', 'image/png', relativePath, createHash('sha256').update(bytes).digest('hex'), fixtureTime);
      return uploadId;
    },
    async close() {for (const value of runtimes) value.close(); await Promise.all(runtimes.map(value => value.drain())); tools.dispose(); await services.drain(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true});},
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
async function waitForGateway(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The synthetic request did not enter the gateway within 10 seconds')), 10_000);
    })]);
  } finally {clearTimeout(timer);}
}
async function finish(f: Fixture, text?: string, options?: Record<string, unknown>) {
  const sent = await f.send(text, options), done = await f.settle(sent.run.id);
  assert.equal(done.run.status, 'completed');
  return done;
}

async function runScenario(f: Fixture, protocol: AgentProtocol, scenario: FingerprintScenario): Promise<void> {
  if (scenario === 'official_single_reply') scenario = 'single_reply';
  else if (scenario === 'official_read_edit_roundtrip') scenario = 'read_edit_roundtrip';
  if (scenario === 'single_reply' || scenario.startsWith('single_reply_')) {
    const locales: Partial<Record<FingerprintScenario, AgentTaskLocale>> = {single_reply_ja: 'ja', single_reply_en: 'en', single_reply_zh_hant: 'zh-Hant'};
    await finish(f, undefined, {locale: locales[scenario] ?? 'zh-Hans'});
  } else if (scenario === 'read_edit_roundtrip') {
    f.setScript(withCanvasLoad(protocol, async function* (index) {yield {type: 'done', output: output(protocol,
      index === 1 ? [call('mioon_project_inspect')] : index === 2 ? [call('mioon_shot_update', {
        shotId, expectedRevision: 1, patch: {prompt: 'Updated prompt'},
      }, 'call_edit')] : [], index < 3 ? 'Inspect then edit.' : 'Edit complete.')};}));
    const done = await finish(f, 'Read the project, then update the first shot prompt.');
    assertCanvasLoaded(done);
    assert.equal(done.changes.length, 1);
    assert.equal(object(f.store.get('shots', shotId)).prompt, 'Updated prompt');
  } else if (scenario === 'note_during_reply') {
    const entered = gate(), release = gate();
    f.setScript(async function* (index) {
      if (index === 1) {entered.resolve(); await release.promise;}
      yield {type: 'done', output: output(protocol, [], index === 1 ? 'Initial reply.' : 'Reply including the note.')};
    });
    try {
      const sent = await f.send(); await waitForGateway(entered.promise);
      const original = f.requests[0]!;
      await f.action(f.runtime.get(projectId, sent.run.id), 'note', {text: 'NOTE_KEEP_THE_ORIGINAL_COLOUR'});
      assert.doesNotMatch(original, /NOTE_KEEP_THE_ORIGINAL_COLOUR/u);
      release.resolve();
      assert.equal((await f.settle(sent.run.id)).run.status, 'completed');
      assert.equal(f.requests[0], original);
      assert.match(f.requests[1]!, /NOTE_KEEP_THE_ORIGINAL_COLOUR/u);
    } finally {release.resolve();}
  } else if (scenario === 'conflict_skip_replan') {
    const target = {kind: 'shot', id: shotId, revision: f.runtime.journal.targetRevision(projectId, 'shot', shotId)};
    f.runtime.journal.edit({requestId: randomUUID(), projectId, ownerId: '00000000-0000-4000-8000-000000000004',
      generation: 1, sequence: 1, action: 'claim', targets: [target]});
    f.setScript(withCanvasLoad(protocol, async function* (index) {yield {type: 'done', output: output(protocol, index < 3 ? [call('mioon_shot_update', {
      shotId, expectedRevision: 1, patch: {prompt: 'Must stay untouched'},
    }, `call_edit_${index}`)] : [])};}));
    const sent = await f.send(), paused = await f.settle(sent.run.id);
    assert.equal(paused.run.pauseReason, 'editing');
    await assert.rejects(f.action(paused, 'resume'), {code: 'AGENT_TASK_SKIP_REQUIRED'});
    await f.action(paused, 'skip');
    const done = await f.settle(sent.run.id);
    assertCanvasLoaded(done);
    assert.equal(done.run.status, 'completed');
    assert.equal(done.run.skippedTargets?.length, 1);
    assert.equal(done.steps.filter(value => value.error?.code === 'TARGET_SKIPPED').length, 1);
    assert.match(f.requests[2]!, /TARGET_SKIPPED/u);
    assert.match(f.requests[3]!, /这一处由用户保留/u);
    assert.equal(done.changes.length, 0);
    assert.equal(object(f.store.get('shots', shotId)).prompt, 'Original prompt');
  } else if (scenario === 'tool_failure_retry') {
    f.setScript(withCanvasLoad(protocol, async function* (index) {yield {type: 'done', output: output(protocol, index === 1 ? [call('mioon_shot_update', {
      shotId, expectedRevision: 1, patch: {duration: -1},
    }, 'call_invalid_edit')] : index === 2 ? [call('mioon_shot_update', {
      shotId, expectedRevision: 1, patch: {prompt: 'Retry edit'},
    }, 'call_retry_edit')] : [])};}));
    const sent = await f.send(), failed = await f.settle(sent.run.id);
    assert.equal(failed.run.status, 'failed');
    assert.equal(failed.steps.at(-1)?.error?.code, 'VALIDATION_ERROR');
    await f.action(failed, 'retry', {stepId: failed.steps.at(-1)!.id});
    const done = await f.settle(sent.run.id);
    assertCanvasLoaded(done);
    assert.equal(done.run.status, 'completed');
    assert.match(f.requests[2]!, /VALIDATION_ERROR/u);
    assert.equal(done.changes.length, 1);
  } else if (scenario === 'unknown_discard_resume') {
    const entered = gate(), release = gate();
    f.setScript(async function* (index) {
      if (index === 1) {entered.resolve(); await release.promise;}
      yield {type: 'done', output: output(protocol, [], 'Continued after explicit disposition.')};
    });
    try {
      const sent = await f.send(); await waitForGateway(entered.promise);
      f.restart();
      const unknown = f.runtime.get(projectId, sent.run.id);
      assert.equal(unknown.run.status, 'interrupted');
      assert.equal(unknown.steps[0]?.status, 'unknown');
      await assert.rejects(f.action(unknown, 'resume'), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
      assert.equal(f.requests.length, 1);
      release.resolve();
      const disposed = await f.action(unknown, 'resolve_unknown', {stepId: unknown.steps[0]!.id, resolution: 'discard'});
      await f.action(disposed, 'resume');
      assert.equal((await f.settle(sent.run.id)).run.status, 'completed');
      assert.equal(f.requests.length, 2);
      assert.match(f.requests[1]!, /上一次模型请求结果未知/u);
    } finally {release.resolve();}
  } else if (scenario === 'conversation_history_trim') {
    f.setScript(async function* (index) {yield {type: 'done', output: output(protocol, [],
      index < 3 ? `${index === 1 ? 'FIRST_REPLY_' : 'SECOND_REPLY_'}${'r'.repeat(50_000)}` : 'History retained.')};});
    const first = await finish(f, `FIRST_MESSAGE_${'a'.repeat(28_000)}`);
    const second = await finish(f, `SECOND_MESSAGE_${'b'.repeat(28_000)}`, {conversationId: first.run.conversationId});
    await finish(f, 'Continue this conversation.', {conversationId: second.run.conversationId});
    assert.match(f.requests[1]!, /FIRST_MESSAGE_/u);
    assert.doesNotMatch(f.requests[2]!, /FIRST_MESSAGE_|FIRST_REPLY_/u);
    assert.match(f.requests[2]!, /SECOND_MESSAGE_/u);
    assert.match(f.requests[2]!, /SECOND_REPLY_/u);
  } else if (scenario === 'attachment_en') {
    await finish(f, 'Inspect this selected attachment.', {locale: 'en', uploads: [f.stageAttachment()]});
    assert.match(f.requests[0]!, /Attachments selected by the user/u);
    assert.ok(f.requests[0]!.includes(uploadId));
  } else if (scenario === 'diagnostic_text') {
    await finish(f, 'Synthetic text diagnostic.', {diagnostic: {profile: 'text'}});
    assert.equal(object(JSON.parse(f.requests[0]!)).tools, undefined);
  } else if (scenario === 'diagnostic_read_only') {
    f.setScript(async function* (index) {yield {type: 'done', output: output(protocol,
      index === 1 ? [call('mioon_project_inspect')] : [], 'Synthetic read-only diagnostic.')};});
    const done = await finish(f, 'Synthetic read-only diagnostic.', {diagnostic: {profile: 'read_only'}});
    assert.equal(done.changes.length, 0);
    const tools = object(JSON.parse(f.requests[0]!)).tools;
    assert.ok(Array.isArray(tools));
    // A diagnostic has none of the conversation-only host tools: no loader,
    // nobody to answer a question, and no methods or review reports (C6).
    assert.equal(tools.length, f.tools.list().filter(value => value.risk === 'read_only' && !AGENT_TASK_CONVERSATION_TOOLS.includes(value.name)).length);
    assert.ok(tools.every(value => {
      const tool = object(value), name = object(protocol === 'chat_completions' ? tool.function : tool).name;
      return !AGENT_TASK_CONVERSATION_TOOLS.includes(String(name));
    }));
  } else if (scenario === 'diagnostic_catalog') {
    f.setScript(async function* () {yield {type: 'done', output: output(protocol, [call('mioon_shot_update', {
      shotId, expectedRevision: 1, patch: {prompt: 'Diagnostic must never execute'},
    }, 'call_catalog_edit')], 'Synthetic catalog diagnostic.')};});
    const done = await finish(f, 'Synthetic catalog diagnostic.', {diagnostic: {profile: 'catalog', toolNames: ['mioon_shot_update']}});
    const tools = object(JSON.parse(f.requests[0]!)).tools;
    assert.ok(Array.isArray(tools)); assert.equal(tools.length, 1);
    assert.equal(done.steps.filter(value => value.kind === 'tool').length, 0);
    assert.equal(object(f.store.get('shots', shotId)).prompt, 'Original prompt');
  } else {
    throw new Error(`Unknown fingerprint scenario: ${scenario}`);
  }
}

/** Entirely offline: the production gateway is replaced before runtime starts.
 * Only Date is fixed; real IDs and temporary workspace paths stay unmodified. */
export async function collectTaskRequestFingerprints(): Promise<TaskRequestFingerprint[]> {
  const fingerprints: TaskRequestFingerprint[] = [];
  mock.timers.enable({apis: ['Date'], now: Date.parse(fixtureTime)});
  try {
    async function capture(protocol: AgentProtocol, scenario: FingerprintScenario, official = false): Promise<void> {
      const f = await fixture(protocol, official);
      try {
        await runScenario(f, protocol, scenario);
        assert.ok(f.requests.length > 0, `${protocol}/${scenario} must dispatch a model request`);
        const records = f.requests.map((body, index) => ({scenario, protocol, index: index + 1,
          bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex')}));
        f.assertNoSessionSecret(JSON.stringify(records));
        fingerprints.push(...records);
      } catch (error) {
        throw new Error(`Fingerprint scenario failed: ${protocol}/${scenario}`, {cause: error});
      } finally {await f.close();}
    }
    for (const protocol of FINGERPRINT_PROTOCOLS) for (const scenario of FINGERPRINT_SCENARIOS) await capture(protocol, scenario);
    // Keep scenario order stable. H1b adds one real loading request before each
    // canvas workflow; diagnostic scenarios retain their original requests.
    for (const protocol of FINGERPRINT_PROTOCOLS) for (const scenario of OFFICIAL_FINGERPRINT_SCENARIOS) await capture(protocol, scenario, true);
    return fingerprints;
  } finally {mock.timers.reset();}
}

export function readTaskRequestFingerprintFixture(): TaskRequestFingerprintFile {
  const value: unknown = JSON.parse(readFileSync(taskRequestFingerprintFixture, 'utf8'));
  const file = object(value);
  assert.equal(file.formatVersion, 1);
  assert.equal(typeof file.note, 'string');
  assert.ok(Array.isArray(file.requests));
  for (const value of file.requests) {
    const row = object(value);
    assert.deepEqual(Object.keys(row), ['scenario', 'protocol', 'index', 'bytes', 'sha256']);
    assert.ok([...FINGERPRINT_SCENARIOS, ...OFFICIAL_FINGERPRINT_SCENARIOS].some(scenario => scenario === row.scenario));
    assert.ok(FINGERPRINT_PROTOCOLS.some(protocol => protocol === row.protocol));
    assert.ok(Number.isSafeInteger(row.index) && Number(row.index) > 0);
    assert.ok(Number.isSafeInteger(row.bytes) && Number(row.bytes) > 0);
    assert.match(String(row.sha256), /^[a-f0-9]{64}$/u);
  }
  return value as TaskRequestFingerprintFile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['--update'], 'Usage: node tests/helpers/agent-task-request-fingerprints-v2.ts --update');
  const requests = await collectTaskRequestFingerprints();
  const file: TaskRequestFingerprintFile = {formatVersion: 1,
    note: 'Reviewed raw runtime request bytes. Review scenario and request changes before explicitly regenerating with node tests/helpers/agent-task-request-fingerprints-v2.ts --update. No real model or provider is contacted.', requests};
  writeFileSync(taskRequestFingerprintFixture, JSON.stringify(file, null, 2) + '\n');
  console.log(`Updated ${requests.length} request fingerprints across ${FINGERPRINT_PROTOCOLS.length} protocols and ${FINGERPRINT_SCENARIOS.length + OFFICIAL_FINGERPRINT_SCENARIOS.length} scenarios.`);
}
