import { resolveLocale } from '../../../packages/i18n/src/locale.ts';
import type { ProjectWindowBridge } from './desktop-window-client.ts';
import { installSettingsBootClose } from './settings-boot-close.ts';

const labels = {
  'zh-Hans': ['设置', '正在加载设置…', '无法载入设置。', '关闭设置窗口'],
  'zh-Hant': ['設定', '正在載入設定…', '無法載入設定。', '關閉設定視窗'],
  en: ['Settings', 'Loading settings…', 'Settings could not load.', 'Close settings window'],
  ja: ['設定', '設定を読み込んでいます…', '設定を読み込めませんでした。', '設定ウィンドウを閉じる'],
};
const locale = resolveLocale('system', navigator.languages);
const [title, loading, failed, closeLabel] = labels[locale];
document.documentElement.lang = locale;
document.getElementById('settings-boot-title')!.textContent = title;
const status = document.getElementById('settings-boot-status')!;
status.textContent = loading;

function startSettings(bridge?: ProjectWindowBridge): void {
  if (bridge) {
    const close = document.getElementById('settings-boot-close')!;
    close.textContent = closeLabel;
    close.hidden = false;
    close.addEventListener('click', () => {
      void bridge.closeSettings().then(accepted => { if (!accepted) close.focus(); }, () => close.focus());
    });
  }
  void import('./main.tsx').catch(() => { status.textContent = failed; });
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
