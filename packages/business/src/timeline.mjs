import {randomUUID} from 'node:crypto';
import {AppError} from '@video-workbench/contracts';

export const TIMELINE_LIMITS=Object.freeze({fps:30,width:720,height:1280,tracks:12,clips:100,durationFrames:18000});
const defaultRect=()=>({x:0,y:0,width:720,height:1280});
const visualTypes=new Set(['image/png','image/jpeg','image/webp','video/mp4','video/webm']);
const audioTypes=new Set(['audio/mpeg','audio/wav','audio/mp4']);
const clone=value=>JSON.parse(JSON.stringify(value));

// The timeline is its own aggregate: revision checks and idempotent responses
// must be committed in the same SQLite transaction as every mutation.
export function createTimelineServices(store,{required,check,hash,now}){
 const {db,get,list,put,tx}=store;
 function ensure(projectId){
  required('projects',projectId);
  const row=db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);
  if(row)return JSON.parse(row.data);
  const createdAt=now();
  return put('timelines',{
   id:randomUUID(),projectId,revision:1,fps:30,width:720,height:1280,
   tracks:[['video','Video 1'],['video','Video 2'],['audio','Audio 1']].map(([kind,name],orderIndex)=>({id:randomUUID(),name,kind,orderIndex,hidden:false,muted:false})),
   clips:[],durationFrames:0,createdAt,updatedAt:createdAt
  });
 }
 function track(timeline,id){
  const result=timeline.tracks.find(item=>item.id===id);
  if(!result)throw new AppError('TRACK_NOT_FOUND','轨道不属于此时间线',404,{trackId:id});
  return result;
 }
 function clip(timeline,id){
  const result=timeline.clips.find(item=>item.id===id);
  if(!result)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404,{clipId:id});
  return result;
 }
 function asset(projectId,id){
  const result=required('assets',id);
  if(result.projectId!==projectId)throw new AppError('CROSS_PROJECT_REFERENCE','素材不属于此项目');
  return result;
 }
 function validate(timeline){
  if(timeline.tracks.length>TIMELINE_LIMITS.tracks||timeline.clips.length>TIMELINE_LIMITS.clips)
   throw new AppError('TIMELINE_LIMIT','时间线最多支持12条轨道和100个片段',400,TIMELINE_LIMITS);
  let duration=0;
  for(const item of timeline.clips){
   const lane=track(timeline,item.trackId),source=asset(timeline.projectId,item.assetId);
   if(!(lane.kind==='audio'?audioTypes:visualTypes).has(source.mimeType))
    throw new AppError('INVALID_CLIP_TYPE','视频轨道只接收图片/视频，音频轨道只接收音频',400,{clipId:item.id,trackId:lane.id,assetId:source.id});
   const end=item.startFrame+item.durationFrames;
   if(end>TIMELINE_LIMITS.durationFrames)
    throw new AppError('TIMELINE_LIMIT','时间线总时长不能超过18000帧（10分钟）',400,{maxDurationFrames:TIMELINE_LIMITS.durationFrames});
   if(source.mimeType.startsWith('image/')){
    if(item.sourceInFrame!==0)throw new AppError('SOURCE_BOUNDS','图片的素材入点必须为0',400,{clipId:item.id});
   }else{
    // A fractional final frame cannot supply a complete output frame. The tiny
    // tolerance only absorbs the binary representation of exact 30fps times.
    const sourceFrames=Number.isFinite(source.duration)?Math.floor(source.duration*30+1e-6):0;
    if(sourceFrames<1||item.sourceInFrame+item.durationFrames>sourceFrames)
     throw new AppError('SOURCE_BOUNDS','素材入点和片段时长超出素材范围',400,{clipId:item.id,assetId:source.id,availableFrames:sourceFrames});
   }
   duration=Math.max(duration,end);
  }
  for(const lane of timeline.tracks){
   const clips=timeline.clips.filter(item=>item.trackId===lane.id).sort((a,b)=>a.startFrame-b.startFrame);
   for(let index=1;index<clips.length;index++){
    const previous=clips[index-1],current=clips[index];
    if(current.startFrame<previous.startFrame+previous.durationFrames)
     throw new AppError('CLIP_OVERLAP','同一轨道的片段不能重叠，可以首尾相接',409,{trackId:lane.id,clipIds:[previous.id,current.id]});
   }
  }
  timeline.durationFrames=duration;
  return timeline;
 }
 function replay(operation,input){
  const requestHash=hash({operation,input});
  const previous=db.prepare('SELECT requestHash,response FROM timeline_requests WHERE requestId=?').get(input.requestId);
  if(previous&&previous.requestHash!==requestHash)
   throw new AppError('IDEMPOTENCY_CONFLICT','同一时间线请求 ID 已用于不同内容',409,{requestId:input.requestId});
  return {requestHash,response:previous?JSON.parse(previous.response):null};
 }
 function saveResponse(input,requestHash,response){
  // Do not reconstruct a response from the current aggregate on retries. An
  // old successful request must return precisely its original response.
  db.prepare('INSERT INTO timeline_requests(requestId,requestHash,response) VALUES(?,?,?)').run(input.requestId,requestHash,JSON.stringify(response));
  return response;
 }
 function mutate(operation,input,apply){
  return tx(()=>{
   const previous=replay(operation,input);
   if(previous.response)return previous.response;
   const timeline=ensure(input.projectId);
   check(timeline,input.expectedRevision);
   apply(timeline);
   validate(timeline);
   timeline.revision++;
   timeline.updatedAt=now();
   put('timelines',timeline);
   return saveResponse(input,previous.requestHash,timeline);
  });
 }
 const handlers={
  'timeline.get':input=>ensure(input.projectId),
  'timeline.track.add':input=>mutate('timeline.track.add',input,timeline=>{
   const number=timeline.tracks.filter(item=>item.kind===input.kind).length+1;
   timeline.tracks.push({id:randomUUID(),name:input.name||`${input.kind==='video'?'Video':'Audio'} ${number}`,kind:input.kind,orderIndex:Math.max(-1,...timeline.tracks.map(item=>item.orderIndex))+1,hidden:false,muted:false});
  }),
  'timeline.track.update':input=>mutate('timeline.track.update',input,timeline=>{
   const lane=track(timeline,input.trackId);
   if(lane.kind==='audio'&&input.patch.hidden!==undefined)
    throw new AppError('AUDIO_HIDDEN_UNSUPPORTED','音频轨道不支持隐藏画面，请使用静音');
   Object.assign(lane,input.patch);
  }),
  'timeline.clip.add':input=>mutate('timeline.clip.add',input,timeline=>{
   const source=asset(timeline.projectId,input.assetId);
   timeline.clips.push({id:randomUUID(),trackId:input.trackId,assetId:input.assetId,name:input.name||source.name||'Clip',startFrame:input.startFrame,durationFrames:input.durationFrames,sourceInFrame:input.sourceInFrame??0,rect:input.rect||defaultRect(),gain:input.gain??1});
  }),
  'timeline.clip.update':input=>mutate('timeline.clip.update',input,timeline=>{
   Object.assign(clip(timeline,input.clipId),input.patch);
  }),
  'timeline.clip.remove':input=>mutate('timeline.clip.remove',input,timeline=>{
   clip(timeline,input.clipId);
   timeline.clips=timeline.clips.filter(item=>item.id!==input.clipId);
  }),
  'timeline.seed':input=>mutate('timeline.seed',input,timeline=>{
   if(timeline.clips.length)throw new AppError('TIMELINE_NOT_EMPTY','只有空时间线可以从镜头顺序导入',409);
   const shots=list('shots',input.projectId).sort((a,b)=>a.orderIndex-b.orderIndex);
   if(!shots.length||shots.some(item=>!item.selectedVersionId))throw new AppError('MISSING_SELECTION','请先为每个镜头选择已生成的视频版本');
   const lane=timeline.tracks.filter(item=>item.kind==='video').sort((a,b)=>a.orderIndex-b.orderIndex)[0];
   if(!lane)throw new AppError('TRACK_NOT_FOUND','时间线没有视频轨道',404);
   let startFrame=0;
   for(const shot of shots){
    const version=required('versions',shot.selectedVersionId);
    if(version.projectId!==timeline.projectId||version.shotId!==shot.id)throw new AppError('INVALID_VERSION','版本不属于此镜头');
    const source=asset(timeline.projectId,version.assetId);
    if(source.sha256!==version.sha256)throw new AppError('ASSET_HASH_MISMATCH','镜头版本与素材哈希不一致',409);
    const durationFrames=Math.floor(source.duration*30+1e-6);
    if(!Number.isSafeInteger(durationFrames)||durationFrames<1)throw new AppError('SOURCE_BOUNDS','所选版本没有有效时长');
    timeline.clips.push({id:randomUUID(),trackId:lane.id,assetId:source.id,name:shot.title,startFrame,durationFrames,sourceInFrame:0,rect:defaultRect(),gain:1});
    startFrame+=durationFrames;
   }
  }),
  'timeline.render':input=>tx(()=>{
   const previous=replay('timeline.render',input);
   if(previous.response)return previous.response;
   const timeline=ensure(input.projectId);
   check(timeline,input.expectedRevision);
   validate(timeline);
   if(!timeline.clips.length)throw new AppError('EMPTY_TIMELINE','请先向时间线添加片段');
   const assets=[...new Set(timeline.clips.map(item=>item.assetId))].map(id=>{
    const source=asset(input.projectId,id);
    return {id:source.id,sha256:source.sha256,mimeType:source.mimeType,duration:source.duration,width:source.width,height:source.height,hasAudio:typeof source.hasAudio==='boolean'?source.hasAudio:null,relativePath:source.relativePath};
   });
   const createdAt=now();
   const result={id:randomUUID(),projectId:input.projectId,requestId:input.requestId,mode:'timeline',purpose:input.purpose,timelineRevision:timeline.revision,snapshot:clone({timeline,assets}),status:'queued',assetId:null,url:null,error:null,createdAt,updatedAt:createdAt};
   put('exports',result);
   return saveResponse(input,previous.requestHash,result);
  })
 };
 return {ensure,handlers};
}
