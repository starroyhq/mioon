import path from 'node:path';
import {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile} from '@mioon/contracts/private-storage';
import {deriveAgentEndpoint} from '../../packages/contracts/src/agent-protocol.ts';
import {isAppLibraryHeld, openAppLibrary, projectFileIdentity} from '../../packages/business/src/app-db/index.ts';
import {createAgentAuthorizations} from '../../packages/business/src/agent/authorizations.ts';
import type {AgentSettingsService} from '../../packages/business/src/agent/settings.ts';
import type { Store as WorkspaceStore } from '../../packages/business/src/store-contract.ts';
import {createServices} from '../../packages/business/src/services.ts';
import {createProjectServiceApplication} from '../../packages/business/src/project-service-application.ts';

/** Project fixtures use the actual application library identity for grants and
 * application documents. No always-allow authorizer or project-file scope is
 * substituted for S0's composition boundary. */
export function createMioTestAppPorts(store: WorkspaceStore) {
  const library = openAppLibrary({dataDir: path.join(store.root, 'app')});
  try {
    const services = createServices(store, new Map(), {application: createProjectServiceApplication(library)});
    return {
      services,
      createAuthorizations(settings: AgentSettingsService) {
        return createAgentAuthorizations({root: library.dataDir, databaseFile: library.databaseFile,
          storage: {readPrivateFile, writePrivateFileAtomic, validatePrivateDirectory, validateManagedFile},
          guards: {ownsLock: () => {const identity = projectFileIdentity(library.databaseFile); return identity !== null && isAppLibraryHeld(identity);}},
          readCurrentTarget: async () => {const current = await settings.get(); return {destination: deriveAgentEndpoint(current.configuration), model: current.configuration.model, settingsRevision: current.revision};},
        });
      },
      close() {library.close();},
    };
  } catch (error) {library.close(); throw error;}
}
