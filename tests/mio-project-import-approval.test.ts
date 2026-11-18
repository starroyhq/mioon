import test from 'node:test';
import assert from 'node:assert/strict';
import {lstatSync,readFileSync,renameSync,utimesSync,writeFileSync} from 'node:fs';
import {protocols,object,fixture,plan,imports} from './helpers/mio-project-import-tools-fixture.ts';

for(const protocol of protocols)for(const mutation of ['replacement','same-inode'] as const)test(protocol+': approval pins the original '+mutation+' source'+(mutation==='same-inode'?' across close and reopen':''),async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});const importCall=plan(f,protocol);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();
  const step=waiting.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);assert.equal(f.prepares.length,1);assert.equal(f.executions.length,0);
  const retained=f.runtime.journal.step(step.id).data;assert.ok(object(retained).projectFileImport);assert.ok(!JSON.stringify(waiting).includes(f.root));
  const prior=lstatSync(f.source,{bigint:true});
  if(mutation==='replacement'){renameSync(f.source,f.source+'.original');writeFileSync(f.source,f.sourceBytes);assert.notEqual(lstatSync(f.source,{bigint:true}).ino,prior.ino);}
  else{const changed=Buffer.from(f.sourceBytes);changed[changed.length-1]^=1;writeFileSync(f.source,changed);assert.equal(lstatSync(f.source,{bigint:true}).ino,prior.ino);}
  utimesSync(f.source,f.sourceTime,f.sourceTime);assert.equal(lstatSync(f.source,{bigint:true}).mtimeNs,prior.mtimeNs);
  if(mutation==='same-inode'){await f.reopen();const current=f.runtime.get(f.projectId,sent.run.id);assert.equal(current.run.status,'interrupted');await f.action(current,'resume');}
  else await f.action(waiting,'approve',{stepId:step.id});
  const done=await f.settle(sent.run.id);
  assert.equal(f.executions.length,0);assert.equal(f.creations.length,0);assert.equal(imports(f).length,0);assert.equal(done.changes.length,0);assert.notEqual(done.steps.find(item=>item.id===step.id)?.status,'completed');
  assert.deepEqual(object(f.runtime.journal.step(step.id).data).projectFileImport,object(retained).projectFileImport,'Reapproval must not replace the frozen source proof');
});

for(const protocol of protocols)test(protocol+': a denied import never executes and preserves the source',async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});const importCall=plan(f,protocol);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const step=waiting.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  await f.action(waiting,'deny',{stepId:step.id});const done=await f.settle(sent.run.id);
  assert.equal(done.steps.find(item=>item.id===step.id)?.status,'rejected');assert.equal(f.executions.length,0);assert.equal(imports(f).length,0);assert.deepEqual(readFileSync(f.source),f.sourceBytes);
});

for(const protocol of protocols)test(protocol+': unchanged approval resumes after reopening with the original private proof',async t=>{
  const f=await fixture(t,protocol);f.runtime.journal.updatePolicy({...f.runtime.policy(),modes:{...f.runtime.policy().modes,local_reversible:'confirm'}});const importCall=plan(f,protocol);
  const sent=await f.send(),waiting=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();const step=waiting.steps.find(item=>item.toolCall?.id===importCall.id);assert.ok(step);
  const original=structuredClone(object(f.runtime.journal.step(step.id).data).projectFileImport);assert.ok(original);
  await f.reopen();const interrupted=f.runtime.get(f.projectId,sent.run.id);assert.equal(interrupted.run.status,'interrupted');await f.action(interrupted,'resume');
  const again=await f.wait(sent.run.id,'awaiting_approval');await f.runtime.drain();assert.equal(f.executions.length,0);assert.deepEqual(object(f.runtime.journal.step(step.id).data).projectFileImport,original);
  await f.action(again,'approve',{stepId:step.id});const done=await f.settle(sent.run.id);
  assert.equal(done.steps.find(item=>item.id===step.id)?.status,'completed');assert.equal(imports(f).length,1);assert.equal(f.creations.length,1);assert.equal(done.changes.filter(change=>change.stepId===step.id).length,1);
  assert.ok(f.prepares.some(item=>item.retained!==undefined));assert.ok(f.prepares.every(item=>item.requestId===step.id));assert.deepEqual(object(f.runtime.journal.step(step.id).data).projectFileImport,original);
});
