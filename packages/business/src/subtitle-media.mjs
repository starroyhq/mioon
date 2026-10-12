import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {TIMELINE_SUBTITLE_PROFILE} from '@mioon/contracts';
import {runStreaming,checkMediaEffect} from './media-runtime.mjs';
import {verifySubtitleFontResource,validateSubtitleSnapshotProfile} from './subtitle-resources.mjs';

const P=TIMELINE_SUBTITLE_PROFILE,WIDTH=4096,HEIGHT=256,FRAME_BYTES=WIDTH*HEIGHT,ORIGIN=64,GUARD=16;
const fault=(code,message)=>Object.assign(Error(message),{code});
const invalid=()=>fault('SUBTITLE_INK_INVALID','Subtitle text cannot fit safely in the fixed rendering profile.');
// Escape option-value syntax first, then filtergraph syntax. No shell layer is
// involved. Only backend-generated paths enter here; literal cue text stays in
// owned UTF-8 files and drawtext expansion is explicitly disabled.
export function subtitleFilterPath(file){
 if(typeof file!=='string'||!path.isAbsolute(file)||/[\r\n\0]/.test(file))throw invalid();
 const option=file.replace(/[\\':]/g,character=>'\\'+character);
 return option.replace(/[\\',;\[\]]/g,character=>'\\'+character);
}
const drawText=(font,text)=>`drawtext=fontfile=${subtitleFilterPath(font)}:textfile=${subtitleFilterPath(text)}:expansion=none:text_shaping=0:fontsize=${P.fontSize}:borderw=${P.outline}:line_spacing=${P.lineSpacing}`;

// Streaming scan retains only counters/bounds, never full frames. Exact frame
// count and edge guards reject partial, extra or potentially clipped output.
export function createSubtitleInkScanner(frameCount,width=WIDTH,height=HEIGHT){
 if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>100||width!==WIDTH||height!==HEIGHT)throw invalid();
 const bounds=Array.from({length:frameCount},()=>({minX:width,minY:height,maxX:-1,maxY:-1}));let offset=0;
 return {consume(chunk){
  if(!Buffer.isBuffer(chunk)||chunk.length>frameCount*FRAME_BYTES-offset)throw invalid();
  for(let i=0;i<chunk.length;i++,offset++)if(chunk[i]){
   const frame=Math.floor(offset/FRAME_BYTES),pixel=offset%FRAME_BYTES,x=pixel%width,y=Math.floor(pixel/width),b=bounds[frame];
   b.minX=Math.min(b.minX,x);b.maxX=Math.max(b.maxX,x);b.minY=Math.min(b.minY,y);b.maxY=Math.max(b.maxY,y);
  }
 },finish(){
  if(offset!==frameCount*FRAME_BYTES)throw invalid();
  return bounds.map(b=>{
   if(b.maxX<0||b.minX<=GUARD||b.maxX>=width-GUARD||b.minY<=GUARD||b.maxY>=height-GUARD)throw invalid();
   return {...b,width:b.maxX-b.minX+1,height:b.maxY-b.minY+1};
  });
 }};
}

export async function prepareTimelineSubtitles(snapshot,work,{signal,beforeEffect,openOwnedFile,writeOwnedFile}={}){
 checkMediaEffect(beforeEffect,signal);
 if(!validateSubtitleSnapshotProfile(snapshot))return null;
 const cues=snapshot.timeline.subtitles.cues,font=path.join(work,'subtitle-font.otf');
 await verifySubtitleFontResource({signal,destination:font,beforeEffect,openOwnedFile});checkMediaEffect(beforeEffect,signal);
 const distinct=[...new Set(cues.map(c=>c.text))],files=[];
 for(let i=0;i<distinct.length;i++){
  checkMediaEffect(beforeEffect,signal);
  const file=path.join(work,`subtitle-${String(i).padStart(3,'0')}.txt`);
  await (writeOwnedFile?writeOwnedFile(file,distinct[i]):writeFile(file,distinct[i],{encoding:'utf8',flag:'wx',mode:0o600}));checkMediaEffect(beforeEffect,signal);files.push(file);
 }
 const scanner=createSubtitleInkScanner(distinct.length);
 const filters=files.map((file,index)=>`${drawText(font,file)}:fontcolor=white:bordercolor=white:x=${ORIGIN}:y=${ORIGIN}:enable='eq(n,${index})'`);
 filters.push('alphaextract,format=gray');
 const script=path.join(work,'subtitle-measure.filter');checkMediaEffect(beforeEffect,signal);await (writeOwnedFile?writeOwnedFile(script,filters.join(',')):writeFile(script,filters.join(','),{flag:'wx',mode:0o600}));checkMediaEffect(beforeEffect,signal);
 await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-f','lavfi','-i',`color=c=black@0:s=${WIDTH}x${HEIGHT}:r=30,format=rgba`,
  '-filter_script:v',script,'-frames:v',String(distinct.length),'-an','-c:v','rawvideo','-pix_fmt','gray','-threads','1','-f','rawvideo','pipe:1'],
  {signal,beforeEffect,timeout:30000,maxStdoutBytes:distinct.length*FRAME_BYTES,maxStderrBytes:64*1024,onStdout:chunk=>scanner.consume(chunk)});
 checkMediaEffect(beforeEffect,signal);
 const measured=scanner.finish();
 const entries=new Map(distinct.map((text,index)=>{
  const ink=measured[index];
  if(ink.width>snapshot.timeline.width-2*(P.outerMargin+P.padding)||ink.height+2*P.padding>P.maxOuterHeight)throw invalid();
  return [text,{file:files[index],ink}];
 }));
 return {font,cues,entries,width:snapshot.timeline.width,height:snapshot.timeline.height};
}

// Captions do not contribute edges or duration. Intersect global cue intervals
// with existing media segments and translate only the enable frame numbers.
export function timelineSubtitleFilters(prepared,begin,end,input){
 if(!prepared)return {filters:[],visual:input};
 if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin||!Number.isSafeInteger(prepared.width)||!Number.isSafeInteger(prepared.height))throw invalid();
 const filters=[];let visual=input,index=0;
 for(const cue of prepared.cues){
  const start=Math.max(begin,cue.startFrame)-begin,stop=Math.min(end,cue.startFrame+cue.durationFrames)-begin;
  if(stop<=start)continue;
  const {file,ink}=prepared.entries.get(cue.text),outerWidth=ink.width+2*P.padding,outerHeight=ink.height+2*P.padding;
  const left=Math.floor((prepared.width-ink.width)/2),top=prepared.height-P.outerMargin-P.padding-ink.height;
  const x=left-(ink.minX-ORIGIN),y=top-(ink.minY-ORIGIN),label=`caption${index++}`;
  if([x,y,left,top,outerWidth,outerHeight,start,stop].some(n=>!Number.isSafeInteger(n)))throw invalid();
  const enable=`gte(n,${start})*lt(n,${stop})`;
  filters.push(`[${visual}]drawbox=x=${left-P.padding}:y=${top-P.padding}:w=${outerWidth}:h=${outerHeight}:color=black@0.6:t=fill:enable='${enable}',${drawText(prepared.font,file)}:fontcolor=white:bordercolor=black:x=${x}:y=${y}:enable='${enable}'[${label}]`);
  visual=label;
 }
 return {filters,visual};
}
