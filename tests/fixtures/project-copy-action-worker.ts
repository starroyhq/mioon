import {openAppLibrary} from '../../packages/business/src/app-db/index.ts';
import {serverAppDirectories} from '../../apps/server/src/project-host/directories.ts';
import {createProjectHostManager} from '../../apps/server/src/project-host/manager.ts';
import {createProjectCopies} from '../../apps/server/src/project-host/copies.ts';
import {createApplicationFileGuard} from '../../apps/server/src/project-host/application-storage.ts';
import type {ProjectAdoptCopyInput} from '../../packages/contracts/src/project-copies.ts';

const value=JSON.parse(process.argv[2]) as {root:string;input:ProjectAdoptCopyInput;point:'ready'|'project-published'};
const directories=serverAppDirectories(value.root),library=openAppLibrary({dataDir:value.root});
const manager=createProjectHostManager({directories,registry:library.registry,identity:library.projectFileIdentity,
 factory:async()=>({handle:async()=>false,isBusy:()=>false,interrupt(){},drain:async()=>{},dispose(){}})});
const copies=createProjectCopies({manager,library,directories,signal:new AbortController().signal,
 assertProjectFile:createApplicationFileGuard(directories),onActionBoundary:phase=>{if(phase===value.point)process.kill(process.pid,'SIGKILL');}});
await copies.adoptCopy(value.input);
throw Error('Adoption crash boundary was not reached');
