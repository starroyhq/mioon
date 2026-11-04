import {realpathSync} from 'node:fs';
import path from 'node:path';
import {mioProjectMediaListInputSchema, mioProjectMediaListingSchema} from '../../../contracts/src/mio-project-media.ts';
import type {MioProjectMediaPort} from '../../../contracts/src/mio-project-media.ts';
import {mediaReferenceError} from '../../../contracts/src/media-reference-errors.ts';
import {isAppLibraryHeld} from '../app-db/connection.ts';
import {isProjectFileHeld} from '../project-file/held-files.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {listProjectMediaPage} from '../media-reference/listing.ts';
import {readProjectUnpublishedMediaSnapshot} from '../referenced-asset-unpublished.ts';
import {readProjectOutputUnpublishedSnapshot} from '../project-output-unpublished.ts';
import {createMioProjectScope} from './mio-project-scope.ts';

const unavailable = () => mediaReferenceError('MEDIA_CHANGED_DURING_READ', {reason: 'project'});

/** An exact native host owns the root and lifetime. A model, copied store or
 * confirmed outside directory cannot manufacture this filesystem capability. */
export function createMioProjectMedia({store, privateDirectories, signal}: {
  readonly store: ProjectStore;
  /** Complete app data/cache/temp roots from the trusted host, not inferred
   * from a project's locator (other projects have private cache entries too). */
  readonly privateDirectories: readonly string[];
  readonly signal?: AbortSignal;
}): MioProjectMediaPort {
  const scope = createMioProjectScope({store, privateDirectories, signal});
  const {projectId, directory, file, live, isPrivate} = scope;
  return {
    async list(owner, input, context) {
      const parsed = mioProjectMediaListInputSchema.safeParse(input);
      if (!parsed.success) throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'path'});
      if (owner !== projectId) throw unavailable();
      const combined = signal && context.signal ? AbortSignal.any([signal, context.signal]) : signal ?? context.signal;
      const fence = (): void => {
        combined?.throwIfAborted(); live(); context.beforeEffect(); combined?.throwIfAborted(); live();
        let requested: string;
        try {requested = realpathSync(path.join(directory, parsed.data.directory ?? ''));}
        catch {throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'missing'});}
        if (isPrivate(requested)) throw mediaReferenceError('MEDIA_LIST_PATH_INVALID', {reason: 'path'});
      };
      fence();
      const imports = await readProjectUnpublishedMediaSnapshot(store, {signal: combined, beforeEffect: fence});
      const publications = await readProjectOutputUnpublishedSnapshot(store, {signal: combined, beforeEffect: fence});
      const beforeEffect = (): void => {fence(); imports.assertCurrent(); publications.assertCurrent(); fence();};
      beforeEffect();
      // Persisted S1 references have size/mtime but no registration-time dev/ino.
      // Without all three proofs they are ineligible for duration reuse; L1's
      // bounded metadata probe is used instead of guessing identity from a path.
      const result = await listProjectMediaPage({projectDir: directory, projectFile: file, mayReadOutside: () => false,
        isHeld: identity => isProjectFileHeld(identity) || isAppLibraryHeld(identity)}, parsed.data.directory ?? '', {
        projectId, ...parsed.data, signal: combined, beforeEffect,
        scopeVersion: JSON.stringify([imports.version, publications.version, scope.blockedRoots]),
        isExcluded: (file, stats) => isPrivate(file) || imports.isExcluded(file, stats) || publications.isExcluded(file, stats),
      });
      beforeEffect();
      return mioProjectMediaListingSchema.parse(result);
    },
  };
}
