import {lstatSync} from 'node:fs';
import {AppError} from '@mioon/contracts';
import {openAppLibrary} from './app-db/index.ts';
import type {AppLibrary} from './app-db/index.ts';
import {isAppLibraryHeld} from './app-db/connection.ts';
import {isProjectStore} from './project-file/store.ts';
import type {ProjectStore} from './project-file/store.ts';
import {testStoreApplicationDirectory, registerTestStoreCloseCompanion} from './project-file/test-store.ts';
import {createWorkspaceConfiguration} from './workspace-configuration.ts';
import {createAppCompanionDocuments} from './companion-scope.ts';
import type {ServiceApplicationPorts} from './services.ts';
import {bindAgentTaskRowValidation} from './agent/task-project-row-validation-v2.ts';

/** App-backed settings and an explicit S0 lifecycle boundary. This never
 * constructs the legacy workspace backup or activation machinery. */
export function createProjectServiceApplication(library: AppLibrary, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): ServiceApplicationPorts {
  const info = lstatSync(library.databaseFile, {bigint: true});
  const identity = {dev: String(info.dev), ino: String(info.ino)};
  const assertOwner = (): void => {
    signal?.throwIfAborted();
    if (!isAppLibraryHeld(identity, library.db)) throw new TypeError('Project services require a live application library owner');
  };
  assertOwner();
  const unavailable = (): never => {assertOwner(); throw new AppError('RESTORE_OPERATION_UNAVAILABLE', 'This project host does not yet support workspace backup or restoration.', 409);};
  return {
    outsidePaths: library.outsidePaths,
    configuration: createWorkspaceConfiguration({root: library.dataDir, documents: createAppCompanionDocuments(library), env}),
    backups: {
      getStatus: unavailable, list: unavailable, create: unavailable, stageRestore: unavailable,
      exportBundle: unavailable, importBundle: unavailable, importDirectory: unavailable,
      isBusy: () => false, assertMutationAllowed: assertOwner,
      start: assertOwner, stop() {}, tick: async () => {assertOwner();}, drain: async () => {},
    },
  };
}

const applications = new WeakMap<ProjectStore, {readonly library: AppLibrary}>();
const applicationOwners = new Map<string, {readonly library: AppLibrary; references: number}>();
/** Only explicit TEST openers populate this map. Fixture setup may borrow an
 * already-held TEST library; it cannot borrow a production server's library. */
export function heldTestApplicationLibrary(dataDir: string): AppLibrary | undefined {
  const owned = applicationOwners.get(dataDir);
  if (!owned) return undefined;
  if (!owned.library.db.isOpen) {applicationOwners.delete(dataDir); return undefined;}
  const identity = lstatSync(owned.library.databaseFile, {bigint: true});
  if (!isAppLibraryHeld({dev: String(identity.dev), ino: String(identity.ino)}, owned.library.db)) throw new TypeError('TEST application ownership changed');
  return owned.library;
}
/** Production-layout stores require the caller's app ports. Only the kernel's
 * exact test-store capability authorizes this one lazy, real B1 owner. */
export function testProjectAppLibrary(value: unknown): AppLibrary | undefined {
  if (!isProjectStore(value)) return undefined;
  const directory = testStoreApplicationDirectory(value);
  if (directory === null) return undefined;
  const existing = applications.get(value);
  if (existing) return existing.library;
  const shared = heldTestApplicationLibrary(directory);
  const library = shared ?? openAppLibrary({dataDir: directory});
  const owner = applicationOwners.get(directory) ?? {library, references: 0};
  let unbind: (() => void) | undefined;
  try {
    unbind = bindAgentTaskRowValidation(value, library);
    registerTestStoreCloseCompanion(value, () => {
      applications.delete(value); unbind!();
      if (--owner.references === 0) {applicationOwners.delete(directory); library.close();}
    });
    owner.references++;
    applicationOwners.set(directory, owner);
    applications.set(value, {library});
    return library;
  } catch (error) {unbind?.(); if (!shared) library.close(); throw error;}
}
export function testProjectServiceApplication(value: unknown, env: NodeJS.ProcessEnv = process.env): ServiceApplicationPorts | undefined {
  const library = testProjectAppLibrary(value);
  if (!library || !isProjectStore(value)) return undefined;
  // Only the database owner is shared. Per-service environment admission keeps
  // the old caller-specific live-generation gate; settings still share B1 data.
  return createProjectServiceApplication(library, undefined, env);
}
