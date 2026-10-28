import {canonicalPrevisValue} from '@mioon/contracts';
import type {PrevisScene} from '@mioon/contracts';

// Undo and redo cover only the edits made since the editor opened, like most
// 3D editors; nothing is kept across sessions. Continuous edits of one control
// (dragging a figure, a slider) collapse into one step.
export const PREVIS_HISTORY_LIMIT = 200;
export const PREVIS_HISTORY_COALESCE_MS = 600;
export interface PrevisHistory {
  readonly past: readonly PrevisScene[];
  readonly future: readonly PrevisScene[];
  readonly key: string | null;
  readonly at: number;
}
export const emptyPrevisHistory = (): PrevisHistory => ({past: [], future: [], key: null, at: 0});
const same = (a: PrevisScene, b: PrevisScene): boolean => canonicalPrevisValue(a) === canonicalPrevisValue(b);

/** Records `before` as the step to return to when `after` replaces it. An edit
 * with the same key soon after the previous one joins that step. */
export function recordPrevisEdit(history: PrevisHistory, before: PrevisScene, after: PrevisScene, {key = null, now = Date.now()}: {key?: string | null; now?: number} = {}): PrevisHistory {
  if (same(before, after)) return history;
  if (key !== null && key === history.key && now - history.at <= PREVIS_HISTORY_COALESCE_MS && history.past.length) return {...history, future: [], at: now};
  const past = [...history.past, before];
  return {past: past.length > PREVIS_HISTORY_LIMIT ? past.slice(past.length - PREVIS_HISTORY_LIMIT) : past, future: [], key, at: now};
}
export function undoPrevisEdit(history: PrevisHistory, current: PrevisScene): {history: PrevisHistory; scene: PrevisScene} | null {
  const previous = history.past.at(-1);
  if (!previous) return null;
  return {scene: previous, history: {past: history.past.slice(0, -1), future: [...history.future, current], key: null, at: 0}};
}
export function redoPrevisEdit(history: PrevisHistory, current: PrevisScene): {history: PrevisHistory; scene: PrevisScene} | null {
  const next = history.future.at(-1);
  if (!next) return null;
  return {scene: next, history: {past: [...history.past, current], future: history.future.slice(0, -1), key: null, at: 0}};
}
export const canUndoPrevis = (history: PrevisHistory): boolean => history.past.length > 0;
export const canRedoPrevis = (history: PrevisHistory): boolean => history.future.length > 0;
