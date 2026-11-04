import {z} from 'zod';
import {isNormalizedAbsolutePath} from './media-reference.ts';
import {PROJECT_FILE_EXTENSION, projectIdSchema} from './project-file.ts';
import {PROJECT_NAME_MAX_LENGTH, projectNameProblem} from './project-name.ts';
import {recentProjectSchema} from './project-registry.ts';
import type {RecentProject} from './project-registry.ts';
import type {ProjectEntriesResponse} from './project-entry.ts';
import {projectAdoptCopyInputSchema, projectCopyInputSchema} from './project-copies.ts';
import type {ProjectCopyInput, ProjectCopyResponse, ProjectCopyToInput, ProjectTemplateInput} from './project-copies.ts';

/** Trusted utility control payloads, not HTTP/renderer messages. The main
 * process generates opaque UUID window owners; these are not BrowserWindow's
 * numeric IDs. Instance ownership belongs to the port's server closure. */
const windowId = z.string().uuid();
const absolutePath = z.string().min(1).max(4096).refine(isNormalizedAbsolutePath, 'Use a normalized absolute path.');
export const projectEntryCreateInputSchema = z.object({
  name: z.string().min(1).max(PROJECT_NAME_MAX_LENGTH).refine(name => projectNameProblem(name) === null, 'Invalid project name.'),
  description: z.string().max(2000).optional(),
  timelinePresetId: z.enum(['portrait_1080', 'landscape_1080', 'square_1080']).optional(),
  parentDir: absolutePath.optional(),
  projectFile: absolutePath.refine(file => file.endsWith(PROJECT_FILE_EXTENSION), 'Choose a .mioon file.').optional(),
}).strict().refine(value => value.parentDir === undefined || value.projectFile === undefined, 'Choose one project location.');
export const projectEntryOpenPathInputSchema = z.object({projectFile: absolutePath, windowId}).strict();
export const projectEntryAcquireInputSchema = z.object({projectId: projectIdSchema, windowId}).strict();
export const projectEntryReleaseInputSchema = z.object({windowId}).strict();
export const projectEntryWindowSchema = z.object({windowId, project: recentProjectSchema}).strict();
export const projectEntryWindowRevokedSchema = z.object({windowId, projectId: projectIdSchema}).strict();
export const projectEntrySaveAsInputSchema = projectCopyInputSchema.extend({windowId});
export const projectEntryAdoptCopyInputSchema = projectAdoptCopyInputSchema.extend({windowId});
export type ProjectEntryCreateInput = z.infer<typeof projectEntryCreateInputSchema>;
export type ProjectEntryOpenPathInput = z.infer<typeof projectEntryOpenPathInputSchema>;
export type ProjectEntryAcquireInput = z.infer<typeof projectEntryAcquireInputSchema>;
export type ProjectEntryReleaseInput = z.infer<typeof projectEntryReleaseInputSchema>;
export type ProjectEntryWindow = z.infer<typeof projectEntryWindowSchema>;
export type ProjectEntryWindowRevoked = z.infer<typeof projectEntryWindowRevokedSchema>;
export type ProjectEntrySaveAsInput = z.infer<typeof projectEntrySaveAsInputSchema>;
export type ProjectEntryAdoptCopyInput = z.infer<typeof projectEntryAdoptCopyInputSchema>;

/** No server types, SQL, caller-selected lease kinds or persisted lease IDs. */
export interface ProjectEntryControlPort {
  listRecent(): ProjectEntriesResponse;
  create(input: ProjectEntryCreateInput): Promise<RecentProject>;
  openPath(input: ProjectEntryOpenPathInput): Promise<ProjectEntryWindow>;
  acquire(input: ProjectEntryAcquireInput): Promise<ProjectEntryWindow>;
  release(input: ProjectEntryReleaseInput): void;
  duplicate?(input: ProjectCopyInput): Promise<ProjectCopyResponse>;
  saveAs?(input: ProjectEntrySaveAsInput): Promise<{copy: ProjectCopyResponse; window: ProjectEntryWindow}>;
  adoptCopy?(input: ProjectEntryAdoptCopyInput): Promise<{copy: ProjectCopyResponse; window: ProjectEntryWindow}>;
  copyTo?(input: ProjectCopyToInput): Promise<ProjectCopyResponse>;
  instantiateTemplate?(input: ProjectTemplateInput): Promise<ProjectCopyResponse>;
  onWindowRevoked(listener: (event: ProjectEntryWindowRevoked) => void): () => void;
}
