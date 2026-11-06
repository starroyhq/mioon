import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {createMioJournal} from '../packages/business/src/agent/mio-journal.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createAgentTaskTools} from '../packages/business/src/agent/task-tools-v2.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createMioProjectRules} from '../packages/business/src/agent/mio-rules.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createHash} from 'node:crypto';

type Operation = 'project.rename' | 'project.notes.set';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-project-record-mio-')), store = openStore(root), services = createServices(store, new Map(), {env: {}});
  const project = await services.call('project.create', {name: 'Original metadata'}); assert.ok(object(project));
  const journal = createMioJournal(store, {policy: () => structuredClone(DEFAULT_AGENT_TASK_POLICY)}), records = createMioRecords(store);
  const tools = createAgentTaskTools({store, services, journal});
  t.after(async () => {tools.dispose(); await services.drain(); store.close(); rmSync(root, {recursive: true, force: true});});
  const run = journal.create({requestId: randomUUID(), projectId: store.projectId, text: 'Synthetic metadata edit', configuration: {protocol: 'chat_completions', model: 'synthetic'}}).run;
  function prepare(operation: Operation) {
    const current = store.get('projects', store.projectId); assert.ok(object(current));
    const input = {expectedRevision: Number(current.revision), ...(operation === 'project.rename' ? {name: 'Mio saved metadata'} : {notes: 'Mio 项目说明\nPreserve exact text.'})};
    const call = {id: randomUUID(), name: tools.list().find(tool => tool.operation === operation)!.name, arguments: input};
    const prepared = tools.prepare({projectId: store.projectId, operation, input});
    const history: AgentTaskJson[] = [{role: 'user', content: run.text}];
    const model = journal.beginModelStep(run.id, {request: {body: JSON.stringify({model: 'synthetic', messages: history}), history}, data: {baseline: []}}, []);
    journal.markDispatch(run.id, model.id);
    journal.completeStep(run.id, model.id, {result: {text: '', toolCalls: [call], providerOutput: {role: 'assistant', content: null, tool_calls: [{id: call.id, type: 'function', function: {name: call.name, arguments: JSON.stringify(input)}}]}}});
    const step = journal.beginStep(run.id, {kind: 'tool', tier: prepared.risk, targets: prepared.targets, toolCall: call, data: {sourceModelStepId: model.id}});
    journal.markDispatch(run.id, step.id);
    let recorded = 0;
    return {step, input, current, get recorded() {return recorded;}, execute(failRecording = false) {
      return tools.execute(prepared, {runId: run.id, stepId: step.id, requestId: step.id,
        beforeEffect: () => journal.assertTargets(store.projectId, prepared.targets),
        recordInside: (result, changes) => {
          assert.equal(store.db.isTransaction, true); recorded++;
          journal.completeStepInside(run.id, step.id, {result, changes});
          if (failRecording) throw Object.assign(new Error('Synthetic Mio metadata archive failure'), {code: 'SQLITE_FULL'});
        }});
    }};
  }
  return {store, services, journal, records, run, tools, prepare};
}

for (const operation of ['project.rename'] as const) {
  test(`${operation}: the project ACK stays in its domain and Mio entries/changes share the metadata transaction`, async t => {
    const f = await fixture(t), effect = f.prepare(operation), projectId = f.store.projectId;
    const beforeRevision = f.journal.targetRevision(projectId, 'project', projectId), outcome = await effect.execute();
    assert.equal(outcome.recorded, true); assert.equal(effect.recorded, 1);
    const saved = f.store.get('projects', projectId); assert.ok(object(saved));
    assert.equal(saved.revision, Number(effect.current.revision) + 1);
    assert.equal(f.journal.targetRevision(projectId, 'project', projectId), beforeRevision + 1);
    if (operation === 'project.rename') assert.equal(saved.name, 'Mio saved metadata');
    else assert.equal(saved.notes, 'Mio 项目说明\nPreserve exact text.');
    const receipt = f.store.db.prepare('SELECT projectId,digest,response FROM main.project_mutation_requests WHERE requestId=?').get(effect.step.id);
    assert.equal(receipt?.projectId, projectId); assert.match(String(receipt?.digest), /^[a-f0-9]{64}$/u);
    assert.deepEqual(JSON.parse(String(receipt?.response)), saved);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mio_controls WHERE requestId=?').get(effect.step.id)!.n, 0);
    const step = f.records.step(effect.step.id); assert.ok(step.resultEntryId);
    const entry = f.records.entry(step.resultEntryId); assert.equal(entry.kind, 'tool_result');
    assert.deepEqual(f.records.payload(entry), f.journal.step(effect.step.id).result);
    const changes = f.journal.snapshot(f.run.id).changes.filter(change => change.stepId === effect.step.id);
    assert.equal(changes.length, 1); assert.equal(changes[0]!.operation, operation);
    assert.equal(changes[0]!.targets[0]!.revisionBefore, beforeRevision);
    assert.equal(changes[0]!.targets[0]!.revisionAfter, beforeRevision + 1);
    const beforeReplay = f.journal.snapshot(f.run.id), usage = readMioStorage(f.store.db);
    const replay = {projectId, requestId: effect.step.id, ...effect.input};
    assert.deepEqual(await f.services.call(operation, replay), saved);
    assert.deepEqual(f.journal.snapshot(f.run.id), beforeReplay); assert.deepEqual(readMioStorage(f.store.db), usage);
    await assert.rejects(f.services.call(operation, {...replay, expectedRevision: Number(saved.revision)}), {code: 'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(f.services.call(operation, {...replay, requestId: randomUUID()}), {code: 'REVISION_CONFLICT'});
    assert.deepEqual(f.store.get('projects', projectId), saved);
    assert.deepEqual(f.journal.snapshot(f.run.id), beforeReplay); assert.deepEqual(readMioStorage(f.store.db), usage);
  });

  test(`${operation}: a Mio archive failure rolls metadata, target revision and the exact domain ACK back together`, async t => {
    const f = await fixture(t), effect = f.prepare(operation), projectId = f.store.projectId;
    const before = f.journal.snapshot(f.run.id), usage = readMioStorage(f.store.db), revision = f.journal.targetRevision(projectId, 'project', projectId);
    const contentSequence = f.store.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence;
    await assert.rejects(effect.execute(true), {code: 'SQLITE_FULL'}); assert.equal(effect.recorded, 1);
    assert.deepEqual(f.store.get('projects', projectId), effect.current);
    assert.equal(f.journal.targetRevision(projectId, 'project', projectId), revision);
    assert.equal(f.store.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence, contentSequence);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_mutation_requests WHERE requestId=?').get(effect.step.id)!.n, 0);
    assert.deepEqual(f.journal.snapshot(f.run.id), before); assert.deepEqual(readMioStorage(f.store.db), usage);
    assert.equal(f.store.db.isTransaction, false);
  });
}


test('retired notes reject public writes and preserve historical project and ACK bytes without Mio side effects', async t => {
 const f=await fixture(t),projectId=f.store.projectId,current=f.store.get('projects',projectId);assert.ok(object(current));
 assert.equal(f.tools.list().some(tool=>tool.operation==='project.notes.set'),false);
 const input={projectId,requestId:randomUUID(),expectedRevision:Number(current.revision),notes:'手工项目说明\nPreserve exact text.'};
 assert.throws(()=>f.tools.prepare({projectId,operation:'project.notes.set',input:{expectedRevision:input.expectedRevision,notes:input.notes}}),{code:'AGENT_TASK_TOOL_FORBIDDEN'});
 const saved:Record<string,unknown>={...current,notes:input.notes};f.store.put('projects',saved);
 const response=JSON.stringify(saved,null,2)+'\n',digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 f.store.db.prepare('INSERT INTO project_mutation_requests VALUES(?,?,?,?)').run(input.requestId,projectId,digest,response);
 const before=f.journal.snapshot(f.run.id),usage=readMioStorage(f.store.db),revision=f.journal.targetRevision(projectId,'project',projectId);
 const bytes=f.store.db.prepare('SELECT data FROM projects WHERE id=?').get(projectId)!.data,changes=f.store.db.prepare('SELECT total_changes() n').get()!.n;
 assert.ok(object(saved));assert.equal(saved.notes,input.notes);assert.equal(saved.revision,input.expectedRevision);
 assert.equal(f.journal.targetRevision(projectId,'project',projectId),revision);
 const receipt=f.store.db.prepare('SELECT projectId,digest,response FROM main.project_mutation_requests WHERE requestId=?').get(input.requestId);
 assert.equal(receipt?.projectId,projectId);assert.match(String(receipt?.digest),/^[a-f0-9]{64}$/u);assert.deepEqual(JSON.parse(String(receipt?.response)),saved);
 await assert.rejects(f.services.call('project.notes.set',input),{code:'UNKNOWN_OPERATION',status:404});
 await assert.rejects(f.services.call('project.notes.set',{...input,expectedRevision:Number(saved.revision)}),{code:'UNKNOWN_OPERATION',status:404});
 await assert.rejects(f.services.call('project.notes.set',{...input,requestId:randomUUID()}),{code:'UNKNOWN_OPERATION',status:404});
 assert.equal(f.store.db.prepare('SELECT data FROM projects WHERE id=?').get(projectId)!.data,bytes);
 assert.equal(f.store.db.prepare('SELECT response FROM project_mutation_requests WHERE requestId=?').get(input.requestId)!.response,response);
 assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);assert.equal(existsSync(join(f.store.projectDir,'AGENTS.md')),false);
 assert.deepEqual(f.journal.snapshot(f.run.id),before);assert.deepEqual(readMioStorage(f.store.db),usage);
});

test('a real rules intent failure rolls back before file publication and leaves project/Mio evidence unchanged',async t=>{
 const f=await fixture(t),projectId=f.store.projectId,current=f.store.get('projects',projectId);assert.ok(object(current));
 const before=f.journal.snapshot(f.run.id),usage=readMioStorage(f.store.db),revision=f.journal.targetRevision(projectId,'project',projectId);
 const sequence=f.store.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence,requestId=randomUUID();
 const application=testProjectAppLibrary(f.store);assert.ok(application);
 const rules=createMioProjectRules({store:f.store,application});t.after(()=>rules.close());
 f.store.db.exec("CREATE TEMP TRIGGER test_rules_intent_full BEFORE INSERT ON main.mio_rule_writes BEGIN SELECT RAISE(ABORT,'Synthetic rules intent failure');END;");
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'must roll back'}),/Synthetic rules intent failure/u);
 assert.deepEqual(f.store.get('projects',projectId),current);
 assert.equal(f.journal.targetRevision(projectId,'project',projectId),revision);
 assert.equal(f.store.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence,sequence);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_mutation_requests WHERE requestId=?').get(requestId)!.n,0);
 assert.deepEqual(f.journal.snapshot(f.run.id),before);assert.deepEqual(readMioStorage(f.store.db),usage);assert.equal(f.store.db.isTransaction,false);
 assert.equal(existsSync(join(f.store.projectDir,'AGENTS.md')),false);assert.equal(application.rulesTrust.get(projectId),null);
 f.store.db.exec('DROP TRIGGER temp.test_rules_intent_full');
 const saved=rules.save({requestId,expectedHash:null,text:'real AGENTS rules'});assert.equal(saved.trust,'trusted');assert.equal(readFileSync(join(f.store.projectDir,'AGENTS.md'),'utf8'),'real AGENTS rules');
});
