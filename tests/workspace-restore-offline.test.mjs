import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {restoreWorkspaceBackup,inspectWorkspaceRestorePublication} from '../packages/business/src/workspace-restore.mjs';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.mjs';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {installWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.mjs';
import {workspaceRestoreOfflineResultSchema,workspaceRestorePublicationStatusSchema} from '../packages/contracts/src/workspace-restore-offline.mjs';
import {restoreFixture,tree,logical,secret,refreshDatabaseManifest,runRestoreChild,repo} from './helpers/workspace-restore-offline-fixture.mjs';
const restore=f=>restoreWorkspaceBackup({directory:f.backup,destination:f.destination});

test('offline restore preserves every original SQL value, source/backup byte and mode, stage file and held unknown outcome',async t=>{
 const f=await restoreFixture(t),sourceBefore=tree(f.source),backupBefore=tree(f.backup),result=await restore(f);
 assert.equal(workspaceRestoreOfflineResultSchema.safeParse(result).success,true);assert.equal(result.databaseSchemaVersion,25);assert.equal(result.publication,'confirmed');
 assert.equal(result.inventory.complete,false);assert.deepEqual(result.inventory,f.created.inventory);assert.ok(result.heldCounts.jobs>0);assert.ok(result.heldCounts.image_tasks>0);assert.ok(result.heldCounts.frame_tasks>0);
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(f.backup),backupBefore);assert.deepEqual(await verifyWorkspaceBackup({directory:f.backup}),f.created);
 const manifest=JSON.parse(fs.readFileSync(path.join(f.backup,'manifest.json')));
 for(const entry of manifest.entries.filter(e=>e.role!=='database'))assert.deepEqual(fs.readFileSync(path.join(f.destination,entry.path.slice(8))),fs.readFileSync(path.join(f.backup,entry.path)));
 const file=path.join(f.destination,'workbench.sqlite');assert.equal(fs.statSync(file).nlink,1);assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(f.destination).mode&0o777,0o700);
 assert.ok(fs.readFileSync(file).includes(Buffer.from(secret)));assert.equal(fs.existsSync(path.join(f.destination,'access-token')),false);assert.equal(fs.existsSync(path.join(f.destination,'server.lock')),false);
 assert.ok(!fs.readdirSync(f.destination).some(name=>name.startsWith('.restore-')||/-wal$|-shm$|-journal$/.test(name)));
 const db=new DatabaseSync(file,{readOnly:true});try{
  const after=logical(db);
  for(const [table,rows] of Object.entries(f.before)){
   const actual=after[table].filter(row=>table!=='schema_version'||row.version<=24).map(row=>{const value=Object.assign(Object.create(Object.getPrototypeOf(row)),row);if(table==='edit_tasks')delete value.executionEpoch;return value;});
   assert.deepEqual(actual,rows,table);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_restore_timeline_history').get().n,2);
  assert.equal(db.prepare('SELECT position FROM workspace_restore_timeline_cursors').get().position,1);
 }finally{db.close();}
 const status=await inspectWorkspaceRestorePublication({destination:f.destination,...result});assert.equal(workspaceRestorePublicationStatusSchema.safeParse(status).success,true);assert.equal(status.publication,'observed_guarded');assert.equal(status.durability,'not_reconfirmed');
 const store=openStore(f.destination);try{assert.equal(getWorkspaceRestoreContext(store).workspaceOrigin,result.workspaceOrigin);}finally{store.close();}
 assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(f.backup),backupBefore);
});

test('same original backup produces distinct server-created independent origins and ids',async t=>{
 const f=await restoreFixture(t,{stages:false}),a=await restore(f),b=await restoreWorkspaceBackup({directory:f.backup,destination:path.join(f.base,'other')});
 assert.notEqual(a.restorationId,b.restorationId);assert.notEqual(a.workspaceOrigin,b.workspaceOrigin);assert.equal(a.sourceDbHash,b.sourceDbHash);assert.equal(a.manifestHash,b.manifestHash);
});

test('existing destination, lock, overlap and unsafe links refuse without changing old contents or permissions',async t=>{
 const f=await restoreFixture(t,{stages:false});fs.mkdirSync(f.destination,{mode:0o700});fs.writeFileSync(path.join(f.destination,'server.lock'),'review-existing-lock',{mode:0o600});
 const before=tree(f.destination);await assert.rejects(restore(f),{code:'WORKSPACE_RESTORE_DESTINATION_EXISTS'});assert.deepEqual(tree(f.destination),before);
 await assert.rejects(restoreWorkspaceBackup({directory:f.backup,destination:path.join(f.backup,'nested')}),{code:'WORKSPACE_RESTORE_INVALID_PATH'});
 const linked=path.join(f.base,'linked');fs.symlinkSync(f.backup,linked);await assert.rejects(restoreWorkspaceBackup({directory:linked,destination:path.join(f.base,'new')}),{code:'STORAGE_PRIVATE_REQUIRED'});
 assert.equal(fs.existsSync(path.join(f.base,'new')),false);
});

for(const type of ['changed-payload','missing-complete','unknown-sql','malicious-trigger','schema25','invalid-identity'])test(`restore refuses ${type} with no final activation and leaves backup unchanged`,async t=>{
 const f=await restoreFixture(t,{stages:false}),file=path.join(f.backup,'payload/workbench.sqlite');
 if(type==='changed-payload')fs.appendFileSync(path.join(f.backup,'payload',f.relativePath),'tamper');
 else if(type==='missing-complete')fs.unlinkSync(path.join(f.backup,'COMPLETE.json'));
 else{
  const db=new DatabaseSync(file);try{
   if(type==='unknown-sql')db.exec('CREATE TABLE unclassified_note(id TEXT,data TEXT)');
   if(type==='malicious-trigger')db.exec("CREATE TRIGGER unclassified BEFORE INSERT ON schema_version BEGIN UPDATE projects SET data='{}'; END");
   if(type==='schema25')installWorkspaceRestoreSchema(db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()});
   if(type==='invalid-identity')db.exec("UPDATE jobs SET data='{}'");
  }finally{db.close();}refreshDatabaseManifest(f.backup);
 }
 const before=tree(f.backup);await assert.rejects(restore(f),error=>/WORKSPACE_(RESTORE|BACKUP)_(SOURCE_SCHEMA_UNSUPPORTED|DATABASE_INVALID|CORRUPT|INCOMPLETE)/.test(error.code));
 assert.equal(fs.existsSync(path.join(f.destination,'workbench.sqlite')),false);assert.deepEqual(tree(f.backup),before);
});

test('cancellation before work creates no destination; exact offline status declines wrong binding and live lock without repairs',async t=>{
 const f=await restoreFixture(t,{stages:false}),controller=new AbortController();controller.abort();
 await assert.rejects(restoreWorkspaceBackup({directory:f.backup,destination:f.destination,signal:controller.signal}),{code:'WORKSPACE_RESTORE_CANCELLED'});assert.equal(fs.existsSync(f.destination),false);
 const result=await restore(f),before=tree(f.destination);await assert.rejects(inspectWorkspaceRestorePublication({destination:f.destination,...result,restorationId:randomUUID()}),{code:'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});assert.deepEqual(tree(f.destination),before);
 const store=openStore(f.destination);try{await assert.rejects(inspectWorkspaceRestorePublication({destination:f.destination,...result}),{code:'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});}finally{store.close();}
 const wal=path.join(f.destination,'workbench.sqlite-wal');fs.writeFileSync(wal,'unexpected',{mode:0o600});const withWal=tree(f.destination);await assert.rejects(inspectWorkspaceRestorePublication({destination:f.destination,...result}),{code:'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});assert.deepEqual(tree(f.destination),withWal);
});

test('actual frozen baseline openStore refuses a SQLite-only copy of offline restored output',async t=>{
 const f=await restoreFixture(t,{stages:false});await restore(f);
 const copy=path.join(f.base,'sqlite-only');fs.mkdirSync(copy,{mode:0o700});fs.copyFileSync(path.join(f.destination,'workbench.sqlite'),path.join(copy,'workbench.sqlite'));
 const file=path.join(f.base,'legacy-probe.mjs'),legacy=new URL('./fixtures/workspace-restore-legacy/beb7fcf-db.mjs',import.meta.url).href,source=new URL('../packages/business/src/',import.meta.url).href;
 fs.writeFileSync(file,`import {registerHooks} from 'node:module';import assert from 'node:assert/strict';registerHooks({resolve(specifier,context,next){if(context.parentURL===${JSON.stringify(legacy)}&&specifier.startsWith('./'))return next(new URL(specifier,${JSON.stringify(source)}).href,context);return next(specifier,context);}});const {openStore}=await import(${JSON.stringify(legacy)});assert.throws(()=>openStore(${JSON.stringify(copy)}),/RESTORE_LEGACY_RUNTIME_BLOCKED/);console.log('legacy-refused');process.exit(0);`,{mode:0o600});
 const result=await runRestoreChild(t,['--help'],{preload:file});assert.equal(result.code,0,result.stderr);assert.equal(result.stdout.trim(),'legacy-refused');assert.equal(fs.existsSync(path.join(copy,'server.lock')),false);
});


for(const variant of ['different-backup','corrupt-backup','ordinary-target','partial-target','locked-target','sidecar-target','absent-target','mixed-mode'])test(`backup-bound publication discovery rejects ${variant} without target/source changes`,async t=>{
 const f=await restoreFixture(t,{stages:false}),restored=await restore(f);let directory=f.backup,destination=f.destination;
 if(variant==='different-backup'){directory=path.join(f.base,'other-backup');await createWorkspaceBackup({source:f.source,destination:directory});}
 if(variant==='corrupt-backup')fs.appendFileSync(path.join(f.backup,'payload',f.relativePath),'tamper');
 if(variant==='ordinary-target')fs.copyFileSync(path.join(f.backup,'payload/workbench.sqlite'),path.join(destination,'workbench.sqlite'));
 if(variant==='partial-target'){const db=new DatabaseSync(path.join(destination,'workbench.sqlite'));try{db.exec('DROP TRIGGER restore_legacy_schema_gate');}finally{db.close();}}
 if(variant==='locked-target')fs.writeFileSync(path.join(destination,'server.lock'),'unknown-owner-lock',{mode:0o600});
 if(variant==='sidecar-target')fs.writeFileSync(path.join(destination,'workbench.sqlite-wal'),'unknown-sidecar',{mode:0o600});
 if(variant==='absent-target')destination=path.join(f.base,'absent');
 const targetBefore=fs.existsSync(destination)?tree(destination):null,sourceBefore=tree(f.source),backupBefore=tree(directory);
 await assert.rejects(inspectWorkspaceRestorePublication({directory,destination,...(variant==='mixed-mode'?{restorationId:restored.restorationId}:{})}),{code:'WORKSPACE_RESTORE_STATUS_UNAVAILABLE'});
 assert.deepEqual(fs.existsSync(destination)?tree(destination):null,targetBefore);assert.deepEqual(tree(directory),backupBefore);assert.deepEqual(tree(f.source),sourceBefore);
});


test('restore rejects a new descendant of the original workspace without changing any original path, bytes or modes',async t=>{
 const f=await restoreFixture(t,{stages:false}),sourceBefore=tree(f.source),backupBefore=tree(f.backup),nested=path.join(f.source,'new-branch');
 await assert.rejects(restoreWorkspaceBackup({directory:f.backup,destination:nested}),{code:'WORKSPACE_RESTORE_DESTINATION_WORKSPACE_ANCESTOR'});
 assert.equal(fs.existsSync(nested),false);assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(f.backup),backupBefore);
 const independent=await restore(f);assert.equal(independent.publication,'confirmed');assert.deepEqual(tree(f.source),sourceBefore);assert.deepEqual(tree(f.backup),backupBefore);
});

test('destination ancestor lock and symbolic fixed marker are fail-closed without deletion or recursive scanning',async t=>{
 const f=await restoreFixture(t,{stages:false}),ancestor=path.join(f.base,'incomplete');fs.mkdirSync(ancestor,{mode:0o700});
 const lock=path.join(ancestor,'server.lock');fs.writeFileSync(lock,'unrecognized-owner',{mode:0o600});const before=tree(ancestor);
 await assert.rejects(restoreWorkspaceBackup({directory:f.backup,destination:path.join(ancestor,'child')}),{code:'WORKSPACE_RESTORE_DESTINATION_WORKSPACE_ANCESTOR'});assert.deepEqual(tree(ancestor),before);
 // This synthetic fixture explicitly owns its lock and switches to a marker
 // symlink to verify that existence is enough to refuse without following it.
 fs.unlinkSync(lock);const marker=path.join(ancestor,'workbench.sqlite');fs.symlinkSync(path.join(f.source,'workbench.sqlite'),marker);
 await assert.rejects(restoreWorkspaceBackup({directory:f.backup,destination:path.join(ancestor,'child')}),{code:'WORKSPACE_RESTORE_DESTINATION_WORKSPACE_ANCESTOR'});assert.equal(fs.lstatSync(marker).isSymbolicLink(),true);assert.equal(fs.existsSync(path.join(ancestor,'child')),false);
});
