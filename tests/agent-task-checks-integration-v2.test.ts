import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {createServices} from '../packages/business/src/services.ts';
import {createAgentTaskJournal} from '../packages/business/src/agent/task-journal-v2.ts';
import {createWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {startServer} from '../apps/server/src/index.ts';
import type {InspectProject} from '../apps/server/src/index.ts';
import {agentTaskChecksSchema} from '../packages/contracts/src/agent-tasks-v2.ts';
import {createServerProject,openProjectDatabase,projectDirFor,schemaObjects} from './helpers/project-database.ts';

function object(value:unknown):Record<string,unknown>{assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;}
function wav():Buffer {
 const bytes=Buffer.alloc(44+96000);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(96000,40);return bytes;
}
function dumpDb(db:DatabaseSync):unknown {
 return schemaObjects(db).filter(({name})=>!name.startsWith('sqlite_')).map(({name,sql})=>({name,sql,...(String(sql).startsWith('CREATE TABLE')?{rows:db.prepare(`SELECT * FROM "${name}"`).all().map(item=>JSON.stringify(item)).sort()}:{})}));
}
async function savedTimeline(root:string){
 const created=createServerProject(root,{name:'Checks integration'}),store=created.store,services=createServices(store,new Map());
 try{
  const projectId=created.projectId;
  const asset=object(await services.call('asset.import',{projectId,name:'checks.wav',mimeType:'audio/wav',dataBase64:wav().toString('base64')}));
  const saved=object(store.get('assets',String(asset.id))),relativePath=String(saved.relativePath),timelineId=randomUUID(),trackId=randomUUID(),stamp='2026-10-28T00:00:00.000Z';
  store.put('timelines',{id:timelineId,projectId,revision:1,fps:30,width:720,height:1280,durationFrames:30,createdAt:stamp,updatedAt:stamp,
   tracks:[{id:trackId,kind:'audio',name:'Audio',orderIndex:0,hidden:false,muted:false}],
   clips:[{id:randomUUID(),trackId,assetId:asset.id,name:'checks.wav',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}]});
  const journal=createAgentTaskJournal(store),run=journal.create({projectId,requestId:randomUUID(),text:'Synthetic saved timeline edit',configuration:{}}).run;
  const step=journal.beginStep(run.id,{kind:'tool',toolCall:{id:'saved_timeline',name:'mioon_timeline_clip_add',arguments:{}},targets:[{kind:'timeline',id:timelineId,revision:1}]});
  journal.markDispatch(run.id,step.id);journal.completeStep(run.id,step.id,{result:{id:timelineId,revision:1},change:{projectId,operation:'timeline.clip.add',targets:[{kind:'timeline',id:timelineId,revision:1}],before:null,after:null,reversible:false}});
  journal.transition(run.id,journal.run(run.id).revision,'completed');
  return {projectId,runId:run.id,timelineId,relativePath};
 }finally{await services.drain();store.close();}
}

for(const restored of [false,true])test(`${restored?'restored':'ordinary'} checks run the complete local preflight and observe missing media without database writes`,{timeout:60000},async()=>{
 const base=mkdtempSync(join(realpathSync(tmpdir()),'mioon-checks-integration-')),source=join(base,'source');
 let server:Awaited<ReturnType<typeof startServer>>|undefined,models=0,inspect!:InspectProject;
 try{
  const saved=await savedTimeline(source),root=restored?join(base,'restored'):source;
  if(restored){const backup=join(base,'backup');await createWorkspaceBackup({source,destination:backup});await restoreWorkspaceBackup({directory:backup,destination:root});}
  server=await startServer({dataDir:root,port:0,taskGatewayV2:async function*(){models++;throw Error('Checks must not request a model');},inspectProject:received=>{inspect=received;}});
  // While the server runs, the database is read on its own connection.
  const before=inspect(saved.projectId,dumpDb),read=async(preflight=false)=>{
   const response=await fetch(`${server!.url}/api/agent/tasks/v2/${saved.projectId}/${saved.runId}/checks${preflight?'?preflight=1':''}`,{headers:{Authorization:`Bearer ${server!.token}`}});
   assert.equal(response.status,200);const envelope=object(await response.json());assert.equal(envelope.ok,true);return agentTaskChecksSchema.parse(envelope.data);
  };
  const lightweight=await read(),defaultItems=lightweight.groups.find(group=>group.id==='timeline')!.items;
  assert.equal(defaultItems.find(item=>item.type==='timeline_references')?.status,'passed');
  assert.equal(defaultItems.find(item=>item.type==='timeline_preflight')?.status,'pending');
  assert.equal(defaultItems.find(item=>item.type==='timeline_preflight')?.reason?.code,'PREFLIGHT_NOT_REQUESTED');
  const initial=await read(true),items=initial.groups.find(group=>group.id==='timeline')!.items;
  assert.equal(items.find(item=>item.type==='timeline_references')?.status,'passed');
  assert.equal(items.find(item=>item.type==='timeline_preflight')?.status,'passed');
  assert.ok(items.every(item=>item.basis.some(basis=>basis.kind==='timeline'&&basis.id===saved.timelineId&&basis.revision===1)));
  assert.deepEqual(inspect(saved.projectId,dumpDb),before);
  unlinkSync(join(root,saved.relativePath));
  const unchangedDefault=await read(),notRequested=unchangedDefault.groups.find(group=>group.id==='timeline')!.items.find(item=>item.type==='timeline_preflight');
  assert.equal(notRequested?.status,'pending');assert.equal(notRequested.reason?.code,'PREFLIGHT_NOT_REQUESTED');
  const changed=await read(true),preflight=changed.groups.find(group=>group.id==='timeline')!.items.find(item=>item.type==='timeline_preflight');
  assert.equal(preflight?.status,'failed');assert.equal(preflight.reason?.code,'PREFLIGHT_BLOCKED');
  assert.doesNotMatch(JSON.stringify(changed),/relativePath|snapshotHash|workbench\.sqlite|\/private\//u);
  assert.equal(changed.runRevision,initial.runRevision);assert.equal(models,0);assert.deepEqual(inspect(saved.projectId,dumpDb),before);
  await server.close();server=undefined;
  const reopened=openProjectDatabase(projectDirFor(root,saved.projectId));
  try{assert.deepEqual(dumpDb(reopened),before);}finally{reopened.close();}
 }finally{await server?.close();rmSync(base,{recursive:true,force:true});}
});
