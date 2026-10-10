import {randomUUID} from 'node:crypto';
import {AppError,sourceFrameCount,getTimelineFadeIssue} from '@mioon/contracts';

export const TIMELINE_LIMITS=Object.freeze({fps:30,width:720,height:1280,tracks:12,clips:100,durationFrames:18000});
const defaultRect=()=>({x:0,y:0,width:720,height:1280});
const visualTypes=new Set(['image/png','image/jpeg','image/webp','video/mp4','video/webm']);
const audioTypes=new Set(['audio/mpeg','audio/wav','audio/mp4']);
const clone=value=>JSON.parse(JSON.stringify(value));

// The timeline is its own aggregate: revision checks and idempotent responses
// must be committed in the same SQLite transaction as every mutation.
export function createTimelineServices(store,{required,check,hash,now}){
 const {db,get,list,put,tx}=store;
 function find(projectId){
  const row=db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);
  return row?JSON.parse(row.data):null;
 }
 function ensure(projectId){
  required('projects',projectId);
  const existing=find(projectId);
  if(existing)return existing;
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
   const fadeIssue=getTimelineFadeIssue(item,source);
   if(fadeIssue)throw new AppError(fadeIssue.code,fadeIssue.message,400,fadeIssue.details);
   const end=item.startFrame+item.durationFrames;
   if(end>TIMELINE_LIMITS.durationFrames)
    throw new AppError('TIMELINE_LIMIT','时间线总时长不能超过18000帧（10分钟）',400,{maxDurationFrames:TIMELINE_LIMITS.durationFrames});
   if(source.mimeType.startsWith('image/')){
    if(item.sourceInFrame!==0)throw new AppError('SOURCE_BOUNDS','图片的素材入点必须为0',400,{clipId:item.id});
   }else{
    // A fractional final frame cannot supply a complete output frame. The tiny
    // tolerance only absorbs the binary representation of exact 30fps times.
    const sourceFrames=sourceFrameCount(source.duration)??0;
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
 // History owns only editable timeline state. Revisions, IDs/timestamps of the
 // aggregate, media, selected versions, jobs and exports are never restored.
 const snapshot=timeline=>clone({tracks:timeline.tracks,clips:timeline.clips,durationFrames:timeline.durationFrames});
 const cursor=projectId=>db.prepare('SELECT position FROM timeline_history_cursors WHERE projectId=?').get(projectId)?.position??0;
 const setCursor=(projectId,position)=>db.prepare('INSERT INTO timeline_history_cursors(projectId,position) VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET position=excluded.position').run(projectId,position);
 function history(projectId){
  required('projects',projectId);
  // One SQLite statement gives even independent connections a single read
  // snapshot. Metadata reads never initialize a timeline or acquire a write lock.
  const row=db.prepare(`SELECT t.data AS timeline,COALESCE(c.position,0) AS position,
   (SELECT COUNT(*) FROM timeline_history h WHERE h.projectId=p.id) AS length,
   (SELECT json_object('id',h.id,'operation',h.operation,'createdAt',h.createdAt) FROM timeline_history h WHERE h.projectId=p.id AND h.position=c.position) AS undoEntry,
   (SELECT json_object('id',h.id,'operation',h.operation,'createdAt',h.createdAt) FROM timeline_history h WHERE h.projectId=p.id AND h.position=COALESCE(c.position,0)+1) AS redoEntry
   FROM projects p LEFT JOIN timelines t ON t.projectId=p.id LEFT JOIN timeline_history_cursors c ON c.projectId=p.id WHERE p.id=?`).get(projectId);
  const timeline=row.timeline?JSON.parse(row.timeline):null,position=row.position,length=row.length;
  return {projectId,timelineId:timeline?.id??null,revision:timeline?.revision??null,cursor:position,length,canUndo:position>0,canRedo:position<length,
   undoEntry:row.undoEntry?JSON.parse(row.undoEntry):null,redoEntry:row.redoEntry?JSON.parse(row.redoEntry):null};
 }
 function recordEdit(operation,timeline,before){
  const position=cursor(timeline.projectId)+1;
  // Branch replacement shares the edit transaction, so rejected edits cannot
  // erase redo. Exact old request responses remain independently durable.
  db.prepare('DELETE FROM timeline_history WHERE projectId=? AND position>=?').run(timeline.projectId,position);
  db.prepare('INSERT INTO timeline_history(id,projectId,position,operation,createdAt,beforeSnapshot,afterSnapshot) VALUES(?,?,?,?,?,?,?)')
   .run(randomUUID(),timeline.projectId,position,operation,timeline.updatedAt,JSON.stringify(before),JSON.stringify(snapshot(timeline)));
  setCursor(timeline.projectId,position);
 }
 function travel(operation,input,direction){
  return tx(()=>{
   const previous=replay(operation,input);
   if(previous.response)return previous.response;
   required('projects',input.projectId);
   const timeline=find(input.projectId);
   const empty=()=>new AppError(direction<0?'NOTHING_TO_UNDO':'NOTHING_TO_REDO',direction<0?'没有可撤销的时间线编辑':'没有可重做的时间线编辑',409);
   if(!timeline)throw empty();
   check(timeline,input.expectedRevision);
   const position=cursor(input.projectId);
   const entry=db.prepare('SELECT beforeSnapshot,afterSnapshot FROM timeline_history WHERE projectId=? AND position=?').get(input.projectId,position+(direction>0?1:0));
   if(!entry)throw empty();
   Object.assign(timeline,JSON.parse(direction<0?entry.beforeSnapshot:entry.afterSnapshot));
   validate(timeline);
   timeline.revision++;
   timeline.updatedAt=now();
   put('timelines',timeline);
   setCursor(input.projectId,position+direction);
   return saveResponse(input,previous.requestHash,timeline);
  });
 }
 function mutate(operation,input,apply){
  return tx(()=>{
   const previous=replay(operation,input);
   if(previous.response)return previous.response;
   const timeline=ensure(input.projectId);
   check(timeline,input.expectedRevision);
   const before=snapshot(timeline);
   apply(timeline);
   validate(timeline);
   timeline.revision++;
   timeline.updatedAt=now();
   put('timelines',timeline);
   recordEdit(operation,timeline,before);
   return saveResponse(input,previous.requestHash,timeline);
  });
 }
 const handlers={
  'timeline.get':input=>ensure(input.projectId),
  'timeline.history.get':input=>history(input.projectId),
  'timeline.undo':input=>travel('timeline.undo',input,-1),
  'timeline.redo':input=>travel('timeline.redo',input,1),
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
   timeline.clips.push({id:randomUUID(),trackId:input.trackId,assetId:input.assetId,name:input.name||source.name||'Clip',startFrame:input.startFrame,durationFrames:input.durationFrames,sourceInFrame:input.sourceInFrame??0,rect:input.rect||defaultRect(),gain:input.gain??1,
    ...Object.fromEntries(['fadeInFrames','fadeOutFrames'].filter(field=>input[field]!==undefined).map(field=>[field,input[field]]))});
  }),
  'timeline.clip.update':input=>mutate('timeline.clip.update',input,timeline=>{
   Object.assign(clip(timeline,input.clipId),input.patch);
  }),
  'timeline.clip.remove':input=>mutate('timeline.clip.remove',input,timeline=>{
   clip(timeline,input.clipId);
   timeline.clips=timeline.clips.filter(item=>item.id!==input.clipId);
  }),
  'timeline.clip.split':input=>mutate('timeline.clip.split',input,timeline=>{
   const left=clip(timeline,input.clipId),end=left.startFrame+left.durationFrames;
   if(input.atFrame<=left.startFrame||input.atFrame>=end)
    throw new AppError('SPLIT_BOUNDS','分割点必须位于所选片段内部，不能位于起止帧',400,{clipId:left.id,startFrame:left.startFrame,endFrame:end,atFrame:input.atFrame});
   const source=asset(timeline.projectId,left.assetId),leftDuration=input.atFrame-left.startFrame;
   const fadeInFrames=left.fadeInFrames??0,fadeOutFrames=left.fadeOutFrames??0;
   if(leftDuration<fadeInFrames||leftDuration>left.durationFrames-fadeOutFrames)
    throw new AppError('SPLIT_FADE_BOUNDS','分割点不能位于音频淡入或淡出内部；可在淡入结束或淡出开始帧分割',400,{clipId:left.id,atFrame:input.atFrame,minFrame:left.startFrame+fadeInFrames,maxFrame:end-fadeOutFrames});
   // A still has no advancing source clock. Moving media keeps contiguous
   // source ranges; copying the complete clip also preserves frozen references.
   const right={...clone(left),id:randomUUID(),startFrame:input.atFrame,durationFrames:end-input.atFrame,
    sourceInFrame:source.mimeType.startsWith('image/')?0:left.sourceInFrame+leftDuration};
   // Preserve the original envelope at its two outer edges. Do not introduce
   // keys into legacy clips or make an omitted zero explicit at an inner edge.
   if(Object.hasOwn(left,'fadeInFrames'))right.fadeInFrames=0;
   if(Object.hasOwn(left,'fadeOutFrames'))left.fadeOutFrames=0;
   left.durationFrames=leftDuration;
   timeline.clips.splice(timeline.clips.indexOf(left)+1,0,right);
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
    const durationFrames=sourceFrameCount(source.duration);
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
 return {ensure,history,handlers};
}
