import {isTimelineDeliveryNameInput} from './timeline-delivery.ts';
import {isTimelineExportSnapshot,timelineExportSettingsSchema,TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES} from './timeline-export-profile.mjs';
import {TIMELINE_SUBTITLE_OPERATIONS,timelineSubtitleSchemas,isTimelineSubtitleSnapshotProfile} from './timeline-subtitles.mjs';
import {timelineFormatSchemas,timelineOutputPreset} from './timeline-format.mjs';
import {isTimelineRecord, isTimelineReplacementResponse} from './timeline-replacement.mjs';
import {sourceFrameCount} from './source-range.mjs';
import {SUBJECT_MUTATION_OPERATIONS} from './subjects.mjs';
import {REFERENCE_MUTATION_OPERATIONS} from './reference-acknowledgement.mjs';

export const TIMELINE_MUTATION_OPERATIONS = Object.freeze([
  'timeline.track.add', 'timeline.track.update', 'timeline.clip.add', 'timeline.clip.update',
  'timeline.clip.replaceSource', 'timeline.clip.remove', 'timeline.clip.split', 'timeline.seed',
  'timeline.undo', 'timeline.redo', 'timeline.render', 'timeline.format.set',
  ...TIMELINE_SUBTITLE_OPERATIONS,
]);
export const TIMELINE_RENDER_RESPONSE_BYTES = 4 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const fields = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const timestamp = value => text(value, 1, 64) && Number.isFinite(Date.parse(value));
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const encoder = new TextEncoder();
const baseFields = ['projectId', 'expectedRevision', 'requestId'];
const clipFields = ['trackId', 'name', 'startFrame', 'durationFrames', 'sourceInFrame', 'rect', 'gain', 'fadeInFrames', 'fadeOutFrames'];
const provenance = ['versionId', 'shotId', 'jobId'];
const same = (a, b) => object(a) && object(b)
  ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && same(a[key], b[key]))
  : a === b;
const hasFields = (value, input, keys) => keys.every(key => input[key] === undefined || same(value[key], input[key]));
const baseInput = input => object(input) && uuid(input.projectId) && text(input.requestId, 8, 200) && integer(input.expectedRevision, 1);
const operationInput = (input, required = [], optional = []) => baseInput(input) && fields(input, [...baseFields, ...required], optional);
const patchInput = (patch, allowed) => object(patch) && Object.keys(patch).length > 0 && Object.keys(patch).every(key => allowed.includes(key) && patch[key] !== undefined);

// Identity and source-intent checks that can be verified without the previous
// aggregate. Ownership, exact history transitions and immutable receipt hashes
// are additionally checked by the backend. No validator edits the supplied data.
export function isTimelineMutationResponse(operation, input, value) {
  if(operation==='timeline.format.set') return timelineFormatSchemas[operation].safeParse(input).success &&
    isTimelineRecord(value,{projectId:input.projectId}) && value.revision===input.expectedRevision+1 &&
    timelineOutputPreset(value)?.id===input.presetId && value.clips.length===0 && value.durationFrames===0;
  if (!TIMELINE_MUTATION_OPERATIONS.includes(operation) || !baseInput(input)) return false;
  if (operation === 'timeline.render') return operationInput(input, ['purpose'], ['preflightSnapshotHash','exportSettings','deliveryName']) && isTimelineRenderRecord(value, input);
  if (input.expectedRevision === Number.MAX_SAFE_INTEGER || !isTimelineRecord(value, {projectId: input.projectId}) || value.revision !== input.expectedRevision + 1) return false;
  const target = value.clips.find(clip => clip.id === input.clipId);
  switch (operation) {
    case 'timeline.subtitle.add':
      return timelineSubtitleSchemas[operation].safeParse(input).success && Boolean(value.subtitles?.cues.some(cue => hasFields(cue,input,['text','startFrame','durationFrames'])));
    case 'timeline.subtitle.update':
      return timelineSubtitleSchemas[operation].safeParse(input).success && Boolean(value.subtitles?.cues.some(cue => cue.id===input.cueId && hasFields(cue,input.patch,Object.keys(input.patch))));
    case 'timeline.subtitle.remove':
      return timelineSubtitleSchemas[operation].safeParse(input).success && Boolean(value.subtitles) && !value.subtitles.cues.some(cue => cue.id===input.cueId);
    case 'timeline.clip.replaceSource':
      return operationInput(input, ['clipId', 'assetId'], ['versionId']) && isTimelineReplacementResponse(value, input);
    case 'timeline.track.add': {
      if (!operationInput(input, ['kind'], ['name']) || !['video', 'audio'].includes(input.kind) ||
          (input.name !== undefined && !text(input.name, 1, 150))) return false;
      const order = Math.max(...value.tracks.map(track => track.orderIndex));
      const name = input.name ?? `${input.kind === 'video' ? 'Video' : 'Audio'} ${value.tracks.filter(track => track.kind === input.kind).length}`;
      return value.tracks.some(track => track.kind === input.kind && track.name === name && track.orderIndex === order && !track.hidden && !track.muted);
    }
    case 'timeline.track.update': {
      if (!operationInput(input, ['trackId', 'patch']) || !uuid(input.trackId) || !patchInput(input.patch, ['name', 'hidden', 'muted'])) return false;
      const track = value.tracks.find(track => track.id === input.trackId);
      return Boolean(track && !(track.kind === 'audio' && Object.hasOwn(input.patch, 'hidden')) && hasFields(track, input.patch, Object.keys(input.patch)));
    }
    case 'timeline.clip.add': {
      if (!operationInput(input, ['assetId', 'trackId', 'startFrame', 'durationFrames'], clipFields.filter(key => !['trackId', 'startFrame', 'durationFrames'].includes(key))) || !uuid(input.assetId) || !uuid(input.trackId) || !integer(input.startFrame, 0, 18000) || !integer(input.durationFrames, 1, 18000)) return false;
      return value.clips.some(clip => clip.assetId === input.assetId && hasFields(clip, input, clipFields) &&
        clip.sourceInFrame === (input.sourceInFrame ?? 0) && clip.gain === (input.gain ?? 1) &&
        same(clip.rect, input.rect ?? {x: 0, y: 0, width: value.width, height: value.height}) &&
        provenance.every(key => !Object.hasOwn(clip, key)) &&
        ['fadeInFrames', 'fadeOutFrames'].every(key => (input[key] !== undefined) === Object.hasOwn(clip, key)));
    }
    case 'timeline.clip.update':
      return operationInput(input, ['clipId', 'patch']) && uuid(input.clipId) && patchInput(input.patch, clipFields) && Boolean(target && hasFields(target, input.patch, Object.keys(input.patch)));
    case 'timeline.clip.remove':
      return operationInput(input, ['clipId']) && uuid(input.clipId) && !target;
    case 'timeline.clip.split':
      if (!operationInput(input, ['clipId', 'atFrame']) || !uuid(input.clipId) || !integer(input.atFrame, 0, 18000) || !target || target.startFrame + target.durationFrames !== input.atFrame || (target.fadeOutFrames ?? 0) !== 0) return false;
      return value.clips.some(right => right.id !== target.id && right.startFrame === input.atFrame &&
        ['trackId', 'assetId', 'name', 'rect', 'gain', ...provenance].every(key => Object.hasOwn(right, key) === Object.hasOwn(target, key) && same(right[key], target[key])) &&
        (right.sourceInFrame === target.sourceInFrame + target.durationFrames || right.sourceInFrame === 0 && target.sourceInFrame === 0) &&
        (right.fadeInFrames ?? 0) === 0 && ['fadeInFrames', 'fadeOutFrames'].every(key => Object.hasOwn(right, key) === Object.hasOwn(target, key)));
    case 'timeline.seed':
      return operationInput(input) && value.clips.length > 0;
    case 'timeline.undo':
    case 'timeline.redo':
      return operationInput(input);
    default: return false;
  }
}

const renderFields = ['id', 'projectId', 'requestId', 'mode', 'purpose', 'timelineRevision', 'snapshot', 'status', 'assetId', 'url', 'error', 'createdAt', 'updatedAt'];
const visualTypes = ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'];
const audioTypes = ['audio/wav', 'audio/mpeg', 'audio/mp4'];
const renderError = value => fields(value, ['code', 'message'], ['retryable']) && text(value.code, 1, 200) && text(value.message, 1, 600) && (!Object.hasOwn(value, 'retryable') || typeof value.retryable === 'boolean');

// A progressed export and an immutable acknowledgement share frozen identity.
// Never require the current job status to equal its originally queued status.
// relativePath is removed from public responses; old snapshots may omit either
// relativePath or hasAudio. Those omissions are preserved rather than repaired.
export function isTimelineRenderRecord(value, input) {
  if (!baseInput(input) || !['preview', 'export'].includes(input.purpose) || !isTimelineDeliveryNameInput(input,input.purpose) ||
      (input.preflightSnapshotHash !== undefined && !digest(input.preflightSnapshotHash)) ||
      (input.exportSettings !== undefined && (input.purpose!=='export'||!timelineExportSettingsSchema.safeParse(input.exportSettings).success)) ||
      !fields(value, renderFields) || !uuid(value.id) || value.projectId !== input.projectId || value.requestId !== input.requestId ||
      value.mode !== 'timeline' || value.purpose !== input.purpose || value.timelineRevision !== input.expectedRevision ||
      (input.exportId !== undefined && value.id !== input.exportId) ||
      !['queued', 'running', 'succeeded', 'failed'].includes(value.status) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
      !fields(value.snapshot, ['timeline', 'assets'], ['subtitleProfile','delivery','deliveryName']) || !isTimelineExportSnapshot(value.snapshot,{purpose:input.purpose,exportSettings:input.exportSettings,input}) || !isTimelineSubtitleSnapshotProfile(value.snapshot) || !isTimelineRecord(value.snapshot.timeline, {projectId: input.projectId}) ||
      value.snapshot.timeline.revision !== input.expectedRevision || !value.snapshot.timeline.clips.length ||
      (input.timelineId !== undefined && value.snapshot.timeline.id !== input.timelineId) ||
      !Array.isArray(value.snapshot.assets) || value.snapshot.assets.length < 1 || value.snapshot.assets.length > 100 ||
      !(value.error === null || renderError(value.error))) return false;
  if (value.status === 'succeeded') {
    if (!uuid(value.assetId) || value.url !== `/media/${value.assetId}` || value.error !== null) return false;
  } else if (value.assetId !== null || value.url !== null || value.status === 'failed' && value.error === null) return false;
  const assets = new Map();
  for (const asset of value.snapshot.assets) {
    if (!fields(asset, ['id', 'sha256', 'mimeType'], ['duration', 'width', 'height', 'hasAudio', 'relativePath']) ||
        !uuid(asset.id) || assets.has(asset.id) || !digest(asset.sha256) || ![...visualTypes, ...audioTypes].includes(asset.mimeType) ||
        (Object.hasOwn(asset, 'duration') && (!Number.isFinite(asset.duration) || asset.duration < 0)) ||
        ['width', 'height'].some(key => Object.hasOwn(asset, key) && !integer(asset[key], 0)) ||
        (Object.hasOwn(asset, 'hasAudio') && asset.hasAudio !== null && typeof asset.hasAudio !== 'boolean') ||
        (Object.hasOwn(asset, 'relativePath') && (!text(asset.relativePath, 1, 4096) || asset.relativePath.includes('\0')))) return false;
    assets.set(asset.id, asset);
  }
  const tracks = new Map(value.snapshot.timeline.tracks.map(track => [track.id, track])), used = new Set();
  for (const clip of value.snapshot.timeline.clips) {
    const asset = assets.get(clip.assetId);
    if (!asset || !(tracks.get(clip.trackId).kind === 'audio' ? audioTypes : visualTypes).includes(asset.mimeType)) return false;
    if (asset.mimeType.startsWith('image/') ? clip.sourceInFrame !== 0 : clip.sourceInFrame + clip.durationFrames > (sourceFrameCount(asset.duration) ?? 0)) return false;
    if ((clip.fadeInFrames ?? 0) + (clip.fadeOutFrames ?? 0) > 0 && (asset.mimeType.startsWith('image/') || asset.hasAudio === false)) return false;
    used.add(asset.id);
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
const referenceProofCodes = new Set(['REVISION_CONFLICT', 'REFERENCE_CONNECTED', 'REFERENCE_SELECTION_EXISTS', 'INVALID_REFERENCE_SOURCE', 'INVALID_REFERENCE_EDGE', 'REFERENCE_REVISION_LIMIT']);
const subjectProofCodes = new Set(['REVISION_CONFLICT', 'SUBJECT_NO_CHANGE', 'SUBJECT_REVISION_LIMIT', 'SUBJECT_BINDING_LIMIT', 'SUBJECT_ROLE_MISMATCH']);
export function hasRequestNotAppliedProof(error, input, {operation} = {}) {
  const details = error?.details;
  if(TIMELINE_EXPORT_CAPABILITY_REJECTION_CODES.includes(error?.code)) return Boolean(operation==='timeline.render' &&
    operationInput(input,['purpose','exportSettings'],['preflightSnapshotHash','deliveryName']) && isTimelineDeliveryNameInput(input,input.purpose) && input.purpose==='export' && timelineExportSettingsSchema.safeParse(input.exportSettings).success &&
    (input.preflightSnapshotHash===undefined||digest(input.preflightSnapshotHash)) && object(details) &&
    (integer(error.status,400,499)&&![401,403].includes(error.status)||error.status===undefined&&error.definitive===true) &&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===input.projectId&&details.requestId===input.requestId);
  if(operation==='timeline.format.set') return Boolean(timelineFormatSchemas[operation].safeParse(input).success && object(details) &&
    (integer(error.status,400,499)&&![401,403].includes(error.status)||error.status===undefined&&error.definitive===true) &&
    ['REVISION_CONFLICT','TIMELINE_FORMAT_LOCKED','TIMELINE_FORMAT_UNCHANGED','TIMELINE_REVISION_LIMIT'].includes(error.code) &&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===input.projectId&&details.requestId===input.requestId);
  if (TIMELINE_SUBTITLE_OPERATIONS.includes(operation)) return Boolean(timelineSubtitleSchemas[operation].safeParse(input).success && object(details) &&
    (integer(error.status,400,499)&&![401,403].includes(error.status)||error.status===undefined&&error.definitive===true) &&
    ['REVISION_CONFLICT','TIMELINE_REVISION_LIMIT','SUBTITLE_LIMIT','SUBTITLE_BOUNDS','SUBTITLE_OVERLAP','SUBTITLE_NOT_FOUND'].includes(error.code) &&
    details.mutationOutcome==='not_applied'&&details.operation===operation&&details.projectId===input.projectId&&details.requestId===input.requestId);
  if (SUBJECT_MUTATION_OPERATIONS.includes(operation)) return Boolean(object(input) && uuid(input.projectId) && text(input.requestId, 8, 200) && object(details) &&
    (integer(error.status, 400, 499) && ![401, 403].includes(error.status) || error.status === undefined && error.definitive === true) &&
    subjectProofCodes.has(error.code) && ['mutationOutcome', 'operation', 'projectId', 'requestId'].every(key => Object.hasOwn(details, key)) &&
    details.mutationOutcome === 'not_applied' && details.operation === operation && details.projectId === input.projectId && details.requestId === input.requestId);
  // Reference rejections must be owner-checked by their own transaction and
  // explicitly bind every identity field. Legacy timeline proofs retain their
  // existing optional operation/project fields and original code allowlist.
  if (REFERENCE_MUTATION_OPERATIONS.includes(operation)) return Boolean(object(input) && uuid(input.projectId) && text(input.requestId, 8, 200) && object(details) &&
    (integer(error.status, 400, 499) && ![401, 403].includes(error.status) || error.status === undefined && error.definitive === true) &&
    referenceProofCodes.has(error.code) && ['mutationOutcome', 'operation', 'projectId', 'requestId'].every(key => Object.hasOwn(details, key)) &&
    details.mutationOutcome === 'not_applied' && details.operation === operation && details.projectId === input.projectId && details.requestId === input.requestId);
  return Boolean(object(input) && text(input.requestId, 8, 200) && object(details) &&
    (integer(error.status, 400, 499) && ![401, 403].includes(error.status) || error.status === undefined && error.definitive === true) &&
    proofCodes.has(error.code) && details.mutationOutcome === 'not_applied' && details.requestId === input.requestId &&
    (!Object.hasOwn(details, 'operation') || details.operation === operation) &&
    (!Object.hasOwn(details, 'projectId') || details.projectId === input.projectId));
}
