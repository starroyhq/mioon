import { createNativeCloseRegistry, installNativeCloseAdmission } from './native-close-state.ts';
import { createSettingsNavigationRegistry } from './settings-navigation-state.ts';

type ClosePage = Parameters<typeof installNativeCloseAdmission>[0];
type BootPage = Pick<ClosePage, 'addEventListener' | 'removeEventListener'> & {
  readonly location: {readonly href: string};
  __mioonFlushWorkspacePreferences?: () => Promise<boolean>;
};
type BootCleanup = BootPage & {__mioonRetireSettingsBootClose?: () => void};

/** Until SettingsRoot takes over, the shell owns no draft or write. It still
 * uses the native one-use protocol for close and reload, including on failure. */
export function installSettingsBootClose(page: BootCleanup): void {
  const readDocumentURL = () => page.location.href;
  const dispose = installNativeCloseAdmission(page as ClosePage, {
    registry: createNativeCloseRegistry(), settings: createSettingsNavigationRegistry(),
    readScope: readDocumentURL, readDocumentURL,
  });
  const flush = async () => true;
  page.__mioonFlushWorkspacePreferences = flush;
  page.__mioonRetireSettingsBootClose = () => {
    dispose();
    if (page.__mioonFlushWorkspacePreferences === flush) delete page.__mioonFlushWorkspacePreferences;
    delete page.__mioonRetireSettingsBootClose;
  };
}

export function retireSettingsBootClose(page: BootCleanup): void {
  page.__mioonRetireSettingsBootClose?.();
}
