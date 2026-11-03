import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {createMioRecords} from '../packages/business/src/agent/mio-records.ts';
import {createMioRuleWriteRepository} from '../packages/business/src/agent/mio-rule-write-repository.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {mioRuleWriteSchema,mioRulesPublicationEvidenceSchema} from '../packages/contracts/src/mio-rule-writes.ts';
import type {MioRuleWrite,MioRulesPublicationEvidence} from '../packages/contracts/src/mio-rule-writes.ts';
import {MIO_QUOTA_BYTES_SQL,MIO_QUOTA_ROWS_SQL} from '../packages/business/src/project-file/schema/domains/mio.ts';

const at='2026-11-03T00:00:00.000Z',hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-rule-write-')),store=openStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 store.put('projects',{id:store.projectId,name:'Rules test'});const records=createMioRecords(store),repository=createMioRuleWriteRepository(store);
 let beforeBlobHash='',afterBlobHash='';store.tx(()=>{beforeBlobHash=records.putBlob('规范\r\n原文🙂',at);afterBlobHash=records.putBlob('规范\r\n改后🙂',at);});
 const record=():MioRuleWrite=>({requestId:randomUUID(),projectId:store.projectId,actor:'manual',runId:null,stepId:null,digest:hash('input'),approvalReceiptId:null,expectedExists:true,beforeHash:beforeBlobHash,afterHash:afterBlobHash,beforeBlobHash,afterBlobHash,fixedRelativeName:'AGENTS.md',fileIdentity:null,state:'prepared',createdAt:at,updatedAt:at});
 return{root,store,records,repository,record};
}
function evidence(record:MioRuleWrite):MioRulesPublicationEvidence{
 const token=randomUUID(),identity={dev:'1',ino:'2',size:'10',mtimeNs:'3',ctimeNs:'4'};
 return{version:1,fixedRelativeName:'AGENTS.md',phase:'before_candidate',directoryIdentity:identity,candidateName:`.mioon-rules-${token}.candidate`,backupName:`.mioon-rules-${token}.backup`,expectedExists:record.expectedExists,beforeHash:record.beforeHash,afterHash:record.afterHash,candidateIdentity:null,capturedIdentity:null,capturedHash:null,publishedIdentity:null};
}
test('manual intent is durable without a Mio run and checkpoints replay without rewriting completed receipts',t=>{
 const f=fixture(t),input=f.record();assert.throws(()=>f.repository.prepare(input),{code:'AGENT_TASK_TRANSACTION_REQUIRED'});
 assert.deepEqual(f.store.tx(()=>f.repository.prepare(input)),input);const captured=evidence(input);
 f.store.tx(()=>f.repository.transition(input.requestId,'prepared','publication_unknown',{fileIdentity:captured,updatedAt:at}));
 const later={...captured,phase:'candidate_created' as const,candidateIdentity:captured.directoryIdentity};
 f.store.tx(()=>f.repository.transition(input.requestId,'publication_unknown','publication_unknown',{fileIdentity:later,updatedAt:at}));
 assert.deepEqual(f.store.tx(()=>f.repository.prepare(input)).fileIdentity,later,'same input replay keeps later evidence');
 assert.equal(f.repository.listPending().length,1);
 assert.throws(()=>f.store.tx(()=>f.repository.transition(input.requestId,'publication_unknown','published',{updatedAt:at})));
 const published={...later,phase:'published' as const,publishedIdentity:later.candidateIdentity};
 for(const [before,after] of [['publication_unknown','published'],['published','trust_pending'],['trust_pending','completed']] as const)f.store.tx(()=>f.repository.transition(input.requestId,before,after,{fileIdentity:published,updatedAt:at}));
 const saved=f.repository.get(input.requestId);assert.equal(saved?.state,'completed');assert.deepEqual(f.repository.listPending(),[]);
 assert.throws(()=>f.store.tx(()=>f.repository.transition(input.requestId,'completed','completed',{updatedAt:at})),{code:'MIO_RULES_STATE_CONFLICT'});
 assert.throws(()=>f.store.tx(()=>f.store.db.prepare('DELETE FROM mio_rule_writes WHERE requestId=?').run(input.requestId)),/retained/u);
 assert.throws(()=>f.store.tx(()=>f.store.db.prepare('UPDATE mio_rule_writes SET updatedAt=updatedAt WHERE requestId=?').run(input.requestId)),/immutable/u);
 f.store.close();const reopened=openStore(f.root);try{assert.deepEqual(createMioRuleWriteRepository(reopened).get(input.requestId),saved);}finally{reopened.close();}
});
test('intents enforce real blob, project, run, tool-step and approval-receipt relationships',t=>{
 const f=fixture(t),conversationId=randomUUID(),runId=randomUUID(),stepId=randomUUID(),entryId=randomUUID(),approvalReceiptId=randomUUID();
 f.store.tx(()=>{
  f.records.createConversation({id:conversationId,createdAt:at,updatedAt:at});f.records.createRun({id:runId,conversationId,requestId:randomUUID(),digest:hash('run'),stepLimit:30,budget:30,locale:'en',configurationBlobHash:null,settingsRevision:null,rulesSnapshotHash:null,createdAt:at,updatedAt:at});
  const shared=f.records.putBlob('{}',at),modelId=randomUUID(),modelRequest=randomUUID();
  f.records.createStep({id:modelId,runId,kind:'model',createdAt:at});
  f.records.beginRequest({id:modelRequest,stepId:modelId,assemblerVersion:1,protocol:'responses',body:'{"input":[]}',assembledAt:at,inputManifest:{version:1,entryIds:[],noteEntryIds:[],configurationBlobHash:shared,toolsBlobHash:shared,systemBlobHash:shared,baselineBlobHash:shared,rulesBlobHash:null,parameters:{},viewVersion:1}});
  f.records.markDispatched(modelRequest,at);
  f.records.completeModelRequest(modelRequest,{entryId,at,output:{protocol:'responses',providerOutput:[{type:'function_call',call_id:'call-rules',name:'mioon_project_rules_set',arguments:'{}'}]}});
  f.records.createStep({id:stepId,runId,kind:'tool',sourceEntryId:entryId,sourceCallIndex:0,createdAt:at});f.records.saveControl({requestId:approvalReceiptId,runId,digest:hash('approval'),data:{stepId,decision:'approve'}},at);
 });
 const good={...f.record(),actor:'mio' as const,runId,stepId,approvalReceiptId};
 for(const patch of [{afterHash:'b'.repeat(64),afterBlobHash:'b'.repeat(64)},{projectId:randomUUID()},{stepId:randomUUID()},{approvalReceiptId:randomUUID()},{runId:randomUUID()}])assert.throws(()=>f.store.tx(()=>f.repository.prepare({...good,...patch,requestId:randomUUID()})));
 assert.deepEqual(f.store.tx(()=>f.repository.prepare(good)),good);
 assert.throws(()=>f.store.tx(()=>f.repository.prepare({...good,digest:hash('changed')})),{code:'MIO_RULES_REQUEST_CONFLICT'});
 assert.throws(()=>f.store.tx(()=>f.store.db.prepare("UPDATE mio_rule_writes SET actor='manual',runId=NULL,stepId=NULL,approvalReceiptId=NULL WHERE requestId=?").run(good.requestId)),/immutable/u);
});
test('same-state evidence checkpoints reject artifact rebinding and rollback counters atomically',t=>{
 const f=fixture(t),input=f.record(),initial=evidence(input);f.store.tx(()=>f.repository.prepare({...input,fileIdentity:initial}));
 const before=readMioStorage(f.store.db);
 assert.throws(()=>f.store.tx(()=>f.repository.transition(input.requestId,'prepared','prepared',{fileIdentity:evidence(input),updatedAt:at})),{code:'MIO_RULES_REQUEST_CONFLICT'});
 assert.throws(()=>f.store.tx(()=>{f.repository.transition(input.requestId,'prepared','publication_unknown',{fileIdentity:{...initial,phase:'before_capture'},updatedAt:at});throw Error('rollback');}),/rollback/u);
 assert.deepEqual(readMioStorage(f.store.db),before);assert.deepEqual(f.repository.get(input.requestId)?.fileIdentity,initial);
 const current=f.store.db.prepare('SELECT bytes,rows FROM mio_storage_counters').get();assert.deepEqual(current,f.store.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes,${MIO_QUOTA_ROWS_SQL} AS rows`).get());
});
test('manual reconciliation remains writable after execution quota fills and still contributes to counters',t=>{
 const f=fixture(t),input=f.record();f.store.tx(()=>f.repository.prepare(input));
 // Real retained data fills the row limit; no counter tampering can hide a
 // broken delta. Manual intent/evidence remains retained at and above it.
 f.store.tx(()=>{const missing=65536-Number(f.store.db.prepare('SELECT rows FROM mio_storage_counters').get()?.rows);f.store.db.prepare("WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO mio_edit_claims(id,projectId,ownerId,kind,targetId,revision,state,createdAt,updatedAt) SELECT printf('claim-%d',x),?,'quota','shot',printf('target-%d',x),1,'active',?,? FROM n").run(missing,f.store.projectId,at,at);});
 const before=readMioStorage(f.store.db);assert.equal(before.usage.rows,65536);
 f.store.tx(()=>f.repository.transition(input.requestId,'prepared','not_applied',{updatedAt:at}));
 f.store.tx(()=>f.repository.prepare({...f.record(),requestId:randomUUID()}));const after=readMioStorage(f.store.db);assert.equal(after.usage.rows,65537);assert.ok(after.usage.bytes>before.usage.bytes);
 assert.throws(()=>f.store.tx(()=>f.records.putBlob('new content forbidden at quota',at)),/AGENT_TASK_STORAGE_LIMIT/u);
});
test('rule-write contracts reject extra fields, partial Mio identities, unsafe paths and mismatched before/after blobs',()=>{
 const base={requestId:randomUUID(),projectId:randomUUID(),actor:'manual',runId:null,stepId:null,digest:hash('input'),approvalReceiptId:null,expectedExists:false,beforeHash:null,afterHash:hash('after'),beforeBlobHash:null,afterBlobHash:hash('after'),fixedRelativeName:'AGENTS.md',fileIdentity:null,state:'prepared',createdAt:at,updatedAt:at};
 assert.equal(mioRuleWriteSchema.safeParse(base).success,true);
 for(const patch of [{approved:true},{actor:'mio'},{expectedExists:true},{afterBlobHash:hash('wrong')},{fixedRelativeName:'../AGENTS.md'}])assert.equal(mioRuleWriteSchema.safeParse({...base,...patch}).success,false);
 const safe=evidence(mioRuleWriteSchema.parse(base));assert.equal(mioRulesPublicationEvidenceSchema.safeParse(safe).success,true);assert.equal(mioRulesPublicationEvidenceSchema.safeParse({...safe,candidateName:'../candidate'}).success,false);
});
