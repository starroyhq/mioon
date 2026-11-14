import {DRAFT_SERVICE_PROBE_LIMITS, draftServiceModelIdSchema} from '../../contracts/src/draft-service-probe.ts';
import {awaitProvider, checkpoint} from './operation-lifecycle.ts';

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function openAiEntries(payload: unknown): unknown[] | null {
  const entries = record(payload)?.data;
  return Array.isArray(entries) ? entries : null;
}

export async function readDraftServiceJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const limit = DRAFT_SERVICE_PROBE_LIMITS.responseBytes;
  if (!response.body) return null;
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let ended = false;
  try {
    while (true) {
      checkpoint(signal);
      const chunk = await awaitProvider(() => reader.read(), signal);
      checkpoint(signal);
      if (chunk.done) {
        ended = true;
        break;
      }
      size += chunk.value.byteLength;
      if (size > limit) return null;
      chunks.push(Buffer.from(chunk.value));
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))) as unknown;
  } catch {
    return null;
  } finally {
    if (!ended) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Only model IDs cross the settings boundary, including when a provider
 * reflects the credential in a field that otherwise has the expected shape. */
export async function readDraftServiceModels(
  response: Response,
  secret: string,
  signal?: AbortSignal,
  select: (payload: unknown) => unknown[] | null = openAiEntries,
): Promise<{id: string}[] | null> {
  const payload = await readDraftServiceJson(response, signal);
  if (payload === null || signal?.aborted) return null;
  const entries = select(payload);
  if (!entries) return null;
  const ids = new Set<string>();
  for (const entry of entries) {
    const candidate = typeof entry === 'string' ? entry : record(entry)?.id;
    const id = draftServiceModelIdSchema.safeParse(candidate);
    if (!id.success || (secret && id.data.includes(secret))) continue;
    ids.add(id.data);
    if (ids.size > DRAFT_SERVICE_PROBE_LIMITS.models) return null;
  }
  return [...ids].map(id => ({id}));
}
