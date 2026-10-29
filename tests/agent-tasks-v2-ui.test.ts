import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTaskClient, createAgentTaskSession, createAgentTaskReceiptStore, safeAgentTaskSnapshot } from '../apps/web/src/agent-tasks-v2.ts';
import type { AgentTaskClient, AgentTaskLookup, AgentTaskPending, AgentTaskProjectSnapshot, AgentTaskReceiptStore, AgentTaskSessionState } from '../apps/web/src/agent-tasks-v2.ts';
import type { AgentTaskEvent, AgentTaskSnapshot, AgentTaskLocale } from '../packages/contracts/src/agent-tasks-v2.ts';
import { AGENT_TASK_POLICY_PRESETS, DEFAULT_AGENT_TASK_POLICY } from '../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskConversationPolicy, AgentTaskPolicy, AgentTaskPolicyModes } from '../packages/contracts/src/agent-tasks-v2.ts';
import { agentTaskCloseState,createAgentTaskCloseReporter } from '../apps/web/src/native-close-sources.ts';
import { agentTaskPolicyMenuStep } from '../apps/web/src/agent-task-policy-menu.ts';
import { agentTaskAnswerTextValid, taskAnswerOf, taskQuestionOf } from '../apps/web/src/agent-task-questions.ts';
import { agentTaskWaitingQuestion } from '../apps/web/src/agent-tasks-v2.ts';
import { taskStepTitle } from '../apps/web/src/agent-task-presentation.ts';
import type { AgentTaskJson, AgentTaskStep } from '../packages/contracts/src/agent-tasks-v2.ts';
import { createNativeCloseRegistry,createNativeCloseAdmission } from '../apps/web/src/native-close-state.ts';
import {createSettingsNavigationRegistry} from '../apps/web/src/settings-navigation-state.ts';

const projectId = '11111111-1111-4111-8111-111111111111', runId = '22222222-2222-4222-8222-222222222222', stepId = '33333333-3333-4333-8333-333333333333', time = '2026-10-20T00:00:00.000Z';
const snapshot = (status: AgentTaskSnapshot['run']['status'] = 'completed', revision = 1): AgentTaskSnapshot => ({ run: { id: runId, projectId, requestId: crypto.randomUUID(), text: 'test task', status, revision, stepLimit: 30, budget: 30, stepsUsed: 1, configuration: {}, createdAt: time, updatedAt: time }, steps: [], changes: [] });
const project = (): AgentTaskProjectSnapshot => ({ version: 2, instanceId: '44444444-4444-4444-8444-444444444444', projectId, runs: [], policy: structuredClone(DEFAULT_AGENT_TASK_POLICY), authorization: { revision: 1, scopes: ['project_agent'] }, settings: { revision: 0, configuration: { presetId: 'openai', platformId: 'global', baseUrl: 'https://example.invalid/v1', model: 'synthetic', protocol: 'responses' }, secret: { configured: false, storage: 'none' }, storage: { persistentAvailable: false, sessionScope: 'server', reasonCode: null }, presets: [], scope: 'settings_only', verification: 'not_tested' } });
const conversation=(run:AgentTaskSnapshot['run'])=>({id:run.conversationId??run.id,projectId:run.projectId,title:run.text,createdAt:run.createdAt,updatedAt:run.updatedAt,lastRunId:run.id,lastRunStatus:run.status,changeCount:0,runCount:1});
function deferred<T>() { let resolve!: (value: T) => void, reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
function fixture(patch: Partial<AgentTaskClient> = {}, saved?: AgentTaskPending, onChangeApplied: (snapshot: AgentTaskSnapshot) => void = () => {}, options:{onChange?:(state:AgentTaskSessionState)=>void;receipts?:AgentTaskReceiptStore;getLocale?:()=>AgentTaskLocale}={}) {
  const receipts = new Map<string, AgentTaskPending>(); if (saved) receipts.set(projectId, saved);
  const store: AgentTaskReceiptStore = { read: id => receipts.get(id) ?? null, write(id, value) { if (value) receipts.set(id, value); else receipts.delete(id); } };
  const streams: { signal: AbortSignal; onEvent: (event: AgentTaskEvent) => void }[] = [], sent: unknown[] = [], actions: unknown[] = [];
  const client: AgentTaskClient = {
    history: async()=>({conversations:[],nextCursor:null}), conversation:async(_,id)=>{const run={...snapshot().run,id,conversationId:id};return{conversation:conversation(run),runs:[run],nextCursor:null};}, list: async () => project(), read: async () => snapshot(), send: async (_, input) => { sent.push(input); return snapshot('running'); }, action: async (_, input) => { actions.push(input); return snapshot('paused', 2); }, lookup: async () => ({ found: false }), authorize: async () => {},
    stream: async (_, __, ___, signal, onEvent) => { streams.push({ signal, onEvent }); return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    policy: async () => ({policy:structuredClone(DEFAULT_AGENT_TASK_POLICY),readOnly:false}), savePolicy: async value => ({policy:value,readOnly:false}), lookupPolicy: async () => ({ found: false,readOnly:false }), conversationPolicy: async (projectId, conversationId) => ({policy:{projectId,conversationId,revision:0,override:null,global:structuredClone(DEFAULT_AGENT_TASK_POLICY),effective:structuredClone(DEFAULT_AGENT_TASK_POLICY.modes)},readOnly:false}), setConversationPolicy: async (projectId, conversationId, input) => ({policy:{projectId,conversationId,revision:input.expectedRevision+1,override:input.modes,global:structuredClone(DEFAULT_AGENT_TASK_POLICY),effective:structuredClone(input.modes??DEFAULT_AGENT_TASK_POLICY.modes)},readOnly:false}), upload: async (_, input) => ({ id: stepId, name: input.name, mimeType: input.mimeType, status: 'staged' }), ...patch,
  };
  const session = createAgentTaskSession({ projectId, client, receipts: options.receipts??store, onChange:options.onChange??(()=>{}),onChangeApplied,...(options.getLocale?{getLocale:options.getLocale}:{}) }); return { session, receipts, client, sent, actions, streams };
}
test('one session captures the current locale at send and keeps drafts and unknown receipts when it changes',async t=>{
  let locale:AgentTaskLocale='ja',lookups=0;const sent:Parameters<AgentTaskClient['send']>[1][]=[];
  const f=fixture({send:async(_,input)=>{sent.push(input);throw new Error('lost acknowledgement');},lookup:async()=>{lookups++;return {found:false};}},undefined,()=>{},{getLocale:()=>locale,onChange:state=>{if(state.phase==='submitting')locale='en';}});
  t.after(()=>f.session.dispose());await f.session.load();f.session.edit('keep my draft');
  assert.equal(await f.session.send(),false);assert.equal(sent[0]!.locale,'ja');assert.equal(locale,'en');assert.equal(f.session.getState().draft,'keep my draft');
  const pending=f.session.getState().pending;assert.ok(pending);locale='zh-Hant';await f.session.reconcile();
  assert.equal(sent.length,1);assert.equal(lookups,1);assert.deepEqual(f.session.getState().pending,pending);assert.equal(f.session.getState().draft,'keep my draft');
});
test('the browser client forwards the chosen response locale and rejects unsupported values before fetch',async()=>{
  const calls:{body?:BodyInit|null}[]=[],client=createAgentTaskClient({fetchImpl:async(_url,options)=>{calls.push(options??{});return new Response(JSON.stringify({ok:true,data:snapshot()}),{status:200});}}),input={requestId:crypto.randomUUID(),text:'synthetic',expectedSettingsRevision:0};
  for(const locale of [null,'zh-CN','fr',1])await assert.rejects(client.send(projectId,{...input,locale:locale as unknown as AgentTaskLocale}),{code:'AGENT_TASK_INVALID'});
  assert.equal(calls.length,0);await client.send(projectId,{...input,locale:'en'});assert.equal(JSON.parse(String(calls[0]!.body)).locale,'en');
});
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

for(const refreshRead of ['project','conversation'] as const)test(`showing a completed conversation can close or reload during its ${refreshRead} GET without posting`,async t=>{
  const saved=snapshot(),view={...project(),runs:[saved.run]},held=deferred<AgentTaskSnapshot>(),heldProject=deferred<AgentTaskProjectSnapshot>();let lists=0,reads=0,grants=0,uploads=0;
  const f=closeFixture(t,{
    list:async()=>++lists===1||refreshRead==='conversation'?view:heldProject.promise,
    read:async()=>++reads===1||refreshRead==='project'?saved:held.promise,
    authorize:async()=>{grants++;throw Error('Must not authorize during refresh');},
    upload:async()=>{uploads++;throw Error('Must not upload during refresh');},
  });
  await f.session.load();f.session.setVisible(false);f.session.setVisible(true);await flush();
  assert.equal(lists,2);assert.equal(reads,refreshRead==='project'?1:2);assert.equal(f.session.getState().snapshot?.run.id,saved.run.id);
  f.session.setVisible(false);f.session.setVisible(true);await flush();
  assert.equal(f.session.getState().phase,'refreshing','repeated visibility changes retain read-only refresh ownership');
  for(const action of ['close','reload'] as const){
    const targetUrl=action==='reload'?f.documentURL:null,ticket=f.admission.inspect(action,targetUrl);
    assert.equal(ticket.disposition,'clean','a cached completed conversation has only a GET in flight');
    assert.equal(f.admission.commit(ticket.token,{action,targetUrl,discardDirty:false,allowDrainFailure:false,expiresAt:1500}),true);
    assert.equal(f.admission.beforeUnload({returnValue:'',preventDefault(){assert.fail('read-only refresh must not veto unload');}}),true);
  }
  f.session.edit('retain this draft');
  assert.equal(f.admission.inspect().disposition,'dirty');
  assert.equal(await f.session.send(),false);assert.equal(await f.session.action('undo_all'),false);
  assert.equal(await f.session.authorize(),false);
  assert.equal(f.session.authorizationReview(),null);assert.equal(f.session.newConversation(),false);
  assert.equal(await f.session.upload({name:'synthetic.txt',type:'text/plain',size:1,arrayBuffer:async()=>new Uint8Array([1]).buffer}),false);
  heldProject.resolve(view);held.resolve(saved);await flush();assert.equal(f.session.getState().phase,'ready');assert.equal(f.session.getState().draft,'retain this draft');
  assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);assert.equal(grants,0);assert.equal(uploads,0);
});

for(const unknownResult of [false,true])test(`completed-conversation refresh ${unknownResult?'revokes':'retains'} a close ticket when it reads ${unknownResult?'unknown results':'safe metadata'}`,async t=>{
  const saved=snapshot(),held=deferred<AgentTaskSnapshot>();let reads=0;
  const f=closeFixture(t,{list:async()=>({...project(),runs:[saved.run]}),read:async()=>++reads===1?saved:held.promise});
  await f.session.load();f.session.setVisible(false);f.session.setVisible(true);await flush();
  const ticket=f.admission.inspect();assert.equal(ticket.disposition,'clean');
  assert.equal(f.admission.commit(ticket.token,{discardDirty:false,allowDrainFailure:false,expiresAt:1500}),true);
  const next={...saved,run:{...saved.run,revision:2}};
  if(unknownResult){next.run.status='interrupted';next.steps=[{id:stepId,runId,position:1,kind:'model',status:'unknown',createdAt:time,updatedAt:time}];}
  held.resolve(next);await flush();
  assert.equal(f.admission.commit(ticket.token,{discardDirty:false,allowDrainFailure:false,expiresAt:1500}),!unknownResult,'validate the original ticket before inspecting again');
  let prevented=false;assert.equal(f.admission.beforeUnload({returnValue:'',preventDefault(){prevented=true;}}),!unknownResult);assert.equal(prevented,unknownResult);
  assert.equal(f.admission.inspect().disposition,unknownResult?'blocked':'clean');
  assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);
});

test('a failed completed-conversation refresh retains drafts and never becomes a blocking business error',async t=>{
  const saved=snapshot(),held=deferred<AgentTaskSnapshot>();let reads=0;
  const f=closeFixture(t,{list:async()=>({...project(),runs:[saved.run]}),read:async()=>++reads===1?saved:held.promise});
  await f.session.load();f.session.edit('retained draft');f.session.setVisible(false);f.session.setVisible(true);await flush();
  const ticket=f.admission.inspect();assert.equal(ticket.disposition,'dirty');
  assert.equal(f.admission.commit(ticket.token,{discardDirty:false,allowDrainFailure:false,expiresAt:1500}),false);
  held.reject(new Error('offline refresh'));await flush();
  assert.equal(f.session.getState().phase,'read_error');assert.equal(f.session.getState().draft,'retained draft');
  assert.equal(f.admission.inspect().disposition,'dirty');assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);
});

for(const kind of ['running','unknown','background'] as const)test(`a ${kind} conversation retains its blocking load fence on visibility refresh`,async t=>{
  const saved=snapshot(kind==='running'?'running':kind==='unknown'?'interrupted':'completed');
  if(kind==='unknown')saved.steps=[{id:stepId,runId,position:1,kind:'model',status:'unknown',createdAt:time,updatedAt:time}];
  if(kind==='background')saved.backgroundPending=true;
  const held=deferred<AgentTaskProjectSnapshot>();let lists=0;
  const f=closeFixture(t,{list:async()=>++lists===1?{...project(),runs:[saved.run]}:held.promise,read:async()=>saved});
  await f.session.load();f.session.setVisible(false);f.session.setVisible(true);await flush();
  assert.equal(f.session.getState().phase,'loading');assert.equal(f.admission.inspect().disposition,'blocked');
  held.resolve({...project(),runs:[saved.run]});await flush();
  assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);
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

const selectedFile = (name: string, type = 'video/mp4') => ({name, type, size: 3, arrayBuffer: async () => Uint8Array.from([65, 66, 67]).buffer});

test('task uploads normalize only the existing closed audio aliases, without guessing types from filenames', async t => {
  const cases = [
    ['tone.m4a', 'audio/x-m4a', 'audio/mp4'], ['tone.wav', 'audio/x-wav', 'audio/wav'],
    ['tone.m4a', 'audio/mp4', 'audio/mp4'], ['clip.mp4', 'video/mp4', 'video/mp4'],
    ['tone.m4a', '', 'application/octet-stream'], ['tone.m4a', 'text/plain', 'text/plain'],
    ['tone.m4a', 'audio/not-a-supported-alias', 'audio/not-a-supported-alias'],
  ] as const;
  for (const [name, type, expected] of cases) await t.test(`${type || 'empty'} remains ${expected}`, async () => {
    const requests: Parameters<AgentTaskClient['upload']>[1][] = [];
    const f = fixture({upload: async (_, input) => { requests.push(input); return {id: stepId, name: input.name, mimeType: input.mimeType, status: 'selected'}; }});
    try {
      await f.session.load(); assert.equal(await f.session.upload(selectedFile(name, type)), true);
      assert.equal(requests.length, 1); assert.equal(requests[0]!.mimeType, expected); assert.equal(requests[0]!.dataBase64, 'QUJD');
    } finally { f.session.dispose(); }
  });
});

test('an actual upload 4xx is visible after receipt lookup, preserves earlier files and draft, and clears only on a new user upload', async () => {
  const requests: {method: string; url: string; body?: Parameters<AgentTaskClient['upload']>[1]}[] = [];
  let reject = true, lists = 0;
  const http = createAgentTaskClient({fetchImpl: async (url, init) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) as Parameters<AgentTaskClient['upload']>[1] : undefined;
    requests.push({method, url: String(url), ...(body ? {body} : {})});
    if (method === 'GET') return Response.json({ok: true, data: {found: false}});
    if (body?.name === 'tone.m4a' && reject) return Response.json({ok: false, error: {code: 'PRIVATE_RESPONSE_MARKER', message: 'private provider body must not appear'}}, {status: 400});
    return Response.json({ok: true, data: {id: crypto.randomUUID(), name: body!.name, mimeType: body!.mimeType, status: 'selected'}});
  }});
  const f = fixture({list: async () => {lists++; return project();}, upload: http.upload, lookup: http.lookup});
  try {
    await f.session.load(); f.session.edit('Keep this intended edit');
    await f.session.upload(selectedFile('red.mp4')); await f.session.upload(selectedFile('blue.mp4'));
    const previous = structuredClone(f.session.getState().uploads);
    assert.equal(await f.session.upload(selectedFile('tone.m4a', 'audio/mp4')), false);
    assert.equal(f.session.getState().phase, 'ready'); assert.equal(f.session.getState().error, 'UPLOAD_REJECTED');
    assert.equal(agentTaskCloseState(f.session.getState()).blocked, false, 'a proven rejection keeps its notice without trapping normal native close');
    assert.equal(agentTaskCloseState(f.session.getState()).dirty, true, 'the existing draft still needs normal discard confirmation');
    assert.equal(agentTaskCloseState({...f.session.getState(), draft: ''}).dirty, true, 'selected attachments and retained conversation drafts still need discard confirmation');
    assert.equal(agentTaskCloseState({...f.session.getState(), draft: '', draftDirty:false, uploads:[]}).dirty, false, 'only an empty input owner can close without discarding work');
    assert.deepEqual(f.session.getState().uploads, previous); assert.equal(f.session.getState().draft, 'Keep this intended edit');
    assert.equal(f.session.getState().pending, null); assert.equal(f.receipts.size, 0); assert.equal(lists, 1);
    assert.equal(requests.filter(row => row.method === 'POST').length, 3); assert.equal(requests.filter(row => row.method === 'GET').length, 1);
    const rejected = requests[2]!.body!;
    assert.ok(requests[3]!.url.endsWith(`/uploads/requests/${rejected.requestId}`));
    assert.doesNotMatch(JSON.stringify(f.session.getState()), /PRIVATE_RESPONSE_MARKER|private provider body/);
    await f.session.reconcile(); assert.equal(requests.length, 4, 'a settled rejection never reposts or rechecks itself');
    reject = false;
    assert.equal(await f.session.upload(selectedFile('tone.m4a', 'audio/x-m4a')), true);
    assert.equal(f.session.getState().phase, 'ready'); assert.equal(f.session.getState().error, ''); assert.equal(f.session.getState().uploads.length, 3);
    assert.equal(requests[4]!.body!.mimeType, 'audio/mp4'); assert.notEqual(requests[4]!.body!.requestId, rejected.requestId);
    assert.deepEqual(f.session.getState().uploads.slice(0, 2), previous); assert.equal(f.session.getState().draft, 'Keep this intended edit');
  } finally { f.session.dispose(); }
});

test('an upload rejection whose lookup fails stays pending until the original receipt can prove nonacceptance', async () => {
  let posts = 0, lookups = 0, unavailable = true;
  const f = fixture({upload: async () => {posts++; throw Object.assign(new Error('private response'), {code: 'INVALID_MEDIA', definitive: true});}, lookup: async () => {lookups++; if (unavailable) throw new Error('private lookup'); return {found: false};}});
  try {
    await f.session.load(); f.session.edit('preserve draft');
    assert.equal(await f.session.upload(selectedFile('tone.m4a', 'audio/mp4')), false);
    const original = structuredClone(f.session.getState().pending);
    assert.equal(f.session.getState().phase, 'unknown'); assert.equal(original?.definitiveRejected, true); assert.equal(f.receipts.size, 1);
    assert.equal(await f.session.upload(selectedFile('tone.m4a', 'audio/mp4')), false); assert.equal(posts, 1);
    unavailable = false; assert.equal(await f.session.reconcile(), false);
    assert.equal(f.session.getState().phase, 'ready'); assert.equal(f.session.getState().error, 'UPLOAD_REJECTED'); assert.equal(f.session.getState().pending, null);
    assert.equal(f.session.getState().draft, 'preserve draft'); assert.equal(posts, 1); assert.equal(lookups, 2); assert.equal(f.receipts.size, 0);
  } finally { f.session.dispose(); }
});

test('a lost upload acknowledgement retains its identity on not-found and adopts a late accepted handle without reposting', async () => {
  let posts = 0, lookups = 0, result: AgentTaskLookup = {found: false}; const identities: string[] = [];
  const f = fixture({upload: async (_, input) => {posts++; identities.push(input.requestId); throw new Error('lost ACK');}, lookup: async (_, pending) => {lookups++; assert.equal(pending.requestId, identities[0]); return result;}});
  try {
    await f.session.load(); f.session.edit('preserve draft'); await f.session.upload(selectedFile('tone.m4a', 'audio/mp4'));
    const pending = structuredClone(f.session.getState().pending); assert.equal(pending?.definitiveRejected, undefined);
    await f.session.reconcile(); assert.equal(f.session.getState().phase, 'unknown'); assert.deepEqual(f.session.getState().pending, pending); assert.equal(f.receipts.size, 1);
    assert.equal(await f.session.upload(selectedFile('other.mp4')), false); assert.equal(posts, 1);
    result = {found: true, upload: {id: stepId, name: 'tone.m4a', mimeType: 'audio/mp4', status: 'selected'}};
    assert.equal(await f.session.reconcile(), true); assert.equal(f.session.getState().phase, 'ready'); assert.equal(f.session.getState().error, '');
    assert.equal(f.session.getState().uploads[0]?.id, stepId); assert.equal(f.session.getState().draft, 'preserve draft'); assert.equal(f.receipts.size, 0); assert.equal(posts, 1); assert.equal(lookups, 2);
  } finally { f.session.dispose(); }
});

test('reopened rejected upload receipts show a safe rejection only after not-found, while an accepted original receipt wins', async t => {
  for (const found of [false, true]) await t.test(found ? 'accepted original' : 'confirmed rejection', async () => {
    const pending: AgentTaskPending = {requestId: crypto.randomUUID(), runId: null, action: 'upload', definitiveRejected: true};
    let posts = 0, lookups = 0;
    const upload = {id: stepId, name: 'tone.m4a', mimeType: 'audio/mp4', status: 'selected'};
    const f = fixture({upload: async () => {posts++; return upload;}, lookup: async (_, input) => {lookups++; assert.deepEqual(input, pending); return found ? {found: true, upload} : {found: false};}}, pending);
    try {
      await f.session.load(); assert.equal(f.session.getState().phase, 'ready'); assert.equal(f.session.getState().pending, null); assert.equal(f.receipts.size, 0);
      assert.equal(f.session.getState().error, found ? '' : 'UPLOAD_REJECTED'); assert.deepEqual(f.session.getState().uploads, found ? [upload] : []);
      assert.equal(posts, 0); assert.equal(lookups, 1);
    } finally { f.session.dispose(); }
  });
});

test('local file-read failures do not dispatch and preserve the existing selected file and draft', async () => {
  let posts = 0; const f = fixture({upload: async (_, input) => {posts++; return {id: stepId, name: input.name, mimeType: input.mimeType, status: 'selected'};}});
  try {
    await f.session.load(); await f.session.upload(selectedFile('red.mp4')); f.session.edit('preserve draft');
    const previous = structuredClone(f.session.getState().uploads);
    assert.equal(await f.session.upload({...selectedFile('tone.m4a', 'audio/mp4'), arrayBuffer: async () => {throw new Error('private file-read failure');}}), false);
    assert.equal(posts, 1); assert.equal(f.session.getState().phase, 'error'); assert.equal(f.session.getState().error, 'NETWORK');
    assert.deepEqual(f.session.getState().uploads, previous); assert.equal(f.session.getState().draft, 'preserve draft'); assert.equal(f.session.getState().pending, null); assert.equal(f.receipts.size, 0);
  } finally { f.session.dispose(); }
});

test('late rejection lookups cannot publish into a disposed session or clear its recoverable identity', async () => {
  const held = deferred<AgentTaskLookup>(); let posts = 0, changes = 0;
  const f = fixture({upload: async () => {posts++; throw Object.assign(new Error('rejected'), {code: 'INVALID_MEDIA', definitive: true});}, lookup: async () => held.promise}, undefined, () => {}, {onChange: () => {changes++;}});
  await f.session.load(); const uploading = f.session.upload(selectedFile('tone.m4a', 'audio/mp4')); await flush();
  assert.equal(f.session.getState().pending?.definitiveRejected, true); f.session.dispose(); const previous = changes;
  held.resolve({found: false}); assert.equal(await uploading, false); assert.equal(changes, previous); assert.equal(f.receipts.size, 1); assert.equal(posts, 1);
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
  const f=fixture({list:async()=>({...project(),readOnly:true}),history:async(_,cursor)=>cursor?{conversations:[conversation(oldRun)],nextCursor:null}:{conversations:[conversation(snapshot().run)],nextCursor:'older'},read:async(_,id)=>{reads++;return{...snapshot(),run:{...snapshot().run,id}};}});
  await f.session.load();await f.session.history();await f.session.history(true);assert.equal(f.session.getState().history.conversations.length,2);await f.session.select(oldId);assert.equal(f.session.getState().snapshot?.run.id,oldId);assert.equal(reads,1);assert.equal(f.sent.length,0);f.session.dispose();
});

test('a completed run with pending background work keeps observing late cost and Change records until work settles',async()=>{
  const initial={...snapshot('completed'),backgroundPending:true};const f=fixture({list:async()=>({...project(),runs:[initial.run]}),read:async()=>initial});await f.session.load();assert.equal(f.streams.length,1);const stream=f.streams[0]!;assert.equal(stream.signal.aborted,false);
  const late={...snapshot('completed',2),backgroundPending:true};late.steps=[{id:stepId,runId,position:1,kind:'tool',status:'completed',cost:'submitted',createdAt:time,updatedAt:time}];late.changes=[{id:crypto.randomUUID(),runId,stepId,projectId,operation:'generation.result',targets:[{kind:'shot',id:crypto.randomUUID(),revision:1}],before:null,after:null,reversible:false,status:'applied',createdAt:time}];
  stream.onEvent({runId,sequence:2,type:'snapshot',createdAt:time,data:late as unknown as AgentTaskEvent['data']});assert.equal(stream.signal.aborted,false);assert.equal(f.session.getState().snapshot?.steps[0]?.cost,'submitted');assert.equal(f.session.getState().snapshot?.changes.length,1);
  stream.onEvent({runId,sequence:3,type:'snapshot',createdAt:time,data:{...late,run:{...late.run,revision:3},backgroundPending:false} as unknown as AgentTaskEvent['data']});assert.equal(stream.signal.aborted,true);assert.equal(f.session.getState().snapshot?.backgroundPending,false);f.session.dispose();
});

test('pending task identities remain stable across backend restarts and isolated from restored workspace origins',()=>{
  const values=new Map<string,string>();const storage:Storage={get length(){return values.size;},clear(){values.clear();},getItem:key=>values.get(key)??null,key:index=>[...values.keys()][index]??null,removeItem:key=>{values.delete(key);},setItem:(key,value)=>{values.set(key,value);}};
  for(const action of ['pause','note','skip','retry','answer'] as const){const pending:AgentTaskPending={requestId:crypto.randomUUID(),runId,action};createAgentTaskReceiptStore(()=>storage,'normal').write(projectId,pending);assert.deepEqual(createAgentTaskReceiptStore(()=>storage,'normal').read(projectId),pending);assert.equal(createAgentTaskReceiptStore(()=>storage,'restored:'+crypto.randomUUID()).read(projectId),null);assert.equal(values.size,1);}
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

test('first-send confirmation grants only the reviewed binding and sends exactly once', async t => {
  const current=project();current.authorization.scopes=[];let grants=0,locale:AgentTaskLocale='ja';
  const f=fixture({list:async()=>structuredClone(current),authorize:async()=>{grants++;current.authorization={revision:2,scopes:['project_agent']};}},undefined,()=>{},{getLocale:()=>locale});
  t.after(()=>f.session.dispose());await f.session.load();f.session.edit('reviewed draft');
  const review=f.session.authorizationReview();assert.ok(review);assert.equal(review.destination,'https://example.invalid/v1/responses');assert.equal(review.locale,'ja');
  assert.equal(grants,0);assert.equal(f.sent.length,0);
  assert.equal(await f.session.authorizeAndSend(review),true);assert.equal(grants,1);assert.equal(f.sent.length,1);assert.equal((f.sent[0] as {text:string;locale:string}).text,'reviewed draft');assert.equal((f.sent[0] as {locale:string}).locale,'ja');
  assert.equal(await f.session.authorizeAndSend(review),false);assert.equal(grants,1);assert.equal(f.sent.length,1);
});

test('authorization review becomes stale before confirmation when its text, locale, attachments or settings change', async t => {
  for(const changed of ['draft','locale','upload','settings'] as const)await t.test(changed,async()=>{
    const current=project();current.authorization.scopes=[];let grants=0,locale:AgentTaskLocale='zh-Hans';
    const f=fixture({list:async()=>structuredClone(current),authorize:async()=>{grants++;}},undefined,()=>{},{getLocale:()=>locale});
    try{await f.session.load();f.session.edit('preserve draft');const review=f.session.authorizationReview();assert.ok(review);
      if(changed==='draft')f.session.edit('new draft');
      if(changed==='locale')locale='en';
      if(changed==='upload')await f.session.upload({name:'local.png',type:'image/png',size:1,arrayBuffer:async()=>new Uint8Array([0]).buffer});
      if(changed==='settings'){current.settings.revision++;current.settings.configuration.model='changed-model';await f.session.load();}
      assert.equal(await f.session.authorizeAndSend(review),false);assert.equal(grants,0);assert.equal(f.sent.length,0);assert.ok(f.session.getState().draft);
    }finally{f.session.dispose();}
  });
});

test('an authorization response cannot send after changed input, changed settings, revocation or a hide-and-return', async t => {
  for(const changed of ['draft','settings','revoked','hidden'] as const)await t.test(changed,async()=>{
    const current=project();current.authorization.scopes=[];const grant=deferred<void>();let grants=0;
    const f=fixture({list:async()=>structuredClone(current),authorize:async()=>{grants++;await grant.promise;} });
    try{await f.session.load();f.session.edit('preserve reviewed draft');const review=f.session.authorizationReview();assert.ok(review);const sending=f.session.authorizeAndSend(review);assert.equal(grants,1);
      current.authorization={revision:2,scopes:['project_agent']};
      if(changed==='draft')f.session.edit('new unsent draft');
      if(changed==='settings'){current.settings.revision++;current.settings.configuration.model='new-model';}
      if(changed==='revoked')current.authorization={revision:3,scopes:[]};
      if(changed==='hidden'){f.session.setVisible(false);f.session.setVisible(true);}
      grant.resolve();assert.equal(await sending,false);assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);assert.ok(f.session.getState().draft);
    }finally{f.session.dispose();}
  });
});

test('a lost authorization response preserves the draft and only a later explicit send can call the model', async t=>{
  const current=project();current.authorization.scopes=[];let grants=0;
  const f=fixture({list:async()=>structuredClone(current),authorize:async()=>{grants++;current.authorization={revision:2,scopes:['project_agent']};throw new Error('lost acknowledgement');}});
  t.after(()=>f.session.dispose());await f.session.load();f.session.edit('keep my draft');const review=f.session.authorizationReview();assert.ok(review);
  assert.equal(await f.session.authorizeAndSend(review),false);assert.equal(grants,1);assert.equal(f.sent.length,0);assert.equal(f.session.getState().draft,'keep my draft');
  await f.session.load();assert.equal(f.sent.length,0);assert.equal(grants,1);assert.equal(f.session.getState().draft,'keep my draft');
  await f.session.send();assert.equal(f.sent.length,1);assert.equal(grants,1);
});


test('a lost retry response retains its stable identity and only reads the original control receipt',async()=>{
  const failed=snapshot('failed',4);failed.steps=[{id:stepId,runId,position:1,kind:'model',status:'failed',createdAt:time,updatedAt:time,error:{code:'AGENT_CHAT_CONNECT_FAILED',message:'safe'}}];
  const actions:Parameters<AgentTaskClient['action']>[1][]=[],lookups:AgentTaskPending[]=[];
  const f=fixture({list:async()=>({...project(),runs:[failed.run]}),read:async()=>failed,action:async(_,input)=>{actions.push(input);throw new Error('response lost');},lookup:async(_,pending)=>{lookups.push(pending);return{found:true,snapshot:snapshot('completed',6),receipt:{requestId:pending.requestId,runId,action:'retry',revision:6,result:{state:'completed'}}};}});
  try{
    await f.session.load();f.session.edit('keep unsent input');assert.equal(await f.session.action('retry',{stepId}),false);const pending=f.session.getState().pending;assert.ok(pending);assert.equal(pending.action,'retry');assert.equal(actions.length,1);assert.equal(actions[0]!.expectedRevision,4);const retried=actions[0]!;assert.ok(retried.action==='retry');assert.equal(retried.stepId,stepId);
    assert.equal(await f.session.action('retry',{stepId}),false);await f.session.reconcile();assert.equal(actions.length,1);assert.deepEqual(lookups,[pending]);assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().draft,'keep unsent input');
  }finally{f.session.dispose();}
});

test('undo preflight refresh is read-only, preserves the draft and refuses a late response after a conversation switch',async()=>{
  let value=snapshot('completed',2),held:ReturnType<typeof deferred<AgentTaskSnapshot>>|undefined;
  const f=fixture({list:async()=>({...project(),runs:[value.run]}),read:async()=>held?held.promise:structuredClone(value)});
  try{
    await f.session.load();f.session.edit('keep this draft');value={...value,changes:[{id:stepId,stepId,runId,projectId,operation:'shot.update',targets:[],before:null,after:null,reversible:true,status:'applied',createdAt:time,modifiedAfter:true,undoDisposition:'retain'}]};
    const refreshed=await f.session.refreshRound(runId);assert.equal(refreshed?.changes[0]?.modifiedAfter,true);assert.equal(refreshed?.changes[0]?.undoDisposition,'retain');assert.equal(f.session.getState().draft,'keep this draft');assert.equal(f.actions.length,0);assert.equal(f.receipts.size,0);
    held=deferred<AgentTaskSnapshot>();const refreshing=f.session.refreshRound(runId);assert.equal(f.session.newConversation(),true);const selection=f.session.getState().selectionKey;held.resolve(value);assert.equal(await refreshing,null);assert.equal(f.session.getState().selectionKey,selection);assert.equal(f.session.getState().snapshot,null);assert.equal(f.actions.length,0);
  }finally{f.session.dispose();}
});


test('undo submits exactly the reviewed changes and a lost response only queries that control receipt',async()=>{
  const initial=snapshot('completed',4),changeIds=[crypto.randomUUID(),crypto.randomUUID()],actions:Parameters<AgentTaskClient['action']>[1][]=[],lookups:AgentTaskPending[]=[];
  const f=fixture({list:async()=>({...project(),runs:[initial.run]}),read:async()=>initial,action:async(_,input)=>{actions.push(structuredClone(input));throw new Error('response lost');},lookup:async(_,pending)=>{lookups.push(pending);return{found:true,snapshot:snapshot('completed',6),receipt:{requestId:pending.requestId,runId,action:'undo_all',revision:6,result:{state:'completed',reverted:2}}};}});
  try{
    await f.session.load();f.session.edit('keep unsent input');assert.equal(await f.session.action('undo_all',{undoChangeIds:changeIds}),false);
    const pending=f.session.getState().pending;assert.ok(pending);assert.equal(pending.action,'undo_all');assert.equal(actions.length,1);const action=actions[0]!;assert.ok(action.action==='undo_all');assert.equal(action.expectedRevision,4);assert.deepEqual(action.undoChangeIds,changeIds);
    assert.equal(await f.session.action('undo_all',{undoChangeIds:[...changeIds,crypto.randomUUID()]}),false);await f.session.reconcile();assert.equal(actions.length,1);assert.deepEqual(lookups,[pending]);assert.equal(f.session.getState().pending,null);assert.equal(f.session.getState().draft,'keep unsent input');
  }finally{f.session.dispose();}
});
const {step:STEP,full:FULL}=AGENT_TASK_POLICY_PRESETS;
const conversationPolicy=(conversationId:string,revision:number,override:AgentTaskPolicyModes|null,global:AgentTaskPolicy=structuredClone(DEFAULT_AGENT_TASK_POLICY)):AgentTaskConversationPolicy=>({projectId,conversationId,revision,override:override&&{...override},global,effective:{...(override??global.modes)}});
test('a new conversation sends only its own chosen modes, acknowledging paid direct work, then reads the saved policy',async t=>{
  const otherRunId='55555555-5555-4555-8555-555555555555',posts:unknown[]=[];let reads=0;
  const f=fixture({send:async(_,input)=>{posts.push(input);const value=snapshot('completed');return posts.length===1?value:{...value,run:{...value.run,id:otherRunId}};},conversationPolicy:async(_,id)=>{reads++;return{policy:conversationPolicy(id,1,FULL),readOnly:false};}});
  t.after(()=>f.session.dispose());await f.session.load();
  assert.deepEqual(f.session.getState().policy,{conversationId:null,phase:'ready',value:null,modes:null});
  assert.equal(await f.session.choosePolicy({...DEFAULT_AGENT_TASK_POLICY.modes}),true);assert.equal(f.session.getState().policy.modes,null,'the global modes are followed, not copied');
  assert.equal(await f.session.choosePolicy({...FULL}),true);assert.deepEqual(f.session.getState().policy.modes,FULL);
  f.session.edit('Start loosely');assert.deepEqual(f.session.authorizationReview()?.modes,FULL,'a reviewed first send is bound to its modes');
  assert.equal(await f.session.send(),true);assert.deepEqual((posts[0] as {policy?:unknown}).policy,{modes:FULL,acknowledgePaid:true});
  await flush();const state=f.session.getState();assert.equal(state.conversationId,runId);assert.equal(state.policy.conversationId,runId);assert.equal(state.policy.phase,'ready');assert.deepEqual(state.policy.value?.override,FULL);assert.equal(reads,1);
  assert.equal(f.session.newConversation(),true);assert.deepEqual(f.session.getState().policy,{conversationId:null,phase:'ready',value:null,modes:null},'a new conversation starts from the global modes');
  assert.equal(await f.session.choosePolicy({...STEP}),true);f.session.edit('Start carefully');assert.equal(await f.session.send(),true);assert.deepEqual((posts[1] as {policy?:unknown}).policy,{modes:STEP},'tightening needs no acknowledgement');
  f.session.newConversation();f.session.edit('Start plainly');assert.equal(await f.session.send(),true);assert.equal(Object.hasOwn(posts[2] as object,'policy'),false,'following the global modes sends no policy');
});
test('a saved conversation changes its modes under the read revision and never resends a failed change',async t=>{
  const saved={...snapshot('completed'),run:{...snapshot('completed').run,conversationId:runId}};let current=conversationPolicy(runId,0,null),puts:unknown[]=[],failNext=false;
  const f=fixture({list:async()=>({...project(),runs:[saved.run]}),read:async()=>saved,conversationPolicy:async()=>({policy:current,readOnly:false}),
    setConversationPolicy:async(_,id,input)=>{puts.push(input);if(failNext){failNext=false;throw Object.assign(new Error('lost'),{code:'NETWORK'});}current=conversationPolicy(id,input.expectedRevision+1,input.modes);return{policy:current,readOnly:false};}});
  t.after(()=>f.session.dispose());await f.session.load();await flush();
  assert.equal(f.session.getState().conversationId,runId);assert.equal(f.session.getState().policy.phase,'ready');assert.equal(f.session.getState().policy.value?.revision,0);
  assert.equal(await f.session.choosePolicy({...STEP}),true);assert.deepEqual(puts.at(-1),{requestId:(puts.at(-1) as {requestId:string}).requestId,expectedRevision:0,modes:STEP});
  assert.equal(await f.session.choosePolicy({...FULL}),true);assert.equal((puts.at(-1) as {acknowledgePaid?:boolean;expectedRevision:number}).acknowledgePaid,true);assert.equal((puts.at(-1) as {expectedRevision:number}).expectedRevision,1);
  assert.equal(await f.session.choosePolicy({...DEFAULT_AGENT_TASK_POLICY.modes}),true);assert.equal((puts.at(-1) as {modes:unknown}).modes,null,'choosing the global modes clears the override');
  assert.equal(f.session.getState().policy.value?.revision,3);
  failNext=true;const before=puts.length;assert.equal(await f.session.choosePolicy({...STEP}),false);
  assert.equal(puts.length,before+1,'a lost change is never resent');assert.equal(f.session.getState().error,'NETWORK');assert.equal(f.session.getState().policy.phase,'ready');assert.equal(f.session.getState().policy.value?.revision,3,'the saved modes are read back');
});
test('making the modes global keeps the step limit, acknowledges paid direct work and recovers a lost acknowledgement by receipt',async t=>{
  const saved={...snapshot('completed'),run:{...snapshot('completed').run,conversationId:runId}},saves:unknown[]=[];let lost=false;
  const f=fixture({list:async()=>({...project(),runs:[saved.run]}),read:async()=>saved,conversationPolicy:async(_,id)=>({policy:conversationPolicy(id,1,FULL),readOnly:false}),
    savePolicy:async value=>{saves.push(value);if(lost)throw Object.assign(new Error('lost'),{code:'NETWORK'});return{policy:{revision:value.revision+1,stepLimit:value.stepLimit,modes:value.modes},readOnly:false};},
    lookupPolicy:async()=>({found:true,policy:{revision:2,stepLimit:30,modes:{...STEP}},readOnly:false})});
  t.after(()=>f.session.dispose());await f.session.load();await flush();
  assert.equal(await f.session.setGlobalPolicy({...FULL}),true);assert.equal((saves[0] as {acknowledgePaid?:boolean}).acknowledgePaid,true);assert.equal((saves[0] as {stepLimit:number}).stepLimit,30);assert.deepEqual(f.session.getState().project?.policy.modes,FULL);
  lost=true;assert.equal(await f.session.setGlobalPolicy({...STEP}),true);assert.equal(saves.length,2,'the receipt answers a lost acknowledgement');assert.deepEqual(f.session.getState().project?.policy.modes,STEP);
});
test('the composer menu confirms before paid work becomes direct, and the current preset or global modes change nothing',()=>{
  const DEFAULT={...DEFAULT_AGENT_TASK_POLICY.modes},custom={...FULL,paid:'confirm' as const},paidDirect={...STEP,paid:'direct' as const};
  assert.deepEqual(agentTaskPolicyMenuStep(null,DEFAULT,'step'),{kind:'none'});
  assert.deepEqual(agentTaskPolicyMenuStep(DEFAULT,DEFAULT,'default'),{kind:'none'});
  assert.deepEqual(agentTaskPolicyMenuStep(DEFAULT,DEFAULT,'step'),{kind:'choose',modes:STEP});
  assert.deepEqual(agentTaskPolicyMenuStep(DEFAULT,DEFAULT,'full'),{kind:'confirm',scope:'conversation'});
  assert.deepEqual(agentTaskPolicyMenuStep(custom,DEFAULT,'full'),{kind:'confirm',scope:'conversation'});
  assert.deepEqual(agentTaskPolicyMenuStep(paidDirect,DEFAULT,'full'),{kind:'choose',modes:FULL},'paid work already direct needs no new confirmation');
  assert.deepEqual(agentTaskPolicyMenuStep(FULL,DEFAULT,'default'),{kind:'choose',modes:DEFAULT});
  assert.deepEqual(agentTaskPolicyMenuStep(DEFAULT,DEFAULT,'global'),{kind:'none'},'the same modes are not saved again');
  assert.deepEqual(agentTaskPolicyMenuStep(STEP,DEFAULT,'global'),{kind:'global',modes:STEP});
  assert.deepEqual(agentTaskPolicyMenuStep(FULL,DEFAULT,'global'),{kind:'confirm',scope:'global'},'making direct paid work global is confirmed again');
  assert.deepEqual(agentTaskPolicyMenuStep(FULL,{...FULL},'global'),{kind:'none'});
});
const askStepId='66666666-6666-4666-8666-666666666666';
const askArguments:AgentTaskJson={question:'Which opening should Mio use?',options:[{label:'Wide street',description:'Establish the city first'},{label:'Close-up'},{label:'Rooftop'}],multiple:true,allowOther:true};
const askStep=(status:AgentTaskStep['status']='awaiting_answer',result?:AgentTaskStep['result']):AgentTaskStep=>({id:askStepId,runId,position:2,kind:'tool',status,tier:'read_only',toolCall:{id:'call_ask',name:'mioon_ask',arguments:askArguments},createdAt:time,updatedAt:time,...(result!==undefined?{result}:{})});
const waiting=(revision=3):AgentTaskSnapshot=>{const value=snapshot('awaiting_answer',revision);return {...value,run:{...value.run,conversationId:runId},steps:[askStep()]};};
test('question helpers read only saved mioon_ask arguments and answers, and bound typed answers',()=>{
  const question=taskQuestionOf(askStep());assert.ok(question);assert.equal(question.options.length,3);
  assert.equal(taskQuestionOf({...askStep(),toolCall:{id:'x',name:'mioon_shot_update',arguments:askArguments}}),null);
  assert.equal(taskQuestionOf({...askStep(),toolCall:{id:'x',name:'mioon_ask',arguments:{question:'Two\nlines',options:[{label:'A'},{label:'B'}]}}}),null,'an invalid saved question is not shown');
  assert.equal(taskAnswerOf(askStep(),question),null,'a waiting question has no answer');
  assert.deepEqual(taskAnswerOf(askStep('completed',{answer:{choices:[0,2]},selected:['Wide street','Rooftop']}),question),{labels:['Wide street','Rooftop']});
  assert.deepEqual(taskAnswerOf(askStep('completed',{answer:{choices:[1],text:'  and a drone shot '}}),question),{labels:['Close-up'],text:'and a drone shot'});
  assert.deepEqual(taskAnswerOf(askStep('completed',{answer:{choices:[],text:'Open on the harbour'}}),question),{labels:[],text:'Open on the harbour'});
  assert.deepEqual(taskAnswerOf(askStep('completed',{answer:{choices:[7]},selected:['Forged label']}),question),null,'labels come from the saved options, not from the result text');
  assert.equal(agentTaskAnswerTextValid('Line one\nline two'),true);assert.equal(agentTaskAnswerTextValid('   '),false);assert.equal(agentTaskAnswerTextValid('x'.repeat(2001)),false);
  assert.equal(taskStepTitle({...askStep(),display:{operation:'ask',targets:[],targetCount:0,fields:[]}},'zh-Hans'),'提问','the server projects the ask step as operation "ask"');
  assert.equal(agentTaskWaitingQuestion(waiting())?.id,askStepId);assert.equal(agentTaskWaitingQuestion({...waiting(),run:{...waiting().run,status:'stopped'}}),null);
});
test('an answer posts its exact choices under a persisted receipt and only for the question the run waits on',async t=>{
  const f=fixture({list:async()=>({...project(),runs:[waiting().run]}),read:async()=>waiting(),conversation:async()=>({conversation:conversation(waiting().run),runs:[waiting().run],nextCursor:null}),
    action:async(_,input)=>{f.actions.push(input);const done=snapshot('running',4);return {...done,run:{...done.run,conversationId:runId},steps:[askStep('completed',{answer:{choices:[0,2],text:'and a drone shot'}})]};}});
  t.after(()=>f.session.dispose());await f.session.load();await flush();
  assert.equal(await f.session.answer(randomStep(),[0]),false,'another step is never answered');assert.equal(f.actions.length,0);
  assert.equal(await f.session.answer(askStepId,[]),false,'an empty answer is not sent');assert.equal(f.actions.length,0);
  const answering=f.session.answer(askStepId,[0,2],'and a drone shot');assert.equal(f.receipts.get(projectId)?.action,'answer');
  assert.equal(await answering,true);assert.equal(f.receipts.size,0);
  assert.deepEqual(f.actions[0],{requestId:(f.actions[0] as {requestId:string}).requestId,runId,expectedRevision:3,action:'answer',stepId:askStepId,choices:[0,2],text:'and a drone shot'});
  assert.equal(await f.session.answer(askStepId,[1]),false,'an answered question takes no second answer');assert.equal(f.actions.length,1);
});
test('a composer answer consumes only the draft it captured, and a reopened answer receipt is only looked up',async t=>{
  const held=deferred<AgentTaskSnapshot>();
  const f=fixture({list:async()=>({...project(),runs:[waiting().run]}),read:async()=>waiting(),conversation:async()=>({conversation:conversation(waiting().run),runs:[waiting().run],nextCursor:null}),action:async(_,input)=>{f.actions.push(input);return held.promise;}});
  t.after(()=>f.session.dispose());await f.session.load();await flush();
  f.session.edit('Open on the harbour');const answering=f.session.answer(askStepId,[],'Open on the harbour');
  const done=snapshot('running',4);held.resolve({...done,run:{...done.run,conversationId:runId},steps:[askStep('completed',{answer:{choices:[],text:'Open on the harbour'}})]});
  assert.equal(await answering,true);assert.equal(f.session.getState().draft,'','the captured draft is consumed');
  assert.deepEqual((f.actions[0] as {choices:unknown;text:unknown}).choices,[]);
  let lookups=0;const pending={requestId:crypto.randomUUID(),runId,action:'answer' as const,conversationId:runId};
  const reopened=fixture({list:async()=>({...project(),runs:[waiting().run]}),read:async()=>waiting(),lookup:async()=>{lookups++;return {found:false};},action:async()=>{throw new Error('never resent');}},pending);
  t.after(()=>reopened.session.dispose());await reopened.session.load();await reopened.session.reconcile();
  assert.ok(lookups>=1);assert.equal(reopened.actions.length,0);assert.equal(reopened.receipts.get(projectId)?.action,'answer');
});
function randomStep(){return '77777777-7777-4777-8777-777777777777';}

