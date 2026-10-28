import React, { useState } from 'react';
import type { ReactNode } from 'react';

// Small controls of the previs panels. A number field keeps what is being
// typed until Enter or blur, then reports one clamped value; arrow keys step it.
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
export interface PrevisNumberFieldProps {
  label: ReactNode;
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  digits: number;
  unit?: ReactNode;
  disabled?: boolean;
  testId?: string;
  onChange: (value: number) => void;
}
export function PrevisNumberField({ label, ariaLabel, value, min, max, step, digits, unit, disabled = false, testId, onChange }: PrevisNumberFieldProps): React.ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string): void => {
    setDraft(null);
    const parsed = Number(text.trim().replace(',', '.'));
    if (text.trim() && Number.isFinite(parsed)) { const next = clamp(parsed, min, max); if (next !== value) onChange(next); }
  };
  return <label className="previs-number" data-disabled={disabled || undefined}>
    <span className="previs-number-label" aria-hidden="true">{label}</span>
    <input type="text" inputMode="decimal" aria-label={ariaLabel} data-testid={testId} disabled={disabled} value={draft ?? value.toFixed(digits)}
      onFocus={event => event.currentTarget.select()} onChange={event => setDraft(event.target.value)} onBlur={event => commit(event.currentTarget.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') { commit(event.currentTarget.value); event.currentTarget.blur(); }
        else if (event.key === 'Escape') { setDraft(null); event.currentTarget.blur(); }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const next = clamp(Number((value + (event.key === 'ArrowUp' ? 1 : -1) * step * (event.shiftKey ? 10 : 1)).toFixed(6)), min, max);
          setDraft(null); if (next !== value) onChange(next);
        }
      }} />
    {unit && <span className="previs-number-unit" aria-hidden="true">{unit}</span>}
  </label>;
}
export interface PrevisSliderProps {
  ariaLabel: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  testId?: string;
  onChange: (value: number) => void;
}
export function PrevisSlider({ ariaLabel, value, min, max, step, disabled = false, testId, onChange }: PrevisSliderProps): React.ReactElement {
  const share = (clamp(value, min, max) - min) / (max - min) * 100;
  return <input type="range" className="previs-slider" aria-label={ariaLabel} data-testid={testId} min={min} max={max} step={step} value={value} disabled={disabled}
    style={{ '--previs-slider-fill': `${share}%` } as React.CSSProperties} onChange={event => onChange(Number(event.target.value))} />;
}
export interface PrevisSegmentOption<T extends string> { value: T; label: string }
export function PrevisSegments<T extends string>({ label, options, value, disabled = false, strong = false, testId, onChange }: { label: string; options: readonly PrevisSegmentOption<T>[]; value: T | null; disabled?: boolean; strong?: boolean; testId?: string; onChange: (value: T) => void }): React.ReactElement {
  return <div className="previs-segments" role="group" aria-label={label} data-testid={testId} data-tone={strong ? 'strong' : undefined}>
    {options.map(option => <button type="button" key={option.value} className="previs-segment" aria-pressed={option.value === value} disabled={disabled}
      data-testid={testId ? `${testId}-${option.value}` : undefined} onClick={() => { if (option.value !== value) onChange(option.value); }}>{option.label}</button>)}
  </div>;
}
export function PrevisRow({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }): React.ReactElement {
  return <div className="previs-row"><span className="previs-row-label">{label}</span><div className="previs-row-control">{children}</div>{hint && <p className="previs-row-hint">{hint}</p>}</div>;
}
