import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServerProject} from './helpers/project-database.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';

function fixture(t:TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'project-versions-'));
  const created=createServerProject(root,{name:'Versions'}),{store,projectId}=created;
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const api=createProjectVersions(store);
  const sequence=()=>Number(store.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence);
  const counts=()=>['project_versions','project_version_blobs','project_version_requests'].map(table=>Number(store.db.prepare(`SELECT count(*) n FROM main.${table}`).get()?.n));
  const changes=()=>Number(store.db.prepare('SELECT total_changes() n').get()?.n);
  return {root,store,projectId,api,sequence,counts,changes};
}

test('manual saves deduplicate bodies, retain distinct versions, replay exact receipts and never change project content',t=>{
  const f=fixture(t),input={projectId:f.projectId,requestId:randomUUID(),name:'First'};
  const before=f.sequence(),ledger=f.store.db.prepare('SELECT * FROM project.agent_task_target_revisions_v2 ORDER BY kind,targetId').all();
  const saved=f.api.save(input),same=f.api.save(input),second=f.api.save({...input,requestId:randomUUID(),name:'Second'});
  assert.deepEqual(same,saved);assert.notEqual(saved.version.id,second.version.id);
  assert.deepEqual(f.counts(),[2,1,2]);assert.equal(f.sequence(),before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM project.agent_task_target_revisions_v2 ORDER BY kind,targetId').all(),ledger);
  assert.throws(()=>f.api.save({...input,name:'Other'}),{code:'REQUEST_ID_REUSED'});
  assert.deepEqual(f.counts(),[2,1,2]);
  const mark=f.changes(),preview=f.api.preview({projectId:f.projectId,versionId:saved.version.id});
  assert.equal(preview.totalChanges,0);assert.deepEqual(preview.changes,[]);assert.equal(preview.restoreAvailable,false);assert.equal(f.changes(),mark);
});

test('list uses project-bound keyset pages; foreign or changed cursor inputs cannot disclose records',t=>{
  const f=fixture(t);
  for(let i=0;i<5;i++)f.api.save({projectId:f.projectId,requestId:randomUUID(),name:`Version ${i}`});
  const mark=f.changes(),all=f.api.list({projectId:f.projectId}).versions;
  const page=f.api.list({projectId:f.projectId,limit:2});assert.equal(page.versions.length,2);assert.ok(page.nextCursor);
  const second=f.api.list({projectId:f.projectId,limit:2,cursor:page.nextCursor!});
  const last=f.api.list({projectId:f.projectId,limit:2,cursor:second.nextCursor!});
  assert.deepEqual([...page.versions,...second.versions,...last.versions],all);assert.equal(last.nextCursor,null);
  assert.throws(()=>f.api.list({projectId:f.projectId,limit:3,cursor:page.nextCursor!}),{code:'PROJECT_VERSION_CURSOR_INVALID'});
  assert.throws(()=>f.api.list({projectId:f.projectId,cursor:page.nextCursor!+'x'}),{code:'PROJECT_VERSION_CURSOR_INVALID'});
  assert.throws(()=>f.api.list({projectId:randomUUID()}),{code:'PROJECT_ID_MISMATCH'});
  assert.equal(f.changes(),mark);
});

test('preview enumerates more than 200 exact differences, binds all pages and stays read-only',t=>{
  const f=fixture(t),saved=f.api.save({projectId:f.projectId,requestId:randomUUID()});
  f.store.tx(()=>{for(let i=0;i<205;i++)f.store.put('shots',{id:randomUUID(),projectId:f.projectId,title:`New shot ${i}`,revision:1,createdAt:'2026-11-03T00:00:00.000Z',updatedAt:'2026-11-03T00:00:00.000Z'});});
  const mark=f.changes(),seq=f.sequence();
  const first=f.api.preview({projectId:f.projectId,versionId:saved.version.id,limit:100});
  assert.equal(first.totalChanges,205);assert.equal(first.changes.length,100);assert.equal(first.keptCurrentCount,0);
  const second=f.api.preview({projectId:f.projectId,versionId:saved.version.id,limit:100,cursor:first.nextCursor!});
  const third=f.api.preview({projectId:f.projectId,versionId:saved.version.id,limit:100,cursor:second.nextCursor!});
  assert.equal(second.previewDigest,first.previewDigest);assert.equal(third.previewDigest,first.previewDigest);
  const changes=[...first.changes,...second.changes,...third.changes];
  assert.equal(changes.length,205);assert.equal(new Set(changes.map(row=>row.table+row.key)).size,205);
  assert.ok(changes.every(row=>row.table==='shots'&&row.action==='remove'&&row.source==='user-or-other'));
  assert.equal(third.nextCursor,null);assert.equal(f.changes(),mark);assert.equal(f.sequence(),seq);
  assert.throws(()=>f.api.preview({projectId:f.projectId,versionId:randomUUID()}),{code:'PROJECT_VERSION_NOT_FOUND'});
  const row=f.store.list('shots',f.projectId)[0] as {id:string;projectId:string};
  f.store.put('shots',{...row,title:'Changed after preview'});
  assert.throws(()=>f.api.preview({projectId:f.projectId,versionId:saved.version.id,limit:100,cursor:first.nextCursor!}),{code:'PROJECT_VERSION_CURSOR_INVALID'});
});

test('a transaction failure rolls back snapshot, version and receipt together and retry succeeds',t=>{
  const f=fixture(t),input={projectId:f.projectId,requestId:randomUUID()};
  const unregister=registerProjectTransactionObserver(f.store.db,()=>{throw Error('Synthetic before-commit failure');});
  assert.throws(()=>f.api.save(input),/Synthetic before-commit failure/);unregister();
  assert.deepEqual(f.counts(),[0,0,0]);
  const saved=f.api.save(input);assert.equal(saved.requestId,input.requestId);assert.deepEqual(f.counts(),[1,1,1]);
});

test('history guards prevent manual deletion, payload/receipt updates and replacement by identity or rowid',t=>{
  const f=fixture(t),saved=f.api.save({projectId:f.projectId,requestId:randomUUID()});
  assert.throws(()=>f.store.db.prepare('DELETE FROM main.project_versions WHERE id=?').run(saved.version.id),/PROJECT_VERSION_MANUAL_RETAINED/);
  assert.throws(()=>f.store.db.exec("UPDATE main.project_version_blobs SET payload=x'00'"),/PROJECT_VERSION_IMMUTABLE/);
  assert.throws(()=>f.store.db.exec("UPDATE main.project_version_requests SET response='{}'"),/PROJECT_VERSION_IMMUTABLE/);
  assert.throws(()=>f.store.db.exec('DELETE FROM main.project_version_requests'),/PROJECT_VERSION_IMMUTABLE/);
  assert.throws(()=>f.store.db.exec('INSERT OR REPLACE INTO main.project_versions SELECT * FROM main.project_versions'),/PROJECT_VERSION_IMMUTABLE/);
  assert.throws(()=>f.store.db.exec('INSERT OR REPLACE INTO main.project_version_blobs SELECT * FROM main.project_version_blobs'),/PROJECT_VERSION_IMMUTABLE/);
  const row=f.store.db.prepare('SELECT rowid,* FROM main.project_versions').get()!;
  assert.throws(()=>f.store.db.prepare('INSERT OR REPLACE INTO main.project_versions(rowid,id,projectId,trigger,name,mioRunId,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(?,?,?, ?,?,NULL,?,?,?,?)')
    .run(row.rowid,randomUUID(),f.projectId,'manual',null,row.contentSequence,row.createdAt,row.blobHash,row.mioChangeRowid),/PROJECT_VERSION_IMMUTABLE/);
  assert.deepEqual(f.counts(),[1,1,1]);
});
