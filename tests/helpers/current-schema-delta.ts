// Frozen ordinary48 delta beyond the independent ordinary24 golden
// fixture (project-lifecycle tables/guards, lifecycle-aware retention triggers,
// ripple edit-task operation, markers44/48). Frozen in
// tests/fixtures/workspace-schema-profiles/current-ordinary-48-delta.json and
// shared by migration tests that must distinguish retained historical SQL from
// the reviewed current startup additions.
import {readFileSync} from 'node:fs';
interface CurrentOrdinary48Delta {readonly objectSql: Record<string, string>; readonly lifecycleTables: Readonly<Record<string, {fields: readonly string[]; rows: 0}>>; readonly lifecycleObjects: readonly {type: string; name: string; tbl_name: string; sql: string | null}[]; readonly [key: string]: unknown}
export const currentOrdinary48Delta: CurrentOrdinary48Delta = JSON.parse(readFileSync(
  new URL('../fixtures/workspace-schema-profiles/current-ordinary-48-delta.json', import.meta.url), 'utf8'));
interface CurrentOrdinary50Delta {readonly schemaVersionRows:readonly (readonly string[])[];readonly objects:readonly {type:string;name:string;tbl_name:string;sql:string|null}[];readonly tables:Readonly<Record<string,{fields:readonly string[];rows:0}>>;readonly catalog:{count:number;sha256:string}}
/** Independent additive50 pin. The historical48 evidence is never rewritten. */
export const currentOrdinary50Delta:CurrentOrdinary50Delta=JSON.parse(readFileSync(
  new URL('../fixtures/workspace-schema-profiles/current-ordinary-50-delta.json',import.meta.url),'utf8'));
export const currentOrdinary52Delta:CurrentOrdinary50Delta & {readonly objectNames:readonly string[];readonly v2Catalog:{count:number;sha256:string}}=JSON.parse(readFileSync(
  new URL('../fixtures/workspace-schema-profiles/current-ordinary-52-delta.json',import.meta.url),'utf8'));
export {currentOrdinary54Delta,withoutReviewedConversationObjects} from './current-schema54-delta.ts';
export {currentOrdinary56Delta,withoutReviewedInteractionObjects} from './current-schema56-delta.ts';
export {currentOrdinary58Delta,withoutReviewedSceneObjects} from './current-schema58-delta.ts';
export {currentOrdinary60Delta,withoutReviewedStorageObjects} from './current-schema60-delta.ts';
export {currentOrdinary62Delta,withoutReviewedSubjectVariantObjects} from './current-schema62-delta.ts';
export {currentOrdinary64Delta,withoutReviewedPrevisObjects} from './current-schema64-delta.ts';
// The current marker chain is pinned once in workspace-schema-current.ts.
export {CURRENT_MARKER_CHAIN as currentMarkerChain} from './workspace-schema-current.ts';
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
