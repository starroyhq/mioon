import {lstatSync} from 'node:fs';
import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory} from '@mioon/contracts/private-storage';
import {TEST_STORE_LAYOUT} from '../../../contracts/src/project-file.ts';
import {createProjectFile} from './connection.ts';
import type {ProjectLocation} from './connection.ts';
import {isProjectStore, openProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';

const testStores = new WeakMap<ProjectStore, {readonly applicationDir: string; readonly closeCompanions: Set<() => void>}>();
/** Only this opener grants the test-layout application scope. Matching public
 * paths or copying a live store's fields cannot manufacture it. */
export function testStoreApplicationDirectory(value: unknown): string | null {
  return isProjectStore(value) ? testStores.get(value)?.applicationDir ?? null : null;
}
export function registerTestStoreCloseCompanion(store: ProjectStore, close: () => void): () => void {
  const held = isProjectStore(store) ? testStores.get(store) : undefined;
  if (!held) throw new TypeError('A live test-layout project store is required');
  held.closeCompanions.add(close);
  return () => {held.closeCompanions.delete(close);};
}

/** Store-level `openStore(root)` of the test layout: `root` is the project
 * directory with `project.mioon`, and the local records, cache and temporary
 * directories share `root/.mioon-store/`. The project file is created on the
 * first call, so this replaces db.ts's `openStore(root)` one for one. */
export function openStore(root: string): ProjectStore {
  root = path.resolve(root);
  ensurePrivateDirectory(root, {create: true});
  const projectFile = path.join(root, ...TEST_STORE_LAYOUT.projectFile);
  if (!lstatSync(projectFile, {throwIfNoEntry: false})) createProjectFile(projectFile);
  const location: ProjectLocation = {
    localDir: path.join(root, ...TEST_STORE_LAYOUT.localDir),
    cacheDir: path.join(root, ...TEST_STORE_LAYOUT.cacheDir),
    tempDir: path.join(root, ...TEST_STORE_LAYOUT.tempDir),
  };
  const store = openProjectStore({projectFile, locate: () => location});
  try {
    // Managed media copies stay in root/media for now, created as db.ts does.
    const media = path.join(root, 'media');
    if (!validateManagedDirectory(media, {root, allowMissing: true})) ensurePrivateDirectory(media, {create: true});
  } catch (error) {
    store.close();
    throw error;
  }
  const held = {applicationDir: path.join(root, '.mioon-store', 'app'), closeCompanions: new Set<() => void>()};
  testStores.set(store, held);
  const close = store.close;
  store.close = (): void => {
    const failures: unknown[] = [];
    try {close();} catch (error) {failures.push(error);}
    if (!store.db.isOpen) {
      testStores.delete(store);
      for (const companion of held.closeCompanions) {
        try {companion();} catch (error) {failures.push(error);}
      }
      held.closeCompanions.clear();
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, 'Test project and application close failed');
  };
  return store;
}
