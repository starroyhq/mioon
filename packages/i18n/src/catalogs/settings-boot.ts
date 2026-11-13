import type { MessageCatalog } from '../types.ts';

export const settingsBootMessages = {
  'settings.boot.title': { 'zh-Hans': '设置', 'zh-Hant': '設定', en: 'Settings', ja: '設定' },
  'settings.boot.loading': { 'zh-Hans': '正在加载设置…', 'zh-Hant': '正在載入設定…', en: 'Loading settings…', ja: '設定を読み込んでいます…' },
  'settings.boot.failed': { 'zh-Hans': '无法载入设置。', 'zh-Hant': '無法載入設定。', en: 'Settings could not load.', ja: '設定を読み込めませんでした。' },
  'settings.boot.close': { 'zh-Hans': '关闭设置窗口', 'zh-Hant': '關閉設定視窗', en: 'Close settings window', ja: '設定ウィンドウを閉じる' },
} as const satisfies MessageCatalog;
