import type {DatabaseSync} from 'node:sqlite';
import {EXPORT_SAMPLE_PEAK_ALGORITHM, EXPORT_SAMPLE_PEAK_LIMITS, exportSamplePeakInputSchema,
  exportSamplePeakMeasurementSchema, exportSamplePeakReason, isExportSamplePeakResponse, isExportSamplePeakFrameCountCompatible} from '@mioon/contracts/export-sample-peak';
import type {ExportSamplePeakInput, ExportSamplePeakResponse, ExportSamplePeakArtifact,
  ExportSamplePeakMeasurement, ExportSamplePeakReasonCode} from '@mioon/contracts/export-sample-peak';
import {timelineExportOutputFrames, timelineExportRangeFields} from '@mioon/contracts/timeline-export-range';
import {timelineDeliveryNameFields} from '@mioon/contracts/timeline-delivery';
import {readTimelineExportOutput} from './timeline-delivery-read.ts';
import type {TimelineDeliveryReadGuards, TimelineExportOutput} from './timeline-delivery-read.ts';
import {exportAudioObservationAdmission} from './export-audio-observation.ts';
import type {ExportAudioObservationEntry} from './export-audio-observation.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined;
const unconfirmed = (error: unknown): boolean => object(error) && error.terminationUnconfirmed === true;
const fault = (code: string, status = 409): Error & {code: string; status: number} =>
  Object.assign(new Error(code === 'EXPORT_SAMPLE_PEAK_UNAVAILABLE' ? '已导出文件解码样本峰值不可用。' : '已导出文件解码样本峰值检查无法完成。'), {code, status});
function unavailable(): never {throw fault('EXPORT_SAMPLE_PEAK_UNAVAILABLE', 404);}
const checkpoint = (signal: AbortSignal): void => {if (signal.aborted) throw fault('OPERATION_CANCELLED', 503);};
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export interface ExportSamplePeakStore {readonly db: DatabaseSync; readonly root: string}
export interface ExportSamplePeakFileIdentity {
  readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number;
}
export interface ExportSamplePeakManagedAsset {readonly relativePath: string; readonly sha256: string; readonly sizeBytes: number}
export interface ExportSamplePeakHashOptions {
  readonly signal: AbortSignal; readonly expected: ExportSamplePeakFileIdentity; readonly maxBytes: number;
  readonly onBytes: (bytes: number) => void; readonly beforeEffect: () => void;
}
export interface ExportSamplePeakDecodeOptions {
  readonly signal: AbortSignal; readonly beforeEffect: () => void; readonly remainingMs: () => number;
}
/** Backend wiring only. The application binds real lock, graph, managed file
 * and child-process functions. Neither input nor invocation context provides
 * these adapters or any caller-supplied ownership/verification flag. */
export interface ExportSamplePeakRuntime extends TimelineDeliveryReadGuards {
  assertOrdinaryWorkspace(): void;
  ownsLock(): boolean;
  validateSource(root: string, asset: ExportSamplePeakManagedAsset, options: {maxBytes: number}): {file: string; info: ExportSamplePeakFileIdentity};
  hash(root: string, asset: ExportSamplePeakManagedAsset, options: ExportSamplePeakHashOptions): Promise<unknown>;
  decode(file: string, expectedDurationSeconds: number, options: ExportSamplePeakDecodeOptions): Promise<unknown>;
  terminate(signal: AbortSignal): Promise<readonly {status: string}[]>;
  waitForClose(signal: AbortSignal): Promise<readonly {status: string}[]>;
  boundedShutdown(work: Promise<unknown>, code: string): Promise<unknown>;
}
interface Descriptor {
  readonly identity: TimelineExportOutput;
  readonly asset: ExportSamplePeakManagedAsset;
  readonly artifact: ExportSamplePeakArtifact;
  readonly durationSeconds: number;
  readonly outputFrames: number;
}
const sameFile = (left: ExportSamplePeakFileIdentity, right: ExportSamplePeakFileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
function fileIdentity(value: unknown): value is ExportSamplePeakFileIdentity {
  return object(value) && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
}
function descriptor(output: TimelineExportOutput): Descriptor {
  const {asset, record} = output;
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 ||
      typeof record.timelineRevision !== 'number' || !Number.isSafeInteger(record.timelineRevision) || record.timelineRevision < 1) unavailable();
  const artifact = {assetId: output.assetId, sha256: asset.sha256, sizeBytes: asset.sizeBytes,
    timelineRevision: record.timelineRevision, ...timelineDeliveryNameFields(output.snapshot), ...timelineExportRangeFields(output.snapshot)};
  const outputFrames = timelineExportOutputFrames(output.snapshot);
  return freeze({identity: output, asset: {relativePath: output.relativePath, sha256: asset.sha256, sizeBytes: asset.sizeBytes},
    artifact, outputFrames, durationSeconds: outputFrames / 30});
}
function observe<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  checkpoint(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {if (settled) return; settled = true; signal.removeEventListener('abort', abort); fn();};
    const abort = (): void => finish(() => reject(fault('OPERATION_CANCELLED', 503)));
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) {abort(); return;}
    task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
function classify(error: unknown): {status: 'unsupported' | 'incomplete' | 'stale'; code: ExportSamplePeakReasonCode} {
  switch (codeOf(error)) {
    case 'SAMPLE_PEAK_UNSUPPORTED_FORMAT': return {status: 'unsupported', code: 'UNSUPPORTED_FORMAT'};
    case 'SAMPLE_PEAK_DURATION_LIMIT': return {status: 'unsupported', code: 'DURATION_LIMIT'};
    case 'MANAGED_SOURCE_LIMIT': return {status: 'unsupported', code: 'INPUT_TOO_LARGE'};
    case 'SAMPLE_PEAK_BUDGET': case 'MEDIA_OUTPUT_LIMIT': return {status: 'incomplete', code: 'RESOURCE_LIMIT'};
    case 'SAMPLE_PEAK_INVALID_PCM': case 'SAMPLE_PEAK_DURATION_MISMATCH': return {status: 'incomplete', code: 'INVALID_PCM'};
    case 'MEDIA_SPAWN_FAILED': case 'MEDIA_INVALID_CONFIGURATION': return {status: 'incomplete', code: 'DECODER_UNAVAILABLE'};
    case 'MEDIA_TIMEOUT': return {status: 'incomplete', code: 'TIMEOUT'};
    case 'MEDIA_CANCELLED': case 'OPERATION_CANCELLED': return {status: 'incomplete', code: 'CANCELLED'};
    case 'SAMPLE_PEAK_ARTIFACT_CHANGED': case 'MANAGED_SOURCE_CHANGED': case 'MANAGED_SOURCE_INVALID': return {status: 'stale', code: 'ARTIFACT_CHANGED'};
    default: return {status: 'incomplete', code: 'DECODE_FAILED'};
  }
}

/** Explicit, ephemeral final-MP4 analysis. It never renders, mutates a record,
 * persists a report, schedules work, or reads today's editable timeline. */
export function createExportSamplePeakServices(store: ExportSamplePeakStore,
  options: {runtime: ExportSamplePeakRuntime; signal?: AbortSignal}) {
  const {runtime, signal: ownerSignal} = options;
  const state = exportAudioObservationAdmission(store.db);
  const assertOwner = (): void => {
    runtime.assertOrdinaryWorkspace();
    if (!runtime.ownsLock()) throw fault('EXPORT_SAMPLE_PEAK_OWNER_REQUIRED', 403);
  };
  function current(input: ExportSamplePeakInput): Descriptor {
    assertOwner();
    const value = readTimelineExportOutput(store.db, input, runtime);
    if (!value) unavailable();
    try {return descriptor(value);} catch {return unavailable();}
  }
  const stop = (): void => {state.stopped = true; state.active?.controller.abort();};
  ownerSignal?.addEventListener('abort', stop, {once: true});
  if (ownerSignal?.aborted) stop();

  async function samplePeak(rawInput: unknown, context: {signal?: AbortSignal} = {}): Promise<ExportSamplePeakResponse> {
    // This denial must precede input parsing or a getter on restored payloads.
    runtime.assertOrdinaryWorkspace();
    const parsed = exportSamplePeakInputSchema.safeParse(rawInput);
    if (!parsed.success) throw fault('VALIDATION_ERROR', 400);
    const input = parsed.data, started = performance.now();
    const initial = current(input);
    let bytesHashed = 0;
    function report(status: 'unsupported' | 'incomplete' | 'stale', code: ExportSamplePeakReasonCode): ExportSamplePeakResponse {
      // Owner revocation outranks every advisory reason, including timeout.
      const latest = current(input);
      if (latest.identity.identityDigest !== initial.identity.identityDigest) {status = 'stale'; code = 'ARTIFACT_CHANGED';}
      const value = {...input, algorithm: EXPORT_SAMPLE_PEAK_ALGORITHM, checkedAt: new Date().toISOString(), status,
        artifact: null, measurement: null, reason: exportSamplePeakReason(code), checks: {bytesHashed, audioFullyDecoded: false}};
      if (!isExportSamplePeakResponse(value, input)) throw fault('EXPORT_SAMPLE_PEAK_UNAVAILABLE', 404);
      return freeze(value);
    }
    if (state.shutdownFailure) throw state.shutdownFailure;
    if (state.stopped || ownerSignal?.aborted) return report('incomplete', 'SHUTDOWN');
    if (context.signal?.aborted) return report('incomplete', 'CANCELLED');
    if (initial.asset.sizeBytes > EXPORT_SAMPLE_PEAK_LIMITS.inputBytes) return report('unsupported', 'INPUT_TOO_LARGE');
    if (initial.durationSeconds > EXPORT_SAMPLE_PEAK_LIMITS.durationSeconds) return report('unsupported', 'DURATION_LIMIT');
    if (state.active) return report('incomplete', 'BUSY');
    const controller = new AbortController();
    const signals = [controller.signal, ownerSignal, context.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    // Unique attempt signal scopes cleanup to this advisory operation only.
    const signal = AbortSignal.any(signals);
    let timedOut = false, fencedFailure: unknown, expected: ExportSamplePeakFileIdentity | undefined;
    const remainingMs = (): number => Math.max(0, EXPORT_SAMPLE_PEAK_LIMITS.timeoutMs - (performance.now() - started));
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, remainingMs());
    const entry: ExportAudioObservationEntry = {controller, signal, task: Promise.resolve()};
    state.active = entry;
    const fence = (): void => {
      try {
        const latest = current(input);
        if (latest.identity.identityDigest !== initial.identity.identityDigest) throw fault('SAMPLE_PEAK_ARTIFACT_CHANGED');
        checkpoint(signal);
        if (remainingMs() <= 0) {timedOut = true; controller.abort(); checkpoint(signal);}
        if (expected) {
          const source = runtime.validateSource(store.root, initial.asset, {maxBytes: EXPORT_SAMPLE_PEAK_LIMITS.inputBytes});
          if (source.info.size !== initial.asset.sizeBytes || !sameFile(source.info, expected)) throw fault('SAMPLE_PEAK_ARTIFACT_CHANGED');
        }
      } catch (error) {fencedFailure ??= error; throw fencedFailure;}
    };
    const onBytes = (bytes: number): void => {
      fence();
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytesHashed + bytes > EXPORT_SAMPLE_PEAK_LIMITS.totalHashedBytes ||
          bytesHashed + bytes > initial.asset.sizeBytes * 2) {fencedFailure ??= fault('SAMPLE_PEAK_BUDGET'); throw fencedFailure;}
      bytesHashed += bytes;
    };
    const hash = async (): Promise<{sha256: string; info: ExportSamplePeakFileIdentity; file: string}> => {
      fence();
      if (!expected) throw fault('SAMPLE_PEAK_ARTIFACT_CHANGED');
      const value = await runtime.hash(store.root, initial.asset, {signal, expected, maxBytes: EXPORT_SAMPLE_PEAK_LIMITS.inputBytes, onBytes, beforeEffect: fence});
      fence();
      if (!object(value) || typeof value.sha256 !== 'string' || value.sha256 !== initial.asset.sha256 || value.sizeBytes !== initial.asset.sizeBytes ||
          typeof value.file !== 'string' || !fileIdentity(value.info) || !sameFile(value.info, expected)) throw fault('SAMPLE_PEAK_ARTIFACT_CHANGED');
      const source = runtime.validateSource(store.root, initial.asset, {maxBytes: EXPORT_SAMPLE_PEAK_LIMITS.inputBytes});
      if (source.file !== value.file) throw fault('SAMPLE_PEAK_ARTIFACT_CHANGED');
      return {sha256: value.sha256, info: value.info, file: value.file};
    };
    async function prepare(): Promise<ExportSamplePeakMeasurement> {
      fence();
      const source = runtime.validateSource(store.root, initial.asset, {maxBytes: EXPORT_SAMPLE_PEAK_LIMITS.inputBytes});
      if (!fileIdentity(source.info) || source.info.size !== initial.asset.sizeBytes) throw fault('SAMPLE_PEAK_ARTIFACT_CHANGED');
      expected = Object.freeze({dev: source.info.dev, ino: source.info.ino, size: source.info.size, mtimeMs: source.info.mtimeMs, ctimeMs: source.info.ctimeMs});
      fence();
      const first = await hash(); fence();
      const decoded = await runtime.decode(first.file, initial.durationSeconds, {signal, beforeEffect: fence, remainingMs}); fence();
      // An injected decoder is no authority. Validate every mathematical and
      // format relationship independently before running the second byte pass.
      const measurement = exportSamplePeakMeasurementSchema.safeParse(decoded);
      if (!measurement.success || !isExportSamplePeakFrameCountCompatible(measurement.data.sampleFrames, initial.outputFrames))
        throw fault('SAMPLE_PEAK_INVALID_PCM');
      const second = await hash(); fence();
      if (second.sha256 !== first.sha256 || !sameFile(second.info, first.info) || bytesHashed !== initial.asset.sizeBytes * 2)
        throw fault('SAMPLE_PEAK_ARTIFACT_CHANGED');
      return measurement.data;
    }
    const preparation = prepare();
    const joined = (async () => {
      try {return await preparation;}
      catch (error) {if (unconfirmed(error)) state.shutdownFailure ??= Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true}); throw error;}
      finally {
        let closed = false;
        try {
          const results = await runtime.terminate(signal);
          if (results.some(result => result.status !== 'exited') || unconfirmed(state.shutdownFailure)) {
            const error = Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true});
            state.shutdownFailure = error;
            // Runner settlement is not proof of child close. Admission stays
            // held across this await and every drain keeps the failure pinned.
            const actual = await runtime.waitForClose(signal);
            if (actual.some(result => result.status !== 'exited')) throw error;
            closed = true;
            throw error;
          }
          closed = true;
        } catch (error) {
          state.shutdownFailure = unconfirmed(error) ? Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true}) : fault('EXPORT_SAMPLE_PEAK_SHUTDOWN_FAILED', 503);
          throw state.shutdownFailure;
        } finally {if (closed && state.active === entry) state.active = null;}
      }
    })();
    entry.task = joined;
    // A caller may observe cancellation before a non-cooperative read settles.
    // Its exact underlying task remains retained, never publishing late data.
    entry.task.catch(error => {if (unconfirmed(error)) state.shutdownFailure ??= error;});
    try {
      const measurement = await observe(joined, signal);
      fence();
      const value = {...input, algorithm: EXPORT_SAMPLE_PEAK_ALGORITHM, checkedAt: new Date().toISOString(), status: 'ready',
        artifact: initial.artifact, measurement, reason: measurement.overFullScale ? exportSamplePeakReason('OVER_FULL_SCALE') : null,
        checks: {bytesHashed, audioFullyDecoded: true}};
      if (!isExportSamplePeakResponse(value, input)) throw fault('SAMPLE_PEAK_INVALID_PCM');
      return freeze(value);
    } catch (error) {
      // Final identity is checked even when a failed decoder never returned
      // through its post-await fence. Byte/path drift also invalidates failure.
      try {fence();} catch { /* The first fence failure is retained separately. */ }
      current(input);
      if (unconfirmed(error) || state.shutdownFailure) throw state.shutdownFailure ?? error;
      if (codeOf(fencedFailure) === 'EXPORT_SAMPLE_PEAK_UNAVAILABLE' || codeOf(fencedFailure) === 'EXPORT_SAMPLE_PEAK_OWNER_REQUIRED') throw fencedFailure;
      if (timedOut) return report('incomplete', 'TIMEOUT');
      if (state.stopped || ownerSignal?.aborted) return report('incomplete', 'SHUTDOWN');
      const classified = classify(fencedFailure ?? error);
      return report(classified.status, classified.code);
    } finally {clearTimeout(timer); controller.abort();}
  }
  async function drain(): Promise<void> {
    stop();
    try {await runtime.boundedShutdown(Promise.allSettled(state.active ? [state.active.task] : []), 'EXPORT_SAMPLE_PEAK_STOP_TIMEOUT');}
    finally {ownerSignal?.removeEventListener('abort', stop);}
    if (state.shutdownFailure) throw state.shutdownFailure;
  }
  return {handlers: {'timeline.export.samplePeak': samplePeak}, drain};
}
