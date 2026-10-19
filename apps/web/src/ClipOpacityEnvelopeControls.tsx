import React, { useId, useRef, useState } from 'react';
import { useI18n } from './i18n/I18nProvider.tsx';
import { OPACITY_ENVELOPE_PROFILE, OPACITY_ENVELOPE_LIMITS } from '../../../packages/contracts/src/timeline-opacity-envelope.ts';
import { acceptsOpacityEnvelopeText, RAW_OPACITY_ENVELOPE_LIMITS, validateRawOpacityEnvelope } from './clip-opacity-envelope-state.ts';
import type { RawOpacityEnvelope, OpacityEnvelopeComposition, OpacityPointField } from './clip-opacity-envelope-state.ts';

export interface ClipOpacityEnvelopeControlsProps {
  value?: RawOpacityEnvelope | null;
  proposedDuration: number;
  disabled?: boolean;
  onEdit: (value: RawOpacityEnvelope | null, session?: symbol) => void;
  /** Required synchronous dirty/guard notification, not a persistence callback.
   * Keep the owner mounted while pending, or explicitly settle/cancel input. */
  onCompositionChange: (state: OpacityEnvelopeComposition) => void;
}
type Pending = { session: symbol; row: number; field: OpacityPointField; text: string };
/** Candidate-only form fragment. Its parent owns Save, draft storage and the
 * internal assembly gate; rendering this component never enables a profile. */
export default function ClipOpacityEnvelopeControls({ value, proposedDuration, disabled = false, onEdit, onCompositionChange }: ClipOpacityEnvelopeControlsProps) {
  const { t } = useI18n(), id = useId();
  const pending = useRef<Pending | null>(null);
  const renderEpoch = useRef(0), rendered = ++renderEpoch.current;
  const [transient, setTransient] = useState<Pending | null>(null);
  const [rejected, setRejected] = useState<{ row: number; field: OpacityPointField } | null>(null);
  const points = value?.points ?? [];
  // A rendered handler retains its originating composition. Start fills this
  // holder before React rerenders, so synchronous start/end is also safe.
  const handlerSession = { value: transient?.session ?? null as symbol | null };
  const invalid = !validateRawOpacityEnvelope(value === undefined ? {} : { opacityEnvelope: value }, proposedDuration).valid;
  // Recovered duration text can still be incomplete. Keep that invalid state,
  // but never send a nonfinite value into the strict translation formatter.
  const durationValid = Number.isSafeInteger(proposedDuration) && proposedDuration >= 1 && proposedDuration <= OPACITY_ENVELOPE_LIMITS.frames;
  const boundsHint = durationValid ? t('opacity.envelope.bounds', { duration: proposedDuration }) : t('opacity.envelope.durationInvalid');
  const publish = (next: Pending) => {
    pending.current = next; setTransient(next);
    onCompositionChange({ session: next.session, pending: true, dirty: true, row: next.row, field: next.field, text: next.text });
  };
  const finish = (session: symbol) => {
    if (pending.current?.session !== session) return;
    pending.current = null; setTransient(null); onCompositionChange({ session, pending: false, dirty: false });
  };
  const admit = (row: number, field: OpacityPointField, text: string, input: HTMLInputElement, session?: symbol) => {
    if (!acceptsOpacityEnvelopeText(field, text)) { input.value = points[row][field]; setRejected({ row, field }); return; }
    setRejected(null);
    if (text === points[row][field]) return;
    onEdit({ profileId: OPACITY_ENVELOPE_PROFILE, points: points.map((point, index) => index === row ? { ...point, [field]: text } : { ...point }) }, session);
  };
  const structure = (next: RawOpacityEnvelope | null) => {
    if (disabled || pending.current || rendered !== renderEpoch.current) return;
    setRejected(null); onEdit(next);
  };
  return <fieldset disabled={disabled} aria-describedby={`${id}-effect ${id}-bounds`}>
    <legend>{t('opacity.envelope.title')}</legend>
    <p id={`${id}-effect`} className="input-hint">{t('opacity.envelope.effect')}</p>
    <p id={`${id}-bounds`} className="input-hint" role={invalid ? 'alert' : undefined}>{boundsHint}</p>
    {points.map((point, row) => <div key={row} className="volume-envelope-row">
      {(['frame', 'opacity'] as const).map(field => {
        const composing = transient?.row === row && transient.field === field;
        const error = rejected?.row === row && rejected.field === field;
        return <label key={field} htmlFor={`${id}-${row}-${field}`}>
          {t(`opacity.envelope.${field}`)} {row + 1}
          <input id={`${id}-${row}-${field}`} type="text" inputMode="text" autoComplete="off" spellCheck={false}
            data-testid={`opacity-envelope-${row}-${field}`} value={composing ? transient.text : point[field]}
            disabled={disabled || !!transient && !composing} aria-invalid={error || undefined}
            aria-describedby={`${id}-bounds${error ? ` ${id}-error` : ''}`}
            onCompositionStart={event => {
              if (disabled || pending.current || rendered !== renderEpoch.current) return;
              handlerSession.value = Symbol('opacity-composition-event');
              setRejected(null); publish({ session: handlerSession.value, row, field, text: event.currentTarget.value });
            }}
            onCompositionUpdate={event => {
              const current = pending.current;
              if (current && handlerSession.value === current.session && current.row === row && current.field === field)
                publish({ ...current, text: event.currentTarget.value });
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
              // Commit/correct the input before releasing the synchronous guard.
              admit(row, field, event.currentTarget.value, event.currentTarget, current.session); finish(current.session);
            }} />
        </label>;
      })}
      <button type="button" disabled={disabled || !!transient} onClick={() => structure({ profileId: OPACITY_ENVELOPE_PROFILE, points: points.filter((_, index) => index !== row) })}>{t('opacity.envelope.remove', { index: row + 1 })}</button>
    </div>)}
    {rejected && <p id={`${id}-error`} role="alert">{t('opacity.envelope.rejected', { limit: RAW_OPACITY_ENVELOPE_LIMITS[rejected.field] })}</p>}
    <button type="button" disabled={disabled || !!transient || points.length >= RAW_OPACITY_ENVELOPE_LIMITS.points} onClick={() => {
      if (points.length < RAW_OPACITY_ENVELOPE_LIMITS.points) structure({ profileId: OPACITY_ENVELOPE_PROFILE, points: [...points, { frame: '', opacity: '' }] });
    }}>{t('opacity.envelope.add')}</button>
    <button type="button" disabled={disabled || !!transient} onClick={() => structure(null)}>{t('opacity.envelope.clear')}</button>
  </fieldset>;
}
