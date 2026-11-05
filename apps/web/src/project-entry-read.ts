import {projectEntryResponseSchema} from '../../../packages/contracts/src/project-entry.ts';
import type {ProjectEntryResponse} from '../../../packages/contracts/src/project-entry.ts';
import {isProjectId} from '../../../packages/contracts/src/project-file.ts';
import {ApiError} from './api.ts';

/** Read registered metadata without acquiring the project. A path from this
 * response is for display, never an authorization to access a file. */
export async function readProjectEntryMetadata(projectId: string, signal?: AbortSignal): Promise<ProjectEntryResponse> {
  if (!isProjectId(projectId)) throw new ApiError('Invalid project identity.', 'VALIDATION_ERROR', undefined, true);
  const response = await fetch('/api/project-entries/' + projectId, {credentials: 'same-origin',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)});
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('Invalid project registration.', 'BACKEND_PROTOCOL_ERROR');
  let text = '', bytes = 0;
  const decoder = new TextDecoder('utf-8', {fatal: true});
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) throw new Error('Project registration is too large.');
      text += decoder.decode(chunk.value, {stream: true});
    }
    text += decoder.decode();
  } catch (error) {await reader.cancel().catch(() => {}); throw error;} finally {reader.releaseLock();}
  let body: unknown;
  try {body = JSON.parse(text);} catch {throw new ApiError('Invalid project registration.', 'BACKEND_PROTOCOL_ERROR');}
  if (!response.ok || !body || typeof body !== 'object' || !('ok' in body) || body.ok !== true || !('data' in body))
    throw new ApiError('Project registration is unavailable.', 'PROJECT_ENTRY_UNAVAILABLE');
  const parsed = projectEntryResponseSchema.safeParse(body.data);
  if (!parsed.success || parsed.data.entry.project.projectId !== projectId)
    throw new ApiError('Project registration does not match this project.', 'BACKEND_PROTOCOL_ERROR');
  return parsed.data;
}
