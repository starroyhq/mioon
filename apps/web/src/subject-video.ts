import { message } from '../../../packages/i18n/src/index.ts';
import { isSubjectReference } from '@mioon/contracts';

export const SUBJECT_VIDEO_KINDS = ['character', 'product', 'location'];
export const ARK_SUBJECT_MODEL = 'doubao-seedance-2-5-260628';
export const ARK_SUBJECT_WARNING = 'Ark 不支持直接上传真实人脸图片。请勿选择含真实人脸的主体图；工作台不进行人脸检测，也不提供身份锁定。';
export const MOCK_SUBJECT_WARNING = 'Mock 仅验证工作流，输出为测试图案，不会呈现主体图片或提示词描述的内容。';
const contentKeys = ['sha256', 'mimeType', 'width', 'height'];
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export function subjectVideoChoice(subject, version) {
  if (!subject || !version || !SUBJECT_VIDEO_KINDS.includes(subject.kind) || version.subjectId !== subject.id || version.projectId !== subject.projectId) return null;
  const reference = { subjectVersionId: version.id, subjectName: subject.name, subjectKind: subject.kind, subjectVersion: clone(version) };
  return isSubjectReference(reference) ? freeze(reference) : null;
}

// This is an explicit, unsent session choice. It never consults planning
// bindings, resolves the latest head, changes a shot, or rewrites its prompt.
export function subjectVideoConflictIssue(shot = {}, { savedShot = shot, boundReference = false } = {}) {
  if (boundReference) return '主体图片不能与首帧连线一起提交。请先明确断开首帧连线，再选择本次主体输入。';
  if ([shot, savedShot].some(value => value?.referenceAssetIds?.length || value?.lastFrameAssetId)) return '主体图片不能与首帧或尾帧组合。请手动清除首帧与尾帧选择，并保存镜头后再启用；不会自动清除素材。';
  return '';
}

export function subjectVideoReferenceIssue(reference, assets = [], projectId) {
  if (!reference) return '请明确选择一个主体及其固定图片版本，不会自动选用当前版本或策划关联。';
  if (!isSubjectReference(reference)) return '主体固定版本记录不完整，请重新明确选择版本。';
  const version = reference.subjectVersion;
  if (projectId && version.projectId !== projectId) return '主体固定版本不属于当前项目，请重新选择。';
  const asset = assets.find(item => item.id === version.assetId && item.projectId === version.projectId);
  if (!asset) return '主体固定版本的原图未加载或已缺失，不能提交。';
  if (contentKeys.some(key => asset[key] !== version[key])) return '主体固定版本的原图内容或元数据已变化，不能替换后提交。请核对原图。';
  return '';
}

export function subjectVideoSnapshot(shot, reference, assets) {
  const version = reference?.subjectVersion;
  const asset = assets.find(item => item.id === version?.assetId && item.projectId === version?.projectId);
  return { ...shot, subjectReference: clone(reference), referenceAssetIds: [version.assetId],
    referenceAssets: [{ ...asset, role: 'subject_reference' }],
    referenceBindings: [{ role: 'subject_reference', assetId: version.assetId, sha256: version.sha256 }] };
}

export function subjectVideoIdentity(reference) {
  return reference ? JSON.stringify(reference) : '';
}

export function subjectVideoSourceLabel(version) {
  const provenance = version?.provenance;
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
export function subjectVideoProfileIdentity(provider, model) {
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return canonical([provider?.id, model, provider?.providerRegion, provider?.inputProfileVersion,
    provider?.inputProfiles?.filter(profile => profile.model === model), provider?.profileEvaluationDate,
    provider?.inputProfileEvaluations]);
}

// Display-only sidecars. The legacy strings above remain exact for existing callers;
// no descriptor is added to frozen references, request snapshots, or provenance.
export const ARK_SUBJECT_WARNING_MESSAGE = message('subjects.warning.ark');
export const MOCK_SUBJECT_WARNING_MESSAGE = message('subjects.warning.mock');
export function subjectVideoConflictDescriptor(shot = {}, { savedShot = shot, boundReference = false } = {}) {
  if (boundReference) return message('subjects.conflict.boundFrame');
  if ([shot, savedShot].some(value => value?.referenceAssetIds?.length || value?.lastFrameAssetId)) return message('subjects.conflict.frames');
  return null;
}
export function subjectVideoReferenceDescriptor(reference, assets = [], projectId) {
  if (!reference) return message('subjects.reference.choose');
  if (!isSubjectReference(reference)) return message('subjects.reference.incomplete');
  const version = reference.subjectVersion;
  if (projectId && version.projectId !== projectId) return message('subjects.reference.foreign');
  const asset = assets.find(item => item.id === version.assetId && item.projectId === version.projectId);
  if (!asset) return message('subjects.reference.missing');
  if (contentKeys.some(key => asset[key] !== version[key])) return message('subjects.reference.changed');
  return null;
}
export function subjectVideoSourceDescriptor(version) {
  const provenance = version?.provenance;
  if (!provenance) return message('subjects.source.missing');
  if (provenance.kind === 'user-import') return message('subjects.source.import');
  if (provenance.kind === 'extracted-frame') return message('subjects.source.frame');
  if (provenance.kind === 'synthetic-mock') return message('subjects.source.mock');
  if (provenance.kind === 'generated') return message(provenance.imageSource ? 'subjects.source.imageGenerated' : 'subjects.source.videoGenerated');
  if (provenance.kind === 'export') return message('subjects.source.export');
  return message('subjects.source.recorded');
}
