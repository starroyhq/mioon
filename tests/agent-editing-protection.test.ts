import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEditingClient, createAgentEditingProtection, agentEditingOwnerIdentity, agentEditingOwnerInWindow, agentEditingTargetRevision, readAgentEditingWrites } from '../apps/web/src/agent-editing-protection.ts';
import type { AgentEditingClient, AgentEditingObservation } from '../apps/web/src/agent-editing-protection.ts';
import type { AgentTaskClaim, AgentTaskEditingInput, AgentTaskTarget } from '../packages/contracts/src/agent-tasks-v2.ts';
import { AGENT_TASK_EDITING_CONFLICT_CODES } from '../packages/contracts/src/agent-tasks-v2.ts';
const projectId = crypto.randomUUID(), ownerId = crypto.randomUUID(), target: AgentTaskTarget = { kind: 'timeline_clip', id: crypto.randomUUID(), revision: 999 };
function claim(): AgentTaskClaim { return { id: crypto.randomUUID(), projectId, ownerId, target: { ...target, revision: 7 }, state: 'active', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const observed = (claims: AgentTaskClaim[] = []): AgentEditingObservation => ({ claims, targets: [{ ...target, revision: 7 }] });
test('manual input is admitted only after claim acknowledgment, using monotonic target revision instead of timeline revision', async () => {
  const held = deferred<AgentEditingObservation>(), inputs: AgentTaskEditingInput[] = [];
  const client: AgentEditingClient = { read: async () => observed(), update: async input => { inputs.push(input); return held.promise; } };
  const controller = createAgentEditingProtection({ projectId, ownerId, targets: [target], client }); const acquire = controller.acquire(); assert.equal(controller.canEdit(), false);
  for (let index = 0; index < 8; index++) await Promise.resolve(); assert.equal(inputs[0]?.targets[0]?.revision, 7); assert.equal(controller.canEdit(), false); held.resolve(observed([claim()])); await acquire; assert.equal(controller.canEdit(), true); controller.dispose();
});
test('a lost acquire acknowledgment does not expire or grant input; empty GET cannot disprove a delayed claim', async () => {
  let mutations = 0; const controller = createAgentEditingProtection({ projectId, ownerId, targets: [target], client: { read: async () => observed(), update: async () => { mutations++; throw new Error('lost acknowledgment'); } } });
  await controller.acquire(); assert.equal(controller.getState().phase, 'uncertain'); assert.equal(controller.canEdit(), false); await controller.refresh(); assert.equal(controller.getState().phase, 'uncertain'); assert.equal(await controller.acquire(), false); assert.equal(mutations, 1); controller.dispose();
});
test('a committed claim can be reconciled without another POST; disposal never releases it', async () => {
  let committed = false; const actions: string[] = []; const controller = createAgentEditingProtection({ projectId, ownerId, targets: [target], client: { read: async () => observed(committed ? [claim()] : []), update: async input => { actions.push(input.action); committed = true; throw new Error('lost response'); } } });
  await controller.acquire(); await controller.refresh(); assert.equal(controller.canEdit(), true); controller.dispose(); assert.deepEqual(actions, ['claim']);
});
test('restart-retained claims require explicit resolution and keep the original target owner', async () => {
  const actions: AgentTaskEditingInput[] = []; let claims = [claim()]; const original = [{ ...target }];
  const controller = createAgentEditingProtection({ projectId, ownerId, targets: original, client: { read: async () => observed(claims), update: async input => { actions.push(input); if (input.action === 'resolve') claims = []; return observed(claims); } } }); original[0]!.id = crypto.randomUUID();
  await controller.refresh(); assert.equal(controller.getState().phase, 'retained'); assert.equal(controller.canEdit(), false); await controller.resolve(); assert.equal(controller.getState().phase, 'idle'); assert.equal(actions[0]?.targets[0]?.id, target.id); controller.dispose();
});

test('restart protection resumes only after an explicit exact-owner restore ACK and keeps the original ledger baseline', async () => {
  let claims:AgentTaskClaim[]=[], ledger=7;const inputs:AgentTaskEditingInput[]=[];
  const view=():AgentEditingObservation=>({claims,targets:[{...target,revision:ledger}],timelineRevision:2});
  const controller=createAgentEditingProtection({projectId,ownerId,targets:[target],client:{read:async()=>view(),update:async input=>{inputs.push(input);if(input.action==='claim')claims=[claim()];if(input.action==='restore'){assert.equal(input.targets[0]?.revision,7);if(ledger!==7)throw Object.assign(new Error('changed'),{definitive:true});claims=claims.map(value=>({...value,state:'active'}));}return view();},lookup:async()=>view()}});
  await controller.acquire();assert.equal(controller.canEdit(),true);claims=claims.map(value=>({...value,state:'uncertain'}));await controller.refresh();assert.equal(controller.canEdit(),false);assert.equal(inputs.length,1);await controller.restore();assert.equal(controller.canEdit(),true);assert.deepEqual(inputs.map(input=>input.action),['claim','restore']);
  claims=claims.map(value=>({...value,state:'uncertain'}));ledger=9;await controller.refresh();assert.equal(controller.getState().targets?.[0]?.revision,9);await controller.restore();assert.equal(controller.canEdit(),false);assert.equal(controller.getState().phase,'retained');assert.equal(controller.getState().claims[0]?.target.revision,7);assert.equal(inputs.at(-1)?.targets[0]?.revision,7);controller.dispose();
});

test('a lost restore acknowledgment queries the exact original receipt without another claim or release',async()=>{
  let claims:AgentTaskClaim[]=[{...claim(),state:'uncertain'}],posted:AgentTaskEditingInput|null=null,count=0;
  const controller=createAgentEditingProtection({projectId,ownerId,targets:[target],client:{read:async()=>observed(claims),update:async input=>{count++;posted=input;claims=claims.map(value=>({...value,state:'active'}));throw new Error('lost ACK');},lookup:async(_,__,requestId)=>{assert.equal(requestId,posted?.requestId);assert.ok(posted);return{...observed(claims),receipt:{requestId:posted.requestId,projectId,ownerId,generation:posted.generation,sequence:posted.sequence}};}}});
  await controller.refresh();await controller.restore();assert.equal(controller.canEdit(),false);await controller.refresh();assert.equal(controller.canEdit(),true);assert.equal(count,1);assert.equal((posted as AgentTaskEditingInput|null)?.action,'restore');controller.dispose();
});

test('scope-aware owner identities exclude exactly this window without sharing authority across windows or origins',()=>{
  const windowId=crypto.randomUUID(),id=agentEditingOwnerIdentity('normal',windowId,[target]);assert.equal(agentEditingOwnerInWindow(id,'normal',windowId),true);assert.equal(agentEditingOwnerInWindow(id,'normal',windowId+'x'),false);assert.equal(agentEditingOwnerInWindow(id,'restored:x',windowId),false);assert.equal(agentEditingOwnerInWindow(agentEditingOwnerIdentity('normal',crypto.randomUUID(),[target]),'normal',windowId),false);
});
test('explicit owner invalidation synchronously closes admission and an old read cannot reactivate its cache',async()=>{
  const held=deferred<AgentEditingObservation>();let slow=false,rows:AgentTaskClaim[]=[];
  const controller=createAgentEditingProtection({projectId,ownerId,targets:[target],client:{read:async()=>slow?held.promise:observed(rows),update:async()=>{rows=[claim()];return observed(rows);}}});
  await controller.acquire();assert.equal(controller.canEdit(),true);slow=true;const oldRead=controller.refresh();controller.invalidate();assert.equal(controller.canEdit(),false);held.resolve(observed(rows));await oldRead;assert.equal(controller.canEdit(),false);slow=false;await controller.refresh();assert.equal(controller.getState().phase,'retained');assert.equal(controller.canEdit(),false);rows=[];await controller.refresh();assert.equal(controller.getState().phase,'idle');assert.equal(controller.canEdit(),false);await controller.acquire();assert.equal(controller.canEdit(),true);controller.dispose();
});

test('the first character stays in the draft and a claim sends its displayed revision across a newer owner read', async () => {
  const reply = deferred<Response>(), posted = deferred<AgentTaskEditingInput>();
  const visible = {...target, revision: 5};
  const details = {reason: 'revision_changed', targets: [{kind: target.kind, id: target.id, expectedRevision: 5, currentRevision: 7,
    currentValues: {gainDb: -6}}]};
  const client = createAgentEditingClient({fetchImpl: async (_url, init) => {
    if (init?.method !== 'POST') return Response.json({ok: true, data: observed()});
    posted.resolve(JSON.parse(String(init.body)) as AgentTaskEditingInput);
    return reply.promise;
  }});
  const controller = createAgentEditingProtection({projectId, ownerId, targets: [target], client});
  const draft = {text: '首'};
  const saving: string[] = [];
  const request = controller.acquireAtRevision([visible]).then(result => { if (result.status === 'acquired') saving.push(draft.text); return result; });
  visible.revision = 8;
  const input = await posted.promise;
  assert.equal(input.targets[0]?.revision, 5);
  assert.equal(controller.canEdit(), false);
  assert.deepEqual(saving, []);
  reply.resolve(Response.json({ok: false, error: {code: 'AGENT_TASK_TARGET_CHANGED', details}}, {status: 409}));
  assert.deepEqual(await request, {status: 'rejected', code: 'AGENT_TASK_TARGET_CHANGED', details, requestId: input.requestId});
  assert.equal(draft.text, '首');
  assert.equal(controller.canEdit(), false);
  assert.deepEqual(saving, []);
});

test('a confirmed group claim uses the clip ledger and admits the unmodified first input only upon acknowledgment', async () => {
  const visible = {...target, kind: 'timeline_clip_audio', revision: 7};
  const reply = deferred<AgentEditingObservation>(), posted = deferred<AgentTaskEditingInput>();
  const controller = createAgentEditingProtection({projectId, ownerId, targets: [visible], client: {
    read: async () => ({...observed(), timelineRevision: 25}),
    update: async input => {posted.resolve(input); return reply.promise;},
  }});
  const draft = '首', saving: string[] = [];
  const request = controller.acquireAtRevision([visible]).then(result => {if (result.status === 'acquired') saving.push(draft); return result;});
  const input = await posted.promise;
  assert.deepEqual(input.targets, [visible]);
  assert.equal(controller.canEdit(), false);
  assert.deepEqual(saving, []);
  reply.resolve({claims: [{...claim(), target: visible}], targets: []});
  assert.deepEqual(await request, {status: 'acquired', requestId: input.requestId});
  assert.deepEqual(saving, ['首']);
  assert.equal(controller.canEdit(), true);
  assert.equal(agentEditingTargetRevision(controller.getState().targets ?? [], visible), 7);
  assert.equal(controller.getState().timelineRevision, 25);
  controller.invalidate();
  assert.equal((await controller.reconcileClaimAtRevision([visible], input.requestId)).status, 'rejected');
});

for (const [reason, state] of [['mio_committing', 'committing'], ['outcome_unknown', 'outcome_unknown']] as const) {
  test(`structured ${reason} is carried unchanged through a definitively rejected HTTP request`, async () => {
    const visible = {...target, revision: 7};
    const code = AGENT_TASK_EDITING_CONFLICT_CODES[reason];
    const details = {reason, writes: [{kind: target.kind, id: target.id, state, runId: crypto.randomUUID(), stepId: crypto.randomUUID()}]};
    const client = createAgentEditingClient({fetchImpl: async (_url, init) => init?.method === 'POST'
      ? Response.json({ok: false, error: {code, details}}, {status: 409}) : Response.json({ok: true, data: observed()})});
    const controller = createAgentEditingProtection({projectId, ownerId, targets: [visible], client, requestId: () => 'own-edit-request'});
    assert.deepEqual(await controller.acquireAtRevision([visible]), {status: 'rejected', code, details, requestId: 'own-edit-request'});
    assert.equal(controller.canEdit(), false);
    assert.equal(controller.getState().pending, null);
  });
}

test('an unknown claim ignores a missing or foreign receipt, then settles the original success without posting again', async () => {
  const visible = {...target, revision: 7};
  let posted: AgentTaskEditingInput | undefined, writes = 0, reads = 0;
  let receiptId: string | null = null;
  const client = createAgentEditingClient({fetchImpl: async (url, init) => {
    if (init?.method === 'POST') {
      posted = JSON.parse(String(init.body)) as AgentTaskEditingInput;
      writes++;
      throw new Error('Synthetic lost acknowledgment');
    }
    const requested = new URL(String(url), 'http://synthetic.invalid').searchParams.get('requestId');
    if (!requested) return Response.json({ok: true, data: observed()});
    reads++;
    assert.ok(posted);
    assert.equal(requested, posted.requestId);
    const {projectId, ownerId, generation, sequence} = posted;
    return Response.json({ok: true, data: {...observed([claim()]), ownerVersion: {generation, sequence},
      receipt: receiptId === null ? null : {projectId, ownerId, requestId: receiptId, generation, sequence, claims: [claim()]}}});
  }});
  const controller = createAgentEditingProtection({projectId, ownerId, targets: [visible], client, requestId: () => 'original-request'});
  const unknown = {status: 'unknown', code: 'AGENT_TASK_UNKNOWN_RESULT', requestId: 'original-request'};
  assert.deepEqual(await controller.acquireAtRevision([visible]), unknown);
  assert.equal((await controller.reconcileClaimAtRevision([visible], 'previous-request')).status, 'rejected');
  assert.deepEqual(await controller.reconcileClaimAtRevision([visible], 'original-request'), unknown);
  receiptId = 'different-request';
  assert.deepEqual(await controller.reconcileClaimAtRevision([visible], 'original-request'), unknown);
  assert.equal(controller.canEdit(), false);
  assert.deepEqual(await controller.acquireAtRevision([visible]), unknown, 'repeated input does not republish an ambiguous request');
  receiptId = 'original-request';
  assert.deepEqual(await controller.reconcileClaimAtRevision([visible], 'original-request'), {status: 'acquired', requestId: 'original-request'});
  assert.equal(controller.canEdit(), true);
  assert.equal(writes, 1);
  assert.equal(reads, 3);
});

test('a rejection received after a lost response retains the exact conflict structured in the receipt', async () => {
  const visible = {...target, revision: 7};
  const code = 'AGENT_TASK_TARGET_CHANGED', details = {reason: 'revision_changed', targets: [
    {kind: target.kind, id: target.id, expectedRevision: 7, currentRevision: 8, currentValues: {gainDb: -6}},
  ]};
  let posted: AgentTaskEditingInput | undefined, writes = 0;
  const client = createAgentEditingClient({fetchImpl: async (url, init) => {
    if (init?.method === 'POST') {
      posted = JSON.parse(String(init.body)) as AgentTaskEditingInput;
      writes++;
      throw new Error('Synthetic lost rejection');
    }
    const requested = new URL(String(url), 'http://synthetic.invalid').searchParams.get('requestId');
    if (!requested) return Response.json({ok: true, data: observed()});
    assert.ok(posted);
    const {requestId, projectId, ownerId, generation, sequence} = posted;
    assert.equal(requested, requestId);
    return Response.json({ok: true, data: {claims: [], targets: [{...target, revision: 8}],
      receipt: {requestId, projectId, ownerId, generation, sequence, error: {code, details}}}});
  }});
  const controller = createAgentEditingProtection({projectId, ownerId, targets: [visible], client, requestId: () => 'original-request'});
  assert.equal((await controller.acquireAtRevision([visible])).status, 'unknown');
  assert.deepEqual(await controller.reconcileClaimAtRevision([visible], 'original-request'), {status: 'rejected', code, details, requestId: 'original-request'});
  assert.equal(controller.canEdit(), false);
  assert.equal(controller.getState().pending, null);
  assert.equal(writes, 1);
});

test('Mio write status comes from the project editing writes read', async () => {
  const writes = [{kind: 'timeline_clip_visual', id: target.id, state: 'committing', runId: crypto.randomUUID(), stepId: crypto.randomUUID()}];
  assert.deepEqual(await readAgentEditingWrites(projectId, {fetchImpl: async (url, init) => {
    assert.equal(url, `/api/projects/${projectId}/agent/tasks/v2/editing/writes`);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.cache, 'no-store');
    return Response.json({ok: true, data: {writes}});
  }}), {writes});
});
