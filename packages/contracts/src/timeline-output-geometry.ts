export const TIMELINE_OUTPUT_RATIOS=Object.freeze(['9:16','16:9','1:1','4:3','3:4','21:9'] as const);
export type TimelineOutputRatio=typeof TIMELINE_OUTPUT_RATIOS[number];
export type TimelineOutputShortEdge=720|1080;
export type TimelineOutputGeometry=Readonly<{fps:30;width:number;height:number}>;
export type TimelineOutputResolution='native'|'short_360'|'short_720'|'short_1080';

function geometryForRatio(ratio:TimelineOutputRatio,short:360|TimelineOutputShortEdge):TimelineOutputGeometry{
  const [width,height]=ratio.split(':').map(Number) as [number,number];
  const unit=short/Math.min(width,height),even=(pixels:number)=>2*Math.round(pixels/2);
  return {fps:30,width:even(width*unit),height:even(height*unit)};
}

function preset<const Id extends string>(id:Id,label:string,ratio:TimelineOutputRatio,short:TimelineOutputShortEdge){
  return Object.freeze({id,label,...geometryForRatio(ratio,short)});
}
// Keep the existing create picker and pristine-format writer closed until the
// frame transaction activates. This also preserves the model-facing enum.
export const TIMELINE_CURRENT_OUTPUT_PRESETS=Object.freeze([
  preset('portrait_1080','竖屏 9:16','9:16',1080),
  preset('landscape_1080','横屏 16:9','16:9',1080),
  preset('square_1080','方屏 1:1','1:1',1080),
]);
export const TIMELINE_LEGACY_OUTPUT_PRESETS=Object.freeze([
  preset('portrait_720','竖屏 9:16','9:16',720),
  preset('landscape_720','横屏 16:9','16:9',720),
  preset('square_720','方屏 1:1','1:1',720),
]);
export const TIMELINE_FORMAT_WRITE_PRESETS=Object.freeze([...TIMELINE_CURRENT_OUTPUT_PRESETS,...TIMELINE_LEGACY_OUTPUT_PRESETS]);
export const TIMELINE_OUTPUT_PRESETS=Object.freeze([
  ...TIMELINE_FORMAT_WRITE_PRESETS,
  preset('landscape_4_3_1080','横屏 4:3','4:3',1080),
  preset('portrait_3_4_1080','竖屏 3:4','3:4',1080),
  preset('ultrawide_1080','超宽屏 21:9','21:9',1080),
  preset('landscape_4_3_720','横屏 4:3','4:3',720),
  preset('portrait_3_4_720','竖屏 3:4','3:4',720),
  preset('ultrawide_720','超宽屏 21:9','21:9',720),
]);
export const TIMELINE_OUTPUT_MAX_EDGE=Math.max(...TIMELINE_OUTPUT_PRESETS.map(({width,height})=>Math.max(width,height)));
export const DEFAULT_TIMELINE_OUTPUT_PRESET='portrait_1080';
export type TimelineOutputPreset=typeof TIMELINE_OUTPUT_PRESETS[number];

function matchesGeometry(value:Record<string,unknown>,geometry:TimelineOutputGeometry):boolean{
  return geometry.fps===value.fps&&geometry.width===value.width&&geometry.height===value.height;
}

export function timelineOutputPreset(value:unknown):TimelineOutputPreset|null{
  if(typeof value==='string')return TIMELINE_OUTPUT_PRESETS.find(item=>item.id===value)??null;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const geometry=value as Record<string,unknown>;
  return TIMELINE_OUTPUT_PRESETS.find(item=>matchesGeometry(geometry,item))??null;
}

export function timelineOutputPresetForRatio(ratio:TimelineOutputRatio,short:TimelineOutputShortEdge):TimelineOutputPreset|null{
  if(!TIMELINE_OUTPUT_RATIOS.includes(ratio)||short!==720&&short!==1080)return null;
  return timelineOutputPreset(geometryForRatio(ratio,short));
}

export function timelineOutputRatio(value:unknown):TimelineOutputRatio|null{
  const source=timelineOutputPreset(value);
  if(!source)return null;
  const short=Math.min(source.width,source.height) as TimelineOutputShortEdge;
  return TIMELINE_OUTPUT_RATIOS.find(ratio=>matchesGeometry(source,geometryForRatio(ratio,short)))??null;
}

/** Standalone encoded geometry is one of the same ratios at a closed short
 * edge. An export receipt also binds it to its original timeline and settings. */
export function isTimelineDeliveryGeometry<Value>(value:Value):value is Value&TimelineOutputGeometry{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const geometry=value as Record<string,unknown>,{width,height}=geometry;
  if(typeof width!=='number'||typeof height!=='number')return false;
  const short=Math.min(width,height);
  return (short===360||short===720||short===1080)&&TIMELINE_OUTPUT_RATIOS.some(ratio=>matchesGeometry(geometry,geometryForRatio(ratio,short)));
}

/** Resolve from the frame ratio and selected short edge, with one even-pixel
 * rounding step. Native delivery retains the original frozen dimensions. */
export function timelineDeliveryGeometry(value:unknown,resolution:TimelineOutputResolution):TimelineOutputGeometry|null{
  const source=timelineOutputPreset(value);
  if(!source)return null;
  if(resolution==='native')return {fps:30,width:source.width,height:source.height};
  const short=resolution==='short_360'?360:resolution==='short_720'?720:resolution==='short_1080'?1080:null;
  const ratio=timelineOutputRatio(source);
  return short===null||ratio===null?null:geometryForRatio(ratio,short);
}
