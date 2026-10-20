interface Timeline {clips?:readonly {id:string;trackId:string}[]}
/** Editor locks are explicit per-window interaction preferences. They do not
 * change saved timelines or claim authority over other clients. */
export function touchesLockedTrack(operation:string,input:Record<string,unknown>,timeline:Timeline|null|undefined,locked:ReadonlySet<string>):boolean{
  if(!locked.size)return false;
  if(['timeline.undo','timeline.redo','timeline.seed','timeline.loudness.apply'].includes(operation))return true;
  const patch=input.patch&&typeof input.patch==='object'?input.patch as Record<string,unknown>:null;
  const source=typeof input.clipId==='string'?timeline?.clips?.find(clip=>clip.id===input.clipId)?.trackId:null;
  return [source,input.trackId,patch?.trackId].some(track=>typeof track==='string'&&locked.has(track));
}
