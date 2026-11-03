import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createProjectFile,inspectProjectFileReadOnly,openProjectConnection} from '../packages/business/src/project-file/connection.ts';
import {openProjectStore,openStagedProjectStore} from '../packages/business/src/project-file/store.ts';
import {readProjectContentStamp} from '../packages/business/src/project-file/content-stamp.ts';
import {buildPreviousHistoryDatabase} from './fixtures/kernel-history-previous-schema.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {V1B_HISTORY_V6_MANIFEST} from '../packages/business/src/project-file/schema/history-v6-manifest.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {AppError} from '../packages/contracts/src/app-error.ts';

function fixture(t:TestContext){
 const root=mkdtempSync(path.join(tmpdir(),'mioon-v5-stamp-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const projectFile=path.join(root,'project.mioon'),projectId=createProjectFile(projectFile);
 const location={localDir:path.join(root,'records'),cacheDir:path.join(root,'cache'),tempDir:path.join(root,'tmp')};
 return {root,projectFile,projectId,location,open:()=>openProjectStore({projectFile,locate:()=>location})};
}
const hash=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
const code=(expected:string)=>(error:unknown)=>error instanceof AppError&&error.code===expected;

test('fresh/current expose immutable opening evidence; raw/autocommit/multirow commits rotate and sync the entire pair',t=>{
 const f=fixture(t),store=f.open();
 assert.equal(store.historyState,'fresh');assert.equal(store.historyAdmission.reason,null);
 const first=readProjectContentStamp(store.db);assert.match(first.contentToken,/^[a-f0-9]{32}$/u);
 assert.equal(store.db.prepare('PRAGMA project.user_version').get()?.user_version,3);
 store.put('projects',{id:f.projectId,name:'first',revision:1});
 const second=readProjectContentStamp(store.db);assert.ok(second.contentSequence>first.contentSequence);assert.notEqual(second.contentToken,first.contentToken);
 store.tx(()=>{store.db.exec('UPDATE project.projects SET data=data');store.db.exec('UPDATE project.projects SET data=data');});
 const third=readProjectContentStamp(store.db);assert.ok(third.contentSequence>second.contentSequence);assert.notEqual(third.contentToken,second.contentToken);
 assert.deepEqual(store.db.prepare('SELECT seenContentSequence,seenContentToken FROM main.history_state').get(),{__proto__:null,seenContentSequence:third.contentSequence,seenContentToken:third.contentToken});
 assert.deepEqual(store.historyAdmission.file,first,'opening evidence remains unchanged by later writes');
 store.close();const reopened=f.open();assert.equal(reopened.historyState,'current');assert.deepEqual(reopened.historyAdmission.file,third);reopened.close();
});

test('rollback retains pair and seen while history-only commits leave the project bytes unchanged',t=>{
 const f=fixture(t),s=f.open(),before=readProjectContentStamp(s.db);
 assert.throws(()=>s.tx(()=>{s.put('projects',{id:f.projectId,name:'rollback',revision:1});throw Error('abort');}),/abort/);
 assert.deepEqual(readProjectContentStamp(s.db),before);assert.equal(s.get('projects',f.projectId),null);
 const bytes=hash(f.projectFile);s.tx(()=>s.db.prepare("INSERT INTO idempotency VALUES('stamp',?,'h','r')").run(randomUUID()));
 assert.deepEqual(readProjectContentStamp(s.db),before);assert.equal(hash(f.projectFile),bytes);s.close();
});

for(const kind of ['smaller','larger','same-sequence'] as const)test(`different file ${kind} is diverged and cannot erase seen through store or raw SQL`,t=>{
 const f=fixture(t);let s=f.open();s.put('projects',{id:f.projectId,name:'one',revision:1});const stamp=readProjectContentStamp(s.db);s.close();
 const db=new DatabaseSync(f.projectFile);db.prepare('UPDATE project_file SET contentSequence=?,contentToken=?').run(stamp.contentSequence+(kind==='larger'?1:0),'f'.repeat(32));db.close();
 if(kind==='smaller'){const history=new DatabaseSync(path.join(f.location.localDir,'history.db'));history.exec('UPDATE history_state SET seenContentSequence=seenContentSequence+1');history.close();}
 s=f.open();assert.equal(s.historyState,'diverged');assert.equal(s.historyAdmission.reason,kind==='smaller'?'file-sequence-smaller':kind==='larger'?'file-sequence-larger':'content-token-different');
 const before=s.db.prepare('SELECT * FROM main.history_state').get(),source=hash(f.projectFile);
 assert.equal(s.tx(()=>s.db.prepare('SELECT count(*) AS n FROM main.project_versions').get()?.n),0,'read transactions remain available');
 assert.throws(()=>s.put('projects',{id:f.projectId,name:'blocked'}),code('PROJECT_HISTORY_DIVERGED'));
 assert.throws(()=>s.db.exec('UPDATE project.projects SET data=data'),/readonly/i);
 s.db.exec('PRAGMA query_only=OFF');
 for(const sql of ['UPDATE project.projects SET data=data','UPDATE main.history_state SET seenContentSequence=seenContentSequence',"INSERT INTO main.idempotency VALUES('blocked','key','hash','id')",'UPDATE project.schema_version SET version=3'])assert.throws(()=>s.db.exec(sql),/PROJECT_HISTORY_DIVERGED/);
 assert.deepEqual(s.db.prepare('SELECT * FROM main.history_state').get(),before);assert.equal(hash(f.projectFile),source);s.close();
 const again=f.open();assert.equal(again.historyState,'diverged');assert.deepEqual(again.historyAdmission.seen,{contentSequence:stamp.contentSequence+Number(kind==='smaller'),contentToken:stamp.contentToken});again.close();
});

test('same token with a different sequence is invalid rather than a recoverable divergence',t=>{
 const f=fixture(t),s=f.open(),stamp=readProjectContentStamp(s.db);s.close();
 const db=new DatabaseSync(f.projectFile);db.prepare('UPDATE project_file SET contentSequence=?').run(stamp.contentSequence+1);db.close();
 const before=hash(f.projectFile);assert.throws(()=>f.open(),code('PROJECT_INVALID'));assert.equal(hash(f.projectFile),before);
});

for(const version of [2,3,4,5,6] as const)test(`exact frozen history ${version} upgrades to 7 with a missing token and no project cleanup`,t=>{
 const f=fixture(t);mkdirSync(f.location.localDir,{recursive:true,mode:0o700});const historyFile=path.join(f.location.localDir,'history.db');
 const db=new DatabaseSync(historyFile);db.exec('BEGIN');buildPreviousHistoryDatabase(db,version);db.prepare('INSERT INTO history_state VALUES(1,?,12)').run(f.projectId);db.exec('COMMIT');
 if(version===6)assert.deepEqual(readSchemaManifest(db,'main'),V1B_HISTORY_V6_MANIFEST.entries);db.close();
 const before=hash(f.projectFile),s=f.open();assert.equal(s.historyState,'diverged');assert.equal(s.historyAdmission.reason,'legacy-token-missing');assert.equal(s.historyAdmission.seen.contentToken,null);assert.equal(s.historyAdmission.seen.contentSequence,12);
 assert.equal(s.db.prepare('SELECT version FROM main.schema_version').get()?.version,7);assert.deepEqual(readSchemaManifest(s.db,'main'),SCHEMA_MANIFEST.history.entries);assert.equal(hash(f.projectFile),before);s.close();
});

for(const format of [0,1,2,4] as const)test(`header format ${format} refuses before locate and leaves every source/companion byte unchanged`,t=>{
 const f=fixture(t),db=new DatabaseSync(f.projectFile);db.exec(`PRAGMA user_version=${format}`);db.close();
 writeFileSync(f.projectFile+'-journal',Buffer.from([1,2,3,4]));const source=readFileSync(f.projectFile),journal=readFileSync(f.projectFile+'-journal'),files=readdirSync(f.root);let located=false;
 assert.throws(()=>openProjectConnection({projectFile:f.projectFile,locate:()=>{located=true;return f.location;}}),code(format>3?'PROJECT_FORMAT_NEWER':'PROJECT_INVALID'));
 assert.equal(located,false);assert.deepEqual(readFileSync(f.projectFile),source);assert.deepEqual(readFileSync(f.projectFile+'-journal'),journal);assert.deepEqual(readdirSync(f.root),files);
});

test('current header with an unexpected schema and hot journal is rejected read-only',t=>{
 const f=fixture(t),db=new DatabaseSync(f.projectFile);db.exec('CREATE TABLE unknown_extension(a)');db.close();
 writeFileSync(f.projectFile+'-journal',Buffer.from([1,2,3,4]));const before=hash(f.projectFile),journal=readFileSync(f.projectFile+'-journal');
 assert.throws(()=>inspectProjectFileReadOnly(f.projectFile),code('PROJECT_INVALID'));assert.equal(hash(f.projectFile),before);assert.deepEqual(readFileSync(f.projectFile+'-journal'),journal);
});

test('pending switch cannot become fresh; staged store requires exact pair, empty execution domain and matching committed evidence',t=>{
 const f=fixture(t),old=f.open();old.put('projects',{id:f.projectId,name:'staged',revision:1});
 old.db.prepare("INSERT INTO project.agent_task_target_revisions_v2 VALUES(?,'job',?,9)").run(f.projectId,randomUUID());
 old.db.prepare("INSERT INTO cache.waveform_cache(cacheKey,projectId,sourceFingerprint,algorithm,status,attemptId,data,bytes,reservedBytes) VALUES(?,?,?,'v5','ready',?,'{}',2,0)").run('a'.repeat(64),f.projectId,'b'.repeat(64),randomUUID());
 const stamp=readProjectContentStamp(old.db);assert.equal(old.db.prepare('SELECT count(*) AS n FROM cache.waveform_cache').get()?.n,1);old.close();
 writeFileSync(path.join(f.location.localDir,'history-switch-active.json'),'{}');assert.throws(()=>f.open(),code('PROJECT_HISTORY_SWITCH_PENDING'));
 const requestId=randomUUID(),historyFile=path.join(f.location.localDir,`history.staged-${requestId}.db`),base={projectFile:f.projectFile,location:f.location,historyFile,expectedStamp:stamp};
 const staged=openStagedProjectStore(base);assert.notEqual(staged.historyState,'diverged');
 assert.equal(staged.db.prepare("SELECT revision FROM project.agent_task_target_revisions_v2 WHERE kind='job'").get()?.revision,9,'staged opening retains project evidence until the confirmed transaction');
 assert.equal(staged.db.prepare('SELECT count(*) AS n FROM cache.waveform_cache').get()?.n,0,'only confirmed staged opening resets canonical rebuildable cache');
 staged.tx(()=>staged.db.prepare('INSERT INTO project_history_resolution VALUES(1,?,?,?)').run(requestId,'d'.repeat(64),JSON.stringify({content:stamp})));staged.close();
 assert.throws(()=>openStagedProjectStore(base),code('PROJECT_INVALID'));
 const reopened=openStagedProjectStore({...base,expectedStamp:{...stamp,contentSequence:999},resolution:{requestId,digest:'d'.repeat(64)}});assert.equal(reopened.historyState,'current');assert.deepEqual(readProjectContentStamp(reopened.db),stamp);reopened.close();
 const dirty=new DatabaseSync(historyFile);dirty.prepare("INSERT INTO idempotency VALUES('bad','key','hash','id')").run();dirty.close();assert.throws(()=>openStagedProjectStore({...base,resolution:{requestId,digest:'d'.repeat(64)}}),code('PROJECT_INVALID'));
});
