import type {DatabaseSync} from 'node:sqlite';
import type {AppLibrary} from '../app-db/index.ts';
import {isAppLibraryHeld, projectFileIdentity, sameProjectFileIdentity} from '../app-db/index.ts';
import {isProjectStore} from '../project-file/store.ts';
import type {ProjectStore} from '../project-file/store.ts';
import {testStoreApplicationDirectory} from '../project-file/test-store.ts';
import {foreignKeyCheck} from '../project-file/cross-file/inspect.ts';
import {registerAgentTaskRowValidationContext} from './task-row-validation-context.ts';

const bindings = new WeakMap<DatabaseSync, {readonly store: ProjectStore; readonly library: AppLibrary; readonly release: () => void; references: number}>();

/** Bind only the manager's exact project owner and the real held B1 library.
 * Production registration is required; TEST ownership comes from its opener's
 * exact metadata, never a matching path or a copied store object. */
export function bindAgentTaskRowValidation(store: ProjectStore, library: AppLibrary): () => void {
  const assertAvailable = (): void => {
    if (!isProjectStore(store)) throw new TypeError('Agent task row validation requires the exact live project store');
    const identity = projectFileIdentity(library.databaseFile);
    if (!identity || !isAppLibraryHeld(identity, library.db)) throw new TypeError('Agent task row validation requires a live application library');
    const testDirectory = testStoreApplicationDirectory(store);
    if (testDirectory !== null) {
      if (library.dataDir !== testDirectory) throw new TypeError('Agent task row validation application does not own this TEST project');
    } else {
      const projectIdentity = projectFileIdentity(store.projectFile), registered = library.registry.get(store.projectId);
      if (!projectIdentity || !registered || !sameProjectFileIdentity(registered.fileIdentity, projectIdentity)) {
        throw new TypeError('Agent task row validation application does not own this project');
      }
    }
  };
  assertAvailable();
  let binding = bindings.get(store.db);
  if (binding && (binding.store !== store || binding.library !== library)) throw new TypeError('Agent task row validation is bound to another application');
  if (!binding) {
    const release = registerAgentTaskRowValidationContext(store.db, {application: library.db, assertAvailable,
      foreignKeysValid: () => foreignKeyCheck(store.db).length === 0 && library.db.prepare('PRAGMA main.foreign_key_check').get() === undefined});
    binding = {store, library, release, references: 0};
    bindings.set(store.db, binding);
  }
  const held = binding;
  held.references++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.references === 0) {held.release(); if (bindings.get(store.db) === held) bindings.delete(store.db);}
  };
}
