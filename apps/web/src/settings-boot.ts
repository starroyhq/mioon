import { resolveLocale } from '../../../packages/i18n/src/locale.ts';
import type { ProjectWindowBridge } from './desktop-window-client.ts';

const labels = {
  'zh-Hans': ['设置', '正在加载设置…', '无法载入设置。', '重试'],
  'zh-Hant': ['設定', '正在載入設定…', '無法載入設定。', '重試'],
  en: ['Settings', 'Loading settings…', 'Settings could not load.', 'Try again'],
  ja: ['設定', '設定を読み込んでいます…', '設定を読み込めませんでした。', '再試行'],
};
const locale = resolveLocale('system', navigator.languages);
const [title, loading, failed, retry] = labels[locale];
document.documentElement.lang = locale;
document.getElementById('settings-boot-title')!.textContent = title;
const status = document.getElementById('settings-boot-status')!;
status.textContent = loading;

function startSettings(): void {
  void import('./main.tsx').catch(() => {
    status.textContent = failed;
    const link = document.getElementById('settings-boot-retry')!;
    link.textContent = retry;
    link.hidden = false;
  });
}

// Only an active native settings owner receives a state event. A prewarmed
// document paints its shell without starting the app or invoking the bridge.
const bridge = (window as Window & {__mioonProjectWindow?: ProjectWindowBridge}).__mioonProjectWindow;
if (bridge) {
  const unsubscribe = bridge.subscribe(context => {
    if (context.role !== 'settings' || context.quitting || !context.settingsSlot) return;
    unsubscribe();
    startSettings();
  });
} else {
  startSettings();
}
