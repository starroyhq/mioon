import React, { useId } from 'react';
import { timelineDeliveryNameSchema } from '@mioon/contracts/timeline-delivery';
import { Input } from '@mioon/ui/components/input';
import { DELIVERY_NAME_HELP, DELIVERY_NAME_PLACEHOLDER, deliveryNameError } from './export-delivery-state.ts';

export interface TimelineDeliveryNameProps {
  value: string;
  disabled?: boolean;
  error?: string;
  onChange?: (value: string) => void;
}

export default function TimelineDeliveryName({ value, disabled = false, error, onChange }: TimelineDeliveryNameProps) {
  const id = useId(), issue = error || deliveryNameError(value);
  return <div className="timeline-delivery-name" data-testid="timeline-delivery-name">
    <label htmlFor={id}>本次成片名称 <span>可选</span></label>
    <Input id={id} type="text" value={value} disabled={disabled} autoComplete="off"
      placeholder={DELIVERY_NAME_PLACEHOLDER} aria-invalid={Boolean(issue)}
      aria-describedby={`${id}-help${issue ? ` ${id}-error` : ''}`} data-testid="delivery-name-input"
      onChange={event => onChange?.(event.currentTarget.value)} />
    <p id={`${id}-help`} className="export-preflight-note">{DELIVERY_NAME_HELP}</p>
    {issue && <p id={`${id}-error`} className="notice error" role="alert" data-testid="delivery-name-error">{issue}</p>}
  </div>;
}

/** The old report remains visibly tied to its previously checked exact title. */
export function TimelineDeliveryNameSnapshot({ value }: { value: unknown }) {
  const parsed = timelineDeliveryNameSchema.safeParse(value);
  return parsed.success ? <div data-testid="preflight-delivery-name"><dt>检查的成片名称</dt><dd>{parsed.data}</dd></div> : null;
}
