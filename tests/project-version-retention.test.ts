import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServerProject} from './helpers/project-database.ts';
import {captureProjectDocumentInside} from '../packages/business/src/project-versions/document.ts';
import {encodeProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import type {EncodedProjectDocument} from '../packages/business/src/project-versions/codec.ts';
import {storeManualVersionInside,storeProjectVersionInside} from '../packages/business/src/project-versions/repository.ts';
import {pinProjectVersion,pruneProjectVersionsInside,projectVersionLocalDay} from '../packages/business/src/project-versions/retention.ts';

function fixture(t:TestContext){
  const root=mkdtempSync(path.join(tmpdir(),'version-retention-')),{store,projectId}=createServerProject(root,{name:'Retention'});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  const encode=()=>store.tx(()=>encodeProjectDocument(captureProjectDocumentInside(store)));
  const shared=encode();
  const add=(createdAt:string,blob:EncodedProjectDocument=shared,trigger:'manual'|'bulk-change'|'restore'|'daily-open'='bulk-change')=>store.tx(()=>storeProjectVersionInside(store.db,
    {projectId,trigger,contentSequence:Number(store.db.prepare('SELECT contentSequence FROM project.project_file').get()!.contentSequence),blob,mioChangeRowid:17,createdAt}));
  const rows=()=>store.db.prepare('SELECT * FROM main.project_versions ORDER BY createdAt,id').all();
  const prune=(now:string,timeZone='UTC',protectedIds:readonly string[]=[])=>store.tx(()=>pruneProjectVersionsInside(store.db,{projectId,now:new Date(now),timeZone,protectedIds}));
  return {store,projectId,shared,encode,add,rows,prune};
}

test('retention keeps manual forever and the exact union of latest twenty and seven earliest local-day versions',t=>{
  const f=fixture(t),manual=f.add('2020-01-01T00:00:00.000Z',f.shared,'manual'),expired=f.add('2026-10-01T00:00:00.000Z');
  const daily=Array.from({length:7},(_,index)=>f.add(`2026-11-${String(index+2).padStart(2,'0')}T00:00:00.000Z`,f.shared,'daily-open'));
  const recent=Array.from({length:25},(_,index)=>f.add(`2026-11-08T10:${String(index).padStart(2,'0')}:00.000Z`));
  const requestId=randomUUID(),response=JSON.stringify({projectId:f.projectId,requestId,version:manual});
  f.store.tx(()=>{
    f.store.db.prepare("INSERT INTO main.project_version_requests VALUES(?,?,'project.version.save',?,?)").run(f.projectId,requestId,'a'.repeat(64),response);
    f.store.db.prepare("INSERT INTO main.project_version_capture_marks VALUES(?,'daily-open','2026-11-08|UTC','2026-11-08T00:00:00.000Z')").run(f.projectId);
  });
  assert.deepEqual(f.prune('2026-11-08T12:00:00.000Z'),{deletedVersions:6,deletedBlobs:0});
  const expected=[manual.id,...daily.map(row=>row.id),...recent.slice(-20).map(row=>row.id)].sort();
  assert.deepEqual(f.rows().map(row=>String(row.id)).sort(),expected);
  assert.equal(f.rows().some(row=>row.id===expired.id),false);
  assert.equal(f.store.db.prepare('SELECT response FROM main.project_version_requests WHERE requestId=?').get(requestId)!.response,response);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.project_version_capture_marks').get()!.n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.project_version_blobs').get()!.n,1);
  assert.throws(()=>f.store.db.prepare('DELETE FROM main.project_versions WHERE id=?').run(manual.id),/PROJECT_VERSION_MANUAL_RETAINED/u);
  assert.deepEqual(f.prune('2026-11-08T12:00:00.000Z'),{deletedVersions:0,deletedBlobs:0});
});

test('pins are reference counted and shared blobs survive until their final unprotected version is pruned',t=>{
  const f=fixture(t),first=f.add('2026-10-01T00:00:00.000Z'),second=f.add('2026-10-02T00:00:00.000Z');
  const releaseFirst=pinProjectVersion(f.store.db,first.id),releaseSecond=pinProjectVersion(f.store.db,first.id);
  const requestId=randomUUID(),receipt=JSON.stringify({projectId:f.projectId,requestId,versionId:first.id,beforeVersionId:second.id,contentSequence:first.contentSequence,contentToken:'e'.repeat(32),totalChanges:0,appliedChanges:[],keptCurrent:[]});
  f.store.tx(()=>f.store.db.prepare("INSERT INTO main.project_version_requests VALUES(?,?,'project.version.restore',?,?)").run(f.projectId,requestId,'b'.repeat(64),receipt));
  f.store.put('projects',{...f.store.get('projects',f.projectId) as Record<string,unknown>,name:'A different canonical body'});
  const fresh=f.encode();
  for(let index=0;index<20;index++)f.add(`2026-11-08T10:${String(index).padStart(2,'0')}:00.000Z`,fresh);
  assert.deepEqual(f.prune('2026-11-08T12:00:00.000Z','UTC',[second.id]),{deletedVersions:0,deletedBlobs:0});
  releaseFirst();releaseFirst();
  assert.deepEqual(f.prune('2026-11-08T12:00:00.000Z'),{deletedVersions:1,deletedBlobs:0});
  assert.ok(f.rows().some(row=>row.id===first.id));
  assert.equal(f.rows().some(row=>row.id===second.id),false);
  releaseSecond();
  assert.deepEqual(f.prune('2026-11-08T12:00:00.000Z'),{deletedVersions:1,deletedBlobs:1});
  assert.equal(f.rows().length,20);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.project_version_blobs').get()!.n,1);
  assert.equal(f.store.db.prepare('SELECT response FROM main.project_version_requests WHERE requestId=?').get(requestId)!.response,receipt);
  assert.throws(()=>pinProjectVersion(f.store.db,first.id),{code:'PROJECT_VERSION_NOT_FOUND'});
});

test('seven-day selection follows local calendar dates across the twenty-five-hour DST day',t=>{
  const f=fixture(t),outside=f.add('2026-10-27T03:30:00.000Z'),inside=f.add('2026-10-27T04:30:00.000Z');
  const repeatedFirst=f.add('2026-11-01T05:30:00.000Z'),repeatedSecond=f.add('2026-11-01T06:30:00.000Z');
  const recent=Array.from({length:25},(_,index)=>f.add(`2026-11-02T05:${String(index).padStart(2,'0')}:00.000Z`));
  assert.equal(projectVersionLocalDay(new Date(outside.createdAt),'America/New_York'),'2026-10-26');
  assert.equal(projectVersionLocalDay(new Date(inside.createdAt),'America/New_York'),'2026-10-27');
  assert.equal(projectVersionLocalDay(new Date(repeatedFirst.createdAt),'America/New_York'),'2026-11-01');
  assert.equal(projectVersionLocalDay(new Date(repeatedSecond.createdAt),'America/New_York'),'2026-11-01');
  const result=f.prune('2026-11-02T05:30:00.000Z','America/New_York');
  assert.deepEqual(result,{deletedVersions:6,deletedBlobs:0});
  assert.deepEqual(f.rows().map(row=>String(row.id)).sort(),[inside.id,repeatedFirst.id,recent[0].id,...recent.slice(-20).map(row=>row.id)].sort());
});

test('cleanup participates in the caller transaction and a later failure restores every deleted row and blob',t=>{
  const f=fixture(t);
  for(let index=0;index<25;index++)f.add(`2026-10-01T00:${String(index).padStart(2,'0')}:00.000Z`);
  const before=f.rows(),blobs=f.store.db.prepare('SELECT * FROM main.project_version_blobs').all();
  assert.throws(()=>f.store.tx(()=>{
    assert.deepEqual(pruneProjectVersionsInside(f.store.db,{projectId:f.projectId,now:new Date('2026-11-08T12:00:00.000Z'),timeZone:'UTC'}),{deletedVersions:5,deletedBlobs:0});
    throw Error('Synthetic capture publication failure');
  }),/Synthetic capture publication failure/u);
  assert.deepEqual(f.rows(),before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM main.project_version_blobs').all(),blobs);
  assert.throws(()=>pruneProjectVersionsInside(f.store.db,{projectId:f.projectId}),/requires a transaction/u);
  assert.throws(()=>f.store.tx(()=>pruneProjectVersionsInside(f.store.db,{projectId:randomUUID()})),{code:'PROJECT_ID_MISMATCH'});
  assert.deepEqual(f.rows(),before);
});

test('the generalized repository preserves explicit pre-mutation rowid evidence and validates reused blobs',t=>{
  const f=fixture(t),saved=f.add('2026-11-08T12:00:00.000Z',f.shared,'restore');
  assert.equal(saved.trigger,'restore');assert.equal(saved.name,null);assert.equal(saved.mioRunId,null);
  assert.equal(f.store.db.prepare('SELECT mioChangeRowid FROM main.project_versions WHERE id=?').get(saved.id)!.mioChangeRowid,17);
  const manual=f.store.tx(()=>storeManualVersionInside(f.store.db,f.projectId,'Compatibility',saved.contentSequence,f.shared));
  assert.equal(manual.trigger,'manual');assert.equal(manual.name,'Compatibility');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM main.project_version_blobs').get()!.n,1);
  assert.throws(()=>f.store.tx(()=>storeProjectVersionInside(f.store.db,{projectId:f.projectId,trigger:'daily-open',name:'Forbidden name',contentSequence:saved.contentSequence,blob:f.shared,mioChangeRowid:0})),{code:'PROJECT_VERSION_RECORD_INVALID'});
  assert.throws(()=>f.store.tx(()=>storeProjectVersionInside(f.store.db,{projectId:f.projectId,trigger:'bulk-change',contentSequence:saved.contentSequence,blob:f.shared,mioChangeRowid:-1})),/captured nonnegative Mio rowid/u);
  assert.equal(f.rows().length,2);
});

test('a damaged existing body cannot become a successful deduplication hit',t=>{
  const f=fixture(t);
  f.store.tx(()=>f.store.db.prepare("INSERT INTO main.project_version_blobs VALUES(?,1,'gzip',?,1,?)").run(f.shared.hash,f.shared.rawBytes,Buffer.from([0])));
  assert.throws(()=>f.add('2026-11-08T12:00:00.000Z'),{code:'PROJECT_VERSION_SNAPSHOT_INVALID'});
  assert.deepEqual(f.rows(),[]);
  assert.equal(f.store.db.prepare('SELECT hex(payload) bytes FROM main.project_version_blobs').get()!.bytes,'00');
});
