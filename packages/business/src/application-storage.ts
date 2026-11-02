import path from 'node:path';
import {lstatSync} from 'node:fs';
import {AppError} from '../../contracts/src/app-error.ts';
import {validateManagedDirectory, validateManagedFile, validatePrivateDirectory} from '@mioon/contracts/private-storage';

/** Metadata-only application preflight. Legacy workspace, media and staging
 * entries are not part of this layout; an old database is explicitly refused. */
export function validateWorkspaceStorage(root: string, {cacheDir = path.join(root, 'cache'), tempDir = path.join(root, 'tmp')}:
  {cacheDir?: string; tempDir?: string} = {}): void {
  root = path.resolve(root);
  if (!validatePrivateDirectory(root, {allowMissing: true})) return;
  if (lstatSync(path.join(root, 'workbench.sqlite'), {throwIfNoEntry: false})) throw new AppError('VALIDATION_ERROR', '此目录含旧工作区 workbench.sqlite，请选择新的应用数据目录；不会自动迁移旧文件。', 400);
  for (const [name, maxBytes, privateFile] of [['access-token', 4098, true], ['server.lock', 64, false],
    ['app-library.db', undefined, true], ['app-library.db-journal', undefined, true], ['app-library.db-wal', undefined, true], ['app-library.db-shm', undefined, true]] as const) {
    validateManagedFile(path.join(root, name), {root, allowMissing: true, ...(maxBytes === undefined ? {} : {maxBytes}), private: privateFile});
  }
  for (const folder of [path.join(root, 'records'), cacheDir, tempDir]) validatePrivateDirectory(folder, {allowMissing: true});
  for (const name of ['agent-settings', 'image-settings', 'comfy-settings', 'video-settings']) {
    const folder = path.join(root, name);
    if (validateManagedDirectory(folder, {root, allowMissing: true, private: true})) for (const file of name === 'image-settings' ? ['settings.json', 'custom-settings.json'] : ['settings.json']) {
      validateManagedFile(path.join(folder, file), {root, allowMissing: true, private: true, maxBytes: name === 'video-settings' ? 4 * 1024 * 1024 : name === 'comfy-settings' ? 16 * 1024 : 64 * 1024});
    }
  }
}
