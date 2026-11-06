import type {ProjectBackupRestoreInput, ProjectBackupRestoreResponse} from '../../../packages/contracts/src/project-backups.ts';
import {projectBackupSchemas, projectBackupRestoreResponseSchema} from '../../../packages/contracts/src/project-backups.ts';
import {backupRestoreSelectionSchema,projectBackupNativeChooseResponseSchema,projectBackupNativeRevealResponseSchema} from '../../../packages/contracts/src/workspace-native.ts';
import type {ProjectBackupNativeErrorCode} from '../../../packages/contracts/src/workspace-native.ts';

/** The native chooser supplies one explicit backup-restore destination. The
 * application RPC still owns validation, publication and exact replay. */
export interface ProjectBackupNativeActions {
  chooseDestination(input: {readonly projectId: string; readonly backupId: string; readonly requestId: string}): Promise<ProjectBackupRestoreInput | null>;
  reveal(result: ProjectBackupRestoreResponse): Promise<void>;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => Object.assign(new Error('Native backup action is unavailable.'), {code: 'WORKSPACE_NATIVE_UNAVAILABLE'});
const failure = (code:ProjectBackupNativeErrorCode) => Object.assign(new Error('Native backup action is unavailable.'), {code});
const call = async (invoke:()=>unknown):Promise<unknown> => {try{return await invoke();}catch{throw unavailable();}};
/** Missing/invalid capabilities stay hidden; no browser path or package-token
 * fallback can turn into a native backup restore permission. */
export function readProjectBackupNativeActions(host: unknown = globalThis): ProjectBackupNativeActions | null {
  if (!record(host) || !record(host.__mioonProjectBackups)) return null;
  const bridge = host.__mioonProjectBackups;
  if (typeof bridge.chooseDestination !== 'function' || typeof bridge.reveal !== 'function') return null;
  const choose = bridge.chooseDestination, reveal = bridge.reveal;
  return Object.freeze({
    async chooseDestination(input: Parameters<ProjectBackupNativeActions['chooseDestination']>[0]) {
      const selected = backupRestoreSelectionSchema.parse(input), response = projectBackupNativeChooseResponseSchema.safeParse(await call(()=>choose(selected)));
      if (!response.success) throw unavailable();
      if (!response.data.ok) throw failure(response.data.code);
      const value = response.data.value;
      if (value === null) return null;
      const result = projectBackupSchemas['project.backup.restore'].safeParse(value);
      if (!result.success || result.data.projectId !== selected.projectId || result.data.backupId !== selected.backupId || result.data.requestId !== selected.requestId) throw unavailable();
      return result.data;
    },
    async reveal(input: ProjectBackupRestoreResponse) {
      const result = projectBackupRestoreResponseSchema.parse(input);
      const response = projectBackupNativeRevealResponseSchema.safeParse(await call(()=>reveal(result)));
      if (!response.success) throw unavailable();
      if (!response.data.ok) throw failure(response.data.code);
      if (response.data.value !== true) throw unavailable();
    },
  });
}
