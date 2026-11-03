import {AppError} from '../../../contracts/src/app-error.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {withProjectRestoreScopeInside} from '../project-file/restore-scope.ts';
import type {RestoreAdmissionRow} from '../project-file/restore-scope.ts';
import {restoreProjectTimelineInside} from '../timeline.ts';
import type {TimelineRecord} from '../timeline-inputs.ts';
import {canonicalJson, primaryKeys, rowKey, snapshotCellValue, tableColumns} from './document.ts';
import type {ProjectSnapshotTable, SnapshotRow} from './document.ts';
import {restorePlanCurrent,planSubjectRestoreRevisions,PROJECT_VERSION_RESTORE_MAX_SUBJECT_STEPS} from './preview.ts';
import type {RestorePlan,SubjectRestoreRevision} from './preview.ts';

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const completed = new WeakSet<RestorePlan>();
const targetKinds: Record<ProjectSnapshotTable,string> = {projects:'project',assets:'asset',shots:'shot',nodes:'node',edges:'edge',versions:'version',timelines:'timeline',asset_annotations:'asset_annotation',asset_dispositions:'asset_disposition',asset_ranges:'asset_range',subjects:'subject',subject_versions:'subject_version',subject_bindings:'subject_binding',image_groups:'image_group',image_versions:'image_version',scene_results:'scene_result',project_lut_resources:'lut'};
const insertOrder: readonly ProjectSnapshotTable[] = ['projects','assets','shots','nodes','subjects','image_groups','versions','subject_versions','image_versions','project_lut_resources','scene_results','asset_annotations','asset_dispositions','asset_ranges','subject_bindings','edges'];
const nextRevision = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new AppError('PROJECT_VERSION_REVISION_LIMIT', '恢复目标修订已达到安全上限。', 409);
  return value + 1;
};
function forwardRow(table: ProjectSnapshotTable, saved: SnapshotRow, before: SnapshotRow | undefined, now: string, missingLedger = 0): SnapshotRow {
  const result = {...saved};
  if (['versions','subject_versions','image_versions','scene_results','project_lut_resources'].includes(table)) return result;
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

/** Applies the reviewed plan on its original synchronous transaction. The
 * caller owns CAS, the before-version, original receipt and final commit. */
export function applyRestorePlanInside(store: ProjectStore, plan: RestorePlan, {requestId, now = new Date().toISOString()}: {requestId: string; now?: string}): void {
  const current = restorePlanCurrent(store, plan);
  if (completed.has(plan)) throw new TypeError('A restore plan can only be applied once');
  if (new Date(now).toISOString() !== now) throw new TypeError('A restore timestamp must be an ISO instant');
  const indexes = new Map(insertOrder.concat('timelines').map(table => [table, {
    current: new Map(current.tables[table].map(row => [rowKey(table,row),row])),
    desired: new Map(plan.document.tables[table].map(row => [rowKey(table,row),row])),
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
      for(const table of insertOrder){
        const item=indexes.get(table)!,adds=item.changes.filter(change=>!item.current.has(change.key)&&item.desired.has(change.key));
        adds.sort((a,b)=>Number(item.desired.get(a.key)!.number??item.desired.get(a.key)!.position??0)-Number(item.desired.get(b.key)!.number??item.desired.get(b.key)!.position??0));
        const columns=tableColumns(table),insert=store.db.prepare(`INSERT INTO project.${quote(table)}(${columns.map(quote).join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
        for(const change of adds){
          const saved=item.desired.get(change.key)!,id=table==='projects'?store.projectId:String(saved.id??saved.assetId);
          const ledger=Number(store.db.prepare('SELECT revision FROM project.agent_task_target_revisions_v2 WHERE projectId=? AND kind=? AND targetId=?').get(store.projectId,targetKinds[table],id)?.revision??0);
          const row=forwardRow(table,saved,undefined,now,ledger);insert.run(...columns.map(column=>snapshotCellValue(row[column])));
        }
      }
      for(const table of insertOrder){
        const item=indexes.get(table)!,keys=primaryKeys(table),columns=tableColumns(table).filter(column=>!keys.includes(column));
        const update=store.db.prepare(`UPDATE project.${quote(table)} SET ${columns.map(column=>`${quote(column)}=?`).join(',')} WHERE ${keys.map(key=>`${quote(key)} IS ?`).join(' AND ')}`);
        for(const change of item.changes){
          const old=item.current.get(change.key),saved=item.desired.get(change.key);if(!old||!saved)continue;
          if(table==='subjects'){updateSubjectInside(store,saved.id,subjectRevisions.get(change.key)!,now);continue;}
          const row=forwardRow(table,saved,old,now);update.run(...columns.map(column=>snapshotCellValue(row[column])),...keys.map(key=>snapshotCellValue(old[key])));
        }
      }
      const timelines=indexes.get('timelines')!;
      if(timelines.changes.length){
        const row=plan.document.tables.timelines[0];
        restoreProjectTimelineInside(store,row?JSON.parse(String(row.data)) as TimelineRecord:null,{requestId,now});
      }
      // Mutable references have now moved. Reverse dependencies can be removed
      // without deleting any retained result, owner or tombstone.
      for(const table of [...insertOrder].reverse()){
        const item=indexes.get(table)!,keys=primaryKeys(table),remove=store.db.prepare(`DELETE FROM project.${quote(table)} WHERE ${keys.map(key=>`${quote(key)} IS ?`).join(' AND ')}`);
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
