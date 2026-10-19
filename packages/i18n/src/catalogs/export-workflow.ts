import type { MessageCatalog } from '../types.ts';

export const exportWorkflowMessages = {
  'redesign.export.reexport': { 'zh-Hans': '重新导出', 'zh-Hant': '重新匯出', en: 'Export again', ja: 'もう一度書き出す' },
  'redesign.export.steps': { 'zh-Hans': '导出步骤', en: 'Export steps', ja: '書き出し手順', 'zh-Hant': '匯出步驟' },
  'redesign.export.step1': { 'zh-Hans': '检查', en: 'Check', ja: '確認', 'zh-Hant': '檢查' },
  'redesign.export.step2': { 'zh-Hans': '设置', en: 'Settings', ja: '設定', 'zh-Hant': '設定' },
  'redesign.export.step3': { 'zh-Hans': '确认', en: 'Confirm', ja: '確定', 'zh-Hant': '確認' },
  'redesign.export.step4': { 'zh-Hans': '导出', en: 'Export', ja: '書き出し', 'zh-Hant': '匯出' },
  'redesign.export.step5': { 'zh-Hans': '完成', en: 'Done', ja: '完了', 'zh-Hant': '完成' },
  'redesign.export.previous': { 'zh-Hans': '上一步', en: 'Back', ja: '戻る', 'zh-Hant': '上一步' },
  'redesign.export.nextSettings': { 'zh-Hans': '下一步：设置', en: 'Next: settings', ja: '次へ：設定', 'zh-Hant': '下一步：設定' },
  'redesign.export.nextConfirm': { 'zh-Hans': '下一步：确认', en: 'Next: confirm', ja: '次へ：確定', 'zh-Hant': '下一步：確認' },
  'redesign.export.complete': { 'zh-Hans': '导出完成', en: 'Export complete', ja: '書き出し完了', 'zh-Hant': '匯出完成' },
  'redesign.export.failed': { 'zh-Hans': '导出失败', en: 'Export failed', ja: '書き出しに失敗しました', 'zh-Hant': '匯出失敗' },
  'redesign.export.unknown': { 'zh-Hans': '导出结果待确认', en: 'Export outcome unconfirmed', ja: '書き出し結果は未確認です', 'zh-Hant': '匯出結果待確認' },
  'redesign.export.running': { 'zh-Hans': '正在导出', en: 'Exporting', ja: '書き出し中', 'zh-Hant': '正在匯出' },
  'redesign.export.closeKeepsTask': { 'zh-Hans': '关闭窗口后任务继续运行；可在任务中查看进度。不会自动重新提交', en: 'The task continues after closing. View progress in Tasks. It will never resubmit automatically', ja: '閉じてもタスクは続行します。「タスク」で進捗を確認できます。自動再送信はしません', 'zh-Hant': '關閉視窗後任務繼續執行；可在任務中查看進度。不會自動重新提交' },
  'redesign.export.viewTasks': { 'zh-Hans': '查看任务', en: 'View tasks', ja: 'タスクを見る', 'zh-Hant': '查看任務' },
} as const satisfies MessageCatalog;
