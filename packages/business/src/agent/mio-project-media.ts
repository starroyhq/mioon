import {lstatSync, realpathSync} from 'node:fs';
import type {BigIntStats} from 'node:fs';
import {mioProjectMediaListInputSchema, mioProjectMediaListingSchema} from '../../../contracts/src/mio-project-media.ts';
import type {MioProjectMediaPort} from '../../../contracts/src/mio-project-media.ts';
import {mediaReferenceError} from '../../../contracts/src/media-reference-errors.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {isProjectFileHeld} from '../project-file/held-files.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {listProjectMediaPage} from '../media-reference/listing.ts';
import {readProjectUnpublishedMediaSnapshot} from '../referenced-asset-unpublished.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameIdentity = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const unavailable = () => mediaReferenceError('MEDIA_CHANGED_DURING_READ', {reason: 'project'});

/** An exact native host owns the root and lifetime. A model, copied store or
 * confirmed outside directory cannot manufacture this filesystem capability. */
export function createMioProjectMedia({store, signal}: {readonly store: ProjectStore; readonly signal?: AbortSignal}): MioProjectMediaPort {
  if (!isProjectStore(store)) throw unavailable();
  const projectId = store.projectId, directory = store.projectDir, file = store.projectFile;
  const realDirectory = realpathSync(directory), realFile = realpathSync(file);
  const directoryIdentity = lstatSync(realDirectory, {bigint: true}), fileIdentity = lstatSync(realFile, {bigint: true});
  if (!directoryIdentity.isDirectory() || !fileIdentity.isFile() || !isProjectFileHeld({dev: String(fileIdentity.dev), ino: String(fileIdentity.ino)})) throw unavailable();
  let admittedProject: {readonly createdAt: unknown} | undefined;
  function live(): void {
    signal?.throwIfAborted();
    if (!isProjectStore(store) || store.projectId !== projectId || store.projectDir !== directory || store.projectFile !== file) throw unavailable();
    try {
      if (realpathSync(directory) !== realDirectory || realpathSync(file) !== realFile ||
          !sameIdentity(lstatSync(realDirectory, {bigint: true}), directoryIdentity) ||
          !sameIdentity(lstatSync(realFile, {bigint: true}), fileIdentity)) throw unavailable();
    } catch {throw unavailable();}
    const row: unknown = store.db.prepare("SELECT id,CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) BETWEEN 1 AND 16384 THEN data END AS data FROM projects WHERE id=?").get(projectId);
    let project: unknown;
    try {project = object(row) && typeof row.data === 'string' ? JSON.parse(row.data) as unknown : undefined;} catch {project = undefined;}
    if (!object(row) || !object(project) || row.id !== projectId || project.id !== projectId ||
        admittedProject && project.createdAt !== admittedProject.createdAt) throw unavailable();
    admittedProject ??= {createdAt: project.createdAt};
  }
  return {
    async list(owner, input, context) {
      const parsed = mioProjectMediaListInputSchema.safeParse(input);
      if (!parsed.success) throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'path'});
      if (owner !== projectId) throw unavailable();
      const combined = signal && context.signal ? AbortSignal.any([signal, context.signal]) : signal ?? context.signal;
      const fence = (): void => {combined?.throwIfAborted(); live(); context.beforeEffect(); combined?.throwIfAborted(); live();};
      fence();
      const publications = await readProjectUnpublishedMediaSnapshot(store, {signal: combined, beforeEffect: fence});
      const beforeEffect = (): void => {fence(); publications.assertCurrent(); fence();};
      beforeEffect();
      // Persisted S1 references have size/mtime but no registration-time dev/ino.
      // Without all three proofs they are ineligible for duration reuse; L1's
      // bounded metadata probe is used instead of guessing identity from a path.
      const result = await listProjectMediaPage({projectDir: directory, projectFile: file, mayReadOutside: () => false,
        isHeld: identity => isProjectFileHeld(identity) || isAppLibraryHeld(identity)}, parsed.data.directory ?? '', {
        projectId, ...parsed.data, signal: combined, beforeEffect,
        scopeVersion: publications.version, isExcluded: publications.isExcluded,
      });
      beforeEffect();
      return mioProjectMediaListingSchema.parse(result);
    },
  };
}
