import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {kernelFixture,snapshot,insert,probe} from './helpers/current-retained-fixture.ts';
const operations=['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.rippleRemove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','timeline.format.set','subject.create','subject.version.add','subject.binding.set','timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove','timeline.loudness.apply'] as const;
function task(db:DatabaseSync,{operation='timeline.loudness.apply'}={}) {
 const projectId=db.prepare('SELECT id FROM projects').get()!.id as string,requestId=randomUUID();
 return {position:null,id:randomUUID(),projectId,operation,input:JSON.stringify({projectId,requestId,expectedRevision:1}),requestId,digest:'a'.repeat(64),lane:operation.startsWith('timeline.')?'timeline:mutation':operation.startsWith('reference.')?'reference:mutation':'subject:mutation',origin:'new',status:'prepared',revision:1,acknowledged:0,claim:null,claimInstance:null,receiptDigest:null,errorCode:null,createdAt:'at',updatedAt:'later',bytes:16384};
}
test('current kernel keeps lane uniqueness, immutable identity, state machine, input bounds and FK constraints', t => {
  const db = kernelFixture(t).store.db; const before = snapshot(db);
  for (const operation of operations) probe(db, () => insert(db, 'edit_tasks', task(db, {operation})));
  for (const patch of [{lane:'reference:mutation'},{lane:'subject:mutation'},{bytes:16383},{revision:0},{revision:1.5},{acknowledged:1},{input:'[]'},{input:'broken'},{input:'{"padding":"'+'x'.repeat(8192)+'"}'},{status:'dispatching',claim:null},{status:'applied',receiptDigest:null},{status:'not_applied',errorCode:null}] as const) {
    probe(db, () => assert.throws(() => insert(db, 'edit_tasks', {...task(db), ...patch}), /CHECK/));
  }
  probe(db, () => {
    const value = task(db); insert(db, 'edit_tasks', value);
    assert.throws(() => db.prepare('DELETE FROM edit_tasks WHERE id=?').run(value.id), /retained/);
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO edit_tasks SELECT * FROM edit_tasks WHERE id=?').run(value.id), /immutable/);
    assert.throws(() => db.prepare("UPDATE edit_tasks SET input='{}',revision=revision+1 WHERE id=?").run(value.id), /immutable|transition/);
    const requestId = randomUUID(), next = {...value, id:randomUUID(), requestId, input:JSON.stringify({...JSON.parse((value.input as string)), requestId})};
    assert.throws(() => insert(db, 'edit_tasks', next), /UNIQUE/);
    db.prepare("UPDATE edit_tasks SET status='dispatching',revision=revision+1,claim=?,claimInstance=? WHERE id=?").run(randomUUID(), randomUUID(), value.id);
    db.prepare("UPDATE edit_tasks SET status='not_applied',revision=revision+1,errorCode='STALE' WHERE id=?").run(value.id);
    assert.throws(() => db.prepare("UPDATE edit_tasks SET status='unknown',revision=revision+1 WHERE id=?").run(value.id), /transition/);
    db.prepare('UPDATE edit_tasks SET acknowledged=1,revision=revision+1 WHERE id=?').run(value.id);
    insert(db, 'edit_tasks', next);
    assert.throws(() => insert(db, 'edit_tasks', {...task(db), projectId:randomUUID(), input:JSON.stringify({projectId:'missing',requestId:randomUUID()})}), /CHECK|FOREIGN KEY/);
  });
  probe(db, () => {
    const value = task(db), projectId = randomUUID();
    assert.throws(() => insert(db, 'edit_tasks', {...value, projectId, input:JSON.stringify({projectId, requestId:value.requestId})}), /FOREIGN KEY/);
  });
  assert.deepEqual(snapshot(db), before);
});
