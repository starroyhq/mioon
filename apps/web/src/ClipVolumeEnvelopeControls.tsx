import React, { useId, useRef, useState } from 'react';
import { Button } from '@mioon/ui/components/button';
import { useI18n } from './i18n/I18nProvider.tsx';
import { VOLUME_ENVELOPE_PROFILE } from '../../../packages/contracts/src/timeline-volume-envelope.ts';
import { acceptsVolumeEnvelopeText, createVolumeEnvelopeFadePreset, MANUAL_DUCKING_FIELDS, manualDuckingEnvelopeFromRaw, RAW_VOLUME_ENVELOPE_LIMITS, validateRawVolumeEnvelope } from './clip-volume-envelope-state.ts';
import type { ManualDuckingField, RawManualDucking, RawVolumeEnvelope, VolumeEnvelopeComposition, VolumePointField } from './clip-volume-envelope-state.ts';

export interface ClipVolumeEnvelopeControlsProps {
  value?: RawVolumeEnvelope | null;
  proposedDuration: number;
  disabled?: boolean;
  onEdit: (value: RawVolumeEnvelope | null, session?: symbol) => void;
  /** Required synchronous dirty/guard notification; not a persistence callback.
   * Parent must keep this component/owner mounted while pending, or explicitly
   * end/cancel composition before navigation. Do not clear pending on unmount. */
  onCompositionChange: (state: VolumeEnvelopeComposition) => void;
}
type Pending = { session: symbol; text: string; original: string } &
  ({ kind: 'point'; row: number; field: VolumePointField } | { kind: 'ducking'; field: ManualDuckingField });
/** Dormant reusable form fragment. It owns no Save, capability or durable state.
 * A caller must preserve absent versus null and bind all callbacks to its owner. */
export default function ClipVolumeEnvelopeControls({ value, proposedDuration, disabled = false, onEdit, onCompositionChange }: ClipVolumeEnvelopeControlsProps) {
  const { t } = useI18n(), id = useId();
  const pending = useRef<Pending | null>(null);
  const renderEpoch = useRef(0), rendered = ++renderEpoch.current;
  const [transient, setTransient] = useState<Pending | null>(null);
  const [rejected, setRejected] = useState<{ row: number; field: VolumePointField } | null>(null);
  // A preset choice is only a form tool; selecting a length is not an edit.
  const [presetFrames, setPresetFrames] = useState(30);
  const [ducking, setDucking] = useState<RawManualDucking>({ startFrame: '0', endFrame: Number.isFinite(proposedDuration) ? String(proposedDuration) : '', multiplier: '0.25', attackFrames: '30', releaseFrames: '30' });
  const [duckingRejected, setDuckingRejected] = useState<ManualDuckingField | null>(null);
  const points = value?.points ?? [];
  // Each rendered handler retains its originating session. Start can set this
  // local holder synchronously before React has rendered the pending state.
  const handlerSession = { value: transient?.session ?? null as symbol | null };
  const invalid = !validateRawVolumeEnvelope(value === undefined ? {} : { volumeEnvelope: value }, proposedDuration).valid;
  // The formatter rejects non-finite parameters. This is only a display
  // fallback; validation and preset admission still use the original duration.
  const displayedDuration = Number.isFinite(proposedDuration) ? proposedDuration : 0;
  const publish = (next: Pending) => {
    pending.current = next; setTransient(next);
    onCompositionChange(next.kind === 'point'
      ? { session: next.session, pending: true, dirty: true, row: next.row, field: next.field, text: next.text }
      : { session: next.session, pending: true, dirty: true, target: 'ducking', field: next.field, text: next.text });
  };
  const finish = (session: symbol) => { if (pending.current?.session !== session) return; pending.current = null; setTransient(null); onCompositionChange({ session, pending: false, dirty: false }); };
  const admit = (row: number, field: VolumePointField, text: string, input: HTMLInputElement, session?: symbol) => {
    if (!acceptsVolumeEnvelopeText(field, text)) {
      input.value = points[row][field]; setRejected({ row, field }); return;
    }
    setRejected(null);
    if (text === points[row][field]) return;
    onEdit({ profileId: VOLUME_ENVELOPE_PROFILE, points: points.map((point, i) => i === row ? { ...point, [field]: text } : { ...point }) }, session);
  };
  const structure = (next: RawVolumeEnvelope | null) => {
    if (disabled || pending.current) return;
    setRejected(null); onEdit(next);
  };
  const presetAvailable = createVolumeEnvelopeFadePreset('in', proposedDuration, presetFrames) !== undefined;
  const applyPreset = (kind: 'in' | 'out') => {
    if (rendered !== renderEpoch.current) return;
    const next = createVolumeEnvelopeFadePreset(kind, proposedDuration, presetFrames);
    if (next) structure(next);
  };
  const duckingEnvelope = manualDuckingEnvelopeFromRaw(proposedDuration, ducking);
  const admitDucking = (field: ManualDuckingField, text: string, input: HTMLInputElement) => {
    if (!acceptsVolumeEnvelopeText(field === 'multiplier' ? 'multiplier' : 'frame', text)) {
      input.value = ducking[field]; setDuckingRejected(field); return;
    }
    setDuckingRejected(null); setDucking({ ...ducking, [field]: text });
  };
  const enabled = value !== undefined && value !== null;
  const graph = !invalid && enabled && points.length ? [`0,${44 - Number(points[0].multiplier) * 36}`, ...points.map(point => `${Number(point.frame) / Math.max(1, proposedDuration) * 240},${44 - Number(point.multiplier) * 36}`), `240,${44 - Number(points.at(-1)!.multiplier) * 36}`].join(' ') : '';
  return <fieldset className="clip-envelope-controls" disabled={disabled} aria-describedby={`${id}-effect ${id}-bounds`}>
    <legend className="sr-only">{t('volume.envelope.title')}</legend>
    <div className="clip-envelope-heading"><span>{t('round3.audio.envelope')}</span><Button variant="ghost" size="icon-sm" type="button" role="switch" aria-checked={enabled} aria-label={t('round3.audio.envelope')} data-testid="clip-envelope-toggle" disabled={disabled || !!transient} onClick={() => { if (rendered === renderEpoch.current) structure(enabled ? null : { profileId: VOLUME_ENVELOPE_PROFILE, points: [{ frame: '0', multiplier: '1' }] }); }} className="clip-envelope-toggle"><span /></Button></div>
    <svg className="clip-envelope-graph" data-testid="clip-envelope-graph" viewBox="0 0 240 52" role="img" aria-label={t(enabled ? 'round3.audio.envelopePreview' : 'round3.audio.envelopeOff')}><path className="clip-envelope-grid" d="M0 8H240M0 26H240M0 44H240" />{graph ? <polyline points={graph} /> : !enabled && <path className="clip-envelope-inactive" d="M0 8H240" />}</svg>
    <details className="clip-envelope-editor"><summary>{t('round3.audio.editEnvelope')}</summary>
    <p id={`${id}-effect`} className="input-hint">{t('volume.envelope.effect')}</p>
    <p id={`${id}-bounds`} className="input-hint" role={invalid ? 'alert' : undefined}>{t('volume.envelope.bounds', { duration: displayedDuration })}</p>
    <fieldset disabled={disabled || !!transient} aria-describedby={`${id}-preset-hint${!presetAvailable ? ` ${id}-preset-unavailable` : ''}`}>
      <legend>{t('volume.envelope.preset.title')}</legend>
      <p id={`${id}-preset-hint`} className="input-hint">{t('volume.envelope.preset.hint')}</p>
      <label htmlFor={`${id}-preset-frames`}>{t('volume.envelope.preset.duration')}</label>
      <select id={`${id}-preset-frames`} data-testid="envelope-preset-frames" value={presetFrames} disabled={disabled || !!transient}
        onChange={event => {
          if (disabled || pending.current || rendered !== renderEpoch.current) return;
          const frames = Number(event.currentTarget.value);
          if ([15, 30, 60].includes(frames)) setPresetFrames(frames);
        }}>
        {[15, 30, 60].map(frames => <option key={frames} value={frames} disabled={!createVolumeEnvelopeFadePreset('in', proposedDuration, frames)}>{t('volume.envelope.preset.frames', { frames })}</option>)}
      </select>
      {!presetAvailable && <p id={`${id}-preset-unavailable`} className="input-hint" role="status">{t('volume.envelope.preset.unavailable')}</p>}
      <div className="field-row">
        <button type="button" data-testid="envelope-preset-in" disabled={disabled || !!transient || !presetAvailable} onClick={() => applyPreset('in')}>{t('volume.envelope.preset.in')}</button>
        <button type="button" data-testid="envelope-preset-out" disabled={disabled || !!transient || !presetAvailable} onClick={() => applyPreset('out')}>{t('volume.envelope.preset.out')}</button>
      </div>
    </fieldset>
    <details className="clip-audio-help"><summary>{t('volume.ducking.title')}</summary><fieldset disabled={disabled} aria-describedby={`${id}-ducking-hint ${id}-ducking-bounds ${id}-ducking-temporary`}>
      <legend>{t('volume.ducking.title')}</legend>
      <p id={`${id}-ducking-hint`} className="input-hint">{t('volume.ducking.hint')}</p>
      <p id={`${id}-ducking-temporary`} className="input-hint">{t('volume.ducking.temporary')}</p>
      <p id={`${id}-ducking-bounds`} className="input-hint" role={!duckingEnvelope ? 'status' : undefined}>{t('volume.ducking.bounds')}</p>
      {MANUAL_DUCKING_FIELDS.map(field => {
        const composing = transient?.kind === 'ducking' && transient.field === field;
        const error = duckingRejected === field;
        return <label key={field} htmlFor={`${id}-ducking-${field}`}>
          {t(`volume.ducking.${field}`)}
          <input id={`${id}-ducking-${field}`} data-testid={`ducking-${field}`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
            value={composing ? transient.text : ducking[field]} disabled={disabled || !!transient && !composing} aria-invalid={error || undefined}
            aria-describedby={`${id}-ducking-bounds${error ? ` ${id}-ducking-error` : ''}`}
            onKeyDown={event => {
              // Keep native CJK confirmation defaults. The Inspector's existing
              // submit fence retains confirmation ownership through its tail.
              if (pending.current?.kind === 'ducking' || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) {
                if (event.key === 'Enter' || event.key === 'Escape' || event.nativeEvent?.keyCode === 229) event.stopPropagation();
                return;
              }
              if (event.key === 'Enter' || event.nativeEvent?.keyCode === 13) { event.preventDefault(); event.stopPropagation(); }
            }}
            onCompositionStart={event => {
              if (disabled || pending.current || rendered !== renderEpoch.current) return;
              handlerSession.value = Symbol('ducking-composition-event'); setDuckingRejected(null);
              publish({ kind: 'ducking', session: handlerSession.value, field, text: event.currentTarget.value, original: ducking[field] });
            }}
            onChange={event => {
              const current = pending.current;
              if (current && handlerSession.value !== current.session) return;
              if (current?.kind === 'ducking' && current.field === field) { publish({ ...current, text: event.currentTarget.value }); return; }
              if (!disabled && !current && rendered === renderEpoch.current) admitDucking(field, event.currentTarget.value, event.currentTarget);
            }}
            onCompositionEnd={event => {
              const current = pending.current;
              if (current?.kind !== 'ducking' || handlerSession.value !== current.session || current.field !== field) return;
              admitDucking(field, event.currentTarget.value, event.currentTarget); finish(current.session);
            }} />
        </label>;
      })}
      {duckingRejected && <p id={`${id}-ducking-error`} role="alert">{t('volume.envelope.rejected', { limit: RAW_VOLUME_ENVELOPE_LIMITS[duckingRejected === 'multiplier' ? 'multiplier' : 'frame'] })}</p>}
      <button type="button" data-testid="ducking-apply" disabled={disabled || !!transient || !duckingEnvelope} onClick={() => {
        if (rendered === renderEpoch.current && duckingEnvelope) structure(duckingEnvelope);
      }}>{t('volume.ducking.apply')}</button>
    </fieldset>
    </details>
    {points.map((point, row) => <div key={row} className="volume-envelope-row">
      {(['frame', 'multiplier'] as const).map(field => {
        const composing = transient?.kind === 'point' && transient.row === row && transient.field === field;
        const error = rejected?.row === row && rejected.field === field;
        return <label key={field} htmlFor={`${id}-${row}-${field}`}>
          {t(`volume.envelope.${field}`)} {row + 1}
          <input id={`${id}-${row}-${field}`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
            data-testid={`envelope-${row}-${field}`} value={composing ? transient.text : point[field]}
            disabled={disabled || !!transient && !composing} aria-invalid={error || undefined}
            aria-describedby={`${id}-bounds${error ? ` ${id}-error` : ''}`}
            onCompositionStart={event => {
              if (disabled || pending.current || rendered !== renderEpoch.current) return;
              handlerSession.value = Symbol('volume-composition-event');
              setRejected(null); publish({ kind: 'point', session: handlerSession.value, row, field, text: event.currentTarget.value, original: point[field] });
            }}
            onChange={event => {
              const current = pending.current;
              if (current && handlerSession.value !== current.session) return;
              if (current?.kind === 'point' && current.row === row && current.field === field) { publish({ ...current, text: event.currentTarget.value }); return; }
              if (!disabled && !current && rendered === renderEpoch.current) admit(row, field, event.currentTarget.value, event.currentTarget);
            }}
            onCompositionEnd={event => {
              const current = pending.current;
              if (current?.kind !== 'point' || handlerSession.value !== current.session || current.row !== row || current.field !== field) return;
              // Commit/correct DOM before releasing the parent's pending guard.
              admit(row, field, event.currentTarget.value, event.currentTarget, current.session); finish(current.session);
            }}
 />
        </label>;
      })}
      <button type="button" disabled={disabled || !!transient} onClick={() => structure({ profileId: VOLUME_ENVELOPE_PROFILE, points: points.filter((_, i) => i !== row) })}>{t('volume.envelope.remove', { index: row + 1 })}</button>
    </div>)}
    {rejected && <p id={`${id}-error`} role="alert">{t('volume.envelope.rejected', { limit: RAW_VOLUME_ENVELOPE_LIMITS[rejected.field] })}</p>}
    <button type="button" disabled={disabled || !!transient || points.length >= RAW_VOLUME_ENVELOPE_LIMITS.points} onClick={() => {
      if (points.length < RAW_VOLUME_ENVELOPE_LIMITS.points) structure({ profileId: VOLUME_ENVELOPE_PROFILE, points: [...points, { frame: '', multiplier: '' }] });
    }}>{t('volume.envelope.add')}</button>
    <button type="button" disabled={disabled || !!transient} onClick={() => structure(null)}>{t('volume.envelope.clear')}</button>
    </details>
  </fieldset>;
}
