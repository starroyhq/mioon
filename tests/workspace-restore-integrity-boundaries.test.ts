import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {TestContext} from 'node:test';
type Loose = Record<string, unknown>;
type Entity = Loose;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {initializeWorkspaceSchema26} from '../packages/business/src/workspace-schema-v26.ts';
import {initializeWorkspaceSchema28} from '../packages/business/src/workspace-schema-v28.ts';
import {initializeWorkspaceSchema30} from '../packages/business/src/workspace-schema-v30.ts';
import {initializeWorkspaceSchema32} from '../packages/business/src/workspace-schema-v32.ts';
import {initializeWorkspaceSchema34} from '../packages/business/src/workspace-schema-v34.ts';
import {initializeWorkspaceSchema36} from '../packages/business/src/workspace-schema-v36.ts';
import {initializeWorkspaceSchema38} from '../packages/business/src/workspace-schema-v38.ts';
import {openStore,getWorkspaceRestoreContext,validateCurrentWorkspaceRestoreSchema} from '../packages/business/src/db.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup,inspectWorkspaceRestorePublication} from '../packages/business/src/workspace-restore.ts';

// No assets, media payload, providers, workers, child processes or transport.
// The fixed initializer's real quota row supplies a genuine captured identity.
const steps = [initializeWorkspaceSchema26,initializeWorkspaceSchema28,initializeWorkspaceSchema30,
  initializeWorkspaceSchema32,initializeWorkspaceSchema34,initializeWorkspaceSchema36,initializeWorkspaceSchema38];
const pairs = [[24,25,0],[26,27,1],[28,29,2],[30,31,3],[32,33,4],[34,35,5],[36,37,6],[38,39,7]];
const quote = (name: string) => '"'+name.replaceAll('"','""')+'"';
const sha = (bytes: Buffer|string) => createHash('sha256').update(bytes).digest('hex');
function tree(root: string): Array<unknown[]> {
  const visit = (relative: string): Array<unknown[]> => {
    const file=path.join(root,relative),info=fs.lstatSync(file);
    return info.isDirectory() ? [[relative,{mode:info.mode}],...fs.readdirSync(file).sort().flatMap((name: string)=>visit(path.join(relative,name)))]
      : [[relative,{mode:info.mode,size:info.size,sha256:sha(fs.readFileSync(file))}]];
  };
  return visit('');
}
function logical(db: DatabaseSync) {
  const objects=db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name').all();
  return {objects,tables:objects.filter((row: Entity)=>row['type']==='table').map((value: unknown)=>{const name=(value as {name: string}).name;
    const statement=db.prepare(`SELECT rowid AS originalRowid,* FROM main.${quote(name)} ORDER BY rowid`);
    statement.setReadBigInts(true);return [name,statement.all()];
  })};
}
async function fixture(t: TestContext,sourceSchema: number,stepCount: number) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'restore-integrity-boundary-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),backup=path.join(root,'backup'),destination=path.join(root,'destination');
  fs.mkdirSync(source,{mode:0o700});
  const db=new DatabaseSync(path.join(source,'workbench.sqlite'));
  try {
    db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');
    initializeWorkspaceSchemaThrough24(db);
    for(const initialize of steps.slice(0,stepCount))initialize(db);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_version').get()!.version,sourceSchema);
  } finally {db.close();}
  fs.chmodSync(path.join(source,'workbench.sqlite'),0o600);
  const sourceBefore=tree(source),created=await createWorkspaceBackup({source,destination:backup});
  assert.equal(created.databaseSchemaVersion,sourceSchema);
  const backupBefore=tree(backup);
  return {root,source,backup,destination,assertOriginals(){assert.deepEqual(tree(source),sourceBefore);assert.deepEqual(tree(backup),backupBefore);}};
}
function corruptCapturedHash(db: DatabaseSync) {
  const trigger='restore_workspace_restore_holds_update';
  const sql=db.prepare('SELECT sql FROM main.sqlite_schema WHERE type=\'trigger\' AND name=?').get(trigger)!.sql as string;
  const before=db.prepare("SELECT rowHash FROM main.workspace_restore_holds WHERE kind='agent_chat_quota' AND id='1'").get();
  assert.ok(before);
  // Offline synthetic corruption only. Restore the exact original guard DDL
  // before any admission call; this is not an application write capability.
  db.exec(`DROP TRIGGER ${quote(trigger)}`);
  try {
    const wrong=before.rowHash==='0'.repeat(64)?'1'.repeat(64):'0'.repeat(64);
    assert.equal(db.prepare("UPDATE main.workspace_restore_holds SET rowHash=? WHERE kind='agent_chat_quota' AND id='1'").run(wrong).changes,1);
  } finally {db.exec(sql);}
  assert.equal(db.prepare('SELECT sql FROM main.sqlite_schema WHERE name=?').get(trigger)!.sql,sql);
}

for(const [sourceSchema,restoredSchema,stepCount] of pairs) {
  test(`source${sourceSchema}/restored${restoredSchema}: valid publication is observed, corrupted startup/status refuse without trusted handles`,async t=>{
    const f=await fixture(t,sourceSchema,stepCount);
    const result=await restoreWorkspaceBackup({directory:f.backup,destination:f.destination});
    assert.equal(result.databaseSchemaVersion,restoredSchema);
    assert.equal((await inspectWorkspaceRestorePublication({destination:f.destination,...result})).publication,'observed_guarded');
    const valid=openStore(f.destination);
    try {assert.equal(getWorkspaceRestoreContext(valid)!.schemaVersion,restoredSchema);}finally{valid.close();}
    const database=path.join(f.destination,'workbench.sqlite');
    const changed=new DatabaseSync(database);
    let before;
    try {corruptCapturedHash(changed);before=logical(changed);}finally{changed.close();}
    const beforeStatus=tree(f.destination);
    await assert.rejects(inspectWorkspaceRestorePublication({destination:f.destination,...result}),{code:'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});
    await assert.rejects(inspectWorkspaceRestorePublication({destination:f.destination,directory:f.backup}),{code:'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});
    assert.deepEqual(tree(f.destination),beforeStatus,'offline status does not repair or rewrite corrupt bytes');
    const closed: DatabaseSync[]=[],close=DatabaseSync.prototype.close;
    const spy=t.mock.method(DatabaseSync.prototype,'close',function(this: DatabaseSync,...args: unknown[]){
      const main=this.prepare('PRAGMA database_list').all().find((row: Loose)=>row['name']==='main');
      if((main as Loose)['file']===database)closed.push(this);
      return Reflect.apply(close,this,args);
    });
    let returned;
    try {assert.throws(()=>{returned=openStore(f.destination);},{code:'RESTORE_CAPTURE_CHANGED'});}finally{spy.mock.restore();}
    assert.equal(returned,undefined,'no store or service/context consumer can be returned');
    assert.equal(closed.length,1);assert.equal(closed[0].isOpen,false,'rejected startup closes its SQLite handle');
    assert.equal(fs.existsSync(path.join(f.destination,'server.lock')),false,'rejected startup releases its owned lock');
    const read=new DatabaseSync(database,{readOnly:true});
    try {
      assert.deepEqual(logical(read),before,'established startup PRAGMAs do not alter logical schema or rows');
      assert.throws(()=>getWorkspaceRestoreContext({db:read,root:f.destination}),{code:'RESTORE_STORE_UNVERIFIED'});
      const changes=read.prepare('SELECT total_changes() AS n').get()!.n;
      assert.throws(()=>validateCurrentWorkspaceRestoreSchema(read),{code:'RESTORE_CAPTURE_CHANGED'});
      assert.equal(read.prepare('SELECT total_changes() AS n').get()!.n,changes);
      assert.deepEqual(logical(read),before,'the current validator itself is read-only');
    } finally {read.close();}
    f.assertOriginals();
  });

  test(`source${sourceSchema}/restored${restoredSchema}: corrupt private candidate is rejected before publication with public error mapping`,async t=>{
    const f=await fixture(t,sourceSchema,stepCount),close=DatabaseSync.prototype.close;
    let fired=0,candidate;
    const spy=t.mock.method(DatabaseSync.prototype,'close',function(this: DatabaseSync,...args: unknown[]){
      const main=this.prepare('PRAGMA database_list').all().find((row: Loose)=>row['name']==='main');
      if(!fired&&main&&path.dirname((main as Loose)['file'] as string)===f.destination&&/^\.restore-.+\.sqlite$/.test(path.basename((main as Loose)['file'] as string))&&this.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='workspace_restoration'").get()){
        candidate=(main as Loose)['file'] as string;fired++;corruptCapturedHash(this);
      }
      return Reflect.apply(close,this,args);
    });
    try {
      await assert.rejects(restoreWorkspaceBackup({directory:f.backup,destination:f.destination}),{code:'WORKSPACE_RESTORE_DATABASE_INVALID'});
    } finally {spy.mock.restore();}
    assert.equal(fired,1,'fault occurs after historical construction and before independent candidate reopen');
    assert.equal(fs.existsSync(path.join(f.destination,'workbench.sqlite')),false,'no active workspace is published');
    assert.equal(fs.existsSync(path.join(f.destination,'server.lock')),false);
    assert.ok(fs.existsSync(candidate as unknown as string),'incomplete candidate is retained for review, not represented as constructor rollback');
    const db=new DatabaseSync(candidate as unknown as string,{readOnly:true});
    try {
      const before=logical(db),changes=db.prepare('SELECT total_changes() AS n').get()!.n;
      assert.throws(()=>validateCurrentWorkspaceRestoreSchema(db),{code:'RESTORE_CAPTURE_CHANGED'});
      assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,changes);
      assert.deepEqual(logical(db),before);
    } finally {db.close();}
    f.assertOriginals();
  });
}
