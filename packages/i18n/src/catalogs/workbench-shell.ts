import type { MessageCatalog } from '../types.ts';

export const workbenchShellMessages = {
  'redesign.tasks.viewAll': { 'zh-Hans': '查看全部任务', 'zh-Hant': '查看全部任務', en: 'View all tasks', ja: 'すべてのタスクを見る' },
  'redesign.tasks.rendering': { 'zh-Hans': '本地预览与导出', 'zh-Hant': '本機預覽與匯出', en: 'Local previews and exports', ja: 'ローカルプレビューと書き出し' },
  'redesign.tasks.unknownHint': { 'zh-Hans': '部分请求结果待确认。核对原请求，不会自动重新提交', 'zh-Hant': '部分請求結果待確認。核對原請求，不會自動重新提交', en: 'Some outcomes are unconfirmed. Check the original requests; they never resubmit automatically', ja: '未確認の結果があります。元のリクエストを確認してください。自動で再送信しません' },
  'redesign.shell.view': { 'zh-Hans': '视图', 'zh-Hant': '檢視', en: 'View', ja: '表示' },
  'redesign.shell.help': { 'zh-Hans': '帮助', 'zh-Hant': '說明', en: 'Help', ja: 'ヘルプ' },
  'redesign.shell.export': { 'zh-Hans': '导出', 'zh-Hant': '匯出', en: 'Export', ja: '書き出し' },
  'redesign.shell.versions': { 'zh-Hans': '版本', 'zh-Hant': '版本', en: 'Versions', ja: 'バージョン' },
  'redesign.shell.agent': { 'zh-Hans': '智能助理', 'zh-Hant': '智慧助理', en: 'Assistant', ja: 'アシスタント' },
  'redesign.shell.offline': { 'zh-Hans': '离线', 'zh-Hant': '離線', en: 'Offline', ja: 'オフライン' },
  'redesign.shell.saved': { 'zh-Hans': '已保存', 'zh-Hant': '已儲存', en: 'Saved', ja: '保存済み' },
  'redesign.shell.draft': { 'zh-Hans': '草稿', 'zh-Hant': '草稿', en: 'Draft', ja: '下書き' },
  'redesign.shell.pin': { 'zh-Hans': '固定面板', 'zh-Hant': '固定面板', en: 'Pin panel', ja: 'パネルを固定' },
} as const satisfies MessageCatalog;
