import type { AgentTaskChange, AgentTaskSnapshot } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createTargetMarks, markableTargets, markTargetElements } from './target-marks.ts';
import type { TargetMarks, TargetMarksOptions } from './target-marks.ts';
import { mioFollowColor } from './mio-follow.ts';
import type { MioFollowTarget } from './mio-follow.ts';

export interface AgentTaskReveal { changeId: string; nonce: number }
export interface AgentChangeMarks {
  readonly marks: TargetMarks;
  /**
   * Takes the changes a Mio session reports as newly saved and returns the ones to mark once the project view
   * has refreshed. Each change is marked at most once; marks of undone, superseded or since-edited changes end.
   */
  accept(snapshot: AgentTaskSnapshot, landed: readonly string[]): AgentTaskChange[];
  /** Marks newly saved changes whose targets are visible now. It never switches modes or scrolls. */
  show(changes: readonly AgentTaskChange[]): void;
  /** Marks a change the user asked to locate; the caller has just brought it into view. */
  locate(change: AgentTaskChange): void;
  /** Ends every mark, for example when the workspace mode changes. */
  clear(): void;
  /** Ends every mark and forgets marked changes, for a project switch. */
  reset(): void;
  dispose(): void;
}
const markEntry = (change: AgentTaskChange) => ({ owner: change.id, targets: change.targets, color: mioFollowColor(change.runId) });
const ended = (change: AgentTaskChange): boolean => change.status !== 'applied' || change.modifiedAfter === true;
// The refreshed canvas and timeline commit, and React Flow measures new nodes, within two frames.
const afterTwoFrames = (callback: () => void): void => { requestAnimationFrame(() => requestAnimationFrame(callback)); };

export function createAgentChangeMarks({ afterLayout = afterTwoFrames, ...options }: TargetMarksOptions & { afterLayout?: (callback: () => void) => void } = {}): AgentChangeMarks {
  const marks = createTargetMarks(options), seen = new Set<string>();
  let epoch = 0;
  return {
    marks,
    accept(snapshot, landed) {
      marks.release(snapshot.changes.filter(ended).map(change => change.id));
      const ids = new Set(landed);
      const fresh = snapshot.changes.filter(change => ids.has(change.id) && !ended(change) && !seen.has(change.id));
      for (const change of fresh) seen.add(change.id);
      return fresh;
    },
    show(changes) {
      if (!changes.length) return;
      const owner = epoch;
      afterLayout(() => { if (owner === epoch) marks.mark(changes.map(markEntry), { requireVisible: true }); });
    },
    locate(change) { marks.mark([markEntry(change)], { requireVisible: false }); },
    clear() { epoch++; marks.clear(); },
    reset() { epoch++; marks.clear(); seen.clear(); },
    dispose() { epoch++; seen.clear(); marks.dispose(); },
  };
}

/** Bring a saved clip or cue into its own scroll viewport without seeking or selecting it. */
export function revealMioFollowTimeline(target: MioFollowTarget, behavior: ScrollBehavior, document: Document = globalThis.document): boolean {
  const element = markTargetElements(target, document)[0];
  const viewport = element?.closest<HTMLElement>('[data-testid="timeline-scroll"]');
  if (!element || !viewport || viewport.closest('[hidden], [inert]') || !viewport.offsetWidth) return false;
  const bounds = viewport.getBoundingClientRect(), clip = element.getBoundingClientRect();
  if (!clip.width || !clip.height || !bounds.width) return false;
  const scale = bounds.width / viewport.offsetWidth;
  const header = viewport.querySelector('.track-label')?.getBoundingClientRect();
  const ruler = viewport.querySelector('.timeline-ruler-row')?.getBoundingClientRect();
  const left = Math.max(bounds.left, header?.right ?? bounds.left), right = bounds.left + viewport.clientWidth * scale;
  const top = Math.max(bounds.top, ruler?.bottom ?? bounds.top), bottom = bounds.top + viewport.clientHeight * scale;
  if (left >= right || top >= bottom) return false;
  let x = viewport.scrollLeft, y = viewport.scrollTop;
  if (clip.left < left || clip.right > right) x += (clip.left + clip.width / 2 - (left + right) / 2) / scale;
  if (clip.top < top || clip.bottom > bottom) y += (clip.top + clip.height / 2 - (top + bottom) / 2) / scale;
  if (x !== viewport.scrollLeft || y !== viewport.scrollTop) viewport.scrollTo({ left: x, top: y, behavior });
  return true;
}

/**
 * Brings a change's first target into view on the timeline and marks it. Canvas targets are framed by the
 * caller's fitView instead: scrolling the overflow-hidden flow pane would shift the whole canvas. It changes
 * neither selection nor inspector ownership.
 */
export function locateAgentTaskChange(change: AgentTaskChange, marks: AgentChangeMarks, document: Document = globalThis.document): void {
  const first = markableTargets(change.targets).flatMap(target => target.kind === 'shot' || target.kind === 'node' ? [] : markTargetElements(target, document))[0];
  const reduced = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  first?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest', inline: 'center' });
  marks.locate(change);
}

/**
 * Opens a change row in the Mio log: scrolls it into view, focuses its locate button and highlights it for a
 * moment. Returns null when the row is not in this log, for example while another conversation is open.
 */
export function revealAgentTaskChangeRow(log: HTMLElement, changeId: string, { setTimer = (callback: () => void, ms: number): unknown => setTimeout(callback, ms), clearTimer = (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>), highlightMs = 1600 } = {}): { following: boolean; cleanup: () => void } | null {
  const row = [...log.querySelectorAll<HTMLElement>('[data-change-id]')].find(item => item.getAttribute('data-change-id') === changeId);
  if (!row) return null;
  row.scrollIntoView({ block: 'nearest' });
  row.querySelector<HTMLElement>('.mio-change-locate')?.focus({ preventScroll: true });
  row.setAttribute('data-revealed', 'true');
  const timer = setTimer(() => row.removeAttribute('data-revealed'), highlightMs);
  // The log follows new rounds only while it is scrolled to the end; a revealed older row stops that.
  return { following: log.scrollHeight - log.clientHeight - log.scrollTop < 24, cleanup: () => { clearTimer(timer); row.removeAttribute('data-revealed'); } };
}
