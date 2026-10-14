import { EXPORT_LOUDNESS_PROFILE, isExportLoudnessResponse, exportLoudnessReason } from '@mioon/contracts/export-loudness';
import type { ExportLoudnessInput, ExportLoudnessResponse, ExportLoudnessTarget } from '@mioon/contracts/export-loudness';
import { isExportSamplePeakFrameCountCompatible } from '@mioon/contracts/export-sample-peak';
import { exportSamplePeakTargets } from './export-sample-peak-state.ts';
import type { ExportSamplePeakContext, ExportSamplePeakTarget, ExportSamplePeakReadOptions } from './export-sample-peak-state.ts';

export const EXPORT_LOUDNESS_LABEL = '已导出文件响度与真峰值';
export const EXPORT_LOUDNESS_LIMITATION = '仅对此导出文件作估算，不是标准认证、无削波证明或再次 AAC 编码的保证。建议不会修改音量。';
export const EXPORT_LOUDNESS_RESTORED = '恢复分支暂不支持已导出文件响度与真峰值测量。';
export type ExportLoudnessContext = ExportSamplePeakContext;
export type ExportLoudnessFileTarget = ExportSamplePeakTarget;
export interface ExportLoudnessDraft { readonly integratedLufs: string; readonly truePeakCeilingDbtp: string }
const blankDraft = (): ExportLoudnessDraft => Object.freeze({ integratedLufs: '', truePeakCeilingDbtp: '' });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

/** Empty fields request measurement alone; no platform target is assumed. */
export function parseExportLoudnessTarget(draft: ExportLoudnessDraft): Readonly<{ target?: ExportLoudnessTarget; error: string }> {
  const lufs = draft.integratedLufs.trim(), peak = draft.truePeakCeilingDbtp.trim();
  if (!lufs && !peak) return { error: '' };
  if (!lufs || !peak) return { error: '请同时填写目标响度和真峰值上限，或将两项都留空以仅测量。' };
  const decimal = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/u;
  const integratedLufs = Number(lufs), truePeakCeilingDbtp = Number(peak);
  if (!decimal.test(lufs) || !Number.isFinite(integratedLufs) || integratedLufs < -60 || integratedLufs > -5)
    return { error: '目标响度须为 −60 至 −5 LUFS 的有限数值。' };
  if (!decimal.test(peak) || !Number.isFinite(truePeakCeilingDbtp) || truePeakCeilingDbtp < -20 || truePeakCeilingDbtp > 0)
    return { error: '真峰值上限须为 −20 至 0 dBTP 的有限数值。' };
  return { target: Object.freeze({ integratedLufs, truePeakCeilingDbtp }), error: '' };
}
export type ExportLoudnessPhase = 'idle' | 'measuring' | 'ready' | 'unsupported' | 'incomplete' | 'stale' | 'error' | 'cancelled';
export interface ExportLoudnessState {
  readonly scope: string | null;
  readonly projectId: string | null;
  readonly executionScope: string;
  readonly connected: boolean;
  readonly visible: boolean;
  readonly restored: boolean;
  readonly targets: readonly ExportLoudnessFileTarget[];
  readonly targetId: string | null;
  readonly targetKey: string | null;
  readonly draft: ExportLoudnessDraft;
  readonly draftVersion: number;
  readonly phase: ExportLoudnessPhase;
  readonly report: ExportLoudnessResponse | null;
  readonly error: string;
}
export interface ExportLoudnessControllerOptions {
  read: (input: ExportLoudnessInput, options: ExportSamplePeakReadOptions) => Promise<unknown>;
  isRenderRecord: (value: unknown, input: unknown) => boolean;
  getContext?: () => ExportLoudnessContext;
  getInvocation?: () => Readonly<{ expectedWorkspaceOrigin?: string }>;
  onChange?: (state: ExportLoudnessState) => void;
  onUnauthorized?: () => void;
}
export const exportLoudnessTargets = exportSamplePeakTargets;
const initial = (): ExportLoudnessState => ({ scope: null, projectId: null, executionScope: '', connected: false, visible: false, restored: false,
  targets: [], targetId: null, targetKey: null, draft: blankDraft(), draftVersion: 0, phase: 'idle', report: null, error: '' });

/** Project/file changes must not flash the previous report before layout effects. */
export function exportLoudnessViewState(state: ExportLoudnessState, context: ExportLoudnessContext, isRenderRecord: ExportLoudnessControllerOptions['isRenderRecord']): ExportLoudnessState {
  const targets = exportLoudnessTargets(context, isRenderRecord);
  const sameOwner = state.scope === context.scope && state.projectId === context.projectId;
  const target = sameOwner ? targets.find(item => item.exportId === state.targetId) : undefined;
  const sameTarget = state.targetId === null || target?.key === state.targetKey;
  const sameExecution = state.executionScope === context.executionScope && state.visible === context.visible && state.connected === context.connected && state.restored === context.restored;
  if (sameOwner && sameTarget && sameExecution && canonical(targets.map(item => item.key)) === canonical(state.targets.map(item => item.key))) return state;
  const clear = !sameOwner || !sameTarget || !context.connected || context.restored;
  return Object.freeze({ ...state, scope: context.scope, projectId: context.projectId, executionScope: context.executionScope,
    connected: context.connected, visible: context.visible, restored: context.restored, targets,
    ...(clear ? { draft: blankDraft(), draftVersion: state.draftVersion + 1, report: null, error: '', targetId: target?.exportId ?? null,
      targetKey: target?.key ?? null, phase: target ? 'stale' : 'idle' } : state.phase === 'measuring' && !sameExecution ? { report: null, error: '', phase: 'cancelled' } : {}) });
}
export function exportLoudnessErrorMessage(error: unknown): string {
  const code = object(error) ? error.code : null;
  if (code === 'UNAUTHORIZED') return '会话已过期，请重新登录后明确重新测量。';
  if (code === 'RESTORE_OPERATION_UNAVAILABLE') return EXPORT_LOUDNESS_RESTORED;
  if (code === 'BACKEND_PROTOCOL_ERROR') return '测量响应不完整或与此导出文件、目标不匹配，请重新测量。';
  return '测量未完成，请确认连接后重新测量。';
}
export function exportLoudnessStatusMessage(state: ExportLoudnessState): string {
  if (state.phase === 'measuring') return '正在测量此已导出文件的响度与真峰值…';
  if (state.phase === 'cancelled') return '本次测量观察已取消，需要时请明确重新测量。';
  if (state.error) return state.error;
  if (state.report?.reason) return exportLoudnessReason(state.report.reason.code).message;
  if (state.phase === 'stale') return '导出文件记录已变化，请重新测量。';
  return '';
}
function freezeObservation(value: unknown): void {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freezeObservation); Object.freeze(value); }
}
const protocolError = () => Object.assign(new Error('Invalid export loudness response'), { code: 'BACKEND_PROTOCOL_ERROR' });

/** Explicit read-only observation. No queue, automatic retry, persistence or gain mutation. */
export function createExportLoudnessController({ read, isRenderRecord, getContext, getInvocation = () => ({}), onChange = () => {}, onUnauthorized = () => {} }: ExportLoudnessControllerOptions) {
  let state = initial(), generation = 0, disposed = false;
  let active: AbortController | null = null;
  const emit = (patch: Partial<ExportLoudnessState>) => { state = Object.freeze({ ...state, ...patch }); onChange(state); };
  const invalidate = () => { generation++; active?.abort(); active = null; };
  const sync = () => { if (!disposed && getContext) controller.setContext(getContext()); };
  const allowed = (requested: ExportLoudnessFileTarget, scope: string | null, version: number) => {
    sync();
    if (disposed || !state.projectId || !state.scope || scope !== state.scope || version !== state.draftVersion || !state.connected || !state.visible || state.restored) return undefined;
    return state.targets.find(item => item.exportId === requested.exportId && item.key === requested.key);
  };
  const current = (attempt: number, target: ExportLoudnessFileTarget, scope: string | null, version: number): boolean => {
    sync();
    return !disposed && generation === attempt && state.scope === scope && state.draftVersion === version && state.connected && state.visible && !state.restored &&
      state.targetId === target.exportId && state.targetKey === target.key && active !== null && !active.signal.aborted;
  };
  const controller = {
    getState: (): ExportLoudnessState => state,
    attach(context: ExportLoudnessContext): void { disposed = false; controller.setContext(context); },
    setContext(context: ExportLoudnessContext): void {
      if (disposed) return;
      const targets = exportLoudnessTargets(context, isRenderRecord);
      const ownerChanged = context.scope !== state.scope || context.projectId !== state.projectId;
      const target = targets.find(item => item.exportId === state.targetId);
      const targetChanged = state.targetId !== null && target?.key !== state.targetKey;
      const executionChanged = context.executionScope !== state.executionScope || context.connected !== state.connected || context.visible !== state.visible || context.restored !== state.restored;
      const targetsChanged = canonical(targets.map(item => item.key)) !== canonical(state.targets.map(item => item.key));
      if (!ownerChanged && !executionChanged && !targetsChanged) return;
      const wasMeasuring = state.phase === 'measuring';
      if (ownerChanged || targetChanged || executionChanged) invalidate();
      const clear = ownerChanged || targetChanged || !context.connected || context.restored;
      emit({ scope: context.scope, projectId: context.projectId, executionScope: context.executionScope, connected: context.connected, visible: context.visible, restored: context.restored, targets,
        ...(clear ? { draft: blankDraft(), draftVersion: state.draftVersion + 1, report: null, error: '', targetId: ownerChanged || !target ? null : target.exportId,
          targetKey: ownerChanged || !target ? null : target.key, phase: !ownerChanged && target ? 'stale' : 'idle' }
          : wasMeasuring && executionChanged ? { phase: 'cancelled', report: null, error: '' } : {}) });
    },
    setDraft(requested: ExportLoudnessFileTarget, scope: string | null, draft: ExportLoudnessDraft, version: number): boolean {
      const target = allowed(requested, scope, version);
      if (!target || typeof draft.integratedLufs !== 'string' || typeof draft.truePeakCeilingDbtp !== 'string' || draft.integratedLufs.length > 32 || draft.truePeakCeilingDbtp.length > 32) return false;
      if (state.targetKey === target.key && canonical(draft) === canonical(state.draft)) return true;
      invalidate();
      emit({ targetId: target.exportId, targetKey: target.key, draft: Object.freeze({ integratedLufs: draft.integratedLufs, truePeakCeilingDbtp: draft.truePeakCeilingDbtp }),
        draftVersion: state.draftVersion + 1, phase: 'idle', report: null, error: '' });
      return true;
    },
    async measure(requested: ExportLoudnessFileTarget, scope: string | null, version: number): Promise<ExportLoudnessResponse | null> {
      const target = allowed(requested, scope, version);
      if (!target || active || !state.projectId) return null;
      const draft = state.targetKey === target.key ? state.draft : blankDraft(), parsed = parseExportLoudnessTarget(draft);
      if (parsed.error) return null;
      const input: ExportLoudnessInput = Object.freeze({ projectId: state.projectId, exportId: target.exportId, expectedArtifactSha256: target.artifact.sha256,
        measurementProfile: EXPORT_LOUDNESS_PROFILE, ...(parsed.target ? { target: parsed.target } : {}) });
      const attempt = ++generation, capturedVersion = state.draftVersion + 1, abort = new AbortController(); active = abort;
      emit({ targetId: target.exportId, targetKey: target.key, draft, draftVersion: capturedVersion, phase: 'measuring', report: null, error: '' });
      try {
        const invocation = getInvocation();
        if (!current(attempt, target, scope, capturedVersion)) return null;
        const result = await read(input, { ...invocation, signal: abort.signal });
        if (!current(attempt, target, scope, capturedVersion)) return null;
        if (!isExportLoudnessResponse(result, input)) throw protocolError();
        if (result.status === 'ready') {
          // The backend digest includes private snapshot material. The renderer binds
          // public artifact fields and its complete captured row, without certifying that digest.
          const { snapshotSha256, ...artifact } = result.artifact;
          if (!snapshotSha256 || canonical(artifact) !== canonical(target.artifact) || !isExportSamplePeakFrameCountCompatible(result.measurement.sampleFrames, target.outputFrames)) throw protocolError();
        }
        const report = structuredClone(result); freezeObservation(report);
        emit({ phase: report.status, report, error: '' });
        return report;
      } catch (error: unknown) {
        if (!current(attempt, target, scope, capturedVersion)) return null;
        emit({ phase: 'error', report: null, error: exportLoudnessErrorMessage(error) });
        if (object(error) && error.code === 'UNAUTHORIZED') onUnauthorized();
        return null;
      } finally { if (active === abort) active = null; }
    },
    cancel(requested: ExportLoudnessFileTarget, scope: string | null, version: number): void {
      const target = allowed(requested, scope, version);
      if (target && active && target.key === state.targetKey) { invalidate(); emit({ phase: 'cancelled', report: null, error: '' }); }
    },
    dispose(): void { invalidate(); disposed = true; state = initial(); },
  };
  return controller;
}
export type ExportLoudnessController = ReturnType<typeof createExportLoudnessController>;
export interface ExportLoudnessView { readonly state: ExportLoudnessState; readonly controller: ExportLoudnessController }
