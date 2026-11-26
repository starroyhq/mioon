import {z} from 'zod';
import {isVolumeEnvelope} from './timeline-volume-envelope-processing.ts';
import {isClipAudioRole} from './timeline-audio-role.ts';
import {isTimelineClipColour} from './timeline-colour.ts';
import {isClipTransform} from './timeline-clip-transform.ts';
import {isClipTransition} from './timeline-clip-transition.ts';
import {isClipLayoutRect} from './timeline-clip-layout.ts';
import {timelineOutputPreset} from './timeline-output-geometry.ts';
import {getTimelineSubtitleTextIssue} from './timeline-subtitles.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID, TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID} from './timeline-subtitle-profile.ts';
import type {TimelineClipRecord, TimelineRecord, TimelineTrackRecord} from './timeline-replacement.ts';
import type {BoardSequenceErrorCode} from './board-sequence.ts';
import type {MainTrackErrorCode} from './chain-main-track.ts';
import {PREVIS_LIMITS} from './previs.ts';
import {clipTimingSchema} from './timeline-speed.ts';
import {compileClipTimeMap, MAX_CLIP_SOURCE_SPAN_FRAMES} from './timeline-clip-timing.ts';
import {projectTimeMapToCurrentClipFields} from './timeline-time-map.ts';

/** One shot's generation-input capacity: material reference lines, subject
 * bindings and previs scene subjects. The read-only projection bound is their
 * sum; the service-side planners read the same constants. */
export const FORMAT5_INPUT_LIMITS = Object.freeze({
  referenceEdgesPerShot: 48,
  subjectBindingsPerShot: 8,
  previsSceneSubjects: PREVIS_LIMITS.figures + PREVIS_LIMITS.props,
});
/** Editing and persistence limits. Export admission retains its own limits. */
export const FORMAT5_LIMITS = Object.freeze({
  mainTrackClips:500, otherTrackClips:1000, subtitleCues:1000, tracks:12,
  durationFrames:300000, timelineBytes:8*1024*1024, baselineBytes:512*1024,
  historyEntryBytes:4*1024*1024, historyEntries:200, historyBytes:128*1024*1024,
  receiptRows:65536, receiptBytes:32*1024*1024, receiptResponseBytes:64*1024,
});

const id=z.string().uuid();
const frame=z.number().int().safe().min(0).max(FORMAT5_LIMITS.durationFrames);
const revision=z.number().int().safe().positive();
const timestamp=z.string().min(1).max(64).refine(value=>Number.isFinite(Date.parse(value)));
const position=z.object({x:z.number().finite(),y:z.number().finite()}).strict();
const optionalCanvasFields={label:z.string().max(150).optional(),text:z.string().max(5000).optional(),revision:revision.optional(),updatedAt:timestamp.optional()};

export const format5SequenceRootSchema=z.object({
  id,projectId:id,type:z.literal('sequence_root'),name:z.string().min(1).max(150),
  position,createdAt:timestamp,...optionalCanvasFields,
}).strict();
export const format5SubjectCardSchema=z.object({
  id,projectId:id,type:z.literal('subject_card'),subjectId:id,
  position,createdAt:timestamp,...optionalCanvasFields,
}).strict();
export type Format5SequenceRoot=z.infer<typeof format5SequenceRootSchema>;
export type Format5SubjectCard=z.infer<typeof format5SubjectCardSchema>;
/** Existing node records retain their format-4 grammar at their domain reader. */
export interface Format5LegacyNode {
  id:string;projectId:string;type:'text'|'image'|'video'|'audio'|'previs';
  assetId?:string|null;[key:string]:unknown;
}
export type Format5Node=Format5SequenceRoot|Format5SubjectCard|Format5LegacyNode;

export const FORMAT5_REFERENCE_ROLES=Object.freeze([
  'first_frame','last_frame','reference_image','composition','reference_audio',
  'reference_video','subject_reference','style_reference',
] as const);
const edgeFields={id,projectId:id,source:id,target:id,createdAt:timestamp};
export const format5SequenceEdgeSchema=z.object({...edgeFields,kind:z.literal('sequence')}).strict();
const materialReference=z.object({...edgeFields,kind:z.literal('reference'),
  role:z.enum(['first_frame','last_frame','reference_image','composition','reference_audio','reference_video']),
  sourceAssetId:id,orderIndex:z.number().int().safe().nonnegative().optional(),
}).strict();
const subjectReference=z.object({...edgeFields,kind:z.literal('reference'),
  role:z.enum(['subject_reference','style_reference']),subjectBindingId:id,
  orderIndex:z.number().int().safe().nonnegative().optional(),
}).strict();
export const format5EdgeSchema=z.union([format5SequenceEdgeSchema,materialReference,subjectReference]);
export type Format5Edge=z.infer<typeof format5EdgeSchema>;

export const format5SequenceSourceSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('shot'),nodeId:id,segmentGroupId:id,versionMode:z.enum(['follow','locked'])}).strict(),
  z.object({kind:z.literal('media'),nodeId:id,segmentGroupId:id}).strict(),
]);
export type Format5SequenceSource=z.infer<typeof format5SequenceSourceSchema>;
export const format5AnchorSchema=z.object({clipId:id,offsetFrames:frame}).strict().nullable();
export type Format5Anchor=z.infer<typeof format5AnchorSchema>;
export const format5DialogueRefSchema=z.object({shotId:id,lineId:id}).strict().nullable();
export type Format5DialogueRef=z.infer<typeof format5DialogueRefSchema>;
export const format5DialogueSchema=z.array(z.object({
  id,text:z.string().superRefine((value,context)=>{
    const issue=getTimelineSubtitleTextIssue(value);
    if(issue)context.addIssue({code:z.ZodIssueCode.custom,message:issue.message});
  }),speakerSubjectId:id.optional(),
}).strict()).max(FORMAT5_LIMITS.subtitleCues).refine(lines=>new Set(lines.map(line=>line.id)).size===lines.length,'Dialogue line IDs must be unique');
export type Format5Dialogue=z.infer<typeof format5DialogueSchema>;
export const format5BindingModeSchema=z.enum(['follow','locked','detached']);
export type Format5BindingMode=z.infer<typeof format5BindingModeSchema>;
export const format5SubjectBindingSchema=z.object({
  id,projectId:id,shotId:id,subjectId:id,role:z.enum(['subject','style']),revision,
  bindingMode:format5BindingModeSchema,subjectVersionId:id.nullable(),reviewedHeadVersionId:id.nullable(),
  createdAt:timestamp,updatedAt:timestamp,
}).strict().refine(value=>value.bindingMode==='locked'?value.subjectVersionId!==null:value.subjectVersionId===null,
  'Only a locked subject binding stores an applied version');
export type Format5SubjectBinding=z.infer<typeof format5SubjectBindingSchema>;

export interface Format5Clip extends Omit<TimelineClipRecord,'assetId'|'versionId'|'jobId'> {
  id:string;trackId:string;name:string;startFrame:number;durationFrames:number;sourceInFrame:number;
  rect:TimelineClipRecord['rect'];gain:number;
  assetId:string|null;versionId?:string|null;jobId?:string|null;shotId?:string;
  sourceState:'ready'|'placeholder';sequenceSource?:Format5SequenceSource;anchor?:Format5Anchor;
  timing?:TimelineClipRecord['timing'];sourceSpanFrames?:number;
  fadeInFrames?:number;fadeOutFrames?:number;transitionIn?:unknown;
  /** Per-clip mute of the clip's own sound. Only stored as `true`; absence means
   * audible. Format 3/4 rows never carry it. */
  muted?:boolean;
  /** Audio-track clip that plays only the sound of a video source. The only
   * legal way for an audio track to reference a video asset. */
  soundOnly?:boolean;
}
export interface Format5Cue {
  id:string;text:string;startFrame:number;durationFrames:number;
  anchor:Format5Anchor;dialogueRef?:Format5DialogueRef;
}
export interface Format5Timeline extends Omit<TimelineRecord,'tracks'|'clips'|'subtitles'> {
  id:string;projectId:string;revision:number;fps:number;width:number;height:number;
  durationFrames:number;createdAt:string;updatedAt:string;
  tracks:TimelineTrackRecord[];clips:Format5Clip[];
  mainTrack:{trackId:string;sequenceNodeId:string};
  subtitles?:{profileId:string;basisPresetId?:string;cues:Format5Cue[]};
}

const boardEntry=z.discriminatedUnion('kind',[
  z.object({nodeId:id,kind:z.literal('shot'),selectedVersionId:id.nullable()}).strict(),
  z.object({nodeId:id,kind:z.literal('media'),assetId:id}).strict(),
]);
const trackEntry=z.discriminatedUnion('kind',[
  z.object({nodeId:id,segmentGroupId:id,clipId:id,kind:z.literal('shot'),versionMode:z.enum(['follow','locked']),appliedVersionId:id.nullable()}).strict(),
  z.object({nodeId:id,segmentGroupId:id,clipId:id,kind:z.literal('media'),assetId:id}).strict(),
]);
export const format5SyncBaselineSchema=z.object({
  version:z.literal(1),board:z.array(boardEntry).max(FORMAT5_LIMITS.mainTrackClips),
  track:z.array(trackEntry).max(FORMAT5_LIMITS.mainTrackClips),
}).strict().superRefine((value,context)=>{
  if(new Set(value.board.map(item=>item.nodeId)).size!==value.board.length||
      new Set(value.track.map(item=>item.clipId)).size!==value.track.length||
      new TextEncoder().encode(JSON.stringify(value)).byteLength>FORMAT5_LIMITS.baselineBytes)
    context.addIssue({code:z.ZodIssueCode.custom,message:'Invalid synchronization baseline identities or byte budget'});
  const groupOwners=new Map<string,string>(),nodeGroups=new Map<string,string>();
  let previous:string|undefined;
  for(const item of value.track){
    if(groupOwners.has(item.segmentGroupId)&&groupOwners.get(item.segmentGroupId)!==item.nodeId||
        nodeGroups.has(item.nodeId)&&(previous!==item.nodeId||nodeGroups.get(item.nodeId)!==item.segmentGroupId)||
        item.kind==='shot'&&item.versionMode==='locked'&&item.appliedVersionId===null){
      context.addIssue({code:z.ZodIssueCode.custom,message:'Invalid synchronization baseline segment group'});
      break;
    }
    groupOwners.set(item.segmentGroupId,item.nodeId);nodeGroups.set(item.nodeId,item.segmentGroupId);previous=item.nodeId;
  }
});
export type Format5SyncBaseline=z.infer<typeof format5SyncBaselineSchema>;

export const FORMAT5_STORAGE_ERROR_CODES=Object.freeze([
  'FORMAT5_TIMELINE_INVALID','FORMAT5_TRACK_INVALID','FORMAT5_MAIN_TRACK_INVALID','FORMAT5_CLIP_INVALID',
  'FORMAT5_SEQUENCE_SOURCE_INVALID','FORMAT5_ANCHOR_INVALID','FORMAT5_PLACEHOLDER_INVALID','FORMAT5_SOURCE_INVALID',
  'FORMAT5_CAPACITY','FORMAT5_DURATION_INVALID','FORMAT5_TRACK_OVERLAP','FORMAT5_MAIN_TRACK_GAP',
  'FORMAT5_SEGMENT_GROUP_INVALID','FORMAT5_SUBTITLES_INVALID','FORMAT5_DIALOGUE_INVALID','FORMAT5_DIALOGUE_DUPLICATE',
  'FORMAT5_SUBTITLE_OVERLAP','FORMAT5_NODE_INVALID','FORMAT5_GRAPH_IDENTITY_INVALID','FORMAT5_NODE_SOURCE_INVALID',
  'FORMAT5_EDGE_INVALID','FORMAT5_SUBJECT_CARD_DUPLICATE','FORMAT5_REFERENCE_ROLE_INVALID','FORMAT5_REFERENCE_CARDINALITY',
  'FORMAT5_ADOPTION_INVALID','FORMAT5_ADOPTION_IMMUTABLE','FORMAT5_SUBJECT_BINDING_INVALID','FORMAT5_VERSION_INVALID',
  'FORMAT5_SYNC_STATE_INVALID','FORMAT5_SYNC_REVISION_CONFLICT',
] as const);
export type Format5ErrorCode=(typeof FORMAT5_STORAGE_ERROR_CODES)[number]|BoardSequenceErrorCode|MainTrackErrorCode|'CHAIN_TRACK_MISMATCH';
export interface Format5Issue {code:Format5ErrorCode;message:string;ids?:readonly string[]}
type RecordValue=Record<string,unknown>;
const object=(value:unknown):value is RecordValue=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fields=(required:readonly string[],optional:readonly string[]=[])=>{
  const allowed=new Set([...required,...optional]);
  return (value:unknown):value is RecordValue=>object(value)&&required.every(key=>Object.hasOwn(value,key))&&
    Object.keys(value).every(key=>allowed.has(key));
};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const integer=(value:unknown,min:number,max:number):value is number=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;
const issue=(code:Format5ErrorCode,message:string,ids?:readonly string[]):Format5Issue=>({code,message,...(ids?{ids}:{})});
const timelineFields=fields(['id','projectId','revision','fps','width','height','tracks','clips','durationFrames','createdAt','updatedAt','mainTrack'],['subtitles']);
const headerFields=fields(['id','projectId','revision','fps','width','height','tracks','durationFrames','createdAt','updatedAt','mainTrack'],['subtitles']);
const mainTrackFields=fields(['trackId','sequenceNodeId']);
const trackFields=fields(['id','name','kind','orderIndex','hidden','muted']);
const clipFields=fields(['id','trackId','assetId','name','startFrame','durationFrames','sourceInFrame','rect','gain','sourceState'],
  ['versionId','shotId','jobId','fadeInFrames','fadeOutFrames','colour','audioRole','volumeEnvelope','transform','transitionIn','layout','sequenceSource','anchor','muted','soundOnly','timing','sourceSpanFrames']);
const fixedSubtitleFields=fields(['profileId','cues']);
const relativeSubtitleFields=fields(['profileId','basisPresetId','cues']);
const headerFixedSubtitleFields=fields(['profileId']);
const headerRelativeSubtitleFields=fields(['profileId','basisPresetId']);
const cueFields=fields(['id','text','startFrame','durationFrames','anchor'],['dialogueRef']);

function clipEffectsValid(clip:RecordValue,frame:unknown,kind:unknown):boolean {
  if(!isClipLayoutRect(clip,frame)||typeof clip.gain!=='number'||!Number.isFinite(clip.gain)||clip.gain<0||clip.gain>2)return false;
  const effectFrameLimit=Object.hasOwn(clip,'timing')?FORMAT5_LIMITS.durationFrames:undefined;
  if(Object.hasOwn(clip,'audioRole')&&!isClipAudioRole(clip.audioRole)||
      Object.hasOwn(clip,'volumeEnvelope')&&!isVolumeEnvelope(clip.volumeEnvelope,clip.durationFrames as number,effectFrameLimit)||
      Object.hasOwn(clip,'transform')&&(clip.transform===null||!isClipTransform(clip.transform,clip.durationFrames as number,effectFrameLimit)||kind!=='video')||
      Object.hasOwn(clip,'transitionIn')&&(clip.transitionIn===null||!isClipTransition(clip.transitionIn)||kind!=='video')||
      Object.hasOwn(clip,'colour')&&(!isTimelineClipColour(clip.colour)||clip.colour!==null&&kind!=='video')||
      Object.hasOwn(clip,'muted')&&clip.muted!==true||
      Object.hasOwn(clip,'soundOnly')&&(clip.soundOnly!==true||kind!=='audio'))return false;
  for(const key of ['fadeInFrames','fadeOutFrames'])if(Object.hasOwn(clip,key)&&!integer(clip[key],0,clip.durationFrames as number))return false;
  return Number(clip.fadeInFrames??0)+Number(clip.fadeOutFrames??0)<=(clip.durationFrames as number);
}

/** Entity that owns the shape of one persisted timeline row. The frame-only
 * helpers are the same checks the whole-timeline contract runs, so a row write
 * and a read projection never diverge on grammar or error codes. */
export function getFormat5TrackIssue(track:unknown):Format5Issue|null {
  if(!trackFields(track)||!uuid(track.id)||!text(track.name,150)||
      !['video','audio'].includes(String(track.kind))||!integer(track.orderIndex,0,11)||
      typeof track.hidden!=='boolean'||typeof track.muted!=='boolean'||track.kind==='audio'&&track.hidden)
    return issue('FORMAT5_TRACK_INVALID','Invalid format-5 track');
  return null;
}

export interface Format5ClipIssueContext {
  readonly width:number;
  readonly height:number;
  readonly fps:number;
  readonly trackKind:'video'|'audio'|undefined;
  readonly main:boolean;
  readonly formatVersion?:number | undefined;
}
export function getFormat5ClipIssue(clip:unknown,context:Format5ClipIssueContext):Format5Issue|null {
  if(!clipFields(clip)||!uuid(clip.id)||!uuid(clip.trackId)||!text(clip.name,200)||
      !integer(clip.startFrame,0,FORMAT5_LIMITS.durationFrames)||
      !integer(clip.durationFrames,1,FORMAT5_LIMITS.durationFrames)||
      clip.startFrame+clip.durationFrames>FORMAT5_LIMITS.durationFrames||
      !integer(clip.sourceInFrame,0,Number.MAX_SAFE_INTEGER-FORMAT5_LIMITS.durationFrames)||
      !clipEffectsValid(clip,{width:context.width,height:context.height,fps:context.fps},context.trackKind))
    return issue('FORMAT5_CLIP_INVALID','Invalid format-5 clip');
  const main=context.main;
  if(main){
    if(!format5SequenceSourceSchema.safeParse(clip.sequenceSource).success||Object.hasOwn(clip,'anchor'))
      return issue('FORMAT5_SEQUENCE_SOURCE_INVALID','Invalid main-track sequence source',[clip.id]);
  }else if(Object.hasOwn(clip,'sequenceSource')||!format5AnchorSchema.safeParse(clip.anchor).success)
    return issue('FORMAT5_ANCHOR_INVALID','Other-track clips must carry an explicit anchor',[clip.id]);
  if(clip.sourceState==='placeholder'){
    if(main){
      if(!object(clip.sequenceSource)||clip.sequenceSource.kind!=='shot'||clip.sequenceSource.versionMode!=='follow'||
          clip.assetId!==null||clip.versionId!==null||clip.jobId!==null||clip.sourceInFrame!==0||
          Object.hasOwn(clip,'shotId')&&clip.shotId!==clip.sequenceSource.nodeId)
        return issue('FORMAT5_PLACEHOLDER_INVALID','A placeholder must reference an ungenerated shot',[clip.id]);
    }else if(!uuid(clip.shotId)||!format5AnchorSchema.safeParse(clip.anchor).success||
        clip.assetId!==null||clip.versionId!==null||clip.jobId!==null||clip.sourceInFrame!==0||Object.hasOwn(clip,'sequenceSource'))
      return issue('FORMAT5_PLACEHOLDER_INVALID','An other-track placeholder must reference its ungenerated shot and owner',[clip.id]);
  }else if(clip.sourceState!=='ready'||!uuid(clip.assetId)||
      ['versionId','shotId','jobId'].some(key=>Object.hasOwn(clip,key)&&!uuid(clip[key]))||
      main&&object(clip.sequenceSource)&&clip.sequenceSource.kind==='shot'&&!uuid(clip.versionId))
    return issue('FORMAT5_SOURCE_INVALID','Invalid ready clip source',[clip.id]);
  if(Object.hasOwn(clip,'timing')||Object.hasOwn(clip,'sourceSpanFrames')){
    const parsed=clipTimingSchema.safeParse(clip.timing);
    if((context.formatVersion!==undefined&&context.formatVersion!==6)||!parsed.success||clip.sourceState!=='ready'||
        !integer(clip.sourceSpanFrames,1,MAX_CLIP_SOURCE_SPAN_FRAMES))
      return issue('FORMAT5_CLIP_INVALID','Invalid clip timing fields',[clip.id]);
    const timed={...clip,id:clip.id,startFrame:clip.startFrame,durationFrames:clip.durationFrames,
      sourceInFrame:clip.sourceInFrame,timing:parsed.data};
    const plan=compileClipTimeMap(timed,{fps:context.fps});
    const projected=plan.ok?projectTimeMapToCurrentClipFields(timed,plan.value):plan;
    if(!projected.ok||projected.value.sourceInFrame!==clip.sourceInFrame||
        projected.value.durationFrames!==clip.durationFrames||projected.value.sourceSpanFrames!==clip.sourceSpanFrames)
      return issue('FORMAT5_CLIP_INVALID','Clip timing projection does not match its frame fields',[clip.id]);
    if(parsed.data.profile==='timeline-freeze-v1'&&(context.trackKind!=='video'||clip.muted!==true||
        parsed.data.sourceVersionId!==(clip.versionId??null)||
        (main&&(clip.sequenceSource as Format5SequenceSource).kind==='shot'&&
          (clip.sequenceSource as {versionMode?:string}).versionMode!=='locked')))
      return issue('FORMAT5_SOURCE_INVALID','Freeze frame requires its locked, muted source',[clip.id]);
  }
  return null;
}

/** Syntax-only checks of one persisted cue. Owner/anchor cross-row checks stay
 * in the timeline and full-state validators. */
export function getFormat5CueIssue(cue:unknown,{durationFrames}:{readonly durationFrames:number}):Format5Issue|null {
  if(!cueFields(cue)||!uuid(cue.id)||
      !integer(cue.startFrame,0,durationFrames)||!integer(cue.durationFrames,1,durationFrames)||
      cue.startFrame+cue.durationFrames>durationFrames||
      !format5AnchorSchema.safeParse(cue.anchor).success||getTimelineSubtitleTextIssue(cue.text))
    return issue('FORMAT5_SUBTITLES_INVALID','Invalid format-5 subtitle cue');
  if(Object.hasOwn(cue,'dialogueRef')&&!format5DialogueRefSchema.safeParse(cue.dialogueRef).success)
    return issue('FORMAT5_DIALOGUE_INVALID','Invalid subtitle dialogue reference',[cue.id]);
  return null;
}

export interface Format5TimelineHeader extends Omit<TimelineRecord,'tracks'|'clips'|'subtitles'> {
  id:string;projectId:string;revision:number;fps:number;width:number;height:number;
  durationFrames:number;createdAt:string;updatedAt:string;
  tracks:TimelineTrackRecord[];
  mainTrack:{trackId:string;sequenceNodeId:string};
  subtitles?:{profileId:string;basisPresetId?:string};
}

/** The persisted `timelines.data` value. Clips and cues are native rows, so the
 * header never carries either array. */
export function format5TimelineHeader(value:Format5Timeline):Format5TimelineHeader {
  const {clips:_clips,subtitles,...rest}=value;
  const header:{[key:string]:unknown}={...rest};
  if(subtitles!==undefined){const {cues:_cues,...profile}=subtitles as {profileId:string;basisPresetId?:string;cues:unknown};header.subtitles=profile;}
  return header as Format5TimelineHeader;
}

/** Header-only validation used by the commit fence before scanning row state. */
export function getFormat5TimelineHeaderIssue(value:unknown,{projectId}:{projectId?:string}={}):Format5Issue|null {
  if(!headerFields(value)||!uuid(value.id)||!uuid(value.projectId)||
      projectId!==undefined&&value.projectId!==projectId||!integer(value.revision,1,Number.MAX_SAFE_INTEGER)||
      !timelineOutputPreset(value)||!integer(value.durationFrames,0,FORMAT5_LIMITS.durationFrames)||
      !timestamp.safeParse(value.createdAt).success||!timestamp.safeParse(value.updatedAt).success||
      !mainTrackFields(value.mainTrack)||!uuid(value.mainTrack.trackId)||!uuid(value.mainTrack.sequenceNodeId)||
      !Array.isArray(value.tracks)||value.tracks.length<1||value.tracks.length>FORMAT5_LIMITS.tracks)
    return issue('FORMAT5_TIMELINE_INVALID','Invalid format-5 timeline record');
  const tracks=new Map<string,RecordValue>();
  for(const track of value.tracks){
    if(!object(track)||tracks.has(String(track.id))||getFormat5TrackIssue(track))return issue('FORMAT5_TRACK_INVALID','Invalid format-5 track');
    tracks.set(String(track.id),track);
  }
  if(tracks.get(value.mainTrack.trackId)?.kind!=='video')return issue('FORMAT5_MAIN_TRACK_INVALID','The main track must be a video track');
  if(Object.hasOwn(value,'subtitles')){
    const subtitles=value.subtitles;
    if(!object(subtitles)||Object.hasOwn(subtitles,'cues')||
        !((subtitles.profileId===TIMELINE_SUBTITLE_PROFILE_ID&&headerFixedSubtitleFields(subtitles))||
          (subtitles.profileId===TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID&&headerRelativeSubtitleFields(subtitles)&&
           typeof subtitles.basisPresetId==='string'&&timelineOutputPreset(subtitles.basisPresetId))))
      return issue('FORMAT5_SUBTITLES_INVALID','Invalid format-5 subtitle layout or capacity');
  }
  return null;
}

/** Validate persisted editing structure, without resolving any filesystem source. */
export function getFormat5TimelineIssue(value:unknown,{projectId,formatVersion}:{projectId?:string;formatVersion?:number|undefined}={}):Format5Issue|null {
  if(!timelineFields(value)||!uuid(value.id)||!uuid(value.projectId)||
      projectId!==undefined&&value.projectId!==projectId||!integer(value.revision,1,Number.MAX_SAFE_INTEGER)||
      !timelineOutputPreset(value)||!integer(value.durationFrames,0,FORMAT5_LIMITS.durationFrames)||
      !timestamp.safeParse(value.createdAt).success||!timestamp.safeParse(value.updatedAt).success||
      !mainTrackFields(value.mainTrack)||!uuid(value.mainTrack.trackId)||!uuid(value.mainTrack.sequenceNodeId)||
      !Array.isArray(value.tracks)||value.tracks.length<1||value.tracks.length>FORMAT5_LIMITS.tracks||
      !Array.isArray(value.clips)||value.clips.length>FORMAT5_LIMITS.mainTrackClips+FORMAT5_LIMITS.otherTrackClips)
    return issue('FORMAT5_TIMELINE_INVALID','Invalid format-5 timeline record');
  const tracks=new Map<string,RecordValue>(),byTrack=new Map<string,RecordValue[]>(),clipIds=new Set<string>();
  for(const track of value.tracks){
    if(!object(track)||tracks.has(String(track.id))||getFormat5TrackIssue(track))return issue('FORMAT5_TRACK_INVALID','Invalid format-5 track');
    tracks.set(String(track.id),track);byTrack.set(String(track.id),[]);
  }
  if(tracks.get(value.mainTrack.trackId)?.kind!=='video')return issue('FORMAT5_MAIN_TRACK_INVALID','The main track must be a video track');
  let duration=0,mainCount=0;
  for(const clip of value.clips){
    if(clipIds.has(String((clip as RecordValue)?.id))||!uuid((clip as RecordValue)?.trackId)||!tracks.has(String((clip as RecordValue)?.trackId)))
      return issue('FORMAT5_CLIP_INVALID','Invalid format-5 clip');
    const main=(clip as RecordValue).trackId===value.mainTrack.trackId;
    const problem=getFormat5ClipIssue(clip,{width:value.width as number,height:value.height as number,fps:value.fps as number,trackKind:tracks.get(String((clip as RecordValue).trackId))?.kind as 'video'|'audio'|undefined,main,formatVersion});
    if(problem)return problem;
    if(main)mainCount++;
    clipIds.add(String((clip as RecordValue).id));
    byTrack.get(String((clip as RecordValue).trackId))!.push(clip as RecordValue);
    duration=Math.max(duration,Number((clip as RecordValue).startFrame)+Number((clip as RecordValue).durationFrames));
  }
  if(mainCount>FORMAT5_LIMITS.mainTrackClips||value.clips.length-mainCount>FORMAT5_LIMITS.otherTrackClips)
    return issue('FORMAT5_CAPACITY','The format-5 editing capacity was exceeded');
  if(duration!==value.durationFrames)return issue('FORMAT5_DURATION_INVALID','Timeline duration must match its clips');
  for(const clips of byTrack.values()){
    clips.sort((a,b)=>(a.startFrame as number)-(b.startFrame as number)||String(a.id).localeCompare(String(b.id)));
    for(let index=1;index<clips.length;index++)if((clips[index]!.startFrame as number)<(clips[index-1]!.startFrame as number)+(clips[index-1]!.durationFrames as number))
      return issue('FORMAT5_TRACK_OVERLAP','Clips overlap on the same track',[String(clips[index-1]!.id),String(clips[index]!.id)]);
  }
  const mainClips=byTrack.get(value.mainTrack.trackId)!;
  const groupOwners=new Map<string,string>(),nodeGroups=new Map<string,string>();
  let nextFrame=0,previousNode:string|undefined;
  for(const clip of mainClips){
    const source=clip.sequenceSource as Format5SequenceSource;
    if(clip.startFrame!==nextFrame)return issue('FORMAT5_MAIN_TRACK_GAP','The main track must be packed from frame zero',[String(clip.id)]);
    if(groupOwners.has(source.segmentGroupId)&&groupOwners.get(source.segmentGroupId)!==source.nodeId||
        nodeGroups.has(source.nodeId)&&(previousNode!==source.nodeId||nodeGroups.get(source.nodeId)!==source.segmentGroupId))
      return issue('FORMAT5_SEGMENT_GROUP_INVALID','A sequence node must occupy one contiguous segment group',[String(clip.id)]);
    groupOwners.set(source.segmentGroupId,source.nodeId);nodeGroups.set(source.nodeId,source.segmentGroupId);
    previousNode=source.nodeId;nextFrame+=clip.durationFrames as number;
  }
  const mainById=new Map(mainClips.map(clip=>[clip.id,clip]));
  const validAnchor=(item:RecordValue,syntaxChecked=false):boolean=>{
    if(item.anchor===null)return true;
    if(!syntaxChecked&&!format5AnchorSchema.safeParse(item.anchor).success||!object(item.anchor))return false;
    const owner=mainById.get(item.anchor.clipId);
    return owner!==undefined&&(item.anchor.offsetFrames as number)<(owner.durationFrames as number)&&
      item.startFrame===(owner.startFrame as number)+(item.anchor.offsetFrames as number);
  };
  // Other-track syntax passed above; the unchanged records still need every
  // owner/offset check here, after the existing packing and overlap checks.
  for(const clip of value.clips)if(clip.trackId!==value.mainTrack.trackId&&!validAnchor(clip as RecordValue,true))
    return issue('FORMAT5_ANCHOR_INVALID','Clip anchor does not identify its current main-track offset',[String(clip.id)]);
  if(Object.hasOwn(value,'subtitles')){
    const error=subtitleIssue(value.subtitles,value.durationFrames,validAnchor);
    if(error)return error;
  }
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>FORMAT5_LIMITS.timelineBytes)
    return issue('FORMAT5_CAPACITY','The format-5 timeline byte budget was exceeded');
  return null;
}

function subtitleIssue(value:unknown,duration:number,validAnchor:(item:RecordValue)=>boolean):Format5Issue|null {
  if(!object(value)||!Array.isArray(value.cues)||value.cues.length>FORMAT5_LIMITS.subtitleCues||
      !(value.profileId===TIMELINE_SUBTITLE_PROFILE_ID&&fixedSubtitleFields(value)||
        value.profileId===TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID&&relativeSubtitleFields(value)&&
        typeof value.basisPresetId==='string'&&timelineOutputPreset(value.basisPresetId)))
    return issue('FORMAT5_SUBTITLES_INVALID','Invalid format-5 subtitle layout or capacity');
  const ids=new Set<string>(),dialogue=new Set<string>();
  for(const cue of value.cues){
    const problem=getFormat5CueIssue(cue,{durationFrames:duration});
    if(problem||ids.has(String((cue as RecordValue)?.id)))return issue('FORMAT5_SUBTITLES_INVALID','Invalid format-5 subtitle cue');
    if(!validAnchor(cue as RecordValue))return issue('FORMAT5_SUBTITLES_INVALID','Invalid format-5 subtitle cue');
    if(Object.hasOwn(cue as RecordValue,'dialogueRef')&&(cue as RecordValue).dialogueRef!==null){
      const ref=(cue as RecordValue).dialogueRef as Exclude<Format5DialogueRef,null>,key=ref.shotId+'/'+ref.lineId;
      if(dialogue.has(key))return issue('FORMAT5_DIALOGUE_DUPLICATE','A dialogue line may appear only once per timeline',[String((cue as RecordValue).id)]);
      dialogue.add(key);
    }
    ids.add(String((cue as RecordValue).id));
  }
  const cues=[...value.cues as RecordValue[]].sort((a,b)=>(a.startFrame as number)-(b.startFrame as number));
  for(let index=1;index<cues.length;index++)if((cues[index]!.startFrame as number)<(cues[index-1]!.startFrame as number)+(cues[index-1]!.durationFrames as number))
    return issue('FORMAT5_SUBTITLE_OVERLAP','Subtitle cues overlap',[String(cues[index-1]!.id),String(cues[index]!.id)]);
  return null;
}

export const isFormat5Timeline=(value:unknown,options:{projectId?:string}={}):value is Format5Timeline=>getFormat5TimelineIssue(value,options)===null;
export function assertFormat5Timeline(value:unknown,options:{projectId?:string}={}):asserts value is Format5Timeline {
  const error=getFormat5TimelineIssue(value,options);
  if(error)throw Object.assign(new Error(error.message),{code:error.code,ids:error.ids??[]});
}
