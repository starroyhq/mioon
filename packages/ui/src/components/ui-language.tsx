import * as React from 'react';
export interface UiLanguageLabels { readonly close: string }
const UiLanguageContext = React.createContext<UiLanguageLabels>({ close: 'Close' });
export function UiLanguageProvider({ labels, children }: { labels: UiLanguageLabels; children: React.ReactNode }) {
  return <UiLanguageContext.Provider value={labels}>{children}</UiLanguageContext.Provider>;
}
export const useUiLanguage = (): UiLanguageLabels => React.useContext(UiLanguageContext);
