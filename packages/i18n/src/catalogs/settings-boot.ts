import type { MessageCatalog } from '../types.ts';

export const settingsBootMessages = {
  'settings.categories': { 'zh-Hans': '设置分类', 'zh-Hant': '設定分類', en: 'Settings categories', ja: '設定カテゴリ' },
  'settings.general': { 'zh-Hans': '通用', 'zh-Hant': '一般', en: 'General', ja: '一般' },
  'settings.boot.title': { 'zh-Hans': '设置', 'zh-Hant': '設定', en: 'Settings', ja: '設定' },
  'settings.boot.loading': { 'zh-Hans': '设置加载已超过 10 秒。', 'zh-Hant': '正在載入設定…', en: 'Loading settings…', ja: '設定を読み込んでいます…' },
  'settings.boot.failed': { 'zh-Hans': '设置页面资源载入失败。', 'zh-Hant': '無法載入設定。', en: 'Settings could not load.', ja: '設定を読み込めませんでした。' },
  'settings.boot.admissionFailed': { 'zh-Hans': '系统未能确认设置窗口。', 'zh-Hant': '無法載入設定。', en: 'Settings could not load.', ja: '設定を読み込めませんでした。' },
  'settings.boot.readFailed': { 'zh-Hans': '无法读取本机设置。', 'zh-Hant': '無法載入設定。', en: 'Settings could not load.', ja: '設定を読み込めませんでした。' },
  'settings.boot.close': { 'zh-Hans': '关闭设置窗口', 'zh-Hant': '關閉設定視窗', en: 'Close settings window', ja: '設定ウィンドウを閉じる' },
  'settings.boot.retry': { 'zh-Hans': '重试', 'zh-Hant': '重試', en: 'Retry', ja: '再試行' },
} as const satisfies MessageCatalog;
