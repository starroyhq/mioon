const sampleIntervalMs = 50;
const retainedMs = 120_000;
const capacity = Math.ceil(retainedMs / sampleIntervalMs) + 1;
const requestTimeoutMs = 2_000;
const maxPendingSamples = 8;
const requestType = 'settings-event-loop:sample';
const replyType = 'settings-event-loop:result';

interface SampleRequest { type: typeof requestType; sampleId: number; fromMs: number; toMs: number }
interface SampleReply { type: typeof replyType; sampleId: number; maxDelayMs: number | null }
interface Gap { fromMs: number; toMs: number }

function hasFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validRange(fromMs: number, toMs: number): boolean {
  return positiveInteger(fromMs) && positiveInteger(toMs) && toMs >= fromMs && toMs - fromMs <= retainedMs;
}

function isSampleRequest(value: unknown): value is SampleRequest {
  return hasFields(value, ['type', 'sampleId', 'fromMs', 'toMs']) && value.type === requestType &&
    positiveInteger(value.sampleId) && positiveInteger(value.fromMs) && positiveInteger(value.toMs) && validRange(value.fromMs, value.toMs);
}

function isSampleReply(value: unknown): value is SampleReply {
  return hasFields(value, ['type', 'sampleId', 'maxDelayMs']) && value.type === replyType && positiveInteger(value.sampleId) &&
    (value.maxDelayMs === null || typeof value.maxDelayMs === 'number' && Number.isSafeInteger(value.maxDelayMs) && value.maxDelayMs >= 0);
}

function overlap(gap: Gap, fromMs: number, toMs: number): number {
  return Math.max(0, Math.min(gap.toMs, toMs) - Math.max(gap.fromMs, fromMs));
}

/** Store only bounded timer gaps. Monotonic elapsed time excludes wall-clock
 * changes from delay; the wall timestamp aligns samples with the main process. */
export function createSettingsEventLoopMonitor() {
  const startedAt = Date.now();
  const gaps = new Array<Gap | undefined>(capacity);
  let previous = performance.now(), next = 0;
  let closed = false;
  function currentGap(at: number, now: number): Gap {
    const delay = Math.max(0, Math.floor(now - previous - sampleIntervalMs));
    return { fromMs: at - delay, toMs: at };
  }
  const timer = setInterval(() => {
    const now = performance.now(), gap = currentGap(Date.now(), now);
    previous = now;
    if (gap.fromMs === gap.toMs) return;
    gaps[next] = gap;
    next = (next + 1) % capacity;
  }, sampleIntervalMs);
  timer.unref();

  function sample(fromMs: number, toMs: number): number | null {
    const at = Date.now();
    if (closed || !validRange(fromMs, toMs) || fromMs < Math.max(startedAt, at - retainedMs) || toMs > at) return null;
    // The utility can receive the sample request before its overdue timer
    // callback. Include the pending gap without waiting for another turn.
    let maximum = overlap(currentGap(at, performance.now()), fromMs, toMs);
    for (const gap of gaps) {
      if (gap) maximum = Math.max(maximum, overlap(gap, fromMs, toMs));
    }
    return maximum;
  }

  return {
    sample,
    handle(message: unknown, send: (reply: SampleReply) => void): boolean {
      if (!isSampleRequest(message)) return false;
      if (!closed) {
        const {sampleId, fromMs, toMs} = message;
        try { send({type: replyType, sampleId, maxDelayMs: sample(fromMs, toMs)}); }
        catch { /* Diagnostics cannot interrupt utility work. */ }
      }
      return true;
    },
    close() { closed = true; clearInterval(timer); },
  };
}

export function createSettingsEventLoopClient(send: (request: SampleRequest) => void, isCurrent: () => boolean) {
  const pending = new Map<number, {finish: (delay: number | null) => void; rangeMs: number; deadlineMs: number}>();
  let nextId = 0, closed = false;

  return {
    sample(fromMs: number, toMs: number, signal?: AbortSignal): Promise<number | null> {
      if (closed || !isCurrent() || signal?.aborted || !validRange(fromMs, toMs) || pending.size >= maxPendingSamples) return Promise.resolve(null);
      const sampleId = ++nextId;
      return new Promise(resolve => {
        const deadlineMs = performance.now() + requestTimeoutMs;
        const abort = () => finish(null);
        const finish = (delay: number | null) => {
          pending.delete(sampleId);
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve(delay);
        };
        const timer = setTimeout(abort, requestTimeoutMs);
        timer.unref();
        pending.set(sampleId, {finish, rangeMs: toMs - fromMs, deadlineMs});
        signal?.addEventListener('abort', abort, {once: true});
        try { send({type: requestType, sampleId, fromMs, toMs}); }
        catch { finish(null); }
      });
    },
    handle(message: unknown): boolean {
      if (!isSampleReply(message)) return false;
      const request = pending.get(message.sampleId);
      if (request && isCurrent() && (message.maxDelayMs === null || message.maxDelayMs <= request.rangeMs)) {
        request.finish(performance.now() < request.deadlineMs ? message.maxDelayMs : null);
      }
      return true;
    },
    close() {
      closed = true;
      for (const request of pending.values()) request.finish(null);
    },
  };
}
