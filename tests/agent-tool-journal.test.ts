import type {FixtureStore} from './helpers/strict-timeline-core-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deriveAgentEndpoint} from '@mioon/contracts';
import {openStore} from '../packages/business/src/db.ts';
import {buildAgentRequest} from '../packages/business/src/agent/agent-gateway.ts';
import {READ_TOOL_SYSTEM_INSTRUCTION, readToolPolicy} from '../packages/business/src/agent/read-tool-policy.ts';
import {createChatJournal, CHAT_JOURNAL_LIMITS, type ChatJournalResult} from '../packages/business/src/agent/chat-journal.ts';

const unavailable = {code: 'AGENT_CHAT_STORAGE_UNAVAILABLE'};
const catalog = ['project', 'asset', 'shot', 'timeline'].map(name => ({name: `${name}_inspect`, operation: `${name}.inspect`, parameters: {type: 'object', properties: {}, additionalProperties: false}}));
const catalogHash = createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
const config = (protocol: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol) => protocol==='anthropic_messages'?({presetId:'custom',platformId:'custom',baseUrl:'https://example.com',model:'synthetic-native',protocol}):({presetId: 'ollama', platformId: 'local', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', protocol});
function fixture(t: test.TestContext, {protocol = 'chat_completions', limits}: {protocol?: import('../packages/contracts/src/agent-protocol.ts').AgentProtocol;limits?: Record<string,number>} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mioon-tool-journal-'));
  let store = (openStore(root) as unknown as FixtureStore), journal = createChatJournal({store, limits});
  store.put('projects', {id: 'p1'}); store.put('projects', {id: 'p2'});
  t.after(() => { store.close(); rmSync(root, {recursive: true, force: true}); });
  const provenance = {category: 'project_saved_text_metadata', projectId: 'p1', sourceRunIds: []};
  const context = [{role: 'system' as const, content: protocol==='anthropic_messages'?READ_TOOL_SYSTEM_INSTRUCTION:'Inspect saved project metadata.'}, {role: 'user' as const, content: 'What is here?'}];
  const body = protocol === 'anthropic_messages' ? JSON.parse(buildAgentRequest({configuration:config(protocol),messages:context,readTools:{phase:'request'}}).body) as Record<string,unknown> : protocol === 'chat_completions' ? {model: 'qwen3:8b', messages: context, stream: true, max_tokens: 2048, tools: catalog, tool_choice: 'auto', parallel_tool_calls: false} :
    {model: 'qwen3:8b', instructions: context[0].content, input: context.slice(1), stream: true, store: false, max_output_tokens: 2048, tools: catalog, tool_choice: 'auto', parallel_tool_calls: false};
  const request = {protocol, body: JSON.stringify(body), context, provenance};
  const policy = protocol === 'anthropic_messages' ? readToolPolicy('p1') : {schemaVersion: 1, projectId: 'p1', context: 'project_inspection', maxModelRequests: 2,
    maxToolCalls: 1, maxResultBytes: 8192, catalog, catalogHash};
  const execution = {version: 1, policy, request};
  const call = {id: 'call_1', name: protocol==='anthropic_messages'?'mioon_project_inspect':'project_inspect', arguments: {}, argumentsJson: '{}', ...(protocol === 'responses' ? {itemId: 'fc_1'} : {})};
  const output = {type: 'done', finishReason: 'tool_calls', toolCall: call,
    providerOutput: protocol === 'anthropic_messages' ? {role:'assistant',content:[{type:'tool_use',id:call.id,name:call.name,input:{}}]} : protocol === 'chat_completions' ? {role: 'assistant' as const, content: '', tool_calls: [{id: call.id, type: 'function', function: {name: call.name, arguments: call.argumentsJson}}]} :
      [{type: 'function_call', id: call.itemId, call_id: call.id, name: call.name, arguments: call.argumentsJson, status: 'completed'}]};
  const observedProvenance = {category: provenance.category, projectId: 'p1', operation: 'project.inspect'};
  const observation = {result: {id: 'p1', name: 'Saved project'}, resultJson: '{"id":"p1","name":"Saved project"}', provenance: observedProvenance};
  let accepted: ChatJournalResult;
  const f = {root, protocol, execution, request, output, call, observation, get store() { return store; }, get journal() { return journal; },
    get accepted() { return accepted; }, get id() { return accepted.run.id; },
    accept(overrides = {}) {
      const input = {message: 'What is here?', expectedSettingsRevision: 0, expectedConversationRevision: 0};
      accepted = journal.accept({projectId: 'p1', requestId: randomUUID(), fingerprint: 'synthetic', instanceId: randomUUID(), configuration: config(protocol),
        messages: context, consent: {destination: deriveAgentEndpoint(config(protocol)), protocol, model: config(protocol).model, context: 'project_inspection', projectId: 'p1', schemaVersion: 1, catalogHash: policy.catalogHash, maxModelRequests: 2, maxToolCalls: 1, maxResultBytes: 8192}, input, execution, ...overrides});
      return accepted;
    },
    reopen() { store.close(); store = (openStore(root) as unknown as FixtureStore); journal = createChatJournal({store, limits}); },
    first() { return journal.steps('p1', f.id)[0]; },
    dispatch() { return journal.modelDispatch(f.id, f.first().id); },
    complete() { return journal.modelComplete(f.id, f.first().id, {output}); },
    intent() { return journal.toolIntent(f.id, f.first().id, {toolCall: call, provenance: observedProvenance}); },
    capture(callback: ()=>unknown = () => observation) { return journal.captureTool(f.id, journal.steps('p1', f.id)[1].id, callback); },
    next() {
      if(protocol==='anthropic_messages')return {...request,body:buildAgentRequest({configuration:config(protocol),messages:context,readTools:{phase:'answer',toolCall:call,providerOutput:output.providerOutput,result:observation.resultJson}}).body};
      const initial = JSON.parse((request.body as string)), next = {...initial}; delete next.tools; delete next.parallel_tool_calls; next.tool_choice = 'none';
      if (protocol === 'chat_completions') next.messages = [...initial.messages, output.providerOutput, {role: 'tool' as const, tool_call_id: call.id, content: observation.resultJson}];
      else next.input = [...initial.input, ...(output.providerOutput as unknown as unknown[]), {type: 'function_call_output', call_id: call.id, output: observation.resultJson}];
      return {...request, body: JSON.stringify(next)};
    },
    untilIntent() { f.accept(); f.dispatch(); f.complete(); return f.intent(); },
    untilObserved() { f.untilIntent(); return f.capture(); },
    rows(table: string) { return store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(); },
  };
  return f;
}

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
  test(`${protocol}: complete bounded workflow commits exact wire artifacts and immutable snapshot history`, t => {
    const f = fixture(t, {protocol}), accepted = f.accept();
    assert.equal(accepted.run.contextMode, 'project_inspection');
    assert.equal(accepted.step!.requestId, accepted.run.modelRequestId);
    assert.deepEqual(f.first().request, f.request);
    assert.equal(f.rows('agent_chat_requests').length, 1);
    const dispatch = f.dispatch(); assert.equal(dispatch.run.modelRequestState, 'dispatch_started');
    const complete = f.complete(); assert.deepEqual(complete.step.output, f.output);
    const intent = f.intent(); assert.equal(intent.step.status, 'intent');
    let calls = 0;
    const captured = f.capture(() => {
      calls++;
      assert.equal(f.journal.steps('p1', f.id)[1].status, 'dispatch_started');
      assert.deepEqual(f.first().output, f.output);
      return f.observation;
    });
    assert.equal(calls, 1); assert.equal(captured.events.length, 2);
    assert.equal(captured.events[0].run!.activity![1].status, 'dispatch_started');
    assert.equal(captured.events[1].run!.activity![1].resultJson, f.observation.resultJson);
    const second = f.journal.prepareContinuation(f.id, f.next());
    assert.equal(second.step.ordinal, 2); assert.notEqual(second.step.requestId, accepted.run.modelRequestId);
    f.journal.modelDispatch(f.id, second.step.id);
    f.journal.modelComplete(f.id, second.step.id, {output: {type: 'done', finishReason: 'stop'}});
    const finished = f.journal.finish(f.id, 'completed');
    assert.equal(finished.run.modelRequestState, 'completed'); assert.equal(finished.run.activity!.length, 3);
    assert.ok(finished.run.activity!.every(item => item.status === 'completed'));
    const events = f.journal.replay(f.id, 0);
    assert.deepEqual(events!.map(event => event.id), Array.from({length: events!.length}, (_, index) => index + 1));
    assert.equal(events![0].run!.activity!.length, 1); assert.equal(events![0].run!.activity![0].status, 'not_started');
    assert.equal(events![3].run!.activity![1].status, 'intent');
    const before = f.rows('agent_chat_steps'); f.reopen(); assert.deepEqual(f.journal.recover(), []);
    assert.deepEqual(f.rows('agent_chat_steps'), before); assert.deepEqual(f.journal.get('p1', f.id), finished.run);
    assert.equal(f.rows('agent_chat_quota')[0].reservedBytes, 0);
  });
}

test('legacy acceptance and stored runs remain typed-only with zero step rows', t => {
  const f = fixture(t); const accepted = f.accept({execution: undefined, consent: {destination: deriveAgentEndpoint(config('chat_completions')), protocol: 'chat_completions' as const, model: 'qwen3:8b', context: 'typed_chat_only'}});
  assert.equal(Object.hasOwn(accepted.run, 'contextMode'), false); assert.deepEqual(f.journal.steps('p1', f.id), []);
  f.journal.dispatch(f.id); f.journal.finish(f.id, 'completed'); f.reopen(); f.journal.recover();
  assert.equal(Object.hasOwn(f.journal.get('p1', f.id)!, 'activity'), false);
});

test('ordering rejects early tool intent, undisbursed completion, legacy dispatch bypass and false run completion', t => {
  const f = fixture(t); f.accept();
  assert.throws(() => f.complete(), unavailable); assert.throws(() => f.intent(), unavailable);
  assert.throws(() => f.journal.dispatch(f.id), unavailable); assert.throws(() => f.journal.finish(f.id, 'completed'), unavailable);
  f.dispatch(); f.complete(); assert.throws(() => f.journal.finish(f.id, 'completed'), unavailable);
  assert.throws(() => f.journal.prepareContinuation(f.id, f.next()), unavailable);
});

test('lost acknowledgement, duplicate intent and two journal instances never repeat an observed read', t => {
  const f = fixture(t); const intent = f.untilIntent(); let calls = 0;
  assert.equal(f.intent().step.id, intent.step.id); assert.deepEqual(f.intent().events, []);
  const original = f.store.tx; let transactions = 0;
  f.store.tx = operation => { const value = original(operation); if (++transactions === 2) throw Error('lost capture acknowledgement'); return value; };
  assert.throws(() => f.capture(() => { calls++; return f.observation; }), /lost capture/);
  f.store.tx = original;
  const secondJournal = createChatJournal({store: f.store});
  const replayed = secondJournal.captureTool(f.id, intent.step.id, () => { calls++; return f.observation; });
  assert.equal(calls, 1); assert.deepEqual(replayed.step.observation, f.observation); assert.deepEqual(replayed.events, []);
});

test('capture result rollback retains durable dispatch boundary and never permits retry', t => {
  const f = fixture(t); f.untilIntent(); let calls = 0;
  f.store.db.exec("CREATE TRIGGER reject_observation BEFORE UPDATE ON agent_chat_steps WHEN json_type(NEW.data,'$.observation') IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic disk fault');END;");
  assert.throws(() => f.capture(() => { calls++; return f.observation; }), /synthetic disk fault/);
  assert.equal(f.journal.steps('p1', f.id)[1].status, 'dispatch_started');
  f.store.db.exec('DROP TRIGGER reject_observation');
  assert.throws(() => f.capture(() => { calls++; return f.observation; }), unavailable); assert.equal(calls, 1);
  f.reopen(); f.journal.recover();
  assert.equal(f.journal.steps('p1', f.id)[1].status, 'unknown'); assert.equal(f.journal.get('p1', f.id)!.status, 'interrupted');
});

test('callback throws, asynchronous callback, thenable and mismatched exact result fail closed', t => {
  for (const mode of ['throw', 'async', 'promise', 'thenable', 'mismatch'] as const) {
    const f = fixture(t); f.untilIntent(); let calls = 0;
    const callback = mode === 'async' ? async () => { calls++; return f.observation; } : () => {
      calls++; if (mode === 'throw') throw Error('read failed');
      if (mode === 'promise') return Promise.resolve(f.observation);
      if (mode === 'thenable') return {then() {}};
      return {...f.observation, resultJson: '{}'};
    };
    assert.throws(() => f.capture(callback));
    assert.equal(calls, mode === 'async' ? 0 : 1);
    if (mode !== 'async') assert.equal(f.journal.steps('p1', f.id)[1].status, 'dispatch_started');
    f.journal.finish(f.id, 'interrupted');
  }
});

for (const protocol of ['chat_completions', 'anthropic_messages'] as const) for (const boundary of ['accepted', 'first-dispatch', 'first-complete', 'intent', 'capture-started', 'observed', 'prepared', 'second-dispatch'] as const) {
  test(`${protocol}: reopen at ${boundary} interrupts without repeating model or read work`, t => {
    const f = fixture(t, {protocol}); f.accept();
    if (boundary !== 'accepted') f.dispatch();
    if (!['accepted', 'first-dispatch'].includes(boundary)) f.complete();
    if (!['accepted', 'first-dispatch', 'first-complete'].includes(boundary)) f.intent();
    if (boundary === 'capture-started') assert.throws(() => f.capture(() => { throw Error('crash window'); }));
    if (['observed', 'prepared', 'second-dispatch'].includes(boundary)) f.capture();
    if (['prepared', 'second-dispatch'].includes(boundary)) {
      const second = f.journal.prepareContinuation(f.id, f.next());
      if (boundary === 'second-dispatch') f.journal.modelDispatch(f.id, second.step.id);
    }
    const before = f.journal.steps('p1', f.id); f.reopen();
    const recovered = f.journal.recover(); assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'interrupted');
    const steps = f.journal.steps('p1', f.id);
    assert.deepEqual(steps.map(step => step.status), before.map(step => step.status === 'completed' ? 'completed' : 'unknown'));
    assert.deepEqual(f.journal.recover(), []);
    if (steps[1] && steps[1].status !== 'completed') assert.throws(() => f.capture(() => assert.fail('must not dispatch')), unavailable);
  });
}

test('Anthropic native journal rejects altered tools, retained input, result identities and compatibility versions', t => {
  const f = fixture(t, {protocol: 'anthropic_messages'});
  for (const mutate of [
    (body: Record<string, unknown>) => { body.thinking = {type: 'enabled', budget_tokens: 1024}; },
    (body: Record<string, unknown>) => { body.anthropic_version = '2099-01-01'; },
    (body: Record<string, unknown>) => { (body.tools as Array<Record<string, unknown>>)[0]!.type = 'web_search_20250305'; },
    (body: Record<string, unknown>) => { body.system = 'Provider-supplied authority'; },
  ]) {
    const execution = structuredClone(f.execution), body = JSON.parse(execution.request.body) as Record<string, unknown>;
    mutate(body); execution.request.body = JSON.stringify(body);
    assert.throws(() => f.accept({execution}), unavailable);
    assert.equal(f.rows('agent_chat_requests').length, 0);
  }
  f.accept(); f.dispatch();
  for (const mutate of [
    (message: {role: string; content: Array<Record<string, unknown>>}) => { message.content[0]!.input = {approved: true}; },
    (message: {role: string; content: Array<Record<string, unknown>>}) => { message.content[0]!.id = 'toolu_other'; },
    (message: {role: string; content: Array<Record<string, unknown>>}) => { message.content.push({...message.content[0]!}); },
    (message: {role: string; content: Array<Record<string, unknown>>}) => { message.content.push({type: 'thinking', thinking: 'hidden'}); },
  ]) {
    const output = structuredClone(f.output); mutate(output.providerOutput as {role: string; content: Array<Record<string, unknown>>});
    assert.throws(() => f.journal.modelComplete(f.id, f.first().id, {output}), unavailable);
  }
  f.complete(); f.intent(); f.capture();
  for (const mutate of [
    (body: Record<string, unknown>) => { ((body.messages as Array<{content: Array<Record<string, unknown>>}>).at(-1)!.content)[0]!.tool_use_id = 'toolu_other'; },
    (body: Record<string, unknown>) => { ((body.messages as Array<{content: Array<Record<string, unknown>>}>).at(-1)!.content)[0]!.content = '{}'; },
    (body: Record<string, unknown>) => { body.tool_choice = {type: 'auto'}; },
    (body: Record<string, unknown>) => { body.max_tokens = 4096; },
  ]) {
    const request = f.next(), body = JSON.parse(request.body) as Record<string, unknown>; mutate(body); request.body = JSON.stringify(body);
    assert.throws(() => f.journal.prepareContinuation(f.id, request), unavailable);
  }
  const second = f.journal.prepareContinuation(f.id, f.next());
  assert.equal(f.journal.prepareContinuation(f.id, f.next()).step.id, second.step.id);
  const before = f.rows('agent_chat_steps'); f.reopen(); f.journal.recover();
  assert.deepEqual(f.journal.steps('p1', f.id).map(step => step.request?.body), before.map(row => JSON.parse(String(row.data)).request?.body));
});

test('Stop revokes future reads and continuation; later callbacks cannot reopen terminal state', t => {
  const f = fixture(t); const intent = f.untilIntent();
  f.journal.finish(f.id, 'stopped');
  assert.throws(() => f.journal.captureTool(f.id, intent.step.id, () => assert.fail('stopped read')), unavailable);
  assert.throws(() => f.journal.prepareContinuation(f.id, f.next()), unavailable);
  assert.equal(f.journal.get('p1', f.id)!.status, 'stopped');
});

test('continuation rejects changed context, substituted call IDs/results and tool-enabled third round', t => {
  const f = fixture(t); f.untilObserved();
  for (const mutate of [
(    request: { context: { role: string; content: string; }[]; }) => { request.context = [{role: 'user' as const, content: 'changed'}]; },
(    request: { body: string; }) => { const body = JSON.parse((request.body as string)); body.messages.at(-1).tool_call_id = 'other'; request.body = JSON.stringify(body); },
(    request: { body: string; }) => { const body = JSON.parse((request.body as string)); body.messages.at(-1).content = '{}'; request.body = JSON.stringify(body); },
(    request: { body: string; }) => { const body = JSON.parse((request.body as string)); body.tools = catalog; request.body = JSON.stringify(body); },
  ] as const) { const next = structuredClone(f.next()); mutate(next); assert.throws(() => f.journal.prepareContinuation(f.id, next), unavailable); }
  const second = f.journal.prepareContinuation(f.id, f.next());
  assert.equal(f.journal.prepareContinuation(f.id, f.next()).step.id, second.step.id);
  f.journal.modelDispatch(f.id, second.step.id);
  assert.throws(() => f.journal.modelComplete(f.id, second.step.id, {output: f.output}), unavailable);
  assert.throws(() => f.journal.toolIntent(f.id, second.step.id, {toolCall: f.call, provenance: f.observation.provenance}), unavailable);
  assert.equal(f.journal.steps('p1', f.id).length, 3);
});

test('step IDs and provenance cannot cross projects or foreign accepted runs', t => {
  const f = fixture(t); f.untilIntent();
  assert.throws(() => f.journal.steps('p2', f.id), {code: 'AGENT_CHAT_NOT_FOUND'});
  assert.equal(f.journal.get('p2', f.id), null);
  assert.throws(() => f.journal.modelDispatch(randomUUID(), f.first().id), unavailable);
  assert.throws(() => f.journal.modelDispatch(f.id, randomUUID()), unavailable);
  assert.throws(() => f.journal.toolIntent(f.id, f.first().id, {toolCall: f.call, provenance: {...f.observation.provenance, projectId: 'p2'}}), unavailable);
});

test('immutable evidence cannot be rewritten/deleted and no credential-shaped fields are accepted', t => {
  const f = fixture(t); f.untilObserved();
  assert.throws(() => f.store.db.exec("UPDATE agent_chat_steps SET data=json_set(data,'$.request.body','{}') WHERE kind='model'"), /immutable/);
  assert.throws(() => f.store.db.exec("UPDATE agent_chat_steps SET data=json_set(data,'$.observation.resultJson','{}') WHERE kind='tool'"), /immutable/);
  assert.throws(() => f.store.db.exec('DELETE FROM agent_chat_steps'), /retained/);
  assert.throws(() => f.store.db.exec("UPDATE agent_chat_runs SET data=json_remove(data,'$.contextMode','$.provenance')"), /immutable/);
  f.journal.finish(f.id, 'stopped');
  for (const key of ['apiKey', 'authorization', 'headers', 'access_token'] as const) {
    const execution = structuredClone(f.execution), body = JSON.parse((execution.request.body as string)); body[key] = 'SYNTHETIC_SECRET'; execution.request.body = JSON.stringify(body);
    assert.throws(() => f.accept({execution}), unavailable);
  }
  assert.equal(JSON.stringify(f.rows('agent_chat_requests')).includes('SYNTHETIC_SECRET'), false);
});

test('missing inspection fields cannot downgrade accepted inspection into legacy typed chat', t => {
  const f = fixture(t); f.accept();
  f.store.db.exec('DROP TRIGGER immutable_agent_chat_inspection_context');
  f.store.db.exec("UPDATE agent_chat_runs SET data=json_remove(data,'$.contextMode','$.provenance','$.activity')");
  assert.throws(() => f.journal.get('p1', f.id), unavailable);
});

test('malformed durable activity and mismatched SQL step identity fail closed on read/replay', t => {
  for (const corruption of ['activity', 'scope', 'oversized'] as const) {
    const f = fixture(t); f.untilObserved();
    if (corruption === 'activity') f.store.db.exec("UPDATE agent_chat_runs SET data=json_set(data,'$.activity[1].ordinal',2)");
    else {
      f.store.db.exec('DROP TRIGGER immutable_agent_chat_step_payload');
      if (corruption === 'scope') f.store.db.exec("UPDATE agent_chat_steps SET projectId='p2',data=json_set(data,'$.projectId','p2') WHERE kind='tool'");
      else f.store.db.exec("UPDATE agent_chat_steps SET data=json_set(data,'$.observation.resultJson',printf('%9000s','x')) WHERE kind='tool'");
    }
    assert.throws(() => f.journal.get('p1', f.id), unavailable);
    assert.throws(() => f.journal.replay(f.id, 0), unavailable);
  }
});

test('acceptance quota rollback leaves no partial run, step, event or reservation', t => {
  const f = fixture(t, {limits: {bytes: CHAT_JOURNAL_LIMITS.terminalReserveBytes + 1000}});
  assert.throws(() => f.accept(), {code: 'AGENT_CHAT_STORAGE_LIMIT'});
  for (const table of ['agent_chat_runs', 'agent_chat_steps', 'agent_chat_events', 'agent_chat_requests', 'agent_chat_threads'] as const) assert.equal(f.rows(table).length, 0);
  assert.equal(f.rows('agent_chat_quota')[0].reservedBytes, 0);
});

test('result quota failure keeps read non-retryable and terminal reserve remains usable', t => {
  const f = fixture(t); f.untilIntent();
  const quota = f.rows('agent_chat_quota')[0];
  const limited = createChatJournal({store: f.store, limits: {bytes: (quota.bytes as unknown as number)! + (quota.reservedBytes as unknown as number)! + 3500}});
  let calls = 0;
  const huge = {...f.observation, result: {text: 'x'.repeat(7000)}, resultJson: JSON.stringify({text: 'x'.repeat(7000)})};
  assert.throws(() => limited.captureTool(f.id, f.journal.steps('p1', f.id)[1].id, () => { calls++; return huge; }), {code: 'AGENT_CHAT_STORAGE_LIMIT'});
  assert.equal(calls, 1); assert.equal(f.journal.steps('p1', f.id)[1].status, 'dispatch_started');
  limited.finish(f.id, 'failed');
  assert.equal(f.journal.get('p1', f.id)!.status, 'failed'); assert.equal(f.rows('agent_chat_quota')[0].reservedBytes, 0);
});


test('project consent without execution is rejected before acceptance and cannot be read as legacy', t => {
  const f = fixture(t);
  assert.throws(() => f.accept({execution: undefined}), unavailable);
  assert.equal(f.rows('agent_chat_requests').length, 0);
  f.accept();
  f.store.db.exec('DROP TRIGGER immutable_agent_chat_requests; DROP TRIGGER immutable_agent_chat_inspection_context');
  f.store.db.exec("UPDATE agent_chat_requests SET acceptance=json_remove(acceptance,'$.execution')");
  f.store.db.exec("UPDATE agent_chat_runs SET data=json_remove(data,'$.contextMode','$.provenance','$.activity')");
  assert.throws(() => f.journal.get('p1', f.id), unavailable);
});

test('persisted replay snapshots cannot lose provenance or substitute activity identities', t => {
  for (const corruption of ['provenance', 'activity'] as const) {
    const f = fixture(t); f.untilObserved();
    f.store.db.exec('DROP TRIGGER immutable_agent_chat_events');
    if (corruption === 'provenance') f.store.db.exec("UPDATE agent_chat_events SET data=json_remove(data,'$.run.contextMode','$.run.provenance','$.run.activity') WHERE seq=1");
    else f.store.db.prepare("UPDATE agent_chat_events SET data=json_set(data,'$.run.activity[0].id',?) WHERE seq=1").run(randomUUID());
    assert.throws(() => f.journal.replay(f.id, 0), unavailable);
  }
});
