import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {schemas,TIMELINE_SUBTITLE_OPERATIONS,TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256,TIMELINE_SUBTITLE_LIMITS,
 getTimelineSubtitleTextIssue,getTimelineSubtitleIssue,isTimelineSubtitleSnapshotProfile,isTimelineRecord,isTimelineMutationResponse,isTimelineRenderRecord,
 DURABLE_EDIT_OPERATIONS,editTaskLane,operationEffect,hasRequestNotAppliedProof,TIMELINE_RESPONSE_BYTES,TIMELINE_REPLACEMENT_RESPONSE_BYTES} from '@mioon/contracts';
import {INSPECTION_ROW_LIMITS} from '../packages/business/src/inspection-query.mjs';
import {INSPECTION_LIMITS} from '../packages/business/src/inspection.mjs';
import {freezeTimelineSnapshot} from '../packages/business/src/timeline-inputs.mjs';
const clone=value=>structuredClone(value),at='2026-10-11T12:00:00.000Z';
const base=()=>({projectId:randomUUID(),expectedRevision:1,requestId:randomUUID()});
const cue=(patch={})=>({id:randomUUID(),text:'手动字幕 Hello 100%',startFrame:0,durationFrames:30,...patch});
const subtitles=(cues=[cue()])=>({profileId:TIMELINE_SUBTITLE_PROFILE_ID,cues});
function timeline(){const projectId=randomUUID(),trackId=randomUUID(),assetId=randomUUID();return {id:randomUUID(),projectId,revision:2,fps:30,width:720,height:1280,
 tracks:[{id:trackId,name:'Video',kind:'video',orderIndex:0,hidden:false,muted:false}],
 clips:[{id:randomUUID(),trackId,assetId,name:'Clip',startFrame:0,durationFrames:300,sourceInFrame:0,rect:{x:0,y:0,width:720,height:1280},gain:1}],durationFrames:300,createdAt:at,updatedAt:at};}

test('subtitle schemas accept exactly three keyed manual operations and preserve the historical16 prefix',()=>{
 assert.deepEqual(TIMELINE_SUBTITLE_OPERATIONS,['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove']);
 assert.deepEqual(DURABLE_EDIT_OPERATIONS.filter(operation=>operation!=='timeline.clip.rippleRemove').slice(0,16),['timeline.track.add','timeline.track.update','timeline.clip.add','timeline.clip.update','timeline.clip.replaceSource','timeline.clip.remove','timeline.clip.split','timeline.seed','timeline.undo','timeline.redo','reference.attach','reference.detach','subject.create','subject.version.add','subject.binding.set','timeline.format.set']);
 assert.deepEqual(DURABLE_EDIT_OPERATIONS.slice(17,20),TIMELINE_SUBTITLE_OPERATIONS);
 assert.equal(DURABLE_EDIT_OPERATIONS.filter(operation=>operation==='timeline.clip.rippleRemove').length,1);
 assert.deepEqual(DURABLE_EDIT_OPERATIONS.slice(20),['timeline.loudness.apply']);
 for(const operation of TIMELINE_SUBTITLE_OPERATIONS){assert.equal(editTaskLane(operation),'timeline:mutation');const effects=operationEffect(operation);assert.equal(effects.idempotent,true);for(const flag of ['externalIO','fileWrite','localProcess','paidGeneration'])assert.equal(effects[flag],false);}
 const add={...base(),text:'第一行\nSecond line',startFrame:1,durationFrames:29};assert.equal(schemas['timeline.subtitle.add'].safeParse(add).success,true);
 for(const patch of [{id:randomUUID()},{profileId:TIMELINE_SUBTITLE_PROFILE_ID},{fontFile:'anything'},{expectedRevision:0},{expectedRevision:Number.MAX_SAFE_INTEGER+1},{startFrame:.1},{durationFrames:0},{startFrame:18000},{requestId:'short'},{text:undefined}])assert.equal(schemas['timeline.subtitle.add'].safeParse({...add,...patch}).success,false,JSON.stringify(patch));
 const update={...base(),cueId:randomUUID(),patch:{text:'更新'}};assert.equal(schemas['timeline.subtitle.update'].safeParse(update).success,true);
 for(const patch of [{},{text:undefined},{id:randomUUID()},{profileId:TIMELINE_SUBTITLE_PROFILE_ID},{startFrame:-1},{durationFrames:1.2}])assert.equal(schemas['timeline.subtitle.update'].safeParse({...update,patch}).success,false);
 const remove={...base(),cueId:randomUUID()};assert.equal(schemas['timeline.subtitle.remove'].safeParse(remove).success,true);assert.equal(schemas['timeline.subtitle.remove'].safeParse({...remove,text:'extra'}).success,false);
});

test('one shared text validator keeps manual line breaks and rejects unsupported Unicode with scalar positions',()=>{
 for(const text of [' '.repeat(1)+'Hello!','中'.repeat(20)+'\n'+'文'.repeat(20),'100% {literal} \\','\"quoted\" & \'single\'','，。！？；：、（）【】《》〈〉“”‘’—','…·￥％～',String.fromCodePoint(0x9fef)])assert.equal(getTimelineSubtitleTextIssue(text),null,text);
 for(const text of ['', ' ', '\n', 'A\n ', 'A\nB\nC','中'.repeat(21),'A'.repeat(21),'A\rB','A\tB','A\0B','A\u007fB','A\u202eB','e\u0301','✈','a\ufe0f','\ud800','\udfff','🦋','\u9ff0'])assert.equal(getTimelineSubtitleTextIssue(text)?.code,'SUBTITLE_TEXT_INVALID',JSON.stringify(text));
 const bad=getTimelineSubtitleTextIssue('允许\nA🦋');assert.deepEqual(bad.details,{line:2,column:2,codePoint:'U+1F98B'});assert.ok(!bad.message.includes('🦋'));
 for(const [text,codePoint] of [['\t','U+0009'],['\u00a0','U+00A0']])assert.deepEqual(getTimelineSubtitleTextIssue(text).details,{line:1,column:1,codePoint});
 assert.equal(TIMELINE_SUBTITLE_LIMITS.textBytes,161);
});

test('subtitle intervals are strict nonoverlapping exclusive-end ranges within media duration',()=>{
 const first=cue(),next=cue({startFrame:30});assert.equal(getTimelineSubtitleIssue(subtitles([next,first]),60),null);
 for(const [value,duration,code] of [[subtitles([first,cue({startFrame:29})]),60,'SUBTITLE_OVERLAP'],[subtitles([first]),29,'SUBTITLE_BOUNDS'],[subtitles([cue({durationFrames:0})]),30,'SUBTITLE_BOUNDS'],[subtitles([first,{...first,startFrame:30}]),60,'INVALID_SUBTITLES'],[{profileId:'custom',cues:[]},0,'INVALID_SUBTITLES'],[{...subtitles(),font:'override'},30,'INVALID_SUBTITLES'],[subtitles([cue({extra:true})]),30,'INVALID_SUBTITLES'],[subtitles(Array.from({length:101},(_,startFrame)=>cue({startFrame,durationFrames:1}))),101,'SUBTITLE_LIMIT']])assert.equal(getTimelineSubtitleIssue(value,duration)?.code,code);
 assert.equal(getTimelineSubtitleIssue(subtitles([]),0),null);
});

test('complete saved acknowledgements match exact subtitle operation intent and reject partial responses',()=>{
 const value=timeline(),added=cue();value.subtitles=subtitles([added]);const add={projectId:value.projectId,expectedRevision:1,requestId:randomUUID(),text:added.text,startFrame:0,durationFrames:30};
 assert.equal(isTimelineRecord(value),true);assert.equal(isTimelineMutationResponse('timeline.subtitle.add',add,value),true);
 assert.equal(isTimelineMutationResponse('timeline.subtitle.add',{...add,text:'different'},value),false);
 const update={projectId:value.projectId,expectedRevision:1,requestId:randomUUID(),cueId:added.id,patch:{text:added.text,startFrame:0}};
 assert.equal(isTimelineMutationResponse('timeline.subtitle.update',update,value),true);assert.equal(isTimelineMutationResponse('timeline.subtitle.update',{...update,cueId:randomUUID()},value),false);
 const remove={projectId:value.projectId,expectedRevision:1,requestId:randomUUID(),cueId:randomUUID()};assert.equal(isTimelineMutationResponse('timeline.subtitle.remove',remove,value),true);
 assert.equal(isTimelineMutationResponse('timeline.subtitle.remove',{...remove,cueId:added.id},value),false);
 for(const patch of [{revision:1},{projectId:randomUUID()},{subtitles:{...value.subtitles,extra:true}},{durationFrames:301}])assert.equal(isTimelineMutationResponse('timeline.subtitle.add',add,{...value,...patch}),false);
 assert.equal(isTimelineMutationResponse('timeline.subtitle.add',add,value.subtitles),false);
});

test('new proof requires every exact identity field and never treats missing cue or stale revision as an unscoped signal',()=>{
 const input={...base(),cueId:randomUUID()},operation='timeline.subtitle.remove';
 for(const code of ['REVISION_CONFLICT','SUBTITLE_NOT_FOUND','SUBTITLE_BOUNDS']){const error={code,status:409,details:{mutationOutcome:'not_applied',operation,projectId:input.projectId,requestId:input.requestId}};assert.equal(hasRequestNotAppliedProof(error,input,{operation}),true);for(const key of ['operation','projectId','requestId']){const bad=clone(error);delete bad.details[key];assert.equal(hasRequestNotAppliedProof(bad,input,{operation}),false);}}
});

test('snapshot profile and exact font hash are required only for nonempty cues; old shape stays byte-identical',()=>{
 const value=timeline(),asset={id:value.clips[0].assetId,sha256:'a'.repeat(64),mimeType:'image/png',width:720,height:1280,relativePath:'media/input.png'};
 const sources=new Map([[asset.id,asset]]),old=freezeTimelineSnapshot(value,sources);
 assert.equal(Object.hasOwn(old,'subtitleProfile'),false);assert.equal(isTimelineSubtitleSnapshotProfile(old),true);
 const legacyBytes=JSON.stringify(old);value.subtitles=subtitles();const frozen=freezeTimelineSnapshot(value,sources);
 assert.deepEqual(frozen.subtitleProfile,{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256});assert.equal(isTimelineSubtitleSnapshotProfile(frozen),true);
 for(const profile of [undefined,null,{profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:'a'.repeat(64)},{...frozen.subtitleProfile,extra:true}]){const bad=clone(frozen);if(profile===undefined)delete bad.subtitleProfile;else bad.subtitleProfile=profile;assert.equal(isTimelineSubtitleSnapshotProfile(bad),false);}
 assert.equal(JSON.stringify(old),legacyBytes);assert.equal(isTimelineSubtitleSnapshotProfile({...old,subtitleProfile:frozen.subtitleProfile}),false);
 value.subtitles=subtitles([]);assert.equal(Object.hasOwn(freezeTimelineSnapshot(value,sources),'subtitleProfile'),false);
 const request={projectId:value.projectId,expectedRevision:value.revision,requestId:randomUUID(),purpose:'preview'};
 const record={id:randomUUID(),...request,mode:'timeline',timelineRevision:value.revision,snapshot:frozen,status:'queued',assetId:null,url:null,error:null,createdAt:at,updatedAt:at};delete record.expectedRevision;
 assert.equal(isTimelineRenderRecord(record,request),true);assert.equal(isTimelineRenderRecord({...record,snapshot:{...frozen,subtitleProfile:{...frozen.subtitleProfile,fontSha256:'b'.repeat(64)}}},request),false);
});

test('maximal escaped legitimate aggregate fits the unified256KiB budget while model and render budgets remain independent',()=>{
 const value=timeline(),assetId=value.clips[0].assetId;value.tracks=Array.from({length:12},(_,orderIndex)=>({id:randomUUID(),name:'\0'.repeat(150),kind:'video',orderIndex,hidden:false,muted:false}));
 value.clips=Array.from({length:100},(_,index)=>({id:randomUUID(),trackId:value.tracks[index%12].id,assetId,name:'\0'.repeat(200),startFrame:index*180,durationFrames:180,sourceInFrame:Number.MAX_SAFE_INTEGER-18000,rect:{x:0,y:0,width:720,height:1280},gain:2,fadeInFrames:90,fadeOutFrames:90,versionId:randomUUID(),shotId:randomUUID(),jobId:randomUUID()}));
 value.durationFrames=18000;value.subtitles=subtitles(Array.from({length:100},(_,index)=>cue({text:'中'.repeat(20)+'\n'+'文'.repeat(20),startFrame:index*180,durationFrames:180})));
 const bytes=Buffer.byteLength(JSON.stringify(value));assert.ok(bytes>128*1024);assert.ok(bytes<TIMELINE_RESPONSE_BYTES);assert.equal(isTimelineRecord(value),true);
 assert.equal(TIMELINE_RESPONSE_BYTES,256*1024);assert.equal(TIMELINE_REPLACEMENT_RESPONSE_BYTES,TIMELINE_RESPONSE_BYTES);assert.equal(INSPECTION_ROW_LIMITS.timelines,TIMELINE_RESPONSE_BYTES);
 assert.equal(INSPECTION_LIMITS.maxResultBytes,128*1024);assert.equal(INSPECTION_LIMITS.maxTotalBytes,512*1024);
 const replaced=clone(value);delete replaced.clips[0].jobId;const input={projectId:value.projectId,expectedRevision:1,requestId:randomUUID(),clipId:replaced.clips[0].id,assetId,versionId:replaced.clips[0].versionId};
 assert.equal(isTimelineMutationResponse('timeline.clip.replaceSource',input,replaced),true);
});
