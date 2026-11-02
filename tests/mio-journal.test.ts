import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createMioAssembly} from '../packages/business/src/agent/mio-assembly.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {openStore as openWorkspaceStore} from '../packages/business/src/db.ts';
import {assembleRunContext} from '../packages/business/src/agent/task-context-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson, AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';

function fixture(t: TestContext, stepLimit = 30) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-mio-journal-'));
  let store = openStore(root), policy = {...structuredClone(DEFAULT_AGENT_TASK_POLICY), stepLimit};
  store.put('projects', {id: store.projectId, name: 'Mio journal synthetic project'});
  const options = {policy: () => structuredClone(policy), updatePolicy: (next: typeof policy) => {policy = {...next, revision: policy.revision + 1}; return structuredClone(policy);}, lookupPolicy: () => null};
  let journal = createMioJournal(store, options);
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  return {root, get store() {return store;}, get journal() {return journal;}, get records() {return createMioRecords(store);},
    reopen() {store.close(); store = openStore(root); journal = createMioJournal(store, options);},
    start(input: {conversationId?: string; text?: string; context?: AgentTaskJson[]} = {}) {
      return journal.create({requestId: randomUUID(), projectId: store.projectId, text: input.text ?? '原消息 😀 \\ \ud800', configuration: {protocol: 'chat_completions', model: 'synthetic'}, ...input}).run;
    },
  };
}
function model(f: ReturnType<typeof fixture>, runId: string, calls: AgentTaskToolCall[] = []) {
  const value = f.journal.run(runId), history: AgentTaskJson[] = [{role: 'user', content: value.text}];
  const body = JSON.stringify({model: 'synthetic', stream: true, messages: history});
  const step = f.journal.beginModelStep(runId, {request: {body, history}, data: {baseline: []}}, (value.notes ?? []).filter(note => !note.modelStepId).map(note => note.requestId));
  const complete = () => {
    f.journal.markDispatch(runId, step.id);
    f.journal.appendText(runId, step.id, '响应');
    f.journal.completeStep(runId, step.id, {result: {text: '响应', toolCalls: calls as unknown as AgentTaskJson[], providerOutput: {role: 'assistant', content: '响应', ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})}, usage: {inputTokens: 12, outputTokens: 2}}});
  };
  return {step, body, complete};
}

test('Mio journal projects canonical entries after cleanup and every read is write-free', t => {
  const f = fixture(t), run = f.start(), request = model(f, run.id);
  request.complete();
  const row = f.records.step(request.step.id), saved = f.records.request(row.currentRequestId!);
  assert.equal(saved.originalBody, null); assert.equal(row.partialText, null);
  assert.ok(row.resultEntryId); assert.equal(f.records.entry(row.resultEntryId).kind, 'model_output');
  assert.equal(f.journal.step(row.id).text, '响应');
  assert.deepEqual(f.journal.step(row.id).result, {text: '响应', toolCalls: [], providerOutput: {role: 'assistant', content: '响应'}, usage: {inputTokens: 12, outputTokens: 2}});
  assert.equal((f.journal.step(row.id).request as {body: string}).body, request.body);
  f.journal.transition(run.id, f.journal.run(run.id).revision, 'completed');
  f.reopen();
  const before = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
  createMioJournal(f.store, {policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY)});
  f.journal.snapshot(run.id); f.journal.run(run.id); f.journal.step(row.id); f.journal.history(f.store.projectId);
  f.journal.conversation(f.store.projectId, run.conversationId!); f.journal.modelContextRuns(f.store.projectId, run.conversationId!);
  const events = f.journal.events(run.id); assert.ok(events.length); assert.ok(events.every(event => event.type === 'invalidate' && event.data === null));
  assert.equal(f.journal.eventSequence(run.id), events.at(-1)!.sequence);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get()!.count, before);
  assert.deepEqual(f.store.db.prepare('PRAGMA main.table_info(mio_events)').all().map(row => row.name), ['runId', 'sequence', 'createdAt']);
});

test('notes bind once at intent, later notes do not rewrite request and replayed controls stay idempotent', t => {
  const f = fixture(t), run = f.start(), noteId = randomUUID();
  f.store.tx(() => f.journal.appendNoteInside(run.id, noteId, '说明一 \ud800'));
  const first = model(f, run.id), before = f.journal.step(first.step.id).request;
  f.store.tx(() => f.journal.appendNoteInside(run.id, randomUUID(), '之后的说明'));
  assert.equal(f.journal.run(run.id).notes?.[0]?.modelStepId, first.step.id);
  assert.equal(f.journal.run(run.id).notes?.[1]?.modelStepId, undefined);
  assert.deepEqual(f.journal.step(first.step.id).request, before);
  assert.throws(() => f.journal.updateStep(run.id, first.step.id, {request: {body: 'changed'}}), {code: 'AGENT_TASK_REQUEST_IMMUTABLE'});
  const input = {requestId: randomUUID(), runId: run.id, expectedRevision: f.journal.run(run.id).revision, action: 'pause'}; let performed = 0;
  const receipt = f.journal.performControl(input, () => {performed++; return {status: f.journal.transition(run.id, input.expectedRevision, 'paused').status};});
  assert.deepEqual(f.journal.performControl(input, () => {performed++; return null;}), receipt); assert.equal(performed, 1);
  assert.throws(() => f.journal.performControl({...input, action: 'stop'}, () => null), {code: 'AGENT_TASK_REQUEST_CONFLICT'});
  f.reopen(); assert.deepEqual(f.journal.lookupControl(input.requestId), receipt);
});

test('tool calls derive from their canonical model, approval spends no extra budget and wait remains free', t => {
  const f = fixture(t, 2), run = f.start(), call = {id: 'call-one', name: 'mioon_project_get', arguments: {text: '\ud800'}};
  const response = model(f, run.id, [call]); response.complete();
  const tool = f.journal.beginStep(run.id, {kind: 'tool', toolCall: call, data: {sourceModelStepId: response.step.id}});
  assert.deepEqual(f.journal.step(tool.id).toolCall, call);
  assert.throws(() => f.journal.beginStep(run.id, {kind: 'tool', toolCall: call, data: {sourceModelStepId: response.step.id}}), {code: 'AGENT_TASK_BUDGET_EXHAUSTED'});
  assert.equal(f.records.step(tool.id).sourceEntryId, f.records.step(response.step.id).resultEntryId);
  assert.equal(JSON.stringify(f.records.step(tool.id).data).includes('arguments'), false);
  f.journal.updateStep(run.id, tool.id, {status: 'awaiting_approval'});
  f.journal.transition(run.id, f.journal.run(run.id).revision, 'awaiting_approval');
  f.journal.updateStep(run.id, tool.id, {status: 'intent'}); f.journal.resume(run.id, f.journal.run(run.id).revision);
  f.journal.markDispatch(run.id, tool.id); f.journal.completeStep(run.id, tool.id, {result: {ok: true}});
  const wait = f.journal.beginStep(run.id, {kind: 'wait'}); f.journal.completeStep(run.id, wait.id, {result: null});
  assert.deepEqual(f.journal.snapshot(run.id).steps.map(step => step.position), [1, 2, 3]);
  assert.equal(f.journal.run(run.id).stepsUsed, 2);
  assert.throws(() => model(f, run.id), {code: 'AGENT_TASK_BUDGET_EXHAUSTED'});
  f.journal.transition(run.id, f.journal.run(run.id).revision, 'paused', 'budget');
  const continued = f.journal.resume(run.id, f.journal.run(run.id).revision, {extendBudget: true}); assert.equal(continued.budget, 4);
  const next = model(f, run.id); assert.equal(next.step.position, 4); assert.equal(f.journal.step(tool.id).status, 'completed');
});

test('unknown model requests retain bytes and fence continuation through restart until explicit discard', t => {
  const f = fixture(t), run = f.start(), pending = model(f, run.id);
  f.journal.markDispatch(run.id, pending.step.id); f.journal.appendText(run.id, pending.step.id, 'partial \ud800');
  f.reopen(); assert.equal(f.journal.recover(), 1);
  assert.equal(f.journal.step(pending.step.id).status, 'unknown'); assert.equal(f.journal.step(pending.step.id).text, 'partial \ud800');
  assert.equal(f.records.request(f.records.step(pending.step.id).currentRequestId!).originalBody, pending.body);
  const before = f.journal.snapshot(run.id);
  assert.throws(() => f.journal.resume(run.id, before.run.revision, {extendBudget: true}), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  assert.deepEqual(f.journal.snapshot(run.id), before);
  f.journal.updateStep(run.id, pending.step.id, {status: 'failed', result: {discarded: true}});
  assert.deepEqual(f.journal.step(pending.step.id).result, {discarded: true});
  f.journal.resume(run.id, f.journal.run(run.id).revision); assert.equal(f.journal.run(run.id).status, 'running');
});

test('only an explicit unsent preparation upgrades the assembler and keeps the frozen note range', t => {
  const f = fixture(t), run = f.start(), records = f.records;
  const legacy = createMioJournal(f.store, {policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY), assembly: createMioAssembly(records, {assemblerVersion: 1})});
  const noteId = randomUUID(); f.store.tx(() => legacy.appendNoteInside(run.id, noteId, 'frozen before intent'));
  const history = [{role: 'user', content: run.text}], body = JSON.stringify({model: 'synthetic', messages: history});
  const step = legacy.beginModelStep(run.id, {request: {body, history}, data: {baseline: []}}, [noteId]);
  const old = records.request(records.step(step.id).currentRequestId!);
  f.store.tx(() => f.journal.appendNoteInside(run.id, randomUUID(), 'later note outside frozen input'));
  const before = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
  f.journal.step(step.id); f.journal.snapshot(run.id); assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get()!.count, before);
  assert.ok(f.journal.prepareModelStep); f.journal.prepareModelStep(run.id, step.id);
  const updated = records.request(records.step(step.id).currentRequestId!);
  assert.equal(updated.assemblerVersion, 2); assert.equal(updated.assemblyNumber, 2); assert.equal(updated.previousRequestId, old.id);
  assert.deepEqual(updated.inputManifest, old.inputManifest); assert.equal(updated.originalBody, body); assert.equal(updated.dispatchStartedAt, null);
  assert.equal(records.request(old.id).state, 'superseded'); assert.equal(records.entries(run.id).filter(entry => entry.kind === 'request_reassembled').length, 1);
  assert.equal(f.journal.run(run.id).stepsUsed, 1); assert.equal(f.journal.run(run.id).notes?.at(-1)?.modelStepId, undefined);
  f.journal.prepareModelStep(run.id, step.id); assert.equal(records.request(records.step(step.id).currentRequestId!).id, updated.id);
});

test('prevented model dispatch preserves immutable boundary evidence and never permits request reassembly', t => {
  const f = fixture(t), run = f.start(), pending = model(f, run.id);
  f.journal.markDispatch(run.id, pending.step.id);
  const id = f.records.step(pending.step.id).currentRequestId!, dispatched = f.records.request(id);
  f.journal.dispatchPrevented(run.id, pending.step.id, 'awaiting_approval');
  f.journal.updateStep(run.id, pending.step.id, {status: 'intent'});
  assert.equal(f.records.request(id).dispatchStartedAt, dispatched.dispatchStartedAt); assert.equal(f.records.request(id).state, 'dispatch_started');
  assert.throws(() => f.records.reassembleRequest(id, {...dispatched, body: pending.body, inputManifest: dispatched.inputManifest, stepId: pending.step.id, assemblerVersion: 3, id: randomUUID(), assembledAt: new Date().toISOString()}, randomUUID()), {code: 'AGENT_TASK_TRANSACTION_REQUIRED'});
  f.store.tx(() => assert.throws(() => f.records.reassembleRequest(id, {...dispatched, body: pending.body, inputManifest: dispatched.inputManifest, stepId: pending.step.id, assemblerVersion: 3, id: randomUUID(), assembledAt: new Date().toISOString()}, randomUUID()), {code: 'AGENT_TASK_STATE_CONFLICT'}));
  f.journal.markDispatch(run.id, pending.step.id); assert.equal(f.records.request(id).dispatchStartedAt, dispatched.dispatchStartedAt);
});

test('edit owners retain generation/sequence fencing, uncertain claims and original receipts', t => {
  const f = fixture(t), projectId = f.store.projectId, ownerId = randomUUID(), target = {kind: 'project', id: projectId, revision: f.journal.targetRevision(projectId, 'project', projectId)};
  const input = {requestId: randomUUID(), projectId, ownerId, generation: 1, sequence: 1, action: 'claim' as const, targets: [target]};
  const original = f.journal.edit(input); assert.equal(original.claims.length, 1);
  assert.throws(() => f.journal.assertTargets(projectId, [target]), {code: 'AGENT_TASK_TARGET_CLAIMED'});
  assert.deepEqual(f.journal.edit(input), original);
  assert.throws(() => f.journal.edit({...input, requestId: randomUUID()}), {code: 'AGENT_TASK_EDIT_OWNER_STALE'});
  f.reopen(); f.journal.recover(); assert.equal(f.journal.claims(projectId, ownerId)[0]?.state, 'uncertain');
  assert.throws(() => f.journal.edit({...input, requestId: randomUUID(), sequence: 2}), {code: 'AGENT_TASK_EDIT_OWNER_UNCERTAIN'});
  const restored = f.journal.edit({...input, requestId: randomUUID(), generation: 2, sequence: 1, action: 'restore'}); assert.equal(restored.claims[0]?.state, 'active');
  f.journal.edit({...input, requestId: randomUUID(), generation: 2, sequence: 2, action: 'release'}); assert.equal(f.journal.claims(projectId).length, 0);
  assert.deepEqual(f.journal.lookupEdit(input.requestId), original);
});

test('completed run undo and pending control recovery preserve terminal time after clock rollback', t => {
  const beginning = Date.parse('2026-11-02T00:00:00Z'); t.mock.timers.enable({apis: ['Date'], now: beginning});
  const f = fixture(t), run = f.start(), call = {id: 'change-call', name: 'mioon_shot_update', arguments: {}};
  const response = model(f, run.id, [call]); response.complete();
  const tool = f.journal.beginStep(run.id, {kind: 'tool', toolCall: call, data: {sourceModelStepId: response.step.id}}); f.journal.markDispatch(run.id, tool.id);
  f.journal.completeStep(run.id, tool.id, {change: {projectId: f.store.projectId, operation: 'shot.update', targets: [], before: null, after: null, reversible: true}});
  t.mock.timers.setTime(beginning + 10000); f.journal.updateStep(run.id, tool.id, {cost: 'charged'});
  t.mock.timers.setTime(beginning + 2000); const terminal = f.journal.transition(run.id, f.journal.run(run.id).revision, 'completed');
  assert.equal(terminal.updatedAt, new Date(beginning + 10000).toISOString()); assert.equal(f.journal.snapshot(run.id).executionEndedAt, terminal.updatedAt);
  const change = f.journal.snapshot(run.id).changes[0]!;
  t.mock.timers.setTime(beginning + 20000); f.store.tx(() => f.journal.markChangeRevertedInside(change.id));
  assert.equal(f.journal.snapshot(run.id).executionEndedAt, terminal.updatedAt);
  const requestId = randomUUID(); f.journal.beginControl({requestId, runId: run.id, expectedRevision: f.journal.run(run.id).revision, action: 'undo_all'});
  f.reopen(); assert.equal(f.journal.recover(), 0);
  assert.deepEqual((f.journal.lookupControl(requestId)?.result as {revertedIds: string[]}).revertedIds, [change.id]);
  assert.equal(f.journal.run(run.id).status, 'completed'); assert.equal(f.journal.snapshot(run.id).executionEndedAt, terminal.updatedAt);
});

test('history and continuation contexts reference existing entries and preserve notes and answers', t => {
  const f = fixture(t), oldText = 'a unique prior user message long enough to be referenced', first = f.start({text: oldText}), note = randomUUID();
  f.store.tx(() => f.journal.appendNoteInside(first.id, note, 'previous note'));
  const ask = {id: 'ask-id', name: 'mioon_ask', arguments: {question: 'Pick?', options: [{label: 'Yes'}, {label: 'No'}]}};
  const response = model(f, first.id, [ask]); response.complete();
  const tool = f.journal.beginStep(first.id, {kind: 'tool', toolCall: ask, data: {sourceModelStepId: response.step.id}});
  f.journal.updateStep(first.id, tool.id, {status: 'awaiting_answer'}); f.journal.updateStep(first.id, tool.id, {status: 'completed', result: {answer: {choices: [0]}}});
  f.journal.transition(first.id, f.journal.run(first.id).revision, 'completed');
  const context: AgentTaskJson[] = [{role: 'user', content: oldText}], second = f.start({conversationId: first.conversationId!, context});
  assert.deepEqual(f.journal.run(second.id).context, context);
  const hint = f.records.entries(second.id).find(item => item.kind === 'host_hint')!; assert.equal(JSON.stringify(f.records.payload(hint)).includes(oldText), false);
  assert.equal(f.journal.requestConversationId(first.id), undefined); assert.equal(f.journal.requestConversationId(second.id), first.conversationId);
  const page = f.journal.conversation(f.store.projectId, first.conversationId!, {limit: 1}); assert.equal(page.runs[0]?.id, first.id); assert.ok(page.nextCursor);
  assert.equal(f.journal.conversation(f.store.projectId, first.conversationId!, {limit: 1, cursor: page.nextCursor}).runs[0]?.id, second.id);
  const history = f.journal.modelContextRuns(f.store.projectId, first.conversationId!)[0]!;
  assert.deepEqual(history.historyInputs, [{kind: 'note', text: 'previous note'}, {kind: 'answer', question: 'Pick?', selected: ['Yes']}]);
  assert.equal(f.journal.history(f.store.projectId).conversations[0]?.runCount, 2);
  f.reopen(); assert.deepEqual(f.journal.run(second.id).context, context);
});

test('conversation policy confirms paid direct, revisions and exact request replay', t => {
  const f = fixture(t), run = f.start(), id = f.store.projectId;
  const before = f.journal.conversationPolicy(id, run.conversationId!), modes = {...before.effective, paid: 'direct' as const};
  const input = {requestId: randomUUID(), expectedRevision: before.revision, modes};
  assert.throws(() => f.journal.setConversationPolicy(id, run.conversationId!, input), {code: 'AGENT_TASK_APPROVAL_REQUIRED'});
  const result = f.journal.setConversationPolicy(id, run.conversationId!, {...input, acknowledgePaid: true});
  assert.deepEqual(f.journal.setConversationPolicy(id, run.conversationId!, {...input, acknowledgePaid: true}), result);
  assert.throws(() => f.journal.setConversationPolicy(id, run.conversationId!, input), {code: 'AGENT_TASK_REQUEST_CONFLICT'});
  assert.equal(f.journal.effectiveModes(id, run.conversationId!).paid, 'direct');
  assert.throws(() => f.journal.setConversationPolicy(id, run.conversationId!, {...input, requestId: randomUUID(), acknowledgePaid: true}), {code: 'AGENT_TASK_REVISION_CONFLICT'});
});

for (const wrapped of [false, true]) test(`frozen ${wrapped ? 'wrapped' : 'legacy no-wrapper'} schema controls explanation projection after cleanup`, t => {
  const f = fixture(t), run = f.start(), rawArguments = {value: '原参数', _mio_step: '读取项目内容'};
  const parameters = {type: 'object', properties: {value: {type: 'string'}, ...(wrapped ? {_mio_step: {type: 'string'}} : {})}}, toolName = 'mioon_project_get';
  const history: AgentTaskJson[] = [{role: 'user', content: run.text}], body = JSON.stringify({model: 'synthetic', messages: history, tools: [{type: 'function', function: {name: toolName, parameters}}]});
  const source = f.journal.beginModelStep(run.id, {request: {body, history}, data: {baseline: []}}, []);
  f.journal.markDispatch(run.id, source.id);
  const businessArguments = wrapped ? {value: rawArguments.value} : rawArguments;
  f.journal.completeStep(run.id, source.id, {result: {text: '', toolCalls: [{id: 'source-call', name: toolName, arguments: businessArguments}], providerOutput: {role: 'assistant', content: null, tool_calls: [{id: 'source-call', type: 'function', function: {name: toolName, arguments: JSON.stringify(rawArguments)}}]}}});
  assert.equal(f.records.request(f.records.step(source.id).currentRequestId!).originalBody, null);
  const call = {id: 'source-call', name: toolName, arguments: businessArguments};
  assert.deepEqual((f.journal.step(source.id).result as {toolCalls: unknown[]}).toolCalls, [call]);
  const step = f.journal.beginStep(run.id, {kind: 'tool', toolCall: call, data: {sourceModelStepId: source.id}});
  assert.deepEqual(f.journal.step(step.id).toolCall, call);
  f.reopen(); assert.deepEqual(f.journal.step(step.id).toolCall, call);
  assert.equal((f.journal.step(source.id).request as {body: string}).body, body);
});

test('send replay is independent of input property order and never creates another entry', t => {
  const f = fixture(t), requestId = randomUUID(), projectId = f.store.projectId, configuration = {protocol: 'chat_completions'};
  const first = f.journal.create({requestId, projectId, text: 'same send', configuration});
  const before = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
  assert.deepEqual(f.journal.create({configuration, text: 'same send', projectId, requestId}), first);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get()!.count, before);
  assert.throws(() => f.journal.create({requestId, projectId, text: 'changed send', configuration}), {code: 'AGENT_TASK_REQUEST_CONFLICT'});
});

test('diagnostic restart stops the hidden run and frees the project for a visible conversation', t => {
  const f = fixture(t), diagnostic = f.journal.create({requestId: randomUUID(), projectId: f.store.projectId, text: 'diagnostic', configuration: {protocol: 'chat_completions'}, diagnostic: {profile: 'text'}}).run;
  assert.equal(f.journal.list(f.store.projectId, {excludeDiagnostics: true}).length, 0); assert.equal(f.journal.history(f.store.projectId).conversations.length, 0);
  f.reopen(); assert.equal(f.journal.recover(), 1); assert.equal(f.journal.run(diagnostic.id).status, 'stopped');
  assert.equal(f.journal.latestDiagnostic('text')?.run.id, diagnostic.id);
  const visible = f.start(); assert.equal(f.journal.list(f.store.projectId, {excludeDiagnostics: true})[0]?.id, visible.id);
  assert.equal(f.journal.history(f.store.projectId).conversations.length, 1);
});

test('stale control rejections replay their retained receipt and never run an action', t => {
  const f = fixture(t), run = f.start(); f.journal.transition(run.id, run.revision, 'paused');
  const input = {requestId: randomUUID(), runId: run.id, expectedRevision: run.revision, action: 'resume'}; let actions = 0;
  assert.throws(() => f.journal.performControl(input, () => {actions++; return null;}), {code: 'AGENT_TASK_REVISION_CONFLICT'});
  const rejected = f.journal.rejectControl(input, 'AGENT_TASK_REVISION_CONFLICT');
  assert.deepEqual(f.journal.performControl(input, () => {actions++; return null;}), rejected); assert.equal(actions, 0);
  f.reopen(); assert.deepEqual(f.journal.lookupControl(input.requestId), rejected);
});

test('change retention and supersession keep their original undo payload and source', t => {
  const f = fixture(t), run = f.start(), call = {id: 'create-call', name: 'mioon_shot_create', arguments: {}};
  const response = model(f, run.id, [call]); response.complete(); const tool = f.journal.beginStep(run.id, {kind: 'tool', toolCall: call, data: {sourceModelStepId: response.step.id}});
  f.journal.markDispatch(run.id, tool.id);
  f.journal.completeStep(run.id, tool.id, {changes: ['shot.create', 'shot.update'].map(operation => ({projectId: f.store.projectId, operation, targets: [], before: {original: true}, after: {changed: true}, reversible: true}))});
  const [retained, superseded] = f.journal.snapshot(run.id).changes;
  f.store.tx(() => {f.journal.markChangeRetainedInside(retained!.id, 'keep generated product'); f.journal.markChangeSupersededInside(superseded!.id);});
  f.reopen(); const changes = f.journal.snapshot(run.id).changes;
  assert.equal(changes[0]?.reversible, false); assert.match(changes[0]?.summary ?? '', /keep generated product/u); assert.equal(changes[0]?.stepId, tool.id);
  assert.equal(changes[1]?.status, 'superseded'); assert.deepEqual(changes[1]?.before, {original: true}); assert.deepEqual(changes[1]?.after, {changed: true});
});

test('two manual owners may claim the same target and releasing one never clears the other', t => {
  const f = fixture(t), projectId = f.store.projectId, first = randomUUID(), second = randomUUID(), target = {kind: 'project', id: projectId, revision: f.journal.targetRevision(projectId, 'project', projectId)};
  f.journal.claim({projectId, ownerId: first, targets: [target]}); f.journal.claim({projectId, ownerId: second, targets: [target]});
  assert.equal(f.journal.claims(projectId).length, 2); f.journal.releaseClaims(projectId, first);
  assert.equal(f.journal.claims(projectId)[0]?.ownerId, second); assert.throws(() => f.journal.assertTargets(projectId, [target]), {code: 'AGENT_TASK_TARGET_CLAIMED'});
  f.journal.releaseClaims(projectId, second); f.journal.assertTargets(projectId, [target]);
});

test('conversation ordering includes a late edit to an earlier run under clock rollback', t => {
  const beginning = Date.parse('2026-11-02T00:00:00Z'); t.mock.timers.enable({apis: ['Date'], now: beginning});
  const f = fixture(t), first = f.start(); f.journal.transition(first.id, first.revision, 'completed');
  t.mock.timers.setTime(beginning + 1000); const second = f.start({conversationId: first.conversationId!}); f.journal.transition(second.id, second.revision, 'completed');
  t.mock.timers.setTime(beginning + 10000); f.journal.transition(first.id, f.journal.run(first.id).revision, 'reverted');
  t.mock.timers.setTime(beginning + 2000); const third = f.start({conversationId: first.conversationId!});
  assert.equal(third.createdAt, new Date(beginning + 10001).toISOString());
  assert.deepEqual(f.journal.conversation(f.store.projectId, first.conversationId!).runs.map(run => run.id), [first.id, second.id, third.id]);
});

test('terminal history projection and serialized conversation context match the legacy journal byte-for-byte', t => {
  const f = fixture(t), projectId = f.store.projectId, conversationRuns: string[] = []; let conversationId: string | undefined;
  for (const [index, status] of ['completed', 'completed', 'failed', 'stopped', 'reverted', 'completed'].entries()) {
    const run = f.start({conversationId, text: `history message ${index} \ud800`}); conversationId = run.conversationId; conversationRuns.push(run.id);
    if (index === 3) {
      f.store.tx(() => f.journal.appendNoteInside(run.id, randomUUID(), 'bound note 😀'));
      const ask: AgentTaskToolCall = {id: 'history-ask', name: 'mioon_ask', arguments: {question: 'Pick one?', options: [{label: 'Yes', description: 'Safe description'}, {label: 'No'}], allowOther: true}};
      const response = model(f, run.id, [ask]); response.complete();
      const tool = f.journal.beginStep(run.id, {kind: 'tool', toolCall: ask, data: {sourceModelStepId: response.step.id}});
      f.journal.updateStep(run.id, tool.id, {status: 'awaiting_answer'}); f.journal.updateStep(run.id, tool.id, {status: 'completed', result: {answer: {choices: [0], text: 'user answer \ud800'}, selected: ['Yes']}});
      f.journal.updateStep(run.id, tool.id, {cost: 'charged'});
      f.store.tx(() => {
        f.journal.appendNoteInside(run.id, randomUUID(), 'unbound note after answer');
        for (let count = 0; count < 66; count++) {
          const id = randomUUID();
          f.journal.appendChangesInside(run.id, tool.id, [{projectId, operation: 'shot.update', targets: [{kind: 'shot', id, revision: 1}], before: [{kind: 'shot', id, value: {title: `title before ${count}`, prompt: 'private prompt', duration: 2}}], after: [{kind: 'shot', id, value: {title: `title after ${count}`, prompt: 'changed private prompt', duration: 4}}], reversible: true}]);
          f.journal.skipTargetsInside(run.id, [{stepId: tool.id, target: {kind: 'shot', id, revision: count, revisionBefore: count - 1, revisionAfter: count + 1}}]);
          const jobId = randomUUID(); f.store.put('jobs', {id: jobId, projectId, status: count === 65 ? 'invalid status' : 'succeeded'});
          f.records.addOrigin({kind: 'job', jobId, runId: run.id, stepId: tool.id, requestId: randomUUID(), operation: 'generation.submit'});
        }
        f.journal.skipTargetsInside(run.id, [{stepId: tool.id, target: {kind: 'INVALID', id: randomUUID(), revision: 0}}]);
      });
    } else {
      const response = model(f, run.id); response.complete();
    }
    f.journal.transition(run.id, f.journal.run(run.id).revision, status === 'reverted' ? 'completed' : status as 'completed' | 'failed' | 'stopped');
    if (status === 'reverted') f.journal.transition(run.id, f.journal.run(run.id).revision, 'reverted');
    if (status === 'failed') f.journal.appendEvent(run.id, 'error', {code: 'HISTORY_FAILURE', message: 'private error detail'});
  }
  const active = f.start({conversationId, text: 'nonterminal excluded'});
  const legacyRoot = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-mio-journal-legacy-')), legacyStore = openWorkspaceStore(legacyRoot);
  t.after(() => {legacyStore.close(); rmSync(legacyRoot, {recursive: true, force: true});});
  legacyStore.put('projects', {id: projectId, name: 'Equivalent synthetic history'});
  legacyStore.tx(() => {
    for (const id of [...conversationRuns, active.id]) {
      const run = f.journal.run(id), snapshot = f.journal.snapshot(id);
      legacyStore.db.prepare('INSERT INTO agent_task_runs_v2(id,projectId,requestId,digest,status,revision,data) VALUES(?,?,?,?,?,?,?)').run(id, projectId, run.requestId, f.records.run(id).digest, run.status, run.revision, JSON.stringify(run));
      for (const step of snapshot.steps) legacyStore.db.prepare('INSERT INTO agent_task_steps_v2(id,runId,projectId,position,status,data) VALUES(?,?,?,?,?,?)').run(step.id, id, projectId, step.position, step.status, JSON.stringify(step));
      for (const change of snapshot.changes) legacyStore.db.prepare('INSERT INTO agent_task_changes_v2(id,runId,stepId,projectId,data) VALUES(?,?,?,?,?)').run(change.id, id, change.stepId, projectId, JSON.stringify(change));
      let sequence = 0;
      for (const entry of f.records.entries(id)) {
        const value = f.records.payload(entry) as Record<string, AgentTaskJson>;
        if (entry.kind === 'host_state' && value.type === 'run_state' || entry.kind === 'host_hint' && value.type === 'error') {
          const type = value.type === 'run_state' ? 'run' : 'error', data = type === 'run' ? {id, projectId, status: value.status, updatedAt: value.updatedAt} : {code: value.code};
          legacyStore.db.prepare('INSERT INTO agent_task_events_v2(runId,projectId,sequence,type,data) VALUES(?,?,?,?,?)').run(id, projectId, ++sequence, type, JSON.stringify({runId: id, sequence, type, data, createdAt: entry.createdAt}));
        }
      }
      for (const row of f.store.db.prepare('SELECT * FROM mio_job_origins WHERE runId=?').all(id)) {
        legacyStore.put('jobs', f.store.get('jobs', String(row.jobId)) as object);
        legacyStore.db.prepare('INSERT INTO agent_task_job_origins_v2(kind,jobId,runId,stepId,projectId,requestId,operation) VALUES(?,?,?,?,?,?,?)').run(String(row.kind), String(row.jobId), id, String(row.stepId), projectId, String(row.requestId), String(row.operation));
      }
    }
  });
  const legacy = createAgentTaskJournal(legacyStore), actual = f.journal.modelContextRuns(projectId, conversationId!), expected = legacy.modelContextRuns(projectId, conversationId!);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.deepEqual(actual.map(run => run.id), conversationRuns.slice(-4).reverse());
  const rich = actual.find(run => run.id === conversationRuns[3])!;
  assert.equal(rich.record.changes.total, 66); assert.equal(rich.record.changes.items.length, 64);
  assert.equal(rich.record.background.total, 66); assert.equal(rich.record.background.items.length, 64); assert.equal(rich.record.background.items[0]?.status, 'unknown');
  assert.equal(rich.record.skipped.total, 67); assert.equal(rich.record.skipped.items.length, 63);
  assert.equal(actual.find(run => run.status === 'failed')?.record.failureCode, 'HISTORY_FAILURE');
  assert.deepEqual(f.journal.contextRuns(projectId, conversationId!).map(run => run.id), legacy.contextRuns(projectId, conversationId!).map(run => run.id));
  for (const locale of ['zh-Hans', 'zh-Hant', 'en', 'ja'] as const) assert.equal(JSON.stringify(assembleRunContext({locale, text: 'next round', historyRuns: [...actual].reverse()})), JSON.stringify(assembleRunContext({locale, text: 'next round', historyRuns: [...expected].reverse()})));
});

test('one snapshot validates each source request once, while later calls revalidate blobs and observe new notes', t => {
  const f = fixture(t), run = f.start(), call = {id: 'read-source', name: 'mioon_project_get', arguments: {}};
  const response = model(f, run.id, [call]); response.complete();
  const tool = f.journal.beginStep(run.id, {kind: 'tool', toolCall: call, data: {sourceModelStepId: response.step.id}});
  f.journal.markDispatch(run.id, tool.id); f.journal.completeStep(run.id, tool.id, {result: {saved: true}});
  let validations = 0; const assembly = createMioAssembly(f.records);
  const journal = createMioJournal(f.store, {policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY), assembly: {...assembly, hydrate(request) {validations++; return assembly.hydrate(request);}}});
  const before = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
  assert.equal(journal.snapshot(run.id).steps.length, 2); assert.equal(validations, 1);
  assert.equal(journal.snapshot(run.id).steps.length, 2); assert.equal(validations, 2);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get()!.count, before);
  f.store.tx(() => journal.appendNoteInside(run.id, randomUUID(), 'newly committed note'));
  assert.equal(journal.snapshot(run.id).run.notes?.at(-1)?.text, 'newly committed note'); assert.equal(validations, 3);
  const request = f.records.request(f.records.step(response.step.id).currentRequestId!), sha256 = request.inputManifest.toolsBlobHash;
  // Simulate externally corrupted evidence in this disposable database. The
  // rollback restores both its immutable trigger and bytes after the check.
  assert.throws(() => f.store.tx(() => {
    f.store.db.exec('DROP TRIGGER main.immutable_mio_blobs');
    f.store.db.prepare('UPDATE mio_blobs SET content=?,bytes=? WHERE sha256=?').run('[1]', 3, sha256);
    const readChanges = f.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    assert.throws(() => journal.snapshot(run.id), {code: 'AGENT_TASK_STORAGE_CORRUPT'});
    assert.equal(f.store.db.prepare('SELECT total_changes() AS count').get()!.count, readChanges);
    throw Error('restore disposable corruption');
  }), /restore disposable corruption/u);
  assert.equal(validations, 4);
  assert.equal(journal.snapshot(run.id).steps.length, 2); assert.equal(validations, 5);
});
