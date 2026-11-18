import { availableParallelism, totalmem } from 'node:os';
import { interruptedMediaError, throwIfMediaAborted } from './media-processes.ts';

// One application-wide admission cap for the heavy segment encoders. A desktop
// backend process hosts every open project, so one module-level pool bounds all
// project windows, previews and Mio renders together. Light media tools
// (probes, frame/waveform decoders, thumbnails) are not encoded segments and
// keep their own existing limits.
/** Every timeline segment encoder runs with `-threads 2` (unchanged by this cap). */
const THREADS_PER_ENCODER = 2;
/** Keep two logical cores for the UI, the backend and light media tooling. */
const CORE_HEADROOM = 2;
/** Same ceiling the per-render segment loop has always used. */
export const MAX_SEGMENT_ENCODERS = 4;
/**
 * Measured peak resident memory of one extra concurrent segment encoder on a
 * 1080x1920 / 30 fps delivery: the 2-minute colour, transition and subtitle
 * benchmark grows by 955 MiB going from one to four encoders, and the widest
 * single-step increase observed is 464 MiB. Round that up and keep 512 MiB per
 * concurrent encoder as the admission estimate.
 */
export const ENCODER_RESIDENT_BYTES = 512 * 1024 * 1024;
/**
 * System and application allowance for the memory form of the cap: the desktop
 * shell (main process plus renderer windows and helpers) and the system work
 * alongside the encoders, and light media tools may overlap an export. Three
 * GiB keeps the memory form from reacting to page cache; it binds only on
 * machines small enough that four encoders would otherwise not fit.
 */
export const ENCODER_MEMORY_RESERVE_BYTES = 3 * 1024 * 1024 * 1024;

export interface EncoderPoolLimitInput {
  readonly parallelism?: number;
  readonly totalMemoryBytes?: number;
}
export interface EncoderPoolLimits {
  /** Final global slot count; the smaller of the core and memory forms. */
  readonly slots: number;
  /** Segments that may encode at once when only the CPU form applies. */
  readonly coreSlots: number;
  /** Encoders that the machine's memory can admit, bounded by the core form. */
  readonly memorySlots: number;
  readonly residentBytes: number;
  readonly reserveBytes: number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RangeError(`Invalid ${name}`);
  return value as number;
}

/** The long-standing per-render formula, now also the whole-application ceiling. */
export function segmentEncoderConcurrency(parallelism: number = availableParallelism()): number {
  const cores = positiveInteger(parallelism, 'available parallelism');
  return Math.min(MAX_SEGMENT_ENCODERS, Math.max(1, Math.floor((cores - CORE_HEADROOM) / THREADS_PER_ENCODER)));
}

export function encoderMemorySlots(totalMemoryBytes: number = totalmem()): number {
  if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) throw new RangeError('Invalid total memory');
  return Math.min(MAX_SEGMENT_ENCODERS, Math.max(1, Math.floor((totalMemoryBytes - ENCODER_MEMORY_RESERVE_BYTES) / ENCODER_RESIDENT_BYTES)));
}

export function encoderPoolLimits({ parallelism = availableParallelism(), totalMemoryBytes = totalmem() }: EncoderPoolLimitInput = {}): EncoderPoolLimits {
  const coreSlots = segmentEncoderConcurrency(parallelism);
  const memorySlots = encoderMemorySlots(totalMemoryBytes);
  return Object.freeze({ slots: Math.min(coreSlots, memorySlots), coreSlots, memorySlots,
    residentBytes: ENCODER_RESIDENT_BYTES, reserveBytes: ENCODER_MEMORY_RESERVE_BYTES });
}

export type EncoderSlotOwner = object;
export interface EncoderPoolStats {
  readonly limit: number;
  readonly active: number;
  readonly waiting: number;
  readonly owners: number;
}
export type EncoderSlotRelease = () => void;
export interface MediaEncoderSlotPool {
  readonly limit: number;
  /** Resolves with an idempotent release once a slot is free. Queuers are served
   * round-robin between owners, so one export cannot take every later slot
   * while another waits. */
  acquire(signal?: AbortSignal | null, owner?: EncoderSlotOwner): Promise<EncoderSlotRelease>;
  stats(): EncoderPoolStats;
}

interface EncoderSlotWaiter {
  readonly owner: EncoderSlotOwner;
  readonly signal: AbortSignal | null | undefined;
  readonly resolve: (release: EncoderSlotRelease) => void;
  readonly reject: (error: unknown) => void;
  abort?: () => void;
}

export function createMediaEncoderPool(limit: number): MediaEncoderSlotPool {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SEGMENT_ENCODERS) throw new RangeError('Invalid encoder pool limit');
  let active = 0, waiting = 0;
  const queues = new Map<EncoderSlotOwner, EncoderSlotWaiter[]>();
  // Owners with queued work, in first-arrival order; grants rotate through it.
  const rotation: EncoderSlotOwner[] = [];
  let lastGranted: EncoderSlotOwner | null = null;
  const detach = (waiter: EncoderSlotWaiter): void => {
    if (waiter.abort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.abort);
  };
  const dropOwner = (owner: EncoderSlotOwner): void => {
    queues.delete(owner);
    const index = rotation.indexOf(owner);
    if (index >= 0) rotation.splice(index, 1);
  };
  const take = (): EncoderSlotWaiter | undefined => {
    if (!rotation.length) return undefined;
    const anchor = lastGranted === null ? -1 : rotation.indexOf(lastGranted);
    for (let offset = 1; offset <= rotation.length; offset++) {
      const owner = rotation[(anchor + offset + rotation.length) % rotation.length]!;
      const queue = queues.get(owner);
      if (!queue?.length) continue;
      const waiter = queue.shift()!;
      if (!queue.length) dropOwner(owner);
      lastGranted = owner;
      waiting -= 1;
      return waiter;
    }
    return undefined;
  };
  const drain = (): void => {
    while (active < limit) {
      const waiter = take();
      if (!waiter) return;
      active += 1;
      detach(waiter);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        drain();
      });
    }
  };
  const acquire = async (signal?: AbortSignal | null, owner: EncoderSlotOwner = {}): Promise<EncoderSlotRelease> => {
    throwIfMediaAborted(signal);
    return new Promise<EncoderSlotRelease>((resolve, reject) => {
      const waiter: EncoderSlotWaiter = { owner, signal, resolve, reject };
      let queue = queues.get(owner);
      if (!queue) { queue = []; queues.set(owner, queue); rotation.push(owner); }
      queue.push(waiter);
      waiting += 1;
      if (signal) {
        const abort = (): void => {
          const pending = queues.get(owner);
          const index = pending?.indexOf(waiter) ?? -1;
          if (index < 0) return;
          pending!.splice(index, 1);
          waiting -= 1;
          if (!pending!.length) dropOwner(owner);
          detach(waiter);
          reject(interruptedMediaError());
        };
        waiter.abort = abort;
        signal.addEventListener('abort', abort, { once: true });
      }
      drain();
    });
  };
  return Object.freeze({
    limit,
    acquire,
    stats: (): EncoderPoolStats => ({ limit, active, waiting, owners: queues.size }),
  });
}

let sharedPool: MediaEncoderSlotPool | undefined;
/** The application-wide pool. Lazily built so importing modules never samples
 * the host before the backend starts; tests inject their own pool instead. */
export function globalMediaEncoderPool(): MediaEncoderSlotPool {
  return sharedPool ??= createMediaEncoderPool(encoderPoolLimits().slots);
}

export function globalMediaEncoderPoolStats(): EncoderPoolStats {
  return globalMediaEncoderPool().stats();
}

export async function withMediaEncoderSlot<T>(pool: MediaEncoderSlotPool, signal: AbortSignal | null | undefined,
  operation: () => T | Promise<T>, owner?: EncoderSlotOwner): Promise<T> {
  const release = await pool.acquire(signal, owner);
  try { return await operation(); }
  finally { release(); }
}
