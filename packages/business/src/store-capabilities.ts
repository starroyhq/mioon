import {isProjectDatabase} from './project-file/held-files.ts';
import {assertProjectDatabase} from './store-runtime.ts';
import {FORMAT4_PROJECT_SCHEMA_VERSION} from './project-file/schema/databases.ts';
import type {DatabaseSync} from 'node:sqlite';

/** The canonical kernel manifest is validated by the real opener. No legacy
 * marker or table-name probe can grant one of these current capabilities. */
export const usesAssetAnnotationSchema=(db: unknown): boolean=>isProjectDatabase(db);
export const usesPrevisSchema=(db: unknown): boolean=>isProjectDatabase(db);
export const usesAgentPolicyAnswerSchema=(db: unknown): boolean=>isProjectDatabase(db);
export function usesTimelineFrameTransaction(db: DatabaseSync): boolean {
  return isProjectDatabase(db) && db.prepare('PRAGMA project.user_version').get()?.user_version === FORMAT4_PROJECT_SCHEMA_VERSION;
}
export function assertTimelineAudioRoleWorkspace(db: DatabaseSync,_value: unknown): void {assertProjectDatabase(db);}
