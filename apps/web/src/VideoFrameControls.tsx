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

// Display the complete manifest, including unresolved historical identities.
// A job's frozen manifest is never expanded from the current shot selection.
export function VideoFrameSummary({ shot, assets = [], frozen = false, compact = false }: {shot?: GenerationShot; assets?: readonly GenerationAsset[]; frozen?: boolean; compact?: boolean}) {
  const { t } = useI18n();
  const references = generationReferencePreview(shot || {}, assets, { frozen });
  if (!references.length) return <p className="input-hint" data-testid="video-frame-summary-empty">{t('timeline.references.none')}</p>;
  return <div className={`video-frame-summary ${compact ? 'compact' : ''}`} data-testid="video-frame-summary" aria-label={t('timeline.references.all')}>
    {references.map((reference, index) => <div className="video-frame-summary-item" key={`${reference.role}:${reference.assetId}:${index}`} data-testid={`video-frame-summary-${reference.role}`}>
      {reference.asset ? <img src={assetUrl(reference.asset)} alt={t('timeline.references.alt', { role: roleLabel(reference.role, t), name: reference.name || t('timeline.references.unnamedImage') })} /> : <span className="video-frame-thumbnail-missing">{t('timeline.references.unavailable')}</span>}
      <div><strong>{reference.role === 'reference_image' ? t('video.wan.imageNumber', { number: index + 1, name: roleLabel(reference.role, t) }) : roleLabel(reference.role, t)}</strong><span className="video-frame-name">{reference.name || t('timeline.references.unnamedAsset')}</span>
        <details className="video-frame-identity"><summary>{t('timeline.references.identity')}</summary><dl><dt>{t('timeline.references.id')}</dt><dd>{reference.assetId}</dd><dt>SHA-256</dt><dd>{reference.sha256 || t('timeline.references.noHash')}</dd></dl></details>
      </div>
    </div>)}
  </div>;
}

export interface VideoFrameDraft {lastFrameAssetId?: string | null; [key: string]: unknown}
type FrameAssetWithId = GenerationAsset & {id: string; name: string};
export default function VideoFrameControls({ draft, assets, disabled, onChoose, onClear }: {
  draft: VideoFrameDraft; assets: readonly FrameAssetWithId[]; disabled?: boolean; onChoose: (assetId: string) => void; onClear: () => void;
}) {
  const { t } = useI18n();
  const selected = assets.find(asset => asset.id === draft.lastFrameAssetId);
  return <section className="video-last-frame" aria-label={t('timeline.references.last')} data-testid="video-last-frame-controls">
    <div className="field-label"><span>{t('timeline.references.last')}</span><span className="optional">{t('timeline.references.optional', { count: draft.lastFrameAssetId ? 1 : 0 })}</span></div>
    <p className="input-hint">{t('timeline.references.restriction')}</p>
    <div className="reference-grid">{assets.map(asset => <Button variant="ghost" size="sm" key={asset.id} title={asset.name} className={`reference-choice ${draft.lastFrameAssetId === asset.id ? 'selected' : ''}`} data-testid={`last-frame-choice-${asset.id}`} aria-label={t('timeline.references.lastAria', { name: asset.name })} aria-pressed={draft.lastFrameAssetId === asset.id} disabled={disabled} onClick={() => onChoose(asset.id)}><img src={assetUrl(asset)} alt={asset.name} />{draft.lastFrameAssetId === asset.id && <span><Icon name="check" size={11} /></span>}</Button>)}</div>
    {!assets.length && <p className="reference-empty">{t('timeline.references.import')}</p>}
    {draft.lastFrameAssetId && <><p className="input-hint" data-testid="selected-last-frame-label">{t('timeline.references.selected', { name: selected?.name || t('timeline.references.missing') })}</p><Button variant="ghost" size="sm" className="text-button" data-testid="clear-last-frame" disabled={disabled} onClick={onClear}>{t('timeline.references.clear')}</Button></>}
  </section>;
}
