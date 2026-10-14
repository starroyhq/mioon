import type {DatabaseSync} from 'node:sqlite';
import {EXPORT_LOUDNESS_LIMITS, exportLoudnessInputSchema,
  exportLoudnessMeasurementSchema, exportLoudnessReason, exportLoudnessSuggestion, isExportLoudnessResponse} from '@mioon/contracts/export-loudness';
import {isExportSamplePeakFrameCountCompatible} from '@mioon/contracts/export-sample-peak';
import type {ExportLoudnessInput, ExportLoudnessResponse, ExportLoudnessArtifact,
  ExportLoudnessMeasurement, ExportLoudnessReasonCode} from '@mioon/contracts/export-loudness';
import {timelineExportOutputFrames, timelineExportRangeFields} from '@mioon/contracts/timeline-export-range';
import {timelineDeliveryNameFields} from '@mioon/contracts/timeline-delivery';
import {readTimelineExportOutput} from './timeline-delivery-read.ts';
import type {TimelineDeliveryReadGuards, TimelineExportOutput} from './timeline-delivery-read.ts';
import {exportAudioObservationAdmission} from './export-audio-observation.ts';
import type {ExportAudioObservationEntry} from './export-audio-observation.ts';
import {floatSnapshotSha256} from './timeline-float-outcome.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeOf = (error: unknown): string | undefined => object(error) && typeof error.code === 'string' ? error.code : undefined;
const unconfirmed = (error: unknown): boolean => object(error) && error.terminationUnconfirmed === true;
const fault = (code: string, status = 409): Error & {code: string; status: number} =>
  Object.assign(new Error(code === 'EXPORT_LOUDNESS_UNAVAILABLE' ? '已导出文件响度不可用。' : '已导出文件响度检查无法完成。'), {code, status});
function unavailable(): never {throw fault('EXPORT_LOUDNESS_UNAVAILABLE', 404);}
const checkpoint = (signal: AbortSignal): void => {if (signal.aborted) throw fault('OPERATION_CANCELLED', 503);};
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export interface ExportLoudnessStore {readonly db: DatabaseSync; readonly root: string}
export interface ExportLoudnessFileIdentity {
  readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number;
}
export interface ExportLoudnessManagedAsset {readonly relativePath: string; readonly sha256: string; readonly sizeBytes: number}
export interface ExportLoudnessHashOptions {
  readonly signal: AbortSignal; readonly expected: ExportLoudnessFileIdentity; readonly maxBytes: number;
  readonly onBytes: (bytes: number) => void; readonly beforeEffect: () => void;
}
export interface ExportLoudnessDecodeOptions {
  readonly signal: AbortSignal; readonly beforeEffect: () => void; readonly remainingMs: () => number;
}
/** Backend wiring only. The application binds real lock, graph, managed file
 * and child-process functions. Neither input nor invocation context provides
 * these adapters or any caller-supplied ownership/verification flag. */
export interface ExportLoudnessRuntime extends TimelineDeliveryReadGuards {
  assertOrdinaryWorkspace(): void;
  ownsLock(): boolean;
  validateSource(root: string, asset: ExportLoudnessManagedAsset, options: {maxBytes: number}): {file: string; info: ExportLoudnessFileIdentity};
  hash(root: string, asset: ExportLoudnessManagedAsset, options: ExportLoudnessHashOptions): Promise<unknown>;
  decode(file: string, expectedDurationSeconds: number, options: ExportLoudnessDecodeOptions): Promise<unknown>;
  terminate(signal: AbortSignal): Promise<readonly {status: string}[]>;
  waitForClose(signal: AbortSignal): Promise<readonly {status: string}[]>;
  boundedShutdown(work: Promise<unknown>, code: string): Promise<unknown>;
}
interface Descriptor {
  readonly identity: TimelineExportOutput;
  readonly asset: ExportLoudnessManagedAsset;
  readonly artifact: ExportLoudnessArtifact;
  readonly durationSeconds: number;
  readonly outputFrames: number;
}
const sameFile = (left: ExportLoudnessFileIdentity, right: ExportLoudnessFileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
function fileIdentity(value: unknown): value is ExportLoudnessFileIdentity {
  return object(value) && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));
}
function descriptor(output: TimelineExportOutput): Descriptor {
  const {asset, record} = output;
  if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 ||
      typeof record.timelineRevision !== 'number' || !Number.isSafeInteger(record.timelineRevision) || record.timelineRevision < 1) unavailable();
  const artifact = {assetId: output.assetId, sha256: asset.sha256, sizeBytes: asset.sizeBytes, snapshotSha256: floatSnapshotSha256(output.snapshot),
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
function classify(error: unknown): {status: 'unsupported' | 'incomplete' | 'stale'; code: ExportLoudnessReasonCode} {
  switch (codeOf(error)) {
    case 'LOUDNESS_UNSUPPORTED_FORMAT': return {status: 'unsupported', code: 'UNSUPPORTED_FORMAT'};
    case 'LOUDNESS_DURATION_LIMIT': return {status: 'unsupported', code: 'DURATION_LIMIT'};
    case 'MANAGED_SOURCE_LIMIT': return {status: 'unsupported', code: 'INPUT_TOO_LARGE'};
    case 'LOUDNESS_BUDGET': case 'LOUDNESS_RESOURCE_LIMIT': case 'MEDIA_OUTPUT_LIMIT': return {status: 'incomplete', code: 'RESOURCE_LIMIT'};
    case 'LOUDNESS_INVALID_PCM': case 'LOUDNESS_DURATION_MISMATCH': return {status: 'incomplete', code: 'INVALID_PCM'};
    case 'MEDIA_SPAWN_FAILED': case 'MEDIA_INVALID_CONFIGURATION': return {status: 'incomplete', code: 'DECODER_UNAVAILABLE'};
    case 'MEDIA_TIMEOUT': return {status: 'incomplete', code: 'TIMEOUT'};
    case 'MEDIA_CANCELLED': case 'OPERATION_CANCELLED': return {status: 'incomplete', code: 'CANCELLED'};
    case 'LOUDNESS_ARTIFACT_CHANGED': case 'MANAGED_SOURCE_CHANGED': case 'MANAGED_SOURCE_INVALID': return {status: 'stale', code: 'ARTIFACT_CHANGED'};
    default: return {status: 'incomplete', code: 'DECODE_FAILED'};
  }
}

/** Explicit, ephemeral final-MP4 analysis. It never renders, mutates a record,
 * persists a report, schedules work, or reads today's editable timeline. */
export function createExportLoudnessServices(store: ExportLoudnessStore,
  options: {runtime: ExportLoudnessRuntime; signal?: AbortSignal}) {
  const {runtime, signal: ownerSignal} = options;
  const state = exportAudioObservationAdmission(store.db);
  const assertOwner = (): void => {
    runtime.assertOrdinaryWorkspace();
    if (!runtime.ownsLock()) throw fault('EXPORT_LOUDNESS_OWNER_REQUIRED', 403);
  };
  function current(input: ExportLoudnessInput): Descriptor {
    assertOwner();
    const value = readTimelineExportOutput(store.db, input, runtime);
    if (!value) unavailable();
    try {return descriptor(value);} catch {return unavailable();}
  }
  const stop = (): void => {state.stopped = true; state.active?.controller.abort();};
  ownerSignal?.addEventListener('abort', stop, {once: true});
  if (ownerSignal?.aborted) stop();

  async function loudness(rawInput: unknown, context: {signal?: AbortSignal} = {}): Promise<ExportLoudnessResponse> {
    // This denial must precede input parsing or a getter on restored payloads.
    runtime.assertOrdinaryWorkspace();
    const parsed = exportLoudnessInputSchema.safeParse(rawInput);
    if (!parsed.success) throw fault('VALIDATION_ERROR', 400);
    const input = parsed.data, started = performance.now();
    const initial = current(input);
    let bytesHashed = 0;
    function report(status: 'unsupported' | 'incomplete' | 'stale', code: ExportLoudnessReasonCode): ExportLoudnessResponse {
      // Owner revocation outranks every advisory reason, including timeout.
      const latest = current(input);
      if (latest.identity.identityDigest !== initial.identity.identityDigest) {status = 'stale'; code = 'ARTIFACT_CHANGED';}
      const value = {...input, checkedAt: new Date().toISOString(), stage: 'decoded-export-file', status,
        artifact: null, measurement: null, suggestion: null, reason: exportLoudnessReason(code), checks: {bytesHashed, audioFullyDecoded: false}};
      if (!isExportLoudnessResponse(value, input)) throw fault('EXPORT_LOUDNESS_UNAVAILABLE', 404);
      return freeze(value);
    }
    if (state.shutdownFailure) throw state.shutdownFailure;
    if (input.expectedArtifactSha256 !== initial.asset.sha256) return report('stale', 'ARTIFACT_CHANGED');
    if (state.stopped || ownerSignal?.aborted) return report('incomplete', 'SHUTDOWN');
    if (context.signal?.aborted) return report('incomplete', 'CANCELLED');
    if (initial.asset.sizeBytes > EXPORT_LOUDNESS_LIMITS.inputBytes) return report('unsupported', 'INPUT_TOO_LARGE');
    if (initial.durationSeconds > EXPORT_LOUDNESS_LIMITS.durationSeconds) return report('unsupported', 'DURATION_LIMIT');
    if (state.active) return report('incomplete', 'BUSY');
    const controller = new AbortController();
    const signals = [controller.signal, ownerSignal, context.signal].filter((signal): signal is AbortSignal => signal !== undefined);
    // Unique attempt signal scopes cleanup to this advisory operation only.
    const signal = AbortSignal.any(signals);
    let timedOut = false, fencedFailure: unknown, expected: ExportLoudnessFileIdentity | undefined;
    const remainingMs = (): number => Math.max(0, EXPORT_LOUDNESS_LIMITS.timeoutMs - (performance.now() - started));
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, remainingMs());
    const entry: ExportAudioObservationEntry = {controller, signal, task: Promise.resolve()};
    state.active = entry;
    const fence = (): void => {
      try {
        const latest = current(input);
        if (latest.identity.identityDigest !== initial.identity.identityDigest) throw fault('LOUDNESS_ARTIFACT_CHANGED');
        checkpoint(signal);
        if (remainingMs() <= 0) {timedOut = true; controller.abort(); checkpoint(signal);}
        if (expected) {
          const source = runtime.validateSource(store.root, initial.asset, {maxBytes: EXPORT_LOUDNESS_LIMITS.inputBytes});
          if (source.info.size !== initial.asset.sizeBytes || !sameFile(source.info, expected)) throw fault('LOUDNESS_ARTIFACT_CHANGED');
        }
      } catch (error) {fencedFailure ??= error; throw fencedFailure;}
    };
    const onBytes = (bytes: number): void => {
      fence();
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytesHashed + bytes > EXPORT_LOUDNESS_LIMITS.totalHashedBytes ||
          bytesHashed + bytes > initial.asset.sizeBytes * 2) {fencedFailure ??= fault('LOUDNESS_BUDGET'); throw fencedFailure;}
      bytesHashed += bytes;
    };
    const hash = async (): Promise<{sha256: string; info: ExportLoudnessFileIdentity; file: string}> => {
      fence();
      if (!expected) throw fault('LOUDNESS_ARTIFACT_CHANGED');
      const value = await runtime.hash(store.root, initial.asset, {signal, expected, maxBytes: EXPORT_LOUDNESS_LIMITS.inputBytes, onBytes, beforeEffect: fence});
      fence();
      if (!object(value) || typeof value.sha256 !== 'string' || value.sha256 !== initial.asset.sha256 || value.sizeBytes !== initial.asset.sizeBytes ||
          typeof value.file !== 'string' || !fileIdentity(value.info) || !sameFile(value.info, expected)) throw fault('LOUDNESS_ARTIFACT_CHANGED');
      const source = runtime.validateSource(store.root, initial.asset, {maxBytes: EXPORT_LOUDNESS_LIMITS.inputBytes});
      if (source.file !== value.file) throw fault('LOUDNESS_ARTIFACT_CHANGED');
      return {sha256: value.sha256, info: value.info, file: value.file};
    };
    async function prepare(): Promise<ExportLoudnessMeasurement | null> {
      fence();
      const source = runtime.validateSource(store.root, initial.asset, {maxBytes: EXPORT_LOUDNESS_LIMITS.inputBytes});
      if (!fileIdentity(source.info) || source.info.size !== initial.asset.sizeBytes) throw fault('LOUDNESS_ARTIFACT_CHANGED');
      expected = Object.freeze({dev: source.info.dev, ino: source.info.ino, size: source.info.size, mtimeMs: source.info.mtimeMs, ctimeMs: source.info.ctimeMs});
      fence();
      const first = await hash(); fence();
      let decoded: unknown;
      try {decoded = await runtime.decode(first.file, initial.durationSeconds, {signal, beforeEffect: fence, remainingMs});}
      catch (error) {
        // Absence of an audio stream is not digital silence. It still needs
        // the post-probe byte pass before it can be reported for this file.
        if (codeOf(error) !== 'LOUDNESS_NO_AUDIO' || unconfirmed(error)) throw error;
        fence();
        const second = await hash(); fence();
        if (second.sha256 !== first.sha256 || !sameFile(second.info, first.info) || bytesHashed !== initial.asset.sizeBytes * 2)
          throw fault('LOUDNESS_ARTIFACT_CHANGED');
        return null;
      }
      fence();
      // An injected decoder is no authority. Validate every mathematical and
      // format relationship independently before running the second byte pass.
      const measurement = exportLoudnessMeasurementSchema.safeParse(decoded);
      if (!measurement.success || !isExportSamplePeakFrameCountCompatible(measurement.data.sampleFrames, initial.outputFrames))
        throw fault('LOUDNESS_INVALID_PCM');
      const second = await hash(); fence();
      if (second.sha256 !== first.sha256 || !sameFile(second.info, first.info) || bytesHashed !== initial.asset.sizeBytes * 2)
        throw fault('LOUDNESS_ARTIFACT_CHANGED');
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
          state.shutdownFailure = unconfirmed(error) ? Object.assign(fault('MEDIA_TERMINATION_UNCONFIRMED', 503), {terminationUnconfirmed: true}) : fault('EXPORT_LOUDNESS_SHUTDOWN_FAILED', 503);
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
      if (measurement === null) return report('unsupported', 'NO_AUDIO');
      const value = {...input, checkedAt: new Date().toISOString(), stage: 'decoded-export-file', status: 'ready',
        artifact: initial.artifact, measurement, suggestion: exportLoudnessSuggestion(measurement, input.target), reason: null,
        checks: {bytesHashed, audioFullyDecoded: true}};
      if (!isExportLoudnessResponse(value, input)) throw fault('LOUDNESS_INVALID_PCM');
      return freeze(value);
    } catch (error) {
      // Final identity is checked even when a failed decoder never returned
      // through its post-await fence. Byte/path drift also invalidates failure.
      try {fence();} catch { /* The first fence failure is retained separately. */ }
      current(input);
      if (unconfirmed(error) || state.shutdownFailure) throw state.shutdownFailure ?? error;
      if (codeOf(fencedFailure) === 'EXPORT_LOUDNESS_UNAVAILABLE' || codeOf(fencedFailure) === 'EXPORT_LOUDNESS_OWNER_REQUIRED') throw fencedFailure;
      if (timedOut) return report('incomplete', 'TIMEOUT');
      if (state.stopped || ownerSignal?.aborted) return report('incomplete', 'SHUTDOWN');
      const classified = classify(fencedFailure ?? error);
      return report(classified.status, classified.code);
    } finally {clearTimeout(timer); controller.abort();}
  }
  async function drain(): Promise<void> {
    stop();
    try {await runtime.boundedShutdown(Promise.allSettled(state.active ? [state.active.task] : []), 'EXPORT_LOUDNESS_STOP_TIMEOUT');}
    finally {ownerSignal?.removeEventListener('abort', stop);}
    if (state.shutdownFailure) throw state.shutdownFailure;
  }
  return {handlers: {'timeline.export.loudness': loudness}, drain};
}
