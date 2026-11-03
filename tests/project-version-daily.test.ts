import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServerProject,openServerProject} from './helpers/project-database.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication,testProjectAppLibrary} from '../packages/business/src/project-service-application.ts';
import {registerProjectTransactionObserver} from '../packages/business/src/project-file/store.ts';
import {captureDailyProjectVersion} from '../packages/business/src/project-versions/daily.ts';
import {storeProjectVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {pruneProjectVersionsInside} from '../packages/business/src/project-versions/retention.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';

function fixture(t:TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'version-daily-'));
  let {store}=createServerProject(root,{name:'Daily'});
  const library=testProjectAppLibrary(store)!,libraries=new Set([library]),owner=new AbortController(),ports=createProjectServiceApplication(library,owner.signal,{});
  t.after(()=>{store.close();for(const value of libraries)value.close();rmSync(root,{recursive:true,force:true});});
  const state=()=>Object.fromEntries(['project_versions','project_version_blobs','project_version_requests','project_version_capture_marks'].map(table=>[table,store.db.prepare(`SELECT * FROM main.${table} ORDER BY rowid`).all()]));
  const capture=(at='2026-11-03T10:00:00.000Z',timeZone='UTC')=>captureDailyProjectVersion(store,{assertMutationAllowed:ports.assertMutationAllowed,now:()=>new Date(at),timeZone:()=>timeZone});
  return {root,get store(){return store;},library,libraries,owner,ports,state,capture,reopen(){const projectId=store.projectId;store.close();store=openServerProject(root,projectId);}};
}

test('daily capture records date and IANA zone, skips unchanged or changed same-day opens and preserves project content',t=>{
  const f=fixture(t),db=f.store.db,sequence=db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence;
  const first=f.capture();assert.ok(first);assert.equal(first.trigger,'daily-open');assert.equal(first.createdAt,'2026-11-03T10:00:00.000Z');
  assert.equal(db.prepare('SELECT key FROM main.project_version_capture_marks').get()!.key,'2026-11-03|UTC');
  assert.equal(db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence,sequence);
  const count=db.prepare('SELECT total_changes() n').get()!.n;
  assert.equal(f.capture('2026-11-03T23:59:59.999Z'),null);
  assert.equal(db.prepare('SELECT total_changes() n').get()!.n,count);
  f.store.put('projects',{...f.store.get('projects',f.store.projectId) as Record<string,unknown>,name:'Changed during the same day'});
  const before=f.state();assert.equal(f.capture(),null);assert.deepEqual(f.state(),before);
  assert.ok(f.capture('2026-11-04T00:00:00.000Z'));
  assert.equal(db.prepare('SELECT count(*) n FROM main.project_versions').get()!.n,2);
  assert.equal(db.prepare('SELECT count(*) n FROM main.project_version_capture_marks').get()!.n,2);
});

test('daily calendar keys handle midnight, repeated DST hours and a changed local time zone',t=>{
  const f=fixture(t);
  assert.ok(f.capture('2026-11-01T05:30:00.000Z','America/New_York'));
  assert.equal(f.capture('2026-11-01T06:30:00.000Z','America/New_York'),null);
  assert.equal(f.capture('2026-11-02T04:59:59.999Z','America/New_York'),null);
  assert.ok(f.capture('2026-11-02T05:00:00.000Z','America/New_York'));
  assert.ok(f.capture('2026-11-02T05:00:00.000Z','UTC'));
  assert.deepEqual(f.store.db.prepare('SELECT key FROM main.project_version_capture_marks ORDER BY key').all().map(row=>row.key),[
    '2026-11-01|America/New_York','2026-11-02|America/New_York','2026-11-02|UTC',
  ]);
  const before=f.state();
  assert.throws(()=>f.capture('2026-11-02T05:00:00.000Z','Not/A_Time_Zone'),RangeError);
  assert.deepEqual(f.state(),before);
});

test('daily marks survive automatic rotation and reopening so an old day is not recaptured',t=>{
  const f=fixture(t),first=f.capture();assert.ok(first);
  f.store.tx(()=>{
    const document=captureProjectDocumentInside(f.store),blob=encodeProjectDocument(document);
    for(let index=0;index<25;index++)storeProjectVersionInside(f.store.db,{projectId:f.store.projectId,trigger:'bulk-change',contentSequence:document.evidence.contentSequence,blob,mioChangeRowid:0,createdAt:`2026-12-01T10:${String(index).padStart(2,'0')}:00.000Z`});
    pruneProjectVersionsInside(f.store.db,{projectId:f.store.projectId,now:new Date('2026-12-01T12:00:00.000Z'),timeZone:'UTC'});
  });
  assert.equal(f.store.db.prepare('SELECT 1 FROM main.project_versions WHERE id=?').get(first.id),undefined);
  f.reopen();
  const liveLibrary=testProjectAppLibrary(f.store)!,guard=createProjectServiceApplication(liveLibrary).assertMutationAllowed;
  assert.equal(captureDailyProjectVersion(f.store,{assertMutationAllowed:guard,now:()=>new Date('2026-11-03T12:00:00.000Z'),timeZone:()=> 'UTC'}),null);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM main.project_version_capture_marks WHERE key='2026-11-03|UTC'").get()!.n,1);
});

test('a failed commit rolls back version, blob and daily mark, then the same day can retry',t=>{
  const f=fixture(t),before=f.state(),error=new Error('Synthetic daily before-commit failure');
  const release=registerProjectTransactionObserver(f.store.db,()=>{throw error;});
  assert.throws(()=>f.capture(),caught=>caught===error);release();
  assert.deepEqual(f.state(),before);
  assert.ok(f.capture());
  assert.equal(f.capture(),null);
});

test('actual SQLite page exhaustion rolls back daily capture without a successful mark and retry can succeed',t=>{
  const f=fixture(t);
  f.store.tx(()=>{for(let index=0;index<48;index++){
    const id=randomUUID();f.store.put('assets',{id,projectId:f.store.projectId,name:'Capacity input',mimeType:'image/png',relativePath:`media/${id}.png`,sha256:'0'.repeat(64),sizeBytes:1});
    f.store.db.prepare('INSERT INTO project.asset_annotations(assetId,projectId,revision,tags,note) VALUES(?,?,1,?,?)').run(id,f.store.projectId,'[]',randomBytes(8192).toString('hex'));
  }});
  const before=f.state(),pages=Number(f.store.db.prepare('PRAGMA main.page_count').get()!.page_count),limit=Number(f.store.db.prepare('PRAGMA main.max_page_count').get()!.max_page_count);
  f.store.db.exec(`PRAGMA main.max_page_count=${pages}`);
  try{assert.throws(()=>f.capture(),error=>error instanceof Error&&'errcode' in error&&error.errcode===13);}
  finally{f.store.db.exec(`PRAGMA main.max_page_count=${limit}`);}
  assert.deepEqual(f.state(),before);
  assert.ok(f.capture());
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.project_version_capture_marks').get()!.n,1);
});

test('an aborted owner and an old B1 capability after reopening reject before all writes, including a same-day hit',t=>{
  const f=fixture(t),first=f.capture();assert.ok(first);
  const before=f.state(),changes=f.store.db.prepare('SELECT total_changes() n').get()!.n,reason=new Error('Daily owner stopped');
  f.owner.abort(reason);
  assert.throws(()=>f.capture(),error=>error===reason);
  assert.throws(()=>f.capture('2026-11-04T10:00:00.000Z'),error=>error===reason);
  assert.deepEqual(f.state(),before);
  assert.equal(f.store.db.prepare('SELECT total_changes() n').get()!.n,changes);
  const g=fixture(t),stale=createProjectServiceApplication(g.library).assertMutationAllowed,state=g.state(),count=g.store.db.prepare('SELECT total_changes() n').get()!.n;
  g.library.close();const replacement=openAppLibrary({dataDir:g.root});g.libraries.add(replacement);
  assert.doesNotThrow(()=>createProjectServiceApplication(replacement).assertMutationAllowed());
  assert.throws(()=>captureDailyProjectVersion(g.store,{assertMutationAllowed:stale}),{name:'TypeError',message:'Project services require a live application library owner'});
  assert.deepEqual(g.state(),state);
  assert.equal(g.store.db.prepare('SELECT total_changes() n').get()!.n,count);
  assert.throws(()=>captureDailyProjectVersion(g.store,{assertMutationAllowed:undefined!}),/require application write admission/u);
});
