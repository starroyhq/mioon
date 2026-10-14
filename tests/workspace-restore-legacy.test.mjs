import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {openStore} from '../packages/business/src/db.mjs';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.mjs';
import {installWorkspaceRestoreSchema,validateWorkspaceRestoreSchema} from '../packages/business/src/workspace-restore-schema.mjs';
const fixtureDir=new URL('./fixtures/workspace-restore-legacy/',import.meta.url),sourceDir=new URL('../packages/business/src/',import.meta.url),serverDir=new URL('../apps/server/src/',import.meta.url);
const provenance=JSON.parse(readFileSync(new URL('provenance.json',fixtureDir),'utf8'));
const plain=value=>JSON.parse(JSON.stringify(value));
function snapshot(db){const objects=db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();return plain({objects,tables:Object.fromEntries(objects.filter(row=>row.type==='table').map(({name})=>[name,db.prepare(`SELECT rowid AS capturedRowid,* FROM "${name}" ORDER BY rowid`).all()]))});}
function restored(t){
 const base=mkdtempSync(path.join(tmpdir(),'mioon-restore-old-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const root=path.join(base,'source');mkdirSync(root,{mode:0o700});mkdirSync(path.join(root,'media'),{mode:0o700});
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeWorkspaceSchemaThrough24(db);
 const projectId=randomUUID(),jobId=randomUUID();db.prepare('INSERT INTO projects VALUES(?,?)').run(projectId,JSON.stringify({id:projectId,name:'legacy gate proof'}));db.prepare('INSERT INTO jobs VALUES(?,?,?)').run(jobId,projectId,JSON.stringify({id:jobId,projectId,status:'queued',providerId:'must-not-construct'}));
 installWorkspaceRestoreSchema(db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-12T00:00:00Z'});db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 const before=snapshot(db);db.close();return {base,root,before};
}
function copyOnly(f,name){const root=path.join(f.base,name);mkdirSync(root,{mode:0o700});mkdirSync(path.join(root,'media'),{mode:0o700});copyFileSync(path.join(f.root,'workbench.sqlite'),path.join(root,'workbench.sqlite'));return root;}
function runner(f,revision,body,{server=false,migration=false}={}){
 const dbUrl=new URL(`${revision}-db.mjs`,fixtureDir).href;
 const oldServices=new URL('3446aed-services.mjs',fixtureDir).href,oldTimeline=new URL('3446aed-timeline.mjs',fixtureDir).href,oldContracts=new URL('3446aed-contracts.mjs',fixtureDir).href;
 const zodUrl=pathToFileURL(createRequire(new URL('../packages/contracts/package.json',import.meta.url)).resolve('zod')).href;
 const inertUrl='data:text/javascript,'+encodeURIComponent("export const providerSettings={};export function normalizedCapabilities(){throw Error('unexpected provider use')}export function generationLimit(){throw Error('unexpected provider use')}export function fileInfo(){throw Error('unexpected media use')}export function safePath(){throw Error('unexpected media use')}");
 const sqliteFile=path.join(f.base,`${revision}-sqlite-spy.mjs`);
 writeFileSync(sqliteFile,`import {DatabaseSync as Native} from 'node:sqlite';export class DatabaseSync extends Native{constructor(...args){super(...args);globalThis.__sqliteHandles.push(this);}close(){globalThis.__sqliteCloseCalls++;return super.close();}}`);
 const stubFile=path.join(f.base,`${revision}-stub.mjs`),serverUrl=new URL(`${revision}-server.mjs`,fixtureDir).href;
 // Dependency substitution does not alter a single byte of the frozen entry
 // source. Downstream constructors deliberately throw if ever reached.
 const serverSource=server?readFileSync(new URL(`${revision}-server.mjs`,fixtureDir),'utf8'):'';
 const names=new Set();for(const match of serverSource.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g))if(!match[2].startsWith('node:')&&match[2]!=='@mioon/contracts/private-storage')for(const name of match[1].split(',')){const value=name.trim().split(/\s+as\s+/)[0];if(value&&value!=='openStore'&&value!=='validateWorkspaceStorage')names.add(value);}
 writeFileSync(stubFile,`import {openStore,${revision==='3446aed'?'':'validateWorkspaceStorage'}} from ${JSON.stringify(dbUrl)};\nexport {openStore};\n${revision==='3446aed'?'export function validateWorkspaceStorage(){}':'export {validateWorkspaceStorage};'}\n${[...names].map(name=>`export const ${name}=(...args)=>{globalThis.__downstream.push(${JSON.stringify(name)});throw Error('DOWNSTREAM_CALLED:${name}');};`).join('\n')}`);
 const program=`import {registerHooks} from 'node:module';import {existsSync,readFileSync} from 'node:fs';import path from 'node:path';\nglobalThis.__downstream=[];globalThis.__sqliteHandles=[];globalThis.__sqliteCloseCalls=0;\nregisterHooks({resolve(specifier,context,next){\n if([${JSON.stringify(oldServices)},${JSON.stringify(oldTimeline)}].includes(context.parentURL)&&specifier==='@video-workbench/contracts')return {url:${JSON.stringify(oldContracts)},shortCircuit:true};\n if(context.parentURL===${JSON.stringify(oldServices)}&&specifier==='./timeline.mjs')return {url:${JSON.stringify(oldTimeline)},shortCircuit:true};\n if(context.parentURL===${JSON.stringify(oldServices)}&&['./provider-registry.mjs','./media.mjs'].includes(specifier))return {url:${JSON.stringify(inertUrl)},shortCircuit:true};\n if(context.parentURL===${JSON.stringify(oldContracts)}&&specifier==='zod')return {url:${JSON.stringify(zodUrl)},shortCircuit:true};\n if(context.parentURL===${JSON.stringify(dbUrl)}&&specifier==='node:sqlite')return {url:${JSON.stringify(pathToFileURL(sqliteFile).href)},shortCircuit:true};\n if(context.parentURL===${JSON.stringify(dbUrl)}&&specifier.startsWith('./'))return next(new URL(specifier,${JSON.stringify(sourceDir.href)}).href,context);\n if(context.parentURL===${JSON.stringify(serverUrl)}&&!specifier.startsWith('node:')&&specifier!=='@mioon/contracts/private-storage')return {url:${JSON.stringify(pathToFileURL(stubFile).href)},shortCircuit:true};\n if(context.parentURL===${JSON.stringify(new URL('beb7fcf-migrate-data.mjs',fixtureDir).href)}&&specifier==='@mioon/business')return {url:${JSON.stringify(pathToFileURL(stubFile).href)},shortCircuit:true};\n return next(specifier,context);}});\n${body}`;
 return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',timeout:20000,stdio:['ignore','pipe','pipe']}).trim());
}
test('frozen historical source fixtures have exact commit/path/byte/SHA256 provenance',()=>{
 for(const entry of provenance){const bytes=readFileSync(new URL(entry.fixture,fixtureDir));assert.equal(bytes.length,entry.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256);assert.match(entry.commit,/^[a-f0-9]{40}$/);}
});
for(const revision of ['beb7fcf','1536878','3446aed'])for(const lock of [false,true])test(`exact ${revision} openStore lock=${lock} refuses a closed SQLite-only copy before downstream work`,t=>{
 const f=restored(t),root=copyOnly(f,'copy'),url=new URL(`${revision}-db.mjs`,fixtureDir).href;
 const result=runner(f,revision,`const {openStore}=await import(${JSON.stringify(url)});let message,returned=false;try{const store=openStore(${JSON.stringify(root)},{lock:${lock}});returned=true;globalThis.__downstream.push('worker');store.close();}catch(error){message=error.message;}console.log(JSON.stringify({message,returned,calls:globalThis.__downstream,sqliteOpen:globalThis.__sqliteHandles.map(db=>db.isOpen),sqliteTransactions:globalThis.__sqliteHandles.map(db=>db.isOpen?db.isTransaction:false),sqliteCloseCalls:globalThis.__sqliteCloseCalls,lock:existsSync(path.join(${JSON.stringify(root)},'server.lock')),pid:process.pid}));`);
 assert.match(result.message,/RESTORE_LEGACY_RUNTIME_BLOCKED/);assert.equal(result.returned,false);assert.deepEqual(result.calls,[]);
 assert.deepEqual(result.sqliteOpen,[revision==='3446aed']);assert.deepEqual(result.sqliteTransactions,[false]);assert.equal(result.sqliteCloseCalls,revision==='3446aed'?0:1);
 assert.equal(result.lock,revision==='3446aed'&&lock,'earliest bootstrap lacks failure cleanup; later sources release their own lock');
 if(result.lock){assert.equal(readFileSync(path.join(root,'server.lock'),'utf8'),String(result.pid));assert.throws(()=>process.kill(result.pid,0));}
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));assert.deepEqual(snapshot(db),f.before);assert.equal(db.isTransaction,false);db.exec('PRAGMA trusted_schema=OFF;BEGIN IMMEDIATE;ROLLBACK;PRAGMA wal_checkpoint(TRUNCATE)');assert.equal(validateWorkspaceRestoreSchema(db).profile,'restored-local-v1');db.close();
 // Header/journal bytes are not asserted equal: the supported guarantee is
 // logical rows/schema/guards plus reopened SQLite/WAL usability after exit.
 for(const suffix of ['-wal','-shm'])if(existsSync(path.join(root,'workbench.sqlite'+suffix)))assert.equal(statSync(path.join(root,'workbench.sqlite'+suffix)).size,0);
});
for(const revision of ['beb7fcf','1536878','3446aed'])test(`exact ${revision} server startup rejects before provider/service/recovery/listener/worker entrypoints`,t=>{
 const f=restored(t),root=copyOnly(f,'server-copy'),url=new URL(`${revision}-server.mjs`,fixtureDir).href;
 const result=runner(f,revision,`const {startServer}=await import(${JSON.stringify(url)});let message,returned=false;try{const server=await startServer({dataDir:${JSON.stringify(root)},port:0,token:'synthetic-restore-proof-token'});returned=true;await server.close();}catch(error){message=error.message;}console.log(JSON.stringify({message,returned,calls:globalThis.__downstream}));`,{server:true});
 assert.match(result.message,/RESTORE_LEGACY_RUNTIME_BLOCKED/);assert.equal(result.returned,false);assert.deepEqual(result.calls,[]);
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));assert.deepEqual(snapshot(db),f.before);db.close();
});
test('exact old migrate-data copies the main-DB barrier then refuses its destination without changing source',async t=>{
 const f=restored(t),destination=path.join(f.base,'migrated'),url=new URL('beb7fcf-migrate-data.mjs',fixtureDir).href;
 const result=runner(f,'beb7fcf',`const {migrateData}=await import(${JSON.stringify(url)});let message,returned=false;try{await migrateData(${JSON.stringify(f.root)},${JSON.stringify(destination)});returned=true;}catch(error){message=error.message;}console.log(JSON.stringify({message,returned,calls:globalThis.__downstream}));`,{migration:true});
 assert.match(result.message,/RESTORE_LEGACY_RUNTIME_BLOCKED/);assert.equal(result.returned,false);assert.deepEqual(result.calls,[]);assert.equal(existsSync(path.join(destination,'server.lock')),false);
 for(const root of [f.root,destination]){const db=new DatabaseSync(path.join(root,'workbench.sqlite'));assert.deepEqual(snapshot(db),f.before);validateWorkspaceRestoreSchema(db);db.close();}
});
test('actual frozen344 services and timeline produce export intents whose original JSON/receipts survive normal upgrade24 and restore',t=>{
 const base=mkdtempSync(path.join(tmpdir(),'mioon-actual344-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const f={base},root=path.join(base,'original');
 const result=runner(f,'3446aed',`const {randomUUID}=await import('node:crypto');const {openStore}=await import(${JSON.stringify(new URL('3446aed-db.mjs',fixtureDir).href)});const {createServices}=await import(${JSON.stringify(new URL('3446aed-services.mjs',fixtureDir).href)});const store=openStore(${JSON.stringify(root)}),services=createServices(store,new Map());
 const project=await services.call('project.create',{name:'Actual344 export evidence'}),shot=await services.call('shot.create',{projectId:project.id,title:'Original shot'});
 const assetId=randomUUID(),jobId=randomUUID(),versionId=randomUUID();store.put('assets',{id:assetId,projectId:project.id,name:'synthetic source',mimeType:'video/mp4',sha256:'a'.repeat(64),duration:2,width:720,height:1280,hasAudio:false,hasVideo:true,relativePath:'media/'+assetId+'.mp4'});store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,status:'succeeded'});store.put('versions',{id:versionId,projectId:project.id,jobId,shotId:shot.id,assetId,sha256:'a'.repeat(64),number:1});
 await services.call('version.select',{shotId:shot.id,versionId,expectedRevision:shot.revision});const storyboard=await services.call('export.create',{projectId:project.id,requestId:randomUUID()});let timeline=await services.call('timeline.get',{projectId:project.id});timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0].id,startFrame:0,durationFrames:30});const rendered=await services.call('timeline.render',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export'});
 const records=Object.fromEntries(['exports','idempotency','timeline_requests'].map(table=>[table,store.db.prepare('SELECT rowid AS capturedRowid,* FROM '+table+' ORDER BY rowid').all()]));store.close();console.log(JSON.stringify({records,storyboardId:storyboard.id,timelineId:rendered.id}));`);
 // This independently proves the old production code really did include the
 // requestId field. Missing-field support above is a synthetic defensive case.
 assert.ok(result.records.exports.every(row=>typeof JSON.parse(row.data).requestId==='string'));
 const db=new DatabaseSync(path.join(root,'workbench.sqlite'));db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON');initializeWorkspaceSchemaThrough24(db);const assertRecords=()=>{for(const [table,rows] of Object.entries(result.records))assert.deepEqual(plain(db.prepare(`SELECT rowid AS capturedRowid,* FROM ${table} ORDER BY rowid`).all()),rows);};assertRecords();
 installWorkspaceRestoreSchema(db,{restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-12T00:00:00Z'});assertRecords();
 assert.equal(db.prepare("SELECT namespace FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(result.storyboardId).namespace,'export');assert.equal(db.prepare("SELECT namespace FROM workspace_restore_holds WHERE kind='exports' AND id=?").get(result.timelineId).namespace,'timeline');db.close();
 const reopened=openStore(root);assert.equal(validateWorkspaceRestoreSchema(reopened.db).profile,'restored-local-v1');reopened.close();
});
