/** The closed output set is shared by new projects and historical snapshots.
 * Keeping legacy presets separate prevents a new-project picker from offering
 * old sizes while preserving exact reads of already saved 720 projects. */
function preset<const Id extends string>(id:Id,label:string,width:number,height:number){
  return Object.freeze({id,label,fps:30 as const,width,height});
}
export const TIMELINE_CURRENT_OUTPUT_PRESETS=Object.freeze([
  preset('portrait_1080','竖屏 9:16',1080,1920),
  preset('landscape_1080','横屏 16:9',1920,1080),
  preset('square_1080','方屏 1:1',1080,1080),
]);
export const TIMELINE_LEGACY_OUTPUT_PRESETS=Object.freeze([
  preset('portrait_720','竖屏 9:16',720,1280),
  preset('landscape_720','横屏 16:9',1280,720),
  preset('square_720','方屏 1:1',720,720),
]);
export const TIMELINE_OUTPUT_PRESETS=Object.freeze([...TIMELINE_CURRENT_OUTPUT_PRESETS,...TIMELINE_LEGACY_OUTPUT_PRESETS]);
export const DEFAULT_TIMELINE_OUTPUT_PRESET='portrait_1080';
export type TimelineOutputPreset=typeof TIMELINE_OUTPUT_PRESETS[number];
export type TimelineOutputGeometry=Readonly<{fps:30;width:number;height:number}>;
export type TimelineOutputResolution='native'|'short_360'|'short_720'|'short_1080';

export function timelineOutputPreset(value:unknown):TimelineOutputPreset|null{
  if(typeof value==='string')return TIMELINE_OUTPUT_PRESETS.find(item=>item.id===value)??null;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const geometry=value as Record<string,unknown>;
  return TIMELINE_OUTPUT_PRESETS.find(item=>item.fps===geometry.fps&&item.width===geometry.width&&item.height===geometry.height)??null;
}

/** Resolve from the native short edge, never a fixed 720 intermediate. */
export function timelineDeliveryGeometry(value:unknown,resolution:TimelineOutputResolution):TimelineOutputGeometry|null{
  const source=timelineOutputPreset(value);
  if(!source)return null;
  const native=Math.min(source.width,source.height);
  const short=resolution==='native'?native:resolution==='short_360'?360:resolution==='short_720'?720:resolution==='short_1080'?1080:null;
  if(short===null)return null;
  return {fps:30,width:source.width*short/native,height:source.height*short/native};
}
