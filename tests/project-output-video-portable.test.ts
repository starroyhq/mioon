import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,cp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {openProjectStore} from '../packages/business/src/project-file/index.ts';
import {createServices} from '../packages/business/src/services.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {run} from '../packages/business/src/media.ts';
import {createOwnedMediaGraphReader} from '../packages/business/src/inspection.ts';
import {projectOutputPublicationProofSchema} from '../packages/contracts/src/project-output-publication.ts';
import {INSPECTION_ROW_LIMITS} from '../packages/business/src/inspection-query.ts';
import {readVersionComparisonMedia} from '../apps/server/src/version-comparison-media.ts';

const row=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
const invalid={code:'INSPECTION_UNAVAILABLE'};
async function fixture(t:TestContext){
 const root=await mkdtemp(path.join(tmpdir(),'mioon-portable-video-')),original=openStore(path.join(root,'original')),source=path.join(root,'source.mp4');
 const calls={submit:0,poll:0,download:0};let worker:ReturnType<typeof startWorker>|undefined,closed=false,received:ReturnType<typeof openProjectStore>|undefined;
 const provider:Provider={id:'ark',capabilities:{models:['fixture'],inputModes:['text'],aspectRatios:['9:16'],durations:[4],configured:true,enabled:true,mock:false},
  submit:async()=>{calls.submit++;return{providerJobId:'completed-portable-video'};},poll:async()=>{calls.poll++;return{status:'succeeded'};},reconcile:async()=>null,download:async(_id,file)=>{calls.download++;await copyFile(source,file);}};
 const providers=new Map([['ark',provider]]),services=createServices(original,providers);
 t.after(async()=>{try{await worker?.stop();if(!closed){await services.drain();original.close();}received?.close();}finally{await rm(root,{recursive:true,force:true});}});
 await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=blue:s=144x256:r=30:d=0.2','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',source],{timeout:30000});
 const project=row(await services.call('project.create',{name:'Portable worker video'})),projectId=String(project.id),shot=row(await services.call('shot.create',{projectId,title:'Published source',prompt:'Blue fixture',duration:4}));
 const accepted=row(await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'ark',requestId:randomUUID()})),jobId=String(accepted.id);
 worker=startWorker(original,services,providers);await worker.tick();await worker.tick();await worker.stop();worker=undefined;
 const job=row(original.get('jobs',jobId));assert.equal(job.status,'succeeded',JSON.stringify(job.error));assert.deepEqual(calls,{submit:1,poll:1,download:1});
 const versionId=String(job.versionId),version=row(original.get('versions',versionId)),assetId=String(version.assetId),asset=row(original.get('assets',assetId));
 createOwnedMediaGraphReader(original.db,projectId).version(versionId);
 await services.drain();original.close();closed=true;
 const receivedDir=path.join(root,'received');await mkdir(receivedDir,{mode:0o755});await cp(path.join(root,'original','project.mioon'),path.join(receivedDir,'project.mioon'));
 await cp(path.join(root,'original','生成'),path.join(receivedDir,'生成'),{recursive:true,preserveTimestamps:true});
 received=openProjectStore({projectFile:path.join(receivedDir,'project.mioon'),locate:()=>({localDir:path.join(root,'received-records'),cacheDir:path.join(root,'received-cache'),tempDir:path.join(root,'received-temp')})});
 const db=received.db,url=new URL('/api/version-comparison/media?'+new URLSearchParams({projectId,shotId:String(version.shotId),versionId,assetId,sha256:String(asset.sha256)}),'http://127.0.0.1');
 return {store:received,projectId,jobId,job,versionId,version,assetId,asset,calls,comparison:()=>readVersionComparisonMedia(db,url,id=>createOwnedMediaGraphReader(db,id))};
}

test('a real worker video remains a zero-write owned version in a project-only copy without local jobs',async t=>{
 const f=await fixture(t),before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n,graph=createOwnedMediaGraphReader(f.store.db,f.projectId);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM jobs').get()!.n,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM job_events').get()!.n,0);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM idempotency').get()!.n,0);
 assert.deepEqual(graph.version(f.versionId),f.version);assert.deepEqual(graph.asset(f.assetId),f.asset);assert.deepEqual(graph.legacySource(f.assetId),f.version);
 assert.ok(f.comparison());
 assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.deepEqual(f.calls,{submit:1,poll:1,download:1});
});

test('portable video proof, snapshot and hidden typed publication markers cannot forge ownership',async t=>{
 const f=await fixture(t);
 // Simulate an externally damaged immutable project record. The real opener,
 // source graph and all ownership assertions remain in use for these negatives.
 f.store.db.exec('DROP TRIGGER project.immutable_versions');
 for(const damage of ['owner','hash','asset','size','snapshot'] as const){
  const asset=structuredClone(f.asset),version=structuredClone(f.version),proof=projectOutputPublicationProofSchema.parse(asset.publication);
  if(damage==='owner')proof.owner.id=randomUUID();if(damage==='hash')proof.sha256='f'.repeat(64);if(damage==='asset')proof.assetId=randomUUID();if(damage==='size')proof.sizeBytes++;
  asset.publication=proof;if(damage==='snapshot')row(version.snapshot).shotId=randomUUID();
  f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(asset),f.assetId);f.store.db.prepare('UPDATE versions SET data=? WHERE id=?').run(JSON.stringify(version),f.versionId);
  assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(f.assetId),invalid,damage);
  assert.equal(f.comparison(),null,damage);
 }
 f.store.db.prepare('UPDATE assets SET data=? WHERE id=?').run(JSON.stringify(f.asset),f.assetId);f.store.db.prepare('UPDATE versions SET data=? WHERE id=?').run(JSON.stringify(f.version),f.versionId);
 for(const kind of ['image','generation'] as const){
  const id=randomUUID(),proof=projectOutputPublicationProofSchema.parse(f.asset.publication);proof.assetId=id;proof.owner.kind=kind;
  const forged={...f.asset,id,provenance:'user-import',publication:proof};f.store.put('assets',forged);
  assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).asset(id),invalid,`${kind} marker cannot hide behind user-import`);
 }
});

test('local job evidence, malformed jobs and oversized jobs prevent portable video fallback',async t=>{
 for(const evidence of ['event','request','mock-submission','disposition','bad-job','oversized-job'] as const){
  const f=await fixture(t),proof=projectOutputPublicationProofSchema.parse(f.asset.publication),stamp=new Date().toISOString();
  if(evidence==='event')f.store.db.prepare('INSERT INTO job_events(jobId,event,createdAt) VALUES(?,?,?)').run(f.jobId,'{}',stamp);
  if(evidence==='request')f.store.db.prepare("INSERT INTO idempotency(scope,requestId,requestHash,resourceId) VALUES('generation',?,?,?)").run(proof.owner.requestId,proof.owner.inputHash,f.jobId);
  if(evidence==='mock-submission')f.store.db.prepare('INSERT INTO mock_provider_submissions(request_id,job_id,provider_job_id,created_at_ms,outcome) VALUES(?,?,?,?,?)').run(proof.owner.requestId,f.jobId,'old-local-provider',Date.now(),'succeeded');
  if(evidence==='disposition')f.store.db.prepare("INSERT INTO task_dispositions(projectId,kind,taskId,revision,archivedAt,sourceStatus,createdAt,updatedAt) VALUES(?,'generation',?,1,?,'succeeded',?,?)").run(f.projectId,f.jobId,stamp,stamp,stamp);
  if(evidence==='bad-job'||evidence==='oversized-job')f.store.put('jobs',{...f.job,versionId:randomUUID(),...(evidence==='oversized-job'?{privatePayload:'x'.repeat(INSPECTION_ROW_LIMITS.jobs+1)}:{})});
  const before=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;assert.throws(()=>createOwnedMediaGraphReader(f.store.db,f.projectId).version(f.versionId),invalid,evidence);
  assert.equal(f.comparison(),null,evidence);
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,before);assert.deepEqual(f.calls,{submit:1,poll:1,download:1});
 }
});
