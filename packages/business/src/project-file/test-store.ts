import {lstatSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {ensurePrivateDirectory} from '@mioon/contracts/private-storage';
import {TEST_STORE_LAYOUT} from '../../../contracts/src/project-file.ts';
import {createProjectFile} from './connection.ts';
import type {OpenProjectConnectionOptions, ProjectLocation} from './connection.ts';
import {isProjectStore, openProjectStore} from './store.ts';
import type {ProjectStore} from './store.ts';
import {registerProjectMediaStore} from '../project-media-storage.ts';
import {referenceTestAsset} from './test-asset-fixture.ts';

const testStores = new WeakMap<ProjectStore, {readonly applicationDir: string; readonly closeCompanions: Set<() => void>}>();
const testConnections = new WeakMap<DatabaseSync, ProjectStore>();
/** Trusted fixture metadata lookup. It returns the exact live TEST owner,
 * never a copied capability or an independently opened connection. */
export function testStoreForConnection(db: unknown, root: string): ProjectStore | null {
  if (db === null || typeof db !== 'object') return null;
  const store = testConnections.get(db as DatabaseSync);
  return store && isProjectStore(store) && store.db === db && store.root === root && testStores.has(store) ? store : null;
}
/** Only the explicit test openers grant an application scope. Matching public
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
  // Validate every ancestor before creating a project file. The portable
  // project folder may be 0755; its TEST companions must remain private.
  ensurePrivateDirectory(path.join(root, '.mioon-store'), {create: true});
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
    ensurePrivateDirectory(media, {create: true});
  } catch (error) {
    store.close();
    throw error;
  }
  return ownTestStore(store, path.join(root, '.mioon-store', 'app'));
}

/** Trusted server-layout fixture opener. The caller passes its real app
 * registration/copy check and locations, so seeds and services use the same
 * project and B1 files the subsequent server opens. Production hosts call
 * openProjectStore directly and never gain this TEST application fallback. */
export function openServerTestStore(options: OpenProjectConnectionOptions, applicationDir: string): ProjectStore {
  if (!path.isAbsolute(applicationDir)) throw new TypeError('A test application directory must be absolute');
  return ownTestStore(openProjectStore(options), path.resolve(applicationDir));
}

function ownTestStore(store: ProjectStore, applicationDir: string): ProjectStore {
  const put = store.put;
  store.put = <T extends object>(table: string, value: T): T => {
    if (table !== 'assets') return put(table, value);
    const fixture = value as Readonly<Record<string, unknown>>;
    if (fixture.reference !== undefined || typeof fixture.relativePath !== 'string') return put(table, value);
    const converted = referenceTestAsset(store.projectDir, fixture);
    put(table, converted);
    // The fixture's old location remains available to test assertions only;
    // persisted records have reference as their single location source.
    return {...converted, ...('relativePath' in fixture ? {relativePath: fixture.relativePath} : {})} as T;
  };
  const held = {applicationDir, closeCompanions: new Set<() => void>()};
  held.closeCompanions.add(registerProjectMediaStore(store));
  testStores.set(store, held);
  testConnections.set(store.db, store);
  const close = store.close;
  store.close = (): void => {
    const failures: unknown[] = [];
    try {close();} catch (error) {failures.push(error);}
    if (!store.db.isOpen) {
      testStores.delete(store);
      if (testConnections.get(store.db) === store) testConnections.delete(store.db);
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
