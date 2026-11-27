import {AppError} from '../../../contracts/src/app-error.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {withProjectRestoreScopeInside} from '../project-file/restore-scope.ts';
import type {RestoreAdmissionRow} from '../project-file/restore-scope.ts';
import {restoreProjectTimelineInside} from '../timeline.ts';
import type {TimelineRecord} from '../timeline-inputs.ts';
import {canonicalJson, FORMAT5_TIMELINE_TABLES, primaryKeys, rowKey, snapshotCellValue, snapshotTablesFor, tableColumns} from './document.ts';
import type {ProjectDocument, ProjectSnapshotTable, SnapshotRow, SnapshotTable} from './document.ts';
import {restorePlanCurrent,planSubjectRestoreRevisions,PROJECT_VERSION_RESTORE_MAX_SUBJECT_STEPS} from './preview.ts';
import {isSequenceProjectFormat} from '../project-file/schema/databases.ts';
import type {RestorePlan,SubjectRestoreRevision} from './preview.ts';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const completed = new WeakSet<RestorePlan>();
const targetKinds: Record<SnapshotTable,string> = {projects:'project',assets:'asset',shots:'shot',nodes:'node',edges:'edge',versions:'version',timelines:'timeline',shot_version_adoptions:'shot_version_adoption',sequence_sync_state:'sequence_sync',asset_annotations:'asset_annotation',asset_dispositions:'asset_disposition',asset_ranges:'asset_range',subjects:'subject',subject_versions:'subject_version',subject_bindings:'subject_binding',image_groups:'image_group',image_versions:'image_version',scene_results:'scene_result',project_lut_resources:'lut',timeline_clips:'timeline_clip',timeline_cues:'timeline_subtitle'};
const insertOrder: readonly SnapshotTable[] = ['projects','assets','shots','nodes','subjects','image_groups','versions','shot_version_adoptions','subject_versions','image_versions','project_lut_resources','scene_results','asset_annotations','asset_dispositions','asset_ranges','subject_bindings','edges'];
const documentRows = (document: ProjectDocument, table: SnapshotTable): readonly SnapshotRow[] =>
  (document.tables as Readonly<Record<string, readonly SnapshotRow[] | undefined>>)[table] ?? [];
const nextRevision = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new AppError('PROJECT_VERSION_REVISION_LIMIT', '恢复目标修订已达到安全上限。', 409);
  return value + 1;
};
function forwardRow(table: SnapshotTable, saved: SnapshotRow, before: SnapshotRow | undefined, now: string, missingLedger = 0): SnapshotRow {
  const result = {...saved};
  if (['versions','subject_versions','image_versions','scene_results','project_lut_resources','shot_version_adoptions'].includes(table)) return result;
  if (Object.hasOwn(saved, 'revision')) result.revision = nextRevision(before?.revision ?? Math.max(Number(saved.revision),missingLedger));
  if (Object.hasOwn(saved, 'updatedAt')) result.updatedAt = now;
  if (before && Object.hasOwn(before, 'createdAt')) result.createdAt = before.createdAt;
  if (typeof saved.data === 'string') {
    const value = JSON.parse(saved.data) as Record<string, unknown>, current = before && typeof before.data === 'string' ? JSON.parse(before.data) as Record<string, unknown> : undefined;
    if (Object.hasOwn(value, 'revision') || current && Object.hasOwn(current, 'revision')) value.revision = nextRevision(current?.revision ?? Math.max(Number(value.revision??0),missingLedger));
    if (Object.hasOwn(value, 'updatedAt') || current && Object.hasOwn(current, 'updatedAt')) value.updatedAt = now;
    if (current && Object.hasOwn(current, 'createdAt')) value.createdAt = current.createdAt;
    if (table === 'nodes' && value.type === 'previs' && current?.type === 'previs') {
      value.sceneRevision = canonicalJson(value.scene) === canonicalJson(current.scene) ? current.sceneRevision : nextRevision(current.sceneRevision);
    }
    result.data = canonicalJson(value);
  }
  return result;
}

function updateSubjectInside(store:ProjectStore,id:SnapshotRow[string],steps:readonly SubjectRestoreRevision[],now:string):void{
  for(const step of steps)store.db.prepare('UPDATE project.subjects SET headVersionId=?,revision=?,updatedAt=? WHERE id=?').run(snapshotCellValue(step.headVersionId),step.revision,now,String(id));
}

function desiredTimeline(document: ProjectDocument, format: ProjectDocument['projectFormatVersion']): TimelineRecord | null {
  const header = document.tables.timelines?.[0];
  if (!header) return null;
  if (!isSequenceProjectFormat(format)) return JSON.parse(String(header.data)) as TimelineRecord;
  const {clips: _clips, subtitles: _cues, ...rest} = JSON.parse(String(header.data)) as Record<string, unknown>;
  const decode = (table: 'timeline_clips' | 'timeline_cues') =>
    (document.tables[table] ?? []).map(row => JSON.parse(String(row.data)) as unknown);
  const clips = decode('timeline_clips'), cues = decode('timeline_cues');
  const value: Record<string, unknown> = {...rest, clips};
  if (Object.hasOwn(rest, 'subtitles')) value.subtitles = {...(rest.subtitles as Record<string, unknown>), cues};
  return value as unknown as TimelineRecord;
}

/** Format 5 keeps one sync-state row per stored timeline and clip/cue rows as
 * children; they are written together in the same aggregate restore so the
 * commit fence never sees a half-restored timeline. */
function restoreTimelineDomain(store: ProjectStore, document: ProjectDocument, format: ProjectDocument['projectFormatVersion'],
  current: ProjectDocument, options: {requestId: string; now: string}): void {
  const desired = desiredTimeline(document, format);
  if (!isSequenceProjectFormat(format)) {
    restoreProjectTimelineInside(store, desired, options);
    return;
  }
  const savedSync = documentRows(document, 'sequence_sync_state')[0];
  const currentSync = documentRows(current, 'sequence_sync_state')[0];
  if (!desired) {
    if (currentSync) store.db.prepare('DELETE FROM project.sequence_sync_state WHERE timelineId=?').run(String(currentSync.timelineId));
    restoreProjectTimelineInside(store, null, options);
    return;
  }
  restoreProjectTimelineInside(store, desired, options);
  if (!savedSync) return;
  const baseline = String(savedSync.baseline), sequenceNodeId = String(savedSync.sequenceNodeId), timelineId = String(savedSync.timelineId);
  if (currentSync) {
    store.db.prepare('UPDATE project.sequence_sync_state SET sequenceNodeId=?,revision=?,baseline=? WHERE timelineId=?')
      .run(sequenceNodeId, Number(currentSync.revision) + 1, baseline, String(currentSync.timelineId));
  } else {
    store.db.prepare('INSERT INTO project.sequence_sync_state(timelineId,projectId,sequenceNodeId,revision,baseline) VALUES(?,?,?,?,?)')
      .run(timelineId, store.projectId, sequenceNodeId, Number(savedSync.revision), baseline);
  }
}

/** Applies the reviewed plan on its original synchronous transaction. The
 * caller owns CAS, the before-version, original receipt and final commit. */
export function applyRestorePlanInside(store: ProjectStore, plan: RestorePlan, {requestId, now = new Date().toISOString()}: {requestId: string; now?: string}): void {
  const current = restorePlanCurrent(store, plan);
  const format = current.projectFormatVersion;
  if (completed.has(plan)) throw new TypeError('A restore plan can only be applied once');
  if (new Date(now).toISOString() !== now) throw new TypeError('A restore timestamp must be an ISO instant');
  const tables = snapshotTablesFor(format);
  const order = insertOrder.filter(table => (tables as readonly string[]).includes(table));
  const timelineDomain: readonly SnapshotTable[] = isSequenceProjectFormat(format)
    ? ['timelines', 'sequence_sync_state', ...FORMAT5_TIMELINE_TABLES] : ['timelines'];
  const indexes = new Map([...order, ...timelineDomain].map(table => [table, {
    current: new Map(documentRows(current, table).map(row => [rowKey(table,row,format),row])),
    desired: new Map(documentRows(plan.document, table).map(row => [rowKey(table,row,format),row])),
    changes: plan.changes.filter(change => change.table === table && change.action !== 'keep-current'),
  }]));
  const admissions: RestoreAdmissionRow[] = [];
  // Recheck the same cumulative budget before the first content statement.
  const subjectRevisions=new Map<string,readonly SubjectRestoreRevision[]>();
  let subjectBudget=PROJECT_VERSION_RESTORE_MAX_SUBJECT_STEPS;
  const subjects=indexes.get('subjects')!;
  for(const change of subjects.changes){
    const old=subjects.current.get(change.key),saved=subjects.desired.get(change.key);if(!old||!saved)continue;
    const steps=planSubjectRestoreRevisions(saved,old,plan.document.tables.subject_versions,subjectBudget);
    subjectBudget-=steps.length;subjectRevisions.set(change.key,steps);
  }
  for (const table of ['subject_versions','scene_results'] as const) for (const change of indexes.get(table)!.changes) {
    const item=indexes.get(table)!;
    if(!item.current.has(change.key)&&item.desired.has(change.key))admissions.push({table,row:item.desired.get(change.key)!});
  }
  try {
    withProjectRestoreScopeInside(store,plan.document,admissions,()=>{
      // Owners precede children. The existing deferred head keys permit the
      // subject/image cycles; version numbers and scene bases retain order.
      for(const table of order){
        const item=indexes.get(table)!,adds=item.changes.filter(change=>!item.current.has(change.key)&&item.desired.has(change.key));
        adds.sort((a,b)=>Number(item.desired.get(a.key)!.number??item.desired.get(a.key)!.position??0)-Number(item.desired.get(b.key)!.number??item.desired.get(b.key)!.position??0));
        const columns=tableColumns(table,format),insert=store.db.prepare(`INSERT INTO project.${quote(table)}(${columns.map(quote).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
        for(const change of adds){
          const saved=item.desired.get(change.key)!,id=table==='projects'?store.projectId:String(saved.id??saved.assetId);
          const ledger=Number(store.db.prepare('SELECT revision FROM project.agent_task_target_revisions_v2 WHERE projectId=? AND kind=? AND targetId=?').get(store.projectId,targetKinds[table],id)?.revision??0);
          const row=forwardRow(table,saved,undefined,now,ledger);insert.run(...columns.map(column=>snapshotCellValue(row[column])));
        }
      }
      for(const table of order){
        const item=indexes.get(table)!,keys=primaryKeys(table,format),columns=tableColumns(table,format).filter(column=>!keys.includes(column));
        const update=store.db.prepare(`UPDATE project.${quote(table)} SET ${columns.map(column=>`${quote(column)}=?`).join(',')} WHERE ${keys.map(key=>`${quote(key)} IS ?`).join(' AND ')}`);
        for(const change of item.changes){
          const old=item.current.get(change.key),saved=item.desired.get(change.key);if(!old||!saved)continue;
          if(table==='subjects'){updateSubjectInside(store,saved.id,subjectRevisions.get(change.key)!,now);continue;}
          const row=forwardRow(table,saved,old,now);update.run(...columns.map(column=>snapshotCellValue(row[column])),...keys.map(key=>snapshotCellValue(old[key])));
        }
      }
      // Format 5 keeps the header and its native clip/cue rows in one
      // aggregate; a change to either side restores them together.
      if(timelineDomain.some(table=>indexes.get(table)!.changes.length)){
        restoreTimelineDomain(store,plan.document,format,current,{requestId,now});
      }
      // Mutable references have now moved. Reverse dependencies can be removed
      // without deleting any retained result, owner or tombstone.
      for(const table of [...order].reverse()){
        const item=indexes.get(table)!,keys=primaryKeys(table,format),remove=store.db.prepare(`DELETE FROM project.${quote(table)} WHERE ${keys.map(key=>`${quote(key)} IS ?`).join(' AND ')}`);
        for(const change of item.changes){const old=item.current.get(change.key);if(old&&!item.desired.has(change.key))remove.run(...keys.map(key=>snapshotCellValue(old[key])));}
      }
      if(store.db.prepare('PRAGMA project.foreign_key_check').get())throw new AppError('PROJECT_VERSION_DEPENDENCY_CONFLICT','恢复内容的依赖无法闭合。',409);
    });
  } catch(error) {
    if(error instanceof AppError)throw error;
    const constraintCode=error instanceof Error?(error as Error & {errcode?:number}).errcode:undefined;
    if(typeof constraintCode==='number' && (constraintCode&255)===19) {
      throw new AppError('PROJECT_VERSION_DEPENDENCY_CONFLICT','恢复内容与保留的领域约束冲突，未应用。',409);
    }
    throw error;
  }
  completed.add(plan);
}
