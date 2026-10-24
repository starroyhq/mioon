import type { AgentTaskChange, AgentTaskSnapshot } from '../../../packages/contracts/src/agent-tasks-v2.ts';
import { createTargetMarks, markableTargets, markTargetElements } from './target-marks.ts';
import type { TargetMarks, TargetMarksOptions } from './target-marks.ts';

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
      afterLayout(() => { if (owner === epoch) marks.mark(changes.map(change => ({ owner: change.id, targets: change.targets })), { requireVisible: true }); });
    },
    locate(change) { marks.mark([{ owner: change.id, targets: change.targets }], { requireVisible: false }); },
    clear() { epoch++; marks.clear(); },
    reset() { epoch++; marks.clear(); seen.clear(); },
    dispose() { epoch++; seen.clear(); marks.dispose(); },
  };
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
