













import test from 'node:test';


import assert from 'node:assert/strict';

import {randomUUID} from 'node:crypto';



import {insert, imageFixture} from './images-fixture.mjs';
import {withoutForeignKeys} from './helpers/project-database.ts';


import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
const rows=(db: DatabaseSync,table: SQLOutputValue)=>db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();








test('new image identities resist updates, delete and INSERT OR REPLACE and dispatch fence never resets',t=>{
 const f=imageFixture(t),{db}=f;f.succeed();
 withoutForeignKeys(db,()=>{for(const table of ['image_groups','image_tasks','image_versions','image_requests']){
  assert.throws(()=>db.exec(`DELETE FROM ${table}`),/retained/);
  const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(row=>row.name).join(',');assert.throws(()=>db.exec(`INSERT OR REPLACE INTO ${table}(${columns}) SELECT ${columns} FROM ${table}`),/immutable|replaced|number must advance/);
 }});
 assert.throws(()=>db.exec('UPDATE image_versions SET data=data'),/immutable/);assert.throws(()=>db.exec('UPDATE image_requests SET response=response'),/immutable/);
 assert.throws(()=>db.exec("UPDATE image_tasks SET state='queued',dispatched=0,revision=revision+1"),/immutable|transition/);
 assert.throws(()=>db.exec("UPDATE image_tasks SET snapshot='{}',revision=revision+1"),/immutable|transition/);
 assert.throws(()=>db.exec("UPDATE image_groups SET name='changed',revision=revision+1"),/immutable/);
 const frozen=rows(db,'image_requests');assert.equal(JSON.parse(frozen[0].response as string).state,'queued');assert.equal(JSON.parse(frozen[0].response as string).revision,1);
});



test('interruption and unknown results keep fences and permit only explicit local-result recovery',t=>{
 const f=imageFixture(t),{db}=f;
 db.prepare("UPDATE image_tasks SET state='interrupted_before_dispatch',revision=2 WHERE id=?").run(f.taskId);
 assert.throws(()=>db.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=3 WHERE id=?").run(f.taskId),/transition/);
 db.prepare("UPDATE image_tasks SET state='cancelled_before_dispatch',revision=3 WHERE id=?").run(f.taskId);
 assert.throws(()=>db.prepare("UPDATE image_tasks SET state='queued',revision=4 WHERE id=?").run(f.taskId),/transition/);
 const g=imageFixture(t),d=g.db;
 d.prepare("UPDATE image_tasks SET state='dispatching',dispatched=1,revision=2 WHERE id=?").run(g.taskId);
 d.prepare("UPDATE image_tasks SET state='outcome_unknown',revision=3 WHERE id=?").run(g.taskId);
 assert.throws(()=>d.prepare("UPDATE image_tasks SET state='queued',dispatched=0,revision=4 WHERE id=?").run(g.taskId),/immutable|transition/);
 assert.throws(()=>d.prepare("UPDATE image_tasks SET state='persisting',revision=4 WHERE id=?").run(g.taskId),/CHECK constraint/);
 d.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=4 WHERE id=?").run(JSON.stringify(g.receipt),g.taskId);
 d.prepare("UPDATE image_tasks SET state='local_result_error',revision=5 WHERE id=?").run(g.taskId);
 assert.throws(()=>d.prepare("UPDATE image_tasks SET state='persisting',stagedReceipt=?,revision=6 WHERE id=?").run(JSON.stringify({...g.receipt,sha256:'b'.repeat(64)}),g.taskId),/immutable/);
 d.prepare("UPDATE image_tasks SET state='persisting',revision=6 WHERE id=?").run(g.taskId);
});

test('one unresolved task occupies its group and published head cannot be erased',t=>{
 const f=imageFixture(t),{db}=f,row=db.prepare('SELECT * FROM image_tasks').get(),id=randomUUID(),requestId=randomUUID();
 assert.throws(()=>insert(db,'image_tasks',{...row,id,requestId,input:JSON.stringify({...f.input,requestId}),snapshot:JSON.stringify({...f.snapshot,taskId:id})}),/UNIQUE constraint/);
 f.succeed();assert.throws(()=>db.exec('UPDATE image_groups SET headVersionId=NULL,revision=revision+1'),/head must advance/);
});
