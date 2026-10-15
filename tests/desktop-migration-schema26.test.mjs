import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openStore,installCurrentWorkspaceRestoreSchema} from '@mioon/business/db';
import {migrateData} from '../apps/desktop/scripts/migrate-data.mjs';

const ordinaryVersions=[...Array.from({length:24},(_,index)=>index+1),26,28,30,32];
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-14T00:00:00.000Z'});

function fixture(t){
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-migration-schema26-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),destination=path.join(base,'absent-parent','destination');
 const store=openStore(source),projectId=randomUUID();
 try{
  assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),ordinaryVersions);
  store.put('projects',{id:projectId,name:'Current ordinary workspace',revision:1});
 }finally{store.close();}
 fs.writeFileSync(path.join(source,'media','preserved.bin'),'unchanged current workspace media');
 fs.writeFileSync(path.join(source,'access-token'),'synthetic-credential-must-not-copy',{mode:0o600});
 const file=path.join(source,'workbench.sqlite');
 // Legacy migration still accepts readable owned roots and database files.
 fs.chmodSync(source,0o755);fs.chmodSync(file,0o644);
 return {base,source,destination,file,projectId};
}

function snapshot(root){
 const walk=(file,relative)=>{
  const info=fs.lstatSync(file);
  return [[relative,{dev:info.dev,ino:info.ino,mode:info.mode,size:info.isFile()?info.size:null,
   hash:info.isFile()?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null}],
  ...(info.isDirectory()?fs.readdirSync(file).sort().flatMap(name=>walk(path.join(file,name),path.join(relative,name))):[])];
 };
 return walk(root,'');
}

function mutate(file,change){
 const db=new DatabaseSync(file);
 try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');change(db);}finally{db.close();}
}

test('desktop migration accepts ordinary32 from current openStore and preserves source identity, bytes, modes and credentials',async t=>{
 const f=fixture(t),before=snapshot(f.source);
 const result=await migrateData(f.source,f.destination);
 assert.deepEqual(result,{ok:true,projects:1,assets:0,destination:f.destination,sourceUnchanged:true,copiedCredentials:false});
 assert.deepEqual(snapshot(f.source),before);
 assert.equal(fs.readFileSync(path.join(f.destination,'media','preserved.bin'),'utf8'),'unchanged current workspace media');
 assert.equal(fs.statSync(f.destination).mode&0o777,0o700);
 assert.equal(fs.statSync(path.join(f.destination,'workbench.sqlite')).mode&0o777,0o600);
 for(const name of ['access-token','server.lock'])assert.equal(fs.existsSync(path.join(f.destination,name)),false);
 const db=new DatabaseSync(path.join(f.destination,'workbench.sqlite'),{readOnly:true});
 try{
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),ordinaryVersions);
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM projects WHERE id=?').get(f.projectId).data),{id:f.projectId,name:'Current ordinary workspace',revision:1});
 }finally{db.close();}
 assert.deepEqual(snapshot(f.source),before);
});

for(const [label,change,code] of [
 ['complete restored33',db=>{
  const restored=installCurrentWorkspaceRestoreSchema(db,metadata());
  assert.equal(restored.schemaVersion,33);assert.equal(restored.sourceSchema,32);
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row=>row.version),[...ordinaryVersions,33]);
 },'RESTORE_MIGRATION_UNAVAILABLE'],
 ['partial restoration metadata on ordinary32',db=>db.exec('CREATE TABLE workspace_restoration(id TEXT)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['partial restoration evidence on ordinary32',db=>db.exec('CREATE TABLE workspace_restore_evidence(id TEXT)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['execution epoch without restore marker on ordinary32',db=>db.exec('ALTER TABLE edit_tasks ADD COLUMN executionEpoch TEXT'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['restored33 marker without metadata',db=>db.exec('INSERT INTO schema_version VALUES(33)'),'RESTORE_MIGRATION_UNAVAILABLE'],
 ['mixed historical restore25 and ordinary32 markers',db=>db.exec('INSERT INTO schema_version VALUES(25)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['future34 marker on ordinary32',db=>db.exec('INSERT INTO schema_version VALUES(34)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['mixed historical restore27 and ordinary32 markers',db=>db.exec('INSERT INTO schema_version VALUES(27)'),'RESTORE_SCHEMA_UNSUPPORTED'],
])test(`desktop migration rejects ${label} before destination creation without changing source`,async t=>{
 const f=fixture(t);mutate(f.file,change);
 const before=snapshot(f.source),siblings=fs.readdirSync(f.base).sort();
 await assert.rejects(migrateData(f.source,f.destination),{code});
 assert.deepEqual(snapshot(f.source),before);
 assert.deepEqual(fs.readdirSync(f.base).sort(),siblings);
 assert.equal(fs.existsSync(path.dirname(f.destination)),false);
});
