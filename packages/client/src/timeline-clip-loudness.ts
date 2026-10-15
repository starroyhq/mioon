import {TIMELINE_CLIP_LOUDNESS_LIMITS, timelineClipLoudnessInputSchema, isTimelineClipLoudnessResponse} from '@mioon/contracts/timeline-clip-loudness';
import type {TimelineClipLoudnessInput, TimelineClipLoudnessResponse} from '@mioon/contracts/timeline-clip-loudness';

export interface TimelineClipLoudnessClientOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly expectedWorkspaceOrigin?: string;
}
export interface TimelineClipLoudnessRpcClient {
  rpc(operation: 'timeline.clip.loudness', input: TimelineClipLoudnessInput,
    options?: TimelineClipLoudnessClientOptions): Promise<unknown>;
}

/** Typed opt-in adapter; neither a target nor an observation is ever inferred. */
export async function measureTimelineClipLoudness(client: TimelineClipLoudnessRpcClient,
  input: TimelineClipLoudnessInput, options?: TimelineClipLoudnessClientOptions): Promise<TimelineClipLoudnessResponse> {
  const request = timelineClipLoudnessInputSchema.parse(input);
  const report = await client.rpc('timeline.clip.loudness', request, options);
  if (!isTimelineClipLoudnessResponse(report, request))
    throw Object.assign(new Error('The backend returned an invalid selected saved-clip loudness report.'),
      {code: 'BACKEND_PROTOCOL_ERROR', status: 502});
  return report;
}

/** Bound the complete wire envelope before JSON parsing, including error bodies.
 * Native fetch must stream; do not fall back to an unbounded response.json(). */
export async function readTimelineClipLoudnessEnvelope(response: Pick<Response, 'body' | 'headers'>,
  signal?: AbortSignal): Promise<unknown> {
  const limit = TIMELINE_CLIP_LOUDNESS_LIMITS.reportBytes;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Oversized selected saved-clip loudness response.');
  }
  if (!response.body) throw new Error('Missing selected saved-clip loudness response.');
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
      if (bytes > limit) throw new Error('Oversized selected saved-clip loudness response.');
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
