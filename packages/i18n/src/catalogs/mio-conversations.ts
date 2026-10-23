import type {MessageCatalog} from '../types.ts';

export const mioConversationMessages = {
  "agent.conversation.title": {
    "zh-Hans": "对话历史",
    "zh-Hant": "對話歷史",
    "en": "Conversation history",
    "ja": "会話履歴"
  },
  "agent.conversation.search": {
    "zh-Hans": "搜索对话",
    "zh-Hant": "搜尋對話",
    "en": "Search conversations",
    "ja": "会話を検索"
  },
  "agent.conversation.today": {
    "zh-Hans": "今天",
    "zh-Hant": "今天",
    "en": "Today",
    "ja": "今日"
  },
  "agent.conversation.yesterday": {
    "zh-Hans": "昨天",
    "zh-Hant": "昨天",
    "en": "Yesterday",
    "ja": "昨日"
  },
  "agent.conversation.earlier": {
    "zh-Hans": "更早",
    "zh-Hant": "更早",
    "en": "Earlier",
    "ja": "以前"
  },
  "agent.conversation.current": {
    "zh-Hans": "当前对话",
    "zh-Hant": "目前對話",
    "en": "Current conversation",
    "ja": "現在の会話"
  },
  "agent.conversation.changes": {
    "zh-Hans": "{count} 处变化",
    "zh-Hant": "{count} 處變更",
    "en": "{count} changes",
    "ja": "変更 {count} 件"
  },
  "agent.conversation.legacy": {
    "zh-Hans": "旧版对话 · 只读",
    "zh-Hant": "舊版對話 · 唯讀",
    "en": "Legacy conversation · Read only",
    "ja": "以前の会話・閲覧のみ"
  },
  "agent.conversation.empty": {
    "zh-Hans": "还没有对话",
    "zh-Hant": "還沒有對話",
    "en": "No conversations yet",
    "ja": "会話はまだありません"
  },
  "agent.conversation.noMatch": {
    "zh-Hans": "已加载的对话中没有匹配项",
    "zh-Hant": "已載入的對話中沒有符合項目",
    "en": "No matches in loaded conversations",
    "ja": "読み込み済みの会話に一致するものはありません"
  },
  "agent.conversation.loading": {
    "zh-Hans": "正在读取对话…",
    "zh-Hant": "正在讀取對話…",
    "en": "Loading conversations…",
    "ja": "会話を読み込み中…"
  },
  "agent.conversation.loadError": {
    "zh-Hans": "对话读取失败，请重试",
    "zh-Hant": "對話讀取失敗，請重試",
    "en": "Could not load the conversation. Try again",
    "ja": "会話を読み込めませんでした。もう一度お試しください"
  },
  "agent.conversation.loadMore": {
    "zh-Hans": "加载更早的对话",
    "zh-Hant": "載入更早的對話",
    "en": "Load earlier conversations",
    "ja": "以前の会話を読み込む"
  },
  "agent.conversation.back": {
    "zh-Hans": "返回对话",
    "zh-Hant": "返回對話",
    "en": "Back to conversation",
    "ja": "会話に戻る"
  },
  "agent.conversation.blocked.running": {
    "zh-Hans": "先完成或停止当前执行，再新建对话",
    "zh-Hant": "請先完成或停止目前執行，再建立新對話",
    "en": "Finish or stop the current run before starting a conversation",
    "ja": "現在の実行を完了または停止してから、新しい会話を始めてください"
  },
  "agent.conversation.blocked.interrupted": {
    "zh-Hans": "先处理上次未完成的执行，再新建对话",
    "zh-Hant": "請先處理上次未完成的執行，再建立新對話",
    "en": "Resolve the interrupted run before starting a conversation",
    "ja": "中断された実行を処理してから、新しい会話を始めてください"
  },
  "agent.conversation.blocked.pending": {
    "zh-Hans": "先核对上次操作的结果，再新建对话",
    "zh-Hant": "請先核對上次操作的結果，再建立新對話",
    "en": "Check the previous operation before starting a conversation",
    "ja": "前の操作結果を確認してから、新しい会話を始めてください"
  },
  "agent.conversation.blocked.unavailable": {
    "zh-Hans": "对话暂不可用，请等待读取完成或重试",
    "zh-Hant": "對話暫時無法使用，請等待讀取完成或重試",
    "en": "Wait for the conversation to load, or retry",
    "ja": "読み込みの完了を待つか、再試行してください"
  },
  "agent.conversation.blocked.composing": {
    "zh-Hans": "请先完成当前文字输入",
    "zh-Hant": "請先完成目前的文字輸入",
    "en": "Finish entering the current text first",
    "ja": "入力中の文字を確定してください"
  },
  "agent.conversation.legacyDraft": {
    "zh-Hans": "旧版对话仅供查看，请新建对话继续",
    "zh-Hant": "舊版對話僅供檢視，請建立新對話繼續",
    "en": "This conversation is read only. Start a new conversation to continue",
    "ja": "この会話は閲覧のみです。続けるには新しい会話を始めてください"
  }
} as const satisfies MessageCatalog;
