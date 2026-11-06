import type {ProjectEntriesResponse} from '../../../packages/contracts/src/project-entry.ts';
import type {ProjectHomeProject} from './ProjectHome.tsx';

/** Membership does not require a cached summary. Missing metadata remains
 * unknown; the full directory remains authoritative for paths and status. */
export function projectDirectoryProjects(directory: ProjectEntriesResponse): readonly ProjectHomeProject[] {
  return directory.registered.map(({project}) => ({
    id: project.projectId, name: project.name, updatedAt: project.summary?.updatedAt ?? '',
    ...(project.summary ? {description: project.summary.description, revision: project.summary.revision, createdAt: project.summary.createdAt} : {}),
  }));
}
