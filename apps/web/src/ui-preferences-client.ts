import { uiPreferencesPutSchema, uiPreferencesProjectIdSchema, uiPreferencesResponseSchema, UI_PREFERENCES_LIMITS } from '../../../packages/contracts/src/ui-preferences.ts';
import type { UiPreferencesPut, UiPreferencesResponse } from '../../../packages/contracts/src/ui-preferences.ts';

export class UiPreferencesRequestError extends Error {
  readonly code: string;
  constructor(code: string) {
    super('Application preferences request failed.');
    this.name = 'UiPreferencesRequestError';
    this.code = /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : 'UI_PREFERENCES_UNKNOWN';
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > UI_PREFERENCES_LIMITS.fileBytes) {
        await reader.cancel();
        throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch { throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL'); }
  finally { reader.releaseLock(); }
}

export interface UiPreferencesClient {
  get(): Promise<UiPreferencesResponse>;
  put(input: UiPreferencesPut): Promise<UiPreferencesResponse>;
  opened(projectId: string): Promise<UiPreferencesResponse>;
}

export function createUiPreferencesClient(fetcher: typeof fetch = (...args) => fetch(...args)): UiPreferencesClient {
  async function request(method: 'GET' | 'PUT' | 'POST', body?: UiPreferencesPut | { projectId: string }): Promise<UiPreferencesResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetcher(method === 'POST' ? '/api/ui-preferences/opened' : '/api/ui-preferences', {
        method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      const value = await readResponse(response);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
      const envelope = value as Record<string, unknown>;
      if (!response.ok || envelope.ok !== true) {
        const error = envelope.error;
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UI_PREFERENCES_PROTOCOL';
        throw new UiPreferencesRequestError(response.status === 401 ? 'UNAUTHORIZED' : code);
      }
      if (response.status !== 200) throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
      if (Object.keys(envelope).sort().join(',') !== 'data,ok') throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
      const parsed = uiPreferencesResponseSchema.safeParse(envelope.data);
      if (!parsed.success) throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
      return parsed.data;
    } catch (error) {
      if (error instanceof UiPreferencesRequestError) throw error;
      throw new UiPreferencesRequestError(controller.signal.aborted ? 'UI_PREFERENCES_TIMEOUT' : 'UI_PREFERENCES_NETWORK');
    } finally { clearTimeout(timer); }
  }
  return {
    get: () => request('GET'),
    async put(input) {
      const parsed = uiPreferencesPutSchema.safeParse(input);
      if (!parsed.success) throw new UiPreferencesRequestError('UI_PREFERENCES_VALIDATION');
      const result = await request('PUT', parsed.data);
      if (result.revision !== parsed.data.expectedRevision + 1 || !result.writable || result.recoveredDefaults ||
          Object.keys(parsed.data.preferences).some(key => result.preferences[key as keyof typeof result.preferences] !== parsed.data.preferences[key as keyof typeof result.preferences])) throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
      return result;
    },
    async opened(projectId) {
      if (!uiPreferencesProjectIdSchema.safeParse(projectId).success) throw new UiPreferencesRequestError('UI_PREFERENCES_VALIDATION');
      const result = await request('POST', { projectId });
      if (!Object.hasOwn(result.recentOpened, projectId)) throw new UiPreferencesRequestError('UI_PREFERENCES_PROTOCOL');
      return result;
    },
  };
}
