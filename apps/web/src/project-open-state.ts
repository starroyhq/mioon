const projectIdPattern = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/iu;

export type ProjectOpenAttempt = {
  readonly projectId: string;
  readonly epoch: number;
  readonly workspaceScope: string;
};

export type ProjectOpenObservation = {
  readonly active: boolean;
  readonly currentProjectId: string | null;
  readonly epoch: number;
  readonly workspaceScope: string;
  readonly preferencesReady: boolean;
  readonly dataProjectId: string | null;
  readonly loading: boolean;
};

const validProjectId = (value: unknown): value is string => typeof value === 'string' && projectIdPattern.test(value);
const validEpoch = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const validScope = (value: string): boolean => typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Checks only the response identity. Existing workspace/DTO validation remains
 * responsible for validating the project's contents before they are published. */
export function projectResponseMatches(value: unknown, expectedProjectId: string): boolean {
  return validProjectId(expectedProjectId) && record(value) && record(value.project) &&
    validProjectId(value.project.id) && value.project.id === expectedProjectId;
}

/** Identifies an explicit foreign restore origin only. Missing or malformed
 * response structure remains the existing workspace validator's responsibility. */
export function hasProjectResponseOriginMismatch(value: unknown, expectedOrigin: string): boolean {
  return validProjectId(expectedOrigin) && record(value) && record(value.restore) &&
    typeof value.restore.workspaceOrigin === 'string' && value.restore.workspaceOrigin !== expectedOrigin;
}

/** Routes existing failure codes without changing their recovery or authority. */
export function projectOpenFailureKind(error: unknown): 'auth' | 'identity' | 'project' {
  if (!record(error)) return 'project';
  switch (error.code) {
    case 'UNAUTHORIZED': return 'auth';
    case 'WORKSPACE_ORIGIN_UNVERIFIED':
    case 'RESTORE_WORKSPACE_ORIGIN_MISMATCH':
    case 'LAST_PROJECT_SCOPE_MISMATCH':
    case 'LAST_PROJECT_STALE_INSTANCE': return 'identity';
    default: return 'project';
  }
}

/** Captures presentation identity only; this ticket grants no operation authority. */
export function projectOpenAttempt(projectId: string, epoch: number, workspaceScope: string): ProjectOpenAttempt {
  if (!validProjectId(projectId)) throw new TypeError('Project open requires a valid project UUID.');
  if (!validEpoch(epoch)) throw new RangeError('Project open requires a nonnegative safe-integer epoch.');
  if (!validScope(workspaceScope)) throw new TypeError('Project open requires a workspace scope.');
  return Object.freeze({ projectId, epoch, workspaceScope });
}

/** A selected ID and loaded preferences alone cannot reveal the workbench.
 * Callers supply dataProjectId only from the validated project response. */
export function canPublishProjectOpen(attempt: ProjectOpenAttempt | null, observed: ProjectOpenObservation): boolean {
  return attempt !== null && typeof attempt === 'object' &&
    validProjectId(attempt.projectId) && validEpoch(attempt.epoch) && validScope(attempt.workspaceScope) &&
    observed.active === true && observed.preferencesReady === true && observed.loading === false &&
    observed.currentProjectId === attempt.projectId && observed.dataProjectId === attempt.projectId &&
    observed.epoch === attempt.epoch && observed.workspaceScope === attempt.workspaceScope;
}
