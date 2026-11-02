import type {DatabaseSync} from 'node:sqlite';
import type {ProjectFileIdentity} from '../../../contracts/src/project-registry.ts';
import type {DatabaseKind} from './schema/databases.ts';

/** The kernel's single live-file registry. Connection opening and release own
 * mutations; schema guards can read identity without importing any generated
 * DDL or manifests into the independent legacy schema derivation chain. */
const heldFiles = new Map<string, {readonly db: DatabaseSync; readonly kind: DatabaseKind}>();

// Internal connection lifecycle API. The source boundary test permits only
// connection.ts to import these functions; no registry entry escapes the leaf.
export function projectFileOwnerKind(key: string): DatabaseKind | undefined {
  const held = heldFiles.get(key);
  return held?.db.isOpen ? held.kind : undefined;
}
export function registerProjectFiles(db: DatabaseSync, files: readonly (readonly [string, DatabaseKind])[]): void {
  for (const [key, kind] of files) heldFiles.set(key, {db, kind});
}
export function releaseProjectFiles(db: DatabaseSync, files: readonly (readonly [string, DatabaseKind])[]): void {
  for (const [key] of files) if (heldFiles.get(key)?.db === db) heldFiles.delete(key);
}

/** Uses an lstat identity: never open a held SQLite file through fs, which
 * would drop the process's POSIX locks when that descriptor closes. File ID 0
 * conveys no identity; the kernel's path fallback is not exposed. */
export function isProjectFileHeld(identity: ProjectFileIdentity): boolean {
  return identity.ino !== '0' && heldFiles.get(`${identity.dev}:${identity.ino}`)?.db.isOpen === true;
}

/** Only a live connection registered by a successful kernel open qualifies.
 * Store fields or another SQLite connection cannot establish ownership. */
export function isProjectDatabase(db: unknown): boolean {
  for (const held of heldFiles.values()) if (held.db === db && held.db.isOpen) return true;
  return false;
}
