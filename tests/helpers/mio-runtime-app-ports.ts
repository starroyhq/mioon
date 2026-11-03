import path from 'node:path';
import {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';
import {isAppLibraryHeld, openAppLibrary, projectFileIdentity} from '../../packages/business/src/app-db/index.ts';
import {createAgentAuthorizations} from '../../packages/business/src/agent/authorizations.ts';
import type {AgentSettingsService} from '../../packages/business/src/agent/settings.ts';
import type {WorkspaceStore} from '../../packages/business/src/db.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createWorkspaceConfiguration} from '../../packages/business/src/workspace-configuration.ts';

/** Project fixtures use the actual application library identity for grants and
 * application documents. No always-allow authorizer or project-file scope is
 * substituted for S0's composition boundary. */
export function createMioTestAppPorts(store: WorkspaceStore) {
  const library = openAppLibrary({dataDir: path.join(store.root, 'app')});
  const configuration = createWorkspaceConfiguration({root: library.dataDir, documents: library.documents});
  const unused = (): never => {throw new Error('Mio runtime scenarios must not invoke application backups');};
  try {
    const services = createServices(store, new Map(), {application: {configuration,outsidePaths:library.outsidePaths, backups: {
      getStatus: unused, list: unused, create: unused, stageRestore: unused, exportBundle: unused, importBundle: unused, importDirectory: unused,
      isBusy: () => false, assertMutationAllowed() {}, start() {}, stop() {}, drain: async () => {}, tick: async () => {},
    }}});
    return {
      services,
      createAuthorizations(settings: AgentSettingsService) {
        return createAgentAuthorizations({root: library.dataDir, databaseFile: library.databaseFile,
          storage: {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile},
          guards: {ownsLock: () => {const identity = projectFileIdentity(library.databaseFile); return identity !== null && isAppLibraryHeld(identity);}, isRestored: () => false},
          readCurrentTarget: async () => {const current = await settings.get(); return {destination: deriveAgentEndpoint(current.configuration), model: current.configuration.model, settingsRevision: current.revision};},
        });
      },
      close() {library.close();},
    };
  } catch (error) {library.close(); throw error;}
}
