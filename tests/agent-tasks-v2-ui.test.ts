import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTaskClient, createAgentTaskSession, createAgentTaskReceiptStore, safeAgentTaskSnapshot } from '../apps/web/src/agent-tasks-v2.ts';
import type { AgentTaskClient, AgentTaskLookup, AgentTaskPending, AgentTaskProjectSnapshot, AgentTaskReceiptStore, AgentTaskSessionState } from '../apps/web/src/agent-tasks-v2.ts';
import type { AgentTaskEvent, AgentTaskSnapshot } from '../packages/contracts/src/agent-tasks-v2.ts';
import { DEFAULT_AGENT_TASK_POLICY } from '../packages/contracts/src/agent-tasks-v2.ts';
import { agentTaskCloseState,createAgentTaskCloseReporter } from '../apps/web/src/native-close-sources.ts';
import { createNativeCloseRegistry,createNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';

const projectId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222', stepId = '33333333-3333-4333-8333-333333333333', time = '2026-10-20T00:00:00.000Z';
const snapshot = (status: AgentTaskSnapshot['run']['status'] = 'completed', revision = 1): AgentTaskSnapshot => ({ run: { id: runId, projectId, requestId: crypto.randomUUID(), text: 'test task', status, revision, stepLimit: 30, budget: 30, stepsUsed: 1, configuration: {}, createdAt: time, updatedAt: time }, steps: [], changes: [] });
const project = (): AgentTaskProjectSnapshot => ({ version: 2, instanceId: '44444444-4444-4444-8444-444444444444', projectId, runs: [], policy: structuredClone(DEFAULT_AGENT_TASK_POLICY), authorization: { revision: 1, scopes: ['project_agent'] }, settings: { revision: 0, configuration: { presetId: 'openai', platformId: 'global', baseUrl: 'https://example.invalid/v1', model: 'synthetic', protocol: 'responses' }, secret: { configured: false, storage: 'none' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: null }, presets: [], scope: 'settings_only', verification: 'not_tested' } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function fixture(patch: Partial<AgentTaskClient> = {}, saved?: AgentTaskPending, onChangeApplied: (snapshot: AgentTaskSnapshot) => void = () => {}, options:{onChange?:(state:AgentTaskSessionState)=>void;receipts?:AgentTaskReceiptStore}={}) {
  const receipts = new Map<string, AgentTaskPending>(); if (saved) receipts.set(projectId, saved);
  const store: AgentTaskReceiptStore = { read: id => receipts.get(id) ?? null, write(id, value) { if (value) receipts.set(id, value); else receipts.delete(id); } };
  const streams: { signal: AbortSignal; onEvent: (event: AgentTaskEvent) => void }[] = [], sent: unknown[] = [], actions: unknown[] = [];
  const client: AgentTaskClient = {
    history: async()=>({runs:[],nextCursor:null}), list: async () => project(), read: async () => snapshot(), send: async (_, input) => { sent.push(input); return snapshot('running'); }, action: async (_, input) => { actions.push(input); return snapshot('paused', 2); }, lookup: async () => ({ found: false }), authorize: async () => {},
    stream: async (_, __, ___, signal, onEvent) => { streams.push({ signal, onEvent }); return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    policy: async () => ({policy:structuredClone(DEFAULT_AGENT_TASK_POLICY),readOnly:false}), savePolicy: async value => ({policy:value,readOnly:false}), lookupPolicy: async () => ({ found: false,readOnly:false }), upload: async (_, input) => ({ id: stepId, name: input.name, mimeType: input.mimeType, status: 'staged' }), ...patch,
  };
  const session = createAgentTaskSession({ projectId, client, receipts: options.receipts??store, onChange:options.onChange??(()=>{}),onChangeApplied }); return { session, receipts, client, sent, actions, streams };
}
function closeFixture(t:TestContext,patch:Partial<AgentTaskClient>={},saved?:AgentTaskPending,receipts?:AgentTaskReceiptStore){
  const registry=createNativeCloseRegistry(),reporter=createAgentTaskCloseReporter(registry),documentURL='http://127.0.0.1:4318/?project='+projectId;
  const f=fixture(patch,saved,()=>{},{onChange:state=>reporter.publish(state),...(receipts?{receipts}:{})});reporter.publish(f.session.getState());
  const admission=createNativeCloseAdmission({registry,settings:createSettingsNavigationRegistry(),readScope:()=>projectId,readDocumentURL:()=>documentURL,now:()=>1000});
  t.after(()=>{f.session.dispose();reporter.release();admission.dispose();});return {...f,registry,reporter,admission,documentURL};
}

test('a verified-empty receipt and failed initial read allow normal native close or reload without discarding work',async t=>{
  const held=deferred<AgentTaskProjectSnapshot>();let reads=0;
  const f=closeFixture(t,{list:async()=>{reads++;return held.promise;}});
  assert.equal(f.admission.inspect().disposition,'blocked','initial read is busy before any async result');
  const loading=f.session.load();assert.equal(f.admission.inspect().disposition,'blocked');held.reject(new Error('offline'));await loading;
  assert.equal(f.session.getState().phase,'read_error');assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().snapshot,null);
  f.session.setVisible(false);assert.equal(f.admission.inspect().disposition,'clean','hiding keeps the known read-only failure safe');
  for(const action of ['close','reload'] as const){
    const targetUrl=action==='reload'?f.documentURL:null,ticket=f.admission.inspect(action,targetUrl);assert.equal(ticket.disposition,'clean');
    assert.equal(f.admission.commit(ticket.token,{action,targetUrl,discardDirty:false,allowDrainFailure:false,expiresAt:1500}),true);
    let prevented=false;assert.equal(f.admission.beforeUnload({returnValue:'',preventDefault(){prevented=true;}}),true);assert.equal(prevented,false);
  }
  assert.equal(reads,1);assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);
});

test('read failures preserve draft confirmation and a retry invalidates the previous native close ticket',async t=>{
  const held=deferred<AgentTaskProjectSnapshot>();let reads=0;
  const f=closeFixture(t,{list:async()=>{if(++reads===1)throw new Error('offline');return held.promise;}});await f.session.load();f.session.edit('keep this draft');
  const ticket=f.admission.inspect();assert.equal(ticket.disposition,'dirty');assert.equal(f.admission.commit(ticket.token,{discardDirty:false,allowDrainFailure:false,expiresAt:1500}),false);
  const retry=f.session.load();assert.equal(f.admission.inspect().disposition,'blocked');assert.equal(f.admission.commit(ticket.token,{discardDirty:true,allowDrainFailure:false,expiresAt:1500}),false);
  held.resolve(project());await retry;assert.equal(f.session.getState().phase,'ready');assert.equal(f.session.getState().draft,'keep this draft');assert.equal(f.admission.inspect().disposition,'dirty');assert.equal(f.sent.length,0);
});

test('receipt storage failures and pending requests never become a safe read error',async t=>{
  let reads=0;const client={list:async()=>{reads++;throw new Error('offline');}};
  const unavailable=closeFixture(t,client,undefined,{read(){throw new Error('storage unavailable');},write(){throw new Error('must not write');}});
  await unavailable.session.load();assert.equal(unavailable.session.getState().phase,'error');assert.equal(unavailable.session.getState().error,'LOCAL_RECEIPT_UNAVAILABLE');assert.equal(unavailable.admission.inspect().disposition,'blocked');assert.equal(reads,0);
  const pending:AgentTaskPending={requestId:crypto.randomUUID(),runId,action:'pause'},unconfirmed=closeFixture(t,client,pending);
  await unconfirmed.session.load();assert.equal(unconfirmed.session.getState().phase,'unknown');assert.deepEqual(unconfirmed.session.getState().pending,pending);unconfirmed.session.setVisible(false);assert.equal(unconfirmed.admission.inspect().disposition,'blocked');assert.equal(unconfirmed.sent.length,0);assert.equal(unconfirmed.actions.length,0);
});

test('a failed task selection retains unknown-step close protection while ordinary read errors remain recoverable',async t=>{
  for(const unknown of [false,true]){
    const saved=snapshot(unknown?'interrupted':'completed');if(unknown)saved.steps=[{id:stepId,runId,position:1,kind:'model',status:'unknown',createdAt:time,updatedAt:time}];
    const held=deferred<AgentTaskSnapshot>();let reads=0;
    const f=closeFixture(t,{list:async()=>({...project(),runs:[saved.run]}),read:async()=>++reads===1?saved:held.promise});await f.session.load();
    const selection=f.session.select(crypto.randomUUID());assert.equal(f.admission.inspect().disposition,'blocked');held.reject(new Error('offline selection'));await selection;
    assert.equal(f.session.getState().phase,'read_error');assert.equal(f.session.getState().snapshot?.run.id,runId);assert.equal(f.admission.inspect().disposition,unknown?'blocked':'clean');assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);
  }
});

test('an unknown send and late reads from a replaced session cannot clear the current native owner',async t=>{
  const f=closeFixture(t,{send:async()=>{throw new Error('lost ACK');},lookup:async()=>({found:false})});await f.session.load();f.session.edit('send once');await f.session.send();assert.equal(f.session.getState().phase,'unknown');f.session.setVisible(false);assert.equal(f.admission.inspect().disposition,'blocked');
  const held=deferred<AgentTaskProjectSnapshot>(),old=closeFixture(t,{list:async()=>held.promise}),loading=old.session.load();old.session.dispose();
  const replacement=createAgentTaskCloseReporter(old.registry);replacement.publish({draft:'',phase:'submitting',pending:{requestId:crypto.randomUUID(),runId:null,action:'send'},snapshot:null});
  t.after(()=>replacement.release());held.resolve(project());await loading;old.reporter.release();assert.equal(old.admission.inspect().disposition,'blocked');assert.equal(old.sent.length,0);assert.equal(old.actions.length,0);
});

test('send stores identity synchronously, blocks double-send, and never retries a lost acknowledgment', async () => {
  const held = deferred<AgentTaskSnapshot>(); let posts = 0, found: AgentTaskLookup = { found: false };
  const f = fixture({ send: async () => { posts++; return held.promise; }, lookup: async () => found }); await f.session.load(); f.session.edit('original task'); const sending = f.session.send(); assert.equal(f.receipts.size, 1); assert.equal(await f.session.send(), false); assert.equal(posts, 1);
  held.reject(new Error('private provider body')); await sending; assert.equal(f.session.getState().phase, 'unknown'); assert.equal(f.session.getState().draft, 'original task');
  await f.session.reconcile(); assert.equal(f.session.getState().phase, 'unknown'); assert.equal(posts, 1); assert.equal(f.receipts.size, 1);
  found = { found: true, snapshot: snapshot('running') }; await f.session.reconcile(); assert.equal(f.receipts.size, 0); assert.equal(posts, 1); f.session.dispose();
});

test('a failed local receipt write blocks the POST', async () => {
  let posts = 0; const f = fixture({ send: async () => { posts++; return snapshot(); } });
  const session = createAgentTaskSession({ projectId, client: f.client, receipts: { read: () => null, write() { throw new Error('quota'); } } }); await session.load(); session.edit('task'); assert.equal(await session.send(), false); assert.equal(posts, 0); session.dispose(); f.session.dispose();
});

test('reopening a pending control queries its receipt and never issues another mutation', async () => {
  const pending: AgentTaskPending = { requestId: crypto.randomUUID(), runId, action: 'undo_all' }; let reads = 0;
  const f = fixture({ lookup: async (_, input) => { reads++; assert.deepEqual(input, pending); return { found: true, snapshot: snapshot('paused', 5) }; } }, pending);
  await f.session.load(); assert.equal(reads, 1); assert.equal(f.actions.length, 0); assert.equal(f.session.getState().snapshot?.run.revision, 5); assert.equal(f.receipts.size, 0); f.session.dispose();
});

test('paused and awaiting approval streams remain subscribed; duplicate and late project callbacks cannot mutate the selected task', async () => {
  const f = fixture({ read: async () => snapshot('paused') }); await f.session.load(); f.session.edit('task'); await f.session.send(); assert.equal(f.streams.length, 1);
  const stream = f.streams[0]!, event = (sequence: number, status: AgentTaskSnapshot['run']['status']): AgentTaskEvent => ({ runId, sequence, type: 'snapshot', data: snapshot(status, sequence) as unknown as AgentTaskEvent['data'], createdAt: time });
  stream.onEvent(event(1, 'paused')); assert.equal(stream.signal.aborted, false); stream.onEvent(event(2, 'awaiting_approval')); assert.equal(stream.signal.aborted, false); stream.onEvent(event(2, 'completed')); assert.equal(f.session.getState().snapshot?.run.status, 'awaiting_approval');
  stream.onEvent(event(3, 'completed')); assert.equal(stream.signal.aborted, true); assert.equal(f.session.getState().snapshot?.run.status, 'completed'); f.session.dispose(); stream.onEvent(event(4, 'running')); assert.equal(f.session.getState().snapshot?.run.status, 'completed');
});

test('received snapshots enforce project, run and child ownership', () => {
  const next = snapshot(); assert.equal(safeAgentTaskSnapshot(next, projectId).run.id, runId); assert.throws(() => safeAgentTaskSnapshot(next, crypto.randomUUID()));
  assert.throws(() => safeAgentTaskSnapshot({ ...next, steps: [{ id: stepId, runId: crypto.randomUUID(), position: 1, kind: 'tool', status: 'completed', createdAt: time, updatedAt: time }] }, projectId));
});

test('staged uploads send only handles with a task, never bytes or file paths', async () => {
  const uploads: unknown[] = []; const f = fixture({ upload: async (_, input) => { uploads.push(input); return { id: stepId, name: input.name, mimeType: input.mimeType, status: 'staged' }; } }); await f.session.load();
  await f.session.upload({ name: 'sample.txt', type: 'text/plain', size: 3, arrayBuffer: async () => Uint8Array.from([65, 66, 67]).buffer }); assert.equal((uploads[0] as { dataBase64: string }).dataBase64, 'QUJD');
  f.session.edit('Use the selected file'); await f.session.send(); assert.deepEqual((f.sent[0] as { uploads: string[] }).uploads, [stepId]); assert.doesNotMatch(JSON.stringify(f.sent), /dataBase64|QUJD|sample\.txt/); f.session.dispose();
});

test('restored snapshots are viewable but cannot send, upload, authorize or control', async () => {
  let writes = 0; const f = fixture({ list: async () => ({ ...project(), readOnly: true }), authorize: async () => { writes++; }, action: async () => { writes++; return snapshot(); } }); await f.session.load(); f.session.edit('task'); assert.equal(await f.session.send(), false); assert.equal(await f.session.authorize(), false); assert.equal(await f.session.action('stop'), false); assert.equal(writes, 0); f.session.dispose();
});

test('native close includes pending task and unknown result metadata and accepts the v2 source', () => {
  const registry = createNativeCloseRegistry(), source = registry.register('agent-task-v2'); source.update({ dirty: false, busy: false, blocked: true, version: 1 }); assert.equal(registry.capture().length, 1);
  const state = agentTaskCloseState({ draft: 'new text', phase: 'ready', pending: null, snapshot: { run: { id: runId, status: 'interrupted' }, steps: [{ id: stepId, status: 'unknown' }] } }); assert.equal(state.blocked, true); assert.equal(state.dirty, true); source.release();
});

test('HTTP routes keep credentials same-origin and expose no provider error body', async () => {
  const calls: { url: string; init: RequestInit }[] = []; const client = createAgentTaskClient({ fetchImpl: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return Response.json({ ok: true, data: { found: false } }); } });
  await client.lookup(projectId, { requestId: stepId, runId, action: 'pause' }); await client.lookup(projectId, { requestId: stepId, runId: null, action: 'send' });
  assert.equal(calls[0]?.url, `/api/agent/tasks/v2/${projectId}/${runId}/actions/${stepId}`); assert.equal(calls[1]?.url, `/api/agent/tasks/v2/${projectId}/requests/${stepId}`); assert.ok(calls.every(call => call.init.credentials === 'same-origin' && call.init.method === 'GET'));
  const failed = createAgentTaskClient({ fetchImpl: async () => Response.json({ ok: false, error: { code: 'PRIVATE SECRET', message: 'private credential' } }, { status: 502 }) }); await assert.rejects(failed.read(projectId, runId), error => error instanceof Error && !error.message.includes('private credential'));
});

test('the actual SSE transport validates and strips its wire ID before strict event parsing',async()=>{
  const event={id:3,runId,sequence:3,type:'changed',data:{revision:8},createdAt:time};const wire=`id: 3\nevent: changed\ndata: ${JSON.stringify(event)}\n\n`;
  const client=createAgentTaskClient({fetchImpl:async()=>new Response(wire,{headers:{'Content-Type':'text/event-stream'}})}),events:AgentTaskEvent[]=[];
  await client.stream(projectId,runId,0,new AbortController().signal,value=>events.push(value));assert.equal(events[0]?.sequence,3);assert.equal(Object.hasOwn(events[0]!,'id'),false);
});

test('an explicit stale CAS rejection checks the original receipt, unlocks only after proven nonacceptance and retains the draft', async()=>{
  let posts=0,lookups=0,lists=0;const f=fixture({list:async()=>{lists++;return project();},send:async()=>{posts++;throw Object.assign(new Error('safe failure'),{code:'AGENT_TASK_CHANGED',definitive:true});},lookup:async()=>{lookups++;return{found:false};}});
  await f.session.load();f.session.edit('retained manual intent');assert.equal(await f.session.send(),false);assert.equal(posts,1);assert.equal(lookups,1);assert.equal(lists,2);assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().draft,'retained manual intent');assert.equal(f.session.getState().phase,'ready');f.session.dispose();
});
test('a partial undo rejection adopts its exact blocked receipt and preserves completed progress',async()=>{
  const f=fixture({list:async()=>({...project(),runs:[snapshot('paused').run]}),action:async()=>{throw Object.assign(new Error('safe conflict'),{code:'AGENT_TASK_TARGET_CHANGED',definitive:true});},lookup:async(_,pending)=>({found:true,snapshot:snapshot('paused',8),receipt:{requestId:pending.requestId,runId,action:'undo_all',revision:8,result:{state:'blocked',reverted:1}}})});
  await f.session.load();await f.session.action('undo_all');assert.equal(f.session.getState().snapshot?.run.revision,8);assert.equal(f.session.getState().error,'REQUEST_BLOCKED');assert.equal(f.session.getState().pending,null);f.session.dispose();
});
test('an undo receipt still pending never unlocks another mutation or claims the entire undo finished',async()=>{
  const pending:AgentTaskPending={requestId:crypto.randomUUID(),runId,action:'undo_all'};const f=fixture({lookup:async()=>({found:true,snapshot:snapshot('paused',8),receipt:{requestId:pending.requestId,runId,action:'undo_all',revision:8,result:{state:'pending',reverted:1}}})},pending);await f.session.load();assert.equal(f.session.getState().phase,'unknown');assert.equal(f.session.getState().pending?.requestId,pending.requestId);assert.equal(await f.session.action('undo_all'),false);assert.equal(f.actions.length,0);f.session.dispose();
});
test('a host project refresh caused by a newly observed Change preserves text typed into the same task session',async()=>{
  let applied=0;const f=fixture({},undefined,()=>{applied++;});await f.session.load();f.session.edit('first');await f.session.send();const before=applied;f.session.edit('new text while AI runs');const next=snapshot('paused',3);next.changes=[{id:crypto.randomUUID(),runId,stepId,projectId,operation:'shot.create',targets:[{kind:'shot',id:crypto.randomUUID(),revision:1}],before:null,after:null,reversible:true,status:'applied',createdAt:time}];const stream=f.streams[0]!;stream.onEvent({runId,sequence:1,type:'snapshot',createdAt:time,data:next as unknown as AgentTaskEvent['data']});assert.equal(applied,before+1);assert.equal(f.session.getState().draft,'new text while AI runs');f.session.dispose();
});

test('read-only history can page and select older runs without losing already loaded entries',async()=>{
  const oldId=crypto.randomUUID(),oldRun={...snapshot().run,id:oldId};let reads=0;
  const f=fixture({list:async()=>({...project(),readOnly:true}),history:async(_,cursor)=>cursor?{runs:[oldRun],nextCursor:null}:{runs:[snapshot().run],nextCursor:'older'},read:async(_,id)=>{reads++;return{...snapshot(),run:{...snapshot().run,id}};}});
  await f.session.load();await f.session.history();await f.session.history(true);assert.equal(f.session.getState().history.runs.length,2);await f.session.select(oldId);assert.equal(f.session.getState().snapshot?.run.id,oldId);assert.equal(reads,1);assert.equal(f.sent.length,0);f.session.dispose();
});

test('a completed run with pending background work keeps observing late cost and Change records until work settles',async()=>{
  const initial={...snapshot('completed'),backgroundPending:true};const f=fixture({list:async()=>({...project(),runs:[initial.run]}),read:async()=>initial});await f.session.load();assert.equal(f.streams.length,1);const stream=f.streams[0]!;assert.equal(stream.signal.aborted,false);
  const late={...snapshot('completed',2),backgroundPending:true};late.steps=[{id:stepId,runId,position:1,kind:'tool',status:'completed',cost:'submitted',createdAt:time,updatedAt:time}];late.changes=[{id:crypto.randomUUID(),runId,stepId,projectId,operation:'generation.result',targets:[{kind:'shot',id:crypto.randomUUID(),revision:1}],before:null,after:null,reversible:false,status:'applied',createdAt:time}];
  stream.onEvent({runId,sequence:2,type:'snapshot',createdAt:time,data:late as unknown as AgentTaskEvent['data']});assert.equal(stream.signal.aborted,false);assert.equal(f.session.getState().snapshot?.steps[0]?.cost,'submitted');assert.equal(f.session.getState().snapshot?.changes.length,1);
  stream.onEvent({runId,sequence:3,type:'snapshot',createdAt:time,data:{...late,run:{...late.run,revision:3},backgroundPending:false} as unknown as AgentTaskEvent['data']});assert.equal(stream.signal.aborted,true);assert.equal(f.session.getState().snapshot?.backgroundPending,false);f.session.dispose();
});

test('pending task identities remain stable across backend restarts and isolated from restored workspace origins',()=>{
  const values=new Map<string,string>();const storage:Storage={get length(){return values.size;},clear(){values.clear();},getItem:key=>values.get(key)??null,key:index=>[...values.keys()][index]??null,removeItem:key=>{values.delete(key);},setItem:(key,value)=>{values.set(key,value);}};
  const pending:AgentTaskPending={requestId:crypto.randomUUID(),runId,action:'pause'};createAgentTaskReceiptStore(()=>storage,'normal').write(projectId,pending);assert.deepEqual(createAgentTaskReceiptStore(()=>storage,'normal').read(projectId),pending);assert.equal(createAgentTaskReceiptStore(()=>storage,'restored:'+crypto.randomUUID()).read(projectId),null);assert.equal(values.size,1);
});

test('SSE reconnect retries failed durable reads until the network returns, without reposting and with visibility cancellation',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let online=true,reads=0,connections=0;
  const f=fixture({list:async()=>({...project(),runs:[snapshot('running').run]}),read:async()=>{reads++;if(!online)throw new Error('offline');return snapshot('running',reads);},stream:async()=>{connections++;throw new Error('offline stream');}});
  await f.session.load();await flush();online=false;t.mock.timers.tick(1500);await flush();assert.equal(f.session.getState().phase,'detached');assert.equal(reads,2);online=true;t.mock.timers.tick(3000);await flush();assert.equal(reads,3);assert.equal(connections,2);assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);f.session.setVisible(false);const previous=reads;t.mock.timers.tick(60000);await flush();assert.equal(reads,previous);f.session.dispose();
});
test('a durable read failure on an otherwise live stream reconnects even when no later event arrives',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let online=true,reads=0;
  const f=fixture({list:async()=>({...project(),runs:[snapshot('running').run]}),read:async()=>{reads++;if(!online)throw new Error('offline');return snapshot('running',reads);}});
  await f.session.load();online=false;f.streams[0]!.onEvent({runId,sequence:1,type:'changed',data:{revision:2},createdAt:time});await flush();assert.equal(f.streams[0]!.signal.aborted,true);t.mock.timers.tick(1500);await flush();assert.equal(f.session.getState().phase,'detached');online=true;t.mock.timers.tick(3000);await flush();assert.equal(f.session.getState().phase,'ready');assert.equal(f.streams.length,2);f.session.dispose();const previous=reads;t.mock.timers.tick(60000);await flush();assert.equal(reads,previous);assert.equal(f.sent.length,0);
});
