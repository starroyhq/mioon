import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import type {HistoryFileIdentity} from '../../../../packages/contracts/src/project-history-recovery.ts';
import {heldProjectHistoryIdentity} from '../../../../packages/business/src/project-file/store.ts';
import type {ProjectStore} from '../../../../packages/business/src/project-file/store.ts';

function digest(directory: Stats, file: Stats): string {
  return createHash('sha256').update(JSON.stringify(['s3-history-v1', String(directory.dev), String(directory.ino),
    String(file.dev), String(file.ino), file.birthtimeMs])).digest('hex');
}

/** The kernel's captured identity, without opening a second SQLite or fs fd. */
export function backgroundHistorySource(store: ProjectStore): string {
  const identity = heldProjectHistoryIdentity(store);
  return digest(identity.directory, identity.db);
}

/** Metadata comparison only, after V5's completed receipt was verified. It
 * cannot open a project or grant task execution under this identity. */
export function currentBackgroundHistorySource(localDir: string): string {
  const directory = lstatSync(localDir), file = lstatSync(path.join(localDir, 'history.db'));
  if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
    throw new AppError('PROJECT_BACKGROUND_HISTORY_UNAVAILABLE', '无法核验当前本机记录的后台任务代际。', 409);
  }
  return digest(directory, file);
}

/** A completed V5 receipt names the old file. Its rename preserves this
 * identity, so replay archives that epoch rather than a newly active one. */
export function archivedBackgroundHistorySource(localDir: string, archive: string, expected: HistoryFileIdentity): string {
  if (!/^history-\d{14}-[a-f0-9-]{36}\.db$/u.test(archive)) throw new TypeError('Invalid history archive identity');
  try {
    const directory = lstatSync(localDir), file = lstatSync(path.join(localDir, archive));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1
      || String(file.dev) !== expected.dev || String(file.ino) !== expected.ino) throw new Error('History archive changed');
    return digest(directory, file);
  } catch {
    throw new AppError('PROJECT_BACKGROUND_HISTORY_UNAVAILABLE', '无法核验旧本机记录的后台任务代际，请保留记录后重试。', 409);
  }
}
