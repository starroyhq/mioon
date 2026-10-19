import test, {mock, after} from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {openNewOpacityCandidateApplicationStore, reopenOpacityCandidateApplicationStore, isOpacityCandidateApplicationStore, getOpacityCandidateAssembly} from '../packages/business/src/opacity-candidate-store.ts';
import {createOpacityCandidateApplicationServices} from '../packages/business/src/opacity-candidate-services.ts';
import {initializeOpacityLegacyThrough40} from '../packages/business/src/workspace-opacity-legacy.ts';
import {initializeWorkspaceSchema42} from '../packages/business/src/workspace-schema-v42.ts';
import {installWorkspaceRestoreSchemaV43} from '../packages/business/src/workspace-restore-schema-v43.ts';
import {createWorkspaceRestoreProfileV41} from '../packages/business/src/workspace-restore-schema-v41.ts';
import {initializeWorkspaceSchemaThrough24} from '../packages/business/src/workspace-fixed-schema.ts';
import {createExistingOpacityCandidateLaunch, consumeOpacityCandidateLaunch, closeUnusedOpacityCandidateLaunch} from '../apps/server/src/opacity-candidate-launch.ts';
import {parseOpacityCandidateArguments} from '../apps/server/src/opacity-candidate-cli.ts';
import {mkdtempPortable} from './helpers/temp-root.ts';

let attempts=0;
const forbidden=()=>{attempts++;throw Error('No listener or native process in reopen qualification');};
(mock.method as unknown as (object: object, name: string, impl: () => never) => unknown)(http.Server.prototype,'listen',forbidden);
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])(mock.method as unknown as (object: object, name: string, impl: () => never) => unknown)(cp,name,forbidden);
syncBuiltinESMExports();
after(()=>{mock.restoreAll();syncBuiltinESMExports();assert.equal(attempts,0);});
const hash=(file: string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const metadata=()=>({restorationId:randomUUID(),workspaceOrigin:randomUUID(),sourceBackupId:randomUUID(),manifestHash:'a'.repeat(64),sourceDbHash:'b'.repeat(64),createdAt:'2026-10-16T00:00:00.000Z'});
function parent(t: TestContext){const root=mkdtempPortable('mioon-opacity-reopen-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function seedDatabase(root: string,version: number){
 fs.mkdirSync(root,{mode:0o700});const db=new DatabaseSync(path.join(root,'workbench.sqlite'));
 try{
  db.exec('PRAGMA trusted_schema=OFF;PRAGMA foreign_keys=ON;');
  if(version===40||version===41)initializeOpacityLegacyThrough40(db);else initializeWorkspaceSchema42(db);
  if(version===41)createWorkspaceRestoreProfileV41(initializeWorkspaceSchemaThrough24).installWorkspaceRestoreSchemaV41(db,metadata());
  if(version===43)installWorkspaceRestoreSchemaV43(db,metadata());
 }finally{db.close();}
}

test('explicit reopen never creates missing roots/databases and keeps new/open CLI actions exclusive',(t: TestContext)=>{
 const base=parent(t),missing=path.join(base,'missing'),empty=path.join(base,'empty');
 assert.throws(()=>reopenOpacityCandidateApplicationStore(missing));assert.equal(fs.existsSync(missing),false);
 fs.mkdirSync(empty,{mode:0o700});assert.throws(()=>reopenOpacityCandidateApplicationStore(empty));assert.deepEqual(fs.readdirSync(empty),[]);
 assert.deepEqual(parseOpacityCandidateArguments(['--open-workspace',empty,'--port','4320']),{directory:empty,port:4320,mode:'open'});
 for(const args of [['--open-workspace','relative'],['--open-workspace',empty,'--new-workspace',missing],['--new-workspace',missing,'--open-workspace',empty],['--open-workspace',empty,'--open-workspace',empty]])assert.throws(()=>parseOpacityCandidateArguments(args));
 assert.throws(()=>createExistingOpacityCandidateLaunch('relative'),{code:'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
});

test('reopen refuses exact40/41/43, unknown catalog and corrupt SQLite without modifying original database bytes',(t: TestContext)=>{
 const base=parent(t);
 for(const version of [40,41,43]){
  const root=path.join(base,`profile${version}`);seedDatabase(root,version);const file=path.join(root,'workbench.sqlite'),before=hash(file);
  assert.throws(()=>reopenOpacityCandidateApplicationStore(root),{code:'RESTORE_SCHEMA_UNSUPPORTED'});
  assert.equal(hash(file),before);assert.equal(fs.existsSync(path.join(root,'server.lock')),false);
 }
 for(const kind of ['catalog','corrupt','empty']){
  const root=path.join(base,kind);seedDatabase(root,42);const file=path.join(root,'workbench.sqlite');
  if(kind==='catalog'){const db=new DatabaseSync(file);try{db.exec('CREATE TABLE unsupported(value TEXT)');}finally{db.close();}}
  else fs.writeFileSync(file,kind==='empty'?Buffer.alloc(0):Buffer.from('not a SQLite database'));
  const before=hash(file);assert.throws(()=>reopenOpacityCandidateApplicationStore(root));assert.equal(hash(file),before);assert.equal(fs.existsSync(path.join(root,'server.lock')),false);
 }
});

test('occupied owner lock and unsafe managed files are refused without taking over or repairing them',(t: TestContext)=>{
 const base=parent(t),root=path.join(base,'owned'),owned=openNewOpacityCandidateApplicationStore(root),lock=path.join(root,'server.lock');
 const before=fs.readFileSync(lock);try{assert.throws(()=>reopenOpacityCandidateApplicationStore(root),/running backend/);assert.deepEqual(fs.readFileSync(lock),before);assert.equal(getOpacityCandidateAssembly(owned)!.ownsLock(),true);}finally{owned.close();}
 const link=path.join(base,'linked');fs.mkdirSync(link,{mode:0o700});fs.symlinkSync(path.join(root,'workbench.sqlite'),path.join(link,'workbench.sqlite'));
 assert.throws(()=>reopenOpacityCandidateApplicationStore(link),(error: unknown)=>(error as {code?: string}).code==='STORAGE_PRIVATE_REQUIRED');assert.equal(fs.lstatSync(path.join(link,'workbench.sqlite')).isSymbolicLink(),true);
});

test('clean reopened application gets a new exact owner capability and preserved project while generic copies do not',async (t: TestContext)=>{
 const base=parent(t),root=path.join(base,'app'),first=openNewOpacityCandidateApplicationStore(root),services=createOpacityCandidateApplicationServices(first);
 const project=await services.call('project.create',{name:'Reopened exact42'}) as unknown as {id: string},old=getOpacityCandidateAssembly(first)!;
 await services.drain();first.close();
 const launch=createExistingOpacityCandidateLaunch(root);
 for(const value of [{...launch},JSON.parse(JSON.stringify(launch))])assert.throws(()=>consumeOpacityCandidateLaunch(value),{code:'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
 const reopened=consumeOpacityCandidateLaunch(launch),next=createOpacityCandidateApplicationServices(reopened.store);
 try{assert.equal(isOpacityCandidateApplicationStore(reopened.store),true);assert.equal(isOpacityCandidateApplicationStore({...reopened.store}),false);
  assert.notEqual(getOpacityCandidateAssembly(reopened.store),old);assert.throws(old.checkpoint,{code:'RESTORE_STORE_UNVERIFIED'});
  assert.deepEqual(await next.call('project.list',{}),[project]);assert.throws(()=>consumeOpacityCandidateLaunch(launch),{code:'OPACITY_CANDIDATE_LAUNCH_REQUIRED'});
 }finally{await next.drain();reopened.store.close();}
 const unused=createExistingOpacityCandidateLaunch(root);closeUnusedOpacityCandidateLaunch(unused);assert.equal(fs.existsSync(path.join(root,'server.lock')),false);
});

test('reopen retains complete raw opacity/source ownership validation',async (t: TestContext)=>{
 const base=parent(t),root=path.join(base,'invalid-source'),store=openNewOpacityCandidateApplicationStore(root),services=createOpacityCandidateApplicationServices(store);
 const project=await services.call('project.create',{name:'Opacity source owner'}) as unknown as {id: string},foreign=await services.call('project.create',{name:'Foreign owner'}) as unknown as {id: string},assetId=randomUUID();
 store.put('assets',{id:assetId,projectId:project.id,name:'Synthetic metadata',mimeType:'video/mp4',duration:1,width:720,height:1280,hasVideo:true,hasAudio:false,sha256:'a'.repeat(64),relativePath:`media/${assetId}.mp4`,createdAt:'2026-10-16T00:00:00.000Z'});
 const timeline=await services.call('timeline.get',{projectId:project.id}) as unknown as {revision: number; tracks: Array<{id: string}>};
 await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),assetId,trackId:timeline.tracks[0]!.id,startFrame:0,durationFrames:30,
  opacityEnvelope:{profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:30,opacity:1}]}});
 store.db.prepare('UPDATE assets SET projectId=? WHERE id=?').run(foreign.id,assetId);await services.drain();store.close();
 const before=hash(path.join(root,'workbench.sqlite'));assert.throws(()=>reopenOpacityCandidateApplicationStore(root),{code:'WORKSPACE_OPACITY_INVALID'});
 assert.equal(hash(path.join(root,'workbench.sqlite')),before);assert.equal(fs.existsSync(path.join(root,'server.lock')),false);
});
