/** Read-only comparison of existing managed shot-video versions. No selection RPC. */
export interface ComparisonVersion {
  id: string; projectId: string; shotId: string; assetId: string; sha256: string;
  number: number; providerId?: string; model?: string; createdAt?: string; isMock?: boolean;
  snapshot?: { prompt?: string; duration?: number; aspectRatio?: string; model?: string; referenceAssetIds?: readonly string[]; parameters?: { seed?: number } };
}
export interface ComparisonAsset { id: string; projectId: string; sha256: string; mimeType: string }
export interface ComparisonContext {
  scope: string | null; projectId: string | null; workspaceOrigin: string | null;
  connected: boolean; visible: boolean; restored: boolean;
  shot: { id: string; projectId: string; title?: string; selectedVersionId?: string | null } | null;
  versions: readonly ComparisonVersion[]; assets: readonly ComparisonAsset[];
}
export interface ComparisonBinding {
  readonly scope: string; readonly projectId: string; readonly shotId: string;
  readonly versionId: string; readonly assetId: string; readonly sha256: string;
  readonly number: number; readonly key: string; readonly url: string;
  readonly metadata: Readonly<{ prompt: string | null; duration: number | null; aspectRatio: string | null;
    provider: string | null; model: string | null; createdAt: string | null; isMock: boolean; references: string | null; seed: number | null }>;
}
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown, max = 12000): string | null => typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
export function comparisonAvailable(context: ComparisonContext): boolean {
  return Boolean(context.connected && context.visible && !context.restored && context.workspaceOrigin === 'normal' && context.scope &&
    id(context.projectId) && context.shot && id(context.shot.id) && context.shot.projectId === context.projectId);
}
export function captureComparison(context: ComparisonContext, versionId: string): ComparisonBinding | null {
  if (!comparisonAvailable(context) || !id(versionId)) return null;
  const matches = context.versions.filter(version => version.id === versionId);
  if (matches.length !== 1) return null;
  const version = matches[0];
  if (version.projectId !== context.projectId || version.shotId !== context.shot!.id || !id(version.assetId) || !hash(version.sha256) ||
    !Number.isSafeInteger(version.number) || version.number < 1) return null;
  const assets = context.assets.filter(asset => asset.id === version.assetId);
  if (assets.length !== 1 || assets[0].projectId !== context.projectId || assets[0].sha256 !== version.sha256 || assets[0].mimeType !== 'video/mp4') return null;
  const metadata = Object.freeze({ prompt: text(version.snapshot?.prompt),
    duration: typeof version.snapshot?.duration === 'number' && Number.isFinite(version.snapshot.duration) && version.snapshot.duration > 0 ? version.snapshot.duration : null,
    aspectRatio: text(version.snapshot?.aspectRatio, 40), provider: text(version.providerId, 200),
    model: text(version.model, 200) || text(version.snapshot?.model, 200),
    createdAt: typeof version.createdAt === 'string' && Number.isFinite(Date.parse(version.createdAt)) ? version.createdAt : null, isMock: version.isMock === true,
    references: Array.isArray(version.snapshot?.referenceAssetIds) && version.snapshot.referenceAssetIds.length <= 100 && version.snapshot.referenceAssetIds.every(id) ? version.snapshot.referenceAssetIds.join(', ') : null,
    seed: Number.isSafeInteger(version.snapshot?.parameters?.seed) ? version.snapshot!.parameters!.seed! : null });
  const identity = { projectId: context.projectId!, shotId: context.shot!.id, versionId, assetId: version.assetId, sha256: version.sha256, workspaceOrigin: 'normal' };
  return Object.freeze({ ...identity, scope: context.scope!, number: version.number, metadata,
    key: JSON.stringify([context.scope, identity, version.number, metadata]),
    url: `/api/version-comparison/media?${new URLSearchParams(identity)}` });
}
export function comparisonCurrent(binding: ComparisonBinding | null, context: ComparisonContext): boolean {
  return Boolean(binding && captureComparison(context, binding.versionId)?.key === binding.key);
}
export function comparisonOptions(context: ComparisonContext): readonly ComparisonBinding[] {
  return context.versions.map(version => captureComparison(context, version.id)).filter((value): value is ComparisonBinding => value !== null)
    .sort((a, b) => b.number - a.number || a.versionId.localeCompare(b.versionId));
}
export function comparisonPairCurrent(a: ComparisonBinding | null, b: ComparisonBinding | null, context: ComparisonContext): boolean {
  return Boolean(a && b && a.versionId !== b.versionId && comparisonCurrent(a, context) && comparisonCurrent(b, context));
}
