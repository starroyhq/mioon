import {z} from 'zod';
import {PROJECT_INVALID_REASONS} from './project-file.ts';

const version = z.number().int().min(1).max(1_000_000);
/** Failure data an owner can display after a native open attempt. The owner
 * supplies its own project name and path from the existing entry metadata. */
export const projectEntryOpenFailureSchema = z.discriminatedUnion('code', [
  z.object({code: z.literal('PROJECT_MISSING')}).strict(),
  z.object({code: z.literal('PROJECT_LOCKED')}).strict(),
  z.object({code: z.literal('PROJECT_ACCESS_DENIED')}).strict(),
  z.object({code: z.literal('PROJECT_INVALID'), reason: z.enum(PROJECT_INVALID_REASONS)}).strict(),
  z.object({
    code: z.literal('PROJECT_FORMAT_NEWER'), database: z.enum(['project', 'history', 'cache']),
    formatVersion: version, supportedFormatVersion: version,
  }).strict(),
]).refine(value => value.code !== 'PROJECT_FORMAT_NEWER' || value.formatVersion > value.supportedFormatVersion,
  'A newer format must exceed the supported version.');
export type ProjectEntryOpenFailure = z.infer<typeof projectEntryOpenFailureSchema>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function projectEntryOpenFailure(error: unknown, projectId?: string): ProjectEntryOpenFailure | undefined {
  if (!record(error)) return undefined;
  const details = record(error.details) ? error.details : {};
  if (projectId !== undefined && details.projectId !== undefined && details.projectId !== projectId) return undefined;
  const code = error.code === 'PROJECT_UNAVAILABLE' ? details.reason :
    error.code === 'PROJECT_NOT_FOUND' && projectId !== undefined && details.projectId === projectId ? 'PROJECT_MISSING' :
    error.code === 'EACCES' || error.code === 'EPERM' ? 'PROJECT_ACCESS_DENIED' : error.code;
  const parsed = projectEntryOpenFailureSchema.safeParse(code === 'PROJECT_FORMAT_NEWER' ? {
    code, database: details.database, formatVersion: details.formatVersion, supportedFormatVersion: details.supportedFormatVersion,
  } : code === 'PROJECT_INVALID' ? {
    code, reason: error.code === 'PROJECT_UNAVAILABLE' ? details.invalidReason : details.reason,
  } : {code});
  return parsed.success ? parsed.data : undefined;
}
