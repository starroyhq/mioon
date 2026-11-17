import path from 'node:path';
import {readPrivateFile, removePrivateFile, writePrivateFileAtomic} from '@mioon/contracts/private-storage';
import {desktopUpdateReopenSchema} from '../../../packages/contracts/src/desktop-update.ts';
import type {DesktopUpdateReopen} from '../../../packages/contracts/src/desktop-update.ts';

const maxBytes = 8 * 1024;
const lifetimeMs = 24 * 60 * 60 * 1000;
export interface DesktopUpdateInstallFailure {
  readonly version: string;
  readonly failures: 1 | 2;
}
interface StartupUpdate {
  readonly projectIds: readonly string[];
  readonly failure?: DesktopUpdateInstallFailure;
  readonly newFailure?: true;
}

export function createDesktopUpdateReopen(root: string, currentVersion: string, now: () => number = Date.now) {
  const file = path.join(root, 'update-reopen.json');
  const storage = {root, maxBytes};
  function read(): DesktopUpdateReopen | null {
    const raw = readPrivateFile(file, {...storage, encoding: 'utf8', allowMissing: true});
    if (raw === null) return null;
    try {return desktopUpdateReopenSchema.parse(JSON.parse(String(raw)));}
    catch {return null;}
  }
  function write(record: DesktopUpdateReopen): void {
    writePrivateFileAtomic(file, JSON.stringify(desktopUpdateReopenSchema.parse(record)), storage);
  }
  return {
    stage(installedVersion: string, projectIds: readonly string[]) {
      const previous = read();
      const failures = previous?.version === 2 && previous.status === 'failed' && previous.sourceVersion === currentVersion &&
        previous.installedVersion === installedVersion ? previous.failures : 0;
      if (failures === 2 || installedVersion === currentVersion) throw new Error('UPDATE_INSTALL_NOT_ADMITTED');
      write({version: 2, status: 'pending', sourceVersion: currentVersion, installedVersion, failures,
        requestedAt: now(), projectIds: [...new Set(projectIds)]});
    },
    consume(): StartupUpdate {
      const record = read();
      if (record?.version === 2 && record.sourceVersion === currentVersion && record.installedVersion !== currentVersion) {
        const {sourceVersion, installedVersion} = record;
        if (record.status === 'failed') return {projectIds: [], failure: {version: installedVersion, failures: record.failures}};
        const failures = record.failures === 0 ? 1 : 2;
        // Replacing the attempt atomically consumes it even if the process
        // exits again before the first window is shown.
        write({version: 2, status: 'failed', sourceVersion, installedVersion, failures});
        return {projectIds: [], failure: {version: installedVersion, failures}, newFailure: true};
      }
      // Consume before reopening any project, so even a failed open is never replayed.
      removePrivateFile(file, storage);
      if (!record || record.installedVersion !== currentVersion || record.version === 2 && record.status === 'failed') return {projectIds: []};
      const age = now() - record.requestedAt;
      return {projectIds: age >= 0 && age <= lifetimeMs ? record.projectIds : []};
    },
  };
}
