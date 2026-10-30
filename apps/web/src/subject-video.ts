import { message } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage } from '../../../packages/i18n/src/index.ts';
import { isSubjectReference } from '@mioon/contracts';
import type { SubjectReference } from '@mioon/contracts';

export interface SubjectRecord {readonly id: string; readonly projectId: string; readonly name: string; readonly kind: string; readonly [key: string]: unknown}
export interface SubjectVersionRecord {
  readonly id: string; readonly subjectId: string; readonly projectId: string; readonly assetId: string;
  readonly sha256?: unknown; readonly mimeType?: unknown; readonly width?: unknown; readonly height?: unknown;
  readonly provenance?: Record<string, unknown>|null; readonly [key: string]: unknown;
}
export interface SubjectAssetLike {readonly id?: unknown; readonly projectId?: unknown; readonly sha256?: unknown; readonly mimeType?: unknown; readonly width?: unknown; readonly height?: unknown; readonly [key: string]: unknown}
export interface SubjectShotLike {readonly id?: unknown; readonly projectId?: unknown; readonly referenceAssetIds?: unknown; readonly lastFrameAssetId?: unknown; readonly [key: string]: unknown}
export interface SubjectConflictOptions {readonly savedShot?: SubjectShotLike; readonly boundReference?: boolean}
export interface SubjectProviderLike {
  readonly id?: unknown; readonly providerRegion?: unknown; readonly inputProfileVersion?: unknown;
  readonly inputProfiles?: readonly {readonly model?: unknown; readonly [key: string]: unknown}[];
  readonly profileEvaluationDate?: unknown; readonly inputProfileEvaluations?: unknown;
}
export interface SubjectVideoReferenceIssueOptions {readonly assets?: readonly SubjectAssetLike[]; readonly projectId?: unknown}

export const SUBJECT_VIDEO_KINDS = ['character', 'product', 'location'] as const;
export const ARK_SUBJECT_MODEL = 'doubao-seedance-2-5-260628';
export const ARK_SUBJECT_WARNING = 'Ark 不支持直接上传真实人脸图片。请勿选择含真实人脸的主体图；工作台不进行人脸检测，也不提供身份锁定。';
export const MOCK_SUBJECT_WARNING = 'Mock 仅验证工作流，输出为测试图案，不会呈现主体图片或提示词描述的内容。';
const contentKeys = ['sha256', 'mimeType', 'width', 'height'] as const;
const isRecord=(value: unknown): value is Record<string, unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const property=(value: unknown,key: string): unknown=>isRecord(value)?value[key]:undefined;
const clone=<T>(value: T): T=>JSON.parse(JSON.stringify(value)) as T;
const freeze=<T>(value: T): Readonly<T>=>{ if (value && typeof value === 'object') { Object.values(value as unknown as Record<string, unknown>).forEach(item=>freeze(item)); Object.freeze(value); } return value; };

export function subjectVideoChoice(subject: SubjectRecord|null|undefined,version: SubjectVersionRecord|null|undefined): SubjectReference|null {
  if (!subject || !version || !(SUBJECT_VIDEO_KINDS as readonly string[]).includes(subject.kind) || version.subjectId !== subject.id || version.projectId !== subject.projectId) return null;
  const reference = { subjectVersionId: version.id, subjectName: subject.name, subjectKind: subject.kind, subjectVersion: clone(version) };
  return isSubjectReference(reference) ? freeze(reference) : null;
}

// This is an explicit, unsent session choice. It never consults planning
// bindings, resolves the latest head, changes a shot, or rewrites its prompt.
export function subjectVideoConflictIssue(shot: SubjectShotLike = {},{ savedShot = shot, boundReference = false }: SubjectConflictOptions = {}): string {
  if (boundReference) return '主体图片不能与首帧连线一起提交。请先明确断开首帧连线，再选择本次主体输入。';
  const hasFrame=(value: SubjectShotLike|undefined): boolean=>Boolean((Array.isArray(value?.referenceAssetIds) && value.referenceAssetIds.length) || value?.lastFrameAssetId);
  if ([shot, savedShot].some(hasFrame)) return '主体图片不能与首帧或尾帧组合。请手动清除首帧与尾帧选择，并保存镜头后再启用；不会自动清除素材。';
  return '';
}

export function subjectVideoReferenceIssue(reference: unknown,assets: readonly SubjectAssetLike[] = [],projectId?: unknown): string {
  if (!reference) return '请明确选择一个主体及其固定图片版本，不会自动选用当前版本或策划关联。';
  if (!isSubjectReference(reference)) return '主体固定版本记录不完整，请重新明确选择版本。';
  const version = reference.subjectVersion;
  if (projectId && version.projectId !== projectId) return '主体固定版本不属于当前项目，请重新选择。';
  const asset = assets.find(item => property(item,'id') === version.assetId && property(item,'projectId') === version.projectId);
  if (!asset) return '主体固定版本的原图未加载或已缺失，不能提交。';
  if (contentKeys.some(key => property(asset,key) !== property(version,key))) return '主体固定版本的原图内容或元数据已变化，不能替换后提交。请核对原图。';
  return '';
}

export function subjectVideoSnapshot(shot: SubjectShotLike,reference: SubjectReference,assets: readonly SubjectAssetLike[]) {
  const version = reference.subjectVersion;
  const asset = assets.find(item => property(item,'id') === version.assetId && property(item,'projectId') === version.projectId);
  return { ...shot, subjectReference: clone(reference), referenceAssetIds: [version.assetId],
    referenceAssets: [{ ...asset, role: 'subject_reference' }],
    referenceBindings: [{ role: 'subject_reference', assetId: version.assetId, sha256: version.sha256 }] };
}

export function subjectVideoIdentity(reference: SubjectReference|null|undefined): string {
  return reference ? JSON.stringify(reference) : '';
}

export function subjectVideoSourceLabel(version: SubjectVersionRecord|null|undefined): string {
  const provenance = isRecord(version?.provenance)?version.provenance:null;
  if (!provenance) return '来源未提供';
  if (provenance.kind === 'user-import') return '用户导入图片';
  if (provenance.kind === 'extracted-frame') return '从视频提取的固定帧';
  if (provenance.kind === 'synthetic-mock') return 'Mock 工作流测试图片';
  if (provenance.kind === 'generated') return provenance.imageSource ? '图像生成结果' : '视频生成结果';
  if (provenance.kind === 'export') return '导出素材';
  return '已记录图片来源';
}

// A paid subject approval includes the exact server route and profile, as well
// as immutable source metadata. Poll-only fields do not invalidate the review.
export function subjectVideoProfileIdentity(provider: SubjectProviderLike|null|undefined,model: unknown): string {
  const canonical = (value: unknown): string => JSON.stringify(value, (_: string,item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return canonical([provider?.id, model, provider?.providerRegion, provider?.inputProfileVersion,
    (provider?.inputProfiles ?? []).filter(profile => profile.model === model), provider?.profileEvaluationDate,
    provider?.inputProfileEvaluations]);
}

// Display-only sidecars. The legacy strings above remain exact for existing callers;
// no descriptor is added to frozen references, request snapshots, or provenance.
export const ARK_SUBJECT_WARNING_MESSAGE = message('subjects.warning.ark');
export const MOCK_SUBJECT_WARNING_MESSAGE = message('subjects.warning.mock');
export function subjectVideoConflictDescriptor(shot: SubjectShotLike = {},{ savedShot = shot, boundReference = false }: SubjectConflictOptions = {}): DisplayMessage|null {
  if (boundReference) return message('subjects.conflict.boundFrame');
  const hasFrame=(value: SubjectShotLike|undefined): boolean=>Boolean((Array.isArray(value?.referenceAssetIds) && value.referenceAssetIds.length) || value?.lastFrameAssetId);
  if ([shot, savedShot].some(hasFrame)) return message('subjects.conflict.frames');
  return null;
}
export function subjectVideoReferenceDescriptor(reference: unknown,assets: readonly SubjectAssetLike[] = [],projectId?: unknown): DisplayMessage|null {
  if (!reference) return message('subjects.reference.choose');
  if (!isSubjectReference(reference)) return message('subjects.reference.incomplete');
  const version = reference.subjectVersion;
  if (projectId && version.projectId !== projectId) return message('subjects.reference.foreign');
  const asset = assets.find(item => property(item,'id') === version.assetId && property(item,'projectId') === version.projectId);
  if (!asset) return message('subjects.reference.missing');
  if (contentKeys.some(key => property(asset,key) !== property(version,key))) return message('subjects.reference.changed');
  return null;
}
export function subjectVideoSourceDescriptor(version: SubjectVersionRecord|null|undefined): DisplayMessage {
  const provenance = isRecord(version?.provenance)?version.provenance:null;
  if (!provenance) return message('subjects.source.missing');
  if (provenance.kind === 'user-import') return message('subjects.source.import');
  if (provenance.kind === 'extracted-frame') return message('subjects.source.frame');
  if (provenance.kind === 'synthetic-mock') return message('subjects.source.mock');
  if (provenance.kind === 'generated') return message(provenance.imageSource ? 'subjects.source.imageGenerated' : 'subjects.source.videoGenerated');
  if (provenance.kind === 'export') return message('subjects.source.export');
  return message('subjects.source.recorded');
}

// Seedance 2.5 reference images filled from a shot's subject bindings (4c),
// only when the user asks. This drafts the explicit, ordered list the user
// sees and can edit before paying; the request still names exact asset IDs and
// the server never reads bindings to choose generation inputs. No image is
// converted, cropped or replaced to pass the model's rules: an unusable one is
// listed with the reason.
export const SUBJECT_REFERENCE_KIND_ORDER = ['character', 'product', 'location', 'look'] as const;
export type SubjectReferenceIssue = 'version' | 'asset' | 'changed' | 'format' | 'size' | 'dimensions' | 'ratio' | 'count' | 'budget';
export interface SubjectReferenceRules {
  readonly mimeTypes: readonly string[]; readonly maxBytes: number; readonly minDimension: number; readonly maxDimension: number;
  readonly minAspectRatio: number; readonly maxAspectRatio: number; readonly maxImages: number; readonly maxEncodedBytes: number;
}
export interface SubjectReferenceCandidate {
  readonly bindingId: string; readonly subjectId: string; readonly name: string | null; readonly kind: string | null; readonly role: string;
  readonly versionId: string; readonly versionNumber: number | null; readonly assetId: string | null; readonly needsReview: boolean;
  readonly issue: SubjectReferenceIssue | null;
}
export interface SubjectReferencePlan {
  readonly phase: 'loading' | 'ready';
  readonly candidates: readonly SubjectReferenceCandidate[];
  readonly images: readonly { readonly role: 'reference_image'; readonly assetId: string }[];
}
interface SubjectBindingLike {readonly id: string; readonly subjectId: string; readonly role: string; readonly subjectVersionId: string | null; readonly needsReview?: boolean; readonly createdAt?: string}
type VersionLike = SubjectVersionRecord & {readonly number?: unknown};
export interface SubjectReferenceStateLike {
  readonly bindings: Readonly<Record<string, {readonly phase: string; readonly items: readonly SubjectBindingLike[]; readonly nextCursor: string | null} | undefined>>;
  readonly subjects: Readonly<Record<string, (SubjectRecord & {readonly headVersion?: VersionLike}) | undefined>>;
  readonly versions: Readonly<Record<string, {readonly known?: Readonly<Record<string, VersionLike>>} | undefined>>;
}
/** The exact model's reference-image rules, read from its server-built input profile. */
export function seedanceReferenceRules(provider: {readonly inputProfiles?: unknown} | null | undefined, model: unknown, capabilities: Record<string, unknown> | null | undefined): SubjectReferenceRules | null {
  const profile = (Array.isArray(provider?.inputProfiles) ? provider.inputProfiles as unknown[] : []).find(item => property(item, 'model') === model);
  const role = property(property(property(profile, 'inputs'), 'roles'), 'reference_image');
  const dimensions = property(role, 'dimensions'), number = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (!capabilities || property(role, 'implemented') !== true || !Array.isArray(property(role, 'mimeTypes'))) return null;
  return {mimeTypes: (property(role, 'mimeTypes') as unknown[]).filter((item): item is string => typeof item === 'string'), maxBytes: number(property(role, 'maxBytes'), 0),
    minDimension: number(property(dimensions, 'min'), 1), maxDimension: number(property(dimensions, 'max'), Infinity),
    minAspectRatio: number(property(dimensions, 'minAspectRatio'), 0), maxAspectRatio: number(property(dimensions, 'maxAspectRatio'), Infinity),
    maxImages: number(property(role, 'max'), 0), maxEncodedBytes: number(capabilities.maxEncodedImageBytes, Infinity)};
}
/** Active bindings in a fixed order: subjects before styles, then character,
 * product, location, look, then the order they were bound. Each uses the
 * version its binding pinned, even when a newer one awaits review. */
export function subjectReferencePlan(state: SubjectReferenceStateLike | null | undefined, shotId: string | null | undefined, assets: readonly SubjectAssetLike[], projectId: unknown, rules: SubjectReferenceRules): SubjectReferencePlan {
  const entry = shotId ? state?.bindings[shotId] : undefined;
  if (!state || !entry || entry.phase !== 'ready' || entry.nextCursor) return {phase: 'loading', candidates: [], images: []};
  const kindRank = (subjectId: string): number => { const index = (SUBJECT_REFERENCE_KIND_ORDER as readonly string[]).indexOf(state.subjects[subjectId]?.kind ?? ''); return index < 0 ? SUBJECT_REFERENCE_KIND_ORDER.length : index; };
  const active = entry.items.filter(row => row.subjectVersionId !== null).sort((a, b) => Number(a.role === 'style') - Number(b.role === 'style') || kindRank(a.subjectId) - kindRank(b.subjectId) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')) || a.id.localeCompare(b.id));
  const images: {role: 'reference_image'; assetId: string}[] = [], included = new Set<string>();
  let encoded = 0;
  const candidates = active.map((binding): SubjectReferenceCandidate => {
    const subject = state.subjects[binding.subjectId], versionId = binding.subjectVersionId as string;
    const version = subject?.headVersion?.id === versionId ? subject.headVersion : state.versions[binding.subjectId]?.known?.[versionId];
    const issue = ((): SubjectReferenceIssue | null => {
      if (!version || version.subjectId !== binding.subjectId) return 'version';
      const asset = assets.find(item => property(item, 'id') === version.assetId && property(item, 'projectId') === projectId && version.projectId === projectId);
      if (!asset) return 'asset';
      if (contentKeys.some(key => property(asset, key) !== property(version, key))) return 'changed';
      const mimeType = String(property(asset, 'mimeType')), size = Number(property(asset, 'sizeBytes')), width = Number(property(asset, 'width')), height = Number(property(asset, 'height'));
      if (!rules.mimeTypes.includes(mimeType)) return 'format';
      if (!Number.isSafeInteger(size) || size <= 0 || size > rules.maxBytes) return 'size';
      if (!(width >= rules.minDimension && height >= rules.minDimension && width <= rules.maxDimension && height <= rules.maxDimension)) return 'dimensions';
      if (width / height < rules.minAspectRatio || width / height > rules.maxAspectRatio) return 'ratio';
      if (included.has(version.assetId)) return null;
      if (images.length >= rules.maxImages) return 'count';
      // Mioon sends each image as a Base64 data URI inside one request body.
      const bytes = `data:${mimeType};base64,`.length + 4 * Math.ceil(size / 3);
      if (encoded + bytes > rules.maxEncodedBytes) return 'budget';
      encoded += bytes; included.add(version.assetId); images.push({role: 'reference_image', assetId: version.assetId});
      return null;
    })();
    return {bindingId: binding.id, subjectId: binding.subjectId, name: subject?.name ?? null, kind: subject?.kind ?? null, role: binding.role,
      versionId, versionNumber: typeof version?.number === 'number' ? version.number : null, assetId: version?.assetId ?? null, needsReview: Boolean(binding.needsReview), issue};
  });
  return {phase: 'ready', candidates, images};
}
/** "Name V2" for an image that is a bound subject version of this shot, else null. */
export function subjectReferenceLabel(plan: SubjectReferencePlan | null | undefined, assetId: string): string | null {
  const candidate = plan?.candidates.find(item => item.assetId === assetId && item.issue !== 'version' && item.issue !== 'asset' && item.issue !== 'changed' && item.name);
  return candidate ? `${candidate.name}${candidate.versionNumber === null ? '' : ` V${candidate.versionNumber}`}` : null;
}
