import { useI18n } from './i18n/I18nProvider.tsx';
import React from 'react';
import { Button } from '@mioon/ui/components/button';
import { Input } from '@mioon/ui/components/input';
import { Label } from '@mioon/ui/components/label';
import { supportsClipAudioFades, clipAudioMessage, clipGainDbText, clipGainFromDbText } from './clip-audio-state.ts';

interface ClipAudioAsset {name?: string; hasAudio?: boolean}
type ClipAudioDraft = Record<string, string | number | undefined> & {
  durationFrames?: string | number; gain?: string | number; fadeInFrames?: string | number; fadeOutFrames?: string | number;
};
interface ClipAudioControlsProps {
  asset?: ClipAudioAsset | null; kind: string; draft: ClipAudioDraft; section?: 'volume' | 'fades' | 'all'; onEdit: (key: string, value: string) => void; issue?: unknown; conflictedFields?: ReadonlySet<string>;
}
export default function ClipAudioControls({ asset, kind, draft, onEdit, issue, section = 'all', conflictedFields }: ClipAudioControlsProps) {
  const { t, renderMessage } = useI18n();
  const issueMessage = clipAudioMessage(draft, asset);
  if (kind === 'image') return null;
  const supported = supportsClipAudioFades(asset);
  const duration = Number(draft.durationFrames);
  const maximum = Number.isSafeInteger(duration) && duration > 0 ? duration : 0;
  const gain = Number(draft.gain);
  const silent = gain === 0 && String(draft.gain ?? '').trim() !== '';
  const db = gain > 0 && Number.isFinite(gain) ? 20 * Math.log10(gain) : -60;
  const gainConflict = conflictedFields?.has('gain') ? 'true' : undefined;
  const volume = <div className="clip-audio-volume">
    <Label className="field-label" htmlFor="clip-gain">{t('round3.audio.volume')}</Label>
    <div className="clip-gain-controls"><Input aria-label={t('round3.audio.volume')} data-testid="clip-gain-slider" type="range" min="-60" max="6.020599913279624" step="0.1" value={Math.min(20 * Math.log10(2), Math.max(-60, db))} onChange={event => onEdit('gain', clipGainFromDbText(event.target.value))} /><div className="clip-db-input"><Input id="clip-gain" data-testid="clip-gain" data-coedit-field-conflict={gainConflict} aria-label={t('round3.audio.volumeDb')} type="number" inputMode="decimal" max={20 * Math.log10(2)} step="any" placeholder={silent ? '−∞' : undefined} aria-valuetext={clipGainDbText(draft.gain)} title={`${clipGainDbText(draft.gain)} ${t('round3.audio.dbUnit')}`} value={silent ? '' : clipGainDbText(draft.gain)} onChange={event => onEdit('gain', clipGainFromDbText(event.target.value))} /><span aria-hidden="true">{t('round3.audio.dbUnit')}</span></div><Button variant="ghost" size="icon-sm" type="button" data-testid="clip-gain-silence" aria-label={t('round3.audio.silence')} title={t('round3.audio.silence')} onClick={() => onEdit('gain', '0')}>−∞</Button></div>
  </div>;
  const fades = <section className="clip-audio-fades" aria-label={t('audio.clip.fades')}>
    <div className="section-heading"><span>{t('round3.audio.fades')}</span><span className="clip-audio-curve">{t('round3.audio.linear')}</span></div>
    <div className="field-row">
      {[['fadeInFrames', t('audio.clip.fadeIn'), 'clip-fade-in'], ['fadeOutFrames', t('audio.clip.fadeOut'), 'clip-fade-out']].map(([key, label, id]) => <div key={key}>
        <Label className="field-label" htmlFor={id}>{label}</Label><div className="clip-frame-input">
        <Input id={id} data-testid={id} data-coedit-field-conflict={conflictedFields?.has(key) ? 'true' : undefined} aria-label={t('audio.clip.fieldAria', { label })} type="number" min="0" max={maximum} step="1" required disabled={!supported} value={draft[key] ?? 0} aria-invalid={Boolean(issue)} aria-describedby={issue ? 'clip-fade-validation' : !supported ? 'clip-fade-effect' : undefined} onChange={event => onEdit(key, event.target.value)} /><span aria-hidden="true">{t('round3.audio.frames')}</span></div>
      </div>)}
    </div>
    {!supported && <p className="input-hint" id="clip-fade-effect" data-testid="clip-fade-effect">{asset?.hasAudio === false ? t('audio.clip.noAudio') : t('audio.clip.unverifiedAudio')}</p>}
    {Boolean(issue) && <p className="notice warning" id="clip-fade-validation" data-testid="clip-fade-validation" role="alert">{renderMessage(issueMessage)}</p>}
  </section>;
  return <>{section !== 'fades' && volume}{section !== 'volume' && fades}</>;
}
