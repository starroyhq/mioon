import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {openStore, createProjectStore} from '../packages/business/src/project-file/index.ts';
import {openAppLibrary, projectFileIdentity} from '../packages/business/src/app-db/index.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {createMioRuleWriteRepository} from '../packages/business/src/agent/mio-rule-write-repository.ts';
import {validateAgentTaskRowsV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {bindAgentTaskRowValidation} from '../packages/business/src/agent/task-project-row-validation-v2.ts';
import {withoutForeignKeys} from './helpers/project-database.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';

const options = {};
const invalid = {code: 'RESTORE_SCHEMA_UNSUPPORTED'};
function scratch(t: TestContext): string {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'mioon-task-row-validation-'));
  t.after(() => rmSync(root, {recursive: true, force: true})); return root;
}
function fixture(t: TestContext) {
  const store = openStore(scratch(t)), library = testProjectAppLibrary(store); assert.ok(library);
  t.after(() => store.close());
  const now = new Date().toISOString();
  store.put('projects', {id: store.projectId, name: 'Actual row validation', revision: 1, createdAt: now, updatedAt: now});
  const records = createMioRecords(store), conversationId=randomUUID(), runId=randomUUID(), stepId=randomUUID(), requestId=randomUUID();
  store.tx(()=>{
    const shared=records.putBlob('{}',now);
    records.createConversation({id:conversationId,createdAt:now,updatedAt:now});
    records.createRun({id:runId,conversationId,requestId:randomUUID(),digest:createHash('sha256').update('fixture').digest('hex'),stepLimit:30,budget:30,locale:'en',configurationBlobHash:shared,settingsRevision:1,rulesSnapshotHash:null,createdAt:now,updatedAt:now});
    records.createStep({id:stepId,runId,kind:'model',createdAt:now});
    records.beginRequest({id:requestId,stepId,assemblerVersion:1,protocol:'responses',body:'{"model":"synthetic","input":[]}',assembledAt:now,inputManifest:{version:1,entryIds:[],noteEntryIds:[],configurationBlobHash:shared,toolsBlobHash:shared,systemBlobHash:shared,baselineBlobHash:shared,rulesBlobHash:null,parameters:{},viewVersion:1}});
    records.setConversationPolicy({requestId:randomUUID(),conversationId,expectedRevision:0,modes:null,global:structuredClone(DEFAULT_AGENT_TASK_POLICY),at:now});
  });
  return {store, library, records, run:records.run(runId), step:records.step(stepId), requestId};
}
const changes = (db: {prepare(sql: string): {get(): unknown}}): unknown => db.prepare('SELECT total_changes() AS n').get();

test('native rule-write rows are validated without writes and cannot hide malformed file evidence',t=>{
 const f=fixture(t),repository=createMioRuleWriteRepository(f.store),requestId=randomUUID(),at=new Date().toISOString(),blob=f.run.configurationBlobHash!;
 f.store.tx(()=>repository.prepare({requestId,projectId:f.store.projectId,actor:'manual',runId:null,stepId:null,approvalReceiptId:null,digest:'a'.repeat(64),expectedExists:false,beforeHash:null,afterHash:blob,beforeBlobHash:null,afterBlobHash:blob,fixedRelativeName:'AGENTS.md',fileIdentity:null,state:'prepared',createdAt:at,updatedAt:at}));
 const before=[changes(f.store.db),changes(f.library.db)];validateAgentTaskRowsV2(f.store.db,options);assert.deepEqual([changes(f.store.db),changes(f.library.db)],before);
 f.store.db.exec('PRAGMA ignore_check_constraints=ON');f.store.db.prepare('UPDATE mio_rule_writes SET fileIdentity=? WHERE requestId=?').run('{"unsupported":"file evidence"}',requestId);f.store.db.exec('PRAGMA ignore_check_constraints=OFF');
 const damagedBefore=[changes(f.store.db),changes(f.library.db)];assert.throws(()=>validateAgentTaskRowsV2(f.store.db,options),invalid);assert.deepEqual([changes(f.store.db),changes(f.library.db)],damagedBefore);
 f.store.db.prepare('UPDATE mio_rule_writes SET fileIdentity=NULL WHERE requestId=?').run(requestId);validateAgentTaskRowsV2(f.store.db,options);
 assert.throws(()=>f.store.db.prepare("UPDATE mio_rule_writes SET state='published' WHERE requestId=?").run(requestId),/CHECK/u);
});

test('the TEST validator reads the actual app policy and project rows without writing either connection', t => {
  const f = fixture(t);
  f.library.agentPolicy.write({...DEFAULT_AGENT_TASK_POLICY, revision: 1}, {requestId: randomUUID(), digest: 'a'.repeat(64)});
  const before = [changes(f.store.db), changes(f.library.db)];
  validateAgentTaskRowsV2(f.store.db, options);
  const localBytes = readMioStorage(f.store.db).usage.bytes;
  validateAgentTaskRowsV2(f.store.db, {...options, maxBytes: localBytes});
  assert.deepEqual([changes(f.store.db), changes(f.library.db)], before);
  assert.equal(f.store.db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='agent_task_policy_v2'").get(), undefined);
  assert.equal(f.store.db.prepare('PRAGMA database_list').all().some(row => row.file === f.library.databaseFile), false);
  assert.throws(() => validateAgentTaskRowsV2(f.store.db, {...options, maxBytes: 1}), invalid);
  const saved = f.library.db.prepare('SELECT data FROM agent_task_policy_v2 WHERE id=1').get()!.data;
  f.library.db.prepare('UPDATE agent_task_policy_v2 SET data=? WHERE id=1').run('{}');
  const badBefore = [changes(f.store.db), changes(f.library.db)];
  assert.throws(() => validateAgentTaskRowsV2(f.store.db, options), invalid);
  assert.deepEqual([changes(f.store.db), changes(f.library.db)], badBefore);
  f.library.db.prepare('UPDATE agent_task_policy_v2 SET data=? WHERE id=1').run(String(saved));
  validateAgentTaskRowsV2(f.store.db, options);
});

test('kernel validation retains row identity, cross-file foreign keys, target revisions and seen sequence checks', t => {
  const f = fixture(t), db = f.store.db;
  const saved=db.prepare('SELECT status FROM mio_runs WHERE id=?').get(f.run.id)!.status;
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare("UPDATE mio_runs SET status='invalid' WHERE id=?").run(f.run.id);
  assert.throws(()=>validateAgentTaskRowsV2(db,options),invalid);
  db.prepare('UPDATE mio_runs SET status=? WHERE id=?').run(String(saved),f.run.id);
  db.exec('PRAGMA ignore_check_constraints=OFF');
  const importId=randomUUID(),at=new Date().toISOString();
  f.store.tx(()=>f.records.addImport({id:importId,requestId:randomUUID(),name:'file',mimeType:'image/png',relativePath:'imports/file.png',sha256:'a'.repeat(64),status:'selected',assetId:null,resourceId:null,createdAt:at}));
  withoutForeignKeys(db,()=>db.prepare('UPDATE mio_imports SET assetId=? WHERE id=?').run(randomUUID(),importId));
  const beforeForeign=[changes(db),changes(f.library.db)];
  assert.throws(()=>validateAgentTaskRowsV2(db,options),invalid);
  assert.deepEqual([changes(db),changes(f.library.db)],beforeForeign);
  withoutForeignKeys(db,()=>db.prepare('UPDATE mio_imports SET assetId=NULL WHERE id=?').run(importId));
  db.exec('PRAGMA ignore_check_constraints=ON');
  try {
    db.exec('UPDATE agent_task_target_revisions_v2 SET revision=0');
    assert.throws(() => validateAgentTaskRowsV2(db, options), {code: 'RESTORE_SCHEMA_UNSUPPORTED', message: 'Invalid Agent target revision'});
    db.exec('UPDATE agent_task_target_revisions_v2 SET revision=1');
  } finally {db.exec('PRAGMA ignore_check_constraints=OFF');}
  db.exec('UPDATE main.history_state SET seenContentSequence=seenContentSequence+1');
  assert.throws(() => validateAgentTaskRowsV2(db, options), invalid);
  db.exec('UPDATE main.history_state SET seenContentSequence=(SELECT contentSequence FROM project.project_file)');
  validateAgentTaskRowsV2(db, options);
});

test('production validation needs its registered project and held application owner, and unbinding is reference counted', t => {
  const root = scratch(t), library = openAppLibrary({dataDir: path.join(root, 'app')}), wrong = openAppLibrary({dataDir: path.join(root, 'other-app')});
  const store = createProjectStore({projectFile: path.join(root, 'project.mioon'), locate: () => ({localDir: path.join(root, 'records'), cacheDir: path.join(root, 'cache'), tempDir: path.join(root, 'tmp')})});
  t.after(() => {store.close(); library.close(); wrong.close();});
  const identity = projectFileIdentity(store.projectFile); assert.ok(identity);
  const now = new Date().toISOString();
  store.put('projects', {id: store.projectId, name: 'Registered', revision: 1, createdAt: now, updatedAt: now});
  library.registry.upsert({projectId: store.projectId, projectFile: store.projectFile, fileIdentity: identity, name: 'Registered', lastOpenedAt: now, summary: null});
  assert.throws(() => validateAgentTaskRowsV2(store.db, options), {name: 'TypeError', message: 'Project Agent task row validation requires a live application context'});
  assert.throws(() => bindAgentTaskRowValidation({...store}, library), {name: 'TypeError', message: 'Agent task row validation requires the exact live project store'});
  assert.throws(() => bindAgentTaskRowValidation(store, wrong), {name: 'TypeError', message: 'Agent task row validation application does not own this project'});
  const one = bindAgentTaskRowValidation(store, library), two = bindAgentTaskRowValidation(store, library);
  one(); validateAgentTaskRowsV2(store.db, options);
  two();
  assert.throws(() => validateAgentTaskRowsV2(store.db, options), {name: 'TypeError', message: 'Project Agent task row validation requires a live application context'});
  const unbind = bindAgentTaskRowValidation(store, library);
  library.close();
  assert.throws(() => validateAgentTaskRowsV2(store.db, options), {name: 'TypeError', message: 'Agent task row validation requires a live application library'});
  unbind();
});

test('TEST context cannot bind another app library or survive closing its exact project owner', t => {
  const f = fixture(t), wrong = openAppLibrary({dataDir: path.join(scratch(t), 'app')});
  t.after(() => wrong.close());
  assert.throws(() => bindAgentTaskRowValidation(f.store, wrong), {name: 'TypeError', message: 'Agent task row validation application does not own this TEST project'});
  f.store.close();
  assert.throws(() => bindAgentTaskRowValidation(f.store, wrong), {name: 'TypeError', message: 'Agent task row validation requires the exact live project store'});
});

test('native validation accepts retained failed/unknown originals and completed cleaned requests',t=>{
  for(const outcome of ['failed','unknown','completed'] as const){
    const f=fixture(t),at=new Date().toISOString();
    f.store.tx(()=>{
      f.records.markDispatched(f.requestId,at);
      f.records.updateStep(f.step.id,'dispatch_started',{status:'dispatch_started',partialText:'durable partial',updatedAt:at});
      if(outcome==='completed')f.records.completeModelRequest(f.requestId,{entryId:randomUUID(),output:{protocol:'responses',providerOutput:[]},at});
      else f.records.failRequest(f.requestId,outcome,at);
    });
    const before=[changes(f.store.db),changes(f.library.db)];
    f.store.db.exec('PRAGMA query_only=ON');f.library.db.exec('PRAGMA query_only=ON');
    try{validateAgentTaskRowsV2(f.store.db,options);assert.deepEqual([changes(f.store.db),changes(f.library.db)],before);}
    finally{f.store.db.exec('PRAGMA query_only=OFF');f.library.db.exec('PRAGMA query_only=OFF');}
    assert.equal(f.records.request(f.requestId).originalBody===null,outcome==='completed');
    if(outcome==='completed'){
      f.store.db.exec('SAVEPOINT lost_completion_entry');
      f.store.db.prepare('UPDATE mio_steps SET resultEntryId=NULL WHERE id=?').run(f.step.id);
      assert.throws(()=>validateAgentTaskRowsV2(f.store.db,options),invalid);
      f.store.db.exec('ROLLBACK TO lost_completion_entry; RELEASE lost_completion_entry');
      validateAgentTaskRowsV2(f.store.db,options);
    }
  }
});

test('native body hashes, manifest references and counters are checked without repairing evidence',t=>{
  const f=fixture(t),db=f.store.db;
  for(const mutation of ['hash','manifest','counter'] as const){
    db.exec('SAVEPOINT corrupt_native_record');
    if(mutation==='counter')db.exec('UPDATE mio_storage_counters SET bytes=bytes+1');
    else{
      db.exec('DROP TRIGGER identity_mio_requests');
      if(mutation==='hash')db.prepare('UPDATE mio_requests SET bodySha256=? WHERE id=?').run('c'.repeat(64),f.requestId);
      else db.prepare("UPDATE mio_requests SET inputManifest=json_set(inputManifest,'$.toolsBlobHash',?) WHERE id=?").run('f'.repeat(64),f.requestId);
    }
    const before=[changes(db),changes(f.library.db)];
    assert.throws(()=>validateAgentTaskRowsV2(db,options),invalid);
    assert.deepEqual([changes(db),changes(f.library.db)],before);
    db.exec('ROLLBACK TO corrupt_native_record; RELEASE corrupt_native_record');
    validateAgentTaskRowsV2(db,options);
  }
});

test('the second B1 global table and history process tombstones retain validation',t=>{
  const f=fixture(t),db=f.store.db;
  f.library.db.exec('SAVEPOINT bad_global_receipt');
  f.library.db.prepare('INSERT INTO agent_task_policy_requests_v2 VALUES(?,?,?)').run(randomUUID(),'a'.repeat(64),'{}');
  assert.throws(()=>validateAgentTaskRowsV2(db,options),invalid);
  f.library.db.exec('ROLLBACK TO bad_global_receipt; RELEASE bad_global_receipt');
  db.exec('SAVEPOINT bad_local_revision; PRAGMA ignore_check_constraints=ON');
  db.prepare('INSERT INTO mio_process_target_revisions VALUES(?,?,?,0)').run(f.store.projectId,'job',randomUUID());
  assert.throws(()=>validateAgentTaskRowsV2(db,options),{code:'RESTORE_SCHEMA_UNSUPPORTED',message:'Invalid Agent target revision'});
  db.exec('ROLLBACK TO bad_local_revision; RELEASE bad_local_revision; PRAGMA ignore_check_constraints=OFF');
  validateAgentTaskRowsV2(db,options);
});

test('default native validation permits legal bookkeeping past execution row quota',t=>{
  const f=fixture(t),db=f.store.db;
  f.store.tx(()=>db.prepare("WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<65536) INSERT INTO mio_process_target_revisions SELECT ?,'job',CAST(n AS TEXT),1 FROM seq").run(f.store.projectId));
  assert.equal(readMioStorage(db).status,'full');
  const before=[changes(db),changes(f.library.db)];
  validateAgentTaskRowsV2(db,options);
  assert.deepEqual([changes(db),changes(f.library.db)],before);
  assert.throws(()=>validateAgentTaskRowsV2(db,{...options,maxBytes:1}),invalid);
});
