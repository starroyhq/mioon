import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {openStore,classifyCurrentWorkspaceSchema,installCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import {classifyWorkspaceSchemaV48V49} from '../packages/business/src/workspace-restore-schema-v49.ts';
function fixture(){const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-task-v2-')),store=openStore(root),projectId=randomUUID();store.put('projects',{id:projectId,name:'Task fixture',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});return {root,store,projectId,journal:createAgentTaskJournal(store),close(){store.close();rmSync(root,{recursive:true,force:true});}};}
function start(f:ReturnType<typeof fixture>,stepLimit=30){return f.journal.create({requestId:randomUUID(),projectId:f.projectId,text:'测试',configuration:{protocol:'responses'},policy:{...structuredClone(DEFAULT_AGENT_TASK_POLICY),stepLimit}});}
test('v2 requests and controls replay original receipt without repeating state changes',()=>{const f=fixture();try{const first=start(f),input={requestId:randomUUID(),runId:first.run.id,expectedRevision:1,action:'pause'};let calls=0;const result=f.journal.performControl(input,()=>{calls++;return {status:f.journal.transition(first.run.id,1,'paused').status};});assert.equal(result.revision,2);assert.deepEqual(f.journal.performControl(input,()=>{calls++;return null;}),result);assert.equal(calls,1);assert.throws(()=>f.journal.performControl({...input,action:'stop'},()=>null),{code:'AGENT_TASK_REQUEST_CONFLICT'});assert.equal(f.journal.lookupRequest(f.projectId,first.run.requestId)?.run.id,first.run.id);}finally{f.close();}});
test('v2 budget is cumulative and an explicitly resumed round does not repeat completed steps',()=>{const f=fixture();try{const run=start(f,2).run;for(let i=0;i<2;i++){const step=f.journal.beginStep(run.id,{kind:'model',request:{i}});f.journal.completeStep(run.id,step.id,{result:{i}});}assert.throws(()=>f.journal.beginStep(run.id,{kind:'model'}),{code:'AGENT_TASK_BUDGET_EXHAUSTED'});let current=f.journal.run(run.id);current=f.journal.transition(run.id,current.revision,'paused','budget');current=f.journal.resume(run.id,current.revision,{extendBudget:true});assert.equal(current.budget,4);assert.equal(current.stepsUsed,2);assert.equal(f.journal.snapshot(run.id).steps.length,2);}finally{f.close();}});
test('approval resume preserves an exhausted budget and finishes only the existing counted intent',()=>{
 const f=fixture();try{
  const run=start(f,2).run,model=f.journal.beginStep(run.id,{kind:'model'});f.journal.completeStep(run.id,model.id,{result:{}});
  const tool=f.journal.beginStep(run.id,{kind:'tool'});f.journal.updateStep(run.id,tool.id,{status:'awaiting_approval'});let current=f.journal.run(run.id);f.journal.transition(run.id,current.revision,'awaiting_approval');
  f.journal.updateStep(run.id,tool.id,{status:'intent'});current=f.journal.resume(run.id,f.journal.run(run.id).revision);
  assert.equal(current.stepsUsed,2);assert.equal(current.budget,2);f.journal.markDispatch(run.id,tool.id);f.journal.completeStep(run.id,tool.id,{result:{approved:true}});
  assert.equal(f.journal.snapshot(run.id).steps.length,2);assert.equal(f.journal.step(tool.id).status,'completed');assert.throws(()=>f.journal.beginStep(run.id,{kind:'model'}),{code:'AGENT_TASK_BUDGET_EXHAUSTED'});
 }finally{f.close();}
});
for(const reason of ['user','budget','interrupted'] as const)for(const full of [false,true])test(`explicit continuation ${reason} ${full?'at':'below'} budget preserves CAS and uses the original round size`,()=>{
 const f=fixture();try{
  const run=start(f,2).run;for(let index=0;index<(full?2:1);index++){const step=f.journal.beginStep(run.id,{kind:'model'});f.journal.completeStep(run.id,step.id,{result:{index}});}
  const before=f.journal.run(run.id),paused=f.journal.transition(run.id,before.revision,reason==='interrupted'?'interrupted':'paused',reason);
  f.journal.updatePolicy({...f.journal.policy(),stepLimit:7});const saved=f.journal.snapshot(run.id);
  assert.throws(()=>f.journal.resume(run.id,paused.revision-1,{extendBudget:true}),{code:'AGENT_TASK_REVISION_CONFLICT'});assert.deepEqual(f.journal.snapshot(run.id),saved);
  const current=f.journal.resume(run.id,paused.revision,{extendBudget:true});assert.equal(current.stepLimit,2);assert.equal(current.budget,full?4:2);assert.equal(current.stepsUsed,full?2:1);
  assert.throws(()=>f.journal.resume(run.id,paused.revision,{extendBudget:true}),{code:'AGENT_TASK_REVISION_CONFLICT'});assert.equal(f.journal.run(run.id).budget,full?4:2);
 }finally{f.close();}
});
test('budget continuation refuses overflow atomically while approval resume never adds a round',()=>{
 const f=fixture();try{
  const run=start(f,2).run,paused=f.journal.transition(run.id,run.revision,'awaiting_approval'),limit=Number.MAX_SAFE_INTEGER-1;
  f.store.db.prepare('UPDATE agent_task_runs_v2 SET data=? WHERE id=?').run(JSON.stringify({...paused,budget:limit,stepsUsed:limit}),run.id);const before=f.journal.snapshot(run.id);
  assert.throws(()=>f.journal.resume(run.id,paused.revision,{extendBudget:true}),{code:'AGENT_TASK_BUDGET_LIMIT'});assert.deepEqual(f.journal.snapshot(run.id),before);
  const approved=f.journal.resume(run.id,paused.revision);assert.equal(approved.budget,limit);assert.equal(approved.stepsUsed,limit);
 }finally{f.close();}
});
test('approval and explicit continuation both preserve unknown-result fencing before changing any budget',()=>{
 const f=fixture();try{
  const run=start(f,1).run,step=f.journal.beginStep(run.id,{kind:'model'});f.journal.markDispatch(run.id,step.id);f.journal.recover();const saved=f.journal.snapshot(run.id);
  for(const extendBudget of [false,true]){assert.throws(()=>f.journal.resume(run.id,saved.run.revision,{extendBudget}),{code:'AGENT_TASK_UNKNOWN_RESULT'});assert.deepEqual(f.journal.snapshot(run.id),saved);}
 }finally{f.close();}
});
for(const reason of ['editing','conflict','user','budget'] as const)test(`restart preserves unresolved ${reason} selection without resuming the run`,()=>{
 const f=fixture();try{
  const run=start(f,2).run,step=f.journal.beginStep(run.id,{kind:'tool'});
  f.journal.transition(run.id,f.journal.run(run.id).revision,'paused',reason);
  assert.equal(f.journal.recover(),1);const saved=f.journal.snapshot(run.id);
  assert.equal(saved.run.status,'interrupted');assert.equal(saved.run.pauseReason,reason==='editing'||reason==='conflict'?reason:'restart');
  assert.equal(saved.steps[0]?.id,step.id);assert.equal(saved.steps[0]?.status,'intent');assert.equal(saved.run.budget,2);assert.equal(saved.run.stepsUsed,1);
  assert.equal(f.journal.recover(),0);assert.deepEqual(f.journal.snapshot(run.id),saved);
 }finally{f.close();}
});
test('v2 dispatch result and changes share domain transaction, failure rolls back both',()=>{const f=fixture();try{const run=start(f).run,step=f.journal.beginStep(run.id,{kind:'tool'});f.journal.markDispatch(run.id,step.id);const nodeId=randomUUID();assert.throws(()=>f.store.tx(()=>{f.store.put('nodes',{id:nodeId,projectId:f.projectId,type:'text',text:'side effect'});f.journal.completeStepInside(run.id,step.id,{result:{ok:true}});throw new Error('disk fault');}),/disk fault/);assert.equal(f.store.get('nodes',nodeId),null);assert.equal(f.journal.step(step.id).status,'dispatch_started');assert.equal(f.journal.recover(),1);assert.equal(f.journal.run(run.id).status,'interrupted');assert.equal(f.journal.step(step.id).status,'unknown');assert.throws(()=>f.journal.resume(run.id,f.journal.run(run.id).revision),{code:'AGENT_TASK_UNKNOWN_RESULT'});}finally{f.close();}});
test('target revisions preserve ABA and separate timeline clip conflicts',()=>{const f=fixture();try{const a=randomUUID(),b=randomUUID(),timelineId=randomUUID();const timeline={id:timelineId,projectId:f.projectId,revision:1,width:720,height:1280,fps:30,tracks:[],clips:[{id:a,name:'A'},{id:b,name:'B'}]};f.store.put('timelines',timeline);const before=f.journal.targetRevision(f.projectId,'timeline_clip',a),other=f.journal.targetRevision(f.projectId,'timeline_clip',b);f.store.put('timelines',{...timeline,revision:2,clips:[{id:a,name:'changed'},{id:b,name:'B'}]});f.store.put('timelines',{...timeline,revision:3});assert.equal(f.journal.targetRevision(f.projectId,'timeline_clip',a),before+2);assert.equal(f.journal.targetRevision(f.projectId,'timeline_clip',b),other);assert.throws(()=>f.journal.assertTargets(f.projectId,[{kind:'timeline_clip',id:a,revision:before}]),{code:'AGENT_TASK_TARGET_CHANGED'});f.journal.assertTargets(f.projectId,[{kind:'timeline_clip',id:b,revision:other}]);}finally{f.close();}});
test('multiple editing owners block AI until all release; stale release cannot unlock new generation',()=>{const f=fixture();try{const target={kind:'shot',id:randomUUID(),revision:0},ownerA=randomUUID(),ownerB=randomUUID();const edit=(ownerId:string,sequence:number,action:'claim'|'release',generation=1)=>f.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation,sequence,action,targets:[target]});edit(ownerA,1,'claim');edit(ownerB,1,'claim');assert.equal(f.journal.claims(f.projectId).length,2);edit(ownerA,2,'release');assert.throws(()=>f.journal.assertTargets(f.projectId,[target]),{code:'AGENT_TASK_TARGET_CLAIMED'});edit(ownerB,2,'release');f.journal.assertTargets(f.projectId,[target]);edit(ownerA,3,'claim');assert.throws(()=>edit(ownerA,2,'release'),{code:'AGENT_TASK_EDIT_OWNER_STALE'});f.journal.recover();assert.equal(f.journal.claims(f.projectId)[0]?.state,'uncertain');assert.throws(()=>edit(ownerA,4,'claim',2),{code:'AGENT_TASK_EDIT_OWNER_UNCERTAIN'});}finally{f.close();}});
test('explicit same-owner restore retains claim identity, checks original target revisions and fences old releases',()=>{const f=fixture();try{
 const id=randomUUID(),ownerId=randomUUID();f.store.put('shots',{id,projectId:f.projectId,title:'Original',revision:1});const target={kind:'shot',id,revision:f.journal.targetRevision(f.projectId,'shot',id)},input={requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence:1,action:'claim' as const,targets:[target]};
 const original=f.journal.edit(input).claims[0]!;f.journal.recover();assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.state,'uncertain');
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:2,action:'restore',targets:[{...target,id:randomUUID()}]}),{code:'AGENT_TASK_TARGET_CHANGED'});
 const restored=f.journal.edit({...input,requestId:randomUUID(),generation:2,action:'restore'});assert.equal(restored.claims[0]?.id,original.id);assert.equal(restored.claims[0]?.state,'active');assert.throws(()=>f.journal.assertTargets(f.projectId,[target]),{code:'AGENT_TASK_TARGET_CLAIMED'});
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),sequence:2,action:'release'}),{code:'AGENT_TASK_EDIT_OWNER_STALE'});
 f.store.put('shots',{id,projectId:f.projectId,title:'External',revision:2});f.store.put('shots',{id,projectId:f.projectId,title:'Original',revision:3});
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:2,sequence:2,targets:[{...target,revision:f.journal.targetRevision(f.projectId,'shot',id)}]}),{code:'AGENT_TASK_TARGET_CHANGED'});assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.target.revision,target.revision);f.journal.recover();
 assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.target.revision,target.revision);assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:3,action:'restore'}),{code:'AGENT_TASK_TARGET_CHANGED'});
 assert.throws(()=>f.journal.edit({...input,requestId:randomUUID(),generation:3,action:'restore',targets:[{...target,revision:f.journal.targetRevision(f.projectId,'shot',id)}]}),{code:'AGENT_TASK_TARGET_CHANGED'});assert.equal(f.journal.claims(f.projectId,ownerId)[0]?.state,'uncertain');
 f.journal.edit({...input,requestId:randomUUID(),generation:3,action:'resolve'});assert.equal(f.journal.claims(f.projectId,ownerId).length,0);
}finally{f.close();}});
test('schema56 is an exact new profile and restored57 retains immutable v2 evidence',()=>{const f=fixture();try{const run=start(f).run;assert.deepEqual(classifyCurrentWorkspaceSchema(f.store.db),{schemaVersion:56,profile:'ordinary'});assert.throws(()=>classifyWorkspaceSchemaV48V49(f.store.db),{code:'RESTORE_SCHEMA_UNSUPPORTED'});const info=installCurrentWorkspaceRestoreSchema(f.store.db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()});assert.equal(info.schemaVersion,57);assert.equal(info.sourceSchema,56);assert.throws(()=>f.store.db.prepare("UPDATE agent_task_runs_v2 SET status='running' WHERE id=?").run(run.id),/RESTORED_RECORD_HELD/);assert.equal(f.journal.run(run.id).text,'测试');}finally{f.close();}});

test('schema56 backup restores policy receipts and selected import bytes into fixed57',async()=>{
 const f=fixture(),backup=`${f.root}-backup`,restored=`${f.root}-restored`;try{
  const requestId=randomUUID(),selected=randomUUID(),bytes=Buffer.from('selected local file'),sha256=createHash('sha256').update(bytes).digest('hex');
  const policy=f.journal.updatePolicy({...structuredClone(DEFAULT_AGENT_TASK_POLICY),modes:{...DEFAULT_AGENT_TASK_POLICY.modes,paid:'direct'}},requestId);
  assert.equal(f.journal.lookupPolicy(requestId)?.revision,1);assert.deepEqual(f.journal.updatePolicy({...structuredClone(DEFAULT_AGENT_TASK_POLICY),modes:{...DEFAULT_AGENT_TASK_POLICY.modes,paid:'direct'}},requestId),policy);
  mkdirSync(join(f.root,'agent-imports'),{mode:0o700});writeFileSync(join(f.root,'agent-imports',`${selected}.bin`),bytes,{mode:0o600});
  f.store.db.prepare("INSERT INTO agent_task_imports_v2(id,projectId,requestId,name,mimeType,relativePath,sha256,status,createdAt) VALUES(?,?,?,?,?,?,?,'selected',?)").run(selected,f.projectId,randomUUID(),'chosen.png','image/png',`agent-imports/${selected}.bin`,sha256,new Date().toISOString());
  const original=f.store.db.prepare('SELECT * FROM agent_task_imports_v2').all();f.store.close();
  const created=await createWorkspaceBackup({source:f.root,destination:backup});assert.equal(created.databaseSchemaVersion,56);assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
  const result=await restoreWorkspaceBackup({directory:backup,destination:restored});assert.equal(result.databaseSchemaVersion,57);
  const copy=openStore(restored);try{assert.deepEqual(copy.db.prepare('SELECT * FROM agent_task_imports_v2').all(),original);assert.deepEqual(readFileSync(join(restored,'agent-imports',`${selected}.bin`)),bytes);assert.deepEqual(createAgentTaskJournal(copy).lookupPolicy(requestId),policy);}finally{copy.close();}
 }finally{f.close();rmSync(backup,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});

test('pending undo control keeps immutable intent and exposes finished persisted progress',()=>{const f=fixture();try{const run=start(f).run,input={requestId:randomUUID(),runId:run.id,expectedRevision:run.revision,action:'undo_all'};assert.deepEqual(f.journal.beginControl(input).result,{state:'pending'});f.journal.finishControl(input.requestId,{state:'blocked',revertedIds:[],error:'target changed'});assert.deepEqual(f.journal.lookupControl(input.requestId)?.result,{state:'blocked',revertedIds:[],error:'target changed'});assert.deepEqual(f.journal.beginControl(input).result,{state:'blocked',revertedIds:[],error:'target changed'});assert.throws(()=>f.journal.beginControl({...input,action:'undo_change'}),{code:'AGENT_TASK_REQUEST_CONFLICT'});}finally{f.close();}});

test('only proven prevented dispatch can return to approval; unknown stays non-retryable',()=>{const f=fixture();try{const run=start(f).run,step=f.journal.beginStep(run.id,{kind:'tool'});f.journal.markDispatch(run.id,step.id);assert.equal(f.journal.dispatchPrevented(run.id,step.id,'awaiting_approval').status,'awaiting_approval');f.journal.updateStep(run.id,step.id,{status:'intent'});f.journal.markDispatch(run.id,step.id);f.journal.updateStep(run.id,step.id,{status:'unknown'});assert.throws(()=>f.journal.dispatchPrevented(run.id,step.id,'intent'),{code:'AGENT_TASK_STATE_CONFLICT'});assert.throws(()=>f.journal.markDispatch(run.id,step.id),{code:'AGENT_TASK_STATE_CONFLICT'});}finally{f.close();}});
test('restart marks pending undo control on completed run blocked without replay',()=>{const f=fixture();try{const run=start(f).run;const completed=f.journal.transition(run.id,run.revision,'completed'),input={requestId:randomUUID(),runId:run.id,expectedRevision:completed.revision,action:'undo_all'};f.journal.beginControl(input);assert.equal(f.journal.recover(),0);assert.equal(f.journal.run(run.id).status,'completed');assert.deepEqual(f.journal.lookupControl(input.requestId)?.result,{state:'blocked',error:{code:'AGENT_TASK_INTERRUPTED',message:'控制操作因进程重启而中断；已完成的变更回退保持不变。'},revertedIds:[]});}finally{f.close();}});

test('aggregate project revision changes do not invalidate a project text target',()=>{const f=fixture();try{const before=f.journal.targetRevision(f.projectId,'project',f.projectId),project=f.store.get('projects',f.projectId) as Record<string,unknown>;f.store.put('projects',{...project,revision:2,updatedAt:new Date(Date.now()+1000).toISOString()});assert.equal(f.journal.targetRevision(f.projectId,'project',f.projectId),before);f.store.put('projects',{...project,revision:3,name:'Updated project title'});assert.equal(f.journal.targetRevision(f.projectId,'project',f.projectId),before+1);}finally{f.close();}});

test('history keyset pages discover every run without overlap and reject a foreign project cursor',()=>{const f=fixture();try{const ids:string[]=[];for(let i=0;i<4;i++){const run=start(f).run;ids.push(run.id);f.journal.transition(run.id,run.revision,'completed');}const first=f.journal.history(f.projectId,{limit:2});assert.equal(first.conversations.length,2);assert.ok(first.nextCursor);const second=f.journal.history(f.projectId,{limit:2,cursor:first.nextCursor});assert.equal(second.nextCursor,null);assert.deepEqual([...first.conversations,...second.conversations].map(conversation=>conversation.lastRunId).sort(),ids.sort());assert.throws(()=>f.journal.history(randomUUID(),{cursor:first.nextCursor!}),{code:'AGENT_TASK_INVALID'});}finally{f.close();}});

test('stale control rejection has a retained receipt and exact replay never performs the action',()=>{const f=fixture();try{const run=start(f).run;f.journal.transition(run.id,run.revision,'paused');const input={requestId:randomUUID(),runId:run.id,expectedRevision:run.revision,action:'resume'};let calls=0;assert.throws(()=>f.journal.performControl(input,()=>{calls++;return null;}),{code:'AGENT_TASK_REVISION_CONFLICT'});const rejected=f.journal.rejectControl(input,'AGENT_TASK_REVISION_CONFLICT');assert.equal(rejected.revision,f.journal.run(run.id).revision);assert.deepEqual(rejected.result,{state:'rejected',code:'AGENT_TASK_REVISION_CONFLICT'});assert.deepEqual(f.journal.lookupControl(input.requestId),rejected);assert.deepEqual(f.journal.performControl(input,()=>{calls++;return null;}),rejected);assert.equal(calls,0);assert.throws(()=>f.journal.rejectControl({...input,action:'stop'},'AGENT_TASK_REVISION_CONFLICT'),{code:'AGENT_TASK_REQUEST_CONFLICT'});}finally{f.close();}});

test('restored57 server reads v2 history without credentials or recovery and rejects every mutation without database changes',async()=>{
 const f=fixture(),backup=`${f.root}-http-backup`,restored=`${f.root}-http-restored`;let server:Awaited<ReturnType<typeof import('../apps/server/src/index.ts')['startServer']>>|undefined;
 const dump=(root:string)=>{const db=new DatabaseSync(join(root,'workbench.sqlite'),{readOnly:true});try{return db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>({name:row.name,sql:row.sql,...(String(row.sql).startsWith('CREATE TABLE')?{rows:db.prepare(`SELECT * FROM "${String(row.name)}"`).all().map(item=>JSON.stringify(item)).sort()}: {})}));}finally{db.close();}};
 try{
  const run=start(f).run,step=f.journal.beginStep(run.id,{kind:'model',request:{test:'never repeat'}});f.journal.markDispatch(run.id,step.id);const expected=f.journal.snapshot(run.id);f.store.close();
  await createWorkspaceBackup({source:f.root,destination:backup});await restoreWorkspaceBackup({directory:backup,destination:restored});const before=dump(restored);
  const {startServer}=await import('../apps/server/src/index.ts');let models=0;server=await startServer({dataDir:restored,port:0,taskGatewayV2:async function*(){models++;throw Error('Restored records must never execute');}});
  const request=async(route:string,method='GET',input?:unknown)=>{const response=await fetch(server!.url+route,{method,headers:{Authorization:`Bearer ${server!.token}`,...(input!==undefined?{'Content-Type':'application/json'}:{})},...(input!==undefined?{body:JSON.stringify(input)}:{})});return {status:response.status,value:await response.json() as {ok?:boolean;data?:Record<string,unknown>;error?:{code:string}}};};
  const prefix=`/api/agent/tasks/v2/${f.projectId}`,listed=await request(prefix);assert.equal(listed.status,200,JSON.stringify(listed.value));assert.equal(listed.value.data?.readOnly,true);assert.ok(listed.value.data?.settings);assert.equal((listed.value.data?.runs as {id:string}[])[0]?.id,run.id);
  const history=await request(`${prefix}/history`);assert.equal(history.status,200);assert.equal((history.value.data?.conversations as {lastRunId:string}[])[0]?.lastRunId,run.id);
  const detail=await request(`${prefix}/${run.id}`);assert.equal(detail.status,200);assert.equal((detail.value.data?.run as {status:string}).status,expected.run.status);assert.equal((detail.value.data?.steps as {status:string}[])[0]?.status,'dispatch_started');
  const writes:[string,string,unknown][]=[
   [prefix,'POST',{requestId:randomUUID(),text:'禁止发送',expectedSettingsRevision:0}],
   [`${prefix}/${run.id}/actions`,'POST',{requestId:randomUUID(),expectedRevision:run.revision,action:'stop'}],
   ['/api/agent/tasks/v2/policy','PUT',{requestId:randomUUID(),expectedRevision:0,stepLimit:30,modes:{...DEFAULT_AGENT_TASK_POLICY.modes}}],
   ['/api/agent/tasks/v2/editing','POST',{requestId:randomUUID(),projectId:f.projectId,ownerId:randomUUID(),generation:1,sequence:1,action:'claim',targets:[]}],
   [`${prefix}/uploads`,'POST',{requestId:randomUUID(),name:'local.txt',mimeType:'text/plain',dataBase64:'eA=='}],
  ];
  for(const [route,method,input]of writes){const response=await request(route,method,input);assert.equal(response.status,409);assert.ok(['AGENT_TASK_READ_ONLY','RESTORE_OPERATION_UNAVAILABLE'].includes(response.value.error?.code??''));}
  assert.equal(models,0);await server.close();server=undefined;assert.deepEqual(dump(restored),before);
 }finally{await server?.close();f.close();rmSync(backup,{recursive:true,force:true});rmSync(restored,{recursive:true,force:true});}
});
