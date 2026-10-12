import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {AppError,isAgentTimelineMoveProposal,TIMELINE_RESPONSE_BYTES} from '@mioon/contracts';
import {canonical} from '../packages/business/src/services.mjs';
import {editToolPolicy} from '../packages/business/src/agent/edit-tool-policy.mjs';
import {agentTimelineMoveFixture} from './helpers/agent-timeline-move-fixture.mjs';
const code=expected=>error=>error.code===expected;
const fields=(f,extra={})=>({projectId:f.project.id,expectedRevision:f.current().revision,requestId:randomUUID(),...extra});
const domain=f=>JSON.stringify(['projects','assets','shots','jobs','versions','timelines','timeline_history','timeline_history_cursors','timeline_requests'].map(table=>f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));

test('timeline proposal is a private pinned, startFrame-only durable review and never writes before approval',async t=>{
 const f=await agentTimelineMoveFixture(t),before=domain(f),prepared=f.prepare(),proposal=f.create(prepared),row=f.row(proposal),definition=JSON.parse(row.definition);
 assert.equal(domain(f),before);assert.equal(f.calls,0);assert.equal(row.shotId,null);assert.equal(row.targetKind,'timeline_clip');assert.equal(row.timelineId,f.timeline.id);assert.equal(row.clipId,f.clip.id);
 assert.equal(definition.version,2);assert.equal(definition.operation,'timeline.clip.update');assert.deepEqual(definition.target.clip,f.clip);assert.deepEqual(proposal.patch,{startFrame:120});
 assert.deepEqual(proposal.diff,{before:{startFrame:30,endFrame:90,durationFrames:60,timelineDurationFrames:90},after:{startFrame:120,endFrame:180,durationFrames:60,timelineDurationFrames:180}});
 assert.equal(isAgentTimelineMoveProposal(proposal,{projectId:f.project.id}),true);assert.equal(JSON.stringify(proposal).includes('PRIVATE'),false);
 assert.equal(JSON.stringify(proposal).includes('assetId'),false);assert.equal(JSON.stringify(proposal).includes('sourceInFrame'),false);
 assert.throws(()=>f.edits.createInside(prepared),/capture transaction/);
 await assert.rejects(f.edits.approve(f.request(proposal)),code('AGENT_EDIT_RUN_INCOMPLETE'));
 f.finish(prepared,proposal);const savedRow=f.row(proposal);
 f.setDispatch((projectId,input,target,services)=>{
  const approved=f.row(proposal),approval=JSON.parse(approved.approval);assert.equal(approved.status,'dispatching');assert.deepEqual(approval.input,definition.input);assert.equal(f.store.db.isTransaction,false);
  return services.moveTimelineClipInProject(projectId,input,target);
 });
 const applied=await f.edits.approve(f.request(proposal));assert.equal(applied.status,'applied');assert.equal(f.calls,1);assert.deepEqual(f.current().clips[0],{...f.clip,startFrame:120});
 assert.equal(f.row(proposal).definition,savedRow.definition);assert.deepEqual(applied.outcome,{status:'applied',timelineId:f.timeline.id,clipId:f.clip.id,revision:3});
 const receipt=f.store.db.prepare('SELECT * FROM timeline_requests WHERE requestId=?').get(definition.input.requestId);
 assert.equal(receipt.requestHash,createHash('sha256').update(canonical({operation:'timeline.clip.update',input:definition.input})).digest('hex'));
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM mutation_requests').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM edit_tasks').get().n,0);
 assert.equal(f.store.db.prepare('SELECT operation FROM timeline_history ORDER BY position DESC LIMIT 1').get().operation,'timeline.clip.update');
});

test('review rejects same start, injected authority, range overflow and same-track overlap',async t=>{
 const f=await agentTimelineMoveFixture(t);
 for(const changes of [{startFrame:30},{startFrame:-1},{startFrame:18000},{startFrame:10.5},{startFrame:120,clipId:randomUUID()},{startFrame:120,trackId:f.timeline.tracks[1].id}]){
  const prepared=f.prepare(changes);assert.throws(()=>f.create(prepared),code('AGENT_EDIT_VALIDATION'));f.finish(prepared,null,'failed');
 }
 await f.services.call('timeline.clip.add',fields(f,{assetId:f.asset.id,trackId:f.clip.trackId,startFrame:180,durationFrames:60}));
 const prepared=f.prepare({startFrame:150});assert.throws(()=>f.create(prepared),code('AGENT_EDIT_VALIDATION'));assert.equal(f.calls,0);
});

test('stale approval produces only exact request-bound not_applied proof, with no rebase or history write',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal();
 await f.services.call('timeline.track.update',fields(f,{trackId:f.clip.trackId,patch:{name:'Renamed'}}));const before=domain(f);
 const result=await f.edits.approve(f.request(proposal));assert.equal(result.status,'failed');assert.deepEqual(result.outcome,{status:'not_applied',code:'REVISION_CONFLICT'});assert.equal(domain(f),before);
 assert.equal((await f.edits.recover(f.request(proposal))).status,'failed');assert.equal(f.calls,1);
});

test('generic errors stay unknown; explicit recovery retains exact input and approval bytes',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal(),request=f.request(proposal),row=f.row(proposal),definition=JSON.parse(row.definition);
 f.setDispatch(()=>{throw new AppError('REVISION_CONFLICT','unbound generic error',409);});
 assert.equal((await f.edits.approve(request)).status,'unknown');const approval=f.row(proposal).approval;
 f.setDispatch((projectId,input,target,services)=>{assert.deepEqual(input,definition.input);return services.moveTimelineClipInProject(projectId,input,target);});
 assert.equal((await f.edits.recover(request)).status,'applied');assert.equal(f.row(proposal).approval,approval);assert.equal(f.row(proposal).definition,row.definition);assert.equal(f.calls,2);
});

test('lost ACK/restart reconciles through the existing timeline receipt without a dispatch',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal(),request=f.request(proposal);
 f.setFault(label=>{if(label==='afterDispatch')throw Error('synthetic lost ACK');});await assert.rejects(f.edits.approve(request),/lost ACK/);
 assert.equal(f.row(proposal).status,'dispatching');assert.equal(f.current().clips[0].startFrame,120);const calls=f.calls,receipts=f.receipts();
 f.restart();f.setFault(()=>{});assert.equal(f.edits.reconcile().reconciled,1);assert.equal(f.calls,calls);assert.deepEqual(f.receipts(),receipts);
 assert.equal((await f.edits.recover(request)).status,'applied');assert.equal(f.calls,calls);
});

test('durable approval interrupted before dispatch requires explicit recovery after restart',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal(),request=f.request(proposal);
 f.setFault(label=>{if(label==='afterApproval')throw Error('synthetic crash');});await assert.rejects(f.edits.approve(request),/crash/);assert.equal(f.calls,0);assert.equal(f.row(proposal).status,'approved');
 const approval=f.row(proposal).approval;f.restart();f.setFault(()=>{});f.edits.reconcile();assert.equal(f.row(proposal).status,'unknown');assert.equal(f.calls,0);assert.equal(f.current().clips[0].startFrame,30);
 await f.edits.recover(request);assert.equal(f.calls,1);assert.equal(f.row(proposal).approval,approval);
});

test('applied historical ACK survives later move, undo, removal, restart and exact domain replay',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal(),request=f.request(proposal);const applied=await f.edits.approve(request);
 const definition=JSON.parse(f.row(proposal).definition),original=f.store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(definition.input.requestId).response;
 await f.services.call('timeline.clip.update',fields(f,{clipId:f.clip.id,patch:{startFrame:240}}));
 assert.deepEqual(f.edits.get({projectId:f.project.id,proposalId:proposal.id}).outcome,applied.outcome);
 await f.services.call('timeline.undo',fields(f));await f.services.call('timeline.undo',fields(f));assert.equal(f.current().clips[0].startFrame,30);
 await f.services.call('timeline.redo',fields(f));assert.equal(f.current().clips[0].startFrame,120);
 await f.services.call('timeline.clip.remove',fields(f,{clipId:f.clip.id}));assert.deepEqual(f.current().clips,[]);const before=domain(f);
 assert.deepEqual(f.edits.get({projectId:f.project.id,proposalId:proposal.id}).outcome,applied.outcome);
 const replay=await f.services.moveTimelineClipInProject(f.project.id,definition.input,definition.target);assert.equal(JSON.stringify(replay),original);assert.equal(domain(f),before);
 f.restart();assert.deepEqual((await f.edits.recover(request)).outcome,applied.outcome);assert.equal(f.calls,1);
});

test('two approval windows share one journal and rejected/stopped proposals never dispatch',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal(),request=f.request(proposal),second=f.second();
 const results=await Promise.all([f.edits.approve(request),second.approve(request)]);assert.equal(results.some(value=>value.status==='applied'),true);assert.equal(f.calls,1);
 const rejected=f.proposal({startFrame:240});assert.equal(f.edits.reject(f.request(rejected)).status,'rejected');assert.equal((await second.approve(f.request(rejected))).status,'rejected');
 const prepared=f.prepare({startFrame:240}),stopped=f.create(prepared);f.finish(prepared,stopped,'stopped');assert.equal(f.edits.cancelRun(prepared.runId),true);assert.equal(f.row(stopped).status,'cancelled');
 await assert.rejects(f.edits.approve(f.request(stopped)),code('AGENT_EDIT_RUN_INCOMPLETE'));assert.equal(f.calls,1);
});

test('current ownership and historical source ownership gate ACKs; foreign project cannot disclose',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal();await f.edits.approve(f.request(proposal));
 assert.throws(()=>f.edits.get({projectId:f.other.id,proposalId:proposal.id}),code('AGENT_EDIT_NOT_FOUND'));
 await f.services.call('timeline.clip.remove',fields(f,{clipId:f.clip.id}));
 f.store.db.prepare('UPDATE assets SET projectId=?,data=? WHERE id=?').run(f.other.id,JSON.stringify({...f.asset,projectId:f.other.id}),f.asset.id);
 assert.throws(()=>f.edits.get({projectId:f.project.id,proposalId:proposal.id}),code('TIMELINE_SOURCE_UNAVAILABLE'));
});

test('receipt operation/input hash and bounded response corruption never acknowledge or redispatch',async t=>{
 for(const corrupt of ['hash','response']){
  const f=await agentTimelineMoveFixture(t),proposal=f.proposal();f.setFault(label=>{if(label==='afterDispatch')throw Error('crash');});await assert.rejects(f.edits.approve(f.request(proposal)),/crash/);
  const input=JSON.parse(f.row(proposal).definition).input;
  f.store.db.exec('DROP TRIGGER immutable_timeline_responses');
  f.store.db.prepare(`UPDATE timeline_requests SET ${corrupt==='hash'?'requestHash':'response'}=? WHERE requestId=?`).run(corrupt==='hash'?'f'.repeat(64):' '.repeat(TIMELINE_RESPONSE_BYTES+1),input.requestId);
  f.setFault(()=>{});f.edits.reconcile();assert.equal(f.row(proposal).status,'unknown');await assert.rejects(f.edits.recover(f.request(proposal)));assert.equal(f.calls,1);
 }
});

test('same-revision private clip identity tamper cannot slip through reviewed dispatch',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal(),timeline=f.current();timeline.clips[0].sourceInFrame++;
 f.store.put('timelines',timeline);const before=domain(f);assert.equal((await f.edits.approve(f.request(proposal))).status,'unknown');assert.equal(domain(f),before);
});

test('frozen timing projection detects same-revision extra clip changes inside the shared transaction',async t=>{
 const f=await agentTimelineMoveFixture(t),proposal=f.proposal(),timeline=f.current();
 timeline.clips.push({...f.clip,id:randomUUID(),trackId:timeline.tracks[1].id,startFrame:600});timeline.durationFrames=660;f.store.put('timelines',timeline);
 const before=domain(f);assert.equal((await f.edits.approve(f.request(proposal))).status,'unknown');assert.equal(domain(f),before);
});

test('subtitle end bounds are reviewed and shared mutation validation remains authoritative',async t=>{
 const f=await agentTimelineMoveFixture(t);
 await f.services.call('timeline.subtitle.add',fields(f,{text:'Final caption',startFrame:60,durationFrames:30}));
 const prepared=f.prepare({startFrame:0});assert.throws(()=>f.create(prepared),code('AGENT_EDIT_VALIDATION'));f.finish(prepared,null,'failed');
 const good=f.proposal({startFrame:60});assert.equal((await f.edits.approve(f.request(good))).status,'applied');assert.equal(f.current().durationFrames,120);
});

test('shared proposal row budget includes legacy shot rows and never evicts an unresolved row',async t=>{
 const f=await agentTimelineMoveFixture(t,{limits:{rows:1}}),proposal=f.proposal(),before=f.row(proposal);
 const second=f.prepare({startFrame:180});assert.throws(()=>f.create(second),code('AGENT_EDIT_STORAGE_LIMIT'));assert.deepEqual(f.row(proposal),before);
 // Both branches draw from the same retained table and same bytes reservation;
 // storage admission counts legacy rows without reinterpreting old JSON.
 const g=await agentTimelineMoveFixture(t,{limits:{rows:1}}),legacy=g.prepare();g.finish(legacy,null,'failed');
 g.store.db.prepare("INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,digest,definition,status,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,'{}','pending',?,?,1)").run(randomUUID(),g.project.id,legacy.runId,randomUUID(),'a'.repeat(64),before.createdAt,before.createdAt);
 const newProposal=g.prepare();assert.equal(g.store.db.prepare('SELECT count(*) n FROM agent_edit_proposals WHERE targetKind=?').get('shot').n,1);
 assert.throws(()=>g.create(newProposal),code('AGENT_EDIT_STORAGE_LIMIT'));assert.deepEqual(f.row(proposal),before);
});


test('retained version1 unusual-whitespace approval bytes survive explicit recovery and historical reads',async t=>{
 const f=await agentTimelineMoveFixture(t),shot=await f.services.call('shot.create',{projectId:f.project.id,title:'Legacy title',prompt:'Legacy prompt'});
 const target=f.edits.pinTarget(f.project.id,{shotId:shot.id,expectedRevision:shot.revision}),runId=randomUUID(),requestId=randomUUID(),threadId=randomUUID(),toolId=randomUUID(),finalId=randomUUID(),proposalId=randomUUID(),createdAt=new Date().toISOString();
 const toolCall={id:'call_legacy_'+randomUUID(),name:'mioon_propose_shot_update',arguments:{title:'Reviewed legacy title',prompt:null},argumentsJson:'{ "title" : "Reviewed legacy title", "prompt" : null }'};
 const patch={title:'Reviewed legacy title'},definition={version:1,id:proposalId,projectId:f.project.id,runId,operation:'shot.update',target,
  changes:toolCall.arguments,patch,diff:{before:{title:target.title,prompt:target.prompt},after:{title:patch.title,prompt:target.prompt}},
  provenance:{runId,toolCallId:toolCall.id,toolName:toolCall.name},input:{shotId:shot.id,expectedRevision:shot.revision,patch,requestId:randomUUID()},createdAt};
 const digest=createHash('sha256').update(canonical(definition)).digest('hex'),approval={approvedAt:createdAt,proposalId,projectId:f.project.id,digest,operation:'shot.update',input:definition.input};
 const raw=value=>' \n'+JSON.stringify(Object.fromEntries(Object.entries(value).reverse()),null,'\t')+'\n ';
 const definitionText=raw(definition),approvalText=raw(approval),result={kind:'untrusted_shot_update_proposal',status:'pending_review',applied:false,proposalId,digest,operation:'shot.update'},resultJson=JSON.stringify(result);
 const tool={id:toolId,runId,projectId:f.project.id,kind:'tool',position:2,ordinal:1,status:'completed',intent:{toolCall,provenance:{category:'project_selected_shot_text',projectId:f.project.id,operation:'shot.update'}},observation:{result,resultJson}};
 const final={id:finalId,runId,projectId:f.project.id,kind:'model',position:3,ordinal:2,status:'completed',output:{type:'done',finishReason:'stop'}};
 const run={id:runId,projectId:f.project.id,requestId,threadId,status:'completed',contextMode:'selected_shot_edit',editTarget:target,modelRequestState:'completed',activity:[{id:toolId,kind:'tool',ordinal:1,status:'completed',resultJson},{id:finalId,kind:'model',ordinal:2,status:'completed'}]};
 f.store.db.prepare('INSERT INTO agent_chat_threads VALUES(?,?,0,1)').run(threadId,f.project.id);
 f.store.db.prepare('INSERT INTO agent_chat_requests VALUES(?,?,?,?,?,?,?)').run(requestId,f.project.id,threadId,runId,'legacy',raw({version:1,execution:{version:1,target,policy:editToolPolicy(f.project.id)}}),100);
 f.store.db.prepare('INSERT INTO agent_chat_runs VALUES(?,?,?,?,?,?,?,?)').run(runId,f.project.id,threadId,requestId,1,'completed',raw(run),100);
 for(const step of [tool,final])f.store.db.prepare('INSERT INTO agent_chat_steps VALUES(?,?,?,?,?,?,?,?)').run(step.id,runId,f.project.id,step.position,step.kind,step.status,raw(step),100);
 f.store.db.prepare("INSERT INTO agent_edit_proposals(id,projectId,runId,shotId,digest,definition,status,approval,createdAt,updatedAt,bytes) VALUES(?,?,?,?,?,?,'approved',?,?,?,4096)").run(proposalId,f.project.id,runId,shot.id,digest,definitionText,approvalText,createdAt,createdAt);
 f.restart();f.edits.reconcile();const action={projectId:f.project.id,proposalId,digest};
 assert.equal(f.row({id:proposalId}).approval,approvalText);assert.equal(f.row({id:proposalId}).definition,definitionText);
 const applied=await f.edits.recover(action);assert.equal(applied.status,'applied');assert.equal(f.store.get('shots',shot.id).title,patch.title);assert.equal(f.calls,0);
 assert.equal(f.row({id:proposalId}).approval,approvalText);assert.equal(f.row({id:proposalId}).definition,definitionText);
 const receipt=f.store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(definition.input.requestId),outcome=f.row({id:proposalId}).outcome;
 f.restart();assert.deepEqual((await f.edits.recover(action)).outcome,applied.outcome);assert.equal(f.row({id:proposalId}).approval,approvalText);assert.equal(f.row({id:proposalId}).outcome,outcome);
 assert.deepEqual(f.store.db.prepare('SELECT * FROM mutation_requests WHERE requestId=?').get(definition.input.requestId),receipt);
});
