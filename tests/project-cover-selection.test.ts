import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createProjectHomeServices,readProjectCover} from '../packages/business/src/project-home.ts';

const id=(n:number)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,projectId=id(1),stamp='2026-11-02T00:00:00.000Z';
function fixture(t:test.TestContext){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 for(const table of ['projects','shots','assets','versions','timelines','nodes','edges'])db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,projectId TEXT,data TEXT)`);
 const put=(table:string,value:Record<string,unknown>)=>db.prepare(`INSERT INTO ${table} VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(String(value.id),projectId,JSON.stringify(value));
 put('projects',{id:projectId,name:'Cover rules',revision:1,createdAt:stamp,updatedAt:stamp});
 const asset=(n:number,mimeType='image/png')=>put('assets',{id:id(n),projectId,mimeType,duration:2,createdAt:stamp});
 asset(10);asset(11);asset(12,'image/jpeg');asset(13,'audio/wav');
 put('shots',{id:id(20),projectId,orderIndex:1,duration:2,selectedVersionId:id(30)});
 put('shots',{id:id(21),projectId,orderIndex:0,duration:2,selectedVersionId:id(31)});
 put('versions',{id:id(30),projectId,shotId:id(20),assetId:id(10)});
 put('versions',{id:id(31),projectId,shotId:id(21),assetId:id(11)});
 const timeline={id:id(40),projectId,width:1080,height:1920,fps:30,presetId:'portrait_1080',durationFrames:60,
   clips:[{id:id(51),assetId:id(11),startFrame:0},{id:id(50),assetId:id(12),startFrame:0}]};
 put('timelines',timeline);
 return {db,put,asset,timeline,expect(assetId:string|null){
   const changes=db.prepare('SELECT total_changes() AS n').get()!.n;
   const full=createProjectHomeServices({db}).handlers['project.summary.list']()[0]!.cover,narrow=readProjectCover({db},projectId);
   assert.deepEqual(narrow,full,'background candidate exactly matches the public summary rule');
   assert.equal(narrow?.assetId??null,assetId);assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,changes,'both reads remain noncreating');
 }};
}

test('cover candidate shares shot order, selected-version ownership, visual filtering and timeline tie breaks',t=>{
 const f=fixture(t);f.expect(id(11));
 f.put('versions',{id:id(31),projectId,shotId:id(20),assetId:id(11)});f.expect(id(10));
 f.asset(10,'audio/wav');f.expect(id(12));
 f.put('timelines',{...f.timeline,clips:[{id:id(51),assetId:id(11),startFrame:0},{id:id(50),assetId:id(12),startFrame:30}]});f.expect(id(11));
 f.asset(11,'application/octet-stream');f.expect(id(12));
 f.asset(12,'audio/wav');f.expect(null);
 assert.equal(readProjectCover({db:f.db},id(999)),null,'an absent project cannot select another project candidate');
});

test('equal shot positions keep UUID tie order and a missing source falls through to the timeline',t=>{
 const f=fixture(t);
 f.put('shots',{id:id(21),projectId,orderIndex:1,duration:2,selectedVersionId:id(31)});f.expect(id(10));
 f.db.prepare('DELETE FROM assets WHERE id=?').run(id(10));f.expect(id(11));
 f.db.prepare('DELETE FROM assets WHERE id=?').run(id(11));f.expect(id(12));
});

for(const table of ['shots','assets','versions','timelines'] as const)test(`candidate retains bounded JSON/id/ownership validation for ${table}`,t=>{
 const f=fixture(t),row=f.db.prepare(`SELECT id,data FROM ${table} ORDER BY id LIMIT 1`).get()!,original=String(row.data);
 for(const corrupt of ['{',JSON.stringify({...JSON.parse(original),id:id(999)}),JSON.stringify({...JSON.parse(original),projectId:id(998)})]){
  f.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(corrupt,String(row.id));
  assert.throws(()=>readProjectCover({db:f.db},projectId),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
  assert.throws(()=>createProjectHomeServices({db:f.db}).handlers['project.summary.list'](),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
 }
 f.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(original,String(row.id));f.expect(id(11));
});

test('candidate rejects excess source rows, oversized JSON and invalid timeline metadata',t=>{
 const f=fixture(t);
 f.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify({id:id(10),projectId,mimeType:'image/png',padding:'x'.repeat(2097152)}),id(10));
 assert.throws(()=>readProjectCover({db:f.db},projectId),{code:'PROJECT_SUMMARY_UNAVAILABLE'});f.asset(10);
 for(const patch of [{durationFrames:-1},{width:7,height:9}]){
  f.put('timelines',{...f.timeline,...patch});assert.throws(()=>readProjectCover({db:f.db},projectId),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
 }
 f.put('timelines',f.timeline);f.put('timelines',{...f.timeline,id:id(41)});
 assert.throws(()=>readProjectCover({db:f.db},projectId),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
 f.db.prepare('DELETE FROM timelines WHERE id=?').run(id(41));
 f.db.exec('BEGIN');for(let n=1000;n<5093;n++)f.asset(n);f.db.exec('COMMIT');
 assert.throws(()=>readProjectCover({db:f.db},projectId),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
});

test('public summaries still validate graph rows while a cover-only read never loads unrelated graph JSON',t=>{
 const f=fixture(t);f.put('nodes',{id:id(80),projectId,text:'unrelated graph'});
 f.db.prepare('UPDATE nodes SET data=? WHERE id=?').run('{',id(80));
 assert.throws(()=>createProjectHomeServices({db:f.db}).handlers['project.summary.list'](),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
 assert.equal(readProjectCover({db:f.db},projectId)?.assetId,id(11));
 f.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({id:projectId,name:'Invalid metadata',revision:1,createdAt:'not-a-date',updatedAt:stamp}),projectId);
 assert.throws(()=>readProjectCover({db:f.db},projectId),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
});

test('candidate retains the aggregate source JSON byte limit below the per-row and row-count limits',t=>{
 const f=fixture(t),padding='x'.repeat(2000000);
 for(let n=100;n<109;n++)f.put('assets',{id:id(n),projectId,mimeType:'image/png',padding});
 const changes=f.db.prepare('SELECT total_changes() AS n').get()!.n;
 assert.throws(()=>readProjectCover({db:f.db},projectId),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
 assert.throws(()=>createProjectHomeServices({db:f.db}).handlers['project.summary.list'](),{code:'PROJECT_SUMMARY_UNAVAILABLE'});
 assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
});
