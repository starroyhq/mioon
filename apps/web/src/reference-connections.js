export const REFERENCE_SOURCE_HANDLE = 'first-frame-out';
export const REFERENCE_TARGET_HANDLE = 'first-frame-in';
export const VISUAL_SOURCE_HANDLE = 'visual-out';
export const VISUAL_TARGET_HANDLE = 'visual-in';

export const isReferenceEdge = edge => edge?.kind === 'reference';
export const referenceForShot = (edges = [], shotId) => edges.find(edge => isReferenceEdge(edge) && edge.target === shotId);
export const isReferenceOperation = operation => ['reference.attach', 'reference.detach'].includes(operation);
export const hasPendingReference = (entries = []) => entries.some(entry => isReferenceOperation(entry.operation));

export function isImageReferenceNode(node, assets = [], projectId = node?.projectId) {
  const asset = assets.find(item => item.id === node?.assetId);
  // Attach validates managed-asset metadata; generation resolves and verifies
  // the frozen file. Never offer external URLs, media-less nodes or other projects.
  return Boolean(node?.type === 'image' && node.projectId === projectId && asset?.projectId === projectId && asset.mimeType?.startsWith('image/'));
}

export function referenceAttachIssue({ source, shot, assets = [], edges = [], projectId }) {
  if (!isImageReferenceNode(source, assets, projectId)) return '首帧连接需要当前项目中已导入的图片节点。';
  if (!shot || shot.projectId !== projectId) return '请选择当前项目中的目标镜头。';
  const bound = referenceForShot(edges, shot.id);
  if (bound) return bound.source === source.id ? '此图片已连接到该镜头。' : '该镜头已有首帧连接。请先在镜头设置中断开，再连接新图片。';
  if (shot.referenceAssetIds?.length) return '该镜头已手动选择参考图。请打开镜头设置，清除手动参考图并保存后再连接。';
  return '';
}

export function canvasEdge(edge, selected = false) {
  const reference = isReferenceEdge(edge);
  return {
    id: edge.id, source: edge.source, target: edge.target, selected,
    sourceHandle: reference ? REFERENCE_SOURCE_HANDLE : VISUAL_SOURCE_HANDLE,
    targetHandle: reference ? REFERENCE_TARGET_HANDLE : VISUAL_TARGET_HANDLE,
    type: 'smoothstep', animated: false, interactionWidth: 20,
    label: reference ? '首帧参考' : '视觉连线 · 不参与生成',
    ariaLabel: reference ? '首帧参考连接' : '视觉连线，不参与生成',
    className: reference ? 'reference-edge' : 'visual-edge',
    style: { stroke: reference ? '#b8d68f' : '#758296', strokeWidth: reference ? 2.5 : 1.5, ...(reference ? {} : { strokeDasharray: '5 5' }) },
    labelStyle: { fill: reference ? '#d5ebbb' : '#a9b5c5', fontSize: 10 },
    labelBgStyle: { fill: '#202830', fillOpacity: .96 }, labelBgPadding: [7, 4], labelBgBorderRadius: 4,
  };
}
