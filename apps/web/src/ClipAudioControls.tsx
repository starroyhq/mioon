import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Separator } from '@mioon/ui/components/separator';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { supportsClipAudioFades, clipAudioMessage } from './clip-audio-state.ts';

export default function ClipAudioControls({ asset, kind, draft, onEdit, issue }) {
  const { t, renderMessage } = useI18n();
  const issueMessage = clipAudioMessage(draft, asset);
  if (kind === 'image') return null;
  const supported = supportsClipAudioFades(asset);
  const duration = Number(draft.durationFrames);
  const maximum = Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
  return <>
    <Label className="field-label" htmlFor="clip-gain">{t('audio.clip.gain')}</Label>
    <Input id="clip-gain" data-testid="clip-gain" type="number" min="0" max="2" step="0.05" required value={draft.gain} onChange={event => onEdit('gain', event.target.value)} />
    <Separator className="section-divider" />
    <div className="section-heading"><span>{t('audio.clip.fades')}</span></div>
    <div className="field-row">
      {[['fadeInFrames', t('audio.clip.fadeIn'), 'clip-fade-in'], ['fadeOutFrames', t('audio.clip.fadeOut'), 'clip-fade-out']].map(([key, label, id]) => <div key={key}>
        <Label className="field-label" htmlFor={id}>{label}</Label>
        <Input id={id} data-testid={id} aria-label={t('audio.clip.fieldAria', { label })} type="number" min="0" max={maximum} step="1" required disabled={!supported} value={draft[key] ?? 0} aria-invalid={Boolean(issue)} aria-describedby={`clip-fade-bounds clip-fade-effect${issue ? ' clip-fade-validation' : ''}`} onChange={event => onEdit(key, event.target.value)} />
      </div>)}
    </div>
    <p className="input-hint" id="clip-fade-bounds">{t('audio.clip.bounds', { maximum })}</p>
    <p className="input-hint" id="clip-fade-effect" data-testid="clip-fade-effect">{supported ? t('audio.clip.effect') : asset?.hasAudio === false ? t('audio.clip.noAudio') : t('audio.clip.unverifiedAudio')}</p>
    {issue && <p className="notice warning" id="clip-fade-validation" data-testid="clip-fade-validation" role="alert">{renderMessage(issueMessage)}</p>}
  </>;
}
