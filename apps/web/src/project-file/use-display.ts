import { useMemo } from 'react';
import { useI18n } from '../i18n/I18nProvider.tsx';
import { byteSize, dayBucket, sameYear } from './format.ts';

/** Dates and sizes as the project file screens show them. `now` always comes
 * from the caller, so the same props give the same text. */
export function useProjectFileDisplay() {
  const { t, formatDate, formatNumber } = useI18n();
  return useMemo(() => ({
    /** `Today 14:32`, `Yesterday 21:08`, `October 14`; with the year when it
     * differs. `withTime` adds the time to earlier days too. */
    when(iso: string, now: Date, withTime = false): string {
      const bucket = dayBucket(iso, now);
      const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
      if (bucket !== 'earlier') {
        const clock = formatDate(iso, time);
        return bucket === 'today' ? t('projectFile.common.today', { time: clock }) : t('projectFile.common.yesterday', { time: clock });
      }
      const day: Intl.DateTimeFormatOptions = sameYear(iso, now) ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' };
      return formatDate(iso, withTime ? { ...day, ...time } : day);
    },
    clock(iso: string): string { return formatDate(iso, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); },
    bytes(value: number): string {
      const size = byteSize(value);
      return t(`projectFile.common.bytes.${size.unit}`, { value: formatNumber(size.value, { maximumFractionDigits: 1 }) });
    },
  }), [t, formatDate, formatNumber]);
}
