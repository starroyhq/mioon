import type {DatabaseSync} from 'node:sqlite';
import {AppError} from '../../../contracts/src/app-error.ts';
import type {ContentStamp, ProjectHistoryAdmission} from '../../../contracts/src/project-file.ts';
export type {ContentStamp, ProjectHistoryAdmission} from '../../../contracts/src/project-file.ts';

export const isContentToken = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
const validSequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function invalid(database: 'project' | 'history'): never {
  throw new AppError('PROJECT_INVALID', '项目文件的内容身份无效。', 422, {database, reason: 'metadata'});
}
/** Reads the exact live pair; no independent project descriptor or write. */
export function readProjectContentStamp(db: DatabaseSync, schema = 'project'): ContentStamp {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema)) throw new TypeError('Invalid schema');
  const rows = db.prepare(`SELECT contentSequence,contentToken FROM ${schema}.project_file`).all();
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || !validSequence(row.contentSequence) || !isContentToken(row.contentToken)) invalid('project');
  return Object.freeze({contentSequence: row.contentSequence, contentToken: row.contentToken});
}
export function classifyHistoryStamp(db: DatabaseSync, fresh: boolean): ProjectHistoryAdmission {
  const file = readProjectContentStamp(db);
  const rows = db.prepare('SELECT seenContentSequence,seenContentToken FROM main.history_state').all();
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || !validSequence(row.seenContentSequence) || row.seenContentToken !== null && !isContentToken(row.seenContentToken)) invalid('history');
  const seen = Object.freeze({contentSequence: row.seenContentSequence, contentToken: row.seenContentToken as string | null});
  if (seen.contentToken === file.contentToken && seen.contentSequence !== file.contentSequence) invalid('history');
  const reason = seen.contentToken === null ? 'legacy-token-missing'
    : file.contentSequence < seen.contentSequence ? 'file-sequence-smaller'
    : file.contentSequence > seen.contentSequence ? 'file-sequence-larger'
    : file.contentToken !== seen.contentToken ? 'content-token-different' : null;
  return Object.freeze({state: fresh ? 'fresh' : reason ? 'diverged' : 'current', reason, file, seen});
}
export function sameContentStamp(a: ContentStamp, b: ContentStamp): boolean {
  return a.contentSequence === b.contentSequence && a.contentToken === b.contentToken;
}
