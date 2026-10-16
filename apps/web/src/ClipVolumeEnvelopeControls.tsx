import React, { useId, useRef, useState } from 'react';
import { useI18n } from './i18n/I18nProvider.tsx';
import { VOLUME_ENVELOPE_PROFILE } from '../../../packages/contracts/src/timeline-volume-envelope.ts';
import { acceptsVolumeEnvelopeText, createVolumeEnvelopeFadePreset, RAW_VOLUME_ENVELOPE_LIMITS, validateRawVolumeEnvelope } from './clip-volume-envelope-state.ts';
import type { RawVolumeEnvelope, VolumeEnvelopeComposition, VolumePointField } from './clip-volume-envelope-state.ts';

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
type Pending = { session: symbol; row: number; field: VolumePointField; text: string; original: string };
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
    onCompositionChange({ session: next.session, pending: true, dirty: true, row: next.row, field: next.field, text: next.text });
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
  return <fieldset disabled={disabled} aria-describedby={`${id}-effect ${id}-bounds`}>
    <legend>{t('volume.envelope.title')}</legend>
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
    {points.map((point, row) => <div key={row} className="volume-envelope-row">
      {(['frame', 'multiplier'] as const).map(field => {
        const composing = transient?.row === row && transient.field === field;
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
              setRejected(null); publish({ session: handlerSession.value, row, field, text: event.currentTarget.value, original: point[field] });
            }}
            onChange={event => {
              const current = pending.current;
              if (current && handlerSession.value !== current.session) return;
              if (current?.row === row && current.field === field) { publish({ ...current, text: event.currentTarget.value }); return; }
              if (!disabled && !current && rendered === renderEpoch.current) admit(row, field, event.currentTarget.value, event.currentTarget);
            }}
            onCompositionEnd={event => {
              const current = pending.current;
              if (!current || handlerSession.value !== current.session || current.row !== row || current.field !== field) return;
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
  </fieldset>;
}
