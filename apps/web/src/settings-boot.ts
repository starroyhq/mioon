import { isLocale, resolveLocale } from '../../../packages/i18n/src/locale.ts';
import type { SettingsDiagnosticsBridge } from '../../desktop/src/settings-diagnostics-protocol.ts';
import type { ProjectWindowBridge } from './desktop-window-client.ts';
import { installSettingsBootClose } from './settings-boot-close.ts';
import { settingsBootMessages } from '../../../packages/i18n/src/catalogs/settings-boot.ts';
import { settingsRedesignMessages } from '../../../packages/i18n/src/catalogs/settings-redesign.ts';
import { settingsCategories, settingsCategoryFor } from './settings-categories.ts';
import type { SettingsCategory } from './settings-categories.ts';
import type { ProjectWindowContext } from './desktop-window-client.ts';

export interface SettingsBootView {
  ready(): void;
  failed(reason?: 'admission' | 'read'): void;
  registerRetry(retry: () => void): () => void;
}

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
const shell = document.getElementById('settings-boot')!;
const app = document.getElementById('root')!;
const nav = document.getElementById('settings-boot-nav')!;
const content = document.getElementById('settings-boot-content')!;
const heading = document.getElementById('settings-boot-heading')!;
const skeleton = document.getElementById('settings-boot-skeleton')!;
const recovery = document.getElementById('settings-boot-recovery')!;
const status = document.getElementById('settings-boot-status')!;
const close = document.getElementById('settings-boot-close')!;
const retryButton = document.getElementById('settings-boot-retry')!;
const bridge = bootWindow.__mioonProjectWindow;
const diagnostics = bootWindow.__mioonSettingsDiagnostics;
const label = (category: SettingsCategory) => category === 'general' ? settingsBootMessages['settings.general'][locale] : settingsRedesignMessages[`redesign.settings.${category}`][locale];
const items = settingsCategories.map(category => {
  const item = document.createElement('span');
  item.textContent = label(category);
  nav.append(item);
  return { category, item };
});
const select = (category: SettingsCategory) => {
  for (const entry of items) {
    if (entry.category === category) entry.item.setAttribute('aria-current', 'page');
    else entry.item.removeAttribute('aria-current');
  }
  heading.textContent = label(category);
  content.dataset.category = category;
};
document.getElementById('settings-boot-title')!.textContent = settingsBootMessages['settings.boot.title'][locale];
nav.setAttribute('aria-label', settingsBootMessages['settings.categories'][locale]);
close.textContent = settingsBootMessages['settings.boot.close'][locale];
retryButton.textContent = settingsBootMessages['settings.boot.retry'][locale];
select('general');
shell.hidden = false;

let slowTimer: ReturnType<typeof setTimeout> | undefined;
let retryWorkspace: (() => void) | undefined;
let unsubscribe: (() => void) | undefined;
let started = false, pending = false, paused = false, repeatAdmission = false, ready = false;
let latest: ProjectWindowContext | undefined;

function showRecovery(reason: 'loading' | 'failed' | 'admissionFailed' | 'readFailed'): void {
  clearTimeout(slowTimer);
  status.textContent = settingsBootMessages[`settings.boot.${reason}`][locale];
  skeleton.hidden = true;
  close.hidden = !bridge;
  recovery.hidden = false;
}

function begin(): void {
  clearTimeout(slowTimer);
  status.textContent = '';
  recovery.hidden = true;
  skeleton.hidden = false;
  slowTimer = setTimeout(() => showRecovery('loading'), 10_000);
}

const view: SettingsBootView = {
  ready() {
    if (ready) return;
    ready = true;
    clearTimeout(slowTimer);
    unsubscribe?.();
    unsubscribe = undefined;
    shell.hidden = true;
    app.hidden = false;
  },
  failed(reason) {
    if (ready) return;
    showRecovery(reason === 'admission' ? 'admissionFailed' : reason === 'read' ? 'readFailed' : 'failed');
  },
  registerRetry(retry) {
    retryWorkspace = retry;
    return () => { if (retryWorkspace === retry) retryWorkspace = undefined; };
  },
};

async function loadSettings(): Promise<void> {
  let phase: 'ready' | 'failed' = 'ready';
  void diagnostics?.markBoot('import').catch(() => {});
  try {
    if (bridge) {
      const { mountSettings } = await import('./settings-app.tsx');
      mountSettings(app, latest!, view);
    } else {
      await import('./main.tsx');
      view.ready();
    }
  }
  catch {
    phase = 'failed';
    view.failed();
  }
  try { await diagnostics?.markBoot(phase); } catch { /* No effect on app loading. */ }
}

async function admit(): Promise<void> {
  if (started || pending || paused || !latest) return;
  pending = true;
  begin();
  let accepted = true;
  if (diagnostics) {
    try { accepted = await diagnostics.markBoot('start'); } catch { accepted = false; }
  }
  pending = false;
  if (accepted) {
    started = true;
    void loadSettings();
  } else {
    view.failed('admission');
    if (repeatAdmission) { repeatAdmission = false; void admit(); }
  }
}

retryButton.addEventListener('click', () => {
  if (recovery.hidden) return;
  if (retryWorkspace) { begin(); retryWorkspace(); }
  // Chromium caches failed module evaluations for this document. Only the
  // still-empty shell can retry module loading by reloading its own page.
  else if (started || !bridge) { begin(); window.location.reload(); }
  else void admit();
});

// Only an active native settings owner receives a state event. A prewarmed
// document paints its shell without starting the app or invoking the bridge.
if (bridge) {
  installSettingsBootClose(window);
  close.addEventListener('click', () => {
    void bridge.closeSettings().then(accepted => { if (!accepted) close.focus(); }, () => close.focus());
  });
  unsubscribe = bridge.subscribe(context => {
    if (context.role !== 'settings' || latest && context.settingsVersion < latest.settingsVersion) return;
    if (context.quitting || !context.settingsSlot) { paused = true; repeatAdmission = false; return; }
    // Resume or a newer setting request may arrive before a rejected ACK
    // settles. Repeated notifications for the in-flight intent are coalesced.
    const newIntent = paused || context.settingsVersion > (latest?.settingsVersion ?? -1);
    if (pending && newIntent) repeatAdmission = true;
    paused = false;
    latest = context;
    select(settingsCategoryFor(context.settingsSlot));
    if (newIntent) void admit();
  });
} else {
  begin();
  void loadSettings();
}
