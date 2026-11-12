import { readTimelineClipLoudnessRpc } from './timeline-clip-loudness-rpc.ts';
import type { TimelineClipLoudnessWireOptions } from './timeline-clip-loudness-rpc.ts';
import { isTimelineClipLoudnessResponse } from '@mioon/contracts/timeline-clip-loudness';
import { readLoudnessApplyRpc } from './timeline-loudness-apply-rpc.ts';
import { readTimelineMixLoudnessRpc } from './timeline-mix-loudness-rpc.ts';
import type { TimelineMixLoudnessWireOptions } from './timeline-mix-loudness-rpc.ts';
import { isTimelineMixLoudnessResponse } from '@mioon/contracts/timeline-mix-loudness';
import { projectMediaPath } from '../../../packages/contracts/src/project-file.ts';
import { rpcPathFor } from '../../../packages/contracts/src/project-addressing.ts';
import { OUTPUT_LOCALE_HEADER } from '../../../packages/contracts/src/output-locale.ts';
import type { Locale } from '../../../packages/i18n/src/types.ts';

export type RpcFetcher = typeof fetch;
export interface RpcOptions {
  readonly signal?: AbortSignal;
  readonly fetcher?: RpcFetcher;
  /** Addresses the entity-addressed operations, whose input names no project. */
  readonly projectId?: string | null;
  readonly outputLocale?: Locale;
}
interface RpcErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
  readonly data?: unknown;
  readonly ok?: unknown;
}
interface LoudnessRpcResult {
  readonly response: Response;
  readonly body: unknown;
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const protocolError = (): ApiError => new ApiError('服务暂时没有返回有效数据，请检查服务后重试。', 'NETWORK');

export class ApiError extends Error {
  code?: string;
  details: unknown;
  definitive: boolean;
  declare status?: number;
  constructor(message: string, code?: string, details?: unknown, definitive = false, status?: number) {
    super(message);
    this.code = code;
    this.details = details;
    this.definitive = definitive;
    if (status !== undefined && Number.isInteger(status)) this.status = status;
  }
}

export async function rpc<T = unknown>(operation: string, input: unknown = {}, { signal, fetcher = (...args: Parameters<RpcFetcher>): ReturnType<RpcFetcher> => fetch(...args), projectId, outputLocale }: RpcOptions = {}): Promise<T> {
  let path: string;
  try { path = rpcPathFor(operation, input, projectId ?? undefined); }
  catch { throw new ApiError('The request has no valid project address.', 'VALIDATION_ERROR', {}, true); }
  const mix = (operation === 'timeline.clip.loudness' ? await readTimelineClipLoudnessRpc(input, { signal, fetch: fetcher } as TimelineClipLoudnessWireOptions) : operation === 'timeline.loudness.apply' ? await readLoudnessApplyRpc(path, { operation, input }, { signal, fetcher }) : operation === 'timeline.loudness.prepare' ? await readTimelineMixLoudnessRpc(input, { signal, fetch: fetcher } as TimelineMixLoudnessWireOptions) : null) as LoudnessRpcResult | null;
  const response = mix?.response ?? await fetcher(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(outputLocale ? { [OUTPUT_LOCALE_HEADER]: outputLocale } : {}) }, body: JSON.stringify({ operation, input }), ...(signal ? { signal } : {}) });
  let body: unknown;
  try { body = mix ? mix.body : await response.json(); } catch { throw protocolError(); }
  if (!isRecord(body) || typeof body.ok !== 'boolean' ||
    (body.ok ? !Object.hasOwn(body, 'data') || !response.ok : !isRecord(body.error) || typeof body.error.code !== 'string' || typeof body.error.message !== 'string'))
    throw new ApiError('服务暂时没有返回有效数据，请检查服务后重试。', 'BACKEND_PROTOCOL_ERROR');
  if (!response.ok || !body.ok) {
    const errorBody: RpcErrorBody = isRecord(body.error) ? body.error : {};
    const code = typeof errorBody.code === 'string' ? errorBody.code : undefined;
    throw new ApiError(typeof errorBody.message === 'string' && errorBody.message ? errorBody.message : '请求未完成', response.status === 401 ? 'UNAUTHORIZED' : code, errorBody.details, response.status >= 400 && response.status < 500, response.status);
  }
  if (operation === 'timeline.loudness.prepare' && !isTimelineMixLoudnessResponse(body.data, input)) throw new ApiError('整片混音测量响应与本次请求不匹配。', 'BACKEND_PROTOCOL_ERROR');
  if (operation === 'timeline.clip.loudness' && !isTimelineClipLoudnessResponse(body.data, input)) throw new ApiError('Invalid saved-clip loudness response.', 'BACKEND_PROTOCOL_ERROR');
  return body.data as T;
}
export const requestId = (): string => crypto.randomUUID();
export const activeJob = (job: unknown): boolean => ['queued', 'submitting', 'running', 'downloading'].includes(String(property(job, 'status')));
const statuses: Readonly<Record<string, string>> = { queued: '等待生成', submitting: '正在提交', running: '生成中', downloading: '保存视频', succeeded: '已完成', failed: '失败', submission_unknown: '提交状态待确认', cancelled: '已停止', ready: '可下载', pending: '等待处理', completed: '已完成' };
export const statusText = (status: unknown): string => (typeof status === 'string' ? statuses[status] : undefined) || (typeof status === 'string' ? status : '') || '待生成';
/** Media at its project's address; the stored `url` is not an address. Empty
 * when the record has no valid project or asset ID. */
export const mediaUrl = (projectId: unknown, assetId: unknown): string => {
  try { return projectMediaPath(projectId as string, assetId as string); } catch { return ''; }
};
export const assetUrl = (asset: unknown): string => mediaUrl(property(asset, 'projectId'), property(asset, 'id'));
export const versionUrl = (version: unknown): string => mediaUrl(property(version, 'projectId'), property(version, 'assetId'));

export const outputReviewRequired = (job: unknown): boolean => property(job, 'phase') === 'output_review_required';
export const jobStatusText = (job: unknown): string => outputReviewRequired(job) ? '输出待核验' : statusText(property(job, 'status'));
export const outputReviewMessage = '服务商已完成生成，但下载视频的画幅比例与请求不符，尚未保存为版本。请核验服务商结果；这里只核对并恢复同一任务，不会自动重新生成。';

function property(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}
