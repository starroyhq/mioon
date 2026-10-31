/** What S0 uses until B1 and S3 land (docs/PROJECT-HOST.md, "需要别的卡提供的端口").
 * Project files, history.db and cache.db are only lstat'ed here, never opened:
 * closing any descriptor of a file this process has open drops its locks. */
import {lstatSync, readdirSync} from 'node:fs';
import type {BigIntStats, Dirent} from 'node:fs';
import path from 'node:path';
import {PROJECT_FILE_EXTENSION} from '../../../../packages/contracts/src/project-file.ts';
import {backgroundTaskIndexEntrySchema, projectInboxItemSchema, recentProjectSchema} from '../../../../packages/contracts/src/project-registry.ts';
import type {BackgroundTaskIndexEntry, ProjectFileIdentity, ProjectInboxItem, RecentProject} from '../../../../packages/contracts/src/project-registry.ts';
import type {AgentTaskPolicy} from '../../../../packages/contracts/src/agent-tasks-v2.ts';
import type {AgentPolicyStorePort, BackgroundTaskIndexPort, ProjectFileIdentityPort, ProjectInboxPort, ProjectRegistryPort} from './ports.ts';

/** POSIX dev and ino from a bigint lstat; never opens the file, so it is safe
 * while the project is open. Null when the path is not a regular file. B1
 * replaces it and verifies full file IDs on Windows. */
export function statProjectFileIdentity(projectFile: string): ProjectFileIdentity | null {
  let info: BigIntStats | undefined;
  try {
    info = lstatSync(projectFile, {bigint: true, throwIfNoEntry: false});
  } catch (error) {
    if ((error as {code?: unknown} | null | undefined)?.code === 'ENOTDIR') return null;
    throw error;
  }
  return info?.isFile() ? {dev: String(info.dev), ino: String(info.ino)} : null;
}

export function sameProjectFileIdentity(a: ProjectFileIdentity | null | undefined, b: ProjectFileIdentity | null | undefined): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

/** Entries findMoved looks at, in total. */
export const DEFAULT_FIND_MOVED_LIMIT = 2_000;
const PROJECT_JOURNAL_SUFFIX = `${PROJECT_FILE_EXTENSION}-journal`;

export interface MemoryProjectRegistryOptions {
  readonly entries?: readonly RecentProject[];
  readonly identity?: ProjectFileIdentityPort;
  readonly searchLimit?: number;
}

/** Searches the old project folder and its parent, two levels down each, for
 * a `.mioon` with the entry's file identity. Like all production listings of
 * project directories it skips names starting with `.` and `*.mioon-journal`
 * (SQLite's journal, present while a project is open); it only reads
 * directories and lstats candidates, never touching a file. Unreadable
 * directories are skipped. */
function findByIdentity(entry: RecentProject, identity: ProjectFileIdentityPort, limit: number): string | null {
  const folder = path.dirname(entry.projectFile);
  const visited = new Set<string>();
  let seen = 0;
  for (const root of [folder, path.dirname(folder)]) {
    let level = [root];
    for (let depth = 0; depth < 2 && level.length > 0; depth++) {
      const next: string[] = [];
      for (const directory of level) {
        if (visited.has(directory)) continue;
        visited.add(directory);
        let children: Dirent[];
        try {
          children = readdirSync(directory, {withFileTypes: true});
        } catch {
          continue;
        }
        for (const child of children) {
          if (++seen > limit) return null;
          if (child.name.startsWith('.') || child.name.endsWith(PROJECT_JOURNAL_SUFFIX)) continue;
          const candidate = path.join(directory, child.name);
          if (child.isDirectory()) {
            next.push(candidate);
          } else if (child.isFile() && child.name.endsWith(PROJECT_FILE_EXTENSION)) {
            let found: ProjectFileIdentity | null;
            try { found = identity(candidate); } catch { found = null; }
            if (sameProjectFileIdentity(found, entry.fileIdentity)) return candidate;
          }
        }
      }
      level = next;
    }
  }
  return null;
}

/** B1's registry, in memory: insertion order, entries checked with recentProjectSchema. */
export function createMemoryProjectRegistry({entries = [], identity = statProjectFileIdentity, searchLimit = DEFAULT_FIND_MOVED_LIMIT}: MemoryProjectRegistryOptions = {}): ProjectRegistryPort {
  const records = new Map<string, RecentProject>();
  const upsert = (entry: RecentProject): void => {
    const parsed = recentProjectSchema.parse(entry);
    records.set(parsed.projectId, parsed);
  };
  for (const entry of entries) upsert(entry);
  return {
    list: () => [...records.values()],
    get: projectId => records.get(projectId) ?? null,
    upsert,
    remove: projectId => { records.delete(projectId); },
    findMoved: async entry => findByIdentity(entry, identity, searchLimit),
  };
}

/** S3's task index, in memory. */
export function createMemoryBackgroundTaskIndex(entries: readonly BackgroundTaskIndexEntry[] = []): BackgroundTaskIndexPort {
  let current = entries.map(entry => backgroundTaskIndexEntrySchema.parse(entry));
  return {
    list: () => [...current],
    replace: (projectId, next) => {
      const parsed = next.map(entry => backgroundTaskIndexEntrySchema.parse(entry));
      if (parsed.some(entry => entry.projectId !== projectId)) throw new TypeError('Task index entries must belong to the project');
      current = [...current.filter(entry => entry.projectId !== projectId), ...parsed];
    },
  };
}

/** S3's inbox, in memory. */
export function createMemoryProjectInbox(items: readonly ProjectInboxItem[] = []): ProjectInboxPort {
  let current = items.map(item => projectInboxItemSchema.parse(item));
  return {
    add: item => { current = [...current, projectInboxItemSchema.parse(item)]; },
    list: projectId => current.filter(item => item.projectId === projectId),
    remove: (projectId, itemId) => { current = current.filter(item => item.projectId !== projectId || item.id !== itemId); },
  };
}

/** B1's global policy tables, in memory. */
export function createMemoryAgentPolicyStore(initial: AgentTaskPolicy | null = null): AgentPolicyStorePort {
  let policy = initial;
  const requests = new Map<string, {readonly digest: string; readonly policy: AgentTaskPolicy}>();
  return {
    read: () => policy,
    readRequest: requestId => requests.get(requestId) ?? null,
    write: (next, request) => {
      policy = next;
      if (request) requests.set(request.requestId, {digest: request.digest, policy: next});
    },
  };
}
