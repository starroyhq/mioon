import React, { useId, useRef, useState } from 'react';
import { useI18n } from './i18n/I18nProvider.tsx';
import { VOLUME_ENVELOPE_PROFILE } from '../../../packages/contracts/src/timeline-volume-envelope.mjs';
import { acceptsVolumeEnvelopeText, RAW_VOLUME_ENVELOPE_LIMITS, validateRawVolumeEnvelope } from './clip-volume-envelope-state.ts';
import type { RawVolumeEnvelope, VolumeEnvelopeComposition, VolumePointField } from './clip-volume-envelope-state.ts';

export interface ClipVolumeEnvelopeControlsProps {
  value?: RawVolumeEnvelope | null;
  proposedDuration: number;
  disabled?: boolean;
  onEdit: (value: RawVolumeEnvelope | null) => void;
  /** Required synchronous dirty/guard notification; not a persistence callback.
   * Parent must keep this component/owner mounted while pending, or explicitly
   * end/cancel composition before navigation. Do not clear pending on unmount. */
  onCompositionChange: (state: VolumeEnvelopeComposition) => void;
}
type Pending = { row: number; field: VolumePointField; text: string; original: string };
/** Dormant reusable form fragment. It owns no Save, capability or durable state.
 * A caller must preserve absent versus null and bind all callbacks to its owner. */
export default function ClipVolumeEnvelopeControls({ value, proposedDuration, disabled = false, onEdit, onCompositionChange }: ClipVolumeEnvelopeControlsProps) {
  const { t } = useI18n(), id = useId();
  const pending = useRef<Pending | null>(null);
  const [transient, setTransient] = useState<Pending | null>(null);
  const [rejected, setRejected] = useState<{ row: number; field: VolumePointField } | null>(null);
  const points = value?.points ?? [];
  const invalid = !validateRawVolumeEnvelope(value === undefined ? {} : { volumeEnvelope: value }, proposedDuration).valid;
  const publish = (next: Pending) => {
    pending.current = next; setTransient(next);
    onCompositionChange({ pending: true, dirty: true, row: next.row, field: next.field, text: next.text });
  };
  const finish = () => { pending.current = null; setTransient(null); onCompositionChange({ pending: false, dirty: false }); };
  const admit = (row: number, field: VolumePointField, text: string, input: HTMLInputElement) => {
    if (!acceptsVolumeEnvelopeText(field, text)) {
      input.value = points[row][field]; setRejected({ row, field }); return;
    }
    setRejected(null);
    if (text === points[row][field]) return;
    onEdit({ profileId: VOLUME_ENVELOPE_PROFILE, points: points.map((point, i) => i === row ? { ...point, [field]: text } : { ...point }) });
  };
  const structure = (next: RawVolumeEnvelope | null) => {
    if (disabled || pending.current) return;
    setRejected(null); onEdit(next);
  };
  return <fieldset disabled={disabled} aria-describedby={`${id}-effect ${id}-bounds`}>
    <legend>{t('volume.envelope.title')}</legend>
    <p id={`${id}-effect`} className="input-hint">{t('volume.envelope.effect')}</p>
    <p id={`${id}-bounds`} className="input-hint" role={invalid ? 'alert' : undefined}>{t('volume.envelope.bounds', { duration: proposedDuration })}</p>
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
              if (disabled || pending.current) return;
              setRejected(null); publish({ row, field, text: event.currentTarget.value, original: point[field] });
            }}
            onChange={event => {
              const current = pending.current;
              if (current?.row === row && current.field === field) { publish({ ...current, text: event.currentTarget.value }); return; }
              if (!disabled && !current) admit(row, field, event.currentTarget.value, event.currentTarget);
            }}
            onCompositionEnd={event => {
              const current = pending.current;
              if (!current || current.row !== row || current.field !== field) return;
              // Commit/correct DOM before releasing the parent's pending guard.
              admit(row, field, event.currentTarget.value, event.currentTarget); finish();
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
