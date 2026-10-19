import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOpacityTimelineIntent,captureOpacityTimelinePrepare,captureOpacityTimelineRecord,isOpacityTimelineMutationResponse,isOpacityTimelineTask} from '../packages/contracts/src/timeline-opacity-persistence.ts';
import {schemas,isTimelineRecord,isTimelineMutationResponse,isEditTask} from '../packages/contracts/src/index.ts';
import {loudnessApplyFixture} from './fixtures/timeline-loudness-apply.ts';
import {OPACITY_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-opacity-envelope.ts';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-10-16T00:00:00.000Z',op='timeline.clip.update';
const envelope=(points=7)=>({profileId:OPACITY_ENVELOPE_PROFILE,points:Array.from({length:points},(_,frame)=>({frame,opacity:frame/8}))});
const input=()=>({projectId:id(1),requestId:'opacity-persist-fixture',expectedRevision:1,clipId:id(4),patch:{opacityEnvelope:envelope()}});
function timeline(){return {id:id(2),projectId:id(1),revision:2,fps:30,width:720,height:1280,
 tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
 clips:[{id:id(4),assetId:id(5),trackId:id(3),name:'Synthetic clip',startFrame:0,durationFrames:20,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:.8,opacityEnvelope:envelope()}],
 durationFrames:20,createdAt:stamp,updatedAt:stamp};}
const count=value=>1+(value&&typeof value==='object'?Object.values(value).reduce((sum,child)=>sum+count(child),0):0);
function maximumInput(){
 const hash='f'.repeat(64),profileId='jfif-ycbcr8-srgb-v1';
 return {...input(),requestId:'\u0002'.repeat(200),expectedRevision:Number.MAX_SAFE_INTEGER-1,patch:{trackId:id(3),name:'\u0001'.repeat(200),startFrame:0,durationFrames:18000,sourceInFrame:Number.MAX_SAFE_INTEGER-18000,
 rect:{x:0,y:0,width:1280,height:720},gain:2,fadeInFrames:9000,fadeOutFrames:9000,audioRole:'human',
 volumeEnvelope:{profileId:'mioon-clip-linear-attenuation-v1',points:Array.from({length:16},(_,frame)=>({frame,multiplier:1.2345678901234567e-100}))},
 colour:{profileId:'mioon-jfif-image-clip-v1',source:{assetSha256:hash,profileId,interpretation:'srgb',declaredBy:'user',declaredAt:stamp,evidence:{profileId,sha256:hash,sourceByteLength:33554432,width:1920,height:1080,bitDepth:8,alphaMode:'opaque',orientation:1,colourTag:'untagged',sampling:'420',decoderPolicy:'ffmpeg-mjpeg-int-bt601-full-bilinear-rgb24-v1'}},look:{resourceId:id(1),resourceSha256:hash,resourceProfile:'mioon-cube3d-normalized-tetrahedral-v1',purpose:'rec709-sdr-creative',declaredBy:'user',enabled:true,strength:1}},
 opacityEnvelope:envelope()}};
}

test('fixed persistence grammar admits complete seven-point prepare and unchanged execute shell budgets',()=>{
 const original=maximumInput(),prepare={projectId:original.projectId,operation:op,input:original,origin:'new'};
 assert.equal(count(original),123);assert.equal(count(prepare),127);
 const captured=captureOpacityTimelinePrepare(prepare);
 assert.deepEqual(captured,prepare);assert.notEqual(captured.input,original);
 assert.equal(captureOpacityTimelineIntent(op,original).prepareNodes,127);
 const over=structuredClone(prepare);over.input.patch.opacityEnvelope=envelope(8);
 assert.throws(()=>captureOpacityTimelinePrepare(over));
 assert.deepEqual(captured,prepare,'failed capture does not partially modify an admitted value');
 assert.equal(count({projectId:id(1),taskId:id(2),digest:'a'.repeat(64),instanceId:id(3)}),5);
});

test('complete compound-field ACK and durable task use independent retained byte caps',()=>{
 const request=maximumInput(),response={...timeline(),width:1280,height:720,revision:Number.MAX_SAFE_INTEGER,durationFrames:18000};
 response.tracks=[response.tracks[0],{...response.tracks[0],id:id(10),orderIndex:1}];
 response.clips=[{id:id(4),assetId:id(5),...structuredClone(request.patch)},{id:id(11),assetId:id(12),...structuredClone(request.patch),trackId:id(10)}];
 assert.ok(count(response)>128);
 assert.equal(isOpacityTimelineMutationResponse(op,request,response),true);
 const task={id:id(6),projectId:id(1),operation:op,input:request,requestId:request.requestId,digest:'a'.repeat(64),lane:'timeline:mutation',status:'prepared',revision:1,createdAt:stamp,updatedAt:stamp,acknowledged:false,origin:'new'};
 assert.equal(isOpacityTimelineTask(task),true);
 assert.ok(Buffer.byteLength(JSON.stringify(task))<=16384);
 assert.ok(captureOpacityTimelineRecord(response).bytes<=262144);
 const corrupt=structuredClone(response);corrupt.clips[0].colour.look.enabled=false;
 assert.equal(isOpacityTimelineMutationResponse(op,request,corrupt),false);
});

test('new ACK grammar binds exact opacity including null and all old patch fields',()=>{
 const request=input(),response=timeline();
 assert.equal(isOpacityTimelineMutationResponse(op,request,response),true);
 const mismatched=structuredClone(response);mismatched.clips[0].opacityEnvelope.points[0].opacity=.9;
 assert.equal(isOpacityTimelineMutationResponse(op,request,mismatched),false);
 assert.equal(isOpacityTimelineMutationResponse(op,{...request,patch:{...request.patch,gain:.9}},response),false);
 assert.equal(isOpacityTimelineMutationResponse(op,{...request,patch:{opacityEnvelope:null}},response),false);
 response.clips[0].opacityEnvelope=null;
 assert.equal(isOpacityTimelineMutationResponse(op,{...request,patch:{opacityEnvelope:null}},response),true);
 const ordered=timeline();ordered.clips[0].opacityEnvelope={points:ordered.clips[0].opacityEnvelope.points,profileId:OPACITY_ENVELOPE_PROFILE};
 assert.equal(isOpacityTimelineMutationResponse(op,request,ordered),true,'property order is not semantic');
});

test('record and ACK checks retain independent 256KiB budget and historical strict fields',()=>{
 const response=timeline(),request=input();
 assert.equal(captureOpacityTimelineRecord(response).bytes,Buffer.byteLength(JSON.stringify(response)));
 assert.equal(isTimelineRecord(response),false);assert.equal(schemas[op].safeParse(request).success,false);
 assert.equal(isTimelineMutationResponse(op,request,response),false);
 assert.throws(()=>captureOpacityTimelineRecord({...response,opacityEnvelope:null}));
 const audio=structuredClone(response);audio.tracks[0].kind='audio';
 assert.throws(()=>captureOpacityTimelineRecord(audio));
 for(const operation of ['timeline.undo','timeline.redo']){
  const travel={projectId:id(1),requestId:'travel-opacity-history',expectedRevision:1};
  assert.equal(isOpacityTimelineMutationResponse(operation,travel,response),true);
  assert.equal(isOpacityTimelineMutationResponse(operation,{...travel,unknown:1},response),false);
 }
});

test('task grammar retains original input and strict16KiB shell without weakening old tasks',()=>{
 const request=input(),task={id:id(6),projectId:id(1),operation:op,input:request,requestId:request.requestId,digest:'a'.repeat(64),lane:'timeline:mutation',status:'prepared',revision:1,createdAt:stamp,updatedAt:stamp,acknowledged:false,origin:'new'};
 assert.equal(isOpacityTimelineTask(task),true);assert.equal(isEditTask(task),false);
 assert.equal(isOpacityTimelineTask({...task,unknown:1}),false);
 assert.equal(isOpacityTimelineTask({...task,input:{...request,patch:{...request.patch,unknown:1}}}),false);
 assert.deepEqual(task.input,request);
});

test('captured legacy durable families retain their closed read grammar and ACK envelope',async()=>{
 const legacy=[
  ['timeline.track.update',{projectId:id(1),requestId:'legacy-track-fixture',expectedRevision:1,trackId:id(3),patch:{name:'Renamed'}}],
  ['reference.attach',{projectId:id(1),requestId:'legacy-reference-fixture',sourceNodeId:id(8),targetShotId:id(9),expectedSourceRevision:1,expectedShotRevision:1,role:'first_frame'}],
  ['subject.create',{projectId:id(1),requestId:'legacy-subject-fixture',kind:'character',name:'Synthetic subject',assetId:id(5)}],
 ];
 const loudness=await loudnessApplyFixture();legacy.push(['timeline.loudness.apply',loudness.input]);
 for(const [operation,request]of legacy){
  assert.equal(schemas[operation].safeParse(request).success,true);
  assert.deepEqual(captureOpacityTimelineIntent(operation,request).input,request);
  const lane=operation.startsWith('timeline.')?'timeline:mutation':operation.startsWith('reference.')?'reference:mutation':'subject:mutation';
  const task={id:id(6),projectId:request.projectId,operation,input:request,requestId:request.requestId,digest:'a'.repeat(64),lane,status:'unknown',revision:1,createdAt:stamp,updatedAt:stamp,acknowledged:false,origin:'legacy_session'};
  assert.equal(isEditTask(task),true);assert.equal(isOpacityTimelineTask(task),true);
  assert.throws(()=>captureOpacityTimelinePrepare({projectId:request.projectId,operation,input:request,origin:'new'}),'read compatibility does not authorize new preparation');
  assert.throws(()=>captureOpacityTimelineIntent(operation,{...request,opacityEnvelope:null}));
 }
 assert.equal(isOpacityTimelineMutationResponse('timeline.loudness.apply',loudness.input,loudness.response),true);
 assert.equal(isOpacityTimelineMutationResponse('timeline.loudness.apply',loudness.input,{...loudness.response,unknown:1}),false);
});

test('prepare and task hostile descriptors never execute accessors or proxies',()=>{
 let calls=0;const trap=()=>{calls++;throw Error('getter executed');};
 const request=input(),prepare={projectId:id(1),operation:op,input:request,origin:'new'};
 const getter={...prepare};Object.defineProperty(getter,'input',{enumerable:true,get:trap});
 for(const value of [getter,new Proxy(prepare,{get:trap,getPrototypeOf:trap,ownKeys:trap,getOwnPropertyDescriptor:trap})])assert.throws(()=>captureOpacityTimelinePrepare(value));
 const hostileTask={};Object.defineProperty(hostileTask,'operation',{enumerable:true,get:trap});
 assert.equal(isOpacityTimelineTask(hostileTask),false);
 assert.equal(isOpacityTimelineTask(new Proxy({},{ownKeys:trap,getPrototypeOf:trap,get:trap,getOwnPropertyDescriptor:trap})),false);
 assert.equal(calls,0);
});

test('fixed parser capture cannot be replaced through the shared legacy schema map',()=>{
 const saved=schemas[op];
 try{
  schemas[op]={safeParse:()=>({success:true})};
  assert.throws(()=>captureOpacityTimelineIntent(op,{...input(),unknown:true}));
  assert.throws(()=>captureOpacityTimelineIntent(op,{...input(),patch:{opacityEnvelope:envelope(),unknown:true}}));
 }finally{schemas[op]=saved;}
});
