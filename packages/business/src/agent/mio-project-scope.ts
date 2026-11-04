import {lstatSync, realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import path from 'node:path';
import {mediaReferenceError} from '../../../contracts/src/media-reference-errors.ts';
import {isProjectFileHeld} from '../project-file/held-files.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {isInsideRealDirectory} from '../media-reference/paths.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => mediaReferenceError('MEDIA_CHANGED_DURING_READ', {reason: 'project'});

/** Shared native ownership for listing and import. Private scope is injected
 * by the application host and is never derived from a model's file argument. */
export function createMioProjectScope({store, privateDirectories, signal}: {
  readonly store: ProjectStore;
  readonly privateDirectories: readonly string[];
  readonly signal?: AbortSignal;
}) {
  if (!isProjectStore(store)) throw unavailable();
  if (!Array.isArray(privateDirectories) || privateDirectories.length === 0 ||
      privateDirectories.some(directory => typeof directory !== 'string' || !path.isAbsolute(directory))) throw unavailable();
  const projectId = store.projectId, directory = store.projectDir, file = store.projectFile;
  const realDirectory = realpathSync(directory), realFile = realpathSync(file);
  const directoryIdentity = lstatSync(realDirectory, {bigint: true}), fileIdentity = lstatSync(realFile, {bigint: true});
  if (!directoryIdentity.isDirectory() || !fileIdentity.isFile() || !isProjectFileHeld({dev: String(fileIdentity.dev), ino: String(fileIdentity.ino)})) throw unavailable();
  const privateRoots = [...new Set([...privateDirectories, store.localDir, store.cacheDir, store.tempDir])].map(directory => {
    const real = realpathSync(directory), identity = lstatSync(real, {bigint: true});
    if (!identity.isDirectory()) throw unavailable();
    return {directory, real, identity};
  });
  // Default projects may be below app data. Only private roots reached inside
  // this project block traversal; realpath still confines every ordinary read.
  const blocked = privateRoots.filter(root => isInsideRealDirectory(realDirectory, root.real));
  const isPrivate = (file: string): boolean => blocked.some(root => isInsideRealDirectory(root.real, file));
  let admittedProject: {readonly createdAt: unknown} | undefined;
  function live(): void {
    signal?.throwIfAborted();
    if (!isProjectStore(store) || store.projectId !== projectId || store.projectDir !== directory || store.projectFile !== file) throw unavailable();
    try {
      if (realpathSync(directory) !== realDirectory || realpathSync(file) !== realFile ||
          !sameIdentity(lstatSync(realDirectory, {bigint: true}), directoryIdentity) ||
          !sameIdentity(lstatSync(realFile, {bigint: true}), fileIdentity)) throw unavailable();
      for (const root of privateRoots) {
        const now = lstatSync(root.real, {bigint: true});
        if (realpathSync(root.directory) !== root.real || !now.isDirectory() || !sameIdentity(now, root.identity)) throw unavailable();
      }
    } catch {throw unavailable();}
    const row: unknown = store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM projects WHERE id=?").get(projectId);
    let project: unknown;
    try {project = object(row) && typeof row.data === 'string' ? JSON.parse(row.data) as unknown : undefined;} catch {project = undefined;}
    if (!object(row) || !object(project) || row.id !== projectId || project.id !== projectId ||
        admittedProject && project.createdAt !== admittedProject.createdAt) throw unavailable();
    admittedProject ??= {createdAt: project.createdAt};
  }
  return Object.freeze({projectId, directory, file, realDirectory, live, isPrivate,
    blockedRoots: Object.freeze(blocked.map(root => root.real))});
}
