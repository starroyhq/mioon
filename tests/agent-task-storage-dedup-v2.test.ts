








import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';

import type {AgentTaskJson} from '../packages/contracts/src/agent-tasks-v2.ts';

const format = 'mioon-model-request-ref/1';
const maxDecodedEventPageBytes = 8 * 1024 * 1024;
const json = (value: unknown): AgentTaskJson => JSON.parse(JSON.stringify(value)) as AgentTaskJson;
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
// The inline/ref event format is an explicit workspace compatibility profile.
// Native K1 coverage below exercises R1's canonical entries and light notices.

function request(size = 1000): AgentTaskJson {
  const history = [{role: 'system', content: 'Mioon host response language v1: zh-Hant.'},
    {role: 'user', content: `Synthetic retained content 中文🙂 ${'x'.repeat(size)}`}];
  return {body: JSON.stringify({model: 'synthetic-model', stream: true, messages: history.slice(1)}), history};
}

















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
