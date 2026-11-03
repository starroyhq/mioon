import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {readMioStorage} from '../packages/business/src/agent/mio-storage.ts';
import {validateAgentTaskRowsV2} from '../packages/business/src/agent/task-schema-v2.ts';
import {startServer,type InspectProject,type InspectApplication} from '../apps/server/src/index.ts';
import {createServerProject} from './helpers/project-database.ts';
import {snapshot} from './helpers/current-retained-fixture.ts';
import {projectRpcPath} from '../packages/contracts/src/project-file.ts';
const limit=256*1024*1024;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function temporary(t:TestContext){const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-native-quota-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function current(t:TestContext){
 const root=temporary(t),store=openStore(root),journal=createAgentTaskJournal(store),projectId=store.projectId;
 t.after(()=>store.close());store.put('projects',{id:projectId,name:'Current journal quota',revision:1});
 const run=journal.create({projectId,requestId:randomUUID(),text:'Storage integrity',configuration:{protocol:'chat_completions',model:'synthetic'}}).run;
 return {root,store,journal,run,projectId};
}
test('native Mio admits history above64MiB, atomically rejects above256MiB and retains its 65536-row limit',t=>{
 const f=current(t),db=f.store.db,at='2026-10-24T00:00:00.000Z';
 const insert=(body:string)=>db.prepare('INSERT INTO mio_blobs(sha256,bytes,content,createdAt) VALUES(?,?,?,?)').run(sha(body),Buffer.byteLength(body),body,at);
 f.store.tx(()=>{for(let index=0;index<128;index++)insert(String(index).padStart(4,'0')+'x'.repeat(2*1024*1024-4100));});
 // Leave one KiB below the exact native quota, including scalar identities.
 const beforeTail=readMioStorage(db),tailBytes=beforeTail.remaining.bytes-88-1024;
 assert.ok(tailBytes>0&&tailBytes<2*1024*1024);f.store.tx(()=>insert('t'.repeat(tailBytes)));
 const before=readMioStorage(db);assert.ok(before.usage.bytes>64*1024*1024&&before.usage.bytes<limit);validateAgentTaskRowsV2(db);
 const count=db.prepare('SELECT count(*) AS n FROM mio_blobs').get()!.n,revision=f.journal.run(f.run.id).revision;
 assert.throws(()=>f.store.tx(()=>{db.prepare('UPDATE mio_runs SET revision=revision+1 WHERE id=?').run(f.run.id);insert('overflow'+'x'.repeat(2*1024*1024-4104));}),/AGENT_TASK_STORAGE_LIMIT/u);
 assert.equal(db.prepare('SELECT count(*) AS n FROM mio_blobs').get()!.n,count);assert.equal(f.journal.run(f.run.id).revision,revision);assert.equal(f.journal.run(f.run.id).text,'Storage integrity');assert.deepEqual(readMioStorage(db),before);
 const triggers=db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='trigger' AND name GLOB 'quota_mio_*'").all();
 assert.ok(triggers.length>20);assert.ok(triggers.some(row=>String(row.sql).includes('268435456')&&String(row.sql).includes('65536')));
 const ownerId=randomUUID(),targets=Array.from({length:100},()=>({kind:'shot',id:randomUUID(),revision:0}));
 for(let sequence=1;sequence<=24;sequence++)f.journal.edit({requestId:randomUUID(),projectId:f.projectId,ownerId,generation:1,sequence,action:sequence===1?'claim':'heartbeat',targets});
 const manual=readMioStorage(db),manualBytes=Number(db.prepare('SELECT sum(length(CAST(data AS BLOB))) AS bytes FROM mio_edit_receipts').get()!.bytes);
 assert.ok(before.usage.bytes+manualBytes>limit);assert.equal(manual.retained.rows-manual.usage.rows,24);validateAgentTaskRowsV2(db);
 // Row-only bookkeeping remains admitted when byte quota is full, while the
 // next execution row is rejected at the exact current row boundary.
 f.store.tx(()=>{const write=db.prepare('INSERT INTO mio_process_target_revisions VALUES(?,?,?,1)');for(let index=manual.usage.rows;index<65536;index++)write.run(f.projectId,'job',String(index));});
 const full=readMioStorage(db);assert.equal(full.usage.rows,65536);assert.equal(full.status,'full');assert.equal(full.remaining.rows,0);
 assert.throws(()=>f.store.tx(()=>db.prepare('INSERT INTO mio_conversations VALUES(?,?,?,?)').run(randomUUID(),f.projectId,at,at)),/AGENT_TASK_STORAGE_LIMIT/u);assert.deepEqual(readMioStorage(db),full);
 f.store.close();const reopened=openStore(f.root);try{createAgentTaskJournal(reopened);validateAgentTaskRowsV2(reopened.db);assert.deepEqual(readMioStorage(reopened.db),full);}finally{reopened.close();}
});
function audit(db:DatabaseSync){return {state:snapshot(db),marks:db.prepare('SELECT total_changes() AS changes').get(),versions:db.prepare('PRAGMA database_list').all().filter(row=>row.name!=='temp').map(row=>({name:row.name,version:db.prepare(`PRAGMA "${String(row.name)}".data_version`).get()}))};}
test('terminal native Mio data stays isolated when application project deletion is unavailable',async t=>{
 const root=temporary(t),projects=[] as {projectId:string;runId:string}[];
 for(const name of ['Retained A','Retained B']){
  const f=createServerProject(root,{name}),journal=createAgentTaskJournal(f.store);
  try{
   const run=journal.create({projectId:f.projectId,requestId:randomUUID(),text:name,configuration:{protocol:'chat_completions',model:'synthetic'}}).run;
   const model=journal.beginModelStep(run.id,{request:{body:JSON.stringify({model:'synthetic',stream:true,messages:[]}),history:[]}},[]);journal.markDispatch(run.id,model.id);journal.completeStep(run.id,model.id,{result:{text:'Local finish',toolCalls:[],providerOutput:{role:'assistant',content:'Local finish'}}});journal.transition(run.id,journal.run(run.id).revision,'completed');projects.push({projectId:f.projectId,runId:run.id});
  }finally{f.store.close();}
 }
 let inspect!:InspectProject,application!:InspectApplication;
 const token='native-quota-retirement-test',server=await startServer({dataDir:root,port:0,token,inspectProject:value=>{inspect=value;},inspectApplication:value=>{application=value;}});t.after(()=>server.close());
 const rpc=(url:string,operation:string,input:unknown)=>fetch(server.url+url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation,input})});
 for(const item of projects){const response=await rpc(projectRpcPath(item.projectId),'project.inspect',{projectId:item.projectId});assert.equal(response.status,200);await response.arrayBuffer();}
 const before=await Promise.all(projects.map(item=>inspect(item.projectId,audit))),appBefore=application(audit);
 assert.notDeepEqual(before[0]!.state.tables.mio_entries,before[1]!.state.tables.mio_entries);
 const response=await rpc('/api/rpc','project.delete',{requestId:randomUUID(),projectId:projects[0]!.projectId,expectedRevision:1,confirmPermanentDeletion:true}),body=await response.json() as {error?:{code?:string}};
 assert.equal(response.status,409);assert.equal(body.error?.code,'PROJECT_DELETE_UNAVAILABLE');
 for(const [index,item]of projects.entries()){
  assert.deepEqual(await inspect(item.projectId,audit),before[index]);
  assert.equal(await inspect(item.projectId,db=>Number(db.prepare('SELECT count(*) AS n FROM mio_runs WHERE id=?').get(item.runId)!.n)),1);
 }
 assert.deepEqual(application(audit),appBefore);
});
