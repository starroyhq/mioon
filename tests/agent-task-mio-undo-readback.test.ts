import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import * as projectFormats from '../packages/business/src/project-file/schema/databases.ts';
import {agentTaskSnapshotSchema, type AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {projectApiPath, projectRpcPath} from '../packages/contracts/src/project-file.ts';
import type {SequenceEditHistoryView} from '../packages/contracts/src/sequence-edit.ts';
import {defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';
import {putTestAgentConfiguration} from './helpers/agent-settings-fixture.ts';
import {call, object, output, textField} from './helpers/agent-task-runtime-fixture.ts';
import {createTestAgentSettings} from './helpers/secret-codec.ts';
import {startServer, type InspectProject} from './helpers/test-server.ts';

const subtitleTool = 'mioon_sequence_timeline_edit';
const undoTool = 'mioon_sequence_undo';
const protocol = 'chat_completions';

for (const format of [5, 6] as const) test(`format ${format} reads completed direct Mio undo with an ungenerated placeholder`, {
  skip: format === 6 && !('FORMAT6_PROJECT_SCHEMA_VERSION' in projectFormats) ? 'Format 6 is not in this release branch' : false,
}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-mio-undo-readback-'));
  const previousFormat6 = process.env.MIOON_FORMAT6_DEV;
  if (format === 6) process.env.MIOON_FORMAT6_DEV = '1';
  const settings = await createTestAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  t.after(async () => {
    await server?.close();
    await settings.close();
    if (previousFormat6 === undefined) delete process.env.MIOON_FORMAT6_DEV;
    else process.env.MIOON_FORMAT6_DEV = previousFormat6;
    await rm(root, {recursive: true, force: true});
  });
  await putTestAgentConfiguration(settings, {
    expectedRevision: (await settings.get()).revision,
    configuration: defaultTestAgentConfiguration(protocol),
    secret: {action: 'replace', storage: 'persistent', value: 'SYNTHETIC_MIO_UNDO_READBACK'},
  });
  let rounds: AgentTaskToolCall[][] = [];
  const gateway: TaskGateway = async function* (request) {
    request.beforeSubmit?.();
    const calls = rounds.shift() ?? [];
    yield {type: 'done', output: output(protocol, calls, calls.length ? '' : 'Synthetic task finished')};
  };
  let inspect!: InspectProject;
  const host = await startServer({
    dataDir: root, port: 0, token: randomUUID(), localDraftChannel: 'development', comfyModule: 'skip',
    projectFormatForTest: format === 5 ? projectFormats.FORMAT5_PROJECT_SCHEMA_VERSION : undefined,
    agentSettings: settings, taskGatewayV2: gateway, inspectProject: value => {inspect = value;},
  });
  server = host;
  const authorization = {authorization: `Bearer ${host.token}`};
  function request(route: string, input?: unknown) {
    return fetch(host.url + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {...authorization, ...(input === undefined ? {} : {'content-type': 'application/json'})},
      body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15_000),
    });
  }
  async function http(route: string, input?: unknown) {
    const response = await request(route, input);
    const body = object(await response.json());
    assert.equal(response.status, 200, JSON.stringify(body.error));
    assert.equal(body.ok, true);
    return body.data;
  }
  const application = (operation: string, input: Record<string, unknown>) => http('/api/rpc', {operation, input});
  const projectId = textField(await application('project.create', {name: 'Synthetic Mio undo'}), 'id');
  const rpc = (operation: string, input: Record<string, unknown> = {}) => http(projectRpcPath(projectId), {
    operation, input: {projectId, ...input},
  });
  const prefix = projectApiPath(projectId, 'agent', 'tasks', 'v2');
  const history = async () => await rpc('sequence.history.get', {origin: 'mio'}) as SequenceEditHistoryView;
  const read = async () => object(await rpc('project.get'));
  const timelineContents = (value: unknown) => {
    const {clips, durationFrames, subtitles} = object(value);
    return {clips, durationFrames, subtitles};
  };
  async function boardEdit(input: Record<string, unknown>) {
    const plan = object(await rpc('sequence.board.edit', input));
    const receipt = object(await rpc('sequence.action.commit', {envelope: plan.envelope, expectedPlanDigest: plan.planDigest}));
    assert.equal(receipt.status, 'applied');
  }
  assert.equal((await read()).projectFormatVersion, format);
  await boardEdit({kind: 'board-root-create', name: 'Synthetic sequence', position: {x: 0, y: 0}});
  await boardEdit({kind: 'board-shot-append', name: 'Ungenerated shot'});
  const before = timelineContents((await read()).timeline);
  assert.ok(Array.isArray(before.clips));
  assert.ok(before.clips.some(clip => object(clip).sourceState === 'placeholder' && object(clip).assetId === null));

  const grant = object(await application('agent.authorization.list', {}));
  const target = object(grant.currentTarget);
  await application('agent.authorization.grant', {
    requestId: randomUUID(), expectedRevision: grant.revision, expectedSettingsRevision: target.settingsRevision,
    destination: target.destination, model: target.model, scope: 'project_agent',
  });
  async function send(calls: AgentTaskToolCall[][]) {
    rounds = calls;
    const input = {requestId: randomUUID(), text: 'Run a synthetic local edit', expectedSettingsRevision: target.settingsRevision};
    const accepted = agentTaskSnapshotSchema.parse(await http(prefix, input));
    return {input, runId: accepted.run.id};
  }
  async function settle(runId: string, expected: string) {
    const started = Date.now();
    for (;;) {
      const status = inspect(projectId, db => db.prepare('SELECT status FROM mio_runs WHERE id=?').get(runId)?.status);
      if (status === expected) return;
      assert.ok(status !== 'failed' && Date.now() - started < 10_000, `Task did not reach ${expected}: ${String(status)}`);
      await delay(10);
    }
  }
  const readTask = async (runId: string) => agentTaskSnapshotSchema.parse(await http(`${prefix}/${runId}`));
  const edit = await send([
    [call('mioon_tools_load', {names: [subtitleTool]})],
    [call(subtitleTool, {kind: 'subtitles', edits: [{kind: 'add', cue: {text: 'Synthetic cue', startFrame: 0, durationFrames: 5}}]})],
  ]);
  await settle(edit.runId, 'awaiting_approval');
  const review = await readTask(edit.runId);
  const step = review.steps.find(item => item.toolCall?.name === subtitleTool);
  assert.ok(step);
  await http(`${prefix}/${edit.runId}/actions`, {
    action: 'approve', stepId: step.id, requestId: randomUUID(), expectedRevision: review.run.revision,
  });
  await settle(edit.runId, 'completed');
  const editedTask = await readTask(edit.runId);
  assert.equal(editedTask.run.status, 'completed');
  const editedChange = editedTask.changes.find(change => change.operation === 'sequence.tool.timeline');
  assert.ok(editedChange);
  assert.equal(editedChange.reversible, true);
  assert.equal(editedChange.undoDisposition, 'blocked');
  const editedHistory = await history();
  const top = editedHistory.undo;
  assert.ok(top?.actionId);
  assert.equal(top.origin, 'mio');
  const editedTimeline = timelineContents((await read()).timeline);
  const editedSubtitles = object(editedTimeline.subtitles);
  assert.ok(Array.isArray(editedSubtitles.cues));
  assert.deepEqual(editedSubtitles.cues.map(cue => object(cue).text), ['Synthetic cue']);
  const compensation = await request(`${prefix}/${edit.runId}/actions`, {
    action: 'undo_change', changeId: editedChange.id, requestId: randomUUID(), expectedRevision: editedTask.run.revision,
  });
  assert.equal(compensation.status, 409);
  assert.equal(object(object(await compensation.json()).error).code, 'AGENT_TASK_TARGET_CHANGED');
  assert.deepEqual(timelineContents((await read()).timeline), editedTimeline);
  assert.deepEqual(await history(), editedHistory);

  const undo = await send([[call(undoTool, {actionId: top.actionId})]]);
  await settle(undo.runId, 'completed');
  assert.deepEqual(timelineContents((await read()).timeline), before);
  const restored = await history();
  assert.equal(restored.redo?.actionId, top.actionId);
  const completed = await readTask(undo.runId);
  assert.equal(completed.run.status, 'completed');
  const undoStep = completed.steps.find(item => item.toolCall?.name === undoTool);
  assert.ok(undoStep);
  assert.equal(undoStep.status, 'completed');
  const result = object(undoStep.result);
  assert.equal(result.operation, 'undo:timeline.subtitle.edit');
  assert.equal(result.actionId, top.actionId);
  assert.equal(result.status, 'applied');
  const receiptHistory = object(result.history);
  assert.equal(receiptHistory.position, restored.position);
  assert.equal(receiptHistory.revision, restored.revision);
  assert.equal(object(receiptHistory.redo).actionId, top.actionId);
  assert.equal(completed.changes.length, 1);
  const change = completed.changes[0]!;
  assert.equal(change.operation, 'sequence.tool.undo');
  assert.equal(change.reversible, false);
  assert.equal(change.undoDisposition, 'retain');

  const legacy = inspect(projectId, db => {
    const row = db.prepare('SELECT data FROM mio_changes WHERE id=?').get(change.id);
    assert.equal(typeof row?.data, 'string');
    const saved = object(JSON.parse(String(row?.data)));
    assert.equal(saved.reversible, false);
    assert.ok(Array.isArray(saved.undo) && saved.undo.length > 0);
    const previous = {...saved, reversible: true};
    db.prepare('UPDATE mio_changes SET data=? WHERE id=?').run(JSON.stringify(previous), change.id);
    return previous;
  });
  assert.deepEqual(await readTask(undo.runId), completed);
  const lookup = object(await http(`${prefix}/requests/${undo.input.requestId}`));
  assert.equal(lookup.found, true);
  assert.deepEqual(lookup.snapshot, completed);
  assert.deepEqual(await http(prefix, undo.input), completed);
  const eventsController = new AbortController();
  try {
    const response = await fetch(`${host.url}${prefix}/${undo.runId}/events?after=0`, {
      headers: authorization, signal: AbortSignal.any([eventsController.signal, AbortSignal.timeout(5_000)]),
    });
    assert.equal(response.status, 200);
    const frame = await response.body!.getReader().read();
    assert.match(new TextDecoder().decode(frame.value), /event: changed/u);
  } finally {eventsController.abort();}
  assert.deepEqual(inspect(projectId, db => {
    const row = db.prepare('SELECT data FROM mio_changes WHERE id=?').get(change.id);
    return JSON.parse(String(row?.data));
  }), legacy, 'readback must not rewrite the old audit marker');
  await http(`${prefix}/${undo.runId}/actions`, {
    action: 'undo_change', changeId: change.id, requestId: randomUUID(), expectedRevision: completed.run.revision,
  });
  assert.deepEqual(timelineContents((await read()).timeline), before);
  assert.deepEqual(await history(), restored);

  const repeated = await send([[call(undoTool, {actionId: top.actionId})]]);
  await settle(repeated.runId, 'failed');
  const refused = await readTask(repeated.runId);
  const refusedStep = refused.steps.find(item => item.toolCall?.name === undoTool);
  assert.ok(refusedStep);
  assert.equal(refusedStep.error?.code, 'SEQUENCE_EDIT_HISTORY_CONFLICT');
  assert.deepEqual(refused.changes, []);
  assert.deepEqual(timelineContents((await read()).timeline), before);
  assert.deepEqual(await history(), restored);
});
