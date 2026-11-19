import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {mkdtemp, readFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/index.ts';
import {prepareFormat5Release} from './helpers/format5-release-fixture.ts';
import {releaseProjectPaths} from './helpers/format4-release-fixture.ts';
import {createServices} from '../packages/business/src/services.ts';
import type {JobRecord,ServiceRow} from '../packages/business/src/services.ts';
import {createProviderRegistry} from '../packages/business/src/provider-registry.ts';
import {createVideoSettings} from '../packages/business/src/video/settings.ts';
import {startWorker} from '../packages/business/src/jobs.ts';
import {defaultVideoModels,SEEDANCE25_MODEL_ID} from '../packages/contracts/src/video-providers.ts';
import type {VideoConnectionConfiguration,VideoModelEntry} from '../packages/contracts/src/video-providers.ts';
import {createTestSecretCodec,testSecretStorage} from './helpers/secret-codec.ts';
import {png} from './helpers/timeline-image-fixtures.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import {buildReferenceEdgeEnvelope,readFrozenFormat5GenerationInputs} from '../packages/business/src/format5-reference-inputs.ts';
import {prepareSequenceEditHistory} from '../packages/business/src/format5-editor-history.ts';
import {runSequenceSync} from '../packages/business/src/format5-sequence-sync.ts';

const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const TASK='format5-reference-task-1';
const timestamp='2026-01-03T00:00:00.000Z';

async function fixture(t:TestContext){
  const workspaceRoot=await realpath(await mkdtemp(path.join(tmpdir(),'mioon-f5-reference-generation-')));
  const source=prepareFormat5Release(workspaceRoot,'v0.2.0');
  const root=path.join(workspaceRoot,'project');
  cpSync(source.sample,root,{recursive:true,errorOnExist:true,force:false});
  const paths=releaseProjectPaths(root);
  for(const directory of [root,...Object.values(paths.location)])chmodSync(directory,0o700);
  const upgraded=upgradeProjectFormatTo5({projectFile:paths.projectFile,locate:()=>paths.location,approveUpgrade:()=>true});
  const store=upgraded.store;
  const settings=await createVideoSettings({directory:path.join(root,'video-settings'),privateRoot:root,
    secretCodec:createTestSecretCodec(),storage:testSecretStorage});
  const providers=createProviderRegistry({db:store.db,root,env:{}});
  const calls:Array<{url:string;init:RequestInit}>=[];let reply:(url:string,init:RequestInit)=>Response|Promise<Response>=(_url,init)=>
    json(init.method==='POST'?{id:TASK}:{id:TASK,status:'running'});
  const library=openAppLibrary({dataDir:path.join(workspaceRoot,'app')});
  const services=createServices(store,providers,{application:createProjectServiceApplication(library),
    videoSettings:settings,profileNow:()=>Date.UTC(2026,9,30),
    videoFetch:async(input,init)=>{const request={url:String(input),init:init??{}};calls.push(request);return reply(request.url,request.init);}});
  await services.call('workspace.settings.set',{expectedRevision:0,liveGeneration:true});
  const defaults=defaultVideoModels('ark');
  const configuration:VideoConnectionConfiguration={id:randomUUID(),providerId:'ark',name:'Ark account',region:'cn-beijing',
    workspaceId:'',enabled:true,archived:false,outputHosts:['output.example'],models:defaults as VideoModelEntry[]};
  await settings.put({action:'save',expectedRevision:0,configuration,secret:{action:'replace',value:'synthetic-ark-key',storage:'persistent'}});
  let worker:ReturnType<typeof startWorker>|null=null;
  const f={root,workspaceRoot,store,services,configuration,calls,
    async tick(){worker??=startWorker(store,services,providers);await worker.tick();},
    async stop(){await worker?.stop();worker=null;},
    reply(next:typeof reply){reply=next;},
    posts(){return calls.filter(call=>call.init.method==='POST');},
    job(id:string){return store.get('jobs',id) as JobRecord;},
  };
  t.after(async()=>{await f.stop();await services.drain();await settings.close();store.close();library.close();
    await rm(workspaceRoot,{recursive:true,force:true});});
  return f;
}

type Fixture=Awaited<ReturnType<typeof fixture>>;

async function seedMedia(f:Fixture) {
  const {store}=f;
  const shot=store.db.prepare('SELECT id,data FROM project.shots WHERE archivedAt IS NULL ORDER BY id LIMIT 1').get() as {id:string;data:string};
  const importImage=async(name:string):Promise<string>=>{
    const row=await f.services.call('asset.import',{projectId:store.projectId,name,mimeType:'image/png',
      dataBase64:png({width:360,height:640,rgba:false}).toString('base64')}) as ServiceRow;
    return String(row.id);
  };
  const importWav=async():Promise<string>=>{
    const row=await f.services.call('asset.import',{projectId:store.projectId,name:'Reference voice.wav',mimeType:'audio/wav',
      dataBase64:wav(5).toString('base64')}) as ServiceRow;
    return String(row.id);
  };
  const node=(type:string,assetId:string):string=>{
    const id=randomUUID();
    store.put('nodes',{id,projectId:store.projectId,type,assetId,position:{x:10,y:10},createdAt:timestamp});
    return id;
  };
  const shotData=JSON.parse(shot.data) as ServiceRow;
  // Epsilon prompt and a frame-compatible aspect; the sample project predates
  // prompts and shot.update is gated for format 5.
  shotData.prompt='A synthetic paper boat drifts across a pond.';
  shotData.aspectRatio='9:16';
  store.put('shots',{...shotData,updatedAt:new Date().toISOString()});
  return {store,shotId:shot.id,shot:shotData,
    imageA:node('image',await importImage('Reference A.png')),
    imageB:node('image',await importImage('Reference B.png')),
    imageC:node('image',await importImage('Reference C.png')),
    audio:node('audio',await importWav())};
}

// A 16-bit mono 8 kHz PCM tone; the managed import decodes it and records its duration.
function wav(seconds:number,tone=440):Buffer {
  const rate=8000,frames=Math.round(seconds*rate),bytes=Buffer.alloc(44+frames*2);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*2,40);
  for(let frame=0;frame<frames;frame++)bytes.writeInt16LE(Math.round(8000*Math.sin(2*Math.PI*tone*frame/rate)),44+frame*2);
  return bytes;
}

function attach(f:Fixture,shotId:string,sourceNodeId:string,role?:string):string{
  const store=f.store,state=prepareSequenceEditHistory(store);
  const requestId=`f5-reference-${randomUUID()}`;
  const envelope=buildReferenceEdgeEnvelope(store,{kind:'attach',edgeId:randomUUID(),shotId,sourceNodeId,
    ...(role?{role}:{})} as never,{epoch:state.state.epoch,historyPosition:state.state.position,
    historyRevision:state.state.revision,requestId,actionId:randomUUID()});
  const result=runSequenceSync(store,envelope) as Record<string,any>;
  assert.equal(result.ok,true,JSON.stringify(result));
  return Array.isArray(result.patch?.after?.board?.writes)?String(result.patch.after.board.writes.find((entry:Record<string,unknown>)=>entry.kind==='edge').id):'';
}

function reorder(f:Fixture,shotId:string,edgeIds:readonly string[]):void{
  const store=f.store,state=prepareSequenceEditHistory(store);
  const envelope=buildReferenceEdgeEnvelope(store,{kind:'reorder',shotId,edgeIds} as never,
    {epoch:state.state.epoch,historyPosition:state.state.position,historyRevision:state.state.revision,
     requestId:`f5-reference-reorder-${randomUUID()}`,actionId:randomUUID()});
  const result=runSequenceSync(store,envelope) as Record<string,any>;
  assert.equal(result.ok,true,JSON.stringify(result));
}

const body=(call:{init:RequestInit})=>JSON.parse(String(call.init.body)) as Record<string,any>;

test('format 5 generation reads reference lines and submits one frozen multi-reference request',async t=>{
  const f=await fixture(t),seeded=await seedMedia(f);
  try{
    const imageA=attach(f,seeded.shotId,seeded.imageA,'reference_image');
    const imageB=attach(f,seeded.shotId,seeded.imageB,'reference_image');
    const audioId=attach(f,seeded.shotId,seeded.audio);
    assert.ok(imageA&&imageB&&audioId);
    // RI-b primary selection: the reordered first image is the provider's image 1.
    reorder(f,seeded.shotId,[imageB,imageA,audioId]);
    const model=f.configuration.models[0]!;
    const input={shotId:seeded.shotId,expectedRevision:Number(seeded.shot.revision),requestId:randomUUID(),
      providerId:'ark',model:model.modelId,connectionId:f.configuration.id,configurationRevision:1,
      modelEntryId:model.id,parameters:{durationSeconds:4,resolution:'720p'}};
    const timelineBefore=JSON.stringify(f.store.db.prepare('SELECT data FROM project.timelines').get());
    const job=await f.services.call('generation.submit',input as never) as JobRecord;
    // Submitting a multi-reference generation never adds audio to playback.
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT data FROM project.timelines').get()),timelineBefore);
    // The frozen plan records actual and unsupported inputs before dispatch.
    const freeze=readFrozenFormat5GenerationInputs(job.snapshot)!;
    assert.ok(freeze,JSON.stringify(job.snapshot));
    assert.equal(freeze.mode,'references');
    assert.equal(freeze.entries.filter(entry=>entry.status==='used').length,3);
    assert.equal(freeze.primaryReferenceId,imageB);
    const primaryEntry=freeze.entries.find(entry=>entry.edgeId===imageB)!;
    const secondaryEntry=freeze.entries.find(entry=>entry.edgeId===imageA)!;
    assert.deepEqual(freeze.actual.images.map(image=>image.assetId),[primaryEntry.assetId,secondaryEntry.assetId]);
    assert.equal(freeze.entries.find(entry=>entry.role==='first_frame'),undefined);
    assert.equal(freeze.actual.images.length,2);
    assert.equal(freeze.actual.audios.length,1);
    assert.deepEqual(freeze.actual.images.map(image=>image.role),['reference_image','reference_image']);
    // A late board change after submit does not rewrite this job.
    attach(f,seeded.shotId,seeded.imageC,'reference_image');
    await f.tick();await f.stop();
    assert.equal(f.posts().length,1,JSON.stringify(f.calls.map(call=>call.url)));
    const sent=body(f.posts()[0]!);
    const content=(sent.content as Record<string,any>[]);
    assert.equal(content[0]!.type,'text');
    const images=content.filter(item=>item.type==='image_url');
    const audios=content.filter(item=>item.type==='audio_url');
    assert.equal(images.length,2);
    assert.equal(audios.length,1);
    for(const image of images)assert.equal(image.role,'reference_image');
    assert.equal(audios[0]!.role,'reference_audio');
    assert.equal(sent.omni_reference_task_type,'reference');
    assert.equal(sent.duration,4);
    // A fresh request after the late line change sees three images.
    const nextInput={...input,requestId:randomUUID()};
    const second=await f.services.call('generation.submit',nextInput as never) as JobRecord;
    const secondFreeze=readFrozenFormat5GenerationInputs(second.snapshot)!;
    assert.equal(secondFreeze.actual.images.length,3);
    await f.tick();await f.stop();
    const secondSent=body(f.posts()[1]!);
    assert.equal((secondSent.content as Record<string,any>[]).filter(item=>item.type==='image_url').length,3);
  }finally{
    // cleanup in t.after
  }
});

test('format 5 first/last frames ride the saved-shot projection and freeze into the version provenance',async t=>{
  const f=await fixture(t),seeded=await seedMedia(f);
  attach(f,seeded.shotId,seeded.imageA,'first_frame');
  attach(f,seeded.shotId,seeded.imageB,'last_frame');
  const model=f.configuration.models[0]!;
  const ratio=String(seeded.shot.aspectRatio??'9:16');
  const [width,height]=ratio==='16:9'?[1280,720]:ratio==='1:1'?[720,720]:[720,1280];
  const videoPath=path.join(f.workspaceRoot,'frame-output.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:s=${width}x${height}:r=24`,'-t','4',
    '-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-y',videoPath]);
  const bytes=await readFile(videoPath);
  f.reply((url,init)=>url.startsWith('https://output.example/')?new Response(bytes)
    :json(init.method==='POST'?{id:TASK}:{id:TASK,status:'succeeded',content:{video_url:'https://output.example/frame-output.mp4'}}));
  const input={shotId:seeded.shotId,expectedRevision:Number(seeded.shot.revision),requestId:randomUUID(),
    providerId:'ark',model:model.modelId,connectionId:f.configuration.id,configurationRevision:1,
    modelEntryId:model.id,parameters:{durationSeconds:4,aspectRatio:ratio,resolution:'720p'}};
  const job=await f.services.call('generation.submit',input as never) as JobRecord;
  const freeze=readFrozenFormat5GenerationInputs(job.snapshot)!;
  assert.equal(freeze.mode,'frames');
  assert.equal(freeze.actual.firstFrameAssetId,freeze.actual.images.find(image=>image.role==='first_frame')!.assetId);
  assert.equal(freeze.actual.lastFrameAssetId,freeze.actual.images.find(image=>image.role==='last_frame')!.assetId);
  // Complete the task so the immutable version provenance is written.
  await f.tick();await f.stop();f.services.saveJob(f.job(job.id),{nextPollAt:0});await f.tick();await f.stop();
  const published=f.job(job.id);assert.equal(published.status,'succeeded',JSON.stringify(published.error));
  const version=f.store.list('versions')[0] as ServiceRow;
  const versionFreeze=readFrozenFormat5GenerationInputs(version.snapshot)!;
  assert.equal(versionFreeze.mode,'frames');
  assert.equal(versionFreeze.actual.lastFrameAssetId,freeze.actual.lastFrameAssetId);
  const sent=body(f.posts()[0]!);
  assert.equal((sent.content as Record<string,any>[]).filter(item=>item.type==='image_url').length,2);
  assert.equal(sent.ratio,'adaptive');
});
