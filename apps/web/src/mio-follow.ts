import type { AgentTaskChange, AgentTaskSnapshot, AgentTaskStep, AgentTaskTarget } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { Locale } from '../../../packages/i18n/src/types.ts';
import { translate } from '../../../packages/i18n/src/index.ts';
import { taskStepTitle, taskTargetTitle, taskToolStepExplanation } from './agent-task-presentation.ts';
import type { TaskDisplayLookup } from './agent-task-presentation.ts';

export interface MioFollowTarget {
  kind: 'shot' | 'node' | 'timeline_clip' | 'timeline_subtitle';
  id: string;
  name: string;
}

export interface MioFollowFocus {
  runId: string;
  stepId: string;
  text: string;
  target?: MioFollowTarget;
  changeId?: string;
}

export type MioFollowTargetExists = (target: Pick<MioFollowTarget, 'kind' | 'id'>) => boolean;
type Presentation = { locale: Locale; lookup?: TaskDisplayLookup; shotNumber?: (id: string) => number | undefined };

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

const targetKinds: ReadonlySet<string> = new Set(['shot', 'node', 'timeline_clip', 'timeline_subtitle']);
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const observation = (step: AgentTaskStep): boolean => step.kind === 'wait' || step.tier === 'read_only' || step.toolCall?.name === 'mioon_task_wait';
const pendingEffect = (step: AgentTaskStep): boolean => ['intent', 'awaiting_approval', 'dispatch_started'].includes(step.status);

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
  const input = step.toolCall?.arguments;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  if (operation === 'timeline.clip.remove' || operation === 'timeline.clip.rippleRemove') return input.clipId;
  if (operation === 'timeline.subtitle.remove') return input.cueId;
}

function locatedChanges(step: AgentTaskStep, changes: readonly AgentTaskChange[], { locale, lookup, shotNumber }: Presentation): LocatedChange[] {
  if (step.kind !== 'tool' || observation(step)) return [];
  const order = new Map((step.targets ?? []).map(({ kind, id }, index) => [`${kind}:${id}`, index]));
  const rank = (target: AgentTaskTarget) => order.get(`${target.kind}:${target.id}`) ?? Number.MAX_SAFE_INTEGER;
  const seen = new Set<string>(), located: LocatedChange[] = [];
  for (const change of [...changes].reverse()) {
    const removed = removedIdentity(step, change.operation);
    const targets = change.targets.filter(target => targetKinds.has(target.kind) && idPattern.test(target.id) && target.id !== removed);
    targets.sort((left, right) => (change.operation === 'timeline.seed' ? Number(right.revisionBefore === 0) - Number(left.revisionBefore === 0) : 0)
      || rank(left) - rank(right) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
    for (const target of targets) {
      const key = `${target.kind}:${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const fallbackName = change.display?.targets.find(item => item.kind === target.kind && item.id === target.id)?.name;
      const number = target.kind === 'shot' ? shotNumber?.(target.id) : undefined;
      const name = number === undefined ? taskTargetTitle(target.kind, target.id, locale, lookup, fallbackName)
        : translate(locale, 'agent.follow.shot', { number: String(number).padStart(2, '0') });
      located.push({ changeId: change.id, target: { kind: target.kind as MioFollowTarget['kind'], id: target.id, name } });
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
  const changes = appliedChanges(snapshot);
  for (const step of [...snapshot.steps].reverse()) {
    if (step.kind === 'model') continue;
    const located = locatedChanges(step, changes.get(step.id) ?? [], presentation)[0];
    // A pending write or approval has yet to land. Keep the last saved step
    // in focus while the next mutation waits; reads and waits have their own bubble.
    if (!located && pendingEffect(step) && !observation(step)) continue;
    return { runId: snapshot.run.id, stepId: step.id, text: taskToolStepExplanation(step) ?? taskStepTitle(step, presentation.locale), ...located };
  }
  return null;
}

const sameFocus = (left: MioFollowFocus | null, right: MioFollowFocus | null): boolean =>
  left?.runId === right?.runId && left?.stepId === right?.stepId && left?.text === right?.text && left?.changeId === right?.changeId &&
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
      if (!changed) return;
      shown = nextFocus !== null;
      return nextFocus;
    },
  };
}
