import { useI18n } from './i18n/I18nProvider.tsx';
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
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const id = useId(), issue = error || deliveryNameError(value);
  return <div className="timeline-delivery-name" data-testid="timeline-delivery-name">
    <label htmlFor={id}>{t('export.name.label')}<span>{t('export.name.optional')}</span></label>
    <Input id={id} type="text" value={value} disabled={disabled} autoComplete="off"
      placeholder={t('export.name.placeholder')} aria-invalid={Boolean(issue)}
      aria-describedby={`${id}-help${issue ? ` ${id}-error` : ''}`} data-testid="delivery-name-input"
      onChange={event => onChange?.(event.currentTarget.value)} />
    <p id={`${id}-help`} className="export-preflight-note">{t('export.name.help')}</p>
    {issue && <p id={`${id}-error`} className="notice error" role="alert" data-testid="delivery-name-error">{t('export.name.invalid')}</p>}
  </div>;
}

/** The old report remains visibly tied to its previously checked exact title. */
export function TimelineDeliveryNameSnapshot({ value }: { value: unknown }) {
  const { t, locale, formatDate, formatNumber, renderMessage } = useI18n();
  const parsed = timelineDeliveryNameSchema.safeParse(value);
  return parsed.success ? <div data-testid="preflight-delivery-name"><dt>{t('export.name.checked')}</dt><dd>{parsed.data}</dd></div> : null;
}
