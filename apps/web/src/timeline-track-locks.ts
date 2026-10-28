interface Timeline {clips?:readonly {id:string;trackId:string;assetId?:string}[];tracks?:readonly {id:string;kind:string;orderIndex:number}[]}
/** Editor locks are explicit per-window interaction preferences. They do not
 * change saved timelines or claim authority over other clients. */
export function touchesLockedTrack(operation:string,input:Record<string,unknown>,timeline:Timeline|null|undefined,locked:ReadonlySet<string>):boolean{
  if(!locked.size)return false;
  if(['timeline.undo','timeline.redo','timeline.seed','timeline.loudness.apply'].includes(operation))return true;
  // The two canvas bridges name no track: refreshing touches its clips' tracks, appending the first video track.
  if(operation==='timeline.clip.refreshSources')return Array.isArray(input.clipIds)&&input.clipIds.some(id=>{const track=timeline?.clips?.find(clip=>clip.id===id)?.trackId;return typeof track==='string'&&locked.has(track);});
  // A crossfade touches the tracks of both of its clips.
  if(operation==='timeline.clip.crossfade')return [input.outgoingClipId,input.incomingClipId].some(id=>{const track=timeline?.clips?.find(clip=>clip.id===id)?.trackId;return typeof track==='string'&&locked.has(track);});
  // The scene split touches every clip of its reference video.
  if(operation==='timeline.clip.splitAtScenes')return Boolean(timeline?.clips?.some(clip=>clip.assetId===input.assetId&&locked.has(clip.trackId)));
  if(operation==='timeline.shots.append'){const lane=[...(timeline?.tracks??[])].filter(track=>track.kind==='video').sort((a,b)=>a.orderIndex-b.orderIndex)[0];return Boolean(lane&&locked.has(lane.id));}
  const patch=input.patch&&typeof input.patch==='object'?input.patch as Record<string,unknown>:null;
  const source=typeof input.clipId==='string'?timeline?.clips?.find(clip=>clip.id===input.clipId)?.trackId:null;
  return [source,input.trackId,patch?.trackId].some(track=>typeof track==='string'&&locked.has(track));
}
