import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore,createServices} from '@mioon/business';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {inspectWorkspaceBackup,BACKUP_INSPECTION_LIMITS} from '../packages/business/src/backup-readiness.ts';
import type {TestContext} from 'node:test';
type Loose = Record<string, unknown>;
interface InspectionView {captureReady: boolean; inspectionComplete: boolean; databaseSchemaVersion: number; counts: Loose; unresolved: Loose; issues: string[]}
const inspectionView=(value: unknown): InspectionView => value as InspectionView;
function fixture(t: TestContext){const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-backup-readiness-')),store=openStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return store;}
const changes=(store: ReturnType<typeof openStore>)=>store.db.prepare('SELECT total_changes() n').get()!.n as number;
test('shared inspection reads empty workspace without constructing data, filesystem work or model authority',async t=>{
 const store=fixture(t),forbidden=new Proxy({},{get(){throw Error('provider access forbidden');}}),services=createServices(store,new Map([['mock',forbidden]]) as never);
 t.after(()=>services.drain());t.mock.method(globalThis,'fetch',()=>{throw Error('network forbidden');});
 const before=changes(store),result=inspectionView(await services.call('workspace.backup.inspect',{}));
 assert.equal(result.captureReady,false);assert.equal(result.inspectionComplete,true);assert.equal(result.databaseSchemaVersion,54);assert.equal(Object.values(result.counts).every(x=>x===0),true);assert.equal(Object.values(result.unresolved).every(x=>x===0),true);assert.equal(changes(store),before);
 assert.throws(()=>services.inspection.dispatch({},'workspace.backup.inspect',{}));
 for(const input of [{source:'/tmp/private'},{projectId:randomUUID()}])await assert.rejects(services.call('workspace.backup.inspect',input));
});
test('summary preserves unknown tasks and excludes all stored text, identities, paths and provider IDs',t=>{
 const store=fixture(t),projectId=randomUUID();store.put('projects',{id:projectId,name:'PRIVATE_PROJECT'});
 for(const status of ['queued','submission_unknown','succeeded'])store.put('jobs',{id:randomUUID(),projectId,status,prompt:'PRIVATE_PROMPT',providerJobId:'SECRET_REMOTE_ID',path:'/secret'});
 const before=changes(store),result=inspectionView(inspectWorkspaceBackup(store));
 assert.equal(result.counts['projects'],1);assert.equal(result.counts['videoTasks'],3);assert.equal(result.unresolved['videoTasks'],2);assert.equal(result.inspectionComplete,true);assert.equal(changes(store),before);
 for(const marker of ['PRIVATE_PROJECT','PRIVATE_PROMPT','SECRET_REMOTE_ID','/secret',projectId])assert.equal(JSON.stringify(result).includes(marker),false);
 assert.equal((store.list('jobs').find((x: unknown)=>(x as Loose)['status']==='submission_unknown') as Loose)['status'],'submission_unknown');
});
test('malformed or oversized JSON is unknown, never clean zero or parsed user content',t=>{
 const store=fixture(t),projectId=randomUUID();store.put('projects',{id:projectId,name:'A'});const id=randomUUID();store.put('jobs',{id,projectId,status:'running'});
 for(const data of ['{broken','{"status":null}','{"status":false}','{"status":"unrecognized"}']){store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(data,id);const result=inspectWorkspaceBackup(store);assert.equal(result.unresolved['videoTasks'],null);assert.equal(result.inspectionComplete,false);assert.ok(result.issues.includes('INVALID_ROW'));}
 store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({status:'running',text:'x'.repeat(BACKUP_INSPECTION_LIMITS.jsonRowBytes)}),id);const result=inspectWorkspaceBackup(store);assert.equal(result.unresolved['videoTasks'],null);assert.ok(result.issues.includes('JSON_LIMIT'));
});
test('row cap applies before materialization, keeps unknown count and leaves caller transaction intact',t=>{
 const store=fixture(t);store.db.exec('BEGIN');const insert=store.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)');for(let i=0;i<=BACKUP_INSPECTION_LIMITS.rowsPerTable;i++)insert.run(randomUUID(),'{}');
 const before=changes(store),result=inspectionView(inspectWorkspaceBackup(store));assert.equal(result.counts['projects'],null);assert.equal(result.inspectionComplete,false);assert.ok(result.issues.includes('ROW_LIMIT'));assert.equal(store.db.isTransaction,true);assert.equal(changes(store),before);store.db.exec('ROLLBACK');assert.equal(inspectWorkspaceBackup(store).counts.projects,0);
});

test('current v2 tasks and unknown terminal steps contribute to the existing unresolved Agent count',t=>{
 const store=fixture(t),projectId=randomUUID();store.put('projects',{id:projectId,name:'v2 task'});const journal=createAgentTaskJournal(store),run=journal.create({requestId:randomUUID(),projectId,text:'PRIVATE_TASK_TEXT',configuration:{}}).run;
 assert.equal(inspectionView(inspectWorkspaceBackup(store)).unresolved['agentRuns'],1);
 const step=journal.beginStep(run.id,{kind:'model'});journal.markDispatch(run.id,step.id);journal.transition(run.id,journal.run(run.id).revision,'stopped');
 const result=inspectionView(inspectWorkspaceBackup(store));assert.equal(result.unresolved['agentRuns'],1);assert.equal(JSON.stringify(result).includes('PRIVATE_TASK_TEXT'),false);
 journal.updateStep(run.id,step.id,{status:'unknown'});journal.updateStep(run.id,step.id,{status:'failed'});assert.equal(inspectionView(inspectWorkspaceBackup(store)).unresolved['agentRuns'],0);
});
