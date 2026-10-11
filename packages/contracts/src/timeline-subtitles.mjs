import {z} from 'zod';
import {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256,isTimelineSubtitleCodePoint} from './timeline-subtitle-profile.mjs';
export {TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_SUBTITLE_FONT_SHA256,TIMELINE_SUBTITLE_PROFILE,isTimelineSubtitleCodePoint} from './timeline-subtitle-profile.mjs';

export const TIMELINE_SUBTITLE_OPERATIONS=Object.freeze(['timeline.subtitle.add','timeline.subtitle.update','timeline.subtitle.remove']);
export const TIMELINE_SUBTITLE_LIMITS=Object.freeze({cues:100,lines:2,scalarsPerLine:20,textBytes:161,durationFrames:18000});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(value,required,optional=[])=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const encoder=new TextEncoder();
const issue=(code,message,details={})=>({code,message,details});

// One non-normalizing text rule is shared by RPC syntax, saved records and the
// renderer. The initial profile makes no arbitrary-Unicode shaping promise.
export function getTimelineSubtitleTextIssue(text){
 if(typeof text!=='string'||text.length>81||encoder.encode(text).byteLength>TIMELINE_SUBTITLE_LIMITS.textBytes)
  return issue('SUBTITLE_TEXT_INVALID','字幕文字最多两行，每行最多20个字符，UTF-8不超过161字节');
 const lines=text.split('\n');
 for(const [lineIndex,line] of lines.entries())for(const [columnIndex,scalar] of [...line].entries())if(!isTimelineSubtitleCodePoint(scalar.codePointAt(0))){
  const codePoint=`U+${scalar.codePointAt(0).toString(16).toUpperCase().padStart(4,'0')}`;
  return issue('SUBTITLE_TEXT_INVALID',`第${lineIndex+1}行第${columnIndex+1}个字符（${codePoint}）不受当前字幕字体配置支持`,{line:lineIndex+1,column:columnIndex+1,codePoint});
 }
 if(lines.length<1||lines.length>TIMELINE_SUBTITLE_LIMITS.lines||lines.some(line=>!line.trim()||[...line].length>TIMELINE_SUBTITLE_LIMITS.scalarsPerLine))
  return issue('SUBTITLE_TEXT_INVALID','字幕每行必须有文字，最多两行，每行最多20个字符');
 return null;
}

// durationFrames is media-derived, never extended by subtitles. Intervals use
// the 30fps timeline clock and exclusive ends; adjacency is legal.
export function getTimelineSubtitleIssue(subtitles,durationFrames){
 if(!fields(subtitles,['profileId','cues'])||subtitles.profileId!==TIMELINE_SUBTITLE_PROFILE_ID||!Array.isArray(subtitles.cues))
  return issue('INVALID_SUBTITLES','字幕数据或固定排版配置无效');
 if(subtitles.cues.length>TIMELINE_SUBTITLE_LIMITS.cues)return issue('SUBTITLE_LIMIT','时间线最多支持100条手动字幕',{maxCues:TIMELINE_SUBTITLE_LIMITS.cues});
 const ids=new Set();
 for(const cue of subtitles.cues){
  if(!fields(cue,['id','text','startFrame','durationFrames'])||!uuid(cue.id)||ids.has(cue.id))return issue('INVALID_SUBTITLES','字幕标识或字段无效');
  ids.add(cue.id);
  const textIssue=getTimelineSubtitleTextIssue(cue.text);if(textIssue)return {...textIssue,details:{...textIssue.details,cueId:cue.id}};
  if(!integer(cue.startFrame,0,18000)||!integer(cue.durationFrames,1,18000)||!integer(durationFrames,0,18000)||cue.startFrame+cue.durationFrames>durationFrames)
   return issue('SUBTITLE_BOUNDS','字幕起止帧必须位于已有媒体时长内',{cueId:cue.id,durationFrames});
 }
 const sorted=[...subtitles.cues].sort((a,b)=>a.startFrame-b.startFrame);
 for(let i=1;i<sorted.length;i++)if(sorted[i].startFrame<sorted[i-1].startFrame+sorted[i-1].durationFrames)
  return issue('SUBTITLE_OVERLAP','字幕时间不能重叠，可以首尾相接',{cueIds:[sorted[i-1].id,sorted[i].id]});
 return null;
}
export const isTimelineSubtitles=(value,durationFrames)=>getTimelineSubtitleIssue(value,durationFrames)===null;
export function isTimelineSubtitleSnapshotProfile(snapshot){
 const present=Object.hasOwn(snapshot??{},'subtitleProfile'),required=(snapshot?.timeline?.subtitles?.cues?.length??0)>0;
 return present===required&&(!present||fields(snapshot.subtitleProfile,['profileId','fontSha256'])&&snapshot.subtitleProfile.profileId===TIMELINE_SUBTITLE_PROFILE_ID&&snapshot.subtitleProfile.fontSha256===TIMELINE_SUBTITLE_FONT_SHA256);
}
const base={projectId:z.string().uuid(),expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),requestId:z.string().min(8).max(200)};
const cueFields={text:z.string().superRefine((value,context)=>{const error=getTimelineSubtitleTextIssue(value);if(error)context.addIssue({code:'custom',message:error.message});}),
 startFrame:z.number().int().min(0).max(18000),durationFrames:z.number().int().min(1).max(18000)};
export const timelineSubtitleSchemas=Object.freeze({
 'timeline.subtitle.add':z.object({...base,...cueFields}).strict().refine(value=>value.startFrame+value.durationFrames<=18000,{message:'Subtitle interval exceeds the timeline limit'}),
 'timeline.subtitle.update':z.object({...base,cueId:z.string().uuid(),patch:z.object(Object.fromEntries(Object.entries(cueFields).map(([key,value])=>[key,value.optional()]))).strict().refine(value=>Object.keys(value).length>0&&Object.values(value).every(item=>item!==undefined),{message:'A nonempty subtitle patch is required'})}).strict(),
 'timeline.subtitle.remove':z.object({...base,cueId:z.string().uuid()}).strict(),
});
