import {AppError} from '../../contracts/src/app-error.ts';
import {FCPXML_EXPORT_TASK_KIND, fcpxmlExportTaskSchema, PREMIERE_EXPORT_TASK_KIND, premiereExportTaskSchema} from '../../contracts/src/project-registry.ts';
import type {FcpExportTask, PremiereExportTask} from '../../contracts/src/project-registry.ts';

type Row = Record<string, unknown>;
export type EditorExportTask = FcpExportTask | PremiereExportTask;
export type EditorExportTaskKind = EditorExportTask['kind'];
type MarkedTask<Kind extends EditorExportTaskKind> = Row & ({mode: Kind} | {kind: Kind});
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);
const targets = {
  [FCPXML_EXPORT_TASK_KIND]: {schema: fcpxmlExportTaskSchema, name: 'Final Cut Pro'},
  [PREMIERE_EXPORT_TASK_KIND]: {schema: premiereExportTaskSchema, name: 'Premiere Pro'},
};

function markerSql(kind: EditorExportTaskKind, operator: 'OR' | 'AND'): string {
  return `(json_extract(data,'$.mode') IS '${kind}' ${operator} json_extract(data,'$.kind') IS '${kind}')`;
}
export function editorExportTaskSql(kind: EditorExportTaskKind): string {
  return `CASE WHEN json_valid(data) THEN ${markerSql(kind, 'OR')} ELSE 0 END`;
}
/** The legacy render worker filters these rows before reading their bodies. */
export const EDITOR_EXPORT_TASK_SQL = `CASE WHEN json_valid(data) THEN
  ${markerSql(FCPXML_EXPORT_TASK_KIND, 'OR')} OR ${markerSql(PREMIERE_EXPORT_TASK_KIND, 'OR')} ELSE 0 END`;
/** Use inside an existing json_valid guard when both markers must match. */
export const MATCHED_EDITOR_EXPORT_TASK_SQL = `(${markerSql(FCPXML_EXPORT_TASK_KIND, 'AND')} OR ${markerSql(PREMIERE_EXPORT_TASK_KIND, 'AND')})`;

/** Recognize either discriminator so a damaged record cannot fall through to
 * generic rendering or disclose its private publication fields. */
export function isFcpExportTaskRecord(value: unknown): value is MarkedTask<typeof FCPXML_EXPORT_TASK_KIND> {
  return object(value) && (value.mode === FCPXML_EXPORT_TASK_KIND || value.kind === FCPXML_EXPORT_TASK_KIND);
}
export function editorExportTaskKind(value: unknown): EditorExportTaskKind | undefined {
  if (isFcpExportTaskRecord(value)) return FCPXML_EXPORT_TASK_KIND;
  if (object(value) && (value.mode === PREMIERE_EXPORT_TASK_KIND || value.kind === PREMIERE_EXPORT_TASK_KIND)) return PREMIERE_EXPORT_TASK_KIND;
}
export function isEditorExportTaskRecord(value: unknown): value is MarkedTask<EditorExportTaskKind> {
  return editorExportTaskKind(value) !== undefined;
}

/** Task Center needs the task identity and progress. The dedicated FCP RPC
 * reads terminal details after verifying the publication and source owner. */
type Identity = {id: string; projectId?: string};
export function discloseEditorExportTask(value: unknown, identity?: Identity, expectedKind?: EditorExportTaskKind): EditorExportTask | null {
  const targetKind = editorExportTaskKind(value);
  if (!targetKind || expectedKind && targetKind !== expectedKind || !object(value)) return null;
  const {id, projectId, requestId, title, status, progress, revision, createdAt, updatedAt, kind, mode} = value;
  const target = targets[targetKind];
  const parsed = target.schema.safeParse({id, projectId, requestId, title, status, progress, revision, createdAt, updatedAt, kind, mode});
  if (!parsed.success || identity && (id !== identity.id || identity.projectId !== undefined && projectId !== identity.projectId)) {
    throw new AppError('EXPORT_FAILED', '无法读取 ' + target.name + ' 导出任务。', 409);
  }
  return parsed.data;
}

export function discloseFcpExportTask(value: unknown, identity?: Identity): FcpExportTask | null {
  const task = discloseEditorExportTask(value, identity, FCPXML_EXPORT_TASK_KIND);
  return task?.kind === FCPXML_EXPORT_TASK_KIND ? task : null;
}
