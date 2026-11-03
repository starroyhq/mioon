import type {MessageCatalog} from '../types.ts';
export const workspaceConfigurationMessages={
 'workspace.settings.liveHelp':{'zh-Hans':'允许使用已配置的真实生成服务；仍需逐次确认图像费用','zh-Hant':'允許使用已設定的真實生成服務；仍須逐次確認影像費用',en:'Allow configured live generation services; image charges still require confirmation for each request',ja:'設定済みの実サービス生成を許可します。画像の料金はリクエストごとに確認します'},
 'workspace.settings.instant':{'zh-Hans':'更改立即保存在本机','zh-Hant':'變更立即儲存在本機',en:'Changes save locally immediately',ja:'変更はすぐにローカル保存されます'},
 'workspace.settings.reading':{'zh-Hans':'正在读取设置','zh-Hant':'正在讀取設定',en:'Reading settings',ja:'設定を読み込み中'},
 'workspace.settings.readOnly':{'zh-Hans':'服务器配置 · 只读','zh-Hant':'伺服器設定 · 唯讀',en:'Server configuration · read only',ja:'サーバー設定・読み取り専用'},
 'workspace.settings.saving':{'zh-Hans':'正在保存','zh-Hant':'正在儲存',en:'Saving',ja:'保存中'},
 'workspace.settings.unconfirmed':{'zh-Hans':'状态未确认','zh-Hant':'狀態未確認',en:'Status unconfirmed',ja:'状態未確認'},
 'workspace.settings.failed':{'zh-Hans':'操作未能确认，请刷新查看当前状态','zh-Hant':'操作未能確認，請重新整理查看目前狀態',en:'The operation could not be confirmed. Refresh to check its current status',ja:'操作を確認できませんでした。更新して現在の状態を確認してください'},
 'workspace.settings.conflict':{'zh-Hans':'设置已在其他窗口更改，请刷新后重试','zh-Hant':'設定已在其他視窗變更，請重新整理後重試',en:'Settings changed in another window. Refresh before trying again',ja:'別のウィンドウで設定が変更されました。更新してから再試行してください'},
 'workspace.settings.open':{'zh-Hans':'配置','zh-Hant':'設定',en:'Configure',ja:'設定'},
} as const satisfies MessageCatalog;
