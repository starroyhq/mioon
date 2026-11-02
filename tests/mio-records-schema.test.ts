import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {HISTORY_TABLES_BY_DOMAIN,LEGACY_MIO_TABLES} from '../packages/business/src/project-file/schema/tables.ts';
import {MIO_STORAGE_LIMITS,MIO_QUOTA_BYTES_SQL,MIO_QUOTA_ROWS_SQL} from '../packages/business/src/project-file/schema/domains/mio.ts';

const date='2026-11-02T00:00:00.000Z';
const digest=(text:string):string=>createHash('sha256').update(text).digest('hex');
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mio-schema-'))),store=openStore(root),db=store.db,projectId=store.projectId;
 store.tx(()=>db.prepare('INSERT INTO project.projects(id,data) VALUES(?,?)').run(projectId,'{}'));
 const conversationId=randomUUID();
 store.tx(()=>db.prepare('INSERT INTO mio_conversations VALUES(?,?,?,?)').run(conversationId,projectId,date,date));
 function run(){const id=randomUUID();store.tx(()=>db.prepare('INSERT INTO mio_runs(id,projectId,conversationId,requestId,digest,status,revision,stepLimit,budget,stepsUsed,locale,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,conversationId,randomUUID(),'a'.repeat(64),'running',1,30,30,0,'en',date,date));return id;}
 function entry(runId:string,kind='model_output'){const id=randomUUID();store.tx(()=>db.prepare('INSERT INTO mio_entries(id,projectId,conversationId,runId,sequence,kind,payloadJson,createdAt) VALUES(?,?,?,?,?,?,?,?)').run(id,projectId,conversationId,runId,1,kind,'{}',date));return id;}
 function step(runId:string){const id=randomUUID();store.tx(()=>db.prepare('INSERT INTO mio_steps(id,runId,projectId,position,kind,status,createdAt,updatedAt) VALUES(?,?,?,1,?,?,?,?)').run(id,runId,projectId,'model','intent',date,date));return id;}
 return{store,db,projectId,conversationId,run,entry,step,close(){store.close();rmSync(root,{recursive:true,force:true});}};
}

test('K1 creates exactly eighteen new Mio tables and ordinary process revision triggers',()=>{
 const f=fixture();try{
  const tables=f.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name GLOB 'mio_*' ORDER BY name").all().map(r=>String(r.name));
  assert.deepEqual(tables,[...HISTORY_TABLES_BY_DOMAIN.mio].sort());assert.equal(tables.length,18);
  for(const name of LEGACY_MIO_TABLES)assert.equal(f.db.prepare('SELECT 1 FROM main.sqlite_master WHERE name=?').get(name),undefined);
  const process=f.db.prepare("SELECT name,sql FROM main.sqlite_master WHERE type='trigger' AND name GLOB 'agent_target_*_v2'").all();
  assert.equal(process.length,12);assert.ok(process.every(r=>String(r.sql).includes('mio_process_target_revisions')&&!String(r.sql).includes('project.')));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM temp.sqlite_master WHERE name GLOB 'agent_target_*_v2'").get()?.n,0);
  assert.equal(f.db.prepare('SELECT version FROM main.schema_version').get()?.version,3);
 }finally{f.close();}
});

test('entries and blobs retain one immutable source and reject foreign ownership',()=>{
 const f=fixture();try{
  const run=f.run(),other=f.run(),entry=f.entry(run),content='规范\r\ntext',sha=digest(content);
  f.store.tx(()=>f.db.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run(sha,Buffer.byteLength(content),content,date));
  assert.throws(()=>f.store.tx(()=>f.db.prepare('UPDATE mio_blobs SET content=? WHERE sha256=?').run('changed',sha)),/immutable/);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('DELETE FROM mio_entries WHERE id=?').run(entry)),/retained/);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('UPDATE mio_entries SET payloadJson=? WHERE id=?').run('{"changed":true}',entry)),/immutable/);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('INSERT INTO mio_steps(id,runId,projectId,position,kind,status,createdAt,updatedAt,sourceEntryId,sourceCallIndex) VALUES(?,?,?,1,?,?,?,?,?,0)').run(randomUUID(),other,f.projectId,'tool','intent',date,date,entry)),/source|FOREIGN KEY/);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run('b'.repeat(64),1,content,date)),/CHECK/);
  const tooLarge='x'.repeat(MIO_STORAGE_LIMITS.rowBytes+1);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run(digest(tooLarge),Buffer.byteLength(tooLarge),tooLarge,date)),/CHECK|AGENT_TASK_STORAGE_LIMIT/);
  assert.throws(()=>f.store.tx(()=>f.db.prepare("UPDATE mio_runs SET status='unbounded-state' WHERE id=?").run(run)),/CHECK/);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('INSERT INTO mio_entries(id,projectId,conversationId,runId,sequence,kind,payloadJson,createdAt) VALUES(?,?,?,?,2,?,?,?)').run(randomUUID(),f.projectId,f.conversationId,run,'arbitrary_kind','{}',date)),/CHECK/);
 }finally{f.close();}
});

test('raw requests cannot be edited, cleared before completion or returned to an unsent state',()=>{
 const f=fixture();try{
  const run=f.run(),step=f.step(run),request=randomUUID(),body='{"messages":[]}';
  f.store.tx(()=>{f.db.prepare('INSERT INTO mio_requests(id,stepId,assemblyNumber,assemblerVersion,protocol,bodySha256,bodyBytes,state,originalBody,inputManifest,assembledAt,assemblyReason) VALUES(?,?,1,1,?,?,?,?,?,?,?,?)').run(request,step,'responses',digest(body),Buffer.byteLength(body),'intent',body,'{}',date,'initial');f.db.prepare('UPDATE mio_steps SET currentRequestId=? WHERE id=?').run(request,step);});
  assert.throws(()=>f.store.tx(()=>f.db.prepare('UPDATE mio_requests SET originalBody=NULL WHERE id=?').run(request)),/completion/);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('UPDATE mio_requests SET bodySha256=? WHERE id=?').run('b'.repeat(64),request)),/immutable/);
  f.store.tx(()=>f.db.prepare("UPDATE mio_requests SET state='dispatch_started',dispatchStartedAt=? WHERE id=?").run(date,request));
  assert.throws(()=>f.store.tx(()=>f.db.prepare("UPDATE mio_requests SET state='intent' WHERE id=?").run(request)),/replayed/);
  f.store.tx(()=>{f.db.prepare("UPDATE mio_steps SET status='completed' WHERE id=?").run(step);f.db.prepare("UPDATE mio_requests SET state='completed',completedAt=?,originalBody=NULL WHERE id=?").run(date,request);});
  assert.equal(f.db.prepare('SELECT originalBody FROM mio_requests WHERE id=?').get(request)?.originalBody,null);
  assert.throws(()=>f.store.tx(()=>f.db.prepare('UPDATE mio_requests SET originalBody=? WHERE id=?').run(body,request)),/completion/);
  assert.equal(f.db.prepare('SELECT bodySha256 FROM mio_requests WHERE id=?').get(request)?.bodySha256,digest(body));
 }finally{f.close();}
});

test('quota totals include unique blobs and local process bookkeeping without touching project content',()=>{
 const f=fixture();try{
  const before=f.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence;
  f.store.tx(()=>f.db.prepare('INSERT INTO jobs(id,projectId,data) VALUES(?,?,?)').run(randomUUID(),f.projectId,'{}'));
  assert.equal(f.db.prepare('SELECT contentSequence FROM project.project_file').get()?.contentSequence,before);
  const initial=Number(f.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes`).get()?.bytes);
  const content='shared content',sha=digest(content);
  f.store.tx(()=>f.db.prepare('INSERT INTO mio_blobs VALUES(?,?,?,?)').run(sha,Buffer.byteLength(content),content,date));
  const after=Number(f.db.prepare(`SELECT ${MIO_QUOTA_BYTES_SQL} AS bytes`).get()?.bytes);
  assert.equal(after-initial,Buffer.byteLength(sha+content+date));
  assert.equal(f.db.prepare(`SELECT ${MIO_QUOTA_ROWS_SQL} AS rows`).get()?.rows,3);
 }finally{f.close();}
});
