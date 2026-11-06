import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {rulesProposalOf, projectRulesProposalChange, rulesStepApplied} from '../apps/web/src/project-rules-proposal.ts';
import {createAgentTaskClient, createAgentTaskSession, safeAgentTaskProject} from '../apps/web/src/agent-tasks-v2.ts';
import type {AgentTaskClient, AgentTaskPending} from '../apps/web/src/agent-tasks-v2.ts';
import type {AgentTaskControlInput, AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createMioProjectRules} from '../packages/business/src/agent/mio-rules.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createAgentSettings} from '../packages/business/src/agent/settings.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {createAgentTaskRuntime} from '../packages/business/src/agent/task-runtime-v2.ts';
import type {TaskGateway} from '../packages/business/src/agent/task-gateway-v2.ts';
import {putTestAgentConfiguration, testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {createTestAuthorizations, authorizeTestScope} from './helpers/agent-authorizations.ts';
import {LOCALES} from '../packages/i18n/src/index.ts';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const time = '2026-11-05T00:00:00.000Z';
function step(beforeText: string | null, proposedText: string): AgentTaskStep {
  const proposal = {file: 'AGENTS.md', expectedHash: beforeText === null ? null : hash(beforeText), beforeText, proposedText, afterHash: hash(proposedText), diff: {before: beforeText, after: proposedText}};
  return {id: randomUUID(), runId: randomUUID(), position: 1, kind: 'tool', status: 'awaiting_approval', createdAt: time, updatedAt: time, toolCall: {id: 'rules-call', name: 'mioon_project_rules_set', arguments: {expectedHash: proposal.expectedHash, proposedText}}, result: {rulesProposal: proposal}};
}

test('rules proposals come only from the complete host result, never model arguments or a partial diff', () => {
  const original = step('before\r\n', 'after\r\n'), proposal = rulesProposalOf(original); assert.ok(proposal); assert.equal(proposal.beforeText, 'before\r\n'); assert.equal(proposal.proposedText, 'after\r\n');
  assert.equal(rulesProposalOf({...original, result: undefined}), null);
  assert.equal(rulesProposalOf({...original, result: {rulesProposal: {...proposal, file: '../AGENTS.md'}}}), null);
  assert.equal(rulesProposalOf({...original, result: {rulesProposal: {...proposal, diff: {before: 'omitted original', after: proposal.proposedText}}}}), null);
  assert.equal(rulesProposalOf({...original, result: {rulesProposal: {...proposal, beforeText: null}}}), null);
  assert.equal(rulesProposalOf({...original, result: {rulesProposal: {...proposal, proposedText: 'x'.repeat(8193), diff: {...proposal.diff, after: 'x'.repeat(8193)}}}}), null);
  assert.equal(rulesProposalOf({...original, kind: 'model'}), null);
});

test('full proposals preserve multiple sections, new/empty files and CRLF while changes remain bounded', () => {
  const before = '# A\r\nkeep\r\nold\r\n# B\r\nold second\r\n', after = '# A\r\nkeep\r\nnew\r\n# B\r\nnew second\r\n';
  const proposal = rulesProposalOf(step(before, after)); assert.ok(proposal); assert.deepEqual(proposal.diff, {before, after});
  const changed = projectRulesProposalChange(proposal); assert.equal(changed.section, null); assert.deepEqual(changed.lines.map(line => line.kind), ['remove', 'remove', 'remove', 'add', 'add', 'add']); assert.equal(changed.lines.at(-1)?.text, 'new second\r');
  const created = rulesProposalOf(step(null, 'new\n')); assert.ok(created); assert.deepEqual(projectRulesProposalChange(created).lines, [{kind: 'add', text: 'new'}, {kind: 'add', text: ''}]);
  const emptied = rulesProposalOf(step('old', '')); assert.ok(emptied); assert.deepEqual(projectRulesProposalChange(emptied).lines, [{kind: 'remove', text: 'old'}]);
  const lineEnding = rulesProposalOf(step('same\n', 'same\r\n')); assert.ok(lineEnding); assert.deepEqual(projectRulesProposalChange(lineEnding).lines, [{kind: 'remove', text: 'same'}, {kind: 'add', text: 'same\r'}]);
});

test('only the actual completed original-step receipt shows applied; not-applied and foreign receipts do not', () => {
  const original = step(null, 'new'), completed = {...original, status: 'completed' as const, result: {file: 'AGENTS.md', hash: hash('new'), requestId: original.id, state: 'completed'}};
  assert.equal(rulesStepApplied(completed), true);
  assert.equal(rulesStepApplied({...completed, result: {error: {code: 'RULES_NOT_APPLIED'}}}), false);
  assert.equal(rulesStepApplied({...completed, result: {...completed.result, requestId: randomUUID()}}), false);
  assert.equal(rulesStepApplied({...completed, status: 'unknown'}), false);
});

interface RulesRenderer {render(input: unknown, locale: string): string; renderDialog(input: unknown, locale: string): string; displayPath(projectFile?: string): string}
async function renderer(): Promise<RulesRenderer> {
  const fixtures = path.join(rootDirectory, 'tests/fixtures/project-file-ui');
  const result = await build({stdin: {contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ProjectRulesChangeCard,ProjectRulesDialog} from './src/project-file/ProjectRules.tsx'; import {projectRulesDisplayPath} from './src/project-file/ProjectRulesController.tsx'; import {setLocale} from ${JSON.stringify(path.join(fixtures, 'ssr-i18n.tsx'))}; export const displayPath=projectRulesDisplayPath; export function render(input,locale){setLocale(locale);return renderToStaticMarkup(React.createElement(ProjectRulesChangeCard,{...input,onAllow(){},onReject(){}}));} export function renderDialog(input,locale){setLocale(locale);return renderToStaticMarkup(React.createElement(ProjectRulesDialog,{open:true,draft:'edited',onDraftChange(){},maxBytes:8192,path:'AGENTS.md',save:{kind:'idle'},conflict:false,onSave(){},onEnable(){},onLoadLatest(){},onRetry(){},onClose(){},...input}));}`, loader: 'tsx', resolveDir: path.join(rootDirectory, 'apps/web')}, bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', loader: {'.css': 'empty'}, nodePaths: [path.join(rootDirectory, 'apps/web/node_modules')], plugins: [{name: 'rules-proposal-ssr', setup(builder) {
    builder.onResolve({filter: /^@mioon\/ui\/components\/dialog$/}, () => ({path: path.join(fixtures, 'ssr-overlays.tsx')}));
    builder.onResolve({filter: /\/i18n\/I18nProvider\.tsx$/}, () => ({path: path.join(fixtures, 'ssr-i18n.tsx')}));
  }}]});
  const module = {exports: {}}; Function('require', 'module', 'exports', result.outputFiles[0]!.text)(createRequire(import.meta.url), module, module.exports); return module.exports as RulesRenderer;
}

test('rules cards expose whole host text in four languages and never offer unknown/unavailable decisions', async () => {
  const ui = await renderer(), proposal = rulesProposalOf(step('# Rules\nkeep\nold', '# Rules\nkeep\nnew')); assert.ok(proposal);
  for (const locale of LOCALES) {
    const html = ui.render({proposal, change: projectRulesProposalChange(proposal), state: {kind: 'pending'}}, locale);
    assert.ok(html.includes('data-testid="pf-rules-complete"')); assert.ok(html.includes('# Rules\nkeep\nold')); assert.ok(html.includes('# Rules\nkeep\nnew')); assert.ok(html.includes('data-testid="pf-rules-allow"'));
    for (const kind of ['unknown', 'unavailable', 'allowed', 'rejected']) assert.doesNotMatch(ui.render({state: {kind}}, locale), /<button\b/u);
    assert.match(ui.render({proposal, state: {kind: 'pending'}, disabled: true}, locale), /<button\b(?=[^>]*data-testid="pf-rules-allow")(?=[^>]*\sdisabled="")[^>]*>/u);
  }
  assert.equal(ui.displayPath(), 'AGENTS.md'); assert.equal(ui.displayPath('relative/project.mioon'), 'AGENTS.md'); assert.equal(ui.displayPath('/trusted/Project/project.mioon'), '/trusted/Project/AGENTS.md'); assert.equal(ui.displayPath('C:\\trusted\\project.mioon'), 'C:\\trusted\\AGENTS.md');
});

test('pending, unavailable and local-receipt blocked dialogs cannot show an enabled write action', async () => {
  const ui = await renderer();
  for (const locale of LOCALES) for (const trust of ['pending', 'unavailable', 'untrusted'] as const) {
    const html = ui.renderDialog({state: {kind: 'ready', value: {text: 'original', exists: true}}, trust, blocked: true}, locale);
    assert.match(html, /<textarea\b[^>]*readOnly=""/u);
    assert.match(html, /<button\b(?=[^>]*data-testid="pf-rules-(?:save|enable)")(?=[^>]*\sdisabled="")[^>]*>/u);
    assert.doesNotMatch(html, /data-testid="pf-rules-status"[^>]*data-tone="success"/u);
  }
});

async function runtimeFixture(t: TestContext) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'web-rules-approval-')), store = openStore(root), services = createServices(store, new Map()), application = testProjectAppLibrary(store); assert.ok(application);
  await services.call('project.create', {name: 'Real rules approval'});
  const settings = await createAgentSettings({persistence: {load: async () => null, save: async () => {}}});
  await putTestAgentConfiguration(settings, {expectedRevision: 0, configuration: {presetId: 'custom', platformId: 'custom', protocol: 'chat_completions', model: 'synthetic-rules', baseUrl: 'https://harness.example.com'}, secret: {action: 'replace', storage: 'session', value: 'SYNTHETIC_RULES_UI_ONLY'}});
  const authorizations = createTestAuthorizations(() => store, settings); await authorizeTestScope(authorizations, 'project_agent');
  const rules = createMioProjectRules({store, application}), before = 'Before\r\nkeep', after = 'After\r\nkeep'; rules.save({requestId: randomUUID(), expectedHash: null, text: before});
  const tools = createAgentTaskTools({store, services, rules}); let requests = 0;
  const gateway: TaskGateway = async function* (request) {request.beforeSubmit?.(); requests++; const calls = requests === 1 ? [{id: 'rules-proposal', name: 'mioon_project_rules_set', arguments: {expectedHash: hash(before), proposedText: after}}] : []; yield {type: 'done', output: {text: calls.length ? '' : 'Done', toolCalls: calls, providerOutput: {role: 'assistant', content: calls.length ? null : 'Done', ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(call.arguments)}}))} : {})}}};};
  const runtime = createAgentTaskRuntime({store, agentSettings: settings, authorizations, tools, gateway, rules, selfPort: () => 4318});
  runtime.journal.updatePolicy({...runtime.policy(), modes: {read_only: 'direct', local_reversible: 'direct', local_irreversible: 'direct', paid: 'direct'}});
  const sent = await runtime.send(store.projectId, {requestId: randomUUID(), text: 'Change the rules', expectedSettingsRevision: testAgentExecution(await settings.get()).revision}); await runtime.drain();
  const sessions: ReturnType<typeof createAgentTaskSession>[] = [], actions: AgentTaskControlInput[] = []; let loseAck = false;
  const client: AgentTaskClient = {...createAgentTaskClient({fetchImpl: async () => {throw Error('Unexpected browser network request');}}),
    list: async id => safeAgentTaskProject(await runtime.snapshot(id), id), history: async (id, cursor) => runtime.history(id, cursor ?? undefined), conversation: async (id, conversationId, cursor) => runtime.conversation(id, conversationId, cursor ?? undefined), read: async (id, runId) => runtime.get(id, runId),
    action: async (id, input) => {actions.push(input); await runtime.action(id, input.runId, input); await runtime.drain(); if (loseAck) throw Error('Synthetic lost approval ACK'); return runtime.get(id, input.runId);},
    lookup: async (id, pending) => pending.action === 'send' ? runtime.lookup(id, pending.requestId) : runtime.lookupAction(id, pending.runId!, pending.requestId),
    stream: async (_id, _runId, _after, signal) => new Promise<void>(resolve => {if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), {once: true});}),
    conversationPolicy: async (id, conversationId) => ({policy: runtime.conversationPolicy(id, conversationId), readOnly: false}),
  };
  t.after(async () => {for (const session of sessions) session.dispose(); runtime.close(); await runtime.drain(); tools.dispose(); rules.close(); await services.drain(); await settings.close(); store.close(); rmSync(root, {recursive: true, force: true});});
  function session() {const receipts = new Map<string, AgentTaskPending>(); const session = createAgentTaskSession({projectId: store.projectId, client, receipts: {read: id => receipts.get(id) ?? null, write(id, value) {if (value) receipts.set(id, value); else receipts.delete(id);}}}); sessions.push(session); return {session, receipts};}
  return {root, store, runtime, actions, before, after, runId: sent.run.id, session, loseAck: () => {loseAck = true;}};
}

for (const action of ['approve', 'deny'] as const) test(`real browser session ${action} binds the original runtime step, revision and durable control receipt`, async t => {
  const f = await runtimeFixture(t), publicSnapshot = f.runtime.get(f.store.projectId, f.runId), step = publicSnapshot.steps.find(value => value.toolCall?.name === 'mioon_project_rules_set'); assert.ok(step); assert.equal(publicSnapshot.run.status, 'awaiting_approval'); assert.ok(rulesProposalOf(step));
  const {session} = f.session(); await session.load(); const awaiting = session.getState().snapshot; assert.ok(awaiting); assert.equal(awaiting.run.id, f.runId);
  assert.equal(await session.action(action, {stepId: step.id}, f.runId), true); assert.equal(f.actions.length, 1);
  const control = f.actions[0]!; assert.ok(control.action === 'approve' || control.action === 'deny'); assert.equal(control.stepId, step.id); assert.equal(control.expectedRevision, awaiting.run.revision); assert.equal(control.runId, f.runId);
  assert.ok(createMioRecords(f.store).control(control.requestId));
  assert.equal(readFileSync(path.join(f.root, 'AGENTS.md'), 'utf8'), action === 'approve' ? f.after : f.before);
  const done = f.runtime.get(f.store.projectId, f.runId).steps.find(value => value.id === step.id)!; assert.equal(rulesStepApplied(done), action === 'approve'); assert.equal(done.status, action === 'approve' ? 'completed' : 'rejected');
});

test('a real applied approval with lost ACK is checked by its original receipt without a second approval', async t => {
  const f = await runtimeFixture(t), {session, receipts} = f.session(); await session.load(); const step = session.getState().snapshot!.steps.find(value => value.toolCall?.name === 'mioon_project_rules_set')!;
  f.loseAck(); assert.equal(await session.action('approve', {stepId: step.id}, f.runId), false); const pending = session.getState().pending; assert.ok(pending); assert.equal(pending.action, 'approve'); assert.equal(receipts.get(f.store.projectId)?.requestId, f.actions[0]!.requestId);
  assert.equal(readFileSync(path.join(f.root, 'AGENTS.md'), 'utf8'), f.after); assert.equal(await session.action('approve', {stepId: step.id}, f.runId), false); assert.equal(f.actions.length, 1);
  await session.reconcile(); assert.equal(session.getState().pending, null); assert.equal(receipts.size, 0); assert.equal(f.actions.length, 1); assert.ok(rulesStepApplied(session.getState().snapshot!.steps.find(value => value.id === step.id)!));
});
