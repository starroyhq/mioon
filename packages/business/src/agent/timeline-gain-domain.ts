import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {AgentTimelineGainTarget, AgentTimelineGainArguments} from '@mioon/contracts/agent-timeline-gain';

const operation = 'timeline.clip.update';
const canonical = (value: unknown): string => JSON.stringify(value, (_key, child: unknown) => child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
});
type Timeline = {id: string; projectId: string; revision: number; clips: Array<{id: string; [key: string]: unknown}>; [key: string]: unknown};
type GainInput = {projectId: string; clipId: string; expectedRevision: number; patch: AgentTimelineGainArguments; requestId: string};
interface Boundary {
  read(options?: {sourceSemantics?: boolean}): Timeline | null;
  clipSource(clip: unknown): Record<string, unknown>;
  sources(timeline: unknown): unknown;
  replay(operation: string, text: string): Timeline;
  [key: string]: unknown;
}
interface Options {
  createBoundary(db: DatabaseSync, input: {projectId: string}): Boundary;
  readReceipt(db: DatabaseSync, input: GainInput, operation: string): {requestHash: string; response: string} | null | undefined;
  isTarget(value: unknown, options?: {projectId?: string}): value is AgentTimelineGainTarget;
  isArguments(value: unknown): value is AgentTimelineGainArguments;
  targetFromTimeline(timeline: unknown, clipId: string, source: unknown): AgentTimelineGainTarget | null;
  diff(target: unknown, arguments_: unknown): unknown;
  isMutationResponse(operation: string, input: unknown, response: unknown): boolean;
  fail(code: 'TIMELINE_SOURCE_UNAVAILABLE' | 'AGENT_EDIT_CONFLICT' | 'AGENT_EDIT_VALIDATION' | 'INVALID_TIMELINE_SNAPSHOT'): never;
}

/** A fixed gain authorization boundary around the shared timeline transaction.
 * It neither writes a timeline nor dispatches a user/model-named operation. */
export function createAgentTimelineGainDomain(options: Options) {
  const {createBoundary, readReceipt, isTarget, isArguments, targetFromTimeline} = options;
  function fail(code: Parameters<Options['fail']>[0]): never { return options.fail(code); }
  function unavailable(): never { return fail('TIMELINE_SOURCE_UNAVAILABLE'); }
  function invalid(): never { return fail('AGENT_EDIT_VALIDATION'); }
  function corrupt(): never { return fail('INVALID_TIMELINE_SNAPSHOT'); }
  function projectedTarget(timeline: Timeline, projectId: string, clipId: string, boundary: Boundary): AgentTimelineGainTarget {
    const clip = timeline.clips.find(value => value.id === clipId); if (!clip) unavailable();
    const source = boundary.clipSource(clip);
    const target = targetFromTimeline(timeline, clipId, {id: source.id, sha256: source.sha256, mimeType: source.mimeType, hasAudio: source.hasAudio});
    if (!target || target.projectId !== projectId) unavailable(); return target;
  }
  function pinAgentTimelineGainTarget(db: DatabaseSync, projectId: string, input: unknown): AgentTimelineGainTarget {
    if (!uuid(projectId) || !exact(input, ['timelineId', 'clipId', 'expectedRevision']) || !uuid(input.timelineId) || !uuid(input.clipId) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 || Number(input.expectedRevision) >= Number.MAX_SAFE_INTEGER) invalid();
    const boundary = createBoundary(db, {projectId}), timeline = boundary.read();
    if (!timeline || timeline.id !== input.timelineId) unavailable();
    if (timeline.revision !== input.expectedRevision) fail('AGENT_EDIT_CONFLICT');
    return projectedTarget(timeline, projectId, input.clipId, boundary);
  }
  function assertSourceIdentity(boundary: Boundary, target: AgentTimelineGainTarget, fresh: boolean): void {
    const source = boundary.clipSource(target.clip);
    if (source.id !== target.source.id || source.sha256 !== target.source.sha256 || source.mimeType !== target.source.mimeType || fresh && source.hasAudio !== true) unavailable();
  }
  // An applied ACK is a historical fact. Current metadata discovery cannot
  // rewrite it; current owner and immutable source bytes remain mandatory.
  function assertAgentTimelineGainOwnership(db: DatabaseSync, target: unknown): Timeline {
    if (!isTarget(target)) corrupt();
    const boundary = createBoundary(db, {projectId: target.projectId}), current = boundary.read({sourceSemantics: false});
    if (!current || current.id !== target.timelineId) unavailable();
    assertSourceIdentity(boundary, target, false); return current;
  }
  function assertAgentTimelineGainTarget(db: DatabaseSync, target: unknown): void {
    if (!isTarget(target)) invalid();
    const pinned = pinAgentTimelineGainTarget(db, target.projectId, {timelineId: target.timelineId, clipId: target.clip.id, expectedRevision: target.expectedRevision});
    if (!same(pinned, target)) fail('AGENT_EDIT_CONFLICT');
  }
  function createAgentTimelineGainBoundary(db: DatabaseSync, rawInput: unknown, rawTarget: unknown): Boundary {
    if (!isTarget(rawTarget) || !exact(rawInput, ['projectId', 'clipId', 'expectedRevision', 'patch', 'requestId']) || rawInput.projectId !== rawTarget.projectId || rawInput.clipId !== rawTarget.clip.id || rawInput.expectedRevision !== rawTarget.expectedRevision || !isArguments(rawInput.patch) || !uuid(rawInput.requestId) || !options.diff(rawTarget, rawInput.patch)) invalid();
    const target = rawTarget, input = rawInput as GainInput, boundary = createBoundary(db, input);
    const inside = (): void => { if (!db.isTransaction) throw new Error('Agent gain scope requires the shared timeline transaction'); };
    return {...boundary,
      read(readOptions) {
        inside(); const current = boundary.read(readOptions);
        if (!current || current.id !== target.timelineId) unavailable();
        // Leave ordinary stale revision rejection to the shared CAS so its
        // transaction-bound not_applied proof remains the only definitive one.
        if (current.revision === target.expectedRevision && !same(projectedTarget(current, input.projectId, target.clip.id, boundary), target)) unavailable();
        return current;
      },
      replay(op, text) {
        inside(); if (op !== operation) corrupt();
        let response: unknown; try { response = JSON.parse(text); } catch { corrupt(); }
        if (!options.isMutationResponse(operation, input, response)) corrupt();
        const historical = response as Timeline;
        const current = assertAgentTimelineGainOwnership(db, target);
        if (current.id !== historical.id || current.revision < historical.revision || historical.revision !== target.expectedRevision + 1) corrupt();
        boundary.sources(historical);
        const projected = targetFromTimeline({...historical, revision: target.expectedRevision}, target.clip.id, target.source);
        if (!projected || !same(projected, {...target, clip: {...target.clip, gain: input.patch.gain}})) corrupt();
        return historical;
      },
    };
  }
  function readAgentTimelineGainReceipt(db: DatabaseSync, input: GainInput, target: AgentTimelineGainTarget) {
    if (!db.isTransaction) throw new Error('Agent receipt reconciliation requires a transaction');
    const boundary = createAgentTimelineGainBoundary(db, input, target);
    assertAgentTimelineGainOwnership(db, target);
    const saved = readReceipt(db, input, operation); if (!saved) return null;
    if (saved.requestHash !== createHash('sha256').update(canonical({operation, input})).digest('hex')) corrupt();
    const response = boundary.replay(operation, saved.response);
    return {status: 'applied' as const, timelineId: response.id, clipId: target.clip.id, revision: response.revision};
  }
  return {pinAgentTimelineGainTarget, assertAgentTimelineGainOwnership, assertAgentTimelineGainTarget, createAgentTimelineGainBoundary, readAgentTimelineGainReceipt};
}
