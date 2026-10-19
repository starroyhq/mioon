import type {MessageCatalog} from '../types.ts';
export const exportFileMessages={
 'export.file.missing':{'zh-Hans':'导出文件丢失','zh-Hant':'匯出檔案遺失',en:'Export file missing',ja:'書き出しファイルが見つかりません'},
 'export.file.locate':{'zh-Hans':'重新定位文件','zh-Hant':'重新定位檔案',en:'Locate file',ja:'ファイルを再指定'},
 'export.file.exact':{'zh-Hans':'请选择原导出文件；大小与哈希必须完全一致','zh-Hant':'請選擇原匯出檔案；大小與雜湊必須完全相同',en:'Select the original export file. Size and hash must match exactly',ja:'元の書き出しファイルを選択してください。サイズとハッシュが完全に一致する必要があります'},
 'export.file.check':{'zh-Hans':'检查文件','zh-Hant':'檢查檔案',en:'Check file',ja:'ファイルを確認'},
 'export.file.failed':{'zh-Hans':'文件检查或恢复未完成，请核对原文件后重试','zh-Hant':'檔案檢查或復原未完成，請核對原檔案後重試',en:'File checking or recovery did not complete. Verify the original file and retry',ja:'ファイルの確認または復元が完了しませんでした。元のファイルを確認して再試行してください'},
} as const satisfies MessageCatalog;
