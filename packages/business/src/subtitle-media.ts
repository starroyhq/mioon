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
 renderGeometry?: {width: number;height: number};
 openOwnedFile?: (file: string)=>Promise<FileHandle>;
 writeOwnedFile?: (file: string,data: string)=>Promise<void>;
}
interface SubtitleRenderEntry {file:string;ink:SubtitleInkBounds;box:NonNullable<ReturnType<typeof positionTimelineSubtitle>>}
interface SubtitlePrepared {
 font: string;cues: SubtitleCueRecord[];textShaping: boolean;layout: TimelineSubtitleLayout;
 entries: Map<string,SubtitleRenderEntry>;
}

const WIDTH=4096,HEIGHT=256,ORIGIN=64,GUARD=16;
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
 if(!Number.isSafeInteger(frameCount)||frameCount<1||frameCount>100||
  !Number.isSafeInteger(width)||width<WIDTH||width>WIDTH+2*ORIGIN||
  !Number.isSafeInteger(height)||height<HEIGHT||height>512)throw invalid();
 const frameBytes=width*height;
 const bounds=Array.from({length:frameCount},()=>({minX:width,minY:height,maxX:-1,maxY:-1}));let offset=0;
 return {consume(chunk: unknown): void{
  if(!Buffer.isBuffer(chunk)||chunk.length>frameCount*frameBytes-offset)throw invalid();
  for(let i=0;i<chunk.length;i++,offset++)if(chunk[i]){
   const frame=Math.floor(offset/frameBytes),pixel=offset%frameBytes,x=pixel%width,y=Math.floor(pixel/width),b=bounds[frame];
   b.minX=Math.min(b.minX,x);b.maxX=Math.max(b.maxX,x);b.minY=Math.min(b.minY,y);b.maxY=Math.max(b.maxY,y);
  }
 },finish(): SubtitleInkBounds[]{
  if(offset!==frameCount*frameBytes)throw invalid();
  return bounds.map(b=>{
   if(b.maxX<0||b.minX<=GUARD||b.maxX>=width-GUARD||b.minY<=GUARD||b.maxY>=height-GUARD)throw invalid();
   return {...b,width:b.maxX-b.minX+1,height:b.maxY-b.minY+1};
  });
 }};
}

export async function prepareTimelineSubtitles(snapshot: unknown,work: string,{signal,beforeEffect,renderGeometry,openOwnedFile,writeOwnedFile}: SubtitlePreparationOptions={}): Promise<SubtitlePrepared|null>{
 checkMediaEffect(beforeEffect,signal);
 if(!validateSubtitleSnapshotProfile(snapshot as SubtitlePreparedSnapshot))return null;
 const {timeline} = snapshot as SubtitlePreparedSnapshot;
 const nativeLayout=projectTimelineSubtitleLayout(timeline,timeline.subtitles);
 if(!nativeLayout)throw fault('INVALID_TIMELINE_SNAPSHOT','The saved subtitle layout is invalid.');
 const frame=renderGeometry??timeline;
 const scaleX=frame.width/timeline.width,scaleY=frame.height/timeline.height;
 const textScale=Math.min(frame.width,frame.height)/Math.min(timeline.width,timeline.height);
 const layout=renderGeometry?{
  fontSize:Math.round(nativeLayout.fontSize*textScale),outline:Math.round(nativeLayout.outline*textScale),
  padding:Math.round(nativeLayout.padding*textScale),lineSpacing:Math.round(nativeLayout.lineSpacing*textScale),
  horizontalMargin:Math.round(nativeLayout.horizontalMargin*scaleX),bottomInset:Math.round(nativeLayout.bottomInset*scaleY),
  maxOuterHeight:Math.round(nativeLayout.maxOuterHeight*textScale),
 }:nativeLayout;
 const {cues}=timeline.subtitles,font=path.join(work,'subtitle-font.otf');
 await verifySubtitleFontResource({signal,destination:font,beforeEffect,openOwnedFile});checkMediaEffect(beforeEffect,signal);
 const {textShaping}=await inspectSubtitleRenderer({signal,beforeEffect});checkMediaEffect(beforeEffect,signal);
 const distinct=[...new Set(cues.map(c=>c.text))],files: string[]=[];
 for(let i=0;i<distinct.length;i++){
  checkMediaEffect(beforeEffect,signal);
  const file=path.join(work,`subtitle-${String(i).padStart(3,'0')}.txt`);
  await (writeOwnedFile?writeOwnedFile(file,distinct[i]):writeFile(file,distinct[i],{encoding:'utf8',flag:'wx',mode:0o600}));checkMediaEffect(beforeEffect,signal);files.push(file);
 }
 const measureWidth=renderGeometry?Math.max(WIDTH,frame.width+2*ORIGIN):WIDTH;
 const measureHeight=renderGeometry?Math.max(HEIGHT,2*Math.ceil((layout.maxOuterHeight+ORIGIN+GUARD)/2)):HEIGHT;
 const scanner=createSubtitleInkScanner(distinct.length,measureWidth,measureHeight);
 const filters=files.map((file,index)=>`${drawText(font,file,textShaping,layout)}:fontcolor=white:bordercolor=white:x=${ORIGIN}:y=${ORIGIN}:enable='eq(n,${index})'`);
 filters.push('alphaextract,format=gray');
 const script=path.join(work,'subtitle-measure.filter');checkMediaEffect(beforeEffect,signal);await (writeOwnedFile?writeOwnedFile(script,filters.join(',')):writeFile(script,filters.join(','),{flag:'wx',mode:0o600}));checkMediaEffect(beforeEffect,signal);
 await runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-filter_threads','1','-f','lavfi','-i',`color=c=black@0:s=${measureWidth}x${measureHeight}:r=30,format=rgba`,
  '-/filter:v',script,'-frames:v',String(distinct.length),'-an','-c:v','rawvideo','-pix_fmt','gray','-threads','1','-f','rawvideo','pipe:1'],
  {signal,beforeEffect,timeout:30000,maxStdoutBytes:distinct.length*measureWidth*measureHeight,maxStderrBytes:64*1024,onStdout:(chunk: Buffer)=>scanner.consume(chunk)});
 checkMediaEffect(beforeEffect,signal);
 const measured=scanner.finish();
 const entries=new Map<string,SubtitleRenderEntry>(distinct.map((text,index)=>{
  const ink=measured[index],box=positionTimelineSubtitle(frame,layout,ink);
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
