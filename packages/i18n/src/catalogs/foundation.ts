import type { MessageCatalog } from '../types.ts';
export const foundationMessages = {
  "language.label": {
    "zh-Hans": "界面语言",
    "zh-Hant": "介面語言",
    "en": "Interface language",
    "ja": "表示言語"
  },
  "language.system": {
    "zh-Hans": "跟随系统",
    "zh-Hant": "跟隨系統",
    "en": "System default",
    "ja": "システム設定に従う"
  },
  "language.loading": {
    "zh-Hans": "正在读取语言设置…",
    "zh-Hant": "正在讀取語言設定…",
    "en": "Loading language preference…",
    "ja": "言語設定を読み込んでいます…"
  },
  "language.saving": {
    "zh-Hans": "正在保存语言设置…",
    "zh-Hant": "正在儲存語言設定…",
    "en": "Saving language preference…",
    "ja": "言語設定を保存しています…"
  },
  "language.sessionOnly": {
    "zh-Hans": "语言仅在本次会话生效，未能持久保存",
    "zh-Hant": "語言僅在本次工作階段生效，無法持久儲存",
    "en": "The language applies to this session only; it could not be saved",
    "ja": "言語の変更は今回のセッションにのみ適用されます。設定を保存できませんでした"
  },
  "language.readFailed": {
    "zh-Hans": "无法读取已保存的语言设置，暂时保留当前显示语言",
    "zh-Hant": "無法讀取已儲存的語言設定，暫時保留目前的顯示語言",
    "en": "The saved language preference could not be read. Keeping the current display language for now",
    "ja": "保存済みの言語設定を読み込めないため、現在の表示言語を維持しています"
  },
  "language.hostUnavailable": {
    "zh-Hans": "无法核对桌面语言设置。当前语言仅用于此窗口",
    "zh-Hant": "無法核對桌面語言設定。目前的語言僅用於此視窗",
    "en": "The desktop language preference could not be verified. This language applies to this window only",
    "ja": "デスクトップの言語設定を確認できません。現在の言語はこのウィンドウにのみ適用されます"
  },
  "common.confirmTitle": {
    "zh-Hans": "请确认此操作",
    "zh-Hant": "請確認此操作",
    "en": "Confirm this action",
    "ja": "操作の確認"
  },
  "common.cancel": {
    "zh-Hans": "取消",
    "zh-Hant": "取消",
    "en": "Cancel",
    "ja": "キャンセル"
  },
  "common.continue": {
    "zh-Hans": "继续",
    "zh-Hant": "繼續",
    "en": "Continue",
    "ja": "続行"
  },
  "common.close": {
    "zh-Hans": "关闭",
    "zh-Hant": "關閉",
    "en": "Close",
    "ja": "閉じる"
  },
  "common.closeSettings": {
    "zh-Hans": "关闭设置窗口",
    "zh-Hant": "關閉設定視窗",
    "en": "Close settings window",
    "ja": "設定ウィンドウを閉じる"
  },
  "common.originalDiagnostic": {
    "zh-Hans": "原始诊断信息",
    "zh-Hant": "原始診斷資訊",
    "en": "Original diagnostic details",
    "ja": "元の診断情報"
  },
  "common.unknownError": {
    "zh-Hans": "操作未能完成。请核对当前状态后再决定是否重试",
    "zh-Hant": "操作未能完成。請核對目前狀態後再決定是否重試",
    "en": "The operation could not be completed. Check its current state before deciding whether to retry",
    "ja": "操作を完了できませんでした。現在の状態を確認してから、再試行するか判断してください"
  },
  "common.invalidMessage": {
    "zh-Hans": "此提示暂时无法显示",
    "zh-Hant": "此提示暫時無法顯示",
    "en": "This message cannot be displayed right now",
    "ja": "現在、このメッセージを表示できません"
  },
  "common.unknownTime": {
    "zh-Hans": "时间未知",
    "zh-Hant": "時間未知",
    "en": "Unknown time",
    "ja": "日時不明"
  },
  "common.notAuthenticated": {
    "zh-Hans": "登录会话已过期，请重新登录后核对状态",
    "zh-Hant": "登入工作階段已過期，請重新登入後核對狀態",
    "en": "Your sign-in session has expired. Sign in again, then check the current state",
    "ja": "ログインセッションの有効期限が切れました。再度ログインして、現在の状態を確認してください"
  },
  "common.conflict": {
    "zh-Hans": "保存的版本已变化。请重新读取并核对，不会自动覆盖",
    "zh-Hant": "儲存的版本已變更。請重新讀取並核對，不會自動覆寫",
    "en": "The saved version has changed. Reload and review it; nothing will be overwritten automatically",
    "ja": "保存済みのバージョンが変更されました。再度読み込んで確認してください。自動的に上書きすることはありません"
  },
  "common.unknownOutcome": {
    "zh-Hans": "提交结果尚未确认。请先核对原请求，不要重复提交",
    "zh-Hant": "提交結果尚未確認。請先核對原請求，不要重複提交",
    "en": "The submission outcome is not yet confirmed. Check the original request before submitting again",
    "ja": "送信結果をまだ確認できません。重複送信せず、先に元のリクエストを確認してください"
  },
  "app.title": {
    "zh-Hans": "Mioon · 影像工作台",
    "zh-Hant": "Mioon · 影像工作台",
    "en": "Mioon · Video workspace",
    "ja": "Mioon · 動画ワークスペース"
  },
  "app.description": {
    "zh-Hans": "在画布中构思、生成、比较和编排你的影像",
    "zh-Hant": "在畫布中構思、生成、比較與編排影像",
    "en": "Develop, generate, compare, and arrange your video on one canvas",
    "ja": "ひとつのキャンバスで映像を構想し、生成・比較・編集できます"
  }
} as const satisfies MessageCatalog;
