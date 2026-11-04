import {lstatSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../../../../packages/contracts/src/app-error.ts';
import {projectCopyIntentSchema as copyIntentSchema} from '../../../../packages/contracts/src/project-copy-records.ts';
import type {ProjectCopyIntent} from '../../../../packages/contracts/src/project-copy-records.ts';
import {ensurePrivateDirectory, readPrivateFile, writePrivateFileAtomic} from '../../../../packages/contracts/src/private-storage.ts';
import {syncCopiedDirectory} from '../../../../packages/business/src/project-file/backup.ts';

const LIMIT = 2 * 1024 * 1024;
export type CopyIntent = ProjectCopyIntent;
export const copyFailure = (code: string, message: string, status = 409): AppError => new AppError(code, message, status);
export function copyIdentity(file: string): {dev: string; ino: string} | null {
  const info = lstatSync(file, {bigint: true, throwIfNoEntry: false});
  return info && !info.isSymbolicLink() && (info.isFile() || info.isDirectory()) ? {dev: String(info.dev), ino: String(info.ino)} : null;
}
export function sameCopyIdentity(a: {dev: string; ino: string} | null, b: {dev: string; ino: string} | null): boolean {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}
export function createCopyRecords(dataDir: string, assertAllowed: () => void) {
  const root = path.join(dataDir, 'project-copies');
  const file = (operation: CopyIntent['operation'], requestId: string) => path.join(root, `${operation}-${requestId}.json`);
  const work = (operation: CopyIntent['operation'], requestId: string) => path.join(root, `${operation}-${requestId}`);
  const read = (operation: CopyIntent['operation'], requestId: string): CopyIntent | null => {
    const target = file(operation, requestId);
    if (!lstatSync(target, {throwIfNoEntry: false})) return null;
    try {
      const bytes = readPrivateFile(target, {root, maxBytes: LIMIT});
      if (bytes === null) throw Error('missing intent');
      const value = copyIntentSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (value.operation !== operation || value.input.requestId !== requestId
        || value.stageDirectory !== null && (path.dirname(value.stageDirectory) !== path.dirname(value.input.projectFile)
          || !path.basename(value.stageDirectory).startsWith('.project-copy-'))) throw Error('intent binding');
      return value;
    } catch (cause) {
      const error = copyFailure('PROJECT_COPY_INTENT_INVALID', '项目复制恢复记录无效，未更改源或目标。'); error.cause = cause; throw error;
    }
  };
  return {root, work, read,
    write(intent: CopyIntent): void {
      assertAllowed();
      const parsed = copyIntentSchema.parse(intent);
      ensurePrivateDirectory(root, {create: true});
      writePrivateFileAtomic(file(parsed.operation, parsed.input.requestId), JSON.stringify(parsed), {root, maxBytes: LIMIT});
      syncCopiedDirectory(root);
    },
    list(): CopyIntent[] {
      if (!lstatSync(root, {throwIfNoEntry: false})) return [];
      ensurePrivateDirectory(root);
      return readdirSync(root).filter(name => /^(?:project\.duplicate|project\.save-as)-[a-f0-9-]{36}\.json$/u.test(name))
        .map(name => {
          const operation = name.startsWith('project.duplicate-') ? 'project.duplicate' : 'project.save-as';
          return read(operation, name.slice(operation.length + 1, -5))!;
        });
    },
  };
}
