import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../packages/business/src/project-file/test-store.ts';
import {createServices} from '../packages/business/src/services.ts';
import {TEST_STORE_LAYOUT,parseProjectApiPath} from '../packages/contracts/src/project-file.ts';
import {upgradeProjectFormatTo5} from '../packages/business/src/project-file/format5-upgrade.ts';
import {FORMAT5_PROJECT_SCHEMA_VERSION} from '../packages/business/src/project-file/schema/databases.ts';
import {composeProjectRuntime,type ProjectRuntime} from './helpers/test-server.ts';
import {createProjectDeletionGate} from '../apps/server/src/project-deletion-gate.ts';
import {openAppLibrary} from '../packages/business/src/app-db/index.ts';
import {createWorkspaceConfiguration} from '../packages/business/src/workspace-configuration.ts';
import {createAppCompanionDocuments} from '../packages/business/src/companion-scope.ts';
import {createProjectServiceApplication} from '../packages/business/src/project-service-application.ts';
import type {ServiceApplicationPorts} from '../packages/business/src/services.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';
import {execFileSync} from 'node:child_process';
import {testEnv} from './helpers/test-env.ts';
import {createTimelineRecoveryBoundary} from '../packages/business/src/timeline-recovery.ts';
import {prepareProjectAssetFullHash} from '../packages/business/src/project-media-storage.ts';
import {createFormat5SequenceEditService} from '../packages/business/src/format5-sequence-edit-service.ts';

function testApplication(library:ReturnType<typeof openAppLibrary>):ServiceApplicationPorts{
 const configuration=createWorkspaceConfiguration({root:library.dataDir,documents:createAppCompanionDocuments(library)});
 const assertOwner=createProjectServiceApplication(library).assertMutationAllowed;
 return {configuration,outsidePaths:library.outsidePaths,receipts:library.receipts,assertMutationAllowed(){assertOwner();assert.equal(library.db.isOpen,true);}};
}
interface Fixture {runtime:ProjectRuntime;library:ReturnType<typeof openAppLibrary>;shutdown:AbortController;close():Promise<void>}
async function composeExisting(t:TestContext,store:ReturnType<typeof upgradeProjectFormatTo5>['store'],root:string):Promise<Fixture>{
 mkdirSync(path.join(root,'cache'),{recursive:true,mode:0o700});mkdirSync(path.join(root,'tmp'),{recursive:true,mode:0o700});
 const library=openAppLibrary({dataDir:path.join(root,'app')}),shutdown=new AbortController(),identity=library.projectFileIdentity(store.projectFile);
 assert.ok(identity);
 library.registry.upsert({projectId:store.projectId,projectFile:store.projectFile,fileIdentity:identity,name:'Format 5 recovery',lastOpenedAt:null,summary:null});
 const deletionGate=createProjectDeletionGate({signal:shutdown.signal,subscribeMedia:onMediaProcess,busy:()=>{throw new Error('project busy');}});
 const runtime=await composeProjectRuntime({store,shutdown,deletionGate,port:4318,serverPort:()=>4318,listeningPort:()=>4318,
  comfyModule:'skip' as const,privateMediaDirectories:[library.dataDir,path.join(root,'cache'),path.join(root,'tmp')],
  application:library,serviceApplication:testApplication(library)});
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;shutdown.abort();runtime.taskRuntimeV2?.close();runtime.taskHttpV2?.close();
  await runtime.serviceDrain();await runtime.editTasks.drain();await runtime.closeSettings();runtime.taskToolsV2?.dispose();
  try{store.close();}finally{library.close();}};
 t.after(close);return {runtime,library,shutdown,close};
}
async function preparedProject(t:TestContext){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'format5-recovery-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=openStore(root),services=createServices(store,new Map());
 const project=await services.call('project.create',{name:'Format 5 recovery project'}) as {id:string};
 const videoFile=path.join(root,'main.mp4'),audioFile=path.join(root,'sound.wav');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=red:s=360x640:d=1:r=30','-pix_fmt','yuv420p','-y',videoFile],{env:testEnv()});
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-y',audioFile],{env:testEnv()});
 const {readFileSync}=await import('node:fs');
 const image=await services.call('asset.import',{projectId:project.id,name:'main.mp4',mimeType:'video/mp4',dataBase64:readFileSync(videoFile).toString('base64')}) as {id:string;sha256:string};
 const audio=await services.call('asset.import',{projectId:project.id,name:'sound.wav',mimeType:'audio/wav',dataBase64:readFileSync(audioFile).toString('base64')}) as {id:string;sha256:string};
 await prepareProjectAssetFullHash(root,image.id);await prepareProjectAssetFullHash(root,audio.id);
 const imageFinal=store.get('assets',image.id) as {sha256:string},audioFinal=store.get('assets',audio.id) as {sha256:string};
 let timeline=await services.call('timeline.get',{projectId:project.id}) as {id:string;revision:number;tracks:{id:string;kind:string}[]};
 timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
  trackId:timeline.tracks.find(track=>track.kind==='video')!.id,assetId:image.id,startFrame:0,sourceInFrame:0,durationFrames:30,gain:1}) as typeof timeline;
 timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
  trackId:timeline.tracks.find(track=>track.kind==='audio')!.id,assetId:audio.id,startFrame:0,sourceInFrame:0,durationFrames:30,gain:1}) as typeof timeline;
 await services.drain();store.close();
 const location={localDir:path.join(root,...TEST_STORE_LAYOUT.localDir),cacheDir:path.join(root,...TEST_STORE_LAYOUT.cacheDir),tempDir:path.join(root,...TEST_STORE_LAYOUT.tempDir)};
 const upgraded=upgradeProjectFormatTo5({projectFile:path.join(root,...TEST_STORE_LAYOUT.projectFile),locate:()=>location,approveUpgrade:()=>true});
 assert.equal(Number(upgraded.store.db.prepare('PRAGMA project.user_version').get()?.user_version),FORMAT5_PROJECT_SCHEMA_VERSION);
 return {root,store:upgraded.store,projectId:upgraded.store.projectId,audioSha:audioFinal.sha256,imageSha:imageFinal.sha256,
  audioAssetId:audio.id,imageAssetId:image.id,timelineId:timeline.id};
}
test('composed format-5 project supports capability check, local draft read and clip loudness',{timeout:180000},async t=>{
 const prepared=await preparedProject(t);
 const {runtime}=await composeExisting(t,prepared.store,prepared.root);
 const projectId=prepared.projectId;
 const boundary=createTimelineRecoveryBoundary(prepared.store.db,{projectId});
 const timeline=boundary.read() as {id:string;projectId:string;revision:number;clips:{id:string;assetId:string}[]};
 assert.ok(timeline.clips.length>=2);
 assert.equal(Object.hasOwn(timeline as unknown as Record<string,unknown>,'mainTrack'),false);
 assert.equal(boundary.read({sourceSemantics:false})?.id,timeline.id);
 assert.equal(boundary.validate(timeline as never).id,timeline.id);
 const settings={profileId:'mp4_h264_v1',resolution:'native',rateControl:{mode:'crf',quality:'standard'}};
 const capability=await runtime.serviceCall('timeline.export.capabilities',{projectId,expectedRevision:timeline.revision,exportSettings:settings}) as {status:string;issues:{code:string}[]};
 assert.notEqual(capability.issues[0]?.code,'INVALID_TIMELINE_SNAPSHOT');
 assert.ok(['available','blocked'].includes(capability.status));
 // Local drafts read through the composed host's real drafts port.
 const drafts=runtime.draftsFactory({store:prepared.store,projectId,signal:new AbortController().signal,
  relocate(){}} as never);
 assert.ok(drafts);
 const clip=timeline.clips.find(item=>item.assetId===prepared.imageAssetId)!;
 const socket=new (await import('node:net')).Socket(),req=new (await import('node:http')).IncomingMessage(socket),res=new (await import('node:http')).ServerResponse(req);
 req.method='GET';req.url=`/api/projects/${projectId}/local-drafts/clip?projectId=${projectId}&timelineId=${timeline.id}&clipId=${clip.id}`;
 const url=new URL(req.url,'http://127.0.0.1'),route=parseProjectApiPath(url.pathname);assert.ok(route);
 const ended:unknown[]=[];t.mock.method(res,'end',(value:unknown)=>{ended.push(value);return res;});
 try{
  const handled=await drafts.handle({req,res,url,route,signal:new AbortController().signal});
  assert.equal(handled,true);assert.equal(res.statusCode,200,String(ended[0]));
  const body=JSON.parse(String(ended[0]));assert.equal(body.ok,true);
 }finally{res.emit('close');socket.destroy();}
 // Clip loudness measures the saved audio clip through the same assembly.
 const audioClip=timeline.clips.find(item=>item.assetId===prepared.audioAssetId)!;
 const audioAssetSha=prepared.audioSha;
 const loudness=await runtime.serviceCall('timeline.clip.loudness',{projectId,timelineId:timeline.id,expectedRevision:timeline.revision,
  clipId:audioClip.id,expectedAssetSha256:audioAssetSha,measurementProfile:'bs1770-5-48k-stereo-fir4x-v1'}) as {status?:string};
 assert.ok(loudness&&typeof loudness==='object');
 await runtime.serviceDrain();
});


async function preparedSoundProject(t:TestContext){
 const root=mkdtempSync(path.join(realpathSync(tmpdir()),'format5-recovery-sound-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const store=openStore(root),services=createServices(store,new Map());
 const project=await services.call('project.create',{name:'Format 5 recovery sound project'}) as {id:string};
 const file=path.join(root,'sound-source.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=360x640:d=1:r=30','-f','lavfi','-i','sine=frequency=660:duration=1',
  '-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',file],{env:testEnv()});
 const {readFileSync}=await import('node:fs');
 const asset=await services.call('asset.import',{projectId:project.id,name:'sound-source.mp4',mimeType:'video/mp4',
  dataBase64:readFileSync(file).toString('base64')}) as {id:string;sha256:string};
 await prepareProjectAssetFullHash(root,asset.id);
 const finalized=store.get('assets',asset.id) as {sha256:string;hasAudio?:boolean};
 assert.equal(finalized.hasAudio,true,'the generated video must keep an audio stream');
 let timeline=await services.call('timeline.get',{projectId:project.id}) as {id:string;revision:number;tracks:{id:string;kind:string}[]};
 timeline=await services.call('timeline.clip.add',{projectId:project.id,expectedRevision:timeline.revision,requestId:randomUUID(),
  trackId:timeline.tracks.find(track=>track.kind==='video')!.id,assetId:asset.id,startFrame:0,sourceInFrame:0,durationFrames:30,gain:1}) as typeof timeline;
 await services.drain();store.close();
 const location={localDir:path.join(root,...TEST_STORE_LAYOUT.localDir),cacheDir:path.join(root,...TEST_STORE_LAYOUT.cacheDir),tempDir:path.join(root,...TEST_STORE_LAYOUT.tempDir)};
 const upgraded=upgradeProjectFormatTo5({projectFile:path.join(root,...TEST_STORE_LAYOUT.projectFile),locate:()=>location,approveUpgrade:()=>true});
 const boundary=createTimelineRecoveryBoundary(upgraded.store.db,{projectId:upgraded.store.projectId});
 const before=boundary.read() as {clips:{id:string}[]};
 const sourceClipId=before.clips[0]!.id;
 const editor=createFormat5SequenceEditService(upgraded.store);
 const preview=editor.preview({projectId:upgraded.store.projectId,requestId:`sound-${randomUUID()}`,
  soundIntent:{side:'timeline',operation:{kind:'separate-sound',clipId:sourceClipId}}}) as {envelope:unknown;planDigest:string};
 const receipt=editor.commit({projectId:upgraded.store.projectId,envelope:preview.envelope,expectedPlanDigest:preview.planDigest}) as {status:string};
 assert.equal(receipt.status,'applied');
 const after=createTimelineRecoveryBoundary(upgraded.store.db,{projectId:upgraded.store.projectId}).read() as
  {id:string;revision:number;clips:{id:string;assetId:string;muted?:boolean;soundOnly?:boolean}[]};
 const muted=after.clips.find(clip=>clip.muted===true),soundOnly=after.clips.find(clip=>clip.soundOnly===true);
 assert.ok(muted,'separate sound mutes the source clip');
 assert.ok(soundOnly,'separate sound inserts a sound-only clip');
 assert.equal(createTimelineRecoveryBoundary(upgraded.store.db,{projectId:upgraded.store.projectId}).validate(after as never).id,after.id);
 return {root,store:upgraded.store,projectId:upgraded.store.projectId,sha:finalized.sha256,timelineId:after.id,
  timelineRevision:after.revision,mutedClipId:muted.id,soundOnlyClipId:soundOnly.id};
}

test('composed format-5 project reads muted and sound-only clips for drafts and loudness',{timeout:180000},async t=>{
 const prepared=await preparedSoundProject(t);
 const {runtime}=await composeExisting(t,prepared.store,prepared.root);
 const projectId=prepared.projectId;
 // Local drafts GET for both the muted source and the sound-only clip.
 const drafts=runtime.draftsFactory({store:prepared.store,projectId,signal:new AbortController().signal,relocate(){}} as never);
 const draft=async(clipId:string)=>{
  const socket=new (await import('node:net')).Socket(),req=new (await import('node:http')).IncomingMessage(socket),res=new (await import('node:http')).ServerResponse(req);
  req.method='GET';req.url=`/api/projects/${projectId}/local-drafts/clip?projectId=${projectId}&timelineId=${prepared.timelineId}&clipId=${clipId}`;
  const url=new URL(req.url,'http://127.0.0.1'),route=parseProjectApiPath(url.pathname);assert.ok(route);
  const ended:unknown[]=[];t.mock.method(res,'end',(value:unknown)=>{ended.push(value);return res;});
  try{assert.equal(await drafts.handle({req,res,url,route,signal:new AbortController().signal}),true);
   assert.equal(res.statusCode,200,String(ended[0]));
   const body=JSON.parse(String(ended[0])) as {ok:boolean};assert.equal(body.ok,true);
  }finally{res.emit('close');socket.destroy();}
 };
 await draft(prepared.mutedClipId);await draft(prepared.soundOnlyClipId);
 const loudness=(clipId:string)=>(runtime.serviceCall('timeline.clip.loudness',{projectId,timelineId:prepared.timelineId,
  expectedRevision:prepared.timelineRevision,clipId,expectedAssetSha256:prepared.sha,
  measurementProfile:'bs1770-5-48k-stereo-fir4x-v1'}) as Promise<unknown>).then(
   value=>({ok:true,value}),error=>({ok:false,code:(error as {code?:string}).code}));
 const muted=await loudness(prepared.mutedClipId);
 assert.equal(muted.ok,false);assert.equal((muted as {code?:string}).code,'TIMELINE_CLIP_LOUDNESS_MUTED');
 const sound=await loudness(prepared.soundOnlyClipId);
 assert.equal(sound.ok,true,JSON.stringify(sound));
 await runtime.serviceDrain();
});
