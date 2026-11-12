import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {positionTimelineSubtitle,projectTimelineSubtitleLayout,type TimelineSubtitleLayout} from '../../contracts/src/timeline-subtitle-profile.ts';
import {runStreaming,checkMediaEffect} from './media-runtime.ts';
import {verifySubtitleFontResource,validateSubtitleSnapshotProfile} from './subtitle-resources.ts';
import {inspectSubtitleRenderer} from './subtitle-renderer-capability.ts';
import type {FileHandle} from 'node:fs/promises';

interface SubtitleCueRecord {text: string;startFrame: number;durationFrames: number}
interface SubtitlePreparedSnapshot {timeline: {width: number;height: number;subtitles: {profileId: unknown;basisPresetId?: unknown;cues: SubtitleCueRecord[]}}}
interface SubtitleInkBounds {minX: number;minY: number;maxX: number;maxY: number;width: number;height: number}
interface SubtitlePreparationOptions {
 signal?: AbortSignal;beforeEffect?: (()=>void)|undefined;
 openOwnedFile?: (file: string)=>Promise<FileHandle>;
 writeOwnedFile?: (file: string,data: string)=>Promise<void>;
}
interface SubtitleRenderEntry {file:string;ink:SubtitleInkBounds;box:NonNullable<ReturnType<typeof positionTimelineSubtitle>>}
interface SubtitlePrepared {
 font: string;cues: SubtitleCueRecord[];textShaping: boolean;layout: TimelineSubtitleLayout;
 entries: Map<string,SubtitleRenderEntry>;
}

const WIDTH=4096,HEIGHT=256,FRAME_BYTES=WIDTH*HEIGHT,ORIGIN=64,GUARD=16;
const fault=(code: string,message: string): Error=>Object.assign(Error(message),{code});
const invalid: ()=>never=()=>{throw fault('SUBTITLE_INK_INVALID','Subtitle text cannot fit safely in the fixed rendering profile.');};
// Escape option-value syntax first, then filtergraph syntax. No shell layer is
// involved. Only backend-generated paths enter here; literal cue text stays in
// owned UTF-8 files and drawtext expansion is explicitly disabled.
export function subtitleFilterPath(file: unknown): string{
 if(typeof file!=='string'||!path.isAbsolute(file)||/[\r\n\0]/.test(file))throw invalid();
 const option=file.replace(/[\\':]/g,character=>'\\'+character);
 return option.replace(/[\\',;\[\]]/g,character=>'\\'+character);
}
// FFmpeg compiles both this option and its FriBidi pre-reordering behind
// CONFIG_LIBFRIBIDI. Without that option, reordering is already disabled. Keep
// an explicit zero whenever supported, in both measurement and final rendering.
// The immutable profile still rejects RTL and combining sequences.
const drawText=(font: string,text: string,textShaping: boolean,layout: TimelineSubtitleLayout): string=>`drawtext=fontfile=${subtitleFilterPath(font)}:textfile=${subtitleFilterPath(text)}:expansion=none${textShaping?':text_shaping=0':''}:fontsize=${layout.fontSize}:borderw=${layout.outline}:line_spacing=${layout.lineSpacing}`;

// Streaming scan retains only counters/bounds, never full frames. Exact frame
// count and edge guards reject partial, extra or potentially clipped output.
export function createSubtitleInkScanner(frameCount: number,width=WIDTH,height=HEIGHT): {consume(chunk: unknown): void;finish(): SubtitleInkBounds[]}{
 if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>100||width!==WIDTH||height!==HEIGHT)throw invalid();
 const bounds=Array.from({length:frameCount},()=>({minX:width,minY:height,maxX:-1,maxY:-1}));let offset=0;
 return {consume(chunk: unknown): void{
  if(!Buffer.isBuffer(chunk)||chunk.length>frameCount*FRAME_BYTES-offset)throw invalid();
  for(let i=0;i<chunk.length;i++,offset++)if(chunk[i]){
   const frame=Math.floor(offset/FRAME_BYTES),pixel=offset%FRAME_BYTES,x=pixel%width,y=Math.floor(pixel/width),b=bounds[frame];
   b.minX=Math.min(b.minX,x);b.maxX=Math.max(b.maxX,x);b.minY=Math.min(b.minY,y);b.maxY=Math.max(b.maxY,y);
  }
 },finish(): SubtitleInkBounds[]{
  if(offset!==frameCount*FRAME_BYTES)throw invalid();
  return bounds.map(b=>{
   if(b.maxX<0||b.minX<=GUARD||b.maxX>=width-GUARD||b.minY<=GUARD||b.maxY>=height-GUARD)throw invalid();
   return {...b,width:b.maxX-b.minX+1,height:b.maxY-b.minY+1};
  });
 }};
}

export async function prepareTimelineSubtitles(snapshot: unknown,work: string,{signal,beforeEffect,openOwnedFile,writeOwnedFile}: SubtitlePreparationOptions={}): Promise<SubtitlePrepared|null>{
 checkMediaEffect(beforeEffect,signal);
 if(!validateSubtitleSnapshotProfile(snapshot as SubtitlePreparedSnapshot))return null;
 const {timeline} = snapshot as SubtitlePreparedSnapshot;
 const layout=projectTimelineSubtitleLayout(timeline,timeline.subtitles);
 if(!layout)throw fault('INVALID_TIMELINE_SNAPSHOT','The saved subtitle layout is invalid.');
 const {cues}=timeline.subtitles,font=path.join(work,'subtitle-font.otf');
 await verifySubtitleFontResource({signal,destination:font,beforeEffect,openOwnedFile});checkMediaEffect(beforeEffect,signal);
 const {textShaping}=await inspectSubtitleRenderer({signal,beforeEffect});checkMediaEffect(beforeEffect,signal);
 const distinct=[...new Set(cues.map(c=>c.text))],files: string[]=[];
 for(let i=0;i<distinct.length;i++){
  checkMediaEffect(beforeEffect,signal);
  const file=path.join(work,`subtitle-${String(i).padStart(3,'0')}.txt`);
  await (writeOwnedFile?writeOwnedFile(file,distinct[i]):writeFile(file,distinct[i],{encoding:'utf8',flag:'wx',mode:0o600}));checkMediaEffect(beforeEffect,signal);files.push(file);
 }
 const scanner=createSubtitleInkScanner(distinct.length);
 const filters=files.map((file,index)=>`${drawText(font,file,textShaping,layout)}:fontcolor=white:bordercolor=white:x=${ORIGIN}:y=${ORIGIN}:enable='eq(n,${index})'`);
 filters.push('alphaextract,format=gray');
 const script=path.join(work,'subtitle-measure.filter');checkMediaEffect(beforeEffect,signal);await (writeOwnedFile?writeOwnedFile(script,filters.join(',')):writeFile(script,filters.join(','),{flag:'wx',mode:0o600}));checkMediaEffect(beforeEffect,signal);
 await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-f','lavfi','-i',`color=c=black@0:s=${WIDTH}x${HEIGHT}:r=30,format=rgba`,
  '-/filter:v',script,'-frames:v',String(distinct.length),'-an','-c:v','rawvideo','-pix_fmt','gray','-threads','1','-f','rawvideo','pipe:1'],
  {signal,beforeEffect,timeout:30000,maxStdoutBytes:distinct.length*FRAME_BYTES,maxStderrBytes:64*1024,onStdout:(chunk: Buffer)=>scanner.consume(chunk)});
 checkMediaEffect(beforeEffect,signal);
 const measured=scanner.finish();
 const entries=new Map<string,SubtitleRenderEntry>(distinct.map((text,index)=>{
  const ink=measured[index],box=positionTimelineSubtitle(timeline,layout,ink);
  if(!box)throw invalid();
  return [text,{file:files[index],ink,box}];
 }));
 return {font,cues,entries,layout,textShaping};
}

// Captions do not contribute edges or duration. Intersect global cue intervals
// with existing media segments and translate only the enable frame numbers.
export function timelineSubtitleFilters(prepared: SubtitlePrepared|null,begin: number,end: number,input: string): {filters: string[];visual: string}{
 if(!prepared)return {filters:[],visual:input};
 if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<=begin)throw invalid();
 const filters: string[]=[];let visual=input,index=0;
 for(const cue of prepared.cues){
  const start=Math.max(begin,cue.startFrame)-begin,stop=Math.min(end,cue.startFrame+cue.durationFrames)-begin;
  if(stop<=start)continue;
  const {file,ink,box}=prepared.entries.get(cue.text)!,{padding}=prepared.layout;
  const x=box.left+padding-(ink.minX-ORIGIN),y=box.top+padding-(ink.minY-ORIGIN),label=`caption${index++}`;
  if(![x,y,start,stop].every(Number.isSafeInteger))throw invalid();
  const enable=`gte(n,${start})*lt(n,${stop})`;
  filters.push(`[${visual}]drawbox=x=${box.left}:y=${box.top}:w=${box.width}:h=${box.height}:color=black@0.6:t=fill:enable='${enable}',${drawText(prepared.font,file,prepared.textShaping,prepared.layout)}:fontcolor=white:bordercolor=black:x=${x}:y=${y}:enable='${enable}'[${label}]`);
  visual=label;
 }
 return {filters,visual};
}
