import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createMioProjectImport} from '../packages/business/src/agent/mio-project-import.ts';
import {projectAssetImportPreparationSchema} from '../packages/business/src/referenced-asset-project-import.ts';
import {decodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import type {EncodedProjectDocument} from '../packages/business/src/project-versions/codec.ts';

const registration=['before_register','inside_record_created','after_commit_before_ack','after_registered'] as const;
const compensation=['undo_before_delete','undo_inside_record','undo_after_commit'] as const;
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
interface Receipt {name:string;sha256:string;phase:string}
interface Evidence {projectId:string;runId:string;stepId:string;controlId:string;preparation:unknown;sourceSha256:string;receiptBeforeUndo:Receipt[]}
const object=(value:unknown):Record<string,unknown>=>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};

for(const point of [...registration,...compensation,'stable'] as const)test(`project import ${point==='stable'?'with production version capture':`SIGKILL ${point}`} preserves one complete state`,{timeout:90_000},async t=>{
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-import-crash-'));let close=async()=>{};
  t.after(async()=>{try{await close();}finally{rmSync(root,{recursive:true,force:true});}});
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/mio-project-import-crash-worker.ts',import.meta.url)),JSON.stringify({root,point})],{stdio:'ignore',timeout:60_000,env:{PATH:process.env.PATH??'',TMPDIR:tmpdir(),LANG:'C.UTF-8',}});
  const failure=path.join(root,'worker-failure.json');assert.equal(child.error,undefined);
  assert.equal(child.status,point==='stable'?0:null,existsSync(failure)?readFileSync(failure,'utf8'):'Unexpected worker exit');
  assert.equal(child.signal,point==='stable'?null:'SIGKILL');
  const evidence=JSON.parse(readFileSync(path.join(root,'evidence.json'),'utf8')) as Evidence,checkpoint=object(JSON.parse(readFileSync(path.join(root,'checkpoint.json'),'utf8')));
  assert.equal(checkpoint.point,point);
  assert.equal(checkpoint.inTransaction,['before_register','inside_record_created','undo_before_delete','undo_inside_record'].includes(point));
  if(point==='before_register'){assert.equal(checkpoint.assets,0);assert.equal(checkpoint.step,'dispatch_started');assert.deepEqual(checkpoint.changes,[]);}
  if(point==='inside_record_created'){assert.equal(checkpoint.assets,1);assert.equal(checkpoint.step,'completed');assert.equal((checkpoint.changes as unknown[]).length,1);}
  if(point==='after_commit_before_ack'||point==='after_registered'){assert.equal(checkpoint.assets,1);assert.equal(checkpoint.step,'completed');}
  if(point==='undo_before_delete'){assert.equal(checkpoint.assets,1);assert.equal(object(object(checkpoint.control).result).state,'pending');}
  if(point==='undo_inside_record'||point==='undo_after_commit'){assert.equal(checkpoint.assets,0);assert.equal(object(object(checkpoint.control).result).state,'completed');assert.equal(object((checkpoint.changes as unknown[])[0]).status,'reverted');}
  const store=openStore(root),services=createServices(store,new Map());close=async()=>{await services.drain();store.close();};
  const journal=createAgentTaskJournal(store),preparation=projectAssetImportPreparationSchema.parse(evidence.preparation),application=testProjectAppLibrary(store);assert.ok(application);
  const port=createMioProjectImport({store,services,privateDirectories:[application.dataDir,store.cacheDir,store.tempDir]});
  const committed=point!=='before_register'&&point!=='inside_record_created',reverted=point==='undo_after_commit'||point==='stable';
  const snapshot=journal.snapshot(evidence.runId),assets=store.list('assets',evidence.projectId),step=journal.step(evidence.stepId);
  assert.equal(assets.length,committed&&!reverted?1:0);assert.equal(snapshot.changes.length,committed?1:0);assert.equal(step.status,committed?'completed':'dispatch_started');
  if(committed){
    const change=snapshot.changes[0]!;assert.equal(change.stepId,evidence.stepId);assert.equal(change.status,reverted?'reverted':'applied');
    assert.equal(change.targets.length,1);assert.equal(change.targets[0]?.id,object(step.result).assetId);
    assert.equal(object(step.result).registration,'created');assert.equal(change.reversible,true);
    const version=store.db.prepare("SELECT b.* FROM main.project_versions v JOIN main.project_version_blobs b ON b.hash=v.blobHash WHERE v.mioRunId=? AND v.trigger='mio-turn'").all(evidence.runId);
    assert.equal(version.length,1);assert.deepEqual(decodeProjectDocument(version[0] as unknown as EncodedProjectDocument).tables.assets,[]);
  }else assert.equal(Number(store.db.prepare('SELECT count(*) n FROM main.project_versions').get()!.n),0);
  const receiptDir=path.join(store.tempDir,'asset-imports'),receipts=readdirSync(receiptDir).filter(name=>name.endsWith('.json')).sort().map(name=>({name,sha256:hash(readFileSync(path.join(receiptDir,name))),phase:object(JSON.parse(readFileSync(path.join(receiptDir,name),'utf8'))).phase}));
  assert.equal(receipts.length,1);assert.equal(receipts[0]!.phase,point==='after_registered'||point.startsWith('undo_')||point==='stable'?'registered':'prepared');
  assert.equal(hash(readFileSync(path.join(root,'source.png'))),evidence.sourceSha256);
  const undo=point.startsWith('undo_')||point==='stable';
  assert.equal(Number(store.db.prepare('SELECT count(*) n FROM main.mio_controls WHERE runId=?').get(evidence.runId)!.n),undo?1:0);
  if(undo){
    assert.deepEqual(receipts,evidence.receiptBeforeUndo);const control=journal.lookupControl(evidence.controlId);assert.ok(control);
    assert.equal(object(control.result).state,reverted?'completed':'pending');
    if(reverted)assert.deepEqual(object(control.result).revertedIds,[snapshot.changes[0]!.id]);
  }
  journal.recover();
  assert.equal(journal.step(evidence.stepId).status,committed?'completed':'unknown');
  const lookup=await port.lookup(preparation,{beforeEffect(){}});assert.equal(lookup.outcome,!committed?'not_applied':reverted?'retired':'applied');lookup.assertCurrent();
  if(undo){
    const result=object(journal.lookupControl(evidence.controlId)!.result);assert.equal(result.state,reverted?'completed':'blocked');
    assert.deepEqual(result.revertedIds,reverted?[snapshot.changes[0]!.id]:[]);
    if(!reverted)assert.equal(object(result.error).code,'AGENT_TASK_INTERRUPTED');
  }
  if(reverted){
    await assert.rejects(services.call('asset.import',preparation.input),{code:'IDEMPOTENCY_CONFLICT'});
    await assert.rejects(port.execute(preparation,{beforeEffect(){},recordCreatedInside(){assert.fail('A retired key must never create a second Change');}}));
    assert.equal(store.list('assets',evidence.projectId).length,0);assert.equal(journal.snapshot(evidence.runId).changes.length,1);
    assert.deepEqual(readdirSync(receiptDir).filter(name=>name.endsWith('.json')).sort().map(name=>({name,sha256:hash(readFileSync(path.join(receiptDir,name))),phase:object(JSON.parse(readFileSync(path.join(receiptDir,name),'utf8'))).phase})),receipts);
  }
});
