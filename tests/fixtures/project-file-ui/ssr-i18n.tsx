import React from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { Locale } from '../../../packages/i18n/src/index.ts';
import { createI18nTestContext } from '../../helpers/i18n.ts';

/** Stand-in for `apps/web/src/i18n/I18nProvider.tsx` in the project file SSR
 * bundle: a pinned language that `setLocale` switches between renders. */
let context = createI18nTestContext('zh-Hans');
export function setLocale(locale: Locale): void { context = createI18nTestContext(locale); }
export function useI18n(): ReturnType<typeof createI18nTestContext> { return context; }
export function I18nProvider({ children }: { readonly children: ReactNode }): ReactElement { return <>{children}</>; }
