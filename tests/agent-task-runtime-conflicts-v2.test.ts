import {testAgentExecution} from './helpers/agent-settings-fixture.ts';
import {beginFixtureModelStep,beginFixtureToolStep} from './helpers/mio-model-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setAgentTaskJobResumer} from '../packages/business/src/agent/task-effects-v2.ts';
import {AGENT_TASK_TOOLS_LOAD_NAME} from '../packages/business/src/agent/task-tool-groups-v2.ts';
import {AGENT_TASK_LOCALES} from '../packages/contracts/src/agent-tasks-v2.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {object,textField,revisionField,gate,output,call,fixture,type RuntimeFixture,recordedHints,setRestartReason,m4ConflictPause,runPaused,staleRevisionMessages,projectRereadMessages,staleShotUpdate} from './helpers/agent-task-runtime-fixture.ts';

test('same target ABA during model wait is handed back for reread while another shot edit still runs',async t=>{for(const same of [true,false]){const f=await fixture(t),entered=gate(),release=gate();f.setScript(async function*(index){if(index===1){entered.resolve();await release.promise;}yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send();await entered.promise;const target=same?f.first:f.other;let saved=object(await f.services.call('shot.update',{shotId:target.id,expectedRevision:target.revision,patch:{prompt:'manual edit'}}));if(same)saved=object(await f.services.call('shot.update',{shotId:target.id,expectedRevision:saved.revision,patch:{prompt:target.prompt}}));release.resolve();const end=await f.settle(sent.run.id);assert.equal(end.run.status,'completed');assert.equal(f.effects.size,(same?0:1)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(recordedHints(f,sent.run.id,'run_state').some(state=>state.status==='paused'),false);const step=end.steps.find(item=>item.toolCall?.name==='mioon_shot_update');if(same){assert.equal(step?.status,'rejected');assert.equal(step?.error?.code,'TARGET_CHANGED');assert.equal(end.changes.length,0);assert.equal(object(f.store.get('shots',String(f.first.id))).prompt,'saved first');assert.match(f.scriptRequest(2).body,/TARGET_CHANGED/u);}else{assert.equal(step?.status,'completed');assert.equal(object(f.store.get('shots',String(f.other.id))).prompt,'manual edit');}}});
test('unsaved editing claim is handed back with TARGET_EDITING, keeps the draft and adds no skip list',async t=>{const f=await fixture(t);const target={kind:'shot',id:String(f.first.id),revision:f.runtime.journal.targetRevision(f.projectId,'shot',String(f.first.id))};f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:'runtime-edit-owner',generation:1,sequence:1,action:'claim',targets:[target]});f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:f.first.revision,patch:{prompt:'AI edit'}})]:[])};},{loadGroups:['canvas']});const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(done.run.skippedTargets,[]);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);const step=done.steps.find(item=>item.toolCall?.name==='mioon_shot_update');assert.equal(step?.status,'rejected');assert.equal(step?.error?.code,'TARGET_EDITING');const error=object(object(step?.result).error);assert.ok(Array.isArray(error.current));assert.equal(object(object(error.current[0]).value).prompt,'saved first');assert.equal(f.runtime.journal.claims(f.projectId).length,1);assert.equal(object(f.store.get('shots',String(f.first.id))).prompt,'saved first');assert.match(f.scriptRequest(2).body,/TARGET_EDITING/u);assert.doesNotMatch(f.scriptRequest(2).body,/TARGET_SKIPPED/u);});
for(const protocol of ['chat_completions','responses'] as const)for(const legacy of [false,true])for(const reason of ['editing','conflict'] as const)test(`${protocol}: interrupted ${legacy?'legacy restart':'preserved'} ${reason} returns to conflict selection before any old tool can run`,async t=>{
 const f=await fixture(t,protocol),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},ownerId=randomUUID();
 const {sent,paused}=await m4ConflictPause(f,{reason,target,protocol,ownerId,calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'old parameters must not run'}})],conflict:async()=>{
  const changed=object(await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'manual ABA'}}));
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:revisionField(changed),patch:{prompt:f.first.prompt}});
 }});assert.equal(paused.run.pauseReason,reason);
 if(reason==='editing')f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:2,action:'release',targets:[target]});
 await assert.rejects(f.action(paused,'resume'),{code:'AGENT_TASK_SKIP_REQUIRED'});assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);
 f.restart();let interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');
 if(legacy){setRestartReason(f,sent.run.id);interrupted=f.runtime.get(f.projectId,sent.run.id);}
 let wakeups=0;const removeResumer=setAgentTaskJobResumer(f.store.db,'synthetic-conflict-resume',()=>{wakeups++;});t.after(removeResumer);
 const control={requestId:randomUUID(),expectedRevision:interrupted.run.revision,action:'resume'},selected=await f.runtime.action(f.projectId,sent.run.id,control);await f.runtime.drain();
 assert.equal(selected.run.status,'paused');assert.equal(selected.run.pauseReason,legacy?'conflict':reason);assert.equal(selected.run.budget,paused.run.budget);assert.equal(selected.run.stepsUsed,paused.run.stepsUsed);
 assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(wakeups,0);assert.deepEqual(selected.run.skippedTargets,[]);assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
 const stable=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);await f.runtime.action(f.projectId,sent.run.id,control);assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),stable);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(wakeups,0);
 await assert.rejects(f.action(selected,'resume'),{code:'AGENT_TASK_SKIP_REQUIRED'});await f.action(selected,'skip');const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(done.run.skippedTargets?.[0]?.target.id,f.first.id);assert.equal(done.changes.length,0);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.match(f.scriptRequest(2)!.body,/TARGET_SKIPPED/);assert.equal(wakeups,1);assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
});
for(const status of ['denied','rejected','completed'] as const)test(`interrupted restart ignores handled ${status} conflict metadata`,async t=>{
 const f=await fixture(t);
 const {sent,paused}=await m4ConflictPause(f,{reason:'editing',target:{kind:'shot',id:f.first.id},ownerId:'handled-conflict',calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'handled old parameters'}})]}),step=paused.steps.find(item=>item.kind==='tool'&&item.toolCall?.name!==AGENT_TASK_TOOLS_LOAD_NAME);assert.ok(step);assert.equal(paused.run.pauseReason,'editing');f.runtime.journal.releaseClaims(f.projectId,'handled-conflict');
 if(status==='completed'){f.runtime.journal.markDispatch(sent.run.id,step.id);f.runtime.journal.completeStep(sent.run.id,step.id,{result:{handled:true}});const current=f.runtime.journal.step(step.id);f.runtime.journal.updateStep(sent.run.id,step.id,{data:{...object(current.data),backgroundInvalidated:false}});}
 else f.runtime.journal.updateStep(sent.run.id,step.id,{status,result:{handled:true}});
 const resumed=f.runtime.journal.resume(sent.run.id,f.runtime.journal.run(sent.run.id).revision);f.runtime.journal.transition(sent.run.id,resumed.revision,'paused','user');f.restart();
 await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(2)+f.loadingRequests);assert.deepEqual(done.run.skippedTargets,[]);
});
for(const protocol of ['chat_completions','responses'] as const)for(const kind of ['model','tool'] as const)test(`${protocol}: interrupted conflict selection still requires unknown ${kind} result disposition first`,async t=>{
 const f=await fixture(t,protocol);
 const {sent,paused}=await m4ConflictPause(f,{reason:'editing',target:{kind:'shot',id:f.first.id},protocol,ownerId:'unknown-conflict',calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'unknown old parameters'}})]});f.runtime.journal.resume(sent.run.id,paused.run.revision);const uncertain=(kind==='tool'?beginFixtureToolStep(f.runtime.journal,sent.run.id,{toolCall:call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'unknown tool must not run'}})}):beginFixtureModelStep(f.runtime.journal,sent.run.id).step);f.runtime.journal.markDispatch(sent.run.id,uncertain.id);f.runtime.journal.transition(sent.run.id,f.runtime.journal.run(sent.run.id).revision,'paused','editing');f.restart();
 const interrupted=f.runtime.get(f.projectId,sent.run.id),before=f.runtime.journal.snapshot(sent.run.id);await assert.rejects(f.action(interrupted,'resume'),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);
 const disposed=await f.action(interrupted,'resolve_unknown',{stepId:uncertain.id,resolution:'discard'}),selected=await f.action(disposed,'resume');assert.equal(selected.run.status,'paused');assert.equal(selected.run.pauseReason,'editing');assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(f.requests.length,(1)+f.loadingRequests);
});
for(const protocol of ['chat_completions','responses'] as const)test(`${protocol}: interrupted conflict recovery preserves an exhausted safety window until separate continuation`,async t=>{
 const f=await fixture(t,protocol,new Map(),{safetyStepLimit:4});
 const {sent,paused}=await m4ConflictPause(f,{reason:'editing',target:{kind:'shot',id:f.first.id},protocol,ownerId:'budget-conflict',calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'no budget for old parameters'}})]});assert.equal(paused.run.pauseReason,'editing');assert.equal(paused.run.stepsUsed,2+f.loadingSteps(paused));assert.equal(f.runtime.journal.safetyWindow(sent.run.id).remaining,0);f.runtime.journal.releaseClaims(f.projectId,'budget-conflict');f.restart();
 const selected=await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');assert.equal(selected.run.status,'paused');assert.equal(selected.run.pauseReason,'editing');assert.equal(f.runtime.journal.safetyWindow(sent.run.id).remaining,0);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
 await f.action(selected,'skip');const budget=await f.settle(sent.run.id);assert.equal(budget.run.status,'paused');assert.equal(budget.run.pauseReason,'safety_limit');assert.equal(f.runtime.journal.safetyWindow(sent.run.id).remaining,0);assert.equal(budget.run.skippedTargets?.[0]?.target.id,f.first.id);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
 await f.action(budget,'resume');const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(f.runtime.journal.safetyWindow(sent.run.id),{startStepsUsed:4,afterPosition:4,remaining:3});assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(object(f.store.get('shots',f.first.id)).prompt,f.first.prompt);
});
test('interrupted conflict recovery and its control receipt roll back together on storage failure',async t=>{
 const f=await fixture(t),{sent}=await m4ConflictPause(f,{reason:'editing',target:{kind:'shot',id:f.first.id},ownerId:'atomic-conflict',calls:[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'never commits'}})]});
 f.restart();const interrupted=f.runtime.get(f.projectId,sent.run.id),request={requestId:randomUUID(),expectedRevision:interrupted.run.revision,action:'resume'},before=f.runtime.journal.snapshot(sent.run.id),events=f.runtime.journal.events(sent.run.id);
 f.store.db.exec(`CREATE TEMP TRIGGER fail_conflict_recovery_receipt BEFORE INSERT ON mio_controls WHEN NEW.requestId='${request.requestId}' BEGIN SELECT RAISE(ABORT,'synthetic conflict recovery receipt failure');END;`);
 await assert.rejects(f.runtime.action(f.projectId,sent.run.id,request),{code:'AGENT_TASK_STORAGE_UNAVAILABLE'});assert.deepEqual(f.runtime.journal.snapshot(sent.run.id),before);assert.deepEqual(f.runtime.journal.events(sent.run.id),events);assert.equal(f.runtime.journal.lookupControl(request.requestId),null);assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);
});
test('a handed-back conflict leaves the rest of its batch unexecuted, including a not yet created third call',async t=>{
 const f=await fixture(t),target={kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)},ownerId=randomUUID();
 f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim',targets:[target]});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_project_inspect'),call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'stale call two'}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'stale call three'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.deepEqual(done.run.skippedTargets,[]);assert.equal(f.effects.size,(1)+f.loadingEffects);assert.equal(done.steps.filter(step=>step.kind==='tool').length,2+done.steps.filter(step=>step.toolCall?.name===AGENT_TASK_TOOLS_LOAD_NAME).length);
 const handed=done.steps.find(step=>step.toolCall?.name==='mioon_shot_update');assert.equal(handed?.status,'rejected');assert.equal(handed?.error?.code,'TARGET_EDITING');assert.equal(f.runtime.journal.claims(f.projectId).length,1);
 assert.equal(f.requests.length,(2)+f.loadingRequests);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.match(f.scriptRequest(2)!.body,/TARGET_EDITING/);assert.match(f.scriptRequest(2)!.body,/TARGET_CHANGED/);assert.match(f.scriptRequest(2)!.body,/此批旧工具参数已失效/u);
});
for(const protocol of ['chat_completions','responses'] as const)test(`X4: ${protocol}: a prompt saved during the model request is handed back with its value and the reread edit applies without a pause`,async t=>{
 const f=await fixture(t,protocol),staleId=randomUUID(),rereadId=randomUUID();
 f.setScript(async function*(index){
  if(index===1)await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'User prompt'}});
  yield {type:'done',output:output(protocol,index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'Stale AI prompt'}},staleId)]:index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'User prompt, refined'}},rereadId)]:[])};
 },{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(runPaused(f,sent.run.id),false);assert.deepEqual(done.run.skippedTargets,[]);assert.equal(done.changes.length,1);
 const stale=done.steps.find(step=>step.toolCall?.id===staleId),reread=done.steps.find(step=>step.toolCall?.id===rereadId);
 assert.equal(stale?.status,'rejected');assert.equal(stale?.error?.code,'TARGET_CHANGED');
 const error=object(object(stale?.result).error);assert.equal(error.code,'TARGET_CHANGED');assert.match(textField(error,'message'),/目标在你读取后已被修改/u);assert.ok(Array.isArray(error.current));assert.equal(error.current.length,1);assert.equal(error.omittedTargets,undefined);
 const entry=object(error.current[0]);assert.equal(entry.kind,'shot');assert.equal(entry.id,f.first.id);assert.equal(object(entry.value).prompt,'User prompt');assert.equal(object(entry.value).revision,2);
 assert.equal(reread?.status,'completed');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'User prompt, refined');
 assert.match(f.scriptRequest(2).body,/TARGET_CHANGED/u);assert.match(f.scriptRequest(2).body,/User prompt/u);assert.match(f.scriptRequest(3).body,/User prompt, refined/u);
 assert.equal(f.effects.size,(1)+f.loadingEffects);assert.equal(f.requests.length,(3)+f.loadingRequests);
});
test('X4: hand-back and invalidated-batch instructions use the run locale',async t=>{
 const expected={'zh-Hans':['目标在你读取后已被修改','用户正在手动编辑这一处','此批旧工具参数已失效'],'zh-Hant':['目標在你讀取後已被修改','使用者正在手動編輯這一處','此批舊工具參數已失效'],en:['The target changed after you read it','The user is editing this target','The old tool arguments in this batch are no longer valid'],ja:['読み取った後に対象が変更された','ユーザーがこの対象を手動で編集中','このバッチの古いツール引数は無効になりました']} as const;
 for(const locale of AGENT_TASK_LOCALES){
  const [changed,editing,invalidated]=expected[locale],send=async(f:RuntimeFixture)=>(await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'synthetic X4 locale',locale,expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision})).run.id;
  const held=await fixture(t);held.runtime.journal.claim({projectId:held.projectId,ownerId:'x4-locale-draft',targets:[{kind:'shot',id:held.first.id,revision:held.runtime.journal.targetRevision(held.projectId,'shot',held.first.id)}]});
  held.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:held.first.id,expectedRevision:1,patch:{prompt:'held by a draft'}}),call('mioon_shot_update',{shotId:held.other.id,expectedRevision:1,patch:{prompt:'stale batch call'}})]:[])};},{loadGroups:['canvas']});
  const heldRun=await send(held);assert.equal((await held.settle(heldRun)).run.status,'completed');const heldBody=held.scriptRequest(2).body;
  assert.ok(heldBody.includes(editing),`${locale}: editing`);assert.ok(heldBody.includes(invalidated),`${locale}: invalidated batch`);assert.equal(object(held.store.get('shots',held.other.id)).prompt,'saved other');
  const saved=await fixture(t);saved.setScript(async function*(index){
   if(index===1)await saved.services.call('shot.update',{shotId:saved.first.id,expectedRevision:1,patch:{prompt:'saved during the request'}});
   yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:saved.first.id,expectedRevision:1,patch:{prompt:'stale'}})]:[])};
  },{loadGroups:['canvas']});
  const savedRun=await send(saved);assert.equal((await saved.settle(savedRun)).run.status,'completed');assert.ok(saved.scriptRequest(2).body.includes(changed),`${locale}: changed`);
 }
});
test('X4: currentTargets projects saved values like tool results and returns at most 20',async t=>{
 const f=await fixture(t),asset=object(await f.services.call('asset.import',{projectId:f.projectId,name:'Synthetic source.png',mimeType:'image/png',dataBase64:png().toString('base64')})),assetId=String(asset.id),missing=randomUUID();
 const values=f.tools.currentTargets(f.projectId,[{kind:'shot',id:f.first.id},{kind:'asset',id:assetId},{kind:'shot',id:missing}]).map(object);
 assert.equal(values.length,3);assert.equal(object(values[0]!.value).prompt,'saved first');assert.equal(values[1]!.kind,'asset');assert.equal(object(values[1]!.value).id,assetId);
 assert.equal(JSON.stringify(values).includes('relativePath'),false);assert.equal(JSON.stringify(values).includes(f.root),false);assert.deepEqual(values[2],{kind:'shot',id:missing,value:null});
 assert.equal(f.tools.currentTargets(f.projectId,Array.from({length:25},()=>({kind:'shot',id:randomUUID()}))).length,20);
});
test('X4: a save after dispatch and before the effect fence is handed back as prevented, never unknown',async t=>{
 const f=await fixture(t);let saved=false;
 f.beforeTool(async prepared=>{if(prepared.operation==='shot.update'&&!saved){saved=true;await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'saved at dispatch'}});}});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'AI after dispatch'}})]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(saved,true);assert.equal(done.run.status,'completed');assert.equal(runPaused(f,sent.run.id),false);
 const step=f.runtime.journal.snapshot(sent.run.id).steps.find(item=>item.toolCall?.name==='mioon_shot_update');assert.ok(step);
 assert.equal(step.status,'rejected');assert.equal(step.error?.code,'TARGET_CHANGED');assert.equal(object(step.data).dispatchPrevented,true);
 const error=object(object(step.result).error);assert.ok(Array.isArray(error.current));assert.equal(object(object(error.current[0]).value).prompt,'saved at dispatch');
 assert.equal(done.steps.some(item=>item.status==='unknown'),false);assert.equal(done.changes.length,0);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved at dispatch');
});
test('X4: a failed batch flag rolls the hand-back back with it and the run fails closed',async t=>{
 const f=await fixture(t);f.runtime.journal.claim({projectId:f.projectId,ownerId:'x4-atomic-draft',targets:[{kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)}]});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'held by a draft'}}),call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'later batch call'}})]:[])};},{loadGroups:['canvas']});
 f.store.db.exec("CREATE TEMP TRIGGER fail_x4_batch_flag BEFORE UPDATE ON mio_steps WHEN NEW.kind='model' AND json_extract(NEW.data,'$.data.toolsInvalidated') IS 1 BEGIN SELECT RAISE(ABORT,'synthetic batch flag failure');END;");
 try{
  const sent=await f.send(),done=await f.settle(sent.run.id);assert.equal(done.run.status,'failed');assert.equal(done.run.pauseReason,'AGENT_TASK_STORAGE_UNAVAILABLE');
  const step=f.runtime.journal.snapshot(sent.run.id).steps.find(item=>item.toolCall?.name==='mioon_shot_update');assert.ok(step);
  assert.equal(step.status,'intent');assert.equal(step.result,undefined);assert.equal(step.error,undefined);
  const source=f.runtime.journal.step(textField(step.data,'sourceModelStepId'));assert.equal(object(source.data).toolsInvalidated,undefined);
  assert.equal(f.requests.length,(1)+f.loadingRequests);assert.equal(f.effects.size,(0)+f.loadingEffects);assert.equal(object(f.store.get('shots',f.other.id)).prompt,'saved other');assert.equal(f.runtime.journal.claims(f.projectId).length,1);
 }finally{f.store.db.exec('DROP TRIGGER temp.fail_x4_batch_flag');}
});
for(const via of ['pause','restart'] as const)for(const held of ['saved','draft'] as const)test(`X4: a pending approval resumed after ${via==='pause'?'a user pause':'a restart'} with a ${held==='saved'?'saved change':'draft'} is handed back and the new plan asks again`,async t=>{
 const f=await fixture(t),staleId=randomUUID(),nextId=randomUUID();
 f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
 const next=held==='saved'?call('mioon_shot_update',{shotId:f.first.id,expectedRevision:2,patch:{prompt:'reread after resume'}},nextId):call('mioon_shot_update',{shotId:f.other.id,expectedRevision:1,patch:{prompt:'other after resume'}},nextId);
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'stale approval'}},staleId)]:index===2?[next]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),waiting=await f.settle(sent.run.id);assert.equal(waiting.run.status,'awaiting_approval');assert.equal(waiting.steps.find(step=>step.toolCall?.id===staleId)?.status,'awaiting_approval');
 if(via==='pause')await f.action(waiting,'pause');else f.restart();
 assert.equal(f.runtime.get(f.projectId,sent.run.id).run.status,via==='pause'?'paused':'interrupted');
 if(held==='saved')await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'saved while stopped'}});
 else f.runtime.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId:'x4-resume-draft',generation:1,sequence:1,action:'claim',targets:[{kind:'shot',id:f.first.id,revision:f.runtime.journal.targetRevision(f.projectId,'shot',f.first.id)}]});
 await f.action(f.runtime.get(f.projectId,sent.run.id),'resume');const asked=await f.settle(sent.run.id);
 const stale=asked.steps.find(step=>step.toolCall?.id===staleId),again=asked.steps.find(step=>step.toolCall?.id===nextId);
 assert.equal(asked.run.status,'awaiting_approval');assert.equal(stale?.status,'rejected');assert.equal(stale?.error?.code,held==='saved'?'TARGET_CHANGED':'TARGET_EDITING');
 const error=object(object(stale?.result).error);assert.ok(Array.isArray(error.current));assert.equal(error.current.length,1);assert.equal(object(object(error.current[0]).value).prompt,held==='saved'?'saved while stopped':'saved first');
 // The new plan asks again: the stale call was never approved, and nothing ran yet.
 assert.equal(again?.status,'awaiting_approval');assert.equal(f.effects.size,(0)+f.loadingEffects);assert.match(f.scriptRequest(2).body,held==='saved'?/TARGET_CHANGED/u:/TARGET_EDITING/u);
 await f.action(asked,'approve',{stepId:again!.id});const done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.deepEqual(done.run.skippedTargets,[]);assert.equal(done.changes.length,1);assert.equal(f.effects.size,(1)+f.loadingEffects);assert.equal(f.requests.length,(3)+f.loadingRequests);
 assert.deepEqual(recordedHints(f,sent.run.id,'run_state').filter(state=>state.status==='paused').map(state=>state.reason),via==='pause'?['user']:[]);
 assert.equal(object(f.store.get('shots',f.first.id)).prompt,held==='saved'?'reread after resume':'saved first');
 if(held==='draft'){assert.equal(object(f.store.get('shots',f.other.id)).prompt,'other after resume');assert.equal(f.runtime.journal.claims(f.projectId).length,1);}
});
for(const protocol of ['chat_completions','responses'] as const)test(`X4 follow-up: ${protocol}: a stale revision the domain rejects returns to Mio for a reread and the run continues`,async t=>{
 const f=await fixture(t,protocol),staleId=randomUUID(),rereadId=randomUUID();
 f.setScript(async function*(index){yield {type:'done',output:output(protocol,index===1?[staleShotUpdate(f,staleId)]:index===2?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'reread edit'}},rereadId)]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id);
 assert.equal(done.run.status,'completed');assert.equal(runPaused(f,sent.run.id),false);assert.equal(done.steps.some(step=>step.status==='unknown'),false);assert.equal(done.changes.length,1);
 const stale=f.runtime.journal.snapshot(sent.run.id).steps.find(step=>step.toolCall?.id===staleId);assert.ok(stale);
 assert.equal(stale.status,'rejected');assert.equal(stale.error?.code,'REVISION_CONFLICT');assert.equal(stale.error?.message,staleRevisionMessages['zh-Hans']);assert.equal(object(stale.data).dispatchPrevented,true);
 // Only the fixed instruction returns: no current value and no domain details.
 const error=object(object(stale.result).error);assert.deepEqual(Object.keys(error).sort(),['code','message']);assert.equal(error.code,'REVISION_CONFLICT');assert.equal(error.message,staleRevisionMessages['zh-Hans']);
 assert.equal(done.steps.find(step=>step.toolCall?.id===rereadId)?.status,'completed');assert.equal(object(f.store.get('shots',f.first.id)).prompt,'reread edit');
 assert.match(f.scriptRequest(2).body,/REVISION_CONFLICT/u);assert.ok(f.scriptRequest(2).body.includes(staleRevisionMessages['zh-Hans']));assert.equal(f.requests.length,(3)+f.loadingRequests);
});
test('X4 follow-up: the stale revision instruction uses the run locale',async t=>{
 for(const locale of AGENT_TASK_LOCALES){
  const f=await fixture(t);f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[staleShotUpdate(f)]:[])};},{loadGroups:['canvas']});
  const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'synthetic X4 follow-up locale',locale,expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision}),done=await f.settle(sent.run.id);
  assert.equal(done.run.status,'completed',locale);assert.equal(done.steps.find(step=>step.toolCall?.name==='mioon_shot_update')?.error?.message,staleRevisionMessages[locale]);
  assert.ok(f.scriptRequest(2).body.includes(staleRevisionMessages[locale]),`${locale}: stale revision`);
 }
});
test('X4 follow-up: three identical stale revision rejections pause without a change',async t=>{
 const f=await fixture(t);
 f.setScript(async function*(){yield {type:'done',output:output('responses',[staleShotUpdate(f)])};},{loadGroups:['canvas']});
 const sent=await f.send(),done=await f.settle(sent.run.id),updates=done.steps.filter(step=>step.toolCall?.name==='mioon_shot_update');
 assert.equal(done.run.status,'paused');assert.equal(done.run.pauseReason,'repeated_tool_failure');assert.equal(updates.length,3);
 // Every model request and every rejected retry counts one step.
 assert.equal(updates.length*2+f.loadingSteps(done),done.run.stepsUsed);assert.ok(updates.every(step=>step.status==='rejected'&&step.error?.code==='REVISION_CONFLICT'));
 assert.equal(done.changes.length,0);assert.equal(object(f.store.get('shots',f.first.id)).prompt,'saved first');
});
test('X4 follow-up: a reorder that meets a changed shot set hands back an empty current and asks Mio to reread the project',async t=>{
 for(const locale of AGENT_TASK_LOCALES){
  const f=await fixture(t),project=object(f.store.get('projects',f.projectId)),order=()=>[f.first.id,f.other.id].map(id=>{const saved=object(f.store.get('shots',id));return [saved.orderIndex,saved.revision];}),before=order();let added=false;
  f.beforeTool(async prepared=>{if(prepared.operation==='shot.reorder'&&!added){added=true;await f.services.call('shot.create',{projectId:f.projectId,title:'Added during dispatch'});}});
  f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_reorder',{expectedRevision:revisionField(project),shotIds:[f.other.id,f.first.id]})]:[])};},{loadGroups:['canvas']});
  const sent=await f.runtime.send(f.projectId,{requestId:randomUUID(),text:'synthetic X4 follow-up reorder',locale,expectedSettingsRevision:testAgentExecution(await f.settings.get()).revision}),done=await f.settle(sent.run.id);
  assert.equal(added,true);assert.equal(done.run.status,'completed',locale);assert.equal(runPaused(f,sent.run.id),false);assert.equal(done.changes.length,0);assert.deepEqual(order(),before);
  const step=f.runtime.journal.snapshot(sent.run.id).steps.find(item=>item.toolCall?.name==='mioon_shot_reorder');assert.ok(step);
  assert.equal(step.status,'rejected');assert.equal(step.error?.code,'TARGET_CHANGED');assert.equal(step.error?.message,projectRereadMessages[locale]);assert.equal(object(step.data).dispatchPrevented,true);
  const error=object(object(step.result).error);assert.deepEqual(error.current,[]);assert.equal(error.message,projectRereadMessages[locale]);assert.equal(error.omittedTargets,undefined);
  assert.ok(f.scriptRequest(2).body.includes(projectRereadMessages[locale]),`${locale}: project reread`);
 }
});
for(const action of ['handBack','deny'] as const)test(`X4 follow-up: ${action==='handBack'?'a handed-back':'a denied'} foreground approval queues the run's background work again at once`,async t=>{
 const f=await fixture(t),callId=randomUUID();
 f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});
 f.setScript(async function*(index){yield {type:'done',output:output('responses',index===1?[call('mioon_shot_update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'awaiting approval'}},callId)]:[])};},{loadGroups:['canvas']});
 const sent=await f.send(),waiting=await f.settle(sent.run.id),step=waiting.steps.find(item=>item.toolCall?.id===callId);assert.equal(waiting.run.status,'awaiting_approval');assert.ok(step);assert.equal(step.status,'awaiting_approval');
 let wakeups=0;const removeResumer=setAgentTaskJobResumer(f.store.db,'synthetic-x4-followup-resume',runId=>{if(runId===sent.run.id)wakeups++;});t.after(removeResumer);
 if(action==='handBack'){
  await f.services.call('shot.update',{shotId:f.first.id,expectedRevision:1,patch:{prompt:'saved before approval'}});
  await assert.rejects(f.action(waiting,'approve',{stepId:step.id}),{code:'AGENT_TASK_TARGET_CHANGED',message:'该目标已被手动修改，这一步没有执行，Mio 会按当前内容重新规划。'});
 }else await f.action(waiting,'deny',{stepId:step.id});
 // Requeued with the control itself, not at the next approval stop.
 assert.equal(wakeups,1);
 const done=await f.settle(sent.run.id);assert.equal(done.run.status,'completed');assert.equal(wakeups,1);assert.equal(done.changes.length,0);assert.equal(done.steps.find(item=>item.id===step.id)?.status,'rejected');
 assert.equal(object(f.store.get('shots',f.first.id)).prompt,action==='handBack'?'saved before approval':'saved first');
});
