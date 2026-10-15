import { translate } from '../../../packages/i18n/src/index.ts';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { timelineRenderDeliveryFields } from '@mioon/contracts/timeline-delivery';
import { isExportSamplePeakResponse, isExportSamplePeakFrameCountCompatible, exportSamplePeakReason } from '@mioon/contracts/export-sample-peak';
import type { ExportSamplePeakInput, ExportSamplePeakResponse, ExportSamplePeakArtifact } from '@mioon/contracts/export-sample-peak';

export const EXPORT_SAMPLE_PEAK_LABEL = '已导出文件解码样本峰值';
export const EXPORT_SAMPLE_PEAK_LIMITATION = '仅检查成片样本，不是响度或真峰值，也不能证明源音频或混音未削波。';
export const EXPORT_SAMPLE_PEAK_RESTORED = '恢复分支暂不支持已导出文件解码样本峰值检查。';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export interface ExportSamplePeakTarget {
  readonly exportId: string;
  readonly key: string;
  readonly outputFrames: number;
  readonly artifact: Readonly<ExportSamplePeakArtifact>;
}
export interface ExportSamplePeakContext {
  readonly scope: string | null;
  readonly projectId: string | null;
  readonly executionScope: string;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly restored: boolean;
  readonly exports: readonly unknown[];
  readonly assets: readonly unknown[];
}
export type ExportSamplePeakPhase = 'idle' | 'checking' | 'ready' | 'unsupported' | 'incomplete' | 'stale' | 'error' | 'cancelled';
export interface ExportSamplePeakState {
  readonly scope: string | null;
  readonly projectId: string | null;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly restored: boolean;
  readonly targets: readonly ExportSamplePeakTarget[];
  readonly targetId: string | null;
  readonly targetKey: string | null;
  readonly phase: ExportSamplePeakPhase;
  readonly executionScope: string;
  readonly report: ExportSamplePeakResponse | null;
  readonly error: string;
  readonly errorCode?: string;
}
export interface ExportSamplePeakReadOptions { readonly signal: AbortSignal; readonly expectedWorkspaceOrigin?: string }
export interface ExportSamplePeakControllerOptions {
  read: (input: ExportSamplePeakInput, options: ExportSamplePeakReadOptions) => Promise<unknown>;
  isRenderRecord: (value: unknown, input: unknown) => boolean;
  getContext?: () => ExportSamplePeakContext;
  getInvocation?: () => Readonly<{ expectedWorkspaceOrigin?: string }>;
  onChange?: (state: ExportSamplePeakState) => void;
  onUnauthorized?: () => void;
}

/** Public rows are observations, never media authority. Reuse the complete
 * render-record validator, then bind the output to its owned public asset. */
export function exportSamplePeakTargets(context: ExportSamplePeakContext, isRenderRecord: ExportSamplePeakControllerOptions['isRenderRecord']): readonly ExportSamplePeakTarget[] {
  if (!uuid(context.projectId)) return [];
  const rows = context.exports.filter(object), assets = context.assets.filter(object);
  const targets: ExportSamplePeakTarget[] = [];
  for (const row of rows) {
    if (!uuid(row.id) || !uuid(row.assetId) || row.projectId !== context.projectId || row.mode !== 'timeline' || row.purpose !== 'export' ||
        row.status !== 'succeeded' || row.error !== null || row.url !== `/media/${row.assetId}` || !positive(row.timelineRevision) || !object(row.snapshot) || !object(row.snapshot.timeline) || !positive(row.snapshot.timeline.durationFrames) ||
        rows.filter(candidate => candidate.id === row.id).length !== 1) continue;
    const matching = assets.filter(asset => asset.id === row.assetId);
    const asset = matching.length === 1 ? matching[0] : undefined;
    if (!asset || asset.projectId !== context.projectId || asset.url !== row.url || asset.mimeType !== 'video/mp4' || asset.provenance !== 'export' ||
        typeof asset.sha256 !== 'string' || asset.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(asset.sha256) || !positive(asset.sizeBytes)) continue;
    try {
      const fields = timelineRenderDeliveryFields(row.snapshot);
      if (!isRenderRecord(row, { projectId: context.projectId, expectedRevision: row.timelineRevision, requestId: row.requestId, purpose: 'export', ...fields })) continue;
      const artifact: ExportSamplePeakArtifact = { assetId: row.assetId, sha256: asset.sha256, sizeBytes: asset.sizeBytes, timelineRevision: row.timelineRevision,
        ...(fields.deliveryName === undefined ? {} : { deliveryName: fields.deliveryName }),
        ...(fields.exportRange === undefined ? {} : { exportRange: Object.freeze({ ...fields.exportRange }) }) };
      const outputFrames = fields.exportRange ? fields.exportRange.endFrame - fields.exportRange.startFrame : row.snapshot.timeline.durationFrames;
      targets.push(Object.freeze({ exportId: row.id, key: canonical([row, asset]), outputFrames, artifact: Object.freeze(artifact) }));
    } catch { /* Malformed frozen rows never get an analysis action. */ }
  }
  return Object.freeze(targets);
}

/** Mask a render that precedes the layout-effect update. A replaced output or
 * A→B→A owner cannot flash the old checked result even for one render. */
export function exportSamplePeakViewState(state: ExportSamplePeakState, context: ExportSamplePeakContext, isRenderRecord: ExportSamplePeakControllerOptions['isRenderRecord']): ExportSamplePeakState {
  const targets = exportSamplePeakTargets(context, isRenderRecord);
  const sameOwner = state.scope === context.scope && state.projectId === context.projectId;
  const target = sameOwner ? targets.find(item => item.exportId === state.targetId) : undefined;
  const sameTarget = state.targetId === null || target?.key === state.targetKey;
  const sameExecution = state.executionScope === context.executionScope && state.visible === context.visible && state.connected === context.connected && state.restored === context.restored;
  if (sameOwner && sameTarget && sameExecution && canonical(targets.map(item => item.key)) === canonical(state.targets.map(item => item.key))) return state;
  const retain = sameOwner && sameTarget && context.connected && !context.restored && (state.phase !== 'checking' || sameExecution);
  const visibleState: ExportSamplePeakState = { ...state, scope: context.scope, projectId: context.projectId, executionScope: context.executionScope,
    connected: context.connected, visible: context.visible, restored: context.restored, targets,
    ...(retain ? {} : { report: null, error: '', targetId: target?.exportId ?? null, targetKey: target?.key ?? null,
      phase: target ? sameTarget ? 'cancelled' : 'stale' : 'idle' }) };
  return Object.freeze(visibleState);
}

export function exportSamplePeakErrorMessage(error: unknown, locale: Locale = 'zh-Hans'): string {
  const code = object(error) ? error.code : null;
  if (code === 'UNAUTHORIZED') return translate(locale, 'audio.loudness.peak.unauthorized');
  if (code === 'RESTORE_OPERATION_UNAVAILABLE') return translate(locale, 'audio.loudness.peak.restored');
  if (code === 'BACKEND_PROTOCOL_ERROR') return translate(locale, 'audio.loudness.peak.protocol');
  return translate(locale, 'audio.loudness.peak.failed');
}
export function exportSamplePeakStatusMessage(state: ExportSamplePeakState, locale: Locale = 'zh-Hans'): string {
  if (state.phase === 'checking') return translate(locale, 'audio.loudness.peak.checking');
  if (state.phase === 'cancelled') return translate(locale, 'audio.loudness.peak.cancelled');
  if (state.error) return exportSamplePeakErrorMessage({ code: state.errorCode }, locale);
  if (state.report?.reason) return translate(locale, `audio.loudness.peak.reason.${state.report.reason.code}`);
  if (state.phase === 'stale') return translate(locale, 'audio.loudness.peak.stale');
  return '';
}
const initial = (): ExportSamplePeakState => ({ scope: null, projectId: null, connected: false, visible: false, restored: false, targets: [], targetId: null, targetKey: null, phase: 'idle', executionScope: '', report: null, error: '' });
function freezeObservation(value: unknown): void {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freezeObservation); Object.freeze(value); }
}
const protocolError = () => Object.assign(new Error('Invalid export sample peak response'), { code: 'BACKEND_PROTOCOL_ERROR' });

/** One explicit observer, no queue, retries, persistence, render or navigation. */
export function createExportSamplePeakController({ read, isRenderRecord, getContext, getInvocation = () => ({}), onChange = () => {}, onUnauthorized = () => {} }: ExportSamplePeakControllerOptions) {
  let state = initial(), generation = 0, disposed = false;
  let active: AbortController | null = null;
  const emit = (patch: Partial<ExportSamplePeakState>) => { state = Object.freeze({ ...state, ...patch }); onChange(state); };
  const invalidate = () => { generation++; active?.abort(); active = null; };
  const sync = () => { if (!disposed && getContext) controller.setContext(getContext()); };
  const current = (attempt: number, target: ExportSamplePeakTarget, scope: string | null): boolean => {
    sync();
    return !disposed && generation === attempt && state.scope === scope && state.connected && state.visible && !state.restored &&
      state.targetId === target.exportId && state.targetKey === target.key && active !== null && !active.signal.aborted;
  };
  const controller = {
    getState: (): ExportSamplePeakState => state,
    attach(context: ExportSamplePeakContext): void { disposed = false; controller.setContext(context); },
    setContext(context: ExportSamplePeakContext): void {
      if (disposed) return;
      const targets = exportSamplePeakTargets(context, isRenderRecord);
      const ownerChanged = context.scope !== state.scope || context.projectId !== state.projectId;
      const target = targets.find(item => item.exportId === state.targetId);
      const targetChanged = state.targetId !== null && target?.key !== state.targetKey;
      const executionChanged = context.executionScope !== state.executionScope || context.connected !== state.connected || context.visible !== state.visible || context.restored !== state.restored;
      const targetsChanged = canonical(targets.map(item => [item.exportId, item.key])) !== canonical(state.targets.map(item => [item.exportId, item.key]));
      if (!ownerChanged && !executionChanged && !targetsChanged) return;
      const wasChecking = state.phase === 'checking';
      if (ownerChanged || targetChanged || executionChanged) invalidate();
      const clear = ownerChanged || targetChanged || !context.connected || context.restored;
      emit({ scope: context.scope, projectId: context.projectId, executionScope: context.executionScope, connected: context.connected, visible: context.visible, restored: context.restored, targets,
        ...(clear ? { report: null, error: '', targetId: ownerChanged || !target ? null : target.exportId, targetKey: ownerChanged || !target ? null : target.key,
          phase: !ownerChanged && target ? 'stale' : 'idle' } : wasChecking && executionChanged ? { phase: 'cancelled', report: null, error: '' } : {}) });
    },
    async check(requestedTarget: ExportSamplePeakTarget, scope: string | null): Promise<ExportSamplePeakResponse | null> {
      sync();
      const target = state.targets.find(item => item.exportId === requestedTarget.exportId && item.key === requestedTarget.key);
      if (disposed || active || !state.projectId || !state.scope || scope !== state.scope || !state.connected || !state.visible || state.restored ||
          !target) return null;
      const attempt = ++generation, abort = new AbortController(); active = abort;
      const input = { projectId: state.projectId, exportId: target.exportId };
      emit({ targetId: target.exportId, targetKey: target.key, phase: 'checking', report: null, error: '' });
      try {
        const invocation = getInvocation();
        if (!current(attempt, target, scope)) return null;
        const result = await read(input, { ...invocation, signal: abort.signal });
        if (!current(attempt, target, scope)) return null;
        if (!isExportSamplePeakResponse(result, input) || result.status === 'ready' && (canonical(result.artifact) !== canonical(target.artifact) || !isExportSamplePeakFrameCountCompatible(result.measurement.sampleFrames, target.outputFrames))) throw protocolError();
        const report = structuredClone(result); freezeObservation(report);
        emit({ phase: report.status, report, error: '' });
        return report;
      } catch (error: unknown) {
        if (!current(attempt, target, scope)) return null;
        emit({ phase: 'error', report: null, error: exportSamplePeakErrorMessage(error), errorCode: object(error) && typeof error.code === 'string' ? error.code : '' });
        if (object(error) && error.code === 'UNAUTHORIZED') onUnauthorized();
        return null;
      } finally { if (active === abort) active = null; }
    },
    cancel(): void {
      sync();
      if (!active) return;
      invalidate(); emit({ phase: 'cancelled', report: null, error: '' });
    },
    dispose(): void { invalidate(); disposed = true; state = initial(); },
  };
  return controller;
}
export type ExportSamplePeakController = ReturnType<typeof createExportSamplePeakController>;
export interface ExportSamplePeakView { readonly state: ExportSamplePeakState; readonly controller: ExportSamplePeakController }
