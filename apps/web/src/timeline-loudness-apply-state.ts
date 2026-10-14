import { isTimelineLoudnessApplicableReport, isTimelineLoudnessApplyInput, timelineLoudnessCandidateDigest, TIMELINE_LOUDNESS_APPLY_OPERATION } from '@mioon/contracts/timeline-loudness-apply';
import type { TimelineLoudnessApplyInput } from '@mioon/contracts/timeline-loudness-apply';
import { parseTimelineMixLoudnessTarget, timelineMixLoudnessAvailable } from './timeline-mix-loudness-state.ts';
import type { TimelineMixLoudnessState } from './timeline-mix-loudness-state.ts';
import type { NativeCloseState } from './native-close-state.ts';

export const TIMELINE_LOUDNESS_APPLY_LIMITATION = '候选是整片编码前浮点混音，不是默认 v1 导出结果。应用只保存一组固定增益，可用一次撤销恢复；不会自动选择 v2 或导出，也不保证输出响度或 AAC 真峰值。需要明确选择浮点检查 v2 导出，再测量实际成片。';
export type TimelineLoudnessApplyPhase = 'idle' | 'digesting' | 'confirming' | 'submitting' | 'unknown' | 'applied' | 'stale' | 'error';
export interface TimelineLoudnessApplyIntent {
  readonly operation: typeof TIMELINE_LOUDNESS_APPLY_OPERATION;
  readonly scope: string;
  readonly timelineId: string;
  readonly sourceIdentity: string;
  readonly executionScope: string;
  readonly input: TimelineLoudnessApplyInput;
}
export interface TimelineLoudnessApplyOutcome { readonly status: 'applied' | 'unknown' | 'rejected'; readonly error?: unknown }
export interface TimelineLoudnessApplyState {
  readonly phase: TimelineLoudnessApplyPhase;
  readonly version: number;
  readonly scope: string | null;
  readonly projectId: string | null;
  readonly requestId: string | null;
  readonly observationVersion: number | null;
  readonly error: string;
}
export interface TimelineLoudnessApplyControllerOptions {
  readonly getObservation: () => TimelineMixLoudnessState;
  /** Stable workspace identity, independent of the transient project/view epoch. */
  readonly getRecoveryScope?: () => string | null;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly createRequestId: () => string;
  readonly submit: (intent: TimelineLoudnessApplyIntent, canExecute: (preparedTask?: unknown) => boolean) => Promise<TimelineLoudnessApplyOutcome>;
  readonly digest?: (report: unknown) => Promise<string>;
  readonly onChange?: (state: TimelineLoudnessApplyState) => void;
  readonly onCloseChange?: (state: NativeCloseState) => void;
}
const identityKeys = ['scope', 'executionScope', 'projectId', 'timelineId', 'revision', 'durationFrames', 'sourceIdentity', 'connected', 'visible', 'restored', 'hasUnsavedDrafts'] as const;
const sameOwner = (a: { readonly scope: string | null; readonly projectId: string | null }, b: TimelineMixLoudnessState): boolean => a.scope === b.scope && a.projectId === b.projectId;
function sameBinding(a: TimelineMixLoudnessState, b: TimelineMixLoudnessState): boolean {
  return identityKeys.every(key => a[key] === b[key]) && a.draft.integratedLufs === b.draft.integratedLufs && a.draft.truePeakCeilingDbtp === b.draft.truePeakCeilingDbtp;
}
export function timelineLoudnessCanReview(observation: TimelineMixLoudnessState): boolean {
  const report = observation.report, target = parseTimelineMixLoudnessTarget(observation.draft).target;
  return timelineMixLoudnessAvailable(observation) && observation.phase === 'ready' && isTimelineLoudnessApplicableReport(report) &&
    report.projectId === observation.projectId && report.expectedRevision === observation.revision &&
    report.identity.timelineId === observation.timelineId && report.identity.range.endFrame === observation.durationFrames &&
    report.target.integratedLufs === target?.integratedLufs && report.target.truePeakCeilingDbtp === target?.truePeakCeilingDbtp;
}
/** The existing durable controller supplies its already-validated prepared task.
 * Bind the task identity as well as every original scalar before accepting the
 * pending fence caused by this request; an unrelated pending task is insufficient. */
export function timelineLoudnessPreparedTaskIdentity(value: unknown, input: TimelineLoudnessApplyInput): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>, exact = task.input;
  if (typeof task.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(task.id) ||
    typeof task.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(task.digest) || task.operation !== TIMELINE_LOUDNESS_APPLY_OPERATION ||
    task.projectId !== input.projectId || task.requestId !== input.requestId || !isTimelineLoudnessApplyInput(exact)) return null;
  const keys = ['projectId', 'expectedRevision', 'requestId', 'mixProfile', 'measurementProfile', 'snapshotSha256', 'candidateDigest'] as const;
  return keys.every(key => exact[key] === input[key]) && exact.target.integratedLufs === input.target.integratedLufs &&
    exact.target.truePeakCeilingDbtp === input.target.truePeakCeilingDbtp ? `${task.id}:${task.digest}` : null;
}
const codeOf = (error: unknown): string => error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
export function timelineLoudnessApplyErrorMessage(error: unknown): string {
  const code = codeOf(error);
  if (['TIMELINE_LOUDNESS_APPLY_STALE', 'TIMELINE_MIX_LOUDNESS_STALE', 'TIMELINE_MIX_LOUDNESS_REVISION_CONFLICT', 'TIMELINE_REVISION_CONFLICT'].includes(code)) return '时间线、来源字节或候选已变化。原报告不能再应用，请重新准备并核对候选。';
  if (code === 'TIMELINE_LOUDNESS_APPLY_UNSAFE') return '重新测量的候选未同时满足两个目标，未修改增益。请重新准备并核对。';
  if (code === 'TIMELINE_LOUDNESS_APPLY_UNCHANGED') return '候选没有可保存的增益变化，请重新准备。';
  if (code.startsWith('RESTORE_')) return '恢复分支不能应用响度候选。';
  return '本次应用未完成。请先核对任务中心的原请求，再明确重新准备。';
}
interface PendingApply {
  readonly attempt: number;
  readonly scope: string;
  readonly input: TimelineLoudnessApplyInput;
  readonly recoveryScope: string;
  readonly observationVersion: number;
  phase: 'submitting' | 'unknown';
  preparedIdentity: string | null;
  preparedRevision: number | null;
}
/** Existing verified storage identity plus workspace branch, never a UI epoch.
 * Missing/blocked identity cannot certify a copied task from another database. */
export function timelineLoudnessApplyRecoveryScope(storageScope: unknown, originScope: unknown): string | null {
  if (typeof storageScope !== 'string' || !/^[a-f0-9]{64}$/u.test(storageScope) || typeof originScope !== 'string' ||
    !(originScope === 'normal' || /^restored:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(originScope))) return null;
  return JSON.stringify([storageScope, originScope]);
}
const recoveryIdentityUnavailable = '当前工作区身份尚未核验，未提交响度应用。请重新连接或重新载入当前工作区，完成身份核验后再重新准备并核对候选。';
const recoveryIdentityChanged = '工作区身份已变化或无法核验，本次确认已失效，未继续提交。请核验当前工作区身份后重新准备并核对候选。';
const initial = (version = 0): TimelineLoudnessApplyState => Object.freeze({ phase: 'idle', version, scope: null, projectId: null, requestId: null, observationVersion: null, error: '' });
/** Ephemeral human review only. Durable request creation, execution and recovery
 * belong to App's existing edit-task controller; never persist or replay here. */
export function createTimelineLoudnessApplyController(options: TimelineLoudnessApplyControllerOptions) {
  let state = initial(), epoch = 0, disposed = false;
  let capture: TimelineMixLoudnessState | null = null, captureRecoveryScope: string | null = null, revoked = false;
  // Renderer-local close evidence outlives a panel/project owner. Durable work
  // still belongs solely to the existing task controller; this map never reads,
  // persists, retries or executes it.
  const pending = new Map<number, PendingApply>();
  let visiblePending: PendingApply | null = null;
  let closeVersion = 1;
  let closeState: NativeCloseState = Object.freeze({ dirty: false, busy: false, blocked: false, version: closeVersion });
  const publishClose = (): void => {
    closeState = Object.freeze({ dirty: false,
      busy: ['digesting', 'confirming'].includes(state.phase) || [...pending.values()].some(value => value.phase === 'submitting'),
      blocked: pending.size > 0, version: ++closeVersion });
    if (!disposed) options.onCloseChange?.(closeState);
  };
  const emit = (patch: Partial<TimelineLoudnessApplyState>): void => {
    state = Object.freeze({ ...state, ...patch, version: state.version + 1 }); publishClose(); options.onChange?.(state);
  };
  const readRecoveryScope = (observation: TimelineMixLoudnessState): string | null => {
    try {
      const value = options.getRecoveryScope ? options.getRecoveryScope() : observation.scope;
      return typeof value === 'string' && value.length > 0 ? value : null;
    } catch { return null; }
  };
  const sync = (): TimelineMixLoudnessState => { const value = options.getObservation(); controller.setObservation(value); return value; };
  const current = (attempt: number, saved: TimelineMixLoudnessState, executing = false, exactPreparedTask = false): boolean => {
    const live = sync();
    if (disposed || revoked || attempt !== epoch || !sameBinding(saved, live)) return false;
    if (!executing) return saved.version === live.version && saved.report === live.report && timelineLoudnessCanReview(live);
    // Preparing this exact durable request sets the timeline's pending fence and
    // revokes the read-only observation. It does not invalidate its captured
    // human approval; every identity/target/navigation condition still must match.
    return live.pending ? exactPreparedTask && (live.report === saved.report || live.report === null && live.phase === 'stale') :
      saved.version === live.version && saved.report === live.report && timelineLoudnessCanReview(live);
  };
  const controller = {
    getState: (): TimelineLoudnessApplyState => state,
    // Pure cached metadata only: final beforeunload never synchronizes context.
    getCloseState: (): NativeCloseState => closeState,
    attach(): void { disposed = false; controller.setObservation(options.getObservation()); },
    setObservation(observation: TimelineMixLoudnessState): void {
      if (disposed) return;
      if (state.scope !== null && !sameOwner(state, observation)) {
        ++epoch; capture = null; revoked = true; visiblePending = null;
        emit(initial(state.version));
      }
      if (state.scope === null) {
        const retained = [...pending.values()].find(value => value.scope === observation.scope && value.input.projectId === observation.projectId);
        if (retained) {
          visiblePending = retained;
          emit({ phase: retained.phase, scope: retained.scope, projectId: retained.input.projectId,
            requestId: retained.input.requestId, observationVersion: retained.observationVersion, error: '' });
        }
      }
      if (!capture) return;
      const recoveryScopeChanged = readRecoveryScope(observation) !== captureRecoveryScope;
      if (state.phase === 'submitting') { if (recoveryScopeChanged || !sameBinding(capture, observation)) revoked = true; return; }
      if (['digesting', 'confirming'].includes(state.phase) && recoveryScopeChanged) {
        ++epoch; capture = null; captureRecoveryScope = null; revoked = true;
        emit({ phase: 'error', requestId: null, error: recoveryIdentityChanged }); return;
      }
      if (['digesting', 'confirming'].includes(state.phase) &&
        (!sameBinding(capture, observation) || capture.version !== observation.version || capture.report !== observation.report || !timelineLoudnessCanReview(observation))) {
        ++epoch; capture = null; revoked = true; emit({ phase: 'stale', requestId: null, error: '' });
      }
    },
    async review(expected: TimelineMixLoudnessState): Promise<TimelineLoudnessApplyOutcome | null> {
      const live = sync();
      if (disposed || ['digesting', 'confirming', 'submitting', 'unknown'].includes(state.phase) || expected.version !== live.version ||
        expected.report !== live.report || ['error', 'applied'].includes(state.phase) && state.observationVersion === live.version || !sameBinding(expected, live) || !timelineLoudnessCanReview(live) || !live.report || !live.scope || !live.timelineId) return null;
      const recoveryScope = readRecoveryScope(live);
      if (recoveryScope === null) {
        emit({ phase: 'error', scope: live.scope, projectId: live.projectId, requestId: null, observationVersion: live.version, error: recoveryIdentityUnavailable });
        return null;
      }
      const report = live.report, attempt = ++epoch; capture = live; captureRecoveryScope = recoveryScope; revoked = false;
      emit({ phase: 'digesting', scope: live.scope, projectId: live.projectId, requestId: null, observationVersion: live.version, error: '' });
      try {
        const candidateDigest = await (options.digest ?? timelineLoudnessCandidateDigest)(report);
        if (!current(attempt, live)) return null;
        const input: TimelineLoudnessApplyInput = Object.freeze({ projectId: report.projectId, expectedRevision: report.expectedRevision,
          requestId: options.createRequestId(), mixProfile: report.mixProfile, measurementProfile: report.measurementProfile,
          target: Object.freeze({ ...report.target }), snapshotSha256: report.identity.snapshotSha256, candidateDigest });
        if (!isTimelineLoudnessApplyInput(input) || report.candidate.status !== 'measured') throw new Error('Invalid application binding');
        const intent: TimelineLoudnessApplyIntent = Object.freeze({ operation: TIMELINE_LOUDNESS_APPLY_OPERATION, scope: live.scope,
          timelineId: live.timelineId, sourceIdentity: live.sourceIdentity, executionScope: live.executionScope, input });
        emit({ phase: 'confirming' });
        const approved = await options.confirm(`将 rev ${input.expectedRevision} 的 ${report.candidate.gains.length} 个可听片段作为一次编辑应用固定增益 ${report.candidate.requiredGainDb.toFixed(2)} dB（×${report.candidate.gainMultiplier.toFixed(4)}）？目标 ${input.target.integratedLufs} LUFS，真峰值上限 ${input.target.truePeakCeilingDbtp} dBTP，额外预留 0.5 dB。服务器会重新核验来源并完整测量；变化或不安全时不应用。${TIMELINE_LOUDNESS_APPLY_LIMITATION}`);
        if (!current(attempt, live)) return null;
        if (!approved) { capture = null; emit({ phase: 'idle', requestId: null }); return null; }
        const owner: PendingApply = { attempt, scope: live.scope, input, recoveryScope, observationVersion: live.version,
          phase: 'submitting', preparedIdentity: null, preparedRevision: null };
        pending.set(attempt, owner); visiblePending = owner;
        emit({ phase: 'submitting', requestId: input.requestId });
        const canExecute = (preparedTask?: unknown): boolean => {
          const binding = timelineLoudnessPreparedTaskIdentity(preparedTask, input);
          if (preparedTask !== undefined && (!binding || owner.preparedIdentity !== null && binding !== owner.preparedIdentity)) return false;
          if (binding && owner.preparedIdentity === null && pending.get(attempt) === owner) {
            owner.preparedIdentity = binding;
            const revision = (preparedTask as { readonly revision?: unknown }).revision;
            owner.preparedRevision = Number.isSafeInteger(revision) && (revision as number) > 0 ? revision as number : null;
            publishClose();
          }
          return current(attempt, live, true, binding !== null);
        };
        let outcome: TimelineLoudnessApplyOutcome;
        try { outcome = await options.submit(intent, canExecute); }
        catch (error) { outcome = { status: 'unknown', error }; }
        // An old completion can settle only its original pending owner, never
        // replace the current project's UI or release another apply's fence.
        if (pending.get(attempt) === owner) {
          if (outcome.status === 'unknown') owner.phase = 'unknown'; else pending.delete(attempt);
          publishClose();
        }
        if (disposed || visiblePending !== owner || !sameOwner(state, options.getObservation())) return outcome;
        capture = null;
        if (outcome.status !== 'unknown') visiblePending = null;
        emit({ phase: outcome.status === 'rejected' ? 'error' : outcome.status, error: outcome.status === 'rejected' ? timelineLoudnessApplyErrorMessage(outcome.error) : '' });
        return outcome;
      } catch (error) {
        if (current(attempt, live)) { capture = null; emit({ phase: 'error', error: timelineLoudnessApplyErrorMessage(error) }); }
        return null;
      }
    },
    revoke(): void {
      revoked = true;
      if (state.phase === 'submitting' || state.phase === 'unknown') return;
      ++epoch; capture = null;
      if (state.phase === 'digesting' || state.phase === 'confirming') emit({ phase: 'stale', requestId: null, error: '' });
    },
    recovered(task: unknown, recoveryScope: string | null): void {
      if (disposed || task === null || typeof task !== 'object' || Array.isArray(task)) return;
      const value = task as Record<string, unknown>;
      if (value.acknowledged !== true || !['applied', 'not_applied'].includes(value.status as string) ||
        !Number.isSafeInteger(value.revision) || (value.revision as number) < 2) return;
      const owners = [...pending.values()].filter(owner => {
        const identity = timelineLoudnessPreparedTaskIdentity(task, owner.input);
        return recoveryScope !== null && recoveryScope === owner.recoveryScope && identity !== null && (owner.preparedIdentity === null || identity === owner.preparedIdentity) &&
          (owner.preparedRevision === null || (value.revision as number) > owner.preparedRevision);
      });
      if (owners.length !== 1) return;
      const owner = owners[0]!; pending.delete(owner.attempt); publishClose();
      if (visiblePending !== owner) return;
      visiblePending = null; capture = null; ++epoch;
      emit({ phase: value.status === 'applied' ? 'applied' : 'error', error: value.status === 'applied' ? '' : timelineLoudnessApplyErrorMessage({ code: value.errorCode }) });
    },
    dispose(): void {
      disposed = true; revoked = true; ++epoch; capture = null; visiblePending = null; state = initial(state.version + 1);
      // React cleanup is not evidence that an outstanding durable request ended.
      for (const owner of pending.values()) owner.phase = 'unknown';
      publishClose();
    },
  };
  return controller;
}
export type TimelineLoudnessApplyController = ReturnType<typeof createTimelineLoudnessApplyController>;
export interface TimelineLoudnessApplyView { readonly state: TimelineLoudnessApplyState; readonly controller: TimelineLoudnessApplyController }
