import type { MessageCatalog } from '../types.ts';
export const nativeMessages = {
  "native.application": {
    "zh-Hans": "应用",
    "zh-Hant": "應用程式",
    "en": "Application",
    "ja": "アプリケーション"
  },
  "native.newProject": {
    "zh-Hans": "新建项目",
    "zh-Hant": "新增專案",
    "en": "New project",
    "ja": "新規プロジェクト"
  },
  "native.openProject": {
    "zh-Hans": "打开项目",
    "zh-Hant": "開啟專案",
    "en": "Open project",
    "ja": "プロジェクトを開く"
  },
  "native.connections": {
    "zh-Hans": "连接设置",
    "zh-Hant": "連線設定",
    "en": "Connection settings",
    "ja": "接続設定"
  },
  "native.reload": {
    "zh-Hans": "重新载入界面",
    "zh-Hant": "重新載入介面",
    "en": "Reload interface",
    "ja": "画面を再読み込み"
  },
  "native.restartService": {
    "zh-Hans": "重启本地服务",
    "zh-Hant": "重新啟動本機服務",
    "en": "Restart local service",
    "ja": "ローカルサービスを再起動"
  },
  "native.quit": {
    "zh-Hans": "退出",
    "zh-Hant": "結束",
    "en": "Quit",
    "ja": "終了"
  },
  "native.edit": {
    "zh-Hans": "编辑",
    "zh-Hant": "編輯",
    "en": "Edit",
    "ja": "編集"
  },
  "native.window": {
    "zh-Hans": "窗口",
    "zh-Hant": "視窗",
    "en": "Window",
    "ja": "ウィンドウ"
  },
  "native.restart": {
    "zh-Hans": "重启",
    "zh-Hant": "重新啟動",
    "en": "Restart",
    "ja": "再起動"
  },
  "native.cancel": {
    "zh-Hans": "取消",
    "zh-Hant": "取消",
    "en": "Cancel",
    "ja": "キャンセル"
  },
  "native.keepEditing": {
    "zh-Hans": "继续编辑",
    "zh-Hant": "繼續編輯",
    "en": "Keep editing",
    "ja": "編集を続ける"
  },
  "native.keepWindow": {
    "zh-Hans": "保留窗口",
    "zh-Hant": "保留視窗",
    "en": "Keep window open",
    "ja": "ウィンドウを開いたままにする"
  },
  "native.quitApplication": {
    "zh-Hans": "退出应用",
    "zh-Hant": "結束應用程式",
    "en": "Quit application",
    "ja": "アプリケーションを終了"
  },
  "native.acknowledge": {
    "zh-Hans": "知道了",
    "zh-Hant": "知道了",
    "en": "OK",
    "ja": "確認"
  },
  "native.discard": {
    "zh-Hans": "放弃修改",
    "zh-Hant": "捨棄變更",
    "en": "Discard changes",
    "ja": "変更を破棄"
  },
  "native.toolsTitle": {
    "zh-Hans": "配置视频工具",
    "zh-Hant": "設定影片工具",
    "en": "Configure video tools",
    "ja": "動画ツールの設定"
  },
  "native.toolsMessage": {
    "zh-Hans": "需要你已安装的 FFmpeg 和 ffprobe",
    "zh-Hant": "需要已安裝的 FFmpeg 和 ffprobe",
    "en": "An installed copy of FFmpeg and ffprobe is required",
    "ja": "インストール済みの FFmpeg と ffprobe が必要です"
  },
  "native.toolsDetail": {
    "zh-Hans": "本应用包含 Electron / Node / SQLite，但不捆绑 FFmpeg。请选择从可信来源安装的 ffmpeg 和 ffprobe 可执行文件。仅保存所选路径，不修改原始素材",
    "zh-Hant": "本應用程式包含 Electron / Node / SQLite，但未隨附 FFmpeg。請選擇從可信來源安裝的 ffmpeg 和 ffprobe 執行檔。僅儲存所選路徑，不會修改原始素材",
    "en": "This app includes Electron / Node / SQLite, but not FFmpeg. Select ffmpeg and ffprobe executables installed from a trusted source. Only their paths are saved; original media is not modified",
    "ja": "このアプリには Electron / Node / SQLite が含まれますが、FFmpeg は同梱されていません。信頼できる配布元からインストールした ffmpeg と ffprobe の実行ファイルを選択してください。選択したパスのみを保存し、元の素材は変更しません"
  },
  "native.chooseTools": {
    "zh-Hans": "选择工具",
    "zh-Hant": "選擇工具",
    "en": "Choose tools",
    "ja": "ツールを選択"
  },
  "native.chooseExecutable": {
    "zh-Hans": "选择 {name} 可执行文件",
    "zh-Hant": "選擇 {name} 執行檔",
    "en": "Choose the {name} executable",
    "ja": "{name} の実行ファイルを選択"
  },
  "native.originalDiagnostic": {
    "zh-Hans": "原始诊断信息：{detail}",
    "zh-Hant": "原始診斷資訊：{detail}",
    "en": "Original diagnostic details: {detail}",
    "ja": "元の診断情報：{detail}"
  },
  "native.draftTitle": {
    "zh-Hans": "本地草稿或视图尚未确认保存",
    "zh-Hant": "本機草稿或檢視尚未確認儲存",
    "en": "Local draft or view save is unconfirmed",
    "ja": "ローカルの下書きや表示位置の保存を確認できません"
  },
  "native.draftReloadMessage": {
    "zh-Hans": "部分本地草稿或视图位置尚未确认保存，仍要重新载入？",
    "zh-Hant": "部分本機草稿或檢視位置尚未確認儲存，仍要重新載入？",
    "en": "Some local drafts or view positions have not been confirmed saved. Reload anyway?",
    "ja": "一部の下書きや表示位置の保存を確認できません。それでも再読み込みしますか？"
  },
  "native.draftQuitMessage": {
    "zh-Hans": "部分本地草稿或视图位置尚未确认保存，仍要退出？",
    "zh-Hant": "部分本機草稿或檢視位置尚未確認儲存，仍要結束？",
    "en": "Some local drafts or view positions have not been confirmed saved. Quit anyway?",
    "ja": "一部の下書きや表示位置の保存を確認できません。それでも終了しますか？"
  },
  "native.draftReloadDetail": {
    "zh-Hans": "重新载入可能丢失最后未确认的输入或位置；不会改变已保存的项目和媒体，也不会取消可能仍在处理的保存请求。可以继续编辑并核对保存状态",
    "zh-Hant": "重新載入可能遺失最後未確認的輸入或位置；不會變更已儲存的專案與媒體，也不會取消可能仍在處理的儲存請求。可以繼續編輯並核對儲存狀態",
    "en": "Reloading may lose the last unconfirmed input or position. It will not change saved projects or media, or cancel save requests that may still be processing. You can keep editing and check the save status",
    "ja": "再読み込みにより、最後の未確認の入力や位置が失われる可能性があります。保存済みのプロジェクトやメディアは変更されず、処理中かもしれない保存リクエストもキャンセルされません。編集を続けて保存状態を確認できます"
  },
  "native.draftQuitDetail": {
    "zh-Hans": "直接退出可能丢失最后未确认的输入或位置；不会改变已保存的项目和媒体，也不会取消可能仍在处理的保存请求。可以继续编辑并核对保存状态",
    "zh-Hant": "直接結束可能遺失最後未確認的輸入或位置；不會變更已儲存的專案與媒體，也不會取消可能仍在處理的儲存請求。可以繼續編輯並核對儲存狀態",
    "en": "Quitting may lose the last unconfirmed input or position. It will not change saved projects or media, or cancel save requests that may still be processing. You can keep editing and check the save status",
    "ja": "終了により、最後の未確認の入力や位置が失われる可能性があります。保存済みのプロジェクトやメディアは変更されず、処理中かもしれない保存リクエストもキャンセルされません。編集を続けて保存状態を確認できます"
  },
  "native.reloadAnyway": {
    "zh-Hans": "仍然重新载入",
    "zh-Hant": "仍然重新載入",
    "en": "Reload anyway",
    "ja": "それでも再読み込み"
  },
  "native.quitAnyway": {
    "zh-Hans": "仍然退出",
    "zh-Hant": "仍然結束",
    "en": "Quit anyway",
    "ja": "それでも終了"
  },
  "native.unknownTitle": {
    "zh-Hans": "此窗口还有结果未知的操作",
    "zh-Hant": "此視窗仍有結果未知的操作",
    "en": "This window has operations with unknown outcomes",
    "ja": "このウィンドウに結果未確認の操作があります"
  },
  "native.unknownMessage": {
    "zh-Hans": "了解风险并关闭此窗口？",
    "zh-Hant": "了解風險並關閉此視窗？",
    "en": "Close this window after acknowledging the risk?",
    "ja": "リスクを理解したうえで、このウィンドウを閉じますか？"
  },
  "native.unknownDetail": {
    "zh-Hans": "操作可能已经在后台完成。关闭只放弃本窗口的未确认线索，不代表失败或取消，不会删除已保存数据或重发请求。重新导入可能产生重复素材。建议保留窗口，先核对原项目与记录；本次选择仅用于这一次关闭",
    "zh-Hant": "操作可能已在背景完成。關閉只會捨棄此視窗中的未確認線索，不代表失敗或取消，也不會刪除已儲存資料或重送請求。重新匯入可能產生重複素材。建議保留視窗，先核對原專案與記錄；本次選擇僅適用於此次關閉",
    "en": "The operation may already have completed in the background. Closing only discards this window’s unconfirmed clues; it does not mean failure or cancellation, delete saved data, or resend requests. Importing again may create duplicate media. Keep the window open and check the original project and records first. This choice applies only to this close action",
    "ja": "操作はバックグラウンドですでに完了している可能性があります。閉じると、このウィンドウにある未確認の手掛かりのみが破棄されます。失敗やキャンセルを意味せず、保存済みデータの削除やリクエストの再送信も行いません。再度インポートすると素材が重複する可能性があります。ウィンドウを保持して、先に元のプロジェクトと記録を確認することをお勧めします。この選択は今回の閉じる操作にのみ適用されます"
  },
  "native.understandClose": {
    "zh-Hans": "了解风险并关闭",
    "zh-Hant": "了解風險並關閉",
    "en": "Acknowledge risk and close",
    "ja": "リスクを理解して閉じる"
  },
  "native.unsavedTitle": {
    "zh-Hans": "尚有未保存的修改",
    "zh-Hant": "仍有未儲存的變更",
    "en": "Unsaved changes remain",
    "ja": "未保存の変更があります"
  },
  "native.discardReloadMessage": {
    "zh-Hans": "放弃未保存的修改和未发送的输入并重新载入？",
    "zh-Hant": "捨棄未儲存的變更與未送出的輸入，並重新載入？",
    "en": "Discard unsaved changes and unsent input, then reload?",
    "ja": "未保存の変更と未送信の入力を破棄して、再読み込みしますか？"
  },
  "native.discardQuitMessage": {
    "zh-Hans": "放弃未保存的修改和未发送的输入并退出？",
    "zh-Hant": "捨棄未儲存的變更與未送出的輸入，並結束？",
    "en": "Discard unsaved changes and unsent input, then quit?",
    "ja": "未保存の変更と未送信の入力を破棄して、終了しますか？"
  },
  "native.discardReloadDetail": {
    "zh-Hans": "包括 Agent、图像工坊和连接设置中的未保存输入。重新载入不会保存连接设置或重新发送请求。选择继续编辑会保持当前窗口和本地服务运行",
    "zh-Hant": "包含 Agent、圖像工坊與連線設定中的未儲存輸入。重新載入不會儲存連線設定或重新送出請求。選擇繼續編輯會保留目前視窗與本機服務",
    "en": "This includes unsaved input in Agent, Image Studio, and connection settings. Reloading will not save connection settings or resend requests. Keep editing leaves the current window and local service running",
    "ja": "Agent、画像スタジオ、接続設定の未保存の入力も含まれます。再読み込みしても、接続設定の保存やリクエストの再送信は行いません。「編集を続ける」を選ぶと、現在のウィンドウとローカルサービスを維持します"
  },
  "native.discardQuitDetail": {
    "zh-Hans": "包括 Agent、图像工坊和连接设置中的未保存输入。退出不会保存连接设置或重新发送请求。选择继续编辑会保持当前窗口和本地服务运行",
    "zh-Hant": "包含 Agent、圖像工坊與連線設定中的未儲存輸入。結束不會儲存連線設定或重新送出請求。選擇繼續編輯會保留目前視窗與本機服務",
    "en": "This includes unsaved input in Agent, Image Studio, and connection settings. Quitting will not save connection settings or resend requests. Keep editing leaves the current window and local service running",
    "ja": "Agent、画像スタジオ、接続設定の未保存の入力も含まれます。終了しても、接続設定の保存やリクエストの再送信は行いません。「編集を続ける」を選ぶと、現在のウィンドウとローカルサービスを維持します"
  },
  "native.leaveBlockedTitle": {
    "zh-Hans": "暂时无法安全离开",
    "zh-Hant": "暫時無法安全離開",
    "en": "Cannot leave safely yet",
    "ja": "まだ安全に終了できません"
  },
  "native.leaveBlocked": {
    "zh-Hans": "还有读取、保存、发送或待核对的状态，请先在原面板处理",
    "zh-Hant": "仍有讀取、儲存、傳送或待核對的狀態，請先在原面板處理",
    "en": "Reading, saving, sending, or verification is still pending. Resolve it in the original panel first",
    "ja": "読み込み、保存、送信、または確認待ちの状態が残っています。先に元のパネルで対応してください"
  },
  "native.leaveChanged": {
    "zh-Hans": "确认期间的输入或状态已变化，本次操作已取消",
    "zh-Hant": "確認期間的輸入或狀態已變更，本次操作已取消",
    "en": "Input or state changed during confirmation. This action was cancelled",
    "ja": "確認中に入力や状態が変わったため、この操作はキャンセルされました"
  },
  "native.leaveUnverified": {
    "zh-Hans": "暂时无法确认当前输入的保存状态，本次操作已取消",
    "zh-Hant": "暫時無法確認目前輸入的儲存狀態，本次操作已取消",
    "en": "The current input’s save status could not be confirmed. This action was cancelled",
    "ja": "現在の入力の保存状態を確認できないため、この操作はキャンセルされました"
  },
  "native.leaveDetail": {
    "zh-Hans": "当前操作未继续，窗口和本地服务仍保留。不会放弃输入、保存连接设置或自动重试请求",
    "zh-Hant": "目前操作未繼續，視窗與本機服務仍保留。不會捨棄輸入、儲存連線設定或自動重試請求",
    "en": "The action did not proceed. The window and local service remain open. Input is not discarded, connection settings are not saved, and requests are not retried automatically",
    "ja": "操作は続行されていません。ウィンドウとローカルサービスは維持されます。入力の破棄、接続設定の保存、リクエストの自動再試行は行いません"
  },
  "native.serviceStoppedTitle": {
    "zh-Hans": "本地服务已停止",
    "zh-Hant": "本機服務已停止",
    "en": "Local service stopped",
    "ja": "ローカルサービスが停止しました"
  },
  "native.serviceStopped": {
    "zh-Hans": "本地服务意外退出。已保存的数据会在重启时恢复",
    "zh-Hant": "本機服務意外結束。已儲存資料會在重新啟動時恢復",
    "en": "The local service exited unexpectedly. Saved data will be restored on restart",
    "ja": "ローカルサービスが予期せず終了しました。保存済みデータは再起動時に復元されます"
  },
  "native.serviceStoppedDetail": {
    "zh-Hans": "未保存的界面修改可能丢失。生成任务会按已保存的状态恢复处理；提交结果未知时只对账，不会自动重新提交。Agent 对话保留已保存的文字；重启后不会自动继续推理或重新发送请求",
    "zh-Hant": "未儲存的介面變更可能遺失。生成任務會依已儲存的狀態恢復處理；提交結果未知時只會核對，不會自動重新提交。Agent 對話保留已儲存的文字；重新啟動後不會自動繼續推理或重新送出請求",
    "en": "Unsaved interface changes may be lost. Generation tasks resume according to their saved state. Unknown submission outcomes are reconciled only, never automatically resubmitted. Saved Agent conversation text is retained; restarting does not automatically resume reasoning or resend requests",
    "ja": "未保存の画面上の変更は失われる可能性があります。生成タスクは保存済みの状態に従って処理を再開します。送信結果が不明な場合は照合のみを行い、自動で再送信しません。Agent の会話は保存済みのテキストを保持しますが、再起動後に推論を自動再開したり、リクエストを再送信したりすることはありません"
  },
  "native.rendererTitle": {
    "zh-Hans": "界面需要重新载入",
    "zh-Hant": "介面需要重新載入",
    "en": "The interface needs to reload",
    "ja": "画面の再読み込みが必要です"
  },
  "native.rendererMessage": {
    "zh-Hans": "工作区界面没有响应。后台任务仍由本地服务管理",
    "zh-Hant": "工作區介面沒有回應。背景任務仍由本機服務管理",
    "en": "The workspace interface is not responding. Background tasks remain managed by the local service",
    "ja": "ワークスペースの画面が応答していません。バックグラウンドタスクは引き続きローカルサービスが管理しています"
  },
  "native.rendererDetail": {
    "zh-Hans": "如果界面进程已经崩溃，未保存的输入可能已经丢失。重新载入只恢复当前界面，不会重新提交任务或生成请求",
    "zh-Hant": "若介面程序已當機，未儲存的輸入可能已遺失。重新載入只會恢復目前介面，不會重新提交任務或生成請求",
    "en": "If the interface process has crashed, unsaved input may already be lost. Reloading restores only the current interface; it does not resubmit tasks or generation requests",
    "ja": "画面のプロセスがクラッシュした場合、未保存の入力はすでに失われている可能性があります。再読み込みは現在の画面のみを復元し、タスクや生成リクエストを再送信しません"
  },
  "native.emptyWindowTitle": {
    "zh-Hans": "窗口尚未载入",
    "zh-Hant": "視窗尚未載入",
    "en": "Window has not loaded",
    "ja": "ウィンドウがまだ読み込まれていません"
  },
  "native.emptyWindowMessage": {
    "zh-Hans": "此窗口还未打开任何项目界面",
    "zh-Hant": "此視窗尚未開啟任何專案介面",
    "en": "This window has not opened a project interface yet",
    "ja": "このウィンドウでは、まだプロジェクト画面を開いていません"
  },
  "native.emptyWindowDetail": {
    "zh-Hans": "可以重试固定入口，或关闭这个尚未载入的空窗口。其他窗口与后台任务会保留",
    "zh-Hant": "可以重試固定入口，或關閉這個尚未載入的空視窗。其他視窗與背景任務會保留",
    "en": "Retry the fixed entry point, or close this unloaded empty window. Other windows and background tasks remain open",
    "ja": "固定の入口を再試行するか、まだ読み込まれていない空のウィンドウを閉じることができます。他のウィンドウやバックグラウンドタスクは維持されます"
  },
  "native.retryLoad": {
    "zh-Hans": "重试载入",
    "zh-Hant": "重試載入",
    "en": "Retry loading",
    "ja": "読み込みを再試行"
  },
  "native.closeEmpty": {
    "zh-Hans": "关闭空窗口",
    "zh-Hant": "關閉空視窗",
    "en": "Close empty window",
    "ja": "空のウィンドウを閉じる"
  },
  "native.cannotStartTitle": {
    "zh-Hans": "无法启动 Mioon",
    "zh-Hant": "無法啟動 Mioon",
    "en": "Cannot start Mioon",
    "ja": "Mioon を起動できません"
  },
  "native.cannotStartMessage": {
    "zh-Hans": "应用无法启动",
    "zh-Hant": "應用程式無法啟動",
    "en": "The application could not start",
    "ja": "アプリケーションを起動できませんでした"
  },
  "native.restartQuestion": {
    "zh-Hans": "重启本地服务？",
    "zh-Hant": "重新啟動本機服務？",
    "en": "Restart the local service?",
    "ja": "ローカルサービスを再起動しますか？"
  },
  "native.restartDetail": {
    "zh-Hans": "所有窗口都需通过关闭检查后才停止服务。已保存的数据保留。未保存的界面修改可能丢失。生成任务会按已保存的状态恢复处理；提交结果未知时只对账，不会自动重新提交。Agent 对话保留已保存的文字；重启后不会自动继续推理或重新发送请求",
    "zh-Hant": "所有視窗都須通過關閉檢查後才會停止服務。已儲存資料會保留。未儲存的介面變更可能遺失。生成任務會依已儲存的狀態恢復處理；提交結果未知時只會核對，不會自動重新提交。Agent 對話保留已儲存的文字；重新啟動後不會自動繼續推理或重新送出請求",
    "en": "The service stops only after every window passes its close checks. Saved data is retained. Unsaved interface changes may be lost. Generation tasks resume according to their saved state. Unknown submission outcomes are reconciled only, never automatically resubmitted. Saved Agent conversation text is retained; restarting does not automatically resume reasoning or resend requests",
    "ja": "すべてのウィンドウが終了チェックを通過してからサービスを停止します。保存済みデータは保持されますが、未保存の画面上の変更は失われる可能性があります。生成タスクは保存済みの状態に従って処理を再開します。送信結果が不明な場合は照合のみを行い、自動で再送信しません。Agent の会話は保存済みのテキストを保持しますが、再起動後に推論を自動再開したり、リクエストを再送信したりすることはありません"
  },
  "native.waitExitTitle": {
    "zh-Hans": "正在等待本地进程退出",
    "zh-Hant": "正在等待本機程序結束",
    "en": "Waiting for the local process to exit",
    "ja": "ローカルプロセスの終了を待っています"
  },
  "native.waitExitMessage": {
    "zh-Hans": "本地进程尚未确认退出，应用将继续等待",
    "zh-Hant": "尚未確認本機程序已結束，應用程式將繼續等待",
    "en": "The local process has not been confirmed exited. The app will keep waiting",
    "ja": "ローカルプロセスの終了をまだ確認できません。アプリは待機を続けます"
  },
  "native.waitExitDetail": {
    "zh-Hans": "当前不会重启服务或继续发送终止信号。确认本地进程退出后，应用会完成清理并退出",
    "zh-Hant": "目前不會重新啟動服務或繼續傳送終止訊號。確認本機程序結束後，應用程式會完成清理並結束",
    "en": "The service will not be restarted and no further termination signals will be sent. Once the local process is confirmed exited, the app will finish cleanup and quit",
    "ja": "現在、サービスの再起動や追加の終了シグナルの送信は行いません。ローカルプロセスの終了が確認でき次第、アプリは後処理を完了して終了します"
  },
  "native.mediaExitTitle": {
    "zh-Hans": "无法确认媒体进程退出",
    "zh-Hant": "無法確認媒體程序已結束",
    "en": "Media process exit is unconfirmed",
    "ja": "メディアプロセスの終了を確認できません"
  },
  "native.mediaExitMessage": {
    "zh-Hans": "本地服务已退出，但媒体子进程可能仍在运行",
    "zh-Hant": "本機服務已結束，但媒體子程序可能仍在執行",
    "en": "The local service has exited, but media child processes may still be running",
    "ja": "ローカルサービスは終了しましたが、メディアの子プロセスは動作中の可能性があります"
  },
  "native.mediaExitDetail": {
    "zh-Hans": "应用无法安全核验这些进程，因此不会自动重启服务或按记录的进程编号强制终止。退出应用前或再次使用前，请在系统任务管理器中检查 FFmpeg 和 ffprobe 是否仍在运行",
    "zh-Hant": "應用程式無法安全核驗這些程序，因此不會自動重新啟動服務，也不會依記錄的程序編號強制終止。結束應用程式前或再次使用前，請在系統工作管理工具中檢查 FFmpeg 與 ffprobe 是否仍在執行",
    "en": "The app cannot safely verify these processes, so it will not automatically restart the service or forcibly terminate recorded process IDs. Before quitting or using the app again, check your system process manager to see whether FFmpeg and ffprobe are still running",
    "ja": "これらのプロセスを安全に検証できないため、サービスの自動再起動や、記録されたプロセス ID を使った強制終了は行いません。アプリを終了する前、または再び使用する前に、システムのプロセス管理ツールで FFmpeg と ffprobe がまだ動作していないか確認してください"
  },
  "native.cleanupTitle": {
    "zh-Hans": "退出清理未完成",
    "zh-Hant": "結束清理尚未完成",
    "en": "Exit cleanup did not finish",
    "ja": "終了時の後処理が完了していません"
  },
  "native.cleanupMessage": {
    "zh-Hans": "本地服务或应用清理未正常完成",
    "zh-Hant": "本機服務或應用程式未正常完成清理",
    "en": "The local service or application did not complete cleanup normally",
    "ja": "ローカルサービスまたはアプリの後処理が正常に完了しませんでした"
  },
  "native.cleanupManaged": {
    "zh-Hans": "应用将保留对本地服务的管理，请稍后再尝试退出",
    "zh-Hant": "應用程式會繼續管理本機服務，請稍後再嘗試結束",
    "en": "The app will continue managing the local service. Try quitting again later",
    "ja": "アプリはローカルサービスの管理を続けます。しばらくしてから、もう一度終了してください"
  },
  "native.cleanupPreserved": {
    "zh-Hans": "已保存的数据保持原样，下次启动时将尝试恢复",
    "zh-Hant": "已儲存資料保持原樣，下次啟動時會嘗試恢復",
    "en": "Saved data remains unchanged. Recovery will be attempted on the next start",
    "ja": "保存済みデータは変更されません。次回起動時に復元を試みます"
  },
  "native.saveVideo": {
    "zh-Hans": "保存视频",
    "zh-Hant": "儲存影片",
    "en": "Save video",
    "ja": "動画を保存"
  },
  "native.mp4Video": {
    "zh-Hans": "MP4 视频",
    "zh-Hant": "MP4 影片",
    "en": "MP4 video",
    "ja": "MP4 動画"
  },
  "native.storageTitle": {
    "zh-Hans": "无法安全启动 Mioon",
    "zh-Hant": "無法安全啟動 Mioon",
    "en": "Cannot start Mioon safely",
    "ja": "Mioon を安全に起動できません"
  },
  "native.storageMessage": {
    "zh-Hans": "数据目录未通过隐私检查",
    "zh-Hant": "資料目錄未通過隱私檢查",
    "en": "The data directory did not pass the privacy checks",
    "ja": "データディレクトリがプライバシーチェックを通過しませんでした"
  },
  "native.storageDetail": {
    "zh-Hans": "数据目录必须属于当前用户且仅供当前用户访问；应用管理的文件不能是符号链接或硬链接",
    "zh-Hant": "資料目錄必須屬於目前使用者，且僅供目前使用者存取；應用程式管理的檔案不能是符號連結或硬連結",
    "en": "The data directory must belong to the current user and be accessible only to that user. App-managed files cannot be symbolic or hard links",
    "ja": "データディレクトリは現在のユーザーが所有し、そのユーザーのみがアクセスできる必要があります。アプリが管理するファイルにシンボリックリンクやハードリンクは使用できません"
  },
  "native.storageRecovery": {
    "zh-Hans": "请先备份已有数据并手动检查权限，或选择一个新的私有目录。MIOON_DESKTOP_USER_DATA 必须使用真实的绝对路径，不能经过符号链接或路径别名",
    "zh-Hant": "請先備份現有資料並手動檢查權限，或選擇新的私有目錄。MIOON_DESKTOP_USER_DATA 必須使用真實的絕對路徑，不能經過符號連結或路徑別名",
    "en": "Back up existing data and check permissions manually, or choose a new private directory. MIOON_DESKTOP_USER_DATA must use a real absolute path without symbolic links or path aliases",
    "ja": "既存データをバックアップして権限を手動で確認するか、新しい非公開ディレクトリを選択してください。MIOON_DESKTOP_USER_DATA には、シンボリックリンクやパスの別名を経由しない実際の絶対パスを指定する必要があります"
  },
  "native.storagePreserved": {
    "zh-Hans": "现有数据保持原样，不会自动更改权限",
    "zh-Hant": "現有資料保持原樣，不會自動變更權限",
    "en": "Existing data remains unchanged. Permissions will not be changed automatically",
    "ja": "既存データは変更されません。権限を自動的に変更することもありません"
  },
  "native.channelMessage": {
    "zh-Hans": "数据目录属于另一个应用通道",
    "zh-Hant": "資料目錄屬於另一個應用程式通道",
    "en": "This data directory belongs to another app channel",
    "ja": "このデータディレクトリは別のアプリチャネルに属しています"
  },
  "native.channelDetail": {
    "zh-Hans": "开发版和正式版不能共用同一个数据目录",
    "zh-Hant": "開發版與正式版不能共用同一個資料目錄",
    "en": "Development and production builds cannot share one data directory",
    "ja": "開発版と製品版で同じデータディレクトリを共有することはできません"
  },
  "native.channelRecovery": {
    "zh-Hans": "请使用与该目录匹配的应用通道，或将 MIOON_DESKTOP_USER_DATA 设置为另一个新的私有目录。不要删除或改写现有标识来绕过检查",
    "zh-Hant": "請使用與該目錄相符的應用程式通道，或將 MIOON_DESKTOP_USER_DATA 設為另一個新的私有目錄。請勿刪除或改寫現有識別資料來略過檢查",
    "en": "Use the app channel matching this directory, or set MIOON_DESKTOP_USER_DATA to a different new private directory. Do not delete or rewrite the existing identity to bypass checks",
    "ja": "このディレクトリに対応するアプリチャネルを使用するか、MIOON_DESKTOP_USER_DATA に別の新しい非公開ディレクトリを指定してください。チェックを回避するために既存の識別情報を削除したり書き換えたりしないでください"
  },
  "native.identityMessage": {
    "zh-Hans": "应用数据标识无法读取",
    "zh-Hant": "無法讀取應用程式資料識別資訊",
    "en": "The app data identity could not be read",
    "ja": "アプリデータの識別情報を読み込めません"
  },
  "native.identityDetail": {
    "zh-Hans": "现有数据标识损坏或格式无效，无法确认它属于哪个应用通道",
    "zh-Hant": "現有資料識別資訊損壞或格式無效，無法確認其所屬的應用程式通道",
    "en": "The existing data identity is damaged or invalid, so its app channel cannot be confirmed",
    "ja": "既存のデータ識別情報が破損しているか形式が無効なため、どのアプリチャネルに属するか確認できません"
  },
  "native.identityRecovery": {
    "zh-Hans": "请先备份并检查现有数据，或将 MIOON_DESKTOP_USER_DATA 设置为一个新的私有目录",
    "zh-Hant": "請先備份並檢查現有資料，或將 MIOON_DESKTOP_USER_DATA 設為新的私有目錄",
    "en": "Back up and inspect existing data, or set MIOON_DESKTOP_USER_DATA to a new private directory",
    "ja": "既存データをバックアップして確認するか、MIOON_DESKTOP_USER_DATA に新しい非公開ディレクトリを指定してください"
  },
  "native.pathMessage": {
    "zh-Hans": "数据目录路径无效",
    "zh-Hant": "資料目錄路徑無效",
    "en": "The data directory path is invalid",
    "ja": "データディレクトリのパスが無効です"
  },
  "native.pathDetail": {
    "zh-Hans": "MIOON_DESKTOP_USER_DATA 必须是绝对路径",
    "zh-Hant": "MIOON_DESKTOP_USER_DATA 必須是絕對路徑",
    "en": "MIOON_DESKTOP_USER_DATA must be an absolute path",
    "ja": "MIOON_DESKTOP_USER_DATA には絶対パスを指定してください"
  },
  "native.privacyMessage": {
    "zh-Hans": "此平台尚无法验证私有存储权限",
    "zh-Hant": "此平台尚無法驗證私有儲存權限",
    "en": "Private storage permissions cannot yet be verified on this platform",
    "ja": "このプラットフォームでは、まだ非公開ストレージの権限を検証できません"
  },
  "native.privacyDetail": {
    "zh-Hans": "Windows 私有存储还需要实现并验证当前用户 ACL 保护；0600/0700 文件模式不能代替 ACL 检查",
    "zh-Hant": "Windows 私有儲存仍須實作並驗證目前使用者的 ACL 保護；0600/0700 檔案模式不能取代 ACL 檢查",
    "en": "Windows private storage still requires implemented and verified current-user ACL protection. File modes 0600/0700 are not a substitute for ACL checks",
    "ja": "Windows の非公開ストレージでは、現在のユーザーに対する ACL 保護の実装と検証がまだ必要です。0600/0700 のファイルモードは ACL チェックの代わりにはなりません"
  },
  "native.privacyRecovery": {
    "zh-Hans": "请使用受支持的本地 POSIX 文件系统。更改目录路径或启用系统密钥库不能绕过此检查",
    "zh-Hant": "請使用受支援的本機 POSIX 檔案系統。變更目錄路徑或啟用系統金鑰庫不能略過此檢查",
    "en": "Use a supported local POSIX filesystem. Changing the directory path or enabling the system key store cannot bypass this check",
    "ja": "対応しているローカルの POSIX ファイルシステムを使用してください。ディレクトリの変更やシステムのキーストアの有効化では、このチェックを回避できません"
  },
  "native.linkDetail": {
    "zh-Hans": "所选目录或应用文件经过符号链接。请使用真实的绝对路径，不能使用链接或路径别名",
    "zh-Hant": "所選目錄或應用程式檔案經過符號連結。請使用真實的絕對路徑，不能使用連結或路徑別名",
    "en": "The selected directory or app file passes through a symbolic link. Use a real absolute path without links or path aliases",
    "ja": "選択されたディレクトリまたはアプリファイルはシンボリックリンクを経由しています。リンクやパスの別名を使わず、実際の絶対パスを指定してください"
  },
  "native.sizeDetail": {
    "zh-Hans": "已有应用文件超过安全读取大小限制。请先备份并检查该目录，不能直接覆盖它",
    "zh-Hant": "現有應用程式檔案超過安全讀取大小限制。請先備份並檢查該目錄，不能直接覆寫",
    "en": "An existing app file exceeds the safe read size limit. Back up and inspect the directory first; do not overwrite it directly",
    "ja": "既存のアプリファイルが安全な読み取りサイズの上限を超えています。直接上書きせず、先にディレクトリをバックアップして確認してください"
  },
  "native.about": {
    "zh-Hans": "关于 Mioon",
    "zh-Hant": "關於 Mioon",
    "en": "About Mioon",
    "ja": "Mioon について"
  },
  "native.services": {
    "zh-Hans": "服务",
    "zh-Hant": "服務",
    "en": "Services",
    "ja": "サービス"
  },
  "native.hide": {
    "zh-Hans": "隐藏 Mioon",
    "zh-Hant": "隱藏 Mioon",
    "en": "Hide Mioon",
    "ja": "Mioon を隠す"
  },
  "native.hideOthers": {
    "zh-Hans": "隐藏其他应用",
    "zh-Hant": "隱藏其他應用程式",
    "en": "Hide others",
    "ja": "ほかを隠す"
  },
  "native.showAll": {
    "zh-Hans": "显示全部",
    "zh-Hant": "顯示全部",
    "en": "Show all",
    "ja": "すべて表示"
  },
  "native.undo": {
    "zh-Hans": "撤销",
    "zh-Hant": "復原",
    "en": "Undo",
    "ja": "取り消す"
  },
  "native.redo": {
    "zh-Hans": "重做",
    "zh-Hant": "重做",
    "en": "Redo",
    "ja": "やり直す"
  },
  "native.cut": {
    "zh-Hans": "剪切",
    "zh-Hant": "剪下",
    "en": "Cut",
    "ja": "カット"
  },
  "native.copy": {
    "zh-Hans": "复制",
    "zh-Hant": "複製",
    "en": "Copy",
    "ja": "コピー"
  },
  "native.paste": {
    "zh-Hans": "粘贴",
    "zh-Hant": "貼上",
    "en": "Paste",
    "ja": "ペースト"
  },
  "native.pasteMatch": {
    "zh-Hans": "粘贴并匹配样式",
    "zh-Hant": "貼上並符合樣式",
    "en": "Paste and match style",
    "ja": "ペーストしてスタイルを合わせる"
  },
  "native.delete": {
    "zh-Hans": "删除",
    "zh-Hant": "刪除",
    "en": "Delete",
    "ja": "削除"
  },
  "native.selectAll": {
    "zh-Hans": "全选",
    "zh-Hant": "全選",
    "en": "Select all",
    "ja": "すべてを選択"
  },
  "native.minimize": {
    "zh-Hans": "最小化",
    "zh-Hant": "最小化",
    "en": "Minimize",
    "ja": "最小化"
  },
  "native.zoom": {
    "zh-Hans": "缩放",
    "zh-Hant": "縮放",
    "en": "Zoom",
    "ja": "拡大／縮小"
  },
  "native.front": {
    "zh-Hans": "全部置于前面",
    "zh-Hant": "全部置於最前方",
    "en": "Bring all to front",
    "ja": "すべてを手前に移動"
  },
  "native.closeWindow": {
    "zh-Hans": "关闭窗口",
    "zh-Hant": "關閉視窗",
    "en": "Close window",
    "ja": "ウィンドウを閉じる"
  }
} as const satisfies MessageCatalog;
