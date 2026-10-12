import { isExportPreflightResponse, isTimelineExportCapabilitiesResponse } from '@mioon/contracts';
import { exportSettingsKey, freezeExportSettings } from './export-settings-state.js';

const initialState = () => ({ scope: null, projectId: null, timelineId: null, revision: null, connected: false, exportSettings: undefined, settingsKey: 'legacy', settingsVersion: 0, capability: null, capabilityPhase: 'idle', checkingStep: null, phase: 'idle', report: null, binding: null, uncheckedIntent: null, error: '', attempted: false });
const hasRevision = value => Number.isSafeInteger(value) && value > 0;
const issueMessages = Object.freeze({
  TIMELINE_MISSING: '项目还没有已保存的时间线，请先编排并保存片段。',
  EMPTY_TIMELINE: '已保存的时间线中没有可导出的片段。',
  INVALID_TIMELINE_SNAPSHOT: '已保存的时间线包含无效或暂不支持的设置。',
  TIMELINE_SOURCE_UNAVAILABLE: '引用的素材缺失，或不属于当前项目。',
  PREFLIGHT_SOURCE_INVALID: '源素材缺失，或无法在受管理的媒体目录中安全读取。',
  PREFLIGHT_SOURCE_CHANGED: '源素材已变化，或文件内容与保存的校验值不一致。',
  PREFLIGHT_MEDIA_INVALID: '源素材的媒体信息无效或暂不支持。',
  PREFLIGHT_INCOMPLETE: '有限额的媒体检查未能完成。实际导出仍会重新验证素材。',
  PREFLIGHT_BUDGET: '文件或累计字节检查已达到限额，尚未完成全部检查。',
  PREFLIGHT_SNAPSHOT_BUDGET: '关联资料超出本次安全检查上限，检查未完成。',
  PREFLIGHT_TIMEOUT: '素材检查已达到时间上限，尚未完成全部检查。',
  PREFLIGHT_BUSY: '另一项交付检查仍在运行，请稍后重新检查。',
  PREFLIGHT_STALE: '时间线或素材信息已变化，请重新检查已保存的快照。',
});
const protocolError = () => Object.assign(new Error('检查响应不完整或与当前快照不匹配，请重新检查。'), { code: 'BACKEND_PROTOCOL_ERROR' });

// Never surface raw transport errors, ffprobe output, or server file locations.
export function preflightErrorMessage(error) {
  if (error?.code === 'UNAUTHORIZED') return '会话已过期，请重新登录后重新检查。';
  if (['CONFLICT', 'REVISION_CONFLICT', 'PREFLIGHT_STALE'].includes(error?.code)) return '时间线已变化，请重新检查已保存的快照。';
  if (error?.code === 'BACKEND_PROTOCOL_ERROR') return '检查响应不完整或与当前快照不匹配，请重新检查。';
  return '检查未完成，请检查连接后重新检查。';
}

export function preflightIssueMessage(issue) {
  if (Object.hasOwn(issueMessages, issue?.code)) return issueMessages[issue.code];
  // Unknown server messages must not leak paths, probe output or credentials.
  // Preserve the bounded issue code and source ID beside a safe explanation.
  return issue?.severity === 'error' ? '素材或时间线检查未通过，请核对源素材与编排。' : '有一项检查未完成或需要注意，请核对源素材。';
}

export function exportCapabilityMessage(status) {
  return ({ idle: '尚未检查本机编码能力。', checking: '正在用当前设置进行有限额的本地编码检查…', available: '当前设置已通过本地编码检查。实际导出时仍会重新验证。', unavailable: '本机编码工具不可用，或缺少当前导出所需的能力。请检查 FFmpeg 配置后重新检查。', incomplete: '本机编码能力尚未确认，检查可能超时或暂时不可用。不能据此判断支持或不支持，请重新检查。', stale: '项目、时间线或编码工具已变化，请重新检查。', blocked: '当前项目或时间线不符合编码检查要求，请先核对已保存的编排。' })[status] || '本机编码能力尚未确认，请重新检查。';
}

function boundReport(report, context) {
  return report && report.projectId === context.projectId && report.timelineId === context.timelineId &&
    report.expectedRevision === context.revision && report.timelineRevision === context.revision;
}
function canBind(report, context) {
  return boundReport(report, context) && ['ready', 'incomplete'].includes(report.status) &&
    typeof report.snapshotHash === 'string' && /^[a-f0-9]{64}$/.test(report.snapshotHash) &&
    report.summary && report.summary.clipCount > 0 && report.summary.durationFrames > 0 &&
    !report.issues.some(issue => issue.severity === 'error') &&
    (report.status !== 'ready' || report.checks.checkedAssets === report.checks.totalAssets);
}

function canOfferUnchecked(report, context) {
  return report?.status === 'incomplete' && context.connected && context.timelineId && hasRevision(context.revision) &&
    report.projectId === context.projectId && report.expectedRevision === context.revision &&
    (report.timelineId === null || report.timelineId === context.timelineId) &&
    (report.timelineRevision === null || report.timelineRevision === context.revision) &&
    !report.issues.some(issue => issue.severity === 'error') && !canBind(report, context);
}

// One in-memory report for the current project. Reads are explicit and never
// mutate a project, create a render, or reuse a report as a request receipt.
export function createExportPreflightController({ read, readCapabilities, getContext, getInvocation = () => ({}), onChange = () => {}, onUnauthorized = () => {} }) {
  let state = initialState(), generation = 0, activeRead = null, visible = false;
  const invalidate = () => { generation++; activeRead?.abort(); activeRead = null; };
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const current = captured => {
    if (captured.generation !== generation) return false;
    // App refs can change before React commits its next layout effect. Re-read
    // that live owner before publishing a response or acting on an auth error.
    if (getContext) controller.setContext(getContext());
    return captured.generation === generation && captured.scope === state.scope && captured.projectId === state.projectId && captured.timelineId === state.timelineId && captured.revision === state.revision && captured.settingsKey === state.settingsKey && captured.settingsVersion === state.settingsVersion && state.connected;
  };
  const capabilityAllows = () => state.exportSettings === undefined || state.capability?.status === 'available';
  const controller = {
    getState: () => state,
    setContext(context) {
      const settingsKey = exportSettingsKey(context?.exportSettings);
      const next = context ? { scope: context.scope, projectId: context.projectId || null, timelineId: context.timelineId || null, revision: hasRevision(context.revision) ? context.revision : null, connected: Boolean(context.connected), settingsVersion: context.settingsVersion ?? 0, settingsKey, exportSettings: settingsKey === null ? undefined : freezeExportSettings(context.exportSettings) } : initialState();
      if (['scope', 'projectId', 'timelineId', 'revision', 'connected', 'settingsKey', 'settingsVersion'].every(key => state[key] === next[key])) return;
      invalidate();
      const changedProject = next.scope !== state.scope || next.projectId !== state.projectId;
      if (changedProject) state = initialState();
      emit({ ...next, capability: null, capabilityPhase: 'idle', checkingStep: null, phase: state.report ? 'stale' : 'idle', binding: null, uncheckedIntent: null, error: '', attempted: false });
    },
    setVisible(next) {
      if (visible && !next && activeRead) {
        invalidate();
        emit({ capability: null, capabilityPhase: 'idle', checkingStep: null, phase: state.report ? 'stale' : 'idle', binding: null, uncheckedIntent: null, error: '' });
      }
      visible = Boolean(next);
    },
    async check() {
      if (getContext) controller.setContext(getContext());
      if (state.settingsKey === null || !state.projectId || !state.timelineId || !hasRevision(state.revision) || !state.connected) return null;
      invalidate();
      const captured = { scope: state.scope, projectId: state.projectId, timelineId: state.timelineId, revision: state.revision, settingsKey: state.settingsKey, settingsVersion: state.settingsVersion, exportSettings: state.exportSettings, generation };
      const invocation = Object.freeze({ ...getInvocation() });
      const abort = new AbortController(); activeRead = abort;
      const input = { projectId: captured.projectId, expectedRevision: captured.revision, ...(captured.exportSettings === undefined ? {} : { exportSettings: captured.exportSettings }) };
      emit({ phase: 'checking', checkingStep: captured.exportSettings === undefined ? 'media' : 'capability', capability: null, capabilityPhase: captured.exportSettings === undefined ? 'idle' : 'checking', binding: null, uncheckedIntent: null, error: '', attempted: false });
      try {
        // The explicit capability operation may perform a bounded local synthetic
        // encode. Media preflight remains a separate read-only operation.
        if (captured.exportSettings !== undefined) {
          if (!readCapabilities) throw protocolError();
          const capability = await readCapabilities(input, { ...invocation, signal: abort.signal });
          if (!current(captured)) return null;
          if (!isTimelineExportCapabilitiesResponse(capability, input) ||
            capability.timelineId !== null && capability.timelineId !== captured.timelineId ||
            capability.timelineRevision !== null && capability.timelineRevision !== captured.revision && capability.status !== 'stale' ||
            capability.status === 'available' && (capability.timelineId !== captured.timelineId || capability.timelineRevision !== captured.revision)) throw protocolError();
          emit({ capability: structuredClone(capability), capabilityPhase: capability.status });
          if (capability.status !== 'available') {
            emit({ phase: ['unavailable', 'blocked'].includes(capability.status) ? 'blocked' : capability.status, checkingStep: null, report: null, binding: null, uncheckedIntent: null });
            return null;
          }
          emit({ checkingStep: 'media' });
        }
        const result = await read(input, { ...invocation, signal: abort.signal });
        if (!current(captured)) return null;
        if (!isExportPreflightResponse(result, input)) throw protocolError();
        // A bounded ownership read can end before a timeline tuple is available.
        // Keep that outcome incomplete without a checked binding; any returned
        // identity/revision still has to match the saved context we requested.
        if (result.status === 'ready' && !boundReport(result, captured)) throw protocolError();
        if (result.status === 'incomplete' && ((result.timelineId !== null && result.timelineId !== captured.timelineId) ||
          (result.timelineRevision !== null && result.timelineRevision !== captured.revision))) throw protocolError();
        if (result.status === 'ready' && !canBind(result, captured)) throw protocolError();
        const report = structuredClone(result);
        const binding = canBind(report, captured) ? Object.freeze({ projectId: report.projectId, expectedRevision: report.expectedRevision, preflightSnapshotHash: report.snapshotHash, ...(captured.exportSettings === undefined ? {} : { exportSettings: captured.exportSettings }) }) : null;
        // This is a separate, explicitly unreviewed intent for the current saved
        // revision. It must never masquerade as a checked snapshot binding.
        const uncheckedIntent = canOfferUnchecked(report, state) ? Object.freeze({ projectId: state.projectId, expectedRevision: state.revision, ...(captured.exportSettings === undefined ? {} : { exportSettings: captured.exportSettings }) }) : null;
        emit({ report, binding, uncheckedIntent, phase: report.status, checkingStep: null, error: '' });
        return report;
      } catch (error) {
        if (!current(captured)) return null;
        emit({ phase: 'error', capabilityPhase: state.checkingStep === 'capability' ? 'incomplete' : state.capabilityPhase, checkingStep: null, binding: null, uncheckedIntent: null, error: preflightErrorMessage(error) });
        if (error?.code === 'UNAUTHORIZED') onUnauthorized();
        return null;
      } finally { if (activeRead === abort) activeRead = null; }
    },
    // Binding identity also fences an old click after a newer check of the same
    // revision/hash. Taking it once prevents double-clicks and automatic retries.
    takeExportBinding(binding) {
      if (getContext) controller.setContext(getContext());
      if (!capabilityAllows() || !state.connected || !binding || binding !== state.binding || state.attempted || !canBind(state.report, state) || !['ready', 'incomplete'].includes(state.phase)) return null;
      emit({ binding: null, uncheckedIntent: null, attempted: true });
      return binding;
    },
    takeUncheckedExportIntent(intent) {
      if (!intent || intent !== state.uncheckedIntent) return null;
      if (getContext) controller.setContext(getContext());
      if (!capabilityAllows() || !intent || intent !== state.uncheckedIntent || state.binding || state.attempted || state.phase !== 'incomplete' || !canOfferUnchecked(state.report, state)) return null;
      emit({ uncheckedIntent: null, attempted: true });
      return intent;
    },
    dispose() { invalidate(); state = initialState(); visible = false; },
  };
  return controller;
}
