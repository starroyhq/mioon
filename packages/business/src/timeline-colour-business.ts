import type {DatabaseSync} from 'node:sqlite';
import {clipColourSchema} from '../../contracts/src/timeline-colour.ts';
import {readLutResource} from './lut-resource-validation.ts';

const fault=(code:string):Error&{code:string;status:number}=>Object.assign(new Error(
  code==='TIMELINE_COLOUR_LOOK_UNAVAILABLE'?'The creative look is not an exact owned LUT resource in this project.':
  'The saved clip colour declaration does not match its current video source.'),{code,status:409});
interface ColourClip {id:string;trackId:string;assetId:string;colour?:unknown}
interface ColourTimeline {projectId:string;tracks:readonly {id:string;kind:string}[];clips:readonly ColourClip[]}
interface ColourAsset {id:string;projectId?:string;sha256:string;mimeType:string}
/** Synchronous metadata/ownership checks only. Never probe files in a write
 * transaction. Actual source evidence is checked again by the export worker. */
export function validateTimelineColourBindings(db:DatabaseSync,timeline:ColourTimeline,assets:ReadonlyMap<string,ColourAsset>):void {
  const looks=new Map<string,ReturnType<typeof readLutResource>>();
  for(const clip of timeline.clips){
    if(clip.colour===undefined||clip.colour===null)continue;
    const parsed=clipColourSchema.safeParse(clip.colour);
    if(!parsed.success||parsed.data===null)throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
    const source=assets.get(clip.assetId),track=timeline.tracks.find(item=>item.id===clip.trackId),colour=parsed.data;
    if(!source||source.id!==clip.assetId||source.projectId!==undefined&&source.projectId!==timeline.projectId||
      track?.kind!=='video'||(colour.source===null?!['video/mp4','video/webm','image/png'].includes(source.mimeType):colour.profileId==='mioon-srgb-image-clip-v1'?source.mimeType!=='image/png':!source.mimeType.startsWith('video/'))||colour.source!==null&&colour.source.assetSha256!==source.sha256)
      throw fault('TIMELINE_COLOUR_SOURCE_MISMATCH');
    // source:null is a deliberately invalidated state, not authority to render.
    // The independent creative look remains editable and survives replacement.
    if(colour.look){
      let resource=looks.get(colour.look.resourceId);
      try{if(!resource){resource=readLutResource(db,timeline.projectId,colour.look.resourceId);looks.set(resource.id,resource);}}
      catch{throw fault('TIMELINE_COLOUR_LOOK_UNAVAILABLE');}
      if(resource.sha256!==colour.look.resourceSha256||resource.profile!==colour.look.resourceProfile)throw fault('TIMELINE_COLOUR_LOOK_UNAVAILABLE');
    }
  }
}
