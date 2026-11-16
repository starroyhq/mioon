import type { MessageCatalog } from '../types.ts';

export const settingsBootMessages = {
  'settings.categories': { 'zh-Hans': '设置分类', 'zh-Hant': '設定分類', en: 'Settings categories', ja: '設定カテゴリ' },
  'settings.general': { 'zh-Hans': '通用', 'zh-Hant': '一般', en: 'General', ja: '一般' },
  'settings.boot.title': { 'zh-Hans': '设置', 'zh-Hant': '設定', en: 'Settings', ja: '設定' },
  'settings.boot.loading': { 'zh-Hans': '设置加载已超过 10 秒。', 'zh-Hant': '載入設定已超過 10 秒。', en: 'Settings have taken more than 10 seconds to load.', ja: '設定の読み込みに 10 秒以上かかっています。' },
  'settings.boot.failed': { 'zh-Hans': '设置页面资源载入失败。', 'zh-Hant': '設定頁面資源載入失敗。', en: 'Could not load the settings page resources.', ja: '設定画面に必要なファイルを読み込めませんでした。' },
  'settings.boot.admissionFailed': { 'zh-Hans': '系统未能确认设置窗口。', 'zh-Hant': '系統未能確認設定視窗。', en: 'The system could not confirm the settings window.', ja: 'システムが設定ウィンドウを確認できませんでした。' },
  'settings.boot.readFailed': { 'zh-Hans': '无法读取本机设置。', 'zh-Hant': '無法讀取本機設定。', en: 'Could not read local settings.', ja: 'この端末の設定を読み込めませんでした。' },
  'settings.boot.close': { 'zh-Hans': '关闭设置窗口', 'zh-Hant': '關閉設定視窗', en: 'Close settings window', ja: '設定ウィンドウを閉じる' },
  'settings.boot.retry': { 'zh-Hans': '重试', 'zh-Hant': '重試', en: 'Retry', ja: '再試行' },
} as const satisfies MessageCatalog;
