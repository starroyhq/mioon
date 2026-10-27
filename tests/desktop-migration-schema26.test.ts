import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openStore,installCurrentWorkspaceRestoreSchema} from '@mioon/business/db';
import {currentMarkerChain} from './helpers/current-schema-delta.ts';
import {migrateData} from '../apps/desktop/scripts/migrate-data.ts';

const ordinaryVersions=[...currentMarkerChain];
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-14T00:00:00.000Z'});

function fixture(t: TestContext) {
 const base=fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()),'mioon-migration-schema26-'));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const source=path.join(base,'source'),destination=path.join(base,'absent-parent','destination');
 const store=openStore(source),projectId=randomUUID();
 try{
  assert.deepEqual(store.db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => Number(row.version)),ordinaryVersions);
  store.put('projects',{id:projectId,name:'Current ordinary workspace',revision:1});
 }finally{store.close();}
 fs.writeFileSync(path.join(source,'media','preserved.bin'),'unchanged current workspace media');
 fs.writeFileSync(path.join(source,'access-token'),'synthetic-credential-must-not-copy',{mode:0o600});
 const file=path.join(source,'workbench.sqlite');
 // Legacy migration still accepts readable owned roots and database files.
 fs.chmodSync(source,0o755);fs.chmodSync(file,0o644);
 return {base,source,destination,file,projectId};
}

function snapshot(root: string) {
 const walk = (file: string, relative: string): Array<[string, Record<string, unknown>]> => {
  const info=fs.lstatSync(file);
  return [[relative,{dev:info.dev,ino:info.ino,mode:info.mode,size:info.isFile()?info.size:null,
   hash:info.isFile()?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null}],
  ...(info.isDirectory()?fs.readdirSync(file).sort().flatMap(name=>walk(path.join(file,name),path.join(relative,name))):[])];
 };
 return walk(root,'');
}

function mutate(file: string, change: (db: DatabaseSync) => void): void {
 const db=new DatabaseSync(file);
 try{db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;');change(db);}finally{db.close();}
}

test('desktop migration accepts current ordinary workspace from current openStore and preserves source identity, bytes, modes and credentials',async t=>{
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
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => Number(row.version)),ordinaryVersions);
  assert.deepEqual(JSON.parse(String(db.prepare('SELECT data FROM projects WHERE id=?').get(f.projectId)?.data)),{id:f.projectId,name:'Current ordinary workspace',revision:1});
 }finally{db.close();}
 assert.deepEqual(snapshot(f.source),before);
});

for(const [label,change,code] of ([
 ['complete restored59',db=>{
  const restored=installCurrentWorkspaceRestoreSchema(db,metadata());
  assert.equal(restored.schemaVersion,63);assert.equal(restored.sourceSchema,62);
  assert.deepEqual(db.prepare('SELECT version FROM schema_version ORDER BY version').all().map(row => Number(row.version)),[...ordinaryVersions,63]);
 },'RESTORE_MIGRATION_UNAVAILABLE'],
 ['partial restoration metadata on ordinary58',db=>db.exec('CREATE TABLE workspace_restoration(id TEXT)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['partial restoration evidence on ordinary58',db=>db.exec('CREATE TABLE workspace_restore_evidence(id TEXT)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['execution epoch without restore marker on ordinary58',db=>db.exec('ALTER TABLE edit_tasks ADD COLUMN executionEpoch TEXT'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['orphan restored marker on ordinary',db=>db.exec('INSERT INTO schema_version VALUES(35)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['mixed historical restore25 and ordinary58 markers',db=>db.exec('INSERT INTO schema_version VALUES(25)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['future64 marker on ordinary62',db=>db.exec('INSERT INTO schema_version VALUES(64)'),'RESTORE_SCHEMA_UNSUPPORTED'],
 ['mixed historical restore27 and ordinary58 markers',db=>db.exec('INSERT INTO schema_version VALUES(27)'),'RESTORE_SCHEMA_UNSUPPORTED'],
] as Array<[string, (db: DatabaseSync) => void, string]>))test(`desktop migration rejects ${label} before destination creation without changing source`,async t=>{
 const f=fixture(t);mutate(f.file,change);
 const before=snapshot(f.source),siblings=fs.readdirSync(f.base).sort();
 await assert.rejects(migrateData(f.source,f.destination),{code});
 assert.deepEqual(snapshot(f.source),before);
 assert.deepEqual(fs.readdirSync(f.base).sort(),siblings);
 assert.equal(fs.existsSync(path.dirname(f.destination)),false);
});

test('desktop migration retains schema58 selected-input manifests and private bytes without credentials',async t=>{
 const f=fixture(t),id=randomUUID(),bytes=Buffer.from('selected local input'),relativePath=`agent-imports/${id}.bin`;
 fs.mkdirSync(path.join(f.source,'agent-imports'),{mode:0o700});fs.writeFileSync(path.join(f.source,relativePath),bytes,{mode:0o600});
 mutate(f.file,db=>db.prepare("INSERT INTO agent_task_imports_v2(id,projectId,requestId,name,mimeType,relativePath,sha256,status,createdAt) VALUES(?,?,?,?,?,?,?,'selected',?)").run(id,f.projectId,randomUUID(),'chosen.png','image/png',relativePath,createHash('sha256').update(bytes).digest('hex'),'2026-10-20T00:00:00.000Z'));
 const before=snapshot(f.source);await migrateData(f.source,f.destination);assert.deepEqual(snapshot(f.source),before);assert.deepEqual(fs.readFileSync(path.join(f.destination,relativePath)),bytes);assert.equal(fs.statSync(path.join(f.destination,'agent-imports')).mode&0o777,0o700);assert.equal(fs.existsSync(path.join(f.destination,'access-token')),false);
 const copied=new DatabaseSync(path.join(f.destination,'workbench.sqlite'),{readOnly:true});try{assert.equal(copied.prepare('SELECT relativePath FROM agent_task_imports_v2 WHERE id=?').get(id)?.relativePath,relativePath);}finally{copied.close();}
});
