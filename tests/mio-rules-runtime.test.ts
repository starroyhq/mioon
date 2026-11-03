import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createMioProjectRules} from '../packages/business/src/agent/mio-rules.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import type {TaskGateway, TaskModelOutput} from '../packages/business/src/agent/task-gateway-v2.ts';
import {assembleRunContext} from '../packages/business/src/agent/task-context-v2.ts';
import {taskBaseModelHistory} from '../packages/business/src/agent/task-context-base-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson, AgentTaskSnapshot, AgentTaskToolCall} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentProtocol} from '../packages/contracts/src/agent-protocol.ts';
import {createTestAuthorizations, authorizeTestScope} from './helpers/agent-authorizations.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function output(protocol: AgentProtocol, calls: AgentTaskToolCall[] = []): TaskModelOutput {
  const text = 'Offline rules completion';
  const providerOutput: AgentTaskJson = protocol === 'chat_completions'
    ? {role: 'assistant', content: text, ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})}
    : protocol === 'responses' ? [{type: 'message', role: 'assistant', content: [{type: 'output_text', text, annotations: []}]}, ...calls.map(call => ({type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed'}))]
      : {role: 'assistant', content: [{type: 'text', text}, ...calls.map(call => ({type: 'tool_use', id: call.id, name: call.name, input: call.arguments}))]};
  return {text, toolCalls: calls, providerOutput};
}
function object(value: unknown): Record<string, unknown> {assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;}
async function fixture(t: TestContext, protocol: AgentProtocol = 'chat_completions', rulesOptions: Pick<Parameters<typeof createMioProjectRules>[0], 'onPhase'> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'mio-rules-runtime-'));
  let store = openStore(root), services = createServices(store, new Map()), application = testProjectAppLibrary(store)!;
  const project = object(await services.call('project.create', {name: 'Frozen rules project'})), projectId = String(project.id);
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  await settings.put({expectedRevision: 0, configuration: {presetId: 'custom', platformId: 'custom', protocol,
    model: 'synthetic-rules', baseUrl: 'https://harness.example.com'}, secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_LOCAL_TEST_ONLY'}});
  const authorizations = createTestAuthorizations(() => ({...store}), settings); await authorizeTestScope(authorizations, 'project_agent');
  let rules = createMioProjectRules({store, application, ...rulesOptions}), captureCount = 0;
  let tools = createAgentTaskTools({store, services, rules});
  const requests: string[] = [];
  let respond: (index: number) => TaskModelOutput = () => output(protocol), beforeResponse: (() => void) | undefined;
  const gateway: TaskGateway = async function* (request) {
    request.beforeSubmit?.(); requests.push(request.body); beforeResponse?.();
    yield {type: 'done', output: respond(requests.length)};
  };
  const build = () => createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, selfPort: () => 4318,
    rules: {...rules, capture() {captureCount++; return rules.capture();}}});
  let runtime = build();
  t.after(async () => {runtime.close(); tools.dispose(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  return {projectId, root, requests, settings, get store() {return store;}, get application() {return application;}, get runtime() {return runtime;}, get rules() {return rules;}, get captures() {return captureCount;},
    respond(next: typeof respond) {respond = next;}, beforeResponse(next?: () => void) {beforeResponse = next;},
    async send(extra: Record<string, unknown> = {}) {return runtime.send(projectId, {requestId: randomUUID(), text: 'Current explicit request', expectedSettingsRevision: (await settings.get()).revision, locale: 'en', ...extra});},
    async settle(id: string) {await runtime.drain(); return runtime.journal.snapshot(id);},
    action(snapshot: AgentTaskSnapshot, action: string, extra: Record<string, unknown> = {}) {return runtime.action(projectId, snapshot.run.id, {requestId: randomUUID(), expectedRevision: snapshot.run.revision, action, ...extra});},
    reopen() {runtime.close(); tools.dispose(); store.close(); store = openStore(root); services = createServices(store, new Map()); application = testProjectAppLibrary(store)!; rules = createMioProjectRules({store, application}); tools = createAgentTaskTools({store, services, rules}); runtime = build();},
  };
}

for (const protocol of ['chat_completions', 'responses', 'anthropic_messages'] as const) {
  test(`${protocol}: send freezes once; live changes and reopening never rewrite the completed request`, async t => {
    const f = await fixture(t, protocol), original = 'PROJECT_RULES_ORIGINAL_😀\r\n', newer = 'PROJECT_RULES_NEXT_😀\r\n';
    f.rules.save({requestId: randomUUID(), expectedHash: null, text: original});
    f.application.tx(() => f.application.userRules.cas(0, 'USER_RULES_ORIGINAL', new Date().toISOString()));
    const project = object(f.store.get('projects', f.projectId)); f.store.put('projects', {...project, notes: 'LEGACY_NOTES_MUST_NOT_INJECT'});
    f.beforeResponse(() => {
      f.beforeResponse(); f.rules.save({requestId: randomUUID(), expectedHash: hash(original), text: newer});
      f.application.tx(() => f.application.userRules.cas(1, 'USER_RULES_NEXT', new Date().toISOString()));
    });
    const sent = await f.send(), completed = await f.settle(sent.run.id);
    assert.equal(completed.run.status, 'completed'); assert.equal(f.captures, 1);
    const firstBody = f.requests[0]!;
    assert.ok(firstBody.includes('PROJECT_RULES_ORIGINAL')); assert.ok(firstBody.includes('USER_RULES_ORIGINAL'));
    assert.equal(firstBody.includes('LEGACY_NOTES_MUST_NOT_INJECT'), false); assert.equal(firstBody.includes('PROJECT_RULES_NEXT'), false);
    const records = createMioRecords(f.store), run = records.run(sent.run.id), entries = records.entries(sent.run.id).filter(entry => entry.kind === 'rules_snapshot');
    assert.equal(entries.length, 1); assert.equal(entries[0]!.payloadBlobHash, run.rulesSnapshotHash);
    const frozen = JSON.parse(records.blob(run.rulesSnapshotHash!)); assert.equal(frozen.project.text, original); assert.equal(frozen.user.revision, 1);
    const model = completed.steps.find(step => step.kind === 'model')!, savedRequest = records.request(records.step(model.id).currentRequestId!);
    assert.equal(savedRequest.originalBody, null); assert.equal(savedRequest.inputManifest.rulesBlobHash, run.rulesSnapshotHash);
    assert.ok(savedRequest.inputManifest.entryIds.includes(entries[0]!.id));
    f.reopen();
    const before = f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const restored = f.runtime.journal.step(model.id);
    assert.equal(object(restored.request).body, firstBody); assert.equal(f.captures, 1);
    assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n, before);
    const next = await f.send({conversationId: completed.run.conversationId}); await f.settle(next.run.id);
    assert.equal(f.captures, 2); assert.ok(f.requests[1]!.includes('PROJECT_RULES_NEXT')); assert.ok(f.requests[1]!.includes('USER_RULES_NEXT'));
    assert.equal(f.requests[1]!.includes('PROJECT_RULES_ORIGINAL'), false); assert.equal(f.requests[1]!.includes('USER_RULES_ORIGINAL'), false);
  });
}

test('diagnostic has the old catalog, never calls capture, and creates no rules blob or entry', async t => {
  const f = await fixture(t);
  f.rules.save({requestId: randomUUID(), expectedHash: null, text: 'PRIVATE_PROJECT_RULES'});
  const sent = await f.send({diagnostic: {profile: 'catalog'}}); await f.settle(sent.run.id);
  assert.equal(f.captures, 0);
  const records = createMioRecords(f.store); assert.equal(records.run(sent.run.id).rulesSnapshotHash, null);
  assert.equal(records.entries(sent.run.id).some(entry => entry.kind === 'rules_snapshot'), false);
  assert.equal(f.requests[0]!.includes('PRIVATE_PROJECT_RULES'), false);
  assert.ok(f.requests[0]!.includes('mioon_project_notes_set')); assert.equal(f.requests[0]!.includes('mioon_project_rules_set'), false);
});

test('empty native rules are frozen without an empty notice, and pinned rules survive history trimming', async t => {
  const f = await fixture(t), sent = await f.send(); await f.settle(sent.run.id);
  const records = createMioRecords(f.store), value = records.run(sent.run.id);
  assert.ok(value.rulesSnapshotHash); assert.deepEqual(JSON.parse(records.blob(value.rulesSnapshotHash)), {version: 1, project: null, user: null, message: null});
  assert.equal(f.requests[0]!.includes('Host-provided frozen rules'), false);
  const snapshot = {version: 1 as const, project: {text: 'Pinned rules', hash: hash('Pinned rules')}, user: null, message: {role: 'user' as const, content: 'Pinned rules'}};
  const {context, metrics} = assembleRunContext({locale: 'en', text: 'Current request', rulesSnapshot: snapshot,
    previousRuns: [{text: 'old'.repeat(5000), steps: [{kind: 'model', status: 'completed', result: {text: 'old result'}}]}], budget: {bytes: 1024, tokens: null}});
  assert.equal(metrics.trimmedRuns, 1); assert.ok(JSON.stringify(taskBaseModelHistory(context)).includes('Pinned rules'));
});

test('rules always require approval under direct modes and expose the actual host proposal', async t => {
  const f = await fixture(t), before = 'Before rules', after = 'Approved new rules';
  f.rules.save({requestId: randomUUID(), expectedHash: null, text: before});
  f.runtime.journal.updatePolicy({...f.runtime.policy(), modes: {read_only: 'direct', local_reversible: 'direct', local_irreversible: 'direct', paid: 'direct'}});
  f.respond(index => output('chat_completions', index === 1 ? [{id: 'set-rules', name: 'mioon_project_rules_set', arguments: {expectedHash: hash(before), proposedText: after}}] : []));
  const sent = await f.send(), awaiting = await f.settle(sent.run.id);
  assert.equal(awaiting.run.status, 'awaiting_approval'); assert.equal(readFileSync(path.join(f.store.projectDir, 'AGENTS.md'), 'utf8'), before);
  const step = awaiting.steps.find(item => item.kind === 'tool')!;
  const safe = await f.runtime.action(f.projectId, awaiting.run.id, {requestId: randomUUID(), expectedRevision: awaiting.run.revision, action: 'pause'});
  // A pause returns the ordinary public snapshot; the pending proposal stays visible.
  const proposal = object(object(safe.steps.find(item => item.id === step.id)!.result).rulesProposal);
  assert.deepEqual(proposal, {file: 'AGENTS.md', expectedHash: hash(before), beforeText: before, proposedText: after, afterHash: hash(after), diff: {before, after}});
  await f.action(f.runtime.journal.snapshot(sent.run.id), 'resume');
  const pending = await f.settle(sent.run.id), approvalId = randomUUID();
  await f.runtime.action(f.projectId, sent.run.id, {requestId: approvalId, expectedRevision: pending.run.revision, action: 'approve', stepId: step.id});
  const done = await f.settle(sent.run.id); assert.equal(done.run.status, 'completed');
  assert.equal(readFileSync(path.join(f.store.projectDir, 'AGENTS.md'), 'utf8'), after);
  const saved = f.runtime.journal.step(step.id), data = object(saved.data), receipt = createMioRecords(f.store).control(approvalId)!;
  assert.equal(data.rulesApprovalReceiptId, approvalId);
  assert.deepEqual(object(receipt.data).result, {state: 'completed', approvedRules: {stepId: step.id, proposalDigest: data.approvalDigest}});
  assert.equal(f.requests.length, 2); assert.ok(f.requests[1]!.includes('Before rules')); assert.equal(f.requests[1]!.includes('Project rules (AGENTS.md):\\nApproved new rules'), false);
  const next = await f.send({conversationId: done.run.conversationId}); await f.settle(next.run.id);
  assert.ok(f.requests[2]!.includes('Approved new rules'));
});

test('denying a rules proposal does not publish or trust the candidate', async t => {
  const f = await fixture(t);
  f.respond(index => output('chat_completions', index === 1 ? [{id: 'denied-rules', name: 'mioon_project_rules_set', arguments: {expectedHash: null, proposedText: 'Denied'}}] : []));
  const sent = await f.send(), awaiting = await f.settle(sent.run.id), step = awaiting.steps.find(item => item.kind === 'tool')!;
  await f.action(awaiting, 'deny', {stepId: step.id});
  const done = await f.settle(sent.run.id); assert.equal(done.run.status, 'completed');
  assert.equal(f.rules.read().exists, false); assert.equal(f.application.rulesTrust.get(f.projectId), null);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mio_rule_writes').get()!.n, 0);
});

test('an old notes call is rejected before visibility/preparation and hands back replanning', async t => {
  const f = await fixture(t);
  f.respond(index => output('chat_completions', index === 1 ? [{id: 'old-notes', name: 'mioon_project_notes_set', arguments: {notes: 'must not write AGENTS'}}] : []));
  const sent = await f.send(), done = await f.settle(sent.run.id);
  assert.equal(done.run.status, 'completed'); assert.equal(done.steps.find(step => step.kind === 'tool')!.error!.code, 'TOOL_RETIRED');
  assert.equal(f.rules.read().exists, false); assert.equal(f.requests.length, 2); assert.ok(f.requests[1]!.includes('TOOL_RETIRED'));
});

test('a retired notes call invalidates its batch suffix before any rules approval or dispatch', async t => {
  const f = await fixture(t);
  f.respond(index => output('chat_completions', index === 1 ? [
    {id: 'retired-first', name: 'mioon_project_notes_set', arguments: {notes: 'Old instruction'}},
    {id: 'rules-suffix', name: 'mioon_project_rules_set', arguments: {expectedHash: null, proposedText: 'Suffix must not execute'}},
  ] : []));
  const sent = await f.send(), done = await f.settle(sent.run.id);
  assert.equal(done.run.status, 'completed'); assert.equal(f.rules.read().exists, false);
  assert.equal(done.steps.filter(step => step.kind === 'tool').length, 1);
  assert.equal(done.steps.find(step => step.kind === 'tool')!.error!.code, 'TOOL_RETIRED');
  assert.ok(f.requests[1]!.includes('rules-suffix')); assert.ok(f.requests[1]!.includes('TARGET_CHANGED'));
});

test('model arguments cannot grant approval, trust or another project/path authority', async t => {
  const authorities: {fields: Record<string, AgentTaskJson>; code: string}[] = [
    {fields: {approved: true}, code: 'AGENT_TASK_INVALID_TOOL'}, {fields: {trust: true}, code: 'VALIDATION_ERROR'},
    {fields: {projectId: randomUUID()}, code: 'AGENT_TASK_INVALID_TOOL'}, {fields: {path: '/private/tmp/AGENTS.md'}, code: 'VALIDATION_ERROR'},
  ];
  for (const authority of authorities) {
    const f = await fixture(t);
    f.respond(index => output('chat_completions', index === 1 ? [{id: randomUUID(), name: 'mioon_project_rules_set', arguments: {expectedHash: null, proposedText: 'Never applied', ...authority.fields}}] : []));
    const sent = await f.send(), done = await f.settle(sent.run.id);
    assert.equal(f.rules.read().exists, false); assert.equal(done.steps.find(step => step.kind === 'tool')!.error!.code, authority.code);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mio_rule_writes').get()!.n, 0);
  }
});

test('unknown publication pauses without a second model call or blind retry', async t => {
  const f = await fixture(t, 'chat_completions', {onPhase: phase => {if (phase === 'published') throw new Error('Injected publication gap');}});
  f.respond(index => output('chat_completions', index === 1 ? [{id: 'unknown-rules', name: 'mioon_project_rules_set', arguments: {expectedHash: null, proposedText: 'Published but pending'}}] : []));
  const sent = await f.send(), awaiting = await f.settle(sent.run.id), step = awaiting.steps.find(item => item.kind === 'tool')!;
  await f.action(awaiting, 'approve', {stepId: step.id}); const paused = await f.settle(sent.run.id);
  assert.equal(paused.run.status, 'paused'); assert.equal(paused.run.pauseReason, 'unknown_outcome');
  assert.equal(paused.steps.find(item => item.id === step.id)!.status, 'unknown');
  assert.equal(f.requests.length, 1); assert.equal(f.rules.read().trust, 'pending');
  await assert.rejects(f.action(paused, 'resume'), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  assert.equal(f.requests.length, 1);
});

test('a failed acceptance rolls back rules snapshot, blob and run in the same transaction', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'mio-rules-atomic-')), store = openStore(root);
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  store.put('projects', {id: store.projectId, name: 'Atomic rules'});
  const journal = createMioJournal(store, {policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY)});
  const snapshot = {version: 1 as const, project: {text: 'Frozen atomic rules', hash: hash('Frozen atomic rules')}, user: null, message: {role: 'user' as const, content: 'Frozen atomic rules'}};
  const before = store.db.prepare('SELECT count(*) AS n FROM mio_blobs').get()!.n;
  store.db.exec("CREATE TEMP TRIGGER reject_rules_snapshot BEFORE INSERT ON mio_entries WHEN NEW.kind='rules_snapshot' BEGIN SELECT RAISE(ABORT,'injected rules failure'); END");
  assert.throws(() => journal.create({requestId: randomUUID(), projectId: store.projectId, text: 'Atomic send', configuration: {protocol: 'chat_completions', model: 'synthetic'}, rulesSnapshot: snapshot}), /injected rules failure/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mio_blobs').get()!.n, before);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mio_runs').get()!.n, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM mio_entries').get()!.n, 0);
});
