import {createVolumeEnvelopeEvaluator, type VolumeEnvelope, type VolumeEnvelopeClip} from './timeline-volume-envelope.ts';
import {isVolumeEnvelope,isVolumeEnvelopeProcessingSnapshot} from './timeline-volume-envelope-processing.ts';
import {isClipAudioRole} from './timeline-audio-role.ts';
import {isTimelineClipColour} from './timeline-colour.ts';
import {createTimelineLoudnessApplyContracts,TIMELINE_LOUDNESS_APPLY_OPERATION,hasTimelineLoudnessApplyNotAppliedProof} from './timeline-loudness-apply.ts';
import {createTimelineShotSyncContracts,hasTimelineShotSyncNotAppliedProof,TIMELINE_SHOT_SYNC_OPERATIONS} from './timeline-shot-sync.ts';
import {createTimelineSceneSplitContracts,hasTimelineSceneSplitNotAppliedProof,TIMELINE_SCENE_SPLIT_OPERATION} from './timeline-scene-split.ts';
import {createTimelineCrossfadeContracts,hasTimelineCrossfadeNotAppliedProof,TIMELINE_CROSSFADE_OPERATION} from './timeline-crossfade.ts';
import {createTimelineClipGainsContracts,hasTimelineClipGainsNotAppliedProof,TIMELINE_CLIP_GAINS_OPERATION} from './timeline-clip-gains.ts';
import {isTimelineExportRangeInput,isTimelineExportRangeProofInput,hasTimelineExportRangeBoundsProof} from './timeline-export-range.ts';
import {isTimelineExportAudioOutcome} from './timeline-export-float.ts';
import {isTimelineDeliveryNameInput} from './timeline-delivery.ts';
import {isTimelineExportSnapshot,timelineExportSettingsSchema,TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES} from './timeline-export-profile.ts';
import {TIMELINE_SUBTITLE_OPERATIONS,timelineSubtitleSchemas,isTimelineSubtitleSnapshotProfile} from './timeline-subtitles.ts';
import {timelineFormatSchemas,timelineOutputPreset} from './timeline-format.ts';
import {isTimelineRecord, isTimelineReplacementResponse, type TimelineRecord, type TimelineClipRecord} from './timeline-replacement.ts';
import {sourceFrameCount} from './source-range.ts';
import {SUBJECT_MUTATION_OPERATIONS} from './subjects.ts';
import {REFERENCE_MUTATION_OPERATIONS} from './reference-acknowledgement.ts';
import {type z} from 'zod';

type Rec = Record<string, unknown>;
const object = (value: unknown): value is Rec => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max;
const fields = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Rec => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const timestamp = (value: unknown): value is string => text(value, 1, 64) && Number.isFinite(Date.parse(value));
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const encoder = new TextEncoder();
const baseFields = ['projectId', 'expectedRevision', 'requestId'];
const clipFields = ['trackId', 'name', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain', 'fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole', 'volumeEnvelope'];
const provenance = ['versionId', 'shotId', 'jobId'];
const same = (a: unknown, b: unknown): boolean => object(a) && object(b)
  ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
  : a === b;
// Only this typed field compares arrays. Other legacy array semantics stay closed.
const sameVolumeEnvelope = (a: unknown, b: unknown): boolean => {
  if(a===null||b===null)return a===b;
  if(!isVolumeEnvelope(a,18000)||!isVolumeEnvelope(b,18000))return false;
  const left = a as VolumeEnvelope, right = b as VolumeEnvelope;
  return left.profileId===right.profileId && left.points.length===right.points.length &&
    left.points.every((point,index)=>point.frame===right.points[index].frame&&point.multiplier===right.points[index].multiplier);
};
const hasFields = (value: unknown, input: unknown, keys: readonly string[]): boolean => keys.every(key => (input as Rec)[key] === undefined ||
  (key==='volumeEnvelope'?sameVolumeEnvelope((value as Rec)[key],(input as Rec)[key]):same((value as Rec)[key], (input as Rec)[key])));
const baseInput = (input: unknown): boolean => object(input) && uuid(input.projectId) && text(input.requestId, 8, 200) && integer(input.expectedRevision, 1);
const operationInput = (input: unknown, required: readonly string[] = [], optional: readonly string[] = []): boolean => baseInput(input) && fields(input, [...baseFields, ...required], optional);
const patchInput = (patch: unknown, allowed: readonly string[]): boolean => object(patch) && Object.keys(patch).length > 0 && Object.keys(patch).every(key => allowed.includes(key) && patch[key] !== undefined);

// Split children do not share point arrays. They must retain the same field
// presence and null semantics, and meet at the exact interpolated boundary.
function splitEnvelopeMatches(left: unknown,right: unknown): boolean {
 if(Object.hasOwn(left as object,'volumeEnvelope')!==Object.hasOwn(right as object,'volumeEnvelope'))return false;
 if(!Object.hasOwn(left as object,'volumeEnvelope'))return true;
 const leftClip = left as {volumeEnvelope?: unknown; durationFrames?: unknown}, rightClip = right as {volumeEnvelope?: unknown};
 if(leftClip.volumeEnvelope===null||rightClip.volumeEnvelope===null)return leftClip.volumeEnvelope===rightClip.volumeEnvelope;
 try{return createVolumeEnvelopeEvaluator(left as unknown as VolumeEnvelopeClip).limitAtSample((leftClip.durationFrames as number)*1600)===createVolumeEnvelopeEvaluator(right as unknown as VolumeEnvelopeClip).limitAtSample(0);}catch{return false;}
}

export const TIMELINE_MUTATION_OPERATIONS = Object.freeze([
  'timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.update',
  'timeline.clip.replaceSource', 'timeline.clip.remove', 'timeline.clip.rippleRemove', 'timeline.clip.split', 'timeline.seed',
  'timeline.undo', 'timeline.redo', 'timeline.render', 'timeline.format.set',
  ...TIMELINE_SUBTITLE_OPERATIONS, TIMELINE_LOUDNESS_APPLY_OPERATION, ...TIMELINE_SHOT_SYNC_OPERATIONS, TIMELINE_SCENE_SPLIT_OPERATION, TIMELINE_CROSSFADE_OPERATION, TIMELINE_CLIP_GAINS_OPERATION,
]);
export const TIMELINE_RENDER_RESPONSE_BYTES = 4 * 1024 * 1024;

// Identity and source-intent checks that can be verified without the previous
// aggregate. Ownership, exact history transitions and immutable receipt hashes
// are additionally checked by the backend. No validator edits the supplied data.
const loudnessApplyContracts=createTimelineLoudnessApplyContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});
const shotSyncContracts=createTimelineShotSyncContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});
const sceneSplitContracts=createTimelineSceneSplitContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});
const crossfadeContracts=createTimelineCrossfadeContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});
const clipGainsContracts=createTimelineClipGainsContracts({isTimelineRecord: (value, options) => isTimelineRecord(value, options)});
export function isTimelineMutationResponse(operation: unknown, input: unknown, value: unknown): boolean {
  const request = input as Rec;
  if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return loudnessApplyContracts.isTimelineLoudnessApplyResponse(value,input);
  if((TIMELINE_SHOT_SYNC_OPERATIONS as readonly unknown[]).includes(operation))return shotSyncContracts.isTimelineShotSyncResponse(operation,input,value);
  if(operation===TIMELINE_SCENE_SPLIT_OPERATION)return sceneSplitContracts.isTimelineSceneSplitResponse(value,input);
  if(operation===TIMELINE_CROSSFADE_OPERATION)return crossfadeContracts.isTimelineCrossfadeResponse(value,input);
  if(operation===TIMELINE_CLIP_GAINS_OPERATION)return clipGainsContracts.isTimelineClipGainsResponse(value,input);
  if(operation==='timeline.format.set') return (timelineFormatSchemas as Record<string, z.ZodTypeAny>)['timeline.format.set'].safeParse(input).success &&
    isTimelineRecord(value,{projectId:request.projectId}) && (value as Rec).revision===((request.expectedRevision as number)+1) &&
    timelineOutputPreset(value)?.id===request.presetId && (value as TimelineRecord).clips.length===0 && (value as Rec).durationFrames===0;
  if (!(TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(operation as string) || !baseInput(input)) return false;
  if (operation === 'timeline.render') return operationInput(input, ['purpose'], ['preflightSnapshotHash','exportSettings','deliveryName','exportRange']) && isTimelineRenderRecord(value, input);
  if (request.expectedRevision === Number.MAX_SAFE_INTEGER || !isTimelineRecord(value, {projectId: request.projectId}) || value.revision !== (request.expectedRevision as number) + 1) return false;
  const timeline = value as TimelineRecord;
  const target = timeline.clips.find(clip => clip.id === request.clipId);
  switch (operation) {
    case 'timeline.subtitle.add':
      return (timelineSubtitleSchemas as Record<string, z.ZodTypeAny>)['timeline.subtitle.add'].safeParse(input).success && Boolean((timeline.subtitles as {cues?: {id: string; [key: string]: unknown}[]} | undefined)?.cues?.some(cue => hasFields(cue,request,['text','startFrame','durationFrames'])));
    case 'timeline.subtitle.update':
      return (timelineSubtitleSchemas as Record<string, z.ZodTypeAny>)['timeline.subtitle.update'].safeParse(input).success && Boolean((timeline.subtitles as {cues?: {id: string; [key: string]: unknown}[]} | undefined)?.cues?.some(cue => cue.id===request.cueId && hasFields(cue,request.patch,Object.keys(request.patch as Rec))));
    case 'timeline.subtitle.remove':
      return (timelineSubtitleSchemas as Record<string, z.ZodTypeAny>)['timeline.subtitle.remove'].safeParse(input).success && Boolean(timeline.subtitles) && !(timeline.subtitles as {cues: {id: string}[]}).cues.some(cue => cue.id===request.cueId);
    case 'timeline.clip.replaceSource':
      return operationInput(input, ['clipId', 'assetId'], ['versionId']) && isTimelineReplacementResponse(value, input);
    case 'timeline.track.add': {
      if (!operationInput(input, ['kind'], ['name']) || typeof request.kind !== 'string' || !['video', 'audio'].includes(request.kind) ||
          (request.name !== undefined && !text(request.name, 1, 150))) return false;
      const order = Math.max(...timeline.tracks.map(track => track.orderIndex));
      const name = request.name ?? `${request.kind === 'video' ? 'Video' : 'Audio'} ${timeline.tracks.filter(track => track.kind === request.kind).length}`;
      return timeline.tracks.some(track => track.kind === request.kind && track.name === name && track.orderIndex === order && !track.hidden && !track.muted);
    }
    case 'timeline.track.update': {
      if (!operationInput(input, ['trackId', 'patch']) || !uuid(request.trackId) || !patchInput(request.patch, ['name', 'hidden', 'muted'])) return false;
      const track = timeline.tracks.find(track => track.id === request.trackId);
      return Boolean(track && !(track.kind === 'audio' && Object.hasOwn(request.patch as Rec, 'hidden')) && hasFields(track, request.patch, Object.keys(request.patch as Rec)));
    }
    case 'timeline.clip.add': {
      const optionalClipFields = clipFields.filter(key => !['trackId', 'startFrame', 'durationFrames'].includes(key));
      if (!operationInput(input, ['assetId', 'trackId', 'startFrame', 'durationFrames'], optionalClipFields) || !uuid(request.assetId) || !uuid(request.trackId) || !integer(request.startFrame, 0, 18000) || !integer(request.durationFrames, 1, 18000) || Object.hasOwn(request,'volumeEnvelope')&&!isVolumeEnvelope(request.volumeEnvelope,request.durationFrames)) return false;
      return timeline.clips.some(clip => clip.assetId === request.assetId && hasFields(clip, request, clipFields) &&
        clip.sourceInFrame === (request.sourceInFrame as number | undefined ?? 0) && clip.gain === (request.gain as number | undefined ?? 1) &&
        same(clip.rect, request.rect ?? {x: 0, y: 0, width: timeline.width, height: timeline.height}) &&
        provenance.every(key => !Object.hasOwn(clip, key)) &&
        ['fadeInFrames', 'fadeOutFrames', 'colour', 'audioRole', 'volumeEnvelope'].every(key => (request[key] !== undefined) === Object.hasOwn(clip, key)));
    }
    case 'timeline.clip.update':
      return operationInput(input, ['clipId', 'patch']) === true && uuid(request.clipId) && patchInput(request.patch, clipFields) && Boolean(target && hasFields(target, request.patch, Object.keys(request.patch as Rec)));
    case 'timeline.clip.remove':
    case 'timeline.clip.rippleRemove':
      return operationInput(input, ['clipId']) && uuid(request.clipId) && !target;
    case 'timeline.clip.split':
      if (!operationInput(input, ['clipId', 'atFrame']) || !uuid(request.clipId) || !integer(request.atFrame, 0, 18000) || !target || target.startFrame + target.durationFrames !== request.atFrame || (target.fadeOutFrames ?? 0) !== 0) return false;
      return timeline.clips.some(right => right.id !== target.id && right.startFrame === request.atFrame && splitEnvelopeMatches(target,right) &&
        ['trackId', 'assetId', 'name', 'rect', 'gain', 'colour', 'audioRole', ...provenance].every(key => Object.hasOwn(right, key) === Object.hasOwn(target, key) && same(right[key], target[key])) &&
        (right.sourceInFrame === target.sourceInFrame + target.durationFrames || right.sourceInFrame === 0 && target.sourceInFrame === 0) &&
        (right.fadeInFrames ?? 0) === 0 && ['fadeInFrames', 'fadeOutFrames'].every(key => Object.hasOwn(right, key) === Object.hasOwn(target, key)));
    case 'timeline.seed':
      return operationInput(input) && timeline.clips.length > 0;
    case 'timeline.undo':
    case 'timeline.redo':
      return operationInput(input);
    default: return false;
  }
}

const renderFields = ['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision', 'snapshot', 'status', 'assetId', 'url', 'error', 'createdAt', 'updatedAt'];
const snapshotFields = ['timeline', 'assets'];
const snapshotOptionalFields = ['subtitleProfile','delivery','deliveryName','exportRange','colourPlan','audioRoleProfile','volumeEnvelopeProfile'];
const visualTypes = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'];
const audioTypes = ['audio/wav', 'audio/mpeg', 'audio/mp4'];
const renderError = (value: unknown): boolean => fields(value, ['code', 'message'], ['retryable']) && text(value.code, 1, 200) && text(value.message, 1, 600) && (!Object.hasOwn(value, 'retryable') || typeof value.retryable === 'boolean');

// A progressed export and an immutable acknowledgement share frozen identity.
// Never require the current job status to equal its originally queued status.
// relativePath is removed from public responses; old snapshots may omit either
// relativePath or hasAudio. Those omissions are preserved rather than repaired.
export function isTimelineRenderRecord(value: unknown, input: unknown): boolean {
  const request = input as Rec;
  if (!baseInput(input) || typeof request.purpose !== 'string' || !['preview', 'export'].includes(request.purpose) || !isTimelineDeliveryNameInput(input,request.purpose) || !isTimelineExportRangeInput(input,request.purpose) ||
      (request.preflightSnapshotHash !== undefined && !digest(request.preflightSnapshotHash)) ||
      (request.exportSettings !== undefined && (request.purpose!=='export'||!timelineExportSettingsSchema.safeParse(request.exportSettings).success)) ||
      !fields(value, renderFields, ['renderAttemptId','audioCheck']) || !isTimelineExportAudioOutcome(value) || !uuid((value as Rec).id) || (value as Rec).projectId !== request.projectId || (value as Rec).requestId !== request.requestId ||
      (value as Rec).mode !== 'timeline' || (value as Rec).purpose !== request.purpose || (value as Rec).timelineRevision !== request.expectedRevision ||
      (request.exportId !== undefined && (value as Rec).id !== request.exportId) ||
      !['queued', 'running', 'succeeded', 'failed'].includes((value as Rec).status as string) || !timestamp((value as Rec).createdAt) || !timestamp((value as Rec).updatedAt)) return false;
  const render = value as Rec;
  const snapshot = render.snapshot;
  if (!fields(snapshot, snapshotFields, snapshotOptionalFields) || !isTimelineExportSnapshot(snapshot,{purpose:request.purpose,exportSettings:request.exportSettings,input}) || !isTimelineSubtitleSnapshotProfile(snapshot) || !isVolumeEnvelopeProcessingSnapshot(snapshot)) return false;
  const snapshotRecord = snapshot as Rec;
  const timeline = snapshotRecord.timeline as TimelineRecord;
  if (!isTimelineRecord(timeline, {projectId: request.projectId}) ||
      timeline.revision !== request.expectedRevision || !timeline.clips.length ||
      (request.timelineId !== undefined && timeline.id !== request.timelineId) ||
      !Array.isArray(snapshotRecord.assets) || snapshotRecord.assets.length < 1 || snapshotRecord.assets.length > 100 ||
      !(render.error === null || renderError(render.error))) return false;
  if (render.status === 'succeeded') {
    if (!uuid(render.assetId) || render.url !== `/media/${render.assetId}` || render.error !== null) return false;
  } else if (render.assetId !== null || render.url !== null || render.status === 'failed' && render.error === null) return false;
  const assets = new Map<string, Rec>();
  for (const asset of snapshotRecord.assets as unknown[]) {
    if (!fields(asset, ['id', 'sha256', 'mimeType'], ['duration', 'width', 'height', 'hasAudio', 'relativePath']) ||
        !uuid(asset.id) || assets.has(asset.id) || !digest(asset.sha256) || ![...visualTypes, ...audioTypes].includes(asset.mimeType as string) ||
        (Object.hasOwn(asset, 'duration') && (!Number.isFinite(asset.duration) || (asset.duration as number) < 0)) ||
        ['width', 'height'].some(key => Object.hasOwn(asset, key) && !integer(asset[key], 0)) ||
        (Object.hasOwn(asset, 'hasAudio') && asset.hasAudio !== null && typeof asset.hasAudio !== 'boolean') ||
        (Object.hasOwn(asset, 'relativePath') && (!text(asset.relativePath, 1, 4096) || (asset.relativePath as string).includes('\0')))) return false;
    assets.set(asset.id, asset);
  }
  const tracks = new Map(timeline.tracks.map(track => [track.id, track])), used = new Set<string>();
  for (const clip of timeline.clips) {
    const asset = assets.get(clip.assetId);
    const track = tracks.get(clip.trackId);
    if (!asset || !track || !(track.kind === 'audio' ? audioTypes : visualTypes).includes(asset.mimeType as string)) return false;
    if ((asset.mimeType as string).startsWith('image/') ? clip.sourceInFrame !== 0 : clip.sourceInFrame + clip.durationFrames > (sourceFrameCount(asset.duration) ?? 0)) return false;
    if (clip.volumeEnvelope != null && ((asset.mimeType as string).startsWith('image/') || asset.hasAudio === false)) return false;
    if ((clip.fadeInFrames ?? 0) + (clip.fadeOutFrames ?? 0) > 0 && ((asset.mimeType as string).startsWith('image/') || asset.hasAudio === false)) return false;
    used.add(asset.id as string);
  }
  if (used.size !== assets.size) return false;
  // The optional preflight digest includes private source paths, so only the
  // backend can bind it after publicValue has removed those fields.
  return encoder.encode(JSON.stringify(value)).byteLength <= TIMELINE_RENDER_RESPONSE_BYTES;
}

// Only transaction-produced business rejection proofs release a caller's key.
// A generic 4xx, authentication error or replay/ownership failure is ambiguous.
const proofCodes = new Set([
  'REVISION_CONFLICT', 'SOURCE_UNCHANGED', 'INVALID_CLIP_TYPE', 'SOURCE_BOUNDS', 'INVALID_FADE', 'FADE_AUDIO_UNSUPPORTED',
  'SUBTITLE_LIMIT', 'SUBTITLE_BOUNDS', 'SUBTITLE_OVERLAP', 'SUBTITLE_NOT_FOUND', 'AUDIO_HIDDEN_UNSUPPORTED', 'TIMELINE_LIMIT', 'CLIP_OVERLAP', 'SPLIT_BOUNDS', 'SPLIT_FADE_BOUNDS',
  'TIMELINE_NOT_EMPTY', 'MISSING_SELECTION', 'NOTHING_TO_UNDO', 'NOTHING_TO_REDO', 'EMPTY_TIMELINE', 'PREFLIGHT_STALE', 'TIMELINE_REVISION_LIMIT',
]);
const envelopeProofCodes = new Set(['TIMELINE_VOLUME_ENVELOPE_INVALID','TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED','TIMELINE_VOLUME_ENVELOPE_LIMIT','TIMELINE_VOLUME_ENVELOPE_WORKSPACE_REQUIRED']);
const colourProofCodes = new Set(['TIMELINE_IMAGE_AGGREGATE_BUDGET','TIMELINE_COLOUR_SOURCE_MISMATCH','TIMELINE_COLOUR_LOOK_UNAVAILABLE']);
const referenceProofCodes = new Set(['REVISION_CONFLICT', 'REFERENCE_CONNECTED', 'REFERENCE_SELECTION_EXISTS', 'INVALID_REFERENCE_SOURCE', 'INVALID_REFERENCE_EDGE', 'REFERENCE_REVISION_LIMIT']);
const subjectProofCodes = new Set(['REVISION_CONFLICT', 'SUBJECT_NO_CHANGE', 'SUBJECT_REVISION_LIMIT', 'SUBJECT_BINDING_LIMIT', 'SUBJECT_ROLE_MISMATCH']);
export interface RequestNotAppliedProofOptions {operation?: string}
export function hasRequestNotAppliedProof(error: unknown, input: unknown, {operation}: RequestNotAppliedProofOptions = {}): boolean {
  const failure = error as {code?: unknown; details?: unknown; status?: unknown; definitive?: unknown; terminationUnconfirmed?: unknown};
  const request = input as Rec;
  const details = failure?.details;
  // These new errors never inherit legacy optional owner/operation bindings.
  // Ordinary edits and scalar loudness may also preserve an enveloped aggregate.
  if(envelopeProofCodes.has(failure?.code as string))return Boolean(baseInput(input)&&(TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(operation as string)&&
    operation!=='timeline.render'&&failure.terminationUnconfirmed!==true&&object(details)&&
    (integer(failure.status,400,499)&&![401,403].includes(failure.status as number)||failure.status===undefined&&failure.definitive===true)&&
    ['mutationOutcome','operation','projectId','requestId'].every(key=>Object.hasOwn(details,key))&&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===request.projectId&&details.requestId===request.requestId);
  if((TIMELINE_SHOT_SYNC_OPERATIONS as readonly unknown[]).includes(operation))return hasTimelineShotSyncNotAppliedProof(failure,input,operation);
  if(operation===TIMELINE_SCENE_SPLIT_OPERATION)return hasTimelineSceneSplitNotAppliedProof(failure,input,operation);
  if(operation===TIMELINE_CROSSFADE_OPERATION)return hasTimelineCrossfadeNotAppliedProof(failure,input,operation);
  if(operation===TIMELINE_CLIP_GAINS_OPERATION)return hasTimelineClipGainsNotAppliedProof(failure,input,operation);
  if(operation===TIMELINE_LOUDNESS_APPLY_OPERATION)return hasTimelineLoudnessApplyNotAppliedProof(failure,input);
  if(failure?.code==='AUDIO_ROLE_CLIP_UNSUPPORTED')return Boolean(baseInput(input)&&
    (operation==='timeline.clip.add'&&operationInput(input,['trackId','assetId','startFrame','durationFrames'],['name','sourceInFrame','rect','gain','fadeInFrames','fadeOutFrames','colour','audioRole','volumeEnvelope'])&&uuid(request.trackId)&&uuid(request.assetId)&&Object.hasOwn(request,'audioRole')&&isClipAudioRole(request.audioRole)||
     operation==='timeline.clip.update'&&operationInput(input,['clipId','patch'])&&uuid(request.clipId)&&patchInput(request.patch,clipFields)&&Object.hasOwn(request.patch as Rec,'audioRole')&&isClipAudioRole((request.patch as Rec).audioRole))&&
    object(details)&&(integer(failure.status,400,499)&&![401,403].includes(failure.status as number)||failure.status===undefined&&failure.definitive===true)&&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===request.projectId&&details.requestId===request.requestId);

  if(colourProofCodes.has(failure?.code as string))return Boolean(baseInput(input)&&(TIMELINE_MUTATION_OPERATIONS as readonly string[]).includes(operation as string)&&
    operation!=='timeline.render'&&object(details)&&
    (!Object.hasOwn(request,'colour')||isTimelineClipColour(request.colour))&&
    (!object(request.patch)||!Object.hasOwn(request.patch,'colour')||isTimelineClipColour(request.patch.colour))&&
    (integer(failure.status,400,499)&&![401,403].includes(failure.status as number)||failure.status===undefined&&failure.definitive===true)&&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===request.projectId&&details.requestId===request.requestId);
  const rangeProof={operation,error: failure,isRenderInput:(value: unknown): boolean =>
    operationInput(value,['purpose','exportRange'],['preflightSnapshotHash','exportSettings','deliveryName']) && isTimelineDeliveryNameInput(value,(value as Rec).purpose) &&
    ((value as Rec).exportSettings===undefined||timelineExportSettingsSchema.safeParse((value as Rec).exportSettings).success) && ((value as Rec).preflightSnapshotHash===undefined||digest((value as Rec).preflightSnapshotHash))};
  if(!isTimelineExportRangeProofInput(input,rangeProof))return false;
  if(failure?.code==='EXPORT_RANGE_BOUNDS')return hasTimelineExportRangeBoundsProof(failure,input,rangeProof);
  if(TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES.includes(failure?.code as string)) return Boolean(operation==='timeline.render' &&
    operationInput(input,['purpose','exportSettings'],['preflightSnapshotHash','deliveryName','exportRange']) && isTimelineDeliveryNameInput(input,request.purpose) && isTimelineExportRangeInput(input,request.purpose) && request.purpose==='export' && timelineExportSettingsSchema.safeParse(request.exportSettings).success &&
    (request.preflightSnapshotHash===undefined||digest(request.preflightSnapshotHash)) && object(details) &&
    (integer(failure.status,400,499)&&![401,403].includes(failure.status as number)||failure.status===undefined&&failure.definitive===true) &&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===request.projectId&&details.requestId===request.requestId);
  if(operation==='timeline.format.set') return Boolean((timelineFormatSchemas as Record<string, z.ZodTypeAny>)['timeline.format.set'].safeParse(input).success && object(details) &&
    (integer(failure.status,400,499)&&![401,403].includes(failure.status as number)||failure.status===undefined&&failure.definitive===true) &&
    ['REVISION_CONFLICT','TIMELINE_FORMAT_LOCKED','TIMELINE_FORMAT_UNCHANGED','TIMELINE_REVISION_LIMIT'].includes(failure.code as string) &&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===request.projectId&&details.requestId===request.requestId);
  if ((TIMELINE_SUBTITLE_OPERATIONS as readonly string[]).includes(operation as string)) return Boolean((timelineSubtitleSchemas as Record<string, z.ZodTypeAny>)[operation as string].safeParse(input).success && object(details) &&
    (integer(failure.status,400,499)&&![401,403].includes(failure.status as number)||failure.status===undefined&&failure.definitive===true) &&
    ['REVISION_CONFLICT','TIMELINE_REVISION_LIMIT','SUBTITLE_LIMIT','SUBTITLE_BOUNDS','SUBTITLE_OVERLAP','SUBTITLE_NOT_FOUND'].includes(failure.code as string) &&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===request.projectId&&details.requestId===request.requestId);
  if ((SUBJECT_MUTATION_OPERATIONS as readonly string[]).includes(operation as string)) return Boolean(object(input) && uuid(request.projectId) && text(request.requestId, 8, 200) && object(details) &&
    (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
    subjectProofCodes.has(failure.code as string) && ['mutationOutcome', 'operation', 'projectId', 'requestId'].every(key => Object.hasOwn(details, key)) &&
    details.mutationOutcome === 'not_applied' && details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId);
  // Reference rejections must be owner-checked by their own transaction and
  // explicitly bind every identity field. Legacy timeline proofs retain their
  // existing optional operation/project fields and original code allowlist.
  if ((REFERENCE_MUTATION_OPERATIONS as readonly string[]).includes(operation as string)) return Boolean(object(input) && uuid(request.projectId) && text(request.requestId, 8, 200) && object(details) &&
    (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
    referenceProofCodes.has(failure.code as string) && ['mutationOutcome', 'operation', 'projectId', 'requestId'].every(key => Object.hasOwn(details, key)) &&
    details.mutationOutcome === 'not_applied' && details.operation === operation && details.projectId === request.projectId && details.requestId === request.requestId);
  return Boolean(object(input) && text(request.requestId, 8, 200) && object(details) &&
    (integer(failure.status, 400, 499) && ![401, 403].includes(failure.status as number) || failure.status === undefined && failure.definitive === true) &&
    proofCodes.has(failure.code as string) && details.mutationOutcome === 'not_applied' && details.requestId === request.requestId &&
    (!Object.hasOwn(details, 'operation') || details.operation === operation) &&
    (!Object.hasOwn(details, 'projectId') || details.projectId === request.projectId));
}
