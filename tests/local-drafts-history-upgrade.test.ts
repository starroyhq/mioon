import {testEnv} from './helpers/test-env.ts';
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createProjectFile,openProjectConnection} from '../packages/business/src/project-file/connection.ts';
import {buildDatabase,HISTORY_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {readSchemaManifest} from '../packages/business/src/project-file/schema/manifest-check.ts';
import {SCHEMA_MANIFEST} from '../packages/business/src/project-file/schema/manifest.ts';
import {S0_HISTORY_V2_MANIFEST} from '../packages/business/src/project-file/schema/history-v2-manifest.ts';
import {R1_HISTORY_V3_MANIFEST} from '../packages/business/src/project-file/schema/history-v3-manifest.ts';
import {R1_HISTORY_V4_MANIFEST} from '../packages/business/src/project-file/schema/history-v4-manifest.ts';
import {R2_HISTORY_V5_MANIFEST} from '../packages/business/src/project-file/schema/history-v5-manifest.ts';
import {V1_HISTORY_V6_MANIFEST} from '../packages/business/src/project-file/schema/history-v6-manifest.ts';
import {S2_HISTORY_V7_MANIFEST} from '../packages/business/src/project-file/schema/history-v7-manifest.ts';
import {V5_HISTORY_V8_MANIFEST} from '../packages/business/src/project-file/schema/history-v8-manifest.ts';
import {LEGACY_MIO_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {buildPreviousHistoryDatabase,type PreviousHistoryVersion} from './fixtures/kernel-history-previous-schema.ts';

const OLD = [[2,S0_HISTORY_V2_MANIFEST],[3,R1_HISTORY_V3_MANIFEST],[4,R1_HISTORY_V4_MANIFEST],[5,R2_HISTORY_V5_MANIFEST],
  [6,V1_HISTORY_V6_MANIFEST],[7,S2_HISTORY_V7_MANIFEST],[8,V5_HISTORY_V8_MANIFEST]] as const;
const DRAFT_TABLES=['local_draft_states','local_clip_drafts','local_delivery_drafts','local_shot_text_drafts'] as const;
const FINAL_VERSION=`UPDATE main.schema_version SET version=${HISTORY_SCHEMA_VERSION}`;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const WORKER=fileURLToPath(new URL('./fixtures/local-drafts-history-upgrade-worker.ts',import.meta.url));
type Version=PreviousHistoryVersion;

function readAll(db:DatabaseSync){
  const objects=db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  const tables=objects.filter(row=>row.type==='table').map(row=>String(row.name));
  return {manifest:readSchemaManifest(db,'main'),version:db.prepare('SELECT version FROM schema_version ORDER BY version').all(),
    tables:Object.fromEntries(tables.map(name=>[name,db.prepare(`SELECT rowid AS retained_rowid,* FROM main.${quote(name)} ORDER BY rowid`).all()])),
    columns:Object.fromEntries(tables.map(name=>[name,db.prepare(`PRAGMA main.table_info(${quote(name)})`).all().map(row=>String(row.name))]))};
}

function fixture(t:TestContext,version:Version=8,{token='current'}:{token?:'current'|'unknown'|'different'}={}){
  const root=mkdtempSync(path.join(realpathSync(tmpdir()),'mioon-s8-history-upgrade-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const projectFile=path.join(root,'movie.mioon'),projectId=createProjectFile(projectFile);
  const localDir=path.join(root,'records'),cacheDir=path.join(root,'cache'),tempDir=path.join(root,'tmp');
  for(const directory of [localDir,cacheDir,tempDir])mkdirSync(directory,{mode:0o700});
  const project=new DatabaseSync(projectFile);let stamp:{contentSequence:number;contentToken:string};
  try{
    project.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'S8 retained movie',revision:1}));
    stamp=project.prepare('SELECT contentSequence,contentToken FROM project_file').get() as typeof stamp;
  }finally{project.close();}
  const cache=new DatabaseSync(path.join(cacheDir,'cache.db'));
  try{cache.exec('BEGIN');buildDatabase(cache,'cache','main');cache.exec('COMMIT');}finally{cache.close();}
  const historyFile=path.join(localDir,'history.db'),db=new DatabaseSync(historyFile),at='2026-11-04T00:00:00.000Z';
  try{
    db.exec('PRAGMA foreign_keys=ON;PRAGMA recursive_triggers=ON;BEGIN');buildPreviousHistoryDatabase(db,version);
    if(version>=6)db.exec('INSERT INTO mio_storage_counters VALUES(1,0,1)');
    if(version===8)db.prepare('INSERT INTO history_state VALUES(1,?,?,?)').run(projectId,stamp.contentSequence,token==='unknown'?null:token==='different'?(stamp.contentToken==='a'.repeat(32)?'b':'a').repeat(32):stamp.contentToken);
    else db.prepare('INSERT INTO history_state VALUES(1,?,?)').run(projectId,stamp.contentSequence);
    const runId=randomUUID(),stepId=randomUUID();
    if(version===2){
      db.prepare('INSERT INTO agent_task_runs_v2 VALUES(?,?,?,?,?,?,?)').run(runId,projectId,randomUUID(),'a'.repeat(64),'completed',1,JSON.stringify({conversationId:randomUUID(),notes:[],skippedTargets:[]}));
      db.prepare('INSERT INTO agent_task_steps_v2 VALUES(?,?,?,?,?,?)').run(stepId,runId,projectId,1,'completed','{}');
      db.prepare('INSERT INTO agent_task_changes_v2 VALUES(?,?,?,?,?)').run(randomUUID(),runId,stepId,projectId,'{"undo":"pre-release"}');
    }else{
      const blobHash=hash('{}'),conversationId=randomUUID(),requestId=randomUUID(),body='{"retained":"原始请求🙂"}';
      db.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run(blobHash,2,'{}',at);
      db.prepare('INSERT INTO mio_conversations VALUES(?,?,?,?)').run(conversationId,projectId,at,at);
      db.prepare('INSERT INTO mio_runs(id,projectId,conversationId,requestId,digest,status,revision,stepLimit,budget,stepsUsed,locale,usageSummary,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(runId,projectId,conversationId,randomUUID(),'a'.repeat(64),'interrupted',3,30,30,1,'en','{"retained":true}',at,at);
      db.prepare('INSERT INTO mio_steps(id,runId,projectId,position,kind,status,createdAt,updatedAt,partialText) VALUES(?,?,?,1,?,?,?,?,?)').run(stepId,runId,projectId,'model','intent',at,at,'retained partial🙂');
      const manifest=JSON.stringify({version:1,entryIds:[],noteEntryIds:[],configurationBlobHash:blobHash,toolsBlobHash:blobHash,systemBlobHash:blobHash,baselineBlobHash:blobHash,rulesBlobHash:null,parameters:{},viewVersion:1});
      db.prepare('INSERT INTO mio_requests(id,stepId,assemblyNumber,assemblerVersion,protocol,bodySha256,bodyBytes,state,originalBody,inputManifest,assembledAt,assemblyReason) VALUES(?,?,1,1,?,?,?,?,?,?,?,?)')
        .run(requestId,stepId,'responses',hash(body),Buffer.byteLength(body),'intent',body,manifest,at,'initial');
      db.prepare("UPDATE mio_requests SET state='dispatch_started',dispatchStartedAt=? WHERE id=?").run(at,requestId);
      db.prepare("UPDATE mio_requests SET state='unknown',completedAt=? WHERE id=?").run(at,requestId);
      db.prepare("UPDATE mio_steps SET status='unknown',currentRequestId=? WHERE id=?").run(requestId,stepId);
    }
    db.prepare('INSERT INTO idempotency VALUES(?,?,?,?)').run('s8-retained','opaque-key','opaque-hash','original-resource');
    db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(randomUUID(),projectId,'{"status":"running","retained":"exact bytes"}');
    db.prepare('INSERT INTO timeline_history_cursors VALUES(?,?)').run(projectId,7);
    if(version>=6){
      const raw=Buffer.from('{"frozen":"version/blob原字节"}'),payload=gzipSync(raw),digest=hash(raw);
      db.prepare("INSERT INTO project_version_blobs VALUES(?,1,'gzip',?,?,?)").run(digest,raw.length,payload.length,payload);
      db.prepare("INSERT INTO project_versions(rowid,id,projectId,trigger,name,mioRunId,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(17,?,?,'manual','retained',NULL,?,?,?,9)").run(randomUUID(),projectId,stamp.contentSequence,at,digest);
      db.prepare("INSERT INTO project_versions(rowid,id,projectId,trigger,name,mioRunId,contentSequence,createdAt,blobHash,mioChangeRowid) VALUES(43,?,?,'mio-turn',NULL,?,?,?,?,9)").run(randomUUID(),projectId,runId,stamp.contentSequence,at,digest);
      db.prepare("INSERT INTO project_version_requests VALUES(?,?,'project.version.save',?,?)").run(projectId,randomUUID(),'a'.repeat(64),'{"retained":"回执原字节"}');
      db.prepare("INSERT INTO project_version_capture_marks VALUES(?,'daily-open','2026-11-04|UTC',?)").run(projectId,at);
    }
    db.exec('COMMIT');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
  const oldJson=Object.fromEntries(['local-drafts-v1.json','local-delivery-v1.json','local-shot-text-v1.json'].map((name,index)=>{
    const bytes=index===0?Buffer.from('{'):index===1?Buffer.from([0xff]):Buffer.from('{"version":999,"entries":[]}');
    const file=path.join(localDir,name);writeFileSync(file,bytes,{mode:0o600});return [file,bytes];
  }));
  const inspect=()=>{const current=new DatabaseSync(historyFile);try{return readAll(current);}finally{current.close();}};
  const files=()=>({project:hash(readFileSync(projectFile)),cache:hash(readFileSync(path.join(cacheDir,'cache.db'))),json:Object.fromEntries(Object.keys(oldJson).map(file=>[file,hash(readFileSync(file))]))});
  const open=()=>openProjectConnection({projectFile,locate:()=>({localDir,cacheDir,tempDir})});
  return {root,projectFile,projectId,localDir,cacheDir,tempDir,historyFile,inspect,files,open,oldJson};
}

function retained(before:ReturnType<typeof readAll>,db:DatabaseSync,version:Version):void{
  for(const [name,rows] of Object.entries(before.tables)){
    if(name==='schema_version'||version===2&&LEGACY_MIO_TABLES.includes(name))continue;
    const columns=before.columns[name]!.map(quote).join(',');
    assert.deepEqual(db.prepare(`SELECT rowid AS retained_rowid,${columns} FROM main.${quote(name)} ORDER BY rowid`).all(),rows,`${name}: original columns, rowids and bytes are retained`);
  }
}
function emptyDrafts(db:DatabaseSync):void{
  for(const table of DRAFT_TABLES)assert.equal(db.prepare(`SELECT count(*) n FROM main.${table}`).get()!.n,0);
}

for(const [version,manifest] of OLD)test(`history ${version} frozen source is exact and upgrades to10 with empty drafts and original admission`,t=>{
  const f=fixture(t,version),before=f.inspect(),files=f.files();assert.deepEqual(before.manifest,manifest.entries);
  const connection=f.open();
  try{
    assert.equal(HISTORY_SCHEMA_VERSION,10);assert.equal(connection.db.prepare('SELECT version FROM main.schema_version').get()!.version,10);
    assert.deepEqual(readSchemaManifest(connection.db,'main'),SCHEMA_MANIFEST.history.entries);retained(before,connection.db,version);emptyDrafts(connection.db);
    assert.equal(connection.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys,1);assert.deepEqual(connection.db.prepare('PRAGMA main.foreign_key_check').all(),[]);
    assert.equal(connection.historyState,version===8?'current':'diverged');
    if(version<8){assert.equal(connection.historyAdmission.reason,'legacy-token-missing');assert.equal(connection.historyAdmission.seen.contentToken,null);assert.equal(connection.db.prepare('PRAGMA query_only').get()!.query_only,1);}
    if(version===2){for(const table of LEGACY_MIO_TABLES)assert.equal(connection.db.prepare('SELECT 1 FROM main.sqlite_schema WHERE name=?').get(table),undefined);assert.equal(connection.db.prepare('SELECT count(*) n FROM main.mio_runs').get()!.n,0);}
  }finally{connection.close();}
  assert.deepEqual(f.files(),files,'project/cache/retired JSON stay byte-exact');const upgraded=f.inspect();const reopened=f.open();reopened.close();assert.deepEqual(f.inspect(),upgraded,'current10 reopen performs no migration or repair');
});

for(const token of ['unknown','different'] as const)test(`history8 ${token} token remains diverged after adding drafts, without guessing a new pair`,t=>{
  const f=fixture(t,8,{token}),before=f.inspect(),connection=f.open();
  try{assert.equal(connection.historyState,'diverged');assert.equal(connection.historyAdmission.reason,token==='unknown'?'legacy-token-missing':'content-token-different');retained(before,connection.db,8);emptyDrafts(connection.db);assert.equal(connection.db.prepare('PRAGMA query_only').get()!.query_only,1);}finally{connection.close();}
});

test('history8 writes schema_version10 exactly once, after all draft objects in the same opening transaction',t=>{
  const f=fixture(t),exec=DatabaseSync.prototype.exec,writes:{sql:string;transaction:boolean;version:unknown}[]=[];
  const mock=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string):void{
    if(/^CREATE (?:TABLE|(?:UNIQUE )?INDEX|TRIGGER) main\.local_/u.test(sql)||/^UPDATE main\.schema_version SET version=/u.test(sql))writes.push({sql,transaction:this.isTransaction,version:this.prepare('SELECT version FROM main.schema_version').get()!.version});
    exec.call(this,sql);
  });
  try{const connection=f.open();connection.close();}finally{mock.mock.restore();}
  assert.equal(writes.filter(row=>row.sql===FINAL_VERSION).length,1);assert.ok(writes.length>4);assert.equal(writes.at(-1)!.sql,FINAL_VERSION);assert.ok(writes.every(row=>row.transaction&&row.version===8));
});

const FAILURE_POINTS=['after-state-table','after-clip-table','after-delivery-table','after-shot-table','after-index','after-trigger','before-version','after-version'] as const;
function hit(point:string,sql:string):boolean{
  if(point==='before-version'||point==='after-version')return sql===FINAL_VERSION;
  if(point==='after-index')return /^CREATE (?:UNIQUE )?INDEX main\.local_/u.test(sql);
  if(point==='after-trigger')return /^CREATE TRIGGER main\.local_/u.test(sql);
  const tables:Readonly<Record<string,string>>={'after-state-table':'local_draft_states','after-clip-table':'local_clip_drafts','after-delivery-table':'local_delivery_drafts','after-shot-table':'local_shot_text_drafts'};const table=tables[point];
  return table!==undefined&&sql.startsWith(`CREATE TABLE main.${table}(`);
}
for(const point of FAILURE_POINTS)test(`history8 exception ${point} rolls back every draft object, version and retained row`,t=>{
  const f=fixture(t),before=f.inspect(),files=f.files(),exec=DatabaseSync.prototype.exec;let reached=false;
  const mock=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string):void{
    if(point==='before-version'&&hit(point,sql)){reached=true;throw Error('S8 injected pre-version failure');}
    exec.call(this,sql);if(point!=='before-version'&&hit(point,sql)){reached=true;throw Error('S8 injected upgrade failure');}
  });
  try{assert.throws(()=>f.open(),{code:'PROJECT_INVALID'});assert.equal(reached,true);}finally{mock.mock.restore();}
  assert.deepEqual(f.inspect(),before);assert.deepEqual(f.files(),files);const connection=f.open();emptyDrafts(connection.db);connection.close();
});

for(const damage of ['extra-object','missing-index','changed-trigger','extra-version','format1','future','v8-labelled7','v8-labelled9','wrong-app-id','invalid-seen','invalid-seen-fraction','invalid-token','same-token-different-sequence'] as const)test(`history8 rejects ${damage} without schema/data/source changes`,t=>{
  const f=fixture(t),db=new DatabaseSync(f.historyFile);
  try{
    if(damage==='extra-object')db.exec('CREATE TABLE s8_unreviewed_extension(value TEXT)');
    else if(damage==='missing-index')db.exec('DROP INDEX project_versions_page');
    else if(damage==='changed-trigger')db.exec('DROP TRIGGER immutable_mio_blobs;CREATE TRIGGER immutable_mio_blobs BEFORE UPDATE ON mio_blobs BEGIN SELECT 1;END');
    else if(damage==='extra-version')db.exec('INSERT INTO schema_version VALUES(7)');
    else if(damage==='wrong-app-id')db.exec('PRAGMA application_id=1');
    else if(damage==='invalid-seen')db.exec('PRAGMA ignore_check_constraints=ON;UPDATE history_state SET seenContentSequence=-1');
    else if(damage==='invalid-seen-fraction')db.exec('PRAGMA ignore_check_constraints=ON;UPDATE history_state SET seenContentSequence=0.25');
    else if(damage==='same-token-different-sequence')db.exec('UPDATE history_state SET seenContentSequence=seenContentSequence+1');
    else if(damage==='invalid-token')db.exec("PRAGMA ignore_check_constraints=ON;UPDATE history_state SET seenContentToken='broken'");
    else db.prepare('UPDATE schema_version SET version=?').run(damage==='format1'?1:damage==='future'?HISTORY_SCHEMA_VERSION+1:damage==='v8-labelled7'?7:9);
  }finally{db.close();}
  const before=f.inspect(),files=f.files(),history=hash(readFileSync(f.historyFile));
  assert.throws(()=>f.open(),{code:damage==='future'?'PROJECT_FORMAT_NEWER':'PROJECT_INVALID'});
  assert.deepEqual(f.inspect(),before);assert.deepEqual(f.files(),files);assert.equal(hash(readFileSync(f.historyFile)),history);
});

for(const point of ['after-state-table','after-delivery-table','after-shot-table','before-version','after-version','after-commit'] as const)test(`history8 SIGKILL ${point} recovers one entire old8 or committed10 profile`,{timeout:60000},t=>{
  const f=fixture(t),before=f.inspect(),files=f.files(),result=spawnSync(process.execPath,[WORKER,JSON.stringify({projectFile:f.projectFile,localDir:f.localDir,cacheDir:f.cacheDir,tempDir:f.tempDir,point})],{env: testEnv(), stdio:'ignore',timeout:30000});
  assert.equal(result.error,undefined);assert.equal(result.signal,'SIGKILL');const recovered=f.inspect();
  if(point==='after-commit'){
    assert.deepEqual(recovered.manifest,SCHEMA_MANIFEST.history.entries);assert.equal(recovered.version.length,1);assert.equal(recovered.version[0]!.version,10);
    const db=new DatabaseSync(f.historyFile);try{retained(before,db,8);emptyDrafts(db);}finally{db.close();}
  }else assert.deepEqual(recovered,before);
  assert.deepEqual(f.files(),files);const connection=f.open();emptyDrafts(connection.db);connection.close();assert.equal(f.inspect().version[0]!.version,10);
});


test('a reported failure after the upgrade COMMIT leaves complete10, never a partial profile or a false rollback claim',t=>{
  const f=fixture(t),before=f.inspect(),files=f.files(),exec=DatabaseSync.prototype.exec;let upgrading=false,reached=false;
  const mock=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string):void{
    exec.call(this,sql);if(sql.startsWith('CREATE TABLE main.local_draft_states('))upgrading=true;
    if(upgrading&&sql==='COMMIT'){reached=true;throw Error('S8 lost open acknowledgement after COMMIT');}
  });
  try{assert.throws(()=>f.open(),{code:'PROJECT_INVALID'});assert.equal(reached,true);}finally{mock.mock.restore();}
  const db=new DatabaseSync(f.historyFile);try{assert.equal(db.prepare('SELECT version FROM schema_version').get()!.version,10);assert.deepEqual(readSchemaManifest(db,'main'),SCHEMA_MANIFEST.history.entries);retained(before,db,8);emptyDrafts(db);}finally{db.close();}
  assert.deepEqual(f.files(),files);const connection=f.open();emptyDrafts(connection.db);connection.close();
});
