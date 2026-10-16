import type { MessageCatalog } from '../types.ts';
export const timelineDeliveryMessages = {
  "export.sample.separateRange": {"zh-Hans": "此短范围仅用于试导出，不改变正式导出范围。", "zh-Hant": "此短範圍僅用於試導出，不會變更正式導出範圍。", "en": "This short range is only for the sample. The final export range is unchanged.", "ja": "この短い範囲は試し書き出し専用です。本番の書き出し範囲は変更しません。"},
  "export.sample.start": {"zh-Hans": "开始帧", "zh-Hant": "開始幀", "en": "Start frame", "ja": "開始フレーム"},
  "export.sample.end": {"zh-Hans": "结束帧（不含）", "zh-Hant": "結束幀（不含）", "en": "End frame (exclusive)", "ja": "終了フレーム（含まない）"},
  "export.sample.check": {"zh-Hans": "检查试导出", "zh-Hant": "檢查試導出", "en": "Check sample export", "ja": "試し書き出しをチェック"},
  "export.sample.checkState": {"zh-Hans": "试导出检查：{state}", "zh-Hant": "試導出檢查：{state}", "en": "Sample check: {state}", "ja": "試し書き出しチェック：{state}"},

  "export.sample.title": {"zh-Hans": "试导出预览", "zh-Hant": "試導出預覽", "en": "Sample export preview", "ja": "試し書き出しプレビュー"},
  "export.sample.help": {"zh-Hans": "使用当前导出设置生成真实 MP4，范围最多 300 帧（10 秒）。先选择短范围，再检查导出。短片仍可能需要较长素材检查或渲染时间。", "zh-Hant": "使用目前的導出設定產生真實 MP4，範圍最多 300 幀（10 秒）。先選擇短範圍，再檢查導出。短片仍可能需要較長的素材檢查或算圖時間。", "en": "Generate a real MP4 using the current export settings, up to 300 frames (10 seconds). Select a short range, then check the export. Source checks and rendering can still take time.", "ja": "現在の書き出し設定で最大 300 フレーム（10 秒）の実際の MP4 を生成します。短い範囲を選択してから書き出しチェックを行ってください。素材の確認やレンダリングには時間がかかる場合があります。"},
  "export.sample.select": {"zh-Hans": "选择播放头附近的短范围", "zh-Hant": "選擇播放頭附近的短範圍", "en": "Select a short range", "ja": "短い範囲を選択"},
  "export.sample.generate": {"zh-Hans": "生成试导出预览", "zh-Hant": "產生試導出預覽", "en": "Generate sample export", "ja": "試し書き出しを生成"},
  "export.sample.stale": {"zh-Hans": "设置、范围、已保存时间线或素材已变化。此结果已过期，请重新检查并生成。", "zh-Hant": "設定、範圍、已儲存時間軸或素材已變更。此結果已過期，請重新檢查並產生。", "en": "Settings, range, saved timeline or sources have changed. This result is stale; check and generate again.", "ja": "設定、範囲、保存済みタイムライン、または素材が変更されました。この結果は古いため、再チェックして生成してください。"},
  "export.sample.receipt": {"zh-Hans": "本次导出：{id}", "zh-Hant": "本次導出：{id}", "en": "This export: {id}", "ja": "今回の書き出し：{id}"},
  "export.sample.retained": {"zh-Hans": "关闭播放器或离开面板不会取消导出。试导出会保留真实文件和导出记录；重开项目后请到导出记录查找。", "zh-Hant": "關閉播放器或離開面板不會取消導出。試導出會保留真實檔案及導出記錄；重新開啟專案後請到導出記錄查找。", "en": "Closing the player or leaving this panel does not cancel the export. The real file and export record are retained; find them in export history after reopening the project.", "ja": "プレーヤーを閉じたりパネルを離れたりしても書き出しは取り消されません。実ファイルと履歴が残ります。プロジェクトを開き直した後は書き出し履歴で確認できます。"},
  "export.sample.close": {"zh-Hans": "关闭播放器", "zh-Hant": "關閉播放器", "en": "Close player", "ja": "プレーヤーを閉じる"},
  "export.sample.reopen": {"zh-Hans": "重新打开播放器", "zh-Hant": "重新開啟播放器", "en": "Reopen player", "ja": "プレーヤーを開く"},
  "export.sample.mediaError": {"zh-Hans": "无法播放此文件。请到导出记录下载并检查；不会自动重新导出。", "zh-Hant": "無法播放此檔案。請到導出記錄下載並檢查；不會自動重新導出。", "en": "This file could not be played. Download it from export history to inspect it; no export will be retried automatically.", "ja": "このファイルを再生できません。書き出し履歴からダウンロードして確認してください。自動で再書き出しはしません。"},
  "export.sample.phase.submitting": {"zh-Hans": "正在提交试导出…", "zh-Hant": "正在提交試導出…", "en": "Submitting sample export…", "ja": "試し書き出しを送信中…"},
  "export.sample.phase.queued": {"zh-Hans": "试导出正在排队…", "zh-Hant": "試導出正在排隊…", "en": "Sample export queued…", "ja": "試し書き出し待機中…"},
  "export.sample.phase.running": {"zh-Hans": "正在生成试导出文件…", "zh-Hant": "正在產生試導出檔案…", "en": "Rendering sample export…", "ja": "試し書き出しを処理中…"},
  "export.sample.phase.succeeded": {"zh-Hans": "试导出文件已完成。", "zh-Hant": "試導出檔案已完成。", "en": "Sample export file is ready.", "ja": "試し書き出しファイルが完成しました。"},
  "export.sample.phase.failed": {"zh-Hans": "试导出失败。请到任务中心查看详情。", "zh-Hant": "試導出失敗。請到任務中心查看詳情。", "en": "Sample export failed. See the task center for details.", "ja": "試し書き出しに失敗しました。タスクセンターで詳細を確認してください。"},
  "export.sample.phase.unknown": {"zh-Hans": "尚未确认提交结果，请到任务中心核对原请求，不要重复提交。", "zh-Hant": "尚未確認提交結果，請到任務中心核對原請求，不要重複提交。", "en": "Submission is not confirmed. Reconcile the original request in the task center; do not submit it again.", "ja": "送信結果が未確認です。重複送信せず、タスクセンターで元のリクエストを確認してください。"},
  "export.sample.phase.unavailable": {"zh-Hans": "当前无法核验或播放此结果，请检查连接或导出记录。", "zh-Hant": "目前無法核驗或播放此結果，請檢查連線或導出記錄。", "en": "This result cannot currently be verified or played. Check the connection or export history.", "ja": "現在、この結果を検証または再生できません。接続または書き出し履歴を確認してください。"},

  "export.history.film": {
    "zh-Hans": "成片",
    "zh-Hant": "成片",
    "en": "Film",
    "ja": "完成映像"
  },
  "export.history.held": {
    "zh-Hans": "历史记录 · 暂停执行，原状态保留",
    "zh-Hant": "歷史記錄 · 暫停執行，保留原狀態",
    "en": "Historical record · Execution paused; original status retained",
    "ja": "履歴 · 実行を停止し、元の状態を保持"
  },
  "export.history.preview": {
    "zh-Hans": "时间线预览",
    "zh-Hant": "時間軸預覽",
    "en": "Timeline preview",
    "ja": "タイムラインプレビュー"
  },
  "export.history.export": {
    "zh-Hans": "时间线导出",
    "zh-Hant": "時間軸匯出",
    "en": "Timeline export",
    "ja": "タイムライン書き出し"
  },
  "export.history.old": {
    "zh-Hans": " · 旧快照",
    "zh-Hant": " · 舊快照",
    "en": " · Older snapshot",
    "ja": " · 以前のスナップショット"
  },
  "export.history.current": {
    "zh-Hans": " · 当前",
    "zh-Hant": " · 目前",
    "en": " · Current",
    "ja": " · 現在"
  },
  "export.history.invalidRange": {
    "zh-Hans": "范围记录不完整，暂时不能下载。",
    "zh-Hant": "範圍記錄不完整，暫時無法下載。",
    "en": "The range record is incomplete. Download is currently unavailable.",
    "ja": "範囲の記録が不完全なため、現在はダウンロードできません。"
  },
  "export.history.upscale": {
    "zh-Hans": " · 放大输出，不增加细节",
    "zh-Hant": " · 放大輸出，不增加細節",
    "en": " · Upscaled output; no added detail",
    "ja": " · 拡大出力。細部は増えません"
  },
  "export.history.rangeUnavailable": {
    "zh-Hans": "范围不可用",
    "zh-Hant": "範圍無法使用",
    "en": "Range unavailable",
    "ja": "範囲を利用できません"
  },
  "export.history.download": {
    "zh-Hans": "下载",
    "zh-Hant": "下載",
    "en": "Download",
    "ja": "ダウンロード"
  },
  "export.history.retained": {
    "zh-Hans": "已保留 · 暂停",
    "zh-Hant": "已保留 · 暫停",
    "en": "Retained · Paused",
    "ja": "保持済み · 停止中"
  },
  "export.history.failed": {
    "zh-Hans": "失败",
    "zh-Hant": "失敗",
    "en": "Failed",
    "ja": "失敗"
  },
  "export.history.empty": {
    "zh-Hans": "还没有导出记录",
    "zh-Hant": "尚無匯出記錄",
    "en": "No exports yet",
    "ja": "書き出し履歴はありません"
  },
  "export.history.emptyHelp": {
    "zh-Hans": "将媒体编排到时间线后导出，或为镜头选好版本后使用分镜导出。",
    "zh-Hant": "將媒體編排至時間軸後匯出，或為鏡頭選好版本後使用分鏡匯出。",
    "en": "Arrange media on the timeline and export, or choose shot versions and export the storyboard.",
    "ja": "メディアをタイムラインに配置して書き出すか、ショットのバージョンを選んで絵コンテを書き出してください。"
  },
  "export.history.title": {
    "zh-Hans": "时间线导出记录",
    "zh-Hant": "時間軸匯出記錄",
    "en": "Timeline export record",
    "ja": "タイムラインの書き出し履歴"
  },
  "export.history.invalidDelivery": {
    "zh-Hans": "成片记录不完整，暂时不能下载。",
    "zh-Hant": "成片記錄不完整，暫時無法下載。",
    "en": "The export record is incomplete. Download is currently unavailable.",
    "ja": "完成映像の記録が不完全なため、現在はダウンロードできません。"
  },
  "export.history.legacyRate": {
    "zh-Hans": "原有编码设置",
    "zh-Hant": "原有編碼設定",
    "en": "Original encoding settings",
    "ja": "元のエンコード設定"
  },
  "export.history.frozenUnavailable": {
    "zh-Hans": "冻结成片规格不可用",
    "zh-Hant": "凍結的成片規格無法使用",
    "en": "Frozen output specifications unavailable",
    "ja": "固定された出力仕様を利用できません"
  },
  "export.name.label": {
    "zh-Hans": "本次成片名称",
    "zh-Hant": "本次成片名稱",
    "en": "Name for this export",
    "ja": "今回の書き出し名"
  },
  "export.name.optional": {
    "zh-Hans": "可选",
    "zh-Hant": "選填",
    "en": "Optional",
    "ja": "任意"
  },
  "export.name.checked": {
    "zh-Hans": "检查的成片名称",
    "zh-Hant": "檢查的成片名稱",
    "en": "Checked export name",
    "ja": "確認した書き出し名"
  },
  "export.name.placeholder": {
    "zh-Hans": "留空使用默认文件名",
    "zh-Hant": "留空使用預設檔名",
    "en": "Leave blank for the default filename",
    "ja": "空欄の場合は既定のファイル名を使用"
  },
  "export.name.help": {
    "zh-Hans": "仅用于本次时间线导出；导出记录会保留此名称。留空沿用默认文件名，不会保存一个新名称。",
    "zh-Hant": "僅用於本次時間軸匯出；匯出記錄會保留此名稱。留空沿用預設檔名，不會儲存新名稱。",
    "en": "Used only for this timeline export; the export record retains this name. Leave blank to use the default filename without saving a new name.",
    "ja": "今回のタイムライン書き出しにのみ使用し、書き出し履歴にこの名前を保持します。空欄なら既定のファイル名を使い、新しい名前は保存しません。"
  },
  "export.name.invalid": {
    "zh-Hans": "请输入 1–120 个字符，不能只有空格，也不能包含换行或控制字符。",
    "zh-Hant": "請輸入 1–120 個字元，不可只有空白，也不可包含換行或控制字元。",
    "en": "Enter 1–120 characters, not only spaces, with no line breaks or control characters.",
    "ja": "1～120 文字で入力してください。空白のみ、改行、制御文字は使用できません。"
  },
  "export.workspace.history": {
    "zh-Hans": "导出记录",
    "zh-Hant": "匯出記錄",
    "en": "Export history",
    "ja": "書き出し履歴"
  },
  "export.workspace.delivery": {
    "zh-Hans": "成片交付",
    "zh-Hant": "成片交付",
    "en": "Delivery",
    "ja": "完成映像の出力"
  },
  "export.workspace.historyHelp": {
    "zh-Hans": "每个文件使用创建时的固定快照。已命名成片保留原名称，后续修改不会覆盖旧文件。",
    "zh-Hant": "每個檔案使用建立時的固定快照。已命名成片保留原名稱，後續修改不會覆寫舊檔案。",
    "en": "Each file uses the snapshot fixed at creation. Named exports keep their original names; later edits do not overwrite old files.",
    "ja": "各ファイルには作成時に固定したスナップショットを使用します。名前付きの書き出しは元の名前を保持し、後の変更で古いファイルを上書きしません。"
  },
  "export.workspace.composeHelp": {
    "zh-Hans": "填写本次名称、检查已保存的时间线，再确认导出。切换到记录不会清除草稿。",
    "zh-Hant": "填寫本次名稱、檢查已儲存的時間軸，再確認匯出。切換至記錄不會清除草稿。",
    "en": "Enter a name, check the saved timeline, then confirm the export. Switching to history does not clear drafts.",
    "ja": "今回の名前を入力し、保存済みのタイムラインを確認してから書き出しを確定してください。履歴に切り替えても下書きは消えません。"
  },
  "export.workspace.pages": {
    "zh-Hans": "成片交付页面",
    "zh-Hant": "成片交付頁面",
    "en": "Delivery pages",
    "ja": "完成映像の出力ページ"
  },
  "export.workspace.compose": {
    "zh-Hans": "本次导出",
    "zh-Hant": "本次匯出",
    "en": "Current export",
    "ja": "今回の書き出し"
  },
  "export.range.title": {
    "zh-Hans": "本次导出范围",
    "zh-Hant": "本次匯出範圍",
    "en": "Range for this export",
    "ja": "今回の書き出し範囲"
  },
  "export.range.label": {
    "zh-Hans": "导出范围",
    "zh-Hant": "匯出範圍",
    "en": "Export range",
    "ja": "書き出し範囲"
  },
  "export.range.whole": {
    "zh-Hans": "全部已保存时间线",
    "zh-Hant": "整段已儲存時間軸",
    "en": "Entire saved timeline",
    "ja": "保存済みタイムライン全体"
  },
  "export.range.choose": {
    "zh-Hans": "选择导出范围",
    "zh-Hant": "選擇匯出範圍",
    "en": "Select export range",
    "ja": "書き出し範囲を選択"
  },
  "export.range.durationUnavailable": {
    "zh-Hans": "已保存时间线时长不可用",
    "zh-Hant": "已儲存時間軸的長度無法使用",
    "en": "Saved timeline duration unavailable",
    "ja": "保存済みタイムラインの長さを取得できません"
  },
  "export.range.start": {
    "zh-Hans": "开始帧（包含）",
    "zh-Hant": "開始影格（包含）",
    "en": "Start frame (inclusive)",
    "ja": "開始フレーム（含む）"
  },
  "export.range.end": {
    "zh-Hans": "结束帧（不包含）",
    "zh-Hant": "結束影格（不包含）",
    "en": "End frame (exclusive)",
    "ja": "終了フレーム（含まない）"
  },
  "export.range.boundsHelp": {
    "zh-Hans": "范围为左闭右开，至少 1 帧。开始帧从 0 起，结束帧不超过已保存时间线。",
    "zh-Hant": "範圍包含起點、不含終點，至少 1 影格。開始影格從 0 起，結束影格不可超過已儲存時間軸。",
    "en": "The range includes the start but excludes the end and must contain at least 1 frame. Start at frame 0 or later; the end cannot exceed the saved timeline.",
    "ja": "開始を含み終了を含まない範囲で、最低 1 フレーム必要です。開始は 0 フレーム以降、終了は保存済みタイムライン内にしてください。"
  },
  "export.range.unavailable": {
    "zh-Hans": "原范围信息不可用",
    "zh-Hant": "原範圍資訊無法使用",
    "en": "Original range information unavailable",
    "ja": "元の範囲情報を利用できません"
  },
  "export.range.originalWhole": {
    "zh-Hans": "全部原时间线",
    "zh-Hant": "整段原時間軸",
    "en": "Entire original timeline",
    "ja": "元のタイムライン全体"
  },
  "export.range.help": {
    "zh-Hans": "范围仅用于本次导出，不改变已保存时间线或编辑预览。未提交的范围不保存；重启或重新打开项目后请重新选择。",
    "zh-Hant": "範圍僅用於本次匯出，不會變更已儲存時間軸或編輯預覽。尚未提交的範圍不會儲存；重新啟動或重新開啟專案後請重新選擇。",
    "en": "This range applies only to this export, not the saved timeline or editing preview. Unsubmitted ranges are not saved; select again after restarting or reopening the project.",
    "ja": "範囲は今回の書き出しにのみ適用され、保存済みタイムラインや編集プレビューは変わりません。未送信の範囲は保存されないため、再起動やプロジェクトの再オープン後に選び直してください。"
  },
  "export.range.invalid": {
    "zh-Hans": "请输入有效整数帧：开始帧不能小于 0，结束帧必须大于开始帧且不超过已保存时间线，至少选择 1 帧。",
    "zh-Hant": "請輸入有效的整數影格：開始影格不可小於 0，結束影格必須大於開始影格且不超過已儲存時間軸，至少選擇 1 影格。",
    "en": "Enter valid integer frames: the start must be at least 0, and the end must be greater than the start without exceeding the saved timeline. Select at least 1 frame.",
    "ja": "整数のフレーム番号を入力してください。開始は 0 以上、終了は開始より大きく、保存済みタイムライン以内で、最低 1 フレーム必要です。"
  },
  "export.settings.profile": {
    "zh-Hans": "音频混音与检查",
    "zh-Hant": "音訊混音與檢查",
    "en": "Audio mixing and checks",
    "ja": "音声ミックスと検査"
  },
  "export.settings.v1": {
    "zh-Hans": "默认 v1 · 原有导出方式",
    "zh-Hant": "預設 v1 · 原有匯出方式",
    "en": "Default v1 · Original export method",
    "ja": "既定の v1 · 従来の書き出し方法"
  },
  "export.settings.v2": {
    "zh-Hans": "浮点检查 v2 · 编码前样本峰值检查",
    "zh-Hant": "浮點檢查 v2 · 編碼前樣本峰值檢查",
    "en": "Float check v2 · Pre-encoding sample peak check",
    "ja": "浮動小数点検査 v2 · エンコード前のサンプルピーク検査"
  },
  "export.settings.v2Help": {
    "zh-Hans": "本次明确选择浮点 v2：完整检查编码前样本峰值；超过 1 则不生成成片，不会自动降增益。仍需测量导出文件，不能保证 AAC 真峰值或输出响度。",
    "zh-Hant": "本次明確選擇浮點 v2：完整檢查編碼前樣本峰值；超過 1 則不產生成片，不會自動降低增益。仍須測量匯出檔案，無法保證 AAC 真峰值或輸出響度。",
    "en": "Float v2 is explicitly selected for this export: it fully checks pre-encoding sample peaks. Peaks above 1 prevent output; gain is not reduced automatically. Measure the exported file too; AAC true peak and output loudness are not guaranteed.",
    "ja": "今回の書き出しでは浮動小数点 v2 を明示的に選択しています。エンコード前のサンプルピークを全体で検査し、1 を超える場合は出力せず、ゲインも自動で下げません。書き出したファイルの測定も必要です。AAC のトゥルーピークや出力ラウドネスは保証しません。"
  },
  "export.settings.v1Help": {
    "zh-Hans": "默认 v1 保持原有导出方式；浮点候选测量不代表 v1 成片响度。应用增益不会改选导出方式。",
    "zh-Hant": "預設 v1 維持原有匯出方式；浮點候選測量不代表 v1 成片響度。套用增益不會變更匯出方式。",
    "en": "Default v1 keeps the original export method. Float candidate measurements do not represent v1 output loudness. Applying gain does not change the export method.",
    "ja": "既定の v1 は従来の書き出し方法を維持します。浮動小数点候補の測定値は v1 出力のラウドネスではありません。ゲインを適用しても書き出し方法は変わりません。"
  },
  "export.settings.title": {
    "zh-Hans": "本次成片设置",
    "zh-Hant": "本次成片設定",
    "en": "Settings for this export",
    "ja": "今回の出力設定"
  },
  "export.settings.scope": {
    "zh-Hans": "MP4 · H.264。仅用于本次导出，不更改时间线或编辑预览；重新打开项目后恢复默认。",
    "zh-Hant": "MP4 · H.264。僅用於本次匯出，不會變更時間軸或編輯預覽；重新開啟專案後恢復預設值。",
    "en": "MP4 · H.264. Applies only to this export, not the timeline or editing preview. Defaults return when you reopen the project.",
    "ja": "MP4 · H.264。今回の書き出しにのみ使用し、タイムラインや編集プレビューは変更しません。プロジェクトを開き直すと既定値に戻ります。"
  },
  "export.settings.resolution": {
    "zh-Hans": "成片分辨率",
    "zh-Hant": "成片解析度",
    "en": "Output resolution",
    "ja": "出力解像度"
  },
  "export.settings.native": {
    "zh-Hans": "原始合成尺寸",
    "zh-Hant": "原始合成尺寸",
    "en": "Original composition size",
    "ja": "元のコンポジションサイズ"
  },
  "export.settings.short360": {
    "zh-Hans": "短边 360 · 保持比例",
    "zh-Hant": "短邊 360 · 保持比例",
    "en": "360 short edge · Preserve ratio",
    "ja": "短辺 360 · 縦横比を維持"
  },
  "export.settings.short1080": {
    "zh-Hans": "短边 1080 · 放大",
    "zh-Hant": "短邊 1080 · 放大",
    "en": "1080 short edge · Upscale",
    "ja": "短辺 1080 · 拡大"
  },
  "export.settings.rateControl": {
    "zh-Hans": "视频码率控制",
    "zh-Hant": "視訊位元率控制",
    "en": "Video bitrate control",
    "ja": "映像ビットレート制御"
  },
  "export.settings.crf": {
    "zh-Hans": "按画质 · CRF",
    "zh-Hant": "依畫質 · CRF",
    "en": "Quality-based · CRF",
    "ja": "画質優先 · CRF"
  },
  "export.settings.bitrate": {
    "zh-Hans": "平均目标码率",
    "zh-Hant": "平均目標位元率",
    "en": "Average target bitrate",
    "ja": "平均目標ビットレート"
  },
  "export.settings.quality": {
    "zh-Hans": "画质",
    "zh-Hant": "畫質",
    "en": "Quality",
    "ja": "画質"
  },
  "export.settings.compact": {
    "zh-Hans": "紧凑 · CRF 28",
    "zh-Hant": "精簡 · CRF 28",
    "en": "Compact · CRF 28",
    "ja": "コンパクト · CRF 28"
  },
  "export.settings.standard": {
    "zh-Hans": "标准 · CRF 23",
    "zh-Hant": "標準 · CRF 23",
    "en": "Standard · CRF 23",
    "ja": "標準 · CRF 23"
  },
  "export.settings.high": {
    "zh-Hans": "高画质 · CRF 18",
    "zh-Hant": "高畫質 · CRF 18",
    "en": "High quality · CRF 18",
    "ja": "高画質 · CRF 18"
  },
  "export.settings.videoTarget": {
    "zh-Hans": "视频平均目标",
    "zh-Hant": "視訊平均目標",
    "en": "Average video target",
    "ja": "映像の平均目標値"
  },
  "export.settings.composition": {
    "zh-Hans": "编辑合成",
    "zh-Hant": "編輯合成",
    "en": "Editing composition",
    "ja": "編集用コンポジション"
  },
  "export.settings.output": {
    "zh-Hans": "本次成片",
    "zh-Hant": "本次成片",
    "en": "This output",
    "ja": "今回の出力"
  },
  "export.settings.video": {
    "zh-Hans": "视频",
    "zh-Hant": "視訊",
    "en": "Video",
    "ja": "映像"
  },
  "export.settings.fixed": {
    "zh-Hans": "固定规格",
    "zh-Hant": "固定規格",
    "en": "Fixed specifications",
    "ja": "固定仕様"
  },
  "export.settings.upscaleHelp": {
    "zh-Hans": "1080 短边会放大当前 720 短边合成，不增加原始画面细节。字幕随整幅画面缩放。",
    "zh-Hant": "1080 短邊會放大目前 720 短邊合成，不會增加原始畫面細節。字幕隨整幅畫面縮放。",
    "en": "A 1080 short edge upscales the current 720-short-edge composition without adding original detail. Subtitles scale with the whole image.",
    "ja": "短辺 1080 では現在の短辺 720 のコンポジションを拡大しますが、元の映像の細部は増えません。字幕は画面全体と一緒に拡大縮小されます。"
  },
  "export.settings.bitrateHelp": {
    "zh-Hans": "单遍编码的平均视频码率目标，不是严格带宽上限，也不保证文件大小。",
    "zh-Hant": "單次編碼的平均視訊位元率目標，並非嚴格的頻寬上限，也不保證檔案大小。",
    "en": "An average video bitrate target for single-pass encoding, not a strict bandwidth limit or a guarantee of file size.",
    "ja": "シングルパスエンコードの平均映像ビットレート目標です。厳密な帯域上限ではなく、ファイルサイズも保証しません。"
  },
  "export.settings.crfHelp": {
    "zh-Hans": "CRF 按画质编码，实际码率和文件大小随画面内容变化。",
    "zh-Hant": "CRF 依畫質編碼，實際位元率與檔案大小會隨畫面內容變化。",
    "en": "CRF encodes for quality; actual bitrate and file size vary with image content.",
    "ja": "CRF は画質を基準にエンコードします。実際のビットレートとファイルサイズは映像内容に応じて変わります。"
  },
  "export.settings.previewHelp": {
    "zh-Hans": "编辑预览始终使用原始合成尺寸与默认画质。检查或改选设置不会自动导出。",
    "zh-Hant": "編輯預覽一律使用原始合成尺寸與預設畫質。檢查或變更設定不會自動匯出。",
    "en": "Editing previews always use the original composition size and default quality. Checking or changing settings does not automatically export.",
    "ja": "編集プレビューは常に元のコンポジションサイズと既定の画質を使用します。設定の確認や変更だけでは自動で書き出しません。"
  },
  "recovery.common.unknown": {
    "zh-Hans": "未知",
    "zh-Hant": "未知",
    "en": "Unknown",
    "ja": "不明"
  },
  "recovery.common.storageTitle": {
    "zh-Hans": "本地保存什么？",
    "zh-Hant": "本機儲存哪些內容？",
    "en": "What is saved locally?",
    "ja": "ローカルに保存される内容"
  },
  "recovery.common.recheck": {
    "zh-Hans": "重新核对本地记录",
    "zh-Hant": "重新核對本機記錄",
    "en": "Recheck local records",
    "ja": "ローカル記録を再確認"
  },
  "recovery.common.validation": {
    "zh-Hans": "本地输入未通过校验，尚未发送保存请求。",
    "zh-Hant": "本機輸入未通過驗證，尚未傳送儲存請求。",
    "en": "Local input validation failed. No save request has been sent.",
    "ja": "ローカル入力の検証に失敗しました。保存リクエストは送信していません。"
  },
  "recovery.common.readOnly": {
    "zh-Hans": "重新核对只读取记录，不会自动恢复写入。",
    "zh-Hant": "重新核對僅讀取記錄，不會自動恢復寫入。",
    "en": "Rechecking only reads records; it does not automatically resume writes.",
    "ja": "再確認は記録の読み取りのみで、書き込みを自動再開しません。"
  },
  "recovery.common.originalTitle": {
    "zh-Hans": "（空标题）",
    "zh-Hant": "（空標題）",
    "en": "(Empty title)",
    "ja": "（タイトルなし）"
  },
  "recovery.common.emptyPrompt": {
    "zh-Hans": "（空提示词）",
    "zh-Hant": "（空提示詞）",
    "en": "(Empty prompt)",
    "ja": "（プロンプトなし）"
  },
  "recovery.common.retryIdentity": {
    "zh-Hans": "重试保留同一草稿编号与保存版本，不会改用较新的当前输入。",
    "zh-Hant": "重試會保留同一草稿編號與儲存版本，不會改用較新的目前輸入。",
    "en": "Retrying retains the same draft ID and save revision; it does not use newer current input.",
    "ja": "再試行では同じ下書き ID と保存バージョンを使用し、現在の新しい入力には置き換えません。"
  },
  "recovery.clip.abandonConfirm": {
    "zh-Hans": "放弃当前输入，保留草稿记录？这只会重置当前属性表单，不会删除已保存的草稿，也不会取消正在处理的写入或时间线请求。已保存或稍后写入的草稿可能再次出现。",
    "zh-Hant": "放棄目前輸入並保留草稿記錄？這只會重設目前屬性表單，不會刪除已儲存草稿，也不會取消處理中的寫入或時間軸請求。已儲存或稍後寫入的草稿可能再次出現。",
    "en": "Discard current input and retain draft records? This only resets the current properties form. It does not delete saved drafts or cancel in-progress writes or timeline requests. Saved drafts, including writes that finish later, may appear again.",
    "ja": "現在の入力を破棄し、下書き記録を保持しますか？現在のプロパティフォームだけをリセットします。保存済みの下書きは削除せず、処理中の書き込みやタイムラインのリクエストもキャンセルしません。保存済み、または後で書き込まれる下書きが再び表示される場合があります。"
  },
  "recovery.clip.unsupported": {
    "zh-Hans": "恢复分支暂不支持本地草稿",
    "zh-Hant": "還原分支暫不支援本機草稿",
    "en": "Local drafts are not supported in restored branches yet",
    "ja": "復元ブランチでは現在、ローカル下書きを利用できません"
  },
  "recovery.clip.recheckingPaused": {
    "zh-Hans": "正在重新核对本地草稿；自动保存仍暂停…",
    "zh-Hant": "正在重新核對本機草稿；自動儲存仍暫停…",
    "en": "Rechecking local draft; autosave remains paused…",
    "ja": "ローカル下書きを再確認中。自動保存は停止したままです…"
  },
  "recovery.clip.loading": {
    "zh-Hans": "正在核对本地草稿…",
    "zh-Hant": "正在核對本機草稿…",
    "en": "Checking local draft…",
    "ja": "ローカル下書きを確認中…"
  },
  "recovery.clip.reset": {
    "zh-Hans": "当前表单已重置；草稿记录保留，自动保存已暂停",
    "zh-Hant": "目前表單已重設；保留草稿記錄，自動儲存已暫停",
    "en": "Form reset; draft records retained and autosave paused",
    "ja": "フォームをリセットしました。下書き記録を保持し、自動保存を停止しています"
  },
  "recovery.clip.paused": {
    "zh-Hans": "本地草稿自动保存已暂停",
    "zh-Hant": "本機草稿自動儲存已暫停",
    "en": "Local draft autosave paused",
    "ja": "ローカル下書きの自動保存を停止中"
  },
  "recovery.clip.saving": {
    "zh-Hans": "正在保存本地草稿…",
    "zh-Hant": "正在儲存本機草稿…",
    "en": "Saving local draft…",
    "ja": "ローカル下書きを保存中…"
  },
  "recovery.clip.unconfirmed": {
    "zh-Hans": "本地草稿尚未确认保存",
    "zh-Hant": "本機草稿尚未確認儲存",
    "en": "Local draft save not confirmed",
    "ja": "ローカル下書きの保存は未確認です"
  },
  "recovery.clip.dirty": {
    "zh-Hans": "输入尚未确认保存到本地",
    "zh-Hant": "輸入尚未確認儲存至本機",
    "en": "Local saving of input not yet confirmed",
    "ja": "入力のローカル保存は未確認です"
  },
  "recovery.clip.ready": {
    "zh-Hans": "片段属性可自动保存为本地草稿",
    "zh-Hant": "片段屬性可自動儲存為本機草稿",
    "en": "Clip properties can autosave as a local draft",
    "ja": "クリップのプロパティはローカル下書きとして自動保存できます"
  },
  "recovery.clip.label": {
    "zh-Hans": "本地片段草稿",
    "zh-Hant": "本機片段草稿",
    "en": "Local clip draft",
    "ja": "クリップのローカル下書き"
  },
  "recovery.clip.shortDisclosure": {
    "zh-Hans": "仅片段属性，本地明文；最后未确认输入可能丢失。草稿不会自动应用到时间线。",
    "zh-Hant": "僅限片段屬性，以本機明文儲存；最後未確認的輸入可能遺失。草稿不會自動套用至時間軸。",
    "en": "Clip properties only, stored locally as plain text. The last unconfirmed input may be lost. Drafts are not automatically applied to the timeline.",
    "ja": "クリップのプロパティのみをローカルに平文で保存します。最後の未確認入力は失われる可能性があります。下書きはタイムラインに自動適用されません。"
  },
  "recovery.clip.restore": {
    "zh-Hans": "恢复到属性表单",
    "zh-Hant": "還原至屬性表單",
    "en": "Restore to properties form",
    "ja": "プロパティフォームに復元"
  },
  "recovery.clip.discard": {
    "zh-Hans": "放弃已保存草稿",
    "zh-Hant": "放棄已儲存草稿",
    "en": "Discard saved draft",
    "ja": "保存済み下書きを破棄"
  },
  "recovery.clip.newInput": {
    "zh-Hans": "当前有新输入，未替换为旧草稿。放弃旧草稿后可继续保留当前输入。",
    "zh-Hant": "目前有新輸入，尚未替換為舊草稿。放棄舊草稿後仍可保留目前輸入。",
    "en": "New input is present and has not been replaced by the older draft. Discarding the older draft can retain current input.",
    "ja": "新しい入力があるため、古い下書きに置き換えていません。古い下書きを破棄しても現在の入力を保持できます。"
  },
  "recovery.clip.refused": {
    "zh-Hans": "服务明确拒绝了本次请求。",
    "zh-Hant": "服務已明確拒絕本次請求。",
    "en": "The service explicitly refused this request.",
    "ja": "サービスが今回のリクエストを明確に拒否しました。"
  },
  "recovery.clip.conflict": {
    "zh-Hans": "本地记录或服务身份发生冲突。",
    "zh-Hant": "本機記錄或服務身分發生衝突。",
    "en": "Local records or service identity conflict.",
    "ja": "ローカル記録またはサービスの識別情報が競合しています。"
  },
  "recovery.clip.unknown": {
    "zh-Hans": "先前请求的结果可能仍未确认。",
    "zh-Hant": "先前請求的結果可能仍未確認。",
    "en": "The earlier request's outcome may still be unconfirmed.",
    "ja": "以前のリクエストの結果がまだ未確認の可能性があります。"
  },
  "recovery.clip.recheckOnly": {
    "zh-Hans": "重新核对只读取记录，不会重新提交或自动恢复写入。",
    "zh-Hant": "重新核對僅讀取記錄，不會重新提交或自動恢復寫入。",
    "en": "Rechecking only reads records; it does not resubmit or automatically resume writes.",
    "ja": "再確認は記録の読み取りのみです。再送信や書き込みの自動再開は行いません。"
  },
  "recovery.clip.recheck": {
    "zh-Hans": "重新核对本地草稿",
    "zh-Hant": "重新核對本機草稿",
    "en": "Recheck local draft",
    "ja": "ローカル下書きを再確認"
  },
  "recovery.clip.abandon": {
    "zh-Hans": "放弃当前输入，保留草稿记录",
    "zh-Hant": "放棄目前輸入，保留草稿記錄",
    "en": "Discard input, retain draft records",
    "ja": "入力を破棄し、下書き記録を保持"
  },
  "recovery.clip.pending": {
    "zh-Hans": "时间线请求尚待确认；本地草稿不会重新提交。",
    "zh-Hant": "時間軸請求尚待確認；不會重新提交本機草稿。",
    "en": "The timeline request awaits confirmation; the local draft will not be resubmitted.",
    "ja": "タイムラインのリクエストは確認待ちです。ローカル下書きは再送信しません。"
  },
  "recovery.clip.tasks": {
    "zh-Hans": "查看任务",
    "zh-Hant": "查看工作",
    "en": "View tasks",
    "ja": "タスクを表示"
  },
  "recovery.delivery.defaultName": {
    "zh-Hans": "留空，使用默认文件名",
    "zh-Hant": "留空，使用預設檔名",
    "en": "Blank; use default filename",
    "ja": "空欄。既定のファイル名を使用"
  },
  "recovery.delivery.defaultSettings": {
    "zh-Hans": "原有默认编码设置",
    "zh-Hant": "原有預設編碼設定",
    "en": "Original default encoding settings",
    "ja": "元の既定のエンコード設定"
  },
  "recovery.delivery.native": {
    "zh-Hans": "原时间线尺寸",
    "zh-Hant": "原時間軸尺寸",
    "en": "Original timeline size",
    "ja": "元のタイムラインサイズ"
  },
  "recovery.delivery.short360": {
    "zh-Hans": "短边 360 像素",
    "zh-Hant": "短邊 360 像素",
    "en": "360-pixel short edge",
    "ja": "短辺 360 ピクセル"
  },
  "recovery.delivery.short1080": {
    "zh-Hans": "短边 1080 像素",
    "zh-Hant": "短邊 1080 像素",
    "en": "1080-pixel short edge",
    "ja": "短辺 1080 ピクセル"
  },
  "recovery.delivery.unsupported": {
    "zh-Hans": "恢复分支暂不支持本地交付草稿",
    "zh-Hant": "還原分支暫不支援本機交付草稿",
    "en": "Local delivery drafts are not supported in restored branches yet",
    "ja": "復元ブランチでは現在、ローカルの出力下書きを利用できません"
  },
  "recovery.delivery.loading": {
    "zh-Hans": "正在核对本地交付草稿…",
    "zh-Hant": "正在核對本機交付草稿…",
    "en": "Checking local delivery draft…",
    "ja": "出力のローカル下書きを確認中…"
  },
  "recovery.delivery.paused": {
    "zh-Hans": "本地名称自动保存已暂停",
    "zh-Hant": "本機名稱自動儲存已暫停",
    "en": "Local name autosave paused",
    "ja": "名前のローカル自動保存を停止中"
  },
  "recovery.delivery.saving": {
    "zh-Hans": "正在保存本地名称…",
    "zh-Hant": "正在儲存本機名稱…",
    "en": "Saving name locally…",
    "ja": "名前をローカルに保存中…"
  },
  "recovery.delivery.candidate": {
    "zh-Hans": "发现可恢复的成片名称",
    "zh-Hant": "找到可還原的成片名稱",
    "en": "Recoverable export name found",
    "ja": "復元できる書き出し名があります"
  },
  "recovery.delivery.unconfirmed": {
    "zh-Hans": "本地名称未确认保存",
    "zh-Hant": "本機名稱尚未確認儲存",
    "en": "Local name save not confirmed",
    "ja": "名前のローカル保存は未確認です"
  },
  "recovery.delivery.dirty": {
    "zh-Hans": "名称尚未确认保存到本地",
    "zh-Hant": "名稱尚未確認儲存至本機",
    "en": "Local saving of name not yet confirmed",
    "ja": "名前のローカル保存はまだ未確認です"
  },
  "recovery.delivery.ready": {
    "zh-Hans": "本次名称可保存为本地草稿",
    "zh-Hant": "本次名稱可儲存為本機草稿",
    "en": "This name can be saved as a local draft",
    "ja": "今回の名前をローカル下書きとして保存できます"
  },
  "recovery.delivery.preparing": {
    "zh-Hans": "正在保存原导出请求，尚未确认可以提交",
    "zh-Hant": "正在儲存原匯出請求，尚未確認可提交",
    "en": "Saving the original export request; submission is not yet confirmed as safe",
    "ja": "元の書き出しリクエストを保存中。送信可能かどうかは未確認です"
  },
  "recovery.delivery.executing": {
    "zh-Hans": "正在核对并执行原导出请求…",
    "zh-Hant": "正在核對並執行原匯出請求…",
    "en": "Checking and executing the original export request…",
    "ja": "元の書き出しリクエストを確認して実行中…"
  },
  "recovery.delivery.uncertain": {
    "zh-Hans": "原导出请求的保存结果待确认，新导出已暂停",
    "zh-Hant": "原匯出請求的儲存結果待確認，新的匯出已暫停",
    "en": "Original request save awaits confirmation; new exports are paused",
    "ja": "元の書き出しリクエストの保存は確認待ちです。新規書き出しを停止しています"
  },
  "recovery.delivery.pending": {
    "zh-Hans": "已保存原导出请求，结果待确认",
    "zh-Hant": "已儲存原匯出請求，結果待確認",
    "en": "Original export request saved; outcome awaits confirmation",
    "ja": "元の書き出しリクエストを保存済み。結果は確認待ちです"
  },
  "recovery.delivery.accepted": {
    "zh-Hans": "原导出请求已确认接受",
    "zh-Hant": "原匯出請求已確認接受",
    "en": "Original export request confirmed accepted",
    "ja": "元の書き出しリクエストの受理を確認しました"
  },
  "recovery.delivery.notApplied": {
    "zh-Hans": "原导出请求已确认未应用",
    "zh-Hant": "原匯出請求已確認未套用",
    "en": "Original export request confirmed not applied",
    "ja": "元の書き出しリクエストが未適用と確認されました"
  },
  "recovery.delivery.label": {
    "zh-Hans": "本地交付草稿与原导出请求",
    "zh-Hant": "本機交付草稿與原匯出請求",
    "en": "Local delivery draft and original export request",
    "ja": "出力のローカル下書きと元の書き出しリクエスト"
  },
  "recovery.delivery.unsupportedHelp": {
    "zh-Hans": "此恢复分支不读写交付草稿或原请求记录。现有的明确确认本机导出流程仍可使用。",
    "zh-Hant": "此還原分支不會讀寫交付草稿或原請求記錄。既有的明確確認本機匯出流程仍可使用。",
    "en": "This restored branch does not read or write delivery drafts or original request records. The existing explicitly confirmed local export flow remains available.",
    "ja": "この復元ブランチでは出力下書きや元のリクエスト記録を読み書きしません。明示的に確認する既存のローカル書き出し手順は引き続き利用できます。"
  },
  "recovery.delivery.savedName": {
    "zh-Hans": "已保存名称：",
    "zh-Hant": "已儲存名稱：",
    "en": "Saved name: ",
    "ja": "保存済みの名前："
  },
  "recovery.delivery.provenance": {
    "zh-Hans": "查看草稿来源",
    "zh-Hant": "查看草稿來源",
    "en": "View draft provenance",
    "ja": "下書きの元情報を表示"
  },
  "recovery.delivery.restore": {
    "zh-Hans": "恢复名称，替换当前输入",
    "zh-Hant": "還原名稱，替換目前輸入",
    "en": "Restore name, replacing current input",
    "ja": "名前を復元し、現在の入力を置換"
  },
  "recovery.delivery.keep": {
    "zh-Hans": "保留当前名称，替换已保存草稿",
    "zh-Hant": "保留目前名稱，替換已儲存草稿",
    "en": "Keep current name, replacing saved draft",
    "ja": "現在の名前を保持し、保存済み下書きを置換"
  },
  "recovery.delivery.discard": {
    "zh-Hans": "放弃已保存名称",
    "zh-Hant": "放棄已儲存名稱",
    "en": "Discard saved name",
    "ja": "保存済みの名前を破棄"
  },
  "recovery.delivery.choicesHelp": {
    "zh-Hans": "以上选择只处理名称草稿，不会删除或取消原导出请求。",
    "zh-Hant": "以上選擇僅處理名稱草稿，不會刪除或取消原匯出請求。",
    "en": "These choices affect only the name draft, not deletion or cancellation of the original export request.",
    "ja": "これらの選択は名前の下書きのみを処理し、元の書き出しリクエストは削除もキャンセルもしません。"
  },
  "recovery.delivery.rebase": {
    "zh-Hans": "明确改用于当前时间线，再检查",
    "zh-Hant": "明確改用目前時間軸，再檢查",
    "en": "Use with current timeline, then check",
    "ja": "現在のタイムラインに明示的に切り替えて確認"
  },
  "recovery.delivery.retryLimit": {
    "zh-Hans": "当前会话的待确认名称已达上限，尚未发送本次保存请求。",
    "zh-Hant": "目前工作階段的待確認名稱已達上限，尚未傳送本次儲存請求。",
    "en": "Unconfirmed names have reached this session's limit. This save request has not been sent.",
    "ja": "このセッションの確認待ちの名前が上限に達しました。今回の保存リクエストは送信していません。"
  },
  "recovery.delivery.capacity": {
    "zh-Hans": "交付记录已达本工作区 128 个项目槽位上限；已有记录不会自动删除。",
    "zh-Hant": "交付記錄已達本工作區 128 個專案槽位上限；既有記錄不會自動刪除。",
    "en": "Delivery records have reached this workspace's limit of 128 project slots. Existing records are not automatically deleted.",
    "ja": "出力記録がこのワークスペースの 128 プロジェクト枠の上限に達しました。既存の記録は自動削除されません。"
  },
  "recovery.delivery.refused": {
    "zh-Hans": "服务明确拒绝了本次名称保存。",
    "zh-Hant": "服務已明確拒絕本次名稱儲存。",
    "en": "The service explicitly refused this name save.",
    "ja": "サービスが今回の名前の保存を明確に拒否しました。"
  },
  "recovery.delivery.conflict": {
    "zh-Hans": "本地草稿版本或服务身份发生冲突。",
    "zh-Hant": "本機草稿版本或服務身分發生衝突。",
    "en": "The local draft revision or service identity conflicts.",
    "ja": "ローカル下書きのバージョンまたはサービスの識別情報が競合しています。"
  },
  "recovery.delivery.saveUnknown": {
    "zh-Hans": "本次保存结果未知；较晚完成的写入仍可能存在。",
    "zh-Hant": "本次儲存結果未知；稍後完成的寫入仍可能存在。",
    "en": "This save's outcome is unknown; a write may still finish later.",
    "ja": "今回の保存結果は不明です。書き込みが後で完了する可能性があります。"
  },
  "recovery.delivery.preparationPending": {
    "zh-Hans": "原请求保存尚待确认，后续名称暂不写入本地。请先明确恢复同一原请求；当前新输入仍保留。",
    "zh-Hant": "原請求儲存尚待確認，後續名稱暫不寫入本機。請先明確還原同一原請求；目前的新輸入仍會保留。",
    "en": "The original request save awaits confirmation, so subsequent names are not being written locally. Explicitly recover the same original request first; current new input is retained.",
    "ja": "元のリクエストの保存が確認待ちのため、その後の名前はローカルに書き込みません。まず同一の元リクエストを明示的に復元してください。現在の新しい入力は保持します。"
  },
  "recovery.delivery.retrySame": {
    "zh-Hans": "重试保存同一名称",
    "zh-Hant": "重試儲存同一名稱",
    "en": "Retry saving the same name",
    "ja": "同じ名前の保存を再試行"
  },
  "recovery.delivery.saveCurrent": {
    "zh-Hans": "明确保存当前名称",
    "zh-Hant": "明確儲存目前名稱",
    "en": "Explicitly save current name",
    "ja": "現在の名前を明示的に保存"
  },
  "recovery.delivery.deletionUncertain": {
    "zh-Hans": "原删除操作尚不能安全重试。请重新核对本地记录；当前输入仍保留，不会自动重建或覆盖草稿。",
    "zh-Hant": "原刪除操作尚無法安全重試。請重新核對本機記錄；目前輸入仍保留，不會自動重建或覆寫草稿。",
    "en": "The original deletion cannot yet be safely retried. Recheck local records. Current input is retained; drafts will not be automatically recreated or overwritten.",
    "ja": "元の削除操作はまだ安全に再試行できません。ローカル記録を再確認してください。現在の入力を保持し、下書きの自動再作成や上書きは行いません。"
  },
  "recovery.delivery.leave": {
    "zh-Hans": "允许离开，不保存当前名称",
    "zh-Hant": "允許離開，不儲存目前名稱",
    "en": "Allow leaving without saving current name",
    "ja": "現在の名前を保存せずに移動を許可"
  },
  "recovery.delivery.originalName": {
    "zh-Hans": "原请求名称：",
    "zh-Hant": "原請求名稱：",
    "en": "Original request name: ",
    "ja": "元のリクエストの名前："
  },
  "recovery.delivery.originalRange": {
    "zh-Hans": "原请求范围",
    "zh-Hant": "原請求範圍",
    "en": "Original request range",
    "ja": "元のリクエストの範囲"
  },
  "recovery.delivery.originalDetails": {
    "zh-Hans": "查看原请求与完整参数",
    "zh-Hant": "查看原請求與完整參數",
    "en": "View original request and complete parameters",
    "ja": "元のリクエストと全パラメーターを表示"
  },
  "recovery.delivery.recoverHelp": {
    "zh-Hans": "恢复只使用上方原编号、名称、范围与已保存参数，可能首次执行之前尚未提交的导出。不会改用当前名称或输出规格，也不会改用当前范围。",
    "zh-Hant": "還原僅使用上方原編號、名稱、範圍與已儲存參數，可能首次執行先前尚未提交的匯出。不會改用目前名稱、輸出規格或範圍。",
    "en": "Recovery uses only the original ID, name, range and saved parameters above. It may execute a previously unsubmitted export for the first time. It does not use the current name, output specifications or range.",
    "ja": "復元には上記の元の ID、名前、範囲、保存済みパラメーターのみを使用します。未送信だった書き出しを初めて実行する場合があります。現在の名前、出力仕様、範囲には切り替えません。"
  },
  "recovery.delivery.acceptedHelp": {
    "zh-Hans": "原请求回执已确认接受。是否完成渲染，请查看导出记录。",
    "zh-Hant": "原請求回執已確認接受。是否完成算繪，請查看匯出記錄。",
    "en": "The original request receipt confirms acceptance. Check export history to see whether rendering is complete.",
    "ja": "元のリクエストの受理を受領記録で確認しました。レンダリングが完了したかは書き出し履歴で確認してください。"
  },
  "recovery.delivery.notAppliedHelp": {
    "zh-Hans": "原请求已确认未应用，不会再次重试同一请求。请核对当前名称后重新检查。",
    "zh-Hant": "原請求已確認未套用，不會再次重試同一請求。請核對目前名稱後重新檢查。",
    "en": "The original request is confirmed not applied and will not be retried again. Review the current name, then check again.",
    "ja": "元のリクエストは未適用と確認されたため、同じリクエストを再試行しません。現在の名前を確認してから、再度検査してください。"
  },
  "recovery.delivery.recover": {
    "zh-Hans": "确认恢复同一原请求",
    "zh-Hant": "確認還原同一原請求",
    "en": "Confirm recovery of the same original request",
    "ja": "同一の元リクエストの復元を確認"
  },
  "recovery.delivery.noAcknowledgement": {
    "zh-Hans": "尚未收到原请求的持久保存确认；即使读取结果为空，也不能认定先前保存未发生。明确恢复会用同一编号和原参数再次确认保存，再尝试原导出。",
    "zh-Hant": "尚未收到原請求的持久儲存確認；即使讀取結果為空，也不能認定先前未曾儲存。明確還原會使用同一編號與原參數再次確認儲存，再嘗試原匯出。",
    "en": "Persistent saving of the original request has not been acknowledged. An empty read does not prove the earlier save did not occur. Explicit recovery confirms saving again with the same ID and original parameters, then attempts the original export.",
    "ja": "元のリクエストの永続保存の応答をまだ受け取っていません。読み取り結果が空でも、以前の保存が行われなかったとは判断できません。明示的に復元すると、同じ ID と元のパラメーターで保存を再確認してから、元の書き出しを試みます。"
  },
  "recovery.delivery.intentRefused": {
    "zh-Hans": "服务明确拒绝了本次原请求保存，尚未开始导出。",
    "zh-Hant": "服務已明確拒絕本次原請求儲存，尚未開始匯出。",
    "en": "The service explicitly refused saving this original request; export has not started.",
    "ja": "サービスが今回の元リクエストの保存を明確に拒否しました。書き出しは開始していません。"
  },
  "recovery.delivery.intentConflict": {
    "zh-Hans": "原请求记录或服务身份冲突；已阻止新导出。",
    "zh-Hant": "原請求記錄或服務身分衝突；已阻止新的匯出。",
    "en": "Original request records or service identity conflict; new exports are blocked.",
    "ja": "元のリクエスト記録またはサービスの識別情報が競合しているため、新規書き出しを止めています。"
  },
  "recovery.delivery.intentUnknown": {
    "zh-Hans": "原请求结果仍待核对，不能当作失败后重新创建。",
    "zh-Hant": "原請求結果仍待核對，不可視為失敗後重新建立。",
    "en": "The original request outcome still needs checking. Do not treat it as failed and create a replacement.",
    "ja": "元のリクエストの結果はまだ確認が必要です。失敗と判断して新しいリクエストを作り直すことはできません。"
  },
  "recovery.text.unsupported": {
    "zh-Hans": "恢复分支暂不支持本地文字草稿",
    "zh-Hant": "還原分支暫不支援本機文字草稿",
    "en": "Local text drafts are not supported in restored branches yet",
    "ja": "復元ブランチでは現在、ローカルのテキスト下書きを利用できません"
  },
  "recovery.text.loading": {
    "zh-Hans": "正在核对本地文字草稿…",
    "zh-Hant": "正在核對本機文字草稿…",
    "en": "Checking local text draft…",
    "ja": "テキストのローカル下書きを確認中…"
  },
  "recovery.text.paused": {
    "zh-Hans": "本地文字自动保存已暂停",
    "zh-Hant": "本機文字自動儲存已暫停",
    "en": "Local text autosave paused",
    "ja": "テキストのローカル自動保存を停止中"
  },
  "recovery.text.saving": {
    "zh-Hans": "正在保存本地文字…",
    "zh-Hant": "正在儲存本機文字…",
    "en": "Saving text locally…",
    "ja": "テキストをローカルに保存中…"
  },
  "recovery.text.candidate": {
    "zh-Hans": "发现可恢复的标题和提示词",
    "zh-Hant": "找到可還原的標題與提示詞",
    "en": "Recoverable title and prompt found",
    "ja": "復元できるタイトルとプロンプトがあります"
  },
  "recovery.text.dirty": {
    "zh-Hans": "文字尚未确认保存到本地",
    "zh-Hant": "文字尚未確認儲存至本機",
    "en": "Local text save not yet confirmed",
    "ja": "テキストのローカル保存は未確認です"
  },
  "recovery.text.synced": {
    "zh-Hans": "标题和提示词已同步",
    "zh-Hant": "標題與提示詞已同步",
    "en": "Title and prompt synced",
    "ja": "タイトルとプロンプトは同期済みです"
  },
  "recovery.text.label": {
    "zh-Hans": "本地标题和提示词草稿",
    "zh-Hant": "本機標題與提示詞草稿",
    "en": "Local title and prompt draft",
    "ja": "タイトルとプロンプトのローカル下書き"
  },
  "recovery.text.save": {
    "zh-Hans": "保存标题和提示词",
    "zh-Hant": "儲存標題與提示詞",
    "en": "Save title and prompt",
    "ja": "タイトルとプロンプトを保存"
  },
  "recovery.text.validationHelp": {
    "zh-Hans": "镜头保存需要 1–150 字符的有效标题，提示词最多 5000 字符。原始输入仍可保存在本地草稿。",
    "zh-Hant": "儲存鏡頭需要 1–150 字元的有效標題，提示詞最多 5000 字元。原始輸入仍可儲存為本機草稿。",
    "en": "Saving a shot requires a valid 1–150-character title and a prompt of at most 5000 characters. Raw input can still be saved in a local draft.",
    "ja": "ショットを保存するには 1～150 文字の有効なタイトルが必要で、プロンプトは最大 5000 文字です。元の入力は引き続きローカル下書きに保存できます。"
  },
  "recovery.text.unsupportedHelp": {
    "zh-Hans": "此恢复分支不读写本地文字记录，现有镜头编辑与保存仍可使用。",
    "zh-Hant": "此還原分支不會讀寫本機文字記錄，既有鏡頭編輯與儲存仍可使用。",
    "en": "This restored branch does not read or write local text records. Existing shot editing and saving remain available.",
    "ja": "この復元ブランチはローカルのテキスト記録を読み書きしません。既存のショット編集と保存は引き続き利用できます。"
  },
  "recovery.text.savedTitle": {
    "zh-Hans": "已保存标题：",
    "zh-Hant": "已儲存標題：",
    "en": "Saved title: ",
    "ja": "保存済みタイトル："
  },
  "recovery.text.originalTitle": {
    "zh-Hans": "原标题：",
    "zh-Hant": "原標題：",
    "en": "Original title: ",
    "ja": "元のタイトル："
  },
  "recovery.text.originalPrompt": {
    "zh-Hans": "原提示词：",
    "zh-Hant": "原提示詞：",
    "en": "Original prompt: ",
    "ja": "元のプロンプト："
  },
  "recovery.text.restore": {
    "zh-Hans": "恢复文字，替换当前标题和提示词",
    "zh-Hant": "還原文字，替換目前標題與提示詞",
    "en": "Restore text, replacing current title and prompt",
    "ja": "テキストを復元し、現在のタイトルとプロンプトを置換"
  },
  "recovery.text.keep": {
    "zh-Hans": "保留当前文字，替换已保存草稿",
    "zh-Hant": "保留目前文字，替換已儲存草稿",
    "en": "Keep current text, replacing saved draft",
    "ja": "現在のテキストを保持し、保存済み下書きを置換"
  },
  "recovery.text.discard": {
    "zh-Hans": "放弃已保存文字草稿",
    "zh-Hant": "放棄已儲存文字草稿",
    "en": "Discard saved text draft",
    "ja": "保存済みテキスト下書きを破棄"
  },
  "recovery.text.rebase": {
    "zh-Hans": "保留输入，明确以当前文字版本保存草稿",
    "zh-Hant": "保留輸入，明確以目前文字版本儲存草稿",
    "en": "Keep input and explicitly save against current text revision",
    "ja": "入力を保持し、現在のテキストバージョンに基づいて明示的に下書きを保存"
  },
  "recovery.text.retryLimit": {
    "zh-Hans": "当前会话待确认草稿已达上限，尚未发送本次保存请求。",
    "zh-Hant": "目前工作階段的待確認草稿已達上限，尚未傳送本次儲存請求。",
    "en": "Unconfirmed drafts have reached this session's limit. This save request has not been sent.",
    "ja": "このセッションの確認待ち下書きが上限に達しました。今回の保存リクエストは送信していません。"
  },
  "recovery.text.refused": {
    "zh-Hans": "服务明确拒绝了本次草稿保存。",
    "zh-Hant": "服務已明確拒絕本次草稿儲存。",
    "en": "The service explicitly refused this draft save.",
    "ja": "サービスが今回の下書き保存を明確に拒否しました。"
  },
  "recovery.text.conflict": {
    "zh-Hans": "草稿版本或服务身份发生冲突。",
    "zh-Hant": "草稿版本或服務身分發生衝突。",
    "en": "The draft revision or service identity conflicts.",
    "ja": "下書きのバージョンまたはサービスの識別情報が競合しています。"
  },
  "recovery.text.unknown": {
    "zh-Hans": "本次草稿保存结果未知；较晚完成的写入仍可能存在。",
    "zh-Hant": "本次草稿儲存結果未知；稍後完成的寫入仍可能存在。",
    "en": "This draft save's outcome is unknown; a write may still finish later.",
    "ja": "今回の下書き保存の結果は不明です。書き込みが後で完了する可能性があります。"
  },
  "recovery.text.preparationPending": {
    "zh-Hans": "原请求保存尚待确认，后续文字暂不写入本地。即使读取结果为空，也不能认定先前保存未发生。",
    "zh-Hant": "原請求儲存尚待確認，後續文字暫不寫入本機。即使讀取結果為空，也不能認定先前未曾儲存。",
    "en": "The original request save awaits confirmation, so subsequent text is not written locally. An empty read does not prove the earlier save did not occur.",
    "ja": "元のリクエストの保存が確認待ちのため、その後のテキストはローカルに書き込みません。読み取り結果が空でも、以前の保存が行われなかったとは判断できません。"
  },
  "recovery.text.retryDetails": {
    "zh-Hans": "查看待确认保存的原文字",
    "zh-Hant": "查看待確認儲存的原文字",
    "en": "View original text awaiting save confirmation",
    "ja": "保存の確認待ちの元テキストを表示"
  },
  "recovery.text.retrySame": {
    "zh-Hans": "重试保存同一文字草稿",
    "zh-Hant": "重試儲存同一文字草稿",
    "en": "Retry saving the same text draft",
    "ja": "同じテキスト下書きの保存を再試行"
  },
  "recovery.text.saveCurrent": {
    "zh-Hans": "明确保存当前文字草稿",
    "zh-Hant": "明確儲存目前文字草稿",
    "en": "Explicitly save current text draft",
    "ja": "現在のテキスト下書きを明示的に保存"
  },
  "recovery.text.deletionUncertain": {
    "zh-Hans": "原草稿删除结果尚未确认，不能安全重建或覆盖。请重新核对本地记录。",
    "zh-Hant": "原草稿刪除結果尚未確認，無法安全重建或覆寫。請重新核對本機記錄。",
    "en": "The original draft deletion is unconfirmed, so it cannot be safely recreated or overwritten. Recheck local records.",
    "ja": "元の下書きの削除結果が未確認のため、安全に再作成や上書きはできません。ローカル記録を再確認してください。"
  },
  "recovery.text.retryDeletion": {
    "zh-Hans": "重试同一草稿删除",
    "zh-Hant": "重試同一草稿刪除",
    "en": "Retry the same draft deletion",
    "ja": "同じ下書きの削除を再試行"
  },
  "recovery.text.acceptState": {
    "zh-Hans": "核对并接受当前草稿状态",
    "zh-Hant": "核對並接受目前草稿狀態",
    "en": "Check and accept current draft state",
    "ja": "現在の下書き状態を確認して受け入れる"
  },
  "recovery.text.leave": {
    "zh-Hans": "允许离开，不保存当前本地草稿",
    "zh-Hant": "允許離開，不儲存目前本機草稿",
    "en": "Allow leaving without saving current local draft",
    "ja": "現在のローカル下書きを保存せずに移動を許可"
  },
  "recovery.text.otherPending": {
    "zh-Hans": "本项目另一个镜头的文字保存结果待确认，请先处理原请求。",
    "zh-Hant": "本專案另一個鏡頭的文字儲存結果待確認，請先處理原請求。",
    "en": "Text saving for another shot in this project awaits confirmation. Resolve the original request first.",
    "ja": "このプロジェクトの別のショットのテキスト保存が確認待ちです。先に元のリクエストを処理してください。"
  },
  "recovery.text.inspect": {
    "zh-Hans": "查看原镜头",
    "zh-Hant": "查看原鏡頭",
    "en": "View original shot",
    "ja": "元のショットを表示"
  },
  "recovery.text.preparing": {
    "zh-Hans": "正在持久保存原文字请求…",
    "zh-Hant": "正在持久儲存原文字請求…",
    "en": "Persisting the original text request…",
    "ja": "元のテキストリクエストを永続保存中…"
  },
  "recovery.text.executing": {
    "zh-Hans": "正在核对并执行原文字请求…",
    "zh-Hant": "正在核對並執行原文字請求…",
    "en": "Checking and executing the original text request…",
    "ja": "元のテキストリクエストを確認して実行中…"
  },
  "recovery.text.intentUnknown": {
    "zh-Hans": "原文字请求保存结果未知，新保存已暂停",
    "zh-Hant": "原文字請求儲存結果未知，新的儲存已暫停",
    "en": "Original text request save outcome unknown; new saves paused",
    "ja": "元のテキストリクエストの保存結果は不明です。新規保存を停止しています"
  },
  "recovery.text.applied": {
    "zh-Hans": "原文字请求已确认应用",
    "zh-Hant": "原文字請求已確認套用",
    "en": "Original text request confirmed applied",
    "ja": "元のテキストリクエストの適用を確認しました"
  },
  "recovery.text.notApplied": {
    "zh-Hans": "原文字请求已确认未应用",
    "zh-Hant": "原文字請求已確認未套用",
    "en": "Original text request confirmed not applied",
    "ja": "元のテキストリクエストが未適用と確認されました"
  },
  "recovery.text.pending": {
    "zh-Hans": "原文字请求结果待确认",
    "zh-Hant": "原文字請求結果待確認",
    "en": "Original text request outcome awaits confirmation",
    "ja": "元のテキストリクエストの結果は確認待ちです"
  },
  "recovery.text.recoverHelp": {
    "zh-Hans": "恢复只使用原编号与原文字，可能首次执行尚未提交的文字保存；不会改用当前输入，也不会生成镜头。",
    "zh-Hant": "還原僅使用原編號與原文字，可能首次執行尚未提交的文字儲存；不會改用目前輸入，也不會生成鏡頭。",
    "en": "Recovery uses only the original ID and text and may execute a previously unsubmitted save for the first time. It does not use current input or generate a shot.",
    "ja": "復元には元の ID とテキストのみを使用し、未送信の保存を初めて実行する場合があります。現在の入力に切り替えたり、ショットを生成したりはしません。"
  },
  "recovery.text.recover": {
    "zh-Hans": "确认恢复同一原文字请求",
    "zh-Hant": "確認還原同一原文字請求",
    "en": "Confirm recovery of the same original text request",
    "ja": "同一の元テキストリクエストの復元を確認"
  },
  "recovery.text.notAppliedHelp": {
    "zh-Hans": "不会再次重试同一请求。当前输入仍保留，请核对后重新保存。",
    "zh-Hant": "不會再次重試同一請求。目前輸入仍保留，請核對後重新儲存。",
    "en": "The same request will not be retried again. Current input is retained; review it before saving again.",
    "ja": "同じリクエストを再試行しません。現在の入力は保持します。内容を確認してから保存し直してください。"
  },
  "recovery.text.appliedHelp": {
    "zh-Hans": "已刷新保存结果。恢复旧请求不会覆盖当前表单或继续生成。",
    "zh-Hant": "已重新整理儲存結果。還原舊請求不會覆寫目前表單或繼續生成。",
    "en": "The saved result has been refreshed. Recovering an old request does not overwrite the current form or continue generation.",
    "ja": "保存結果を更新しました。古いリクエストを復元しても、現在のフォームの上書きや生成の続行は行いません。"
  },
  "recovery.storage.title": {
    "zh-Hans": "保存范围与容量说明",
    "zh-Hant": "儲存範圍與容量說明",
    "en": "Storage scope and limits",
    "ja": "保存範囲と容量制限"
  },
  "recovery.storage.otherRules": {
    "zh-Hans": "除下述专用入口外，既有画板/素材编辑及普通时间线渲染/预览的待确认参数仍依赖当前浏览器会话。完整镜头表单中的非文字或混合修改，以及生成提交仍沿用各自原有恢复规则。",
    "zh-Hant": "除下列專用入口外，既有畫板／素材編輯與一般時間軸算繪／預覽的待確認參數仍依賴目前瀏覽器工作階段。完整鏡頭表單中的非文字或混合修改，以及生成提交仍沿用各自原有還原規則。",
    "en": "Except for the dedicated flows below, pending parameters for existing canvas/asset edits and ordinary timeline renders/previews still depend on the current browser session. Non-text or mixed changes in the full shot form and generation submissions retain their existing recovery rules.",
    "ja": "以下の専用操作を除き、既存のキャンバス／素材編集と通常のタイムラインのレンダリング／プレビューの確認待ちパラメーターは、現在のブラウザーセッションに依存します。ショットの全項目フォームでの非テキスト変更や混合変更、生成リクエストには、それぞれ既存の復元ルールが適用されます。"
  },
  "recovery.storage.exceptions": {
    "zh-Hans": "普通工作区中的例外是交付面板的成片导出（purpose=export）和镜头标题/提示词专用保存：它们另有持久原请求，需回到原交付面板或镜头面板明确恢复。任务中心不会汇总这些旁文件中的全部原请求。读取记录、打开面板或重新连接不会自动执行业务或调用模型；原请求恢复只使用保存的原编号与精确参数。",
    "zh-Hant": "一般工作區的例外為交付面板的成片匯出（purpose=export）及鏡頭標題／提示詞專用儲存：這些操作另有持久原請求，須回到原交付面板或鏡頭面板明確還原。工作中心不會彙整這些附加檔案中的全部原請求。讀取記錄、開啟面板或重新連線不會自動執行操作或呼叫模型；原請求還原僅使用已儲存的原編號與精確參數。",
    "en": "In ordinary workspaces, delivery-panel exports (purpose=export) and dedicated shot title/prompt saves have separate persistent original requests. Explicitly recover them in their original delivery or shot panel. Task Center does not aggregate all original requests in these sidecar files. Reading records, opening panels or reconnecting does not automatically execute operations or call models; recovery uses only the saved original ID and exact parameters.",
    "ja": "通常のワークスペースでは、出力パネルの書き出し（purpose=export）とショットのタイトル／プロンプト専用保存が例外です。それぞれ別途永続保存した元リクエストを、元の出力パネルまたはショットパネルで明示的に復元してください。タスクセンターはこれらの補助ファイル内の全リクエストを集約しません。記録の読み取り、パネルの表示、再接続だけでは操作の自動実行やモデルの呼び出しは行いません。復元には保存済みの元 ID と正確なパラメーターのみを使います。"
  },
  "recovery.storage.clipSlots": {
    "zh-Hans": "片段属性草稿：累计最多 128 个项目/时间线/片段目标槽位。",
    "zh-Hant": "片段屬性草稿：累計最多 128 個專案／時間軸／片段目標槽位。",
    "en": "Clip property drafts: up to 128 project/timeline/clip target slots in total.",
    "ja": "クリップのプロパティ下書き：プロジェクト／タイムライン／クリップ単位で累計最大 128 枠。"
  },
  "recovery.storage.deliverySlots": {
    "zh-Hans": "成片名称草稿与原导出请求：最多 128 个项目槽位。",
    "zh-Hant": "成片名稱草稿與原匯出請求：最多 128 個專案槽位。",
    "en": "Export name drafts and original export requests: up to 128 project slots.",
    "ja": "書き出し名の下書きと元の書き出しリクエスト：最大 128 プロジェクト枠。"
  },
  "recovery.storage.textSlots": {
    "zh-Hans": "标题/提示词草稿与原文字请求：最多 128 个项目/镜头槽位。",
    "zh-Hant": "標題／提示詞草稿與原文字請求：最多 128 個專案／鏡頭槽位。",
    "en": "Title/prompt drafts and original text requests: up to 128 project/shot slots.",
    "ja": "タイトル／プロンプトの下書きと元テキストリクエスト：最大 128 プロジェクト／ショット枠。"
  },
  "recovery.storage.recentSlot": {
    "zh-Hans": "最近项目定位：仅保留 1 条位置记录，成功记住新项目会覆盖上一条。",
    "zh-Hant": "最近專案定位：僅保留 1 筆位置記錄，成功記住新專案會覆寫上一筆。",
    "en": "Recent project location: only 1 record is retained; successfully remembering a new project replaces the previous one.",
    "ja": "最近のプロジェクト位置：1 件のみ保持します。新しいプロジェクトの記録に成功すると、以前の記録を上書きします。"
  },
  "recovery.storage.slotRetention": {
    "zh-Hans": "前三类清除草稿后仍保留版本记录并占用槽位，尚未提供槽位清理；容量限制不表示磁盘已满。以上四类旁文件均不包含在工作区离线备份中。恢复分支不启用这些旁文件，原有允许的手动编辑、保存和本机导出仍可使用。",
    "zh-Hant": "前三類清除草稿後仍保留版本記錄並占用槽位，尚未提供槽位清理；容量限制不表示磁碟已滿。上述四類附加檔案皆不包含在工作區離線備份中。還原分支不啟用這些附加檔案，原有允許的手動編輯、儲存與本機匯出仍可使用。",
    "en": "The first three types retain revision records and occupy slots after drafts are cleared; slot cleanup is not yet available. The capacity limit does not mean the disk is full. All four sidecar types are excluded from offline workspace backups. Restored branches do not enable these sidecars; previously allowed manual editing, saving and local export remain available.",
    "ja": "最初の 3 種類は下書きを消去してもバージョン記録が残り、枠を使用します。枠の整理機能はまだありません。容量制限はディスクが満杯という意味ではありません。4 種類すべての補助ファイルはワークスペースのオフラインバックアップに含まれません。復元ブランチではこれらを有効にしませんが、従来許可されている手動編集、保存、ローカル書き出しは利用できます。"
  },
  "recovery.storage.privacy": {
    "zh-Hans": "本地恢复记录是本机私有目录中的明文用户数据，未经保险库加密，不保存账号或认证配置；名称、提示词等自由文本仍可能包含隐私。放弃草稿或重置当前输入不会取消原请求，也不保证清除原请求已捕获的文本。最后未收到确认的输入可能丢失。",
    "zh-Hant": "本機還原記錄是本機私有目錄中的明文使用者資料，未經保險庫加密，不儲存帳號或驗證設定；名稱、提示詞等自由文字仍可能包含隱私。放棄草稿或重設目前輸入不會取消原請求，也不保證清除原請求已擷取的文字。最後未收到確認的輸入可能遺失。",
    "en": "Local recovery records are plain-text user data in a private local directory, not vault-encrypted, and do not store account or authentication settings. Free text such as names and prompts may still contain private information. Discarding drafts or resetting current input does not cancel original requests or guarantee removal of text already captured by them. The last unacknowledged input may be lost.",
    "ja": "ローカル復元記録は端末の非公開ディレクトリにある平文のユーザーデータで、保管庫による暗号化はされず、アカウントや認証設定は保存しません。名前やプロンプトなどの自由入力には個人情報が含まれる場合があります。下書きの破棄や現在の入力のリセットは元のリクエストをキャンセルせず、すでに取り込まれたテキストの消去も保証しません。最後に応答を受けていない入力は失われる可能性があります。"
  },
  "recovery.storage.clipContent": {
    "zh-Hans": "保存片段属性的原始输入、原时间线版本和素材来源，包括名称、轨道、时间、矩形、音量与淡入淡出。读取或恢复到属性表单不会保存到时间线，也不会调用模型；原业务请求仍由任务中心单独核对。",
    "zh-Hant": "儲存片段屬性的原始輸入、原時間軸版本與素材來源，包括名稱、軌道、時間、矩形、音量與淡入淡出。讀取或還原至屬性表單不會儲存至時間軸，也不會呼叫模型；原操作請求仍由工作中心另外核對。",
    "en": "Saves raw clip-property input, the original timeline revision and asset source, including name, track, timing, rectangle, volume and fades. Reading or restoring the properties form does not save to the timeline or call a model; original operation requests are checked separately in Task Center.",
    "ja": "名前、トラック、時間、矩形、音量、フェードを含むクリップ属性の元入力、元のタイムラインバージョン、素材ソースを保存します。読み取りやプロパティフォームへの復元ではタイムラインに保存せず、モデルも呼び出しません。元の操作リクエストはタスクセンターで個別に確認します。"
  },
  "recovery.storage.clipPrivacy": {
    "zh-Hans": "草稿在本机私有目录中以明文保存，不保存账号或认证配置；片段名称等自由文本仍可能包含隐私。最后未收到确认的输入可能丢失。",
    "zh-Hant": "草稿以明文儲存在本機私有目錄，不儲存帳號或驗證設定；片段名稱等自由文字仍可能包含隱私。最後未收到確認的輸入可能遺失。",
    "en": "Drafts are stored as plain text in a private local directory, without account or authentication settings. Free text such as clip names may still contain private information. The last unacknowledged input may be lost.",
    "ja": "下書きは端末の非公開ディレクトリに平文で保存し、アカウントや認証設定は保存しません。クリップ名などの自由入力には個人情報が含まれる場合があります。最後に応答を受けていない入力は失われる可能性があります。"
  },
  "recovery.storage.clipCapacity": {
    "zh-Hans": "本工作区累计最多 128 个项目/时间线/片段目标槽位；清除草稿后保留的版本记录仍占位。尚未提供槽位清理，已有记录不会自动删除；容量限制不表示磁盘已满。",
    "zh-Hant": "本工作區累計最多 128 個專案／時間軸／片段目標槽位；清除草稿後保留的版本記錄仍占位。尚未提供槽位清理，既有記錄不會自動刪除；容量限制不表示磁碟已滿。",
    "en": "This workspace supports up to 128 project/timeline/clip target slots in total. Revision records still occupy slots after drafts are cleared. Slot cleanup is not available and existing records are not automatically deleted. The capacity limit does not mean the disk is full.",
    "ja": "このワークスペースはプロジェクト／タイムライン／クリップ単位で累計最大 128 枠です。下書きを消去してもバージョン記録が枠を使います。枠の整理機能はなく、既存記録は自動削除されません。容量制限はディスクが満杯という意味ではありません。"
  },
  "recovery.storage.clipDiscard": {
    "zh-Hans": "放弃已保存草稿不会取消原业务请求或清除其记录。“放弃当前输入，保留草稿记录”只重置表单，不取消在途草稿写入；已保存或稍后写入的草稿可能再次出现。",
    "zh-Hant": "放棄已儲存草稿不會取消原操作請求或清除其記錄。「放棄目前輸入，保留草稿記錄」僅重設表單，不會取消進行中的草稿寫入；已儲存或稍後寫入的草稿可能再次出現。",
    "en": "Discarding a saved draft does not cancel the original operation request or clear its records. “Discard input, retain draft records” only resets the form, without cancelling in-flight draft writes. Saved drafts or writes that finish later may appear again.",
    "ja": "保存済み下書きを破棄しても、元の操作リクエストのキャンセルや記録の消去は行いません。「入力を破棄し、下書き記録を保持」はフォームのみをリセットし、処理中の下書き書き込みはキャンセルしません。保存済み、または後で書き込まれる下書きが再び表示される場合があります。"
  },
  "recovery.storage.clipBackup": {
    "zh-Hans": "此草稿旁文件不包含在工作区离线备份中。恢复分支不读写本地片段草稿，原有允许的手动片段编辑与保存仍可使用。",
    "zh-Hant": "此草稿附加檔案不包含在工作區離線備份中。還原分支不會讀寫本機片段草稿，原有允許的手動片段編輯與儲存仍可使用。",
    "en": "This draft sidecar is excluded from offline workspace backups. Restored branches do not read or write local clip drafts; previously allowed manual clip editing and saving remain available.",
    "ja": "この下書き補助ファイルはワークスペースのオフラインバックアップに含まれません。復元ブランチはクリップのローカル下書きを読み書きしませんが、従来許可されている手動のクリップ編集と保存は利用できます。"
  },
  "recovery.storage.deliveryContent": {
    "zh-Hans": "名称草稿仅保存原始名称输入及原时间线版本，不保存可编辑的输出规格。恢复名称不会导出，也不会自动改用当前时间线版本。",
    "zh-Hant": "名稱草稿僅儲存原始名稱輸入與原時間軸版本，不儲存可編輯的輸出規格。還原名稱不會匯出，也不會自動改用目前時間軸版本。",
    "en": "Name drafts store only the raw name input and original timeline revision, not editable output specifications. Restoring a name does not export or automatically switch to the current timeline revision.",
    "ja": "名前の下書きには元の名前入力と元のタイムラインバージョンのみを保存し、編集可能な出力仕様は保存しません。名前の復元では書き出さず、現在のタイムラインバージョンにも自動で切り替えません。"
  },
  "recovery.storage.deliveryRequest": {
    "zh-Hans": "导出前会单独保存原请求编号与完整参数，包括本次输出规格和已有检查的摘要标识。打开面板、重新连接或读取记录均不会提交或重试导出。明确恢复原请求才会按原编号与精确参数核对或执行，不会改用当前名称或规格，也不会调用模型。",
    "zh-Hant": "匯出前會另外儲存原請求編號與完整參數，包括本次輸出規格與既有檢查的摘要識別碼。開啟面板、重新連線或讀取記錄皆不會提交或重試匯出。只有明確還原原請求才會依原編號與精確參數核對或執行，不會改用目前名稱或規格，也不會呼叫模型。",
    "en": "Before export, the original request ID and complete parameters are saved separately, including output specifications and digests of existing checks. Opening the panel, reconnecting or reading records does not submit or retry exports. Only explicit recovery checks or executes the original ID and exact parameters, without using the current name or specifications or calling a model.",
    "ja": "書き出し前に、今回の出力仕様と既存検査の要約識別子を含む元リクエスト ID と全パラメーターを別途保存します。パネルの表示、再接続、記録の読み取りでは書き出しの送信や再試行を行いません。元のリクエストを明示的に復元した場合のみ、元の ID と正確なパラメーターで確認または実行します。現在の名前や仕様に切り替えず、モデルも呼び出しません。"
  },
  "recovery.storage.deliveryCapacity": {
    "zh-Hans": "本工作区最多保留 128 个项目槽位；清除名称后保留的版本记录与最新原导出请求仍占位。尚未提供槽位清理，已有记录不会自动删除；容量限制不表示磁盘已满。",
    "zh-Hant": "本工作區最多保留 128 個專案槽位；清除名稱後保留的版本記錄與最新原匯出請求仍占位。尚未提供槽位清理，既有記錄不會自動刪除；容量限制不表示磁碟已滿。",
    "en": "This workspace retains up to 128 project slots. After a name is cleared, revision records and the latest original export request still occupy a slot. Slot cleanup is not available and existing records are not automatically deleted. The capacity limit does not mean the disk is full.",
    "ja": "このワークスペースは最大 128 プロジェクト枠を保持します。名前を消去しても、バージョン記録と最新の元書き出しリクエストが枠を使います。枠の整理機能はなく、既存記録は自動削除されません。容量制限はディスクが満杯という意味ではありません。"
  },
  "recovery.storage.deliveryPrivacy": {
    "zh-Hans": "名称草稿与原导出请求在本机私有目录中以明文保存，不保存账号或认证配置；名称等自由文本仍可能包含隐私。放弃名称草稿或重置当前输入不会取消原导出请求，也不保证清除原请求已捕获的名称。最后未收到确认的输入可能丢失。",
    "zh-Hant": "名稱草稿與原匯出請求以明文儲存在本機私有目錄，不儲存帳號或驗證設定；名稱等自由文字仍可能包含隱私。放棄名稱草稿或重設目前輸入不會取消原匯出請求，也不保證清除原請求已擷取的名稱。最後未收到確認的輸入可能遺失。",
    "en": "Name drafts and original export requests are stored as plain text in a private local directory, without account or authentication settings. Names and other free text may contain private information. Discarding a name draft or resetting current input does not cancel the original export request or guarantee removal of a name it already captured. The last unacknowledged input may be lost.",
    "ja": "名前の下書きと元の書き出しリクエストは端末の非公開ディレクトリに平文で保存し、アカウントや認証設定は保存しません。名前などの自由入力には個人情報が含まれる場合があります。名前の下書きの破棄や入力のリセットは元の書き出しリクエストをキャンセルせず、すでに取り込まれた名前の消去も保証しません。最後に応答を受けていない入力は失われる可能性があります。"
  },
  "recovery.storage.deliveryBackup": {
    "zh-Hans": "此旁文件中的名称草稿与原导出请求均不包含在工作区离线备份中。恢复分支不读写这些记录，现有的明确确认本机导出流程仍可使用。",
    "zh-Hant": "此附加檔案中的名稱草稿與原匯出請求皆不包含在工作區離線備份中。還原分支不會讀寫這些記錄，既有的明確確認本機匯出流程仍可使用。",
    "en": "Name drafts and original export requests in this sidecar are excluded from offline workspace backups. Restored branches do not read or write these records; the existing explicitly confirmed local export flow remains available.",
    "ja": "この補助ファイルの名前の下書きと元の書き出しリクエストは、ワークスペースのオフラインバックアップに含まれません。復元ブランチはこれらを読み書きしませんが、明示的に確認する既存のローカル書き出し手順は利用できます。"
  },
  "recovery.storage.textContent": {
    "zh-Hans": "仅保存原始标题、提示词、原文字与保存版本，不保存参考图或生成参数。保存文字前会单独持久保存原请求编号与精确文字修改。",
    "zh-Hant": "僅儲存原始標題、提示詞、原文字與儲存版本，不儲存參考圖或生成參數。儲存文字前會另外持久儲存原請求編號與精確文字修改。",
    "en": "Stores only the raw title, prompt, original text and save revision, not reference images or generation parameters. Before saving text, the original request ID and exact text changes are separately persisted.",
    "ja": "元のタイトル、プロンプト、元テキスト、保存バージョンのみを保存し、参照画像や生成パラメーターは保存しません。テキスト保存の前に、元リクエスト ID と正確なテキスト変更を別途永続保存します。"
  },
  "recovery.storage.textRequest": {
    "zh-Hans": "打开面板、重新连接和读取记录都不会恢复文字或执行保存。恢复草稿只替换标题和提示词，其他输入保留。明确恢复原请求才会按原编号与原文字核对或执行，不会改用当前输入，也不会调用模型或生成镜头。",
    "zh-Hant": "開啟面板、重新連線與讀取記錄都不會還原文字或執行儲存。還原草稿僅替換標題與提示詞，其他輸入保留。只有明確還原原請求才會依原編號與原文字核對或執行，不會改用目前輸入，也不會呼叫模型或生成鏡頭。",
    "en": "Opening the panel, reconnecting or reading records does not restore text or save. Restoring a draft replaces only the title and prompt, retaining other input. Only explicit recovery checks or executes the original request ID and text, without using current input, calling a model or generating a shot.",
    "ja": "パネルの表示、再接続、記録の読み取りではテキストの復元や保存は行いません。下書きの復元はタイトルとプロンプトのみを置き換え、他の入力は保持します。元リクエストを明示的に復元した場合のみ、元の ID とテキストで確認または実行します。現在の入力に切り替えず、モデルの呼び出しやショット生成も行いません。"
  },
  "recovery.storage.textCapacity": {
    "zh-Hans": "本工作区最多保留 128 个项目/镜头槽位；清除草稿后保留的版本记录与最新原文字请求仍占位。尚未提供槽位清理，已有记录不会自动删除；还受旁文件载荷上限约束，容量限制不表示磁盘已满。",
    "zh-Hant": "本工作區最多保留 128 個專案／鏡頭槽位；清除草稿後保留的版本記錄與最新原文字請求仍占位。尚未提供槽位清理，既有記錄不會自動刪除；亦受附加檔案載荷上限約束，容量限制不表示磁碟已滿。",
    "en": "This workspace retains up to 128 project/shot slots. Revision records and the latest original text request still occupy slots after drafts are cleared. Slot cleanup is unavailable and existing records are not automatically deleted. Sidecar payload limits also apply; capacity limits do not mean the disk is full.",
    "ja": "このワークスペースは最大 128 プロジェクト／ショット枠を保持します。下書きを消去しても、バージョン記録と最新の元テキストリクエストが枠を使います。枠の整理機能はなく、既存記録は自動削除されません。補助ファイルのデータ量上限も適用されます。容量制限はディスクが満杯という意味ではありません。"
  },
  "recovery.storage.textPrivacy": {
    "zh-Hans": "文字草稿与原请求在本机私有目录中以明文保存，不保存账号或认证配置；标题、提示词等自由文本仍可能包含隐私。放弃文字草稿或重置当前输入不会取消原文字请求，也不保证清除原请求已捕获的文字。最后未收到确认的输入可能丢失。",
    "zh-Hant": "文字草稿與原請求以明文儲存在本機私有目錄，不儲存帳號或驗證設定；標題、提示詞等自由文字仍可能包含隱私。放棄文字草稿或重設目前輸入不會取消原文字請求，也不保證清除原請求已擷取的文字。最後未收到確認的輸入可能遺失。",
    "en": "Text drafts and original requests are stored as plain text in a private local directory, without account or authentication settings. Titles, prompts and other free text may contain private information. Discarding text drafts or resetting current input does not cancel original text requests or guarantee removal of text already captured by them. The last unacknowledged input may be lost.",
    "ja": "テキスト下書きと元のリクエストは端末の非公開ディレクトリに平文で保存し、アカウントや認証設定は保存しません。タイトルやプロンプトなどの自由入力には個人情報が含まれる場合があります。下書きの破棄や現在の入力のリセットは元テキストリクエストをキャンセルせず、すでに取り込まれたテキストの消去も保証しません。最後に応答を受けていない入力は失われる可能性があります。"
  },
  "recovery.storage.textBackup": {
    "zh-Hans": "此旁文件中的文字草稿与原请求不包含在工作区备份中，包括离线备份。恢复分支不读写这些记录，现有镜头编辑与保存仍可使用。",
    "zh-Hant": "此附加檔案中的文字草稿與原請求不包含在工作區備份中，包括離線備份。還原分支不會讀寫這些記錄，既有鏡頭編輯與儲存仍可使用。",
    "en": "Text drafts and original requests in this sidecar are excluded from workspace backups, including offline backups. Restored branches do not read or write these records; existing shot editing and saving remain available.",
    "ja": "この補助ファイルのテキスト下書きと元リクエストは、オフラインを含むワークスペースのバックアップに含まれません。復元ブランチはこれらを読み書きしませんが、既存のショット編集と保存は利用できます。"
  },
  "export.preflight.phase.idle": {
    "zh-Hans": "尚未检查",
    "zh-Hant": "尚未檢查",
    "en": "Not checked",
    "ja": "未確認"
  },
  "export.preflight.phase.checking": {
    "zh-Hans": "正在检查",
    "zh-Hant": "正在檢查",
    "en": "Checking",
    "ja": "確認中"
  },
  "export.preflight.phase.ready": {
    "zh-Hans": "检查通过",
    "zh-Hant": "檢查通過",
    "en": "Checks passed",
    "ja": "確認に合格"
  },
  "export.preflight.phase.blocked": {
    "zh-Hans": "无法导出",
    "zh-Hant": "無法匯出",
    "en": "Export blocked",
    "ja": "書き出し不可"
  },
  "export.preflight.phase.incomplete": {
    "zh-Hans": "检查未完成",
    "zh-Hant": "檢查未完成",
    "en": "Checks incomplete",
    "ja": "確認未完了"
  },
  "export.preflight.phase.stale": {
    "zh-Hans": "报告已过期",
    "zh-Hant": "報告已過期",
    "en": "Report outdated",
    "ja": "レポートは期限切れ"
  },
  "export.preflight.phase.error": {
    "zh-Hans": "检查失败",
    "zh-Hant": "檢查失敗",
    "en": "Checks failed",
    "ja": "確認に失敗"
  },
  "export.preflight.label": {
    "zh-Hans": "时间线交付检查",
    "zh-Hant": "時間軸交付檢查",
    "en": "Timeline delivery checks",
    "ja": "タイムラインの出力確認"
  },
  "export.preflight.title": {
    "zh-Hans": "交付检查",
    "zh-Hant": "交付檢查",
    "en": "Delivery checks",
    "ja": "出力確認"
  },
  "export.preflight.selectProject": {
    "zh-Hans": "请先选择项目",
    "zh-Hant": "請先選擇專案",
    "en": "Select a project first",
    "ja": "先にプロジェクトを選択してください"
  },
  "export.preflight.capability": {
    "zh-Hans": "本机编码能力",
    "zh-Hant": "本機編碼能力",
    "en": "Local encoding capability",
    "ja": "ローカルのエンコード機能"
  },
  "export.preflight.scopeTitle": {
    "zh-Hans": "仅检查已保存的时间线快照",
    "zh-Hant": "僅檢查已儲存的時間軸快照",
    "en": "Checks only the saved timeline snapshot",
    "ja": "保存済みタイムラインのスナップショットのみ確認"
  },
  "export.preflight.scope": {
    "zh-Hans": "镜头、片段和源范围，以及输出规格的未保存修改均不包含在检查或本次导出中。检查不会保存或放弃草稿。",
    "zh-Hant": "鏡頭、片段、來源範圍與輸出規格的未儲存修改皆不包含在檢查或本次匯出中。檢查不會儲存或放棄草稿。",
    "en": "Unsaved changes to shots, clips, source ranges or output specifications are excluded from checks and this export. Checking does not save or discard drafts.",
    "ja": "ショット、クリップ、ソース範囲、出力仕様の未保存変更は、確認や今回の書き出しに含まれません。確認だけでは下書きの保存や破棄は行いません。"
  },
  "export.preflight.unsaved": {
    "zh-Hans": "有未保存修改，本次不包含；保存后请重新检查。",
    "zh-Hant": "有未儲存修改，本次不包含；儲存後請重新檢查。",
    "en": "Unsaved changes are excluded. Save them and check again.",
    "ja": "未保存の変更は含まれません。保存後に再確認してください。"
  },
  "export.preflight.last": {
    "zh-Hans": "上次检查",
    "zh-Hant": "上次檢查",
    "en": "Previous check",
    "ja": "前回の確認"
  },
  "export.preflight.snapshot": {
    "zh-Hans": "检查快照",
    "zh-Hant": "檢查快照",
    "en": "Checked snapshot",
    "ja": "確認したスナップショット"
  },
  "export.preflight.empty": {
    "zh-Hans": "已保存的时间线还没有片段，暂时无法导出。请先在剪辑里“从分镜建立时间线”，或把素材加入时间线。",
    "zh-Hant": "已儲存的時間軸尚無片段，暫時無法匯出。請先在剪輯中「從分鏡建立時間軸」，或將素材加入時間軸。",
    "en": "The saved timeline has no clips and cannot be exported yet. First build a timeline from the storyboard in the editor, or add assets to the timeline.",
    "ja": "保存済みタイムラインにクリップがないため、まだ書き出せません。編集画面で絵コンテからタイムラインを作成するか、素材をタイムラインに追加してください。"
  },
  "export.preflight.idleHelp": {
    "zh-Hans": "点击“检查本次设置”，先验证本机编码能力，再检查已保存的素材与时间线。打开面板不会开始检查。",
    "zh-Hant": "按下「檢查本次設定」，先驗證本機編碼能力，再檢查已儲存的素材與時間軸。開啟面板不會開始檢查。",
    "en": "Select “Check these settings” to verify local encoding capability, then check saved assets and the timeline. Opening the panel does not start checks.",
    "ja": "「今回の設定を確認」を押すと、ローカルのエンコード機能を検証してから保存済み素材とタイムラインを確認します。パネルを開くだけでは確認は始まりません。"
  },
  "export.preflight.stale": {
    "zh-Hans": "项目、时间线、成片名称、导出范围、成片设置或连接状态已变化。此报告不能用于导出，请重新检查。",
    "zh-Hant": "專案、時間軸、成片名稱、匯出範圍、成片設定或連線狀態已變更。此報告不能用於匯出，請重新檢查。",
    "en": "The project, timeline, export name, range, settings or connection has changed. This report cannot authorize export; check again.",
    "ja": "プロジェクト、タイムライン、書き出し名、範囲、出力設定、または接続状態が変わりました。このレポートは書き出しに使用できません。再確認してください。"
  },
  "export.preflight.oldHelp": {
    "zh-Hans": "下方保留上次报告供参考，不能作为当前导出依据。",
    "zh-Hant": "下方保留上次報告供參考，不能作為目前匯出的依據。",
    "en": "The previous report is retained below for reference, not as the basis for the current export.",
    "ja": "以下に前回のレポートを参考として残していますが、今回の書き出しの根拠にはできません。"
  },
  "export.preflight.attention": {
    "zh-Hans": "需要注意",
    "zh-Hant": "需要注意",
    "en": "Needs attention",
    "ja": "注意が必要"
  },
  "export.preflight.blocking": {
    "zh-Hans": "阻止导出",
    "zh-Hant": "阻止匯出",
    "en": "Blocks export",
    "ja": "書き出しを停止"
  },
  "export.preflight.warning": {
    "zh-Hans": "提醒",
    "zh-Hant": "提醒",
    "en": "Notice",
    "ja": "注意"
  },
  "export.preflight.subtitleUnavailable": {
    "zh-Hans": "内置字幕字体缺失或校验不符，无法安全渲染字幕。请恢复完整的应用资源后重试。",
    "zh-Hant": "內建字幕字型遺失或驗證不符，無法安全算繪字幕。請還原完整的應用程式資源後重試。",
    "en": "The bundled subtitle font is missing or failed verification, so subtitles cannot be rendered safely. Restore the complete application resources and retry.",
    "ja": "内蔵字幕フォントがないか検証に失敗したため、安全に字幕を描画できません。アプリのリソースを完全に復元してから再試行してください。"
  },
  "export.preflight.output": {
    "zh-Hans": "输出与编排",
    "zh-Hant": "輸出與編排",
    "en": "Output and arrangement",
    "ja": "出力と配置"
  },
  "export.preflight.composition": {
    "zh-Hans": "编辑合成规格",
    "zh-Hant": "編輯合成規格",
    "en": "Editing composition specifications",
    "ja": "編集用コンポジション仕様"
  },
  "export.preflight.checkedOutput": {
    "zh-Hans": "检查的成片规格",
    "zh-Hant": "檢查的成片規格",
    "en": "Checked output specifications",
    "ja": "確認した出力仕様"
  },
  "export.preflight.fullDuration": {
    "zh-Hans": "完整时间线时长",
    "zh-Hant": "完整時間軸長度",
    "en": "Full timeline duration",
    "ja": "タイムライン全体の長さ"
  },
  "export.preflight.duration": {
    "zh-Hans": "总时长",
    "zh-Hant": "總長度",
    "en": "Total duration",
    "ja": "合計時間"
  },
  "export.preflight.counts": {
    "zh-Hans": "轨道 / 片段 / 素材",
    "zh-Hant": "軌道／片段／素材",
    "en": "Tracks / Clips / Assets",
    "ja": "トラック／クリップ／素材"
  },
  "export.preflight.enabled": {
    "zh-Hans": "画面 / 声音启用片段",
    "zh-Hant": "啟用畫面／聲音的片段",
    "en": "Video / Audio-enabled clips",
    "ja": "映像／音声が有効なクリップ"
  },
  "export.preflight.disabled": {
    "zh-Hans": "静音 / 隐藏画面轨",
    "zh-Hant": "靜音／隱藏畫面軌道",
    "en": "Muted / Hidden video tracks",
    "ja": "ミュート／映像非表示のトラック"
  },
  "export.preflight.checkedRange": {
    "zh-Hans": "检查的导出范围",
    "zh-Hant": "檢查的匯出範圍",
    "en": "Checked export range",
    "ja": "確認した書き出し範囲"
  },
  "export.preflight.fontVerified": {
    "zh-Hans": "已校验固定字体与配置",
    "zh-Hant": "已驗證固定字型與設定",
    "en": "Fixed font and configuration verified",
    "ja": "固定フォントと設定を検証済み"
  },
  "export.preflight.fontUnverified": {
    "zh-Hans": "固定字体尚未通过校验",
    "zh-Hant": "固定字型尚未通過驗證",
    "en": "Fixed font not yet verified",
    "ja": "固定フォントは未検証"
  },
  "export.preflight.rangeScope": {
    "zh-Hans": "范围只限定成片输出；仍会检查完整已保存时间线的全部引用素材，包括范围外素材。",
    "zh-Hant": "範圍僅限制成片輸出；仍會檢查整段已儲存時間軸的所有引用素材，包括範圍外素材。",
    "en": "The range limits only the output. All referenced assets across the entire saved timeline are still checked, including those outside the range.",
    "ja": "範囲が制限するのは出力のみです。範囲外の素材も含め、保存済みタイムライン全体で参照するすべての素材を確認します。"
  },
  "export.preflight.sourceScope": {
    "zh-Hans": "素材检查范围",
    "zh-Hant": "素材檢查範圍",
    "en": "Asset check scope",
    "ja": "素材の確認範囲"
  },
  "export.preflight.limitedChecks": {
    "zh-Hans": "有限额的文件状态、流式 SHA-256 与媒体探测检查。未进行完整解码，也不能保证检查后文件不再变化。",
    "zh-Hant": "有限額的檔案狀態、串流 SHA-256 與媒體探測檢查。未進行完整解碼，也無法保證檢查後檔案不再變更。",
    "en": "Bounded checks of file status, streaming SHA-256 and media probing. Files are not fully decoded, and may still change after checking.",
    "ja": "ファイル状態、ストリーミング SHA-256、メディア解析を上限付きで確認します。完全なデコードは行わず、確認後にファイルが変わらないことも保証しません。"
  },
  "export.preflight.incompleteWarning": {
    "zh-Hans": "检查未完成，不代表通过。",
    "zh-Hant": "檢查未完成，不代表通過。",
    "en": "Incomplete checks do not mean checks passed.",
    "ja": "確認が未完了であり、合格したわけではありません。"
  },
  "export.preflight.tryBound": {
    "zh-Hans": "仍尝试导出可能失败，渲染进程会重新验证素材与快照。",
    "zh-Hant": "仍嘗試匯出可能失敗，算繪程序會重新驗證素材與快照。",
    "en": "Attempting export may still fail; the renderer will revalidate assets and the snapshot.",
    "ja": "それでも書き出しを試すと失敗する場合があります。レンダラーが素材とスナップショットを再検証します。"
  },
  "export.preflight.tryUnchecked": {
    "zh-Hans": "尚未完成快照核验。仍尝试导出会使用当前已保存的时间线版本；渲染进程会重新验证素材。",
    "zh-Hant": "尚未完成快照核驗。仍嘗試匯出將使用目前已儲存的時間軸版本；算繪程序會重新驗證素材。",
    "en": "Snapshot verification is incomplete. Attempting export uses the current saved timeline revision; the renderer will revalidate assets.",
    "ja": "スナップショットの検証が未完了です。それでも書き出す場合は現在保存済みのタイムラインバージョンを使い、レンダラーが素材を再検証します。"
  },
  "export.preflight.noSnapshot": {
    "zh-Hans": "尚未取得有效快照，暂时不能导出。",
    "zh-Hant": "尚未取得有效快照，暫時無法匯出。",
    "en": "No valid snapshot has been obtained; export is unavailable for now.",
    "ja": "有効なスナップショットがないため、現在は書き出せません。"
  },
  "export.preflight.pending": {
    "zh-Hans": "已有导出请求结果待确认。请使用原请求旁的恢复入口核对同一请求；重新检查不会重发导出。",
    "zh-Hant": "已有匯出請求結果待確認。請使用原請求旁的還原入口核對同一請求；重新檢查不會重送匯出。",
    "en": "An export request already awaits outcome confirmation. Use recovery beside the original request to check that same request. Rechecking will not resubmit the export.",
    "ja": "すでに書き出しリクエストの結果が確認待ちです。元のリクエスト横の復元操作で同じリクエストを確認してください。再検査では書き出しを再送信しません。"
  },
  "export.preflight.attempted": {
    "zh-Hans": "已发起一次导出提交。请在任务或导出记录查看结果；此报告不代表导出已完成。",
    "zh-Hant": "已發起一次匯出提交。請在工作或匯出記錄查看結果；此報告不代表匯出已完成。",
    "en": "One export submission has been initiated. Check tasks or export history for its result; this report does not mean export is complete.",
    "ja": "書き出しの送信を 1 回開始しました。結果はタスクまたは書き出し履歴で確認してください。このレポートは書き出し完了を意味しません。"
  },
  "export.preflight.encodingScope": {
    "zh-Hans": "本机编码检查会进行有限额的短时合成编码与 MP4 封装，测试输出仅留在内存中；后续素材预检为只读。均不创建成片任务。",
    "zh-Hant": "本機編碼檢查會進行有限額的短時間合成編碼與 MP4 封裝，測試輸出僅留在記憶體中；後續素材預檢為唯讀。兩者皆不建立成片工作。",
    "en": "Local encoding checks perform bounded, short synthetic encodes and MP4 muxing, with test output kept only in memory. Subsequent asset preflight checks are read-only. Neither creates an export task.",
    "ja": "ローカルのエンコード確認では、短い合成映像のエンコードと MP4 多重化を上限付きで行い、テスト出力はメモリ内にのみ保持します。その後の素材事前確認は読み取り専用です。いずれも書き出しタスクは作成しません。"
  },
  "export.preflight.limits": {
    "zh-Hans": "上限：100 个片段、12 条轨道、18000 帧。实际导出仍会重新验证；检查报告不是导出成功凭据。",
    "zh-Hant": "上限：100 個片段、12 條軌道、18000 影格。實際匯出仍會重新驗證；檢查報告不是匯出成功憑據。",
    "en": "Limits: 100 clips, 12 tracks and 18000 frames. Actual export still revalidates; a check report is not proof of export success.",
    "ja": "上限は 100 クリップ、12 トラック、18000 フレームです。実際の書き出し時にも再検証します。確認レポートは書き出し成功の証明ではありません。"
  },
  "export.preflight.checkCapability": {
    "zh-Hans": "检查编码能力…",
    "zh-Hant": "檢查編碼能力…",
    "en": "Checking encoding capability…",
    "ja": "エンコード機能を確認中…"
  },
  "export.preflight.checkAssets": {
    "zh-Hans": "检查素材…",
    "zh-Hant": "檢查素材…",
    "en": "Checking assets…",
    "ja": "素材を確認中…"
  },
  "export.preflight.check": {
    "zh-Hans": "检查本次设置",
    "zh-Hant": "檢查本次設定",
    "en": "Check these settings",
    "ja": "今回の設定を確認"
  },
  "export.preflight.submitting": {
    "zh-Hans": "正在提交…",
    "zh-Hant": "正在提交…",
    "en": "Submitting…",
    "ja": "送信中…"
  },
  "export.preflight.attempt": {
    "zh-Hans": "检查未完成，仍尝试导出",
    "zh-Hant": "檢查未完成，仍嘗試匯出",
    "en": "Checks incomplete; attempt export anyway",
    "ja": "確認未完了でも書き出しを試す"
  },
  "export.preflight.confirm": {
    "zh-Hans": "确认导出",
    "zh-Hant": "確認匯出",
    "en": "Confirm export",
    "ja": "書き出しを確認"
  },
  "export.preflight.unchecked": {
    "zh-Hans": "未完成快照核验，仍尝试导出",
    "zh-Hant": "尚未完成快照核驗，仍嘗試匯出",
    "en": "Snapshot unverified; attempt export anyway",
    "ja": "スナップショット未検証でも書き出しを試す"
  },
  "recovery.backup.scope": {
    "zh-Hans": "范围：整个工作区，包含所有项目、聊天、提示词，以及 SQLite 内的本地缓存。",
    "zh-Hant": "範圍：整個工作區，包含所有專案、聊天、提示詞，以及 SQLite 內的本機快取。",
    "en": "Scope: the entire workspace, including all projects, chats, prompts and local caches in SQLite.",
    "ja": "対象はワークスペース全体です。すべてのプロジェクト、チャット、プロンプト、SQLite 内のローカルキャッシュを含みます。"
  },
  "recovery.backup.media": {
    "zh-Hans": "媒体按离线指南的固定清单收集，不代表工作区内所有文件都会复制。",
    "zh-Hant": "媒體依離線指南的固定清單收集，不代表工作區內所有檔案都會複製。",
    "en": "Media is collected from the fixed list in the offline guide; not every workspace file is copied.",
    "ja": "メディアはオフラインガイドの固定リストに従って収集します。ワークスペース内の全ファイルをコピーするわけではありません。"
  },
  "recovery.backup.privacy": {
    "zh-Hans": "不包含应用凭据与应用设置；用户文本仍可能含密钥或其他秘密。请妥善保管备份。",
    "zh-Hant": "不包含應用程式憑證與設定；使用者文字仍可能含金鑰或其他機密。請妥善保管備份。",
    "en": "Application credentials and settings are excluded, but user text may still contain keys or other secrets. Keep backups secure.",
    "ja": "アプリの認証情報や設定は含みませんが、ユーザーテキストにキーなどの機密情報が含まれる場合があります。バックアップは安全に保管してください。"
  },
  "recovery.backup.readOnly": {
    "zh-Hans": "运行中的后端不能创建冷备份。这里只读核对数据库记录，未逐一检查源文件，也没有创建备份或验证恢复。",
    "zh-Hant": "執行中的後端無法建立冷備份。此處僅以唯讀方式核對資料庫記錄，未逐一檢查來源檔案，也未建立備份或驗證還原。",
    "en": "A running backend cannot create a cold backup. This only checks database records read-only; it does not inspect each source file, create a backup or verify restoration.",
    "ja": "バックエンドの実行中はコールドバックアップを作成できません。ここではデータベース記録を読み取り専用で確認するだけです。個々のソースファイルの検査、バックアップの作成、復元の検証は行いません。"
  },
  "recovery.backup.checking": {
    "zh-Hans": "正在核对…",
    "zh-Hant": "正在核對…",
    "en": "Checking…",
    "ja": "照合中…"
  },
  "recovery.backup.refresh": {
    "zh-Hans": "刷新数据库核对",
    "zh-Hant": "重新整理資料庫核對",
    "en": "Refresh database check",
    "ja": "データベース確認を更新"
  },
  "recovery.backup.check": {
    "zh-Hans": "核对数据库状态",
    "zh-Hant": "核對資料庫狀態",
    "en": "Check database status",
    "ja": "データベースの状態を確認"
  },
  "recovery.backup.disconnected": {
    "zh-Hans": "连接不可用，恢复连接后请手动核对。",
    "zh-Hant": "連線無法使用，恢復連線後請手動核對。",
    "en": "Connection unavailable. Check manually after reconnecting.",
    "ja": "接続を利用できません。再接続後に手動で確認してください。"
  },
  "recovery.backup.reading": {
    "zh-Hans": "正在读取有上限的数据库记录…",
    "zh-Hant": "正在讀取有上限的資料庫記錄…",
    "en": "Reading bounded database records…",
    "ja": "上限付きでデータベース記録を読み取り中…"
  },
  "recovery.backup.stale": {
    "zh-Hans": "上次核对结果仅供参考，请手动刷新。",
    "zh-Hant": "上次核對結果僅供參考，請手動重新整理。",
    "en": "The previous check is for reference only. Refresh manually.",
    "ja": "前回の確認結果は参考用です。手動で更新してください。"
  },
  "recovery.backup.failed": {
    "zh-Hans": "核对失败，未取得可用结果。",
    "zh-Hant": "核對失敗，未取得可用結果。",
    "en": "The check failed; no usable result was obtained.",
    "ja": "確認に失敗し、利用できる結果は取得できませんでした。"
  },
  "recovery.backup.incomplete": {
    "zh-Hans": "数据库核对未完成；未知数量不等于零。",
    "zh-Hant": "資料庫核對未完成；未知數量不等於零。",
    "en": "Database check incomplete. Unknown counts do not mean zero.",
    "ja": "データベースの確認が未完了です。件数不明は 0 件という意味ではありません。"
  },
  "recovery.backup.complete": {
    "zh-Hans": "数据库记录核对完成，仅为本次瞬时结果；仍须关闭应用后离线创建备份。",
    "zh-Hant": "資料庫記錄核對完成，僅為本次瞬間結果；仍須關閉應用程式後離線建立備份。",
    "en": "Database record checks are complete, but only for this instant. Close the application and create the backup offline.",
    "ja": "データベース記録の確認が完了しましたが、この時点だけの結果です。バックアップはアプリを終了してからオフラインで作成する必要があります。"
  },
  "recovery.backup.idle": {
    "zh-Hans": "尚未核对。展开、切换页面或恢复连接不会自动发起请求。",
    "zh-Hant": "尚未核對。展開、切換頁面或恢復連線不會自動發起請求。",
    "en": "Not checked yet. Expanding, switching pages or reconnecting does not automatically send a request.",
    "ja": "まだ確認していません。展開、ページ切り替え、再接続だけではリクエストを自動送信しません。"
  },
  "recovery.backup.report": {
    "zh-Hans": "数据库记录核对",
    "zh-Hant": "資料庫記錄核對",
    "en": "Database record check",
    "ja": "データベース記録の確認"
  },
  "recovery.backup.unresolved": {
    "zh-Hans": "未解决的任务与请求",
    "zh-Hant": "未解決的工作與請求",
    "en": "Unresolved tasks and requests",
    "ja": "未解決のタスクとリクエスト"
  },
  "recovery.backup.noneUnresolved": {
    "zh-Hans": "本次数据库核对未发现未解决记录；这不是备份可用性保证。",
    "zh-Hant": "本次資料庫核對未發現未解決記錄；這不是備份可用性的保證。",
    "en": "No unresolved records were found in this database check; this does not guarantee backup usability.",
    "ja": "今回のデータベース確認で未解決の記録は見つかりませんでした。バックアップが利用可能である保証ではありません。"
  },
  "recovery.backup.retention": {
    "zh-Hans": "备份保留这些记录，不会自动恢复、提交或重试任务。",
    "zh-Hant": "備份保留這些記錄，不會自動還原、提交或重試工作。",
    "en": "Backups retain these records without automatically recovering, submitting or retrying tasks.",
    "ja": "バックアップはこれらの記録を保持しますが、タスクの復元、送信、再試行は自動で行いません。"
  },
  "recovery.backup.limits": {
    "zh-Hans": "离线命令的容量上限",
    "zh-Hant": "離線命令的容量上限",
    "en": "Offline command capacity limits",
    "ja": "オフラインコマンドの容量上限"
  },
  "recovery.backup.steps": {
    "zh-Hans": "离线备份步骤",
    "zh-Hant": "離線備份步驟",
    "en": "Offline backup steps",
    "ja": "オフラインバックアップの手順"
  },
  "recovery.backup.terminal": {
    "zh-Hans": "关闭应用后，在本地终端操作",
    "zh-Hant": "關閉應用程式後，在本機終端操作",
    "en": "After closing the app, use a local terminal",
    "ja": "アプリを終了してからローカル端末で操作"
  },
  "recovery.backup.close": {
    "zh-Hans": "保存草稿，正常关闭 Mioon 和所有使用同一工作区的后端。不要删除锁文件、WAL 或日志文件来绕过检查。",
    "zh-Hant": "儲存草稿，正常關閉 Mioon 與所有使用同一工作區的後端。請勿刪除鎖定檔案、WAL 或記錄檔來繞過檢查。",
    "en": "Save drafts and shut down Mioon and every backend using the same workspace normally. Do not delete lock files, WAL or logs to bypass checks.",
    "ja": "下書きを保存し、Mioon と同じワークスペースを使うすべてのバックエンドを正常に終了してください。検査を回避するためにロックファイル、WAL、ログを削除しないでください。"
  },
  "recovery.backup.run": {
    "zh-Hans": "在已安装锁定依赖的源码仓库根目录，使用 Node 24+ 运行下面的命令。替换占位绝对路径；目标必须是工作区之外的新目录。平台支持与限制请先查看指南。",
    "zh-Hant": "在已安裝鎖定相依套件的原始碼儲存庫根目錄，使用 Node 24+ 執行以下命令。替換佔位絕對路徑；目標必須是工作區以外的新目錄。平台支援與限制請先查看指南。",
    "en": "From the source repository root with locked dependencies installed, run the commands below using Node 24+. Replace the placeholder absolute paths. The destination must be a new directory outside the workspace. Read the guide first for platform support and limitations.",
    "ja": "固定された依存関係をインストール済みのソースリポジトリのルートで、Node 24+ を使って以下のコマンドを実行してください。仮の絶対パスを置き換え、保存先にはワークスペース外の新しいディレクトリを指定します。対応環境と制限は先にガイドを確認してください。"
  },
  "recovery.backup.verify": {
    "zh-Hans": "单独核验已有备份：",
    "zh-Hant": "單獨核驗既有備份：",
    "en": "Verify an existing backup separately:",
    "ja": "既存バックアップを個別に検証："
  },
  "recovery.backup.restoreWarning": {
    "zh-Hans": "核验成功只表示声明的备份内容通过完整性检查，不表示可以安全恢复。恢复需按离线指南写入全新目录；恢复分支仅开放本地编辑与导出，受限功能和后续备份限制请先阅读指南。",
    "zh-Hant": "核驗成功僅表示聲明的備份內容通過完整性檢查，不代表可安全還原。還原須依離線指南寫入全新目錄；還原分支僅開放本機編輯與匯出，受限功能及後續備份限制請先閱讀指南。",
    "en": "Successful verification means only that the declared backup contents passed integrity checks, not that restoration is safe. Follow the offline guide to restore into a new directory. Restored branches allow only local editing and export; read the guide first for restricted features and later-backup limitations.",
    "ja": "検証成功は、宣言されたバックアップ内容が整合性検査に合格したことだけを示し、安全に復元できることを意味しません。オフラインガイドに従って新規ディレクトリに復元してください。復元ブランチはローカル編集と書き出しのみ利用できます。制限機能とその後のバックアップ制限は先にガイドを確認してください。"
  },
  "recovery.backup.closeGuide": {
    "zh-Hans": "收起离线备份指南",
    "zh-Hant": "收合離線備份指南",
    "en": "Collapse offline backup guide",
    "ja": "オフラインバックアップガイドを閉じる"
  },
  "recovery.backup.openGuide": {
    "zh-Hans": "查看离线备份指南",
    "zh-Hant": "查看離線備份指南",
    "en": "View offline backup guide",
    "ja": "オフラインバックアップガイドを表示"
  },
  "recovery.backup.title": {
    "zh-Hans": "工作区离线备份",
    "zh-Hant": "工作區離線備份",
    "en": "Offline workspace backup",
    "ja": "ワークスペースのオフラインバックアップ"
  },
  "recovery.backup.subtitle": {
    "zh-Hans": "整工作区 · 需先正常关闭应用",
    "zh-Hant": "整個工作區 · 須先正常關閉應用程式",
    "en": "Entire workspace · Shut down the app normally first",
    "ja": "ワークスペース全体 · 先にアプリを正常終了"
  },
  "recovery.restored.unavailable": {
    "zh-Hans": "此功能暂不可用",
    "zh-Hant": "此功能暫時無法使用",
    "en": "This feature is currently unavailable",
    "ja": "現在この機能は利用できません"
  },
  "recovery.restored.records": {
    "zh-Hans": "已保存的记录仍被保留；此视图暂不能安全读取或操作这些任务。已完成的素材和版本可在素材库查看。",
    "zh-Hant": "已儲存的記錄仍保留；此檢視暫時無法安全讀取或操作這些工作。已完成的素材與版本可在素材庫查看。",
    "en": "Saved records are retained, but this view cannot safely read or operate these tasks yet. Completed assets and versions are available in the asset library.",
    "ja": "保存済み記録は保持していますが、この画面ではまだ安全にタスクを読み取り、操作できません。完了済みの素材とバージョンは素材ライブラリで確認できます。"
  },
  "recovery.restored.branch": {
    "zh-Hans": "恢复分支",
    "zh-Hant": "還原分支",
    "en": "Restored branch",
    "ja": "復元ブランチ"
  },
  "recovery.restored.localReady": {
    "zh-Hans": "可本地导入、编辑、预览和导出",
    "zh-Hant": "可在本機匯入、編輯、預覽與匯出",
    "en": "Local import, editing, preview and export available",
    "ja": "ローカルで読み込み、編集、プレビュー、書き出しが可能"
  },
  "recovery.restored.localLimited": {
    "zh-Hans": "本地操作按当前支持范围开放",
    "zh-Hant": "本機操作依目前支援範圍開放",
    "en": "Local operations follow current support limits",
    "ja": "現在の対応範囲でローカル操作が可能"
  },
  "recovery.restored.details": {
    "zh-Hans": "分支与暂停范围",
    "zh-Hant": "分支與暫停範圍",
    "en": "Branch and paused operations",
    "ja": "ブランチと停止対象"
  },
  "recovery.restored.independent": {
    "zh-Hans": "这是原备份时点的独立工作区。原工作区之后的修改不会合并；旧任务状态不代表正在执行。",
    "zh-Hant": "這是原備份時點的獨立工作區。原工作區之後的修改不會合併；舊工作狀態不代表正在執行。",
    "en": "This is an independent workspace from the original backup point. Later changes in the original workspace are not merged; old task statuses do not indicate active execution.",
    "ja": "これは元のバックアップ時点の独立したワークスペースです。元のワークスペースでの以後の変更は統合されません。古いタスク状態は現在実行中であることを意味しません。"
  },
  "recovery.restored.disabledReason": {
    "zh-Hans": "恢复分支第一版暂不支持新生成、Agent、Comfy、抽帧或波形解码。历史任务保持原状态并暂停执行。",
    "zh-Hant": "還原分支第一版暫不支援新生成、Agent、Comfy、影格擷取或波形解碼。歷史工作保留原狀態並暫停執行。",
    "en": "The first version of restored branches does not support new generation, Agent, Comfy, frame extraction or waveform decoding. Historical tasks retain their original status and execution is paused.",
    "ja": "復元ブランチの初期版は、新規生成、Agent、Comfy、フレーム抽出、波形デコードに対応していません。過去のタスクは元の状態を保持し、実行を停止しています。"
  },
  "recovery.restored.backupReason": {
    "zh-Hans": "此恢复分支暂不能再次创建可恢复备份；请保留原始备份。新成片可本地导出。",
    "zh-Hant": "此還原分支暫時無法再次建立可還原備份；請保留原始備份。新成片可在本機匯出。",
    "en": "This restored branch cannot yet create another restorable backup. Keep the original backup. New output can be exported locally.",
    "ja": "この復元ブランチからは、まだ再復元可能なバックアップを作成できません。元のバックアップを保管してください。新しい完成映像はローカルに書き出せます。"
  },
  "audio.loudness.export.label": {
    "zh-Hans": "已导出文件响度与真峰值",
    "zh-Hant": "已匯出檔案響度與真峰值",
    "en": "Exported file loudness and true peak",
    "ja": "書き出し済みファイルのラウドネスとトゥルーピーク"
  },
  "audio.loudness.export.limitation": {
    "zh-Hans": "仅对此导出文件作估算，不是标准认证、无削波证明或再次 AAC 编码的保证。建议不会修改音量。",
    "zh-Hant": "僅對此匯出檔案作估算，並非標準認證、無削波證明或再次 AAC 編碼的保證。建議不會修改音量。",
    "en": "An estimate for this exported file only, not standards certification, proof of no clipping or a guarantee for another AAC encode. Suggestions do not change volume.",
    "ja": "この書き出し済みファイルだけの推定値です。規格認証、クリッピングがない証明、AAC 再エンコードの保証ではありません。提案だけで音量は変更しません。"
  },
  "audio.loudness.export.restored": {
    "zh-Hans": "恢复分支暂不支持已导出文件响度与真峰值测量。",
    "zh-Hant": "還原分支暫不支援已匯出檔案響度與真峰值測量。",
    "en": "Exported-file loudness and true-peak measurement is not supported in restored branches yet.",
    "ja": "復元ブランチでは現在、書き出し済みファイルのラウドネスとトゥルーピークの測定を利用できません。"
  },
  "audio.loudness.peak.label": {
    "zh-Hans": "已导出文件解码样本峰值",
    "zh-Hant": "已匯出檔案解碼樣本峰值",
    "en": "Decoded sample peak of exported file",
    "ja": "書き出し済みファイルのデコード後サンプルピーク"
  },
  "audio.loudness.peak.limitation": {
    "zh-Hans": "仅检查成片样本，不是响度或真峰值，也不能证明源音频或混音未削波。",
    "zh-Hant": "僅檢查成片樣本，並非響度或真峰值，也無法證明來源音訊或混音未削波。",
    "en": "Checks only output samples, not loudness or true peak. It cannot prove that source audio or the mix is free of clipping.",
    "ja": "出力サンプルのみを検査し、ラウドネスやトゥルーピークは測定しません。ソース音声やミックスにクリッピングがない証明にはなりません。"
  },
  "audio.loudness.peak.restored": {
    "zh-Hans": "恢复分支暂不支持已导出文件解码样本峰值检查。",
    "zh-Hant": "還原分支暫不支援已匯出檔案解碼樣本峰值檢查。",
    "en": "Decoded sample-peak checks for exported files are not supported in restored branches yet.",
    "ja": "復元ブランチでは現在、書き出し済みファイルのデコード後サンプルピーク検査を利用できません。"
  },
  "audio.loudness.state.valid": {
    "zh-Hans": "可计算综合响度",
    "zh-Hant": "可計算綜合響度",
    "en": "Integrated loudness available",
    "ja": "統合ラウドネスを算出可能"
  },
  "audio.loudness.state.digital_silence": {
    "zh-Hans": "数字静音：综合响度不可用",
    "zh-Hant": "數位靜音：綜合響度無法使用",
    "en": "Digital silence: integrated loudness unavailable",
    "ja": "デジタル無音：統合ラウドネスは算出不可"
  },
  "audio.loudness.state.too_short": {
    "zh-Hans": "短于 400 毫秒：综合响度不可用",
    "zh-Hant": "短於 400 毫秒：綜合響度無法使用",
    "en": "Under 400 ms: integrated loudness unavailable",
    "ja": "400 ミリ秒未満：統合ラウドネスは算出不可"
  },
  "audio.loudness.state.below_gate": {
    "zh-Hans": "低于绝对门限：综合响度不可用",
    "zh-Hant": "低於絕對閘值：綜合響度無法使用",
    "en": "Below absolute gate: integrated loudness unavailable",
    "ja": "絶対ゲート値未満：統合ラウドネスは算出不可"
  },
  "audio.loudness.target.optional": {
    "zh-Hans": "自定参考目标（可选）",
    "zh-Hant": "自訂參考目標（選填）",
    "en": "Custom reference targets (optional)",
    "ja": "参照目標を指定（任意）"
  },
  "audio.loudness.target.optionalHelp": {
    "zh-Hans": "两项留空仅测量；不预设平台标准。",
    "zh-Hant": "兩項留空則僅測量；不預設平台標準。",
    "en": "Leave both blank for measurement only; no platform standard is assumed.",
    "ja": "両方を空欄にすると測定のみ行います。プラットフォームの基準はあらかじめ設定しません。"
  },
  "audio.loudness.target.lufs": {
    "zh-Hans": "目标响度（LUFS，−60 至 −5）",
    "zh-Hant": "目標響度（LUFS，−60 至 −5）",
    "en": "Target loudness (LUFS, −60 to −5)",
    "ja": "目標ラウドネス（LUFS、−60～−5）"
  },
  "audio.loudness.target.peak": {
    "zh-Hans": "真峰值上限（dBTP，−20 至 0）",
    "zh-Hant": "真峰值上限（dBTP，−20 至 0）",
    "en": "True-peak ceiling (dBTP, −20 to 0)",
    "ja": "トゥルーピーク上限（dBTP、−20～0）"
  },
  "audio.loudness.target.both": {
    "zh-Hans": "请同时填写目标响度和真峰值上限，或将两项都留空以仅测量。",
    "zh-Hant": "請同時填寫目標響度與真峰值上限，或將兩項皆留空以僅測量。",
    "en": "Enter both target loudness and true-peak ceiling, or leave both blank for measurement only.",
    "ja": "目標ラウドネスとトゥルーピーク上限の両方を入力するか、測定のみなら両方を空欄にしてください。"
  },
  "audio.loudness.target.lufsInvalid": {
    "zh-Hans": "目标响度须为 −60 至 −5 LUFS 的有限数值。",
    "zh-Hant": "目標響度須為 −60 至 −5 LUFS 的有限數值。",
    "en": "Target loudness must be a finite number from −60 to −5 LUFS.",
    "ja": "目標ラウドネスは −60～−5 LUFS の有限数で入力してください。"
  },
  "audio.loudness.target.peakInvalid": {
    "zh-Hans": "真峰值上限须为 −20 至 0 dBTP 的有限数值。",
    "zh-Hant": "真峰值上限須為 −20 至 0 dBTP 的有限數值。",
    "en": "True-peak ceiling must be a finite number from −20 to 0 dBTP.",
    "ja": "トゥルーピーク上限は −20～0 dBTP の有限数で入力してください。"
  },
  "audio.loudness.measureAgain": {
    "zh-Hans": "重新测量",
    "zh-Hant": "重新測量",
    "en": "Measure again",
    "ja": "再測定"
  },
  "audio.loudness.measure": {
    "zh-Hans": "测量",
    "zh-Hant": "測量",
    "en": "Measure",
    "ja": "測定"
  },
  "audio.loudness.cancelObservation": {
    "zh-Hans": "取消本次观察",
    "zh-Hant": "取消本次觀察",
    "en": "Cancel this observation",
    "ja": "今回の観測をキャンセル"
  },
  "audio.loudness.selectedFile": {
    "zh-Hans": "所选范围的已导出文件",
    "zh-Hant": "所選範圍的已匯出檔案",
    "en": "Exported file for the selected range",
    "ja": "選択範囲の書き出し済みファイル"
  },
  "audio.loudness.fullFile": {
    "zh-Hans": "完整冻结时间线的已导出文件",
    "zh-Hant": "完整凍結時間軸的已匯出檔案",
    "en": "Exported file for the entire frozen timeline",
    "ja": "固定されたタイムライン全体の書き出し済みファイル"
  },
  "audio.loudness.integratedLabel": {
    "zh-Hans": "综合响度：",
    "zh-Hant": "綜合響度：",
    "en": "Integrated loudness: ",
    "ja": "統合ラウドネス："
  },
  "audio.loudness.truePeakLabel": {
    "zh-Hans": "真峰值估算：",
    "zh-Hant": "真峰值估算：",
    "en": "Estimated true peak: ",
    "ja": "推定トゥルーピーク："
  },
  "audio.loudness.samplePeakLabel": {
    "zh-Hans": "解码样本峰值：",
    "zh-Hant": "解碼樣本峰值：",
    "en": "Decoded sample peak: ",
    "ja": "デコード後サンプルピーク："
  },
  "audio.loudness.conflict": {
    "zh-Hans": "所需增益超过参考真峰值余量，两个目标存在冲突。",
    "zh-Hant": "所需增益超過參考真峰值餘量，兩個目標存在衝突。",
    "en": "The required gain exceeds the reference true-peak headroom; the two targets conflict.",
    "ja": "必要ゲインが参照トゥルーピークの余裕を超えており、2 つの目標が競合しています。"
  },
  "audio.loudness.adviceHelp": {
    "zh-Hans": "仅供参考，未验证当前时间线；未来如另行调整音量，须重新导出并测量。",
    "zh-Hant": "僅供參考，未驗證目前時間軸；日後若另行調整音量，須重新匯出並測量。",
    "en": "For reference only; the current timeline was not verified. If you later adjust volume separately, export and measure again.",
    "ja": "参考用であり、現在のタイムラインは検証していません。後で音量を別途変更した場合は、再度書き出して測定してください。"
  },
  "audio.loudness.noAdvice": {
    "zh-Hans": "本次综合响度不可用，无法提供增益参考。",
    "zh-Hant": "本次綜合響度無法使用，無法提供增益參考。",
    "en": "Integrated loudness is unavailable, so gain advice cannot be provided.",
    "ja": "今回の統合ラウドネスは算出できないため、ゲインの参考値を提示できません。"
  },
  "audio.loudness.details": {
    "zh-Hans": "测量文件与算法详情",
    "zh-Hant": "測量檔案與演算法詳情",
    "en": "Measured file and algorithm details",
    "ja": "測定ファイルとアルゴリズムの詳細"
  },
  "audio.loudness.projectId": {
    "zh-Hans": "项目编号：",
    "zh-Hant": "專案編號：",
    "en": "Project ID: ",
    "ja": "プロジェクト ID："
  },
  "audio.loudness.exportId": {
    "zh-Hans": "导出编号：",
    "zh-Hant": "匯出編號：",
    "en": "Export ID: ",
    "ja": "書き出し ID："
  },
  "audio.loudness.assetId": {
    "zh-Hans": "文件编号：",
    "zh-Hant": "檔案編號：",
    "en": "File ID: ",
    "ja": "ファイル ID："
  },
  "audio.loudness.snapshotHash": {
    "zh-Hans": "快照 SHA-256：",
    "zh-Hant": "快照 SHA-256：",
    "en": "Snapshot SHA-256: ",
    "ja": "スナップショット SHA-256："
  },
  "audio.loudness.profile": {
    "zh-Hans": "测量配置：",
    "zh-Hant": "測量設定：",
    "en": "Measurement profile: ",
    "ja": "測定プロファイル："
  },
  "audio.loudness.stage": {
    "zh-Hans": "阶段：已导出文件解码后",
    "zh-Hant": "階段：已匯出檔案解碼後",
    "en": "Stage: after decoding the exported file",
    "ja": "段階：書き出し済みファイルのデコード後"
  },
  "audio.loudness.stateLabel": {
    "zh-Hans": "测量状态：",
    "zh-Hant": "測量狀態：",
    "en": "Measurement state: ",
    "ja": "測定状態："
  },
  "audio.loudness.relativeGate": {
    "zh-Hans": "相对门限：",
    "zh-Hant": "相對閘值：",
    "en": "Relative gate: ",
    "ja": "相対ゲート値："
  },
  "audio.loudness.unavailable": {
    "zh-Hans": "不可用",
    "zh-Hant": "無法使用",
    "en": "Unavailable",
    "ja": "利用不可"
  },
  "audio.loudness.measuredAt": {
    "zh-Hans": "测量时间：",
    "zh-Hant": "測量時間：",
    "en": "Measured at: ",
    "ja": "測定日時："
  },
  "audio.loudness.another": {
    "zh-Hans": "另一文件正在测量，请等待或取消该观察。",
    "zh-Hant": "另一檔案正在測量，請等待或取消該觀察。",
    "en": "Another file is being measured. Wait or cancel that observation.",
    "ja": "別のファイルを測定中です。待つか、その観測をキャンセルしてください。"
  },
  "audio.loudness.reconnect": {
    "zh-Hans": "连接恢复后可明确发起测量。",
    "zh-Hant": "連線恢復後可明確發起測量。",
    "en": "You can explicitly start measurement after reconnecting.",
    "ja": "再接続後に測定を明示的に開始できます。"
  },
  "audio.loudness.peak.checkAgain": {
    "zh-Hans": "重新检查",
    "zh-Hant": "重新檢查",
    "en": "Check again",
    "ja": "再確認"
  },
  "audio.loudness.peak.check": {
    "zh-Hans": "检查",
    "zh-Hant": "檢查",
    "en": "Check",
    "ja": "確認"
  },
  "audio.loudness.peak.cancel": {
    "zh-Hans": "取消本次检查",
    "zh-Hant": "取消本次檢查",
    "en": "Cancel this check",
    "ja": "今回の確認をキャンセル"
  },
  "audio.loudness.peak.overall": {
    "zh-Hans": "总体：",
    "zh-Hant": "整體：",
    "en": "Overall: ",
    "ja": "全体："
  },
  "audio.loudness.peak.left": {
    "zh-Hans": "左声道：",
    "zh-Hant": "左聲道：",
    "en": "Left channel: ",
    "ja": "左チャンネル："
  },
  "audio.loudness.peak.right": {
    "zh-Hans": "右声道：",
    "zh-Hant": "右聲道：",
    "en": "Right channel: ",
    "ja": "右チャンネル："
  },
  "audio.loudness.peak.warning": {
    "zh-Hans": "此成片解码后的样本峰值超过 0 dBFS；可能存在过载风险。",
    "zh-Hant": "此成片解碼後的樣本峰值超過 0 dBFS；可能有過載風險。",
    "en": "This output's decoded sample peak exceeds 0 dBFS; overload may be a risk.",
    "ja": "この出力のデコード後サンプルピークは 0 dBFS を超えています。過負荷の可能性があります。"
  },
  "audio.loudness.peak.details": {
    "zh-Hans": "检查文件详情",
    "zh-Hant": "檢查檔案詳情",
    "en": "Checked file details",
    "ja": "確認したファイルの詳細"
  },
  "audio.loudness.peak.another": {
    "zh-Hans": "另一文件正在检查，请等待或取消该检查。",
    "zh-Hant": "另一檔案正在檢查，請等待或取消該檢查。",
    "en": "Another file is being checked. Wait or cancel that check.",
    "ja": "別のファイルを確認中です。待つか、その確認をキャンセルしてください。"
  },
  "audio.loudness.peak.reconnect": {
    "zh-Hans": "连接恢复后可明确发起检查。",
    "zh-Hant": "連線恢復後可明確發起檢查。",
    "en": "You can explicitly start a check after reconnecting.",
    "ja": "再接続後に確認を明示的に開始できます。"
  },
  "audio.loudness.mix.label": {
    "zh-Hans": "当前整片浮点混音与固定增益候选",
    "zh-Hant": "目前整片浮點混音與固定增益候選",
    "en": "Current full-timeline float mix and fixed-gain candidate",
    "ja": "現在のタイムライン全体の浮動小数点ミックスと固定ゲイン候補"
  },
  "audio.loudness.mix.limitation": {
    "zh-Hans": "仅测量当前已保存时间线的编码前浮点混音，不是已导出文件。准备测量不会修改音量或创建导出任务，应用须另行确认；不代表已实现逐段响度统一，也不保证 AAC 编码后的峰值。",
    "zh-Hant": "僅測量目前已儲存時間軸的編碼前浮點混音，並非已匯出檔案。準備測量不會修改音量或建立匯出工作，套用須另外確認；不代表已實現逐段響度一致，也不保證 AAC 編碼後的峰值。",
    "en": "Measures only the pre-encoding float mix of the currently saved timeline, not an exported file. Preparing measurement does not change volume or create an export task; applying requires separate confirmation. This does not provide per-clip loudness normalization or guarantee peaks after AAC encoding.",
    "ja": "現在保存済みのタイムラインのエンコード前の浮動小数点ミックスのみを測定し、書き出し済みファイルは測定しません。測定の準備では音量を変更せず、書き出しタスクも作成しません。適用は別途確認が必要です。クリップごとのラウドネス統一を実現するものではなく、AAC エンコード後のピークも保証しません。"
  },
  "audio.loudness.mix.targetHelp": {
    "zh-Hans": "请填写两个明确目标；不预设平台标准。真峰值比较额外预留 0.5 dB，准备结果保持只读，应用需另行核对确认。",
    "zh-Hant": "請填寫兩個明確目標；不預設平台標準。真峰值比較額外預留 0.5 dB，準備結果保持唯讀，套用須另外核對確認。",
    "en": "Enter both explicit targets; no platform standard is assumed. True-peak comparisons reserve an extra 0.5 dB. Prepared results remain read-only; applying requires a separate review and confirmation.",
    "ja": "2 つの目標値を明示的に入力してください。プラットフォームの基準はあらかじめ設定しません。トゥルーピーク比較には追加で 0.5 dB の余裕を設けます。準備結果は読み取り専用で、適用には別途確認が必要です。"
  },
  "audio.loudness.mix.prepare": {
    "zh-Hans": "准备并测量候选",
    "zh-Hant": "準備並測量候選",
    "en": "Prepare and measure candidate",
    "ja": "候補を準備して測定"
  },
  "audio.loudness.mix.prepareAgain": {
    "zh-Hans": "重新准备并测量",
    "zh-Hant": "重新準備並測量",
    "en": "Prepare and measure again",
    "ja": "再準備して測定"
  },
  "audio.loudness.mix.original": {
    "zh-Hans": "原始整片浮点混音",
    "zh-Hant": "原始整片浮點混音",
    "en": "Original full-timeline float mix",
    "ja": "元の全体浮動小数点ミックス"
  },
  "audio.loudness.mix.candidate": {
    "zh-Hans": "重新渲染的固定增益候选",
    "zh-Hant": "重新算繪的固定增益候選",
    "en": "Re-rendered fixed-gain candidate",
    "ja": "再レンダリングした固定ゲイン候補"
  },
  "audio.loudness.yes": {
    "zh-Hans": "是",
    "zh-Hant": "是",
    "en": "Yes",
    "ja": "はい"
  },
  "audio.loudness.no": {
    "zh-Hans": "否",
    "zh-Hant": "否",
    "en": "No",
    "ja": "いいえ"
  },
  "audio.loudness.mix.conflict": {
    "zh-Hans": "此固定增益候选未同时满足两个参考目标，未降低目标或限幅。",
    "zh-Hant": "此固定增益候選未同時滿足兩個參考目標，未降低目標或限幅。",
    "en": "This fixed-gain candidate does not meet both reference targets. Targets were not lowered and no limiter was applied.",
    "ja": "この固定ゲイン候補は両方の参照目標を満たしていません。目標を下げたり、リミッターを適用したりはしていません。"
  },
  "audio.loudness.mix.noLoudness": {
    "zh-Hans": "原混音没有可用的综合响度，无法计算固定增益。",
    "zh-Hant": "原混音沒有可用的綜合響度，無法計算固定增益。",
    "en": "The original mix has no usable integrated loudness, so fixed gain cannot be calculated.",
    "ja": "元のミックスで統合ラウドネスを算出できないため、固定ゲインを計算できません。"
  },
  "audio.loudness.mix.gainBounds": {
    "zh-Hans": "所需增益会使片段超出支持范围，未夹紧或修改增益。",
    "zh-Hant": "所需增益會使片段超出支援範圍，未限制或修改增益。",
    "en": "The required gain would put clips outside the supported range. Gain was not clamped or changed.",
    "ja": "必要ゲインを適用するとクリップが対応範囲を超えます。ゲインのクランプや変更は行っていません。"
  },
  "audio.loudness.mix.details": {
    "zh-Hans": "本次快照、来源与增益详情",
    "zh-Hant": "本次快照、來源與增益詳情",
    "en": "Snapshot, sources and gain details",
    "ja": "今回のスナップショット、ソース、ゲインの詳細"
  },
  "audio.loudness.mix.timelineId": {
    "zh-Hans": "时间线编号：",
    "zh-Hant": "時間軸編號：",
    "en": "Timeline ID: ",
    "ja": "タイムライン ID："
  },
  "audio.loudness.mix.profile": {
    "zh-Hans": "混音配置：",
    "zh-Hant": "混音設定：",
    "en": "Mix profile: ",
    "ja": "ミックスプロファイル："
  },
  "audio.loudness.mix.authority": {
    "zh-Hans": "来源字节与版本由后端核验；报告不授予应用权限。",
    "zh-Hant": "來源位元組與版本由後端核驗；報告不授予套用權限。",
    "en": "The backend verifies source bytes and revisions. The report does not grant permission to apply.",
    "ja": "ソースのバイト列とバージョンはバックエンドが検証します。レポートは適用権限を付与しません。"
  },
  "audio.loudness.apply.digesting": {
    "zh-Hans": "正在绑定本次报告与候选…",
    "zh-Hant": "正在繫結本次報告與候選…",
    "en": "Binding this report and candidate…",
    "ja": "今回のレポートと候補を関連付け中…"
  },
  "audio.loudness.apply.confirming": {
    "zh-Hans": "等待确认本次固定增益编辑。",
    "zh-Hant": "等待確認本次固定增益編輯。",
    "en": "Awaiting confirmation of this fixed-gain edit.",
    "ja": "今回の固定ゲイン編集の確認待ちです。"
  },
  "audio.loudness.apply.submitting": {
    "zh-Hans": "原请求正在准备、重新核验并应用，请等待确认。",
    "zh-Hant": "原請求正在準備、重新核驗並套用，請等待確認。",
    "en": "The original request is being prepared, revalidated and applied. Wait for confirmation.",
    "ja": "元のリクエストを準備、再検証、適用しています。確認をお待ちください。"
  },
  "audio.loudness.apply.unknown": {
    "zh-Hans": "应用结果待确认。原请求保留在任务中心，请恢复同一请求；不会生成新的应用编号。",
    "zh-Hant": "套用結果待確認。原請求保留在工作中心，請還原同一請求；不會產生新的套用編號。",
    "en": "The apply outcome awaits confirmation. The original request is retained in Task Center; recover that same request. No new apply ID will be created.",
    "ja": "適用結果は確認待ちです。元のリクエストをタスクセンターに保持しています。同じリクエストを復元してください。新しい適用 ID は作成しません。"
  },
  "audio.loudness.apply.applied": {
    "zh-Hans": "固定增益已作为一次时间线编辑保存，可用一次撤销恢复。请明确导出并重新测量成片。",
    "zh-Hant": "固定增益已儲存為一次時間軸編輯，可透過一次復原還原。請明確匯出並重新測量成片。",
    "en": "Fixed gain was saved as one timeline edit and can be reverted with one undo. Explicitly export and measure the output again.",
    "ja": "固定ゲインを 1 回のタイムライン編集として保存しました。1 回の取り消しで元に戻せます。明示的に書き出して、完成ファイルを再測定してください。"
  },
  "audio.loudness.apply.stale": {
    "zh-Hans": "本次确认已失效，请重新准备并核对候选。",
    "zh-Hant": "本次確認已失效，請重新準備並核對候選。",
    "en": "This confirmation is no longer valid. Prepare and review the candidate again.",
    "ja": "今回の確認は無効になりました。候補を再準備して確認してください。"
  },
  "audio.loudness.apply.label": {
    "zh-Hans": "应用固定增益候选",
    "zh-Hant": "套用固定增益候選",
    "en": "Apply fixed-gain candidate",
    "ja": "固定ゲイン候補を適用"
  },
  "audio.loudness.apply.review": {
    "zh-Hans": "核对并应用固定增益",
    "zh-Hant": "核對並套用固定增益",
    "en": "Review and apply fixed gain",
    "ja": "固定ゲインを確認して適用"
  },
  "audio.loudness.apply.original": {
    "zh-Hans": "核对原请求",
    "zh-Hant": "核對原請求",
    "en": "Check original request",
    "ja": "元のリクエストを確認"
  },
  "audio.loudness.apply.limitation": {
    "zh-Hans": "候选是整片编码前浮点混音，不是默认 v1 导出结果。应用只保存一组固定增益，可用一次撤销恢复；不会自动选择 v2 或导出，也不保证输出响度或 AAC 真峰值。需要明确选择浮点检查 v2 导出，再测量实际成片。",
    "zh-Hant": "候選是整片編碼前浮點混音，並非預設 v1 匯出結果。套用僅儲存一組固定增益，可透過一次復原還原；不會自動選擇 v2 或匯出，也不保證輸出響度或 AAC 真峰值。須明確選擇浮點檢查 v2 匯出，再測量實際成片。",
    "en": "The candidate is the full pre-encoding float mix, not the default v1 export result. Applying saves one set of fixed gains, reversible with one undo; it does not automatically select v2 or export, and does not guarantee output loudness or AAC true peak. Explicitly select float-check v2 export, then measure the actual output.",
    "ja": "候補は全体のエンコード前浮動小数点ミックスであり、既定の v1 書き出し結果ではありません。適用では 1 組の固定ゲインのみを保存し、1 回の取り消しで元に戻せます。v2 の自動選択や書き出しは行わず、出力ラウドネスや AAC のトゥルーピークも保証しません。浮動小数点検査 v2 を明示的に選んで書き出してから、実際の出力を測定してください。"
  },
  "export.history.storyboard": {
    "zh-Hans": {
      "one": "分镜顺序导出 · {count} 个镜头",
      "other": "分镜顺序导出 · {count} 个镜头"
    },
    "zh-Hant": {
      "one": "分鏡順序匯出 · {count} 個鏡頭",
      "other": "分鏡順序匯出 · {count} 個鏡頭"
    },
    "en": {
      "one": "Storyboard-order export · {count} shot",
      "other": "Storyboard-order export · {count} shots"
    },
    "ja": {
      "one": "絵コンテ順の書き出し · {count} ショット",
      "other": "絵コンテ順の書き出し · {count} ショット"
    }
  },
  "export.history.output": {
    "zh-Hans": "成片 · {dimensions} · {fps} fps · {rate}{upscale} · AAC 128 kb/s",
    "zh-Hant": "成片 · {dimensions} · {fps} fps · {rate}{upscale} · AAC 128 kb/s",
    "en": "Output · {dimensions} · {fps} fps · {rate}{upscale} · AAC 128 kb/s",
    "ja": "出力 · {dimensions} · {fps} fps · {rate}{upscale} · AAC 128 kb/s"
  },
  "export.history.legacyOutput": {
    "zh-Hans": "成片 · {dimensions} · {fps} fps · {rate}{upscale}",
    "zh-Hant": "成片 · {dimensions} · {fps} fps · {rate}{upscale}",
    "en": "Output · {dimensions} · {fps} fps · {rate}{upscale}",
    "ja": "出力 · {dimensions} · {fps} fps · {rate}{upscale}"
  },
  "export.history.timelineRevision": {
    "zh-Hans": "时间线导出 · 修订版 {revision}{snapshot}",
    "zh-Hant": "時間軸匯出 · 修訂版 {revision}{snapshot}",
    "en": "Timeline export · revision {revision}{snapshot}",
    "ja": "タイムライン書き出し · リビジョン {revision}{snapshot}"
  },
  "export.history.safeError": {
    "zh-Hans": "此导出遇到问题，请核对原记录与当前状态。",
    "zh-Hant": "此匯出遇到問題，請核對原記錄與目前狀態。",
    "en": "This export encountered a problem. Check the original record and current status.",
    "ja": "この書き出しで問題が発生しました。元の記録と現在の状態を確認してください。"
  },
  "export.settings.rateTarget": {
    "zh-Hans": "平均目标 {rate} Mb/s",
    "zh-Hant": "平均目標 {rate} Mb/s",
    "en": "Average target {rate} Mb/s",
    "ja": "平均目標 {rate} Mb/s"
  },
  "export.range.extent": {
    "zh-Hans": "已保存时间线共 {frames} 帧",
    "zh-Hant": "已儲存時間軸共 {frames} 影格",
    "en": "Saved timeline: {frames} frames",
    "ja": "保存済みタイムライン：{frames} フレーム"
  },
  "export.range.fixed": {
    "zh-Hans": "固定 30 fps · {extent}",
    "zh-Hant": "固定 30 fps · {extent}",
    "en": "Fixed 30 fps · {extent}",
    "ja": "固定 30 fps · {extent}"
  },
  "export.range.output": {
    "zh-Hans": "本次范围 [{start}, {end}) · {frames} 帧 · {seconds} 秒",
    "zh-Hant": "本次範圍 [{start}, {end}) · {frames} 影格 · {seconds} 秒",
    "en": "This range [{start}, {end}) · {frames} frames · {seconds} seconds",
    "ja": "今回の範囲 [{start}, {end}) · {frames} フレーム · {seconds} 秒"
  },
  "export.range.summary": {
    "zh-Hans": "第 {start} 帧（含）至第 {end} 帧（不含） · {frames} 帧 · {seconds} 秒 · 30 fps",
    "zh-Hant": "第 {start} 影格（含）至第 {end} 影格（不含） · {frames} 影格 · {seconds} 秒 · 30 fps",
    "en": "Frame {start} (inclusive) to {end} (exclusive) · {frames} frames · {seconds} seconds · 30 fps",
    "ja": "フレーム {start}（含む）～{end}（含まない） · {frames} フレーム · {seconds} 秒 · 30 fps"
  },
  "export.preflight.assetRef": {
    "zh-Hans": " · 素材 {id}",
    "zh-Hant": " · 素材 {id}",
    "en": " · Asset {id}",
    "ja": " · 素材 {id}"
  },
  "export.preflight.clipRef": {
    "zh-Hans": " · 片段 {id}",
    "zh-Hant": " · 片段 {id}",
    "en": " · Clip {id}",
    "ja": " · クリップ {id}"
  },
  "export.preflight.durationValue": {
    "zh-Hans": "{seconds} 秒 · {frames} 帧",
    "zh-Hant": "{seconds} 秒 · {frames} 影格",
    "en": "{seconds} seconds · {frames} frames",
    "ja": "{seconds} 秒 · {frames} フレーム"
  },
  "export.preflight.subtitleScope": {
    "zh-Hans": "字幕：{status}。本次不测量实际文字宽高；渲染时逐条测量，超出安全区域会拒绝导出，不缩小、换行或截断文字。",
    "zh-Hant": "字幕：{status}。本次不測量實際文字寬高；算繪時逐條測量，超出安全區域將拒絕匯出，不會縮小、換行或截斷文字。",
    "en": "Subtitles: {status}. Actual text width and height are not measured now. Each subtitle is measured when rendering; text outside the safe area blocks export rather than being shrunk, wrapped or truncated.",
    "ja": "字幕：{status}。今回は実際の文字の幅と高さを測定しません。レンダリング時に字幕ごとに測定し、安全領域を超える場合は書き出しを拒否します。文字の縮小、折り返し、切り詰めは行いません。"
  },
  "export.preflight.checkedAssets": {
    "zh-Hans": "已检查 {checked} / {total} 个素材 · 已校验 {bytes}",
    "zh-Hant": "已檢查 {checked} / {total} 個素材 · 已驗證 {bytes}",
    "en": "Checked {checked} / {total} assets · Verified {bytes}",
    "ja": "素材 {checked} / {total} 件を確認 · {bytes} を検証済み"
  },
  "recovery.backup.schema": {
    "zh-Hans": "数据库记录 · 版本 {version}",
    "zh-Hant": "資料庫記錄 · 版本 {version}",
    "en": "Database records · Version {version}",
    "ja": "データベース記録 · バージョン {version}"
  },
  "recovery.backup.capacityDetails": {
    "zh-Hans": "数据库 {database} · 文件 {files} 个 · 单文件 {file} · 总计 {total}。实际文件范围与磁盘空间须由离线命令再次核对。",
    "zh-Hant": "資料庫 {database} · 檔案 {files} 個 · 單檔 {file} · 總計 {total}。實際檔案範圍與磁碟空間須由離線命令再次核對。",
    "en": "Database {database} · {files} files · {file} per file · {total} total. The offline command must recheck the actual file scope and disk space.",
    "ja": "データベース {database} · ファイル {files} 件 · 1 ファイル {file} · 合計 {total}。実際のファイル範囲とディスク空き容量はオフラインコマンドで再確認が必要です。"
  },
  "recovery.restored.historyCount": {
    "zh-Hans": {
      "one": "{availability} · 保留 {count} 条历史记录",
      "other": "{availability} · 保留 {count} 条历史记录"
    },
    "zh-Hant": {
      "one": "{availability} · 保留 {count} 筆歷史記錄",
      "other": "{availability} · 保留 {count} 筆歷史記錄"
    },
    "en": {
      "one": "{availability} · {count} historical record retained",
      "other": "{availability} · {count} historical records retained"
    },
    "ja": {
      "one": "{availability} · 履歴 {count} 件を保持",
      "other": "{availability} · 履歴 {count} 件を保持"
    }
  },
  "recovery.restored.created": {
    "zh-Hans": "恢复分支创建时间：{time}",
    "zh-Hant": "還原分支建立時間：{time}",
    "en": "Restored branch created: {time}",
    "ja": "復元ブランチの作成日時：{time}"
  },
  "recovery.restored.source": {
    "zh-Hans": "来源备份：{id}",
    "zh-Hant": "來源備份：{id}",
    "en": "Source backup: {id}",
    "ja": "復元元バックアップ：{id}"
  },
  "recovery.restored.origin": {
    "zh-Hans": "分支来源：{origin}",
    "zh-Hant": "分支來源：{origin}",
    "en": "Branch origin: {origin}",
    "ja": "ブランチの元情報：{origin}"
  },
  "recovery.storage.durableCount": {
    "zh-Hans": "{count} 类本地编辑请求由现有 SQLite 任务台账保留原编号与完整参数。最多保留 4096 个请求身份，已完成并关闭的记录也占容量；尚未提供归档或槽位清理，不会自动删除旧身份。达到上限会阻止新建此类任务，不表示磁盘已满，也不是整个数据库或 WAL 的大小上限。",
    "zh-Hant": "{count} 類本機編輯請求由既有 SQLite 工作台帳保留原編號與完整參數。最多保留 4096 個請求身分，已完成並關閉的記錄也占容量；尚未提供封存或槽位清理，不會自動刪除舊身分。達到上限將阻止建立此類新工作，不表示磁碟已滿，也不是整個資料庫或 WAL 的大小上限。",
    "en": "The existing SQLite task ledger retains original IDs and complete parameters for {count} types of local edit requests. It holds up to 4096 request identities, including completed and closed records. Archiving and slot cleanup are not yet available; old identities are not automatically deleted. Reaching the limit blocks new tasks of these types. It does not mean the disk is full or limit the entire database or WAL size.",
    "ja": "{count} 種類のローカル編集リクエストについて、既存の SQLite タスク台帳が元 ID と全パラメーターを保持します。最大 4096 件のリクエスト識別情報を保持し、完了して閉じた記録も容量を使います。アーカイブや枠の整理機能はまだなく、古い識別情報は自動削除しません。上限に達すると該当する新規タスクを作成できませんが、ディスクが満杯という意味でも、データベース全体や WAL のサイズ上限でもありません。"
  },
  "recovery.clip.saved": {
    "zh-Hans": "本地草稿已保存{time}",
    "zh-Hant": "本機草稿已儲存{time}",
    "en": "Local draft saved{time}",
    "ja": "ローカル下書きを保存しました{time}"
  },
  "recovery.clip.candidate": {
    "zh-Hans": "有可恢复的本地草稿{time}",
    "zh-Hant": "有可還原的本機草稿{time}",
    "en": "A local draft can be recovered{time}",
    "ja": "復元できるローカル下書きがあります{time}"
  },
  "recovery.delivery.saved": {
    "zh-Hans": "本地名称已保存{time}",
    "zh-Hant": "本機名稱已儲存{time}",
    "en": "Name saved locally{time}",
    "ja": "名前をローカルに保存しました{time}"
  },
  "recovery.delivery.provenanceValue": {
    "zh-Hans": "原时间线 {timeline} · 草稿 {draft}",
    "zh-Hant": "原時間軸 {timeline} · 草稿 {draft}",
    "en": "Original timeline {timeline} · Draft {draft}",
    "ja": "元のタイムライン {timeline} · 下書き {draft}"
  },
  "recovery.delivery.baseline": {
    "zh-Hans": "此名称来自原时间线的 修订版 {revision}，与当前时间线不同。原版本保留，不能直接用于当前检查。",
    "zh-Hant": "此名稱來自原時間軸的 修訂版 {revision}，與目前時間軸不同。原版本仍保留，不能直接用於目前檢查。",
    "en": "This name comes from revision {revision} of the original timeline, which differs from the current timeline. The original revision is retained and cannot be used directly for the current check.",
    "ja": "この名前は元のタイムラインの リビジョン {revision} に由来し、現在のタイムラインとは異なります。元のバージョンは保持しますが、今回の確認にはそのまま使用できません。"
  },
  "recovery.delivery.retryName": {
    "zh-Hans": "待确认保存的原名称：",
    "zh-Hant": "待確認儲存的原名稱：",
    "en": "Original name awaiting save confirmation: ",
    "ja": "保存の確認待ちの元の名前："
  },
  "recovery.delivery.originalProfile": {
    "zh-Hans": "原时间线 修订版 {revision} · {profile}",
    "zh-Hant": "原時間軸 修訂版 {revision} · {profile}",
    "en": "Original timeline revision {revision} · {profile}",
    "ja": "元のタイムライン リビジョン {revision} · {profile}"
  },
  "recovery.delivery.requestDetails": {
    "zh-Hans": "请求 {request} · 原时间线 {timeline}",
    "zh-Hant": "請求 {request} · 原時間軸 {timeline}",
    "en": "Request {request} · Original timeline {timeline}",
    "ja": "リクエスト {request} · 元のタイムライン {timeline}"
  },
  "recovery.text.saved": {
    "zh-Hans": "文字草稿已保存在本地{time}",
    "zh-Hant": "文字草稿已儲存在本機{time}",
    "en": "Text draft saved locally{time}",
    "ja": "テキスト下書きをローカルに保存しました{time}"
  },
  "recovery.text.provenance": {
    "zh-Hans": "查看提示词与草稿来源 · 修订版 {revision}",
    "zh-Hant": "查看提示詞與草稿來源 · 修訂版 {revision}",
    "en": "View prompt and draft provenance · revision {revision}",
    "ja": "プロンプトと下書きの元情報を表示 · リビジョン {revision}"
  },
  "recovery.text.draftIdentity": {
    "zh-Hans": "草稿 {draft} · {time}",
    "zh-Hant": "草稿 {draft} · {time}",
    "en": "Draft {draft} · {time}",
    "ja": "下書き {draft} · {time}"
  },
  "recovery.text.baseline": {
    "zh-Hans": "文字来自 修订版 {revision}，当前镜头已变化。原版本仍保留，请核对当前保存内容后再继续。",
    "zh-Hant": "文字來自 修訂版 {revision}，目前鏡頭已變更。原版本仍保留，請核對目前儲存內容後再繼續。",
    "en": "This text comes from revision {revision}; the current shot has changed. The original revision is retained. Review the currently saved content before continuing.",
    "ja": "テキストは リビジョン {revision} に由来し、現在のショットは変更されています。元のバージョンは保持します。続行前に現在の保存内容を確認してください。"
  },
  "recovery.text.originalDetails": {
    "zh-Hans": "查看原请求与精确文字 · 修订版 {revision}",
    "zh-Hant": "查看原請求與精確文字 · 修訂版 {revision}",
    "en": "View original request and exact text · revision {revision}",
    "ja": "元のリクエストと正確なテキストを表示 · リビジョン {revision}"
  },
  "recovery.text.requestId": {
    "zh-Hans": "请求 {request}",
    "zh-Hant": "請求 {request}",
    "en": "Request {request}",
    "ja": "リクエスト {request}"
  },
  "audio.loudness.silence": {
    "zh-Hans": "−∞ {unit}（数字静音）",
    "zh-Hant": "−∞ {unit}（數位靜音）",
    "en": "−∞ {unit} (digital silence)",
    "ja": "−∞ {unit}（デジタル無音）"
  },
  "audio.loudness.targetValue": {
    "zh-Hans": "本次参考目标：{lufs} LUFS · 上限 {peak} dBTP",
    "zh-Hant": "本次參考目標：{lufs} LUFS · 上限 {peak} dBTP",
    "en": "Reference targets: {lufs} LUFS · Ceiling {peak} dBTP",
    "ja": "今回の参照目標：{lufs} LUFS · 上限 {peak} dBTP"
  },
  "audio.loudness.advice": {
    "zh-Hans": "达到参考响度所需增益（算术）：{gain} dB；真峰值可用余量（已预留0.5 dB）：{room} dB。",
    "zh-Hant": "達到參考響度所需增益（算術）：{gain} dB；真峰值可用餘量（已預留 0.5 dB）：{room} dB。",
    "en": "Gain needed to reach reference loudness (arithmetic): {gain} dB; available true-peak headroom (0.5 dB reserved): {room} dB.",
    "ja": "参照ラウドネスに必要なゲイン（算術値）：{gain} dB。利用可能なトゥルーピーク余裕（0.5 dB 確保済み）：{room} dB。"
  },
  "audio.loudness.frozenRevision": {
    "zh-Hans": "冻结修订版：{revision}",
    "zh-Hant": "凍結修訂版：{revision}",
    "en": "Frozen revision: {revision}",
    "ja": "固定リビジョン：{revision}"
  },
  "audio.loudness.frozenRange": {
    "zh-Hans": "冻结范围：第 {start} 帧（含）至第 {end} 帧（不含）",
    "zh-Hant": "凍結範圍：第 {start} 影格（含）至第 {end} 影格（不含）",
    "en": "Frozen range: frame {start} (inclusive) to {end} (exclusive)",
    "ja": "固定範囲：フレーム {start}（含む）～{end}（含まない）"
  },
  "audio.loudness.sampleFrames": {
    "zh-Hans": "解码样本帧：{frames} · 48 kHz · 双声道",
    "zh-Hant": "解碼樣本影格：{frames} · 48 kHz · 雙聲道",
    "en": "Decoded sample frames: {frames} · 48 kHz · Stereo",
    "ja": "デコード済みサンプルフレーム：{frames} · 48 kHz · ステレオ"
  },
  "audio.loudness.duration": {
    "zh-Hans": "解码时长：{seconds} 秒",
    "zh-Hant": "解碼長度：{seconds} 秒",
    "en": "Decoded duration: {seconds} seconds",
    "ja": "デコード時間：{seconds} 秒"
  },
  "audio.loudness.gating": {
    "zh-Hans": "门限块：全部 {all}；绝对门限后 {absolute}；相对门限后 {relative}",
    "zh-Hant": "閘值區塊：全部 {all}；絕對閘值後 {absolute}；相對閘值後 {relative}",
    "en": "Gating blocks: all {all}; after absolute gate {absolute}; after relative gate {relative}",
    "ja": "ゲートブロック：全体 {all}、絶対ゲート後 {absolute}、相対ゲート後 {relative}"
  },
  "audio.loudness.linearPeaks": {
    "zh-Hans": "线性峰值：样本 {sample}；真峰值估算 {truePeak}",
    "zh-Hant": "線性峰值：樣本 {sample}；真峰值估算 {truePeak}",
    "en": "Linear peaks: sample {sample}; estimated true peak {truePeak}",
    "ja": "線形ピーク：サンプル {sample}、推定トゥルーピーク {truePeak}"
  },
  "audio.loudness.projection": {
    "zh-Hans": "算术倍率：{multiplier}；投影真峰值：{peak} dBTP。余量计算另扣 {margin} dB 的应用参考预留，不保证编码安全。",
    "zh-Hant": "算術倍率：{multiplier}；投影真峰值：{peak} dBTP。餘量計算另扣 {margin} dB 的套用參考預留，不保證編碼安全。",
    "en": "Arithmetic multiplier: {multiplier}; projected true peak: {peak} dBTP. Headroom calculations deduct an additional {margin} dB reference margin for applying gain; encoding safety is not guaranteed.",
    "ja": "算術倍率：{multiplier}。予測トゥルーピーク：{peak} dBTP。余裕の計算では適用時の参考マージン {margin} dB を追加で差し引きます。エンコードの安全性は保証しません。"
  },
  "audio.loudness.peak.checked": {
    "zh-Hans": "已解码检查此成片 ·",
    "zh-Hant": "已解碼檢查此成片 ·",
    "en": "Decoded and checked this output ·",
    "ja": "この出力をデコードして確認済み ·"
  },
  "audio.loudness.peak.linear": {
    "zh-Hans": "线性峰值：总体 {overall}；左 {left}；右 {right}",
    "zh-Hant": "線性峰值：整體 {overall}；左 {left}；右 {right}",
    "en": "Linear peaks: overall {overall}; left {left}; right {right}",
    "ja": "線形ピーク：全体 {overall}、左 {left}、右 {right}"
  },
  "audio.loudness.mix.peaks": {
    "zh-Hans": "真峰值估算 {truePeak} · 样本峰值 {sample}",
    "zh-Hant": "真峰值估算 {truePeak} · 樣本峰值 {sample}",
    "en": "Estimated true peak {truePeak} · Sample peak {sample}",
    "ja": "推定トゥルーピーク {truePeak} · サンプルピーク {sample}"
  },
  "audio.loudness.mix.scope": {
    "zh-Hans": "完整已保存时间线：第 0 帧至第 {end} 帧（不含）· 修订版 {revision}。始终测量整片，不使用本次所选导出范围。",
    "zh-Hant": "完整已儲存時間軸：第 0 影格至第 {end} 影格（不含）· 修訂版 {revision}。一律測量整片，不使用本次所選匯出範圍。",
    "en": "Entire saved timeline: frame 0 to {end} (exclusive) · revision {revision}. Always measures the full timeline, not the selected export range.",
    "ja": "保存済みタイムライン全体：フレーム 0～{end}（含まない）· リビジョン {revision}。常に全体を測定し、今回選択した書き出し範囲は使いません。"
  },
  "audio.loudness.mix.target": {
    "zh-Hans": "本次目标：{lufs} LUFS · 上限 {peak} dBTP；额外预留 {margin} dB（应用参考余量）。",
    "zh-Hant": "本次目標：{lufs} LUFS · 上限 {peak} dBTP；額外預留 {margin} dB（套用參考餘量）。",
    "en": "Targets: {lufs} LUFS · Ceiling {peak} dBTP; extra {margin} dB reserved as reference headroom for applying gain.",
    "ja": "今回の目標：{lufs} LUFS · 上限 {peak} dBTP。適用時の参考余裕として追加で {margin} dB を確保。"
  },
  "audio.loudness.mix.gain": {
    "zh-Hans": "单一固定增益：{gain} dB · ×{multiplier}，覆盖 {count} 个可听片段。",
    "zh-Hant": "單一固定增益：{gain} dB · ×{multiplier}，涵蓋 {count} 個可聽片段。",
    "en": "Single fixed gain: {gain} dB · ×{multiplier}, covering {count} audible clips.",
    "ja": "単一の固定ゲイン：{gain} dB · ×{multiplier}。音声が有効な {count} クリップが対象です。"
  },
  "audio.loudness.mix.comparison": {
    "zh-Hans": "候选实测与目标相差≤0.1 LU：{target}；真峰值含 0.5 dB 预留后满足上限：{peak}。",
    "zh-Hant": "候選實測與目標相差≤0.1 LU：{target}；真峰值包含 0.5 dB 預留後符合上限：{peak}。",
    "en": "Measured candidate within 0.1 LU of target: {target}; true peak within ceiling including 0.5 dB reserve: {peak}.",
    "ja": "候補の実測値と目標との差が 0.1 LU 以内：{target}。0.5 dB の余裕を含めトゥルーピークが上限内：{peak}。"
  },
  "audio.loudness.mix.unavailable": {
    "zh-Hans": "候选不可用：{reason}",
    "zh-Hant": "候選無法使用：{reason}",
    "en": "Candidate unavailable: {reason}",
    "ja": "候補を利用できません：{reason}"
  },
  "audio.loudness.mix.savedRevision": {
    "zh-Hans": "已保存修订版：{revision}",
    "zh-Hant": "已儲存修訂版：{revision}",
    "en": "Saved revision: {revision}",
    "ja": "保存済みリビジョン：{revision}"
  },
  "audio.loudness.mix.fullRange": {
    "zh-Hans": "完整区间：第 0 帧至第 {end} 帧（不含）",
    "zh-Hant": "完整區間：第 0 影格至第 {end} 影格（不含）",
    "en": "Full range: frame 0 to {end} (exclusive)",
    "ja": "全範囲：フレーム 0～{end}（含まない）"
  },
  "audio.loudness.mix.fullSamples": {
    "zh-Hans": "每次完整测量：{frames} 样本帧 · 48 kHz · 双声道",
    "zh-Hant": "每次完整測量：{frames} 樣本影格 · 48 kHz · 雙聲道",
    "en": "Each full measurement: {frames} sample frames · 48 kHz · Stereo",
    "ja": "各全体測定：{frames} サンプルフレーム · 48 kHz · ステレオ"
  },
  "audio.loudness.mix.source": {
    "zh-Hans": "来源 {id}",
    "zh-Hant": "來源 {id}",
    "en": "Source {id}",
    "ja": "ソース {id}"
  },
  "audio.loudness.mix.bytes": {
    "zh-Hans": "{bytes} 字节",
    "zh-Hant": "{bytes} 位元組",
    "en": "{bytes} bytes",
    "ja": "{bytes} バイト"
  },
  "audio.loudness.mix.clipGain": {
    "zh-Hans": "片段 {id}：{before} → {after}",
    "zh-Hant": "片段 {id}：{before} → {after}",
    "en": "Clip {id}: {before} → {after}",
    "ja": "クリップ {id}：{before} → {after}"
  },
  "audio.loudness.export.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后明确重新测量。",
    "zh-Hant": "工作階段已過期，請重新登入後明確重新測量。",
    "en": "Your session expired. Sign in again, then explicitly measure again.",
    "ja": "セッションの有効期限が切れました。再ログインしてから明示的に再測定してください。"
  },
  "audio.loudness.export.protocol": {
    "zh-Hans": "测量响应不完整或与此导出文件、目标不匹配，请重新测量。",
    "zh-Hant": "測量回應不完整，或與此匯出檔案、目標不符，請重新測量。",
    "en": "The measurement response is incomplete or does not match this exported file and targets. Measure again.",
    "ja": "測定応答が不完全、またはこの書き出しファイルや目標と一致しません。再測定してください。"
  },
  "audio.loudness.export.failed": {
    "zh-Hans": "测量未完成，请确认连接后重新测量。",
    "zh-Hant": "測量未完成，請確認連線後重新測量。",
    "en": "Measurement did not complete. Check the connection and measure again.",
    "ja": "測定が完了しませんでした。接続を確認して再測定してください。"
  },
  "audio.loudness.export.measuring": {
    "zh-Hans": "正在测量此已导出文件的响度与真峰值…",
    "zh-Hant": "正在測量此已匯出檔案的響度與真峰值…",
    "en": "Measuring this exported file's loudness and true peak…",
    "ja": "この書き出し済みファイルのラウドネスとトゥルーピークを測定中…"
  },
  "audio.loudness.export.cancelled": {
    "zh-Hans": "本次测量观察已取消，需要时请明确重新测量。",
    "zh-Hant": "本次測量觀察已取消，需要時請明確重新測量。",
    "en": "This measurement observation was cancelled. Explicitly measure again if needed.",
    "ja": "今回の測定観測をキャンセルしました。必要に応じて明示的に再測定してください。"
  },
  "audio.loudness.export.stale": {
    "zh-Hans": "导出文件记录已变化，请重新测量。",
    "zh-Hant": "匯出檔案記錄已變更，請重新測量。",
    "en": "The exported file record changed. Measure again.",
    "ja": "書き出しファイルの記録が変わりました。再測定してください。"
  },
  "audio.loudness.peak.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后明确重新检查。",
    "zh-Hant": "工作階段已過期，請重新登入後明確重新檢查。",
    "en": "Your session expired. Sign in again, then explicitly check again.",
    "ja": "セッションの有効期限が切れました。再ログインしてから明示的に再確認してください。"
  },
  "audio.loudness.peak.protocol": {
    "zh-Hans": "检查响应不完整或与此导出文件不匹配，请重新检查。",
    "zh-Hant": "檢查回應不完整，或與此匯出檔案不符，請重新檢查。",
    "en": "The check response is incomplete or does not match this exported file. Check again.",
    "ja": "確認応答が不完全、またはこの書き出しファイルと一致しません。再確認してください。"
  },
  "audio.loudness.peak.failed": {
    "zh-Hans": "检查未完成，请确认连接后重新检查。",
    "zh-Hant": "檢查未完成，請確認連線後重新檢查。",
    "en": "The check did not complete. Check the connection and try again.",
    "ja": "確認が完了しませんでした。接続を確認してやり直してください。"
  },
  "audio.loudness.peak.checking": {
    "zh-Hans": "正在检查已导出文件解码样本峰值…",
    "zh-Hant": "正在檢查已匯出檔案解碼樣本峰值…",
    "en": "Checking the exported file's decoded sample peak…",
    "ja": "書き出し済みファイルのデコード後サンプルピークを確認中…"
  },
  "audio.loudness.peak.cancelled": {
    "zh-Hans": "本次检查已取消，需要时请重新检查。",
    "zh-Hant": "本次檢查已取消，需要時請重新檢查。",
    "en": "This check was cancelled. Check again if needed.",
    "ja": "今回の確認をキャンセルしました。必要に応じて再確認してください。"
  },
  "audio.loudness.peak.stale": {
    "zh-Hans": "导出文件记录已变化，请重新检查。",
    "zh-Hant": "匯出檔案記錄已變更，請重新檢查。",
    "en": "The exported file record changed. Check again.",
    "ja": "書き出しファイルの記録が変わりました。再確認してください。"
  },
  "audio.loudness.reason.NO_AUDIO": {
    "zh-Hans": "此导出文件没有音轨，不能当作数字静音。",
    "zh-Hant": "此匯出檔案沒有音軌，不可視為數位靜音。",
    "en": "This exported file has no audio track; that is not digital silence.",
    "ja": "この書き出しファイルに音声トラックはありません。デジタル無音とは扱えません。"
  },
  "audio.loudness.reason.UNSUPPORTED_FORMAT": {
    "zh-Hans": "此检查仅支持完整托管 MP4 的唯一 AAC、48 kHz 双声道音轨。",
    "zh-Hant": "此檢查僅支援完整受管理 MP4 中唯一的 AAC、48 kHz 雙聲道音軌。",
    "en": "This check supports only a single AAC, 48 kHz stereo track in a fully managed MP4.",
    "ja": "この検査は、完全に管理された MP4 内の単一の AAC、48 kHz、ステレオ音声トラックにのみ対応しています。"
  },
  "audio.loudness.reason.INPUT_TOO_LARGE": {
    "zh-Hans": "此文件超过 512 MiB 检查上限。",
    "zh-Hant": "此檔案超過 512 MiB 檢查上限。",
    "en": "This file exceeds the 512 MiB check limit.",
    "ja": "このファイルは検査上限の 512 MiB を超えています。"
  },
  "audio.loudness.reason.DURATION_LIMIT": {
    "zh-Hans": "此文件超过 600 秒检查上限。",
    "zh-Hant": "此檔案超過 600 秒檢查上限。",
    "en": "This file exceeds the 600-second check limit.",
    "ja": "このファイルは検査上限の 600 秒を超えています。"
  },
  "audio.loudness.reason.BUSY": {
    "zh-Hans": "另一个导出音频检查仍在运行或清理，本次未排队。",
    "zh-Hant": "另一個匯出音訊檢查仍在執行或清理，本次未加入佇列。",
    "en": "Another exported-audio check is still running or cleaning up. This request was not queued.",
    "ja": "別の書き出し音声検査が実行中または後処理中です。今回のリクエストはキューに入れていません。"
  },
  "audio.loudness.reason.TIMEOUT": {
    "zh-Hans": "检查超时，未获得完整测量。",
    "zh-Hant": "檢查逾時，未取得完整測量。",
    "en": "The check timed out; no complete measurement was obtained.",
    "ja": "確認がタイムアウトし、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.reason.RESOURCE_LIMIT": {
    "zh-Hans": "检查达到资源上限，未获得完整测量。",
    "zh-Hant": "檢查達到資源上限，未取得完整測量。",
    "en": "The check reached its resource limit; no complete measurement was obtained.",
    "ja": "確認がリソース上限に達し、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.reason.DECODER_UNAVAILABLE": {
    "zh-Hans": "本地解码器不可用，未获得完整测量。",
    "zh-Hant": "本機解碼器無法使用，未取得完整測量。",
    "en": "The local decoder is unavailable; no complete measurement was obtained.",
    "ja": "ローカルのデコーダーを利用できず、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.reason.INVALID_PCM": {
    "zh-Hans": "音频不完整、含无效样本或时长不符，未获得完整测量。",
    "zh-Hant": "音訊不完整、含無效樣本或長度不符，未取得完整測量。",
    "en": "Audio is incomplete, contains invalid samples or has a duration mismatch. No complete measurement was obtained.",
    "ja": "音声が不完全、無効なサンプルを含む、または長さが一致しないため、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.reason.DECODE_FAILED": {
    "zh-Hans": "文件未能完整解码，未获得完整测量。",
    "zh-Hant": "檔案未能完整解碼，未取得完整測量。",
    "en": "The file could not be fully decoded; no complete measurement was obtained.",
    "ja": "ファイルを完全にデコードできず、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.reason.CANCELLED": {
    "zh-Hans": "本次检查已停止，未获得完整测量。",
    "zh-Hant": "本次檢查已停止，未取得完整測量。",
    "en": "This check stopped; no complete measurement was obtained.",
    "ja": "今回の確認を停止し、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.reason.SHUTDOWN": {
    "zh-Hans": "后端正在关闭，本次检查未完成。",
    "zh-Hant": "後端正在關閉，本次檢查未完成。",
    "en": "The backend is shutting down; this check did not complete.",
    "ja": "バックエンドが終了中のため、今回の確認は完了しませんでした。"
  },
  "audio.loudness.reason.ARTIFACT_CHANGED": {
    "zh-Hans": "所选导出文件的身份、内容或归属变化，结果已丢弃。",
    "zh-Hant": "所選匯出檔案的身分、內容或歸屬已變更，結果已捨棄。",
    "en": "The selected exported file's identity, content or ownership changed; the result was discarded.",
    "ja": "選択した書き出しファイルの識別情報、内容、または所属が変わったため、結果を破棄しました。"
  },
  "audio.loudness.peak.reason.OVER_FULL_SCALE": {
    "zh-Hans": "已导出文件解码样本峰值超过 0 dBFS；这不表示削波次数，也不保证其他播放或制作阶段的结果。",
    "zh-Hant": "已匯出檔案解碼樣本峰值超過 0 dBFS；這不代表削波次數，也不保證其他播放或製作階段的結果。",
    "en": "The exported file's decoded sample peak exceeds 0 dBFS. This is not a clipping count and does not guarantee results at other playback or production stages.",
    "ja": "書き出し済みファイルのデコード後サンプルピークは 0 dBFS を超えています。これはクリッピングの回数ではなく、他の再生や制作段階の結果も保証しません。"
  },
  "audio.loudness.peak.reason.UNSUPPORTED_FORMAT": {
    "zh-Hans": "此导出文件的音频格式暂不支持已导出文件解码样本峰值检查。",
    "zh-Hant": "此匯出檔案的音訊格式暫不支援已匯出檔案解碼樣本峰值檢查。",
    "en": "This exported file's audio format does not currently support decoded sample-peak checking.",
    "ja": "この書き出しファイルの音声形式は、現在デコード後サンプルピーク検査に対応していません。"
  },
  "audio.loudness.peak.reason.INPUT_TOO_LARGE": {
    "zh-Hans": "此导出文件超过已导出文件解码样本峰值检查的文件大小上限。",
    "zh-Hant": "此匯出檔案超過已匯出檔案解碼樣本峰值檢查的檔案大小上限。",
    "en": "This exported file exceeds the file-size limit for decoded sample-peak checking.",
    "ja": "この書き出しファイルはデコード後サンプルピーク検査のファイルサイズ上限を超えています。"
  },
  "audio.loudness.peak.reason.DURATION_LIMIT": {
    "zh-Hans": "此导出文件超过已导出文件解码样本峰值检查的时长上限。",
    "zh-Hant": "此匯出檔案超過已匯出檔案解碼樣本峰值檢查的長度上限。",
    "en": "This exported file exceeds the duration limit for decoded sample-peak checking.",
    "ja": "この書き出しファイルはデコード後サンプルピーク検査の時間上限を超えています。"
  },
  "audio.loudness.peak.reason.BUSY": {
    "zh-Hans": "已有已导出文件解码样本峰值检查正在运行；本次未排队。",
    "zh-Hant": "已有已匯出檔案解碼樣本峰值檢查正在執行；本次未加入佇列。",
    "en": "An exported-file decoded sample-peak check is running; this request was not queued.",
    "ja": "書き出し済みファイルのデコード後サンプルピーク検査が実行中です。今回のリクエストはキューに入れていません。"
  },
  "audio.loudness.peak.reason.TIMEOUT": {
    "zh-Hans": "已导出文件解码样本峰值检查超时，未获得完整测量。",
    "zh-Hant": "已匯出檔案解碼樣本峰值檢查逾時，未取得完整測量。",
    "en": "The exported-file decoded sample-peak check timed out; no complete measurement was obtained.",
    "ja": "書き出し済みファイルのデコード後サンプルピーク検査がタイムアウトし、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.peak.reason.RESOURCE_LIMIT": {
    "zh-Hans": "已导出文件解码样本峰值检查达到资源上限，未获得完整测量。",
    "zh-Hant": "已匯出檔案解碼樣本峰值檢查達到資源上限，未取得完整測量。",
    "en": "The exported-file decoded sample-peak check reached its resource limit; no complete measurement was obtained.",
    "ja": "書き出し済みファイルのデコード後サンプルピーク検査がリソース上限に達し、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.peak.reason.DECODER_UNAVAILABLE": {
    "zh-Hans": "本地解码器不可用，未获得已导出文件解码样本峰值。",
    "zh-Hant": "本機解碼器無法使用，未取得已匯出檔案解碼樣本峰值。",
    "en": "The local decoder is unavailable; the exported file's decoded sample peak was not obtained.",
    "ja": "ローカルのデコーダーを利用できず、書き出し済みファイルのデコード後サンプルピークは得られませんでした。"
  },
  "audio.loudness.peak.reason.INVALID_PCM": {
    "zh-Hans": "解码音频不完整或含无效样本，未获得已导出文件解码样本峰值。",
    "zh-Hant": "解碼音訊不完整或含無效樣本，未取得已匯出檔案解碼樣本峰值。",
    "en": "Decoded audio is incomplete or contains invalid samples; the exported file's decoded sample peak was not obtained.",
    "ja": "デコードした音声が不完全か無効なサンプルを含むため、書き出し済みファイルのサンプルピークは得られませんでした。"
  },
  "audio.loudness.peak.reason.DECODE_FAILED": {
    "zh-Hans": "导出文件未能完整解码，未获得已导出文件解码样本峰值。",
    "zh-Hant": "匯出檔案未能完整解碼，未取得已匯出檔案解碼樣本峰值。",
    "en": "The exported file could not be fully decoded; its decoded sample peak was not obtained.",
    "ja": "書き出しファイルを完全にデコードできず、デコード後サンプルピークは得られませんでした。"
  },
  "audio.loudness.peak.reason.CANCELLED": {
    "zh-Hans": "已导出文件解码样本峰值检查已停止，未获得完整测量。",
    "zh-Hant": "已匯出檔案解碼樣本峰值檢查已停止，未取得完整測量。",
    "en": "The exported-file decoded sample-peak check stopped; no complete measurement was obtained.",
    "ja": "書き出し済みファイルのデコード後サンプルピーク検査を停止し、完全な測定結果は得られませんでした。"
  },
  "audio.loudness.peak.reason.SHUTDOWN": {
    "zh-Hans": "后端正在关闭，已导出文件解码样本峰值检查未完成。",
    "zh-Hant": "後端正在關閉，已匯出檔案解碼樣本峰值檢查未完成。",
    "en": "The backend is shutting down; the exported-file decoded sample-peak check did not complete.",
    "ja": "バックエンドが終了中のため、書き出し済みファイルのデコード後サンプルピーク検査は完了しませんでした。"
  },
  "audio.loudness.peak.reason.ARTIFACT_CHANGED": {
    "zh-Hans": "导出文件或其归属在检查期间发生变化，已导出文件解码样本峰值结果已丢弃。",
    "zh-Hant": "匯出檔案或其歸屬在檢查期間發生變更，已匯出檔案解碼樣本峰值結果已捨棄。",
    "en": "The exported file or its ownership changed during the check; decoded sample-peak results were discarded.",
    "ja": "検査中に書き出しファイルまたは所属が変わったため、デコード後サンプルピークの結果を破棄しました。"
  },
  "audio.loudness.mix.required": {
    "zh-Hans": "请明确填写目标响度和真峰值上限，再准备候选。",
    "zh-Hant": "請明確填寫目標響度與真峰值上限，再準備候選。",
    "en": "Explicitly enter target loudness and true-peak ceiling before preparing a candidate.",
    "ja": "候補を準備する前に、目標ラウドネスとトゥルーピーク上限を明示的に入力してください。"
  },
  "audio.loudness.mix.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后明确重新准备。",
    "zh-Hant": "工作階段已過期，請重新登入後明確重新準備。",
    "en": "Your session expired. Sign in again and explicitly prepare again.",
    "ja": "セッションの有効期限が切れました。再ログインしてから明示的に再準備してください。"
  },
  "audio.loudness.mix.restored": {
    "zh-Hans": "恢复分支暂不支持当前整片浮点混音测量。",
    "zh-Hant": "還原分支暫不支援目前整片浮點混音測量。",
    "en": "Current full-timeline float-mix measurement is not supported in restored branches yet.",
    "ja": "復元ブランチでは現在、タイムライン全体の浮動小数点ミックス測定を利用できません。"
  },
  "audio.loudness.mix.changed": {
    "zh-Hans": "已保存时间线或来源已变化，结果已丢弃，请重新准备。",
    "zh-Hant": "已儲存時間軸或來源已變更，結果已捨棄，請重新準備。",
    "en": "The saved timeline or source changed; results were discarded. Prepare again.",
    "ja": "保存済みタイムラインまたはソースが変わったため、結果を破棄しました。再準備してください。"
  },
  "audio.loudness.mix.busy": {
    "zh-Hans": "另一个音频检查仍在运行或清理，本次未排队，请稍后明确重试。",
    "zh-Hant": "另一個音訊檢查仍在執行或清理，本次未加入佇列，請稍後明確重試。",
    "en": "Another audio check is still running or cleaning up. This request was not queued; explicitly retry later.",
    "ja": "別の音声検査が実行中または後処理中です。今回のリクエストはキューに入れていません。後で明示的に再試行してください。"
  },
  "audio.loudness.mix.timeout": {
    "zh-Hans": "整片测量超过 120 秒预算，未保留部分结果。",
    "zh-Hant": "整片測量超過 120 秒限額，未保留部分結果。",
    "en": "Full-timeline measurement exceeded the 120-second budget; partial results were not retained.",
    "ja": "全体測定が 120 秒の上限を超えました。部分的な結果は保持していません。"
  },
  "audio.loudness.mix.resource": {
    "zh-Hans": "整片测量达到来源或解码资源上限，未省略音轨或缩短范围。",
    "zh-Hant": "整片測量達到來源或解碼資源上限，未省略音軌或縮短範圍。",
    "en": "Full-timeline measurement reached a source or decoding resource limit. No tracks were omitted and the range was not shortened.",
    "ja": "全体測定がソースまたはデコードのリソース上限に達しました。トラックの省略や範囲の短縮は行っていません。"
  },
  "audio.loudness.mix.format": {
    "zh-Hans": "当前时间线含暂不支持的音频格式，未省略该音轨。",
    "zh-Hant": "目前時間軸包含暫不支援的音訊格式，未省略該音軌。",
    "en": "The current timeline includes an unsupported audio format. That track was not omitted.",
    "ja": "現在のタイムラインに未対応の音声形式があります。そのトラックは省略していません。"
  },
  "audio.loudness.mix.bounds": {
    "zh-Hans": "已保存片段超出来源音频范围，请核对来源后重新准备。",
    "zh-Hant": "已儲存片段超出來源音訊範圍，請核對來源後重新準備。",
    "en": "Saved clips extend beyond the source audio. Check the source and prepare again.",
    "ja": "保存済みクリップがソース音声の範囲を超えています。ソースを確認して再準備してください。"
  },
  "audio.loudness.mix.decode": {
    "zh-Hans": "声音未能完整解码或样本数量不符，未获得整片测量。",
    "zh-Hant": "聲音未能完整解碼或樣本數量不符，未取得整片測量。",
    "en": "Audio could not be fully decoded or sample counts did not match. No full-timeline measurement was obtained.",
    "ja": "音声を完全にデコードできないかサンプル数が一致しないため、全体の測定結果は得られませんでした。"
  },
  "audio.loudness.mix.owner": {
    "zh-Hans": "当前连接不拥有工作区，暂时不能准备整片混音。",
    "zh-Hant": "目前連線不擁有工作區，暫時無法準備整片混音。",
    "en": "This connection does not own the workspace and cannot currently prepare a full-timeline mix.",
    "ja": "現在の接続はワークスペースの所有者ではないため、全体ミックスを準備できません。"
  },
  "audio.loudness.mix.failed": {
    "zh-Hans": "当前已保存时间线暂时无法测量，请核对时间线和来源。",
    "zh-Hant": "目前已儲存時間軸暫時無法測量，請核對時間軸與來源。",
    "en": "The currently saved timeline cannot be measured right now. Check the timeline and sources.",
    "ja": "現在保存済みのタイムラインを今は測定できません。タイムラインとソースを確認してください。"
  },
  "audio.loudness.mix.protocol": {
    "zh-Hans": "测量响应不完整或与当前整片时间线、目标不匹配，请重新准备。",
    "zh-Hant": "測量回應不完整，或與目前整段時間軸、目標不符，請重新準備。",
    "en": "The measurement response is incomplete or does not match the current full timeline and targets. Prepare again.",
    "ja": "測定応答が不完全、または現在のタイムライン全体や目標と一致しません。再準備してください。"
  },
  "audio.loudness.mix.stopped": {
    "zh-Hans": "本次整片测量已停止，需要时请明确重新准备。",
    "zh-Hant": "本次整片測量已停止，需要時請明確重新準備。",
    "en": "This full-timeline measurement stopped. Explicitly prepare again if needed.",
    "ja": "今回の全体測定は停止しました。必要に応じて明示的に再準備してください。"
  },
  "audio.loudness.mix.cleanup": {
    "zh-Hans": "上一音频检查尚未确认结束，请等待资源释放后明确重试。",
    "zh-Hant": "上一個音訊檢查尚未確認結束，請等待資源釋放後明確重試。",
    "en": "The previous audio check has not been confirmed ended. Wait for resources to be released, then explicitly retry.",
    "ja": "前の音声検査が終了したことはまだ確認できていません。リソース解放を待ってから明示的に再試行してください。"
  },
  "audio.loudness.mix.incomplete": {
    "zh-Hans": "整片测量未完成，请确认连接后重新准备。",
    "zh-Hant": "整片測量未完成，請確認連線後重新準備。",
    "en": "Full-timeline measurement did not complete. Check the connection and prepare again.",
    "ja": "全体測定が完了しませんでした。接続を確認して再準備してください。"
  },
  "audio.loudness.mix.preparing": {
    "zh-Hans": "正在完整测量原混音，并重新渲染固定增益候选…",
    "zh-Hant": "正在完整測量原混音，並重新算繪固定增益候選…",
    "en": "Measuring the complete original mix and re-rendering the fixed-gain candidate…",
    "ja": "元のミックス全体を測定し、固定ゲイン候補を再レンダリング中…"
  },
  "audio.loudness.mix.cancelled": {
    "zh-Hans": "本次只读观察已取消，未修改时间线；需要时请明确重新准备。",
    "zh-Hant": "本次唯讀觀察已取消，未修改時間軸；需要時請明確重新準備。",
    "en": "This read-only observation was cancelled without changing the timeline. Explicitly prepare again if needed.",
    "ja": "今回の読み取り専用の観測をキャンセルしました。タイムラインは変更していません。必要に応じて明示的に再準備してください。"
  },
  "audio.loudness.mix.stale": {
    "zh-Hans": "当前身份或显示范围已变化，原结果已清除，请重新准备。",
    "zh-Hant": "目前身分或顯示範圍已變更，原結果已清除，請重新準備。",
    "en": "The current identity or displayed scope changed. The original result was cleared; prepare again.",
    "ja": "現在の識別情報または表示範囲が変わったため、元の結果を消去しました。再準備してください。"
  },
  "export.preflight.issue.EXPORT_RANGE_BOUNDS": {
    "zh-Hans": "导出范围超出已保存时间线，请重新选择范围并检查。",
    "zh-Hant": "匯出範圍超出已儲存時間軸，請重新選擇範圍並檢查。",
    "en": "The export range exceeds the saved timeline. Select a range and check again.",
    "ja": "書き出し範囲が保存済みタイムラインを超えています。範囲を選び直して確認してください。"
  },
  "export.preflight.issue.TIMELINE_MISSING": {
    "zh-Hans": "项目还没有已保存的时间线，请先编排并保存片段。",
    "zh-Hant": "專案尚無已儲存的時間軸，請先編排並儲存片段。",
    "en": "The project has no saved timeline. Arrange and save clips first.",
    "ja": "プロジェクトに保存済みタイムラインがありません。先にクリップを配置して保存してください。"
  },
  "export.preflight.issue.EMPTY_TIMELINE": {
    "zh-Hans": "已保存的时间线中没有可导出的片段。",
    "zh-Hant": "已儲存時間軸中沒有可匯出的片段。",
    "en": "The saved timeline has no exportable clips.",
    "ja": "保存済みタイムラインに書き出せるクリップがありません。"
  },
  "export.preflight.issue.INVALID_TIMELINE_SNAPSHOT": {
    "zh-Hans": "已保存的时间线包含无效或暂不支持的设置。",
    "zh-Hant": "已儲存時間軸包含無效或暫不支援的設定。",
    "en": "The saved timeline contains invalid or unsupported settings.",
    "ja": "保存済みタイムラインに無効または未対応の設定があります。"
  },
  "export.preflight.issue.TIMELINE_SOURCE_UNAVAILABLE": {
    "zh-Hans": "引用的素材缺失，或不属于当前项目。",
    "zh-Hant": "引用的素材遺失，或不屬於目前專案。",
    "en": "Referenced assets are missing or do not belong to the current project.",
    "ja": "参照素材がないか、現在のプロジェクトに属していません。"
  },
  "export.preflight.issue.TIMELINE_IMAGE_COMPOSITOR_BUDGET": {
    "zh-Hans": "同一时段最多支持两个可见的 SDR 图片片段，请错开片段或隐藏多余图片轨道。",
    "zh-Hant": "同一時段最多支援兩個可見的 SDR 圖片片段，請錯開片段或隱藏多餘圖片軌道。",
    "en": "At most two SDR image clips can be visible at once. Stagger clips or hide extra image tracks.",
    "ja": "同時に表示できる SDR 画像クリップは2個までです。配置をずらすか、余分な画像トラックを非表示にしてください。"
  },
  "export.preflight.issue.INVALID_TIMELINE_COLOUR": {
    "zh-Hans": "请先为可见片段确认受支持的 SDR 素材色彩设置。",
    "zh-Hant": "請先為可見片段確認受支援的 SDR 素材色彩設定。",
    "en": "Confirm supported SDR source colour settings for visible clips first.",
    "ja": "先に表示対象クリップの対応 SDR ソース色設定を確認してください。"
  },
  "export.preflight.issue.TIMELINE_COLOUR_SOURCE_UNSUPPORTED": {
    "zh-Hans": "素材的色彩或像素格式不受当前 SDR 配置支持。",
    "zh-Hant": "素材的色彩或像素格式不受目前 SDR 設定支援。",
    "en": "The source colour or pixel format is unsupported by this SDR profile.",
    "ja": "素材の色またはピクセル形式は、この SDR プロファイルに対応していません。"
  },
  "export.preflight.issue.TIMELINE_COLOUR_SOURCE_MISMATCH": {
    "zh-Hans": "已保存的色彩设置与当前素材不符，请重新检查并确认素材。",
    "zh-Hant": "已儲存的色彩設定與目前素材不符，請重新檢查並確認素材。",
    "en": "Saved colour settings no longer match the source. Inspect and confirm it again.",
    "ja": "保存済みの色設定が現在の素材と一致しません。素材を再検査して確認してください。"
  },
  "export.preflight.issue.TIMELINE_COLOUR_RESOURCE_CHANGED": {
    "zh-Hans": "创意 LUT 的内容或校验值已变化，无法验证已保存的外观。",
    "zh-Hant": "創意 LUT 的內容或校驗值已變更，無法驗證已儲存的外觀。",
    "en": "Creative LUT contents or checksums changed; the saved look cannot be verified.",
    "ja": "クリエイティブ LUT の内容またはチェックサムが変わり、保存済みのルックを検証できません。"
  },
  "export.preflight.issue.TIMELINE_COLOUR_LUT_BUDGET": {
    "zh-Hans": "色彩资源或图片图层超过处理限额，请减少不同的外观、图片尺寸或图层。",
    "zh-Hant": "色彩資源或圖片圖層超過處理上限，請減少不同的外觀、圖片尺寸或圖層。",
    "en": "Colour resources or image layers exceed processing limits. Reduce distinct looks, image sizes or layers.",
    "ja": "色リソースまたは画像レイヤーが処理上限を超えています。ルックの種類、画像サイズ、レイヤー数を減らしてください。"
  },
  "export.preflight.issue.TIMELINE_COLOUR_LOOK_UNAVAILABLE": {
    "zh-Hans": "片段引用的创意 LUT 不可用，或不属于当前项目。",
    "zh-Hant": "片段引用的創意 LUT 無法使用，或不屬於目前專案。",
    "en": "The clip's creative LUT is unavailable or does not belong to this project.",
    "ja": "クリップのクリエイティブ LUT が利用できないか、このプロジェクトに属していません。"
  },
  "export.preflight.issue.SOURCE_BOUNDS": {
    "zh-Hans": "素材入点和片段时长超出素材范围，请调整入点或时长。",
    "zh-Hant": "素材入點和片段時長超出素材範圍，請調整入點或時長。",
    "en": "The source in-point and clip duration exceed source bounds. Adjust the in-point or duration.",
    "ja": "素材のイン点とクリップの長さが素材範囲を超えています。イン点または長さを調整してください。"
  },
  "export.preflight.issue.FADE_AUDIO_UNSUPPORTED": {
    "zh-Hans": "淡入淡出需要已确认含音频的音频或视频素材。",
    "zh-Hant": "淡入淡出需要已確認含音訊的音訊或影片素材。",
    "en": "Audio fades require an audio or video source with confirmed audio.",
    "ja": "音声フェードには、音声を確認済みの音声素材または動画素材が必要です。"
  },
  "export.preflight.issue.AUDIO_ROLE_CLIP_UNSUPPORTED": {
    "zh-Hans": "音频角色仅适用于音频或视频片段，不能用于静态图片。",
    "zh-Hant": "音訊角色僅適用於音訊或影片片段，不能用於靜態圖片。",
    "en": "Audio roles apply to audio or video clips, not still images.",
    "ja": "音声ロールは音声または動画クリップにのみ設定できます。静止画像には設定できません。"
  },
  "export.preflight.issue.TIMELINE_VOLUME_ENVELOPE_SOURCE_UNSUPPORTED": {
    "zh-Hans": "音量关键帧需要受支持且含音频的素材，请检查素材或清除音量关键帧。",
    "zh-Hant": "音量關鍵幀需要受支援且含音訊的素材，請檢查素材或清除音量關鍵幀。",
    "en": "Volume keyframes require a supported source with audio. Check the source or clear its volume keyframes.",
    "ja": "音量キーフレームには、音声を含む対応素材が必要です。素材を確認するか、音量キーフレームを解除してください。"
  },
  "export.preflight.issue.VOLUME_ENVELOPE_SOURCE_UNSUPPORTED": {
    "zh-Hans": "实际素材未确认包含受支持的音频，无法应用音量关键帧。",
    "zh-Hant": "實際素材未確認包含受支援的音訊，無法套用音量關鍵幀。",
    "en": "Supported audio could not be confirmed in the actual source; volume keyframes cannot be applied.",
    "ja": "実際の素材で対応する音声を確認できないため、音量キーフレームを適用できません。"
  },
  "export.preflight.issue.INVALID_CLIP_TYPE": {
    "zh-Hans": "片段素材类型与轨道不符：视频轨道接收图片或视频，音频轨道接收音频。",
    "zh-Hant": "片段素材類型與軌道不符：影片軌道接收圖片或影片，音訊軌道接收音訊。",
    "en": "The source type does not match its track: video tracks accept images or video; audio tracks accept audio.",
    "ja": "素材の種類がトラックと一致しません。動画トラックには画像または動画、音声トラックには音声を配置してください。"
  },
  "export.preflight.issue.INVALID_FADE": {
    "zh-Hans": "音频淡入淡出帧数无效，或合计超过片段时长。",
    "zh-Hant": "音訊淡入淡出幀數無效，或合計超過片段時長。",
    "en": "Audio fade frame counts are invalid or their total exceeds the clip duration.",
    "ja": "音声フェードのフレーム数が無効か、合計がクリップの長さを超えています。"
  },
  "export.preflight.issue.PREFLIGHT_SOURCE_INVALID": {
    "zh-Hans": "源素材缺失，或无法在受管理的媒体目录中安全读取。",
    "zh-Hant": "來源素材遺失，或無法在受管理的媒體目錄中安全讀取。",
    "en": "Source assets are missing or cannot be read safely from the managed media directory.",
    "ja": "ソース素材がないか、管理対象のメディアディレクトリから安全に読み取れません。"
  },
  "export.preflight.issue.PREFLIGHT_SOURCE_CHANGED": {
    "zh-Hans": "源素材已变化，或文件内容与保存的校验值不一致。",
    "zh-Hant": "來源素材已變更，或檔案內容與儲存的校驗值不一致。",
    "en": "Source assets changed or file contents no longer match saved checksums.",
    "ja": "ソース素材が変わったか、ファイル内容が保存済みチェックサムと一致しません。"
  },
  "export.preflight.issue.PREFLIGHT_MEDIA_INVALID": {
    "zh-Hans": "源素材的媒体信息无效或暂不支持。",
    "zh-Hant": "來源素材的媒體資訊無效或暫不支援。",
    "en": "Source media information is invalid or unsupported.",
    "ja": "ソース素材のメディア情報が無効または未対応です。"
  },
  "export.preflight.issue.PREFLIGHT_INCOMPLETE": {
    "zh-Hans": "有限额的媒体检查未能完成。实际导出仍会重新验证素材。",
    "zh-Hant": "有限額的媒體檢查未能完成。實際匯出仍會重新驗證素材。",
    "en": "The bounded media check did not complete. Actual export will still revalidate assets.",
    "ja": "上限付きメディア検査が完了しませんでした。実際の書き出し時にも素材を再検証します。"
  },
  "export.preflight.issue.PREFLIGHT_BUDGET": {
    "zh-Hans": "文件或累计字节检查已达到限额，尚未完成全部检查。",
    "zh-Hant": "檔案或累計位元組檢查已達限額，尚未完成全部檢查。",
    "en": "File or total-byte checks reached their limit before all checks completed.",
    "ja": "ファイル数または累計バイト数の検査上限に達し、すべての確認は完了していません。"
  },
  "export.preflight.issue.PREFLIGHT_SNAPSHOT_BUDGET": {
    "zh-Hans": "关联资料超出本次安全检查上限，检查未完成。",
    "zh-Hant": "關聯資料超出本次安全檢查上限，檢查未完成。",
    "en": "Related data exceeds this safety check's limit; checks are incomplete.",
    "ja": "関連データが今回の安全検査上限を超えたため、確認は未完了です。"
  },
  "export.preflight.issue.PREFLIGHT_TIMEOUT": {
    "zh-Hans": "素材检查已达到时间上限，尚未完成全部检查。",
    "zh-Hant": "素材檢查已達時間上限，尚未完成全部檢查。",
    "en": "Asset checks reached the time limit before all checks completed.",
    "ja": "素材検査が時間上限に達し、すべての確認は完了していません。"
  },
  "export.preflight.issue.PREFLIGHT_BUSY": {
    "zh-Hans": "另一项交付检查仍在运行，请稍后重新检查。",
    "zh-Hant": "另一項交付檢查仍在執行，請稍後重新檢查。",
    "en": "Another delivery check is still running. Check again later.",
    "ja": "別の出力確認がまだ実行中です。後で再確認してください。"
  },
  "export.preflight.issue.PREFLIGHT_STALE": {
    "zh-Hans": "时间线或素材信息已变化，请重新检查已保存的快照。",
    "zh-Hant": "時間軸或素材資訊已變更，請重新檢查已儲存快照。",
    "en": "Timeline or asset information changed. Check the saved snapshot again.",
    "ja": "タイムラインまたは素材情報が変わりました。保存済みスナップショットを再確認してください。"
  },
  "export.preflight.error.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后重新检查。",
    "zh-Hant": "工作階段已過期，請重新登入後重新檢查。",
    "en": "Your session expired. Sign in again and recheck.",
    "ja": "セッションの有効期限が切れました。再ログインして再確認してください。"
  },
  "export.preflight.error.changed": {
    "zh-Hans": "时间线已变化，请重新检查已保存的快照。",
    "zh-Hant": "時間軸已變更，請重新檢查已儲存快照。",
    "en": "The timeline changed. Check the saved snapshot again.",
    "ja": "タイムラインが変わりました。保存済みスナップショットを再確認してください。"
  },
  "export.preflight.error.protocol": {
    "zh-Hans": "检查响应不完整或与当前快照不匹配，请重新检查。",
    "zh-Hant": "檢查回應不完整，或與目前快照不符，請重新檢查。",
    "en": "The check response is incomplete or does not match the current snapshot. Check again.",
    "ja": "確認応答が不完全、または現在のスナップショットと一致しません。再確認してください。"
  },
  "export.preflight.error.failed": {
    "zh-Hans": "检查未完成，请检查连接后重新检查。",
    "zh-Hant": "檢查未完成，請檢查連線後重新檢查。",
    "en": "Checks did not complete. Check the connection and try again.",
    "ja": "確認が完了しませんでした。接続を確認してやり直してください。"
  },
  "export.preflight.issue.unknownError": {
    "zh-Hans": "素材或时间线检查未通过，请核对源素材与编排。",
    "zh-Hant": "素材或時間軸檢查未通過，請核對來源素材與編排。",
    "en": "Asset or timeline checks did not pass. Review source assets and arrangement.",
    "ja": "素材またはタイムラインの検査に合格しませんでした。ソース素材と配置を確認してください。"
  },
  "export.preflight.issue.unknownNotice": {
    "zh-Hans": "有一项检查未完成或需要注意，请核对源素材。",
    "zh-Hant": "有一項檢查未完成或需要注意，請核對來源素材。",
    "en": "A check is incomplete or needs attention. Review source assets.",
    "ja": "未完了または注意が必要な検査があります。ソース素材を確認してください。"
  },
  "export.preflight.capability.idle": {
    "zh-Hans": "尚未检查本机编码能力。",
    "zh-Hant": "尚未檢查本機編碼能力。",
    "en": "Local encoding capability has not been checked.",
    "ja": "ローカルのエンコード機能は未確認です。"
  },
  "export.preflight.capability.checking": {
    "zh-Hans": "正在用当前设置进行有限额的本地编码检查…",
    "zh-Hant": "正在使用目前設定進行有限額的本機編碼檢查…",
    "en": "Running a bounded local encoding check with current settings…",
    "ja": "現在の設定で上限付きのローカルエンコード検査を実行中…"
  },
  "export.preflight.capability.available": {
    "zh-Hans": "当前设置已通过本地编码检查。实际导出时仍会重新验证。",
    "zh-Hant": "目前設定已通過本機編碼檢查。實際匯出時仍會重新驗證。",
    "en": "Current settings passed the local encoding check. Actual export will revalidate them.",
    "ja": "現在の設定はローカルのエンコード検査に合格しました。実際の書き出し時にも再検証します。"
  },
  "export.preflight.capability.unavailable": {
    "zh-Hans": "本机编码工具不可用，或缺少当前导出所需的能力。请检查 FFmpeg 配置后重新检查。",
    "zh-Hant": "本機編碼工具無法使用，或缺少目前匯出所需能力。請檢查 FFmpeg 設定後重新檢查。",
    "en": "Local encoding tools are unavailable or lack capabilities needed for this export. Check FFmpeg configuration and recheck.",
    "ja": "ローカルのエンコードツールを利用できないか、今回の書き出しに必要な機能がありません。FFmpeg の設定を確認して再検査してください。"
  },
  "export.preflight.capability.incomplete": {
    "zh-Hans": "本机编码能力尚未确认，检查可能超时或暂时不可用。不能据此判断支持或不支持，请重新检查。",
    "zh-Hant": "本機編碼能力尚未確認，檢查可能逾時或暫時無法使用。不可據此判斷支援與否，請重新檢查。",
    "en": "Local encoding capability is unconfirmed; the check may have timed out or been temporarily unavailable. This does not establish support or lack of support. Check again.",
    "ja": "ローカルのエンコード機能は未確認です。検査がタイムアウトしたか、一時的に利用できなかった可能性があります。対応・非対応の判断はできません。再確認してください。"
  },
  "export.preflight.capability.stale": {
    "zh-Hans": "项目、时间线或编码工具已变化，请重新检查。",
    "zh-Hant": "專案、時間軸或編碼工具已變更，請重新檢查。",
    "en": "The project, timeline or encoding tools changed. Check again.",
    "ja": "プロジェクト、タイムライン、またはエンコードツールが変わりました。再確認してください。"
  },
  "export.preflight.capability.blocked": {
    "zh-Hans": "当前项目或时间线不符合编码检查要求，请先核对已保存的编排。",
    "zh-Hant": "目前專案或時間軸不符合編碼檢查要求，請先核對已儲存編排。",
    "en": "The current project or timeline does not meet encoding-check requirements. Review the saved arrangement first.",
    "ja": "現在のプロジェクトまたはタイムラインがエンコード検査の要件を満たしていません。先に保存済みの配置を確認してください。"
  },
  "export.preflight.capability.unknown": {
    "zh-Hans": "本机编码能力尚未确认，请重新检查。",
    "zh-Hant": "本機編碼能力尚未確認，請重新檢查。",
    "en": "Local encoding capability is unconfirmed. Check again.",
    "ja": "ローカルのエンコード機能は未確認です。再確認してください。"
  },
  "audio.loudness.apply.changed": {
    "zh-Hans": "时间线、来源字节或候选已变化。原报告不能再应用，请重新准备并核对候选。",
    "zh-Hant": "時間軸、來源位元組或候選已變更。原報告不能再套用，請重新準備並核對候選。",
    "en": "The timeline, source bytes or candidate changed. The original report can no longer be applied; prepare and review the candidate again.",
    "ja": "タイムライン、ソースのバイト列、または候補が変わりました。元のレポートは適用できません。候補を再準備して確認してください。"
  },
  "audio.loudness.apply.unsafe": {
    "zh-Hans": "重新测量的候选未同时满足两个目标，未修改增益。请重新准备并核对。",
    "zh-Hant": "重新測量的候選未同時滿足兩個目標，未修改增益。請重新準備並核對。",
    "en": "The remeasured candidate did not meet both targets. Gain was not changed. Prepare and review again.",
    "ja": "再測定した候補が両方の目標を満たさなかったため、ゲインは変更していません。再準備して確認してください。"
  },
  "audio.loudness.apply.unchanged": {
    "zh-Hans": "候选没有可保存的增益变化，请重新准备。",
    "zh-Hant": "候選沒有可儲存的增益變更，請重新準備。",
    "en": "The candidate has no gain changes to save. Prepare again.",
    "ja": "候補に保存できるゲイン変更がありません。再準備してください。"
  },
  "audio.loudness.apply.restored": {
    "zh-Hans": "恢复分支不能应用响度候选。",
    "zh-Hant": "還原分支無法套用響度候選。",
    "en": "Restored branches cannot apply loudness candidates.",
    "ja": "復元ブランチではラウドネス候補を適用できません。"
  },
  "audio.loudness.apply.failed": {
    "zh-Hans": "本次应用未完成。请先核对任务中心的原请求，再明确重新准备。",
    "zh-Hant": "本次套用未完成。請先核對工作中心的原請求，再明確重新準備。",
    "en": "This apply operation did not complete. Check the original request in Task Center before explicitly preparing again.",
    "ja": "今回の適用は完了しませんでした。まずタスクセンターで元のリクエストを確認してから、明示的に再準備してください。"
  },
  "audio.loudness.apply.identityUnavailable": {
    "zh-Hans": "当前工作区身份尚未核验，未提交响度应用。请重新连接或重新载入当前工作区，完成身份核验后再重新准备并核对候选。",
    "zh-Hant": "目前工作區身分尚未核驗，未提交響度套用。請重新連線或重新載入目前工作區，完成身分核驗後再重新準備並核對候選。",
    "en": "The current workspace identity is unverified; loudness application was not submitted. Reconnect or reload the workspace, verify its identity, then prepare and review the candidate again.",
    "ja": "現在のワークスペースの識別情報が未検証のため、ラウドネス適用は送信していません。再接続または再読み込みし、識別情報の検証後に候補を再準備して確認してください。"
  },
  "audio.loudness.apply.identityChanged": {
    "zh-Hans": "工作区身份已变化或无法核验，本次确认已失效，未继续提交。请核验当前工作区身份后重新准备并核对候选。",
    "zh-Hant": "工作區身分已變更或無法核驗，本次確認已失效，未繼續提交。請核驗目前工作區身分後重新準備並核對候選。",
    "en": "Workspace identity changed or cannot be verified. This confirmation is invalid and submission did not continue. Verify the current workspace identity, then prepare and review the candidate again.",
    "ja": "ワークスペースの識別情報が変わったか検証できないため、今回の確認は無効になり、送信は続行していません。現在の識別情報を検証してから候補を再準備して確認してください。"
  },
  "audio.loudness.apply.confirm": {
    "zh-Hans": "将 修订版 {revision} 的 {count} 个可听片段作为一次编辑应用固定增益 {gain} dB（×{multiplier}）？目标 {lufs} LUFS，真峰值上限 {peak} dBTP，额外预留 0.5 dB。服务器会重新核验来源并完整测量；变化或不安全时不应用。候选是整片编码前浮点混音，不是默认 v1 导出结果。应用只保存一组固定增益，可用一次撤销恢复；不会自动选择 v2 或导出，也不保证输出响度或 AAC 真峰值。需要明确选择浮点检查 v2 导出，再测量实际成片。",
    "zh-Hant": "將 修訂版 {revision} 的 {count} 個可聽片段作為一次編輯，套用固定增益 {gain} dB（×{multiplier}）？目標 {lufs} LUFS，真峰值上限 {peak} dBTP，額外預留 0.5 dB。伺服器會重新核驗來源並完整測量；有變更或不安全時不套用。候選是整片編碼前浮點混音，並非預設 v1 匯出結果。套用僅儲存一組固定增益，可透過一次復原還原；不會自動選擇 v2 或匯出，也不保證輸出響度或 AAC 真峰值。須明確選擇浮點檢查 v2 匯出，再測量實際成片。",
    "en": "Apply fixed gain {gain} dB (×{multiplier}) to {count} audible clips at revision {revision} as one edit? Target: {lufs} LUFS; true-peak ceiling: {peak} dBTP, with an extra 0.5 dB reserve. The server revalidates sources and fully measures; changes or unsafe results prevent application. This candidate is the full pre-encoding float mix, not default v1 output. Applying saves one set of fixed gains, reversible with one undo; it does not automatically select v2 or export, or guarantee output loudness or AAC true peak. Explicitly select float-check v2 export, then measure the actual output.",
    "ja": "リビジョン {revision} の音声が有効な {count} クリップに、1 回の編集として固定ゲイン {gain} dB（×{multiplier}）を適用しますか？目標は {lufs} LUFS、トゥルーピーク上限は {peak} dBTP、追加の余裕は 0.5 dB です。サーバーがソースを再検証し全体を測定します。変更がある場合や安全でない場合は適用しません。候補は全体のエンコード前浮動小数点ミックスであり、既定の v1 出力ではありません。適用では 1 組の固定ゲインを保存し、1 回の取り消しで戻せます。v2 の自動選択や書き出しは行わず、出力ラウドネスや AAC トゥルーピークも保証しません。浮動小数点検査 v2 を明示的に選んで書き出し、実際の出力を測定してください。"
  },
  "recovery.notice.unconfirmed": {
    "zh-Hans": "本地状态尚未确认，当前输入与原请求仍保留。请重新核对；不会自动重试。",
    "zh-Hant": "本機狀態尚未確認，目前輸入與原請求仍保留。請重新核對；不會自動重試。",
    "en": "Local state is unconfirmed. Current input and original requests are retained. Recheck; no automatic retry will occur.",
    "ja": "ローカル状態は未確認です。現在の入力と元のリクエストを保持しています。再確認してください。自動再試行は行いません。"
  },
  "recovery.notice.timeout": {
    "zh-Hans": "本地请求超时，结果仍待确认。中断连接不会取消保存、删除或原业务请求；当前输入与原请求仍保留。",
    "zh-Hant": "本機請求逾時，結果仍待確認。中斷連線不會取消儲存、刪除或原操作請求；目前輸入與原請求仍保留。",
    "en": "The local request timed out; its outcome is still unconfirmed. Disconnecting does not cancel saves, deletions or the original operation request. Current input and original requests are retained.",
    "ja": "ローカルリクエストがタイムアウトし、結果は未確認です。切断しても保存、削除、元の操作リクエストはキャンセルされません。現在の入力と元のリクエストを保持します。"
  },
  "recovery.notice.protocol": {
    "zh-Hans": "本地确认不完整或与原记录不符，当前输入与原请求仍保留。请重新核对，不会自动覆盖或重试。",
    "zh-Hant": "本機確認不完整或與原記錄不符，目前輸入與原請求仍保留。請重新核對，不會自動覆寫或重試。",
    "en": "The local acknowledgement is incomplete or does not match the original record. Current input and original requests are retained. Recheck; nothing will be automatically overwritten or retried.",
    "ja": "ローカルの確認応答が不完全、または元の記録と一致しません。現在の入力と元のリクエストを保持します。再確認してください。自動上書きや再試行は行いません。"
  },
  "recovery.notice.network": {
    "zh-Hans": "本地请求未收到确认；结果可能仍待确认。当前输入与原请求仍保留，不会自动重试。",
    "zh-Hant": "本機請求未收到確認；結果可能仍待確認。目前輸入與原請求仍保留，不會自動重試。",
    "en": "No acknowledgement was received for the local request; its outcome may still be pending. Current input and original requests are retained; no automatic retry will occur.",
    "ja": "ローカルリクエストの確認応答を受け取れませんでした。結果はまだ未確認の可能性があります。現在の入力と元のリクエストを保持し、自動再試行は行いません。"
  },
  "recovery.notice.capacity": {
    "zh-Hans": "本地恢复记录已达容量上限。已有记录不会自动删除；这不表示磁盘已满。当前输入与原请求仍保留。",
    "zh-Hant": "本機還原記錄已達容量上限。既有記錄不會自動刪除；這不表示磁碟已滿。目前輸入與原請求仍保留。",
    "en": "Local recovery records reached their capacity limit. Existing records are not automatically deleted; this does not mean the disk is full. Current input and original requests are retained.",
    "ja": "ローカル復元記録が容量上限に達しました。既存記録は自動削除されず、ディスクが満杯という意味ではありません。現在の入力と元のリクエストを保持します。"
  },
  "recovery.notice.conflict": {
    "zh-Hans": "本地记录或工作区身份发生冲突，已停止覆盖。当前输入与原请求仍保留，请重新核对。",
    "zh-Hant": "本機記錄或工作區身分發生衝突，已停止覆寫。目前輸入與原請求仍保留，請重新核對。",
    "en": "Local records or workspace identity conflict, so overwriting stopped. Current input and original requests are retained. Recheck.",
    "ja": "ローカル記録またはワークスペースの識別情報が競合したため、上書きを停止しました。現在の入力と元のリクエストを保持しています。再確認してください。"
  },
  "recovery.delivery.localInvalid": {
    "zh-Hans": "名称超过本地草稿的 512 字符上限或包含无效 Unicode；未发送保存请求，原输入保留，不会截断。",
    "zh-Hant": "名稱超過本機草稿的 512 字元上限或包含無效 Unicode；未傳送儲存請求，原輸入保留，不會截斷。",
    "en": "The name exceeds the local draft's 512-character limit or contains invalid Unicode. No save request was sent; original input is retained without truncation.",
    "ja": "名前がローカル下書きの 512 文字上限を超えたか、無効な Unicode を含みます。保存リクエストは送信せず、元の入力を切り詰めずに保持します。"
  },
  "recovery.delivery.localRetryLimit": {
    "zh-Hans": "当前会话已有 128 个项目的名称保存待确认；请先恢复原名称。未发送本次新保存请求。",
    "zh-Hant": "目前工作階段已有 128 個專案的名稱儲存待確認；請先還原原名稱。未傳送本次新的儲存請求。",
    "en": "Name saves for 128 projects already await confirmation in this session. Recover the original names first. This new save request was not sent.",
    "ja": "このセッションではすでに 128 プロジェクトの名前保存が確認待ちです。先に元の名前を復元してください。今回の新しい保存リクエストは送信していません。"
  },
  "recovery.delivery.newerInput": {
    "zh-Hans": "本次名称已确认保存。较新的输入仍保留，请明确保存当前名称。",
    "zh-Hant": "本次名稱已確認儲存。較新的輸入仍保留，請明確儲存目前名稱。",
    "en": "This name was confirmed saved. Newer input is retained; explicitly save the current name.",
    "ja": "今回の名前の保存を確認しました。新しい入力は保持しています。現在の名前を明示的に保存してください。"
  },
  "recovery.delivery.chooseDraft": {
    "zh-Hans": "已重新核对记录；请选择恢复已保存名称或明确保留当前名称。",
    "zh-Hant": "已重新核對記錄；請選擇還原已儲存名稱或明確保留目前名稱。",
    "en": "Records have been rechecked. Choose to restore the saved name or explicitly retain the current name.",
    "ja": "記録を再確認しました。保存済みの名前を復元するか、現在の名前を明示的に保持するかを選んでください。"
  },
  "recovery.delivery.newerUnsaved": {
    "zh-Hans": "原名称已确认保存。较新的当前输入仍未保存；请明确保存当前名称，不会自动覆盖。",
    "zh-Hant": "原名稱已確認儲存。較新的目前輸入仍未儲存；請明確儲存目前名稱，不會自動覆寫。",
    "en": "The original name was confirmed saved. Newer current input is still unsaved; explicitly save the current name. It will not be overwritten automatically.",
    "ja": "元の名前の保存を確認しました。現在の新しい入力はまだ未保存です。現在の名前を明示的に保存してください。自動では上書きしません。"
  },
  "recovery.delivery.leaveNotice": {
    "zh-Hans": "已选择保留当前输入但不保存到本地；离开或关闭后，这些输入可能丢失。原导出请求不会因此取消。",
    "zh-Hant": "已選擇保留目前輸入但不儲存至本機；離開或關閉後，這些輸入可能遺失。原匯出請求不會因此取消。",
    "en": "You chose to retain current input without saving locally. It may be lost after leaving or closing. This does not cancel the original export request.",
    "ja": "現在の入力を保持し、ローカルには保存しないことを選択しました。移動や終了後に入力が失われる場合があります。元の書き出しリクエストはキャンセルされません。"
  },
  "recovery.delivery.notAppliedCode": {
    "zh-Hans": "服务器已确认原请求未应用（{code}）。名称仍保留，请核对后重新检查。",
    "zh-Hant": "伺服器已確認原請求未套用（{code}）。名稱仍保留，請核對後重新檢查。",
    "en": "The server confirmed the original request was not applied ({code}). The name is retained; review it and check again.",
    "ja": "サーバーが元のリクエストを未適用と確認しました（{code}）。名前は保持します。内容を確認してから再検査してください。"
  },
  "recovery.notice.pending": {
    "zh-Hans": "原请求结果仍待确认；不会自动重试。",
    "zh-Hant": "原請求結果仍待確認；不會自動重試。",
    "en": "The original request outcome still awaits confirmation; it will not be retried automatically.",
    "ja": "元のリクエストの結果はまだ確認待ちです。自動再試行は行いません。"
  },
  "recovery.text.localInvalid": {
    "zh-Hans": "文字超过本地草稿上限或包含无效 Unicode；尚未发送保存请求，原输入保留，不会截断。",
    "zh-Hant": "文字超過本機草稿上限或包含無效 Unicode；尚未傳送儲存請求，原輸入保留，不會截斷。",
    "en": "Text exceeds local draft limits or contains invalid Unicode. No save request was sent; original input is retained without truncation.",
    "ja": "テキストがローカル下書きの上限を超えたか、無効な Unicode を含みます。保存リクエストは送信せず、元の入力を切り詰めずに保持します。"
  },
  "recovery.text.localRetryLimit": {
    "zh-Hans": "当前会话的待确认草稿已达上限；尚未发送本次保存请求。",
    "zh-Hant": "目前工作階段的待確認草稿已達上限；尚未傳送本次儲存請求。",
    "en": "Unconfirmed drafts reached this session's limit. This save request has not been sent.",
    "ja": "このセッションの確認待ち下書きが上限に達しました。今回の保存リクエストは送信していません。"
  },
  "recovery.text.newerInput": {
    "zh-Hans": "原文字已确认保存。较新的输入仍保留，请明确保存当前文字。",
    "zh-Hant": "原文字已確認儲存。較新的輸入仍保留，請明確儲存目前文字。",
    "en": "The original text was confirmed saved. Newer input is retained; explicitly save the current text.",
    "ja": "元のテキストの保存を確認しました。新しい入力は保持しています。現在のテキストを明示的に保存してください。"
  },
  "recovery.text.chooseDraft": {
    "zh-Hans": "已重新核对记录；请选择恢复已保存文字或明确保留当前文字。",
    "zh-Hant": "已重新核對記錄；請選擇還原已儲存文字或明確保留目前文字。",
    "en": "Records have been rechecked. Choose to restore the saved text or explicitly retain the current text.",
    "ja": "記録を再確認しました。保存済みテキストを復元するか、現在のテキストを明示的に保持するかを選んでください。"
  },
  "recovery.text.newerUnsaved": {
    "zh-Hans": "原文字已确认保存。较新的当前输入仍未保存；请明确保存当前文字，不会自动覆盖。",
    "zh-Hant": "原文字已確認儲存。較新的目前輸入仍未儲存；請明確儲存目前文字，不會自動覆寫。",
    "en": "The original text was confirmed saved. Newer current input remains unsaved; explicitly save it. No automatic overwrite will occur.",
    "ja": "元のテキストの保存を確認しました。現在の新しい入力はまだ未保存です。明示的に保存してください。自動では上書きしません。"
  },
  "recovery.text.deleted": {
    "zh-Hans": "同一草稿删除已确认。当前输入仍保留，请明确选择是否保存当前文字草稿。",
    "zh-Hant": "同一草稿刪除已確認。目前輸入仍保留，請明確選擇是否儲存目前文字草稿。",
    "en": "Deletion of the same draft was confirmed. Current input is retained; explicitly choose whether to save the current text draft.",
    "ja": "同じ下書きの削除を確認しました。現在の入力は保持しています。現在のテキスト下書きを保存するか明示的に選んでください。"
  },
  "recovery.text.acceptedState": {
    "zh-Hans": "已接受核对后的当前草稿状态，原删除结果仍不作成功确认。当前输入未自动写入，请明确选择下一步。",
    "zh-Hant": "已接受核對後的目前草稿狀態，原刪除結果仍不視為成功確認。目前輸入未自動寫入，請明確選擇下一步。",
    "en": "The checked current draft state was accepted; the original deletion is still not confirmed successful. Current input was not written automatically. Explicitly choose the next step.",
    "ja": "確認後の現在の下書き状態を受け入れましたが、元の削除の成功は確認していません。現在の入力は自動で書き込んでいません。次の操作を明示的に選んでください。"
  },
  "recovery.text.leaveNotice": {
    "zh-Hans": "已选择不保存当前本地文字；离开或关闭后，这些输入可能丢失。原文字保存请求不会因此取消。",
    "zh-Hant": "已選擇不儲存目前本機文字；離開或關閉後，這些輸入可能遺失。原文字儲存請求不會因此取消。",
    "en": "You chose not to save the current text locally. It may be lost after leaving or closing. This does not cancel the original text-save request.",
    "ja": "現在のテキストをローカル保存しないことを選択しました。移動や終了後に入力が失われる場合があります。元のテキスト保存リクエストはキャンセルされません。"
  },
  "recovery.text.invalidSave": {
    "zh-Hans": "请填写有效的镜头名称与提示词后，再保存标题和提示词。",
    "zh-Hant": "請填寫有效的鏡頭名稱與提示詞，再儲存標題與提示詞。",
    "en": "Enter a valid shot title and prompt before saving the title and prompt.",
    "ja": "有効なショット名とプロンプトを入力してから、タイトルとプロンプトを保存してください。"
  },
  "recovery.text.notAppliedCode": {
    "zh-Hans": "服务器已确认原请求未应用（{code}）。当前文字仍保留，请核对后再保存。",
    "zh-Hant": "伺服器已確認原請求未套用（{code}）。目前文字仍保留，請核對後再儲存。",
    "en": "The server confirmed the original request was not applied ({code}). Current text is retained; review it before saving again.",
    "ja": "サーバーが元のリクエストを未適用と確認しました（{code}）。現在のテキストは保持します。確認してから保存し直してください。"
  },
  "recovery.clip.otherDraft": {
    "zh-Hans": "发现另一个已保存草稿。当前输入未被替换；请明确处理已保存草稿。",
    "zh-Hant": "找到另一個已儲存草稿。目前輸入未被替換；請明確處理已儲存草稿。",
    "en": "Another saved draft was found. Current input was not replaced; explicitly resolve the saved draft.",
    "ja": "別の保存済み下書きがあります。現在の入力は置き換えていません。保存済み下書きを明示的に処理してください。"
  },
  "recovery.clip.abandoned": {
    "zh-Hans": "已放弃当前表单输入，未删除草稿记录，也未取消任何请求。已保存或稍后写入的草稿可能再次出现。",
    "zh-Hant": "已放棄目前表單輸入，未刪除草稿記錄，也未取消任何請求。已儲存或稍後寫入的草稿可能再次出現。",
    "en": "Current form input was discarded without deleting draft records or cancelling any request. Saved drafts or writes that finish later may appear again.",
    "ja": "現在のフォーム入力を破棄しました。下書き記録は削除せず、リクエストもキャンセルしていません。保存済み、または後で書き込まれる下書きが再び表示される場合があります。"
  },
  "recovery.clip.leaveUnconfirmed": {
    "zh-Hans": "本地草稿状态尚未确认。可选择“放弃当前输入，保留草稿记录”安全离开；这不会删除或取消原记录。",
    "zh-Hant": "本機草稿狀態尚未確認。可選擇「放棄目前輸入，保留草稿記錄」安全離開；這不會刪除或取消原記錄。",
    "en": "Local draft state is unconfirmed. Choose “Discard input, retain draft records” to leave safely without deleting or cancelling the original records.",
    "ja": "ローカル下書きの状態は未確認です。「入力を破棄し、下書き記録を保持」を選ぶと、元の記録を削除やキャンセルせずに移動できます。"
  },
  "recovery.clip.timelineChanged": {
    "zh-Hans": "时间线已有更新；本地草稿仍保留，请核对最新片段。",
    "zh-Hant": "時間軸已有更新；本機草稿仍保留，請核對最新片段。",
    "en": "The timeline has newer changes. The local draft is retained; review the latest clip.",
    "ja": "タイムラインが更新されています。ローカル下書きは保持しています。最新のクリップを確認してください。"
  },
  "recovery.clip.newerInput": {
    "zh-Hans": "原输入已保存到时间线。之后的新输入仍保留，请核对更新后的片段。",
    "zh-Hant": "原輸入已儲存至時間軸。之後的新輸入仍保留，請核對更新後的片段。",
    "en": "Original input was saved to the timeline. Subsequent new input is retained; review the updated clip.",
    "ja": "元の入力をタイムラインに保存しました。その後の新しい入力は保持しています。更新されたクリップを確認してください。"
  },
  "recovery.clip.savedUnconfirmed": {
    "zh-Hans": "片段已保存到时间线，但本地草稿状态尚未确认。当前输入仍保留，请重新核对本地记录。",
    "zh-Hant": "片段已儲存至時間軸，但本機草稿狀態尚未確認。目前輸入仍保留，請重新核對本機記錄。",
    "en": "The clip was saved to the timeline, but local draft state is unconfirmed. Current input is retained; recheck local records.",
    "ja": "クリップをタイムラインに保存しましたが、ローカル下書きの状態は未確認です。現在の入力は保持しています。ローカル記録を再確認してください。"
  },
  "recovery.clip.clearUnconfirmed": {
    "zh-Hans": "片段已保存，但本地草稿清除未确认。当前输入与原记录仍保留，请重新核对；不会自动重试。",
    "zh-Hant": "片段已儲存，但本機草稿清除尚未確認。目前輸入與原記錄仍保留，請重新核對；不會自動重試。",
    "en": "The clip was saved, but clearing its local draft is unconfirmed. Current input and original records are retained; recheck. No automatic retry will occur.",
    "ja": "クリップは保存しましたが、ローカル下書きの消去は未確認です。現在の入力と元の記録を保持しています。再確認してください。自動再試行は行いません。"
  },
  "recovery.backup.count.projects": {
    "zh-Hans": "项目",
    "zh-Hant": "專案",
    "en": "Projects",
    "ja": "プロジェクト"
  },
  "recovery.backup.count.assets": {
    "zh-Hans": "素材记录",
    "zh-Hant": "素材記錄",
    "en": "Asset records",
    "ja": "素材記録"
  },
  "recovery.backup.count.videoTasks": {
    "zh-Hans": "视频任务",
    "zh-Hant": "影片工作",
    "en": "Video tasks",
    "ja": "動画タスク"
  },
  "recovery.backup.count.imageTasks": {
    "zh-Hans": "图像任务",
    "zh-Hant": "圖像工作",
    "en": "Image tasks",
    "ja": "画像タスク"
  },
  "recovery.backup.count.frameTasks": {
    "zh-Hans": "抽帧任务",
    "zh-Hant": "影格擷取工作",
    "en": "Frame extraction tasks",
    "ja": "フレーム抽出タスク"
  },
  "recovery.backup.count.exports": {
    "zh-Hans": "导出任务",
    "zh-Hant": "匯出工作",
    "en": "Export tasks",
    "ja": "書き出しタスク"
  },
  "recovery.backup.count.agentRuns": {
    "zh-Hans": "Agent 运行",
    "zh-Hant": "Agent 執行",
    "en": "Agent runs",
    "ja": "Agent の実行"
  },
  "recovery.backup.count.agentProposals": {
    "zh-Hans": "Agent 提案",
    "zh-Hant": "Agent 提案",
    "en": "Agent proposals",
    "ja": "Agent の提案"
  },
  "recovery.backup.count.editTasks": {
    "zh-Hans": "编辑请求",
    "zh-Hant": "編輯請求",
    "en": "Edit requests",
    "ja": "編集リクエスト"
  },
  "recovery.backup.issue.ROW_LIMIT": {
    "zh-Hans": "记录数量超过本次核对上限，部分数量未知。",
    "zh-Hant": "記錄數量超過本次核對上限，部分數量未知。",
    "en": "The record count exceeds this check's limit; some counts are unknown.",
    "ja": "記録件数が今回の確認上限を超えており、一部の件数は不明です。"
  },
  "recovery.backup.issue.JSON_LIMIT": {
    "zh-Hans": "部分记录超过检查容量，计数未知。",
    "zh-Hant": "部分記錄超過檢查容量，計數未知。",
    "en": "Some records exceed the check capacity; their count is unknown.",
    "ja": "一部の記録が検査容量を超えており、件数は不明です。"
  },
  "recovery.backup.issue.INVALID_ROW": {
    "zh-Hans": "存在无法识别的数据库记录，部分数量未知。",
    "zh-Hant": "存在無法辨識的資料庫記錄，部分數量未知。",
    "en": "Some database records are unrecognized; some counts are unknown.",
    "ja": "認識できないデータベース記録があり、一部の件数は不明です。"
  },
  "recovery.backup.issue.SCHEMA_UNSUPPORTED": {
    "zh-Hans": "数据库版本不在支持范围内，无法完成核对。",
    "zh-Hant": "資料庫版本不在支援範圍內，無法完成核對。",
    "en": "The database version is unsupported; the check cannot complete.",
    "ja": "データベースのバージョンが対応範囲外のため、確認を完了できません。"
  },
  "recovery.backup.issue.DATABASE_UNAVAILABLE": {
    "zh-Hans": "数据库暂不可读取，无法完成核对。",
    "zh-Hant": "資料庫暫時無法讀取，無法完成核對。",
    "en": "The database cannot currently be read; the check cannot complete.",
    "ja": "現在データベースを読み取れないため、確認を完了できません。"
  },
  "recovery.backup.error.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后再核对。",
    "zh-Hant": "工作階段已過期，請重新登入後再核對。",
    "en": "Your session expired. Sign in again before checking.",
    "ja": "セッションの有効期限が切れました。再ログインしてから確認してください。"
  },
  "recovery.backup.error.protocol": {
    "zh-Hans": "返回的核对信息不完整或无法识别，请刷新后重试。",
    "zh-Hant": "傳回的核對資訊不完整或無法辨識，請重新整理後重試。",
    "en": "Returned check information is incomplete or unrecognized. Refresh and retry.",
    "ja": "返された確認情報が不完全か認識できません。更新して再試行してください。"
  },
  "recovery.backup.error.failed": {
    "zh-Hans": "暂时无法核对数据库状态。请检查连接后手动重试。",
    "zh-Hant": "暫時無法核對資料庫狀態。請檢查連線後手動重試。",
    "en": "Database status cannot be checked right now. Check the connection and retry manually.",
    "ja": "現在データベースの状態を確認できません。接続を確認して手動で再試行してください。"
  },
  "recovery.clip.error.ackMismatch": {
    "zh-Hans": "本地草稿确认与当前记录不一致；已停止覆盖。",
    "zh-Hant": "本機草稿確認與目前記錄不一致；已停止覆寫。",
    "en": "The local draft acknowledgement does not match the current record; overwriting stopped.",
    "ja": "ローカル下書きの確認応答が現在の記録と一致しないため、上書きを停止しました。"
  },
  "recovery.clip.error.newerAck": {
    "zh-Hans": "另一个本地草稿确认已更新记录；忽略旧回复。",
    "zh-Hant": "另一個本機草稿確認已更新記錄；忽略舊回覆。",
    "en": "Another local draft acknowledgement already updated the record; the older response was ignored.",
    "ja": "別のローカル下書きの確認応答で記録が更新済みのため、古い応答を無視しました。"
  },
  "recovery.clip.error.identity": {
    "zh-Hans": "工作区或服务实例已变化。当前输入仍保留；请重新载入页面并明确恢复草稿。",
    "zh-Hant": "工作區或服務實例已變更。目前輸入仍保留；請重新載入頁面並明確還原草稿。",
    "en": "The workspace or service instance changed. Current input is retained; reload the page and explicitly recover the draft.",
    "ja": "ワークスペースまたはサービスインスタンスが変わりました。現在の入力は保持しています。ページを再読み込みし、下書きを明示的に復元してください。"
  },
  "recovery.clip.error.oldRevision": {
    "zh-Hans": "本地草稿返回了旧版本；当前输入仍保留。",
    "zh-Hant": "本機草稿傳回舊版本；目前輸入仍保留。",
    "en": "The local draft returned an older revision; current input is retained.",
    "ja": "ローカル下書きが古いバージョンを返しました。現在の入力は保持します。"
  },
  "recovery.clip.error.owner": {
    "zh-Hans": "本地草稿归属不匹配；已停止载入。",
    "zh-Hant": "本機草稿歸屬不符；已停止載入。",
    "en": "Local draft ownership does not match; loading stopped.",
    "ja": "ローカル下書きの所属が一致しないため、読み込みを停止しました。"
  },
  "recovery.clip.error.saveAck": {
    "zh-Hans": "本地草稿保存确认无效；当前输入仍保留。",
    "zh-Hant": "本機草稿儲存確認無效；目前輸入仍保留。",
    "en": "The local draft save acknowledgement is invalid; current input is retained.",
    "ja": "ローカル下書きの保存確認が無効です。現在の入力は保持します。"
  },
  "recovery.clip.error.clearAck": {
    "zh-Hans": "本地草稿未被确认清除；已保留当前输入。",
    "zh-Hant": "本機草稿尚未確認清除；已保留目前輸入。",
    "en": "Clearing the local draft was not confirmed; current input is retained.",
    "ja": "ローカル下書きの消去は未確認です。現在の入力は保持します。"
  },
  "recovery.clip.error.timelineAck": {
    "zh-Hans": "片段保存确认与原始输入不一致；本地草稿仍保留。",
    "zh-Hant": "片段儲存確認與原始輸入不一致；本機草稿仍保留。",
    "en": "The clip save acknowledgement does not match the original input; the local draft is retained.",
    "ja": "クリップの保存確認が元の入力と一致しません。ローカル下書きは保持します。"
  },
  "recovery.delivery.error.identity": {
    "zh-Hans": "工作区身份已变化；当前输入与原请求仍保留，请重新打开原工作区核对。",
    "zh-Hant": "工作區身分已變更；目前輸入與原請求仍保留，請重新開啟原工作區核對。",
    "en": "Workspace identity changed. Current input and original requests are retained; reopen the original workspace to check.",
    "ja": "ワークスペースの識別情報が変わりました。現在の入力と元のリクエストを保持しています。元のワークスペースを開き直して確認してください。"
  },
  "export.revision": {
    "zh-Hans": "修订版 {revision}",
    "zh-Hant": "修訂版 {revision}",
    "en": "revision {revision}",
    "ja": "リビジョン {revision}"
  },
  "export.preflight.snapshotRevision": {
    "zh-Hans": "{label} · 修订版 {revision}",
    "zh-Hant": "{label} · 修訂版 {revision}",
    "en": "{label} · revision {revision}",
    "ja": "{label} · リビジョン {revision}"
  },
  "audio.loudness.fileRevision": {
    "zh-Hans": "{file} · 修订版 {revision}",
    "zh-Hant": "{file} · 修訂版 {revision}",
    "en": "{file} · revision {revision}",
    "ja": "{file} · リビジョン {revision}"
  },
  "export.status.queued": {
    "zh-Hans": "排队中",
    "zh-Hant": "佇列中",
    "en": "Queued",
    "ja": "待機中"
  },
  "export.status.submitting": {
    "zh-Hans": "正在提交",
    "zh-Hant": "正在提交",
    "en": "Submitting",
    "ja": "送信中"
  },
  "export.status.running": {
    "zh-Hans": "导出中",
    "zh-Hant": "匯出中",
    "en": "Exporting",
    "ja": "書き出し中"
  },
  "export.status.downloading": {
    "zh-Hans": "正在保存文件",
    "zh-Hant": "正在儲存檔案",
    "en": "Saving file",
    "ja": "ファイルを保存中"
  },
  "export.status.succeeded": {
    "zh-Hans": "已完成",
    "zh-Hant": "已完成",
    "en": "Completed",
    "ja": "完了"
  },
  "export.status.failed": {
    "zh-Hans": "失败",
    "zh-Hant": "失敗",
    "en": "Failed",
    "ja": "失敗"
  },
  "export.status.submission_unknown": {
    "zh-Hans": "提交状态待确认",
    "zh-Hant": "提交狀態待確認",
    "en": "Submission status unconfirmed",
    "ja": "送信状態は未確認"
  },
  "export.status.cancelled": {
    "zh-Hans": "已停止",
    "zh-Hant": "已停止",
    "en": "Stopped",
    "ja": "停止済み"
  },
  "export.status.ready": {
    "zh-Hans": "可下载",
    "zh-Hant": "可下載",
    "en": "Ready to download",
    "ja": "ダウンロード可能"
  },
  "export.status.pending": {
    "zh-Hans": "等待处理",
    "zh-Hant": "等待處理",
    "en": "Pending",
    "ja": "保留中"
  },
  "export.status.completed": {
    "zh-Hans": "已完成",
    "zh-Hant": "已完成",
    "en": "Completed",
    "ja": "完了"
  },
  "export.status.unknown": {
    "zh-Hans": "状态未知",
    "zh-Hant": "狀態未知",
    "en": "Status unknown",
    "ja": "状態不明"
  },
  "recovery.workspace.taskProtocol": {
    "zh-Hans": "任务的工作区身份确认无效，原编号和参数仍保留。请核对原工作区与原请求，不要重新创建请求。",
    "zh-Hant": "工作的工作區身分確認無效，原編號和參數仍保留。請核對原工作區與原請求，不要重新建立請求。",
    "en": "The task's workspace identity could not be validated. Its original ID and parameters are retained. Check the original workspace and request; do not create a replacement request.",
    "ja": "タスクのワークスペース識別情報を検証できませんでした。元の ID とパラメーターは保持されています。元のワークスペースとリクエストを確認し、別のリクエストを作成しないでください。"
  },
  "export.history.previewRevision": {
    "zh-Hans": "时间线预览 · 修订版 {revision}{snapshot}",
    "zh-Hant": "時間軸預覽 · 修訂版 {revision}{snapshot}",
    "en": "Timeline preview · revision {revision}{snapshot}",
    "ja": "タイムラインプレビュー · リビジョン {revision}{snapshot}"
  }
} as const satisfies MessageCatalog;
