import {clipTransitionPredecessor,clipTransitionSides,savedClipTransition} from '../../contracts/src/timeline-clip-transition.ts';
import {encoderResidentBytesForOutput} from './media-encoder-pool.ts';
import {clipRenderPeakRaster,clipRenderPlacement} from './timeline-transform-filter.ts';
import type {TimelineRecord} from './timeline-inputs.ts';

interface Raster {readonly width: number;readonly height: number}
interface PictureRange {startFrame: number;endFrame: number}
type Timeline4kRasterInput=Pick<TimelineRecord,'width'|'height'|'fps'|'clips'|'tracks'>;

// Keep the same addressable-frame bound as FFmpeg's format-independent
// av_image_check_size(), including its rows and stride padding.
const addressable=({width,height}: Raster): boolean=>(8*width+1024)*(height+128)<0x7fffffff;
// Allow room for the prepared layer, filter queue, transformed layer and
// composited copy. Each of those may have the peak raster size.
const LAYER_BYTES_PER_PIXEL=4*4;

/** Peak encoder reservation across the selected picture segments. The decoder
 * and lookahead allowance depends on the delivery raster. Layer storage adds
 * the derived size of simultaneously visible placements, including cut handles.
 */
export function timeline4kRasterBudget(timeline: Timeline4kRasterInput,output: Raster,
 range?: PictureRange): {residentBytes: number;unsupportedRaster?: Raster}{
 const visibleTracks=new Set(timeline.tracks.filter(track=>track.kind==='video'&&!track.hidden).map(track=>track.id));
 const clips=timeline.clips.filter(clip=>visibleTracks.has(clip.trackId));
 const intervals=new Map(clips.map(clip=>[clip.id,{startFrame:clip.startFrame,endFrame:clip.startFrame+clip.durationFrames}]));
 const edges: {frame: number;bytes: number}[]=[];
 const add=(interval: PictureRange,bytes: number): void=>{
  const start=Math.max(interval.startFrame,range?.startFrame??0),end=Math.min(interval.endFrame,range?.endFrame??Infinity);
  if(end>start)edges.push({frame:start,bytes},{frame:end,bytes:-bytes});
 };
 for(const clip of clips){
  const transition=savedClipTransition(clip);
  if(!transition)continue;
  const outgoing=clipTransitionPredecessor(clips,clip);
  if(!outgoing)continue;
  const {before,after}=clipTransitionSides(transition.durationFrames);
  const startFrame=clip.startFrame-before,endFrame=clip.startFrame+after;
  intervals.get(clip.id)!.startFrame=startFrame;
  intervals.get(outgoing.id)!.endFrame=endFrame;
  add({startFrame,endFrame},output.width*output.height*LAYER_BYTES_PER_PIXEL);
 }
 const residentBytes=encoderResidentBytesForOutput(output.width,output.height);
 for(const clip of clips){
  const interval=intervals.get(clip.id)!;
  if(range&&(interval.endFrame<=range.startFrame||interval.startFrame>=range.endFrame))continue;
  const placement=clipRenderPlacement(clip,timeline,Infinity,output);
  const rasters=[clipRenderPeakRaster(placement)];
  // A managed image skips the larger pre-rotation layer. Its final even
  // dimensions can still differ by rounding, so bound both graph shapes.
  if(placement.transform&&placement.transform.factor>1)
   rasters.push(clipRenderPeakRaster(clipRenderPlacement(clip,timeline,1,output)));
  const unsupportedRaster=rasters.find(raster=>!addressable(raster));
  if(unsupportedRaster)return {residentBytes,unsupportedRaster};
  const peakPixels=Math.max(...rasters.map(raster=>raster.width*raster.height));
  add(interval,peakPixels*LAYER_BYTES_PER_PIXEL);
 }
 let bytes=0,peak=0;
 for(const edge of edges.sort((a,b)=>a.frame-b.frame||a.bytes-b.bytes)){
  bytes+=edge.bytes;
  peak=Math.max(peak,bytes);
 }
 return {residentBytes:residentBytes+peak};
}
