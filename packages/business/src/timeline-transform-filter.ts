import {isAnimatedClipTransform,isIdentityClipTransform,validateClipTransform,type ClipTransform,type ClipTransformKeyframe} from '../../contracts/src/timeline-clip-transform.ts';

// FFmpeg graph pieces for clip transforms, shared by preview and export. A clip
// without a transform, or with the identity, keeps the historical chain exactly.
// The layer is the clip's rectangle at an intermediate factor, with the cropped
// source fitted and centred on a transparent background; it is rotated once,
// then scaled per frame and overlaid by its centre, so its frames never change
// size before the scale (FFmpeg 7.1 and 9 render this identically).

// Zooming in renders the fitted layer larger first so it keeps source detail;
// the layer never exceeds 4096 pixels on either edge.
const LAYER_EDGE=4096;
export interface ClipTransformRenderPlan {
 readonly transform: ClipTransform;
 /** The layer size: the rectangle times the intermediate factor, even. */
 readonly layerWidth: number;readonly layerHeight: number;
 /** Layer pixels per rectangle pixel, horizontally (the layer keeps the rectangle's ratio). */
 readonly factor: number;
 readonly animated: boolean;
}
interface PlanClip {readonly durationFrames: number;readonly rect: {x: number;y: number;width: number;height: number};readonly transform?: unknown}
const even=(value: number): number=>Math.max(2,2*Math.round(value/2));

/** maxFactor 1 keeps the layer at the rectangle size: managed image layers
 * stay within their existing pixel budget, so they sample at that size. */
export function clipTransformRenderPlan(clip: PlanClip,{maxFactor=Infinity}: {maxFactor?: number}={}): ClipTransformRenderPlan|null {
 if(!Object.hasOwn(clip,'transform'))return null;
 const transform=validateClipTransform(clip.transform,clip.durationFrames);
 if(isIdentityClipTransform(transform))return null;
 const most=Math.max(1,...transform!.keyframes.map(point=>point.scale));
 const factor=Math.min(most,maxFactor,LAYER_EDGE/clip.rect.width,LAYER_EDGE/clip.rect.height);
 const layerWidth=Math.min(even(clip.rect.width*Math.max(1,factor)),LAYER_EDGE),layerHeight=Math.min(even(clip.rect.height*Math.max(1,factor)),LAYER_EDGE);
 return Object.freeze({transform:transform!,layerWidth,layerHeight,factor:layerWidth/clip.rect.width,animated:isAnimatedClipTransform(transform)});
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
export function clipTransformCropFilter(plan: ClipTransformRenderPlan|null): string {
 const crop=plan?.transform.crop;
 if(!crop||crop.left===0&&crop.top===0&&crop.right===0&&crop.bottom===0)return '';
 return `crop=w=iw*${literal(1-crop.left-crop.right)}:h=ih*${literal(1-crop.top-crop.bottom)}:x=iw*${literal(crop.left)}:y=ih*${literal(crop.top)},`;
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
export function clipTransformOverlayPosition(plan: ClipTransformRenderPlan,rect: {x: number;y: number;width: number;height: number},offset: number): string {
 const x=keyframeExpression(plan.transform.keyframes,point=>point.x,offset),y=keyframeExpression(plan.transform.keyframes,point=>point.y,offset);
 return `x='${literal(rect.x+rect.width/2)}+${x}-overlay_w/2':y='${literal(rect.y+rect.height/2)}+${y}-overlay_h/2'${plan.animated?':eval=frame':''}`;
}
