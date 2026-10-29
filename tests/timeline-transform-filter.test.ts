import test from 'node:test';
import assert from 'node:assert/strict';
import {CLIP_TRANSFORM_PROFILE,clipTransformAt,type ClipTransform,type ClipTransformKeyframe} from '../packages/contracts/src/timeline-clip-transform.ts';
import {clipTransformCropFilter,clipTransformLayerFilters,clipTransformOverlayPosition,clipTransformPixelCrop,clipTransformRenderPlan,keyframeExpression} from '../packages/business/src/timeline-transform-filter.ts';

const make=(keyframes: ClipTransformKeyframe[],patch: Partial<ClipTransform>={}): ClipTransform=>({profileId:CLIP_TRANSFORM_PROFILE,keyframes,rotation:0,crop:{left:0,top:0,right:0,bottom:0},...patch});
const square={x:0,y:0,width:720,height:720};
/** Evaluates an FFmpeg expression of these graphs (if, lt, round, arithmetic) at a timestamp. */
function evaluate(expression: string,t: number): number {
 return new Function('t','lt','iff','round',`return ${expression.replaceAll('if(','iff(')};`)(t,(a: number,b: number)=>a<b?1:0,(c: number,a: number,b: number)=>c?a:b,Math.round) as number;
}

test('only a non-identity transform plans a layer; zoom-in renders it larger within 4096',()=>{
 assert.equal(clipTransformRenderPlan({durationFrames:60,rect:square}),null);
 assert.equal(clipTransformRenderPlan({durationFrames:60,rect:square,transform:make([{frame:0,x:0,y:0,scale:1}])}),null);
 const zoomIn={durationFrames:60,rect:square,transform:make([{frame:0,x:0,y:0,scale:1},{frame:59,x:0,y:0,scale:2}])};
 const plan=clipTransformRenderPlan(zoomIn)!;
 assert.deepEqual([plan.layerWidth,plan.layerHeight,plan.factor,plan.animated],[1440,1440,2,true]);
 assert.deepEqual([clipTransformRenderPlan(zoomIn,{maxFactor:1})!.layerWidth,clipTransformRenderPlan(zoomIn,{maxFactor:1})!.factor],[720,1],'managed images keep the rectangle size');
 const capped=clipTransformRenderPlan({durationFrames:60,rect:{x:0,y:0,width:1920,height:1080},transform:make([{frame:0,x:40,y:0,scale:8}])})!;
 assert.deepEqual([capped.layerWidth,capped.layerHeight,capped.animated],[4096,2304,false]);
 assert.deepEqual([clipTransformRenderPlan({durationFrames:60,rect:square,transform:make([{frame:0,x:0,y:0,scale:0.5}])})!.layerWidth],[720],'zoom-out needs no larger layer');
});

test('keyframe expressions match the model at every segment frame',()=>{
 const transform=make([{frame:10,x:-100,y:20,scale:0.5},{frame:50,x:100,y:-20,scale:1.5}]),clip={durationFrames:60,transform};
 for(const offset of [0,7,45]){
  for(const [channel,pick] of [['x',(point: ClipTransformKeyframe)=>point.x],['y',(point: ClipTransformKeyframe)=>point.y],['scale',(point: ClipTransformKeyframe)=>point.scale]] as const){
   const expression=keyframeExpression(transform.keyframes,pick,offset);
   for(let n=0;offset+n<60;n++)assert.ok(Math.abs(evaluate(expression,n/30)-clipTransformAt(clip,offset+n)[channel])<1e-9,`${channel} at offset ${offset}, frame ${n}`);
  }
 }
 assert.equal(keyframeExpression(make([{frame:0,x:-3,y:0,scale:1}]).keyframes,point=>point.x,12),'(-3)','a constant needs no frame term');
});

test('crop, layer and overlay options follow the plan',()=>{
 const animated=clipTransformRenderPlan({durationFrames:60,rect:{x:100,y:50,width:400,height:300},
  transform:make([{frame:0,x:0,y:0,scale:1},{frame:30,x:10,y:0,scale:1.5}],{rotation:90,crop:{left:0.25,top:0.1,right:0,bottom:0}})})!;
 assert.equal(clipTransformCropFilter(animated),'crop=w=iw*0.75:h=ih*0.9:x=iw*0.25:y=ih*0.1,');
 assert.equal(clipTransformCropFilter(null),'');
 const layer=clipTransformLayerFilters(animated,0);
 assert.match(layer,/^rotate=a=1\.5707963267948966:ow=rotw\(1\.5707963267948966\):oh=roth\(1\.5707963267948966\):c=none,scale=w='max\(2,2\*round\(iw\*\(/);
 assert.match(layer,/:eval=frame$/);
 assert.match(clipTransformOverlayPosition(animated,{x:100,y:50,width:400,height:300},0),/^x='300\+if\(.*-overlay_w\/2':y='200\+0-overlay_h\/2':eval=frame$/);
 const still=clipTransformRenderPlan({durationFrames:60,rect:square,transform:make([{frame:0,x:-30,y:12,scale:0.5}])})!;
 assert.equal(clipTransformOverlayPosition(still,square,0),"x='360+(-30)-overlay_w/2':y='360+12-overlay_h/2'");
 assert.doesNotMatch(clipTransformLayerFilters(still,0),/eval=frame|rotate/);
 assert.deepEqual(clipTransformPixelCrop(animated,1000,500),{x:250,y:50,width:750,height:450});
 assert.equal(clipTransformPixelCrop(still,1000,500),null);
});
