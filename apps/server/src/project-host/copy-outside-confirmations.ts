import path from 'node:path';
import {realpathSync} from 'node:fs';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {outsidePathConfirmationSchema} from '../../../../packages/contracts/src/project-registry.ts';
import type {OutsidePathConfirmationStore} from '../../../../packages/business/src/app-db/stores.ts';

export type CopyOutsidePaths = Pick<OutsidePathConfirmationStore, 'list' | 'confirm'>;

/** A user-requested new-ID copy transfers only existing consent: the source
 * project directory itself and its exact confirmed directories. No descendant
 * permission, project-file grant or model input enters this operation.
 *
 * The caller durably claims the transfer before any grant. A crash may leave
 * fewer grants, requiring explicit confirmation, but a replay must never grant
 * again after a user has revoked one on the new project. */
export function transferCopiedProjectConfirmations(outsidePaths: CopyOutsidePaths, sourceProjectId: string, projectId: string,
  sourceProjectDir: string, claim: (directories: readonly string[]) => void): void {
  const existing = outsidePaths.list(sourceProjectId);
  if (existing.length > 20_000) throw new AppError('PROJECT_BACKUP_COPY_FAILED', '素材位置确认过多，未转移确认。', 409);
  const directories = new Set(existing.map(entry => outsidePathConfirmationSchema.parse(entry))
    .filter(entry => entry.projectId === sourceProjectId).map(entry => entry.directory));
  // A missing source directory grants nothing; its references remain missing.
  try {directories.add(realpathSync(path.resolve(sourceProjectDir)));} catch {}
  const values = [...directories].sort();
  if (Buffer.byteLength(JSON.stringify(values)) > 1024 * 1024) throw new AppError('PROJECT_BACKUP_COPY_FAILED', '素材位置确认记录过大，未转移确认。', 409);
  claim(values);
  const confirmedAt = new Date().toISOString();
  for (const directory of values) outsidePaths.confirm(outsidePathConfirmationSchema.parse({projectId, directory, confirmedAt}));
}
