import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,lstatSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createProjectHostManager} from '../apps/server/src/project-host/manager.ts';
import {createMemoryProjectRegistry} from '../apps/server/src/project-host/stand-ins.ts';
import {projectLocation,serverAppDirectories} from '../apps/server/src/project-host/directories.ts';
import {ensureProjectRow} from '../apps/server/src/project-host/project-initialization.ts';
import {createProjectVersions} from '../packages/business/src/project-versions/service.ts';
import {recoverHistorySwitch} from '../packages/business/src/project-file/history-switch.ts';
import type {HistorySwitchBoundary} from '../packages/business/src/project-file/history-switch.ts';
import type {ProjectStore} from '../packages/business/src/project-file/store.ts';
import type {ProjectHistoryResolveInput,ProjectHistoryStatus} from '../packages/contracts/src/project-history-recovery.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';

function snapshot(root:string):unknown {
 const result:Record<string,unknown>={};
 function visit(directory:string):void {
  for(const name of readdirSync(directory).sort()){
   const full=path.join(directory,name),info=lstatSync(full,{bigint:true}),key=path.relative(root,full);
   result[key]={mode:String(info.mode),ino:String(info.ino),size:String(info.size),mtime:String(info.mtimeNs),
    hash:info.isFile()?createHash('sha256').update(readFileSync(full)).digest('hex'):null};
   if(info.isDirectory())visit(full);
  }
 }
 visit(root);return result;
}
const sha=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex');
async function fixture(t:TestContext,seed?:(store:ProjectStore)=>void){
 const root=mkdtempSync(path.join(tmpdir(),'history-switch-boundary-')),directories=serverAppDirectories(root),registry=createMemoryProjectRegistry();
 const counts={factory:0},injection:{point:HistorySwitchBoundary|null}={point:null};
 const manager=createProjectHostManager({directories,registry,assertMutationAllowed:()=>{},historySwitchBoundary:point=>{if(injection.point===point)throw Error(`stop at ${point}`);},
  factory:context=>{counts.factory++;ensureProjectRow(context.store,{name:'Original'});return {handle:async()=>false,isBusy:()=>false,interrupt(){},drain:async()=>{},dispose(){}};}});
 t.after(async()=>{await manager.closeAll();rmSync(root,{recursive:true,force:true});});
 const registration=await manager.create({name:'Original'}),projectId=registration.projectId,lease=await manager.acquire(projectId,'window');
 const version=createProjectVersions(lease.host.store).save({projectId,requestId:randomUUID(),name:'before external edit'}).version;
 seed?.(lease.host.store);lease.release();await manager.close(projectId);
 const project=new DatabaseSync(registration.projectFile);
 project.prepare("UPDATE projects SET data=json_set(data,'$.name','External','$.revision',json_extract(data,'$.revision')+1) WHERE id=?").run(projectId);project.close();
 const local=projectLocation(directories,projectId),historyFile=path.join(local.localDir,'history.db');
 const opened=await manager.acquire(projectId,'window'),status=opened.host.recovery!.status();opened.release();await manager.close(projectId);
 const input:ProjectHistoryResolveInput={projectId,requestId:randomUUID(),expected:status.file,historyIdentity:status.historyIdentity,confirmationDigest:status.confirmationDigest,action:'continue'};
 const options={projectFile:registration.projectFile,location:local,assertMutationAllowed:()=>{}};
 async function stop(point:'prepared'|'staged'){
  injection.point=point;await assert.rejects(manager.resolveHistory(input),new RegExp(`stop at ${point}`));injection.point=null;
  assert.equal(JSON.parse(readFileSync(path.join(local.localDir,'history-switch-active.json'),'utf8')).requestId,input.requestId);
 }
 return {root,registry,manager,counts,injection,registration,projectId,version,local,historyFile,status,input,options,stop};
}
function restoreInput(status:ProjectHistoryStatus,versionId:string,previewDigest:string):ProjectHistoryResolveInput {
 return {projectId:status.projectId,requestId:randomUUID(),expected:status.file,historyIdentity:status.historyIdentity,confirmationDigest:status.confirmationDigest,action:'restore-version',versionId,previewDigest};
}

test('prepared intent never mutates old-format or forged-current source, sidecars, local directories or registry',async t=>{
 for(const variant of ['format2-hot','forged3-schema'] as const)await t.test(variant,async child=>{
  const f=await fixture(child);await f.stop('prepared');
  const db=new DatabaseSync(f.registration.projectFile);
  if(variant==='format2-hot')db.exec('PRAGMA user_version=2');
  else db.exec('ALTER TABLE project_file RENAME COLUMN contentToken TO oldContentToken');
  db.close();if(variant==='format2-hot')writeFileSync(f.registration.projectFile+'-journal',Buffer.from([1,2,3,4]));
  const before=snapshot(f.root),registered=f.registry.list(),count=f.counts.factory;
  assert.throws(()=>recoverHistorySwitch(f.options));assert.deepEqual(snapshot(f.root),before);
  await assert.rejects(f.manager.acquire(f.projectId,'window'));assert.deepEqual(snapshot(f.root),before);
  assert.deepEqual(f.registry.list(),registered);assert.equal(f.counts.factory,count);
 });
});

test('prepared/staged source identity replacements are refused without publishing or overwriting either file',async t=>{
 for(const point of ['prepared','staged'] as const)for(const target of ['project','history'] as const)await t.test(`${point}-${target}`,async child=>{
  const f=await fixture(child);await f.stop(point);const file=target==='project'?f.registration.projectFile:f.historyFile,kept=file+'.original';
  renameSync(file,kept);copyFileSync(kept,file);assert.notEqual(lstatSync(file).ino,lstatSync(kept).ino);
  const before=snapshot(f.root);assert.throws(()=>recoverHistorySwitch(f.options),{code:target==='project'||point==='prepared'?'PROJECT_HISTORY_BASELINE_CHANGED':'PROJECT_HISTORY_SWITCH_INVALID'});
  assert.deepEqual(snapshot(f.root),before);assert.equal(readdirSync(f.local.localDir).filter(name=>/^history-\d/u.test(name)).length,0);
 });
});

test('a changed exact project stamp after prepared or staged confirmation cannot be acknowledged or restored',async t=>{
 for(const point of ['prepared','staged'] as const)await t.test(point,async child=>{
  const f=await fixture(child);await f.stop(point);const db=new DatabaseSync(f.registration.projectFile);
  db.exec("UPDATE projects SET data=json_set(data,'$.name','Even later','$.revision',json_extract(data,'$.revision')+1)");db.close();
  const before=snapshot(f.root);assert.throws(()=>recoverHistorySwitch(f.options),{code:'PROJECT_HISTORY_BASELINE_CHANGED'});
  assert.deepEqual(snapshot(f.root),before);assert.equal(readdirSync(f.local.localDir).filter(name=>/^history-\d/u.test(name)).length,0);
 });
});

test('a real cached node foreign reference is ignored by empty preview and cleared before the same restore plan is applied',async t=>{
 const nodeId=randomUUID(),f=await fixture(t,store=>store.tx(()=>{
  store.put('nodes',{id:nodeId,projectId:store.projectId,type:'previs',label:'cached',text:'',position:{x:0,y:0},revision:1,sceneRevision:1,scene:defaultPrevisScene(),createdAt:'2026-11-04T00:00:00.000Z'});
  store.db.prepare("INSERT INTO cache.previs_thumbnails VALUES(?,'card',?,?,1,1,1,?,?)").run(nodeId,store.projectId,'a'.repeat(64),Buffer.from([0xff,0xd8,0xff,0xd9]),'2026-11-04T00:00:00.000Z');
 }));
 const lease=await f.manager.acquire(f.projectId,'window'),session=lease.host.recovery!,status=session.status(),preview=session.previewVersion({projectId:f.projectId,versionId:f.version.id});
 assert.equal(lease.host.store.db.prepare('SELECT count(*) AS n FROM cache.previs_thumbnails WHERE nodeId=?').get(nodeId)?.n,1);
 assert.ok(preview.changes.some(change=>change.table==='nodes'&&change.action==='remove'));
 const input=restoreInput(status,f.version.id,preview.previewDigest);lease.release();
 const result=await f.manager.resolveHistory(input),current=await f.manager.acquire(f.projectId,'window');
 assert.equal(current.host.recovery,undefined);assert.equal(current.host.store.get('nodes',nodeId),null);
 assert.equal(current.host.store.db.prepare('SELECT count(*) AS n FROM cache.previs_thumbnails').get()?.n,0);
 assert.ok(result.content.contentSequence>status.file.contentSequence);assert.notEqual(result.content.contentToken,status.file.contentToken);current.release();
});

test('a failure after a copied blob rolls the stage back and the identical confirmation safely retries once',async t=>{
 const f=await fixture(t),source=sha(f.registration.projectFile),history=sha(f.historyFile),identity=lstatSync(f.historyFile).ino;
 const prepare=DatabaseSync.prototype.prepare;let hits=0;
 const mocked=t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
  const statement=prepare.call(this,sql);
  if(sql.startsWith('INSERT INTO main.project_version_blobs(')){
   const run=statement.run.bind(statement);
   statement.run=(...values:unknown[]):never=>{Reflect.apply(run,statement,values);hits++;throw Error('injected partial version copy');};
  }
  return statement;
 });
 await assert.rejects(f.manager.resolveHistory(f.input),/injected partial version copy/);mocked.mock.restore();
 assert.equal(hits,1);assert.equal(sha(f.registration.projectFile),source);assert.equal(sha(f.historyFile),history);assert.equal(lstatSync(f.historyFile).ino,identity);
 assert.equal(readdirSync(f.local.localDir).filter(name=>/^history-\d/u.test(name)).length,0);
 const staged=path.join(f.local.localDir,`history.staged-${f.input.requestId}.db`),partial=new DatabaseSync(staged);
 try{assert.equal(partial.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()?.n,0);}finally{partial.close();}
 const result=await f.manager.resolveHistory(f.input);assert.deepEqual(await f.manager.resolveHistory(f.input),result);
 assert.equal(readdirSync(f.local.localDir).filter(name=>/^history-\d/u.test(name)).length,1);
 const current=await f.manager.acquire(f.projectId,'window');assert.equal(current.host.store.db.prepare('SELECT count(*) AS n FROM project_versions WHERE id=?').get(f.version.id)?.n,1);current.release();
});
