import type {ServerResponse} from 'node:http';

// A legal 128 KiB answer can expand sixfold in JSON. The single-frame
// allowance also covers 8 KiB user text, a 20,600-byte edit target, and one
// 8 KiB tool result: even at 6x escaping these total <1.01 MB, with <64 KiB
// additional configuration/identity/activity/envelope fields in current DTOs.
// At most one such frame is outstanding, in addition to the ordinary budget.
export interface ChatSseLimits {clients: number; maxBufferedBytes: number; maxFrameBytes: number; heartbeatMs: number; stallTimeoutMs: number}
export type ChatSseOptions = Partial<ChatSseLimits>;
export interface ChatSseEvent {id: string | number; type: string; run?: {status?: string} | null}
interface ChatSseFrame {frame: string; bytes: number}
export interface ChatSseStream {
  event(value: ChatSseEvent): void;
  end(): void;
  attach(fn: (() => void) | null | undefined): void;
  start(): void;
  reject(): void;
  close(): void;
}
export const CHAT_SSE_LIMITS: Readonly<ChatSseLimits> = Object.freeze({clients: 32, maxBufferedBytes: 256 * 1024,
  maxFrameBytes: 2 * 1024 * 1024, heartbeatMs: 15000, stallTimeoutMs: 30000});
const HEARTBEAT = ': keepalive\n\n';

/** One response, not one run. Ending a subscription never stops or retries work.
 * Options are trusted constructor-only test seams, never HTTP/environment input. */
export function createChatSse({res, onSettled, options = {}}: {res: ServerResponse; onSettled: () => void; options?: ChatSseOptions}): ChatSseStream {
  // Validation below rejects non-numeric overrides; an explicit undefined stays
  // invalid, exactly like the former unchecked JS spread.
  const {maxBufferedBytes, maxFrameBytes, heartbeatMs, stallTimeoutMs} = {...CHAT_SSE_LIMITS, ...options} as ChatSseLimits;
  for (const value of [maxBufferedBytes, maxFrameBytes, heartbeatMs, stallTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid SSE transport limit');
  }
  let detach: (() => void) | undefined, heartbeat: NodeJS.Timeout | undefined, stalled: NodeJS.Timeout | undefined,
    shutdown: NodeJS.Immediate | undefined, accepting = true, ending = false, settled = false, aborted = false, blocked = false;
  const queue: ChatSseFrame[] = []; let queuedBytes = 0, largeFrame: ChatSseFrame | undefined, writeGeneration = 0;
  const clearHeartbeat = () => { clearInterval(heartbeat); heartbeat = undefined; };
  const clearStall = () => { clearTimeout(stalled); stalled = undefined; };
  const release = () => {
    accepting = false; clearHeartbeat();
    const fn = detach; detach = undefined;
    // The runtime may synchronously call end() again from its detach function.
    try { fn?.(); } catch { /* Detaching is local cleanup, never a run failure. */ }
  };
  const settle = () => {
    if (settled) return;
    settled = true; release(); clearStall(); clearImmediate(shutdown); queue.length = 0; queuedBytes = 0; largeFrame = undefined;
    res.removeListener('close', settle); res.removeListener('finish', settle);
    res.removeListener('error', abort); res.removeListener('drain', drain);
    onSettled();
  };
  function abort() {
    if (settled || aborted) return;
    aborted = true; ending = true; release(); clearStall(); clearImmediate(shutdown); queue.length = 0; queuedBytes = 0; largeFrame = undefined;
    // Keep error/close/finish handlers and the client registration until destroy
    // actually closes the response. destroy() may schedule close asynchronously.
    try { res.destroy(); } catch { settle(); }
    if (res.closed || res.writableFinished) settle();
  }
  const armStall = () => {
    if (stalled !== undefined || settled || aborted) return;
    stalled = setTimeout(abort, stallTimeoutMs); stalled.unref?.();
  };
  const pendingBytes = () => res.writableLength + queuedBytes;
  // Include Node's HTTP chunk framing when present, as well as the SSE frame.
  const cost = (frame: string) => { const bytes = Buffer.byteLength(frame); return bytes + (res.chunkedEncoding ? bytes.toString(16).length + 4 : 0); };
  const headers = () => {
    if (res.headersSent) return;
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
    res.flushHeaders();
  };
  const endResponse = () => {
    if (!ending || settled || aborted || blocked || queue.length) return;
    armStall();
    try { if (!res.writableEnded) res.end(); }
    catch { abort(); }
    if (res.writableFinished) settle();
  };
  const write = (next: ChatSseFrame) => {
    try {
      if (res.destroyed || res.writableEnded) { abort(); return; }
      const generation = writeGeneration;
      const ready = res.write(next.frame, error => {
        if (error) { abort(); return; }
        if (largeFrame === next) largeFrame = undefined;
        // Small writes can stall below the high-water mark too. Only actual
        // progress in this unblocked generation may refresh their deadline;
        // an older callback cannot extend a newer backpressure/drain cycle.
        if (settled || aborted || blocked || generation !== writeGeneration) return;
        clearStall();
        if (res.writableLength > 0 || ending) armStall();
      });
      if (settled || aborted) return;
      if (ready === false) { blocked = true; writeGeneration++; armStall(); }
      else if (res.writableLength > 0) armStall();
    } catch { abort(); }
  };
  function drain() {
    if (settled || aborted) return;
    blocked = false; writeGeneration++; clearStall();
    while (queue.length && !blocked && !settled && !aborted) {
      const next = queue.shift(); if (!next) break; queuedBytes -= next.bytes; write(next);
    }
    endResponse();
  }
  const enqueue = (frame: string) => {
    if (settled || aborted) return;
    try {
      if (res.destroyed || res.writableEnded) { abort(); return; }
      headers();
      const bytes = cost(frame);
      const next = {frame, bytes}, large = bytes > maxBufferedBytes;
      if (bytes > maxFrameBytes || large && largeFrame ||
          pendingBytes() + bytes - (largeFrame?.bytes ?? (large ? bytes : 0)) > maxBufferedBytes) { abort(); return; }
      if (large) largeFrame = next;
      if (blocked) { queue.push(next); queuedBytes += bytes; }
      else write(next);
    } catch { abort(); }
  };
  function end() {
    if (settled || aborted || ending) return;
    ending = true; release(); endResponse();
  }
  const event = (value: ChatSseEvent) => {
    if (!accepting || settled || aborted) return;
    try {
      enqueue(`id: ${value.id}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      if (value.type === 'terminal' || value.run && value.run.status !== 'running') end();
    } catch { abort(); }
  };
  res.on('close', settle); res.on('finish', settle); res.on('error', abort); res.on('drain', drain);
  return {
    event, end,
    attach(fn) {
      // subscribe() can synchronously replay a terminal/overflow before returning
      // its detach function. Release that late handle exactly once in this case.
      if (!accepting || settled || aborted) { try { fn?.(); } catch {} }
      else detach = fn ?? undefined;
    },
    start() {
      if (!accepting || settled || aborted) return;
      if (res.destroyed || res.writableEnded) { abort(); return; }
      heartbeat = setInterval(() => {
        if (res.destroyed) { abort(); return; }
        // write(false) already has a deadline. Heartbeats cannot enlarge its
        // backlog or refresh that deadline while waiting for a real drain.
        if (!blocked && accepting) enqueue(HEARTBEAT);
      }, heartbeatMs);
      heartbeat.unref?.();
    },
    reject() {
      // A subscribe validation/cap error before headers must remain JSON, with
      // its original status. The route owns that response, not this transport.
      if (!res.headersSent && !aborted) settle();
      else abort();
    },
    close() {
      end();
      // Healthy responses get their normal finish and retain final durable
      // events. A stalled response cannot delay HTTP shutdown awaiting a drain.
      if (blocked || queue.length) abort();
      else if (!settled && !aborted && shutdown === undefined) {
        // end() itself can be buffered without a preceding write(false). Give
        // healthy finish callbacks this turn, then close any remaining socket.
        shutdown = setImmediate(abort); shutdown.unref?.();
      }
    },
  };
}
