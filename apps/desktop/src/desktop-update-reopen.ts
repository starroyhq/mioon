import path from 'node:path';
import {readPrivateFile, removePrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {desktopUpdateReopenSchema} from '../../../packages/contracts/src/desktop-update.ts';
import type {DesktopUpdateReopen} from '../../../packages/contracts/src/desktop-update.ts';

const maxBytes = 8 * 1024;
const lifetimeMs = 24 * 60 * 60 * 1000;
export function createDesktopUpdateReopen(root: string, now: () => number = Date.now) {
  const file = path.join(root, 'update-reopen.json');
  const storage = {root, maxBytes};
  return {
    stage(installedVersion: string, projectIds: readonly string[]) {
      const record = desktopUpdateReopenSchema.parse({version: 1, installedVersion, requestedAt: now(), projectIds: [...new Set(projectIds)]});
      writePrivateFileAtomic(file, JSON.stringify(record), storage);
    },
    discard() {removePrivateFile(file, storage);},
    consume(currentVersion: string): readonly string[] {
      const raw = readPrivateFile(file, {...storage, encoding: 'utf8', allowMissing: true});
      if (raw === null) return [];
      // Consume before attempting to open any project. A failed open remains
      // an ordinary recent project and never causes a second automatic open.
      removePrivateFile(file, storage);
      let record: DesktopUpdateReopen;
      try {record = desktopUpdateReopenSchema.parse(JSON.parse(String(raw)));}
      catch {return [];}
      const age = now() - record.requestedAt;
      return record.installedVersion === currentVersion && age >= 0 && age <= lifetimeMs ? record.projectIds : [];
    },
  };
}
