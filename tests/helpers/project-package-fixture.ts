import {testEnv} from './test-env.ts';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,readFileSync,copyFileSync,rmSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openStore} from '../../packages/business/src/project-file/test-store.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {isProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../packages/business/src/project-file/store.ts';
import type {Store} from '../../packages/business/src/store-contract.ts';
import {prepareProjectAssetFullHash} from '../../packages/business/src/project-media-storage.ts';
import {mediaFixturePath} from './media-reference-fixtures.ts';
import {publishOutputFixture,markProjectOutputRegistered} from './project-output-fixture.ts';

type Row=Record<string,any>;
const tools=process.env.MIOON_TEST_MEDIA_TOOLS??'/opt/homebrew/bin';
const ffmpeg=process.env.MIOON_FFMPEG_PATH??path.join(tools,'ffmpeg'),ffprobe=process.env.MIOON_FFPROBE_PATH??path.join(tools,'ffprobe');
export const mediaToolsAvailable=existsSync(ffmpeg)&&existsSync(ffprobe);
if(mediaToolsAvailable){process.env.MIOON_FFMPEG_PATH??=ffmpeg;process.env.MIOON_FFPROBE_PATH??=ffprobe;}

function render(dir:string,name:string,args:string[]):Buffer{
 const file=path.join(dir,name);execFileSync(process.env.MIOON_FFMPEG_PATH!,['-v','error','-y',...args,file], {env: testEnv()});return readFileSync(file);
}
export function sampleMedia(dir:string){
 return {
  png:render(dir,'ref.png',['-f','lavfi','-i','color=c=0x336699:s=64x64','-frames:v','1']),
  png2:render(dir,'subject.png',['-f','lavfi','-i','color=c=0x993333:s=64x64','-frames:v','1']),
  mp4:render(dir,'clip.mp4',['-f','lavfi','-i','testsrc=size=180x320:rate=30','-t','2','-c:v','libx264','-pix_fmt','yuv420p']),
  wav:render(dir,'music.wav',['-f','lavfi','-i','sine=frequency=440:duration=2']),
 };
}
export const sampleCube=Buffer.from('TITLE "look"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');

const referencedPackageStores=new WeakMap<Store,ProjectStore>();
function legacyPackageAssetView<T>(root:string,value:T):T{
 if(!value||typeof value!=='object'||!('reference' in value))return value;
 // The old serializer spreads imported records while relabeling provenance.
 // Keep its read-only alias enumerable in this view, never in persisted rows.
 return Object.defineProperty({...value},'relativePath',{value:path.relative(root,mediaFixturePath(root,value)),enumerable:true});
}
/** Keep real S1 records and services underneath the historical serializer.
 * This fixture-only read view does not enable native packaging in production;
 * its real SQLite identity still rejects legacy imports into a project file. */
export function legacyPackageViewForReferencedStore(store:ProjectStore):Store{
 const view:Store={db:store.db,root:store.root,
  get:(table,id)=>{const value=store.get(table,id);return table==='assets'?legacyPackageAssetView(store.projectDir,value):value;},
  list:(table,projectId)=>store.list(table,projectId).map(value=>table==='assets'?legacyPackageAssetView(store.projectDir,value):value),
  put:()=>{throw new TypeError('The historical package fixture view is read-only');},
  tx:store.tx,close:store.close,
 };
 referencedPackageStores.set(view,store);return view;
}
export function openWorkspace(root:string){const store=openStore(root);return {store:legacyPackageViewForReferencedStore(store),services:createServices(store,new Map(),{imageOptions:{autoRun:false}})};}
export function tempRoot(label:string):string{return realpathSync(mkdtempSync(path.join(tmpdir(),`mioon-${label}-`)));}

/** Builds a project that touches every entity a `.mioon` file carries. */
export async function buildSampleProject(root:string,{store:packageStore,services}:{store:any;services:any}){
 const store=referencedPackageStores.get(packageStore)??packageStore;
 const mediaDirectory=mkdtempSync(path.join(root,'.package-media-'));
 let media:ReturnType<typeof sampleMedia>;
 try{media=sampleMedia(mediaDirectory);}finally{rmSync(mediaDirectory,{recursive:true,force:true});}
 const native=isProjectStore(store);
 const call=(op:string,input:Row)=>services.call(op,input);
 const project=await call('project.create',{name:'UI 走查项目',description:'第二幕：由街景过渡到霓虹特写',timelinePresetId:'portrait_1080'});
 const imp=async(name:string,mimeType:string,bytes:Buffer)=>{
  const {id}=await call('asset.import',{projectId:project.id,name,mimeType,dataBase64:bytes.toString('base64')});
  if(native&&mimeType.startsWith('video/'))await prepareProjectAssetFullHash(root,id);
  return store.get('assets',id);
 };
 const ref=await imp('ref.png','image/png',media.png),face=await imp('subject.png','image/png',media.png2);
 const video=await imp('clip.mp4','video/mp4',media.mp4),music=await imp('music.wav','audio/wav',media.wav);
 const shot=await call('shot.create',{requestId:randomUUID(),projectId:project.id,title:'霓虹特写',prompt:'镜头缓慢推进',aspectRatio:'9:16',duration:4});
 const node=await call('node.create',{requestId:randomUUID(),projectId:project.id,type:'image',assetId:ref.id,position:{x:10,y:20}});
 const note=await call('node.create',{requestId:randomUUID(),projectId:project.id,type:'text',text:'冷色调',position:{x:300,y:20}});
 await call('reference.attach',{projectId:project.id,sourceNodeId:node.id,targetShotId:shot.id,expectedSourceRevision:node.revision,expectedShotRevision:shot.revision,requestId:randomUUID(),role:'first_frame'});
 await call('edge.create',{projectId:project.id,source:note.id,target:shot.id});
 await call('asset.annotation.set',{projectId:project.id,assetId:video.id,expectedRevision:0,requestId:randomUUID(),tags:['夜景'],note:'主镜头'});
 await call('asset.disposition.set',{projectId:project.id,assetId:video.id,expectedRevision:0,requestId:randomUUID(),disposition:'favorite'});
 await call('asset.range.set',{projectId:project.id,assetId:video.id,expectedRevision:0,requestId:randomUUID(),inFrame:6,outFrame:48});
 const subject=await call('subject.create',{projectId:project.id,kind:'character',name:'主角',assetId:face.id,requestId:randomUUID()});
 // A finished mock version, published exactly as the job worker does.
 const jobId=randomUUID(),versionId=randomUUID(),assetId=randomUUID(),requestId=randomUUID(),requestHash='a'.repeat(64),relativePath=`media/result-${jobId}.mp4`,now=new Date().toISOString();
 const outputFile=path.join(root,relativePath);
 if(!native)copyFileSync(mediaFixturePath(root,video),outputFile);
 const current=store.get('shots',shot.id),info={sizeBytes:video.sizeBytes,sha256:video.sha256,width:video.width,height:video.height,duration:video.duration,hasVideo:true,hasAudio:false};
 const published=native?await publishOutputFixture(store,{assetId,owner:{kind:'generation',id:jobId,requestId,inputHash:requestHash},bytes:readFileSync(mediaFixturePath(root,video)),mimeType:'video/mp4'}):null;
 const snapshot={shotId:shot.id,shotRevision:current.revision,title:current.title,prompt:current.prompt,referenceAssetIds:[ref.id],referenceAssets:[{id:ref.id,...(native?{projectId:ref.projectId,reference:ref.reference,referenceRevision:ref.referenceRevision,sizeBytes:ref.sizeBytes}:{relativePath:ref.relativePath}),mimeType:ref.mimeType,sha256:ref.sha256,width:ref.width,height:ref.height}],referenceConnections:[],aspectRatio:'9:16',duration:4,providerId:'mock',model:'mock-v1',parameters:{},capabilities:{}};
 store.tx(()=>{
  store.put('jobs',{id:jobId,projectId:project.id,shotId:shot.id,requestId,requestHash,providerId:'mock',model:'mock-v1',revision:3,status:'succeeded',phase:'complete',progress:100,snapshot,providerJobId:null,submissionCount:1,error:null,createdAt:now,updatedAt:now,versionId,cancelScope:null,retryOfJobId:null});
  store.put('assets',{id:assetId,projectId:project.id,name:'霓虹特写 模拟视频.mp4',mimeType:'video/mp4',...info,...(published?{...published,producer:{kind:'generation',id:jobId}}:{relativePath}),url:`/media/${assetId}`,provenance:'synthetic-mock',createdAt:now});
  store.put('versions',{id:versionId,projectId:project.id,shotId:shot.id,jobId,number:1,providerId:'mock',model:'mock-v1',isMock:true,snapshot,assetId,url:`/media/${assetId}`,sha256:info.sha256,createdAt:now});
  store.put('shots',{...current,selectedVersionId:versionId,revision:current.revision+1,updatedAt:now});
 });
 if(native&&published)await markProjectOutputRegistered(store,published.publication);
 const shotNow=store.get('shots',shot.id);
 await call('subject.binding.set',{projectId:project.id,shotId:shot.id,subjectId:subject.id,role:'subject',subjectVersionId:null,expectedRevision:0,expectedSubjectRevision:subject.revision,requestId:randomUUID()});
 const lut=await call('lut.import',{projectId:project.id,requestId:randomUUID(),name:'look.cube',dataBase64:sampleCube.toString('base64')});
 let timeline=await call('timeline.get',{projectId:project.id});
 const add=async(input:Row)=>{timeline=await call('timeline.clip.add',{requestId:randomUUID(),projectId:project.id,expectedRevision:timeline.revision,...input});return timeline;};
 const videoTrack=timeline.tracks.find((t:Row)=>t.kind==='video')??timeline.tracks[0],audioTrack=timeline.tracks.find((t:Row)=>t.kind==='audio');
 await add({assetId:video.id,trackId:videoTrack.id,startFrame:0,durationFrames:45});
 await add({assetId,trackId:videoTrack.id,startFrame:45,durationFrames:45});
 if(audioTrack)await add({assetId:music.id,trackId:audioTrack.id,startFrame:0,durationFrames:60});
 timeline=await call('timeline.subtitle.add',{requestId:randomUUID(),projectId:project.id,expectedRevision:timeline.revision,text:'雨后的城市街道',startFrame:0,durationFrames:30}).catch((error:unknown)=>{throw Object.assign(new Error('subtitle add failed'),{cause:error});});
 const assetHandle=(asset:Row)=>native?legacyPackageAssetView(root,asset):asset;
 return {project,assets:{ref:assetHandle(ref),face:assetHandle(face),video:assetHandle(video),music:assetHandle(music),generated:assetHandle(store.get('assets',assetId))},shot:shotNow,node,note,subject,lut,versionId,jobId,timeline:await call('timeline.get',{projectId:project.id})};
}

export const sha256=(value:Buffer|string):string=>createHash('sha256').update(value).digest('hex');
export function cleanup(...roots:string[]):void{for(const root of roots)rmSync(root,{recursive:true,force:true});}
