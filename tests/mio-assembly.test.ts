import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {assembleRequest, createMioAssembly} from '../packages/business/src/agent/mio-assembly.ts';
import {buildTaskModelRequest, taskContinuation, taskResponseLanguageContext} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {TaskModelOutput, TaskToolDefinition} from '../packages/business/src/agent/task-gateway-v2.ts';
import type {AgentConfiguration} from '../packages/business/src/agent/config.ts';
import {AGENT_PRESETS} from '../packages/business/src/agent/presets.ts';
import type {AgentTaskJson, AgentTaskLocale} from '../packages/contracts/src/agent-tasks-v2.ts';

const at = '2026-11-02T08:00:00.000Z';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const protocols = ['chat_completions', 'responses', 'anthropic_messages'] as const;
const text = '保留用户原始文本 \\ " \r\n🙂 '.repeat(10);
const argumentsJson = '{ "value": "保留\\ud800\\\\原参数", "space":  1 }';
const tools: TaskToolDefinition[] = [{name: 'mioon_project_inspect', description: 'Frozen catalog before future edits.', parameters: {type: 'object', properties: {}, additionalProperties: false}}];
const code = (expected: string) => (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === expected;
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
function setup(t: TestContext, protocol: typeof protocols[number] = 'chat_completions', locale: AgentTaskLocale = 'zh-Hans', official = false) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-r1-assembly-'));
  let store = openStore(root), records = createMioRecords(store);
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  store.put('projects', {id: store.projectId, name: 'Mio assembly synthetic project'});
  const conversationId = randomUUID(), runId = randomUUID();
  const platform = AGENT_PRESETS.find(preset => preset.id === 'anthropic')!.platforms.find(platform => platform.id === 'global')!;
  const configuration: AgentConfiguration = official ? {presetId: 'anthropic', platformId: platform.id, protocol, model: platform.model, baseUrl: platform.baseUrl}
    : {presetId: 'ollama', platformId: 'local', protocol, model: 'qwen3:8b', baseUrl: `http://127.0.0.1:11434${protocol === 'anthropic_messages' ? '' : '/v1'}`};
  const context: AgentTaskJson[] = [taskResponseLanguageContext(locale), {role: 'user', content: text}];
  store.tx(() => {
    const configurationBlobHash = records.putBlob(JSON.stringify(configuration), at);
    records.createConversation({id: conversationId, createdAt: at, updatedAt: at});
    records.createRun({id: runId, conversationId, requestId: randomUUID(), digest: sha('synthetic request'), stepLimit: 30, budget: 30, locale, configurationBlobHash, settingsRevision: 1, rulesSnapshotHash: null, createdAt: at, updatedAt: at});
    records.appendEntry({id: randomUUID(), runId, kind: 'user_message', createdAt: at, payload: {json: {text}}});
    records.appendEntry({id: randomUUID(), runId, kind: 'host_hint', createdAt: at, payload: {json: {type: 'run_context', context}}});
  });
  function begin(history = context, version: 1 | 2 = 2, data: AgentTaskJson = {baseline: []}) {
    const assembly = createMioAssembly(records, {now: () => at, assemblerVersion: version}), stepId = randomUUID();
    const body = buildTaskModelRequest(configuration, history, tools, 9080, {toolLoading: true});
    const saved = store.tx(() => {
      records.createStep({id: stepId, runId, kind: 'model', createdAt: at});
      const input = assembly.freeze(runId, stepId, {request: {body, history}, data}, []);
      return records.beginRequest(input);
    });
    return {saved, body, history, assembly};
  }
  function complete(id: string) {
    const providerOutput: AgentTaskJson = protocol === 'responses'
      ? [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Complete synthetic answer.'}]}]
      : protocol === 'anthropic_messages' ? {role: 'assistant', content: [{type: 'text', text: 'Complete synthetic answer.'}]} : {role: 'assistant', content: 'Complete synthetic answer.'};
    store.tx(() => { records.markDispatched(id, at); records.completeModelRequest(id, {entryId: randomUUID(), at, output: {protocol, providerOutput}}); });
  }
  return {
    root, runId, context, configuration, begin, complete,
    get store() { return store; }, get records() { return records; },
    reopen() { store.close(); store = openStore(root); records = createMioRecords(store); return createMioAssembly(records); },
  };
}

for (const protocol of protocols) for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) {
  test(`${protocol}/${locale}: successful raw cleanup reconstructs exact gateway bytes from frozen entries after reopen`, t => {
    const f = setup(t, protocol, locale), sent = f.begin();
    f.complete(sent.saved.id);
    assert.equal(f.records.request(sent.saved.id).originalBody, null);
    const assembly = f.reopen(), request = f.records.request(sent.saved.id);
    const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.deepEqual(assembly.hydrate(request), {body: sent.body, history: sent.history});
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
    const snapshot = frozen(assembly.collect(request.inputManifest)), serialized = JSON.stringify(snapshot);
    assert.deepEqual(assembleRequest(request.assemblerVersion, snapshot), assembleRequest(request.assemblerVersion, snapshot));
    assert.equal(assembleRequest(request.assemblerVersion, snapshot).body, sent.body);
    assert.equal(JSON.stringify(snapshot), serialized);
    // The long canonical user text is held by entries, not copied into each
    // request's input manifest or non-source blobs.
    assert.equal(JSON.stringify(request.inputManifest.parameters).includes(text), false);
    assert.ok(JSON.stringify(request.inputManifest.parameters).includes('"source"'));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mio_blobs WHERE content=?').get(sent.body)!.n, 0);
  });
}

test('pure assembly does not use clock or network and rejects missing/tampered sources and unsupported versions', t => {
  const f = setup(t), sent = f.begin(), snapshot = sent.assembly.collect(sent.saved.inputManifest);
  const before = JSON.stringify(snapshot);
  t.mock.method(Date, 'now', () => { throw new Error('Clock must not run'); });
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network must not run'); });
  assert.equal(assembleRequest(2, frozen(snapshot)).body, sent.body);
  assert.equal(JSON.stringify(snapshot), before);
  assert.throws(() => assembleRequest(99, snapshot), code('AGENT_TASK_STORAGE_CORRUPT'));
  const altered = structuredClone(snapshot); altered.entries[0]!.payload = 'forged';
  assert.throws(() => assembleRequest(2, altered), code('AGENT_TASK_STORAGE_CORRUPT'));
  assert.throws(() => assembleRequest(2, {...snapshot, entries: []}), code('AGENT_TASK_STORAGE_CORRUPT'));
  assert.throws(() => assembleRequest(2, {...snapshot, tools: []}), code('AGENT_TASK_STORAGE_CORRUPT'));
});

for (const protocol of protocols) test(`${protocol}: signed thinking and raw call strings are referenced from canonical provider output`, t => {
  const f = setup(t, protocol), first = f.begin(), entryId = randomUUID();
  const thinking = 'PRIVATE_SIGNED_THINKING_'.repeat(24), signature = 'PRIVATE_SIGNATURE_'.repeat(16);
  const call = {id: 'frozen_call', name: 'mioon_project_inspect', arguments: JSON.parse(argumentsJson) as AgentTaskJson};
  const providerOutput: AgentTaskJson = protocol === 'chat_completions'
    ? {role: 'assistant', content: 'Read the exact prior call.', reasoning_content: thinking, tool_calls: [{id: call.id, type: 'function', function: {name: call.name, arguments: argumentsJson}}]}
    : protocol === 'responses' ? [{type: 'reasoning', encrypted_content: signature, summary: []}, {type: 'function_call', call_id: call.id, name: call.name, arguments: argumentsJson, status: 'completed'}]
      : {role: 'assistant', content: [{type: 'thinking', thinking, signature}, {type: 'tool_use', id: call.id, name: call.name, input: call.arguments}]};
  f.store.tx(() => {
    f.records.markDispatched(first.saved.id, at);
    f.records.completeModelRequest(first.saved.id, {entryId, at, output: {protocol, providerOutput}});
  });
  const output: TaskModelOutput = {text: 'Read the exact prior call.', toolCalls: [call], providerOutput};
  const result: AgentTaskJson = {preserved: 'Original retained result '.repeat(16)};
  f.store.tx(() => f.records.appendEntry({id: randomUUID(), runId: f.runId, kind: 'tool_result', createdAt: at, payload: {json: result}}));
  const history = [...f.context, ...taskContinuation(protocol, output, [{callId: call.id, result}])], second = f.begin(history);
  f.complete(second.saved.id);
  const assembly = f.reopen(), saved = f.records.request(second.saved.id);
  assert.deepEqual(assembly.hydrate(saved), {body: second.body, history});
  const view = JSON.stringify(saved.inputManifest.parameters);
  assert.ok(view.includes(entryId));
  assert.equal(view.includes(thinking), false);
  assert.equal(view.includes(signature), false);
  assert.equal(view.includes(argumentsJson), false);
});

test('known undispatched v1 upgrades to v2 without later notes/configuration or an extra model step', t => {
  const f = setup(t), old = f.begin(f.context, 1), oldManifest = structuredClone(old.saved.inputManifest);
  f.store.tx(() => {
    f.records.appendEntry({id: randomUUID(), runId: f.runId, kind: 'note', createdAt: at, payload: {json: {requestId: 'later-note-request', text: 'This later note cannot enter the saved request.'}}});
    f.records.putBlob(JSON.stringify({...f.configuration, model: 'a-current-profile-change'}), at);
  });
  const assembly = createMioAssembly(f.records, {now: () => at}), input = assembly.upgrade(f.records.request(old.saved.id));
  assert.ok(input);
  const beforeSteps = f.records.run(f.runId).stepsUsed;
  const next = f.store.tx(() => f.records.reassembleRequest(old.saved.id, input, randomUUID()));
  assert.equal(next.previousRequestId, old.saved.id);
  assert.equal(next.assemblyNumber, 2); assert.equal(next.assemblerVersion, 2);
  assert.deepEqual(next.inputManifest, oldManifest);
  assert.equal(next.originalBody, old.body);
  assert.equal(f.records.run(f.runId).stepsUsed, beforeSteps);
  assert.equal(f.records.request(old.saved.id).state, 'superseded');
  assert.ok(f.records.entries(f.runId).some(entry => entry.kind === 'request_reassembled'));
  f.store.tx(() => f.records.markDispatched(next.id, at));
  assert.equal(assembly.upgrade(f.records.request(next.id)), undefined);
  assert.throws(() => createMioAssembly(f.records, {assemblerVersion: 1}).upgrade(f.records.request(next.id)), code('AGENT_TASK_STORAGE_CORRUPT'));
  assert.throws(() => assembly.upgrade({...old.saved, state: 'dispatch_started', dispatchStartedAt: at}), code('AGENT_TASK_STORAGE_CORRUPT'));
  assert.throws(() => assembly.upgrade({...old.saved, assemblerVersion: 99}), code('AGENT_TASK_STORAGE_CORRUPT'));
});

test('input manifests exclude unused outputs and unbound notes even when a note equals used text', t => {
  const f = setup(t), noteId = randomUUID(), unusedOutputId = randomUUID();
  f.store.tx(() => {
    f.records.appendEntry({id: noteId, runId: f.runId, kind: 'note', createdAt: at, payload: {json: {requestId: 'unbound-note-request', text}}});
    f.records.appendEntry({id: unusedOutputId, runId: f.runId, kind: 'model_output', createdAt: at, payload: {json: {protocol: 'chat_completions', providerOutput: {role: 'assistant', content: 'Unused provider output cannot enter this intent.'}}}});
  });
  const sent = f.begin();
  assert.equal(sent.saved.inputManifest.entryIds.includes(noteId), false);
  assert.equal(sent.saved.inputManifest.entryIds.includes(unusedOutputId), false);
  assert.deepEqual(sent.saved.inputManifest.noteEntryIds, []);
  assert.deepEqual(sent.assembly.hydrate(sent.saved), {body: sent.body, history: sent.history});
});

test('cross-run context and JSON-wrapped historical text reference canonical entries rather than duplicate transcripts', t => {
  const f = setup(t), first = f.begin(); f.complete(first.saved.id);
  f.store.tx(() => { const run = f.records.run(f.runId); f.records.updateRun(run.id, run.revision, {status: 'completed', budget: run.budget, updatedAt: at}); });
  const assembly = createMioAssembly(f.records, {now: () => at}), previous = f.records.run(f.runId), runId = randomUUID();
  const currentText = 'A genuinely separate new user action.';
  const context: AgentTaskJson[] = [taskResponseLanguageContext('zh-Hans'), {role: 'user', content: text}, {role: 'assistant', content: 'Complete synthetic answer.'},
    {role: 'user', content: `Frozen historical record:\n${JSON.stringify({text, finalText: 'Complete synthetic answer.', count: 1})}`}, {role: 'user', content: currentText}];
  let view: AgentTaskJson = null, requestId = '';
  const body = buildTaskModelRequest(f.configuration, context, tools, 9080, {toolLoading: true});
  f.store.tx(() => {
    f.records.createRun({id: runId, conversationId: previous.conversationId, requestId: randomUUID(), digest: sha('new action'), stepLimit: 30, budget: 30, locale: 'zh-Hans', configurationBlobHash: previous.configurationBlobHash, settingsRevision: 1, rulesSnapshotHash: null, createdAt: at, updatedAt: at});
    const user = f.records.appendEntry({id: randomUUID(), runId, kind: 'user_message', createdAt: at, payload: {json: {text: currentText}}});
    view = assembly.freezeContext(context, [...f.records.entries(f.runId).map(entry => entry.id), user.id]);
    f.records.appendEntry({id: randomUUID(), runId, kind: 'host_hint', createdAt: at, payload: {json: {type: 'run_context', contextView: view}}});
    const step = f.records.createStep({id: randomUUID(), runId, kind: 'model', createdAt: at});
    const input = assembly.freeze(runId, step.id, {request: {body, history: context}}, []);
    requestId = f.records.beginRequest(input).id;
  });
  assert.deepEqual(assembly.hydrateContext(view), context);
  assert.equal(JSON.stringify(view).includes(JSON.stringify(text).slice(1, -1)), false);
  const saved = f.records.request(requestId);
  assert.ok(saved.inputManifest.entryIds.some(id => f.records.entry(id).runId === f.runId));
  assert.equal(JSON.stringify(saved.inputManifest.parameters).includes(JSON.stringify(text).slice(1, -1)), false);
  f.complete(requestId);
  const reopened = f.reopen();
  assert.deepEqual(reopened.hydrate(f.records.request(requestId)), {body, history: context});
});

test('equal user messages and tool results retain each canonical action identity in history order', t => {
  const f = setup(t), assembly = createMioAssembly(f.records), firstUser = f.records.entries(f.runId).find(entry => entry.kind === 'user_message')!.id;
  const secondUser = randomUUID(), firstResult = randomUUID(), secondResult = randomUUID();
  const result: AgentTaskJson = {text: 'The same result bytes belong to two different calls.'};
  f.store.tx(() => {
    f.records.appendEntry({id: secondUser, runId: f.runId, kind: 'user_message', createdAt: at, payload: {json: {text}}});
    f.records.appendEntry({id: firstResult, runId: f.runId, kind: 'tool_result', createdAt: at, payload: {json: result}});
    f.records.appendEntry({id: secondResult, runId: f.runId, kind: 'tool_result', createdAt: at, payload: {json: result}});
  });
  const history: AgentTaskJson[] = [taskResponseLanguageContext('zh-Hans'), {role: 'user', content: text}, {role: 'user', content: text},
    {role: 'tool', tool_call_id: 'first_distinct_call', content: JSON.stringify(result)}, {role: 'tool', tool_call_id: 'second_distinct_call', content: JSON.stringify(result)}];
  const contextView = assembly.freezeContext(history, f.records.entries(f.runId).map(entry => entry.id));
  assert.deepEqual(assembly.hydrateContext(contextView), history);
  const sent = f.begin(history), view = sent.saved.inputManifest.parameters as {history: unknown};
  const serialized = JSON.stringify(view.history);
  for (const id of [firstUser, secondUser, firstResult, secondResult]) assert.ok(serialized.includes(id), `Missing canonical action ${id}`);
  assert.ok(serialized.indexOf(firstUser) < serialized.indexOf(secondUser));
  assert.ok(serialized.indexOf(firstResult) < serialized.indexOf(secondResult));
  assert.deepEqual(sent.assembly.hydrate(sent.saved), {body: sent.body, history});
});

test('a clipped escaped tool view references a frozen canonical slice instead of copying the clipped transcript', t => {
  const f = setup(t), resultId = randomUUID(), rawText = '長い返答 "\\\r\n🙂'.repeat(1600);
  const result: AgentTaskJson = {text: rawText}, clipped: AgentTaskJson = {text: rawText.slice(0, 1200), truncated: true};
  f.store.tx(() => f.records.appendEntry({id: resultId, runId: f.runId, kind: 'tool_result', createdAt: at, payload: {json: result}}));
  const history: AgentTaskJson[] = [...f.context, {role: 'tool', tool_call_id: 'clipped_call', content: JSON.stringify(clipped)}];
  const sent = f.begin(history), parameters = JSON.stringify(sent.saved.inputManifest.parameters);
  assert.ok(parameters.includes(resultId)); assert.ok(parameters.includes('"slice"'));
  assert.equal(parameters.includes(JSON.stringify(rawText.slice(0, 1200)).slice(1, -1)), false);
  f.complete(sent.saved.id);
  const reopened = f.reopen();
  assert.deepEqual(reopened.hydrate(f.records.request(sent.saved.id)), {body: sent.body, history});
  const altered = reopened.collect(f.records.request(sent.saved.id).inputManifest);
  const view = altered.manifest.parameters as {history: {array: {object: [string, {concat?: {slice?: number[]}[]}][]}[]}};
  const reference = view.history.array.at(-1)!.object.find(([key]) => key === 'content')![1].concat!.find(node => node.slice);
  assert.ok(reference); reference.slice = [0, Number.MAX_SAFE_INTEGER];
  assert.throws(() => assembleRequest(2, altered), code('AGENT_TASK_STORAGE_CORRUPT'));
});

for (const reused of [false, true]) test(`Messages cache wrapping retains exact output/result identity across equal text/args (${reused ? 'reused' : 'distinct'} call IDs)`, t => {
  const f = setup(t, 'anthropic_messages', 'en', true), first = f.begin();
  const result: AgentTaskJson = {value: 'Two different calls have exactly equal result bytes.'};
  function finish(requestId: string, callId: string) {
    const outputId = randomUUID(), resultId = randomUUID();
    const argumentsValue: AgentTaskJson = {echo: {type: 'tool_use', id: 'a_business_data_field', input: {}}};
    const output: TaskModelOutput = {text: 'Same assistant text for both different model turns.', toolCalls: [{id: callId, name: 'mioon_project_inspect', arguments: argumentsValue}],
      providerOutput: {role: 'assistant', content: [{type: 'text', text: 'Same assistant text for both different model turns.'}, {type: 'tool_use', id: callId, name: 'mioon_project_inspect', input: argumentsValue}]}};
    f.store.tx(() => {
      f.records.markDispatched(requestId, at);
      f.records.completeModelRequest(requestId, {entryId: outputId, at, output: {protocol: 'anthropic_messages', providerOutput: output.providerOutput}});
      const step = f.records.createStep({id: randomUUID(), runId: f.runId, kind: 'tool', sourceEntryId: outputId, sourceCallIndex: 0, createdAt: at});
      f.records.updateStep(step.id, 'intent', {status: 'dispatch_started', updatedAt: at});
      f.records.appendEntry({id: resultId, runId: f.runId, kind: 'tool_result', createdAt: at, payload: {json: result}});
      f.records.updateStep(step.id, 'dispatch_started', {status: 'completed', resultEntryId: resultId, updatedAt: at});
    });
    return {outputId, resultId, continuation: taskContinuation('anthropic_messages', output, [{callId, result}])};
  }
  const a = finish(first.saved.id, 'first_or_reused_call');
  const second = f.begin([...f.context, ...a.continuation], 2, {assemblyModelStepIds: [first.saved.stepId]});
  const b = finish(second.saved.id, reused ? 'first_or_reused_call' : 'second_distinct_call');
  function refs(value: unknown, ids = new Set<string>()): Set<string> {
    if (value && typeof value === 'object') {
      if ('source' in value && typeof value.source === 'string') ids.add(value.source);
      Object.values(value).forEach(child => refs(child, ids));
    }
    return ids;
  }
  const data: AgentTaskJson = {assemblyModelStepIds: [first.saved.stepId, second.saved.stepId]};
  // Messages requires a final user message and unique call IDs in the retained
  // wire history. A reused ID is legal here only after the earlier group was
  // compacted out; its canonical source must still be the later model step.
  const histories = reused ? [[...f.context, ...b.continuation]] : [[...f.context, ...a.continuation, ...b.continuation], [...f.context, ...b.continuation]];
  for (const history of histories) {
    const sent = f.begin(history, 2, data), body = JSON.parse(sent.body) as {messages: {content: {cache_control?: unknown}[]}[]};
    assert.ok(body.messages.at(-1)!.content.some(block => block.cache_control));
    const descriptor = sent.saved.inputManifest.parameters as {wireHistory: {array: unknown[]}};
    const last = refs(descriptor.wireHistory.array.at(-1));
    assert.ok(last.has(b.resultId));
    assert.equal(last.has(a.outputId), false); assert.equal(last.has(a.resultId), false);
    const lastModel = refs(descriptor.wireHistory.array.at(-2));
    assert.ok(lastModel.has(b.outputId)); assert.equal(lastModel.has(a.outputId), false);
    assert.deepEqual(sent.assembly.hydrate(sent.saved), {body: sent.body, history});
  }
  const wrongModel = f.records.steps(f.runId).find(step => step.kind === 'tool')!;
  assert.throws(() => f.begin(f.context, 2, {assemblyModelStepIds: [wrongModel.id]}), code('AGENT_TASK_STORAGE_CORRUPT'));
  assert.throws(() => f.begin([...f.context, ...b.continuation], 2, {assemblyModelStepIds: []}), code('AGENT_TASK_STORAGE_CORRUPT'));
});
