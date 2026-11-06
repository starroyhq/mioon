import {z} from 'zod';
import {PROJECT_INVALID_REASONS} from './project-file.ts';
import {recentProjectSchema} from './project-registry.ts';

/** Application reads only. This catalog grants neither file access nor a
 * window lease and is deliberately absent from the model operation catalog. */
export const PROJECT_ENTRY_LIMITS = Object.freeze({
  maxEntries: 8192,
  // Bound this unpaginated transport independently from B1's per-record cap;
  // an oversized catalog must fail explicitly instead of truncating entries.
  responseBytes: 384 * 1024 * 1024,
});
export const PROJECT_ENTRY_ERROR_STATUS = Object.freeze({
  PROJECT_ENTRY_SCOPE_MISMATCH: 409,
  PROJECT_ENTRY_UNAVAILABLE: 503,
  PROJECT_ENTRY_WINDOW_CONFLICT: 409,
  PROJECT_ENTRY_LIMIT: 413,
} as const);
export const projectEntryAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({state: z.enum(['open', 'busy', 'available', 'locked', 'missing', 'access-denied'])}).strict(),
  z.object({state: z.literal('invalid'), reason: z.enum(PROJECT_INVALID_REASONS)}).strict(),
]);
export type ProjectEntryAvailability = z.infer<typeof projectEntryAvailabilitySchema>;

export const projectEntrySchema = z.object({
  project: recentProjectSchema,
  availability: projectEntryAvailabilitySchema,
  coverUrl: z.string().nullable(),
}).strict().refine(entry => entry.coverUrl === (entry.project.summary?.cover ? '/api/project-covers/' + entry.project.projectId : null),
  'The cover address must match this project and its cached summary.');
export type ProjectEntry = z.infer<typeof projectEntrySchema>;

export const projectEntriesResponseSchema = z.object({
  version: z.literal(1),
  appLibraryScope: z.string().regex(/^[a-f0-9]{64}$/u),
  instanceId: z.string().uuid(),
  registered: z.array(projectEntrySchema).max(PROJECT_ENTRY_LIMITS.maxEntries),
}).strict().refine(value => new Set(value.registered.map(entry => entry.project.projectId)).size === value.registered.length,
  'Each registered project appears once.');
export type ProjectEntriesResponse = z.infer<typeof projectEntriesResponseSchema>;

/** One authenticated registration for a native result action. Reading this
 * descriptor does not acquire a project or grant a file/window capability. */
export const projectEntryResponseSchema = z.object({
  version: z.literal(1), appLibraryScope: z.string().regex(/^[a-f0-9]{64}$/u), instanceId: z.string().uuid(),
  entry: projectEntrySchema,
}).strict();
export type ProjectEntryResponse = z.infer<typeof projectEntryResponseSchema>;
