export class ApiError extends Error {
  constructor(message, code, details, definitive = false) { super(message); this.code = code; this.details = details; this.definitive = definitive; }
}
export async function rpc(operation, input = {}) {
  const response = await fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, input }) });
  let body;
  try { body = await response.json(); } catch { throw new ApiError('服务暂时没有返回有效数据，请检查服务后重试。', 'NETWORK'); }
  if (!body || typeof body !== 'object' || typeof body.ok !== 'boolean' ||
    (body.ok ? !Object.hasOwn(body, 'data') || !response.ok : typeof body.error?.code !== 'string' || typeof body.error?.message !== 'string'))
    throw new ApiError('服务暂时没有返回有效数据，请检查服务后重试。', 'BACKEND_PROTOCOL_ERROR');
  if (!response.ok || !body.ok) throw new ApiError(body.error?.message || '请求未完成', response.status === 401 ? 'UNAUTHORIZED' : body.error?.code, body.error?.details, response.status >= 400 && response.status < 500);
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
