import { TIMELINE_MIX_LOUDNESS_LIMITS, timelineMixLoudnessInputSchema } from '@mioon/contracts/timeline-mix-loudness';
import { readTimelineMixLoudnessEnvelope } from '@mioon/client/timeline-mix-loudness';

export interface TimelineMixLoudnessWireOptions {
  readonly signal?: AbortSignal;
  readonly expectedWorkspaceOrigin?: string;
  readonly fetch?: typeof fetch;
  /** Tests may shorten the fixed deadline; it can never be extended. */
  readonly timeoutMs?: number;
}
const fault = (code: string): Error & { code: string } => Object.assign(new Error('整片混音只读测量未完成，请明确重新准备。'), { code });
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
export async function readTimelineMixLoudnessRpc(rawInput: unknown, options: TimelineMixLoudnessWireOptions = {}): Promise<{ response: Response; body: unknown }> {
  const parsed = timelineMixLoudnessInputSchema.safeParse(rawInput);
  if (!parsed.success) throw fault('VALIDATION');
  const controller = new AbortController();
  let timedOut = false;
  const cancel = (): void => controller.abort();
  const cancelled = (): Error => fault(timedOut ? 'TIMELINE_MIX_LOUDNESS_TIMEOUT' : 'OPERATION_CANCELLED');
  const timeout = options.timeoutMs === undefined ? TIMELINE_MIX_LOUDNESS_LIMITS.clientTimeoutMs : options.timeoutMs;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > TIMELINE_MIX_LOUDNESS_LIMITS.clientTimeoutMs) throw fault('VALIDATION');
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, timeout);
  try {
    if (options.signal?.aborted) cancel();
    if (controller.signal.aborted) throw cancelled();
    let response: Response;
    try {
      response = await observe((options.fetch ?? fetch)('/api/rpc', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'timeline.loudness.prepare', input: parsed.data,
          ...(options.expectedWorkspaceOrigin ? { expectedWorkspaceOrigin: options.expectedWorkspaceOrigin } : {}) }), signal: controller.signal }).then(value => {
          if (controller.signal.aborted) { void value.body?.cancel().catch(() => {}); throw cancelled(); }
          return value;
        }), controller.signal, cancelled);
    } catch (error) { if (controller.signal.aborted) throw cancelled(); throw fault('NETWORK'); }
    try {
      const body = await observe(readTimelineMixLoudnessEnvelope(response, controller.signal), controller.signal, cancelled);
      if (controller.signal.aborted) throw cancelled();
      return { response, body };
    } catch (error) { if (controller.signal.aborted) throw cancelled(); throw fault('BACKEND_PROTOCOL_ERROR'); }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); cancel(); }
}
