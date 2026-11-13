import type {FixtureTimeline} from './helpers/strict-timeline-core-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {schemas,parse,TIMELINE_OUTPUT_PRESETS,DEFAULT_TIMELINE_OUTPUT_PRESET,timelineOutputPreset,TIMELINE_FORMAT_BLOCKED_REASONS,isTimelineFormatReadResponse,isTimelineRecord,isTimelineMutationResponse,DURABLE_EDIT_OPERATIONS,editTaskLane,operationEffect,hasRequestNotAppliedProof} from '@mioon/contracts';
import {TIMELINE_FORMAT_WRITE_PRESETS} from '../packages/contracts/src/timeline-output-geometry.ts';
import {readWrappedTimelineReceipt} from '../packages/business/src/timeline-retained-receipts.ts';
const projectId=randomUUID();
const input={projectId,expectedProjectRevision:1,expectedRevision:0,requestId:randomUUID(),presetId:'landscape_720'};
const timeline=(presetId='landscape_720'): FixtureTimeline=>{const {fps,width,height}=timelineOutputPreset(presetId)!;return {id:randomUUID(),projectId,revision:1,fps,width,height,tracks:[{id:randomUUID(),name:'Video 1',kind:'video',orderIndex:0,hidden:false,muted:false}],clips:[],durationFrames:0,createdAt:'2026-10-11T10:00:00.000Z',updatedAt:'2026-10-11T10:00:00.000Z'};};
test('the public frame input admits all presets while the fixed Mio schema keeps its original enum',()=>{
 assert.equal(DEFAULT_TIMELINE_OUTPUT_PRESET,'portrait_1080');assert.equal(Object.isFrozen(TIMELINE_OUTPUT_PRESETS),true);
 assert.deepEqual(TIMELINE_FORMAT_WRITE_PRESETS.map(({id,fps,width,height})=>({id,fps,width,height})),[
  {id:'portrait_1080',fps:30,width:1080,height:1920},{id:'landscape_1080',fps:30,width:1920,height:1080},{id:'square_1080',fps:30,width:1080,height:1080},
  {id:'portrait_720',fps:30,width:720,height:1280},{id:'landscape_720',fps:30,width:1280,height:720},{id:'square_720',fps:30,width:720,height:720}]);
 for(const preset of TIMELINE_OUTPUT_PRESETS){
  assert.equal(Object.isFrozen(preset),true);
  assert.equal(timelineOutputPreset(preset.id),preset);
  assert.equal(timelineOutputPreset(preset),preset);
  const request={...input,presetId:preset.id};
  assert.deepEqual(parse('timeline.format.set',request),request);
  assert.equal(schemas['timeline.format.set'].safeParse(request).success,TIMELINE_FORMAT_WRITE_PRESETS.some(item=>item.id===preset.id));
 }
 for(const value of ['other',{},null,{fps:30,width:1280,height:1280},{fps:24,width:720,height:1280}])assert.equal(timelineOutputPreset(value),null);
 assert.equal(schemas['timeline.format.set'].safeParse(input).success,true);
 for(const change of [{expectedRevision:-1},{expectedRevision:1.2},{expectedRevision:Number.MAX_SAFE_INTEGER},{expectedProjectRevision:0},{expectedProjectRevision:Number.MAX_SAFE_INTEGER+1},{presetId:'custom'},{fps:30},{allowPending:true}])assert.equal(schemas['timeline.format.set'].safeParse({...input,...change}).success,false);
 assert.equal(schemas['timeline.clip.remove'].safeParse({projectId,expectedRevision:0,requestId:randomUUID(),clipId:randomUUID()}).success,false);
});
test('format read response is exact, scoped, bounded, and self-consistent',()=>{
 const value={projectId,projectRevision:1,timelineId:null,timelineRevision:0,presetId:'portrait_1080',fps:30,width:1080,height:1920,eligible:true,blockedReasons:[]};
 assert.equal(isTimelineFormatReadResponse(value,{projectId}),true);
 for(const change of [{projectId:randomUUID()},{timelineId:randomUUID()},{timelineRevision:1},{width:1280},{eligible:false},{blockedReasons:['UNKNOWN']},{extra:true}])assert.equal(isTimelineFormatReadResponse({...value,...change},{projectId}),false);
 const existing={...value,timelineId:randomUUID(),timelineRevision:1,eligible:false,blockedReasons:[...TIMELINE_FORMAT_BLOCKED_REASONS]};
 assert.equal(isTimelineFormatReadResponse(existing,{projectId}),true);
 assert.equal(isTimelineFormatReadResponse({...existing,blockedReasons:['PENDING_EDIT','PENDING_EDIT']},{projectId}),false);
 const ultrawide={...existing,presetId:'ultrawide_1080',width:2520,height:1080};
 assert.equal(isTimelineFormatReadResponse(ultrawide,{projectId}),true);
 assert.equal(isTimelineFormatReadResponse({...ultrawide,width:2518},{projectId}),false);
});
test('format ACK allows absence revision zero only for this operation and validates the response own format',()=>{
 const value=timeline();assert.equal(isTimelineMutationResponse('timeline.format.set',input,value),true);
 for(const change of [{revision:2},{projectId:randomUUID()},{width:720},{fps:60},{durationFrames:1}])assert.equal(isTimelineMutationResponse('timeline.format.set',input,{...value,...change}),false);
 assert.equal(isTimelineMutationResponse('timeline.format.set',{...input,presetId:'square_720'},value),false);
 const portrait=timeline('portrait_720');assert.equal(isTimelineRecord(portrait),true);
 assert.equal(isTimelineRecord({...portrait,width:1280}),false);
});
test('legacy rectangle syntax and ACKs retain their original write bounds',()=>{
 for(const preset of TIMELINE_FORMAT_WRITE_PRESETS){
  const value=timeline(preset.id),clip={id:randomUUID(),trackId:value.tracks[0].id,assetId:randomUUID(),name:'Clip',startFrame:0,durationFrames:30,sourceInFrame:0,rect:{x:0,y:0,width:value.width,height:value.height},gain:1};
  value.clips=[clip];value.durationFrames=30;value.revision=2;
  const add={projectId,expectedRevision:1,requestId:randomUUID(),trackId:clip.trackId,assetId:clip.assetId,startFrame:0,durationFrames:30};
  assert.equal(schemas['timeline.clip.add'].safeParse({...add,rect:clip.rect}).success,true);
  assert.equal(isTimelineRecord(value),true);assert.equal(isTimelineMutationResponse('timeline.clip.add',add,value),true);
  assert.equal(isTimelineRecord({...value,clips:[{...clip,rect:{...clip.rect,x:2}}]}),false);
 }
});
test('a split acknowledgement keeps the same layout basis on both halves',()=>{
 const value=timeline('portrait_720');
 const left={id:randomUUID(),trackId:value.tracks[0].id,assetId:randomUUID(),name:'Clip',startFrame:0,durationFrames:15,sourceInFrame:0,
  rect:{x:0,y:0,width:256,height:256},gain:1,layout:{profileId:'mioon-clip-layout-v2' as const,basisPresetId:'landscape_720' as const}};
 const right={...left,id:randomUUID(),startFrame:15};
 const result={...value,revision:2,durationFrames:30,clips:[left,right]};
 const request={projectId,expectedRevision:1,requestId:randomUUID(),clipId:left.id,atFrame:15};
 assert.equal(isTimelineMutationResponse('timeline.clip.split',request,result),true);
 const differentBasis={...right,layout:{...right.layout,basisPresetId:'square_720'}};
 assert.equal(isTimelineRecord({...result,clips:[left,differentBasis]}),true);
 assert.equal(isTimelineMutationResponse('timeline.clip.split',request,{...result,clips:[left,differentBasis]}),false);

 const sceneSplit={operation:'timeline.clip.splitAtScenes',requestId:request.requestId,
  timeline:{...result,clips:[left,{...right,sourceInFrame:15}]},
  split:[{clipId:left.id,clipIds:[left.id,right.id],cutFrames:[15],fadeCutFrames:[]}],skipped:[]};
 assert.equal(readWrappedTimelineReceipt(sceneSplit,projectId,request.requestId),sceneSplit.timeline);
 const wrongCut={...sceneSplit,split:[{...sceneSplit.split[0],cutFrames:[14]}]};
 assert.equal(readWrappedTimelineReceipt(wrongCut,projectId,request.requestId),undefined);
 const wrongBasis={...sceneSplit,timeline:{...result,clips:[left,{...differentBasis,sourceInFrame:15}]}};
 assert.equal(readWrappedTimelineReceipt(wrongBasis,projectId,request.requestId),undefined);
});
test('format uses existing lane and strict proof while preserving all legacy durable ordering',()=>{
 assert.deepEqual(DURABLE_EDIT_OPERATIONS.filter(operation=>operation!=='timeline.clip.rippleRemove').slice(0,15),['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','subject.create','subject.version.add','subject.binding.set']);
 assert.equal(DURABLE_EDIT_OPERATIONS.filter(operation=>operation==='timeline.clip.rippleRemove').length,1);
 assert.equal(DURABLE_EDIT_OPERATIONS[16],'timeline.format.set');assert.equal(editTaskLane('timeline.format.set'),'timeline:mutation');
 assert.equal(operationEffect('timeline.format.get').readOnly,true);assert.equal(operationEffect('timeline.format.set').readOnly,false);
 const error={code:'TIMELINE_FORMAT_UNCHANGED',status:409,details:{mutationOutcome:'not_applied',operation:'timeline.format.set',projectId,requestId:input.requestId}};
 assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.format.set'}),true);
 for(const field of ['operation','projectId','requestId']){const incomplete=structuredClone(error);delete incomplete.details[(field as keyof typeof incomplete.details)];assert.equal(hasRequestNotAppliedProof(incomplete,input,{operation:'timeline.format.set'}),false);}
});
