import {withoutForeignKeys} from './helpers/project-database.ts';
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {openStore,openLegacyWorkspaceStore} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {validateAgentTaskModelRequestReferences} from '../packages/business/src/agent/task-model-requests-v2.ts';
import type {AgentTaskEvent, AgentTaskJson, AgentTaskStep} from '../packages/contracts/src/agent-tasks-v2.ts';

const format = 'mioon-model-request-ref/1';
const maxDecodedEventPageBytes = 8 * 1024 * 1024;
const json = (value: unknown): AgentTaskJson => JSON.parse(JSON.stringify(value)) as AgentTaskJson;
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
// The inline/ref event format is an explicit workspace compatibility profile.
// Native K1 coverage below exercises R1's canonical entries and light notices.
function legacyFixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'mioon-agent-storage-dedup-v2-'));
  let store = openLegacyWorkspaceStore(root), journal = createAgentTaskJournal(store);
  const foreignStore = openLegacyWorkspaceStore(join(root,'foreign')), foreignJournal = createAgentTaskJournal(foreignStore);
  t.after(() => {store.close(); foreignStore.close(); rmSync(root, {recursive: true, force: true});});
  const projectId = randomUUID(), foreignProjectId = randomUUID(), date = new Date().toISOString();
  for (const [selected,id] of [[store,projectId],[foreignStore,foreignProjectId]] as const) {
    selected.put('projects', {id, name:'Storage source', revision: 1, createdAt: date, updatedAt: date});
  }
  const run = journal.create({requestId: randomUUID(), projectId, text: 'Synthetic storage regression', configuration: {protocol: 'chat_completions'}}).run;
  function rawEvents(runId = run.id) {
    return store.db.prepare('SELECT runId,projectId,sequence,type,data FROM agent_task_events_v2 WHERE runId=? ORDER BY sequence').all(runId);
  }
  function insertEvent(data: AgentTaskJson, {runId = run.id, owner = projectId, type = 'step'}: {runId?: string; owner?: string; type?: string} = {}) {
    const sequence = Number(store.db.prepare('SELECT COALESCE(max(sequence),0)+1 AS n FROM agent_task_events_v2 WHERE runId=?').get(runId)!.n);
    const event: AgentTaskEvent = {runId, sequence, type, data, createdAt: date};
    store.db.prepare('INSERT INTO agent_task_events_v2(runId,projectId,sequence,type,data) VALUES(?,?,?,?,?)').run(runId, owner, sequence, type, JSON.stringify(event));
    return event;
  }
  return {root, projectId, foreignProjectId, foreignStore, foreignJournal, run,
    get store() {return store;}, get journal() {return journal;}, rawEvents, insertEvent,
    reopen() {store.close(); store = openLegacyWorkspaceStore(root); journal = createAgentTaskJournal(store);},
  };
}
function request(size = 1000): AgentTaskJson {
  const history = [{role: 'system', content: 'Mioon host response language v1: zh-Hant.'},
    {role: 'user', content: `Synthetic retained content 中文🙂 ${'x'.repeat(size)}`}];
  return {body: JSON.stringify({model: 'synthetic-model', stream: true, messages: history.slice(1)}), history};
}
function reference(step: AgentTaskStep, original: AgentTaskJson = step.request!) {
  const encoded = JSON.stringify(original);
  return {format, stepId: step.id, sha256: createHash('sha256').update(encoded).digest('hex'), bytes: Buffer.byteLength(encoded)};
}
function sourceEvents(events: AgentTaskEvent[], id: string) {
  return events.filter(event => event.type === 'step' && record(event.data).id === id);
}

test('legacy workspace: model references and mixed inline evidence stay byte-for-byte unchanged', t => {
  const f = legacyFixture(t), original = request(48 * 1024), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  const legacy = f.insertEvent(json(model)), legacyRow = f.rawEvents().find(row => row.sequence === legacy.sequence)!;
  const expected = reference(model, original);
  f.journal.markDispatch(f.run.id, model.id);
  for (let index = 0; index < 12; index++) f.journal.updateStep(f.run.id, model.id, {data: {checkpoint: index}});
  f.journal.completeStep(f.run.id, model.id, {result: {text: 'Synthetic finished', toolCalls: []}});
  const rows = f.rawEvents(), encoded = rows.filter(row => row.type === 'step' && row.sequence !== legacy.sequence);
  assert.ok(encoded.length >= 15);
  for (const row of encoded) {
    const value = record(JSON.parse(String(row.data)));
    assert.deepEqual(record(value.data).request, expected);
    assert.ok(!String(row.data).includes('Synthetic retained content'));
  }
  assert.deepEqual(f.rawEvents().find(row => row.sequence === legacy.sequence), legacyRow);
  const stored = f.store.db.prepare('SELECT data FROM agent_task_steps_v2 WHERE id=?').get(model.id)!;
  assert.deepEqual(record(JSON.parse(String(stored.data))).request, original);
  const savedRequestBytes = Buffer.byteLength(JSON.stringify(original));
  const compactEventBytes = encoded.reduce((sum, row) => sum + Buffer.byteLength(String(row.data)), 0);
  assert.ok(compactEventBytes < savedRequestBytes / 2, 'Repeated lifecycle events must not duplicate the full request');
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
  assert.throws(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: false}));
  const events = sourceEvents(f.journal.events(f.run.id), model.id);
  assert.ok(events.every(event => JSON.stringify(record(event.data).request) === JSON.stringify(original)));
  assert.equal(record(events[0]!.data).status, 'intent');
  assert.equal(record(events[1]!.data).status, 'intent');
  assert.equal(record(events[2]!.data).status, 'dispatch_started');
  assert.equal(record(events.at(-1)!.data).status, 'completed');
  assert.equal(record(events[0]!.data).result, undefined);
  assert.deepEqual(record(events.at(-1)!.data).result, {text: 'Synthetic finished', toolCalls: []});
  assert.deepEqual(record(events.find(event => event.sequence === legacy.sequence)!.data), model);
});

test('legacy workspace: request hydration has no aliases between events, steps or separate reads', t => {
  const f = legacyFixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  f.journal.markDispatch(f.run.id, model.id); f.journal.completeStep(f.run.id, model.id, {result: {done: true}});
  const events = sourceEvents(f.journal.events(f.run.id), model.id), first = record(record(events[0]!.data).request), second = record(record(events[1]!.data).request);
  assert.notEqual(first, second);
  first.body = 'locally changed'; record((first.history as unknown[])[0]).content = 'locally changed';
  assert.deepEqual(second, original);
  assert.deepEqual(f.journal.step(model.id).request, original);
  assert.ok(sourceEvents(f.journal.events(f.run.id), model.id).every(event => JSON.stringify(record(event.data).request) === JSON.stringify(original)));
});

test('legacy workspace: decoded event pages stay bounded and the sequence probe needs no hydration', t => {
  const f = legacyFixture(t), original = request(180 * 1024), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  f.journal.markDispatch(f.run.id, model.id);
  for (let index = 0; index < 32; index++) f.journal.updateStep(f.run.id, model.id, {data: {checkpoint: index}});
  const raw = f.rawEvents(), expectedSequences = raw.map(row => Number(row.sequence)), seen: number[] = [];
  let after = 0, pages = 0;
  for (;;) {
    const page = f.journal.events(f.run.id, after); if (!page.length) break;
    pages++; assert.ok(page.length <= 2000);
    assert.ok(page.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) <= maxDecodedEventPageBytes);
    assert.equal(page[0]!.sequence, after + 1);
    for (const event of page) {seen.push(event.sequence); assert.ok(event.sequence > after); after = event.sequence;}
  }
  assert.ok(pages > 1, 'Full model requests must count against the decoded page bound');
  assert.deepEqual(seen, expectedSequences);
  assert.equal(f.journal.eventSequence(f.run.id, 0), after);
  assert.equal(f.journal.eventSequence(f.run.id, after), after);
  const invalid = f.insertEvent(json({...model, request: {...reference(model), sha256: 'f'.repeat(64)}}));
  assert.throws(() => f.journal.events(f.run.id, after));
  assert.equal(f.journal.eventSequence(f.run.id, after), invalid.sequence);
});

test('legacy workspace: model requests reject changes or deletion at journal and database boundaries', t => {
  const f = legacyFixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  assert.deepEqual(f.journal.updateStep(f.run.id, model.id, {request: structuredClone(original)}).request, original);
  for (const changed of [{...record(original), body: 'different body'}, {...record(original), history: []}, null, undefined]) {
    const before = f.journal.snapshot(f.run.id), raw = f.rawEvents();
    assert.throws(() => f.journal.updateStep(f.run.id, model.id, {request: changed as AgentTaskJson | undefined}));
    assert.deepEqual(f.journal.snapshot(f.run.id), before); assert.deepEqual(f.rawEvents(), raw);
  }
  const before = f.store.db.prepare('SELECT * FROM agent_task_steps_v2 WHERE id=?').get(model.id)!;
  assert.throws(() => f.store.db.prepare("UPDATE agent_task_steps_v2 SET data=json_set(data,'$.request.body','tampered') WHERE id=?").run(model.id));
  assert.throws(() => f.store.db.prepare("UPDATE agent_task_steps_v2 SET data=json_remove(data,'$.request') WHERE id=?").run(model.id));
  assert.throws(() => f.store.db.prepare('DELETE FROM agent_task_steps_v2 WHERE id=?').run(model.id));
  assert.deepEqual(f.store.db.prepare('SELECT * FROM agent_task_steps_v2 WHERE id=?').get(model.id), before);
  f.journal.markDispatch(f.run.id, model.id); f.journal.completeStep(f.run.id, model.id, {result: {done: true}});
  assert.equal(f.journal.step(model.id).status, 'completed');
});

test('legacy workspace: malformed or wrongly bound model references fail closed without changing evidence', async t => {
  const f = legacyFixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  const foreignRun = f.foreignJournal.create({projectId: f.foreignProjectId, requestId: randomUUID(), text: 'Foreign source', configuration: {}}).run;
  const foreignModel = f.foreignJournal.beginStep(foreignRun.id, {kind: 'model', request: original});
  const tool = f.journal.beginStep(f.run.id, {kind: 'tool', request: original});
  const emptyModel = f.journal.beginStep(f.run.id, {kind: 'model'}), good = reference(model);
  const missingId = randomUUID();
  const cases: Array<[string, AgentTaskJson, {owner?: string; type?: string}?]> = [
    ['source missing', json({...model, id: missingId, request: {...good, stepId: missingId}})],
    ['reference step differs from event step', json({...model, request: {...good, stepId: foreignModel.id}})],
    ['source belongs to another run and project', json({...model, id: foreignModel.id, request: reference(foreignModel)})],
    ['event SQL project differs', json({...model, request: good}), {owner: f.foreignProjectId}],
    ['event data run differs', json({...model, runId: foreignRun.id, request: good})],
    ['source is a tool', json({...tool, kind: 'model', request: reference(tool)})],
    ['source has no request', json({...emptyModel, request: {...good, stepId: emptyModel.id}})],
    ['wrong hash', json({...model, request: {...good, sha256: 'f'.repeat(64)}})],
    ['wrong byte length', json({...model, request: {...good, bytes: good.bytes + 1}})],
    ['non-numeric byte length', json({...model, request: {...good, bytes: String(good.bytes)}})],
    ['unknown reference version', json({...model, request: {...good, format: 'mioon-model-request-ref/2'}})],
    ['inline request mixed with reference', json({...model, request: {...good, ...record(original)}})],
    ['unknown reference field', json({...model, request: {...good, privateData: 'synthetic'}})],
  ];
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
  for (const [name, data, options] of cases) await t.test(name, () => {
    const before = f.rawEvents(), foreignBefore = f.foreignStore.db.prepare('SELECT * FROM agent_task_events_v2 ORDER BY sequence').all(), foreignChanges = f.foreignStore.db.prepare('SELECT total_changes() AS n').get()!.n, rollback = new Error('Rollback only this synthetic invalid reference');
    assert.throws(() => withoutForeignKeys(f.store.db,()=>f.store.tx(() => {
      const event = f.insertEvent(data, options);
      assert.throws(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
      assert.throws(() => f.journal.events(f.run.id, event.sequence - 1));
      throw rollback;
    })), error => error === rollback);
    assert.deepEqual(f.rawEvents(), before);
    assert.deepEqual(f.foreignStore.db.prepare('SELECT * FROM agent_task_events_v2 ORDER BY sequence').all(), foreignBefore);
    assert.equal(f.foreignStore.db.prepare('SELECT total_changes() AS n').get()!.n, foreignChanges);
  });
});

test('legacy workspace: lookalike payloads outside a model step request remain ordinary JSON', t => {
  const f = legacyFixture(t), model = f.journal.beginStep(f.run.id, {kind: 'model', request: request()});
  const lookalike = reference(model), payloads = [
    {type: 'text', data: {kind: 'model', request: lookalike}},
    {type: 'step', data: {kind: 'tool', request: lookalike}},
    {type: 'step', data: {...model, result: {request: lookalike}}},
  ];
  for (const payload of payloads) {
    const event = f.insertEvent(json(payload.data), {type: payload.type});
    const found = f.journal.events(f.run.id, event.sequence - 1)[0]!;
    assert.deepEqual(found.data, payload.data);
  }
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
});

test('legacy workspace: reopening and UNKNOWN recovery preserve the exact source without replacement intent', t => {
  const f = legacyFixture(t), original = request(), model = f.journal.beginStep(f.run.id, {kind: 'model', request: original});
  f.journal.markDispatch(f.run.id, model.id);
  const evidence = f.rawEvents(); f.reopen();
  assert.equal(f.journal.recover(), 1);
  const recovered = f.journal.snapshot(f.run.id);
  assert.equal(recovered.run.status, 'interrupted'); assert.equal(recovered.steps.length, 1);
  assert.equal(recovered.steps[0]!.status, 'unknown'); assert.deepEqual(recovered.steps[0]!.request, original);
  assert.deepEqual(f.rawEvents().slice(0, evidence.length), evidence);
  assert.throws(() => f.journal.resume(f.run.id, recovered.run.revision), {code: 'AGENT_TASK_UNKNOWN_RESULT'});
  assert.equal(f.journal.recover(), 0); assert.equal(f.journal.snapshot(f.run.id).steps.length, 1);
  const states = sourceEvents(f.journal.events(f.run.id), model.id).map(event => record(event.data).status);
  assert.deepEqual(states, ['intent', 'dispatch_started', 'unknown']);
  assert.doesNotThrow(() => validateAgentTaskModelRequestReferences(f.store.db, {allowReferences: true}));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n, 0);
});

function nativeFixture(t:TestContext,size=1000){
  const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-native-request-dedup-')),original=request(size);
  let store=openStore(root),journal=createAgentTaskJournal(store);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  store.put('projects',{id:store.projectId,name:'Canonical native source',revision:1});
  const run=journal.create({requestId:randomUUID(),projectId:store.projectId,text:String(record((record(original).history as AgentTaskJson[])[1]).content),configuration:{protocol:'chat_completions'}}).run;
  const model=journal.beginModelStep(run.id,{request:original},[]);
  return {original,run,model,get store(){return store;},get journal(){return journal;},get records(){return createMioRecords(store);},
    rawEvents(){return store.db.prepare('SELECT * FROM mio_events WHERE runId=? ORDER BY sequence').all(run.id);},
    request(){return createMioRecords(store).request(createMioRecords(store).step(model.id).currentRequestId!);},
    complete(){journal.markDispatch(run.id,model.id);journal.completeStep(run.id,model.id,{result:{text:'Synthetic finished',toolCalls:[],providerOutput:{role:'assistant',content:'Synthetic finished'}}});},
    reopen(){store.close();store=openStore(root);journal=createAgentTaskJournal(store);}};
}

test('native canonical request is immutable and light lifecycle notices never repeat its body or history',t=>{
  const f=nativeFixture(t,48*1024),original=f.request();
  for(let index=0;index<12;index++)f.journal.updateStep(f.run.id,f.model.id,{data:{checkpoint:index}});
  assert.equal(f.request().originalBody,record(f.original).body);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mio_requests WHERE stepId=?').get(f.model.id)!.n,1);
  f.complete();const saved=f.request(),raw=f.rawEvents();
  assert.ok(raw.length>=15);assert.ok(raw.every(row=>Object.keys(row).sort().join(',')==='createdAt,runId,sequence'));
  assert.ok(Buffer.byteLength(JSON.stringify(raw))<Buffer.byteLength(JSON.stringify(f.original))/2);
  assert.doesNotMatch(JSON.stringify(raw),/Synthetic retained content|history|request|providerOutput/u);
  assert.equal(saved.originalBody,null);assert.equal(saved.bodySha256,original.bodySha256);assert.equal(saved.bodyBytes,original.bodyBytes);
  assert.deepEqual(f.journal.step(f.model.id).request,f.original);
  const output=f.records.entries(f.run.id).filter(entry=>entry.kind==='model_output');assert.equal(output.length,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB \'agent_task_*_v2\'').get()!.n,0);
});

test('native request projections share no mutable aliases and light event reads remain zero-write',t=>{
  const f=nativeFixture(t);f.complete();
  const before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const first=record(f.journal.step(f.model.id).request),second=record(f.journal.snapshot(f.run.id).steps[0]!.request);
  assert.notEqual(first,second);first.body='locally changed';record((first.history as unknown[])[0]).content='locally changed';
  assert.deepEqual(second,f.original);assert.deepEqual(f.journal.step(f.model.id).request,f.original);
  assert.ok(f.journal.events(f.run.id).every(event=>event.type==='invalidate'&&event.data===null));
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);
});

test('native notification pages remain bounded, consecutive and complete without hydrating large requests',t=>{
  const f=nativeFixture(t,180*1024),at=new Date().toISOString();
  f.store.tx(()=>{
    const insert=f.store.db.prepare('INSERT INTO mio_events(runId,sequence,createdAt) VALUES(?,?,?)');
    let sequence=f.journal.eventSequence(f.run.id,0);for(let index=0;index<2005;index++)insert.run(f.run.id,++sequence,at);
  });
  const raw=f.rawEvents(),seen:number[]=[];let after=0,pages=0;
  for(;;){const page=f.journal.events(f.run.id,after);if(!page.length)break;pages++;assert.ok(page.length<=2000);
    assert.ok(Buffer.byteLength(JSON.stringify(page))<=maxDecodedEventPageBytes);assert.equal(page[0]!.sequence,after+1);
    for(const event of page){assert.equal(event.data,null);assert.equal(event.type,'invalidate');seen.push(event.sequence);after=event.sequence;}}
  assert.ok(pages>1);assert.deepEqual(seen,raw.map(row=>Number(row.sequence)));
  f.journal.events=()=>{throw new Error('Sequence probe must not hydrate events or model requests');};
  const firstPageEnd=seen[1999]!;
  assert.equal(f.journal.eventSequence(f.run.id,0),firstPageEnd);assert.equal(f.journal.eventSequence(f.run.id,firstPageEnd),after);assert.equal(f.journal.eventSequence(f.run.id,after),after);
});

test('native model requests accept equal projections and reject changed identity, bytes or deletion',t=>{
  const f=nativeFixture(t),original=f.request();
  assert.deepEqual(f.journal.updateStep(f.run.id,f.model.id,{request:structuredClone(f.original)}).request,f.original);
  for(const changed of [{...record(f.original),body:'different'}, {...record(f.original),history:[]},null,undefined]){
    const before=f.journal.snapshot(f.run.id),events=f.rawEvents();
    assert.throws(()=>f.journal.updateStep(f.run.id,f.model.id,{request:changed as AgentTaskJson|undefined}));
    assert.deepEqual(f.journal.snapshot(f.run.id),before);assert.deepEqual(f.rawEvents(),events);
  }
  for(const sql of ['UPDATE mio_requests SET bodySha256=? WHERE id=?','UPDATE mio_requests SET originalBody=? WHERE id=?'])
    assert.throws(()=>f.store.db.prepare(sql).run('f'.repeat(64),original.id));
  assert.throws(()=>f.store.db.prepare('DELETE FROM mio_requests WHERE id=?').run(original.id));
  assert.deepEqual(f.request(),original);f.complete();assert.equal(f.journal.step(f.model.id).status,'completed');
});

test('native malformed request hashes and frozen source bindings fail closed without changing evidence',async t=>{
  const f=nativeFixture(t),original=f.request(),events=f.rawEvents();
  const cases:[string,string,string|number][]=[
    ['wrong hash','bodySha256','f'.repeat(64)],['wrong byte length','bodyBytes',original.bodyBytes+1],
    ['unknown manifest version','inputManifest',JSON.stringify({...original.inputManifest,version:2})],
    ['missing frozen blob','inputManifest',JSON.stringify({...original.inputManifest,toolsBlobHash:'f'.repeat(64)})],
    ['missing frozen entry','inputManifest',JSON.stringify({...original.inputManifest,entryIds:[randomUUID()]})],
  ];
  for(const [label,column,value] of cases)await t.test(label,()=>{
    f.store.db.exec('SAVEPOINT malformed_native_request');
    try{f.store.db.exec('DROP TRIGGER identity_mio_requests');
      assert.throws(()=>{f.store.db.prepare(`UPDATE mio_requests SET ${column}=? WHERE id=?`).run(value,original.id);f.journal.step(f.model.id);});
      // Event sequence is independent of private request integrity.
      assert.equal(f.journal.eventSequence(f.run.id,0),Number(events.at(-1)!.sequence));
    }finally{f.store.db.exec('ROLLBACK TO malformed_native_request; RELEASE malformed_native_request');}
    assert.deepEqual(f.request(),original);assert.deepEqual(f.rawEvents(),events);
  });
});

test('native lookalike reference JSON in a result remains ordinary payload and never becomes a request reference',t=>{
  const f=nativeFixture(t),lookalike={format,stepId:f.model.id,sha256:'f'.repeat(64),bytes:123};
  const payloads:AgentTaskJson[]=[{type:'text',data:{kind:'model',request:lookalike}},{type:'step',data:{kind:'tool',request:lookalike}},{result:{request:lookalike}}];
  for(const payload of payloads){
    let id='';f.store.tx(()=>{id=f.records.appendEntry({id:randomUUID(),runId:f.run.id,kind:'tool_result',createdAt:new Date().toISOString(),payload:{json:payload}}).id;});
    assert.deepEqual(f.records.payload(f.records.entry(id)),payload);
  }
  assert.deepEqual(f.journal.step(f.model.id).request,f.original);assert.ok(f.journal.events(f.run.id).every(event=>event.data===null));
});

test('native UNKNOWN recovery preserves canonical source bytes and never creates a replacement intent',t=>{
  const f=nativeFixture(t);f.journal.markDispatch(f.run.id,f.model.id);
  const original=f.request(),events=f.rawEvents();f.reopen();assert.equal(f.journal.recover(),1);
  const recovered=f.journal.snapshot(f.run.id);assert.equal(recovered.run.status,'interrupted');assert.equal(recovered.steps.length,1);
  assert.equal(recovered.steps[0]!.status,'unknown');assert.deepEqual(recovered.steps[0]!.request,f.original);
  assert.equal(f.request().originalBody,original.originalBody);assert.equal(f.request().bodySha256,original.bodySha256);
  assert.deepEqual(f.rawEvents().slice(0,events.length),events);
  assert.throws(()=>f.journal.resume(f.run.id,recovered.run.revision),{code:'AGENT_TASK_UNKNOWN_RESULT'});
  assert.equal(f.journal.recover(),0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mio_requests').get()!.n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n,0);
});
