import type { AgentTaskChange, AgentTaskJson, AgentTaskSnapshot, AgentTaskStep, AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { Locale } from '../../../packages/i18n/src/types.ts';
import { translate } from '../../../packages/i18n/src/index.ts';
import { taskStepTitle, taskTargetTitle, taskToolStepExplanation } from './agent-task-presentation.ts';
import type { TaskDisplayLookup } from './agent-task-presentation.ts';

export interface MioFollowTarget {
  kind: 'shot' | 'node' | 'timeline_clip' | 'timeline_subtitle' | 'timeline_track';
  id: string;
  name: string;
}

export type MioFollowLocation = { kind: 'canvas'; x: number; y: number }
  | { kind: 'timeline'; trackId: string; startFrame: number };

export interface MioFollowFocus {
  runId: string;
  stepId: string;
  text: string;
  phase: 'idle' | 'operate' | 'approval';
  target?: MioFollowTarget;
  location?: MioFollowLocation;
  highlight?: boolean;
  changeId?: string;
}

export type MioFollowTargetExists = (target: Pick<MioFollowTarget, 'kind' | 'id'>) => boolean;
type Presentation = {
  locale: Locale;
  lookup?: TaskDisplayLookup;
  shotNumber?: (id: string) => number | undefined;
  exists?: MioFollowTargetExists;
};

const PALETTE = [
  '#EBA384', '#EBE184', '#E6EB84', '#D6EB84', '#C7EB84', '#B8EB84', '#A8EB84', '#99EB84',
  '#89EB84', '#84EB8E', '#84EBCC', '#84EBDC', '#84EBEB', '#84DCEB', '#84CCEB', '#84BDEB',
  '#84ADEB', '#849EEB', '#848EEB', '#8984EB', '#9984EB', '#A884EB', '#B884EB', '#C784EB',
  '#D684EB', '#E684EB', '#EB84E1', '#EB84D1', '#EB84C2', '#EB84B2', '#EB84A3',
] as const;

export function mioFollowColor(runId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < runId.length; index++) hash = Math.imul(hash ^ runId.charCodeAt(index), 16777619);
  return PALETTE[(hash >>> 0) % PALETTE.length]!;
}

const targetKinds: ReadonlySet<string> = new Set(['shot', 'node', 'timeline_clip', 'timeline_subtitle', 'timeline_track']);
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const record = (value: AgentTaskJson | undefined) => value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const idValue = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);
const concreteReadTools = new Set(['mioon_previs_inspect', 'mioon_subject_binding_list', 'mioon_version_list', 'mioon_timeline_clip_loudness']);
const liveToolStatuses = new Set(['intent', 'awaiting_approval', 'dispatch_started', 'completed']);
const terminalRunStatuses = new Set(['completed', 'failed', 'stopped', 'reverted']);
const waitingTools = new Set(['mioon_task_wait', 'mioon_ask']);
const observation = (step: AgentTaskStep): boolean => step.kind === 'wait' || step.tier === 'read_only'
  || concreteReadTools.has(step.toolCall?.name ?? '') || waitingTools.has(step.toolCall?.name ?? '');
const canvasCreationTools = new Set(['mioon_shot_create', 'mioon_node_create', 'mioon_previs_create', 'mioon_scene_shots_create']);
const creationTools = new Set([...canvasCreationTools, 'mioon_timeline_clip_add', 'mioon_timeline_subtitle_add',
  'mioon_timeline_track_add', 'mioon_timeline_seed', 'mioon_timeline_shots_append', 'mioon_timeline_clip_splitAtScenes']);
const timelineTrackChanges = new Set(['timeline.track.add', 'timeline.track.update']);

type TargetIdentity = Pick<MioFollowTarget, 'kind' | 'id'>;
type TargetCandidate = { kind: string; id: unknown };

const belongsOnWorkbench = (target: TargetCandidate): target is TargetIdentity => targetKinds.has(target.kind) && idValue(target.id);

function displayedTarget(target: TargetIdentity, { locale, lookup, shotNumber }: Presentation, fallbackName?: string): MioFollowTarget {
  const number = target.kind === 'shot' ? shotNumber?.(target.id) : undefined;
  const name = number === undefined ? taskTargetTitle(target.kind, target.id, locale, lookup, fallbackName)
    : translate(locale, 'agent.follow.shot', { number: String(number).padStart(2, '0') });
  return { kind: target.kind, id: target.id, name };
}

/** Read only the fields the named tool can use to point at a workbench object.
 * A live intent can arrive before the host has published its prepared targets. */
function* argumentTargets(step: AgentTaskStep): Generator<TargetCandidate> {
  const name = step.toolCall?.name;
  const input = record(step.toolCall?.arguments);
  if (!input) return;
  switch (name) {
    case 'mioon_shot_update':
    case 'mioon_generation_submit':
    case 'mioon_version_select':
    case 'mioon_version_list':
    case 'mioon_subject_binding_set':
    case 'mioon_subject_binding_list':
      yield { kind: 'shot', id: input.shotId };
      return;
    case 'mioon_shot_reorder':
      for (const id of Array.isArray(input.shotIds) ? input.shotIds : []) yield { kind: 'shot', id };
      return;
    case 'mioon_node_update':
    case 'mioon_previs_inspect':
    case 'mioon_previs_scene_set':
      yield { kind: 'node', id: input.nodeId };
      return;
    case 'mioon_reference_attach':
      yield { kind: 'shot', id: input.targetShotId };
      yield { kind: 'node', id: input.sourceNodeId };
      return;
    case 'mioon_edge_create':
      for (const id of [input.target, input.source]) {
        yield { kind: 'shot', id };
        yield { kind: 'node', id };
      }
      return;
    case 'mioon_canvas_layout':
    case 'mioon_canvas_archive':
    case 'mioon_canvas_restore':
      for (const item of Array.isArray(input.targets) ? input.targets : []) {
        const target = record(item);
        if (target?.kind === 'shot' || target?.kind === 'node') yield { kind: target.kind, id: target.id };
      }
      return;
    case 'mioon_timeline_clip_update':
    case 'mioon_timeline_clip_replaceSource':
    case 'mioon_timeline_clip_remove':
    case 'mioon_timeline_clip_rippleRemove':
    case 'mioon_timeline_clip_split':
    case 'mioon_timeline_clip_loudness':
      yield { kind: 'timeline_clip', id: input.clipId };
      return;
    case 'mioon_timeline_clip_refreshSources':
      for (const id of Array.isArray(input.clipIds) ? input.clipIds : []) yield { kind: 'timeline_clip', id };
      return;
    case 'mioon_timeline_clip_crossfade':
      yield { kind: 'timeline_clip', id: input.outgoingClipId };
      yield { kind: 'timeline_clip', id: input.incomingClipId };
      return;
    case 'mioon_timeline_clip_setGains':
      for (const item of Array.isArray(input.gains) ? input.gains : []) yield { kind: 'timeline_clip', id: record(item)?.clipId };
      return;
    case 'mioon_timeline_subtitle_update':
    case 'mioon_timeline_subtitle_remove':
      yield { kind: 'timeline_subtitle', id: input.cueId };
      return;
    case 'mioon_timeline_track_update':
      yield { kind: 'timeline_track', id: input.trackId };
  }
}

function liveTarget(step: AgentTaskStep, presentation: Presentation): MioFollowTarget | undefined {
  const { exists } = presentation;
  if (!exists) return;
  const fromStep = step.targets?.find((target): target is AgentTaskTarget & TargetIdentity =>
    target.kind !== 'timeline_track' && belongsOnWorkbench(target) && exists(target));
  if (fromStep) return displayedTarget(fromStep, presentation);
  for (const target of argumentTargets(step)) {
    if (belongsOnWorkbench(target) && exists(target)) return displayedTarget(target, presentation);
  }
  const name = step.toolCall?.name;
  if (name && (name.startsWith('mioon_timeline_clip_') || name.startsWith('mioon_timeline_subtitle_'))) return;
  const track = step.targets?.find((target): target is AgentTaskTarget & TargetIdentity =>
    target.kind === 'timeline_track' && belongsOnWorkbench(target) && exists(target));
  if (track) return displayedTarget(track, presentation);
}

function creationLocation(step: AgentTaskStep): MioFollowLocation | undefined {
  const name = step.toolCall?.name, input = record(step.toolCall?.arguments);
  if (!input || !name) return;
  if (canvasCreationTools.has(name)) {
    const position = record(input.position);
    if (typeof position?.x === 'number' && Number.isFinite(position.x) && typeof position.y === 'number' && Number.isFinite(position.y)) {
      return { kind: 'canvas', x: position.x, y: position.y };
    }
  }
  if (typeof input.startFrame !== 'number' || !Number.isSafeInteger(input.startFrame) || input.startFrame < 0) return;
  if (name === 'mioon_timeline_subtitle_add') return { kind: 'timeline', trackId: 'subtitle', startFrame: input.startFrame };
  if (name === 'mioon_timeline_clip_add' && idValue(input.trackId)) return { kind: 'timeline', trackId: input.trackId, startFrame: input.startFrame };
}

type LocatedChange = { target: MioFollowTarget; changeId: string };

function appliedChanges(snapshot: AgentTaskSnapshot): Map<string, AgentTaskChange[]> {
  const changes = new Map<string, AgentTaskChange[]>();
  for (const change of snapshot.changes) {
    if (change.runId !== snapshot.run.id || change.projectId !== snapshot.run.projectId || change.status !== 'applied' || change.modifiedAfter) continue;
    const entries = changes.get(change.stepId) ?? [];
    entries.push(change);
    changes.set(change.stepId, entries);
  }
  return changes;
}

function removedIdentity(step: AgentTaskStep, operation: string): unknown {
  const input = record(step.toolCall?.arguments);
  if (!input) return;
  if (operation === 'timeline.clip.remove' || operation === 'timeline.clip.rippleRemove') return input.clipId;
  if (operation === 'timeline.subtitle.remove') return input.cueId;
}

function locatedChanges(step: AgentTaskStep, changes: readonly AgentTaskChange[], presentation: Presentation): LocatedChange[] {
  if (step.kind !== 'tool' || observation(step)) return [];
  const order = new Map((step.targets ?? []).map(({ kind, id }, index) => [`${kind}:${id}`, index]));
  const rank = (target: AgentTaskTarget) => order.get(`${target.kind}:${target.id}`) ?? Number.MAX_SAFE_INTEGER;
  const seen = new Set<string>(), located: LocatedChange[] = [];
  for (const change of [...changes].reverse()) {
    const removed = removedIdentity(step, change.operation);
    const targets = change.targets.filter((target): target is AgentTaskTarget & TargetIdentity =>
      belongsOnWorkbench(target) && target.id !== removed && (target.kind !== 'timeline_track' || timelineTrackChanges.has(change.operation)));
    targets.sort((left, right) => (change.operation === 'timeline.seed' ? Number(right.revisionBefore === 0) - Number(left.revisionBefore === 0) : 0)
      || rank(left) - rank(right) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    for (const target of targets) {
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fallbackName = change.display?.targets.find(item => item.kind === target.kind && item.id === target.id)?.name;
      located.push({ changeId: change.id, target: displayedTarget(target, presentation, fallbackName) });
    }
  }
  return located;
}

export function mioFollowTargetsByStep(snapshot: AgentTaskSnapshot, presentation: Presentation, exists?: MioFollowTargetExists): Map<string, MioFollowTarget[]> {
  const changes = appliedChanges(snapshot), result = new Map<string, MioFollowTarget[]>();
  for (const step of snapshot.steps) {
    const targets = locatedChanges(step, changes.get(step.id) ?? [], presentation).map(item => item.target);
    const current = exists ? targets.filter(exists) : targets;
    if (current.length) result.set(step.id, current);
  }
  return result;
}

function latestFocus(snapshot: AgentTaskSnapshot, presentation: Presentation): MioFollowFocus | null {
  const { run } = snapshot;
  if (terminalRunStatuses.has(run.status)) return null;
  const step = snapshot.steps.at(-1);
  const idle: MioFollowFocus = {
    runId: run.id, stepId: step?.id ?? run.id, phase: 'idle',
    text: step ? taskToolStepExplanation(step) ?? taskStepTitle(step, presentation.locale)
      : translate(presentation.locale, run.status === 'accepted' ? 'agent.task.status.accepted' : 'agent.display.model'),
  };
  if (step?.kind !== 'tool' || waitingTools.has(step.toolCall?.name ?? '') ||
    run.status === 'paused' || run.status === 'interrupted' || run.status === 'awaiting_answer') return idle;
  const changes = appliedChanges(snapshot).get(step.id) ?? [];
  const located = locatedChanges(step, changes, presentation)[0];
  const location = creationLocation(step);
  if (located) return { ...idle, ...located, ...(location ? { location } : {}), phase: 'operate', highlight: true };
  // A completed edit without a surviving target (for example a deletion) no
  // longer points at the pre-edit object, even while project data is refreshing.
  if (changes.length || !liveToolStatuses.has(step.status)) return idle;
  const target = creationTools.has(step.toolCall?.name ?? '') ? undefined : liveTarget(step, presentation);
  const phase = step.status === 'awaiting_approval' ? 'approval' : 'operate';
  if (target) return { ...idle, phase, target, highlight: !observation(step) };
  if (location) return { ...idle, phase, location };
  return idle;
}

function sameLocation(left?: MioFollowLocation, right?: MioFollowLocation): boolean {
  if (!left || !right) return left === right;
  if (left.kind === 'canvas') return right.kind === 'canvas' && left.x === right.x && left.y === right.y;
  return right.kind === 'timeline' && left.trackId === right.trackId && left.startFrame === right.startFrame;
}

const sameFocus = (left: MioFollowFocus | null, right: MioFollowFocus | null): boolean =>
  left?.runId === right?.runId && left?.stepId === right?.stepId && left?.text === right?.text && left?.changeId === right?.changeId &&
  left?.phase === right?.phase && left?.highlight === right?.highlight && sameLocation(left?.location, right?.location) &&
  left?.target?.kind === right?.target?.kind && left?.target?.id === right?.target?.id && left?.target?.name === right?.target?.name;

export function createMioFollowTracker() {
  let previous: AgentTaskSnapshot | null = null, previousFocus: MioFollowFocus | null = null, wasEnabled = false, shown = false;
  return {
    observe(snapshot: AgentTaskSnapshot | null, presentation: Presentation, enabled: boolean, sendRequestId?: string): MioFollowFocus | null | undefined {
      const sameRun = snapshot !== null && snapshot.run.id === previous?.run.id;
      if (sameRun && snapshot.run.revision < previous!.run.revision) return;
      if (enabled && wasEnabled && snapshot && snapshot === previous) return;
      const nextFocus = snapshot && latestFocus(snapshot, presentation), changed = !sameFocus(previousFocus, nextFocus);
      const live = sameRun && wasEnabled || Boolean(sendRequestId && sendRequestId === snapshot?.run.requestId);
      previous = snapshot;
      previousFocus = nextFocus;
      wasEnabled = enabled;
      // Only a matching live send may focus its first snapshot. Opening a
      // history entry or reloading an existing conversation establishes a baseline.
      if (!enabled || !snapshot || !live) {
        if (!shown) return;
        shown = false;
        return null;
      }
      if (!changed || (!nextFocus && !shown)) return;
      shown = nextFocus !== null;
      return nextFocus;
    },
  };
}
