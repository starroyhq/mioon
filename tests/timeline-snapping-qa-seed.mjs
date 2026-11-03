/** Fresh synthetic kernels only. Historical fixture directories are never upgraded. */
import path from 'node:path';
import {writeFile,unlink,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {prepareNativeQaProject,closeQaProject} from './helpers/native-local-qa-fixture.ts';
import {readQaFixture} from './helpers/kernel-qa-fixture.mjs';
import {run} from '@mioon/business/media';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
import {randomUUID} from 'node:crypto';
const runtime=path.resolve(process.env.MIOON_QA_RUNTIME||'evidence/timeline-snapping/runtime'),dataDir=path.join(runtime,'data');
if(!runtime.endsWith('/evidence/timeline-snapping/runtime'))throw Error('Disposable timeline-snapping runtime required');
ensurePrivateDirectory(runtime,{create:true});
const previous=readQaFixture(path.join(runtime,'fixture.json'),dataDir);
if(previous&&(previous.snappingLayoutVersion!==1||previous.assetReferenceFixture!==1))throw Error('Historical snapping geometry must be preserved; choose a fresh MIOON_QA_RUNTIME');
if(!previous){
 if(existsSync(path.join(dataDir,'app-library.db')))throw Error('Partial snapping data must be preserved; choose a fresh MIOON_QA_RUNTIME');
 const first=await prepareNativeQaProject(dataDir,'吸附验收 · 合成项目'),{store,services:s,project}=first,projectId=project.id;
 let other;const generated=[];
 try{
  const importMedia=async(name,mimeType,bytes)=>s.call('asset.import',{projectId,name,mimeType,dataBase64:bytes.toString('base64')});
  const video=async(name,seconds,colour)=>{
   const file=path.join(store.tempDir,randomUUID()+'.mp4');generated.push(file);
   await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-n','-f','lavfi','-i',`color=c=${colour}:s=320x180:r=30:d=${seconds}`,'-c:v','libx264','-threads','1','-pix_fmt','yuv420p',file]);
   return importMedia(name,'video/mp4',await readFile(file));
  };
  const firstVideo=await video('01 First · 合成视频.mp4',4,'0x336699'),secondVideo=await video('02 Second · 合成视频.mp4',6,'0x993366');
  const audioFile=path.join(store.tempDir,randomUUID()+'.wav');generated.push(audioFile);
  await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-n','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=4',audioFile]);
  const audio=await importMedia('合成音频.wav','audio/wav',await readFile(audioFile));
  const image=await importMedia('星形 · 合成首帧.png','image/png',await readFile(new URL('../examples/synthetic/reference.png',import.meta.url)));
  let timeline=await s.call('timeline.get',{projectId});
  const videoTrack=timeline.tracks.find(track=>track.kind==='video'),baseAudioTrack=timeline.tracks.find(track=>track.kind==='audio');
  const addTrack=async(kind,name)=>{timeline=await s.call('timeline.track.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),kind,name});return timeline.tracks.at(-1);};
  const imageTrack=timeline.tracks.filter(track=>track.kind==='video')[1];if(!videoTrack||!baseAudioTrack||!imageTrack)throw Error('Expected the current two-video/one-audio baseline');
  const targetTrack=await addTrack('video','吸附练习 · 画面'),audioTrack=await addTrack('audio','吸附练习 · 音频');
  const add=async(asset,track,startFrame,durationFrames)=>timeline=await s.call('timeline.clip.add',{projectId,expectedRevision:timeline.revision,requestId:randomUUID(),assetId:asset.id,trackId:track.id,startFrame,durationFrames});
  await add(firstVideo,videoTrack,0,120);await add(secondVideo,videoTrack,150,150);await add(image,imageTrack,60,150);await add(audio,baseAudioTrack,0,120);await add(audio,baseAudioTrack,150,120);
  // Unknown duration is an explicit synthetic metadata vector, not a copied store.
  const unknown={...store.get('assets',firstVideo.id),id:randomUUID(),name:'验收专用 · 时长未知',duration:null};store.tx(()=>store.put('assets',unknown));
  other=await prepareNativeQaProject(dataDir,'吸附验收 · 独立项目');await other.services.call('timeline.get',{projectId:other.project.id});
  await writeFile(path.join(runtime,'fixture.json'),JSON.stringify({kernel:true,assetReferenceFixture:1,snappingLayoutVersion:1,fixtureId:randomUUID(),workspace:dataDir,dataDir,projectDir:store.projectDir,localDir:store.localDir,projectFile:store.projectFile,runtime,project,second:other.project,targetTrack,audioTrack,timeline,unknownAssetId:unknown.id},null,2),{mode:0o600,flag:'wx'});
 }finally{
  try{if(other)await closeQaProject(other);}finally{try{await closeQaProject(first);}finally{for(const file of generated)try{await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}}}
 }
}
