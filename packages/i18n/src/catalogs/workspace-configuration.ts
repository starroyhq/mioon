import type {MessageCatalog} from '../types.ts';
export const workspaceConfigurationMessages={
 'workspace.settings.instant':{'zh-Hans':'更改立即保存在本机','zh-Hant':'變更立即儲存在本機',en:'Changes save locally immediately',ja:'変更はすぐにローカル保存されます'},
 'workspace.settings.reading':{'zh-Hans':'正在读取设置','zh-Hant':'正在讀取設定',en:'Reading settings',ja:'設定を読み込み中'},
 'workspace.settings.readOnly':{'zh-Hans':'服务器配置 · 只读','zh-Hant':'伺服器設定 · 唯讀',en:'Server configuration · read only',ja:'サーバー設定・読み取り専用'},
 'workspace.settings.saving':{'zh-Hans':'正在保存','zh-Hant':'正在儲存',en:'Saving',ja:'保存中'},
 'workspace.settings.unconfirmed':{'zh-Hans':'状态未确认','zh-Hant':'狀態未確認',en:'Status unconfirmed',ja:'状態未確認'},
 'workspace.settings.failed':{'zh-Hans':"操作结果未确认。",'zh-Hant':"操作結果未確認。",en:"The operation could not be confirmed.",ja:"操作結果を確認できませんでした。"},
 'workspace.settings.conflict':{'zh-Hans':"设置已在其他窗口更改。",'zh-Hant':"設定已在其他視窗更改。",en:"Settings changed in another window.",ja:"別のウィンドウで設定が変更されました。"},
 'workspace.settings.open':{'zh-Hans':'配置','zh-Hant':'設定',en:'Configure',ja:'設定'},
} as const satisfies MessageCatalog;
