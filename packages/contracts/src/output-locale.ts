import {z} from 'zod';
import {LOCALES} from '../../i18n/src/locale.ts';

export const OUTPUT_LOCALE_HEADER = 'X-Mioon-Output-Locale';
export const outputLocaleSchema = z.enum(LOCALES);
export type OutputLocale = z.infer<typeof outputLocaleSchema>;
