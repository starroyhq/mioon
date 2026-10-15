import { TIMELINE_CLIP_LOUDNESS_LIMITS, timelineClipLoudnessInputSchema } from '@mioon/contracts/timeline-clip-loudness';
import { readTimelineClipLoudnessEnvelope } from '@mioon/client/timeline-clip-loudness';

export interface TimelineClipLoudnessWireOptions {
  readonly signal?: AbortSignal;
  readonly expectedWorkspaceOrigin?: string;
  readonly fetch?: typeof fetch;
  /** Tests may shorten the fixed deadline; it can never be extended. */
  readonly timeoutMs?: number;
}
const fault = (code: string): Error & { code: string } => Object.assign(new Error('Selected saved-clip loudness observation did not complete.'), { code });
function observe<T>(work: Promise<T>, signal: AbortSignal, cancelled: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); fn(); };
    const abort = (): void => finish(() => reject(cancelled()));
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort();
  });
}
/** Same-origin read-only RPC with one deadline for headers and the complete
 * bounded wire envelope, including errors. Never call response.json(). */
export async function readTimelineClipLoudnessRpc(rawInput: unknown, options: TimelineClipLoudnessWireOptions = {}): Promise<{ response: Response; body: unknown }> {
  const parsed = timelineClipLoudnessInputSchema.safeParse(rawInput);
  if (!parsed.success) throw fault('VALIDATION');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = (): void => controller.abort();
  const cancelled = (): Error => fault(timedOut ? 'TIMELINE_CLIP_LOUDNESS_TIMEOUT' : 'OPERATION_CANCELLED');
  const timeout = options.timeoutMs === undefined ? TIMELINE_CLIP_LOUDNESS_LIMITS.clientTimeoutMs : options.timeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > TIMELINE_CLIP_LOUDNESS_LIMITS.clientTimeoutMs) throw fault('VALIDATION');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeout);
  try {
    if (options.signal?.aborted) cancel();
    if (controller.signal.aborted) throw cancelled();
    let response: Response;
    try {
      response = await observe((options.fetch ?? fetch)('/api/rpc', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'timeline.clip.loudness', input: parsed.data,
          ...(options.expectedWorkspaceOrigin ? { expectedWorkspaceOrigin: options.expectedWorkspaceOrigin } : {}) }), signal: controller.signal }).then(value => {
          if (controller.signal.aborted) { void value.body?.cancel().catch(() => {}); throw cancelled(); }
          return value;
        }), controller.signal, cancelled);
    } catch (error) { if (controller.signal.aborted) throw cancelled(); throw fault('NETWORK'); }
    try {
      const body = await observe(readTimelineClipLoudnessEnvelope(response, controller.signal), controller.signal, cancelled);
      if (controller.signal.aborted) throw cancelled();
      return { response, body };
    } catch (error) { if (controller.signal.aborted) throw cancelled(); throw fault('BACKEND_PROTOCOL_ERROR'); }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); cancel(); }
}
