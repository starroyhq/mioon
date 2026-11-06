import type { MessageCatalog } from '../types.ts';

export const projectRulesRuntimeMessages = {
 'projectRules.runtime.receiptOwnerUnknown':{'zh-Hans':'这份未确认的规范请求来自旧版记录，无法核实所属的应用资料库。原请求仍保留，不能在当前资料库核对或重发。','zh-Hant':'這份未確認的規範請求來自舊版記錄，無法核實所屬的應用程式資料庫。原請求仍保留，無法在目前資料庫核對或重送。',en:'This unconfirmed rules request has a legacy record without a verifiable application library. The original is retained and cannot be checked or resent in this library.',ja:'この未確認のルール要求は、所属ライブラリーを確認できない旧版の記録です。元の要求は保持され、このライブラリーで照合や再送はできません。'},
  'projectRules.runtime.pending': {'zh-Hans': '有一次规范保存尚未核对完成。完成核对前不会启用或覆盖文件。', 'zh-Hant': '有一次規範儲存尚未核對完成。完成核對前不會啟用或覆寫檔案。', en: 'A rules write is still unresolved. The file will not be enabled or replaced until it is checked.', ja: '規範の保存結果が未確認です。確認が完了するまで有効化や上書きはできません。'},
  'projectRules.runtime.pendingLabel': {'zh-Hans': '等待核对', 'zh-Hant': '等待核對', en: 'Awaiting verification', ja: '確認待ち'},
  'projectRules.runtime.unavailable': {'zh-Hans': '暂时无法安全读取或确认此文件，当前不会启用。', 'zh-Hant': '暫時無法安全讀取或確認此檔案，目前不會啟用。', en: 'This file cannot currently be read or verified safely and is not enabled.', ja: '現在、このファイルを安全に読み取り・確認できないため有効にできません。'},
  'projectRules.runtime.unavailableLabel': {'zh-Hans': '暂不可用', 'zh-Hant': '暫不可用', en: 'Unavailable', ja: '利用不可'},
  'projectRules.runtime.unknown': {'zh-Hans': '无法确认保存结果。请核对原请求；不会自动重新保存或启用。', 'zh-Hant': '無法確認儲存結果。請核對原請求；不會自動重新儲存或啟用。', en: 'The write outcome is unknown. Check the original request; it will not be saved or enabled again automatically.', ja: '保存結果を確認できません。元の要求を確認してください。自動的な再保存・有効化は行いません。'},
  'projectRules.runtime.check': {'zh-Hans': '核对原保存', 'zh-Hant': '核對原儲存', en: 'Check original write', ja: '元の保存を確認'},
  'projectRules.runtime.reconcile': {'zh-Hans': '继续核对原请求', 'zh-Hant': '繼續核對原請求', en: 'Reconcile original request', ja: '元の要求を照合'},
  'projectRules.runtime.notApplied': {'zh-Hans': '已确认原请求没有执行。草稿仍在，可检查最新文件后重新保存。', 'zh-Hant': '已確認原請求沒有執行。草稿仍在，可檢查最新檔案後重新儲存。', en: 'The original write was not applied. Your draft is retained; review the latest file before saving again.', ja: '元の要求が実行されていないことを確認しました。下書きを保持しています。最新ファイルを確認してから保存できます。'},
  'projectRules.runtime.receiptError': {'zh-Hans': '无法安全保存或读取原请求记录。请保留此窗口，暂不重新保存。', 'zh-Hant': '無法安全儲存或讀取原請求紀錄。請保留此視窗，暫不重新儲存。', en: 'The original request record cannot be stored or read safely. Keep this window and do not submit again yet.', ja: '元の要求の記録を安全に保存・読み取りできません。このウィンドウを保持し、再送信しないでください。'},
  'projectRules.runtime.nextRound': {'zh-Hans': '这里显示当前文件状态；保存或启用只影响之后发送的请求，不会改变已发送的轮次。', 'zh-Hant': '這裡顯示目前檔案狀態；儲存或啟用只影響之後傳送的請求，不會改變已傳送的輪次。', en: 'This is the current file state. Saving or enabling affects future requests, never rounds already sent.', ja: '現在のファイルの状態です。保存・有効化は今後の要求にのみ反映され、送信済みのラウンドは変わりません。'},
  'projectRules.runtime.refresh': {'zh-Hans': '重新读取状态', 'zh-Hant': '重新讀取狀態', en: 'Refresh file state', ja: '状態を再読み込み'},
  'projectRules.runtime.proposalUnavailable': {'zh-Hans': '宿主保存的完整规范提议暂不可用，不能确认。请重新读取这一轮。', 'zh-Hant': '宿主儲存的完整規範提議暫不可用，不能確認。請重新讀取這一輪。', en: 'The complete host-saved proposal is unavailable. Reload this round before approving.', ja: 'ホストが保存した提案全体を取得できません。このラウンドを再読み込みするまで承認できません。'},
  'projectRules.runtime.decisionUnknown': {'zh-Hans': '确认结果尚未核对。请使用此轮原请求的核对入口，不要重复确认。', 'zh-Hant': '確認結果尚未核對。請使用此輪原請求的核對入口，不要重複確認。', en: 'The decision outcome is unverified. Check this round’s original request instead of deciding again.', ja: '確認操作の結果が未確認です。このラウンドの元の要求を確認し、重ねて操作しないでください。'},
  'projectRules.runtime.proposalBefore': {'zh-Hans': '完整原文', 'zh-Hant': '完整原文', en: 'Complete original', ja: '変更前の全文'},
  'projectRules.runtime.proposalAfter': {'zh-Hans': '完整拟写入内容', 'zh-Hant': '完整擬寫入內容', en: 'Complete proposed file', ja: '提案された全文'},
  'projectRules.runtime.emptyFile': {'zh-Hans': '（空文件）', 'zh-Hant': '（空檔案）', en: '(empty file)', ja: '（空のファイル）'},
  'projectRules.runtime.noFile': {'zh-Hans': '（原文件不存在）', 'zh-Hant': '（原檔案不存在）', en: '(file does not exist)', ja: '（ファイルなし）'},
} as const satisfies MessageCatalog;
