import { message as localizedMessage } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { ApiError, rpc, requestId as newRequestId } from './api.ts';
import { createImageRejectionCloseLatch } from './native-close-sources.ts';
import { IMAGE_FIXED_OPTIONS, IMAGE_MODELS, IMAGE_LIMITS, IMAGE_REVIEW_LIMITS, IMAGE_EDIT_LIMITS, imageEditInputImageSchema, imageEditSourceSchema, canonicalImageInput, imageSchemas, isImageTaskResponse, isImageGroupResponse, isImageMutationResponse, isImageRequestResponse, isImageListResponse, isImageReviewResponse, isImageReviewListResponse, isImageReviewPreparationResponse, isCompleteCustomImageConfiguration, getCustomImageDestination, COMFY_IMAGE_OPTIONS, comfyImageExecutionSchema, isCompleteComfyImageConfiguration, getComfyImageDestination } from '@mioon/contracts';
import type { ImageTaskResponse, ImageGroupResponse, ImageVersionResponse, ImageReviewResponse } from '@mioon/contracts';
import { safeImageSettings } from './image-settings.ts';
import { safeComfyImageSettings, safeComfyConnectorAvailability, comfyConnectorAvailable } from './comfy-image-settings.ts';
import { createComfyObservationSession, comfyObservationActive, comfyCanObserve } from './comfy-image-observation.ts';
export { comfyCanObserve } from './comfy-image-observation.ts';
import { createImageReviewClient, imageReviewIdentity as reviewIdentity } from './image-review.ts';

export { IMAGE_FIXED_OPTIONS, IMAGE_MODELS };
const PREFIX = 'mioon.image-intent.v1:';
const ACTIVE: ReadonlySet<string> = new Set(['queued', 'dispatching', 'receiving', 'persisting']);
const CANCELABLE: ReadonlySet<string> = new Set(['queued', 'interrupted_before_dispatch']);
const REJECTION_CODES: ReadonlySet<string> = new Set(['IMAGE_LIVE_DISABLED', 'IMAGE_CAPACITY', 'IMAGE_QUEUE_FULL', 'IMAGE_GROUP_BUSY', 'IMAGE_REVISION_CONFLICT', 'IMAGE_STATE_CONFLICT', 'IMAGE_RESULT_INVALID']);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const failureCode = (error: unknown): string | undefined => record(error) && typeof error.code === 'string' ? error.code : undefined;
const copy = <T>(value: T): T => structuredClone(value);
const problem = (code: string): Error => Object.assign(new Error(code), { code });

export type ImageProviderId = 'mock' | 'openai' | 'openai-compatible' | 'comfy-local';
export type ImageMode = 'text' | 'edit';
export interface ImageDraft { name: string; prompt: string }
export interface ImageInputImage { assetId: string; sha256: string }
export interface ImageSourcePreview { assetId: string; sha256?: string; name?: string; mimeType?: string; width?: number; height?: number; byteLength?: number }
export interface ImageTarget { groupId: string; expectedRevision: number }
export interface ImageTargetRequest { reviewId?: string; groupId?: string | null }
export interface ImageEditAsset {
  id?: string;
  projectId?: string;
  sha256?: string;
  mimeType?: string;
  provenance?: unknown;
  sizeBytes?: number;
  width?: number;
  height?: number;
  name?: string;
  [key: string]: unknown;
}
export interface ImageConfigurationView { enabled?: boolean; model?: string; options?: unknown; baseUrl: string; [key: string]: unknown }
export interface ImageSettingsView { revision: number; configuration: ImageConfigurationView; secret: { configured?: boolean; [key: string]: unknown }; readiness?: { checked?: boolean; [key: string]: unknown }; [key: string]: unknown }
export interface ImageMutationInput {
  projectId: string;
  requestId?: string;
  taskId?: string;
  expectedRevision?: number;
  providerId?: string;
  purpose?: string;
  name?: string;
  prompt?: string;
  model?: string;
  options?: Record<string, unknown>;
  inputImage?: ImageInputImage | null;
  groupId?: string;
  [key: string]: unknown;
}
export interface ImagePending {
  version: number;
  operation: string;
  input: ImageMutationInput;
  reviewId?: string | null;
  approvalAttempted?: boolean;
  sourceIssue?: string;
  sourceImage?: Record<string, unknown> | null;
  settingsRevision?: number;
  configuration?: Record<string, unknown>;
  destination?: string;
  execution?: Record<string, unknown> | null;
  preserveDraft?: boolean;
}
export interface ImageRemotePending { input: { taskId: string; [key: string]: unknown } }
export interface ImageGenerationState {
  draft: ImageDraft;
  mode: ImageMode;
  inputImage: ImageInputImage | null;
  sourcePreview: ImageSourcePreview | null;
  providerId: ImageProviderId;
  settings: ImageSettingsView | null;
  customSettings: ImageSettingsView | null;
  comfySettings: ImageSettingsView | null;
  comfyAvailability: unknown;
  comfyAvailabilityPhase: 'idle' | 'loading' | 'ready' | 'error';
  remotes: Record<string, unknown>;
  remotePending: ImageRemotePending | null;
  remoteActionTaskId: string | null;
  remoteStorageBlocked: boolean;
  reviews: ImageReviewView[];
  reviewCursor: string | null;
  reviewTrail: (string | null)[];
  nextReviewCursor: string | null;
  reviewActionId: string | null;
  target: ImageTarget | null;
  targetRequest: ImageTargetRequest | null;
  tasks: ImageTaskView[];
  groups: ImageGroupResponse[];
  versions: ImageVersionResponse[];
  selectedGroupId: string | null;
  groupCursor: string | null;
  groupTrail: (string | null)[];
  nextGroupCursor: string | null;
  versionCursor: string | null;
  versionTrail: (string | null)[];
  nextVersionCursor: string | null;
  historyPhase: string;
  pending: ImagePending | null;
  phase: string;
  loaded: boolean;
  message: string;
  displayMessage: DisplayMessage | null;
  storageBlocked: boolean;
  pollPaused: boolean;
  actionTaskId: string | null;
}
export interface ImageReviewClient {
  approve: (review: ImageReviewResponse) => Promise<unknown>;
  reject: (review: ImageReviewResponse) => Promise<unknown>;
}
export interface ImageApi { (operation: string, input: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> }
export interface ImageGenerationSessionOptions {
  projectId: string;
  api?: ImageApi;
  reviewClient?: ImageReviewClient;
  settings?: unknown; settingsReader?: () => Promise<unknown>;
  customSettings?: unknown; customSettingsReader?: () => Promise<unknown>;
  comfySettings?: unknown; comfySettingsReader?: () => Promise<unknown>;
  comfyAvailability?: unknown; comfyAvailabilityReader?: () => Promise<unknown>;
  storage?: Storage;
  requestId?: () => string;
  onChange?: (state: ImageGenerationState) => void;
  onGenerated?: (projectId: string, task: ImageTaskView) => void;
  setTimer?: (handler: () => void, milliseconds: number) => number;
  clearTimer?: (handle: number | undefined) => void;
  pollMs?: number;
  pollLimit?: number;
  timeoutMs?: number;
}
export interface ImageTargetAuthorization {
  providerId: ImageProviderId;
  draft: ImageDraft;
  target: ImageTarget | null;
  mode: ImageMode;
  inputImage: ImageInputImage | null;
  configuration: ImageConfigurationView;
  settingsRevision: number;
  destination: string | null;
}
export interface ImagePage<T> { items: T[]; nextCursor: string | null }
export interface ImageTaskView extends Record<string, unknown> {
  id: string; projectId: string; groupId: string | null; requestId: string; name: string; prompt: string;
  providerId: string; model: string; options: Record<string, unknown>; purpose: string; createdAt: string;
  state: string; revision: number; dispatched: boolean; errorCode: string | null; taskId?: string;
}
export interface ImageReviewView extends Record<string, unknown> {
  id: string; projectId: string; requestId: string; taskId?: string | null; revision: number; state: string;
  input: Record<string, unknown>; settingsRevision: number; destination?: string | null;
  sourceImage?: Record<string, unknown> | null; configuration?: Record<string, unknown>; execution?: Record<string, unknown> | null;
}
type ComfyObservationSession = {
  snapshot: () => unknown;
  read: (taskId: string, review: unknown) => Promise<unknown>;
  setVisible: (value: boolean) => void;
  observe: (task: unknown) => Promise<unknown>;
  dispose: () => void;
};
const createObservations = createComfyObservationSession as unknown as (options: Record<string, unknown>) => ComfyObservationSession;
const reviewViewOf = (review: ImageReviewResponse): ImageReviewView => review as unknown as ImageReviewView;
const taskViewOf = (task: ImageTaskResponse): ImageTaskView => task as unknown as ImageTaskView;

const FALLBACK_TASK_LABEL = '状态待确认';
const taskLabels: Record<string, string> = { queued: '等待生成', dispatching: '正在发送', receiving: '正在接收图像', persisting: '正在保存结果', succeeded: '已保存', cancelled_before_dispatch: '发送前已取消', interrupted_before_dispatch: '发送前已中断', failed: '生成失败', outcome_unknown: '服务商结果未知', local_result_error: '本地结果保存失败' };
export const imageTaskLabel = (state: string): string => Object.hasOwn(taskLabels, state) ? taskLabels[state] : FALLBACK_TASK_LABEL;
const taskMessages: Record<string, string> = { interrupted_before_dispatch: '应用重启前尚未发送，不会自动继续。可取消此任务，再明确创建新请求。', outcome_unknown: '无法确认服务商结果。可明确检查并恢复已落盘的本地结果；没有可核验结果时仍保持未知，绝不重新调用服务商。', local_result_error: '已有本地结果待恢复。恢复只处理同一份结果，不再次生成。', cancelled_before_dispatch: '已确认在发送前取消，没有启动生成。', failed: '此请求已结束。查看记录后，可明确创建新的生成请求。' };
export const imageTaskMessage = (state: string): string => Object.hasOwn(taskMessages, state) ? taskMessages[state] : '';
const customPreDispatchMessages: Record<string, string> = {
  IMAGE_NETWORK_DENIED: '发送前网络检查未通过。请检查自定义地址是否指向允许访问的 HTTPS 公网服务，再准备新的请求。',
  IMAGE_CONNECTION_FAILED: '发送前无法建立连接。请检查自定义地址和服务状态，再准备新的请求。',
  IMAGE_TIMEOUT: '发送前连接检查超时。请检查自定义服务是否可用，再准备新的请求。',
  IMAGE_DISPATCH_BLOCKED: '发送前安全检查未通过。请重新读取并核对自定义连接设置，再准备新的请求。',
  IMAGE_SETTINGS_CONFLICT: '自定义连接在发送前已变化。请读取当前地址、模型与配置版本，再准备新的请求。',
  IMAGE_SETTINGS_NOT_CONFIGURED: '自定义连接缺少完整设置或可用密钥。请检查连接设置并重新输入此连接的密钥，再准备新的请求。',
  IMAGE_SETTINGS_DISABLED: '自定义连接已停用。请在图像设置中确认是否启用，再准备新的请求。',
};
export function imageTaskConnectionMessage(task: ImageTaskView | null | undefined): string {
  if (task?.providerId !== 'openai-compatible' || task.state !== 'failed' || task.dispatched !== false || !Object.hasOwn(customPreDispatchMessages, task.errorCode ?? '')) return '';
  return `${customPreDispatchMessages[task.errorCode ?? '']}本次未发送生成 POST；任何新请求都需要重新明确批准，不会自动重试。`;
}
const rejectionMessages: Record<string, string> = { IMAGE_SOURCE_INVALID: '源图未通过后端核验，本次未被接受。仅支持当前项目的完整、不透明、8 位非交错 PNG；最多 8 MiB，每边最多 1024 像素。', IMAGE_LIVE_DISABLED: '真实图像调用尚未启用，本次未被接受。', IMAGE_GROUP_BUSY: '此组有未结束或结果未知的任务，本次未被接受。请查看原任务。', IMAGE_REVISION_CONFLICT: '图像组或任务的状态已变化，本次未被接受。请重新读取并明确选择目标。', IMAGE_QUEUE_FULL: '本地图像队列已满，本次未被接受。草稿保留，可稍后明确提交。', IMAGE_CAPACITY: '本地图像记录容量已满，本次未被接受。草稿保留。', IMAGE_STATE_CONFLICT: '当前任务或图像组不允许此操作，本次未被接受。请重新读取。', IMAGE_RESULT_INVALID: '未找到可完整核验的本地结果，本次恢复未被接受。原任务保留，不会重新生成。' };
const rejectionMessage = (code: string): string => Object.hasOwn(rejectionMessages, code) ? rejectionMessages[code] : '请求未被接受，草稿保留。请重新读取并核对后再提交。';
export function imageInputIssue(draft: ImageDraft): string {
  if (!draft.name.trim()) return '请填写图像名称。';
  if (draft.name.length > 120) return '名称最多 120 个字符。';
  if (!draft.prompt.trim()) return '请填写图像描述。';
  if (draft.prompt.length > IMAGE_LIMITS.promptCharacters || new TextEncoder().encode(draft.prompt).length > IMAGE_LIMITS.promptBytes) return `描述最多 ${IMAGE_LIMITS.promptCharacters} 个字符。`;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(draft.prompt)) return '描述中含有不支持的控制字符。';
  return '';
}
export function initialImageGenerationState(): ImageGenerationState {
  return { draft: { name: '', prompt: '' }, mode: 'text', inputImage: null, sourcePreview: null, providerId: 'mock', settings: null, customSettings: null, comfySettings: null, comfyAvailability: null, comfyAvailabilityPhase: 'idle', remotes: {}, remotePending: null, remoteActionTaskId: null, remoteStorageBlocked: false, reviews: [], reviewCursor: null, reviewTrail: [], nextReviewCursor: null, reviewActionId: null, target: null, targetRequest: null, tasks: [], groups: [], versions: [], selectedGroupId: null, groupCursor: null, groupTrail: [], nextGroupCursor: null, versionCursor: null, versionTrail: [], nextVersionCursor: null, historyPhase: 'idle', pending: null, phase: 'idle', loaded: false, message: '', displayMessage: null, storageBlocked: false, pollPaused: false, actionTaskId: null };
}
export const imageDraftDirty = (state: ImageGenerationState): boolean => Boolean(state.draft.name || state.draft.prompt || state.target || state.mode === 'edit' || state.inputImage);
// Metadata only: eligibility here is a chooser hint. The backend alone verifies
// project ownership, immutable PNG bytes, opacity, bit depth and interlacing.
export function imageEditSourceIssue(asset: ImageEditAsset | null | undefined, projectId: string): string {
  if (!asset || asset.projectId !== projectId || !imageEditInputImageSchema.safeParse({ assetId: asset.id, sha256: asset.sha256 }).success) return '素材身份或所属项目无效。';
  if (asset.mimeType !== 'image/png') return '仅支持 PNG。';
  if (!['user-import', 'generated', 'synthetic-mock', 'extracted-frame'].includes(asset.provenance as string)) return '此素材来源不支持图像编辑。';
  if (typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > IMAGE_EDIT_LIMITS.sourceBytes) return 'PNG 必须不超过 8 MiB。';
  if (typeof asset.width !== 'number' || typeof asset.height !== 'number' || ![asset.width, asset.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= IMAGE_EDIT_LIMITS.sourceMaxEdge) || asset.width * asset.height > IMAGE_EDIT_LIMITS.sourceMaxPixels) return '每边最多 1024 像素，总计最多 1,048,576 像素。';
  return '';
}
export const imageEditDraftIssue = (state: ImageGenerationState): string => state.mode !== 'edit' ? '' : !['mock', 'openai'].includes(state.providerId) ? '图像编辑仅支持 Mock 和 OpenAI 官方连接。' : !imageEditInputImageSchema.safeParse(state.inputImage).success ? '请选择当前项目的一张 PNG 源图。' : '';
const editInput = (state: ImageGenerationState): Record<string, unknown> => state.mode === 'edit' ? { purpose: 'edit', inputImage: copy(state.inputImage) } : {};
const clearedDraft = (): Partial<ImageGenerationState> => ({ draft: { name: '', prompt: '' }, target: null, mode: 'text', inputImage: null, sourcePreview: null });
const reviewRecord = (review: unknown): Record<string, unknown> | null => record(review) ? review : null;
export function imageEditReviewMatchesDraft(state: ImageGenerationState, review: unknown): boolean {
  const reviewValue = reviewRecord(review), input = reviewValue && record(reviewValue.input) ? reviewValue.input : null;
  if (input?.purpose !== 'edit') return true;
  return state.mode === 'edit' && state.providerId === input.providerId && state.draft.name === input.name && state.draft.prompt === input.prompt && canonicalImageInput(state.inputImage) === canonicalImageInput(input.inputImage) && (state.target?.groupId || undefined) === input.groupId && (state.target?.expectedRevision || undefined) === input.expectedRevision;
}
const paidProvider = (providerId: string | null | undefined): boolean => Boolean(providerId && ['openai', 'openai-compatible'].includes(providerId));
const reviewedProvider = (providerId: string | null | undefined): boolean => paidProvider(providerId) || providerId === 'comfy-local';
export const imageSelectedSettings = (state: ImageGenerationState, providerId: string = state.providerId): ImageSettingsView | null => providerId === 'comfy-local' ? state.comfySettings : providerId === 'openai-compatible' ? state.customSettings : providerId === 'openai' ? state.settings : null;
export function imageReviewCanApprove(state: ImageGenerationState, review: unknown): boolean {
  if (!isImageReviewResponse(review)) return false;
  const view = reviewViewOf(review), reviewValue = reviewRecord(view), input = reviewValue && record(reviewValue.input) ? reviewValue.input : null;
  const providerId = typeof input?.providerId === 'string' ? input.providerId : null;
  const settings = imageSelectedSettings(state, providerId ?? state.providerId);
  if (!imageEditReviewMatchesDraft(state, view) || view.state !== 'pending' || settings?.revision !== view.settingsRevision || !settings || !settings.configuration.enabled) return false;
  const reviewInput = view.input;
  if (reviewInput.purpose === 'edit' && reviewInput.groupId && !state.groups.some(group => group.id === reviewInput.groupId && group.revision === reviewInput.expectedRevision && !group.activeTaskId)) return false;
  if (reviewInput.providerId === 'comfy-local') return comfyConnectorAvailable(state.comfyAvailability) && settings.readiness?.checked === true && isCompleteComfyImageConfiguration(settings.configuration) && canonicalImageInput(settings.configuration) === canonicalImageInput(view.configuration);
  return settings.secret.configured === true && (reviewInput.providerId !== 'openai-compatible' || canonicalImageInput(settings.configuration) === canonicalImageInput(view.configuration));
}
export function imageTaskReview(state: ImageGenerationState, task: ImageTaskView | null | undefined): ImageReviewView | null {
  if (!task) return null;
  const taskRecord = task as unknown as Record<string, unknown>;
  return state.reviews.find(review => review.taskId === task.id && review.projectId === task.projectId && review.requestId === task.requestId && ['name', 'prompt', 'providerId', 'model', 'options', 'purpose', 'inputImage'].every(field => canonicalImageInput(review.input[field]) === canonicalImageInput(taskRecord[field])) && canonicalImageInput(review.sourceImage) === canonicalImageInput(task.sourceImage) && (!review.input.groupId || review.input.groupId === task.groupId)) || null;
}
export function imagePaidAuthorization(state: ImageGenerationState): ImageTargetAuthorization | null {
  const settings = imageSelectedSettings(state);
  if (!settings || !paidProvider(state.providerId)) return null;
  return { providerId: state.providerId, draft: copy(state.draft), target: copy(state.target), mode: state.mode, inputImage: copy(state.inputImage), configuration: copy(settings.configuration), settingsRevision: settings.revision,
    destination: state.providerId === 'openai-compatible' ? isCompleteCustomImageConfiguration(settings.configuration) ? getCustomImageDestination(settings.configuration.baseUrl) : null : `${settings.configuration.baseUrl}/images/${state.mode === 'edit' ? 'edits' : 'generations'}` };
}
export function imageCanGenerate(state: ImageGenerationState): boolean {
  const group = state.target && state.groups.find(item => item.id === state.target?.groupId), settings = imageSelectedSettings(state);
  return Boolean(state.loaded && !state.pending && !state.storageBlocked && !state.actionTaskId && !state.reviewActionId && !state.remoteActionTaskId && !state.remotePending && !state.remoteStorageBlocked && !['loading', 'submitting', 'targeting'].includes(state.phase) && !imageInputIssue(state.draft) && !imageEditDraftIssue(state) && (state.providerId === 'mock' || state.providerId === 'comfy-local' && comfyConnectorAvailable(state.comfyAvailability) && settings?.configuration.enabled === true && settings.readiness?.checked === true && settings.revision > 0 && isCompleteComfyImageConfiguration(settings.configuration) || paidProvider(state.providerId) && settings?.configuration.enabled === true && settings.secret.configured === true && settings.revision > 0 && (state.providerId !== 'openai-compatible' || isCompleteCustomImageConfiguration(settings.configuration))) && (!state.target || (group && !group.activeTaskId && group.revision === state.target.expectedRevision)));
}
const pendingMatchesReview = (pending: ImagePending, review: ImageReviewView): boolean => (!pending.sourceImage || canonicalImageInput(pending.sourceImage) === canonicalImageInput(review.sourceImage)) && canonicalImageInput(pending.input) === canonicalImageInput(review.input) && pending.settingsRevision === review.settingsRevision &&
  (pending.input.providerId !== 'openai-compatible' || pending.version === 2 && canonicalImageInput(pending.configuration) === canonicalImageInput(review.configuration) && pending.destination === review.destination) &&
  (pending.input.providerId !== 'comfy-local' || pending.version === 3 && canonicalImageInput(pending.configuration) === canonicalImageInput(review.configuration) && pending.destination === review.destination && (!pending.execution || canonicalImageInput(pending.execution) === canonicalImageInput(review.execution)));
const imageOperationSchema = (operation: string): (typeof imageSchemas)[keyof typeof imageSchemas] | undefined => Object.hasOwn(imageSchemas, operation) ? imageSchemas[operation as keyof typeof imageSchemas] : undefined;
const fixedIntent = (projectId: string, value: unknown): boolean => {
  const fixed = record(value) ? value : null, input = fixed && record(fixed.input) ? fixed.input : null;
  if (!fixed || !input || !imageOperationSchema(typeof fixed.operation === 'string' ? fixed.operation : '')?.safeParse(input).success || input.projectId !== projectId || !['image.generate', 'image.task.cancelQueued', 'image.task.recoverResult'].includes(typeof fixed.operation === 'string' ? fixed.operation : '')) return false;
  if (fixed.sourceIssue !== undefined && (fixed.sourceIssue !== 'IMAGE_SOURCE_INVALID' || fixed.operation !== 'image.generate' || input.providerId !== 'mock' || input.purpose !== 'edit')) return false;
  if (fixed.sourceImage !== undefined && (input.purpose !== 'edit' || !imageEditSourceSchema.safeParse(fixed.sourceImage).success || !record(fixed.sourceImage) || !record(input.inputImage) || fixed.sourceImage.assetId !== input.inputImage.assetId || fixed.sourceImage.sha256 !== input.inputImage.sha256)) return false;
  if (fixed.operation !== 'image.generate' || input.providerId === 'mock') return fixed.version === 1;
  if (!Number.isSafeInteger(fixed.settingsRevision) || typeof fixed.settingsRevision !== 'number' || fixed.settingsRevision < 1 || typeof fixed.approvalAttempted !== 'boolean' || !(fixed.reviewId === null || typeof fixed.reviewId === 'string')) return false;
  if (input.providerId === 'openai') return fixed.version === 1;
  if (input.providerId === 'comfy-local') return fixed.version === 3 && isCompleteComfyImageConfiguration(fixed.configuration) && record(fixed.configuration) && fixed.configuration.enabled === true && fixed.configuration.model === input.model && canonicalImageInput(fixed.configuration.options) === canonicalImageInput(input.options) && fixed.destination === getComfyImageDestination(fixed.configuration.baseUrl as string) && (fixed.execution === null && fixed.reviewId === null && !fixed.approvalAttempted || comfyImageExecutionSchema.safeParse(fixed.execution).success);
  return fixed.version === 2 && isCompleteCustomImageConfiguration(fixed.configuration) && record(fixed.configuration) && fixed.configuration.enabled === true && fixed.configuration.model === input.model && canonicalImageInput(fixed.configuration.options) === canonicalImageInput(input.options) && fixed.destination === getCustomImageDestination(fixed.configuration.baseUrl as string);
};
const safeTask = (value: unknown, projectId: string): ImageTaskView => {
  if (!isImageTaskResponse(value) || value.projectId !== projectId) throw problem('INVALID_RESPONSE');
  return copy(value) as unknown as ImageTaskView;
};
function safePage<T>(operation: string, input: unknown, value: unknown): ImagePage<T> {
  if (!isImageListResponse(operation, input, value)) throw problem('INVALID_RESPONSE');
  return copy(value) as unknown as ImagePage<T>;
}
const taskIdentity = (task: ImageTaskView): string => canonicalImageInput(Object.fromEntries(['id', 'projectId', 'groupId', 'requestId', 'name', 'prompt', 'providerId', 'model', 'options', 'purpose', 'inputImage', 'sourceImage', 'createdAt'].map(key => [key, (task as unknown as Record<string, unknown>)[key]])));
function newestTask(previous: ImageTaskView | undefined, next: ImageTaskView): ImageTaskView {
  if (previous && (taskIdentity(previous) !== taskIdentity(next) || (previous.revision === next.revision && canonicalImageInput(previous) !== canonicalImageInput(next)))) throw problem('INVALID_RESPONSE');
  return previous && previous.revision > next.revision ? previous : next;
}
async function notAccepted(error: unknown, operation: string, input: ImageMutationInput): Promise<boolean> {
  const apiError = error instanceof ApiError ? error as ApiError & { code?: unknown; details?: unknown } : null;
  const details = record(apiError?.details) ? apiError.details : null;
  const proof = details ? details.imageOutcome : undefined;
  const code = typeof apiError?.code === 'string' ? apiError.code : '';
  if (!apiError || !REJECTION_CODES.has(code) || !record(proof) || proof.status !== 'not_accepted' || proof.projectId !== input.projectId || proof.operation !== operation || proof.requestId !== input.requestId || !/^[a-f0-9]{64}$/.test(typeof proof.inputHash === 'string' ? proof.inputHash : '')) return false;
  try {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalImageInput(input)));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') === proof.inputHash;
  } catch { return false; }
}

/** One project lifetime. Reads never dispatch work; every mutation needs a saved exact intent. */
export function createImageGenerationSession({ projectId, api = rpc as unknown as ImageApi, reviewClient = createImageReviewClient() as unknown as ImageReviewClient, settings, settingsReader, customSettings, customSettingsReader, comfySettings, comfySettingsReader, comfyAvailability, comfyAvailabilityReader, storage, requestId = newRequestId, onChange = () => {}, onGenerated = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, pollMs = 1500, pollLimit = 40, timeoutMs = 15000 }: ImageGenerationSessionOptions) {
  let state: ImageGenerationState = initialImageGenerationState(), disposed = false, visible = true, readEpoch = 0, selectionEpoch = 0, interactionEpoch = 0, timer: number | null = null, polls = 0, reading = false, availabilityEpoch = 0;
  if (settings) state.settings = safeImageSettings(settings) as ImageSettingsView;
  if (customSettings) state.customSettings = safeImageSettings(customSettings, 'custom') as ImageSettingsView;
  if (comfySettings) state.comfySettings = safeComfyImageSettings(comfySettings) as ImageSettingsView;
  if (comfyAvailability) { try { state.comfyAvailability = safeComfyConnectorAvailability(comfyAvailability); state.comfyAvailabilityPhase = 'ready'; } catch { state.comfyAvailabilityPhase = 'error'; } }
  const announced = new Set<string>(), tracked = new Map<string, ImageTaskView>(), calls = new Set<AbortController>();
  async function call(operation: string, input: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController(); calls.add(controller); let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(problem('NETWORK')); }, timeoutMs); });
    try { return await Promise.race([Promise.resolve().then(() => api(operation, input, { signal: controller.signal })), expired]); }
    finally { clearTimeout(deadline); calls.delete(controller); }
  }
  const store = (): Storage | null => storage === undefined ? globalThis.sessionStorage : storage;
  const emit = (patch: Partial<ImageGenerationState>): void => {
    if (disposed) return;
    const groupChanged = Object.hasOwn(patch, 'selectedGroupId') && patch.selectedGroupId !== state.selectedGroupId;
    const pageChanged = Object.hasOwn(patch, 'versionCursor') && patch.versionCursor !== state.versionCursor;
    const groupPageChanged = Object.hasOwn(patch, 'groupCursor') && patch.groupCursor !== state.groupCursor;
    // Saved previews and their cursor belong to one exact group/page. Every
    // selection route (including recovered receipts) crosses this same boundary.
    // Same-page refreshes keep their known results, drafts and recoverable tasks.
    state = { ...state, ...(groupPageChanged ? { nextGroupCursor: null } : {}), ...(groupChanged ? { versionCursor: null, versionTrail: [] } : {}),
      ...(groupChanged || pageChanged ? { versions: [], nextVersionCursor: null, historyPhase: 'loading' } : {}), ...patch };
    onChange(copy(state));
  };
  const rejectionClose = createImageRejectionCloseLatch({ limit: IMAGE_REVIEW_LIMITS.reviewsPerProject, identityBytes: IMAGE_REVIEW_LIMITS.rowBytes }, () => emit({}));
  const observations = createObservations({ projectId, call, storage, requestId, getAvailability: () => state.comfyAvailability, onChange: emit });
  state = { ...state, ...(observations.snapshot() as Partial<ImageGenerationState>) };
  const stopTimer = (): void => { if (timer !== null) clearTimer(timer); timer = null; };
  const owned = (epoch: number): boolean => !disposed && readEpoch === epoch;
  function savePending(value: ImagePending): void {
    const target = store(); if (!target) throw problem('LOCAL_STORAGE_UNAVAILABLE');
    if (target.getItem(`${PREFIX}${projectId}`)) throw problem('LOCAL_STORAGE_CHANGED');
    const serialized = JSON.stringify(value); target.setItem(`${PREFIX}${projectId}`, serialized);
    if (target.getItem(`${PREFIX}${projectId}`) !== serialized) throw problem('LOCAL_STORAGE_UNAVAILABLE');
  }
  function updatePending(previous: ImagePending, next: ImagePending): boolean {
    try {
      if (disposed || state.pending !== previous) return false;
      const target = store(), stored: unknown = JSON.parse(target?.getItem(`${PREFIX}${projectId}`) || 'null');
      if (canonicalImageInput(stored) !== canonicalImageInput(previous)) throw problem('LOCAL_STORAGE_CHANGED');
      const serialized = JSON.stringify(next); target?.setItem(`${PREFIX}${projectId}`, serialized);
      if (target?.getItem(`${PREFIX}${projectId}`) !== serialized) throw problem('LOCAL_STORAGE_UNAVAILABLE');
      emit({ pending: next }); return true;
    } catch { emit({ storageBlocked: true, phase: 'unknown', message: '无法核验本地审批记录，本次不会继续发送。请重新打开面板后核对。', displayMessage: localizedMessage('image.state.reviewRecordUnverifiable') }); return false; }
  }
  function clearPending(pending: ImagePending): boolean {
    // Late acknowledgements from an old project lifetime never remove a newer intent.
    if (disposed || state.pending !== pending) return false;
    try {
      const target = store(), saved: unknown = JSON.parse(target?.getItem(`${PREFIX}${projectId}`) || 'null');
      if (saved && canonicalImageInput(saved) !== canonicalImageInput(pending)) throw problem('LOCAL_STORAGE_CHANGED');
      target?.removeItem(`${PREFIX}${projectId}`);
      if (target?.getItem(`${PREFIX}${projectId}`)) throw problem('LOCAL_STORAGE_UNAVAILABLE');
    } catch { emit({ storageBlocked: true, phase: 'unknown', message: '原请求已确认，但无法更新本地请求记录。请重新打开面板后核对。', displayMessage: localizedMessage('image.state.requestRecordUpdateFailed') }); return false; }
    emit({ pending: null }); return true;
  }
  try {
    const serialized = store()?.getItem(`${PREFIX}${projectId}`);
    if (serialized) {
      const parsed: unknown = JSON.parse(serialized); if (!fixedIntent(projectId, parsed)) throw problem('LOCAL_STORAGE_INVALID');
      const pending = parsed as ImagePending;
      state.pending = pending; state.phase = 'unknown';
      if (pending.operation === 'image.generate') { state.draft = { name: pending.input.name ?? '', prompt: pending.input.prompt ?? '' }; state.providerId = pending.input.providerId as ImageProviderId; state.mode = pending.input.purpose === 'edit' ? 'edit' : 'text'; state.inputImage = record(pending.input.inputImage) ? copy(pending.input.inputImage as unknown as ImageInputImage) : null; state.sourcePreview = record(pending.sourceImage) ? copy(pending.sourceImage as unknown as ImageSourcePreview) : null; state.target = pending.input.groupId ? { groupId: pending.input.groupId, expectedRevision: pending.input.expectedRevision ?? 0 } : null; }
    }
  } catch { state.storageBlocked = true; state.message = '无法读取本地请求记录。为避免重复生成，暂不能提交。'; state.displayMessage = localizedMessage('image.state.requestStorageBlocked'); }
  function mergeTask(taskValue: unknown): ImageTaskView {
    const previous = state.tasks.find(item => item.id === (record(taskValue) ? taskValue.id : undefined));
    const task = newestTask(previous, taskValue as ImageTaskView);
    emit({ tasks: [task, ...state.tasks.filter(item => item.id !== task.id)].slice(0, IMAGE_LIMITS.maxPageSize) });
    if (ACTIVE.has(task.state)) tracked.set(task.id, task); else tracked.delete(task.id);
    if (task.state === 'succeeded' && !announced.has(task.id)) { announced.add(task.id); onGenerated(projectId, copy(task)); }
    return task;
  }
  function schedule(): void {
    stopTimer();
    if (disposed || !visible || reading || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || !(state.pending || state.remotePending || Object.values(state.remotes).some(comfyObservationActive) || state.tasks.some(task => ACTIVE.has(task.state)))) return;
    if (polls >= pollLimit) { emit({ pollPaused: true }); return; }
    timer = setTimer(() => { timer = null; polls++; void load({ automatic: true }); }, pollMs);
  }
  async function resolvePending(epoch: number): Promise<void> {
    const pending = state.pending; if (!pending) return;
    const receipt = await call('image.request.get', { projectId, requestId: pending.input.requestId });
    if (!owned(epoch)) return;
    if (!isImageRequestResponse(receipt) || (receipt && (receipt.projectId !== projectId || receipt.requestId !== pending.input.requestId || receipt.operation !== pending.operation || !isImageMutationResponse(pending.operation, pending.input, receipt.response)))) throw problem('INVALID_RESPONSE');
    if (!receipt) {
      if (pending.reviewId) {
        const reviewValue = await call('image.review.get', { projectId, reviewId: pending.reviewId });
        if (!owned(epoch)) return;
        if (!isImageReviewResponse(reviewValue) || reviewValue.projectId !== projectId) throw problem('INVALID_RESPONSE');
        const review = mergeReview(reviewValue);
        if (!pendingMatchesReview(pending, review)) throw problem('INVALID_RESPONSE');
        if (review.state === 'rejected' && clearPending(pending)) { emit({ phase: 'ready', message: '原请求已被拒绝，没有重新生成。', displayMessage: localizedMessage('image.state.originalRejected') }); return; }
        if (review.state === 'pending') { emit({ phase: 'unknown', message: '原始描述仍在等待审批。只有明确点击批准才会发送，不会自动继续。', displayMessage: localizedMessage('image.state.waitingForApproval') }); return; }
      }
      if (pending.sourceIssue === 'IMAGE_SOURCE_INVALID') { emit({ phase: 'unknown', message: '源图核验报告问题。请核对 PNG 是否不透明、8 位、非交错、最多 8 MiB 且每边不超过 1024 像素，并重新读取原请求。原请求结果仍未知，原始标识已保留；为避免重复任务，本项目暂不能提交新图像请求，不会自动重发。', displayMessage: localizedMessage('image.state.sourceUnknownHeld') }); return; }
      emit({ phase: 'unknown', message: reviewedProvider(pending.input.providerId) && !pending.approvalAttempted ? pending.input.providerId === 'comfy-local' ? '尚未确认本地运行准备结果；没有批准运行。请重新读取，或明确放弃此未批准请求。' : '尚未确认审批准备结果；没有发起付费审批。请重新读取，或明确放弃此未批准请求。' : '尚未找到原请求的确认记录。这不能证明请求未被接受；请继续核对，不要重复生成。', displayMessage: reviewedProvider(pending.input.providerId) && !pending.approvalAttempted ? pending.input.providerId === 'comfy-local' ? localizedMessage('image.state.comfyPreparationUnknown') : localizedMessage('image.state.paidPreparationUnknown') : localizedMessage('image.state.originalNotFoundUnknown') }); return;
    }
    const response = receipt.response;
    const latest = safeTask(await call('image.task.get', { projectId, taskId: response.id }), projectId);
    if (!owned(epoch)) return;
    if (pending.sourceImage && canonicalImageInput(pending.sourceImage) !== canonicalImageInput(latest.sourceImage) || taskIdentity(latest) !== taskIdentity(response as unknown as ImageTaskView) || latest.revision < response.revision) throw problem('INVALID_RESPONSE');
    mergeTask(latest);
    if (clearPending(pending)) emit({ phase: 'ready', ...(pending.operation === 'image.generate' ? { ...(!pending.preserveDraft ? clearedDraft() : {}), selectedGroupId: latest.groupId, versionCursor: null, versionTrail: [] } : {}), message: '已找到原请求，没有重新生成。', displayMessage: localizedMessage('image.state.originalFound') });
  }
  async function refreshComfyAvailability(): Promise<boolean> {
    if (disposed || !visible || !comfyAvailabilityReader) return false;
    const token = ++availabilityEpoch;
    emit({ comfyAvailability: null, comfyAvailabilityPhase: 'loading' });
    try {
      const availability = safeComfyConnectorAvailability(await comfyAvailabilityReader());
      if (disposed || token !== availabilityEpoch) return false;
      emit({ comfyAvailability: availability, comfyAvailabilityPhase: 'ready' }); return true;
    } catch {
      if (!disposed && token === availabilityEpoch) emit({ comfyAvailability: null, comfyAvailabilityPhase: 'error' });
      return false;
    }
  }
  async function load({ automatic = false, refreshAvailability = false }: { automatic?: boolean; refreshAvailability?: boolean } = {}): Promise<boolean> {
    if (disposed || !visible || reading || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || state.phase === 'targeting') return false;
    if (refreshAvailability || state.comfyAvailabilityPhase === 'idle') void refreshComfyAvailability();
    if (!automatic) { polls = 0; emit({ pollPaused: false }); }
    stopTimer(); const epoch = ++readEpoch; reading = true; let pendingRemoteTask: ImageTaskView | null = null;
    emit({ historyPhase: 'loading', ...(!state.loaded ? { phase: state.pending ? 'unknown' : 'loading' } : {}) });
    try {
      await resolvePending(epoch); if (!owned(epoch)) return false;
      if (state.remotePending) {
        const task = safeTask(await call('image.task.get', { projectId, taskId: state.remotePending.input.taskId }), projectId);
        if (!owned(epoch)) return false;
        if (task.providerId !== 'comfy-local' || task.id !== state.remotePending.input.taskId) throw problem('INVALID_RESPONSE');
        pendingRemoteTask = task;
        await observations.read(task.id, imageTaskReview(state, task));
        if (!owned(epoch)) return false;
        if (!state.selectedGroupId) emit({ selectedGroupId: task.groupId });
      }
      if (settingsReader) {
        try { const latest = safeImageSettings(await settingsReader()) as ImageSettingsView; if (!owned(epoch)) return false; emit({ settings: latest }); }
        catch { if (!owned(epoch)) return false; emit({ settings: null, message: '暂时无法核验图像设置。付费生成已暂停，Mock 与已保存记录仍可使用。', displayMessage: localizedMessage('image.state.settingsUnverifiable') }); }
      }
      if (customSettingsReader) {
        try { const latest = safeImageSettings(await customSettingsReader(), 'custom') as ImageSettingsView; if (!owned(epoch)) return false; emit({ customSettings: latest }); }
        catch { if (!owned(epoch)) return false; emit({ customSettings: null }); }
      }
      if (comfySettingsReader) {
        try { const latest = safeComfyImageSettings(await comfySettingsReader()) as ImageSettingsView; if (!owned(epoch)) return false; emit({ comfySettings: latest }); }
        catch { if (!owned(epoch)) return false; emit({ comfySettings: null }); }
      }
      const groupInput = { projectId, limit: IMAGE_LIMITS.pageSize, ...(state.groupCursor ? { cursor: state.groupCursor } : {}) };
      const groups = safePage<ImageGroupResponse>('image.group.list', groupInput, await call('image.group.list', groupInput));
      if (!owned(epoch)) return false;
      const selectedGroupId = state.selectedGroupId || groups.items[0]?.id || null;
      // An accepted group can be outside this page. Resolve it by identity rather
      // than switching to an unrelated first row and dropping its running task.
      for (const groupId of [state.target?.groupId].filter((id): id is string => Boolean(id) && id !== selectedGroupId)) if (!groups.items.some(group => group.id === groupId)) {
        const group = await call('image.group.get', { projectId, groupId });
        if (!isImageGroupResponse(group) || group.projectId !== projectId || group.id !== groupId) throw problem('INVALID_RESPONSE');
        groups.items.push(copy(group));
      }
      if (!owned(epoch)) return false;
      const changed = selectedGroupId !== state.selectedGroupId;
      const taskInput = { projectId, limit: IMAGE_LIMITS.pageSize, ...(selectedGroupId ? { groupId: selectedGroupId } : {}) };
      const versionInput = { projectId, groupId: selectedGroupId, limit: IMAGE_LIMITS.pageSize, ...(!changed && state.versionCursor ? { cursor: state.versionCursor } : {}) };
      const tasks = safePage<ImageTaskView>('image.task.list', taskInput, await call('image.task.list', taskInput));
      if (pendingRemoteTask && !tasks.items.some(task => task.id === pendingRemoteTask?.id)) tasks.items.push(copy(pendingRemoteTask));
      if (!owned(epoch)) return false;
      // Observe completion before reading its committed group/version data. A
      // parallel older empty version page must not stop polling after success.
      if (selectedGroupId) {
        const currentGroup = await call('image.group.get', { projectId, groupId: selectedGroupId });
        if (!isImageGroupResponse(currentGroup) || currentGroup.projectId !== projectId || currentGroup.id !== selectedGroupId) throw problem('INVALID_RESPONSE');
        const index = groups.items.findIndex(item => item.id === selectedGroupId);
        if (index < 0) groups.items.push(copy(currentGroup)); else groups.items[index] = copy(currentGroup);
        if (currentGroup.activeTaskId && !tasks.items.some(task => task.id === currentGroup.activeTaskId)) {
          const task = safeTask(await call('image.task.get', { projectId, taskId: currentGroup.activeTaskId }), projectId);
          if (task.id !== currentGroup.activeTaskId || task.groupId !== selectedGroupId) throw problem('INVALID_RESPONSE');
          tasks.items.push(task);
        }
      }
      if (!owned(epoch)) return false;
      const versions: ImagePage<ImageVersionResponse> = selectedGroupId ? safePage<ImageVersionResponse>('image.version.list', versionInput, await call('image.version.list', versionInput)) : { items: [], nextCursor: null };
      if (!owned(epoch)) return false;
      let pageReviews: ImageReviewView[] = [];
      { // Retained review authority is readable even when current settings are unavailable.
        const input = { projectId, limit: IMAGE_LIMITS.pageSize, ...(state.reviewCursor ? { cursor: state.reviewCursor } : {}) };
        const page = await call('image.review.list', input);
        if (!owned(epoch)) return false;
        if (!isImageReviewListResponse(input, page)) throw problem('INVALID_RESPONSE');
        const reviewPage = page as { items: unknown[]; nextCursor: string | null };
        pageReviews = reviewPage.items.map(review => mergeReview(review));
        const pending = state.pending;
        const pendingReview = pending && pageReviews.find(review => review.requestId === pending.input.requestId && pendingMatchesReview(pending, review));
        if (pending && pendingReview && !pending.reviewId) updatePending(pending, { ...pending, reviewId: pendingReview.id, ...(pendingReview.sourceImage ? { sourceImage: copy(pendingReview.sourceImage) } : {}), ...(pendingReview.input.providerId === 'comfy-local' ? { execution: copy(pendingReview.execution) } : {}) });
        const pinned = state.reviews.find(item => item.id === state.pending?.reviewId);
        emit({ reviews: [...(pinned && !pageReviews.some(item => item.id === pinned.id) ? [pinned] : []), ...pageReviews.map(review => state.reviews.find(item => item.id === review.id) ?? review)], nextReviewCursor: reviewPage.nextCursor });
      }
      if (!owned(epoch)) return false;
      for (const taskId of tracked.keys()) if (!tasks.items.some(task => task.id === taskId)) {
        const task = safeTask(await call('image.task.get', { projectId, taskId }), projectId);
        if (task.id !== taskId) throw problem('INVALID_RESPONSE');
        tasks.items.push(task);
      }
      if (!owned(epoch)) return false;
      for (const task of tasks.items.filter(item => item.providerId === 'comfy-local')) {
        try { await observations.read(task.id, imageTaskReview(state, task)); } catch { if (owned(epoch)) emit({ message: '暂时无法读取此任务的本地远端身份记录。没有查询 ComfyUI 或重新提交生成。', displayMessage: localizedMessage('image.state.remoteIdentityReadFailed') }); }
        if (!owned(epoch)) return false;
      }
      const monotonicTasks = tasks.items.map(task => newestTask(state.tasks.find(item => item.id === task.id), task));
      for (const version of versions.items) { const old = state.versions.find(item => item.id === version.id); if (old && canonicalImageInput(old) !== canonicalImageInput(version)) throw problem('INVALID_RESPONSE'); }
      emit({ groups: groups.items, nextGroupCursor: groups.nextCursor, selectedGroupId, tasks: monotonicTasks, versions: versions.items, nextVersionCursor: versions.nextCursor, ...(changed ? { versionCursor: null, versionTrail: [] } : {}), loaded: true, historyPhase: 'ready', phase: state.pending ? 'unknown' : 'ready' });
      for (const task of monotonicTasks) {
        if (ACTIVE.has(task.state)) tracked.set(task.id, task); else tracked.delete(task.id);
        if (task.state === 'succeeded' && !announced.has(task.id)) { announced.add(task.id); onGenerated(projectId, copy(task)); }
      }
      return true;
    } catch {
      if (owned(epoch)) emit({ historyPhase: 'read_error', phase: state.pending ? 'unknown' : 'read_error', message: state.pending ? '原请求的结果仍待确认。只会重新读取本地记录，不会自动重发。' : '暂时无法读取图像记录。草稿保留，可重新读取。', displayMessage: state.pending ? localizedMessage('image.state.originalOutcomeUnconfirmed') : localizedMessage('image.state.recordsUnavailable') });
      return false;
    } finally { reading = false; if (owned(epoch)) schedule(); }
  }
  async function dispatch(operation: string, input: ImageMutationInput): Promise<boolean> {
    if (disposed || !visible || state.pending || state.storageBlocked || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId) return false;
    const pending: ImagePending = { version: 1, operation, input: copy(input) };
    try { savePending(pending); } catch { emit({ message: '无法保存本地请求凭据，本次尚未发送。请恢复页面存储后再试。', displayMessage: localizedMessage('image.state.receiptSaveFailed') }); return false; }
    stopTimer(); readEpoch++; reading = false; emit({ pending, phase: 'submitting', message: '', displayMessage: null, actionTaskId: input.taskId || null });
    try {
      const result = await call(operation, copy(input));
      if (disposed || state.pending !== pending) return false;
      if (!isImageMutationResponse(operation, input, result)) throw problem('INVALID_RESPONSE');
      const task = safeTask(result, projectId);
      mergeTask(task);
      if (clearPending(pending)) emit({ phase: 'ready', ...(operation === 'image.generate' ? { ...clearedDraft(), selectedGroupId: task.groupId, groupCursor: null, groupTrail: [], versionCursor: null, versionTrail: [] } : {}), message: operation === 'image.generate' ? input.purpose === 'edit' ? '请求已保存。Mock 编辑只生成静态测试卡片，不会实际修改源图。' : '请求已保存。Mock 仅生成确定性测试图案。' : '操作已确认。', displayMessage: operation === 'image.generate' ? input.purpose === 'edit' ? localizedMessage('image.state.mockEditSaved') : localizedMessage('image.state.mockGenerationSaved') : localizedMessage('image.state.operationConfirmed') });
    } catch (error) {
      if (disposed || state.pending !== pending) return false;
      // Only an operation-bound, authoritative rejection may release the intent.
      const rejected = await notAccepted(error, operation, input);
      if (disposed || state.pending !== pending) return false;
      const code = failureCode(error);
      if (code === 'IMAGE_SOURCE_INVALID' && input.purpose === 'edit' && input.providerId === 'mock') { const failedPending = Object.assign(copy(pending), { sourceIssue: 'IMAGE_SOURCE_INVALID' }); if (updatePending(pending, failedPending)) emit({ phase: 'unknown', message: '源图核验报告问题。原请求结果仍未知，原始标识已保留；请重新读取核对，不会重发。', displayMessage: localizedMessage('image.state.sourceIssueUnknown') }); }
      else if (rejected && clearPending(pending)) emit({ phase: 'ready', message: rejectionMessage(code ?? ''), displayMessage: rejectionDescriptor(code ?? '') });
      else emit({ phase: 'unknown', message: '尚未确认原请求是否已接受。正在核对本地记录，不会重新生成。', displayMessage: localizedMessage('image.state.acceptanceUnconfirmed') });
    } finally {
      if (!disposed) { emit({ actionTaskId: null }); if (visible) await load(); }
    }
    return !state.pending;
  }
  function mergeReview(review: unknown): ImageReviewView {
    if (!isImageReviewResponse(review) || review.projectId !== projectId) throw problem('INVALID_RESPONSE');
    const view = reviewViewOf(review);
    const previous = state.reviews.find(item => item.id === view.id);
    if (previous && (reviewIdentity(previous) !== reviewIdentity(view) || previous.revision === view.revision && canonicalImageInput(previous) !== canonicalImageInput(view))) throw problem('INVALID_RESPONSE');
    const next = previous && previous.revision > view.revision ? previous : copy(view);
    rejectionClose.reconcile(next.id, next.revision, next.state, reviewIdentity(next));
    if (next.input.purpose === 'edit' && state.pending?.input.requestId === next.requestId && imageEditReviewMatchesDraft(state, next)) emit({ sourcePreview: copy(next.sourceImage) as unknown as ImageSourcePreview });
    emit({ reviews: [next, ...state.reviews.filter(item => item.id !== next.id)].slice(0, IMAGE_LIMITS.maxPageSize) }); return next;
  }
  function reviewUsable(review: unknown): boolean { return Boolean(record(review) && review.projectId === projectId) && imageReviewCanApprove(state, review); }
  async function approveSaved(review: ImageReviewView, pending: ImagePending): Promise<boolean> {
    if (disposed || !visible || state.pending !== pending || !reviewUsable(review) || !pendingMatchesReview(pending, review)) return false;
    const next: ImagePending = { ...pending, reviewId: review.id, approvalAttempted: true, ...(review.sourceImage ? { sourceImage: copy(review.sourceImage) } : {}) };
    if (!updatePending(pending, next)) return false;
    emit({ phase: 'submitting', reviewActionId: review.id, message: '', displayMessage: null });
    try {
      const result = await reviewClient.approve(copy(review) as unknown as ImageReviewResponse);
      if (disposed || state.pending !== next) return false;
      if (!isImageMutationResponse('image.generate', next.input, result) || canonicalImageInput((result as Record<string, unknown>).sourceImage) !== canonicalImageInput(review.sourceImage)) throw problem('INVALID_RESPONSE');
      const task = safeTask(result, projectId);
      mergeTask(task);
      if (clearPending(next)) emit({ phase: 'ready', ...(!next.preserveDraft ? clearedDraft() : {}), selectedGroupId: task.groupId, groupCursor: null, groupTrail: [], versionCursor: null, versionTrail: [], message: review.input.providerId === 'comfy-local' ? '本地运行请求已保存。最多提交一次；关闭面板不会取消远端 GPU 工作。' : '付费请求已保存。最多发送一次，不会自动重试。', displayMessage: review.input.providerId === 'comfy-local' ? localizedMessage('image.state.comfyRunSaved') : localizedMessage('image.state.paidRequestSaved') });
    } catch (error) {
      const code = failureCode(error), input = review.input;
      if (!disposed && state.pending === next) emit({ phase: 'unknown', message: input.purpose === 'edit' && code === 'IMAGE_SOURCE_INVALID' ? '源图无法通过当前后端核验。此审批不能继续发送；请重新读取原请求，并明确拒绝仍待批准的审批后再选择源图。不会自动重试。' : input.providerId === 'comfy-local' ? '尚未确认本地运行审批结果。只读取原请求，不会自动重新批准、提交或查询远端。' : '尚未确认付费审批结果。只会读取原请求，不会自动重新批准或生成。', displayMessage: input.purpose === 'edit' && code === 'IMAGE_SOURCE_INVALID' ? localizedMessage('image.state.editApprovalSourceInvalid') : input.providerId === 'comfy-local' ? localizedMessage('image.state.comfyApprovalUnknown') : localizedMessage('image.state.paidApprovalUnknown') });
    } finally { if (!disposed) { emit({ reviewActionId: null }); if (visible) await load(); } }
    return !state.pending;
  }
  async function generatePaid(authorization?: unknown): Promise<boolean> {
    if (disposed || !visible || !paidProvider(state.providerId) || !imageCanGenerate(state)) return false;
    if (authorization !== undefined && canonicalImageInput(authorization) !== canonicalImageInput(imagePaidAuthorization(state))) { emit({ message: '描述或连接配置已变化。请核对当前完整地址、模型与配置版本后重新点击付费生成。', displayMessage: localizedMessage('image.state.paidAuthorizationChanged') }); return false; }
    const selected = imageSelectedSettings(state), custom = state.providerId === 'openai-compatible';
    if (!selected) return false;
    const input: ImageMutationInput = { projectId, name: state.draft.name, prompt: state.draft.prompt, providerId: state.providerId, model: selected.configuration.model, options: { ...IMAGE_FIXED_OPTIONS }, requestId: requestId(), ...editInput(state), ...(state.target || {}) };
    if (!imageOperationSchema('image.generate')?.safeParse(input).success) return false;
    const pending: ImagePending = { version: custom ? 2 : 1, operation: 'image.generate', input, settingsRevision: selected.revision, reviewId: null, approvalAttempted: false, ...(custom ? { configuration: copy(selected.configuration) as unknown as Record<string, unknown>, destination: getCustomImageDestination(selected.configuration.baseUrl) } : {}) }, interaction = interactionEpoch;
    try { savePending(pending); } catch { emit({ message: '无法保存原始付费请求，本次尚未发送。', displayMessage: localizedMessage('image.state.paidRequestSaveFailed') }); return false; }
    stopTimer(); readEpoch++; reading = false; emit({ pending, phase: 'submitting', message: '', displayMessage: null });
    const prepareInput = { input: copy(input), settingsRevision: pending.settingsRevision };
    try {
      const prepared = await call('image.review.prepare', prepareInput);
      if (disposed || state.pending !== pending) return false;
      if (!isImageReviewPreparationResponse(prepareInput, prepared) || !isImageReviewResponse(prepared) || !pendingMatchesReview(pending, reviewViewOf(prepared)) || prepared.state !== 'pending') throw problem('INVALID_RESPONSE');
      const review = mergeReview(prepared);
      const next: ImagePending = { ...pending, reviewId: review.id, ...(review.sourceImage ? { sourceImage: copy(review.sourceImage) } : {}) };
      if (!updatePending(pending, next)) return false;
      if (!visible || interactionEpoch !== interaction || !reviewUsable(review)) { emit({ phase: 'unknown', message: '审批内容已保存。页面或配置已变化，请回到原请求并重新明确批准；不会自动发送。', displayMessage: localizedMessage('image.state.preparedScopeChanged') }); return false; }
      if (input.purpose === 'edit') { emit({ phase: 'unknown', message: '源图已通过后端核验，编辑请求已准备。请核对下方固定源图、完整描述和发送目标，再单独批准；目前未发送。', displayMessage: localizedMessage('image.state.editPrepared') }); return true; }
      return await approveSaved(review, next);
    } catch (error) {
      if (disposed || state.pending !== pending) return false;
      emit({ phase: 'unknown', message: input.purpose === 'edit' && failureCode(error) === 'IMAGE_SOURCE_INVALID' ? '源图未通过后端核验。原始准备请求仍保留，尚未批准或发送。请重新读取；没有已保存审批时，可明确放弃此未批准请求后重新选择源图。' : '审批准备结果待核对。尚未发起付费审批，不会自动重试。', displayMessage: input.purpose === 'edit' && failureCode(error) === 'IMAGE_SOURCE_INVALID' ? localizedMessage('image.state.preparationSourceInvalid') : localizedMessage('image.state.paidPreparationPending') });
      return false;
    }
    finally { if (!disposed && state.phase === 'submitting') emit({ phase: 'unknown' }); if (!disposed && visible && !state.reviewActionId) await load(); }
  }
  async function prepareComfy(): Promise<boolean> {
    if (disposed || !visible || state.providerId !== 'comfy-local' || !imageCanGenerate(state)) return false;
    const selected = state.comfySettings;
    if (!selected) return false;
    const input: ImageMutationInput = { projectId, name: state.draft.name, prompt: state.draft.prompt, providerId: 'comfy-local', model: selected.configuration.model, options: { ...COMFY_IMAGE_OPTIONS }, requestId: requestId(), ...editInput(state), ...(state.target || {}) };
    if (!imageOperationSchema('image.generate')?.safeParse(input).success) return false;
    const pending: ImagePending = { version: 3, operation: 'image.generate', input, settingsRevision: selected.revision, reviewId: null, approvalAttempted: false, configuration: copy(selected.configuration) as unknown as Record<string, unknown>, destination: getComfyImageDestination(selected.configuration.baseUrl), execution: null };
    try { savePending(pending); } catch { emit({ message: '无法保存本地运行请求凭据，没有准备或发送生成。', displayMessage: localizedMessage('image.state.comfyReceiptSaveFailed') }); return false; }
    stopTimer(); readEpoch++; reading = false; emit({ pending, phase: 'submitting', message: '', displayMessage: null });
    try {
      const prepareInput = { input: copy(input), settingsRevision: pending.settingsRevision };
      const prepared = await call('image.review.prepare', prepareInput);
      if (disposed || state.pending !== pending) return false;
      if (!isImageReviewPreparationResponse(prepareInput, prepared) || !isImageReviewResponse(prepared) || !pendingMatchesReview(pending, reviewViewOf(prepared)) || prepared.state !== 'pending') throw problem('INVALID_RESPONSE');
      const review = mergeReview(prepared);
      if (!updatePending(pending, { ...pending, reviewId: review.id, execution: review.execution ? copy(review.execution) : null })) return false;
      emit({ phase: 'unknown', message: '本地运行请求已准备。请核对下方实际地址、种子和完整冻结工作流，再单独批准；目前未发送生成。', displayMessage: localizedMessage('image.state.comfyPrepared') }); return true;
    } catch { if (!disposed) emit({ phase: 'unknown', message: '准备结果待核对。尚未批准运行，不会自动重试。请重新读取已保存审批。', displayMessage: localizedMessage('image.state.comfyPreparationPending') }); return false; }
    finally { if (!disposed && state.phase === 'submitting') emit({ phase: 'unknown' }); if (!disposed && visible) await load(); }
  }
  async function chooseTarget(groupId: string | null): Promise<boolean> {
    if (disposed || !visible || state.pending || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || reading || state.phase === 'targeting') return false;
    const group = groupId ? state.groups.find(item => item.id === groupId) : null;
    if (groupId && (!group || group.activeTaskId)) return false;
    if (!groupId) { interactionEpoch++; emit({ ...clearedDraft(), targetRequest: null, message: '', displayMessage: null }); return true; }
    const targetGroup = group as ImageGroupResponse;
    const epoch = ++selectionEpoch; let reloadHistory = false;
    emit({ phase: 'targeting', targetRequest: null }); stopTimer();
    try {
      const input = { projectId, groupId, limit: 1 };
      const page = safePage<ImageVersionResponse>('image.version.list', input, await call('image.version.list', input));
      let task: ImageTaskView | null = null;
      const firstVersion = page.items[0];
      if (firstVersion) task = safeTask(await call('image.task.get', { projectId, taskId: firstVersion.taskId }), projectId);
      if (disposed || selectionEpoch !== epoch || !visible) return false;
      if (task && task.groupId !== groupId) throw problem('INVALID_RESPONSE');
      reloadHistory = state.selectedGroupId !== groupId || state.versionCursor !== null;
      interactionEpoch++;
      emit({ mode: 'text', inputImage: null, sourcePreview: null, draft: { name: targetGroup.name, prompt: task?.prompt || '' }, target: { groupId: groupId as string, expectedRevision: targetGroup.revision }, selectedGroupId: groupId, versionCursor: null, versionTrail: [], message: '已载入历史描述。这是按描述重新生成，不会读取旧图；点击生成才会创建此组的新版本。', displayMessage: localizedMessage('image.state.historicalPromptLoaded') });
      return true;
    } catch { if (!disposed && selectionEpoch === epoch) emit({ message: '无法读取此组的原始描述，未改变草稿。', displayMessage: localizedMessage('image.state.historicalPromptUnavailable') }); return false; }
    finally { if (!disposed && selectionEpoch === epoch) { emit({ phase: state.pending ? 'unknown' : 'ready' }); if (reloadHistory && visible) await load(); else schedule(); } }
  }
  const composerEditable = (): boolean => !disposed && visible && !state.pending && !state.remotePending && !state.remoteActionTaskId && !state.actionTaskId && !state.reviewActionId && state.phase !== 'targeting';
  function chooseEditReview(reviewId: string): boolean {
    if (!composerEditable()) return false;
    const review = state.reviews.find(item => item.id === reviewId && item.state === 'pending' && item.projectId === projectId && (item.input as unknown as Record<string, unknown>).purpose === 'edit');
    if (!review) return false;
    const input = review.input as unknown as Record<string, unknown>;
    const groupId = typeof input.groupId === 'string' ? input.groupId : null;
    const expectedRevision = typeof input.expectedRevision === 'number' ? input.expectedRevision : 0;
    interactionEpoch++;
    emit({ mode: 'edit', providerId: input.providerId as ImageProviderId, draft: { name: input.name as string ?? '', prompt: input.prompt as string ?? '' }, inputImage: copy(input.inputImage as unknown as ImageInputImage), sourcePreview: copy(review.sourceImage as unknown as ImageSourcePreview), target: groupId ? { groupId, expectedRevision } : null, targetRequest: null, ...(groupId ? { selectedGroupId: groupId } : {}), message: '已载入这份固定编辑请求。请核对源图、描述与发送目标，再单独批准。', displayMessage: localizedMessage('image.state.fixedEditLoaded') }); if (groupId) void load(); return true;
  }
  return {
    getState: (): ImageGenerationState => copy(state), getNativeCloseState: rejectionClose.getState, load, generatePaid, prepareComfy,
    setSettings(value: unknown): boolean { if (disposed) return false; const settings = safeImageSettings(value) as ImageSettingsView; if (canonicalImageInput(state.settings) !== canonicalImageInput(settings)) interactionEpoch++; emit({ settings }); return true; },
    setCustomSettings(value: unknown): boolean { if (disposed) return false; const customSettings = safeImageSettings(value, 'custom') as ImageSettingsView; if (canonicalImageInput(state.customSettings) !== canonicalImageInput(customSettings)) interactionEpoch++; emit({ customSettings }); return true; },
    setComfyAvailability(value: unknown): boolean { if (disposed) return false; availabilityEpoch++; let comfyAvailability: unknown = null; try { comfyAvailability = safeComfyConnectorAvailability(value); } catch {} emit({ comfyAvailability, comfyAvailabilityPhase: comfyAvailability ? 'ready' : 'error' }); return Boolean(comfyAvailability); },
    setComfySettings(value: unknown): boolean { if (disposed) return false; const comfySettings = safeComfyImageSettings(value) as ImageSettingsView; if (canonicalImageInput(state.comfySettings) !== canonicalImageInput(comfySettings)) interactionEpoch++; emit({ comfySettings }); return true; },
    selectMode(mode: string): boolean { if (!composerEditable() || !['text', 'edit'].includes(mode)) return false; interactionEpoch++; emit({ mode: mode as ImageMode, targetRequest: null, message: '', displayMessage: null }); return true; },
    selectSource(asset: ImageEditAsset | null | undefined): boolean {
      if (!composerEditable() || state.mode !== 'edit') return false;
      if (asset && imageEditSourceIssue(asset, projectId)) return false;
      interactionEpoch++;
      emit({ inputImage: asset ? { assetId: asset.id as string, sha256: asset.sha256 as string } : null, sourcePreview: asset ? { assetId: asset.id as string, sha256: asset.sha256, name: asset.name, mimeType: asset.mimeType, width: asset.width, height: asset.height, byteLength: asset.sizeBytes } : null, targetRequest: null, message: '', displayMessage: null }); return true;
    },
    requestEditReview(review: unknown): boolean { if (!composerEditable() || !state.reviews.some(item => item.id === (record(review) ? review.id : undefined) && canonicalImageInput(item) === canonicalImageInput(review))) return false; if (imageDraftDirty(state)) { emit({ targetRequest: { reviewId: record(review) && typeof review.id === 'string' ? review.id : '' } }); return false; } return chooseEditReview(record(review) && typeof review.id === 'string' ? review.id : ''); },
    selectProvider(providerId: string): boolean { if (disposed || !visible || state.pending || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || !['mock', 'openai', 'openai-compatible', 'comfy-local'].includes(providerId)) return false; interactionEpoch++; emit({ providerId: providerId as ImageProviderId }); return true; },
    async approveReview(review: unknown): Promise<boolean> {
      if (!isImageReviewResponse(review)) return false;
      const reviewValue = reviewViewOf(review);
      if (disposed || !visible || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || !reviewUsable(reviewValue) || !state.reviews.some(item => item.id === reviewValue.id && canonicalImageInput(item) === canonicalImageInput(reviewValue))) return false;
      if (state.pending && (state.pending.reviewId !== reviewValue.id || !pendingMatchesReview(state.pending, reviewValue))) return false;
      let pending = state.pending;
      if (!pending) {
        const input = reviewValue.input, providerId = input.providerId;
        pending = { version: providerId === 'comfy-local' ? 3 : providerId === 'openai-compatible' ? 2 : 1, operation: 'image.generate', input: copy(reviewValue.input) as unknown as ImageMutationInput, settingsRevision: reviewValue.settingsRevision, reviewId: reviewValue.id, approvalAttempted: false, preserveDraft: input.purpose !== 'edit', ...(reviewValue.sourceImage ? { sourceImage: copy(reviewValue.sourceImage) } : {}), ...(['openai-compatible', 'comfy-local'].includes(providerId as string) ? { configuration: reviewValue.configuration, destination: reviewValue.destination ?? undefined } : {}), ...(providerId === 'comfy-local' ? { execution: reviewValue.execution ?? null } : {}) };
        try { savePending(pending); } catch { emit({ message: '无法保存原始审批请求，本次未发送。', displayMessage: localizedMessage('image.state.approvalRequestSaveFailed') }); return false; }
        emit({ pending });
      }
      stopTimer(); readEpoch++; reading = false;
      return approveSaved(reviewValue, pending);
    },
    async rejectReview(reviewValue: unknown): Promise<boolean> {
      if (!isImageReviewResponse(reviewValue)) return false;
      const review = reviewViewOf(reviewValue);
      if (disposed || !visible || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId || state.phase === 'submitting' || state.reviews.some(item => item.id === review.id && canonicalImageInput(item) === canonicalImageInput(review)) === false) return false;
      rejectionClose.begin(review.id, review.revision, reviewIdentity(review));
      stopTimer(); readEpoch++; reading = false; emit({ reviewActionId: review.id });
      try {
        const rejected = await reviewClient.reject(copy(review) as unknown as ImageReviewResponse);
        if (disposed) return false;
        if (!isImageReviewResponse(rejected) || rejected.id !== review.id || reviewIdentity(rejected) !== reviewIdentity(review) || rejected.state !== 'rejected') throw problem('INVALID_RESPONSE');
        mergeReview(rejected);
        if (state.pending?.reviewId === review.id) clearPending(state.pending);
        emit({ phase: state.pending ? 'unknown' : 'ready', message: '已拒绝此原始请求，不会生成图像。', displayMessage: localizedMessage('image.state.requestRejected') }); return true;
      } catch { if (!disposed) emit({ message: '拒绝结果待确认。只会重新读取，不会自动重试。', displayMessage: localizedMessage('image.state.rejectionUnknown') }); return false; }
      finally { if (!disposed) { emit({ reviewActionId: null }); if (visible) await load(); } }
    },
    abandonUnapproved(): boolean {
      const pending = state.pending;
      if (disposed || !visible || state.phase === 'submitting' || state.reviewActionId || !pending || !reviewedProvider(pending.input.providerId) || pending.approvalAttempted || pending.reviewId) return false;
      if (clearPending(pending)) { emit({ phase: 'ready', message: '已放弃本页尚未批准的请求。若准备记录随后出现，仍需明确批准或拒绝。', displayMessage: localizedMessage('image.state.unapprovedAbandoned') }); return true; } return false;
    },
    edit(field: string, value: string): boolean { if (!disposed && visible && !state.pending && !state.remotePending && !state.remoteActionTaskId && !state.actionTaskId && !state.reviewActionId && state.phase !== 'targeting' && ['name', 'prompt'].includes(field) && !(field === 'name' && state.target)) { interactionEpoch++; emit({ draft: { ...state.draft, [field]: value } as ImageDraft, targetRequest: null }); return true; } return false; },
    async generate(): Promise<boolean> {
      if (!visible || state.providerId !== 'mock' || !imageCanGenerate(state)) return false;
      const input: ImageMutationInput = { projectId, name: state.draft.name, prompt: state.draft.prompt, providerId: 'mock', model: IMAGE_MODELS.mock, options: { ...IMAGE_FIXED_OPTIONS }, requestId: requestId(), ...editInput(state), ...(state.target || {}) };
      if (!imageOperationSchema('image.generate')?.safeParse(input).success) return false;
      return dispatch('image.generate', input);
    },
    async act(action: string, task: ImageTaskResponse | null | undefined): Promise<boolean> {
      if (!visible || !task || !state.tasks.some(item => item.id === task.id && item.revision === task.revision) || state.pending || state.actionTaskId || state.reviewActionId) return false;
      const current = state.tasks.find(item => item.id === task.id) as ImageTaskResponse;
      if (action === 'cancelQueued' ? !CANCELABLE.has(current.state) || current.dispatched : action !== 'recoverResult' || !['local_result_error', 'outcome_unknown'].includes(current.state)) return false;
      return dispatch(`image.task.${action}`, { projectId, taskId: current.id, expectedRevision: current.revision, requestId: requestId() });
    },
    async observeRemote(task: ImageTaskResponse | null | undefined): Promise<boolean> {
      if (disposed || !visible || reading || state.pending || state.actionTaskId || state.reviewActionId || !task || !state.tasks.some(item => item.id === task.id && canonicalImageInput(item) === canonicalImageInput(task)) || !comfyCanObserve(state, task)) return false;
      stopTimer(); readEpoch++; reading = false;
      const accepted = await observations.observe(task);
      if (!disposed && visible) await load();
      return Boolean(accepted);
    },
    requestTarget(groupId: string | null = null): boolean | Promise<boolean> { if (!visible || state.pending || state.remotePending || state.remoteActionTaskId || state.actionTaskId || state.reviewActionId) return false; if (imageDraftDirty(state)) { emit({ targetRequest: { groupId } }); return false; } return chooseTarget(groupId); },
    confirmTarget(): Promise<boolean> | boolean { const request = state.targetRequest; if (!request) return false; if (request.reviewId) return chooseEditReview(request.reviewId); return chooseTarget(request.groupId ?? null); },
    keepDraft(): void { emit({ targetRequest: null }); },
    async selectGroup(groupId: string): Promise<boolean> { if (!visible || state.remotePending || state.remoteActionTaskId || reading || !state.groups.some(group => group.id === groupId)) return false; emit({ selectedGroupId: groupId, versionCursor: null, versionTrail: [] }); return load(); },
    async pageGroups(older: boolean): Promise<boolean> { if (!visible || state.remotePending || state.remoteActionTaskId || reading || (older ? !state.nextGroupCursor : !state.groupTrail.length)) return false; const trail = [...state.groupTrail], cursor = older ? state.nextGroupCursor : trail.pop() ?? null; if (older) trail.push(state.groupCursor); emit({ groupCursor: cursor, groupTrail: trail, selectedGroupId: null, versionCursor: null, versionTrail: [] }); return load(); },
    async pageVersions(older: boolean): Promise<boolean> { if (!visible || state.remotePending || state.remoteActionTaskId || reading || (older ? !state.nextVersionCursor : !state.versionTrail.length)) return false; const trail = [...state.versionTrail], cursor = older ? state.nextVersionCursor : trail.pop() ?? null; if (older) trail.push(state.versionCursor); emit({ versionCursor: cursor, versionTrail: trail }); return load(); },
    async pageReviews(older: boolean): Promise<boolean> { if (!visible || reading || state.reviewActionId || (older ? !state.nextReviewCursor : !state.reviewTrail.length)) return false; const trail = [...state.reviewTrail], cursor = older ? state.nextReviewCursor : trail.pop() ?? null; if (older) trail.push(state.reviewCursor); emit({ reviewCursor: cursor, reviewTrail: trail }); return load(); },
    setVisible(value: boolean): void { if (disposed) return; const changed = visible !== Boolean(value); visible = Boolean(value); observations.setVisible(visible); if (changed) interactionEpoch++; if (!visible) { stopTimer(); selectionEpoch++; if (state.phase === 'targeting') emit({ phase: 'ready' }); } else if (changed) { polls = 0; void load(); } },
    dispose(): void { rejectionClose.dispose(); observations.dispose(); disposed = true; availabilityEpoch++; readEpoch++; selectionEpoch++; interactionEpoch++; stopTimer(); for (const controller of calls) controller.abort(); },
  };
}

// Display-only companions keep legacy diagnostics and business identities unchanged.
const taskLabelDescriptors: Record<string, DisplayMessage> = { queued: localizedMessage('image.state.queued'), dispatching: localizedMessage('image.state.dispatching'), receiving: localizedMessage('image.state.receiving'), persisting: localizedMessage('image.state.saving'), succeeded: localizedMessage('image.state.succeeded'), cancelled_before_dispatch: localizedMessage('image.state.cancelledBeforeDispatch'), interrupted_before_dispatch: localizedMessage('image.state.interruptedBeforeDispatch'), failed: localizedMessage('image.state.failed'), outcome_unknown: localizedMessage('image.state.outcomeUnknown'), local_result_error: localizedMessage('image.state.localResultError') };
export const imageTaskLabelDescriptor = (state: string): DisplayMessage => Object.hasOwn(taskLabelDescriptors, state) ? taskLabelDescriptors[state] : localizedMessage('image.state.statusUnconfirmed');

const taskMessageDescriptors: Record<string, DisplayMessage> = { interrupted_before_dispatch: localizedMessage('image.state.interruptedDisclosure'), outcome_unknown: localizedMessage('image.state.unknownDisclosure'), local_result_error: localizedMessage('image.state.localRecoveryDisclosure'), cancelled_before_dispatch: localizedMessage('image.state.cancellationConfirmed'), failed: localizedMessage('image.state.requestEnded') };
export const imageTaskMessageDescriptor = (state: string): DisplayMessage | null => Object.hasOwn(taskMessageDescriptors, state) ? taskMessageDescriptors[state] : null;

const customPreDispatchDescriptors: Record<string, DisplayMessage> = Object.freeze({
  IMAGE_NETWORK_DENIED: localizedMessage('image.state.customNetworkDenied'),
  IMAGE_CONNECTION_FAILED: localizedMessage('image.state.customConnectionFailed'),
  IMAGE_TIMEOUT: localizedMessage('image.state.customTimeout'),
  IMAGE_DISPATCH_BLOCKED: localizedMessage('image.state.customDispatchBlocked'),
  IMAGE_SETTINGS_CONFLICT: localizedMessage('image.state.customSettingsConflict'),
  IMAGE_SETTINGS_NOT_CONFIGURED: localizedMessage('image.state.customUnconfigured'),
  IMAGE_SETTINGS_DISABLED: localizedMessage('image.state.customDisabled'),
} as Record<string, DisplayMessage>);

const rejectionDescriptors: Record<string, DisplayMessage> = { IMAGE_SOURCE_INVALID: localizedMessage('image.state.sourceRejected'), IMAGE_LIVE_DISABLED: localizedMessage('image.state.liveDisabled'), IMAGE_GROUP_BUSY: localizedMessage('image.state.groupBusy'), IMAGE_REVISION_CONFLICT: localizedMessage('image.state.revisionConflict'), IMAGE_QUEUE_FULL: localizedMessage('image.state.queueFull'), IMAGE_CAPACITY: localizedMessage('image.state.capacityReached'), IMAGE_STATE_CONFLICT: localizedMessage('image.state.stateConflict'), IMAGE_RESULT_INVALID: localizedMessage('image.state.invalidLocalResult') };
const rejectionDescriptor = (code: string): DisplayMessage => Object.hasOwn(rejectionDescriptors, code) ? rejectionDescriptors[code] : localizedMessage('image.state.notAcceptedFallback');

export function imageInputIssueDescriptor(draft: ImageDraft): DisplayMessage | null {
  if (!draft.name.trim()) return localizedMessage('image.state.nameRequired');
  if (draft.name.length > 120) return localizedMessage('image.state.nameLimit');
  if (!draft.prompt.trim()) return localizedMessage('image.state.promptRequired');
  if (draft.prompt.length > IMAGE_LIMITS.promptCharacters || new TextEncoder().encode(draft.prompt).length > IMAGE_LIMITS.promptBytes) return localizedMessage('image.state.promptLimit', { promptCharacters: IMAGE_LIMITS.promptCharacters });
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(draft.prompt)) return localizedMessage('image.state.promptControlCharacters');
  return null;
}

export function imageEditSourceIssueDescriptor(asset: ImageEditAsset | null | undefined, projectId: string): DisplayMessage | null {
  if (!asset || asset.projectId !== projectId || !imageEditInputImageSchema.safeParse({ assetId: asset.id, sha256: asset.sha256 }).success) return localizedMessage('image.state.invalidAssetIdentity');
  if (asset.mimeType !== 'image/png') return localizedMessage('image.state.pngOnly');
  if (!['user-import', 'generated', 'synthetic-mock', 'extracted-frame'].includes(asset.provenance as string)) return localizedMessage('image.state.unsupportedSourceOrigin');
  if (typeof asset.sizeBytes !== 'number' || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 1 || asset.sizeBytes > IMAGE_EDIT_LIMITS.sourceBytes) return localizedMessage('image.state.sourceByteLimit');
  if (typeof asset.width !== 'number' || typeof asset.height !== 'number' || ![asset.width, asset.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= IMAGE_EDIT_LIMITS.sourceMaxEdge) || asset.width * asset.height > IMAGE_EDIT_LIMITS.sourceMaxPixels) return localizedMessage('image.state.sourceDimensions');
  return null;
}

export const imageEditDraftIssueDescriptor = (state: ImageGenerationState): DisplayMessage | null => state.mode !== 'edit' ? null : !['mock', 'openai'].includes(state.providerId) ? localizedMessage('image.state.editProvidersOnly') : !imageEditInputImageSchema.safeParse(state.inputImage).success ? localizedMessage('image.state.sourceRequired') : null;

export function imageTaskConnectionDescriptors(task: ImageTaskView | null | undefined): DisplayMessage[] {
  if (task?.providerId !== 'openai-compatible' || task.state !== 'failed' || task.dispatched !== false || !Object.hasOwn(customPreDispatchDescriptors, task.errorCode ?? '')) return [];
  return [customPreDispatchDescriptors[task.errorCode ?? ''], localizedMessage('image.state.customNotDispatched', { value: '' })];
}
