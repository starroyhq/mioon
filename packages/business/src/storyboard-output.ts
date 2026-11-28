import type {DatabaseSync} from 'node:sqlite';
import {timelineOutputPreset,DEFAULT_TIMELINE_OUTPUT_PRESET} from '../../contracts/src/timeline-output-geometry.ts';
import type {TimelineOutputGeometry} from '../../contracts/src/timeline-output-geometry.ts';
import {readTimelineHeaderStorage,timelineStorageFormat,timelineStorageSchema} from './project-file/timeline-storage.ts';
import {FORMAT6_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
function invalid():never{throw Object.assign(new Error('Invalid frozen storyboard output geometry'),{code:'INVALID_TIMELINE_SNAPSHOT'});}
const geometry=(value:unknown,allowProjectFps=false):TimelineOutputGeometry=>{
  const preset=timelineOutputPreset(value,{allowProjectFps});if(!preset)invalid();
  // Storyboard output stitches selected source videos. The saved timeline
  // supplies its canvas dimensions while the stitch profile retains its own clock.
  return {fps:30,width:preset.width,height:preset.height};
};

/** Reading an export's format must not initialize an empty timeline. */
export function freezeStoryboardOutputGeometry(db:DatabaseSync,projectId:string):TimelineOutputGeometry{
  const snapshot=readTimelineHeaderStorage(db,projectId);
  if(!snapshot)return geometry(DEFAULT_TIMELINE_OUTPUT_PRESET);
  const allowProjectFps=snapshot.format5&&process.env.MIOON_FORMAT6_DEV==='1'&&
    timelineStorageFormat(db,timelineStorageSchema(db))===FORMAT6_PROJECT_SCHEMA_VERSION;
  return geometry(snapshot.header,allowProjectFps);
}

/** A queued legacy export without this additive field retains its old size. */
export function storyboardOutputGeometry(value:unknown):TimelineOutputGeometry{
  if(!value||typeof value!=='object'||Array.isArray(value))invalid();
  if(!Object.hasOwn(value,'outputGeometry'))return geometry('portrait_720');
  return geometry((value as Record<string,unknown>).outputGeometry);
}
