import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createProjectRulesState, projectRulesReceiptKey} from '../apps/web/src/project-rules-state.ts';
import {ProjectRulesRequestError} from '../apps/web/src/project-rules-client.ts';
import type {WebProjectRulesClient} from '../apps/web/src/project-rules-client.ts';
import type {ProjectRulesSnapshot, ProjectRulesRequestLookup} from '../packages/contracts/src/mio-rules.ts';

function fixture() {
  const projectId = randomUUID(), values = new Map<string, string>(), calls: Array<{method: string; requestId?: string}> = [];
  let snapshot: ProjectRulesSnapshot = {projectId, file: 'AGENTS.md', exists: true, text: 'old', hash: 'a'.repeat(64), trust: 'trusted', maxBytes: 8192, readError: null, pendingWrites: false};
  let outcome: ProjectRulesRequestLookup['status'] = 'uncertain', fail: Error | null = null;
  const client: WebProjectRulesClient = {
    read: async () => {calls.push({method: 'read'}); return snapshot;},
    save: async (_id, input) => {calls.push({method: 'save', requestId: input.requestId}); if (fail) throw fail; snapshot = {...snapshot, text: input.text, hash: 'b'.repeat(64), trust: 'trusted'}; return snapshot;},
    enable: async (_id, input) => {calls.push({method: 'enable', requestId: input.requestId}); if (fail) throw fail; snapshot = {...snapshot, trust: 'trusted'}; return snapshot;},
    lookup: async (_id, requestId) => {calls.push({method: 'lookup', requestId}); return lookup(requestId);},
    reconcile: async (_id, requestId) => {calls.push({method: 'reconcile', requestId}); return lookup(requestId);},
  };
  function lookup(requestId: string): ProjectRulesRequestLookup { return outcome === 'uncertain' ? {projectId, requestId, status: 'uncertain', state: 'trust_pending', result: null} : outcome === 'not_applied' ? {projectId, requestId, status: 'not_applied', state: 'not_applied', result: null} : {projectId, requestId, status: 'applied', state: 'completed', result: snapshot}; }
  const storage = () => ({getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}});
  const create = () => createProjectRulesState({projectId, client, storage});
  return {projectId, values, calls, client, storage, create, snapshot, setSnapshot: (next: ProjectRulesSnapshot) => {snapshot = next;}, fail: (next: Error | null) => {fail = next;}, outcome: (next: typeof outcome) => {outcome = next;}};
}

test('unknown survives closing; opening only reads and explicit checks retain the original request and never resubmit', async () => {
  const f = fixture(), first = f.create(); await first.load(); first.setDraft('exact\r\n😀'); f.fail(new ProjectRulesRequestError('TIMEOUT', true)); assert.equal(await first.save(), false);
  const original = first.getSnapshot().pending; assert.ok(original); const key = projectRulesReceiptKey(f.projectId); assert.ok(f.values.has(key)); first.dispose();
  const second = f.create(); await second.load(); assert.equal(second.getSnapshot().draft, 'exact\r\n😀'); assert.deepEqual(second.getSnapshot().pending, original); assert.deepEqual(f.calls.map(call => call.method), ['read', 'save', 'read']);
  assert.equal(await second.save(), false); await second.lookup(); assert.equal(second.getSnapshot().lookup?.status, 'uncertain'); assert.equal(f.calls.at(-1)?.requestId, original.input.requestId);
  f.outcome('applied'); f.setSnapshot({...f.snapshot, text: 'exact\r\n😀', hash: 'b'.repeat(64)}); await second.reconcile();
  assert.equal(f.calls.filter(call => call.method === 'save').length, 1); assert.deepEqual(f.calls.filter(call => ['lookup', 'reconcile'].includes(call.method)).map(call => call.requestId), [original.input.requestId, original.input.requestId]); assert.equal(f.values.size, 0); assert.equal(second.getSnapshot().pending, null); second.dispose();
});

test('conflict retains the draft until explicit load-latest, while edited untrusted enable uses one exact save', async () => {
  const f = fixture(), controller = f.create(); await controller.load(); controller.setDraft('my draft'); f.fail(new ProjectRulesRequestError('MIO_RULES_CONFLICT'));
  assert.equal(await controller.save(), false); assert.equal(controller.getSnapshot().mutation, 'conflict'); assert.equal(controller.getSnapshot().draft, 'my draft'); assert.equal(f.values.size, 0);
  f.setSnapshot({...f.snapshot, text: 'external', hash: 'c'.repeat(64), trust: 'untrusted'}); await controller.load(); assert.equal(controller.getSnapshot().draft, 'my draft'); assert.equal(await controller.enable(), false);
  await controller.loadLatest(); assert.equal(controller.getSnapshot().draft, 'external'); f.fail(null); controller.setDraft('edited external\r\n'); assert.equal(await controller.enable(), true);
  assert.deepEqual(f.calls.filter(call => call.method === 'enable'), []); assert.equal(f.calls.filter(call => call.method === 'save').length, 2); controller.dispose();
});

test('pending, unsafe/unavailable and invalid text cannot dispatch writes or be treated as enabled', async () => {
  for (const snapshot of [{...fixture().snapshot, trust: 'pending' as const, pendingWrites: true}, {...fixture().snapshot, trust: 'unavailable' as const, text: null, hash: null, readError: 'unsafe_file' as const}]) {
    const f = fixture(); f.setSnapshot({...snapshot, projectId: f.projectId}); const controller = f.create(); await controller.load(); controller.setDraft('new'); assert.equal(await controller.save(), false); assert.equal(await controller.enable(), false); assert.deepEqual(f.calls.map(call => call.method), ['read']); controller.dispose();
  }
  const f = fixture(), controller = f.create(); await controller.load(); for (const text of ['x'.repeat(8193), '雨'.repeat(2731), '\ud800']) {controller.setDraft(text); assert.equal(await controller.save(), false);} assert.deepEqual(f.calls.map(call => call.method), ['read']); controller.dispose();
});

test('not-applied lookup keeps the draft but does not retry publication, and receipt failures refuse before effects', async () => {
  const f = fixture(), controller = f.create(); await controller.load(); controller.setDraft('still here'); f.fail(new ProjectRulesRequestError('BACKEND_UNAVAILABLE', true)); await controller.save(); f.outcome('not_applied'); await controller.lookup();
  assert.equal(controller.getSnapshot().draft, 'still here'); assert.equal(controller.getSnapshot().lookup?.status, 'not_applied'); assert.equal(controller.getSnapshot().pending, null); assert.equal(f.calls.filter(call => call.method === 'save').length, 1); controller.dispose();
  const blocked = createProjectRulesState({projectId: f.projectId, client: f.client, storage: () => ({...f.storage(), setItem: () => {throw Error('denied');}})}); await blocked.load(); blocked.setDraft('blocked'); assert.equal(await blocked.save(), false); assert.equal(blocked.getSnapshot().error, 'LOCAL_RECEIPT_UNAVAILABLE'); assert.equal(f.calls.filter(call => call.method === 'save').length, 1); blocked.dispose();
});

test('late reads cannot replace newer reads or publish after disposal; StrictMode reconnect starts a fresh epoch', async () => {
  const f = fixture(), reads: Array<(value: ProjectRulesSnapshot) => void> = [];
  f.client.read = async () => new Promise(resolve => reads.push(resolve)); const controller = f.create(); let updates = 0; controller.subscribe(() => updates++);
  const first = controller.load(), second = controller.load(); reads[1]!({...f.snapshot, text: 'new'}); await second; reads[0]!({...f.snapshot, text: 'stale'}); await first; assert.equal(controller.getSnapshot().draft, 'new');
  const late = controller.load(); controller.dispose(); const before = updates; reads[2]!({...f.snapshot, text: 'closed'}); await late; assert.equal(updates, before); assert.equal(controller.getSnapshot().draft, 'new');
  controller.connect(); const again = controller.load(); reads[3]!({...f.snapshot, text: 'reconnected'}); await again; assert.equal(controller.getSnapshot().snapshot?.text, 'reconnected'); controller.dispose();
});

test('a second controller does not overwrite another unresolved original identity', async () => {
  const f = fixture(), first = f.create(), second = f.create(); await first.load(); await second.load(); first.setDraft('first'); second.setDraft('second'); f.fail(new ProjectRulesRequestError('TIMEOUT', true)); await first.save(); const original = first.getSnapshot().pending; assert.ok(original);
  assert.equal(await second.save(), false); assert.deepEqual(second.getSnapshot().pending, original); assert.equal(second.getSnapshot().draft, 'first'); assert.equal(f.calls.filter(call => call.method === 'save').length, 1); first.dispose(); second.dispose();
});

test('a failed read and later successful reload cannot clear the independent local-receipt block', async () => {
  const f = fixture(); let failRead = true;
  f.client.read = async () => {if (failRead) throw new ProjectRulesRequestError('BACKEND_UNAVAILABLE'); return f.snapshot;};
  const controller = createProjectRulesState({projectId: f.projectId, client: f.client, storage: () => {throw Error('local storage unavailable');}});
  await controller.load(); assert.equal(controller.getSnapshot().phase, 'error'); assert.equal(controller.getSnapshot().error, 'BACKEND_UNAVAILABLE'); assert.equal(controller.getSnapshot().receiptBlocked, true);
  failRead = false; await controller.load(); assert.equal(controller.getSnapshot().phase, 'ready'); assert.equal(controller.getSnapshot().receiptBlocked, true);
  controller.setDraft('cannot silently submit'); assert.equal(await controller.save(), false); assert.equal(f.calls.some(call => call.method === 'save'), false); controller.dispose();
});


test('live project admission fences reads, captured writers and receipt observation without clearing a retained draft',async()=>{
  const f=fixture();let allowed=true;const controller=createProjectRulesState({projectId:f.projectId,client:f.client,storage:f.storage,admission:{scope:'a'.repeat(64),key:'scope-A:instance-A',isCurrent:()=>allowed}});await controller.load();controller.setDraft('retained\r\n😀');allowed=false;await controller.load();assert.equal(await controller.save(),false);assert.equal(await controller.enable(),false);await controller.lookup();await controller.reconcile();controller.setDraft('stale callback');assert.equal(controller.getSnapshot().draft,'retained\r\n😀');assert.deepEqual(f.calls.map(call=>call.method),['read']);controller.dispose();
});

test('late rules reads and write ACKs cannot publish into a revoked owner or erase its original pending receipt',async()=>{
  const f=fixture();let allowed=true;const pending=Promise.withResolvers<ProjectRulesSnapshot>();f.client.read=async()=>pending.promise;const controller=createProjectRulesState({projectId:f.projectId,client:f.client,storage:f.storage,admission:{scope:'a'.repeat(64),key:'scope-A:instance-A',isCurrent:()=>allowed}});const reading=controller.load();allowed=false;pending.resolve(f.snapshot);await reading;assert.equal(controller.getSnapshot().snapshot,null);assert.equal(controller.getSnapshot().phase,'loading');controller.dispose();
  const g=fixture(),ack=Promise.withResolvers<ProjectRulesSnapshot>();let current=true;g.client.save=async()=>ack.promise;const writer=createProjectRulesState({projectId:g.projectId,client:g.client,storage:g.storage,admission:{scope:'a'.repeat(64),key:'scope-A:instance-A',isCurrent:()=>current}});await writer.load();writer.setDraft('exact pending');const sending=writer.save(),original=writer.getSnapshot().pending;assert.ok(original);current=false;ack.resolve({...g.snapshot,text:'exact pending'});assert.equal(await sending,false);assert.equal(writer.getSnapshot().mutation,'unknown');assert.deepEqual(writer.getSnapshot().pending,original);assert.equal(writer.getSnapshot().draft,'exact pending');assert.ok(g.values.has(projectRulesReceiptKey(g.projectId,'a'.repeat(64))));const calls=g.calls.length;await writer.lookup();await writer.reconcile();assert.equal(g.calls.length,calls);writer.dispose();
});


test('persisted rules intents are library scoped and remain queryable after a same-library backend restart',async()=>{
  const f=fixture(),scopeA='a'.repeat(64),scopeB='b'.repeat(64),create=(scope:string,instance:string)=>createProjectRulesState({projectId:f.projectId,client:f.client,storage:f.storage,admission:{scope,key:scope+instance,isCurrent:()=>true}});
  const a=create(scopeA,'instance-1');await a.load();a.setDraft('A exact unknown');f.fail(new ProjectRulesRequestError('TIMEOUT',true));await a.save();const original=a.getSnapshot().pending;assert.ok(original);const key=projectRulesReceiptKey(f.projectId,scopeA),raw=f.values.get(key);a.dispose();
  const b=create(scopeB,'instance-2');await b.load();assert.equal(b.getSnapshot().pending,null);assert.equal(b.getSnapshot().draft,'old');await b.lookup();await b.reconcile();assert.equal(f.calls.filter(x=>x.method==='lookup'||x.method==='reconcile').length,0);assert.equal(f.values.get(key),raw);f.fail(null);b.setDraft('B independent');assert.equal(await b.save(),true);assert.equal(f.values.get(key),raw);assert.notEqual(f.calls.filter(x=>x.method==='save')[1]!.requestId,original.input.requestId);b.dispose();
  const restarted=create(scopeA,'instance-3');await restarted.load();assert.deepEqual(restarted.getSnapshot().pending,original);assert.equal(restarted.getSnapshot().draft,'A exact unknown');await restarted.lookup();assert.equal(f.calls.at(-1)?.requestId,original.input.requestId);assert.equal(f.calls.filter(x=>x.method==='save').length,2);assert.equal(f.values.get(key),raw);restarted.dispose();
});

test('unscoped legacy rules intent is retained verbatim and cannot be assigned to, queried by or resent in a library',async()=>{
  const f=fixture(),scope='a'.repeat(64),key=projectRulesReceiptKey(f.projectId),legacy=JSON.stringify({projectId:f.projectId,action:'save',input:{requestId:randomUUID(),expectedHash:null,text:'legacy exact draft'}});f.values.set(key,legacy);
  const controller=createProjectRulesState({projectId:f.projectId,client:f.client,storage:f.storage,admission:{scope,key:scope+'instance',isCurrent:()=>true}});await controller.load();assert.equal(controller.getSnapshot().draft,'legacy exact draft');assert.equal(controller.getSnapshot().receiptOwnerUnknown,true);assert.equal(controller.getSnapshot().receiptBlocked,true);assert.equal(await controller.save(),false);await controller.lookup();await controller.reconcile();assert.deepEqual(f.calls.map(x=>x.method),['read']);assert.equal(f.values.get(key),legacy);assert.equal(f.values.has(projectRulesReceiptKey(f.projectId,scope)),false);controller.dispose();
});
