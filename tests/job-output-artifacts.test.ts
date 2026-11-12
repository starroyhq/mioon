import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,readFileSync,statSync} from 'node:fs';
import {mkdtemp,copyFile,readFile,readdir,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord} from '../packages/business/src/services.ts';
import type {Provider} from '../packages/business/src/provider-registry.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {run} from '../packages/business/src/media.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {setProjectOutputPublicationTestHooks,isPublishedProjectOutput} from '../packages/business/src/project-output-publication.ts';
import type {ProjectOutputPublicationProof} from '../packages/business/src/project-output-publication.ts';
import {outputArtifactSchema} from '../packages/contracts/src/output-artifact.ts';
import {writePrivateFileAtomic} from '../packages/contracts/src/private-storage.ts';
import {isTimelineExportAudioOutcome} from '../packages/contracts/src/timeline-export-float.ts';
import {isTimelineRenderRecord} from '../packages/contracts/src/timeline-acknowledgement.ts';
import {timelineDeliveryContentDisposition} from '../packages/contracts/src/timeline-delivery.ts';
import {readTimelineDeliveryDownload} from '../packages/business/src/timeline-delivery-read.ts';
import {readOwnedTimelineAsset} from '../packages/business/src/timeline-sources.ts';

const row=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;};
async function sourceFile(root:string):Promise<string>{const file=path.join(root,'source.mp4');await run('ffmpeg',['-hide_banner','-loglevel','error','-n','-f','lavfi','-i','color=c=blue:s=144x256:r=30:d=0.2','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',file],{timeout:30000});return file;}

function changeCtimeBeforeRegistration(store: ReturnType<typeof openStore>, targetKind: 'exports' | 'generated') {
  let changed: ProjectOutputPublicationProof | undefined;
  const clear = setProjectOutputPublicationTestHooks(store, {fault(point, proof) {
    if (point !== 'after_final' || proof.targetKind !== targetKind || changed) return;
    assert.equal(store.db.isTransaction, false);
    assert.equal(store.get('assets', proof.assetId), null);
    const file = path.join(store.projectDir, proof.relativePath);
    const before = statSync(file, {bigint: true});
    const bytes = readFileSync(file);
    const mode = Number(before.mode & 0o777n);
    chmodSync(file, mode ^ 0o200);
    chmodSync(file, mode);
    const after = statSync(file, {bigint: true});
    for (const field of ['dev', 'ino', 'birthtimeNs', 'size', 'mode', 'mtimeNs', 'nlink'] as const) {
      assert.equal(after[field], before[field], field);
    }
    assert.notEqual(after.ctimeNs, before.ctimeNs, 'the fixture must change ctime');
    assert.deepEqual(readFileSync(file), bytes);
    changed = proof;
  }});
  return {clear, proof: () => {
    assert.ok(changed, 'the metadata change must occur between verification and registration');
    return changed;
  }};
}

test('export registers the verified artifact after a ctime-only change before registration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-export-registration-'));
  const source = await sourceFile(root);
  const store = openStore(root);
  const providers = new Map<string, Provider>();
  const services = createServices(store, providers);
  const change = changeCtimeBeforeRegistration(store, 'exports');
  let worker: ReturnType<typeof startWorker> | undefined;
  t.after(async () => {
    change.clear();
    await worker?.stop();
    await services.drain();
    store.close();
    await rm(root, {recursive: true, force: true});
  });
  const project = row(await services.call('project.create', {name: 'Export registration'}));
  const projectId = String(project.id);
  const imported = row(await services.call('asset.import', {
    projectId, name: 'source.mp4', mimeType: 'video/mp4', dataBase64: (await readFile(source)).toString('base64'),
  }));
  const timeline = row(await services.call('timeline.get', {projectId}));
  const track = row((timeline.tracks as unknown[])[0]);
  const edited = row(await services.call('timeline.clip.add', {
    projectId, expectedRevision: timeline.revision, requestId: randomUUID(),
    assetId: imported.id, trackId: track.id, startFrame: 0, durationFrames: 6,
  }));
  const accepted = row(await services.call('timeline.render', {
    projectId, expectedRevision: edited.revision, requestId: randomUUID(), purpose: 'export',
  }));
  worker = startWorker(store, services, providers);
  await worker.tick();
  await worker.stop();
  worker = undefined;

  const proof = change.proof();
  const completed = row(store.get('exports', String(accepted.id)));
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  assert.equal(completed.assetId, proof.assetId);
  assert.equal(row(store.get('assets', proof.assetId)).name, '多轨时间线-导出-9x16.mp4');
  const output = row(await services.call('export.output.get', {projectId, exportId: accepted.id}));
  assert.equal(output.assetId, proof.assetId);
  assert.ok(isPublishedProjectOutput(store.get('assets', proof.assetId), proof));
  assert.deepEqual(await readdir(path.join(root, '导出')), [path.basename(proof.relativePath)]);
});

test('ultrawide output uses the frozen 21:9 asset name and preserves a literal delivery name', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-wide-output-'));
  const store = openStore(root), providers = new Map<string, Provider>();
  const services = createServices(store, providers);
  let worker: ReturnType<typeof startWorker> | undefined;
  t.after(async () => {await worker?.stop();await services.drain();store.close();await rm(root, {recursive:true,force:true});});
  const source = await sourceFile(root), project = row(await services.call('project.create', {name:'Wide output'})), projectId = String(project.id);
  const asset = row(await services.call('asset.import', {projectId,name:'source.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')}));
  const timeline = row(await services.call('timeline.get', {projectId})), track = row((timeline.tracks as unknown[])[0]);
  // The public format setter is still closed to new frame presets in G.
  store.put('timelines', {...timeline,width:2520,height:1080});
  const edited = row(await services.call('timeline.clip.add', {projectId,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:track.id,startFrame:0,durationFrames:6}));
  const deliveryName = 'Wide cut', input = {projectId,expectedRevision:edited.revision,requestId:randomUUID(),purpose:'export',deliveryName};
  const accepted = row(await services.call('timeline.render', input, {outputLocale:'en'})), exportId = String(accepted.id);
  worker = startWorker(store, services, providers);
  await worker.tick();
  await worker.stop();
  worker = undefined;
  const completed = row(store.get('exports', exportId));
  assert.equal(completed.status,'succeeded',JSON.stringify(completed.error));
  const assetId = String(completed.assetId), output = row(store.get('assets',assetId));
  assert.deepEqual([output.width,output.height,output.name],[2520,1080,'Timeline export · 21x9.mp4']);
  assert.deepEqual(await services.call('timeline.render', input),accepted);
  const url = new URL(`http://127.0.0.1/media/${assetId}?download=1&exportId=${exportId}`);
  const download = readTimelineDeliveryDownload(store.db,url,{isTimelineRenderRecord,readOwnedAsset:(project,asset)=>readOwnedTimelineAsset(store.db,project,asset)});
  assert.equal(download?.contentDisposition,timelineDeliveryContentDisposition(deliveryName,exportId)+`; mioon-export-id="${exportId}"; mioon-asset-id="${assetId}"`);
});

test('video generation registers the verified artifact after a ctime-only change before registration', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mioon-generation-registration-'));
  const source = await sourceFile(root);
  const store = openStore(root);
  const provider: Provider = {
    id: 'ark',
    capabilities: {models: ['fixture'], inputModes: ['text'], aspectRatios: ['9:16'], durations: [4], configured: true, enabled: true, mock: false},
    submit: async () => ({providerJobId: 'fixture-ctime-registration'}),
    poll: async () => ({status: 'succeeded'}),
    reconcile: async () => null,
    download: async (_id, destination) => {await copyFile(source, destination);},
  };
  const providers = new Map([['ark', provider]]);
  const services = createServices(store, providers);
  const change = changeCtimeBeforeRegistration(store, 'generated');
  let worker: ReturnType<typeof startWorker> | undefined;
  t.after(async () => {
    change.clear();
    await worker?.stop();
    await services.drain();
    store.close();
    await rm(root, {recursive: true, force: true});
  });
  const project = row(await services.call('project.create', {name: 'Generation registration'}));
  const shot = row(await services.call('shot.create', {projectId: project.id, title: 'Fixture', prompt: 'A blue rectangle', duration: 4}));
  const accepted = row(await services.call('generation.submit', {
    shotId: shot.id, expectedRevision: shot.revision, providerId: 'ark', requestId: randomUUID(),
  }));
  worker = startWorker(store, services, providers);
  await worker.tick();
  await worker.tick();
  await worker.stop();
  worker = undefined;

  const proof = change.proof();
  const completed = row(store.get('jobs', String(accepted.id)));
  assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
  const version = row(store.get('versions', String(completed.versionId)));
  assert.equal(version.assetId, proof.assetId);
  assert.ok(isPublishedProjectOutput(store.get('assets', proof.assetId), proof));
  assert.equal(store.list('versions').length, 1);
  assert.deepEqual(await readdir(path.join(root, '生成')), [path.basename(proof.relativePath)]);
});

test('a moved private download stage retains its task and serializes an I/O error without local paths',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-artifact-private-error-')),source=await sourceFile(root),store=openStore(root);let worker:ReturnType<typeof startWorker>|undefined,moved='';
 const calls={submit:0,poll:0,download:0},provider:Provider={id:'ark',capabilities:{models:['fixture'],inputModes:['text'],aspectRatios:['9:16'],durations:[4],configured:true,enabled:true,mock:false},
  submit:async()=>{calls.submit++;return{providerJobId:'existing-private-download-job'};},poll:async()=>{calls.poll++;return{status:'succeeded'};},reconcile:async()=>null,
  download:async(_id,destination)=>{calls.download++;await copyFile(source,destination);moved=destination+'.moved.mp4';await rename(destination,moved);}};
 const providers=new Map([['ark',provider]]),services=createServices(store,providers);
 t.after(async()=>{await worker?.stop();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 const project=row(await services.call('project.create',{name:'Private output error'})),shot=row(await services.call('shot.create',{projectId:project.id,title:'Retained task',prompt:'A blue rectangle',duration:4})),job=row(await services.call('generation.submit',{shotId:shot.id,expectedRevision:shot.revision,providerId:'ark',requestId:randomUUID()}));
 worker=startWorker(store,services,providers);await worker.tick();await worker.tick();await worker.stop();worker=undefined;
 const retained=row(await services.call('job.get',{jobId:job.id})),error=row(retained.error),serialized=JSON.stringify(retained);
 assert.equal(retained.status,'downloading');assert.equal(retained.providerJobId,'existing-private-download-job');assert.equal(retained.requestId,job.requestId);assert.equal(retained.submissionCount,1);assert.deepEqual(calls,{submit:1,poll:1,download:1});
 assert.deepEqual(error,{code:'ENOENT',message:'本地产物文件不可用，已保留任务记录',retryable:true});assert.equal(serialized.includes(root),false);assert.equal(serialized.includes(store.tempDir),false);assert.equal(serialized.includes(moved),false);assert.equal(store.list('versions').length,0);assert.equal(store.list('assets').length,0);assert.deepEqual(await readFile(moved),await readFile(source));
});

test('completed generation artifact resumes locally after restart, rejects corrupt manifest and registers its exact IDs once',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-generation-artifact-')),source=await sourceFile(root);let store=openStore(root),worker:ReturnType<typeof startWorker>|undefined;
 const calls={submit:0,poll:0,download:0};
 const provider:Provider={id:'ark',capabilities:{models:['fixture'],inputModes:['text'],aspectRatios:['9:16'],durations:[4],configured:true,enabled:true,mock:false},
  submit:async()=>{calls.submit++;return{providerJobId:'existing-completed-provider-job'};},poll:async()=>{calls.poll++;return{status:'succeeded'};},reconcile:async()=>null,
  download:async(_id,destination)=>{calls.download++;await copyFile(source,destination);}};
 const providers=new Map([['ark',provider]]);let services=createServices(store,providers);
 t.after(async()=>{await worker?.stop();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 const project=row(await services.call('project.create',{name:'Generation artifact'})),projectId=String(project.id),shot=row(await services.call('shot.create',{projectId,title:'Frozen output',prompt:'A blue rectangle',duration:4}));
 const submission={shotId:shot.id,expectedRevision:shot.revision,providerId:'ark',requestId:randomUUID()};
 const job=row(await services.call('generation.submit',submission,{outputLocale:'en'})),jobId=String(job.id),controller=new AbortController();
 assert.deepEqual(await services.call('generation.submit',submission,{outputLocale:'ja'}),job);
 const unreceipted=path.join(root,'media',`result-${jobId}.mp4`);await copyFile(source,unreceipted);const unreceiptedBytes=await readFile(unreceipted);
 const off=setProjectOutputPublicationTestHooks(store,{fault:point=>{if(point==='after_final')controller.abort();}});
 worker=startWorker(store,services,providers,{signal:controller.signal});await worker.tick();await worker.tick();await worker.stop();worker=undefined;off();
 assert.equal(row(store.get('jobs',jobId)).status,'downloading');assert.deepEqual(calls,{submit:1,poll:1,download:1},'an existing result-like file without a complete artifact never substitutes for the provider download');assert.equal(store.list('versions').length,0);assert.deepEqual(await readFile(unreceipted),unreceiptedBytes);
 const manifestFile=path.join(store.tempDir,'job-results',jobId,'complete.json'),raw=await readFile(manifestFile,'utf8'),artifact=outputArtifactSchema.parse(JSON.parse(raw)),files=await readdir(path.join(root,'生成'));assert.equal(files.length,1);
 await services.drain();store.close();store=openStore(root);services=createServices(store,new Map());
 writePrivateFileAtomic(manifestFile,JSON.stringify({...artifact,sourceIdentity:'f'.repeat(64)}),{root:store.tempDir,maxBytes:32768});
 let children=0;const stopObserving=onMediaProcess(event=>{if(event.type==='started')children++;});
 worker=startWorker(store,services,new Map());await worker.tick();await worker.stop();worker=undefined;
 assert.equal(row(store.get('jobs',jobId)).status,'downloading');assert.equal(row(row(store.get('jobs',jobId)).error).code,'INVALID_OUTPUT_ARTIFACT');assert.deepEqual(calls,{submit:1,poll:1,download:1});assert.equal(children,0);
 writePrivateFileAtomic(manifestFile,raw,{root:store.tempDir,maxBytes:32768});services.saveJob(store.get('jobs',jobId) as JobRecord,{nextPollAt:0});
 worker=startWorker(store,services,new Map());await worker.tick();await worker.stop();worker=undefined;stopObserving();
 const completed=row(store.get('jobs',jobId)),asset=row(store.get('assets',artifact.assetId)),version=row(store.get('versions',String(artifact.versionId)));
 assert.equal(asset.name,'Frozen output · Generated video.mp4');
 assert.equal(completed.status,'succeeded');assert.equal(completed.versionId,artifact.versionId);assert.equal(version.assetId,artifact.assetId);assert.equal(store.list('versions').length,1);assert.deepEqual(calls,{submit:1,poll:1,download:1});assert.equal(children,0,'recovery does not probe, decode, render or contact an adapter');assert.deepEqual(await readdir(path.join(root,'生成')),files);
 assert.ok(isPublishedProjectOutput(asset,{projectId,assetId:artifact.assetId,owner:artifact.owner,targetKind:'generated'}));
 assert.deepEqual(await readFile(unreceipted),unreceiptedBytes,'unreceipted project files are never deleted or adopted');
});

for(const float of [false,true])test(`completed ${float?'float-checked':'ordinary'} export artifact resumes without a second render and keeps its original asset ID`,async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'mioon-export-artifact-')),source=await sourceFile(root);let store=openStore(root),services=createServices(store,new Map(),{exportOptions:{inspect:async()=>({status:'available',code:'EXPORT_CAPABILITY_AVAILABLE'})}}),worker:ReturnType<typeof startWorker>|undefined;
 t.after(async()=>{await worker?.stop();await services.drain();store.close();await rm(root,{recursive:true,force:true});});
 const project=row(await services.call('project.create',{name:'Export artifact'})),projectId=String(project.id),asset=row(await services.call('asset.import',{projectId,name:'source.mp4',mimeType:'video/mp4',dataBase64:(await readFile(source)).toString('base64')}));
 let timeline=row(await services.call('timeline.get',{projectId}));const track=row((timeline.tracks as unknown[])[0]);timeline=row(await services.call('timeline.clip.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:track.id,startFrame:0,durationFrames:6}));
 const input={projectId,expectedRevision:timeline.revision,requestId:randomUUID(),purpose:'export',...(float?{exportSettings:{profileId:'mp4_h264_float_checked_v2',resolution:'short_360',rateControl:{mode:'crf',quality:'standard'}}}:{})},accepted=row(await services.call('timeline.render',input,{outputLocale:float?'ja':'zh-Hant'})),exportId=String(accepted.id),controller=new AbortController();
 assert.deepEqual(await services.call('timeline.render',input,{outputLocale:'en'}),accepted);
 const originalReceipt=store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId),off=setProjectOutputPublicationTestHooks(store,{fault:point=>{if(point==='after_final')controller.abort();}});
 worker=startWorker(store,services,new Map(),{signal:controller.signal});await worker.tick();await worker.stop();worker=undefined;off();
 assert.equal(row(store.get('exports',exportId)).status,'queued');const artifact=outputArtifactSchema.parse(JSON.parse(await readFile(path.join(store.tempDir,'export-staging',exportId,'complete.json'),'utf8'))),files=await readdir(path.join(root,'导出'));assert.equal(files.length,1);
 await services.drain();store.close();store=openStore(root);services=createServices(store,new Map(),{exportOptions:{inspect:async()=>{assert.fail('completed artifact does not re-run export capability/render admission');}}});
 let children=0;const stopObserving=onMediaProcess(event=>{if(event.type==='started')children++;});
 worker=startWorker(store,services,new Map());await worker.tick();await worker.stop();worker=undefined;stopObserving();
 const completed=row(store.get('exports',exportId));assert.equal(completed.status,'succeeded',JSON.stringify(completed.error));assert.equal(completed.assetId,artifact.assetId);assert.equal(children,0);assert.deepEqual(await readdir(path.join(root,'导出')),files);assert.deepEqual(store.db.prepare('SELECT response FROM timeline_requests WHERE requestId=?').get(input.requestId),originalReceipt);
 if(float)assert.ok(isTimelineExportAudioOutcome(completed,{assetSha256:artifact.info.sha256}));
 const output=row(await services.call('export.output.get',{projectId,exportId}));assert.equal(output.assetId,artifact.assetId);
 assert.equal(row(store.get('assets',artifact.assetId)).name,float?'タイムライン書き出し · 9x16.mp4':'多軌時間軸-匯出-9x16.mp4');
 if(!float){
  const next=row(await services.call('timeline.render',{...input,requestId:randomUUID()},{outputLocale:'zh-Hant'}));
  worker=startWorker(store,services,new Map());await worker.tick();await worker.stop();worker=undefined;
  const second=row(store.get('exports',String(next.id)));
  assert.equal(second.status,'succeeded');
  assert.equal(row(store.get('assets',String(second.assetId))).name,'多軌時間軸-匯出-9x16 (2).mp4');
  assert.equal(row(store.get('assets',artifact.assetId)).name,'多軌時間軸-匯出-9x16.mp4');
 }
});
