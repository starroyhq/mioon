/** Project host (docs/PROJECT-HOST.md): one host per open project, managed per
 * app. types.ts, naming.ts and errors.ts import no Node module; the web app
 * imports those files directly, not this index. */
export {
  DEFAULT_BUSY_RECHECK_MS, DEFAULT_IDLE_CLOSE_MS, DEFAULT_REQUEST_DRAIN_MS, PROJECT_CLOSE_REASONS, PROJECT_HOST_STATES, PROJECT_LEASE_KINDS,
} from './types.ts';
export type {ProjectAvailability, ProjectCloseReason, ProjectHostEvent, ProjectHostState, ProjectHostStatus, ProjectLeaseKind} from './types.ts';
export {
  numberedProjectFolderName, PROJECT_FOLDER_FALLBACK_NAME, PROJECT_FOLDER_MAX_SEQUENCE, PROJECT_FOLDER_NAME_MAX_BYTES, projectFolderName,
} from './naming.ts';
export {
  asProjectUnavailable, isDatabaseMovedError, PROJECT_ADDRESS_ERROR_STATUS, PROJECT_HOST_ERROR_CODES, PROJECT_HOST_ERROR_STATUS, projectFileExists,
  projectHostError, projectIdMismatch, projectNotFound, projectUnavailable, SQLITE_READONLY_DBMOVED,
} from './errors.ts';
export type {ProjectHostErrorCode} from './errors.ts';
export {claimProjectFolder} from './folders.ts';
export type {ClaimedProjectFolder} from './folders.ts';
export {desktopAppDirectories, PROJECT_TEMP_DIRECTORY, projectLocation, serverAppDirectories, systemCacheDirectory} from './directories.ts';
export type {AppDirectories, DesktopDirectoriesInput, SystemCacheInput} from './directories.ts';
export type {
  InspectProject, ProjectHost, ProjectHostContext, ProjectHostFactory, ProjectHostRuntime, ProjectHostSummary, ProjectLease, ProjectRequest,
  UnfinishedTask,
} from './host.ts';
export type {
  AgentPolicyStorePort, AppLibraryPort, BackgroundTaskIndexPort, KernelMaintenancePort, MioAppServices, MioRuntimeFactory, MioRuntimePort,
  ProjectDraftsFactory, ProjectDraftsPort, ProjectFileIdentityPort, ProjectFileRecovery, ProjectInboxPort, ProjectLifecycleHooks, ProjectRegistryPort,
} from './ports.ts';
export {
  createMemoryAgentPolicyStore, createMemoryBackgroundTaskIndex, createMemoryProjectInbox, createMemoryProjectRegistry, DEFAULT_FIND_MOVED_LIMIT,
  sameProjectFileIdentity, STAT_ONLY_MAINTENANCE, statProjectFileIdentity,
} from './stand-ins.ts';
export type {MemoryProjectRegistryOptions} from './stand-ins.ts';
export {createProjectFiles, createProjectHostManager, SYSTEM_CLOCK} from './manager.ts';
export type {
  CreateProjectInput, CreateProjectPorts, ListedProject, ManagerClock, ProjectHostManager, ProjectHostManagerOptions, RestoreResult,
} from './manager.ts';
