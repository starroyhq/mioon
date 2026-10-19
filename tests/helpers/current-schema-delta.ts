// Reviewed current ordinary48 delta beyond the independent ordinary24 golden
// fixture (project-lifecycle tables/guards, lifecycle-aware retention triggers,
// ripple edit-task operation, markers44/48). Frozen in
// tests/fixtures/workspace-schema-profiles/current-ordinary-48-delta.json and
// shared by migration tests that must distinguish retained historical SQL from
// the reviewed current startup additions.
import {readFileSync} from 'node:fs';
interface CurrentOrdinary48Delta {readonly objectSql: Record<string, string>; readonly [key: string]: unknown}
export const currentOrdinary48Delta: CurrentOrdinary48Delta = JSON.parse(readFileSync(
  new URL('../fixtures/workspace-schema-profiles/current-ordinary-48-delta.json', import.meta.url), 'utf8'));
export const currentMarkerChain = Object.freeze([
  ...Array.from({length: 24}, (_, index) => index + 1), 26, 28, 30, 32, 34, 36, 38, 40, 44, 48,
]);
/** The current reviewed SQL for an object whose historical SQL was upgraded by
 * the reviewed current-schema delta, or the historical SQL when unchanged. */
export function reviewedObjectSql(name: string, historicalSql: string): string {
  return currentOrdinary48Delta.objectSql[name] ?? historicalSql;
}
/** Historical retention guards were extended with a project-deletion-scope
 * exemption at current schema44/48. Strip only that reviewed wrapper so the
 * untouched historical trigger body can still be compared byte-exactly. */
export function stripReviewedLifecycleGuard(sql: unknown, name: string): unknown {
  if (typeof sql !== 'string') return sql;
  const guard = ` WHEN NOT EXISTS(SELECT 1 FROM project_deletion_scope WHERE tableName='${name}' AND rowId=OLD.rowid)`;
  return sql.includes(guard) ? sql.replace(guard, '') : sql;
}
