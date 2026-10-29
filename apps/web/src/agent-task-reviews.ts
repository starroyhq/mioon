import { AGENT_TASK_SKILL_NAMES, agentTaskContinuityReportSchema } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import type { AgentTaskContinuityCategory, AgentTaskContinuityIssue, AgentTaskSkillName, AgentTaskSnapshot, AgentTaskStep } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createTargetMarks } from './target-marks.ts';
import type { MarkTarget, TargetMarks, TargetMarksOptions } from './target-marks.ts';

/** The host continuity-report tool (C6). Reports are shown only from saved arguments. */
export const CONTINUITY_REPORT_TOOL = 'mioon_continuity_report';
export const SKILL_READ_TOOL = 'mioon_skill_read';

/** A completed `mioon_continuity_report` step's issues; invalid or unfinished reports show nothing. */
export function taskContinuityReportOf(step: AgentTaskStep): AgentTaskContinuityIssue[] | null {
  if (step.kind !== 'tool' || step.status !== 'completed' || step.toolCall?.name !== CONTINUITY_REPORT_TOOL) return null;
  const parsed = agentTaskContinuityReportSchema.safeParse(step.toolCall.arguments);
  return parsed.success ? parsed.data.issues : null;
}

/** The method a `mioon_skill_read` step read, when its saved arguments name a listed one. */
export function taskSkillReadOf(step: AgentTaskStep): AgentTaskSkillName | null {
  if (step.kind !== 'tool' || step.toolCall?.name !== SKILL_READ_TOOL) return null;
  const args = step.toolCall.arguments, name = args && typeof args === 'object' && !Array.isArray(args) ? args.name : undefined;
  return typeof name === 'string' && (AGENT_TASK_SKILL_NAMES as readonly string[]).includes(name) ? name as AgentTaskSkillName : null;
}

/** i18n keys use camel case; skill names are kebab case. */
export const taskSkillTitleKey = (name: AgentTaskSkillName): `agent.skill.title.${string}` =>
  `agent.skill.title.${name.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())}`;

/** Owners of review marks: one per reported issue, stable for its saved step. */
export const reviewIssueOwner = (stepId: string, index: number): string => `review:${stepId}:${index}`;
export function parseReviewIssueOwner(owner: string): { stepId: string; index: number } | null {
  const match = /^review:([0-9a-f-]{36}):(\d{1,2})$/iu.exec(owner);
  return match ? { stepId: match[1]!, index: Number(match[2]) } : null;
}

/** One reported issue as the canvas and storyboard see it: its owner, category and shots. */
export interface ReviewIssueEntry { owner: string; category: AgentTaskContinuityCategory; shotIds: readonly string[] }
export interface AgentReviewReveal { owner: string; nonce: number }

/** The issues of one saved report, keyed by their mark owners. */
export function reviewIssueEntries(step: AgentTaskStep, issues: readonly AgentTaskContinuityIssue[]): ReviewIssueEntry[] {
  return issues.map((issue, index) => ({ owner: reviewIssueOwner(step.id, index), category: issue.category, shotIds: [...issue.shotIds] }));
}

/**
 * Tracks which reports of the rounds on screen were already seen. A report new to a round that was already on
 * screen arrived while it was watched; a first read of a round (opening history, reloading) reports none, so old
 * reports are never announced again. Mirrors how a Mio session reports newly saved changes.
 */
export function createReviewArrivals(): { arrived(rounds: readonly AgentTaskSnapshot[]): ReviewIssueEntry[] } {
  const seen = new Map<string, Set<string>>();
  return {
    arrived(rounds) {
      const fresh: ReviewIssueEntry[] = [];
      for (const snapshot of rounds) {
        const reports = snapshot.steps.flatMap(step => { const issues = taskContinuityReportOf(step); return issues ? [{ step, issues }] : []; });
        const known = seen.get(snapshot.run.id);
        if (!known) { seen.set(snapshot.run.id, new Set(reports.map(item => item.step.id))); continue; }
        for (const { step, issues } of reports) if (!known.has(step.id)) { known.add(step.id); fresh.push(...reviewIssueEntries(step, issues)); }
      }
      return fresh;
    },
  };
}

/** Canvas nodes come first, so an issue's label sits on its first visible shot; storyboard frames only glow. */
export const reviewMarkTargets = (shotIds: readonly string[]): MarkTarget[] =>
  [...shotIds.map(id => ({ kind: 'shot', id })), ...shotIds.map(id => ({ kind: 'storyboard_shot', id }))];

export interface AgentReviewMarks {
  readonly marks: TargetMarks;
  /** Marks the shots of newly reported issues that are visible now. It never switches modes or scrolls. */
  show(entries: readonly ReviewIssueEntry[]): void;
  /** Marks one issue's shots after the user asked to locate it; the caller has just brought them into view. */
  locate(entry: ReviewIssueEntry): void;
  /** The category of a marked issue, for its label's tooltip. */
  category(owner: string): AgentTaskContinuityCategory | undefined;
  /** Ends every mark, for example when the workspace mode changes. */
  clear(): void;
  /** Ends every mark and forgets categories, for a project switch. */
  reset(): void;
  dispose(): void;
}
// The canvas and storyboard commit, and React Flow measures nodes, within two frames.
const afterTwoFrames = (callback: () => void): void => { requestAnimationFrame(() => requestAnimationFrame(callback)); };

/** "待核对" marks (C6): Mio changed nothing on these shots, so they never use the "Mio 修改" marks. */
export function createAgentReviewMarks({ afterLayout = afterTwoFrames, ...options }: TargetMarksOptions & { afterLayout?: (callback: () => void) => void } = {}): AgentReviewMarks {
  const marks = createTargetMarks({ placement: 'inside', labelKinds: new Set(['shot']), ...options }), categories = new Map<string, AgentTaskContinuityCategory>();
  let epoch = 0;
  const entries = (items: readonly ReviewIssueEntry[]) => items.map(item => { categories.set(item.owner, item.category); return { owner: item.owner, targets: reviewMarkTargets(item.shotIds) }; });
  return {
    marks,
    show(items) {
      if (!items.length) return;
      const owner = epoch;
      afterLayout(() => { if (owner === epoch) marks.mark(entries(items), { requireVisible: true }); });
    },
    locate(item) { marks.mark(entries([item]), { requireVisible: false }); },
    category: owner => categories.get(owner),
    clear() { epoch++; marks.clear(); },
    reset() { epoch++; marks.clear(); categories.clear(); },
    dispose() { epoch++; categories.clear(); marks.dispose(); },
  };
}

/**
 * Opens a reported issue in the Mio log: scrolls it into view, focuses its locate button and highlights it for a
 * moment. Returns null when the issue is not in this log, for example while another conversation is open.
 */
export function revealReviewIssue(log: HTMLElement, owner: string, { setTimer = (callback: () => void, ms: number): unknown => setTimeout(callback, ms), clearTimer = (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>), highlightMs = 1600 } = {}): { following: boolean; cleanup: () => void } | null {
  const card = [...log.querySelectorAll<HTMLElement>('[data-review-owner]')].find(item => item.getAttribute('data-review-owner') === owner);
  if (!card) return null;
  card.scrollIntoView({ block: 'nearest' });
  card.querySelector<HTMLElement>('.mio-review-locate')?.focus({ preventScroll: true });
  card.setAttribute('data-revealed', 'true');
  const timer = setTimer(() => card.removeAttribute('data-revealed'), highlightMs);
  return { following: log.scrollHeight - log.clientHeight - log.scrollTop < 24, cleanup: () => { clearTimer(timer); card.removeAttribute('data-revealed'); } };
}

/** Two-digit storyboard numbers, as the strip shows them. */
export const shotNumberLabel = (number: number): string => String(number).padStart(2, '0');
