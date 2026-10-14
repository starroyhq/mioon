// Explicit QA entry, never part of the application or automatic Node test set.
// Run `node tests/workspace-restore-electron-qa.mjs launch` from a graphical
// session. The actual locked Electron main starts a real utilityProcess.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {openStore,getWorkspaceRestoreContext} from '../packages/business/src/db.mjs';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {installWorkspaceRestoreSchema,validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.mjs';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
import {createMockProvider} from '../packages/business/src/providers/mock.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const evidence=path.join(repo,'evidence/workspace-restore/electron-final');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(file){const digest=createHash('sha256');for await(const bytes of fs.createReadStream(file,{highWaterMark:1024*1024}))digest.update(bytes);return digest.digest('hex');}
const q=name=>'"'+name.replaceAll('"','""')+'"';
function snapshot(db){
 const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
 return JSON.stringify({objects,tables:Object.fromEntries(objects.filter(x=>x.type==='table').map(x=>[x.name,db.prepare(`SELECT rowid AS qaRowid,* FROM ${q(x.name)} ORDER BY rowid`).all()]))});
}
function evidenceFile(name,value){fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
async function utility(){
 assert.equal(process.type,'utility');assert.ok(process.parentPort);assert.equal(process.versions.electron,'44.7.0');
 const results=[];
 for(const mockLedger of [false,true])for(const revision of ['beb7fcf','1536878','3446aed']){
  const base=path.join(evidence,`case-${revision}-${mockLedger?'mock':'base'}`);ensurePrivateDirectory(base,{create:true});
  const source=path.join(base,'source');ensurePrivateDirectory(source,{create:true});ensurePrivateDirectory(path.join(source,'media'),{create:true});
  const db=new DatabaseSync(path.join(source,'workbench.sqlite'));db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeWorkspaceSchemaThrough24(db);
  const projectId=randomUUID(),jobId=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'Synthetic Electron restore gate'}));db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(jobId,projectId,JSON.stringify({id:jobId,projectId,status:'queued',providerId:'must-not-execute'}));
  if(mockLedger){
   const provider=createMockProvider({db,root:source,now:()=>1234});
   await provider.submit({model:'mock-motion-v1',prompt:'Synthetic ledger preservation',aspectRatio:'9:16',duration:2,parameters:{scenario:'success'}},{requestId:randomUUID(),jobId});
   assert.equal(db.prepare('SELECT count(*) AS n FROM mock_provider_submissions').get().n,1);
  }
  installWorkspaceRestoreSchema(db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:new Date().toISOString()});
  const before=snapshot(db);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();
  const store=openStore(source);assert.equal(getWorkspaceRestoreContext(store).profile,'restored-local-v1');assert.equal(snapshot(store.db),before);store.close();
  const root=path.join(base,'old-open');ensurePrivateDirectory(root,{create:true});ensurePrivateDirectory(path.join(root,'media'),{create:true});fs.copyFileSync(path.join(source,'workbench.sqlite'),path.join(root,'workbench.sqlite'));
  const native=new DatabaseSync(path.join(root,'workbench.sqlite'));
  const sqliteSourceId=native.prepare('SELECT sqlite_source_id() AS source').get().source;
  for(const sql of ['INSERT INTO schema_version VALUES(1)','INSERT OR IGNORE INTO schema_version VALUES(1)','INSERT OR REPLACE INTO schema_version VALUES(1)','INSERT INTO schema_version VALUES(1) ON CONFLICT(version) DO NOTHING'])assert.throws(()=>native.exec(sql),/RESTORE_LEGACY_RUNTIME_BLOCKED/);
  assert.equal(snapshot(native),before);native.close();
  const fixture=new URL(`./fixtures/workspace-restore-legacy/${revision}-db.mjs`,import.meta.url).href;
  const handles=[];let closes=0;
  const globals={};const token=`__mioonRestoreQa_${revision}_${mockLedger?'mock':'base'}`;
  globals.handles=handles;globals.close=()=>{closes++;};globalThis[token]=globals;
  const spy=path.join(base,'sqlite-spy.mjs');fs.writeFileSync(spy,`import {DatabaseSync as Native} from 'node:sqlite';export class DatabaseSync extends Native{constructor(...args){super(...args);globalThis[${JSON.stringify(token)}].handles.push(this);}close(){globalThis[${JSON.stringify(token)}].close();return super.close();}}`,{mode:0o600,flag:'wx'});
  const hooks=registerHooks({resolve(specifier,context,next){
   if(context.parentURL===fixture+'?profile='+(mockLedger?'mock':'base')&&specifier==='node:sqlite')return {url:pathToFileURL(spy).href,shortCircuit:true};
   if(context.parentURL===fixture+'?profile='+(mockLedger?'mock':'base')&&specifier.startsWith('./'))return next(new URL(specifier,new URL('../packages/business/src/',import.meta.url)).href,context);
   return next(specifier,context);
  }});
  let returned=false,message;
  try{const legacy=await import(fixture+'?profile='+(mockLedger?'mock':'base'));try{const old=legacy.openStore(root);returned=true;old.close();}catch(error){message=error.message;}}finally{hooks.deregister();}
  assert.equal(returned,false);assert.match(message,/RESTORE_LEGACY_RUNTIME_BLOCKED/);
  assert.deepEqual(handles.map(db=>db.isOpen),[revision==='3446aed']);assert.equal(closes,revision==='3446aed'?0:1);
  const lock=fs.existsSync(path.join(root,'server.lock'));assert.equal(lock,revision==='3446aed');
  const check=new DatabaseSync(path.join(root,'workbench.sqlite'));assert.equal(snapshot(check),before);assert.equal(validateWorkspaceRestoreSchema(check).profile,'restored-local-v1');check.close();
  results.push({revision,mockLedger,root,source,beforeHash:hash(before),returned,message,sqliteSourceId,handlesOpenBeforeQaCleanup:handles.map(db=>db.isOpen),closeCallsBeforeQaCleanup:closes,lockBeforeQaCleanup:lock});
  // Explicit QA-only cleanup of our observed legacy handle. The legacy source
  // itself did not close it; no lock is deleted or used to bypass the barrier.
  for(const db of handles)if(db.isOpen)db.close();delete globalThis[token];
 }
 process.parentPort.on('message',({data})=>{if(data==='report-saved')process.exit(0);});
 process.parentPort.postMessage({ok:true,runtime:{electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite,type:process.type,parentPort:true},results,scope:'locked utility runtime; exact old openStore source + current relative dependencies + native SQLite spy; Node suite separately covers server downstream probes; not complete old packaged binaries'});
}
async function launch({headless=false}={}){
 ensurePrivateDirectory(evidence,{create:true});ensurePrivateDirectory(path.join(evidence,'user-data'),{create:true});
 const binary='/workspace/shared/video-workbench/node_modules/electron/dist/electron';
 const version=fs.readFileSync(path.join(path.dirname(binary),'version'),'utf8').trim();assert.equal(version,'44.7.0');
 evidenceFile('binary.json',{version,bytes:fs.statSync(binary).size,sha256:await fileHash(binary),entrySha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),mainSha256:hash(fs.readFileSync(path.join(repo,'tests/fixtures/workspace-restore-electron/main.cjs'))),mode:headless?'headless main and real utility; not GUI':'graphical main and real utility',args:[...(headless?['--ozone-platform=headless']:[]),path.join(repo,'tests/fixtures/workspace-restore-electron/main.cjs')]});
 const env={...process.env};for(const name of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH'])delete env[name];
 const child=spawn(binary,[...(headless?['--ozone-platform=headless']:[]),path.join(repo,'tests/fixtures/workspace-restore-electron/main.cjs')],{env,stdio:['ignore','pipe','pipe']});
 const log=fs.createWriteStream(path.join(evidence,'runtime.log'),{flags:'wx',mode:0o600});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 let termTimer,killTimer,reapTimer,timedOut=false;
 const code=await new Promise((resolve,reject)=>{
  const clear=()=>{clearTimeout(termTimer);clearTimeout(killTimer);clearTimeout(reapTimer);};
  child.once('error',error=>{clear();reject(error);});child.once('close',value=>{clear();resolve(value);});
  termTimer=setTimeout(()=>{timedOut=true;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');},90000);
  killTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},93000);
  reapTimer=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();child.unref();reject(Error('QA_PROCESS_CLEANUP_UNCONFIRMED'));},94000);
 });await new Promise(resolve=>log.end(resolve));assert.equal(timedOut,false);assert.equal(code,0);
 const report=JSON.parse(fs.readFileSync(path.join(evidence,'utility-report.json'),'utf8'));assert.equal(report.ok,true);
 for(const row of report.results){const db=new DatabaseSync(path.join(row.root,'workbench.sqlite'));assert.equal(hash(snapshot(db)),row.beforeHash);db.exec('BEGIN IMMEDIATE;ROLLBACK;PRAGMA wal_checkpoint(TRUNCATE)');validateWorkspaceRestoreSchema(db);db.close();}
 evidenceFile('post-exit.json',{ok:true,exitCode:code,rowsAndSchemaPreserved:true,walReopenedAfterExplicitQaHandleCleanup:true,retainedLegacyLock:'3446aed QA-owned lock is intentionally preserved; no stale-lock bypass'});
 console.log(JSON.stringify({ok:true,evidence,version,utility:report.runtime}));
}
if(process.argv[2]==='utility')await utility();
else if(process.argv[2]==='launch')await launch();
else if(process.argv[2]==='launch-headless')await launch({headless:true});
else throw Error('Use explicit launch or utility QA mode');
