import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentEditingProtection, agentEditingOwnerIdentity, agentEditingOwnerInWindow } from '../apps/web/src/agent-editing-protection.ts';
import type { AgentEditingClient, AgentEditingObservation } from '../apps/web/src/agent-editing-protection.ts';
import type { AgentTaskClaim, AgentTaskEditingInput, AgentTaskTarget } from '../packages/contracts/src/agent-tasks-v2.ts';
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
