import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,readFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {openStore} from '../packages/business/src/db.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {createWorkspaceBackup,verifyWorkspaceBackup} from '../packages/business/src/workspace-backup.ts';
import {restoreWorkspaceBackup} from '../packages/business/src/workspace-restore.ts';
import {getWorkspaceRestoreContext} from '../packages/business/src/workspace-restore-schema.ts';
import {defaultVideoModels} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration,VideoExecutionBinding} from '../packages/contracts/src/video-providers.ts';

const SESSION_KEY='synthetic-video-backup-session-key',PERSISTENT_KEY='synthetic-video-backup-persistent-key';
function syntheticCodec(){const key=randomBytes(32);return {
 encrypt(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString('base64');},
 decrypt(value:string){const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([cipher.update(bytes.subarray(12,-16)),cipher.final()]).toString();},
};}
async function files(root:string):Promise<string[]>{const entries=await readdir(root,{withFileTypes:true});return (await Promise.all(entries.map(async entry=>entry.isDirectory()?await files(path.join(root,entry.name)):[path.join(root,entry.name)]))).flat();}

test('frozen video jobs survive backup and restore while session keys, encrypted credentials and private settings stay excluded',async t=>{
 const base=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-video-backup-'))),source=path.join(base,'source'),backup=path.join(base,'backup'),destination=path.join(base,'restored');
 let sourceStore:ReturnType<typeof openStore>|undefined=openStore(source),restoredStore:ReturnType<typeof openStore>|undefined;
 let settings:Awaited<ReturnType<typeof createVideoSettings>>|undefined,services:ReturnType<typeof createServices>|undefined,restoredServices:ReturnType<typeof createServices>|undefined,worker:ReturnType<typeof startWorker>|undefined;
 let remoteCalls=0;
 t.after(async()=>{await worker?.stop();await restoredServices?.drain();restoredStore?.close();await services?.drain();await settings?.close();sourceStore?.close();await rm(base,{recursive:true,force:true});});
 settings=await createVideoSettings({directory:path.join(source,'video-settings'),privateRoot:source,secretCodec:syntheticCodec(),storage:{persistentAvailable:true,sessionScope:'server',reasonCode:null}});
 services=createServices(sourceStore,createProviderRegistry({db:sourceStore.db,root:source,env:{}}),{videoSettings:settings,profileNow:()=>Date.UTC(2026,9,20),videoFetch:async()=>{remoteCalls++;return assert.fail('Backup validation must never contact a video provider');}});
 await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
 const project=await services.call('project.create',{name:'Video credential isolation'}) as ServiceRow,jobs:JobRecord[]=[],requests:Array<Record<string,unknown>>=[];
 for(const [index,storage] of ['session','persistent'].entries()){
  const configuration:VideoConnectionConfiguration={id:randomUUID(),providerId:'minimax',name:`Account ${storage}`,region:index?'cn':'global',workspaceId:'',enabled:true,archived:false,outputHosts:[],models:defaultVideoModels('minimax')};
  await settings.put({action:'save',expectedRevision:index,configuration,secret:{action:'replace',storage,value:index?PERSISTENT_KEY:SESSION_KEY}});
  const shot=await services.call('shot.create',{projectId:project.id,title:`Frozen ${storage} job`,prompt:'Synthetic blue shapes move slowly.',aspectRatio:'9:16',duration:4,referenceAssetIds:[]}) as ServiceRow;
  const input={shotId:shot.id,expectedRevision:shot.revision,requestId:randomUUID(),providerId:configuration.providerId,model:configuration.models[0]!.modelId,connectionId:configuration.id,configurationRevision:1,modelEntryId:configuration.models[0]!.id};
  const job=await services.call('generation.submit',input) as JobRecord,binding=job.snapshot.executionBinding as VideoExecutionBinding;
  assert.equal(binding.connectionId,configuration.id);assert.equal(binding.configurationRevision,1);assert.equal(await settings.acquire(binding),index?PERSISTENT_KEY:SESSION_KEY);
  assert.equal(job.status,'queued');assert.doesNotMatch(JSON.stringify(job),/synthetic-video-backup-(?:session|persistent)-key|encrypted/);jobs.push(structuredClone(job));requests.push(input);
 }
 const safeSettings=await settings.get();assert.deepEqual(safeSettings.connections.map(value=>value.secret.storage),['session','persistent']);assert.equal(remoteCalls,0);
 const privateBytes=await readFile(path.join(source,'video-settings/settings.json')),privateEnvelope=JSON.parse(privateBytes.toString('utf8')) as {credentials:Array<{encrypted:string|null}>};
 const encrypted=privateEnvelope.credentials.find(value=>value.encrypted)!.encrypted!;assert.ok(encrypted);assert.equal(privateBytes.includes(Buffer.from(SESSION_KEY)),false);assert.equal(privateBytes.includes(Buffer.from(PERSISTENT_KEY)),false);
 await services.drain();services=undefined;await settings.close();settings=undefined;sourceStore.close();sourceStore=undefined;
 const sourceDatabase=await readFile(path.join(source,'workbench.sqlite'));
 for(const secret of [SESSION_KEY,PERSISTENT_KEY,encrypted])assert.equal(sourceDatabase.includes(Buffer.from(secret)),false);
 const created=await createWorkspaceBackup({source,destination:backup});assert.equal(created.integrity,'verified');assert.equal(created.databaseSchemaVersion,60);assert.deepEqual(await verifyWorkspaceBackup({directory:backup}),created);
 const manifest=JSON.parse(await readFile(path.join(backup,'manifest.json'),'utf8')) as {entries:Array<{path:string}>};assert.deepEqual(manifest.entries.map(value=>value.path),['payload/workbench.sqlite']);
 for(const file of await files(backup)){assert.equal(path.relative(backup,file).includes('video-settings'),false);const bytes=await readFile(file);for(const secret of [SESSION_KEY,PERSISTENT_KEY,encrypted])assert.equal(bytes.includes(Buffer.from(secret)),false,`${path.relative(backup,file)} excludes credential material`);}
 assert.deepEqual(await readFile(path.join(backup,'payload/workbench.sqlite')),sourceDatabase);assert.deepEqual(await readFile(path.join(source,'video-settings/settings.json')),privateBytes);
 await restoreWorkspaceBackup({directory:backup,destination});await assert.rejects(access(path.join(destination,'video-settings')));
 restoredStore=openStore(destination);assert.equal(getWorkspaceRestoreContext(restoredStore)?.schemaVersion,61);restoredServices=createServices(restoredStore,new Map());
 const storedJobs=()=>restoredStore!.db.prepare('SELECT id,data FROM jobs ORDER BY id').all();const before=storedJobs(),changes=restoredStore.db.prepare('SELECT total_changes() AS n').get()!.n;
 for(const [index,job] of jobs.entries()){
  const held=await restoredServices.call('job.get',{jobId:job.id}) as JobRecord;assert.deepEqual(held.snapshot,job.snapshot);
  assert.doesNotMatch(JSON.stringify(held),/synthetic-video-backup-(?:session|persistent)-key|encrypted/);
  await assert.rejects(restoredServices.call('job.retry',{jobId:job.id,requestId:randomUUID()}),{code:'RESTORED_RECORD_HELD'});
  await assert.rejects(restoredServices.call('generation.submit',requests[index]!),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 }
 await assert.rejects(restoredServices.call('video.connection.list',{}),{code:'RESTORE_OPERATION_UNAVAILABLE'});
 worker=startWorker(restoredStore,restoredServices,new Proxy(new Map(),{get(){return assert.fail('Restored frozen jobs cannot inspect a video provider');}}));await worker.tick();await worker.stop();worker=undefined;
 assert.deepEqual(storedJobs(),before);assert.equal(restoredStore.db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.equal(remoteCalls,0);
});
