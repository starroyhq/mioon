import { message as msg, renderMessage, translate } from '../../../packages/i18n/src/index.ts';
import type { DisplayMessage, Locale, MessageParameters } from '../../../packages/i18n/src/index.ts';
import type { MessageKey } from '../../../packages/i18n/src/index.ts';
export type ReferenceRecord=Record<string,unknown>;
export interface ReferenceNode extends ReferenceRecord {readonly id?: unknown; readonly projectId?: unknown; readonly type?: unknown; readonly assetId?: unknown; readonly label?: unknown; readonly [key: string]: unknown}
export interface ReferenceAsset extends ReferenceRecord {readonly id?: unknown; readonly projectId?: unknown; readonly mimeType?: unknown; readonly name?: unknown; readonly [key: string]: unknown}
export interface ReferenceShot extends ReferenceRecord {readonly id?: unknown; readonly projectId?: unknown; readonly title?: unknown; readonly referenceAssetIds?: unknown; readonly [key: string]: unknown}
export interface ReferenceEdge extends ReferenceRecord {readonly id?: unknown; readonly kind?: unknown; readonly source?: unknown; readonly target?: unknown; readonly [key: string]: unknown}
export interface ReferenceSourceDetailsOptions {
  readonly sourceId?: unknown;
  readonly assetId?: unknown;
  readonly projectId?: unknown;
  readonly nodes?: readonly unknown[];
  readonly assets?: readonly unknown[];
  readonly locale?: Locale;
}
export interface ReferenceTargetOption {readonly shot: ReferenceShot; readonly label: string}
export interface ReferenceAttachIssueOptions {
  readonly source?: unknown;
  readonly shot?: unknown;
  readonly assets?: readonly unknown[];
  readonly edges?: readonly unknown[];
  readonly projectId?: unknown;
}
export interface CanvasEdge {
  id: unknown; source: unknown; target: unknown; selected: boolean;
  sourceHandle: string; targetHandle: string; type: 'smoothstep'; animated: boolean; interactionWidth: number;
  label: string; ariaLabel: string; className: string;
  style: Record<string, unknown>; labelStyle: Record<string, unknown>; labelBgStyle: Record<string, unknown>;
  labelBgPadding: [number, number]; labelBgBorderRadius: number;
}
export const REFERENCE_SOURCE_HANDLE = 'first-frame-out';
export const REFERENCE_TARGET_HANDLE = 'first-frame-in';
export const VISUAL_SOURCE_HANDLE = 'visual-out';
export const VISUAL_TARGET_HANDLE = 'visual-in';

const property=(value: unknown,key: string): unknown=>value!==null&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>)[key]:undefined;
export const isReferenceEdge=(edge: unknown): boolean=>property(edge,'kind') === 'reference';
export const referenceForShot=(edges: readonly unknown[] = [],shotId: unknown): unknown=>edges.find(edge => isReferenceEdge(edge) && property(edge,'target') === shotId);
export const isReferenceOperation=(operation: unknown): boolean=>['reference.attach', 'reference.detach'].includes(String(operation));
export const hasPendingReference=(entries: readonly unknown[] = []): boolean=>entries.some(entry => isReferenceOperation(property(entry,'operation')));

const referenceName=(value: unknown,fallback: string): string=>typeof value === 'string' && value.trim() ? value : fallback;
const hasReferenceId=(value: unknown): boolean=>typeof value === 'string' && value.length > 0;

export function referenceSourceDetails({ sourceId, assetId, projectId, nodes = [], assets = [], locale = 'zh-Hans' as Locale }: ReferenceSourceDetailsOptions) {
  const t = (key: MessageKey, params?: MessageParameters): string => translate(locale, key, params as never);
  const scoped = hasReferenceId(projectId);
  // Resolve the edge's stored asset independently; a stale node must never
  // silently replace it or expose a record from another project.
  const source = scoped && hasReferenceId(sourceId) && hasReferenceId(assetId)
    ? nodes.find(node => property(node,'id') === sourceId && property(node,'projectId') === projectId && property(node,'type') === 'image' && property(node,'assetId') === assetId) : undefined;
  const asset = scoped && hasReferenceId(assetId)
    ? assets.find(item => property(item,'id') === assetId && property(item,'projectId') === projectId && String(property(item,'mimeType') ?? '').startsWith('image/')) : undefined;
  // SourcePanel only receives one node, so a shortened ID cannot be checked
  // for collisions. Keep the full identity alongside the human-readable name.
  const sourceName = source ? referenceName(property(source,'label'), t('assets.reference.unnamedNode')) : t('assets.reference.sourceUnavailable');
  const sourceLabel = source ? t('assets.reference.nodeIdentity', { name: sourceName, id: String(property(source,'id')) }) : sourceName;
  const assetLabel = asset ? referenceName(property(asset,'name'), t('assets.reference.unnamedAsset')) : t('assets.reference.assetUnavailable');
  return { source, asset, sourceName: String(sourceName), sourceLabel: String(sourceLabel), assetLabel: String(assetLabel), displayDescription: t('assets.reference.sourceDetails', { asset: String(assetLabel), node: String(sourceName) }), description: t('assets.reference.sourceDetails', { asset: String(assetLabel), node: String(sourceLabel) }) };
}

export function referenceTargetOptions(shots: readonly unknown[] = [],projectId: unknown,locale: Locale = 'zh-Hans'): ReferenceTargetOption[] {
  const t = (key: MessageKey, params?: MessageParameters): string => translate(locale, key, params as never);
  if (!hasReferenceId(projectId)) return [];
  // The caller supplies storyboard order. Number that scoped list, rather than
  // orderIndex values which need not be contiguous, to distinguish equal titles.
  return shots.filter(shot => property(shot,'projectId') === projectId && hasReferenceId(property(shot,'id'))).map((shot, index) => ({
    shot: shot as ReferenceShot, label: t('assets.reference.targetOption', { number: String(index + 1).padStart(2, '0'), name: referenceName(property(shot,'title'), t('assets.reference.unnamedShot')) }),
  }));
}

export function isImageReferenceNode(node: unknown,assets: readonly unknown[] = [],projectId: unknown = property(node,'projectId')): boolean {
  const asset = assets.find(item => property(item,'id') === property(node,'assetId'));
  // Attach validates managed-asset metadata; generation resolves and verifies
  // the frozen file. Never offer external URLs, media-less nodes or other projects.
  return Boolean(property(node,'type') === 'image' && property(node,'projectId') === projectId && property(asset,'projectId') === projectId && String(property(asset,'mimeType') ?? '').startsWith('image/'));
}

export function referenceAttachIssueDescriptor({ source, shot, assets = [], edges = [], projectId }: ReferenceAttachIssueOptions): DisplayMessage|string {
  if (!isImageReferenceNode(source, assets, projectId)) return msg('assets.reference.requiresImage');
  if (!shot || property(shot,'projectId') !== projectId) return msg('assets.reference.chooseTarget');
  const bound = referenceForShot(edges, property(shot,'id'));
  if (bound) return property(bound,'source') === property(source,'id') ? msg('assets.reference.alreadyConnected') : msg('assets.reference.otherConnected');
  const references=property(shot,'referenceAssetIds');
  if (Array.isArray(references) && references.length) return msg('assets.reference.manualSelected');
  return '';
}
export function referenceAttachIssue(input: ReferenceAttachIssueOptions): string { return renderMessage('zh-Hans', referenceAttachIssueDescriptor(input)); }
export function canvasEdge(edge: unknown,selected = false,locale: Locale = 'zh-Hans'): CanvasEdge {
  const t = (key: MessageKey, params?: MessageParameters): string => translate(locale, key, params as never);
  const reference = isReferenceEdge(edge);
  return {
    id: property(edge,'id'), source: property(edge,'source'), target: property(edge,'target'), selected,
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
