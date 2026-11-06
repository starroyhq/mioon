import {AppError} from '../../../contracts/src/app-error.ts';
import type {ProjectVersionDifference, ProjectVersionDifferenceReasonCode} from '../../../contracts/src/project-version-operations.ts';
import {agentTaskChangeSchema} from '../../../contracts/src/agent-tasks-v2.ts';
import {mediaReferenceSchema} from '../../../contracts/src/media-reference.ts';
import {CROSS_FILE_RELATIONS} from '../project-file/cross-file/relations.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {readProjectContentStamp} from '../project-file/content-stamp.ts';
import {canonicalJson, primaryKeys, PROJECT_SNAPSHOT_TABLES, rowKey, snapshotCellValue, tableColumns, validateProjectDocument} from './document.ts';
import type {ProjectDocument, ProjectSnapshotTable, SnapshotRow} from './document.ts';

type Table = ProjectSnapshotTable;
const metadata = new Set(['revision', 'updatedAt']);
const retained = new Set<Table>(['subject_versions', 'image_versions', 'scene_results', 'project_lut_resources', 'image_groups']);
const immutable = new Set<Table>(['versions', 'subject_versions', 'image_versions', 'scene_results', 'project_lut_resources']);
const identityColumns: Partial<Record<Table, readonly string[]>> = {
  subjects: ['id', 'projectId', 'kind', 'name', 'createdAt'],
  subject_bindings: ['id', 'projectId', 'shotId', 'subjectId', 'role', 'createdAt'],
  image_groups: ['id', 'projectId', 'name', 'createdAt'],
};
const targetKinds: Record<Table, string> = {projects: 'project', assets: 'asset', asset_annotations: 'asset_annotation', asset_dispositions: 'asset_disposition',
  asset_ranges: 'asset_range', shots: 'shot', nodes: 'node', edges: 'edge', versions: 'version', timelines: 'timeline', subjects: 'subject',
  subject_versions: 'subject_version', subject_bindings: 'subject_binding', image_groups: 'image_group', image_versions: 'image_version', scene_results: 'scene_result', project_lut_resources: 'lut'};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const token = (table: Table, key: string) => `${table}\0${key}`;
export interface RestorePlan {readonly changes: ProjectVersionDifference[]; readonly document: ProjectDocument}
const restorePlans = new WeakMap<RestorePlan, {store: ProjectStore; current: ProjectDocument; contentToken: string}>();
// Display metadata must not alter the confirmed plan digest or the persisted
// restoration ACK. Attach codes while planning, never infer them from an old
// human-readable reason or rewrite a historical receipt.
const differenceReasons = new WeakMap<ProjectVersionDifference, ProjectVersionDifferenceReasonCode>();
function setReason(difference: ProjectVersionDifference, code: ProjectVersionDifferenceReasonCode, reason: string): void {
  difference.reason = reason;
  differenceReasons.set(difference, code);
}
export function projectVersionDifferenceForDisplay(difference: ProjectVersionDifference): ProjectVersionDifference {
  const reasonCode = differenceReasons.get(difference);
  return reasonCode === undefined ? difference : {...difference, reasonCode};
}
export interface RestorePlanningOptions {readonly executionDomain?: 'current' | 'empty'}
/** The execution capability is local to a reviewed plan on its original store.
 * HTTP callers cannot construct one by posting a document or a diff. */
export function restorePlanCurrent(store: ProjectStore, plan: RestorePlan): ProjectDocument {
  const context = restorePlans.get(plan);
  if (!isProjectStore(store) || !store.db.isTransaction || context?.store !== store) throw new TypeError('Restoration requires a plan from this live store inside its transaction');
  const stamp = readProjectContentStamp(store.db);
  if (stamp?.contentSequence !== context.current.evidence.contentSequence || stamp?.contentToken !== context.contentToken) fail('PROJECT_VERSION_BASELINE_CHANGED', '项目内容已改变，请重新预览。');
  return context.current;
}
function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, code === 'PROJECT_ID_MISMATCH' ? 400 : code.endsWith('_INVALID') ? 422 : 409, details);
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function data(row: SnapshotRow): Record<string, unknown> {
  if (typeof row.data !== 'string') return {};
  const result: unknown = JSON.parse(row.data);
  if (!object(result)) fail('PROJECT_VERSION_SNAPSHOT_INVALID', '内容行不是合法对象。');
  return result;
}
/** Subject revisions may have real numbering gaps. Bound their cumulative
 * traversal per restoration, independently of the snapshot's byte limit. */
export const PROJECT_VERSION_RESTORE_MAX_SUBJECT_STEPS = 10_000;
export interface SubjectRestoreRevision {readonly revision: number; readonly headVersionId: SnapshotRow[string]}
export function planSubjectRestoreRevisions(saved: SnapshotRow, before: SnapshotRow, versions: readonly SnapshotRow[], budget: number): readonly SubjectRestoreRevision[] {
  if(!Number.isSafeInteger(budget)||budget<0||budget>PROJECT_VERSION_RESTORE_MAX_SUBJECT_STEPS)throw new TypeError('Invalid subject restoration budget');
  const relevant=versions.filter(row=>row.subjectId===saved.id),byNumber=new Map(relevant.map(row=>[Number(row.number),row]));
  const ordinary=relevant.filter(row=>!Object.hasOwn(data(row),'variant'));
  let revision=Number(before.revision),head=before.headVersionId;
  if(!Number.isSafeInteger(revision)||revision>=Number.MAX_SAFE_INTEGER)fail('PROJECT_VERSION_REVISION_LIMIT','恢复目标修订已达到安全上限。');
  const required=relevant.reduce((maximum,row)=>Math.max(maximum,Number(row.number)),revision+1);
  if(required-revision>budget)fail('PROJECT_VERSION_RESTORE_LIMIT','恢复的主体修订推进超过单次执行上限。');
  const steps: SubjectRestoreRevision[]=[];
  do{
    if(steps.length>=budget)fail('PROJECT_VERSION_RESTORE_LIMIT','恢复的主体修订推进超过单次执行上限。');
    if(revision>=Number.MAX_SAFE_INTEGER)fail('PROJECT_VERSION_REVISION_LIMIT','恢复目标修订已达到安全上限。');
    const next=revision+1,version=byNumber.get(next);
    let desiredHead=saved.headVersionId;
    if(next<required||head===desiredHead){
      const variant=version&&Object.hasOwn(data(version),'variant');
      // Retained ordinary heads traverse a gap without inventing a version.
      const alternate=version&&!variant&&version.id!==head?version:ordinary.find(row=>row.id!==head);
      if(variant)desiredHead=head;
      else if(alternate)desiredHead=alternate.id;
      else fail('PROJECT_VERSION_DEPENDENCY_CONFLICT','主体的保留版本无法按现有修订规则补齐。');
    }
    steps.push({revision:next,headVersionId:desiredHead});
    revision=next;head=desiredHead;
  }while(revision<required||head!==saved.headVersionId);
  return steps;
}
function semantic(row: SnapshotRow): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !metadata.has(name)).map(([name, value]) => [name,
    name === 'data' && typeof value === 'string' ? Object.fromEntries(Object.entries(data(row)).filter(([key]) => !metadata.has(key))) : value]));
}
function fields(table: Table, before?: SnapshotRow, after?: SnapshotRow): string[] {
  const a = before ? semantic(before) : {}, b = after ? semantic(after) : {};
  return tableColumns(table).filter(column => !metadata.has(column) && canonicalJson(a[column] ?? null) !== canonicalJson(b[column] ?? null));
}

/** Attribution is deliberately object-level. A later rowid, undo evidence or
 * a persistent target revision beyond the snapshot marks the recorded targets.
 * Other differences are "you or another source", never proven manual edits. */
function mioTargets(store: ProjectStore, saved: ProjectDocument, boundary: number, createdAt: string): Set<string> {
  const result = new Set<string>();
  const revisions = new Map(saved.evidence.targetRevisions.map(row => [`${row.kind}:${row.targetId}`, Number(row.revision)]));
  const persistentKinds = new Set<string>([...Object.values(targetKinds), 'timeline_clip', 'timeline_track', 'timeline_subtitle']);
  for (const row of store.db.prepare('SELECT rowid,data FROM main.mio_changes WHERE projectId=? ORDER BY rowid').all(store.projectId)) {
    let value: unknown;
    try {value = JSON.parse(String(row.data));} catch {fail('PROJECT_VERSION_RECORD_INVALID', 'Mio 变化记录损坏，无法准确标示来源。');}
    const parsed = agentTaskChangeSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== store.projectId) fail('PROJECT_VERSION_RECORD_INVALID', 'Mio 变化记录无效，无法准确标示来源。');
    const change = parsed.data;
    const revised = [...change.targets, ...(change.revertedTargets ?? [])].some(target =>
      Math.max(target.revision, target.revisionAfter ?? 0) > (revisions.get(`${target.kind}:${target.id}`) ?? 0));
    // Copied versions retain their original rowid boundary while a replacement
    // history starts at rowid 1. Persistent content revisions survive that
    // replacement and provide additional attribution evidence without granting
    // any execution or compensation authority to archived changes.
    const contentRevised = [...change.targets, ...(change.revertedTargets ?? [])].some(target => persistentKinds.has(target.kind)
      && Math.max(target.revision, target.revisionAfter ?? 0) > (revisions.get(`${target.kind}:${target.id}`) ?? 0));
    const after = Number(row.rowid) > boundary || typeof change.revertedAt === 'string' && Date.parse(change.revertedAt) > Date.parse(createdAt)
      || change.status === 'reverted' && revised || contentRevised;
    if (after) for (const target of [...change.targets, ...(change.revertedTargets ?? [])]) result.add(`${target.kind}:${target.id}`);
  }
  return result;
}
function source(table: Table, row: SnapshotRow, projectId: string, touched: Set<string>): 'mio' | 'user-or-other' {
  const id = table === 'projects' || table === 'timelines' ? projectId : String(row.id ?? row.assetId);
  if (touched.has(`${targetKinds[table]}:${id}`)) return 'mio';
  if (table === 'timelines') {
    const value = data(row);
    for (const [key, kind] of [['clips', 'timeline_clip'], ['tracks', 'timeline_track'], ['subtitles', 'timeline_subtitle']] as const) {
      const entries = key === 'subtitles' && object(value.subtitles) ? value.subtitles.cues : value[key];
      if (Array.isArray(entries) && entries.some(entry => object(entry) && typeof entry.id === 'string' && touched.has(`${kind}:${entry.id}`))) return 'mio';
    }
  }
  return 'user-or-other';
}

interface ForeignKey {readonly parent: Table; readonly from: readonly string[]; readonly to: readonly string[]}
function nativeKeys(store: ProjectStore): Map<Table, ForeignKey[]> {
  const all = new Set<string>(PROJECT_SNAPSHOT_TABLES), result = new Map<Table, ForeignKey[]>();
  for (const table of PROJECT_SNAPSHOT_TABLES) {
    const groups = new Map<number, {parent: Table; parts: {seq: number; from: string; to: string | null}[]}>();
    for (const row of store.db.prepare(`PRAGMA project.foreign_key_list(${quote(table)})`).all()) {
      if (!all.has(String(row.table))) continue;
      const id = Number(row.id), group = groups.get(id) ?? {parent: String(row.table) as Table, parts: []};
      group.parts.push({seq: Number(row.seq), from: String(row.from), to: row.to === null ? null : String(row.to)}); groups.set(id, group);
    }
    result.set(table, [...groups.values()].map(group => {const parts = group.parts.sort((a, b) => a.seq - b.seq); return {
      parent: group.parent, from: parts.map(part => part.from), to: parts.map((part, index) => part.to ?? primaryKeys(group.parent)[index]),
    };}));
  }
  return result;
}
// Explicit domain references in JSON-backed rows supplement native SQL FKs.
// Never infer a reference merely because arbitrary user text equals an ID.
function logicalReferences(table: Table, row: SnapshotRow): {table: Table; id: string}[] {
  const result: {table: Table; id: string}[] = [];
  const add = (parent: Table, value: unknown): void => {
    if (typeof value === 'string') result.push({table: parent, id: value});
    else if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') result.push({table: parent, id});
  };
  const value = data(row);
  if (table === 'shots') {
    add('assets', value.referenceAssetIds); add('assets', value.lastFrameAssetId);
    add('versions', value.selectedVersionId); add('versions', value.versionIds);
  } else if (table === 'versions') {
    add('assets', value.assetId); add('shots', value.shotId);
  } else if (table === 'nodes') {
    if (value.type === 'asset') add('assets', value.assetId);
    if (value.type === 'shot') add('shots', value.shotId);
    if (value.type === 'previs' && object(value.scene) && Array.isArray(value.scene.keyframes)) {
      for (const keyframe of value.scene.keyframes) if (object(keyframe)) add('assets', keyframe.exports);
    }
  } else if (table === 'edges') {
    if (value.kind === 'reference') {
      add('nodes', value.source); add('shots', value.target); add('assets', value.sourceAssetId);
    } else {add('nodes', value.from ?? value.source); add('nodes', value.to ?? value.target);}
  } else if (table === 'timelines' && Array.isArray(value.clips)) {
    for (const clip of value.clips) if (object(clip)) {
      add('assets', clip.assetId); add('versions', clip.versionId); add('shots', clip.shotId);
      if (object(clip.colour) && object(clip.colour.look)) add('project_lut_resources', clip.colour.look.resourceId);
    }
  }
  return result;
}

/** Complete diff data only: no content writes, receipt writes, trigger changes
 * or effects. V1-A does not expose executable restoration. */
export function buildRestorePlan(store: ProjectStore, saved: ProjectDocument, current: ProjectDocument, mioChangeRowid: number, versionCreatedAt: string, options: RestorePlanningOptions = {}): RestorePlan {
  if (!isProjectStore(store) || !store.db.isTransaction) throw new TypeError('Preview requires a real project store in its transaction');
  if (saved.projectId !== store.projectId || current.projectId !== store.projectId) fail('PROJECT_ID_MISMATCH', '版本内容不属于此项目。');
  const empty = options.executionDomain === 'empty';
  const touched = empty ? new Set<string>() : mioTargets(store, saved, mioChangeRowid, versionCreatedAt);
  const differences = new Map<string, ProjectVersionDifference>(), predicted = new Map<Table, Map<string, SnapshotRow>>();
  const removable = new Map<string, {table: Table; key: string; row: SnapshotRow}>();
  for (const table of PROJECT_SNAPSHOT_TABLES) {
    const old = new Map(saved.tables[table].map(row => [rowKey(table, row), row]));
    const now = new Map(current.tables[table].map(row => [rowKey(table, row), row]));
    const finalRows = new Map(now); predicted.set(table, finalRows);
    for (const key of [...new Set([...old.keys(), ...now.keys()])].sort(compare)) {
      if (key.length > 4096) fail('PROJECT_VERSION_PREVIEW_LIMIT', '对象标识超过预览上限，未截断标识。');
      const before = now.get(key), original = old.get(key), identity = token(table, key);
      let after = original, keptLocation = false;
      if (table === 'assets' && before && after) {
        const value = data(before), previous = data(after);
        if (mediaReferenceSchema.safeParse(value.reference).success && Number.isSafeInteger(value.referenceRevision) && Number(value.referenceRevision) >= 1) {
          const preserved = {...previous};
          for (const name of ['reference', 'referenceRevision', 'sha256', 'sizeBytes', 'fingerprint', 'hashState']) {
            if (Object.hasOwn(value, name)) preserved[name] = value[name]; else delete preserved[name];
          }
          keptLocation = canonicalJson(previous) !== canonicalJson(preserved);
          after = {...after, data: canonicalJson(preserved)};
        }
      }
      if (before && after && immutable.has(table) && canonicalJson(before) !== canonicalJson(after)) {
        fail('PROJECT_VERSION_IMMUTABLE_CONFLICT', '同一标识的不可变内容不同，不能生成恢复计划。', {table, key});
      }
      const changed = fields(table, before, after);
      if (table === 'subjects' && before && after && saved.tables.subject_versions.some(version => version.subjectId === after?.id
        && Number(version.number) > Number(before.revision))) changed.push('revision');
      if (before && after && !changed.length && !keptLocation) continue;
      const diff: ProjectVersionDifference = {table, key, fields: changed, action: after ? before ? 'change' : 'add' : 'remove',
        source: source(table, before ?? after!, store.projectId, touched), reason: null};
      if (keptLocation) {
        setReason(diff, 'PROJECT_VERSION_ASSET_LOCATION_CURRENT', '素材文件定位及其引用修订保持当前，其他可变内容按版本恢复。');
        if (!changed.length) diff.action = 'keep-current';
      }
      if (table === 'timelines' && after && source(table, after, store.projectId, touched) === 'mio') diff.source = 'mio';
      if (before && after) {
        const target = after;
        if (immutable.has(table) || identityColumns[table]?.some(column => canonicalJson(before[column]) !== canonicalJson(target[column]))) {
          fail('PROJECT_VERSION_IMMUTABLE_CONFLICT', '同一标识的不可变内容不同，不能生成恢复计划。', {table, key});
        }
        if (table === 'image_groups') {
          diff.action = 'keep-current'; setReason(diff, 'PROJECT_VERSION_IMAGE_GROUP_FORWARD_ONLY', '图像组的版本链只能向前，当前 headVersionId 和过程选择保持当前。');
        } else if (table === 'subjects' && before.headVersionId !== after.headVersionId
          && saved.tables.subject_versions.some(version => version.id === target.headVersionId && Object.hasOwn(data(version), 'variant'))) {
          diff.action = 'keep-current'; setReason(diff, 'PROJECT_VERSION_SUBJECT_VARIANT_HEAD', '领域禁止把带变体过程标记的版本设为主体当前头；当前选择保持不变。');
        } else finalRows.set(key, after);
      } else if (after) {
        if (table === 'image_groups' && after.activeTaskId !== null) {
          after = {...after, activeTaskId: null};
          setReason(diff, 'PROJECT_VERSION_IMAGE_GROUP_TASK_NOT_REPLAYED', '补回图像组内容身份，不重建或重放本机活动任务。');
        }
        finalRows.set(key, after);
      }
      else if (retained.has(table)) {
        diff.action = 'keep-current'; setReason(diff, 'PROJECT_VERSION_PROTECTED_RESULT_CURRENT', '快照后新增的受保护结果或只前进对象不能删除，保持当前。');
      } else if (!empty && table === 'timelines' && store.db.prepare('SELECT 1 FROM main.timeline_history WHERE projectId=? LIMIT 1').get(store.projectId)) {
        diff.action = 'keep-current'; setReason(diff, 'PROJECT_VERSION_TIMELINE_HISTORY_CURRENT', '本机时间线编辑历史仍引用此聚合，保持当前身份和内容，不删除过程历史。');
      } else if (table === 'asset_annotations') {
        const reset = {...before!, tags: '[]', note: ''}; finalRows.set(key, reset);
        diff.fields = fields(table, before, reset); diff.action = diff.fields.length ? 'change' : 'keep-current';
        setReason(diff, 'PROJECT_VERSION_ANNOTATION_IDENTITY_CURRENT', '标注行必须保留；仅恢复默认空标签和备注，不删除其身份或历史修订。');
      } else if (table === 'subject_bindings') {
        const reset = {...before!, subjectVersionId: null}; finalRows.set(key, reset);
        diff.fields = fields(table, before, reset); diff.action = diff.fields.length ? 'change' : 'keep-current';
        setReason(diff, 'PROJECT_VERSION_BINDING_TOMBSTONE_CURRENT', '绑定墓碑必须保留；清空当前绑定版本，身份和已审版本证据保持当前。');
      } else {
        finalRows.delete(key); removable.set(identity, {table, key, row: before!});
      }
      differences.set(identity, diff);
    }
  }
  const graph = nativeKeys(store);
  const candidatesByParent = new Map<string, Map<string, {table: Table; key: string; row: SnapshotRow}[]>>();
  const matches = (table: Table, columns: readonly string[], values: readonly unknown[]) => {
    const signature = `${table}\0${canonicalJson(columns)}`;
    let lookup = candidatesByParent.get(signature);
    if (!lookup) {
      lookup = new Map();
      for (const candidate of removable.values()) if (candidate.table === table) {
        const key = canonicalJson(columns.map(column => candidate.row[column]));
        const list = lookup.get(key) ?? []; list.push(candidate); lookup.set(key, list);
      }
      candidatesByParent.set(signature, lookup);
    }
    return lookup.get(canonicalJson(values)) ?? [];
  };
  let closureQueue: {table: Table; row: SnapshotRow}[] | undefined;
  const retain = (table: Table, key: string, reasonCode: ProjectVersionDifferenceReasonCode, reason: string): boolean => {
    const id = token(table, key), candidate = removable.get(id);
    if (!candidate) return false;
    removable.delete(id); predicted.get(table)!.set(key, candidate.row);
    closureQueue?.push({table, row: candidate.row});
    const diff = differences.get(id)!; diff.action = 'keep-current'; setReason(diff, reasonCode, reason);
    return true;
  };
  // Cross-file rows are process/cache evidence and will not be rewound. Their
  // actual references protect current owners even when no snapshot row did.
  for (const candidate of [...removable.values()]) for (const relation of empty ? [] : CROSS_FILE_RELATIONS) {
    if (relation.parent.table !== candidate.table) continue;
    const values = relation.parent.columns.map(column => candidate.row[column]);
    if (values.some(value => value === null || value === undefined)) continue;
    const where = relation.child.columns.map(column => `${quote(column)} IS ?`).join(' AND ');
    if (store.db.prepare(`SELECT 1 FROM ${relation.child.schema}.${quote(relation.child.table)} WHERE ${where} LIMIT 1`).get(...values.map(snapshotCellValue))) {
      retain(candidate.table, candidate.key, 'PROJECT_VERSION_PROCESS_REFERENCE_CURRENT', `本机 ${relation.child.schema}.${relation.child.table} 仍引用此对象，过程记录保持当前，不能删除该对象。`);
    }
  }
  // A protected child may keep its owner, whose content may keep another
  // owner. Compute the whole dependency closure, not a single pass.
  closureQueue = [...predicted].flatMap(([table, rows]) => [...rows.values()].map(row => ({table, row})));
  for (let index = 0; index < closureQueue.length; index++) {
    const {table: childTable, row: child} = closureQueue[index];
    for (const fk of graph.get(childTable) ?? []) {
        const values = fk.from.map(column => child[column]);
        if (values.some(value => value === null || value === undefined)) continue;
        for (const candidate of matches(fk.parent, fk.to, values)) retain(candidate.table, candidate.key, 'PROJECT_VERSION_FOREIGN_KEY_REFERENCE_CURRENT', `恢复后保留的 ${childTable} 内容仍通过外键引用此对象，保持当前。`);
      }
    for (const ref of logicalReferences(childTable, child)) for (const candidate of matches(ref.table, ['id'], [ref.id])) retain(candidate.table, candidate.key, 'PROJECT_VERSION_CONTENT_REFERENCE_CURRENT', `恢复后保留的 ${childTable} 内容仍引用此对象，保持当前。`);
  }
  // Both input files can be valid while their retained/additive combination
  // conflicts (for example two binding IDs with one shot/subject/role key).
  // Reject that whole preview rather than describe an impossible restore.
  const imageGroups=new Map([...predicted.get('image_groups')!.values()].map(row=>[row.id,row]));
  const imageVersions=new Map([...predicted.get('image_versions')!.values()].map(row=>[row.id,row]));
  for(const version of imageVersions.values()){
    const owner=imageGroups.get(version.groupId),head=owner?imageVersions.get(owner.headVersionId):undefined;
    if(!owner||!head||head.groupId!==version.groupId||Number(head.number)<Number(version.number)||Number(owner.revision)<Number(version.number)||Number(head.number)>Number(owner.revision)) {
      fail('PROJECT_VERSION_DEPENDENCY_CONFLICT','补回图像版本将超出保持当前的图像组头或修订，无法生成可读取的恢复计划。');
    }
  }
  let document: ProjectDocument;
  try {document = validateProjectDocument({...current, tables: Object.fromEntries([...predicted].map(([table, rows]) =>
    [table, [...rows.values()].sort((a, b) => compare(rowKey(table, a), rowKey(table, b)))]))});}
  catch {fail('PROJECT_VERSION_DEPENDENCY_CONFLICT', '保留当前内容与快照的引用或唯一性约束冲突，无法生成恢复计划。');}
  const changes = [...differences.values()].sort((a, b) => compare(a.table, b.table) || compare(a.key, b.key));
  let subjectBudget=PROJECT_VERSION_RESTORE_MAX_SUBJECT_STEPS;
  const currentSubjects=new Map(current.tables.subjects.map(row=>[rowKey('subjects',row),row]));
  const desiredSubjects=new Map(document.tables.subjects.map(row=>[rowKey('subjects',row),row]));
  for(const change of changes)if(change.table==='subjects'&&change.action!=='keep-current'){
    const before=currentSubjects.get(change.key),after=desiredSubjects.get(change.key);
    if(before&&after)subjectBudget-=planSubjectRestoreRevisions(after,before,document.tables.subject_versions,subjectBudget).length;
  }
  for (const change of changes) {Object.freeze(change.fields); Object.freeze(change);}
  Object.freeze(changes);
  const plan = Object.freeze({changes, document});
  restorePlans.set(plan, {store, current, contentToken: readProjectContentStamp(store.db).contentToken});
  return plan;
}

export function previewDifferences(store: ProjectStore, saved: ProjectDocument, current: ProjectDocument, mioChangeRowid: number, versionCreatedAt: string): ProjectVersionDifference[] {
  return buildRestorePlan(store, saved, current, mioChangeRowid, versionCreatedAt).changes.map(projectVersionDifferenceForDisplay);
}
