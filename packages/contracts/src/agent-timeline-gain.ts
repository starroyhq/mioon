// Closed, reviewed selected-clip gain contracts. This creates no operation and
// grants no execution authority. Canonical timeline and rollback validators are
// fixed dependencies supplied once by the existing contracts barrel.
export const AGENT_TIMELINE_GAIN_CONTEXT = 'selected_timeline_clip_gain';
export const AGENT_TIMELINE_GAIN_PROVENANCE = 'project_selected_timeline_audio_gain';
export const AGENT_TIMELINE_GAIN_TOOL = 'mioon_propose_timeline_clip_gain';
export const AGENT_TIMELINE_GAIN_DEFINITION_VERSION = 3;
export const AGENT_TIMELINE_GAIN_LIMITS = Object.freeze({minGain: 0, maxGain: 2,
  targetBytes: 16 * 1024, proposalBytes: 16 * 1024});

export type AgentTimelineGainArguments = Readonly<{gain: number}>;
export type AgentTimelineGainSource = Readonly<{id: string; sha256: string;
  mimeType: 'video/mp4' | 'video/webm' | 'audio/wav' | 'audio/mpeg' | 'audio/mp4'; hasAudio: true}>;
export type AgentTimelineGainClip = Readonly<{id: string; trackId: string; assetId: string; name: string;
  startFrame: number; durationFrames: number; sourceInFrame: number;
  rect: Readonly<{x: number; y: number; width: number; height: number}>; gain: number;
  versionId?: string; shotId?: string; jobId?: string; fadeInFrames?: number; fadeOutFrames?: number}>;
export type AgentTimelineGainTrack = Readonly<{id: string; name: string; kind: 'video' | 'audio';
  orderIndex: number; hidden: boolean; muted: boolean}>;
export type AgentTimelineGainTarget = Readonly<{projectId: string; timelineId: string; expectedRevision: number;
  fps: 30; width: number; height: number; durationFrames: number; clip: AgentTimelineGainClip;
  track: AgentTimelineGainTrack; source: AgentTimelineGainSource}>;
export type AgentTimelineGainPublicTarget = Readonly<{projectId: string; timelineId: string; clipId: string;
  trackId: string; expectedRevision: number; clipName: string; trackName: string; trackKind: 'video' | 'audio';
  fps: 30; width: number; height: number; trackMuted: boolean; hasAudio: true}>;
export type AgentTimelineGainReviewTarget = AgentTimelineGainPublicTarget & Readonly<{gain: number}>;
export type AgentTimelineGainDiff = Readonly<{before: AgentTimelineGainArguments; after: AgentTimelineGainArguments}>;
export type AgentTimelineGainModelContext = Readonly<{clip: Readonly<{name: string; gain: number}>;
  track: Readonly<{name: string; kind: 'video' | 'audio'; muted: boolean}>; hasAudio: true; minGain: 0; maxGain: 2}>;
export type AgentTimelineGainRunStatus = 'running' | 'completed' | 'stopped' | 'failed' | 'interrupted';
export type AgentTimelineGainApproval = Readonly<{approvedAt: string; requestId: string}>;
export type AgentTimelineGainAppliedOutcome = Readonly<{status: 'applied'; timelineId: string; clipId: string; revision: number}>;
export type AgentTimelineGainFailedOutcome = Readonly<{status: 'not_applied'; code: string}>;
type ProposalBase = Readonly<{id: string; projectId: string; runId: string; digest: string;
  operation: 'timeline.clip.update'; target: AgentTimelineGainPublicTarget; patch: AgentTimelineGainArguments;
  diff: AgentTimelineGainDiff; provenance: Readonly<{runId: string; toolCallId: string; toolName: typeof AGENT_TIMELINE_GAIN_TOOL}>;
  createdAt: string; updatedAt: string}>;
// Exact status union keeps approval/outcome authority separate from model prose.
export type AgentTimelineGainProposal = ProposalBase & (
  Readonly<{status: 'pending' | 'rejected' | 'cancelled'; runStatus: AgentTimelineGainRunStatus; approval?: never; outcome?: never}> |
  Readonly<{status: 'approved' | 'dispatching' | 'unknown'; runStatus: 'completed'; approval: AgentTimelineGainApproval; outcome?: never}> |
  Readonly<{status: 'applied'; runStatus: 'completed'; approval: AgentTimelineGainApproval; outcome: AgentTimelineGainAppliedOutcome}> |
  Readonly<{status: 'failed'; runStatus: 'completed'; approval: AgentTimelineGainApproval; outcome: AgentTimelineGainFailedOutcome}>
);
export type AgentTimelineGainValidationOptions = Readonly<{projectId?: unknown}>;
export type AgentTimelineGainCanonicalValidators = Readonly<{
  isTimelineRecord: (value: unknown, options?: AgentTimelineGainValidationOptions) => boolean;
  hasRequestNotAppliedProof: (error: unknown, input: unknown, options: Readonly<{operation: string}>) => boolean;
}>;

const encoder = new TextEncoder();
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> =>
  object(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const integer = (value: unknown, min = 0, max = 18000): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
const wellFormed = (value: string): boolean => /^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/u.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.length >= 1 && value.length <= max && wellFormed(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const timestamp = (value: unknown): value is string => text(value, 30) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));
const callId = (value: unknown): value is string => text(value, 256) && encoder.encode(value).byteLength <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
const savedGain = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2;
const withinBytes = (value: unknown, maximum: number): boolean => {
  try { return encoder.encode(JSON.stringify(value)).byteLength <= maximum; } catch { return false; }
};

// Read descriptors before values/serialization: direct contracts must never
// invoke getters or accept hidden, symbol, prototype, cyclic or non-JSON data.
function boundedData(value: unknown, budget = 1200): boolean {
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (--budget < 0 || depth > 8) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item === 'string') return item.length <= 4096 && wellFormed(item);
    if (typeof item !== 'object' || ancestors.has(item)) return false;
    const array = Array.isArray(item);
    if (array ? Object.getPrototypeOf(item) !== Array.prototype || item.length > 100 : !object(item)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
    if (array ? keys.length !== item.length + 1 : keys.length > 32) return false;
    ancestors.add(item);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return false;
      const descriptor: PropertyDescriptor | undefined = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable ||
          array && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length) || !visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item); return true;
  }
  try { return visit(value, 0); } catch { return false; }
}

const targetFields = ['projectId', 'timelineId', 'expectedRevision', 'fps', 'width', 'height', 'durationFrames', 'clip', 'track', 'source'];
const publicFields = ['projectId', 'timelineId', 'clipId', 'trackId', 'expectedRevision', 'clipName', 'trackName', 'trackKind',
  'fps', 'width', 'height', 'trackMuted', 'hasAudio'];
const sourceTypes: readonly string[] = ['video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4'];
const runStatuses: readonly unknown[] = ['running', 'completed', 'stopped', 'failed', 'interrupted'];
const statuses: readonly unknown[] = ['pending', 'approved', 'dispatching', 'unknown', 'applied', 'failed', 'rejected', 'cancelled'];
const proposalFields = ['id', 'projectId', 'runId', 'runStatus', 'digest', 'status', 'operation', 'target', 'patch', 'diff', 'provenance', 'createdAt', 'updatedAt'];

export function isAgentTimelineGainArguments(value: unknown): value is AgentTimelineGainArguments {
  return boundedData(value) && exact(value, ['gain']) && savedGain(value.gain) && !Object.is(value.gain, -0);
}
export function isAgentTimelineGainSource(value: unknown): value is AgentTimelineGainSource {
  return boundedData(value) && exact(value, ['id', 'sha256', 'mimeType', 'hasAudio']) && uuid(value.id) && hash(value.sha256) &&
    typeof value.mimeType === 'string' && sourceTypes.includes(value.mimeType) && value.hasAudio === true;
}
function publicTargetValid(value: Record<string, unknown>, projectId: unknown): boolean {
  // This public selected projection admits only the three existing 30fps output
  // pairs. Private targets additionally pass the canonical timeline validator.
  return uuid(value.projectId) && (projectId === undefined || value.projectId === projectId) && uuid(value.timelineId) &&
    uuid(value.clipId) && uuid(value.trackId) && integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) &&
    text(value.clipName, 200) && text(value.trackName, 150) && (value.trackKind === 'video' || value.trackKind === 'audio') &&
    value.fps === 30 && (value.width === 720 && (value.height === 720 || value.height === 1280) || value.width === 1280 && value.height === 720) &&
    typeof value.trackMuted === 'boolean' && value.hasAudio === true;
}
export function isAgentTimelineGainPublicTarget(value: unknown, {projectId}: AgentTimelineGainValidationOptions = {}): value is AgentTimelineGainPublicTarget {
  return boundedData(value) && exact(value, publicFields) && publicTargetValid(value, projectId) && withinBytes(value, AGENT_TIMELINE_GAIN_LIMITS.targetBytes);
}
export function isAgentTimelineGainReviewTarget(value: unknown, {projectId}: AgentTimelineGainValidationOptions = {}): value is AgentTimelineGainReviewTarget {
  return boundedData(value) && exact(value, [...publicFields, 'gain']) && publicTargetValid(value, projectId) && savedGain(value.gain) &&
    withinBytes(value, AGENT_TIMELINE_GAIN_LIMITS.targetBytes);
}

/** Fixed module-construction adapter. Never accept these dependencies from an
 * RPC, model, renderer payload or saved record. They are the existing shared
 * validators, not alternate clip schemas or a pluggable operation registry. */
export function createAgentTimelineGainContracts({isTimelineRecord, hasRequestNotAppliedProof}: AgentTimelineGainCanonicalValidators) {
  if (typeof isTimelineRecord !== 'function' || typeof hasRequestNotAppliedProof !== 'function') throw new TypeError('Canonical timeline validators are required');
  function isAgentTimelineGainTarget(value: unknown, {projectId}: AgentTimelineGainValidationOptions = {}): value is AgentTimelineGainTarget {
    if (!boundedData(value) || !exact(value, targetFields) || !uuid(value.projectId) || !uuid(value.timelineId) ||
        projectId !== undefined && value.projectId !== projectId || !integer(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER - 1) ||
        !integer(value.durationFrames, 1) || !object(value.clip) || !object(value.track) || !isAgentTimelineGainSource(value.source) ||
        value.source.id !== value.clip.assetId || !integer(value.clip.startFrame) || !integer(value.clip.durationFrames, 1) ||
        (value.track.kind === 'audio' ? !value.source.mimeType.startsWith('audio/') : !value.source.mimeType.startsWith('video/'))) return false;
    const endFrame = value.clip.startFrame + value.clip.durationFrames;
    const mini = {id: value.timelineId, projectId: value.projectId, revision: value.expectedRevision,
      fps: value.fps, width: value.width, height: value.height, tracks: [value.track], clips: [value.clip],
      durationFrames: endFrame, createdAt: '2000-01-01T00:00:00.000Z', updatedAt: '2000-01-01T00:00:00.000Z'};
    try { return isTimelineRecord(mini, {projectId: value.projectId}) === true && value.durationFrames >= endFrame &&
      withinBytes(value, AGENT_TIMELINE_GAIN_LIMITS.targetBytes); } catch { return false; }
  }
  function agentTimelineGainTargetFromTimeline(timeline: unknown, clipId: unknown, source: unknown): AgentTimelineGainTarget | null {
    if (!boundedData(timeline, 12000) || !uuid(clipId) || !isAgentTimelineGainSource(source)) return null;
    try { if (isTimelineRecord(timeline) !== true) return null; } catch { return null; }
    if (!object(timeline) || !Array.isArray(timeline.clips) || !Array.isArray(timeline.tracks)) return null;
    const clip: unknown = timeline.clips.find((item: unknown) => object(item) && item.id === clipId);
    if (!object(clip)) return null;
    const track: unknown = timeline.tracks.find((item: unknown) => object(item) && item.id === clip.trackId);
    const target = {projectId: timeline.projectId, timelineId: timeline.id, expectedRevision: timeline.revision,
      fps: timeline.fps, width: timeline.width, height: timeline.height, durationFrames: timeline.durationFrames, clip, track, source};
    return isAgentTimelineGainTarget(target) ? structuredClone(target) : null;
  }
  function agentTimelineGainPublicTarget(target: unknown): AgentTimelineGainPublicTarget | null {
    if (!isAgentTimelineGainTarget(target)) return null;
    return {projectId: target.projectId, timelineId: target.timelineId, clipId: target.clip.id, trackId: target.track.id,
      expectedRevision: target.expectedRevision, clipName: target.clip.name, trackName: target.track.name,
      trackKind: target.track.kind, fps: target.fps, width: target.width, height: target.height,
      trackMuted: target.track.muted, hasAudio: true};
  }
  function agentTimelineGainReviewTarget(target: unknown): AgentTimelineGainReviewTarget | null {
    if (!isAgentTimelineGainTarget(target)) return null;
    const publicTarget = agentTimelineGainPublicTarget(target);
    return publicTarget ? {...publicTarget, gain: target.clip.gain} : null;
  }
  function agentTimelineGainModelContext(target: unknown): AgentTimelineGainModelContext | null {
    if (!isAgentTimelineGainTarget(target)) return null;
    // Construct explicitly; never spread source/clip/track identity into model data.
    return {clip: {name: target.clip.name, gain: target.clip.gain},
      track: {name: target.track.name, kind: target.track.kind, muted: target.track.muted}, hasAudio: true, minGain: 0, maxGain: 2};
  }
  function agentTimelineGainDiff(target: unknown, changes: unknown): AgentTimelineGainDiff | null {
    if (!isAgentTimelineGainTarget(target) || !isAgentTimelineGainArguments(changes) || target.clip.gain === changes.gain) return null;
    return {before: {gain: target.clip.gain}, after: {gain: changes.gain}};
  }
  function isAgentTimelineGainProposal(value: unknown, {projectId}: AgentTimelineGainValidationOptions = {}): value is AgentTimelineGainProposal {
    if (!boundedData(value) || !exact(value, proposalFields, ['approval', 'outcome']) || !uuid(value.id) || !uuid(value.runId) ||
        !uuid(value.projectId) || !hash(value.digest) || !statuses.includes(value.status) || !runStatuses.includes(value.runStatus) ||
        value.operation !== 'timeline.clip.update' || !isAgentTimelineGainPublicTarget(value.target, {projectId: value.projectId}) ||
        projectId !== undefined && value.projectId !== projectId || !isAgentTimelineGainArguments(value.patch) ||
        !exact(value.diff, ['before', 'after']) || !exact(value.diff.before, ['gain']) || !savedGain(value.diff.before.gain) ||
        !isAgentTimelineGainArguments(value.diff.after) || value.diff.before.gain === value.diff.after.gain ||
        value.diff.after.gain !== value.patch.gain || !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
        !exact(value.provenance, ['runId', 'toolCallId', 'toolName']) || value.provenance.runId !== value.runId ||
        value.provenance.toolName !== AGENT_TIMELINE_GAIN_TOOL || !callId(value.provenance.toolCallId)) return false;
    const unapproved = ['pending', 'rejected', 'cancelled'].includes(String(value.status)), terminal = ['applied', 'failed'].includes(String(value.status));
    if (unapproved !== !Object.hasOwn(value, 'approval') || terminal !== Object.hasOwn(value, 'outcome') ||
        !unapproved && value.runStatus !== 'completed') return false;
    if (!unapproved && (!exact(value.approval, ['approvedAt', 'requestId']) || !timestamp(value.approval.approvedAt) || !uuid(value.approval.requestId))) return false;
    if (value.status === 'applied' && (!exact(value.outcome, ['status', 'timelineId', 'clipId', 'revision']) ||
        value.outcome.status !== 'applied' || value.outcome.timelineId !== value.target.timelineId ||
        value.outcome.clipId !== value.target.clipId || value.outcome.revision !== value.target.expectedRevision + 1)) return false;
    if (value.status === 'failed') {
      if (!exact(value.outcome, ['status', 'code']) || value.outcome.status !== 'not_applied' || !text(value.outcome.code, 100) || !object(value.approval)) return false;
      const input = {projectId: value.projectId, expectedRevision: value.target.expectedRevision,
        clipId: value.target.clipId, requestId: value.approval.requestId, patch: value.patch};
      // This reuses the shared vocabulary only. It is not rollback evidence;
      // execution may classify failure only from the actual shared transaction.
      try { if (hasRequestNotAppliedProof({code: value.outcome.code, status: 409,
        details: {mutationOutcome: 'not_applied', requestId: input.requestId}}, input, {operation: value.operation}) !== true) return false; }
      catch { return false; }
    }
    return withinBytes(value, AGENT_TIMELINE_GAIN_LIMITS.proposalBytes);
  }
  return Object.freeze({isAgentTimelineGainArguments, isAgentTimelineGainSource, isAgentTimelineGainTarget,
    isAgentTimelineGainPublicTarget, isAgentTimelineGainReviewTarget, isAgentTimelineGainProposal,
    agentTimelineGainTargetFromTimeline, agentTimelineGainPublicTarget, agentTimelineGainReviewTarget,
    agentTimelineGainModelContext, agentTimelineGainDiff});
}
export type AgentTimelineGainContracts = ReturnType<typeof createAgentTimelineGainContracts>;
