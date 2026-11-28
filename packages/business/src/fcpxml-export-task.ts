import {AppError} from '../../contracts/src/app-error.ts';
import {FCPXML_EXPORT_TASK_KIND, fcpxmlExportTaskSchema} from '../../contracts/src/project-registry.ts';
import type {FcpExportTask} from '../../contracts/src/project-registry.ts';

type Row = Record<string, unknown>;
type MarkedTask = Row & ({mode: typeof FCPXML_EXPORT_TASK_KIND} | {kind: typeof FCPXML_EXPORT_TASK_KIND});
const object = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The legacy render worker filters these rows before reading their bodies. */
export const FCPXML_EXPORT_TASK_SQL = `CASE WHEN json_valid(data) THEN
  json_extract(data,'$.mode') IS '${FCPXML_EXPORT_TASK_KIND}' OR json_extract(data,'$.kind') IS '${FCPXML_EXPORT_TASK_KIND}' ELSE 0 END`;

/** Recognize either discriminator so a damaged record cannot fall through to
 * generic rendering or disclose its private publication fields. */
export function isFcpExportTaskRecord(value: unknown): value is MarkedTask {
  return object(value) && (value.mode === FCPXML_EXPORT_TASK_KIND || value.kind === FCPXML_EXPORT_TASK_KIND);
}

/** Task Center needs the task identity and progress. The dedicated FCP RPC
 * reads terminal details after verifying the publication and source owner. */
export function discloseFcpExportTask(value: unknown, identity?: {id: string; projectId?: string}): FcpExportTask | null {
  if (!isFcpExportTaskRecord(value)) return null;
  const {id, projectId, requestId, title, status, progress, revision, createdAt, updatedAt, kind, mode} = value;
  const parsed = fcpxmlExportTaskSchema.safeParse({id, projectId, requestId, title, status, progress, revision, createdAt, updatedAt, kind, mode});
  if (!parsed.success || identity && (id !== identity.id || identity.projectId !== undefined && projectId !== identity.projectId)) {
    throw new AppError('EXPORT_FAILED', '无法读取 Final Cut Pro 导出任务。', 409);
  }
  return parsed.data;
}
