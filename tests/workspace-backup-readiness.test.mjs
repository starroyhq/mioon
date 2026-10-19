import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore,createServices} from '@mioon/business';
import {inspectWorkspaceBackup,BACKUP_INSPECTION_LIMITS} from '../packages/business/src/backup-readiness.ts';
function fixture(t){const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-backup-readiness-')),store=openStore(root);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return store;}
const changes=store=>store.db.prepare('SELECT total_changes() n').get().n;
test('shared inspection reads empty workspace without constructing data, filesystem work or model authority',async t=>{
 const store=fixture(t),forbidden=new Proxy({},{get(){throw Error('provider access forbidden');}}),services=createServices(store,new Map([['mock',forbidden]]));
 t.after(()=>services.drain());t.mock.method(globalThis,'fetch',()=>{throw Error('network forbidden');});
 const before=changes(store),result=await services.call('workspace.backup.inspect',{});
 assert.equal(result.captureReady,false);assert.equal(result.inspectionComplete,true);assert.equal(result.databaseSchemaVersion,48);assert.equal(Object.values(result.counts).every(x=>x===0),true);assert.equal(Object.values(result.unresolved).every(x=>x===0),true);assert.equal(changes(store),before);
 assert.throws(()=>services.inspection.dispatch({},'workspace.backup.inspect',{}));
 for(const input of [{source:'/tmp/private'},{projectId:randomUUID()}])await assert.rejects(services.call('workspace.backup.inspect',input));
});
test('summary preserves unknown tasks and excludes all stored text, identities, paths and provider IDs',t=>{
 const store=fixture(t),projectId=randomUUID();store.put('projects',{id:projectId,name:'PRIVATE_PROJECT'});
 for(const status of ['queued','submission_unknown','succeeded'])store.put('jobs',{id:randomUUID(),projectId,status,prompt:'PRIVATE_PROMPT',providerJobId:'SECRET_REMOTE_ID',path:'/secret'});
 const before=changes(store),result=inspectWorkspaceBackup(store);
 assert.equal(result.counts.projects,1);assert.equal(result.counts.videoTasks,3);assert.equal(result.unresolved.videoTasks,2);assert.equal(result.inspectionComplete,true);assert.equal(changes(store),before);
 for(const marker of ['PRIVATE_PROJECT','PRIVATE_PROMPT','SECRET_REMOTE_ID','/secret',projectId])assert.equal(JSON.stringify(result).includes(marker),false);
 assert.equal(store.list('jobs').find(x=>x.status==='submission_unknown').status,'submission_unknown');
});
test('malformed or oversized JSON is unknown, never clean zero or parsed user content',t=>{
 const store=fixture(t),projectId=randomUUID();store.put('projects',{id:projectId,name:'A'});const id=randomUUID();store.put('jobs',{id,projectId,status:'running'});
 for(const data of ['{broken','{"status":null}','{"status":false}','{"status":"unrecognized"}']){store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(data,id);const result=inspectWorkspaceBackup(store);assert.equal(result.unresolved.videoTasks,null);assert.equal(result.inspectionComplete,false);assert.ok(result.issues.includes('INVALID_ROW'));}
 store.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({status:'running',text:'x'.repeat(BACKUP_INSPECTION_LIMITS.jsonRowBytes)}),id);const result=inspectWorkspaceBackup(store);assert.equal(result.unresolved.videoTasks,null);assert.ok(result.issues.includes('JSON_LIMIT'));
});
test('row cap applies before materialization, keeps unknown count and leaves caller transaction intact',t=>{
 const store=fixture(t);store.db.exec('BEGIN');const insert=store.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)');for(let i=0;i<=BACKUP_INSPECTION_LIMITS.rowsPerTable;i++)insert.run(randomUUID(),'{}');
 const before=changes(store),result=inspectWorkspaceBackup(store);assert.equal(result.counts.projects,null);assert.equal(result.inspectionComplete,false);assert.ok(result.issues.includes('ROW_LIMIT'));assert.equal(store.db.isTransaction,true);assert.equal(changes(store),before);store.db.exec('ROLLBACK');assert.equal(inspectWorkspaceBackup(store).counts.projects,0);
});
