import {lstatSync} from 'node:fs';
import {AppError} from '@mioon/contracts';
import {openAppLibrary} from './app-db/index.ts';
import type {AppLibrary} from './app-db/index.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {testStoreApplicationDirectory, registerTestStoreCloseCompanion} from './project-file/test-store.ts';
import {createWorkspaceConfiguration} from './workspace-configuration.ts';
import type {ServiceApplicationPorts} from './services.ts';

/** App-backed settings and an explicit S0 lifecycle boundary. This never
 * constructs the legacy workspace backup or activation machinery. */
export function createProjectServiceApplication(library: AppLibrary, signal?: AbortSignal): ServiceApplicationPorts {
  const info = lstatSync(library.databaseFile, {bigint: true});
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  const assertOwner = (): void => {
    signal?.throwIfAborted();
    if (!isAppLibraryHeld(identity, library.db)) throw new TypeError('Project services require a live application library owner');
  };
  assertOwner();
  const unavailable = (): never => {assertOwner(); throw new AppError('RESTORE_OPERATION_UNAVAILABLE', 'This project host does not yet support workspace backup or restoration.', 409);};
  return {
    configuration: createWorkspaceConfiguration({root: library.dataDir, documents: library.documents}),
    backups: {
      getStatus: unavailable, list: unavailable, create: unavailable, stageRestore: unavailable,
      exportBundle: unavailable, importBundle: unavailable, importDirectory: unavailable,
      isBusy: () => false, assertMutationAllowed: assertOwner,
      start: assertOwner, stop() {}, tick: async () => {assertOwner();}, drain: async () => {},
    },
  };
}

const applications = new WeakMap<ProjectStore, {readonly library: AppLibrary; application?: ServiceApplicationPorts}>();
/** Production-layout stores require the caller's app ports. Only the kernel's
 * exact test-store capability authorizes this one lazy, real B1 owner. */
export function testProjectAppLibrary(value: unknown): AppLibrary | undefined {
  if (!isProjectStore(value)) return undefined;
  const directory = testStoreApplicationDirectory(value);
  if (directory === null) return undefined;
  const existing = applications.get(value);
  if (existing) return existing.library;
  const library = openAppLibrary({dataDir: directory});
  try {
    registerTestStoreCloseCompanion(value, () => {applications.delete(value); library.close();});
    applications.set(value, {library});
    return library;
  } catch (error) {library.close(); throw error;}
}
export function testProjectServiceApplication(value: unknown): ServiceApplicationPorts | undefined {
  const library = testProjectAppLibrary(value);
  if (!library || !isProjectStore(value)) return undefined;
  const held = applications.get(value)!;
  return held.application ??= createProjectServiceApplication(library);
}
