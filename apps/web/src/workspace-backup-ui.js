import { translate, formatNumber } from '../../../packages/i18n/src/index.ts';
import { isWorkspaceBackupInspection } from '@mioon/contracts';

// This panel only reads bounded database metadata. The offline CLI owns capture.
export const WORKSPACE_BACKUP_COUNTS = Object.freeze([
  ['projects', '项目'], ['assets', '素材记录'], ['videoTasks', '视频任务'],
  ['imageTasks', '图像任务'], ['frameTasks', '抽帧任务'], ['exports', '导出记录'],
]);
export const WORKSPACE_BACKUP_UNRESOLVED = Object.freeze([
  ['videoTasks', '视频任务'], ['imageTasks', '图像任务'], ['frameTasks', '抽帧任务'],
  ['exports', '导出任务'], ['agentRuns', 'Agent 运行'], ['agentProposals', 'Agent 提案'], ['editTasks', '编辑请求'],
]);
export const WORKSPACE_BACKUP_CREATE_COMMAND = 'node apps/cli/src/backup.mjs create --source /absolute/workspace --destination /absolute/new-backup';
export const WORKSPACE_BACKUP_VERIFY_COMMAND = 'node apps/cli/src/backup.mjs verify --directory /absolute/backup';
export const WORKSPACE_BACKUP_ISSUES = Object.freeze({
  ROW_LIMIT: '记录数量超过本次核对上限，部分数量未知。',
  JSON_LIMIT: '部分记录超过检查容量，计数未知。',
  INVALID_ROW: '存在无法识别的数据库记录，部分数量未知。',
  SCHEMA_UNSUPPORTED: '数据库版本不在支持范围内，无法完成核对。',
  DATABASE_UNAVAILABLE: '数据库暂不可读取，无法完成核对。',
});

export const workspaceBackupCount = (value, locale = 'zh-Hans') => Number.isSafeInteger(value) && value >= 0 ? formatNumber(locale, value) : translate(locale, 'recovery.common.unknown');
export function workspaceBackupBytes(value, locale = 'zh-Hans') {
  if (!Number.isSafeInteger(value) || value < 0) return translate(locale, 'recovery.common.unknown');
  for (const [unit, size] of [['GiB', 1024 ** 3], ['MiB', 1024 ** 2], ['KiB', 1024]]) if (value >= size) return `${formatNumber(locale, Number((value / size).toFixed(1)))} ${unit}`;
  return `${formatNumber(locale, value)} B`;
}

export function workspaceBackupError(error, locale = 'zh-Hans') {
  if (error?.code === 'UNAUTHORIZED') return translate(locale, 'recovery.backup.error.unauthorized');
  if (error?.code === 'BACKEND_PROTOCOL_ERROR') return translate(locale, 'recovery.backup.error.protocol');
  return translate(locale, 'recovery.backup.error.failed');
}

const initialState = () => ({ scope: null, connected: false, visible: false, version: 0, phase: 'idle', report: null, error: '', checkedAt: null });

export function createWorkspaceBackupController({ read, validate = isWorkspaceBackupInspection, getContext, onChange = () => {}, onUnauthorized = () => {}, now = () => new Date().toISOString() }) {
  let state = initialState(), generation = 0, activeRead = null, disposed = false;
  const invalidate = () => { generation++; activeRead?.abort(); activeRead = null; };
  const emit = patch => { state = { ...state, ...patch }; onChange(state); };
  const sync = () => { if (!disposed && getContext) controller.setContext(getContext()); };
  const current = captured => {
    if (disposed || captured.generation !== generation) return false;
    // Live App refs may move to another project/navigation epoch before commit.
    sync();
    return !disposed && captured.generation === generation && captured.scope === state.scope && state.connected && state.visible;
  };
  const controller = {
    getState: () => state,
    connect() { disposed = false; },
    setContext(context) {
      if (disposed) return;
      const next = { scope: context?.scope ?? null, connected: Boolean(context?.connected), visible: Boolean(context?.visible) };
      if (['scope', 'connected', 'visible'].every(key => state[key] === next[key])) return;
      invalidate();
      const changedOwner = next.scope !== state.scope;
      emit({ ...next, version: state.version + 1, phase: !changedOwner && state.report ? 'stale' : 'idle',
        report: changedOwner ? null : state.report, checkedAt: changedOwner ? null : state.checkedAt, error: '' });
    },
    async inspect(scope = state.scope, version = state.version) {
      sync();
      if (disposed || scope !== state.scope || version !== state.version || !state.connected || !state.visible || activeRead) return null;
      invalidate();
      const captured = { scope: state.scope, generation }, abort = new AbortController();
      activeRead = abort;
      emit({ phase: 'checking', report: null, checkedAt: null, error: '' });
      try {
        // Never pass a filesystem path, selected project, request id or token.
        const result = await read({}, { signal: abort.signal });
        if (!current(captured)) return null;
        if (!validate(result)) throw Object.assign(Error('Invalid backup inspection'), { code: 'BACKEND_PROTOCOL_ERROR' });
        const report = structuredClone(result);
        emit({ phase: report.inspectionComplete ? 'checked' : 'incomplete', report, checkedAt: now(), error: '' });
        return report;
      } catch (error) {
        if (!current(captured)) return null;
        emit({ phase: 'error', report: null, checkedAt: null, error: workspaceBackupError(error), errorCode: error?.code });
        if (error?.code === 'UNAUTHORIZED') onUnauthorized();
        return null;
      } finally { if (activeRead === abort) activeRead = null; }
    },
    dispose() { disposed = true; invalidate(); state = { ...initialState(), version: state.version + 1 }; },
  };
  return controller;
}
