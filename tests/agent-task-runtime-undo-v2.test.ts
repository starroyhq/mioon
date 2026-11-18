import test from 'node:test';
import {mediaFixturePath} from './helpers/media-reference-fixtures.ts';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {startWorker} from '../packages/business/src/jobs.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import type {AgentTaskToolCall,AgentTaskSnapshot} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createMockProvider} from '../packages/business/src/providers/mock.ts';
import {object,textField,revisionField,mockProviderAdapter,shot,gate,output,call,fixture,recordedHints} from './helpers/agent-task-runtime-fixture.ts';

test('whole task undo changes only AI targets and preserves manual edits elsewhere',async t=>{const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.changes.length,1);await f.services.call('shot.update',{shotId:f.other.id,expectedRevision:f.other.revision,patch:{prompt:'manual stays'}});const undone=await f.action(done,'undo_all');assert.equal(undone.run.status,'reverted');assert.equal(object(f.store.get('shots',String(f.first.id))).prompt,'saved first');assert.equal(object(f.store.get('shots',String(f.other.id))).prompt,'manual stays');assert.equal(f.requests.length,(2)+f.loadingRequests);});
test('whole undo retains the generated shot owner while reverting earlier edits and preserving products across restart and replay',async t=>{
 const providers=new Map<string,Provider>(),f=await fixture(t,'responses',providers);providers.set('mock',mockProviderAdapter(createMockProvider({db:f.store.db,root:f.root})));
 const timeline=object(await f.services.call('timeline.get',{projectId:f.projectId}));assert.ok(Array.isArray(timeline.tracks));const trackId=textField(timeline.tracks[0],'id');
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,local_irreversible:'direct',paid:'direct'},acknowledgePaid:true});
 const created=()=>object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Created generated owner'));
 f.setScript(async function*(index){
  let next:AgentTaskToolCall[]=[];
  if(index===1)next=[call('mioon_project_rename',{expectedRevision:1,name:'AI project rename'})];
  if(index===2)next=[call('mioon_shot_create',{title:'Created generated owner',prompt:'Synthetic local motion',duration:2})];
  if(index===3){const shot=created();next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1',parameters:{delayMs:0}})];}
  if(index===4)next=[call('mioon_task_wait',{kind:'job',id:textField(f.store.list('jobs',f.projectId)[0],'id')})];
  if(index===5)next=[call('mioon_timeline_clip_add',{expectedRevision:1,assetId:textField(f.store.list('versions',f.projectId)[0],'assetId'),trackId,startFrame:0,durationFrames:6})];
  if(index===6)next=[call('mioon_timeline_render',{expectedRevision:2,purpose:'export',exportSettings:{profileId:'mp4_h264_v1',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}}})];
  if(index===7)next=[call('mioon_task_wait',{kind:'export',id:textField(f.store.list('exports',f.projectId)[0],'id')})];
  yield {type:'done',output:output('responses',next)};
 },{loadGroups:['canvas','editing','exports','video']});
 const sent=await f.send(),worker=startWorker(f.store,f.services,providers);let done:AgentTaskSnapshot;
 try{done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed',JSON.stringify({error:done.run.error,pauseReason:done.run.pauseReason,errors:done.steps.flatMap(step=>step.error?[step.error]:[]),jobs:f.store.list('jobs',f.projectId).map(value=>({status:object(value).status,error:object(value).error}))}));assert.equal(done.backgroundPending,false);}finally{await worker.stop();}
 const before=f.runtime.journal.snapshot(sent.run.id),creation=before.changes.find(change=>change.operation==='shot.create')!;assert.ok(creation);const shotId=String(created().id);
 const products=Object.fromEntries(['jobs','versions','assets','exports'].map(table=>[table,structuredClone(f.store.list(table,f.projectId))]));
 const hashes=()=>f.store.list('assets',f.projectId).map(value=>{const asset=object(value);return createHash('sha256').update(readFileSync(mediaFixturePath(f.root,asset))).digest('hex');}),beforeHashes=hashes();
 const control={requestId:randomUUID(),expectedRevision:done.run.revision,action:'undo_all'},undone=await f.runtime.action(f.projectId,sent.run.id,control),retained=f.runtime.journal.snapshot(sent.run.id).changes.find(change=>change.id===creation.id)!;
 assert.equal(undone.run.status,'reverted');assert.equal(object(f.store.get('projects',f.projectId)).name,'Runtime project');assert.equal(object(f.store.get('shots',shotId)).selectedVersionId,null);
 const savedTimeline=object(await f.services.call('timeline.inspect',{projectId:f.projectId}));assert.deepEqual(savedTimeline.clips,[]);
 assert.equal(retained.reversible,false);assert.equal(retained.status,'applied');assert.match(retained.summary??'',/保留生成记录及产物所需镜头/);assert.equal(retained.revertedAt,undefined);assert.equal(retained.revertedTargets,undefined);
 assert.deepEqual(retained.before,creation.before);assert.deepEqual(retained.after,creation.after);assert.deepEqual(retained.undo,creation.undo);
 for(const [table,records] of Object.entries(products))assert.deepEqual(f.store.list(table,f.projectId),records);assert.deepEqual(hashes(),beforeHashes);
 assert.deepEqual(undone.steps.map(step=>[step.id,step.cost]),done.steps.map(step=>[step.id,step.cost]));assert.deepEqual(f.runtime.journal.lookupControl(control.requestId)?.result,{state:'completed',retainedChangeIds:[creation.id]});
 const stable=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,control);f.restart();await f.runtime.action(f.projectId,sent.run.id,control);
 assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.requests.length,(8)+f.loadingRequests);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM mock_provider_submissions').get()?.n,1);
});
for(const started of [false,true])test(`retained shot ${started?'keeps a late product without selecting it':'cancels its queued work on whole undo'} and never dispatches after reversion`,async t=>{
 const providers=new Map<string,Provider>(),f=await fixture(t,'responses',providers),entered=gate(),release=gate();let posts=0,downloads=0;
 const mock=mockProviderAdapter(createMockProvider({db:f.store.db,root:f.root}));providers.set('mock',{...mock,async submit(snapshot,context){posts++;return mock.submit(snapshot,context);},async download(id,destination,context){downloads++;entered.resolve();await release.promise;return mock.download(id,destination,context);}});
 f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,local_irreversible:'direct',paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){let next:AgentTaskToolCall[]=[];if(index===1)next=[call('mioon_shot_create',{title:'Pending generated owner',duration:2})];if(index===2){const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Pending generated owner'));next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1',parameters:{delayMs:0}})];}yield {type:'done',output:output('responses',next)};},{loadGroups:['canvas','video']});
 const sent=await f.send(),completed=await f.settle(sent.run.id);assert.equal(completed.run.status,'completed');assert.equal(completed.backgroundPending,true);
 let worker:ReturnType<typeof startWorker>|undefined;
 try{
  if(started){worker=startWorker(f.store,f.services,providers);await Promise.race([entered.promise,delay(10000,undefined,{ref:false}).then(()=>{throw Error(`Synthetic download barrier not reached: ${JSON.stringify(f.store.list('jobs',f.projectId).map(value=>({status:object(value).status,error:object(value).error})))}`);})]);}
  const current=f.runtime.get(f.projectId,sent.run.id),creation=current.changes.find(change=>change.operation==='shot.create')!;
  const single={requestId:randomUUID(),expectedRevision:current.run.revision,action:'undo_change',changeId:creation.id};await f.runtime.action(f.projectId,sent.run.id,single);
  const retained=f.runtime.get(f.projectId,sent.run.id);assert.equal(retained.run.status,'completed');assert.equal(retained.changes.find(change=>change.id===creation.id)?.reversible,false);assert.deepEqual(f.runtime.journal.lookupControl(single.requestId)?.result,{state:'completed',retainedChangeIds:[creation.id]});
  const undone=await f.action(retained,'undo_all');assert.equal(undone.run.status,'reverted');release.resolve();worker??=startWorker(f.store,f.services,providers);await worker.tick();await worker.tick();
  assert.equal(posts,started?1:0);assert.equal(downloads,started?1:0);assert.equal(f.requests.length,(3)+f.loadingRequests);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'reverted');
  const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Pending generated owner'));assert.equal(shot.selectedVersionId,null);
  const job=object(f.store.list('jobs',f.projectId)[0]);assert.equal(job.status,started?'succeeded':'cancelled');assert.equal(f.store.list('jobs',f.projectId).length,1);assert.equal(f.store.list('versions',f.projectId).length,started?1:0);assert.equal(f.store.list('assets',f.projectId).length,started?1:0);
  const timeline=await f.services.call('timeline.inspect',{projectId:f.projectId}),saved=timeline===null?null:object(timeline);assert.ok(saved===null||saved.clips===undefined||Array.isArray(saved.clips)&&saved.clips.length===0);
 }finally{release.resolve();await worker?.stop();}
});
test('retention survives an unknown control finish without repeating metadata or dispatch after restart',async t=>{
 let posts=0;const provider:Provider={id:'mock',capabilities:{models:['mock-motion-v1'],inputModes:['text'],aspectRatios:['9:16'],durations:[2],mock:true,configured:true,enabled:true},async submit(){posts++;throw Error('No new dispatch is permitted');},async reconcile(){return null;},async poll(){return {status:'running'};},async download(){throw Error('No output requested');}};
 const providers=new Map([['mock',provider]]),f=await fixture(t,'responses',providers);f.runtime.updatePolicy({requestId:randomUUID(),expectedRevision:f.runtime.policy().revision,stepLimit:30,modes:{...f.runtime.policy().modes,paid:'direct'},acknowledgePaid:true});
 f.setScript(async function*(index){let next:AgentTaskToolCall[]=[];if(index===1)next=[call('mioon_project_rename',{expectedRevision:1,name:'Reversible earlier rename'})];if(index===2)next=[call('mioon_shot_create',{title:'Owner retained across interruption',duration:2})];if(index===3){const shot=object(f.store.list('shots',f.projectId).find(value=>object(value).title==='Owner retained across interruption'));next=[call('mioon_generation_submit',{shotId:textField(shot,'id'),expectedRevision:revisionField(shot),providerId:'mock',model:'mock-motion-v1'})];}yield {type:'done',output:output('responses',next)};},{loadGroups:['canvas','video']});
 const sent=await f.send(),done=await f.settle(sent.run.id),creation=done.changes.find(change=>change.operation==='shot.create')!,control={requestId:randomUUID(),expectedRevision:done.run.revision,action:'undo_all'};
 f.store.db.exec(`CREATE TEMP TRIGGER test_retention_control_finish BEFORE INSERT ON mio_control_states WHEN NEW.requestId='${control.requestId}' AND json_extract(NEW.data,'$.result.state')='completed' BEGIN SELECT RAISE(ABORT,'synthetic lost control finish');END;`);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,control),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});
 const interrupted=f.runtime.journal.snapshot(sent.run.id);assert.equal(interrupted.run.status,'reverted');assert.equal(interrupted.changes.find(change=>change.id===creation.id)?.reversible,false);assert.equal(object(f.runtime.journal.lookupControl(control.requestId)?.result).state,'pending');
 f.restart();const recovered=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);assert.deepEqual(recovered,interrupted);assert.equal(object(f.runtime.journal.lookupControl(control.requestId)?.result).state,'blocked');
 await f.runtime.action(f.projectId,sent.run.id,control);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),recovered);
 const worker=startWorker(f.store,f.services,providers);try{await worker.tick();await worker.tick();assert.equal(posts,0);assert.equal(f.requests.length,(4)+f.loadingRequests);assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,'reverted');assert.equal(f.store.list('versions',f.projectId).length,0);assert.equal(f.store.list('assets',f.projectId).length,0);}finally{await worker.stop();}
});
for(const externalAba of [false,true])test(`persisted compensation chain ${externalAba?'cannot cross an external ABA':'continues adjacent AI changes after restart'}`,async t=>{
 const f=await fixture(t);let insertedAba=false;
 f.setScript(async function*(index){
  if(index===2&&externalAba){await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'manual intervening'}});await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:3,patch:{prompt:'AI first'}});insertedAba=true;}
  const expectedRevision=index===1?1:externalAba?4:2;
  const calls=index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision,patch:{prompt:'AI first'}})]:index===2||externalAba&&index===3?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision,patch:{prompt:'AI second'}})]:[];
  yield {type:'done',output:output('responses',calls)};
 },{loadGroups:['canvas']});
 const sent=await f.send();let done=await f.settle(sent.run.id);
 if(externalAba){
  // X4: the second request's call is handed back; the third request's reread edit applies.
  assert.equal(done.run.status,'completed');assert.equal(insertedAba,true);assert.equal(recordedHints(f,sent.run.id,'run_state').some(state=>state.status==='paused'),false);
  assert.deepEqual(done.steps.filter(step=>step.toolCall?.name==='mioon_shot_update').map(step=>[step.status,step.error?.code]),[['completed',undefined],['rejected','TARGET_CHANGED'],['completed',undefined]]);
  assert.equal(done.changes.length,2);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'AI second');
  // Whole undo still cannot bridge the external ABA to compensate the first AI change.
  // The second AI change is undone first; the first one is then refused and stays applied.
  await assert.rejects(f.action(done,'undo_all'),{code:'AGENT_TASK_TARGET_CHANGED'});
  assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).changes.map(change=>change.status),['applied','reverted']);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'AI first');return;
 }
 assert.equal(done.run.status,'completed');assert.equal(done.changes.length,2);const latest=done.changes[1]!;
 await f.action(done,'undo_change',{changeId:latest.id});const reverted=f.runtime.journal.snapshot(sent.run.id).changes[1]!;
 assert.equal(reverted.status,'reverted');assert.ok(reverted.revertedTargets?.length);assert.equal(reverted.revertedTargets[0]?.revisionBefore,latest.targets[0]?.revisionBefore);assert.equal(reverted.revertedTargets[0]?.revisionAfter,latest.targets[0]?.revisionAfter);
 f.restart();done=f.runtime.get(f.projectId,sent.run.id);const request={requestId:randomUUID(),expectedRevision:done.run.revision,action:'undo_all'};
 if(externalAba){await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_TARGET_CHANGED'});assert.equal(object(f.store.get('shots',f.first.id)).prompt,'AI first');assert.equal(f.runtime.journal.snapshot(sent.run.id).changes[0]?.status,'applied');assert.equal(object(f.runtime.journal.lookupControl(request.requestId)?.result).state,'blocked');}
 else {const undone=await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(undone.run.status,'reverted');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');assert.ok(undone.changes.every(change=>change.status==='reverted'));}
});
for(const scenario of ['modified','aba','draft','compound','audit_failure'] as const)test(`whole undo safely classifies and preserves ${scenario} while protecting earlier changes`,async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'Earlier AI edit'}}),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Later AI edit'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(done.changes.length,2);let current=object(await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'Manual after AI'}}));
 if(scenario==='aba')current=object(await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:current.revision,patch:{prompt:'Later AI edit'}}));
 if(scenario==='draft')f.runtime.journal.claim({projectId:f.projectId,ownerId:randomUUID(),targets:[{kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)}]});
 if(scenario==='compound'){const original=f.runtime.journal.snapshot(sent.run.id).changes.at(-1)!;original.targets.push({kind:'shot',id:f.other.id,revision:2,revisionBefore:1,revisionAfter:2});f.store.db.prepare('UPDATE mio_changes SET data=? WHERE id=?').run(JSON.stringify(original),original.id);}
 const fresh=f.runtime.get(f.projectId,sent.run.id),last=fresh.changes.at(-1)!;assert.equal(last.modifiedAfter,true);assert.equal(last.undoDisposition,scenario==='modified'||scenario==='audit_failure'?'retain':'blocked');assert.equal(fresh.changes[0]!.undoDisposition,scenario==='modified'||scenario==='audit_failure'?'undo':'blocked');
 await assert.rejects(f.action(fresh,'undo_change',{changeId:last.id}),{code:'AGENT_TASK_TARGET_CHANGED'});
 const request={requestId:randomUUID(),expectedRevision:f.runtime.journal.run(sent.run.id).revision,action:'undo_all'};
 if(scenario==='audit_failure')f.store.db.exec(`CREATE TEMP TRIGGER fail_superseded_event BEFORE UPDATE ON mio_changes WHEN json_extract(NEW.data,'$.status')='superseded' BEGIN SELECT RAISE(ABORT,'synthetic superseded audit failure');END;`);
 if(scenario==='modified'){
  const undone=await f.runtime.action(f.projectId,sent.run.id,request);assert.equal(undone.run.status,'reverted');assert.deepEqual(undone.changes.map(change=>change.status),['reverted','superseded']);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'Manual after AI');assert.deepEqual(object(f.runtime.journal.lookupControl(request.requestId)?.result).retainedChangeIds,[last.id]);
  f.restart();const stable=f.runtime.journal.snapshot(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,request);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.equal(f.requests.length,3);assert.equal(f.loadingRequests,1);assert.ok(stable.changes.every(change=>change.modifiedAfter===undefined&&change.undoDisposition===undefined));
 }else{
  await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:scenario==='audit_failure'?'AGENT_TASK_STORAGE_UNAVAILABLE':'AGENT_TASK_TARGET_CHANGED'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).changes.map(change=>change.status),['applied','applied']);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'Earlier AI edit');assert.equal(object(f.store.get('shots',f.first.id)).prompt,current.prompt);
 }
});
test('whole undo preview includes adjacent own changes without mistaking their revisions for external supersession',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index<=2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:index,patch:{prompt:`AI edit ${index}`}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.changes.length,2);assert.deepEqual(done.changes.map(change=>change.undoDisposition),['undo','undo']);assert.deepEqual(done.changes.map(change=>change.modifiedAfter),[true,false]);await assert.rejects(f.action(done,'undo_change',{changeId:done.changes[0]!.id}),{code:'AGENT_TASK_TARGET_CHANGED'});const undone=await f.action(f.runtime.get(f.projectId,sent.run.id),'undo_all');assert.equal(undone.run.status,'reverted');assert.deepEqual(undone.changes.map(change=>change.status),['reverted','reverted']);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');
});
test('unchanged target with a retained draft blocks whole undo without compensating other targets',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'Earlier AI'}}),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Draft target AI'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);f.runtime.journal.claim({projectId:f.projectId,ownerId:randomUUID(),targets:done.changes.at(-1)!.targets});f.runtime.journal.markClaimsUncertain(f.projectId);
 const fresh=f.runtime.get(f.projectId,sent.run.id);assert.deepEqual(fresh.changes.map(change=>change.undoDisposition),['blocked','blocked']);assert.equal(fresh.changes.at(-1)?.modifiedAfter,false);await assert.rejects(f.action(fresh,'undo_all'),{code:'AGENT_TASK_TARGET_CLAIMED'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id).changes.map(change=>change.status),['applied','applied']);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'Earlier AI');
});

test('whole undo confirmation cannot expand after a draft is released and replays its rejection receipt',async t=>{
 const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'First AI'}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'Second AI'}}),call('mioon_project_rename',{expectedRevision:1,name:'Third AI'})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id),ownerId=randomUUID();assert.equal(done.changes.length,3);f.runtime.journal.claim({projectId:f.projectId,ownerId,targets:done.changes[1]!.targets});
 const preview=f.runtime.get(f.projectId,sent.run.id),undoChangeIds=preview.changes.filter(change=>change.undoDisposition==='undo').map(change=>change.id);assert.deepEqual(undoChangeIds,[done.changes[2]!.id]);f.runtime.journal.releaseClaims(f.projectId,ownerId);assert.equal(f.runtime.journal.run(sent.run.id).revision,preview.run.revision);
 const request={requestId:randomUUID(),expectedRevision:preview.run.revision,action:'undo_all',undoChangeIds};await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_TARGET_CHANGED'});assert.ok(f.runtime.journal.snapshot(sent.run.id).changes.every(change=>change.status==='applied'));assert.equal(object(f.store.get('projects',f.projectId)).name,'Third AI');
 assert.equal(object(f.runtime.journal.lookupControl(request.requestId)?.result).state,'rejected');await f.runtime.action(f.projectId,sent.run.id,request);assert.ok(f.runtime.journal.snapshot(sent.run.id).changes.every(change=>change.status==='applied'));
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,{...request,undoChangeIds:done.changes.map(change=>change.id)}),{code:'AGENT_TASK_REQUEST_CONFLICT'});
 const fresh=f.runtime.get(f.projectId,sent.run.id),accepted={requestId:randomUUID(),expectedRevision:fresh.run.revision,action:'undo_all',undoChangeIds:fresh.changes.filter(change=>change.undoDisposition==='undo').map(change=>change.id)};const undone=await f.runtime.action(f.projectId,sent.run.id,accepted);assert.equal(undone.run.status,'reverted');assert.ok(undone.changes.every(change=>change.status==='reverted'));f.restart();await f.runtime.action(f.projectId,sent.run.id,accepted);assert.ok(f.runtime.journal.snapshot(sent.run.id).changes.every(change=>change.status==='reverted'));
});
