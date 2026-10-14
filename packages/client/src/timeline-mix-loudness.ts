import {TIMELINE_MIX_LOUDNESS_LIMITS, timelineMixLoudnessInputSchema, isTimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';
import type {TimelineMixLoudnessInput, TimelineMixLoudnessResponse} from '@mioon/contracts/timeline-mix-loudness';

export interface TimelineMixLoudnessClientOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly expectedWorkspaceOrigin?: string;
}
export interface TimelineMixLoudnessRpcClient {
  rpc(operation: 'timeline.loudness.prepare', input: TimelineMixLoudnessInput,
    options?: TimelineMixLoudnessClientOptions): Promise<unknown>;
}

/** Typed opt-in adapter; neither a target nor an observation is ever inferred. */
export async function prepareTimelineMixLoudness(client: TimelineMixLoudnessRpcClient,
  input: TimelineMixLoudnessInput, options?: TimelineMixLoudnessClientOptions): Promise<TimelineMixLoudnessResponse> {
  const request = timelineMixLoudnessInputSchema.parse(input);
  const report = await client.rpc('timeline.loudness.prepare', request, options);
  if (!isTimelineMixLoudnessResponse(report, request))
    throw Object.assign(new Error('The backend returned an invalid saved-timeline loudness report.'),
      {code: 'BACKEND_PROTOCOL_ERROR', status: 502});
  return report;
}

/** Bound the complete wire envelope before JSON parsing, including error bodies.
 * Native fetch must stream; do not fall back to an unbounded response.json(). */
export async function readTimelineMixLoudnessEnvelope(response: Pick<Response, 'body' | 'headers'>,
  signal?: AbortSignal): Promise<unknown> {
  const limit = TIMELINE_MIX_LOUDNESS_LIMITS.reportBytes;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Oversized saved-timeline loudness response.');
  }
  if (!response.body) throw new Error('Missing saved-timeline loudness response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0, complete = false;
  // Abort also releases a stalled synthetic/custom stream, not just native fetch.
  const cancel = (): void => {void reader.cancel().catch(() => {});};
  signal?.addEventListener('abort', cancel, {once: true});
  try {
    signal?.throwIfAborted();
    while (true) {
      const result = await reader.read();
      signal?.throwIfAborted();
      if (result.done) {complete = true; break;}
      bytes += result.value.byteLength;
      if (bytes > limit) throw new Error('Oversized saved-timeline loudness response.');
      chunks.push(result.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {body.set(chunk, offset); offset += chunk.byteLength;}
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body)) as unknown;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (!complete) void reader.cancel().catch(() => {});
    // Preserve the causal failure/cancellation if a custom stream refuses to
    // release; cleanup must not replace the observation's transport outcome.
    try {reader.releaseLock();} catch {}
  }
}
