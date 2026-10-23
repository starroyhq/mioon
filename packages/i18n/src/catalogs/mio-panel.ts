import type {MessageCatalog} from '../types.ts';

export const mioPanelMessages = {
  "agent.panel.note": {"zh-Hans": "补充说明", "zh-Hant": "補充說明", "en": "Additional instruction", "ja": "補足指示"},
  "agent.panel.sendNote": {"zh-Hans": "发送补充说明", "zh-Hant": "傳送補充說明", "en": "Send instruction", "ja": "補足指示を送信"},
  "agent.panel.noteDraft": {"zh-Hans": "补充说明，下一步生效…", "zh-Hant": "補充說明，下一步生效…", "en": "Add an instruction for the next step…", "ja": "次のステップに向けて補足する…"},
  "agent.panel.pausedNoteDraft": {"zh-Hans": "补充说明，继续时生效…", "zh-Hant": "補充說明，繼續時生效…", "en": "Add an instruction to use when continuing…", "ja": "再開時に反映する補足を入力…"},
  "agent.panel.attachNextRound": {"zh-Hans": "附件将在下一轮发送", "zh-Hant": "附件將在下一輪傳送", "en": "Attachments will be sent with the next round", "ja": "添付ファイルは次のラウンドで送信します"},
  "agent.panel.skipContinue": {"zh-Hans": "跳过这一处并继续", "zh-Hant": "跳過這一處並繼續", "en": "Skip this content and continue", "ja": "この箇所をスキップして続行"},
  "agent.panel.skippedOperation": {"zh-Hans": "已跳过 · {operation}", "zh-Hant": "已跳過 · {operation}", "en": "Skipped · {operation}", "ja": "スキップ済み · {operation}"},
  "agent.panel.retainedValue": {"zh-Hans": "保留你的修改：{value}", "zh-Hant": "保留你的修改：{value}", "en": "Keeping your changes: {value}", "ja": "現在の変更を保持：{value}"},
  "agent.panel.newConversation": {
    "zh-Hans": "新对话",
    "zh-Hant": "新對話",
    "en": "New conversation",
    "ja": "新しい会話"
  },
  "agent.panel.history": {
    "zh-Hans": "历史",
    "zh-Hant": "歷史",
    "en": "History",
    "ja": "履歴"
  },
  "agent.panel.steps": {
    "zh-Hans": "步骤 {count}",
    "zh-Hant": "步驟 {count}",
    "en": "Steps {count}",
    "ja": "ステップ {count}"
  },
  "agent.panel.changes": {
    "zh-Hans": "变化 {count}",
    "zh-Hant": "變化 {count}",
    "en": "Changes {count}",
    "ja": "変更 {count}"
  },
  "agent.panel.roundChanges": {
    "zh-Hans": "本轮变化 {count}",
    "zh-Hant": "本輪變化 {count}",
    "en": "Round changes {count}",
    "ja": "このラウンドの変更 {count}"
  },
  "agent.panel.usedSteps": {
    "zh-Hans": "{count} 步",
    "zh-Hant": "{count} 步",
    "en": "{count} steps",
    "ja": "{count} ステップ"
  },
  "agent.panel.elapsed": {
    "zh-Hans": "用时 {seconds} 秒",
    "zh-Hant": "用時 {seconds} 秒",
    "en": "Took {seconds} seconds",
    "ja": "所要時間 {seconds} 秒"
  },
  "agent.panel.stepElapsed": {
    "zh-Hans": "{seconds} 秒",
    "zh-Hant": "{seconds} 秒",
    "en": "{seconds} s",
    "ja": "{seconds} 秒"
  },
  "agent.panel.details": {
    "zh-Hans": "查看详情",
    "zh-Hant": "查看詳情",
    "en": "View details",
    "ja": "詳細を表示"
  },
  "agent.panel.detailsPrivacy": {
    "zh-Hans": "仅显示可安全展示的操作信息",
    "zh-Hant": "僅顯示可安全展示的操作資訊",
    "en": "Only safe operation information is shown",
    "ja": "安全に表示できる操作情報のみ表示します"
  },
  "agent.panel.try": {
    "zh-Hans": "试试这样说",
    "zh-Hant": "試試這樣說",
    "en": "Try asking",
    "ja": "たとえば、こんな依頼"
  },
  "agent.panel.suggest.description": {
    "zh-Hans": "根据参考图给镜头 03 写画面描述",
    "zh-Hant": "根據參考圖為鏡頭 03 寫畫面描述",
    "en": "Describe shot 03 using its reference image",
    "ja": "参考画像をもとにショット 03 の描写を書く"
  },
  "agent.panel.suggest.gaps": {
    "zh-Hans": "检查时间线上的空隙和重叠",
    "zh-Hant": "檢查時間軸上的空隙和重疊",
    "en": "Check the timeline for gaps and overlaps",
    "ja": "タイムラインの隙間と重なりを確認する"
  },
  "agent.panel.suggest.subtitles": {
    "zh-Hans": "把所有字幕统一成一个样式",
    "zh-Hant": "把所有字幕統一成一個樣式",
    "en": "Give all subtitles the same style",
    "ja": "字幕のスタイルを統一する"
  },
  "agent.panel.suggest.export": {
    "zh-Hans": "导出前检查一遍问题",
    "zh-Hant": "匯出前檢查一遍問題",
    "en": "Check for issues before exporting",
    "ja": "書き出す前に問題がないか確認する"
  },
  "agent.panel.continuedraft": {
    "zh-Hans": "继续对话，或让 Mio 做点别的…",
    "zh-Hant": "繼續對話，或讓 Mio 做點別的…",
    "en": "Continue the conversation, or ask Mio for something else…",
    "ja": "会話を続けるか、Mio に別のことを頼む…"
  },
  "agent.panel.blockedDraft": {
    "zh-Hans": "先处理上次未完成的执行",
    "zh-Hant": "先處理上次未完成的執行",
    "en": "Resolve the unfinished run first",
    "ja": "先に前回の未完了の実行を確認してください"
  },
  "agent.panel.modelMenu": {
    "zh-Hans": "当前模型与范围",
    "zh-Hant": "目前模型與範圍",
    "en": "Current model and scope",
    "ja": "現在のモデルと範囲"
  },
  "agent.panel.changeModel": {
    "zh-Hans": "在设置中更换…",
    "zh-Hant": "在設定中更換…",
    "en": "Change in Settings…",
    "ja": "設定で変更…"
  },
  "agent.panel.budgetTitle": {
    "zh-Hans": "已暂停 · 达到每轮步数上限",
    "zh-Hant": "已暫停 · 達到每輪步數上限",
    "en": "Paused · Step limit reached",
    "ja": "一時停止 · ステップ上限に到達"
  },
  "agent.panel.budgetBody": {
    "zh-Hans": "这一轮已执行 {count} 步，检查变化记录后可以继续执行下一轮",
    "zh-Hant": "本輪已執行 {count} 步，檢查變化紀錄後可以繼續執行下一輪",
    "en": "This round has used {count} steps. Review the changes before continuing with another round",
    "ja": "このラウンドは {count} ステップ実行しました。変更を確認してから次のラウンドを続行できます"
  },
  "agent.panel.pauseTitle": {
    "zh-Hans": "已暂停 · 你暂停了这一轮",
    "zh-Hant": "已暫停 · 你暫停了這一輪",
    "en": "Paused · You paused this round",
    "ja": "一時停止 · このラウンドを一時停止しました"
  },
  "agent.panel.pauseBody": {
    "zh-Hans": "所有已完成的变化都已保留，继续后从下一步开始",
    "zh-Hant": "所有已完成的變化都已保留，繼續後從下一步開始",
    "en": "Completed changes are retained. Continue from the next step",
    "ja": "完了した変更は保持されています。次のステップから続行します"
  },
  "agent.panel.conflictTitle": {
    "zh-Hans": "已暂停 · 你修改了同一处",
    "zh-Hant": "已暫停 · 你修改了同一處",
    "en": "Paused · You edited the same content",
    "ja": "一時停止 · 同じ箇所が手動で編集されました"
  },
  "agent.panel.conflictTarget": {"zh-Hans":"目标","zh-Hant":"目標","en":"Target","ja":"対象"},
  "agent.panel.yourChanges": {"zh-Hans":"你的修改","zh-Hant":"你的修改","en":"Your changes","ja":"現在の変更"},
  "agent.panel.originalPlan": {"zh-Hans":"Mio 原计划","zh-Hant":"Mio 原計畫","en":"Mio’s original plan","ja":"Mio の元の計画"},
  "agent.panel.conflictBody": {
    "zh-Hans": "继续后 Mio 跳过这一处，本轮不再修改，接着做后面的步骤",
    "zh-Hant": "繼續後 Mio 跳過這一處，本輪不再修改，接著完成後面的步驟",
    "en": "Mio will skip this content for the rest of this round and continue with the remaining steps",
    "ja": "Mio はこのラウンドでこの箇所を変更せず、残りのステップを続行します"
  },
  "agent.panel.approvalTitle": {
    "zh-Hans": "确认这次操作",
    "zh-Hant": "確認這次操作",
    "en": "Confirm this operation",
    "ja": "この操作を確認"
  },
  "agent.panel.confirmGenerate": {
    "zh-Hans": "确认生成",
    "zh-Hant": "確認生成",
    "en": "Confirm generation",
    "ja": "生成を確認"
  },
  "agent.panel.reject": {
    "zh-Hans": "拒绝",
    "zh-Hant": "拒絕",
    "en": "Reject",
    "ja": "拒否"
  },
  "agent.panel.fee": {
    "zh-Hans": "可能产生费用，按服务商实际计费",
    "zh-Hant": "可能產生費用，按服務商實際計費",
    "en": "Charges may apply at the provider’s rates",
    "ja": "プロバイダーの料金に従い、費用が発生する場合があります"
  },
  "agent.panel.paidSettings": {
    "zh-Hans": "以后都直接调用？在设置中开启",
    "zh-Hant": "以後都直接呼叫？在設定中開啟",
    "en": "Allow future calls directly? Enable in Settings",
    "ja": "次回から直接実行する場合は設定で有効にできます"
  },
  "agent.panel.provider": {
    "zh-Hans": "服务商",
    "zh-Hant": "服務商",
    "en": "Provider",
    "ja": "プロバイダー"
  },
  "agent.panel.mode": {
    "zh-Hans": "方式",
    "zh-Hant": "方式",
    "en": "Mode",
    "ja": "方式"
  },
  "agent.panel.ratio": {
    "zh-Hans": "比例",
    "zh-Hant": "比例",
    "en": "Aspect ratio",
    "ja": "縦横比"
  },
  "agent.panel.duration": {
    "zh-Hans": "时长",
    "zh-Hant": "時長",
    "en": "Duration",
    "ja": "長さ"
  },
  "agent.panel.result": {
    "zh-Hans": "结果",
    "zh-Hant": "結果",
    "en": "Result",
    "ja": "結果"
  },
  "agent.panel.newVersion": {
    "zh-Hans": "新增版本",
    "zh-Hant": "新增版本",
    "en": "New version",
    "ja": "新しいバージョン"
  },
  "agent.panel.recoveryTitle": {
    "zh-Hans": "上次执行未完成",
    "zh-Hant": "上次執行未完成",
    "en": "Previous run unfinished",
    "ja": "前回の実行が未完了です"
  },
  "agent.panel.recoveryBody": {
    "zh-Hans": "请先核对结果未知的步骤，再继续执行或放弃",
    "zh-Hant": "請先核對結果未知的步驟，再繼續執行或放棄",
    "en": "Check steps with unknown results before continuing or abandoning this run",
    "ja": "結果が不明なステップを確認してから、続行または破棄してください"
  },
  "agent.panel.recoveryThen": {
    "zh-Hans": "然后选择继续或放弃",
    "zh-Hant": "然後選擇繼續或放棄",
    "en": "Then continue or abandon",
    "ja": "確認後、続行または破棄を選択"
  },
  "agent.panel.abandon": {
    "zh-Hans": "放弃",
    "zh-Hant": "放棄",
    "en": "Abandon",
    "ja": "破棄"
  },
  "agent.panel.abandonHelp": {
    "zh-Hans": "放弃后，已完成的变化仍保留，可在历史中撤销",
    "zh-Hant": "放棄後，已完成的變化仍保留，可在歷史中復原",
    "en": "Completed changes remain after abandoning this run and can be undone from history",
    "ja": "破棄しても完了した変更は保持され、履歴から取り消せます"
  },
  "agent.panel.unknownStep": {
    "zh-Hans": "先核对：{name}",
    "zh-Hant": "先核對：{name}",
    "en": "Check first: {name}",
    "ja": "先に確認：{name}"
  },
  "agent.panel.unknownModel": {
    "zh-Hans": "模型请求可能已发送，请先标记为失败再继续",
    "zh-Hant": "模型請求可能已傳送，請先標記為失敗再繼續",
    "en": "The model request may have been sent. Mark it as failed before continuing",
    "ja": "モデルリクエストは送信済みの可能性があります。失敗として記録してから続行してください"
  },
  "agent.panel.markFailed": {
    "zh-Hans": "标记为失败",
    "zh-Hant": "標記為失敗",
    "en": "Mark as failed",
    "ja": "失敗として記録"
  },
  "agent.panel.checkProvider": {
    "zh-Hans": "向服务商核对结果",
    "zh-Hant": "向服務商核對結果",
    "en": "Check the result with the provider",
    "ja": "プロバイダーに結果を確認"
  },
  "agent.panel.failedTail": {
    "zh-Hans": "这一步没有成功，后面的步骤还没有执行",
    "zh-Hant": "這一步沒有成功，後面的步驟還沒有執行",
    "en": "This step failed. The following steps have not run",
    "ja": "このステップは失敗し、後続のステップは実行されていません"
  },
  "agent.panel.authorizationTitle": {
    "zh-Hans": "首次向 {model} 发送",
    "zh-Hant": "首次向 {model} 傳送",
    "en": "First time sending to {model}",
    "ja": "{model} への初回送信"
  },
  "agent.panel.authorizationIntro": {
    "zh-Hans": "发送前请确认以下内容。确认一次后，同一目标与范围不再询问",
    "zh-Hant": "傳送前請確認以下內容。確認一次後，同一目標與範圍不再詢問",
    "en": "Review the following before sending. The same destination and scope will not be requested again",
    "ja": "送信前に以下を確認してください。一度許可すると、同じ送信先と範囲では再確認しません"
  },
  "agent.panel.authorizationScope": {
    "zh-Hans": "发送范围",
    "zh-Hant": "傳送範圍",
    "en": "Sending scope",
    "ja": "送信範囲"
  },
  "agent.panel.authorizationContent": {
    "zh-Hans": "本条消息、当前项目分镜与镜头描述、时间线结构与属性、素材信息、创作方向、素材标注与备注、主体库，以及按操作需要返回的生成记录",
    "zh-Hant": "本則訊息、目前專案分鏡與鏡頭描述、時間軸結構與屬性、素材資訊、創作方向、素材標註與備註、主體庫，以及按操作需要傳回的生成紀錄",
    "en": "This message; the current project’s storyboard and shot descriptions, timeline structure and properties, asset information, creative direction, annotations and notes, subject library, and generation records returned as needed by operations",
    "ja": "このメッセージ、現在のプロジェクトの絵コンテとショットの描写、タイムラインの構造と属性、素材情報、制作方針、素材の注釈とメモ、被写体ライブラリ、操作に必要な生成記録"
  },
  "agent.panel.authorizationExcluded": {
    "zh-Hans": "不会向此助理模型发送媒体文件本身或密钥",
    "zh-Hant": "不會向此助理模型傳送媒體檔案本身或密鑰",
    "en": "Media files themselves and credentials are not sent to this assistant model",
    "ja": "この Mio のモデルにメディアファイル本体や認証情報は送信しません"
  },
  "agent.panel.authorizationDestination": {
    "zh-Hans": "目标地址与模型",
    "zh-Hant": "目標位址與模型",
    "en": "Destination and model",
    "ja": "送信先アドレスとモデル"
  },
  "agent.panel.authorizationFeeTitle": {
    "zh-Hans": "可能计费",
    "zh-Hant": "可能計費",
    "en": "Possible charges",
    "ja": "費用について"
  },
  "agent.panel.authorizationFee": {
    "zh-Hans": "服务可能按用量计费，费用计入你在该服务商的账户",
    "zh-Hant": "服務可能按用量計費，費用計入你在該服務商的帳戶",
    "en": "The service may charge by usage through your provider account",
    "ja": "サービスの利用量に応じて、プロバイダーのアカウントに費用が請求される場合があります"
  },
  "agent.panel.authorizationRevoke": {
    "zh-Hans": "可在 设置 › Mio 中撤销授权",
    "zh-Hant": "可在 設定 › Mio 中撤銷授權",
    "en": "Revoke authorization in Settings › Mio",
    "ja": "設定 › Mio で許可を取り消せます"
  },
  "agent.panel.confirmSend": {
    "zh-Hans": "确认并发送",
    "zh-Hant": "確認並傳送",
    "en": "Confirm and send",
    "ja": "確認して送信"
  },
  "agent.panel.undoConfirm": {
    "zh-Hans": "撤销这一轮已完成的可逆变化？",
    "zh-Hant": "復原本輪已完成的可逆變化？",
    "en": "Undo the reversible changes completed in this round?",
    "ja": "このラウンドで完了した、取り消し可能な変更を取り消しますか？"
  },
  "agent.panel.approvalReadonly": {
    "zh-Hans": "确认查看当前项目内容",
    "zh-Hant": "確認查看目前專案內容",
    "en": "Confirm reading the current project",
    "ja": "現在のプロジェクトの閲覧を確認"
  },
  "agent.panel.editingItem": {
    "zh-Hans": "此处仍有未结束的编辑",
    "zh-Hant": "此處仍有未結束的編輯",
    "en": "This content still has unfinished edits",
    "ja": "この箇所に未完了の編集があります"
  },
  "agent.panel.emptyHistory": {
    "zh-Hans": "还没有记录",
    "zh-Hant": "還沒有紀錄",
    "en": "No records yet",
    "ja": "まだ履歴がありません"
  },
  "agent.panel.stepStatus.intent": {
    "zh-Hans": "准备执行",
    "zh-Hant": "準備執行",
    "en": "Preparing",
    "ja": "実行を準備中"
  },
  "agent.panel.stepStatus.awaiting_approval": {
    "zh-Hans": "等待你确认",
    "zh-Hant": "等待你確認",
    "en": "Waiting for your approval",
    "ja": "確認待ち"
  },
  "agent.panel.stepStatus.dispatch_started": {
    "zh-Hans": "正在执行",
    "zh-Hant": "正在執行",
    "en": "Running",
    "ja": "実行中"
  },
  "agent.panel.stepStatus.completed": {
    "zh-Hans": "已完成",
    "zh-Hant": "已完成",
    "en": "Completed",
    "ja": "完了"
  },
  "agent.panel.stepStatus.denied": {
    "zh-Hans": "已拒绝",
    "zh-Hant": "已拒絕",
    "en": "Declined",
    "ja": "拒否済み"
  },
  "agent.panel.stepStatus.rejected": {
    "zh-Hans": "未执行",
    "zh-Hant": "未執行",
    "en": "Not executed",
    "ja": "未実行"
  },
  "agent.panel.stepStatus.failed": {
    "zh-Hans": "未成功",
    "zh-Hant": "未成功",
    "en": "Failed",
    "ja": "失敗"
  },
  "agent.panel.stepStatus.unknown": {
    "zh-Hans": "结果未知",
    "zh-Hant": "結果未知",
    "en": "Result unknown",
    "ja": "結果不明"
  },
  "agent.display.field.durationFrames": {
    "zh-Hans": "时长",
    "zh-Hant": "時長",
    "en": "Duration",
    "ja": "長さ"
  },
  "agent.display.field.sourceInFrame": {
    "zh-Hans": "入点",
    "zh-Hant": "入點",
    "en": "In-point",
    "ja": "イン点"
  },
  "agent.display.field.sourceOutFrame": {
    "zh-Hans": "出点",
    "zh-Hant": "出點",
    "en": "Out-point",
    "ja": "アウト点"
  },
  "agent.display.field.startFrame": {
    "zh-Hans": "时间线位置",
    "zh-Hant": "時間軸位置",
    "en": "Timeline position",
    "ja": "タイムライン位置"
  },
  "agent.display.field.positionX": {
    "zh-Hans": "水平位置",
    "zh-Hant": "水平位置",
    "en": "Horizontal position",
    "ja": "水平位置"
  },
  "agent.display.field.positionY": {
    "zh-Hans": "垂直位置",
    "zh-Hant": "垂直位置",
    "en": "Vertical position",
    "ja": "垂直位置"
  },
  "agent.display.field.gainDb": {
    "zh-Hans": "音量",
    "zh-Hant": "音量",
    "en": "Volume",
    "ja": "音量"
  },
  "agent.display.field.fadeInFrames": {
    "zh-Hans": "淡入",
    "zh-Hant": "淡入",
    "en": "Fade in",
    "ja": "フェードイン"
  },
  "agent.display.field.fadeOutFrames": {
    "zh-Hans": "淡出",
    "zh-Hant": "淡出",
    "en": "Fade out",
    "ja": "フェードアウト"
  },
  "agent.display.field.aspectRatio": {
    "zh-Hans": "比例",
    "zh-Hant": "比例",
    "en": "Aspect ratio",
    "ja": "縦横比"
  },
  "agent.display.field.durationSeconds": {
    "zh-Hans": "时长",
    "zh-Hant": "時長",
    "en": "Duration",
    "ja": "長さ"
  },
  "agent.display.field.description": {
    "zh-Hans": "画面描述",
    "zh-Hant": "畫面描述",
    "en": "Description",
    "ja": "描写"
  },
  "agent.display.field.subtitleText": {
    "zh-Hans": "字幕文字",
    "zh-Hant": "字幕文字",
    "en": "Subtitle text",
    "ja": "字幕テキスト"
  },
  "agent.display.field.provider": {
    "zh-Hans": "服务商",
    "zh-Hant": "服務商",
    "en": "Provider",
    "ja": "プロバイダー"
  },
  "agent.display.field.model": {
    "zh-Hans": "模型",
    "zh-Hant": "模型",
    "en": "Model",
    "ja": "モデル"
  },
  "agent.display.field.resolution": {
    "zh-Hans": "分辨率",
    "zh-Hant": "解析度",
    "en": "Resolution",
    "ja": "解像度"
  },
  "agent.display.field.generateAudio": {
    "zh-Hans": "生成声音",
    "zh-Hant": "生成聲音",
    "en": "Generate audio",
    "ja": "音声を生成"
  },
  "agent.display.field.seed": {
    "zh-Hans": "随机种子",
    "zh-Hant": "隨機種子",
    "en": "Seed",
    "ja": "シード"
  },
  "agent.display.field.width": {
    "zh-Hans": "宽度",
    "zh-Hant": "寬度",
    "en": "Width",
    "ja": "幅"
  },
  "agent.display.field.height": {
    "zh-Hans": "高度",
    "zh-Hant": "高度",
    "en": "Height",
    "ja": "高さ"
  },
  "agent.display.field.count": {
    "zh-Hans": "数量",
    "zh-Hant": "數量",
    "en": "Count",
    "ja": "数"
  },
  "agent.display.field.quality": {
    "zh-Hans": "质量",
    "zh-Hant": "品質",
    "en": "Quality",
    "ja": "品質"
  },
  "agent.display.field.outputFormat": {
    "zh-Hans": "格式",
    "zh-Hant": "格式",
    "en": "Format",
    "ja": "形式"
  },
  "agent.display.field.background": {
    "zh-Hans": "背景",
    "zh-Hant": "背景",
    "en": "Background",
    "ja": "背景"
  },
  "agent.display.target.project": {
    "zh-Hans": "项目",
    "zh-Hant": "專案",
    "en": "Project",
    "ja": "プロジェクト"
  },
  "agent.display.target.shot": {
    "zh-Hans": "镜头",
    "zh-Hant": "鏡頭",
    "en": "Shot",
    "ja": "ショット"
  },
  "agent.display.target.node": {
    "zh-Hans": "画板内容",
    "zh-Hant": "畫板內容",
    "en": "Canvas content",
    "ja": "キャンバスの内容"
  },
  "agent.display.target.edge": {
    "zh-Hans": "连线",
    "zh-Hant": "連線",
    "en": "Connection",
    "ja": "接続"
  },
  "agent.display.target.asset": {
    "zh-Hans": "素材",
    "zh-Hant": "素材",
    "en": "Asset",
    "ja": "素材"
  },
  "agent.display.target.version": {
    "zh-Hans": "版本",
    "zh-Hant": "版本",
    "en": "Version",
    "ja": "バージョン"
  },
  "agent.display.target.job": {
    "zh-Hans": "生成记录",
    "zh-Hant": "生成紀錄",
    "en": "Generation record",
    "ja": "生成記録"
  },
  "agent.display.target.export": {
    "zh-Hans": "导出记录",
    "zh-Hant": "匯出紀錄",
    "en": "Export record",
    "ja": "書き出し記録"
  },
  "agent.display.target.asset_range": {
    "zh-Hans": "素材选区",
    "zh-Hant": "素材選區",
    "en": "Asset range",
    "ja": "素材の範囲"
  },
  "agent.display.target.asset_disposition": {
    "zh-Hans": "素材标记",
    "zh-Hant": "素材標記",
    "en": "Asset mark",
    "ja": "素材のマーク"
  },
  "agent.display.target.asset_annotation": {
    "zh-Hans": "素材标注",
    "zh-Hant": "素材標註",
    "en": "Asset annotation",
    "ja": "素材の注釈"
  },
  "agent.display.target.subject": {
    "zh-Hans": "主体",
    "zh-Hant": "主體",
    "en": "Subject",
    "ja": "被写体"
  },
  "agent.display.target.subject_version": {
    "zh-Hans": "主体版本",
    "zh-Hant": "主體版本",
    "en": "Subject version",
    "ja": "被写体のバージョン"
  },
  "agent.display.target.subject_binding": {
    "zh-Hans": "主体关联",
    "zh-Hant": "主體關聯",
    "en": "Subject binding",
    "ja": "被写体の関連付け"
  },
  "agent.display.target.image_task": {
    "zh-Hans": "图像生成",
    "zh-Hant": "圖像生成",
    "en": "Image generation",
    "ja": "画像生成"
  },
  "agent.display.target.image_group": {
    "zh-Hans": "图像组",
    "zh-Hant": "圖像群組",
    "en": "Image group",
    "ja": "画像グループ"
  },
  "agent.display.target.image_version": {
    "zh-Hans": "图像版本",
    "zh-Hant": "圖像版本",
    "en": "Image version",
    "ja": "画像バージョン"
  },
  "agent.display.target.frame_task": {
    "zh-Hans": "提取画面",
    "zh-Hant": "擷取畫面",
    "en": "Frame extraction",
    "ja": "フレーム抽出"
  },
  "agent.display.target.timeline": {
    "zh-Hans": "时间线",
    "zh-Hant": "時間軸",
    "en": "Timeline",
    "ja": "タイムライン"
  },
  "agent.display.target.timeline_clip": {
    "zh-Hans": "片段",
    "zh-Hant": "片段",
    "en": "Clip",
    "ja": "クリップ"
  },
  "agent.display.target.timeline_track": {
    "zh-Hans": "轨道",
    "zh-Hant": "軌道",
    "en": "Track",
    "ja": "トラック"
  },
  "agent.display.target.timeline_subtitle": {
    "zh-Hans": "字幕",
    "zh-Hant": "字幕",
    "en": "Subtitle",
    "ja": "字幕"
  },
  "agent.display.target.unknown": {
    "zh-Hans": "项目内容",
    "zh-Hant": "專案內容",
    "en": "Project content",
    "ja": "プロジェクトの内容"
  },
  "agent.display.fallback": {
    "zh-Hans": "处理项目内容",
    "zh-Hant": "處理專案內容",
    "en": "Work on project content",
    "ja": "プロジェクトの内容を処理"
  },
  "agent.display.model": {
    "zh-Hans": "理解你的要求",
    "zh-Hant": "理解你的要求",
    "en": "Understand your request",
    "ja": "依頼を理解する"
  },
  "agent.display.wait": {
    "zh-Hans": "等待后台结果",
    "zh-Hant": "等待背景結果",
    "en": "Wait for background results",
    "ja": "バックグラウンドの結果を待つ"
  },
  "agent.display.removed": {
    "zh-Hans": "已移除",
    "zh-Hant": "已移除",
    "en": "Removed",
    "ja": "削除済み"
  },
  "agent.display.empty": {
    "zh-Hans": "空",
    "zh-Hant": "空",
    "en": "Empty",
    "ja": "空"
  },
  "agent.display.on": {
    "zh-Hans": "开启",
    "zh-Hant": "開啟",
    "en": "On",
    "ja": "オン"
  },
  "agent.display.off": {
    "zh-Hans": "关闭",
    "zh-Hant": "關閉",
    "en": "Off",
    "ja": "オフ"
  },
  "agent.display.muted": {
    "zh-Hans": "静音",
    "zh-Hant": "靜音",
    "en": "Muted",
    "ja": "ミュート"
  },
  "agent.display.moreTargets": {
    "zh-Hans": "另 {count} 处",
    "zh-Hant": "另 {count} 處",
    "en": "{count} more",
    "ja": "ほか {count} 箇所"
  },
  "agent.display.moreFields": {
    "zh-Hans": "等 {count} 项",
    "zh-Hant": "等 {count} 項",
    "en": "{count} more",
    "ja": "ほか {count} 項目"
  },
  "agent.display.setField": {
    "zh-Hans": "设置{field} {value}",
    "zh-Hant": "設定{field} {value}",
    "en": "Set {field} to {value}",
    "ja": "{field}を{value}に設定"
  },
  "agent.display.add.subtitle": {
    "zh-Hans": "添加字幕「{text}」",
    "zh-Hant": "新增字幕「{text}」",
    "en": "Add subtitle “{text}”",
    "ja": "字幕「{text}」を追加"
  },
  "agent.display.add.clip": {
    "zh-Hans": "添加片段「{text}」",
    "zh-Hant": "新增片段「{text}」",
    "en": "Add clip “{text}”",
    "ja": "クリップ「{text}」を追加"
  },
  "agent.display.add.shot": {
    "zh-Hans": "添加镜头「{text}」",
    "zh-Hant": "新增鏡頭「{text}」",
    "en": "Add shot “{text}”",
    "ja": "ショット「{text}」を追加"
  },
  "agent.display.unit.frames": {
    "zh-Hans": "{value} 帧",
    "zh-Hant": "{value} 影格",
    "en": "{value} frames",
    "ja": "{value} フレーム"
  },
  "agent.display.unit.seconds": {
    "zh-Hans": "{value} 秒",
    "zh-Hant": "{value} 秒",
    "en": "{value} s",
    "ja": "{value} 秒"
  },
  "agent.display.unit.db": {
    "zh-Hans": "{value} dB",
    "zh-Hant": "{value} dB",
    "en": "{value} dB",
    "ja": "{value} dB"
  },
  "agent.display.unit.pixels": {
    "zh-Hans": "{value} px",
    "zh-Hant": "{value} px",
    "en": "{value} px",
    "ja": "{value} px"
  },
  "agent.display.unit.count": {
    "zh-Hans": "{value}",
    "zh-Hant": "{value}",
    "en": "{value}",
    "ja": "{value}"
  },
  "agent.display.operation.project.inspect": {
    "zh-Hans": "查看项目",
    "zh-Hant": "查看專案",
    "en": "Read project",
    "ja": "プロジェクトを確認"
  },
  "agent.display.operation.project.rename": {
    "zh-Hans": "修改项目名称",
    "zh-Hant": "修改專案名稱",
    "en": "Rename project",
    "ja": "プロジェクト名を変更"
  },
  "agent.display.operation.asset.inspect": {
    "zh-Hans": "查看素材",
    "zh-Hant": "查看素材",
    "en": "Read asset",
    "ja": "素材を確認"
  },
  "agent.display.operation.asset.list": {
    "zh-Hans": "查看项目素材",
    "zh-Hant": "查看專案素材",
    "en": "List project assets",
    "ja": "プロジェクトの素材を確認"
  },
  "agent.display.operation.shot.inspect": {
    "zh-Hans": "查看镜头",
    "zh-Hant": "查看鏡頭",
    "en": "Read shot",
    "ja": "ショットを確認"
  },
  "agent.display.operation.shot.create": {
    "zh-Hans": "添加镜头",
    "zh-Hant": "新增鏡頭",
    "en": "Add shot",
    "ja": "ショットを追加"
  },
  "agent.display.operation.shot.update": {
    "zh-Hans": "修改镜头",
    "zh-Hant": "修改鏡頭",
    "en": "Edit shot",
    "ja": "ショットを編集"
  },
  "agent.display.operation.shot.reorder": {
    "zh-Hans": "调整镜头顺序",
    "zh-Hant": "調整鏡頭順序",
    "en": "Reorder shots",
    "ja": "ショット順を変更"
  },
  "agent.display.operation.node.inspect": {
    "zh-Hans": "查看画板内容",
    "zh-Hant": "查看畫板內容",
    "en": "Read canvas content",
    "ja": "キャンバスの内容を確認"
  },
  "agent.display.operation.node.create": {
    "zh-Hans": "添加画板内容",
    "zh-Hant": "新增畫板內容",
    "en": "Add canvas content",
    "ja": "キャンバスに内容を追加"
  },
  "agent.display.operation.node.update": {
    "zh-Hans": "修改画板内容",
    "zh-Hant": "修改畫板內容",
    "en": "Edit canvas content",
    "ja": "キャンバスの内容を編集"
  },
  "agent.display.operation.edge.inspect": {
    "zh-Hans": "查看连线",
    "zh-Hant": "查看連線",
    "en": "Read connection",
    "ja": "接続を確認"
  },
  "agent.display.operation.edge.create": {
    "zh-Hans": "添加连线",
    "zh-Hant": "新增連線",
    "en": "Add connection",
    "ja": "接続を追加"
  },
  "agent.display.operation.edge.delete": {
    "zh-Hans": "移除连线",
    "zh-Hant": "移除連線",
    "en": "Remove connection",
    "ja": "接続を削除"
  },
  "agent.display.operation.reference.attach": {
    "zh-Hans": "关联参考图",
    "zh-Hant": "關聯參考圖",
    "en": "Attach reference image",
    "ja": "参考画像を関連付け"
  },
  "agent.display.operation.reference.detach": {
    "zh-Hans": "取消参考图关联",
    "zh-Hant": "取消參考圖關聯",
    "en": "Detach reference image",
    "ja": "参考画像の関連付けを解除"
  },
  "agent.display.operation.version.select": {
    "zh-Hans": "选用版本",
    "zh-Hant": "選用版本",
    "en": "Select version",
    "ja": "バージョンを選択"
  },
  "agent.display.operation.version.list": {
    "zh-Hans": "查看版本",
    "zh-Hant": "查看版本",
    "en": "List versions",
    "ja": "バージョンを確認"
  },
  "agent.display.operation.generation.submit": {
    "zh-Hans": "提交生成",
    "zh-Hant": "提交生成",
    "en": "Submit generation",
    "ja": "生成を送信"
  },
  "agent.display.operation.image.generate": {
    "zh-Hans": "提交图像生成",
    "zh-Hant": "提交圖像生成",
    "en": "Submit image generation",
    "ja": "画像生成を送信"
  },
  "agent.display.operation.timeline.inspect": {
    "zh-Hans": "查看时间线",
    "zh-Hant": "查看時間軸",
    "en": "Read timeline",
    "ja": "タイムラインを確認"
  },
  "agent.display.operation.timeline.format.get": {
    "zh-Hans": "查看画面规格",
    "zh-Hant": "查看畫面規格",
    "en": "Read canvas format",
    "ja": "映像の仕様を確認"
  },
  "agent.display.operation.timeline.format.set": {
    "zh-Hans": "修改画面规格",
    "zh-Hant": "修改畫面規格",
    "en": "Edit canvas format",
    "ja": "映像の仕様を変更"
  },
  "agent.display.operation.timeline.clip.add": {
    "zh-Hans": "添加片段",
    "zh-Hant": "新增片段",
    "en": "Add clip",
    "ja": "クリップを追加"
  },
  "agent.display.operation.timeline.clip.update": {
    "zh-Hans": "调整片段",
    "zh-Hant": "調整片段",
    "en": "Adjust clip",
    "ja": "クリップを調整"
  },
  "agent.display.operation.timeline.clip.replaceSource": {
    "zh-Hans": "替换片段素材",
    "zh-Hant": "替換片段素材",
    "en": "Replace clip source",
    "ja": "クリップの素材を置換"
  },
  "agent.display.operation.timeline.clip.remove": {
    "zh-Hans": "移除片段",
    "zh-Hant": "移除片段",
    "en": "Remove clip",
    "ja": "クリップを削除"
  },
  "agent.display.operation.timeline.clip.rippleRemove": {
    "zh-Hans": "移除片段并衔接",
    "zh-Hant": "移除片段並銜接",
    "en": "Ripple remove clip",
    "ja": "クリップをリップル削除"
  },
  "agent.display.operation.timeline.clip.split": {
    "zh-Hans": "分割片段",
    "zh-Hant": "分割片段",
    "en": "Split clip",
    "ja": "クリップを分割"
  },
  "agent.display.operation.timeline.track.add": {
    "zh-Hans": "添加轨道",
    "zh-Hant": "新增軌道",
    "en": "Add track",
    "ja": "トラックを追加"
  },
  "agent.display.operation.timeline.track.update": {
    "zh-Hans": "调整轨道",
    "zh-Hant": "調整軌道",
    "en": "Adjust track",
    "ja": "トラックを調整"
  },
  "agent.display.operation.timeline.subtitle.add": {
    "zh-Hans": "添加字幕",
    "zh-Hant": "新增字幕",
    "en": "Add subtitle",
    "ja": "字幕を追加"
  },
  "agent.display.operation.timeline.subtitle.update": {
    "zh-Hans": "修改字幕",
    "zh-Hant": "修改字幕",
    "en": "Edit subtitle",
    "ja": "字幕を編集"
  },
  "agent.display.operation.timeline.subtitle.remove": {
    "zh-Hans": "移除字幕",
    "zh-Hant": "移除字幕",
    "en": "Remove subtitle",
    "ja": "字幕を削除"
  },
  "agent.display.operation.timeline.render": {
    "zh-Hans": "渲染预览",
    "zh-Hant": "算繪預覽",
    "en": "Render preview",
    "ja": "プレビューをレンダリング"
  },
  "agent.display.operation.timeline.seed": {
    "zh-Hans": "编排时间线",
    "zh-Hant": "編排時間軸",
    "en": "Arrange timeline",
    "ja": "タイムラインを構成"
  },
  "agent.display.operation.timeline.clip.refreshSources": {
    "zh-Hans": "更新片段来源",
    "zh-Hant": "更新片段來源",
    "en": "Refresh clip sources",
    "ja": "クリップのソースを更新"
  },
  "agent.display.operation.timeline.shots.append": {
    "zh-Hans": "追加镜头到时间线",
    "zh-Hant": "附加鏡頭到時間軸",
    "en": "Append shots to timeline",
    "ja": "ショットをタイムラインに追加"
  },
  "agent.display.operation.timeline.history.get": {
    "zh-Hans": "查看编辑历史",
    "zh-Hant": "查看編輯歷史",
    "en": "Read edit history",
    "ja": "編集履歴を確認"
  },
  "agent.display.operation.timeline.loudness.prepare": {
    "zh-Hans": "检查响度",
    "zh-Hant": "檢查響度",
    "en": "Check loudness",
    "ja": "ラウドネスを確認"
  },
  "agent.display.operation.timeline.loudness.apply": {
    "zh-Hans": "调整整体响度",
    "zh-Hant": "調整整體響度",
    "en": "Adjust overall loudness",
    "ja": "全体のラウドネスを調整"
  },
  "agent.display.operation.timeline.clip.loudness": {
    "zh-Hans": "检查片段响度",
    "zh-Hant": "檢查片段響度",
    "en": "Check clip loudness",
    "ja": "クリップのラウドネスを確認"
  },
  "agent.display.operation.timeline.export.preflight": {
    "zh-Hans": "检查导出条件",
    "zh-Hant": "檢查匯出條件",
    "en": "Check export readiness",
    "ja": "書き出し条件を確認"
  },
  "agent.display.operation.timeline.export.samplePeak": {
    "zh-Hans": "检查音频峰值",
    "zh-Hant": "檢查音訊峰值",
    "en": "Check audio peaks",
    "ja": "音声のピークを確認"
  },
  "agent.display.operation.timeline.export.loudness": {
    "zh-Hans": "检查导出响度",
    "zh-Hant": "檢查匯出響度",
    "en": "Check export loudness",
    "ja": "書き出しのラウドネスを確認"
  },
  "agent.display.operation.timeline.export.capabilities": {
    "zh-Hans": "检查视频工具",
    "zh-Hant": "檢查影片工具",
    "en": "Check video tools",
    "ja": "動画ツールを確認"
  },
  "agent.display.operation.timeline.audioPreview.plan": {
    "zh-Hans": "准备声音试听",
    "zh-Hant": "準備聲音試聽",
    "en": "Prepare audio preview",
    "ja": "音声プレビューを準備"
  },
  "agent.display.operation.timeline.audioPreview.continuousPlan": {
    "zh-Hans": "准备连续试听",
    "zh-Hant": "準備連續試聽",
    "en": "Prepare continuous audio preview",
    "ja": "連続音声プレビューを準備"
  },
  "agent.display.operation.timeline.colour.source.inspect": {
    "zh-Hans": "查看素材色彩",
    "zh-Hant": "查看素材色彩",
    "en": "Read source colour",
    "ja": "素材の色を確認"
  },
  "agent.display.operation.timeline.colour.image.inspect": {
    "zh-Hans": "查看图片色彩",
    "zh-Hant": "查看圖片色彩",
    "en": "Read image colour",
    "ja": "画像の色を確認"
  },
  "agent.display.operation.timeline.colour.jpeg.inspect": {
    "zh-Hans": "查看图片色彩",
    "zh-Hant": "查看圖片色彩",
    "en": "Read image colour",
    "ja": "画像の色を確認"
  },
  "agent.display.operation.asset.range.get": {
    "zh-Hans": "查看素材选区",
    "zh-Hant": "查看素材選區",
    "en": "Read asset range",
    "ja": "素材の範囲を確認"
  },
  "agent.display.operation.asset.range.set": {
    "zh-Hans": "调整素材选区",
    "zh-Hant": "調整素材選區",
    "en": "Edit asset range",
    "ja": "素材の範囲を調整"
  },
  "agent.display.operation.asset.disposition.list": {
    "zh-Hans": "查看素材标记",
    "zh-Hant": "查看素材標記",
    "en": "Read asset marks",
    "ja": "素材のマークを確認"
  },
  "agent.display.operation.asset.disposition.set": {
    "zh-Hans": "标记素材",
    "zh-Hant": "標記素材",
    "en": "Mark asset",
    "ja": "素材をマーク"
  },
  "agent.display.operation.asset.annotation.list": {
    "zh-Hans": "查看素材标注",
    "zh-Hant": "查看素材標註",
    "en": "Read asset annotations",
    "ja": "素材の注釈を確認"
  },
  "agent.display.operation.asset.annotation.set": {
    "zh-Hans": "修改素材标注",
    "zh-Hant": "修改素材標註",
    "en": "Edit asset annotations",
    "ja": "素材の注釈を編集"
  },
  "agent.display.operation.asset.waveform.get": {
    "zh-Hans": "查看音频波形",
    "zh-Hant": "查看音訊波形",
    "en": "Read audio waveform",
    "ja": "音声の波形を確認"
  },
  "agent.display.operation.asset.waveform.request": {
    "zh-Hans": "分析音频波形",
    "zh-Hant": "分析音訊波形",
    "en": "Analyze audio waveform",
    "ja": "音声の波形を解析"
  },
  "agent.display.operation.asset.importSelected": {
    "zh-Hans": "导入已选素材",
    "zh-Hant": "匯入已選素材",
    "en": "Import selected assets",
    "ja": "選択済み素材を読み込む"
  },
  "agent.display.operation.lut.importSelected": {
    "zh-Hans": "导入已选色彩预设",
    "zh-Hant": "匯入已選色彩預設",
    "en": "Import selected colour preset",
    "ja": "選択済みカラープリセットを読み込む"
  },
  "agent.display.operation.lut.list": {
    "zh-Hans": "查看色彩预设",
    "zh-Hant": "查看色彩預設",
    "en": "List colour presets",
    "ja": "カラープリセットを確認"
  },
  "agent.display.operation.lut.inspect": {
    "zh-Hans": "查看色彩预设",
    "zh-Hant": "查看色彩預設",
    "en": "Read colour preset",
    "ja": "カラープリセットを確認"
  },
  "agent.display.operation.lut.look.inspect": {
    "zh-Hans": "查看色彩外观",
    "zh-Hant": "查看色彩外觀",
    "en": "Read colour look",
    "ja": "カラーの外観を確認"
  },
  "agent.display.operation.provider.list": {
    "zh-Hans": "查看生成服务",
    "zh-Hant": "查看生成服務",
    "en": "List generation services",
    "ja": "生成サービスを確認"
  },
  "agent.display.operation.video.connection.list": {
    "zh-Hans": "查看视频连接",
    "zh-Hant": "查看影片連線",
    "en": "List video connections",
    "ja": "動画の接続を確認"
  },
  "agent.display.operation.job.get": {
    "zh-Hans": "查看生成结果",
    "zh-Hant": "查看生成結果",
    "en": "Read generation result",
    "ja": "生成結果を確認"
  },
  "agent.display.operation.job.list": {
    "zh-Hans": "查看生成记录",
    "zh-Hant": "查看生成紀錄",
    "en": "List generation records",
    "ja": "生成記録を確認"
  },
  "agent.display.operation.export.create": {
    "zh-Hans": "导出视频",
    "zh-Hant": "匯出影片",
    "en": "Export video",
    "ja": "動画を書き出す"
  },
  "agent.display.operation.export.get": {
    "zh-Hans": "查看导出结果",
    "zh-Hant": "查看匯出結果",
    "en": "Read export result",
    "ja": "書き出し結果を確認"
  },
  "agent.display.operation.export.activity.get": {
    "zh-Hans": "查看导出记录",
    "zh-Hant": "查看匯出紀錄",
    "en": "Read export activity",
    "ja": "書き出し履歴を確認"
  },
  "agent.display.operation.frame.extract": {
    "zh-Hans": "提取画面",
    "zh-Hant": "擷取畫面",
    "en": "Extract frame",
    "ja": "フレームを抽出"
  },
  "agent.display.operation.frame.request.get": {
    "zh-Hans": "查看提取记录",
    "zh-Hant": "查看擷取紀錄",
    "en": "Read extraction record",
    "ja": "抽出記録を確認"
  },
  "agent.display.operation.frame.task.get": {
    "zh-Hans": "查看提取结果",
    "zh-Hant": "查看擷取結果",
    "en": "Read extraction result",
    "ja": "抽出結果を確認"
  },
  "agent.display.operation.frame.task.list": {
    "zh-Hans": "查看提取记录",
    "zh-Hant": "查看擷取紀錄",
    "en": "List extraction records",
    "ja": "抽出記録を確認"
  },
  "agent.display.operation.image.profile.list": {
    "zh-Hans": "查看图像连接",
    "zh-Hant": "查看圖像連線",
    "en": "List image connections",
    "ja": "画像の接続を確認"
  },
  "agent.display.operation.image.request.get": {
    "zh-Hans": "查看图像请求",
    "zh-Hant": "查看圖像請求",
    "en": "Read image request",
    "ja": "画像リクエストを確認"
  },
  "agent.display.operation.image.task.get": {
    "zh-Hans": "查看图像生成结果",
    "zh-Hant": "查看圖像生成結果",
    "en": "Read image generation result",
    "ja": "画像生成結果を確認"
  },
  "agent.display.operation.image.task.list": {
    "zh-Hans": "查看图像生成记录",
    "zh-Hant": "查看圖像生成紀錄",
    "en": "List image generation records",
    "ja": "画像生成記録を確認"
  },
  "agent.display.operation.image.task.remote.get": {
    "zh-Hans": "查看生成服务结果",
    "zh-Hant": "查看生成服務結果",
    "en": "Read provider result",
    "ja": "生成サービスの結果を確認"
  },
  "agent.display.operation.image.group.get": {
    "zh-Hans": "查看图像组",
    "zh-Hant": "查看圖像群組",
    "en": "Read image group",
    "ja": "画像グループを確認"
  },
  "agent.display.operation.image.group.list": {
    "zh-Hans": "查看图像组",
    "zh-Hant": "查看圖像群組",
    "en": "List image groups",
    "ja": "画像グループを確認"
  },
  "agent.display.operation.image.version.list": {
    "zh-Hans": "查看图像版本",
    "zh-Hant": "查看圖像版本",
    "en": "List image versions",
    "ja": "画像バージョンを確認"
  },
  "agent.display.operation.subject.list": {
    "zh-Hans": "查看主体",
    "zh-Hant": "查看主體",
    "en": "List subjects",
    "ja": "被写体を確認"
  },
  "agent.display.operation.subject.create": {
    "zh-Hans": "添加主体",
    "zh-Hant": "新增主體",
    "en": "Add subject",
    "ja": "被写体を追加"
  },
  "agent.display.operation.subject.version.add": {
    "zh-Hans": "添加主体版本",
    "zh-Hant": "新增主體版本",
    "en": "Add subject version",
    "ja": "被写体のバージョンを追加"
  },
  "agent.display.operation.subject.version.list": {
    "zh-Hans": "查看主体版本",
    "zh-Hant": "查看主體版本",
    "en": "List subject versions",
    "ja": "被写体のバージョンを確認"
  },
  "agent.display.operation.subject.binding.list": {
    "zh-Hans": "查看主体关联",
    "zh-Hant": "查看主體關聯",
    "en": "List subject bindings",
    "ja": "被写体の関連付けを確認"
  },
  "agent.display.operation.subject.binding.set": {
    "zh-Hans": "调整主体关联",
    "zh-Hant": "調整主體關聯",
    "en": "Edit subject binding",
    "ja": "被写体の関連付けを調整"
  },
  "agent.display.operation.task.disposition.list": {
    "zh-Hans": "查看后台结果",
    "zh-Hant": "查看背景結果",
    "en": "Read background results",
    "ja": "バックグラウンドの結果を確認"
  },
  "agent.display.operation.task.wait": {
    "zh-Hans": "等待后台结果",
    "zh-Hant": "等待背景結果",
    "en": "Wait for background results",
    "ja": "バックグラウンドの結果を待つ"
  },
  "agent.display.enum.quality.low": {
    "zh-Hans": "低",
    "zh-Hant": "低",
    "en": "Low",
    "ja": "低"
  },
  "agent.display.enum.quality.medium": {
    "zh-Hans": "中",
    "zh-Hant": "中",
    "en": "Medium",
    "ja": "中"
  },
  "agent.display.enum.quality.high": {
    "zh-Hans": "高",
    "zh-Hant": "高",
    "en": "High",
    "ja": "高"
  },
  "agent.display.enum.quality.auto": {
    "zh-Hans": "自动",
    "zh-Hant": "自動",
    "en": "Auto",
    "ja": "自動"
  },
  "agent.display.enum.background.opaque": {
    "zh-Hans": "不透明",
    "zh-Hant": "不透明",
    "en": "Opaque",
    "ja": "不透明"
  },
  "agent.display.enum.background.transparent": {
    "zh-Hans": "透明",
    "zh-Hant": "透明",
    "en": "Transparent",
    "ja": "透明"
  },
  "agent.display.enum.background.auto": {
    "zh-Hans": "自动",
    "zh-Hant": "自動",
    "en": "Auto",
    "ja": "自動"
  },
  "agent.display.field.mode": {
    "zh-Hans": "方式",
    "zh-Hant": "方式",
    "en": "Mode",
    "ja": "方式"
  },
  "agent.display.field.versionNumber": {
    "zh-Hans": "版本",
    "zh-Hant": "版本",
    "en": "Version",
    "ja": "バージョン"
  },
  "agent.display.enum.mode.text_to_video": {
    "zh-Hans": "文生视频",
    "zh-Hant": "文生影片",
    "en": "Text to video",
    "ja": "テキストから動画"
  },
  "agent.display.enum.mode.image_to_video": {
    "zh-Hans": "图生视频 · 首帧参考",
    "zh-Hant": "圖生影片 · 首影格參考",
    "en": "Image to video · First-frame reference",
    "ja": "画像から動画 · 最初のフレームを参照"
  },
  "agent.display.enum.mode.first_last_frame": {
    "zh-Hans": "图生视频 · 首尾帧参考",
    "zh-Hant": "圖生影片 · 首尾影格參考",
    "en": "Image to video · First and last frames",
    "ja": "画像から動画 · 最初と最後のフレームを参照"
  },
  "agent.display.enum.mode.subject_reference": {
    "zh-Hans": "主体参考",
    "zh-Hant": "主體參考",
    "en": "Subject reference",
    "ja": "被写体を参照"
  },
  "agent.display.enum.mode.text_to_image": {
    "zh-Hans": "文生图像",
    "zh-Hant": "文生圖像",
    "en": "Text to image",
    "ja": "テキストから画像"
  },
  "agent.display.enum.mode.image_edit": {
    "zh-Hans": "图像编辑",
    "zh-Hant": "圖像編輯",
    "en": "Image editing",
    "ja": "画像編集"
  },
  "agent.panel.noConnection": {
    "zh-Hans": "请先在设置中配置模型连接",
    "zh-Hant": "請先在設定中設定模型連線",
    "en": "Configure a model connection in Settings first",
    "ja": "先に設定でモデルの接続を構成してください"
  },
  "agent.panel.model": {
    "zh-Hans": "模型",
    "zh-Hant": "模型",
    "en": "Model",
    "ja": "モデル"
  },
  "agent.panel.stepModel": {
    "zh-Hans": "理解你的要求",
    "zh-Hant": "理解你的要求",
    "en": "Understand your request",
    "ja": "依頼を理解する"
  },
  "agent.panel.stepWait": {
    "zh-Hans": "等待后台结果",
    "zh-Hant": "等待背景結果",
    "en": "Wait for background results",
    "ja": "バックグラウンドの結果を待つ"
  },
  "agent.panel.authorizedTarget": {
    "zh-Hans": "已授权此目标",
    "zh-Hant": "已授權此目標",
    "en": "This destination is authorized",
    "ja": "この送信先は許可済みです"
  },
  "agent.panel.latest": {
    "zh-Hans": "最新消息",
    "zh-Hant": "最新訊息",
    "en": "Latest message",
    "ja": "最新のメッセージ"
  },
  "agent.panel.checkOriginal": {
    "zh-Hans": "查看原请求",
    "zh-Hant": "查看原請求",
    "en": "View original request",
    "ja": "元のリクエストを表示"
  }
} as const satisfies MessageCatalog;
