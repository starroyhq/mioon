import { message as msg, renderMessage, translate } from '../../../packages/i18n/src/index.ts';
export const REFERENCE_SOURCE_HANDLE = 'first-frame-out';
export const REFERENCE_TARGET_HANDLE = 'first-frame-in';
export const VISUAL_SOURCE_HANDLE = 'visual-out';
export const VISUAL_TARGET_HANDLE = 'visual-in';

export const isReferenceEdge = edge => edge?.kind === 'reference';
export const referenceForShot = (edges = [], shotId) => edges.find(edge => isReferenceEdge(edge) && edge.target === shotId);
export const isReferenceOperation = operation => ['reference.attach', 'reference.detach'].includes(operation);
export const hasPendingReference = (entries = []) => entries.some(entry => isReferenceOperation(entry.operation));

const referenceName = (value, fallback) => typeof value === 'string' && value.trim() ? value : fallback;
const hasReferenceId = value => typeof value === 'string' && value.length > 0;

export function referenceSourceDetails({ sourceId, assetId, projectId, nodes = [], assets = [], locale = 'zh-Hans' }) {
  const t = (key, params) => translate(locale, key, params);
  const scoped = hasReferenceId(projectId);
  // Resolve the edge's stored asset independently; a stale node must never
  // silently replace it or expose a record from another project.
  const source = scoped && hasReferenceId(sourceId) && hasReferenceId(assetId)
    ? nodes.find(node => node.id === sourceId && node.projectId === projectId && node.type === 'image' && node.assetId === assetId) : undefined;
  const asset = scoped && hasReferenceId(assetId)
    ? assets.find(item => item.id === assetId && item.projectId === projectId && item.mimeType?.startsWith('image/')) : undefined;
  // SourcePanel only receives one node, so a shortened ID cannot be checked
  // for collisions. Keep the full identity alongside the human-readable name.
  const sourceName = source ? referenceName(source.label, t('assets.reference.unnamedNode')) : t('assets.reference.sourceUnavailable');
  const sourceLabel = source ? t('assets.reference.nodeIdentity', { name: sourceName, id: source.id }) : sourceName;
  const assetLabel = asset ? referenceName(asset.name, t('assets.reference.unnamedAsset')) : t('assets.reference.assetUnavailable');
  return { source, asset, sourceName, sourceLabel, assetLabel, displayDescription: t('assets.reference.sourceDetails', { asset: assetLabel, node: sourceName }), description: t('assets.reference.sourceDetails', { asset: assetLabel, node: sourceLabel }) };
}

export function referenceTargetOptions(shots = [], projectId, locale = 'zh-Hans') {
  const t = (key, params) => translate(locale, key, params);
  if (!hasReferenceId(projectId)) return [];
  // The caller supplies storyboard order. Number that scoped list, rather than
  // orderIndex values which need not be contiguous, to distinguish equal titles.
  return shots.filter(shot => shot.projectId === projectId && hasReferenceId(shot.id)).map((shot, index) => ({
    shot, label: t('assets.reference.targetOption', { number: String(index + 1).padStart(2, '0'), name: referenceName(shot.title, t('assets.reference.unnamedShot')) }),
  }));
}

export function isImageReferenceNode(node, assets = [], projectId = node?.projectId) {
  const asset = assets.find(item => item.id === node?.assetId);
  // Attach validates managed-asset metadata; generation resolves and verifies
  // the frozen file. Never offer external URLs, media-less nodes or other projects.
  return Boolean(node?.type === 'image' && node.projectId === projectId && asset?.projectId === projectId && asset.mimeType?.startsWith('image/'));
}

export function referenceAttachIssueDescriptor({ source, shot, assets = [], edges = [], projectId }) {
  if (!isImageReferenceNode(source, assets, projectId)) return msg('assets.reference.requiresImage');
  if (!shot || shot.projectId !== projectId) return msg('assets.reference.chooseTarget');
  const bound = referenceForShot(edges, shot.id);
  if (bound) return bound.source === source.id ? msg('assets.reference.alreadyConnected') : msg('assets.reference.otherConnected');
  if (shot.referenceAssetIds?.length) return msg('assets.reference.manualSelected');
  return '';
}

export function referenceAttachIssue(input) { return renderMessage('zh-Hans', referenceAttachIssueDescriptor(input)); }
export function canvasEdge(edge, selected = false, locale = 'zh-Hans') {
  const t = (key, params) => translate(locale, key, params);
  const reference = isReferenceEdge(edge);
  return {
    id: edge.id, source: edge.source, target: edge.target, selected,
    sourceHandle: reference ? REFERENCE_SOURCE_HANDLE : VISUAL_SOURCE_HANDLE,
    targetHandle: reference ? REFERENCE_TARGET_HANDLE : VISUAL_TARGET_HANDLE,
    type: 'smoothstep', animated: false, interactionWidth: 20,
    label: reference ? t('assets.reference.firstFrame') : t('shell.node.visualOnly'),
    ariaLabel: reference ? t('shell.referenceLink') : t('assets.reference.visualOnlyAria'),
    className: reference ? 'reference-edge' : 'visual-edge',
    style: { stroke: reference ? 'var(--wb-accent-line)' : 'var(--wb-soft)', strokeWidth: reference ? 2 : 1, ...(reference ? {} : { strokeDasharray: '5 5' }) },
    labelStyle: { fill: reference ? 'var(--wb-text)' : 'var(--wb-muted)', fontSize: 10 },
    labelBgStyle: { fill: 'var(--wb-panel)', fillOpacity: .96 }, labelBgPadding: [7, 4], labelBgBorderRadius: 4,
  };
}
