import path from 'node:path';
import {isProjectId} from '../../../contracts/src/project-file.ts';
import {recentProjectSchema} from '../../../contracts/src/project-registry.ts';
import type {ProjectFileIdentity, RecentProject} from '../../../contracts/src/project-registry.ts';
import {UI_PREFERENCES_LIMITS} from '../../../contracts/src/ui-preferences.ts';
import type {AppDatabase} from './connection.ts';
import {appLibraryError, projectFileCopyError} from './errors.ts';
import {findMovedProjectFile, sameProjectFileIdentity} from './identity.ts';
import type {FindMovedOptions} from './identity.ts';

/** Registered projects at most, as many as ui-preferences kept opened-at times for. */
export const MAX_RECENT_PROJECTS = UI_PREFERENCES_LIMITS.recentProjects;

/** A project file being opened, as the kernel's copy check receives it. */
export interface ProjectFileCandidate {
  readonly projectId: string;
  readonly projectFile: string;
}

/** The recent-project registry: the project host's ProjectRegistryPort, plus
 * `copyOf` for the open flow. A plain object of closures, so callers may
 * spread and wrap it. Synchronous except findMoved. */
export interface AppProjectRegistry {
  /** In the order the projects were first registered. */
  list(): RecentProject[];
  get(projectId: string): RecentProject | null;
  /** Validates with recentProjectSchema; replaces the entry of this project ID
   * and keeps its place in the order. */
  upsert(entry: RecentProject): void;
  remove(projectId: string): void;
  /** Where the entry's file is now, by its file identity (findMovedProjectFile);
   * null when not found. */
  findMoved(entry: RecentProject): Promise<string | null>;
  /** The kernel's checkCopy hook: throws PROJECT_FILE_COPY when copyOf finds
   * the registered original. */
  checkCopy(file: ProjectFileCandidate): void;
  /** The registered location of the original when `file` is a copy of a
   * registered project, otherwise null. */
  copyOf(file: ProjectFileCandidate): string | null;
}

export interface ProjectRegistryOptions {
  readonly identity: (projectFile: string) => ProjectFileIdentity | null;
  readonly findMoved?: Omit<FindMovedOptions, 'path'>;
}

const parse = (data: unknown): RecentProject => recentProjectSchema.parse(JSON.parse(String(data)));

/** The file at an entry's registered path, when it can still be the entry's
 * project file: a regular file that no other registration claims by path and
 * file identity (another project created where this one used to be). Null when
 * the registered place holds nothing of this project. Only lstat. */
export function fileAtRegisteredPlace(
  entry: RecentProject, identity: ProjectRegistryOptions['identity'], claimedElsewhere: (found: ProjectFileIdentity) => boolean,
): ProjectFileIdentity | null {
  let found: ProjectFileIdentity | null;
  try {
    found = identity(entry.projectFile);
  } catch {
    found = null;
  }
  if (found === null || sameProjectFileIdentity(found, entry.fileIdentity)) return found;
  return claimedElsewhere(found) ? null : found;
}

export function createProjectRegistry(database: AppDatabase, {identity, findMoved: search = {}}: ProjectRegistryOptions): AppProjectRegistry {
  const get = (projectId: string): RecentProject | null => {
    if (!isProjectId(projectId)) return null;
    const row = database.statement('SELECT data FROM recent_projects WHERE projectId=?').get(projectId);
    return row ? parse(row.data) : null;
  };
  const list = (): RecentProject[] =>
    database.statement('SELECT data FROM recent_projects ORDER BY position').all().map(row => parse(row.data));
  const upsert = (entry: RecentProject): void => {
    const parsed = recentProjectSchema.parse(entry);
    database.atomically(() => {
      const known = database.statement('SELECT 1 FROM recent_projects WHERE projectId=?').get(parsed.projectId) !== undefined;
      if (!known && Number(database.statement('SELECT count(*) AS n FROM recent_projects').get()?.n) >= MAX_RECENT_PROJECTS) {
        throw appLibraryError('APP_LIBRARY_LIMIT', {limit: MAX_RECENT_PROJECTS});
      }
      database.statement('INSERT INTO recent_projects(projectId,data) VALUES(?,?) ON CONFLICT(projectId) DO UPDATE SET data=excluded.data')
        .run(parsed.projectId, JSON.stringify(parsed));
    });
  };
  const remove = (projectId: string): void => {
    if (isProjectId(projectId)) database.statement('DELETE FROM recent_projects WHERE projectId=?').run(projectId);
  };
  /** Another registration has this path and this file identity. */
  const claimedElsewhere = (projectId: string, projectFile: string) => (found: ProjectFileIdentity): boolean =>
    database.statement("SELECT data FROM recent_projects WHERE projectId<>? AND json_extract(data,'$.projectFile')=?").all(projectId, projectFile)
      .some(row => sameProjectFileIdentity(parse(row.data).fileIdentity, found));
  const identityOrNull = (file: string): ProjectFileIdentity | null => {
    try {
      return identity(file);
    } catch {
      return null;
    }
  };

  // Plan 5.2. Two lstat calls and no search: checkCopy runs synchronously in
  // every open, and a directory listing on an unreachable network volume could
  // stall the whole backend. A copy is a file that is not the registered file
  // while the registered file is still at its registered place.
  const copyOf = ({projectId, projectFile}: ProjectFileCandidate): string | null => {
    const registered = get(projectId);
    if (!registered) return null;
    const candidate = path.resolve(projectFile);
    if (candidate === registered.projectFile) return null;
    const candidateIdentity = identityOrNull(candidate);
    // The registered file itself, moved or reached through a hard link.
    if (sameProjectFileIdentity(candidateIdentity, registered.fileIdentity)) return null;
    const original = fileAtRegisteredPlace(registered, identity, claimedElsewhere(projectId, registered.projectFile));
    // The registered file left its place: this one is taken as the moved project.
    if (original === null) return null;
    // The file at the registered place is this one, under another spelling of its path.
    if (sameProjectFileIdentity(original, candidateIdentity)) return null;
    return registered.projectFile;
  };
  const checkCopy = (file: ProjectFileCandidate): void => {
    if (copyOf(file) !== null) throw projectFileCopyError(file.projectId);
  };
  const findMoved = async (entry: RecentProject): Promise<string | null> => {
    const {projectFile, fileIdentity} = recentProjectSchema.parse(entry);
    return findMovedProjectFile({projectFile, fileIdentity}, search);
  };
  return {list, get, upsert, remove, findMoved, checkCopy, copyOf};
}
