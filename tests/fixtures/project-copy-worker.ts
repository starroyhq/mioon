import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {serverAppDirectories} from '../../apps/server/src/project-host/directories.ts';
import {createProjectHostManager} from '../../apps/server/src/project-host/manager.ts';
import {createProjectCopies} from '../../apps/server/src/project-host/copies.ts';
import {createApplicationFileGuard} from '../../apps/server/src/project-host/application-storage.ts';
import type {ProjectCopyInput} from '../../packages/contracts/src/project-copies.ts';
const value = JSON.parse(process.argv[2]) as {root: string; input: ProjectCopyInput; point: string};
const directories = serverAppDirectories(value.root), library = openAppLibrary({dataDir: value.root});
const manager = createProjectHostManager({directories, registry: library.registry, identity: library.projectFileIdentity,
  factory: async () => ({handle: async () => false, isBusy: () => false, interrupt() {}, drain: async () => {}, dispose() {}})});
const copies = createProjectCopies({manager, library, directories, signal: new AbortController().signal,
  assertProjectFile: createApplicationFileGuard(directories), onBoundary: phase => {if (phase === value.point) process.kill(process.pid, 'SIGKILL');}});
await copies.duplicate(value.input);
throw Error('Crash boundary was not reached');
