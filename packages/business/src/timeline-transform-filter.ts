import {isAnimatedClipTransform,isIdentityClipTransform,validateClipTransform,type ClipTransform,type ClipTransformKeyframe,type ClipTransformRect} from '../../contracts/src/timeline-clip-transform.ts';
import {projectClipLayout,rasterClipRect} from '../../contracts/src/timeline-clip-layout.ts';

// FFmpeg graph pieces for clip transforms, shared by preview and export. A clip
// without a transform, or with the identity, keeps the historical chain exactly.
// The layer is the clip's rectangle at an intermediate factor, with the cropped
// source fitted and centred on a transparent background; it is rotated once,
// then scaled per frame and overlaid by its centre, so its frames never change
// size before the scale (FFmpeg 7.1 and 9 render this identically).

// Zooming in renders the fitted layer larger first so it keeps source detail;
// the layer never exceeds 4096 pixels on either edge.
const LAYER_EDGE=4096;
type ProjectedTransform=Omit<ClipTransform,'profileId'>;
export interface ClipTransformRenderPlan {
 readonly transform: ProjectedTransform;
 /** The layer size: the rectangle times the intermediate factor, even. */
 readonly layerWidth: number;readonly layerHeight: number;
 /** Sampling scale to remove after the layer has been built. */
 readonly factor: number;
 readonly animated: boolean;
}
interface PlanClip {readonly durationFrames: number;readonly rect: ClipTransformRect;readonly transform?: unknown;readonly layout?: unknown}
const even=(value: number): number=>Math.max(2,2*Math.round(value/2));

/** maxFactor 1 keeps the layer at the rectangle size: managed image layers
 * stay within their existing pixel budget, so they sample at that size. */
export function clipTransformRenderPlan(clip: PlanClip,{maxFactor=Infinity}: {maxFactor?: number}={}): ClipTransformRenderPlan|null {
 if(!Object.hasOwn(clip,'transform'))return null;
 return projectedTransformPlan(clip.rect,validateClipTransform(clip.transform,clip.durationFrames),maxFactor);
}

function projectedTransformPlan(rect: ClipTransformRect,transform: ProjectedTransform|null,maxFactor: number,relative=false): ClipTransformRenderPlan|null {
 if(!transform||isIdentityClipTransform(transform))return null;
 const most=Math.max(1,...transform.keyframes.map(point=>point.scale));
 const factor=Math.max(1,Math.min(most,maxFactor,LAYER_EDGE/rect.width,LAYER_EDGE/rect.height));
 const layerWidth=Math.min(even(rect.width*factor),LAYER_EDGE),layerHeight=Math.min(even(rect.height*factor),LAYER_EDGE);
 // Rounding one narrow axis can multiply its apparent scale. Keep that
 // rounding confined to the raster rather than shrinking the other axis.
 return Object.freeze({transform,layerWidth,layerHeight,factor:relative?factor:layerWidth/rect.width,animated:isAnimatedClipTransform(transform)});
}

/** Raster dimensions are even, but the placement still uses the projected centre. */
export function clipRenderPlacement(clip: PlanClip,frame: {fps: number;width: number;height: number},maxFactor=Infinity) {
 const relative=Object.hasOwn(clip,'layout');
 const projected=relative?projectClipLayout(clip,frame):null;
 const rect=projected?.rect??clip.rect;
 const transform=projected?projectedTransformPlan(rect,projected.transform,maxFactor,true):clipTransformRenderPlan(clip,{maxFactor});
 const {x,y,width,height}=relative?rasterClipRect(rect):rect;
 return {rect,transform,width,height,x,y,relative};
}

/** Display aspect is read from the decoded, cropped input. The frozen asset's
 * width and height describe coded pixels and need not describe its picture. */
export function clipLayoutFitFilter(width: number,height: number): string {
 return `scale=w='max(2,2*trunc(min(${width},${height}*dar)/2))':h='max(2,2*trunc(min(${height},${width}/dar)/2))'`;
}

/** A number as an FFmpeg expression literal; negative values are parenthesized. */
const literal=(value: number): string=>{
 if(!Number.isFinite(value))throw Object.assign(new Error('Invalid transform value.'),{code:'INVALID_CLIP_TRANSFORM'});
 const text=String(Object.is(value,-0)?0:value);
 return value<0?`(${text})`:text;
};
/** Piecewise-linear value of one keyframe channel at clip-local frame
 * offset+round(t*30), holding the first and last values outside the keyframes.
 * The segment frame comes from the timestamp: scale and overlay count n from
 * their already advanced link counter, one ahead of the frame they draw. */
export function keyframeExpression(keyframes: readonly ClipTransformKeyframe[],pick: (point: ClipTransformKeyframe)=>number,offset: number): string {
 const values=keyframes.map(pick);
 if(values.every(value=>value===values[0]))return literal(values[0]!);
 const frame=`(${literal(offset)}+round(t*30))`;
 let expression=literal(values.at(-1)!);
 for(let index=keyframes.length-1;index>=1;index--){
  const left=keyframes[index-1]!,right=keyframes[index]!,from=values[index-1]!,to=values[index]!;
  const segment=from===to?literal(from):`${literal(from)}+${literal(to-from)}*(${frame}-${left.frame})/${right.frame-left.frame}`;
  expression=`if(lt(${frame},${right.frame}),${segment},${expression})`;
 }
 return `if(lt(${frame},${keyframes[0]!.frame}),${literal(values[0]!)},${expression})`;
}

/** The crop in whole source pixels, for layers built from a known source size. */
export function clipTransformPixelCrop(plan: ClipTransformRenderPlan|null,sourceWidth: number,sourceHeight: number): {x: number;y: number;width: number;height: number}|null {
 const crop=plan?.transform.crop;
 if(!crop||crop.left===0&&crop.top===0&&crop.right===0&&crop.bottom===0)return null;
 const x=Math.round(sourceWidth*crop.left),y=Math.round(sourceHeight*crop.top);
 return {x,y,width:Math.max(1,sourceWidth-x-Math.round(sourceWidth*crop.right)),height:Math.max(1,sourceHeight-y-Math.round(sourceHeight*crop.bottom))};
}
/** Crops the source before it is fitted; empty when nothing is cropped. */
export function clipTransformCropFilter(plan: ClipTransformRenderPlan|null,exact=false): string {
 const crop=plan?.transform.crop;
 if(!crop||crop.left===0&&crop.top===0&&crop.right===0&&crop.bottom===0)return '';
 return `crop=w=iw*${literal(1-crop.left-crop.right)}:h=ih*${literal(1-crop.top-crop.bottom)}:x=iw*${literal(crop.left)}:y=ih*${literal(crop.top)}${exact?':exact=1':''},`;
}

/** Runs after the layer is trimmed and retimed to the segment's frames: a
 * static rotation, then the per-frame scale relative to the layer. */
export function clipTransformLayerFilters(plan: ClipTransformRenderPlan,offset: number): string {
 const rotation=plan.transform.rotation,filters: string[]=[];
 if(rotation!==0){
  const radians=literal(rotation*Math.PI/180);
  filters.push(`rotate=a=${radians}:ow=rotw(${radians}):oh=roth(${radians}):c=none`);
 }
 const scale=keyframeExpression(plan.transform.keyframes,point=>point.scale/plan.factor,offset);
 filters.push(`scale=w='max(2,2*round(iw*(${scale})/2))':h='max(2,2*round(ih*(${scale})/2))'${plan.animated?':eval=frame':''}`);
 return filters.join(',');
}

/** Overlay options placing the layer's centre at the rectangle centre plus the
 * keyframed offset; the layer may leave the frame. */
export function clipTransformOverlayPosition(plan: ClipTransformRenderPlan,rect: {x: number;y: number;width: number;height: number},offset: number,shift?: string): string {
 const x=keyframeExpression(plan.transform.keyframes,point=>point.x,offset),y=keyframeExpression(plan.transform.keyframes,point=>point.y,offset);
 // A push transition moves the placed content horizontally per frame.
 return `x='${literal(rect.x+rect.width/2)}+${x}-overlay_w/2${shift?`+${shift}`:''}':y='${literal(rect.y+rect.height/2)}+${y}-overlay_h/2'${plan.animated||shift?':eval=frame':''}`;
}
