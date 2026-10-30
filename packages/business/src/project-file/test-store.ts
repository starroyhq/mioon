import {lstatSync} from 'node:fs';
import path from 'node:path';
import {ensurePrivateDirectory, validateManagedDirectory} from '@mioon/contracts/private-storage';
import {TEST_STORE_LAYOUT} from '../../../contracts/src/project-file.ts';
import {createProjectFile} from './connection.ts';
import type {ProjectLocation} from './connection.ts';
import {openProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';

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
  return store;
}
