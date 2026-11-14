import { isLocale, resolveLocale } from '../../../packages/i18n/src/locale.ts';
import type { SettingsDiagnosticsBridge } from '../../desktop/src/settings-diagnostics-protocol.ts';
import type { ProjectWindowBridge } from './desktop-window-client.ts';
import { installSettingsBootClose } from './settings-boot-close.ts';
import { settingsBootMessages } from '../../../packages/i18n/src/catalogs/settings-boot.ts';

const bootWindow = window as Window & {
  __mioonProjectWindow?: ProjectWindowBridge;
  __mioonSettingsDiagnostics?: SettingsDiagnosticsBridge;
  __mioonSettingsBootAppearance?: {locale: unknown; theme: unknown};
};
const appearance = bootWindow.__mioonSettingsBootAppearance;
const locale = isLocale(appearance?.locale) ? appearance.locale : resolveLocale('system', navigator.languages);
const root = document.documentElement;
root.lang = locale;
if (appearance?.theme === 'light' || appearance?.theme === 'dark') {
  root.dataset.theme = appearance.theme;
  root.classList.toggle('light', appearance.theme === 'light');
  root.classList.toggle('dark', appearance.theme === 'dark');
  root.style.colorScheme = appearance.theme;
}
document.getElementById('settings-boot-title')!.textContent = settingsBootMessages['settings.boot.title'][locale];
const status = document.getElementById('settings-boot-status')!;
const showLoading = () => { status.textContent = settingsBootMessages['settings.boot.loading'][locale]; };
const showFailure = () => { status.textContent = settingsBootMessages['settings.boot.failed'][locale]; };
showLoading();
document.getElementById('settings-boot')!.hidden = false;

async function loadSettings(diagnostics?: SettingsDiagnosticsBridge): Promise<void> {
  let phase: 'ready' | 'failed' = 'ready';
  void diagnostics?.markBoot('import').catch(() => {});
  try { await import('./main.tsx'); }
  catch {
    phase = 'failed';
    showFailure();
  }
  try { await diagnostics?.markBoot(phase); } catch { /* No effect on app loading. */ }
}

// Only an active native settings owner receives a state event. A prewarmed
// document paints its shell without starting the app or invoking the bridge.
const bridge = bootWindow.__mioonProjectWindow;
if (bridge) {
  installSettingsBootClose(window);
  const close = document.getElementById('settings-boot-close')!;
  close.textContent = settingsBootMessages['settings.boot.close'][locale];
  close.addEventListener('click', () => {
    void bridge.closeSettings().then(accepted => { if (!accepted) close.focus(); }, () => close.focus());
  });
  const diagnostics = bootWindow.__mioonSettingsDiagnostics;
  let started = false, unsubscribe: (() => void) | undefined;
  let pending = false, paused = false, retry = false, version = -1;
  async function admit(): Promise<void> {
    pending = true;
    showLoading();
    let accepted = true;
    if (diagnostics) {
      try { accepted = await diagnostics.markBoot('start'); } catch { accepted = false; }
    }
    pending = false;
    if (accepted) {
      started = true;
      unsubscribe?.();
      void loadSettings(diagnostics);
    } else {
      showFailure();
      if (retry) { retry = false; void admit(); }
    }
  }
  unsubscribe = bridge.subscribe(context => {
    if (started || context.role !== 'settings') return;
    if (context.quitting || !context.settingsSlot) { paused = true; retry = false; return; }
    // Resume or a newer setting request may arrive before a rejected ACK
    // settles. Repeated notifications for the in-flight intent are coalesced.
    if (pending && (paused || context.settingsVersion > version)) retry = true;
    paused = false;
    version = context.settingsVersion;
    close.hidden = false;
    if (!pending) void admit();
  });
  if (started) unsubscribe();
} else {
  void loadSettings();
}
