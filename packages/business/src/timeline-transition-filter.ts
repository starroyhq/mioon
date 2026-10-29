import {sourceFrameCount} from '@mioon/contracts';
import {clipTransitionRegions,type ClipTransitionRegion} from '../../contracts/src/timeline-clip-transition.ts';
import {assertTimelineImageCompositorInputCount} from '../../contracts/src/timeline-colour.ts';

// Graph pieces for two-clip transitions, used by timeline-media.ts for preview
// and export alike. A timeline without transitions never reaches them.
const FPS=30;
interface RenderClip {readonly id: string;readonly trackId: string;readonly assetId: string;readonly startFrame: number;readonly durationFrames: number;readonly sourceInFrame: number;readonly transitionIn?: unknown}
interface RenderTimeline {readonly durationFrames: number;readonly clips: readonly RenderClip[]}
/** A clip's prepared layer: its label, its overlay position (optionally moved
 * horizontally by a per-frame expression) and the rest of its overlay options. */
export interface TransitionLayer {readonly label: string;readonly position: (shift?: string)=>string;readonly placement: string}

/** The saved transitions of a validated render timeline. Saved timelines keep
 * only transitions that fit, so one that does not is an invalid snapshot. */
export function timelineTransitionRegions(timeline: RenderTimeline,assets: ReadonlyMap<string,{readonly mimeType: string;readonly duration?: unknown}>): ClipTransitionRegion[]{
 if(!timeline.clips.some(clip=>Object.hasOwn(clip,'transitionIn')))return [];
 try{
  return clipTransitionRegions(timeline,assetId=>{
   const asset=assets.get(assetId);if(!asset)return null;
   const image=asset.mimeType.startsWith('image/');return {image,frames:image?0:sourceFrameCount(asset.duration)??0};
  });
 }catch{throw Object.assign(Error('A saved transition does not fit its cut.'),{code:'INVALID_TIMELINE_SNAPSHOT'});}
}
/** The segment planner's input: transition edges cut segments like clip edges,
 * so every segment lies wholly inside or outside each transition. */
export function transitionPlanSnapshot<T extends {readonly timeline: RenderTimeline}>(snapshot: T,regions: readonly ClipTransitionRegion[]): T{
 if(!regions.length)return snapshot;
 return {...snapshot,timeline:{...snapshot.timeline,clips:[...snapshot.timeline.clips,
  ...regions.map(region=>({startFrame:region.startFrame,durationFrames:region.endFrame-region.startFrame}))]}};
}
/** The frames a clip shows its picture for: a transition reaches into the
 * neighbouring clip's range, using source frames beyond the clip's own. */
export function transitionPictureRange(clip: RenderClip,regions: readonly ClipTransitionRegion[]): {start: number;end: number}{
 let start=clip.startFrame,end=clip.startFrame+clip.durationFrames;
 for(const region of regions){if(region.incomingId===clip.id)start=region.startFrame;if(region.outgoingId===clip.id)end=region.endFrame;}
 return {start,end};
}
/** The managed image budget of a frozen snapshot, counted as the renderer opens
 * inputs: a transition shows the images on both sides of its cut at once,
 * which the colour plan, counting clip ranges, does not see. */
export function assertTransitionImageBudget(snapshot: {
 readonly timeline: RenderTimeline;readonly assets: readonly {readonly id: string;readonly mimeType: string;readonly duration?: unknown}[];
 readonly colourPlan?: {readonly clips: readonly {readonly clipId: string;readonly kind?: string}[]};
}): void{
 const images=new Set(snapshot.colourPlan?.clips.filter(clip=>clip.kind==='image').map(clip=>clip.clipId));
 if(!images.size)return;
 const regions=timelineTransitionRegions(snapshot.timeline,new Map(snapshot.assets.map(asset=>[asset.id,asset])));if(!regions.length)return;
 const edges: {frame: number;delta: number}[]=[];
 for(const clip of snapshot.timeline.clips)if(images.has(clip.id)){const {start,end}=transitionPictureRange(clip,regions);edges.push({frame:start,delta:1},{frame:end,delta:-1});}
 let active=0;
 for(const edge of edges.sort((a,b)=>a.frame-b.frame||a.delta-b.delta)){active+=edge.delta;assertTimelineImageCompositorInputCount(active);}
}
/** The transition this segment lies in on a track, if any. */
export function segmentTransition(regions: readonly ClipTransitionRegion[],trackId: string,begin: number,end: number): ClipTransitionRegion|null{
 return regions.find(region=>region.trackId===trackId&&region.startFrame<=begin&&end<=region.endFrame)??null;
}
const seconds=(frames: number): string=>String(Number((frames/FPS).toFixed(6)));
/** Progress at each frame of a segment that starts `into` frames after the
 * transition starts, as xfade counts it: transition frame k is k/D of the way. */
export function transitionProgress(into: number,durationFrames: number): string{
 return `(${into}+round(t*${FPS}))/${durationFrames}`;
}
/** Both clips over the composition below them for one segment, ending at `out`.
 * Dissolve and wipes mix two complete compositions, so layers under the clips
 * stay put. A dip and a push change only the two clips: the dip darkens the
 * outgoing picture to black in the first half and brightens the incoming one
 * from black in the second; the push moves both. A segment that starts inside
 * the transition pads its streams with `into` frames, so the transition
 * advances from where it is. */
export function transitionFilters(region: ClipTransitionRegion,{begin,width,below,outgoing,incoming,out}: {
 begin: number;width: number;below: string;outgoing: TransitionLayer;incoming: TransitionLayer;out: string;
}): string[]{
 const into=begin-region.startFrame,duration=region.durationFrames;
 if(region.kind==='pushLeft'||region.kind==='pushRight'){
  const progress=transitionProgress(into,duration),away=region.kind==='pushLeft'?-width:width;
  return [`[${below}][${outgoing.label}]overlay=${outgoing.position(`(${away}*${progress})`)}${outgoing.placement}[${out}a]`,
   `[${out}a][${incoming.label}]overlay=${incoming.position(`(${-away}*(1-${progress}))`)}${incoming.placement}[${out}]`];
 }
 const trim=into?`,trim=start_frame=${into},setpts=N/(${FPS}*TB)`:'';
 if(region.kind==='dipToBlack'){
  // Planar RGB: fade scales packed RGBA's alpha too, but a plane format's colour only.
  const half=seconds(duration/2),progress=transitionProgress(into,duration),pad=into?`fps=${FPS},tpad=start=${into}:start_mode=clone,`:'';
  return [`[${outgoing.label}]${pad}format=gbrap,fade=t=out:st=0:d=${half}:color=black${trim}[${out}a]`,
   `[${incoming.label}]${pad}format=gbrap,fade=t=in:st=${half}:d=${half}:color=black${trim}[${out}b]`,
   `[${below}][${out}a]overlay=${outgoing.position()}${outgoing.placement}:enable='lt(${progress},0.5)'[${out}c]`,
   `[${out}c][${out}b]overlay=${incoming.position()}${incoming.placement}:enable='gte(${progress},0.5)'[${out}]`];
 }
 const filters=[`[${below}]split=2[${out}a0][${out}b0]`,
  `[${out}a0][${outgoing.label}]overlay=${outgoing.position()}${outgoing.placement}[${out}a1]`,
  `[${out}b0][${incoming.label}]overlay=${incoming.position()}${incoming.placement}[${out}b1]`];
 const kind={dissolve:'fade',wipeLeft:'wipeleft',wipeRight:'wiperight'}[region.kind];
 // xfade and tpad need a declared constant rate, which setpts upstream leaves
 // unknown in FFmpeg 7.
 const lead=`fps=${FPS}${into?`,tpad=start=${into}:start_mode=clone`:''}`;
 filters.push(`[${out}a1]${lead}[${out}a2]`,`[${out}b1]${lead}[${out}b2]`,
  `[${out}a2][${out}b2]xfade=transition=${kind}:duration=${seconds(duration)}:offset=0${trim}[${out}]`);
 return filters;
}
