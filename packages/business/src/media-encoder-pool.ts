import { availableParallelism, totalmem } from 'node:os';
import { interruptedMediaError, throwIfMediaAborted } from './media-processes.ts';

// One application-wide admission cap for the heavy segment encoders. A desktop
// backend process hosts every open project, so one module-level pool bounds all
// project windows, previews and Mio renders together. Light media tools
// (probes, frame/waveform decoders, thumbnails) are not encoded segments and
// keep their own existing limits.
//
// Global slots = min(cores form, memory form). The four-segment ceiling belongs
// to a single export; the application total scales with the machine, with the
// memory form bounding encoders on small machines.
/** Every timeline segment encoder runs with `-threads 2` (unchanged by this cap). */
const THREADS_PER_ENCODER = 2;
/** Keep two logical cores for the UI, the backend and light media tooling. */
const CORE_HEADROOM = 2;
/** Per render: one export gains nothing from more concurrent segments. */
export const MAX_SEGMENT_ENCODERS = 4;
/**
 * Measured peak resident memory of one extra concurrent segment encoder on a
 * 1080x1920 / 30 fps delivery: the 2-minute colour, transition and subtitle
 * benchmark grows by 955 MiB going from one to four encoders, and the widest
 * single-step increase observed is 464 MiB. Round that up and keep 512 MiB per
 * concurrent encoder as the admission estimate.
 */
export const ENCODER_RESIDENT_BYTES = 512 * 1024 * 1024;
const BASE_FRAME_PIXELS = 1920 * 1080;
const RGBA_BYTES_PER_PIXEL = 4;
// Account for scaled staging, compositor/filter buffers and encoder lookahead
// above the measured HD allowance. Use the actual landscape or portrait raster.
const LARGE_FRAME_BUFFER_ALLOWANCE = 28;

export function encoderResidentBytesForOutput(width: number, height: number): number {
  const extraPixels = Math.max(0, width * height - BASE_FRAME_PIXELS);
  return ENCODER_RESIDENT_BYTES + extraPixels * RGBA_BYTES_PER_PIXEL * LARGE_FRAME_BUFFER_ALLOWANCE;
}
/**
 * System and application allowance for the memory form of the cap: the desktop
 * shell (main process plus renderer windows and helpers) and the system work
 * alongside the encoders, and light media tools may overlap an export. Three
 * GiB keeps the memory form from reacting to page cache; it binds on machines
 * where the core form would otherwise crowd the available memory.
 */
export const ENCODER_MEMORY_RESERVE_BYTES = 3 * 1024 * 1024 * 1024;
/** Defensive bound for constructing a pool; the formula is far below this. */
export const MAX_ENCODER_POOL_SLOTS = 256;

export interface EncoderPoolLimitInput {
  readonly parallelism?: number;
  readonly totalMemoryBytes?: number;
}
export interface EncoderPoolLimits {
  /** Final global slot count; the smaller of the core and memory forms. */
  readonly slots: number;
  /** Global slots the machine's cores can keep occupied. */
  readonly coreSlots: number;
  /** Global slots the machine's memory can admit. */
  readonly memorySlots: number;
  readonly residentBytes: number;
  readonly reserveBytes: number;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RangeError(`Invalid ${name}`);
  return value as number;
}

/** Global slots that the machine's cores can keep busy across all exports.
 * Unlike the per-render formula this is not capped at four: the four is a
 * per-export ceiling, not the ceiling of the whole application. */
export function coreEncoderSlots(parallelism: number = availableParallelism()): number {
  const cores = positiveInteger(parallelism, 'available parallelism');
  return Math.max(1, Math.floor((cores - CORE_HEADROOM) / THREADS_PER_ENCODER));
}

function hostEncoderMemoryBytes(): number {
  const physical = totalmem();
  const constrained = process.constrainedMemory();
  return constrained > 0 ? Math.min(physical, constrained) : physical;
}

export function encoderMemoryAllows(residentBytes: number, totalMemoryBytes = hostEncoderMemoryBytes()): boolean {
  return residentBytes <= totalMemoryBytes - ENCODER_MEMORY_RESERVE_BYTES;
}

export function memoryEncoderSlots(totalMemoryBytes: number = hostEncoderMemoryBytes()): number {
  if (typeof totalMemoryBytes !== 'number' || !Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) throw new RangeError('Invalid total memory');
  return Math.max(1, Math.floor((totalMemoryBytes - ENCODER_MEMORY_RESERVE_BYTES) / ENCODER_RESIDENT_BYTES));
}

export function encoderPoolLimits({ parallelism = availableParallelism(), totalMemoryBytes = hostEncoderMemoryBytes() }: EncoderPoolLimitInput = {}): EncoderPoolLimits {
  const coreSlots = coreEncoderSlots(parallelism);
  const memorySlots = memoryEncoderSlots(totalMemoryBytes);
  return Object.freeze({ slots: Math.min(coreSlots, memorySlots), coreSlots, memorySlots,
    residentBytes: ENCODER_RESIDENT_BYTES, reserveBytes: ENCODER_MEMORY_RESERVE_BYTES });
}

/** One export still runs at most four segments at a time, and never more than
 * the application-wide pool admits. */
export function segmentConcurrencyFor(slots: number): number {
  return Math.min(MAX_SEGMENT_ENCODERS, positiveInteger(slots, 'encoder pool slots'));
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
  /** Resolves once enough capacity is free. Owners are served round-robin.
   * Large rasters reserve multiple units until the idempotent release. */
  acquire(signal?: AbortSignal | null, owner?: EncoderSlotOwner, residentBytes?: number): Promise<EncoderSlotRelease>;
  stats(): EncoderPoolStats;
}

interface EncoderSlotWaiter {
  readonly owner: EncoderSlotOwner;
  readonly signal: AbortSignal | null | undefined;
  readonly slots: number;
  readonly resolve: (release: EncoderSlotRelease) => void;
  readonly reject: (error: unknown) => void;
  abort?: () => void;
}

export function createMediaEncoderPool(limit: number): MediaEncoderSlotPool {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ENCODER_POOL_SLOTS) throw new RangeError('Invalid encoder pool limit');
  let active = 0, usedSlots = 0, waiting = 0;
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
      const waiter = queue[0]!;
      // Accumulate capacity for the next owner instead of starving a large
      // export behind a continuous stream of single-unit requests.
      if (waiter.slots > limit - usedSlots) return undefined;
      queue.shift();
      if (!queue.length) dropOwner(owner);
      lastGranted = owner;
      waiting -= 1;
      return waiter;
    }
    return undefined;
  };
  const drain = (): void => {
    while (usedSlots < limit) {
      const waiter = take();
      if (!waiter) return;
      active += 1;
      usedSlots += waiter.slots;
      detach(waiter);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        usedSlots -= waiter.slots;
        drain();
      });
    }
  };
  const acquire = async (signal?: AbortSignal | null, owner: EncoderSlotOwner = {}, residentBytes = ENCODER_RESIDENT_BYTES): Promise<EncoderSlotRelease> => {
    throwIfMediaAborted(signal);
    // A memory-qualified 4K export can occupy the whole pool on a machine
    // whose CPU form admits fewer units. Its caller checks physical memory.
    const slots = Math.min(limit, Math.ceil(positiveInteger(residentBytes, 'encoder resident bytes') / ENCODER_RESIDENT_BYTES));
    return new Promise<EncoderSlotRelease>((resolve, reject) => {
      const waiter: EncoderSlotWaiter = { owner, signal, slots, resolve, reject };
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
          drain();
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
