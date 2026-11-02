import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lstatSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openLegacyWorkspaceStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createAgentTaskTools, listDiagnosticAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {assembleRunContext, selectTaskModelTools} from '../packages/business/src/agent/task-context-v2.ts';
import {collectTaskProjectNotes} from '../packages/business/src/agent/task-context-observations-v2.ts';
import {agentTaskToolGroupForName, agentTaskToolNamesForGroup, loadedAgentTaskToolNames,
  parseAgentTaskToolNameLoadInput} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'mio-rules-legacy-')), store = openLegacyWorkspaceStore(root), services = createServices(store, new Map());
  const project = await services.call('project.create', {name: 'Legacy rules isolation'}) as {id: string};
  const journal = createAgentTaskJournal(store), tools = createAgentTaskTools({store, services});
  const run = journal.create({requestId: randomUUID(), projectId: project.id, text: 'Legacy round', configuration: {protocol: 'chat_completions', model: 'synthetic'}}).run;
  t.after(async () => {tools.dispose(); await services.drain(); store.close(); rmSync(root, {recursive: true, force: true});});
  async function execute(name: string, input: AgentTaskJson, toolLoadMode?: 'names' | 'groups') {
    const prepared = tools.prepare({projectId: project.id, operation: name, input, ...(toolLoadMode ? {toolLoadMode} : {})});
    const step = journal.beginStep(run.id, {kind: 'tool', tier: prepared.risk, targets: prepared.targets,
      toolCall: {id: randomUUID(), name, arguments: input}});
    journal.markDispatch(run.id, step.id);
    const outcome = await tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id, beforeEffect() {},
      recordInside: (result, changes) => journal.completeStepInside(run.id, step.id, {result, changes})});
    if (!outcome.recorded) journal.completeStep(run.id, step.id, {result: outcome.result, changes: outcome.changes});
    return outcome.result;
  }
  return {root, store, projectId: project.id, journal, tools, run, execute};
}

test('the real legacy store retains the original catalog, exact-name loader schema and no AGENTS authority', async t => {
  const f = await fixture(t), catalog = f.tools.list();
  assert.deepEqual(catalog, listDiagnosticAgentTaskTools());
  assert.ok(catalog.some(tool => tool.name === 'mioon_project_notes_set'));
  assert.equal(catalog.some(tool => tool.name === 'mioon_project_rules_set'), false);
  const loader = catalog.find(tool => tool.name === 'mioon_tools_load')!.parameters as {properties: {names: {items: {enum: string[]}}}};
  assert.ok(loader.properties.names.items.enum.includes('mioon_project_notes_set'));
  assert.equal(loader.properties.names.items.enum.includes('mioon_project_rules_set'), false);
  assert.deepEqual(parseAgentTaskToolNameLoadInput({names: ['mioon_project_notes_set']}, 'legacy'), ['mioon_project_notes_set']);
  assert.equal(parseAgentTaskToolNameLoadInput({names: ['mioon_project_notes_set']}), null);
  assert.equal(agentTaskToolGroupForName('mioon_project_notes_set', 'legacy'), 'canvas');
  assert.equal(agentTaskToolGroupForName('mioon_project_rules_set', 'legacy'), undefined);
  assert.ok(agentTaskToolNamesForGroup('canvas', 'legacy').includes('mioon_project_notes_set'));
  assert.throws(() => f.tools.prepare({projectId: f.projectId, operation: 'mioon_project_rules_set', input: {expectedHash: null, proposedText: 'No file write'}}), {code: 'AGENT_TASK_TOOL_FORBIDDEN'});
  assert.equal(lstatSync(path.join(f.root, 'AGENTS.md'), {throwIfNoEntry: false}), undefined);
});

test('legacy names loading and execution preserve project.notes without creating an R2 file or tables', async t => {
  const f = await fixture(t);
  assert.equal(selectTaskModelTools(f.tools.list()).some(tool => tool.name === 'mioon_project_notes_set'), false);
  assert.deepEqual(await f.execute('mioon_tools_load', {names: ['mioon_project_notes_set']}), {names: ['mioon_project_notes_set']});
  const steps = f.journal.snapshot(f.run.id).steps;
  assert.deepEqual(loadedAgentTaskToolNames(steps, 'legacy'), ['mioon_project_notes_set']);
  assert.deepEqual(loadedAgentTaskToolNames(steps), []);
  assert.equal(selectTaskModelTools(f.tools.list(), undefined, {steps}).some(tool => tool.name === 'mioon_project_notes_set'), true);
  const project = f.store.get('projects', f.projectId) as {revision: number};
  await f.execute('mioon_project_notes_set', {expectedRevision: project.revision, notes: 'Legacy notes remain reference data'});
  assert.equal(collectTaskProjectNotes(f.store, f.projectId), 'Legacy notes remain reference data');
  const {context} = assembleRunContext({locale: 'en', text: 'Legacy round', projectNotes: collectTaskProjectNotes(f.store, f.projectId)});
  assert.ok(JSON.stringify(context).includes('Legacy notes remain reference data'));
  assert.equal(JSON.stringify(context).includes('mio.context.rules-snapshot'), false);
  assert.equal(lstatSync(path.join(f.root, 'AGENTS.md'), {throwIfNoEntry: false}), undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('mio_rule_writes','mio_blobs')").get()!.n, 0);
});

test('legacy frozen group loading retains notes in canvas and makes only old tools visible', async t => {
  const f = await fixture(t), result = await f.execute('mioon_tools_load', {groups: ['canvas']}, 'groups') as {groups: string[]; tools: string[]};
  assert.deepEqual(result.groups, ['canvas']); assert.ok(result.tools.includes('mioon_project_notes_set'));
  assert.equal(result.tools.includes('mioon_project_rules_set'), false);
  const selected = selectTaskModelTools(f.tools.list(), undefined, {steps: f.journal.snapshot(f.run.id).steps});
  assert.ok(selected.some(tool => tool.name === 'mioon_project_notes_set'));
  assert.equal(selected.some(tool => tool.name === 'mioon_project_rules_set'), false);
});
