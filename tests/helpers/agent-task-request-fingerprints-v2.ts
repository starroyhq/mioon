import {createTestAgentSettings} from './secret-codec.ts';
import {putTestAgentConfiguration,testAgentExecution} from './agent-settings-fixture.ts';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mock} from 'node:test';
import {backup} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {ensurePrivateDirectory, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {openServerTestStore} from '../../packages/business/src/project-file/test-store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import {createProjectFile, openClosedProjectSnapshotConnection} from '../../packages/business/src/project-file/connection.ts';
import {FORMAT4_HISTORY_SCHEMA_VERSION, FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION, FORMAT5_PROJECT_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION, PROJECT_FILE_SCHEMA_VERSION} from '../../packages/business/src/project-file/schema/databases.ts';
import {assertProjectStore} from '../../packages/business/src/store-runtime.ts';
import {createMioRecords} from '../../packages/business/src/agent/mio-records.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createAgentSettings} from '../../packages/business/src/agent/settings.ts';
import {AGENT_PRESETS, DEFAULT_AGENT_CONFIGURATION} from '../../packages/business/src/agent/presets.ts';
import {createAgentTaskTools} from '../../packages/business/src/agent/task-tools-v2.ts';
import {createFormat5SequenceEditService} from '../../packages/business/src/format5-sequence-edit-service.ts';
import {AGENT_TASK_CONVERSATION_TOOLS, AGENT_TASK_TOOLS_LOAD_NAME} from '../../packages/business/src/agent/task-tool-groups-v2.ts';
import {createAgentTaskRuntime} from '../../packages/business/src/agent/task-runtime-v2.ts';
import type {AgentTaskRuntimeOptions} from '../../packages/business/src/agent/task-runtime-v2.ts';
import {TASK_MODEL_LIMITS} from '../../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskGateway, TaskModelItem, TaskModelOutput, TaskModelRequest} from '../../packages/business/src/agent/task-gateway-v2.ts';
import {anthropicMessages} from '../../packages/business/src/agent/anthropic-wire.ts';
import type {AgentProtocol} from '../../packages/contracts/src/agent-protocol.ts';
import type {AgentTaskJson, AgentTaskLocale, AgentTaskSnapshot, AgentTaskToolCall} from '../../packages/contracts/src/agent-tasks-v2.ts';
import {TEST_STORE_DIRECTORY, TEST_STORE_LAYOUT} from '../../packages/contracts/src/project-file.ts';
import {authorizeTestScope, createTestAuthorizations} from './agent-authorizations.ts';
import {png} from './timeline-image-fixtures.ts';

export const FINGERPRINT_PROTOCOLS = ['chat_completions', 'responses', 'anthropic_messages'] as const;
export const FINGERPRINT_SCENARIOS = [
  'single_reply', 'read_edit_roundtrip', 'note_during_reply', 'conflict_reread',
  'tool_failure_retry', 'unknown_discard_resume', 'conversation_history_trim',
  'attachment_en', 'diagnostic_text', 'diagnostic_read_only', 'diagnostic_catalog',
  'single_reply_ja', 'single_reply_en', 'single_reply_zh_hant',
] as const;
export const OFFICIAL_FINGERPRINT_SCENARIOS = ['official_single_reply', 'official_read_edit_roundtrip'] as const;
export const FINGERPRINT_PRELOAD_SCENARIOS = ['read_edit_roundtrip', 'conflict_reread', 'tool_failure_retry', 'official_read_edit_roundtrip'] as const;
export type FingerprintScenario = typeof FINGERPRINT_SCENARIOS[number] | typeof OFFICIAL_FINGERPRINT_SCENARIOS[number];
export const FINGERPRINT_FORMATS = ['format4', 'format3', 'format5'] as const;
export type FingerprintProjectFormat = typeof FINGERPRINT_FORMATS[number];
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
/** Both kernel formats run the same scenarios and capture the exact gateway
 * bytes. The legacy scenarios edit a disposable clone of the read-only source. */
export interface TaskRequestFingerprintHarness {
  format?: FingerprintProjectFormat;
  /** Omitted for full captures and fixture updates, preserving their order. */
  protocol?: AgentProtocol;
  createFixturePorts?: (store: ProjectStore) => {
    services: ReturnType<typeof createServices>;
    createAuthorizations: (settings: Awaited<ReturnType<typeof createAgentSettings>>) => ReturnType<typeof createTestAuthorizations>;
    close: () => void;
  };
  createRuntime?: (options: AgentTaskRuntimeOptions) => ReturnType<typeof createAgentTaskRuntime>;
  createTools?: (options: Parameters<typeof createAgentTaskTools>[0]) => ReturnType<typeof createAgentTaskTools>;
  stageAttachment?: (store: ProjectStore, input: {
    id: string; projectId: string; requestId: string; name: string; mimeType: string;
    relativePath: string; sha256: string; createdAt: string;
  }) => void;
  afterClose?: (input: {root: string; requests: readonly string[]; intents: readonly {runId: string; stepId: string}[]; protocol: AgentProtocol; scenario: FingerprintScenario}) => void | Promise<void>;
}
const fingerprintFixtures = {
  format3: new URL('../fixtures/agent-task-request-fingerprints-v2.json', import.meta.url),
  format4: new URL('../fixtures/agent-task-format4-request-fingerprints-v2.json', import.meta.url),
  format5: new URL('../fixtures/agent-task-format5-request-fingerprints-v2.json', import.meta.url),
};
const projectId = '00000000-0000-4000-8000-000000000001';
const shotId = '00000000-0000-4000-8000-000000000002';
const uploadId = '00000000-0000-4000-8000-000000000003';
const format5 = Object.freeze({root:'00000000-0000-4000-8000-000000000011', version:'00000000-0000-4000-8000-000000000012',
  asset:'00000000-0000-4000-8000-000000000013', job:'00000000-0000-4000-8000-000000000014',
  clip:'00000000-0000-4000-8000-000000000015', track:'00000000-0000-4000-8000-000000000016',
  group:'00000000-0000-4000-8000-000000000017', timeline:'00000000-0000-4000-8000-000000000018',
  baseline:{version:1, board:[{nodeId:shotId,kind:'shot',selectedVersionId:null}],
    track:[{nodeId:shotId,segmentGroupId:'00000000-0000-4000-8000-000000000017',clipId:'00000000-0000-4000-8000-000000000015',
      kind:'shot',versionMode:'follow',appliedVersionId:'00000000-0000-4000-8000-000000000012'}]}});
const fixtureTime = '2026-10-27T00:00:00.000Z';

export function reopenFingerprintProject(root: string, format: FingerprintProjectFormat): ProjectStore {
  const projectFile = path.join(root, ...TEST_STORE_LAYOUT.projectFile);
  const location = {
    localDir: path.join(root, ...TEST_STORE_LAYOUT.localDir),
    cacheDir: path.join(root, ...TEST_STORE_LAYOUT.cacheDir),
    tempDir: path.join(root, ...TEST_STORE_LAYOUT.tempDir),
  };
  const store = openServerTestStore({projectFile, locate: () => location,
    ...(format === 'format5' ? {} : format === 'format4' ? {format4: {}} : {})},
    path.join(root, TEST_STORE_DIRECTORY, 'app'));
  try {
    const [projectVersion, historyVersion] = format === 'format5' ?
      [FORMAT5_PROJECT_SCHEMA_VERSION, FORMAT5_HISTORY_SCHEMA_VERSION] : format === 'format4' ?
      [FORMAT4_PROJECT_SCHEMA_VERSION, FORMAT4_HISTORY_SCHEMA_VERSION] : [PROJECT_FILE_SCHEMA_VERSION, HISTORY_SCHEMA_VERSION];
    assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version, projectVersion);
    assert.equal(store.db.prepare('SELECT version FROM main.schema_version').get()?.version, historyVersion);
    return store;
  } catch (error) {store.close(); throw error;}
}

async function createFingerprintProject(root: string, format: FingerprintProjectFormat): Promise<() => void> {
  const projectFile = path.join(root, ...TEST_STORE_LAYOUT.projectFile);
  if (format === 'format5') {
    createProjectFile(projectFile, {projectId, targetFormat: 5});
    return () => {};
  }
  if (format === 'format4') {
    createProjectFile(projectFile, {projectId, format4: {}});
    return () => {};
  }
  // The editing scenarios need writes and a runtime, so run them on a
  // disposable format-3 clone. The old source is opened only by SQLite's
  // read-only snapshot connection and stays untouched even on re-open.
  const source = path.join(root, 'closed-source'), sourceFile = path.join(source, 'source.mioon');
  mkdirSync(source, {mode: 0o700});
  createProjectFile(sourceFile, {projectId});
  const original = createHash('sha256').update(readFileSync(sourceFile)).digest('hex');
  const connection = openClosedProjectSnapshotConnection({projectFile: sourceFile});
  try {
    assert.equal(connection.db.prepare('PRAGMA query_only').get()?.query_only, 1);
    assert.equal(connection.db.prepare('PRAGMA user_version').get()?.user_version, PROJECT_FILE_SCHEMA_VERSION);
    await backup(connection.db, projectFile);
  } finally {connection.close();}
  return () => {
    assert.equal(createHash('sha256').update(readFileSync(sourceFile)).digest('hex'), original);
    assert.deepEqual(readdirSync(source), ['source.mioon']);
  };
}

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
    // The context validator accepts plain conversation blocks. Cache policy is
    // applied later by the request builder, so validate pairing on a copy with
    // only legal block metadata removed. The original body is still hashed
    // directly below; neither cache metadata nor ordering is normalized there.
    const messages=request.messages.map(value=>{
      const message=object(value);
      if(!Array.isArray(message.content))return message;
      return {...message,content:message.content.map(value=>{
        const block=object(value);
        if(!Object.hasOwn(block,'cache_control'))return block;
        assert.deepEqual(block.cache_control,{type:'ephemeral'});
        return Object.fromEntries(Object.entries(block).filter(([key])=>key!=='cache_control'));
      })};
    });
    anthropicMessages(messages as AgentTaskJson[]);
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
 * first model turn loads the required shot-update tool through the real path. */
function withCanvasLoad(protocol: AgentProtocol, script: Script): Script {
  return async function* (index, request) {
    if (index === 1) yield {type: 'done', output: output(protocol,
      [call(AGENT_TASK_TOOLS_LOAD_NAME, {names: ['mioon_shot_update']}, 'call_load_canvas')], 'Load the shot update tool.')};
    else yield* script(index - 1, request);
  };
}
function assertCanvasLoaded(snapshot: AgentTaskSnapshot): void {
  const loads = snapshot.steps.filter(step => step.kind === 'tool' && step.toolCall?.name === AGENT_TASK_TOOLS_LOAD_NAME);
  assert.equal(loads.length, 1);
  assert.equal(loads[0]!.status, 'completed');
  assert.deepEqual(object(loads[0]!.result).names, ['mioon_shot_update']);
}
const sequenceEditCall = (arguments_: AgentTaskJson, id: string) => call('mioon_sequence_edit', arguments_, id);
function sequenceSetMode(mode: 'follow' | 'locked', id: string): AgentTaskToolCall {
 return sequenceEditCall({kind: 'set-mode', clipId: format5.clip, mode, versionId: format5.version}, id);
}
/** A real user edit between Mio turns; it advances the clip target revision so
 * the approved stale Mio remove must fail closed with TARGET_CHANGED. */
function saveUserSequenceEdit(f: Fixture): void {
 const service = createFormat5SequenceEditService(f.store), requestId = `user-format5-${randomUUID()}`;
 const preview = service.preview({projectId, requestId, origin: 'user', propertiesIntent: {side: 'timeline',
   operation: {kind: 'clip-properties', edits: [{clipId: format5.clip, patch: {name: 'User property edit'}}]}}}) as Record<string, unknown>;
 assert.ok(typeof preview.planDigest === 'string');
 const receipt = service.commit({projectId, envelope: preview.envelope, expectedPlanDigest: preview.planDigest}) as Record<string, unknown>;
 assert.equal(receipt.status, 'applied');
 assert.equal((f.store.get('timelines', format5.timeline) as {clips?: {id: string; name?: string}[]}).clips?.find(clip => clip.id === format5.clip)?.name, 'User property edit');
}
async function fixture(protocol: AgentProtocol, official = false, harness: TaskRequestFingerprintHarness = {}) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-request-fingerprint-'));
  // The fixed request seed is also the real kernel file identity, not a
  // second project inserted into a randomly identified project file.
  const format = harness.format ?? 'format4';
  let verifySource: () => void;
  let store: ProjectStore;
  try {
    verifySource = await createFingerprintProject(root, format);
    store = reopenFingerprintProject(root, format);
  } catch (error) {rmSync(root, {recursive: true, force: true}); throw error;}
  assertProjectStore(store);
  const ports = harness.createFixturePorts?.(store), services = ports?.services ?? createServices(store, new Map());
  // Seed complete, fixed domain rows. Runtime/journal/control UUIDs remain
  // genuine; they must never accidentally become part of these request bodies.
  store.put('projects', {id: projectId, name: 'Fingerprint project', description: '', revision: 1, createdAt: fixtureTime, updatedAt: fixtureTime});
  if (format === 'format5') {
    // One fixed, fully wired format-5 film: root chain node, a shot with one
    // applied version, and one main-track clip. This is real project content so
    // sequence.inspect/sequence.tool.edit go through the production services.
    store.tx(() => {
      store.put('shots', {id: shotId, projectId, title: 'First shot', orderIndex: 0, selectedVersionId: null,
        duration: 1, createdAt: fixtureTime, updatedAt: fixtureTime});
      store.put('assets', {id: format5.asset, projectId, name: 'take.mp4', mimeType: 'video/mp4', duration: 1, sha256: 'a'.repeat(64)});
      store.put('jobs', {id: format5.job, projectId, status: 'succeeded', phase: 'done', providerId: 'mock',
        model: 'mock', shotId, createdAt: fixtureTime, updatedAt: fixtureTime});
      store.put('versions', {id: format5.version, projectId, jobId: format5.job, shotId, number: 1,
        assetId: format5.asset, sha256: 'a'.repeat(64), createdAt: fixtureTime});
      store.put('nodes', {id: format5.root, projectId, type: 'sequence_root', name: 'Film',
        position: {x: 0, y: 0}, createdAt: fixtureTime});
      store.put('edges', {id: '00000000-0000-4000-8000-000000000019', projectId, kind: 'sequence',
        source: format5.root, target: shotId, createdAt: fixtureTime});
      store.put('timelines', {id: format5.timeline, projectId, revision: 1, width: 720, height: 1280, fps: 30,
        durationFrames: 30, createdAt: fixtureTime, updatedAt: fixtureTime,
        mainTrack: {trackId: format5.track, sequenceNodeId: format5.root},
        tracks: [{id: format5.track, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}],
        clips: [{id: format5.clip, trackId: format5.track, name: 'A', startFrame: 0, durationFrames: 30,
          sourceInFrame: 0, rect: {x: 0, y: 0, width: 720, height: 1280}, gain: 1,
          assetId: format5.asset, versionId: format5.version, shotId,
          sourceState: 'ready', sequenceSource: {kind: 'shot', nodeId: shotId,
            segmentGroupId: format5.group, versionMode: 'follow'}}]});
      store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
        .run(format5.timeline, projectId, format5.root, 1, JSON.stringify(format5.baseline));
    });
  } else store.put('shots', {id: shotId, projectId, title: 'First shot', prompt: 'Original prompt', referenceAssetIds: [],
    aspectRatio: '9:16', duration: 2, parameters: {}, position: {x: 80, y: 100}, orderIndex: 0, revision: 1,
    selectedVersionId: null, createdAt: fixtureTime, updatedAt: fixtureTime});
  const settings = await createTestAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const anthropic = AGENT_PRESETS.find(preset => preset.id === 'anthropic')?.platforms.find(platform => platform.id === 'global');
  assert.ok(anthropic);
  const configuration = official ? protocol === 'anthropic_messages' ? {
    presetId: 'anthropic', platformId: anthropic.id, baseUrl: anthropic.baseUrl, model: anthropic.model, protocol,
  } : {...DEFAULT_AGENT_CONFIGURATION, protocol, ...(protocol === 'chat_completions' ? {model: 'gpt-6-luna'} : {})} : {presetId: 'ollama', platformId: 'local', protocol,
    model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
  // This disposable credential stays only in the synthetic settings vault. It is
  // deliberately nondeterministic: only the model-facing body is fingerprinted.
  const syntheticSecret = official ? randomUUID() : null;
  const assertNoSyntheticSecret = (value: string): void => {
    assert.ok(syntheticSecret === null || !value.includes(syntheticSecret), 'Test credentials must not enter request artifacts');
  };
  await putTestAgentConfiguration(settings,{expectedRevision: 0, configuration, secret: syntheticSecret === null ? {action: 'remove'} : {
    action: 'replace', storage: 'persistent', value: syntheticSecret,
  }});
  const authorizations = ports?.createAuthorizations(settings) ?? createTestAuthorizations(() => store, settings);
  await authorizeTestScope(authorizations, 'project_agent');
  const tools = (harness.createTools ?? createAgentTaskTools)({store, services}), requests: string[] = [], intents: {runId: string; stepId: string}[] = [];
  let script: Script = async function* () {yield {type: 'done', output: output(protocol)};};
  const gateway: TaskGateway = async function* (request) {
    request.beforeSubmit?.();
    if (official) {
      assert.ok(request.apiKey === syntheticSecret, 'Official preset must use its synthetic credential');
      assert.equal(request.configuration.presetId, protocol === 'anthropic_messages' ? 'anthropic' : 'openai');
      assert.equal(request.configuration.model, configuration.model);
      assert.equal(request.configuration.baseUrl, configuration.baseUrl);
    }
    assertNoSyntheticSecret(request.body);
    assertRequest(request.body, protocol);
    const run = runtime.journal.list(projectId).find(value => value.status === 'running');
    assert.ok(run);
    const model = runtime.journal.snapshot(run.id).steps.filter(value => value.kind === 'model').at(-1);
    assert.ok(model);
    assertNoSyntheticSecret(JSON.stringify(model.request));
    assert.equal(object(model.request).body, request.body, 'The fingerprint must cover the already durable intent');
    requests.push(request.body);
    intents.push({runId: run.id, stepId: model.id});
    yield* script(requests.length, request);
  };
  const createRuntime = (): ReturnType<typeof createAgentTaskRuntime> => (harness.createRuntime ?? createAgentTaskRuntime)({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318});
  let runtime = createRuntime();
  const runtimes = [runtime];
  return {
    store, services, tools, requests, assertNoSyntheticSecret,
    get runtime() {return runtime;},
    restart() {runtime.close(); runtime = createRuntime(); runtimes.push(runtime);},
    setScript(value: Script) {script = value;},
    async send(text = 'Inspect this project.', options: Record<string, unknown> = {}) {
      return runtime.send(projectId, {requestId: randomUUID(), expectedSettingsRevision: testAgentExecution(await settings.get()).revision, text, ...options});
    },
    async settle(runId: string) {await runtime.drain(); return runtime.get(projectId, runId);},
    action(snapshot: AgentTaskSnapshot, action: string, extra: Record<string, unknown> = {}) {
      return runtime.action(projectId, snapshot.run.id, {requestId: randomUUID(), expectedRevision: snapshot.run.revision, action, ...extra});
    },
    stageAttachment() {
      const bytes = png(), relativePath = `agent-imports/${uploadId}.bin`;
      ensurePrivateDirectory(path.join(root, 'agent-imports'), {create: true});
      writePrivateFileAtomic(path.join(root, relativePath), bytes, {root, maxBytes: 30 * 1024 * 1024, replace: false});
      const input = {id: uploadId, projectId, requestId: 'fingerprint-selected-image', name: 'Selected image.png', mimeType: 'image/png', relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), createdAt: fixtureTime};
      if (harness.stageAttachment) harness.stageAttachment(store, input);
      else store.tx(() => createMioRecords(store).addImport({...input, status: 'selected', assetId: null, resourceId: null}));
      return uploadId;
    },
    async close(verify?: () => void | Promise<void>) {try {for (const value of runtimes) value.close(); await Promise.all(runtimes.map(value => value.drain())); tools.dispose(); await services.drain(); await settings.close(); ports?.close(); store.close(); await verify?.(); verifySource();} finally {rmSync(root, {recursive: true, force: true});}},
    format, root, intents,
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
    if (f.format === 'format5') {
      // Four requests, same shape as the canvas workflow: read the project,
      // read the sequence, make one bounded Mio write, then finish.
      f.setScript(async function* (index) {yield {type: 'done', output: output(protocol,
        index === 1 ? [call('mioon_project_inspect', {}, 'call_read_project')] : index === 2 ? [call('mioon_sequence_inspect', {}, 'call_read_sequence')] :
        index === 3 ? [sequenceSetMode('locked', 'call_edit')] : [],
        index < 4 ? 'Inspect then edit the sequence.' : 'Edit complete.')};});
      const done = await finish(f, 'Read the project and sequence, then lock the first clip.');
      assert.equal(done.changes.length, 1);
      const timeline = f.store.get('timelines', format5.timeline) as {clips: {id: string; sequenceSource?: {versionMode?: string}}[]};
      assert.equal(timeline.clips.find(clip => clip.id === format5.clip)?.sequenceSource?.versionMode, 'locked');
      assert.equal(done.steps.filter(step => step.kind === 'tool' && step.toolCall?.name === 'mioon_sequence_edit').length, 1);
    } else {
      f.setScript(withCanvasLoad(protocol, async function* (index) {yield {type: 'done', output: output(protocol,
        index === 1 ? [call('mioon_project_inspect')] : index === 2 ? [call('mioon_shot_update', {
          shotId, expectedRevision: 1, patch: {prompt: 'Updated prompt'},
        }, 'call_edit')] : [], index < 3 ? 'Inspect then edit.' : 'Edit complete.')};}));
      const done = await finish(f, 'Read the project, then update the first shot prompt.');
      assertCanvasLoaded(done);
      assert.equal(done.changes.length, 1);
      assert.equal(object(f.store.get('shots', shotId)).prompt, 'Updated prompt');
    }
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
  } else if (scenario === 'conflict_reread') {
    if (f.format === 'format5') {
      // The Mio remove requires approval. While it waits, a real user edit
      // advances the clip target; approving the stale remove must fail closed
      // with TARGET_CHANGED, and the reread set-mode then applies.
      f.setScript(async function* (index) {yield {type: 'done', output: output(protocol,
        index === 1 ? [call('mioon_project_inspect', {}, 'call_read_project')] : index === 2 ? [call('mioon_sequence_edit', {
          kind: 'remove', clipId: format5.clip,
        }, 'call_edit_stale')] : index === 3 ? [sequenceSetMode('locked', 'call_edit_reread')] : [],
        index < 4 ? 'Inspect then conditionally edit.' : 'Reread edit complete.')};});
      const sent = await f.send();
      const waiting = await f.settle(sent.run.id);
      assert.equal(waiting.run.status, 'awaiting_approval');
      const stale = waiting.steps.find(step => step.toolCall?.id === 'call_edit_stale');
      assert.ok(stale); assert.equal(stale.status, 'awaiting_approval');
      saveUserSequenceEdit(f);
      await assert.rejects(f.action(waiting, 'approve', {stepId: stale.id}), {code: 'AGENT_TASK_TARGET_CHANGED', handedBack: true});
      const done = await f.settle(waiting.run.id);
      const rejected = done.steps.find(value => value.toolCall?.id === 'call_edit_stale');
      assert.equal(rejected?.status, 'rejected');
      assert.equal(rejected?.error?.code, 'TARGET_CHANGED');
      assert.match(f.requests[2]!, /TARGET_CHANGED/u);
      assert.match(f.requests[3]!, /User property edit/u);
      assert.equal(done.changes.length, 1);
      assert.deepEqual(done.run.skippedTargets, []);
      assert.equal((f.store.get('timelines', format5.timeline) as {clips: {id: string; name?: string}[]}).clips
        .find(clip => clip.id === format5.clip)?.name, 'User property edit');
    } else {
      // X4: the user saves while the second request is in flight. The stale call is
      // handed back with the saved value, and the reread edit applies.
      f.setScript(withCanvasLoad(protocol, async function* (index) {
        if (index === 1) await f.services.call('shot.update', {shotId, expectedRevision: 1, patch: {prompt: 'User prompt'}});
        yield {type: 'done', output: output(protocol, index === 1 ? [call('mioon_shot_update', {
          shotId, expectedRevision: 1, patch: {prompt: 'Stale AI prompt'},
        }, 'call_edit_stale')] : index === 2 ? [call('mioon_shot_update', {
          shotId, expectedRevision: 2, patch: {prompt: 'User prompt, refined'},
        }, 'call_edit_reread')] : [])};
      }));
      const done = await finish(f);
      assertCanvasLoaded(done);
      const stale = done.steps.find(value => value.toolCall?.id === 'call_edit_stale');
      assert.equal(stale?.status, 'rejected');
      assert.equal(stale?.error?.code, 'TARGET_CHANGED');
      assert.match(f.requests[2]!, /TARGET_CHANGED/u);
      assert.match(f.requests[2]!, /User prompt/u);
      assert.match(f.requests[3]!, /User prompt, refined/u);
      assert.equal(done.changes.length, 1);
      assert.deepEqual(done.run.skippedTargets, []);
      assert.equal(object(f.store.get('shots', shotId)).prompt, 'User prompt, refined');
    }
  } else if (scenario === 'tool_failure_retry') {
    if (f.format === 'format5') {
      f.setScript(async function* (index) {yield {type: 'done', output: output(protocol,
        index === 1 ? [call('mioon_project_inspect', {}, 'call_read_project')] : index === 2 ? [sequenceEditCall({kind: 'split', clipId: format5.clip, offsetFrames: 0}, 'call_invalid_edit')] :
        index === 3 ? [sequenceSetMode('follow', 'call_retry_edit')] : [],
        index < 4 ? 'Inspect then retry.' : 'Retry complete.')};});
      const sent = await f.send(), failed = await f.settle(sent.run.id);
      assert.equal(failed.run.status, 'failed');
      assert.equal(failed.steps.at(-1)?.error?.code, 'VALIDATION_ERROR');
      await f.action(failed, 'retry', {stepId: failed.steps.at(-1)!.id});
      const done = await f.settle(sent.run.id);
      assert.equal(done.run.status, 'completed');
      assert.match(f.requests[2]!, /VALIDATION_ERROR/u);
      assert.equal(done.changes.length, 1);
    } else {
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
    }
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
    assert.equal(tools.length, f.tools.diagnosticList().filter(value => value.risk === 'read_only' && !AGENT_TASK_CONVERSATION_TOOLS.includes(value.name)).length);
    assert.ok(tools.every(value => {
      const tool = object(value), name = object(protocol === 'chat_completions' ? tool.function : tool).name;
      return !AGENT_TASK_CONVERSATION_TOOLS.includes(String(name));
    }));
  } else if (scenario === 'diagnostic_catalog') {
    if (f.format === 'format5') {
      const before = f.store.get('timelines', format5.timeline) as {revision?: number};
      f.setScript(async function* () {yield {type: 'done', output: output(protocol, [call('mioon_sequence_undo', {}, 'call_catalog_edit')], 'Synthetic catalog diagnostic.')};});
      const done = await finish(f, 'Synthetic catalog diagnostic.', {diagnostic: {profile: 'catalog', toolNames: ['mioon_sequence_undo']}});
      const tools = object(JSON.parse(f.requests[0]!)).tools;
      assert.ok(Array.isArray(tools)); assert.equal(tools.length, 1);
      assert.equal(done.steps.filter(value => value.kind === 'tool').length, 0);
      assert.equal((f.store.get('timelines', format5.timeline) as {revision?: number}).revision, before.revision);
    } else {
      f.setScript(async function* () {yield {type: 'done', output: output(protocol, [call('mioon_shot_update', {
        shotId, expectedRevision: 1, patch: {prompt: 'Diagnostic must never execute'},
      }, 'call_catalog_edit')], 'Synthetic catalog diagnostic.')};});
      const done = await finish(f, 'Synthetic catalog diagnostic.', {diagnostic: {profile: 'catalog', toolNames: ['mioon_shot_update']}});
      const tools = object(JSON.parse(f.requests[0]!)).tools;
      assert.ok(Array.isArray(tools)); assert.equal(tools.length, 1);
      assert.equal(done.steps.filter(value => value.kind === 'tool').length, 0);
      assert.equal(object(f.store.get('shots', shotId)).prompt, 'Original prompt');
    }
  } else {
    throw new Error(`Unknown fingerprint scenario: ${scenario}`);
  }
}

/** Entirely offline: the production gateway is replaced before runtime starts.
 * Only Date is fixed; real IDs and temporary workspace paths stay unmodified. */
export async function collectTaskRequestFingerprints(harness: TaskRequestFingerprintHarness = {}): Promise<TaskRequestFingerprint[]> {
  const fingerprints: TaskRequestFingerprint[] = [];
  // Format-5 sequence tool results carry server-allocated action ids and
  // history epochs. Normalize only those two audit UUIDs so request bytes stay
  // deterministic; all other ids and payload bytes remain untouched.
  const fingerprintBody=(format: FingerprintProjectFormat, body: string): string => format === 'format5'
    ? body.replace(/(\\?"(?:requestId|inputDigest|actionId|epoch|requestHash)\\?":\\?")([0-9a-f-]{36}|[0-9a-f]{64})(\\?")/gu,
      (_whole, before, value, after) => `${before}${String(value).length === 64 ? '0'.repeat(64) : '00000000-0000-4000-8000-000000000000'}${after}`)
    : body;
  const protocols = harness.protocol === undefined ? FINGERPRINT_PROTOCOLS : [harness.protocol];
  assert.ok(protocols.every(protocol => FINGERPRINT_PROTOCOLS.some(value => value === protocol)));
  mock.timers.enable({apis: ['Date'], now: Date.parse(fixtureTime)});
  try {
    async function capture(protocol: AgentProtocol, scenario: FingerprintScenario, official = false): Promise<void> {
      const f = await fixture(protocol, official, harness);
      let completed = false;
      try {
        await runScenario(f, protocol, scenario);
        assert.ok(f.requests.length > 0, `${protocol}/${scenario} must dispatch a model request`);
        const records = f.requests.map((body, index) => {const normalized=fingerprintBody(f.format,body);
          return {scenario, protocol, index: index + 1, bytes: Buffer.byteLength(normalized),
            sha256: createHash('sha256').update(normalized).digest('hex')};});
        f.assertNoSyntheticSecret(JSON.stringify(records));
        fingerprints.push(...records);
        completed = true;
      } catch (error) {
        throw new Error(`Fingerprint scenario failed: ${protocol}/${scenario}`, {cause: error});
      } finally {await f.close(completed && harness.afterClose ? () => harness.afterClose!({root: f.root, requests: f.requests, intents: f.intents, protocol, scenario}) : undefined);}
    }
    for (const protocol of protocols) for (const scenario of FINGERPRINT_SCENARIOS) await capture(protocol, scenario);
    // Keep scenario order stable. H1b adds one real loading request before each
    // canvas workflow; diagnostic scenarios retain their original requests.
    for (const protocol of protocols) for (const scenario of OFFICIAL_FINGERPRINT_SCENARIOS) await capture(protocol, scenario, true);
    return fingerprints;
  } finally {mock.timers.reset();}
}

export function readTaskRequestFingerprintFixture(format: FingerprintProjectFormat): TaskRequestFingerprintFile {
  const value: unknown = JSON.parse(readFileSync(fingerprintFixtures[format], 'utf8'));
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
  const update = process.argv[2], format = process.argv[3] ?? 'format4';
  assert.ok(update === '--update' && (format === 'format3' || format === 'format4' || format === 'format5') && process.argv.length <= 4,
    'Usage: node tests/helpers/agent-task-request-fingerprints-v2.ts --update [format4|format3|format5]');
  const requests = await collectTaskRequestFingerprints({format});
  const file: TaskRequestFingerprintFile = {formatVersion: 1,
    note: 'Reviewed raw runtime request bytes. Review scenario and request changes before explicitly regenerating with node tests/helpers/agent-task-request-fingerprints-v2.ts --update. No real model or provider is contacted.', requests};
  writeFileSync(fingerprintFixtures[format], JSON.stringify(file, null, 2) + '\n');
  console.log(`Updated ${format}: ${requests.length} request fingerprints across ${FINGERPRINT_PROTOCOLS.length} protocols and ${FINGERPRINT_SCENARIOS.length + OFFICIAL_FINGERPRINT_SCENARIOS.length} scenarios.`);
}
