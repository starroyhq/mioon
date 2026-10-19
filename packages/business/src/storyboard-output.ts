import {timelineOutputPreset,DEFAULT_TIMELINE_OUTPUT_PRESET} from '../../contracts/src/timeline-output-geometry.ts';
import type {TimelineOutputGeometry} from '../../contracts/src/timeline-output-geometry.ts';

interface StoryboardDatabase{prepare(sql:string):{get(projectId:string):unknown}}
function invalid():never{throw Object.assign(new Error('Invalid frozen storyboard output geometry'),{code:'INVALID_TIMELINE_SNAPSHOT'});}
const geometry=(value:unknown):TimelineOutputGeometry=>{
  const preset=timelineOutputPreset(value);if(!preset)invalid();
  return {fps:30,width:preset.width,height:preset.height};
};

/** Reading an export's format must not initialize an empty timeline. */
export function freezeStoryboardOutputGeometry(db:StoryboardDatabase,projectId:string):TimelineOutputGeometry{
  const row=db.prepare('SELECT data FROM timelines WHERE projectId=?').get(projectId);
  if(row===undefined)return geometry(DEFAULT_TIMELINE_OUTPUT_PRESET);
  if(!row||typeof row!=='object'||!('data' in row)||typeof row.data!=='string')invalid();
  let timeline:unknown;try{timeline=JSON.parse(row.data);}catch{invalid();}
  return geometry(timeline);
}

/** A queued legacy export without this additive field retains its old size. */
export function storyboardOutputGeometry(value:unknown):TimelineOutputGeometry{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  if(!Object.hasOwn(value,'outputGeometry'))return geometry('portrait_720');
  return geometry((value as Record<string,unknown>).outputGeometry);
}
