import {AppError} from '@mioon/contracts';
import type {DatabaseSync} from 'node:sqlite';
import {createTimelineRecoveryBoundary,TIMELINE_REPLACEMENT_RESPONSE_BYTES} from './timeline-recovery.ts';
import type {TimelineRecord} from './timeline-inputs.ts';

export interface ReplacementInput {[key: string]: unknown;projectId: string;requestId: string;expectedRevision: number;clipId: string;assetId: string;versionId?: string}

export const REPLACEMENT_RESPONSE_BYTES=TIMELINE_REPLACEMENT_RESPONSE_BYTES;
const category=(value: unknown): string|null=>typeof value==='string'?value.split('/')[0]:null;
const provenance=['versionId','shotId','jobId'] as const;
type ClipSourceFields = {
 assetId: string|null;versionId?:string|null;shotId?:string;jobId?:string|null;colour?:unknown;
};

export function sameClipSourceCategory(previous: string, next: string): boolean {
 const kind=category(next);
 return (kind==='video'||kind==='audio'||kind==='image')&&category(previous)===kind;
}

/** The source edit itself, shared by replaceSource and refreshSources: every
 * editable field stays, old provenance and the colour source binding go, and
 * an optional version pins the clip to that version and its shot. */
export function replaceClipSource(clip: ClipSourceFields,sourceId: string,version: {id: string;shotId: string}|null): void{
 for(const key of provenance)delete clip[key];
 clip.assetId=sourceId;
 if(typeof clip.colour==='object'&&clip.colour!==null)clip.colour={...clip.colour,source:null};
 if(version){clip.versionId=version.id;clip.shotId=version.shotId;}
}

// Source replacement shares the common receipt/ownership boundary with every
// other keyed timeline write. Its only distinct behavior is the source edit.
export function createTimelineReplacementBoundary(db: DatabaseSync,input: ReplacementInput){
 const boundary=createTimelineRecoveryBoundary(db,input);
 function read(): TimelineRecord{
  const timeline=boundary.read();
  if(!timeline)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404);
  return timeline;
 }
 function apply(timeline: TimelineRecord): void{
  const clip=timeline.clips.find(clip=>clip.id===input.clipId);
  if(!clip)throw new AppError('CLIP_NOT_FOUND','片段不属于此时间线',404);
  const previous=boundary.clipSource(clip),source=boundary.asset(input.assetId);
  if(previous.id===source.id)throw new AppError('SOURCE_UNCHANGED','片段已使用此素材，无需替换',409);
  if(!sameClipSourceCategory(previous.mimeType,source.mimeType))
   throw new AppError('INVALID_CLIP_TYPE','替换素材必须与原素材同为视频、音频或图片',400);
  const version=input.versionId===undefined?null:boundary.version(input.versionId as string,undefined,source.id);
  replaceClipSource(clip,source.id,version);
 }
 return {...boundary,read,apply};
}
