import { useMemo } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { byteSize, dayBucket, sameYear } from './format.ts';

/** Dates and sizes as the project file screens show them. `now` always comes
 * from the caller, so the same props give the same text. */
export function useProjectFileDisplay() {
  const { t, formatDate, formatNumber } = useI18n();
  return useMemo(() => ({
    /** `Today 14:32`, `Yesterday 21:08`, `October 14`; with the year when it differs. */
    when(iso: string, now: Date): string {
      const bucket = dayBucket(iso, now);
      if (bucket !== 'earlier') {
        const time = formatDate(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        return bucket === 'today' ? t('projectFile.common.today', { time }) : t('projectFile.common.yesterday', { time });
      }
      return formatDate(iso, sameYear(iso, now) ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
    },
    clock(iso: string): string { return formatDate(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); },
    bytes(value: number): string {
      const size = byteSize(value);
      return t(`projectFile.common.bytes.${size.unit}`, { value: formatNumber(size.value, { maximumFractionDigits: 1 }) });
    },
  }), [t, formatDate, formatNumber]);
}
