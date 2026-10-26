import test from 'node:test';
import assert from 'node:assert/strict';
import {schemas,isTimelineRecord,isTimelineMutationResponse,isTimelineRenderRecord,hasRequestNotAppliedProof,isEditTask,EDIT_TASK_LIMITS} from '../packages/contracts/src/index.ts';
import {VOLUME_ENVELOPE_PROFILE as profileId} from '../packages/contracts/src/timeline-volume-envelope.ts';
const id=(n: number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const clone=<T>(value: T): T => JSON.parse(JSON.stringify(value));
const envelope=()=>({profileId,points:[{frame:0,multiplier:1},{frame:20,multiplier:.25}]});
const base=()=>({projectId:id(1),expectedRevision:1,requestId:'envelope-contract-request'});
const add=()=>({...base(),trackId:id(2),assetId:id(3),startFrame:0,durationFrames:20,volumeEnvelope:envelope()});
const update=()=>({...base(),clipId:id(4),patch:{volumeEnvelope:envelope()}});
function timeline(value: ReturnType<typeof envelope>|null|undefined=envelope()) {return {id:id(5),projectId:id(1),revision:2,fps:30,width:720,height:1280,tracks:[{id:id(2),name:'Audio',kind:'audio',orderIndex:0,hidden:false,muted:false}],clips:[{id:id(4),trackId:id(2),assetId:id(3),name:'Fixture',startFrame:0,durationFrames:20,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1,...(value===undefined?{}:{volumeEnvelope:value})}],durationFrames:20,createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z'};}
function render(value: ReturnType<typeof envelope>|null|undefined=envelope()) {const saved=timeline(((value) as unknown as Parameters<typeof timeline>[0]));saved.revision=1;return {id:id(6),projectId:id(1),requestId:base().requestId,mode:'timeline',purpose:'export',timelineRevision:1,snapshot:{timeline:saved,assets:[{id:id(3),sha256:'a'.repeat(64),mimeType:'audio/wav',duration:1,hasAudio:true}],...(value==null?{}:{volumeEnvelopeProfile:profileId})},status:'queued',assetId:null,url:null,error:null,createdAt:saved.createdAt,updatedAt:saved.updatedAt};}

test('live add/update retain exact bounded presence and lexical historical-update semantics',()=>{
 for(const operation of (['timeline.clip.add','timeline.clip.update'] as const))for(const value of ([null,envelope()] as const)){
  const input=operation.endsWith('.add')?add():update(),fields=(input as {patch?:ReturnType<typeof update>['patch']}).patch??input;(fields as {volumeEnvelope:unknown}).volumeEnvelope=value;
  const before=clone(input),parsed=schemas[operation].parse(input);assert.deepEqual(parsed,before);assert.deepEqual(input,before);
 }
 const input=update();assert.equal(schemas['timeline.clip.update'].safeParse(input).success,true,'no present-day duration is required');
 assert.equal(schemas['timeline.clip.update'].safeParse({...input,patch:{...input.patch,durationFrames:10}}).success,false);
 for(const value of ([undefined,{profileId,points:[]},{profileId,points:[{frame:0,multiplier:-0}]},{profileId,points:[{frame:-0,multiplier:1}]},{profileId,points:[{frame:21,multiplier:1}]}] as const))
  assert.equal(schemas['timeline.clip.add'].safeParse({...add(),volumeEnvelope:value}).success,false);
 const absent=add();delete (absent as {volumeEnvelope?: unknown}).volumeEnvelope;assert.equal(Object.hasOwn(schemas['timeline.clip.add'].parse(absent),'volumeEnvelope'),false);
});
test('live point schema refuses sparse, custom, extra-property and unknown typed fields',()=>{
 const invalid=[new Array(2),Object.assign([{frame:0,multiplier:1}],{extra:true}),Object.setPrototypeOf([{frame:0,multiplier:1}],null),[{frame:0,multiplier:1,extra:true}],Array.from({length:17},(_,frame)=>({frame,multiplier:1})),[{frame:1,multiplier:1},{frame:0,multiplier:1}]];
 for(const points of invalid)assert.equal(schemas['timeline.clip.add'].safeParse({...add(),volumeEnvelope:{profileId,points}}).success,false);
 for(const value of ([{profileId,points:envelope().points,extra:true},{profileId:'unknown',points:envelope().points},[]] as const))assert.equal(schemas['timeline.clip.add'].safeParse({...add(),volumeEnvelope:value}).success,false);
 for(const patch of ([{volumeEnvelope:envelope(),unknown:[]},{volumeEnvelope:{profileId,points:[{frame:0,multiplier:[]}]}}] as const))assert.equal(schemas['timeline.clip.update'].safeParse({...update(),patch}).success,false);
});
test('JSON round-tripped ACK uses envelope-only typed equality and exact add/null presence',()=>{
 for(const value of ([null,envelope()] as const)){
  const input=add();input.volumeEnvelope=(value as unknown as (typeof input)["volumeEnvelope"]);const saved=clone(timeline(((value) as unknown as Parameters<typeof timeline>[0])));
  assert.equal(isTimelineRecord(saved),true);assert.equal(isTimelineMutationResponse('timeline.clip.add',input,saved),true);
  assert.equal(isTimelineMutationResponse('timeline.clip.update',{...update(),patch:{volumeEnvelope:value}},saved),true);
  delete saved.clips[0].volumeEnvelope;assert.equal(isTimelineMutationResponse('timeline.clip.add',input,saved),false);
 }
 const input=add(),saved=timeline();(saved.clips[0].volumeEnvelope)!.points[1].multiplier=.5;
 assert.equal(isTimelineMutationResponse('timeline.clip.add',input,saved),false);
 assert.equal(isTimelineMutationResponse('timeline.clip.update',update(),saved),false);
 const absent=add();delete (absent as {volumeEnvelope?: unknown}).volumeEnvelope;assert.equal(isTimelineMutationResponse('timeline.clip.add',absent,timeline(((null) as unknown as Parameters<typeof timeline>[0]))),false);
 const none=timeline();delete none.clips[0].volumeEnvelope;
 assert.equal(isTimelineMutationResponse('timeline.clip.add',{...absent,volumeEnvelope:undefined},none),false);
 assert.equal(isTimelineMutationResponse('timeline.clip.add',{...input,projectId:id(99)},timeline()),false);
});
test('render ACK accepts only the production string profile with exact absent/null behavior',()=>{
 const input={...base(),purpose:'export'},value=render();assert.equal(isTimelineRenderRecord(clone(value),input),true);
 for(const profile of ([undefined,null,{profileId},'unknown'] as const)){const bad=clone(value);if(profile===undefined)delete bad.snapshot.volumeEnvelopeProfile;else bad.snapshot.volumeEnvelopeProfile=(profile as unknown as ((typeof bad)["snapshot"])["volumeEnvelopeProfile"]);assert.equal(isTimelineRenderRecord(bad,input),false);}
 const cleared=render(((null) as unknown as Parameters<typeof render>[0]));assert.equal(isTimelineRenderRecord(cleared,input),true);cleared.snapshot.volumeEnvelopeProfile=profileId;assert.equal(isTimelineRenderRecord(cleared,input),false);
 for(const source of ([{mimeType:'image/png'},{hasAudio:false}] as const)){const bad=clone(value);Object.assign(bad.snapshot.assets[0],source);assert.equal(isTimelineRenderRecord(bad,input),false);}
});
test('render envelope snapshot wrapper stays bounded at 262143/262144/262145 bytes beneath 4-MiB outer cap',()=>{
 const input={...base(),purpose:'export'},value=render();value.snapshot.timeline.clips=[];value.snapshot.assets=[];value.snapshot.timeline.durationFrames=100;
 for(let n=0;n<100;n++){value.snapshot.timeline.clips.push({...timeline().clips[0],id:id(100+n),assetId:id(300+n),startFrame:n,durationFrames:1,volumeEnvelope:(({profileId,points:[{frame:0,multiplier:.5}]}) as unknown as undefined)});value.snapshot.assets.push((({id:id(300+n),sha256:'a'.repeat(64),mimeType:'audio/wav',duration:1,hasAudio:true,relativePath:'x'}) as unknown as Parameters<NonNullable<(((typeof value)["snapshot"])["assets"])["push"]>>[0]));}
 const initial=Buffer.byteLength(JSON.stringify(value.snapshot));
 for(const bytes of ([262143,262144,262145] as const)){const saved=clone(value);let left=bytes-initial;for(const asset of saved.snapshot.assets){const extra=Math.min(4095,left);(asset as typeof asset & {relativePath:string}).relativePath+='x'.repeat(extra);left-=extra;}assert.equal(left,0);assert.equal(Buffer.byteLength(JSON.stringify(saved.snapshot)),bytes);assert.equal(isTimelineRenderRecord(saved,input),bytes<=262144);}
});
test('new rejection codes bind exact operation/project/request even for scalar loudness and never accept uncertain outcomes',()=>{
 const input=base();for(const operation of (['timeline.clip.update','timeline.track.update','timeline.undo','timeline.redo','timeline.loudness.apply'] as const))for(const code of (['TIMELINE_VOLUME_ENVELOPE_INVALID','TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED','TIMELINE_VOLUME_ENVELOPE_LIMIT','TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED'] as const)){
  const error={code,status:409,details:{mutationOutcome:'not_applied',operation,projectId:input.projectId,requestId:input.requestId}};
  assert.equal(hasRequestNotAppliedProof(error,input,{operation}),true);
  for(const key of (['operation','projectId','requestId'] as const)){const missing=clone(error);delete missing.details[key];assert.equal(hasRequestNotAppliedProof(missing,input,{operation}),false);const changed=clone(error);(changed.details as Record<string,unknown>)[key]='wrong';assert.equal(hasRequestNotAppliedProof(changed,input,{operation}),false);}
  assert.equal(hasRequestNotAppliedProof({...error,terminationUnconfirmed:true},input,{operation}),false);
  assert.equal(hasRequestNotAppliedProof({...error,status:500},input,{operation}),false);
  assert.equal(hasRequestNotAppliedProof(error,input,{operation:'timeline.render'}),false);
 }
 assert.equal(hasRequestNotAppliedProof({code:'TIMELINE_VOLUME_ENVELOPE_FUTURE',status:409,details:{mutationOutcome:'not_applied',...input,operation:'timeline.undo'}},input,{operation:'timeline.undo'}),false);
});
test('complete live durable task retains the existing byte budgets and exact typed input',()=>{
 const input=add(),value={id:id(10),projectId:id(1),operation:'timeline.clip.add',input,requestId:input.requestId,digest:'a'.repeat(64),lane:'timeline:mutation',status:'prepared',revision:1,createdAt:'2026-10-15T00:00:00Z',updatedAt:'2026-10-15T00:00:00Z',acknowledged:false,origin:'new'};
 assert.equal(isEditTask(value),true);assert.deepEqual([EDIT_TASK_LIMITS.inputBytes,EDIT_TASK_LIMITS.rowBytes],[8192,16384]);
 assert.equal(isEditTask({...value,input:{...input,volumeEnvelope:{...envelope(),extra:1}}}),false);
 assert.equal(isEditTask({...value,requestId:'changed-request'}),false);
});
test('split ACK preserves envelope presence/null and exact meeting value, not array equality',()=>{
 const input={...base(),clipId:id(4),atFrame:10},saved=timeline();
 saved.clips[0].durationFrames=10;saved.clips[0].volumeEnvelope=({profileId,points:[{frame:0,multiplier:1},{frame:10,multiplier:.625}]} as unknown as (((typeof saved)["clips"])[number])["volumeEnvelope"]);
 const right={...clone(saved.clips[0]),id:id(7),startFrame:10,sourceInFrame:10,volumeEnvelope:{profileId,points:[{frame:0,multiplier:.625},{frame:10,multiplier:.25}]}};saved.clips.push(((right) as unknown as Parameters<typeof saved.clips.push>[0]));
 assert.equal(isTimelineMutationResponse('timeline.clip.split',input,clone(saved)),true);
 for(const value of ([undefined,null,{profileId,points:[{frame:0,multiplier:.6},{frame:10,multiplier:.25}]}] as const)){
  const bad=clone(saved);if(value===undefined)delete bad.clips[1].volumeEnvelope;else bad.clips[1].volumeEnvelope=(value as unknown as (((typeof bad)["clips"])[number])["volumeEnvelope"]);
  assert.equal(isTimelineMutationResponse('timeline.clip.split',input,bad),false);
 }
});
