import assert from 'node:assert/strict';
import test from 'node:test';
import type {TestContext} from 'node:test';
import {chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {mkdtemp, readFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
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
import {readFrozenFormat5Dialogue} from '../packages/business/src/format5-dialogue-generation.ts';
import {prepareSequenceEditHistory} from '../packages/business/src/format5-editor-history.ts';
import {runSequenceSync} from '../packages/business/src/format5-sequence-sync.ts';
import {defaultPrevisScene} from '../packages/contracts/src/previs.ts';
import type {PrevisScene, PrevisSubjectReference} from '../packages/contracts/src/previs.ts';

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

function imageAssetOf(f:Fixture,nodeId:string):string{
  const node=f.store.get('nodes',nodeId) as ServiceRow;
  return String(node.assetId);
}

/** Format-5 subject rows are fixture evidence: legacy subject writes are gated
 * behind the unified sequence entry, and previs subjects only need to resolve. */
function createSubject(f:Fixture,kind:string,name:string,assetId:string):{subjectId:string;headVersionId:string}{
  const {store}=f,subjectId=randomUUID(),headVersionId=randomUUID();
  const version=(id:string,number:number,versionAssetId:string)=>
    store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)')
      .run(id,store.projectId,subjectId,number,versionAssetId,JSON.stringify({id,projectId:store.projectId,subjectId,number,
        assetId:versionAssetId,sha256:'a'.repeat(64),mimeType:'image/png',width:360,height:640,createdAt:timestamp,
        provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null}}));
  store.tx(()=>{
    store.db.prepare(`INSERT INTO project.subjects(id,projectId,kind,name,revision,headVersionId,createdAt,updatedAt)
      VALUES(?,?,?,?,?,?,?,?)`).run(subjectId,store.projectId,kind,name,1,headVersionId,timestamp,timestamp);
    version(headVersionId,1,assetId);
  });
  return {subjectId,headVersionId};
}

function addSubjectVersion(f:Fixture,subjectId:string,number:number,assetId:string):string{
  const {store}=f,versionId=randomUUID();
  store.tx(()=>{
    store.db.prepare('INSERT INTO project.subject_versions(id,projectId,subjectId,number,assetId,data) VALUES(?,?,?,?,?,?)')
      .run(versionId,store.projectId,subjectId,number,assetId,JSON.stringify({id:versionId,projectId:store.projectId,
        subjectId,number,assetId,sha256:'a'.repeat(64),mimeType:'image/png',width:360,height:640,createdAt:timestamp,
        provenance:{kind:'user-import',versionId:null,shotId:null,jobId:null}}));
    store.db.prepare('UPDATE project.subjects SET headVersionId=?, revision=? WHERE id=?').run(versionId,number,subjectId);
  });
  return versionId;
}

/** A scene with one mannequin and optional prop subject references; a keyframe
 * makes the scene publishable by the real previs output operation. */
function previsScene(subjects:{figure?:PrevisSubjectReference;props?:readonly PrevisSubjectReference[]}):PrevisScene{
  const scene=defaultPrevisScene();
  const figures=[{...scene.figures[0]!,...(subjects.figure?{subject:subjects.figure}:{})}];
  const props=(subjects.props??[]).map((subject,index)=>({id:`p${index+1}`,kind:'box' as const,name:'',visible:true,
    position:[index*0.5,0,1] as [number,number,number],rotation:0,size:[0.5,0.5,0.5] as [number,number,number],subject}));
  return {...scene,figures,props,keyframes:[{id:'k1',name:'',camera:scene.camera,exports:[]}],activeKeyframeId:'k1'};
}

async function seedPrevis(f:Fixture,scene:PrevisScene,label:string):Promise<{nodeId:string;outputAssetId:string}>{
  const {store}=f,nodeId=randomUUID();
  store.tx(()=>store.put('nodes',{id:nodeId,projectId:store.projectId,type:'previs',label,text:'',
    position:{x:0,y:0},revision:1,sceneRevision:1,scene,createdAt:timestamp}));
  const bytes=png({width:360,height:640,rgba:false});
  const published=await f.services.call('previs.output.publish',{projectId:store.projectId,nodeId,keyframeId:'k1',
    sceneRevision:1,requestId:`f5-previs-output-${randomUUID()}`,name:'Previs frame.png',
    sha256:createHash('sha256').update(bytes).digest('hex'),width:360,height:640,
    dataBase64:bytes.toString('base64')}) as ServiceRow;
  return {nodeId,outputAssetId:String((published.asset as ServiceRow).id)};
}

async function submit(f:Fixture,seeded:Awaited<ReturnType<typeof seedMedia>>,requestId:string):Promise<JobRecord>{
  const model=f.configuration.models[0]!;
  return await f.services.call('generation.submit',{shotId:seeded.shotId,expectedRevision:Number(seeded.shot.revision),
    requestId,providerId:'ark',model:model.modelId,connectionId:f.configuration.id,configurationRevision:1,
    modelEntryId:model.id,parameters:{durationSeconds:4,resolution:'720p'}} as never) as JobRecord;
}

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
  // A connected previs scene names one subject: it is frozen as evidence but a
  // frames-mode request never sends it (both stay in the plan as unsupported).
  const hero=createSubject(f,'character','阿璃',imageAssetOf(f,seeded.imageA));
  const previs=await seedPrevis(f,previsScene({figure:{subjectId:hero.subjectId}}),'机位预演');
  attach(f,seeded.shotId,previs.nodeId);
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
  // The immutable version provenance carries exactly the job's frozen plan.
  assert.deepEqual(versionFreeze,freeze);
  assert.equal(versionFreeze.mode,'frames');
  assert.equal(versionFreeze.actual.lastFrameAssetId,freeze.actual.lastFrameAssetId);
  const versionSubjects=versionFreeze.entries.filter(entry=>entry.source==='previs');
  assert.equal(versionSubjects.length,1);
  assert.equal(versionSubjects[0]!.subjectId,hero.subjectId);
  assert.equal(versionSubjects[0]!.subjectVersionId,hero.headVersionId);
  assert.equal(versionSubjects[0]!.role,'subject_reference');
  assert.equal(versionSubjects[0]!.status,'unsupported');
  assert.equal(versionSubjects[0]!.reason,'EXCLUSIVE_MODE');
  const sent=body(f.posts()[0]!);
  assert.equal((sent.content as Record<string,any>[]).filter(item=>item.type==='image_url').length,2);
  assert.equal(sent.ratio,'adaptive');
});


test('previs scene subjects freeze the version used at submit; later subject and scene changes only affect the next job',async t=>{
  const f=await fixture(t),seeded=await seedMedia(f);
  const character=createSubject(f,'character','阿璃',imageAssetOf(f,seeded.imageA));
  const look=createSubject(f,'look','霓虹色',imageAssetOf(f,seeded.imageB));
  const previs=await seedPrevis(f,previsScene({figure:{subjectId:character.subjectId},
    props:[{subjectId:look.subjectId,subjectVersionId:look.headVersionId}]}),'机位预演');
  const compositionEdgeId=attach(f,seeded.shotId,previs.nodeId);
  assert.ok(compositionEdgeId);
  const first=await submit(f,seeded,`f5-previs-submit-${randomUUID()}`);
  const firstFreeze=readFrozenFormat5GenerationInputs(first.snapshot)!;
  assert.equal(firstFreeze.mode,'references');
  const firstSubjects=firstFreeze.entries.filter(entry=>entry.source==='previs');
  assert.deepEqual(firstSubjects.map(entry=>entry.subjectId),[character.subjectId,look.subjectId]);
  const firstCharacter=firstSubjects[0]!,firstLook=firstSubjects[1]!;
  assert.equal(firstCharacter.role,'subject_reference');
  assert.equal(firstCharacter.bindingMode,'follow');
  assert.equal(firstCharacter.subjectVersionId,character.headVersionId);
  assert.equal(firstCharacter.sourceNodeId,previs.nodeId);
  assert.equal(firstLook.role,'style_reference');
  assert.equal(firstLook.bindingMode,'locked');
  assert.equal(firstLook.subjectVersionId,look.headVersionId);
  assert.equal(firstFreeze.primaryReferenceId,compositionEdgeId);
  assert.deepEqual(firstFreeze.actual.images.map(image=>image.assetId),
    [previs.outputAssetId,imageAssetOf(f,seeded.imageA),imageAssetOf(f,seeded.imageB)]);
  // Read the persisted row so byte comparisons use the stored snapshot form.
  const firstSnapshot=JSON.stringify(f.job(first.id).snapshot);
  // (a) A newer subject head changes only the next job's follow version.
  const characterV2=addSubjectVersion(f,character.subjectId,2,imageAssetOf(f,seeded.imageC));
  const second=await submit(f,seeded,`f5-previs-submit-${randomUUID()}`);
  const secondFreeze=readFrozenFormat5GenerationInputs(second.snapshot)!;
  const secondCharacter=secondFreeze.entries.find(entry=>entry.source==='previs'&&entry.subjectId===character.subjectId)!;
  assert.equal(secondCharacter.subjectVersionId,characterV2);
  assert.equal(secondFreeze.entries.find(entry=>entry.source==='previs'&&entry.subjectId===look.subjectId)!.subjectVersionId,look.headVersionId);
  const secondSnapshot=JSON.stringify(f.job(second.id).snapshot);
  assert.equal(JSON.stringify(f.job(first.id).snapshot),firstSnapshot);
  // (b) Rewriting the saved previs scene changes the next job, never the old ones:
  // the look subject leaves the prop and becomes a locked second figure while a
  // new product subject enters through a prop.
  const productAsset=await f.services.call('asset.import',{projectId:f.store.projectId,name:'Product.png',
    mimeType:'image/png',dataBase64:png({width:360,height:640,rgba:false}).toString('base64')}) as ServiceRow;
  const product=createSubject(f,'product','陶罐',String(productAsset.id));
  const current=f.store.get('nodes',previs.nodeId) as ServiceRow;
  const nextScene=previsScene({figure:{subjectId:character.subjectId},
    props:[{subjectId:product.subjectId}]});
  nextScene.figures.push({...nextScene.figures[0]!,id:'f2',position:[1.5,0,0] as [number,number,number],
    subject:{subjectId:look.subjectId,subjectVersionId:look.headVersionId}});
  f.store.tx(()=>f.store.put('nodes',{...current,revision:Number(current.revision)+1,
    sceneRevision:Number(current.sceneRevision)+1,scene:nextScene}));
  const third=await submit(f,seeded,`f5-previs-submit-${randomUUID()}`);
  const thirdFreeze=readFrozenFormat5GenerationInputs(third.snapshot)!;
  const thirdSubjects=thirdFreeze.entries.filter(entry=>entry.source==='previs');
  // Figure-then-prop order; each subject once; the new scene's versions applied.
  assert.deepEqual(thirdSubjects.map(entry=>entry.subjectId),[character.subjectId,look.subjectId,product.subjectId]);
  assert.equal(thirdSubjects[0]!.subjectVersionId,characterV2);
  assert.equal(thirdSubjects[1]!.subjectVersionId,look.headVersionId);
  assert.equal(thirdSubjects[1]!.bindingMode,'locked');
  assert.equal(thirdSubjects[2]!.bindingMode,'follow');
  assert.equal(JSON.stringify(f.job(first.id).snapshot),firstSnapshot);
  assert.equal(JSON.stringify(f.job(second.id).snapshot),secondSnapshot);
});

async function seedDialogue(f: Fixture, seeded: Awaited<ReturnType<typeof seedMedia>>,
  lines: readonly {id: string; text: string}[], prompt?: string) {
  const current = f.store.get('shots', seeded.shotId) as Record<string, unknown>;
  f.store.tx(() => f.store.put('shots', {...current, duration: 4, aspectRatio: '9:16',
    ...(prompt === undefined ? {} : {prompt}), dialogue: lines, updatedAt: new Date().toISOString()}));
  const shot = f.store.get('shots', seeded.shotId) as Record<string, unknown>;
  return {...seeded, shot};
}

function lastRequestBody(f: Fixture, index: number): Record<string, unknown> {
  const call = f.posts()[index];
  assert.ok(call, `request ${index} was sent`);
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

test('format 5 dialogue follows the 生成声音 switch: default, manual off/on and an Mio request without it', async t => {
  const f = await fixture(t);
  const seeded = await seedDialogue(f, await seedMedia(f), [{id: randomUUID(), text: '我们走吧。'}]);
  const model = f.configuration.models[0]!;
  const base = {shotId: seeded.shotId, expectedRevision: Number(seeded.shot.revision), providerId: 'ark',
    model: model.modelId, connectionId: f.configuration.id, configurationRevision: 1, modelEntryId: model.id,
    parameters: {durationSeconds: 4, resolution: '720p'}} as Record<string, unknown>;

  // 1) Seedance default: the shot's dialogue opens the optional native sound.
  const first = await f.services.call('generation.submit', {...base, requestId: randomUUID()} as never) as JobRecord;
  const firstFrozen = readFrozenFormat5Dialogue(first.snapshot)!;
  assert.equal(firstFrozen.status, 'used');
  assert.equal(firstFrozen.generateAudio, true);
  assert.equal(first.snapshot.prompt, `${String(seeded.shot.prompt)}\n{“我们走吧。”}`, 'the snapshot keeps the final raw prompt');
  await f.tick();
  await f.stop();
  const firstBody = lastRequestBody(f, 0);
  const firstText = (firstBody.content as {type: string; text?: string}[])[0]!.text!;
  assert.equal(firstText, first.snapshot.prompt, 'the provider receives the same raw text');
  assert.equal(firstBody.generate_audio, true);

  // 2) Manual off: the dialogue is not sent and the freeze records the actual value.
  const off = await f.services.call('generation.submit', {...base, requestId: randomUUID(),
    parameters: {...base.parameters as Record<string, unknown>, generateAudio: false}} as never) as JobRecord;
  const offFrozen = readFrozenFormat5Dialogue(off.snapshot)!;
  assert.equal(offFrozen.status, 'unsupported');
  assert.equal(offFrozen.reason, 'AUDIO_OFF');
  assert.equal(offFrozen.generateAudio, false);
  assert.equal(off.snapshot.prompt, String(seeded.shot.prompt), 'muted dialogue stays out of the prompt');
  await f.tick();
  await f.stop();
  const offBody = lastRequestBody(f, 1);
  assert.equal((offBody.content as {type: string; text?: string}[])[0]!.text, String(seeded.shot.prompt));
  assert.equal(offBody.generate_audio, false);

  // 3) Manual on: the explicit switch wins and the dialogue is sent.
  const on = await f.services.call('generation.submit', {...base, requestId: randomUUID(),
    parameters: {...base.parameters as Record<string, unknown>, generateAudio: true}} as never) as JobRecord;
  const onFrozen = readFrozenFormat5Dialogue(on.snapshot)!;
  assert.equal(onFrozen.status, 'used');
  assert.equal(onFrozen.generateAudio, true);
  assert.match(String(on.snapshot.prompt), /\{“我们走吧。”\}$/u);
  await f.tick();
  await f.stop();
  assert.equal((lastRequestBody(f, 2).content as {type: string; text?: string}[])[0]!.text, on.snapshot.prompt);
  assert.equal(lastRequestBody(f, 2).generate_audio, true);

  // 4) Mio does not send the switch: the same dialogue default applies.
  const {parameters: _omitted, ...mioBase} = base;
  const mio = await f.services.call('generation.submit', {...mioBase, requestId: randomUUID()} as never) as JobRecord;
  const mioFrozen = readFrozenFormat5Dialogue(mio.snapshot)!;
  assert.equal(mioFrozen.status, 'used');
  assert.equal(mioFrozen.generateAudio, true);
  await f.tick();
  await f.stop();
  assert.equal((lastRequestBody(f, 3).content as {type: string; text?: string}[])[0]!.text, mio.snapshot.prompt);
  assert.equal(lastRequestBody(f, 3).generate_audio, true);
});

test('retrying a format 5 dialogue generation reuses the frozen prompt and request', async t => {
  const f = await fixture(t);
  const seeded = await seedDialogue(f, await seedMedia(f), [{id: randomUUID(), text: '第一句台词。'}]);
  const model = f.configuration.models[0]!;
  const job = await f.services.call('generation.submit', {shotId: seeded.shotId,
    expectedRevision: Number(seeded.shot.revision), requestId: randomUUID(), providerId: 'ark',
    model: model.modelId, connectionId: f.configuration.id, configurationRevision: 1, modelEntryId: model.id,
    parameters: {durationSeconds: 4, resolution: '720p'}} as never) as JobRecord;
  await f.tick();
  await f.stop();
  const frozenSnapshot = JSON.stringify(job.snapshot);
  const firstBody = JSON.stringify(lastRequestBody(f, 0));

  // A later shot edit must not reach the retried job.
  await seedDialogue(f, seeded, [{id: randomUUID(), text: '改过的台词。'}]);
  f.store.put('jobs', {...f.job(job.id), status: 'failed', phase: 'failed',
    error: {code: 'SYNTHETIC', message: 'synthetic failure', retryable: true}, updatedAt: new Date().toISOString()});
  const retried = await f.services.call('job.retry', {jobId: job.id, requestId: randomUUID()}) as JobRecord;
  assert.equal(JSON.stringify(retried.snapshot), frozenSnapshot, 'the retry keeps the frozen prompt');
  assert.equal(readFrozenFormat5Dialogue(retried.snapshot)!.generateAudio,
    readFrozenFormat5Dialogue(job.snapshot)!.generateAudio);
  await f.tick();
  await f.stop();
  assert.equal(f.posts().length, 2);
  await seedDialogue(f, seeded, [{id: randomUUID(), text: '再来一句。'}]);
  assert.equal(JSON.stringify(lastRequestBody(f, 1)), firstBody, 'the retried request is byte-identical');
});

test('a dialogue-caused prompt overflow is rejected before any job or idempotency row', async t => {
  const f = await fixture(t);
  const seeded = await seedDialogue(f, await seedMedia(f), [{id: randomUUID(), text: '我们走吧。'}],
    '海'.repeat(4995));
  const model = f.configuration.models[0]!;
  const jobs = Number((f.store.db.prepare('SELECT count(*) AS n FROM jobs').get() as {n: number}).n);
  const idempotency = Number((f.store.db.prepare("SELECT count(*) AS n FROM idempotency WHERE scope='generation'").get() as {n: number}).n);
  await assert.rejects(f.services.call('generation.submit', {shotId: seeded.shotId,
    expectedRevision: Number(seeded.shot.revision), requestId: randomUUID(), providerId: 'ark',
    model: model.modelId, connectionId: f.configuration.id, configurationRevision: 1, modelEntryId: model.id,
    parameters: {durationSeconds: 4, resolution: '720p'}} as never),
  (error: {code?: string}) => error.code === 'DIALOGUE_PROMPT_TOO_LONG');
  assert.equal(Number((f.store.db.prepare('SELECT count(*) AS n FROM jobs').get() as {n: number}).n), jobs,
    'a rejected dialogue generation writes no job row');
  assert.equal(Number((f.store.db.prepare("SELECT count(*) AS n FROM idempotency WHERE scope='generation'").get() as {n: number}).n), idempotency,
    'a rejected dialogue generation writes no idempotency row');
  // The original prompt alone is too long: that stays the existing prompt error.
  await seedDialogue(f, seeded, [{id: randomUUID(), text: '我们走吧。'}], '海'.repeat(5005));
  await assert.rejects(f.services.call('generation.submit', {shotId: seeded.shotId,
    expectedRevision: Number((f.store.get('shots', seeded.shotId) as {revision: number}).revision), requestId: randomUUID(),
    providerId: 'ark', model: model.modelId, connectionId: f.configuration.id, configurationRevision: 1,
    modelEntryId: model.id, parameters: {durationSeconds: 4, resolution: '720p'}} as never),
  (error: {code?: string}) => error.code !== 'DIALOGUE_PROMPT_TOO_LONG');
});
