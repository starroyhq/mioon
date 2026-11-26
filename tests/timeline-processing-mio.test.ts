import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createAgentTaskTools, listAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {agentTaskToolCatalogProfile, parseAgentTaskToolNameLoadInput} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {createMioRuntime} from '../packages/business/src/agent/mio-runtime.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import {createProjectFile} from '../packages/business/src/project-file/connection.ts';
import {readFormat5TimelineRecord} from '../packages/business/src/project-file/format5-timeline.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {openServerTestStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices, type OrdinaryServices} from '../packages/business/src/services.ts';
import type {AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import {isTimelineProcessingOperation, timelineProcessingSchemas} from '../packages/contracts/src/timeline-processing.ts';
import {authorizeTestScope, createTestAuthorizations} from './helpers/agent-authorizations.ts';
import {defaultTestAgentConfiguration} from './helpers/agent-preset-configurations.ts';
import {putTestAgentConfiguration, testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {mioTestPolicy} from './helpers/mio-runtime-fixture.ts';
import {createTestAgentSettings} from './helpers/secret-codec.ts';

test('processing tools appear only in the enabled format-6 Mio catalog with exact host-owned fields', () => {
  const processing = (tools: ReturnType<typeof listAgentTaskTools>) => tools.filter(tool => isTimelineProcessingOperation(tool.operation));
  for (const catalog of [listAgentTaskTools(), listAgentTaskTools(true), listAgentTaskTools(false, true)]) {
    assert.deepEqual(processing(catalog), []);
  }
  const format6 = listAgentTaskTools(true, true, true);
  assert.equal(agentTaskToolCatalogProfile(format6), 'format6');
  const tools = processing(format6);
  assert.deepEqual(tools.map(tool => tool.operation).sort(), Object.keys(timelineProcessingSchemas).sort());
  for (const tool of tools) {
    assert.deepEqual(parseAgentTaskToolNameLoadInput({names: [tool.name]}, 'format6'), [tool.name]);
    assert.equal(parseAgentTaskToolNameLoadInput({names: [tool.name]}, 'format5'), null);
    const schema = tool.parameters as {properties: Record<string, unknown>};
    assert.equal(Object.hasOwn(schema.properties, 'projectId'), false);
    assert.equal(Object.hasOwn(schema.properties, 'requestId'), false);
    assert.equal(tool.risk, ['timeline.processing.retry', 'timeline.processing.cancel', 'timeline.processing.cache.clear'].includes(tool.operation)
      ? 'local_irreversible' : 'read_only');
  }
});

test('Mio processing retry honors approval and recovers only its original durable receipt', {timeout: 30_000}, async t => {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'mioon-processing-mio-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const projectId = randomUUID(), taskId = randomUUID();
  const projectFile = path.join(root, 'project.mioon');
  createProjectFile(projectFile, {projectId, targetFormat: FORMAT6_PROJECT_SCHEMA_VERSION});
  const store = openServerTestStore({projectFile, allowFormat6: true, locate: () => ({
    localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'temp'),
  })}, path.join(root, 'app'));
  try {
    const at = '2026-01-01T00:00:00.000Z';
    const timelineId = randomUUID(), trackId = randomUUID(), sequenceNodeId = randomUUID();
    store.tx(() => {
      store.put('projects', {id: projectId, name: 'Processing approvals', createdAt: at, updatedAt: at, revision: 1});
      store.put('nodes', {id: sequenceNodeId, projectId, type: 'sequence_root', name: 'Film', position: {x: 0, y: 0}, createdAt: at});
      store.put('timelines', {id: timelineId, projectId, revision: 1, width: 720, height: 1280, fps: 30, durationFrames: 0,
        createdAt: at, updatedAt: at, mainTrack: {trackId, sequenceNodeId},
        tracks: [{id: trackId, name: 'V1', kind: 'video', orderIndex: 0, hidden: false, muted: false}], clips: []});
      store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
        .run(timelineId, projectId, sequenceNodeId, 1, JSON.stringify({version: 1, board: [], track: []}));
      store.db.prepare(
        `INSERT INTO main.timeline_processing_tasks(id,projectId,demandKey,kind,state,revision,requestId,input,errorCode,updatedAt)
        VALUES(?,?,?,'reverse','failed',1,?,'{}','PROCESSING_FAILED',?)`
      ).run(taskId, projectId, 'a'.repeat(64), randomUUID(), at);
    });
    const local = createServices(store, new Map());
    const effects: unknown[] = [];
    let lostResponse: 'applied' | 'not_applied' | undefined;
    // Exercise the real Mio approval/runtime around a synthetic processing
    // port. Transport parity and the real processor run independently.
    const services: OrdinaryServices = {
      ...local, timelineProcessingEnabled: true,
      async call(operation, input, context) {
        if (!isTimelineProcessingOperation(operation)) return local.call(operation, input, context);
        assert.equal(operation, 'timeline.processing.retry');
        assert.equal(typeof context?.beforeEffect, 'function');
        if (typeof context?.beforeEffect === 'function') context.beforeEffect();
        const retry = timelineProcessingSchemas['timeline.processing.retry'].parse(input);
        if (lostResponse !== 'not_applied') effects.push(retry);
        if (lostResponse === 'applied') {
          store.db.prepare('INSERT INTO main.timeline_processing_retries(requestId,taskId) VALUES(?,?)').run(retry.requestId, retry.taskId);
        }
        if (lostResponse) throw Object.assign(new Error('Synthetic loss of retry response'), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
        return {taskId};
      },
    };
    const settings = await createTestAgentSettings({persistence: {load: async () => null, save: async () => {}}});
    const journal = createMioJournal(store, mioTestPolicy);
    const tools = createAgentTaskTools({store, services, journal});
    const authorizations = createTestAuthorizations(store, settings);
    let rounds: AgentTaskToolCall[][] = [];
    const gateway: TaskGateway = async function* (request) {
      request.beforeSubmit?.();
      const toolCalls = rounds.shift() ?? [];
      const text = toolCalls.length ? '' : '合成测试结束。';
      yield {type: 'done', output: {text, toolCalls, providerOutput: {role: 'assistant', content: text || null,
        ...(toolCalls.length ? {tool_calls: toolCalls.map(call => ({id: call.id, type: 'function',
          function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})}}};
    };
    const runtime = createMioRuntime({store, journal, policy: mioTestPolicy, tools, agentSettings: settings,
      authorizations, gateway, selfPort: () => 4318});
    try {
      const operation = 'timeline.processing.retry';
      const toolName = 'mioon_timeline_processing_retry';
      assert.throws(() => tools.prepare({projectId: randomUUID(), operation, input: {taskId}}), {code: 'AGENT_TASK_TOOL_FORBIDDEN'});
      assert.throws(() => tools.prepare({projectId, operation, input: {projectId, taskId}}), {code: 'AGENT_TASK_INVALID_TOOL'});
      assert.throws(() => tools.prepare({projectId, operation, input: {taskId, requestId: randomUUID()}}), {code: 'AGENT_TASK_INVALID_TOOL'});
      await putTestAgentConfiguration(settings, {expectedRevision: 0,
        configuration: defaultTestAgentConfiguration('chat_completions'),
        secret: {action: 'replace', storage: 'persistent', value: 'SYNTHETIC_MIO_PROCESSING'}});
      await authorizeTestScope(authorizations, 'project_agent');
      for (const decision of ['deny', 'stale', 'approve', 'lost_applied', 'lost_not_applied'] as const) {
        lostResponse = decision === 'lost_applied' ? 'applied' : decision === 'lost_not_applied' ? 'not_applied' : undefined;
        const initialEffects = [...effects];
        rounds = [[{id: 'load_processing', name: 'mioon_tools_load', arguments: {names: [toolName]}}],
          [{id: 'retry_processing', name: toolName, arguments: {taskId}}]];
        const sent = await runtime.send(projectId, {requestId: randomUUID(), text: '重试一个处理任务',
          locale: 'zh-Hans', expectedSettingsRevision: testAgentExecution(await settings.get()).revision});
        await runtime.drain();
        const waiting = runtime.get(projectId, sent.run.id);
        assert.equal(waiting.run.status, 'awaiting_approval');
        const step = waiting.steps.find(item => item.toolCall?.id === 'retry_processing');
        assert.ok(step);
        assert.equal(step.tier, 'local_irreversible');
        assert.deepEqual(effects, initialEffects);
        if (decision === 'stale') {
          const before = readFormat5TimelineRecord(store.db, 'project');
          assert.ok(before);
          assert.equal(before.id, timelineId);
          store.put('timelines', {...before, revision: before.revision + 1});
        }
        const control = {action: decision === 'deny' ? 'deny' : 'approve', stepId: step.id,
          requestId: randomUUID(), expectedRevision: waiting.run.revision};
        await runtime.action(projectId, sent.run.id, control);
        await runtime.drain();
        const done = runtime.get(projectId, sent.run.id);
        const finished = done.steps.find(item => item.id === step.id);
        assert.ok(finished);
        assert.deepEqual(done.changes, []);
        if (decision === 'deny' || decision === 'stale') {
          assert.equal(finished.status, 'rejected');
          if (decision === 'stale') assert.equal(finished.error?.code, 'TARGET_CHANGED');
          assert.deepEqual(effects, initialEffects);
          continue;
        }
        const appliedEffects = [...initialEffects, {projectId, taskId, requestId: step.id}];
        if (lostResponse) {
          assert.equal(finished.status, 'unknown');
          assert.deepEqual(effects, lostResponse === 'applied' ? appliedEffects : initialEffects);
          const resolution = lostResponse === 'applied' ? 'accept_result' : 'discard';
          await assert.rejects(runtime.action(projectId, sent.run.id, {
            action: 'resolve_unknown', resolution: resolution === 'accept_result' ? 'discard' : 'accept_result',
            stepId: step.id, requestId: randomUUID(), expectedRevision: done.run.revision,
          }), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
          const resolved = await runtime.action(projectId, sent.run.id, {
            action: 'resolve_unknown', resolution, stepId: step.id, requestId: randomUUID(),
            expectedRevision: runtime.get(projectId, sent.run.id).run.revision,
          });
          const recovered = resolved.steps.find(item => item.id === step.id);
          assert.ok(recovered);
          if (lostResponse === 'applied') {
            assert.equal(recovered.status, 'completed');
            assert.deepEqual(recovered.result, {taskId});
          } else {
            assert.equal(recovered.status, 'failed');
            assert.match(JSON.stringify(recovered.result), /UNKNOWN_NOT_APPLIED/u);
          }
          assert.deepEqual(effects, lostResponse === 'applied' ? appliedEffects : initialEffects);
          await runtime.action(projectId, sent.run.id, {action: 'stop', requestId: randomUUID(),
            expectedRevision: runtime.get(projectId, sent.run.id).run.revision});
          continue;
        }
        assert.equal(finished.status, 'completed');
        assert.deepEqual(finished.result, {taskId});
        assert.deepEqual(effects, appliedEffects);
        assert.deepEqual(await runtime.action(projectId, sent.run.id, control), done);
        assert.deepEqual(effects, appliedEffects);
      }
    } finally {
      runtime.close();
      await runtime.drain();
      tools.dispose();
      await local.drain();
      await settings.close();
    }
  } finally {
    store.close();
  }
});
