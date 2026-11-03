












import test from 'node:test';


import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';


import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {ownsStoreLock} from '../packages/business/src/store-runtime.ts';
import {createTaskDispositionServices} from '../packages/business/src/task-dispositions.ts';
import {taskDispositionSchemas} from '../packages/contracts/src/task-dispositions.ts';





const stamp='2026-10-20T00:00:00.000Z';
function fixture(t:any){const root=realpathSync(mkdtempSync(join(tmpdir(),'mioon-task-disposition-')));let store=openStore(root),fault:((point:string)=>void)=()=>{},owned=true,readOnly=false;
 const projectId=store.projectId;store.put('projects',{id:projectId,name:'Tasks',revision:1,createdAt:stamp,updatedAt:stamp});
 const services=()=>createTaskDispositionServices(store,{ownsLock:()=>owned&&ownsStoreLock(store),isReadOnly:()=>readOnly,now:()=>stamp,fault:point=>fault(point)}).handlers;
 t.after(()=>{if(store.db.isOpen)store.close();rmSync(root,{recursive:true,force:true});});
 return {projectId,get store(){return store;},get handlers(){return services();},setFault(value:typeof fault){fault=value;},setOwned(value:boolean){owned=value;},setReadOnly(value:boolean){readOnly=value;},restart(){store.close();store=openStore(root);},job(status='submission_unknown',extra={}){const id=randomUUID();store.put('jobs',{id,projectId,status,requestId:randomUUID(),submissionCount:1,...extra});return {kind:'generation' as const,taskId:id};},list(targets:any[]){return services()['task.disposition.list']({projectId,targets});},mark(target:any,extra={}){return {projectId,...target,expectedRevision:0,expectedStatus:'submission_unknown',requestId:randomUUID(),confirm:true as const,...extra};}};
}

test('strict closed schemas require explicit confirmation, bounded unique targets and valid Unicode',()=>{const base={projectId:randomUUID(),kind:'generation',taskId:randomUUID(),expectedRevision:0,expectedStatus:'submission_unknown',requestId:randomUUID(),confirm:true};assert.ok(taskDispositionSchemas['task.disposition.markFailed'].safeParse(base).success);for(const bad of [{...base,confirm:false},{...base,extra:true},{...base,requestId:'abcdefg\ud800'},{...base,expectedRevision:-1}])assert.equal(taskDispositionSchemas['task.disposition.markFailed'].safeParse(bad).success,false);assert.equal(taskDispositionSchemas['task.disposition.list'].safeParse({projectId:base.projectId,targets:[base,base]}).success,false);});
test('markFailed is a retained local marker; raw unknown status, original request and reconciliation stay unchanged',t=>{const f=fixture(t),target=f.job(),raw=f.store.get('jobs',target.taskId),input=f.mark(target);const result=f.handlers['task.disposition.markFailed'](input);assert.equal(result.items[0].markedFailed,true);assert.equal(result.items[0].canArchive,false);assert.deepEqual(f.store.get('jobs',target.taskId),raw);assert.deepEqual(f.handlers['task.disposition.markFailed'](input),result);assert.throws(()=>f.handlers['task.disposition.markFailed']({...input,confirm:false}),{code:'TASK_DISPOSITION_VALIDATION'});assert.throws(()=>f.handlers['task.disposition.markFailed']({...input,expectedRevision:1}),{code:'IDEMPOTENCY_CONFLICT'});assert.throws(()=>f.handlers['task.disposition.markFailed']({...input,requestId:randomUUID()}),{code:'TASK_DISPOSITION_CONFLICT'});f.restart();assert.deepEqual(f.handlers['task.disposition.markFailed'](input),result);assert.equal(f.list([target]).items[0].revision,1);});
test('archive is atomic and refuses running, unknown, paid cancellation and output review',t=>{const f=fixture(t),done=f.job('succeeded'),bad=f.job('running');const input={projectId:f.projectId,requestId:randomUUID(),targets:[{...done,expectedRevision:0,expectedStatus:'succeeded'},{...bad,expectedRevision:0,expectedStatus:'running'}]};assert.throws(()=>f.handlers['task.disposition.archiveCompleted'](input),{code:'TASK_DISPOSITION_STATE'});assert.equal(f.list([done]).items[0].revision,0);for(const [status,extra] of [['submission_unknown',{}],['cancelled',{submissionCount:1}],['succeeded',{phase:'output_review_required'}]] as const){const target=f.job(status,extra);assert.equal(f.list([target]).items[0].canArchive,false);}input.targets.pop();const result=f.handlers['task.disposition.archiveCompleted'](input);assert.ok(result.items[0].archived);assert.ok(f.store.get('jobs',done.taskId));assert.deepEqual(f.handlers['task.disposition.archiveCompleted'](input),result);});
test('state CAS and ownership are checked again before committing; after-commit replay does not duplicate work',t=>{const f=fixture(t),target=f.job(),input=f.mark(target);f.setOwned(false);assert.throws(()=>f.handlers['task.disposition.markFailed'](input),{code:'TASK_DISPOSITION_UNAVAILABLE'});f.setOwned(true);f.setReadOnly(true);assert.throws(()=>f.handlers['task.disposition.markFailed'](input),{code:'TASK_DISPOSITION_UNAVAILABLE'});f.setReadOnly(false);f.setFault(point=>{if(point==='beforeCommit')throw Error('crash before commit');});assert.throws(()=>f.handlers['task.disposition.markFailed'](input),/crash before commit/);assert.equal(f.list([target]).items[0].revision,0);f.setFault(point=>{if(point==='afterCommit')throw Error('response lost');});assert.throws(()=>f.handlers['task.disposition.markFailed'](input),/response lost/);f.setFault(()=>{});assert.equal(f.handlers['task.disposition.markFailed'](input).items[0].revision,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM task_disposition_requests').get()!.n,1);});








test('audit records refuse INSERT OR REPLACE even when recursive triggers are disabled',t=>{const f=fixture(t),target=f.job(),input=f.mark(target);f.handlers['task.disposition.markFailed'](input);f.store.db.exec('PRAGMA recursive_triggers=OFF');assert.throws(()=>f.store.db.exec('INSERT OR REPLACE INTO task_dispositions SELECT * FROM task_dispositions'),/must not be replaced/);assert.throws(()=>f.store.db.exec('INSERT OR REPLACE INTO task_disposition_requests SELECT * FROM task_disposition_requests'),/must not be replaced/);assert.equal(f.list([target]).items[0].markedFailed,true);});
