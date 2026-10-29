import { PROJECT_NOTES_MAX_BYTES, projectNotesSetInputSchema, projectNotesValid } from '../../../packages/contracts/src/project-lifecycle.ts';
import { ApiError } from './api.ts';

/** Project notes (C6): plain text on the project record that Mio reads with every run. */
export interface ProjectNotesSetInput { requestId: string; projectId: string; expectedRevision: number; notes: string }
export interface ProjectNotesBase { projectId: string; revision: number; notes: string }
export type ProjectNotesOutcome =
  | { kind: 'saved'; base: ProjectNotesBase }
  /** The notes changed elsewhere; the user's text is not saved and `latest` is the new base. */
  | { kind: 'conflict'; latest: ProjectNotesBase }
  /** No confirmed answer: retrying the same input replays the saved receipt instead of saving twice. */
  | { kind: 'unknown'; input: ProjectNotesSetInput }
  | { kind: 'rejected'; code?: string };
export type ProjectNotesCall = (operation: 'project.notes.set' | 'project.get', input: unknown) => Promise<unknown>;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
export const projectNotesBytes = (text: string): number => encoder.encode(text).byteLength;
/** Why text cannot be saved as notes, or null when it can. */
export function projectNotesProblem(text: string): 'tooLong' | 'invalid' | null {
  if (projectNotesBytes(text) > PROJECT_NOTES_MAX_BYTES) return 'tooLong';
  return projectNotesValid(text) ? null : 'invalid';
}
/** A project record's saved notes; a missing or invalid field reads as none. */
export function projectNotesOf(project: unknown): string {
  const notes = record(project) ? project.notes : undefined;
  return typeof notes === 'string' && projectNotesValid(notes) ? notes : '';
}
function baseOf(project: unknown, projectId: string): ProjectNotesBase | null {
  if (!record(project) || project.id !== projectId || typeof project.revision !== 'number' || !Number.isSafeInteger(project.revision) || project.revision < 1) return null;
  return { projectId, revision: project.revision, notes: projectNotesOf(project) };
}
const stored = (notes: string): string => notes.trim() ? notes : '';

/**
 * Saves notes against the project revision they were edited from. Any project edit moves that revision, so a
 * conflict is read back: when the saved notes are still the ones the user started from, the save is repeated on
 * the new revision with a new request; changed notes are handed back for the user to decide. An unconfirmed
 * outcome keeps its exact request, which the server replays from its receipt when retried.
 */
export async function saveProjectNotes(call: ProjectNotesCall, { base, notes, retained = null, newRequestId = () => crypto.randomUUID() }: { base: ProjectNotesBase; notes: string; retained?: ProjectNotesSetInput | null; newRequestId?: () => string }): Promise<ProjectNotesOutcome> {
  let current = base, input = retained;
  for (let attempt = 0; attempt < 3; attempt++) {
    input ??= projectNotesSetInputSchema.parse({ requestId: newRequestId(), projectId: current.projectId, expectedRevision: current.revision, notes });
    try {
      const saved = baseOf(await call('project.notes.set', input), current.projectId);
      if (!saved || saved.revision !== input.expectedRevision + 1 || saved.notes !== stored(input.notes)) return { kind: 'unknown', input };
      return { kind: 'saved', base: saved };
    } catch (error) {
      if (!(error instanceof ApiError) || !error.definitive) return { kind: 'unknown', input };
      if (error.code !== 'REVISION_CONFLICT') return { kind: 'rejected', ...(error.code ? { code: error.code } : {}) };
    }
    // A conflict also answers a retained request: had it been saved, its receipt would have been replayed.
    let latest: ProjectNotesBase | null = null;
    try { const response = await call('project.get', { projectId: current.projectId }); latest = baseOf(record(response) ? response.project : undefined, current.projectId); } catch { /* reported as a conflict below */ }
    if (!latest) return { kind: 'rejected', code: 'REVISION_CONFLICT' };
    if (latest.notes !== base.notes) return { kind: 'conflict', latest };
    current = latest; input = null;
  }
  return { kind: 'rejected', code: 'REVISION_CONFLICT' };
}
