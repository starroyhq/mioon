import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {AppError, isAgentTimelineGainProposal, TIMELINE_RESPONSE_BYTES} from '@mioon/contracts';
import {canonical} from '../packages/business/src/services.mjs';
import {agentTimelineGainFixture} from './helpers/agent-timeline-gain-fixture.mjs';
const code = expected => error => error.code === expected;
const fields = (f, extra = {}) => ({projectId: f.project.id, expectedRevision: f.current().revision, requestId: randomUUID(), ...extra});
const domain = f => JSON.stringify(['projects','assets','shots','jobs','versions','timelines','timeline_history','timeline_history_cursors','timeline_requests'].map(table => f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

test('gain review freezes exact owned audio and applies one patch through the timeline journal only after approval', async t => {
 const f = await agentTimelineGainFixture(t), before = domain(f), prepared = f.prepare(), proposal = f.create(prepared), definition = JSON.parse(f.row(proposal).definition);
 assert.equal(domain(f), before); assert.equal(f.calls, 0); assert.equal(definition.version, 3);
 assert.deepEqual(definition.target.source, {id:f.asset.id,sha256:f.asset.sha256,mimeType:f.asset.mimeType,hasAudio:true});
 assert.deepEqual(definition.target.clip, f.clip); assert.deepEqual(proposal.patch, {gain:0.4}); assert.deepEqual(proposal.diff, {before:{gain:1},after:{gain:0.4}});
 assert.equal(isAgentTimelineGainProposal(proposal,{projectId:f.project.id}), true); assert.equal(JSON.stringify(proposal).includes('PRIVATE'), false);
 assert.equal(JSON.stringify(proposal).includes('sha256'), false); assert.equal(JSON.stringify(proposal).includes('assetId'), false);
 await assert.rejects(f.edits.approve(f.request(proposal)), code('AGENT_EDIT_RUN_INCOMPLETE')); f.finish(prepared,proposal);
 const applied = await f.edits.approve(f.request(proposal)); assert.equal(applied.status,'applied'); assert.equal(f.calls,1);
 assert.deepEqual(f.current().clips[0], {...f.clip,gain:0.4}); assert.deepEqual(f.current().tracks, f.timeline.tracks); assert.equal(f.current().durationFrames, f.timeline.durationFrames);
 assert.deepEqual(applied.outcome,{status:'applied',timelineId:f.timeline.id,clipId:f.clip.id,revision:3});
 assert.equal(f.store.db.prepare('SELECT requestHash FROM timeline_requests WHERE requestId=?').get(definition.input.requestId).requestHash,createHash('sha256').update(canonical({operation:'timeline.clip.update',input:definition.input})).digest('hex'));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM mutation_requests').get().n,0);
});

test('gain rejects no-op, injected authority, non-number and invalid source eligibility without effects', async t => {
 const f = await agentTimelineGainFixture(t);
 for (const changes of [{gain:1},{gain:-1},{gain:2.1},{gain:'0.4'},{gain:null},{gain:0.4,startFrame:40},{gain:0.4,requestId:randomUUID()}]) {
  const prepared=f.prepare(changes), before=domain(f); assert.throws(()=>f.create(prepared),code('AGENT_EDIT_VALIDATION')); assert.equal(domain(f),before); f.finish(prepared,null,'failed');
 }
 for (const hasAudio of [false,undefined]) {
  const asset={...f.asset};if(hasAudio===undefined)delete asset.hasAudio;else asset.hasAudio=hasAudio;f.store.put('assets',asset);const before=domain(f);
  assert.throws(()=>f.edits.pinTimelineGainTarget(f.project.id,{timelineId:f.timeline.id,clipId:f.clip.id,expectedRevision:f.current().revision}));assert.equal(domain(f),before);
 }
});

test('gain fresh source identity and metadata tamper fail closed in shared mutation transaction', async t => {
 for (const change of [{hasAudio:false},{sha256:'b'.repeat(64)}]) {
  const f=await agentTimelineGainFixture(t), proposal=f.proposal();f.store.put('assets',{...f.asset,...change});const before=domain(f);
  if(change.sha256)await assert.rejects(f.edits.approve(f.request(proposal)));else assert.equal((await f.edits.approve(f.request(proposal))).status,'unknown');assert.equal(domain(f),before);assert.equal(f.current().clips[0].gain,1);
 }
});

test('gain stale revision records exact rollback proof and never rebase or write history', async t => {
 const f=await agentTimelineGainFixture(t),proposal=f.proposal();await f.services.call('timeline.track.update',fields(f,{trackId:f.clip.trackId,patch:{muted:true}}));const before=domain(f);
 const result=await f.edits.approve(f.request(proposal));assert.equal(result.status,'failed');assert.deepEqual(result.outcome,{status:'not_applied',code:'REVISION_CONFLICT'});assert.equal(domain(f),before);
});

test('gain uncertain dispatch recovery retains original input, approval, and idempotent history', async t => {
 const f=await agentTimelineGainFixture(t),proposal=f.proposal(),request=f.request(proposal),definition=f.row(proposal).definition;
 f.setDispatch(()=>{throw new AppError('REVISION_CONFLICT','unbound error',409);});assert.equal((await f.edits.approve(request)).status,'unknown');const approval=f.row(proposal).approval;
 f.setDispatch((projectId,input,target,services)=>services.setTimelineClipGainInProject(projectId,input,target));assert.equal((await f.edits.recover(request)).status,'applied');
 assert.equal(f.row(proposal).approval,approval);assert.equal(f.row(proposal).definition,definition);const before=domain(f);await f.edits.recover(request);assert.equal(domain(f),before);assert.equal(f.calls,2);
});

test('historical gain ACK survives later gain, mute, undo, clip removal, metadata discovery and restart', async t => {
 const f=await agentTimelineGainFixture(t),proposal=f.proposal(),request=f.request(proposal),applied=await f.edits.approve(request),definition=JSON.parse(f.row(proposal).definition);
 await f.services.call('timeline.clip.update',fields(f,{clipId:f.clip.id,patch:{gain:0.8}}));await f.services.call('timeline.track.update',fields(f,{trackId:f.clip.trackId,patch:{muted:true}}));
 assert.deepEqual(f.edits.get({projectId:f.project.id,proposalId:proposal.id}).outcome,applied.outcome);
 await f.services.call('timeline.undo',fields(f));await f.services.call('timeline.undo',fields(f));await f.services.call('timeline.undo',fields(f));assert.equal(f.current().clips[0].gain,1);
 await f.services.call('timeline.clip.remove',fields(f,{clipId:f.clip.id}));f.store.put('assets',{...f.asset,hasAudio:false,duration:1});const before=domain(f);
 assert.deepEqual(f.edits.get({projectId:f.project.id,proposalId:proposal.id}).outcome,applied.outcome);
 const replay=f.services.setTimelineClipGainInProject(f.project.id,definition.input,definition.target);assert.equal(replay.revision,applied.outcome.revision);assert.equal(domain(f),before);
 f.restart();assert.deepEqual((await f.edits.recover(request)).outcome,applied.outcome);assert.equal(f.calls,1);
});

test('gain applied receipt source reassignment cannot disclose historical ACK', async t => {
 const f=await agentTimelineGainFixture(t),proposal=f.proposal();await f.edits.approve(f.request(proposal));await f.services.call('timeline.clip.remove',fields(f,{clipId:f.clip.id}));
 f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.other.id,JSON.stringify({...f.asset,projectId:f.other.id}),f.asset.id);
 assert.throws(()=>f.edits.get({projectId:f.project.id,proposalId:proposal.id}),code('TIMELINE_SOURCE_UNAVAILABLE'));
});


test('gain supports exact 0 and 2, muted audio and hidden video without changing track state', async t => {
 for(const gain of [0,2,0.4000000000000001]) {
  const f=await agentTimelineGainFixture(t);await f.services.call('timeline.track.update',fields(f,{trackId:f.clip.trackId,patch:{muted:true,hidden:true}}));
  const before=f.current(),proposal=f.proposal({gain});assert.equal(proposal.target.trackMuted,true);assert.equal((await f.edits.approve(f.request(proposal))).status,'applied');
  assert.equal(f.current().clips[0].gain,gain);assert.deepEqual(f.current().tracks,before.tracks);assert.equal(f.current().durationFrames,before.durationFrames);
 }
});

test('gain saved audio-only clip is eligible but image and absent saved timeline do not lazily initialize', async t => {
 const f=await agentTimelineGainFixture(t),audio=f.store.put('assets',{...f.asset,id:randomUUID(),mimeType:'audio/wav',hasVideo:false});
 await f.services.call('timeline.clip.add',fields(f,{assetId:audio.id,trackId:f.timeline.tracks[2].id,startFrame:0,durationFrames:60}));
 const clip=f.current().clips.find(value=>value.assetId===audio.id),target=f.edits.pinTimelineGainTarget(f.project.id,{timelineId:f.timeline.id,clipId:clip.id,expectedRevision:f.current().revision});
 assert.equal(target.source.hasAudio,true);assert.equal(target.track.kind,'audio');
 const image=f.store.put('assets',{...f.asset,id:randomUUID(),mimeType:'image/png',hasAudio:false,hasVideo:false});
 await f.services.call('timeline.clip.add',fields(f,{assetId:image.id,trackId:f.timeline.tracks[1].id,startFrame:0,durationFrames:30}));const imageClip=f.current().clips.find(value=>value.assetId===image.id);
 const before=domain(f);assert.throws(()=>f.edits.pinTimelineGainTarget(f.project.id,{timelineId:f.timeline.id,clipId:imageClip.id,expectedRevision:f.current().revision}));assert.throws(()=>f.edits.pinTimelineGainTarget(f.other.id,{timelineId:randomUUID(),clipId:randomUUID(),expectedRevision:1}));assert.equal(domain(f),before);
});

test('gain two approval windows, rejection and stop cannot multiply or authorize dispatch', async t => {
 const f=await agentTimelineGainFixture(t),proposal=f.proposal(),second=f.second();
 await Promise.all([f.edits.approve(f.request(proposal)),second.approve(f.request(proposal))]);assert.equal(f.calls,1);
 const rejected=f.proposal({gain:0.6});f.edits.reject(f.request(rejected));assert.equal((await second.approve(f.request(rejected))).status,'rejected');
 const prepared=f.prepare({gain:0.6}),stopped=f.create(prepared);f.finish(prepared,stopped,'stopped');f.edits.cancelRun(prepared.runId);await assert.rejects(f.edits.approve(f.request(stopped)),code('AGENT_EDIT_RUN_INCOMPLETE'));assert.equal(f.calls,1);
});

test('gain lost ACK and approval-before-dispatch recovery never infer or mint a fresh key', async t => {
 for(const point of ['afterApproval','afterDispatch']) {
  const f=await agentTimelineGainFixture(t),proposal=f.proposal(),request=f.request(proposal);f.setFault(label=>{if(label===point)throw Error('synthetic interruption');});
  await assert.rejects(f.edits.approve(request),/synthetic interruption/);const row=f.row(proposal),calls=f.calls;
  f.restart();f.setFault(()=>{});f.edits.reconcile();assert.equal(f.calls,calls);assert.equal(f.row(proposal).approval,row.approval);assert.equal(f.row(proposal).definition,row.definition);
  assert.equal((await f.edits.recover(request)).status,'applied');assert.equal(f.calls,point==='afterApproval'?1:calls);
 }
});


test('gain receipt hash, historical target and oversized response corruption fail closed without replay writes', async t => {
 for(const damage of ['hash','clip','oversize']) {
  const f=await agentTimelineGainFixture(t),proposal=f.proposal();f.setFault(label=>{if(label==='afterDispatch')throw Error('lost ACK');});await assert.rejects(f.edits.approve(f.request(proposal)),/lost ACK/);
  const input=JSON.parse(f.row(proposal).definition).input,receipt=f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(input.requestId);
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses');
  let response=receipt.response;if(damage==='clip'){const snapshot=JSON.parse(response);snapshot.clips[0].name='Corrupted historical clip';response=JSON.stringify(snapshot);}if(damage==='oversize')response=' '.repeat(TIMELINE_RESPONSE_BYTES+1);
  f.store.db.prepare('UPDATE timeline_requests SET requestHash=?,response=? WHERE requestId=?').run(damage==='hash'?'f'.repeat(64):receipt.requestHash,response,input.requestId);
  f.setFault(()=>{});f.edits.reconcile();assert.equal(f.row(proposal).status,'unknown');const before=domain(f);await assert.rejects(f.edits.recover(f.request(proposal)));assert.equal(f.calls,1);assert.equal(domain(f),before);
 }
});

test('gain same-revision frozen clip, muted track, and format tampering cannot pass fresh mutation scope', async t => {
 for(const damage of ['clip','track','format']) {
  const f=await agentTimelineGainFixture(t),proposal=f.proposal(),current=f.current();
  if(damage==='clip')current.clips[0].sourceInFrame++;if(damage==='track')current.tracks[0].muted=true;if(damage==='format'){current.width=1280;current.height=720;current.clips[0].rect={x:0,y:0,width:1280,height:720};}
  f.store.put('timelines',current);const before=domain(f);assert.equal((await f.edits.approve(f.request(proposal))).status,'unknown');assert.equal(domain(f),before);
 }
});

test('gain rejected no-op preserves redo branch and a fresh approved gain clears it once', async t => {
 const f=await agentTimelineGainFixture(t),proposal=f.proposal();await f.edits.approve(f.request(proposal));await f.services.call('timeline.undo',fields(f));
 const historyBefore=f.store.db.prepare('SELECT * FROM timeline_history ORDER BY position').all(),prepared=f.prepare({gain:1});assert.throws(()=>f.create(prepared),code('AGENT_EDIT_VALIDATION'));f.finish(prepared,null,'failed');
 assert.deepEqual(f.store.db.prepare('SELECT * FROM timeline_history ORDER BY position').all(),historyBefore);
 const fresh=f.proposal({gain:0.7});await f.edits.approve(f.request(fresh));await assert.rejects(f.services.call('timeline.redo',fields(f)),code('NOTHING_TO_REDO'));
 const before=domain(f);await f.edits.recover(f.request(proposal));assert.equal(domain(f),before);assert.equal(f.current().clips[0].gain,0.7);
});

test('gain proposal quota retains existing unknown work and never creates a second request key', async t => {
 const f=await agentTimelineGainFixture(t,{limits:{rows:1}}),proposal=f.proposal();f.setDispatch(()=>{throw Error('unknown dispatch');});assert.equal((await f.edits.approve(f.request(proposal))).status,'unknown');const row=f.row(proposal);
 const second=f.prepare({gain:0.6});assert.throws(()=>f.create(second),code('AGENT_EDIT_STORAGE_LIMIT'));assert.deepEqual(f.row(proposal),row);assert.equal(f.store.db.prepare('SELECT count(*) n FROM agent_edit_proposals').get().n,1);
});
