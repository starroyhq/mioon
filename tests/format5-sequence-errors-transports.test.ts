import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {format5PanelErrorKey} from '../apps/web/src/edit-ui/format5-panel-edits.ts';
import {format5BoardFailureMessageKey, format5CommandErrorMessageKey} from '../apps/web/src/edit-ui/session.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import {sequenceEditInputDigest} from '../packages/business/src/format5-editor-history.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {agentTaskSnapshotSchema, type AgentTaskJson, type AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {projectApiPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import type {Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {isSequenceEditEnvelope, type SequenceEditEnvelope, type SequenceEditErrorCode} from '../packages/contracts/src/sequence-edit.ts';
import {sequenceSyncIntent} from '../packages/contracts/src/sequence-sync.ts';
import {sequenceEditFailureMessageKey, translate} from '../packages/i18n/src/index.ts';
import {defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';
import {putTestAgentConfiguration} from './helpers/agent-settings-fixture.ts';
import {call, object, output, textField} from './helpers/agent-task-runtime-fixture.ts';
import {createTestAgentSettings} from './helpers/secret-codec.ts';
import {testEnv} from './helpers/test-env.ts';
import {startServer} from './helpers/test-server.ts';

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const token = 'synthetic-sequence-error-test';
const protocol = 'chat_completions';
const locale = 'zh-Hans';

interface FailureCase {
  operation: 'sequence.action.edit' | 'sequence.timeline.edit';
  action: Record<string, AgentTaskJson>;
  preview: Record<string, unknown>;
  code: SequenceEditErrorCode;
  ids?: readonly string[];
  reason?: string;
}

test('Format 5 shares actionable sequence failures across preview, CLI, MCP and Mio', {timeout: 90_000}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-sequence-errors-'));
  const settings = await createTestAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  const mcp = new Client({name: 'sequence-errors-test', version: '1.0.0'});
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    try {
      await mcp.close();
      await server?.close();
      await settings.close();
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
  await putTestAgentConfiguration(settings, {
    expectedRevision: (await settings.get()).revision,
    configuration: defaultTestAgentConfiguration(protocol),
    secret: {action: 'replace', storage: 'persistent', value: 'SYNTHETIC_SEQUENCE_ERRORS'},
  });
  const rounds: AgentTaskToolCall[][] = [];
  const gateway: TaskGateway = async function* (request) {
    request.beforeSubmit?.();
    const actions = rounds.shift() ?? [];
    yield {type: 'done', output: output(protocol, actions, actions.length ? '' : 'Synthetic sequence task finished')};
  };
  const host = await startServer({
    dataDir: root, port: 0, token, localDraftChannel: 'development', comfyModule: 'skip',
    projectFormatForTest: FORMAT5_PROJECT_SCHEMA_VERSION, agentSettings: settings, taskGatewayV2: gateway,
  });
  server = host;
  async function request(route: string, input?: unknown) {
    const response = await fetch(host.url + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {authorization: `Bearer ${token}`, ...(input === undefined ? {} : {'content-type': 'application/json'})},
      body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15_000),
    });
    return object(await response.json());
  }
  function success(body: Record<string, unknown>) {
    assert.equal(body.ok, true, JSON.stringify(body.error));
    return object(body.data);
  }
  const application = async (operation: string, input: Record<string, unknown>) => success(await request('/api/rpc', {operation, input}));
  const projectId = textField(await application('project.create', {name: 'Synthetic sequence error matrix'}), 'id');
  const rpc = (operation: string, input: Record<string, unknown> = {}) =>
    request(projectRpcPath(projectId), {operation, input: {projectId, ...input}});
  const read = async (operation: string) => success(await rpc(operation));
  async function edit(operation: string, action: Record<string, unknown>) {
    const {envelope, planDigest} = success(await rpc(operation, action));
    const receipt = success(await rpc('sequence.action.commit', {envelope, expectedPlanDigest: planDigest}));
    assert.equal(receipt.status, 'applied');
  }
  await edit('sequence.board.edit', {kind: 'board-root-create', name: 'Film', position: {x: 0, y: 0}});
  await edit('sequence.board.edit', {kind: 'board-shot-append', name: 'First shot'});
  await edit('sequence.board.edit', {kind: 'board-shot-append', name: 'Second shot'});
  const firstTimeline = (await read('project.get')).timeline as Format5Timeline;
  await edit('sequence.action.edit', {kind: 'split', clipId: firstTimeline.clips[0]!.id, offsetFrames: 15});
  await edit('sequence.timeline.edit', {kind: 'track-add', trackKind: 'video', name: 'Overlay'});
  const imported = success(await rpc('asset.import', {
    name: 'synthetic.png', mimeType: 'image/png',
    dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  }));
  const assetId = textField(imported, 'id');
  const timeline = (await read('project.get')).timeline as Format5Timeline;
  const track = timeline.tracks.find(row => row.id === timeline.mainTrack.trackId);
  const overlay = timeline.tracks.find(row => row.name === 'Overlay');
  const clip = timeline.clips.find(row => row.id === firstTimeline.clips[0]!.id);
  assert.ok(clip?.sequenceSource && track && overlay);
  const fromId = timeline.mainTrack.sequenceNodeId, toId = clip.sequenceSource.nodeId;
  const missingClipId = randomUUID(), missingNodeId = randomUUID(), missingAssetId = randomUUID(), missingTrackId = randomUUID();
  const split = (clipId: string, offsetFrames: number) => ({
    intents: [sequenceSyncIntent({kind: 'clip-split', clipId, offsetFrames, rightClipId: randomUUID()})],
  });
  const board = (edit: Record<string, unknown>) => ({intents: [{side: 'board', operation: {kind: 'board', edit}}]});
  const trackUpdate = {trackId: track.id, patch: {name: track.name}};
  const trackPreview = {trackIntent: {side: 'timeline', operation: {kind: 'track-structure', edit: {kind: 'update', ...trackUpdate}}}};
  const insert = (mediaId: string, trackId: string, startFrame: number, code: SequenceEditErrorCode, ids: string[], reason: string): FailureCase => {
    const action = {kind: 'insert-asset' as const, assetId: mediaId, trackId, startFrame};
    return {operation: 'sequence.timeline.edit', action, preview: {intents: [sequenceSyncIntent(action)]}, code, ids, reason};
  };
  const missingAnchor = insert(assetId, overlay.id, timeline.durationFrames, 'SEQUENCE_EDIT_ANCHOR_CONFLICT',
    [overlay.id], 'MAIN_TRACK_CLIP_REQUIRED');
  const missingAsset = insert(missingAssetId, track.id, 0, 'INVALID_MEDIA', [missingAssetId], 'ASSET_NOT_FOUND');
  const missingTrack = insert(assetId, missingTrackId, 0, 'INVALID_TRACK_TARGET', [missingTrackId], 'TRACK_NOT_FOUND');
  const missingClip: FailureCase = {operation: 'sequence.action.edit', action: {kind: 'split', clipId: missingClipId, offsetFrames: 1},
    preview: split(missingClipId, 1), code: 'CLIP_NOT_FOUND', ids: [missingClipId]};
  const missingNode: FailureCase = {operation: 'sequence.action.edit', action: {kind: 'connect', fromId, toId: missingNodeId},
    preview: board({kind: 'connect', fromId, toId: missingNodeId}), code: 'MISSING_NODE'};
  const noop: FailureCase = {operation: 'sequence.timeline.edit', action: {kind: 'track-update', ...trackUpdate},
    preview: trackPreview, code: 'SEQUENCE_EDIT_NOOP', ids: [track.id]};
  const duplicateEdge: FailureCase = {operation: 'sequence.action.edit', action: {kind: 'connect', fromId, toId},
    preview: board({kind: 'connect', fromId, toId}), code: 'DUPLICATE_EDGE'};
  const attempts: FailureCase[] = [
    {operation: 'sequence.action.edit', action: {kind: 'split', clipId: clip.id, offsetFrames: clip.durationFrames},
      preview: split(clip.id, clip.durationFrames), code: 'INVALID_SPLIT', ids: [clip.id]},
    missingClip,
    {operation: 'sequence.action.edit', action: {kind: 'reorder', clipId: clip.id, beforeClipId: null},
      preview: {intents: [sequenceSyncIntent({kind: 'clip-move', clipId: clip.id, beforeClipId: null})]},
      code: 'COPY_NODE_REQUIRED', ids: [toId, clip.id]},
    missingAsset,
    missingTrack,
    missingAnchor,
    duplicateEdge,
    missingNode,
    {operation: 'sequence.action.edit', action: {kind: 'connect', fromId: toId, toId: fromId},
      preview: board({kind: 'connect', fromId: toId, toId: fromId}), code: 'FILM_MUST_START'},
    {operation: 'sequence.action.edit', action: {kind: 'delete-node', nodeId: fromId},
      preview: board({kind: 'delete', nodeId: fromId}), code: 'ACTIVE_FILM_REMOVED', ids: [fromId]},
    noop,
  ];
  const messages = new Set<string>();
  const snapshot = async () => {
    const {timeline, nodes, edges} = await read('project.get');
    return {timeline, nodes, edges, history: await read('sequence.history.get')};
  };
  const before = await snapshot();
  function expectedMessage({code, reason}: FailureCase, language: 'zh-Hans' | 'en') {
    const key = sequenceEditFailureMessageKey(code, reason);
    assert.ok(key, code);
    return translate(language, key);
  }
  function assertFailure(failure: Record<string, unknown>, item: FailureCase, language: 'zh-Hans' | 'en' = locale) {
    assert.equal(failure.code, item.code);
    const message = textField(failure, 'message');
    assert.equal(message, expectedMessage(item, language));
    assert.doesNotMatch(message, /格式 5 序列动作无法预览|操作没有完成，请重试/u);
    return message;
  }
  function assertDetails(details: Record<string, unknown>, item: FailureCase) {
    if (item.ids) {
      assert.ok(Array.isArray(details.ids), item.code);
      for (const id of item.ids) assert.ok(details.ids.includes(id), `${item.code}: expected ID ${id}`);
    }
    if (item.reason !== undefined) assert.equal(details.reason, item.reason);
  }
  for (const item of attempts) {
    const key = sequenceEditFailureMessageKey(item.code, item.reason);
    assert.ok(key, item.code);
    for (const mapper of [format5BoardFailureMessageKey, format5CommandErrorMessageKey, format5PanelErrorKey]) {
      assert.equal(mapper(item.code, item.reason), key, item.code);
    }
    const direct = success(await rpc('sequence.preview', {requestId: randomUUID(), ...item.preview}));
    assert.equal(direct.ok, false);
    assert.equal(direct.messageKey, key);
    messages.add(assertFailure(direct, item));
    assertDetails(direct, item);
    const wrapper = await rpc(item.operation, item.action);
    assert.equal(wrapper.ok, false);
    const error = object(wrapper.error);
    assertFailure(error, item);
    const details = object(error.details);
    assert.equal(details.messageKey, key);
    assertDetails(details, item);
  }
  assert.equal(messages.size, 11);
  assert.deepEqual(await snapshot(), before);

  const env = {...testEnv(), MIOON_BASE_URL: host.url, MIOON_TOKEN: token};
  for (const language of [locale, 'en'] as const) {
    await assert.rejects(run(process.execPath, ['apps/cli/src/index.ts', ...missingAnchor.operation.split('.'),
      '--locale', language, '--input', JSON.stringify({projectId, ...missingAnchor.action})],
    {cwd: repo, env, encoding: 'utf8', timeout: 30_000}), error => {
      const result = object(error);
      const body = object(JSON.parse(textField(result, 'stdout')));
      assert.equal(body.ok, false);
      const failure = object(body.error);
      const message = assertFailure(failure, missingAnchor, language);
      assertDetails(object(failure.details), missingAnchor);
      assert.equal(textField(result, 'stderr').trim(), `${missingAnchor.code}: ${message}`);
      return true;
    });
  }
  await mcp.connect(new StdioClientTransport({command: process.execPath, args: ['apps/mcp/src/index.ts', '--locale', 'en'],
    cwd: repo, env, stderr: 'ignore'}));
  const reply = await mcp.callTool({name: 'sequence_timeline_edit', arguments: {projectId, ...missingAnchor.action}},
    undefined, {timeout: 15_000}) as CallToolResult;
  assert.equal(reply.isError, true);
  const mcpError = object(object(reply.structuredContent).error);
  assertFailure(mcpError, missingAnchor, 'en');
  assertDetails(object(mcpError.details), missingAnchor);
  const human = reply.content[0];
  assert.ok(human?.type === 'text');
  assert.deepEqual(JSON.parse(human.text), reply.structuredContent);

  // A well-formed commit whose track update does nothing must report the same
  // code and target on its first attempt and after receipt replay.
  const valid = success(await rpc('sequence.timeline.edit', {kind: 'track-update', trackId: track.id, patch: {name: 'Changed label'}}));
  const envelope = valid.envelope;
  assert.ok(isSequenceEditEnvelope(envelope));
  assert.ok(envelope.trackIntent?.operation.edit.kind === 'update');
  const invalid: SequenceEditEnvelope = {...envelope, trackIntent: {...envelope.trackIntent, operation: {
    ...envelope.trackIntent.operation, edit: {kind: 'update', ...trackUpdate},
  }}};
  const commit = {envelope: invalid, expectedPlanDigest: sequenceEditInputDigest(invalid)};
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = await rpc('sequence.action.commit', commit);
    assert.equal(body.ok, false);
    const error = object(body.error);
    assertFailure(error, noop);
    assertDetails(object(error.details), noop);
  }

  // Board planning also supports a durable not-applied receipt instead of an
  // HTTP rejection. Its wire presentation is localized when that receipt is replayed.
  const boardPlan = success(await rpc('sequence.action.edit', {kind: 'disconnect', fromId, toId}));
  assert.ok(isSequenceEditEnvelope(boardPlan.envelope));
  const duplicate: SequenceEditEnvelope = {
    ...boardPlan.envelope,
    intents: [{side: 'board', operation: {kind: 'board', edit: {kind: 'connect', fromId, toId}}}],
  };
  const boardCommit = {projectId, envelope: duplicate, expectedPlanDigest: sequenceEditInputDigest(duplicate)};
  const rejectedBoard = await rpc('sequence.action.commit', boardCommit);
  assert.equal(rejectedBoard.ok, false);
  const boardError = object(rejectedBoard.error);
  assertFailure(boardError, duplicateEdge);
  assertDetails(object(boardError.details), duplicateEdge);
  const boardReceipt = success(await rpc('sequence.action.commit', boardCommit));
  assert.equal(boardReceipt.status, 'not_applied');
  assertFailure(boardReceipt, duplicateEdge);
  assert.equal(boardReceipt.message, boardError.message);
  if (duplicateEdge.ids) assertDetails(object(boardReceipt.failure), duplicateEdge);
  const playedCli = await run(process.execPath, ['apps/cli/src/index.ts', 'sequence', 'action', 'commit',
    '--locale', 'en', '--input', JSON.stringify(boardCommit)], {cwd: repo, env, encoding: 'utf8', timeout: 30_000});
  const boardEnglish = success(object(JSON.parse(playedCli.stdout)));
  assertFailure(boardEnglish, duplicateEdge, 'en');
  assert.deepEqual(boardEnglish, {...boardReceipt, message: boardEnglish.message});
  const playedMcp = await mcp.callTool({name: 'sequence_action_commit', arguments: boardCommit}, undefined, {timeout: 15_000});
  assert.equal(playedMcp.isError, false);
  assert.deepEqual(success(object(playedMcp.structuredContent)), boardEnglish);

  const grant = await application('agent.authorization.list', {});
  const target = object(grant.currentTarget);
  await application('agent.authorization.grant', {requestId: randomUUID(), expectedRevision: grant.revision,
    expectedSettingsRevision: target.settingsRevision, destination: target.destination, model: target.model, scope: 'project_agent'});
  const prefix = projectApiPath(projectId, 'agent', 'tasks', 'v2');
  for (const item of [missingAnchor, missingAsset, missingTrack, missingClip, missingNode]) {
    const tool = item.operation === 'sequence.timeline.edit' ? 'mioon_sequence_timeline_edit' : 'mioon_sequence_edit';
    rounds.splice(0, rounds.length, [call('mioon_tools_load', {names: [tool]})], [call(tool, item.action)]);
    const submitted = agentTaskSnapshotSchema.parse(success(await request(prefix, {requestId: randomUUID(),
      text: 'Perform a synthetic timeline or board edit', locale: 'en', expectedSettingsRevision: target.settingsRevision})));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = agentTaskSnapshotSchema.parse(success(await request(`${prefix}/${submitted.run.id}`)));
      const step = state.steps.find(candidate => candidate.toolCall?.name === tool && candidate.error);
      if (step && state.run.status === 'failed') {
        assertFailure(object(step.error), item, 'en');
        const toolError = object(object(step.result).error);
        assertFailure(toolError, item, 'en');
        assertDetails(toolError, item);
        assert.deepEqual(state.changes, []);
        break;
      }
      assert.ok(Date.now() < deadline, `Mio did not report ${item.code}: ${state.run.status}`);
      await delay(20);
    }
  }
  assert.deepEqual(await snapshot(), before);
});
