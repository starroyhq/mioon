/** SIGKILL boundary worker; never imported by production. */
import {readFileSync} from 'node:fs';
import {createProjectHostManager} from '../../apps/server/src/project-host/manager.ts';
import {createMemoryProjectRegistry} from '../../apps/server/src/project-host/stand-ins.ts';
import {serverAppDirectories} from '../../apps/server/src/project-host/directories.ts';
import type {RecentProject} from '../../packages/contracts/src/project-registry.ts';
import type {ProjectHistoryResolveInput} from '../../packages/contracts/src/project-history-recovery.ts';
const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as {root: string; registration: RecentProject; input: ProjectHistoryResolveInput; boundary: string};
const manager = createProjectHostManager({directories: serverAppDirectories(config.root), registry: createMemoryProjectRegistry({entries: [config.registration]}),
  assertMutationAllowed() {}, factory: async () => {throw new Error('A diverged history cannot start the normal factory');},
  historySwitchBoundary: boundary => {if (boundary === config.boundary) process.kill(process.pid, 'SIGKILL');}});
try {await manager.resolveHistory(config.input); throw new Error('The requested fault boundary was never reached');}
finally {await manager.closeAll();}
