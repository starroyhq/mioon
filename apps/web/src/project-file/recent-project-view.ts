import type { BackgroundTaskQueryResponse } from '../../../../packages/contracts/src/background-task-query.ts';
import type { ProjectEntry } from '../../../../packages/contracts/src/project-entry.ts';

export type RecentProjectsSort = 'recent' | 'updated' | 'name';
export type WaitingProjectReason = 'missing' | 'missing-volume' | 'read-only' | 'locked' | 'access-denied' | 'unavailable';
/** Unfinished generation tasks waiting for their unavailable project. These
 * counts never describe staged results or grant permission to discard tasks. */
export interface WaitingProject {
  readonly projectId: string;
  readonly projectName: string;
  readonly taskCount: number;
  readonly reason: WaitingProjectReason;
  readonly volumeName?: string;
  readonly lastOpenedAt: string | null;
}

const recent = (left: {lastOpenedAt: string | null}, right: {lastOpenedAt: string | null}): number =>
  (right.lastOpenedAt ?? '').localeCompare(left.lastOpenedAt ?? '');

/** Only join against the current authoritative directory. In the browser that
 * directory already excludes registrations outside the configured root. */
export function waitingProjects(entries: readonly ProjectEntry[], tasks: readonly BackgroundTaskQueryResponse['projects'][number][]): WaitingProject[] {
  const directory = new Map(entries.map(entry => [entry.project.projectId, entry.project]));
  return tasks.flatMap(task => {
    const project = directory.get(task.projectId);
    if (!project) return [];
    const codes = new Set(task.reasonCodes), volume = /^\/Volumes\/([^/]+)\//u.exec(project.projectFile);
    const missing = codes.has('PROJECT_MISSING') || codes.has('PROJECT_FILE_MOVED');
    const reason: WaitingProjectReason = missing ? volume ? 'missing-volume' : 'missing'
      : codes.has('PROJECT_READ_ONLY') || codes.has('PROJECT_READONLY') ? 'read-only'
        : codes.has('PROJECT_LOCKED') ? 'locked'
          : codes.has('PROJECT_ACCESS_DENIED') ? 'access-denied' : 'unavailable';
    return [{projectId: project.projectId, projectName: project.name, taskCount: task.taskCount, reason,
      ...(reason === 'missing-volume' ? {volumeName: volume![1]!} : {}), lastOpenedAt: project.lastOpenedAt}];
  }).sort((left, right) => recent(left, right) || left.projectId.localeCompare(right.projectId));
}

/** Sorting never invents a last-opened time for a project with no successful
 * open. Stable IDs settle equal names and timestamps in every locale. */
export function orderedRecentProjects<T extends ProjectEntry>(entries: readonly T[], query: string, sort: RecentProjectsSort, locale: string): T[] {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase(locale);
  const names = new Intl.Collator(locale, {numeric: true, sensitivity: 'base'});
  return entries.filter(entry => !needle || entry.project.name.normalize('NFKC').toLocaleLowerCase(locale).includes(needle)).slice().sort((left, right) => {
    const primary = sort === 'name' ? names.compare(left.project.name, right.project.name)
      : sort === 'updated' ? (right.project.summary?.updatedAt ?? '').localeCompare(left.project.summary?.updatedAt ?? '')
        : recent(left.project, right.project);
    return primary || names.compare(left.project.name, right.project.name) || left.project.projectId.localeCompare(right.project.projectId);
  });
}

export function visibleWaitingProjects(entries: readonly WaitingProject[], expanded: boolean): {shown: readonly WaitingProject[]; remaining: number} {
  const shown = !expanded && entries.length > 3 ? entries.slice(0, 2) : entries;
  return {shown, remaining: entries.length - shown.length};
}
