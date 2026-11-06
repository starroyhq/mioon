import type {MessageCatalog} from '../types.ts';

export const nativeEntryMessages = {
  'nativeEntry.selectionExpired': {
    'zh-Hans': '所选保存位置已失效。请重新选择保存位置后再试；项目内容和表单输入已保留。',
    'zh-Hant': '所選儲存位置已失效。請重新選擇儲存位置後再試；專案內容及表單輸入已保留。',
    en: 'The selected save location is no longer valid. Choose a save location again. Project content and form input have been kept.',
    ja: '選択した保存場所は無効になりました。保存場所を選び直してください。プロジェクトの内容とフォームの入力は保持されています。',
  },
  'nativeEntry.recheckConsent': {
    'zh-Hans': '继续核对先前操作的结果？将使用原请求核对，现有表单输入会保留。',
    'zh-Hant': '繼續確認先前操作的結果？將使用原請求確認，現有表單輸入會保留。',
    en: 'Check the earlier action’s result? The original request will be used and current form input will be kept.',
    ja: '先ほどの操作結果を確認しますか？元のリクエストを使用し、現在のフォーム入力は保持されます。',
  },
  'nativeEntry.copySelectionExpired': {
    'zh-Hans': '先前的系统选择已失效。请重新选择项目文件，再选择保存位置。原项目未修改。',
    'zh-Hant': '先前的系統選擇已失效。請重新選擇專案檔案，再選擇儲存位置。原專案未修改。',
    en: 'The earlier system selection is no longer valid. Select the project file again, then choose a save location. The original project was not changed.',
    ja: '先ほどのシステム選択は無効になりました。プロジェクトファイルを選び直し、保存場所を選択してください。元のプロジェクトは変更されていません。',
  },
} as const satisfies MessageCatalog;
