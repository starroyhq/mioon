import type {ProjectEntryOpenFailure} from '../../../../packages/contracts/src/project-entry-open-failure.ts';

/** Presentation issues built only after the owner validates the corresponding
 * backend failure or trusted location facts. These are not transport schemas. */
interface ProjectOpenIssueLocation {
  readonly projectFile: string | null;
  readonly projectId: string | null;
}
export type ProjectOpenIssue = (ProjectOpenIssueLocation & Exclude<ProjectEntryOpenFailure, {code: 'PROJECT_ACCESS_DENIED'}>)
  | (ProjectOpenIssueLocation & {readonly code: 'PROJECT_FILE_COPY'; readonly originalProjectFile: string | null; readonly originalProjectId: string | null})
  | (ProjectOpenIssueLocation & {readonly code: 'PROJECT_FILE_MOVED'; readonly reason: 'missing' | 'access-denied' | 'disk-disconnected'; readonly writeRejected: true})
  | (ProjectOpenIssueLocation & {readonly code: 'PROJECT_ACCESS_DENIED'; readonly context?: 'open' | 'create'})
  | (ProjectOpenIssueLocation & {readonly code: 'NETWORK_LOCATION'})
  | (ProjectOpenIssueLocation & {readonly code: 'OPEN_UNAVAILABLE'});
