/** Real catalog/helper imports for legacy source-transform component tests. */
import { createI18nTestContext, i18nTestModule } from './i18n.ts';
import * as core from '../../packages/i18n/src/index.ts';
import * as creation from '../../apps/web/src/creation-i18n.ts';
export function creationTestDependency(name: string, language: core.Locale | { getSnapshot(): { locale: core.Locale } } = 'zh-Hans'): unknown {
  if (name === './i18n/I18nProvider.tsx') return typeof language === 'string' ? i18nTestModule(language) : { useI18n: () => createI18nTestContext(language.getSnapshot().locale) };
  if (name === '../../../packages/i18n/src/index.ts') return core;
  if (name === './creation-i18n.ts') return creation;
  return undefined;
}
