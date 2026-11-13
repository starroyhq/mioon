import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../contracts/src/app-error.ts';
import {CANVAS_EDIT_LIMITS} from '../../contracts/src/canvas-editing.ts';
import type {CanvasTarget} from '../../contracts/src/canvas-editing.ts';
import {hasCanvasArchives} from './canvas-active.ts';
import {canvasKey, decodeCanvasPatch} from './canvas-patch.ts';

/** Legacy deletes may remove active rows only when no retained user action
 * needs those IDs for a patch, related-row guard, or story-order anchor. */
export function retainedCanvasDependencies(db: DatabaseSync, projectId: string, targets: readonly CanvasTarget[]): Set<string> {
  if (!targets.length || !hasCanvasArchives(db)) return new Set();
  const keys = new Set(targets.map(canvasKey));
  const shots = new Set(targets.filter(({kind}) => kind === 'shot').map(({id}) => id));
  const retained = new Set<string>();
  let count = 0, bytes = 0;
  const max = CANVAS_EDIT_LIMITS.historyBytes;
  const rows = db.prepare(`SELECT CASE WHEN length(CAST(beforePatch AS BLOB)) BETWEEN 1 AND ${max} THEN beforePatch END AS beforePatch,
    CASE WHEN length(CAST(afterPatch AS BLOB)) BETWEEN 1 AND ${max} THEN afterPatch END AS afterPatch
    FROM main.canvas_history_entries WHERE projectId=? LIMIT ?`).iterate(projectId, CANVAS_EDIT_LIMITS.historyEntries + 1);
  for (const row of rows) {
    if (++count > CANVAS_EDIT_LIMITS.historyEntries) return keys;
    for (const raw of [row.beforePatch, row.afterPatch]) {
      if (typeof raw !== 'string' || (bytes += Buffer.byteLength(raw)) > max) return keys;
      try {
        const patch = decodeCanvasPatch(raw);
        for (const target of [...patch.rows, ...patch.guards]) {
          const key = canvasKey(target);
          if (keys.has(key)) retained.add(key);
        }
        for (const anchor of patch.anchors) {
          for (const id of [anchor.id, anchor.previous, anchor.next]) if (id !== null && shots.has(id)) retained.add(`shot:${id}`);
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'CANVAS_EDIT_CONFLICT') return keys;
        throw error;
      }
    }
  }
  return retained;
}

export function hasRetainedCanvasDependency(db: DatabaseSync, projectId: string, targets: readonly CanvasTarget[]): boolean {
  return retainedCanvasDependencies(db, projectId, targets).size !== 0;
}
