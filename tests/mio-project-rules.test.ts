import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../packages/business/src/project-file/index.ts';
import {testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {createMioProjectRules} from '../packages/business/src/agent/mio-rules.ts';
import type {MioRulesApproval,MioProjectRules} from '../packages/business/src/agent/mio-rules.ts';
import {createMioRuleWriteRepository} from '../packages/business/src/agent/mio-rule-write-repository.ts';
import {createMioProjectJournal} from '../packages/business/src/agent/mio-journal-factory.ts';
import {DEFAULT_AGENT_TASK_POLICY} from '../packages/contracts/src/agent-tasks-v2.ts';
import {beginFixtureToolStep,mioFixtureConfiguration} from './helpers/mio-model-fixture.ts';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-project-rules-'));let store=openStore(root);const services:MioProjectRules[]=[];
 store.put('projects',{id:store.projectId,name:'Rules integration'});
 function app(){const library=testProjectAppLibrary(store);assert.ok(library);return library;}
 function service(options:Partial<Parameters<typeof createMioProjectRules>[0]>={}){const rules=createMioProjectRules({store,application:app(),...options});services.push(rules);return rules;}
 t.after(()=>{for(const rules of services)rules.close();store.close();rmSync(root,{recursive:true,force:true});});
 return{root,file:join(root,'AGENTS.md'),get store(){return store;},get app(){return app();},service,reopen(){for(const rules of services)rules.close();store.close();store=openStore(root);}};
}
const changes=(f:ReturnType<typeof fixture>)=>[f.store.db.prepare('SELECT total_changes() AS n').get()?.n,f.app.db.prepare('SELECT total_changes() AS n').get()?.n];
const row=(f:ReturnType<typeof fixture>,requestId:string)=>createMioRuleWriteRepository(f.store).get(requestId);
function approved(f:ReturnType<typeof fixture>,rules:MioProjectRules,text='Mio approved rules'){
 const journal=createMioProjectJournal(f.store,f.app.agentPolicy),proposal=rules.proposal({expectedHash:null,proposedText:text});
 const run=journal.create({requestId:randomUUID(),projectId:f.store.projectId,text:'请修改项目规范',configuration:mioFixtureConfiguration,policy:structuredClone(DEFAULT_AGENT_TASK_POLICY)}).run;
 const step=beginFixtureToolStep(journal,run.id,{toolCall:{id:'rules-call',name:'mioon_project_rules_set',arguments:{expectedHash:null,proposedText:text}},targets:[],tier:'local_reversible',data:{rulesProposal:{...proposal}}});
 const proposalDigest=hash(JSON.stringify({call:step.toolCall,targets:step.targets,tier:step.tier,rulesProposal:proposal})),approvalReceiptId=randomUUID();
 journal.updateStep(run.id,step.id,{status:'awaiting_approval'});
 journal.control({requestId:approvalReceiptId,runId:run.id,expectedRevision:journal.run(run.id).revision,action:'approve',stepId:step.id},{state:'completed',approvedRules:{stepId:step.id,proposalDigest}});
 const data=step.data!==null&&typeof step.data==='object'&&!Array.isArray(step.data)?step.data:{};
 journal.updateStep(run.id,step.id,{status:'intent',data:{...data,approvalDigest:proposalDigest,rulesApprovalReceiptId:approvalReceiptId}});journal.markDispatch(run.id,step.id);
 const approval:MioRulesApproval={runId:run.id,stepId:step.id,approvalReceiptId,proposalDigest,recordInside:result=>journal.completeStepInside(run.id,step.id,{result,changes:[]})};
 return{journal,approval,text,input:{requestId:randomUUID(),expectedHash:null,text}};
}

test('manual save creates a trusted empty file, retains before bytes and replays without any write',t=>{
 const f=fixture(t),rules=f.service(),requestId=randomUUID();assert.equal(rules.read().trust,'absent');assert.equal(rules.capture().message,null);
 const result=rules.save({requestId,expectedHash:null,text:''});assert.equal(readFileSync(f.file,'utf8'),'');assert.equal(result.trust,'trusted');assert.equal(f.app.rulesTrust.get(f.store.projectId)?.sha256,hash(''));assert.equal(rules.capture().project?.text,'');assert.ok(rules.capture().message?.content.endsWith(`Project rules (AGENTS.md, SHA-256 ${hash('')}):\n`));
 const before=changes(f);assert.deepEqual(rules.save({requestId,expectedHash:null,text:''}),result);assert.equal(rules.lookup(requestId).status,'applied');assert.deepEqual(changes(f),before);
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'other'}),{code:'MIO_RULES_REQUEST_CONFLICT'});
 const second=rules.save({requestId:randomUUID(),expectedHash:hash(''),text:'项目规范\r\n🙂'});assert.equal(second.hash,hash('项目规范\r\n🙂'));
 assert.ok(readdirSync(f.root).every(name=>!name.startsWith('.mioon-rules-')));
 const saved=row(f,requestId);assert.equal(saved?.state,'completed');f.reopen();const restored=f.service();assert.equal(restored.read().trust,'trusted');assert.equal(restored.lookup(requestId).status,'applied');
});
test('external files require exact enable hash and any later external edit disables only future captures',t=>{
 const f=fixture(t),rules=f.service();writeFileSync(f.file,'project\r\n');assert.equal(rules.read().trust,'untrusted');assert.equal(rules.capture().project,null);
 assert.throws(()=>rules.enable({requestId:randomUUID(),expectedHash:hash('wrong')}),{code:'MIO_RULES_CONFLICT'});assert.equal(f.app.rulesTrust.get(f.store.projectId),null);
 rules.enable({requestId:randomUUID(),expectedHash:hash('project\r\n')});f.app.userRules.cas(0,'generic',new Date().toISOString());const frozen=rules.capture();assert.equal(frozen.project?.text,'project\r\n');assert.equal(frozen.user?.text,'generic');assert.match(frozen.message?.content??'',/host instructions > this round’s explicit user request > project rules > generic user rules/u);assert.ok(frozen.message?.content.includes(`Project rules (AGENTS.md, SHA-256 ${hash('project\r\n')}):`));
 writeFileSync(f.file,'external changed');assert.equal(rules.read().trust,'untrusted');assert.equal(rules.capture().project,null);assert.equal(frozen.project?.text,'project\r\n');
});
test('prepared restart is suspended; lookup and repeated save do not retry publication',t=>{
 const f=fixture(t),requestId=randomUUID(),rules=f.service({onPhase:phase=>{if(phase==='prepared')throw Error('stop after durable intent');}});
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'after'}),/stop after durable intent/u);assert.equal(existsSync(f.file),false);assert.equal(row(f,requestId)?.state,'prepared');
 f.reopen();const reopened=f.service(),before=changes(f),files=readdirSync(f.root);assert.equal(reopened.lookup(requestId).status,'uncertain');assert.equal(reopened.capture().project,null);assert.throws(()=>reopened.save({requestId,expectedHash:null,text:'after'}),{code:'MIO_RULES_WRITE_UNCERTAIN'});assert.deepEqual(changes(f),before);assert.deepEqual(readdirSync(f.root),files);
 writeFileSync(f.file,'outside change');assert.equal(reopened.reconcile(requestId).status,'not_applied');assert.equal(readFileSync(f.file,'utf8'),'outside change');assert.equal(f.app.rulesTrust.get(f.store.projectId),null);
});
for(const phase of ['published','before_trust','trusted','completed'] as const)test(`manual ${phase} fault reconciles only the original durable operation`,t=>{
 const f=fixture(t),requestId=randomUUID(),rules=f.service({onPhase:current=>{if(current===phase)throw Error('injected phase fault');}});
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'after\r\n'}),/injected phase fault/u);assert.equal(readFileSync(f.file,'utf8'),'after\r\n');f.reopen();
 const reopened=f.service(),before=changes(f);assert.equal(reopened.lookup(requestId).status,phase==='completed'?'applied':'uncertain');assert.deepEqual(changes(f),before);assert.equal(reopened.reconcile(requestId).status,'applied');assert.equal(reopened.read().trust,'trusted');assert.equal(row(f,requestId)?.state,'completed');
});
test('a link without its durable identity checkpoint remains unknown despite identical target bytes',t=>{
 const f=fixture(t),rules=f.service({publication:{afterEffect:effect=>{if(effect==='target_linked')throw Error('kill window');}}}),requestId=randomUUID();
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'after'}),{code:'MIO_RULES_WRITE_UNCERTAIN'});assert.equal(readFileSync(f.file,'utf8'),'after');assert.equal(row(f,requestId)?.fileIdentity?.publishedIdentity,null);
 f.reopen();const reopened=f.service(),before=changes(f);assert.equal(reopened.reconcile(requestId).status,'uncertain');assert.deepEqual(changes(f),before);assert.equal(f.app.rulesTrust.get(f.store.projectId),null);
});
test('same inode and same bytes after an external rewrite cannot acquire publication ownership',t=>{
 const f=fixture(t),requestId=randomUUID(),rules=f.service({onPhase:phase=>{if(phase==='published')throw Error('pending published');}});
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'after'}),/pending published/u);
 writeFileSync(f.file,'after');utimesSync(f.file,new Date('2020-01-01T00:00:00.000Z'),new Date('2020-01-01T00:00:00.000Z'));
 const reopened=f.service(),before=changes(f);assert.equal(reopened.reconcile(requestId).status,'uncertain');assert.deepEqual(changes(f),before);assert.equal(f.app.rulesTrust.get(f.store.projectId),null);
});
test('B1 trust failure keeps new rounds disabled and retries only explicit reconciliation',t=>{
 const f=fixture(t),base=f.app;let failing=true;
 const application={...base,rulesTrust:{...base.rulesTrust,set(value:Parameters<typeof base.rulesTrust.set>[0]){if(failing)throw Error('trust unavailable');base.rulesTrust.set(value);}}};
 const rules=f.service({application}),requestId=randomUUID();assert.throws(()=>rules.save({requestId,expectedHash:null,text:'after'}),/trust unavailable/u);assert.equal(row(f,requestId)?.state,'trust_pending');assert.equal(base.receipts.read('project.rules.save',requestId),null);assert.equal(rules.capture().project,null);
 failing=false;assert.equal(rules.reconcile(requestId).status,'applied');assert.equal(rules.capture().project?.text,'after');
});
test('reconciliation verifies B1 trust as well as its receipt before completing history',t=>{
 const f=fixture(t),requestId=randomUUID(),rules=f.service({onPhase:phase=>{if(phase==='trusted')throw Error('B1 committed');}});
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'after'}),/B1 committed/u);f.app.rulesTrust.remove(f.store.projectId);
 assert.throws(()=>f.service().reconcile(requestId),{code:'MIO_RULES_WRITE_UNCERTAIN'});assert.equal(row(f,requestId)?.state,'trust_pending');assert.equal(f.service().capture().project,null);
});
test('lookup binds the immutable B1 receipt digest to its history intent',t=>{
 const f=fixture(t),requestId=randomUUID();f.service().save({requestId,expectedHash:null,text:'after'});const app=f.app;
 const rules=f.service({application:{...app,receipts:{...app.receipts,read(operation,id){const saved=app.receipts.read(operation,id);return saved?{...saved,digest:'b'.repeat(64)}:null;}}}});
 assert.throws(()=>rules.lookup(requestId),{code:'MIO_RULES_REQUEST_CONFLICT'});
});
test('Mio save needs the canonical tool call, a real approval receipt and the recomputed proposal digest',t=>{
 const f=fixture(t),rules=f.service(),a=approved(f,rules),before=changes(f);
 assert.throws(()=>rules.save(a.input,{...a.approval,proposalDigest:'b'.repeat(64)}),{code:'MIO_RULES_CONFLICT'});assert.equal(existsSync(f.file),false);assert.deepEqual(changes(f),before);
 const result=rules.save(a.input,a.approval);assert.equal(result.trust,'trusted');assert.equal(a.journal.step(a.approval.stepId).status,'completed');assert.equal(row(f,a.input.requestId)?.actor,'mio');
});
test('Mio published recovery revalidates approval and completes the same tool step exactly once',t=>{
 const f=fixture(t),rules=f.service({onPhase:phase=>{if(phase==='published')throw Error('Mio published');}}),a=approved(f,rules);
 assert.throws(()=>rules.save(a.input,a.approval),/Mio published/u);f.reopen();const reopened=f.service();assert.equal(reopened.lookup(a.input.requestId).status,'uncertain');assert.equal(reopened.reconcile(a.input.requestId).status,'applied');
 const journal=createMioProjectJournal(f.store,f.app.agentPolicy);assert.equal(journal.step(a.approval.stepId).status,'completed');const before=changes(f);assert.equal(reopened.lookup(a.input.requestId).status,'applied');assert.deepEqual(changes(f),before);
});
for(const phase of ['prepared','published','before_trust','trusted','completed'] as const)test(`host close at ${phase} prevents any late effect and restart stays suspended`,t=>{
 const f=fixture(t),requestId=randomUUID();let rules:MioProjectRules;rules=f.service({onPhase:current=>{if(current===phase)rules.close();}});
 assert.throws(()=>rules.save({requestId,expectedHash:null,text:'after'}),{code:'MIO_RULES_UNAVAILABLE'});const before=changes(f);assert.throws(()=>rules.read(),{code:'MIO_RULES_UNAVAILABLE'});assert.deepEqual(changes(f),before);f.reopen();const reopened=f.service(),reopenedBefore=changes(f);reopened.lookup(requestId);assert.deepEqual(changes(f),reopenedBefore);
});
for(const phase of ['prepared','published','before_trust','trusted','completed'] as const)test(`SIGKILL upper-layer ${phase} preserves coherent B1/history/file evidence`,t=>{
 const f=fixture(t),requestId=randomUUID(),worker=fileURLToPath(new URL('./fixtures/mio-project-rules-crash.ts',import.meta.url));f.store.close();
 const child=spawnSync(process.execPath,[worker,f.root,requestId,phase],{stdio:'ignore',timeout:30000});assert.equal(child.signal,'SIGKILL');f.reopen();const rules=f.service(),before=changes(f),lookup=rules.lookup(requestId);assert.equal(lookup.status,phase==='completed'?'applied':'uncertain');assert.deepEqual(changes(f),before);
 const recovered=rules.reconcile(requestId);assert.equal(recovered.status,phase==='prepared'?'not_applied':'applied');assert.equal(row(f,requestId)?.state,phase==='prepared'?'not_applied':'completed');
});
for(const phase of ['prepared','published','before_trust','trusted','completed'] as const)test(`SIGKILL Mio ${phase} recovers the same approved tool and never republishes`,t=>{
 const f=fixture(t),a=approved(f,f.service()),worker=fileURLToPath(new URL('./fixtures/mio-project-rules-crash.ts',import.meta.url));f.store.close();
 const child=spawnSync(process.execPath,[worker,f.root,a.input.requestId,phase,JSON.stringify(a.approval)],{stdio:'ignore',timeout:30000});assert.equal(child.signal,'SIGKILL');f.reopen();const rules=f.service(),before=changes(f);assert.equal(rules.lookup(a.input.requestId).status,phase==='completed'?'applied':'uncertain');assert.deepEqual(changes(f),before);
 assert.equal(rules.reconcile(a.input.requestId).status,phase==='prepared'?'not_applied':'applied');
 const journal=createMioProjectJournal(f.store,f.app.agentPolicy);assert.equal(journal.step(a.approval.stepId).status,'completed');
 if(phase==='prepared'){
  assert.equal(existsSync(f.file),false);assert.match(JSON.stringify(journal.step(a.approval.stepId).result),/RULES_NOT_APPLIED/u);
  assert.throws(()=>rules.save(a.input),{code:'MIO_RULES_REQUEST_CONFLICT'});
 }else assert.equal(readFileSync(f.file,'utf8'),a.text);
});
