import { resolveLocale } from '../../../packages/i18n/src/locale.ts';
import type { ProjectWindowBridge } from './desktop-window-client.ts';
import { installSettingsBootClose } from './settings-boot-close.ts';
import { settingsBootMessages } from '../../../packages/i18n/src/catalogs/settings-boot.ts';

const locale = resolveLocale('system', navigator.languages);
document.documentElement.lang = locale;
document.getElementById('settings-boot-title')!.textContent = settingsBootMessages['settings.boot.title'][locale];
const status = document.getElementById('settings-boot-status')!;
status.textContent = settingsBootMessages['settings.boot.loading'][locale];

function startSettings(bridge?: ProjectWindowBridge): void {
  if (bridge) {
    const close = document.getElementById('settings-boot-close')!;
    close.textContent = settingsBootMessages['settings.boot.close'][locale];
    close.hidden = false;
    close.addEventListener('click', () => {
      void bridge.closeSettings().then(accepted => { if (!accepted) close.focus(); }, () => close.focus());
    });
  }
  void import('./main.tsx').catch(() => { status.textContent = settingsBootMessages['settings.boot.failed'][locale]; });
}

// Only an active native settings owner receives a state event. A prewarmed
// document paints its shell without starting the app or invoking the bridge.
const bridge = (window as Window & {__mioonProjectWindow?: ProjectWindowBridge}).__mioonProjectWindow;
if (bridge) {
  installSettingsBootClose(window);
  const unsubscribe = bridge.subscribe(context => {
    if (context.role !== 'settings' || context.quitting || !context.settingsSlot) return;
    unsubscribe();
    startSettings(bridge);
  });
} else {
  startSettings();
}
