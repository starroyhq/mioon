import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openAppLibrary,APP_LIBRARY_APPLICATION_ID,APP_LIBRARY_FILE,APP_LIBRARY_SCHEMA_VERSION} from '../packages/business/src/app-db/index.ts';
import {appLibraryStatements,expectedAppSchema,readAppSchema,upgradeAppLibraryV2} from '../packages/business/src/app-db/schema.ts';

const at='2026-11-03T00:00:00.000Z';
function directory(t:TestContext):string{const root=mkdtempSync(join(realpathSync(tmpdir()),'mioon-user-rules-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function v2(t:TestContext){
 const dataDir=directory(t),file=join(dataDir,APP_LIBRARY_FILE),db=new DatabaseSync(file);
 try{db.exec('BEGIN');for(const sql of appLibraryStatements(2))db.exec(sql);db.exec(`PRAGMA application_id=${APP_LIBRARY_APPLICATION_ID}`);db.exec('INSERT INTO schema_version VALUES(2)');db.prepare('INSERT INTO app_documents VALUES(?,?)').run('ui-preferences-v1.json','{"preserved":"原件\\r\\n🙂"}');db.exec('COMMIT');}finally{db.close();chmodSync(file,0o600);}
 return{dataDir,file};
}
function inspect<T>(file:string,read:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(file);try{return read(db);}finally{db.close();}}

test('typed user rules default, byte boundaries, CRLF and revision CAS survive reopen',t=>{
 const dataDir=directory(t),library=openAppLibrary({dataDir});
 assert.deepEqual(library.userRules.get(),{text:'',revision:0,updatedAt:null});
 assert.deepEqual(library.userRules.cas(0,'规范\r\n🙂',at),{text:'规范\r\n🙂',revision:1,updatedAt:at});
 assert.throws(()=>library.userRules.cas(0,'stale',at),{code:'MIO_RULES_REVISION_CONFLICT'});
 const boundary='🙂'.repeat(2048);assert.equal(Buffer.byteLength(boundary),8192);library.userRules.cas(1,boundary,at);
 assert.throws(()=>library.userRules.cas(2,boundary+'x',at));assert.throws(()=>library.userRules.cas(2,'\ud800',at));assert.throws(()=>library.userRules.cas(2,'a\0b',at));
 assert.deepEqual(library.userRules.get(),{text:boundary,revision:2,updatedAt:at});library.close();
 const reopened=openAppLibrary({dataDir});try{assert.deepEqual(reopened.userRules.get(),{text:boundary,revision:2,updatedAt:at});}finally{reopened.close();}
 assert.throws(()=>library.userRules.get(),{code:'APP_LIBRARY_CLOSED'});
});

test('user-rules CAS and operation receipt compose in one B1 transaction and rollback together',t=>{
 const library=openAppLibrary({dataDir:directory(t)});t.after(()=>library.close());
 const receipt={operation:'mio.rules.user.save',requestId:'user-rules-request',digest:'a'.repeat(64),response:{revision:1},createdAt:at};
 assert.throws(()=>library.tx(()=>{library.userRules.cas(0,'before rollback',at);library.receipts.write(receipt);throw Error('rollback');}),/rollback/u);
 assert.equal(library.userRules.get().revision,0);assert.equal(library.receipts.read(receipt.operation,receipt.requestId),null);
 library.tx(()=>{library.userRules.cas(0,'committed',at);library.receipts.write(receipt);});
 assert.equal(library.userRules.get().revision,1);assert.deepEqual(library.receipts.read(receipt.operation,receipt.requestId),receipt);
 assert.throws(()=>library.db.exec("INSERT OR REPLACE INTO user_rules VALUES(2,'invalid',1,'now')"),/CHECK/u);
});

test('only the explicit historical v2 profile upgrades to v3 without changing existing bytes',t=>{
 const f=v2(t),before=inspect(f.file,db=>db.prepare('SELECT * FROM app_documents').all());
 assert.throws(()=>openAppLibrary({dataDir:f.dataDir}),{code:'APP_LIBRARY_INVALID'});
 inspect(f.file,db=>{upgradeAppLibraryV2(db);assert.deepEqual(readAppSchema(db),expectedAppSchema(3));assert.deepEqual(db.prepare('SELECT * FROM app_documents').all(),before);assert.equal(db.prepare('SELECT version FROM schema_version').get()?.version,3);});
 const library=openAppLibrary({dataDir:f.dataDir});try{assert.deepEqual(readAppSchema(library.db),expectedAppSchema());assert.deepEqual(library.db.prepare('SELECT * FROM app_documents').all(),before);assert.deepEqual(library.userRules.get(),{text:'',revision:0,updatedAt:null});assert.equal(library.db.prepare('SELECT version FROM schema_version').get()?.version,APP_LIBRARY_SCHEMA_VERSION);}finally{library.close();}
 for(const mutation of ['extra','changed'] as const){const other=v2(t);inspect(other.file,db=>db.exec(mutation==='extra'?'CREATE TABLE unknown_extension(value TEXT)':"DROP TRIGGER immutable_app_operation_receipts;CREATE TRIGGER immutable_app_operation_receipts BEFORE UPDATE ON app_operation_receipts BEGIN SELECT 1;END"));assert.throws(()=>openAppLibrary({dataDir:other.dataDir}),{code:'APP_LIBRARY_INVALID'});assert.throws(()=>inspect(other.file,db=>upgradeAppLibraryV2(db)),/v2 schema does not match/);inspect(other.file,db=>{assert.equal(db.prepare('SELECT version FROM schema_version').get()?.version,2);assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='user_rules'").get(),undefined);});}
});

for(const point of ['after-create','before-commit'] as const)test(`application v2→v3 rollback ${point} restores schema and version`,t=>{
 const f=v2(t),exec=DatabaseSync.prototype.exec;let hit=false;
 const mock=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string):void{if(sql==='COMMIT'&&point==='before-commit'&&this.prepare("SELECT 1 FROM sqlite_master WHERE name='user_rules'").get()){hit=true;throw Error('injected');}exec.call(this,sql);if(point==='after-create'&&sql.startsWith('CREATE TABLE user_rules(')){hit=true;throw Error('injected');}});
 assert.throws(()=>inspect(f.file,db=>upgradeAppLibraryV2(db)),/injected/);mock.mock.restore();assert.equal(hit,true);
 inspect(f.file,db=>{assert.deepEqual(readAppSchema(db),expectedAppSchema(2));assert.equal(db.prepare('SELECT version FROM schema_version').get()?.version,2);});inspect(f.file,db=>upgradeAppLibraryV2(db));openAppLibrary({dataDir:f.dataDir}).close();
});

for(const point of ['after-create','before-commit','after-commit'] as const)test(`application v2→v3 SIGKILL ${point} leaves a complete old or new profile`,t=>{
 const f=v2(t),module=new URL('../packages/business/src/app-db/schema.ts',import.meta.url).href;
 const source=`import{DatabaseSync}from'node:sqlite';import{upgradeAppLibraryV2}from ${JSON.stringify(module)};const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=1;PRAGMA cache_spill=ON');const exec=db.exec.bind(db);db.exec=sql=>{if(sql==='COMMIT'&&process.argv[2]==='before-commit')process.kill(process.pid,'SIGKILL');exec(sql);if(sql.startsWith('CREATE TABLE user_rules(')&&process.argv[2]==='after-create'||sql==='COMMIT'&&process.argv[2]==='after-commit')process.kill(process.pid,'SIGKILL');};upgradeAppLibraryV2(db);throw Error('barrier missed');`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source,f.file,point],{stdio:'ignore',timeout:30000});assert.equal(result.signal,'SIGKILL');
 inspect(f.file,db=>{assert.equal(db.prepare('SELECT version FROM schema_version').get()?.version,point==='after-commit'?3:2);assert.deepEqual(readAppSchema(db),expectedAppSchema(point==='after-commit'?3:2));});
 inspect(f.file,db=>{if(db.prepare('SELECT version FROM schema_version').get()?.version===2)upgradeAppLibraryV2(db);assert.deepEqual(readAppSchema(db),expectedAppSchema(3));});
 const library=openAppLibrary({dataDir:f.dataDir});try{assert.deepEqual(readAppSchema(library.db),expectedAppSchema());assert.equal(library.documents.read('ui-preferences-v1.json'),'{"preserved":"原件\\r\\n🙂"}');}finally{library.close();}
});
