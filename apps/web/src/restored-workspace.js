import { workspaceOriginScope } from './workspace-origin.js';

export const RESTORE_DISABLED_REASON = '恢复分支第一版暂不支持新生成、Agent、Comfy、抽帧或波形解码。历史任务保持原状态并暂停执行。';
export const RESTORE_BACKUP_REASON = '此恢复分支暂不能再次创建可恢复备份；请保留原始备份。新成片可本地导出。';
export function workspaceOperationReason(workspace, operation) {
  if (workspace?.restored === false) return '';
  if (!workspaceOriginScope(workspace)) return '工作区身份尚未核对，暂不能提交。';
  const policy = workspace.operationPolicy?.find(item => item.operation === operation);
  return policy?.available ? '' : policy?.reason === 'RESTORE_GATE_PENDING' ? '恢复分支的此项操作尚未开放，历史记录仍保留。' : RESTORE_DISABLED_REASON;
}
export function assertWorkspaceOperation(workspace, operation) {
  const reason = workspaceOperationReason(workspace, operation);
  if (reason) throw Object.assign(new Error(reason), { code: 'RESTORE_OPERATION_UNAVAILABLE' });
}
export function validateProjectWorkspace(snapshot, workspace) {
  if (workspace?.restored === false) {
    if (snapshot?.restore !== undefined) throw Object.assign(new Error('工作区已变化，请重新载入；原请求仍保留。'), { code: 'RESTORE_WORKSPACE_ORIGIN_MISMATCH' });
    return snapshot;
  }
  const restore = snapshot?.restore, exports = snapshot?.exports;
  if (!workspaceOriginScope(workspace) || !restore || restore.workspaceOrigin !== workspace.workspaceOrigin ||
    Object.keys(restore).sort().join(',') !== 'heldExportIds,workspaceOrigin' || !Array.isArray(exports) || !Array.isArray(restore.heldExportIds) ||
    restore.heldExportIds.length > 20_000 || new Set(restore.heldExportIds).size !== restore.heldExportIds.length ||
    restore.heldExportIds.some(id => !exports.some(item => item.id === id)))
    throw Object.assign(new Error('恢复分支身份或导出历史核对无效，原请求仍保留。'), { code: 'BACKEND_PROTOCOL_ERROR' });
  return snapshot;
}
