import {createHash} from 'node:crypto';
import {lstatSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {projectDeleteInputSchema} from '../../../../packages/contracts/src/project-lifecycle.ts';
import type {ProjectDeleteInput} from '../../../../packages/contracts/src/project-lifecycle.ts';
import {projectTrashIntentSchema} from '../../../../packages/contracts/src/project-trash-records.ts';
import type {ProjectTrashIntent} from '../../../../packages/contracts/src/project-trash-records.ts';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '../../../../packages/contracts/src/private-storage.ts';
import {isAppLibraryHeld} from '../../../../packages/business/src/app-db/connection.ts';
import {isProjectFileHeld} from '../../../../packages/business/src/project-file/held-files.ts';
import {syncCopiedDirectory} from '../../../../packages/business/src/project-file/backup.ts';
import {canonicalJson} from '../../../../packages/business/src/project-versions/document.ts';

export const PROJECT_TRASH_OPERATION = 'project.delete' as const;
export const projectTrashDigest = (input: ProjectDeleteInput): string => createHash('sha256')
  .update(canonicalJson({operation: PROJECT_TRASH_OPERATION, input})).digest('hex');
export type {ProjectTrashIntent} from '../../../../packages/contracts/src/project-trash-records.ts';
export const invalidTrashIntent = (): AppError => new AppError('PROJECT_TRASH_INTENT_INVALID', '移到废纸篓的操作记录无效，未重试移动项目文件。', 409);

/** A dispatch without a final B1 receipt is permanently uncertain. Startup
 * does not replay these files or infer an outcome from a missing path. */
export function createProjectTrashRecords(dataDir: string, assertAllowed: () => void) {
  const root = path.join(dataDir, 'project-trash'), limit = 64 * 1024;
  const file = (requestId: string) => path.join(root, `${requestId}.json`);
  const checkFile = (target: string): boolean => {
    const info = lstatSync(target, {bigint: true, throwIfNoEntry: false});
    if (!info) return false;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
      || isAppLibraryHeld({dev: String(info.dev), ino: String(info.ino)})
      || isProjectFileHeld({dev: String(info.dev), ino: String(info.ino)})) throw invalidTrashIntent();
    return true;
  };
  const checked = (raw: unknown): ProjectTrashIntent => {
    const value = projectTrashIntentSchema.parse(raw), {input, source} = value;
    if (value.digest !== projectTrashDigest(input) || source.projectId !== input.projectId
      || source.revision !== input.expectedRevision || source.generation.dev !== input.fileIdentity.dev
      || source.generation.ino !== input.fileIdentity.ino) throw invalidTrashIntent();
    return value;
  };
  const read = (requestId: string): ProjectTrashIntent | null => {
    if (!projectDeleteInputSchema.shape.requestId.safeParse(requestId).success) throw invalidTrashIntent();
    const target = file(requestId);
    if (!checkFile(target)) return null;
    try {
      const bytes = readPrivateFile(target, {root, maxBytes: limit});
      if (bytes === null) throw invalidTrashIntent();
      const value = checked(JSON.parse(bytes.toString('utf8')));
      if (value.input.requestId !== requestId) throw invalidTrashIntent();
      return value;
    } catch (cause) {
      const error = invalidTrashIntent(); error.cause = cause; throw error;
    }
  };
  return {root, read,
    write(raw: ProjectTrashIntent): void {
      assertAllowed();
      const value = checked(raw);
      ensurePrivateDirectory(root, {create: true});
      checkFile(file(value.input.requestId));
      writePrivateFileAtomic(file(value.input.requestId), JSON.stringify(value), {root, maxBytes: limit});
      syncCopiedDirectory(root);
      // The first record also needs its newly-created parent entry durable.
      syncCopiedDirectory(dataDir);
    },
    list(): ProjectTrashIntent[] {
      if (!lstatSync(root, {throwIfNoEntry: false})) return [];
      ensurePrivateDirectory(root);
      return readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/iu.test(name)).map(name => read(name.slice(0, -5))!);
    },
  };
}
