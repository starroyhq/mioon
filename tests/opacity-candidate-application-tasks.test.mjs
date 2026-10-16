import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOpacityApplicationPrepare,isOpacityApplicationMutationResponse,isOpacityApplicationTask,captureOpacityTimelinePrepare} from '../packages/contracts/src/timeline-opacity-persistence.ts';
import {isTimelineMutationResponse,isEditTask} from '../packages/contracts/src/index.mjs';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const stamp='2026-10-16T00:00:00.000Z';
const curve=()=>({profileId:'mioon-clip-linear-opacity-v1',points:[{frame:0,opacity:0},{frame:20,opacity:1}]});
const base=()=>({projectId:id(1),requestId:'application-task-fixture',expectedRevision:1});
const add=()=>({...base(),assetId:id(5),trackId:id(3),startFrame:0,durationFrames:20,name:'Synthetic clip'});
function record(){return {id:id(2),projectId:id(1),revision:2,fps:30,width:720,height:1280,
 tracks:[{id:id(3),name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
 clips:[{id:id(4),assetId:id(5),trackId:id(3),name:'Synthetic clip',startFrame:0,durationFrames:20,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,opacityEnvelope:curve()}],
 durationFrames:20,createdAt:stamp,updatedAt:stamp};}
const task=(operation,input)=>({id:id(6),projectId:id(1),operation,input,requestId:input.requestId,digest:'a'.repeat(64),lane:'timeline:mutation',status:'prepared',revision:1,createdAt:stamp,updatedAt:stamp,acknowledged:false,origin:'new'});

test('fresh application prepare has a fixed seven-operation data grammar without broadening ordinary42/43',()=>{
 const inputs=[
  ['timeline.track.add',{...base(),kind:'video',name:'Overlay'}],
  ['timeline.track.update',{...base(),trackId:id(3),patch:{name:'Renamed',muted:true}}],
  ['timeline.clip.add',{...add(),opacityEnvelope:curve()}],
  ['timeline.clip.update',{...base(),clipId:id(4),patch:{opacityEnvelope:null}}],
  ['timeline.clip.remove',{...base(),clipId:id(4)}],
  ['timeline.undo',base()],['timeline.redo',base()],
 ];
 for(const [operation,input]of inputs){
  const prepare={projectId:id(1),operation,input,origin:'new'};
  assert.deepEqual(captureOpacityApplicationPrepare(prepare),prepare);
  assert.equal(isOpacityApplicationTask(task(operation,input)),true);
  if(!['timeline.clip.update','timeline.undo','timeline.redo'].includes(operation))assert.throws(()=>captureOpacityTimelinePrepare(prepare));
 }
 for(const operation of ['timeline.seed','timeline.clip.split','timeline.clip.replaceSource','timeline.format.set','timeline.render','reference.attach','subject.create']){
  assert.throws(()=>captureOpacityApplicationPrepare({projectId:id(1),operation,input:base(),origin:'new'}));
  assert.equal(isOpacityApplicationTask(task(operation,base())),false);
 }
});

test('application add ACK requires exact opacity presence, null or points on the clip matching legacy fields',()=>{
 for(const state of ['absent','null','curve']){
  const input=add(),response=record();delete response.clips[0].opacityEnvelope;
  if(state!=='absent'){input.opacityEnvelope=state==='null'?null:curve();response.clips[0].opacityEnvelope=structuredClone(input.opacityEnvelope);}
  assert.equal(isOpacityApplicationMutationResponse('timeline.clip.add',input,response),true,state);
  const corrupt=structuredClone(response);
  if(state==='absent')corrupt.clips[0].opacityEnvelope=null;
  else delete corrupt.clips[0].opacityEnvelope;
  assert.equal(isOpacityApplicationMutationResponse('timeline.clip.add',input,corrupt),false,state);
 }
 const input={...add(),opacityEnvelope:curve()},response=record();
 response.clips.push({...structuredClone(response.clips[0]),id:id(7),startFrame:20,opacityEnvelope:null});response.durationFrames=40;
 // The first clip matches scalar fields but loses the curve; the second has
 // the requested curve but a different start. Neither is a complete ACK.
 response.clips[0].opacityEnvelope=null;response.clips[1].opacityEnvelope=curve();
 assert.equal(isOpacityApplicationMutationResponse('timeline.clip.add',input,response),false);
 response.clips[0].opacityEnvelope=curve();
 assert.equal(isOpacityApplicationMutationResponse('timeline.clip.add',input,response),true);
 response.clips[0].gain=.5;
 assert.equal(isOpacityApplicationMutationResponse('timeline.clip.add',input,response),false,'legacy default gain remains checked');
});

test('application track/remove ACK projects retained opacity but still uses frozen legacy intent semantics',()=>{
 const response=record(),update={...base(),trackId:id(3),patch:{name:'Renamed'}};response.tracks[0].name='Renamed';
 assert.equal(isOpacityApplicationMutationResponse('timeline.track.update',update,response),true);
 assert.equal(isTimelineMutationResponse('timeline.track.update',update,response),false);
 response.tracks.push({id:id(8),name:'Overlay',kind:'video',orderIndex:1,hidden:false,muted:false});
 assert.equal(isOpacityApplicationMutationResponse('timeline.track.add',{...base(),kind:'video',name:'Overlay'},response),true);
 assert.equal(isOpacityApplicationMutationResponse('timeline.track.add',{...base(),kind:'video',name:'Wrong'},response),false);
 assert.equal(isOpacityApplicationMutationResponse('timeline.clip.remove',{...base(),clipId:id(9)},response),true);
 assert.equal(isOpacityApplicationMutationResponse('timeline.clip.remove',{...base(),clipId:id(4)},response),false);
 assert.equal(isOpacityApplicationMutationResponse('timeline.track.update',{...update,patch:{name:'Renamed',opacityEnvelope:null}},response),false);
 assert.equal(isOpacityApplicationMutationResponse('timeline.seed',base(),response),false);
});

test('application task projection retains original opacity fields and rejects unknown shell or intent fields',()=>{
 const input={...add(),opacityEnvelope:curve()},value=task('timeline.clip.add',input),before=structuredClone(value);
 assert.equal(isOpacityApplicationTask(value),true);assert.equal(isEditTask(value),false);
 assert.deepEqual(value,before);
 assert.equal(isOpacityApplicationTask({...value,unknown:true}),false);
 assert.equal(isOpacityApplicationTask({...value,input:{...input,unknown:true}}),false);
 assert.equal(isOpacityApplicationTask({...value,input:{...input,opacityEnvelope:{...curve(),points:[...curve().points,...Array.from({length:6},(_,n)=>({frame:n+2,opacity:.5}))]}}}),false);
 let calls=0;const hostile={...value};Object.defineProperty(hostile,'input',{enumerable:true,get(){calls++;throw Error('getter');}});
 assert.equal(isOpacityApplicationTask(hostile),false);assert.equal(calls,0);
});
