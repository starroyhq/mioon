import { readTimelineClipLoudnessRpc } from './timeline-clip-loudness-rpc.ts';
import { isTimelineClipLoudnessResponse } from '@mioon/contracts/timeline-clip-loudness';
import { readLoudnessApplyRpc } from './timeline-loudness-apply-rpc.ts';
import { isWorkspaceRestoreInspection } from '@mioon/contracts';
import { readOpacityCandidateClientBinding } from './opacity-candidate-client-binding.ts';
import { workspaceOriginOptions } from './workspace-origin.ts';
import { readTimelineMixLoudnessRpc } from './timeline-mix-loudness-rpc.ts';
import { isTimelineMixLoudnessResponse } from '@mioon/contracts/timeline-mix-loudness';

export class ApiError extends Error {
  constructor(message, code, details, definitive = false, status) { super(message); this.code = code; this.details = details; this.definitive = definitive; if (Number.isInteger(status)) this.status = status; }
}
export async function rpc(operation, input = {}, { signal, expectedWorkspaceOrigin, fetcher = (...args) => fetch(...args), opacityBinding } = {}) {
  const invocation = workspaceOriginOptions(expectedWorkspaceOrigin);
  const mix = operation === 'timeline.clip.loudness' ? await readTimelineClipLoudnessRpc(input, { ...invocation, signal, fetch: fetcher }) : operation === 'timeline.loudness.apply' ? await readLoudnessApplyRpc('/api/rpc', { operation, input, ...invocation }, { signal, fetcher }) : operation === 'timeline.loudness.prepare' ? await readTimelineMixLoudnessRpc(input, { ...invocation, signal, fetch: fetcher }) : null;
  const response = mix?.response ?? await fetcher('/api/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, input, ...invocation }), ...(signal ? { signal } : {}) });
  let body;
  try { body = mix ? mix.body : await response.json(); } catch { throw new ApiError('服务暂时没有返回有效数据，请检查服务后重试。', 'NETWORK'); }
  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean' ||
    (body.ok ? !Object.hasOwn(body, 'data') || !response.ok : typeof body.error?.code !== 'string' || typeof body.error?.message !== 'string'))
    throw new ApiError('服务暂时没有返回有效数据，请检查服务后重试。', 'BACKEND_PROTOCOL_ERROR');
  if (!response.ok || !body.ok) {
    const restricted = ['RESTORE_OPERATION_UNAVAILABLE', 'RESTORED_RECORD_HELD', 'RESTORE_WORKSPACE_ORIGIN_REQUIRED', 'RESTORE_WORKSPACE_ORIGIN_MISMATCH', 'RESTORE_BACKUP_UNAVAILABLE'].includes(body.error?.code);
    const details = restricted ? { ...body.error?.details } : body.error?.details;
    if (restricted) { delete details.mutationOutcome; delete details.frameOutcome; delete details.observation; }
    throw new ApiError(body.error?.message || '请求未完成', response.status === 401 ? 'UNAUTHORIZED' : body.error?.code, details, !restricted && response.status >= 400 && response.status < 500, response.status);
  }
  const inspectionValidator = readOpacityCandidateClientBinding(opacityBinding)?.isWorkspaceInspection ?? isWorkspaceRestoreInspection;
  if (operation === 'workspace.restore.inspect' && !inspectionValidator(body.data)) throw new ApiError('工作区身份核对返回无效数据。', 'BACKEND_PROTOCOL_ERROR');
  if (operation === 'timeline.loudness.prepare' && !isTimelineMixLoudnessResponse(body.data, input)) throw new ApiError('整片混音测量响应与本次请求不匹配。', 'BACKEND_PROTOCOL_ERROR');
  if (operation === 'timeline.clip.loudness' && !isTimelineClipLoudnessResponse(body.data, input)) throw new ApiError('Invalid saved-clip loudness response.', 'BACKEND_PROTOCOL_ERROR');
  return body.data;
}
export const requestId = () => crypto.randomUUID();
export const activeJob = (job) => ['queued', 'submitting', 'running', 'downloading'].includes(job.status);
export const statusText = (status) => ({ queued: '等待生成', submitting: '正在提交', running: '生成中', downloading: '保存视频', succeeded: '已完成', failed: '失败', submission_unknown: '提交状态待确认', cancelled: '已停止', ready: '可下载', pending: '等待处理', completed: '已完成' }[status] || status || '待生成');
export const assetUrl = (asset) => asset?.url || (asset?.id ? `/media/${asset.id}` : '');
export const versionUrl = (version) => version?.url || (version?.assetId ? `/media/${version.assetId}` : '');

export const outputReviewRequired = job => job?.phase === 'output_review_required';
export const jobStatusText = job => outputReviewRequired(job) ? '输出待核验' : statusText(job?.status);
export const outputReviewMessage = '服务商已完成生成，但下载视频的画幅比例与请求不符，尚未保存为版本。请核验服务商结果；这里只核对并恢复同一任务，不会自动重新生成。';
