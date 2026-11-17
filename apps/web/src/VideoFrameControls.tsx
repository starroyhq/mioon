import {ProjectMediaImage} from './project-media-read-gate.tsx';
import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import Icon from './icons.tsx';
import { assetUrl } from './api.ts';
import { generationReferencePreview } from './generation-settings.ts';
import type { GenerationAsset, GenerationShot } from './generation-settings.ts';

type Translate = ReturnType<typeof useI18n>['t'];
import './video-frame-controls.css';

const roleLabel = (role: string, t: Translate): string => role === 'first_frame' ? t('timeline.references.first') : role === 'last_frame' ? t('timeline.references.last') : role === 'reference_image' ? t('video.wan.referenceImages') : t('timeline.references.role', { role });

export function AssetIdentityDetails({ assetId, sha256 }: {assetId?: string; sha256?: string | null}) {
  const { t } = useI18n();
  return <details className="asset-identity-details" data-testid="asset-identity-details">
    <summary>{t('timeline.references.identity')}</summary>
    <dl>
      <dt>{t('timeline.references.id')}</dt><dd>{assetId}</dd>
      <dt>SHA-256</dt><dd>{sha256 || t('timeline.references.noHash')}</dd>
    </dl>
  </details>;
}

// Display the complete manifest, including unresolved historical identities.
// A job's frozen manifest is never expanded from the current shot selection.
export function VideoFrameSummary({ shot, assets = [], frozen = false, compact = false, showIdentity = true }: {shot?: GenerationShot; assets?: readonly GenerationAsset[]; frozen?: boolean; compact?: boolean; showIdentity?: boolean}) {
  const { t } = useI18n();
  const references = generationReferencePreview(shot || {}, assets, { frozen });
  if (!references.length) return null;
  return <div className={`video-frame-summary ${compact ? 'compact' : ''}`} data-testid="video-frame-summary" aria-label={t('timeline.references.all')}>
    {references.map((reference, index) => <div className="video-frame-summary-item" key={`${reference.role}:${reference.assetId}:${index}`} data-testid={`video-frame-summary-${reference.role}`}>
      {reference.asset ? <ProjectMediaImage asset={reference.asset} src={assetUrl(reference.asset)} alt={t('timeline.references.alt', { role: roleLabel(reference.role, t), name: reference.name || t('timeline.references.unnamedImage') })} /> : <span className="video-frame-thumbnail-missing">{t('timeline.references.unavailable')}</span>}
      <div><strong>{reference.role === 'reference_image' ? t('video.wan.imageNumber', { number: index + 1, name: roleLabel(reference.role, t) }) : roleLabel(reference.role, t)}</strong><span className="video-frame-name">{reference.name || t('timeline.references.unnamedAsset')}</span>
        {showIdentity && <AssetIdentityDetails assetId={reference.assetId} sha256={reference.sha256} />}
      </div>
    </div>)}
  </div>;
}

export interface VideoFrameDraft {lastFrameAssetId?: string | null; [key: string]: unknown}
type FrameAssetWithId = GenerationAsset & {id: string; name: string};
export default function VideoFrameControls({ draft, assets, disabled, issue, onChoose, onClear }: {
  draft: VideoFrameDraft; assets: readonly FrameAssetWithId[]; disabled?: boolean; issue?: string | null; onChoose: (assetId: string) => void; onClear: () => void;
}) {
  const { t } = useI18n();
  const lastFrameAssetId = draft.lastFrameAssetId;
  if (!assets.length && !lastFrameAssetId && !issue) return null;
  const missing = lastFrameAssetId && !assets.some(asset => asset.id === lastFrameAssetId);
  return <section className="video-last-frame" aria-label={t('timeline.references.last')} data-testid="video-last-frame-controls">
    <div className="field-label">{t('timeline.references.last')}</div>
    {assets.length > 0 && <div className="reference-grid">{assets.map(asset => {
      const selected = lastFrameAssetId === asset.id;
      return <Button variant="ghost" size="sm" key={asset.id} title={asset.name} className={`reference-choice ${selected ? 'selected' : ''}`} data-testid={`last-frame-choice-${asset.id}`} aria-label={t('timeline.references.lastAria', { name: asset.name })} aria-pressed={selected} disabled={disabled} onClick={() => onChoose(asset.id)}><ProjectMediaImage asset={asset} src={assetUrl(asset)} alt={asset.name} />{selected && <span><Icon name="check" size={11} /></span>}</Button>;
    })}</div>}
    {issue && <p className="capability-issue" role="status" data-testid="last-frame-issue">{issue}</p>}
    {missing && <p className="capability-issue" role="status" data-testid="last-frame-missing">{t('timeline.references.missing')}</p>}
    {lastFrameAssetId && <Button variant="ghost" size="sm" className="text-button" data-testid="clear-last-frame" disabled={disabled} onClick={onClear}>{t('timeline.references.clear')}</Button>}
  </section>;
}
