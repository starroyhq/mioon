import {lstatSync} from 'node:fs';
import type {Stats} from 'node:fs';
import path from 'node:path';
import {PrivateStorageError, validateManagedFile} from '@mioon/contracts/private-storage';
import {readPrivateFile, writePrivateFileAtomic, removePrivateFile} from '@mioon/contracts/private-storage';
import type {ReadPrivateFileOptions, WritePrivateFileOptions, RemovePrivateFileOptions} from '@mioon/contracts/private-storage';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectFileHeld} from './project-file/held-files.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';

const projects = new Map<string, {readonly owner: WeakRef<ProjectStore>; count: number}>();
/** A root string only selects an already proven, still-live kernel owner. */
export function registerProjectMediaStore(store: unknown): () => void {
  if (!isProjectStore(store)) return () => {};
  const root = store.projectDir, prior = projects.get(root);
  const registration = prior?.owner.deref() === store ? prior : {owner: new WeakRef(store), count: 0};
  registration.count++; projects.set(root, registration);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--registration.count === 0 && projects.get(root) === registration) projects.delete(root);
  };
}
export function projectMediaDirectory(store: ProjectStore): string {
  if (!isProjectStore(store)) throw new TypeError('Project media requires the exact live project store');
  return path.join(store.projectDir, 'media');
}
export interface ProjectMediaFileOptions {allowMissing?: boolean; maxBytes?: number; private?: boolean}
/** Content is under media/, whose private mode is independent of the ordinary
 * 0755 project folder. App/local/cache/temp roots never enter this API. Every
 * ancestor and symlink/hard-link rule remains the existing storage policy. */
export function resolveProjectMediaFile(store: ProjectStore, relativePath: string, options: ProjectMediaFileOptions = {}): {file: string; info: Stats | null} {
  const root = projectMediaDirectory(store);
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || relativePath.includes('\0') || relativePath.includes('\\') || !relativePath.startsWith('media/') || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new PrivateStorageError('OUTSIDE_ROOT', 'Project content must name a canonical media file');
  }
  const file = path.resolve(store.projectDir, relativePath);
  if (!file.startsWith(root + path.sep)) throw new PrivateStorageError('OUTSIDE_ROOT', 'Project content must stay inside its media directory');
  const info = validateManagedFile(file, {root, ...options});
  if (info) {
    // Metadata only: opening a held SQLite inode through fs would drop its lock.
    const identity = lstatSync(file, {bigint: true});
    const id = {dev: String(identity.dev), ino: String(identity.ino)};
    if (isProjectFileHeld(id) || isAppLibraryHeld(id)) throw new PrivateStorageError('HELD_DATABASE', 'A held database cannot be used as project media');
  }
  return {file, info};
}
/** Compatibility for internal decoder APIs that already take root:string.
 * A copied store or arbitrary matching path never registers a capability. */
export function registeredProjectMediaFile(root: string, relativePath: string): {file: string; info: Stats | null} | undefined {
  const store = projects.get(root)?.owner.deref();
  if (!store || !isProjectStore(store) || store.projectDir !== root) {projects.delete(root); return undefined;}
  return resolveProjectMediaFile(store, relativePath);
}
export function readProjectMediaFile(store: ProjectStore, relativePath: string, options: Omit<ReadPrivateFileOptions, 'root'> = {}): Buffer | string | null {
  const {file} = resolveProjectMediaFile(store, relativePath, options);
  return readPrivateFile(file, {root: projectMediaDirectory(store), ...options});
}
export function writeProjectMediaFileAtomic(store: ProjectStore, relativePath: string, bytes: Buffer | string | Uint8Array, options: Omit<WritePrivateFileOptions, 'root'> = {}): void {
  const {file} = resolveProjectMediaFile(store, relativePath, {allowMissing: true, maxBytes: options.maxBytes, private: true});
  writePrivateFileAtomic(file, bytes, {root: projectMediaDirectory(store), ...options});
}
export function removeProjectMediaFile(store: ProjectStore, relativePath: string, options: Omit<RemovePrivateFileOptions, 'root'> = {}): void {
  const {file} = resolveProjectMediaFile(store, relativePath, {allowMissing: true, ...options});
  removePrivateFile(file, {root: projectMediaDirectory(store), ...options});
}
