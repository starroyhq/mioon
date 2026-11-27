import path from 'node:path';
import {privateStorageIdentity} from '@mioon/contracts/private-storage';
import {inspectFile, sameFile, streamFile} from '../managed-file-io.ts';
import {processingHash} from './demand.ts';
import {OPTICAL_PROXY_PROFILE} from './optical-proxy-port.ts';
import type {TimelineOpticalProxyPort, TimelineOpticalProxyRequest, TimelineOpticalProxyProof} from './optical-proxy-port.ts';
import type {ProcessingCache, ProcessingCacheEntry} from './cache.ts';
import type {SpeedProcessingReason} from '../../../contracts/src/timeline-speed.ts';

export function opticalCacheProof(entry: ProcessingCacheEntry) {
  if (entry.result.profileId !== OPTICAL_PROXY_PROFILE) return null;
  const {directory, result} = entry;
  const files = result.files.map(payload => {
    const file = path.join(directory, payload.fileName);
    const info = inspectFile(file, directory, {private: true, maxBytes: payload.bytes});
    if (!info || info.size !== payload.bytes) throw new Error('The optical cache payload changed.');
    return {file, info, payload};
  });
  // Tie the verified receipt to the published immutable files. A replacement
  // is rejected on the status path, even if its byte count is unchanged.
  const proof = processingHash([result, files.map(({info}) => [privateStorageIdentity(info), info.size, info.mtimeMs, info.ctimeMs])]);
  return {proof, files, result};
}

export async function verifyOpticalCache(entry: ProcessingCacheEntry, options: {readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void}, expectedProof?: string) {
  const ready = opticalCacheProof(entry);
  if (!ready || expectedProof !== undefined && ready.proof !== expectedProof) return null;
  for (const {file, info, payload} of ready.files) {
    const actual = await streamFile({file, root: entry.directory, expected: info, maxBytes: payload.bytes,
      private: true, signal: options.signal, check: options.beforeEffect});
    if (actual.sha256 !== payload.sha256 || actual.bytes !== payload.bytes) return null;
  }
  return ready;
}

export interface ResolvedOpticalProxy {
  readonly taskId: string;
  readonly entry?: ProcessingCacheEntry;
  readonly verifiedProxy?: string;
  readonly reason?: SpeedProcessingReason;
}

export function createOpticalProxyPort(cache: ProcessingCache,
  resolve: (request: TimelineOpticalProxyRequest, frozenTaskId?: string) => ResolvedOpticalProxy | null,
  beforeRead: (signal?: AbortSignal) => void): TimelineOpticalProxyPort {
  function lookup(request: TimelineOpticalProxyRequest) {
    const task = resolve(request);
    if (!task) return null;
    return {taskId: task.taskId, ...(task.reason ? {reason: task.reason} : {}),
      ...(task.entry && task.verifiedProxy ? {readySha256: task.verifiedProxy} : {})};
  }
  async function acquire(request: TimelineOpticalProxyRequest, proof: TimelineOpticalProxyProof,
    options: {readonly signal?: AbortSignal; readonly beforeEffect?: () => void} = {}) {
    const beforeEffect = () => {beforeRead(options.signal); options.beforeEffect?.();};
    beforeEffect();
    const task = resolve(request, proof.taskId);
    const entry = task?.entry;
    if (!task || !entry || task.taskId !== proof.taskId || task.verifiedProxy !== proof.sha256) return null;
    const unpin = cache.pin(entry.cacheKey);
    let leased = false, released = false;
    try {
      const verified = await verifyOpticalCache(entry, {signal: options.signal, beforeEffect}, proof.sha256);
      if (!verified) return null;
      const {firstOutputFrame, frameCount} = verified.result;
      const proxy = verified.files.find(({payload}) => payload.fileName === 'proxy.mkv')!;
      const verify = (): boolean => {
        if (released) return false;
        try {
          beforeEffect();
          const current = resolve(request, proof.taskId);
          return current?.taskId === proof.taskId && current?.verifiedProxy === proof.sha256 &&
            current.entry?.cacheKey === entry.cacheKey &&
            verified.files.every(({file, info, payload}) => sameFile(info, inspectFile(file, entry.directory,
              {private: true, maxBytes: payload.bytes})));
        } catch { return false; }
      };
      if (!verify()) return null;
      leased = true;
      return {proof, video: {file: proxy.file, firstOutputFrame, frameCount}, verify,
        release: () => {released = true; unpin();}};
    } catch (error) {
      options.signal?.throwIfAborted();
      beforeEffect();
      if ((error as {code?: unknown})?.code === 'MANAGED_FILE_IO_UNAVAILABLE') throw error;
      return null;
    } finally {if (!leased) unpin();}
  }
  return {lookup, acquire};
}
