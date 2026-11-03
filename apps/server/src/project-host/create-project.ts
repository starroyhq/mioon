import {rmSync, rmdirSync} from 'node:fs';
import path from 'node:path';
import {publicValue} from '../../../../packages/contracts/src/index.ts';
import type {RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import type {ProjectEntryCreateInput} from '../../../../packages/contracts/src/project-entry-native.ts';
import {openProjectStore} from '../../../../packages/business/src/project-file/index.ts';
import {projectLocation} from './directories.ts';
import type {AppDirectories} from './directories.ts';
import type {ProjectHostManager} from './manager.ts';
import type {ProjectFileIdentityPort, ProjectRegistryPort} from './ports.ts';
import {sameProjectFileIdentity} from './stand-ins.ts';
import {ensureProjectRow} from './project-initialization.ts';

/** One create path for the app RPC and trusted desktop control. Selecting a
 * location does not skip project-row initialization or ownership checks. */
export function createInitializedProject({manager, registry, directories, identity, assertProjectFile}: {
  readonly manager: ProjectHostManager;
  readonly registry: ProjectRegistryPort;
  readonly directories: AppDirectories;
  readonly identity: ProjectFileIdentityPort;
  readonly assertProjectFile: (file: string) => void;
}) {
  return async (input: ProjectEntryCreateInput): Promise<{readonly registration: RecentProject; readonly project: unknown}> => {
    // Reject private application targets before creating any folder or file.
    assertProjectFile(input.projectFile ?? path.join(input.parentDir ?? directories.projectsDir, 'project.mioon'));
    const entry = await manager.create({name: input.name,
      ...(input.parentDir === undefined ? {} : {parentDir: input.parentDir}),
      ...(input.projectFile === undefined ? {} : {projectFile: input.projectFile})});
    let initialized = false;
    try {
      assertProjectFile(entry.projectFile);
      const store = openProjectStore({projectFile: entry.projectFile,
        locate: id => projectLocation(directories, id), checkCopy: registry.checkCopy});
      try {
        ensureProjectRow(store, {name: input.name,
          ...(input.description === undefined ? {} : {description: input.description}),
          ...(input.timelinePresetId === undefined ? {} : {timelinePresetId: input.timelinePresetId})});
        initialized = true;
        // Creation by itself does not compose a runtime or count as an open.
        // The existing public RPC performs its request admission afterwards;
        // desktop control admits the eventual editor window separately.
        return {registration: entry, project: publicValue(store.get('projects', entry.projectId))};
      } finally {store.close();}
    } catch (error) {
      if (!initialized && manager.status(entry.projectId) === null) {
        // A replaced path belongs to somebody else. Never unlink it, and never
        // remove a caller-chosen existing parent when initialization fails.
        const registration = registry.get(entry.projectId);
        if (registration && sameProjectFileIdentity(registration.fileIdentity, entry.fileIdentity)) {
          registry.remove(entry.projectId);
          if (sameProjectFileIdentity(identity(entry.projectFile), entry.fileIdentity)) {
            rmSync(entry.projectFile, {force: true});
            if (input.projectFile === undefined) {
              try {rmdirSync(path.dirname(entry.projectFile));} catch { /* Only remove our empty claimed folder. */ }
            }
          }
        }
      }
      throw error;
    }
  };
}
