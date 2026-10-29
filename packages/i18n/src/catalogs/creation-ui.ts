import type { MessageCatalog } from '../types.ts';
export const creationUiMessages = {
  "agent.authorization.confirmSend": {"zh-Hans": "确认并发送", "zh-Hant": "確認並傳送", "en": "Confirm and send", "ja": "確認して送信"},
  "agent.authorization.scopeLabel": {"zh-Hans": "发送范围", "zh-Hant": "傳送範圍", "en": "Sending scope", "ja": "送信範囲"},
  "agent.authorization.destinationLabel": {"zh-Hans": "目标与模型", "zh-Hant": "目標與模型", "en": "Destination and model", "ja": "送信先とモデル"},
  "agent.authorization.costLabel": {"zh-Hans": "可能计费", "zh-Hant": "可能計費", "en": "Possible charges", "ja": "料金について"},
  "agent.authorization.scopeDetails": {"zh-Hans": "查看发送详情", "zh-Hant": "查看傳送詳情", "en": "View sending details", "ja": "送信内容の詳細"},
  "agent.proposal.shotSuggestion": {"zh-Hans": "修改建议", "zh-Hant": "修改建議", "en": "Suggested changes", "ja": "変更の提案"},
  "agent.proposal.currentShot": {"zh-Hans": "当前镜头", "zh-Hant": "目前鏡頭", "en": "Current shot", "ja": "現在のショット"},
  "agent.proposal.reviewHint": {"zh-Hans": "确认后才会应用修改", "zh-Hant": "確認後才會套用修改", "en": "Changes require your approval", "ja": "確認後に変更を適用"},
  "agent.activity.shotDetailsHeading": {"zh-Hans": "镜头修改范围", "zh-Hant": "鏡頭修改範圍", "en": "Shot change scope", "ja": "ショットの変更範囲"},
  "agent.activity.proposalActivity": {"zh-Hans": "生成修改建议", "zh-Hant": "產生修改建議", "en": "Prepare suggested changes", "ja": "変更の提案を作成"},
  "agent.activity.inspectionActivity": {"zh-Hans": "读取项目信息", "zh-Hant": "讀取專案資訊", "en": "Read project information", "ja": "プロジェクト情報を確認"},
  "agent.authorization.title": {"zh-Hans": "确认 Mio 发送范围", "zh-Hant": "確認 Mio 傳送範圍", "en": "Authorize Mio sending scope", "ja": "Mio の送信範囲を許可"},
  "agent.authorization.explanation": {"zh-Hans": "相同目标地址、模型和发送范围只需确认一次，授权保存在本机工作区，可在设置中撤销", "zh-Hant": "相同目標位址、模型與傳送範圍只需確認一次，授權儲存在本機工作區，可在設定中撤銷", "en": "Authorize each destination, model, and sending scope once. Permission is saved in this local workspace and can be revoked in Settings", "ja": "送信先、モデル、送信範囲ごとに一度許可します。許可はこのローカルワークスペースに保存され、設定で取り消せます"},
  "agent.authorization.cost": {"zh-Hans": "发送内容可能离开本机，模型调用可能计费；撤销不会撤回已发送的请求", "zh-Hant": "傳送內容可能離開本機，模型呼叫可能計費；撤銷不會撤回已傳送的請求", "en": "Content may leave this device and model calls may incur charges. Revoking permission cannot recall a request already sent", "ja": "内容が端末外に送信され、モデルの呼び出しに料金が発生する場合があります。許可を取り消しても送信済みのリクエストは撤回されません"},
  "agent.authorization.remember": {"zh-Hans": "我确认此目标、模型与发送范围，并保存授权", "zh-Hant": "我確認此目標、模型與傳送範圍，並儲存授權", "en": "I approve this destination, model, and sending scope and want to save permission", "ja": "この送信先、モデル、送信範囲を確認し、許可を保存します"},
  "agent.authorization.firstRequired": {"zh-Hans": "首次使用此发送范围需要确认", "zh-Hant": "首次使用此傳送範圍需要確認", "en": "Confirm this sending scope before first use", "ja": "初めての送信範囲には確認が必要です"},
  "agent.authorization.saved": {"zh-Hans": "此目标、模型与发送范围已授权", "zh-Hant": "此目標、模型與傳送範圍已授權", "en": "This destination, model, and sending scope are authorized", "ja": "この送信先、モデル、送信範囲は許可済みです"},
  "agent.authorization.review": {"zh-Hans": "查看并授权", "zh-Hant": "查看並授權", "en": "Review permission", "ja": "確認して許可"},
  "agent.authorization.confirm": {"zh-Hans": "保存授权", "zh-Hant": "儲存授權", "en": "Save permission", "ja": "許可を保存"},
  "agent.authorization.saving": {"zh-Hans": "正在保存…", "zh-Hant": "正在儲存…", "en": "Saving…", "ja": "保存中…"},
  "agent.authorization.cancel": {"zh-Hans": "取消", "zh-Hant": "取消", "en": "Cancel", "ja": "キャンセル"},
  "agent.authorization.listTitle": {"zh-Hans": "已授权目标", "zh-Hant": "已授權目標", "en": "Authorized destinations", "ja": "許可済みの送信先"},
  "agent.authorization.refresh": {"zh-Hans": "刷新", "zh-Hant": "重新整理", "en": "Refresh", "ja": "更新"},
  "agent.authorization.revoke": {"zh-Hans": "撤销授权", "zh-Hant": "撤銷授權", "en": "Revoke permission", "ja": "許可を取り消す"},
  "agent.authorization.empty": {"zh-Hans": "尚未授权任何目标", "zh-Hant": "尚未授權任何目標", "en": "No destinations authorized yet", "ja": "許可済みの送信先はありません"},
  "agent.authorization.error": {"zh-Hans": "授权状态暂时无法确认，请刷新后重试", "zh-Hant": "暫時無法確認授權狀態，請重新整理後重試", "en": "Permission status could not be confirmed. Refresh before trying again", "ja": "許可の状態を確認できませんでした。更新してから再試行してください"},
  "agent.authorization.scope.typed_chat_only": {"zh-Hans": "仅对话文字", "zh-Hant": "僅對話文字", "en": "Chat text only", "ja": "会話テキストのみ"},
  "agent.authorization.scope.project_inspection": {"zh-Hans": "项目文字与元数据", "zh-Hant": "專案文字與中繼資料", "en": "Project text and metadata", "ja": "プロジェクトのテキストとメタデータ"},
  "agent.authorization.scope.selected_shot_edit": {"zh-Hans": "项目与选中镜头", "zh-Hant": "專案與所選鏡頭", "en": "Project and selected shot", "ja": "プロジェクトと選択ショット"},
  "agent.authorization.scope.selected_timeline_clip_move": {"zh-Hans": "时间线与选中片段移动", "zh-Hant": "時間軸與所選片段移動", "en": "Timeline and selected clip movement", "ja": "タイムラインと選択クリップの移動"},
  "agent.authorization.scope.selected_timeline_clip_gain": {"zh-Hans": "时间线与选中片段音量", "zh-Hant": "時間軸與所選片段音量", "en": "Timeline and selected clip volume", "ja": "タイムラインと選択クリップの音量"},
  "agent.chat.replyRunning": {
    "zh-Hans": "正在回复",
    "zh-Hant": "正在回覆",
    "en": "Replying",
    "ja": "返信中"
  },
  "agent.chat.replyComplete": {
    "zh-Hans": "回复结束",
    "zh-Hant": "回覆結束",
    "en": "Reply complete",
    "ja": "返信完了"
  },
  "agent.chat.replyStopped": {
    "zh-Hans": "已停止 · 保留部分文字",
    "zh-Hant": "已停止 · 保留部分文字",
    "en": "Stopped · Partial text retained",
    "ja": "停止済み · 受信済みの文章を保持"
  },
  "agent.chat.replyFailed": {
    "zh-Hans": "回复失败",
    "zh-Hant": "回覆失敗",
    "en": "Reply failed",
    "ja": "返信に失敗"
  },
  "agent.chat.replyInterrupted": {
    "zh-Hans": "回复中断",
    "zh-Hant": "回覆中斷",
    "en": "Reply interrupted",
    "ja": "返信が中断されました"
  },
  "agent.chat.statusUnknown": {
    "zh-Hans": "状态未知",
    "zh-Hant": "狀態未知",
    "en": "Status unknown",
    "ja": "状態不明"
  },
  "agent.chat.loadingConversation": {
    "zh-Hans": "正在读取对话",
    "zh-Hant": "正在讀取對話",
    "en": "Loading conversation",
    "ja": "会話を読み込み中"
  },
  "agent.chat.confirmingSend": {
    "zh-Hans": "正在确认发送",
    "zh-Hant": "正在確認傳送",
    "en": "Confirming submission",
    "ja": "送信結果を確認中"
  },
  "agent.chat.receivingProgress": {
    "zh-Hans": "正在接收运行进度",
    "zh-Hant": "正在接收執行進度",
    "en": "Receiving progress",
    "ja": "進捗を受信中"
  },
  "agent.chat.requestingStop": {
    "zh-Hans": "正在请求停止",
    "zh-Hant": "正在請求停止",
    "en": "Requesting stop",
    "ja": "停止を要求中"
  },
  "agent.chat.displayDisconnected": {
    "zh-Hans": "显示连接已断开",
    "zh-Hant": "顯示連線已中斷",
    "en": "Display connection lost",
    "ja": "表示用の接続が切断されました"
  },
  "agent.chat.runUnconfirmed": {
    "zh-Hans": "运行状态待确认",
    "zh-Hant": "執行狀態待確認",
    "en": "Run status unconfirmed",
    "ja": "実行状態の確認待ち"
  },
  "agent.chat.loadFailed": {
    "zh-Hans": "读取失败",
    "zh-Hant": "讀取失敗",
    "en": "Could not load",
    "ja": "読み込めませんでした"
  },
  "agent.chat.waitingForMessage": {
    "zh-Hans": "等待你的消息",
    "zh-Hant": "等待你的訊息",
    "en": "Waiting for your message",
    "ja": "メッセージをお待ちしています"
  },
  "agent.chat.statusUnconfirmed": {
    "zh-Hans": "状态待确认",
    "zh-Hant": "狀態待確認",
    "en": "Status unconfirmed",
    "ja": "状態の確認待ち"
  },
  "agent.chat.you": {
    "zh-Hans": "你",
    "zh-Hant": "你",
    "en": "You",
    "ja": "あなた"
  },
  "agent.chat.awaitingFirstText": {
    "zh-Hans": "等待第一段文字…",
    "zh-Hant": "等待第一段文字…",
    "en": "Waiting for the first text…",
    "ja": "最初の文章を待機中…"
  },
  "agent.chat.noReplyText": {
    "zh-Hans": "没有收到回复文字",
    "zh-Hant": "未收到回覆文字",
    "en": "No reply text was received",
    "ja": "返信の文章を受信できませんでした"
  },
  "agent.chat.interruptedDisclosure": {
    "zh-Hans": "已保存的回复中断，不会自动续接或重新发送；远端仍可能已计算或计费",
    "zh-Hant": "已儲存的回覆中斷，不會自動接續或重新傳送；遠端仍可能已進行運算或計費",
    "en": "The saved reply was interrupted and will not resume or resend automatically. Remote computation or charges may already have occurred",
    "ja": "保存された返信は中断されました。自動で再開や再送はしません。リモート側で処理や課金が発生している可能性があります"
  },
  "agent.chat.conversationEyebrow": {
    "zh-Hans": "Mio · CONVERSATION",
    "zh-Hant": "Mio · 對話",
    "en": "Mio · CONVERSATION",
    "ja": "Mio · 会話"
  },
  "agent.chat.conversationHeading": {
    "zh-Hans": "聊聊你的创作想法",
    "zh-Hant": "聊聊你的創作想法",
    "en": "Talk through your creative ideas",
    "ja": "創作のアイデアを話しましょう"
  },
  "agent.chat.gainScope": {
    "zh-Hans": "新消息范围：选中片段音量提议",
    "zh-Hant": "新訊息範圍：所選片段的音量提議",
    "en": "New message scope: selected clip gain proposal",
    "ja": "新しいメッセージの対象：選択中クリップの音量提案"
  },
  "agent.chat.moveScope": {
    "zh-Hans": "新消息范围：选中片段移动提议",
    "zh-Hant": "新訊息範圍：所選片段的移動提議",
    "en": "New message scope: selected clip move proposal",
    "ja": "新しいメッセージの対象：選択中クリップの移動提案"
  },
  "agent.chat.shotScope": {
    "zh-Hans": "新消息范围：选中镜头修改提议",
    "zh-Hant": "新訊息範圍：所選鏡頭的修改提議",
    "en": "New message scope: selected shot edit proposal",
    "ja": "新しいメッセージの対象：選択中ショットの変更提案"
  },
  "agent.chat.inspectionScope": {
    "zh-Hans": "新消息范围：当前项目只读检查",
    "zh-Hant": "新訊息範圍：目前專案的唯讀檢查",
    "en": "New message scope: read-only project inspection",
    "ja": "新しいメッセージの対象：現在のプロジェクトの読み取り専用確認"
  },
  "agent.chat.chatScope": {
    "zh-Hans": "新消息范围：仅文字聊天",
    "zh-Hant": "新訊息範圍：僅文字聊天",
    "en": "New message scope: text chat only",
    "ja": "新しいメッセージの対象：テキストチャットのみ"
  },
  "agent.chat.connectionSettings": {
    "zh-Hans": "Mio 连接设置",
    "zh-Hant": "Mio 連線設定",
    "en": "Mio connection settings",
    "ja": "Mio 接続設定"
  },
  "agent.chat.settingsKeepDraft": {
    "zh-Hans": "连接设置（保留聊天草稿）",
    "zh-Hant": "連線設定（保留聊天草稿）",
    "en": "Connection settings (keep chat draft)",
    "ja": "接続設定（チャットの下書きを保持）"
  },
  "agent.chat.collapsePanel": {
    "zh-Hans": "收起 Mio 面板",
    "zh-Hant": "收起 Mio 面板",
    "en": "Collapse Mio panel",
    "ja": "Mio パネルを折りたたむ"
  },
  "agent.chat.currentProject": {
    "zh-Hans": "当前项目",
    "zh-Hant": "目前專案",
    "en": "Current project",
    "ja": "現在のプロジェクト"
  },
  "agent.chat.selectedProjectScope": {
    "zh-Hans": "本次选择的项目范围",
    "zh-Hant": "此次選擇的專案範圍",
    "en": "Project scope selected for this message",
    "ja": "今回選択したプロジェクト範囲"
  },
  "agent.chat.chatDoesNotSendLabel": {
    "zh-Hans": "仅文字聊天不会发送此标签",
    "zh-Hant": "僅文字聊天不會傳送此標籤",
    "en": "Text-only chat does not send this label",
    "ja": "テキストチャットではこのラベルを送信しません"
  },
  "agent.chat.localStorageDisclosure": {
    "zh-Hans": "记录保存在本地应用数据库，并非密钥保险库加密。请勿输入密钥或其他秘密",
    "zh-Hant": "記錄儲存在本機應用程式資料庫，未經密鑰保管庫加密。請勿輸入密鑰或其他機密",
    "en": "Records are stored in the local app database, without secret-vault encryption. Do not enter keys or other secrets",
    "ja": "記録はローカルのアプリデータベースに保存され、秘密情報用保管庫の暗号化は適用されません。キーなどの秘密情報は入力しないでください"
  },
  "agent.chat.simulatedRun": {
    "zh-Hans": "模拟测试 · 无真实模型调用",
    "zh-Hant": "模擬測試 · 無實際模型呼叫",
    "en": "Simulation · No real model calls",
    "ja": "シミュレーション · 実際のモデル呼び出しなし"
  },
  "agent.chat.storageAndExecution": {
    "zh-Hans": "存储与运行说明",
    "zh-Hant": "儲存與執行說明",
    "en": "Storage and execution details",
    "ja": "保存と実行について"
  },
  "agent.chat.draftPersistence": {
    "zh-Hans": "已发送文字、回复及读取结果会保存在本地。切换页签、收起面板或重新读取保留草稿；刷新页面或退出应用会丢失未发送草稿。切换项目前会确认放弃草稿",
    "zh-Hant": "已傳送文字、回覆及讀取結果會儲存在本機。切換分頁、收起面板或重新讀取時會保留草稿；重新整理頁面或結束應用程式會遺失未傳送草稿。切換專案前會確認是否放棄草稿",
    "en": "Sent text, replies, and read results are saved locally. Switching tabs, collapsing the panel, or reloading preserves drafts. Refreshing the page or quitting the app loses unsent drafts. Switching projects asks before discarding a draft",
    "ja": "送信済みの文章、返信、読み取り結果はローカルに保存されます。タブの切り替え、パネルの折りたたみ、再読み込みでは下書きを保持します。ページの更新やアプリの終了で未送信の下書きは失われます。プロジェクトを切り替える前に下書きの破棄を確認します"
  },
  "agent.chat.contextLimits": {
    "zh-Hans": "从最近 16 轮中最多选取 12 轮已完成对话。仅文字聊天会排除所有项目读取和修改提议轮次，与固定提示和本条输入合计最多 32 KiB；项目检查的首次上下文最多 20 KiB，镜头或片段提议的首次上下文最多 30 KiB。更早历史仅供查阅，不扩大上下文",
    "zh-Hant": "從最近 16 輪中最多選取 12 輪已完成對話。僅文字聊天會排除所有專案讀取及修改提議輪次，連同固定提示與本條輸入最多 32 KiB；專案檢查的首次上下文最多 20 KiB，鏡頭或片段提議的首次上下文最多 30 KiB。較早記錄僅供查閱，不會擴大上下文",
    "en": "Up to 12 completed turns are selected from the latest 16. Text-only chat excludes all project inspection and edit-proposal turns and is limited to 32 KiB including fixed instructions and this input. Initial context is limited to 20 KiB for project inspection and 30 KiB for shot or clip proposals. Older history is for viewing only and does not extend context",
    "ja": "直近16ターンから完了済みの最大12ターンを選びます。テキストチャットではプロジェクト確認と変更提案のターンをすべて除外し、固定指示と今回の入力を含め最大32 KiBです。初回コンテキストはプロジェクト確認で最大20 KiB、ショット・クリップ提案で最大30 KiBです。過去の履歴は閲覧専用で、コンテキストには追加されません"
  },
  "agent.chat.readOnlyToolVersion": {
    "zh-Hans": "只读工具定义 v{schemaVersion} · 目录 {catalogHash}",
    "zh-Hant": "唯讀工具定義 v{schemaVersion} · 目錄 {catalogHash}",
    "en": "Read-only tool definitions v{schemaVersion} · Catalog {catalogHash}",
    "ja": "読み取り専用ツール定義 v{schemaVersion} · カタログ {catalogHash}"
  },
  "agent.chat.inspectionDisclosure": {
    "zh-Hans": "项目检查仅限 project.inspect、asset.inspect、shot.inspect、timeline.inspect 的固定只读范围：已保存项目、素材、镜头及时间线文字与元数据。每轮最多读取一次、结果最多 8 KiB；不发送媒体、路径、凭据或未保存编辑。文字中可能包含你保存的私人内容，请先核对",
    "zh-Hant": "專案檢查僅限 project.inspect、asset.inspect、shot.inspect、timeline.inspect 的固定唯讀範圍：已儲存的專案、素材、鏡頭及時間軸文字與中繼資料。每輪最多讀取一次，結果最多 8 KiB；不傳送媒體、路徑、憑證或未儲存編輯。文字可能包含你儲存的私人內容，請先核對",
    "en": "Project inspection is limited to the fixed read-only scope of project.inspect, asset.inspect, shot.inspect, and timeline.inspect: saved project, asset, shot, and timeline text and metadata. Each turn allows one read with at most 8 KiB of results. Media, paths, credentials, and unsaved edits are not sent. Text may include private content you saved; review it first",
    "ja": "プロジェクト確認は project.inspect、asset.inspect、shot.inspect、timeline.inspect の固定された読み取り専用範囲に限ります。対象は保存済みのプロジェクト、素材、ショット、タイムラインの文章とメタデータです。各ターンの読み取りは最大1回、結果は最大8 KiBです。メディア、パス、認証情報、未保存の編集は送信しません。保存した私的な内容が文章に含まれる場合があるため、事前に確認してください"
  },
  "agent.chat.shotProposalDisclosure": {
    "zh-Hans": "选中镜头修改提议只发送所选已保存镜头的完整标题与画面描述，不含属性面板的未保存草稿。每轮最多 2 次模型请求、1 次提议工具调用，工具只创建待审阅提议。null 保持字段不变，空画面描述会清空，标题不能为空；提议不能在审阅时编辑或自动重新基于新版本生成",
    "zh-Hant": "所選鏡頭的修改提議只傳送該已儲存鏡頭的完整標題與畫面描述，不含屬性面板的未儲存草稿。每輪最多 2 次模型請求、1 次提議工具呼叫，工具只建立待審閱提議。null 保持欄位不變，空白畫面描述會清空內容，標題不可為空；審閱時不能編輯提議，也不會自動依新版本重新產生",
    "en": "Shot edit proposals send only the selected saved shot’s full title and visual description, excluding unsaved Inspector drafts. Each turn allows at most 2 model requests and 1 proposal-tool call, which only creates a proposal for review. null leaves a field unchanged; an empty visual description clears it; titles cannot be empty. Proposals cannot be edited during review or automatically rebased onto a newer version",
    "ja": "ショットの変更提案では、選択した保存済みショットのタイトル全文と画面描写だけを送信し、インスペクターの未保存の下書きは含めません。各ターンはモデルへのリクエスト最大2回、提案ツールの呼び出し最大1回です。ツールはレビュー待ちの提案を作成するだけです。null は変更なし、空の画面描写は内容の消去を意味し、タイトルは空にできません。レビュー時の提案の編集や、新しいバージョンに基づく自動再作成は行いません"
  },
  "agent.chat.moveProposalDisclosure": {
    "zh-Hans": "选中片段移动提议只发送一个已保存片段的名称和时间、当前轨道名称和类型、30fps 以及同轨其他片段的有界数值占用区间。不发送其他轨道、媒体、源路径或未保存草稿。工具只提议 startFrame，批准后仅在原轨道非波纹移动",
    "zh-Hant": "片段移動提議只傳送一個已儲存片段的名稱與時間、目前軌道的名稱與類型、30fps，以及同軌其他片段在限定範圍內的數值佔用區間。不傳送其他軌道、媒體、來源路徑或未儲存草稿。工具只提議 startFrame，批准後僅在原軌道進行非波紋移動",
    "en": "Clip move proposals send only one saved clip’s name and timing, the current track’s name and type, 30 fps, and bounded numeric occupied intervals for other clips on that track. Other tracks, media, source paths, and unsaved drafts are not sent. The tool proposes only startFrame; approval performs a non-ripple move on the original track",
    "ja": "クリップの移動提案では、保存済みクリップ1つの名前と時間、現在のトラックの名前と種類、30 fps、同じトラック上の他のクリップが占有する範囲内の数値区間だけを送信します。他のトラック、メディア、ソースのパス、未保存の下書きは送信しません。提案は startFrame のみで、承認後も元のトラック上でリップルなしの移動のみを行います"
  },
  "agent.chat.hiddenRunDisclosure": {
    "zh-Hans": "隐藏窗口、切换页签、收起面板或切换项目后，已接受的限界运行可能继续。停止可阻止后续步骤，无法撤回已发生的计算或费用；重启后不会自动续接或重新发送",
    "zh-Hant": "隱藏視窗、切換分頁、收起面板或切換專案後，已接受的限界執行仍可能繼續。停止可阻止後續步驟，但無法撤回已發生的運算或費用；重啟後不會自動接續或重新傳送",
    "en": "Accepted bounded runs may continue after hiding the window, switching tabs, collapsing the panel, or switching projects. Stopping blocks later steps but cannot undo computation or charges already incurred. Restarting will not automatically resume or resend",
    "ja": "ウィンドウを隠す、タブを切り替える、パネルを折りたたむ、プロジェクトを切り替える操作の後も、受け付け済みの制限付き実行は続く場合があります。停止で後続の処理は止められますが、発生済みの処理や料金は取り消せません。再起動後の自動再開や再送は行いません"
  },
  "agent.chat.backendRestarted": {
    "zh-Hans": "后端已重新启动。已保存的历史仍保留；中断的回复不会自动续接或重发",
    "zh-Hant": "後端已重新啟動。已儲存的歷史仍保留；中斷的回覆不會自動接續或重送",
    "en": "The backend restarted. Saved history is retained; interrupted replies will not resume or resend automatically",
    "ja": "バックエンドが再起動しました。保存済みの履歴は保持されます。中断した返信を自動で再開・再送することはありません"
  },
  "agent.chat.loadingSavedConversation": {
    "zh-Hans": "正在读取已保存的对话…",
    "zh-Hant": "正在讀取已儲存的對話…",
    "en": "Loading saved conversation…",
    "ja": "保存済みの会話を読み込み中…"
  },
  "agent.chat.conversationUnavailable": {
    "zh-Hans": "对话暂不可用",
    "zh-Hant": "對話暫時無法使用",
    "en": "Conversation unavailable",
    "ja": "会話を利用できません"
  },
  "agent.chat.openReadsOnly": {
    "zh-Hans": "打开窗口只读取状态，不会连接模型",
    "zh-Hant": "開啟視窗只會讀取狀態，不會連接模型",
    "en": "Opening this window only reads status; it does not contact a model",
    "ja": "ウィンドウを開く操作は状態を読み取るだけで、モデルには接続しません"
  },
  "agent.chat.startWithIdea": {
    "zh-Hans": "从一个想法开始",
    "zh-Hant": "從一個想法開始",
    "en": "Start with an idea",
    "ja": "アイデアから始めましょう"
  },
  "agent.chat.gainEmptyHint": {
    "zh-Hans": "可请 Mio 把一个已保存有声片段的音量调到 40% 等数值。先核对发送范围，再审阅固定倍率；明确批准后才会应用",
    "zh-Hant": "可請 Mio 將一個已儲存且含音訊的片段音量調至 40% 等數值。先核對傳送範圍，再審閱固定倍率；只有明確批准後才會套用",
    "en": "Ask Mio to set a saved clip with audio to a level such as 40%. Check the sending scope, then review the fixed gain. It is applied only after explicit approval",
    "ja": "音声を含む保存済みクリップの音量を40%などにする提案を Mio に依頼できます。送信範囲を確認してから固定倍率をレビューしてください。明示的に承認するまで適用されません"
  },
  "agent.chat.moveEmptyHint": {
    "zh-Hans": "可请 Mio 为一个已保存时间线片段提出同轨移动。先核对发送范围，再审阅固定前后时间；明确批准后才会应用",
    "zh-Hant": "可請 Mio 為一個已儲存的時間軸片段提議同軌移動。先核對傳送範圍，再審閱固定的前後時間；只有明確批准後才會套用",
    "en": "Ask Mio to propose moving a saved timeline clip on the same track. Check the sending scope, then review the fixed before-and-after timing. It is applied only after explicit approval",
    "ja": "保存済みタイムラインクリップを同じトラック内で移動する提案を Mio に依頼できます。送信範囲を確認してから移動前後の固定時刻をレビューしてください。明示的に承認するまで適用されません"
  },
  "agent.chat.shotEmptyHint": {
    "zh-Hans": "可请 Mio 为当前选中镜头的已保存标题或画面描述提出修改，审阅差异并明确批准后才会应用",
    "zh-Hant": "可請 Mio 為目前所選鏡頭的已儲存標題或畫面描述提議修改；審閱差異並明確批准後才會套用",
    "en": "Ask Mio to propose changes to the selected shot’s saved title or visual description. Changes are applied only after you review the diff and explicitly approve",
    "ja": "選択中ショットの保存済みタイトルや画面描写の変更を Mio に提案してもらえます。差分をレビューし、明示的に承認した後でのみ適用されます"
  },
  "agent.chat.inspectionEmptyHint": {
    "zh-Hans": "可请求查看本项目已保存的文字与元数据。不会查看媒体画面或执行修改",
    "zh-Hant": "可要求查看本專案已儲存的文字與中繼資料。不會查看媒體畫面或執行修改",
    "en": "Ask to inspect this project’s saved text and metadata. Media content will not be viewed and no edits will be made",
    "ja": "このプロジェクトの保存済みの文章とメタデータを確認できます。メディアの映像を見たり、変更を加えたりはしません"
  },
  "agent.chat.chatEmptyHint": {
    "zh-Hans": "可以讨论叙事、镜头语言或台词。需要项目资料时，请先选择只读检查",
    "zh-Hant": "可以討論敘事、鏡頭語言或台詞。需要專案資料時，請先選擇唯讀檢查",
    "en": "Discuss storytelling, visual language, or dialogue. Select read-only inspection first if project information is needed",
    "ja": "物語、映像表現、台詞について話せます。プロジェクトの情報が必要な場合は、先に読み取り専用確認を選んでください"
  },
  "agent.chat.olderSavedConversation": {
    "zh-Hans": "更早的已保存对话",
    "zh-Hant": "較早的已儲存對話",
    "en": "Older saved conversation",
    "ja": "過去の保存済み会話"
  },
  "agent.chat.historyPageLimit": {
    "zh-Hans": "每页最多 16 轮",
    "zh-Hant": "每頁最多 16 輪",
    "en": "Up to 16 turns per page",
    "ja": "1ページにつき最大16ターン"
  },
  "agent.chat.historyReadOnly": {
    "zh-Hans": "仅供查阅。查看更早记录不会把它们加入发送上下文；下方最近对话、当前回复与草稿保持独立",
    "zh-Hant": "僅供查閱。查看較早記錄不會將其加入傳送上下文；下方最近對話、目前回覆與草稿保持獨立",
    "en": "For viewing only. Opening older records does not add them to sent context. Recent conversation, the current reply, and the draft below remain independent",
    "ja": "閲覧専用です。過去の記録を開いても送信コンテキストには追加されません。下部の直近の会話、現在の返信、下書きは独立したままです"
  },
  "agent.chat.loading": {
    "zh-Hans": "正在读取…",
    "zh-Hant": "正在讀取…",
    "en": "Loading…",
    "ja": "読み込み中…"
  },
  "agent.chat.olderPage": {
    "zh-Hans": "更早一页",
    "zh-Hant": "更早一頁",
    "en": "Older page",
    "ja": "さらに前のページ"
  },
  "agent.chat.viewOlderHistory": {
    "zh-Hans": "查看更早记录",
    "zh-Hant": "查看較早記錄",
    "en": "View older history",
    "ja": "過去の履歴を見る"
  },
  "agent.chat.newerPage": {
    "zh-Hans": "较新一页",
    "zh-Hant": "較新一頁",
    "en": "Newer page",
    "ja": "新しいページ"
  },
  "agent.chat.collapseHistory": {
    "zh-Hans": "收起历史",
    "zh-Hant": "收起歷史",
    "en": "Collapse history",
    "ja": "履歴を折りたたむ"
  },
  "agent.chat.oldestRecordReached": {
    "zh-Hans": "已到最早保存的记录",
    "zh-Hant": "已到最早儲存的記錄",
    "en": "You have reached the oldest saved record",
    "ja": "最も古い保存済み記録です"
  },
  "agent.chat.savedHistoryPage": {
    "zh-Hans": "已保存历史页",
    "zh-Hant": "已儲存的歷史頁面",
    "en": "Saved history page",
    "ja": "保存済み履歴のページ"
  },
  "agent.chat.originalRequestFound": {
    "zh-Hans": "已找到原请求，未重新发送。这条记录不在最近 16 轮中，仅供查阅",
    "zh-Hant": "已找到原請求，未重新傳送。這筆記錄不在最近 16 輪中，僅供查閱",
    "en": "The original request was found and was not resent. This record is outside the latest 16 turns and is for viewing only",
    "ja": "元のリクエストが見つかりました。再送はしていません。この記録は直近16ターンより前のもので、閲覧専用です"
  },
  "agent.chat.confirmedOriginalRequest": {
    "zh-Hans": "已确认的原请求",
    "zh-Hant": "已確認的原請求",
    "en": "Confirmed original request",
    "ja": "確認済みの元のリクエスト"
  },
  "agent.chat.sendUnconfirmed": {
    "zh-Hans": "发送待确认",
    "zh-Hant": "傳送結果待確認",
    "en": "Submission unconfirmed",
    "ja": "送信結果の確認待ち"
  },
  "agent.chat.checkingOriginalRequest": {
    "zh-Hans": "正在核对原请求。请勿重复发送同一消息",
    "zh-Hant": "正在核對原請求。請勿重複傳送同一訊息",
    "en": "Checking the original request. Do not send the same message again",
    "ja": "元のリクエストを確認しています。同じメッセージを重複して送信しないでください"
  },
  "agent.chat.endPendingState": {
    "zh-Hans": "结束本地待确认状态…",
    "zh-Hant": "結束本機的待確認狀態…",
    "en": "End local pending state…",
    "ja": "ローカルの確認待ち状態を終了…"
  },
  "agent.chat.endPendingWarning": {
    "zh-Hans": "原请求可能已被接受，结束此状态不会停止它或撤回费用。草稿保留，但再次发送可能造成重复回复或计费。确定继续？",
    "zh-Hant": "原請求可能已被接受。結束此狀態不會停止該請求，也不會撤回費用。草稿會保留，但再次傳送可能造成重複回覆或計費。確定繼續？",
    "en": "The original request may have been accepted. Ending this state will not stop it or reverse charges. The draft is kept, but sending again may cause duplicate replies or charges. Continue?",
    "ja": "元のリクエストは受け付け済みかもしれません。この状態を終了してもリクエストは停止されず、料金も取り消されません。下書きは保持されますが、再送すると返信や課金が重複する可能性があります。続けますか？"
  },
  "agent.chat.acceptEndPending": {
    "zh-Hans": "我理解风险，结束待确认",
    "zh-Hant": "我了解風險，結束待確認",
    "en": "I understand; end pending state",
    "ja": "リスクを理解して確認待ちを終了"
  },
  "agent.chat.keepChecking": {
    "zh-Hans": "继续核对",
    "zh-Hant": "繼續核對",
    "en": "Keep checking",
    "ja": "確認を続ける"
  },
  "agent.chat.sendingScope": {
    "zh-Hans": "本次发送的范围",
    "zh-Hant": "此次傳送的範圍",
    "en": "Scope of this message",
    "ja": "今回送信する範囲"
  },
  "agent.chat.textChatOnly": {
    "zh-Hans": "仅文字聊天",
    "zh-Hant": "僅文字聊天",
    "en": "Text chat only",
    "ja": "テキストチャットのみ"
  },
  "agent.chat.readOnlyProject": {
    "zh-Hans": "当前项目只读检查",
    "zh-Hant": "目前專案唯讀檢查",
    "en": "Read-only project inspection",
    "ja": "現在のプロジェクトを読み取り専用で確認"
  },
  "agent.chat.selectedShotProposal": {
    "zh-Hans": "选中镜头修改提议",
    "zh-Hant": "所選鏡頭的修改提議",
    "en": "Selected shot edit proposal",
    "ja": "選択中ショットの変更提案"
  },
  "agent.chat.selectedMoveProposal": {
    "zh-Hans": "选中片段移动提议",
    "zh-Hant": "所選片段的移動提議",
    "en": "Selected clip move proposal",
    "ja": "選択中クリップの移動提案"
  },
  "agent.chat.selectedGainProposal": {
    "zh-Hans": "选中片段音量提议",
    "zh-Hant": "所選片段的音量提議",
    "en": "Selected clip gain proposal",
    "ja": "選択中クリップの音量提案"
  },
  "agent.chat.gainUnavailable": {
    "zh-Hans": "片段音量提议暂不可用",
    "zh-Hant": "片段音量提議暫時無法使用",
    "en": "Clip gain proposals unavailable",
    "ja": "クリップの音量提案を利用できません"
  },
  "agent.chat.gainRequiresAudio": {
    "zh-Hans": "音量提议需要选中已保存且已知含音频的片段",
    "zh-Hant": "音量提議須選中已儲存且已知含音訊的片段",
    "en": "Gain proposals require a selected saved clip known to contain audio",
    "ja": "音量提案には、音声を含むことが確認された保存済みクリップの選択が必要です"
  },
  "agent.chat.moveUnavailable": {
    "zh-Hans": "片段移动提议暂不可用",
    "zh-Hant": "片段移動提議暫時無法使用",
    "en": "Clip move proposals unavailable",
    "ja": "クリップの移動提案を利用できません"
  },
  "agent.chat.shotUnavailable": {
    "zh-Hans": "镜头修改提议暂不可用",
    "zh-Hant": "鏡頭修改提議暫時無法使用",
    "en": "Shot edit proposals unavailable",
    "ja": "ショットの変更提案を利用できません"
  },
  "agent.chat.inspectionUnavailable": {
    "zh-Hans": "项目只读检查暂不可用",
    "zh-Hant": "專案唯讀檢查暫時無法使用",
    "en": "Read-only project inspection unavailable",
    "ja": "プロジェクトの読み取り専用確認を利用できません"
  },
  "agent.chat.useSelectedSavedShot": {
    "zh-Hans": "使用当前选中的已保存镜头",
    "zh-Hant": "使用目前所選的已儲存鏡頭",
    "en": "Use the selected saved shot",
    "ja": "現在選択している保存済みショットを使用"
  },
  "agent.chat.shotRevision": {
    "zh-Hans": "镜头 {shotId} · 基准版本 {expectedRevision}",
    "zh-Hant": "鏡頭 {shotId} · 基準版本 {expectedRevision}",
    "en": "Shot {shotId} · Base revision {expectedRevision}",
    "ja": "ショット {shotId} · 基準リビジョン {expectedRevision}"
  },
  "agent.chat.savedShotScope": {
    "zh-Hans": "范围：完整已保存标题与画面描述，不含未保存草稿",
    "zh-Hant": "範圍：完整已儲存標題與畫面描述，不含未儲存草稿",
    "en": "Scope: the full saved title and visual description, excluding unsaved drafts",
    "ja": "対象：保存済みタイトル全文と画面描写。未保存の下書きは含みません"
  },
  "agent.chat.fullTextLimits": {
    "zh-Hans": "完整发送文字与工具限额",
    "zh-Hant": "完整傳送文字與工具限額",
    "en": "Full sent text and tool limits",
    "ja": "送信する全文とツールの上限"
  },
  "agent.chat.expandReviewedText": {
    "zh-Hans": "展开已核对的完整文字与工具限额",
    "zh-Hant": "展開已核對的完整文字與工具限額",
    "en": "Expand reviewed text and tool limits",
    "ja": "確認済みの全文とツールの上限を展開"
  },
  "agent.chat.savedTextDisclosure": {
    "zh-Hans": "以下是将发给模型的完整已保存文字。属性面板里的未保存输入不在其中；切换镜头或保存内容变化后需重新确认",
    "zh-Hant": "以下是將傳送給模型的完整已儲存文字，不含屬性面板裡的未儲存輸入。切換鏡頭或已儲存內容變更後，須重新確認",
    "en": "Below is the full saved text that will be sent to the model, excluding unsaved Inspector input. Confirm again after changing shots or saved content",
    "ja": "以下はモデルに送信する保存済みの全文です。インスペクター内の未保存の入力は含みません。ショットの切り替えや保存内容の変更後には、再確認が必要です"
  },
  "agent.chat.savedTitle": {
    "zh-Hans": "已保存标题",
    "zh-Hant": "已儲存標題",
    "en": "Saved title",
    "ja": "保存済みタイトル"
  },
  "agent.chat.savedDescription": {
    "zh-Hans": "已保存画面描述",
    "zh-Hant": "已儲存畫面描述",
    "en": "Saved visual description",
    "ja": "保存済み画面描写"
  },
  "agent.chat.emptyValue": {
    "zh-Hans": "（空）",
    "zh-Hant": "（空）",
    "en": "(Empty)",
    "ja": "（空）"
  },
  "agent.chat.shotToolLimits": {
    "zh-Hans": "提议工具 v{schemaVersion} · 目录 {catalogHash} · 标题最多 150 字符 / 600 字节，画面描述最多 5000 字符 / 20000 字节",
    "zh-Hant": "提議工具 v{schemaVersion} · 目錄 {catalogHash} · 標題最多 150 字元 / 600 位元組，畫面描述最多 5000 字元 / 20000 位元組",
    "en": "Proposal tool v{schemaVersion} · Catalog {catalogHash} · Title: 150 characters / 600 bytes maximum; visual description: 5000 characters / 20000 bytes maximum",
    "ja": "提案ツール v{schemaVersion} · カタログ {catalogHash} · タイトルは最大150文字 / 600バイト、画面描写は最大5000文字 / 20000バイト"
  },
  "agent.chat.selectSavedShot": {
    "zh-Hans": "请先在画板中选择一个已保存镜头。标题或画面描述超出安全长度限制时不能发送",
    "zh-Hant": "請先在畫板選擇一個已儲存鏡頭。標題或畫面描述超出安全長度限制時，無法傳送",
    "en": "Select a saved shot on the canvas first. Sending is blocked if the title or visual description exceeds the safe length limit",
    "ja": "先にキャンバスで保存済みショットを選択してください。タイトルまたは画面描写が安全な長さの上限を超える場合、送信できません"
  },
  "agent.chat.savedShotTextScope": {
    "zh-Hans": "本次发送的已保存镜头文字",
    "zh-Hant": "此次傳送的已儲存鏡頭文字",
    "en": "Saved shot text to send",
    "ja": "今回送信する保存済みショットの文章"
  },
  "agent.chat.moveOneSavedClip": {
    "zh-Hans": "只移动当前轨道上的一个已保存片段",
    "zh-Hant": "僅移動目前軌道上的一個已儲存片段",
    "en": "Move one saved clip on its current track only",
    "ja": "現在のトラック上の保存済みクリップ1つだけを移動"
  },
  "agent.chat.clipTargetSummary": {
    "zh-Hans": "{clipName} · {trackName}（{value}）· 基准版本 {expectedRevision}",
    "zh-Hant": "{clipName} · {trackName}（{value}）· 基準版本 {expectedRevision}",
    "en": "{clipName} · {trackName} ({value}) · Base revision {expectedRevision}",
    "ja": "{clipName} · {trackName}（{value}）· 基準リビジョン {expectedRevision}"
  },
  "agent.chat.audioTrack": {
    "zh-Hans": "音频轨道",
    "zh-Hant": "音訊軌道",
    "en": "Audio track",
    "ja": "オーディオトラック"
  },
  "agent.chat.videoTrack": {
    "zh-Hans": "视频轨道",
    "zh-Hant": "影片軌道",
    "en": "Video track",
    "ja": "ビデオトラック"
  },
  "agent.chat.clipTiming": {
    "zh-Hans": "{value} → {value2} · 时长 {value3}",
    "zh-Hant": "{value} → {value2} · 時長 {value3}",
    "en": "{value} → {value2} · Duration {value3}",
    "ja": "{value} → {value2} · 長さ {value3}"
  },
  "agent.chat.fullScopeLimits": {
    "zh-Hans": "完整发送范围与工具限额",
    "zh-Hant": "完整傳送範圍與工具限額",
    "en": "Full sending scope and tool limits",
    "ja": "送信範囲の詳細とツールの上限"
  },
  "agent.chat.expandReviewedScope": {
    "zh-Hans": "展开已核对的发送范围与工具限额",
    "zh-Hant": "展開已核對的傳送範圍與工具限額",
    "en": "Expand reviewed sending scope and tool limits",
    "ja": "確認済みの送信範囲とツールの上限を展開"
  },
  "agent.chat.moveDataDisclosure": {
    "zh-Hans": "发给模型的项目资料仅为上方片段名称和时间、轨道名称和类型、30fps，以及以下同轨其他片段的开始/结束帧。结束帧为排他端点",
    "zh-Hant": "傳送給模型的專案資料僅為上方的片段名稱與時間、軌道名稱與類型、30fps，以及以下同軌其他片段的開始與結束影格。結束影格為不包含在內的端點",
    "en": "Project data sent to the model is limited to the clip name and timing above, track name and type, 30 fps, and the start/end frames below for other clips on the same track. End frames are exclusive",
    "ja": "モデルに送信するプロジェクト情報は、上記のクリップ名と時間、トラック名と種類、30 fps、および以下の同一トラック上の他のクリップの開始・終了フレームのみです。終了フレームは区間に含まれません"
  },
  "agent.chat.frameInterval": {
    "zh-Hans": "{startFrame} → {endFrame} 帧",
    "zh-Hant": "{startFrame} → {endFrame} 影格",
    "en": "Frames {startFrame} → {endFrame}",
    "ja": "{startFrame} → {endFrame} フレーム"
  },
  "agent.chat.noOtherClips": {
    "zh-Hans": "同轨没有其他片段",
    "zh-Hant": "同軌沒有其他片段",
    "en": "No other clips on this track",
    "ja": "このトラックに他のクリップはありません"
  },
  "agent.chat.sentOccupiedIntervals": {
    "zh-Hans": "将发送的同轨其他片段数值区间",
    "zh-Hant": "將傳送的同軌其他片段數值區間",
    "en": "Numeric intervals of other clips to send",
    "ja": "送信する同一トラック上の他のクリップの数値区間"
  },
  "agent.chat.moveBounds": {
    "zh-Hans": {
      "one": "同轨其他区间 {count} 个，最多 99 个。最大结束位置 18000 帧 / 600 秒；仅提议新的开始帧，不换轨、不裁切、不改变时长，也不自动移动其他片段",
      "other": "同轨其他区间 {count} 个，最多 99 个。最大结束位置 18000 帧 / 600 秒；仅提议新的开始帧，不换轨、不裁切、不改变时长，也不自动移动其他片段"
    },
    "zh-Hant": {
      "one": "同軌其他區間共 {count} 個，最多 99 個。最大結束位置為 18000 影格 / 600 秒；僅提議新的開始影格，不換軌、不裁切、不改變時長，也不自動移動其他片段",
      "other": "同軌其他區間共 {count} 個，最多 99 個。最大結束位置為 18000 影格 / 600 秒；僅提議新的開始影格，不換軌、不裁切、不改變時長，也不自動移動其他片段"
    },
    "en": {
      "one": "There is {count} other interval on this track, with a maximum of 99. The latest end is 18000 frames / 600 seconds. Only a new start frame is proposed: no track change, trimming, duration change, or automatic movement of other clips",
      "other": "There are {count} other intervals on this track, with a maximum of 99. The latest end is 18000 frames / 600 seconds. Only a new start frame is proposed: no track change, trimming, duration change, or automatic movement of other clips"
    },
    "ja": {
      "one": "同じトラックの他の区間は{count}個で、最大99個です。終了位置の上限は18000フレーム / 600秒です。新しい開始フレームのみを提案し、トラックの変更、トリミング、長さの変更、他のクリップの自動移動は行いません",
      "other": "同じトラックの他の区間は{count}個で、最大99個です。終了位置の上限は18000フレーム / 600秒です。新しい開始フレームのみを提案し、トラックの変更、トリミング、長さの変更、他のクリップの自動移動は行いません"
    }
  },
  "agent.chat.movePreservedAndConflicts": {
    "zh-Hans": "片段源、画面几何、音量及淡入淡出保持不变；移动末尾片段可能改变时间线总时长。重叠、超界、字幕范围或保存版本冲突由服务端阻止，不会自动修正",
    "zh-Hant": "片段來源、畫面位置與大小、音量及淡入淡出保持不變；移動末尾片段可能改變時間軸總時長。重疊、超出範圍、字幕範圍或儲存版本衝突會由伺服器阻止，不會自動修正",
    "en": "Clip source, visual geometry, gain, and fades stay unchanged. Moving the last clip may change total timeline duration. The server blocks overlaps, out-of-bounds positions, subtitle-range conflicts, and saved-revision conflicts; it does not correct them automatically",
    "ja": "クリップのソース、映像の位置とサイズ、音量、フェードは変わりません。末尾のクリップを移動するとタイムライン全体の長さが変わる場合があります。重なり、範囲外、字幕範囲、保存リビジョンの競合はサーバーが拒否し、自動修正はしません"
  },
  "agent.chat.proposalToolLimits": {
    "zh-Hans": "提议工具 v{schemaVersion} · 目录 {catalogHash} · 最多 2 次模型请求 / 1 次提议 / 8 KiB 结果",
    "zh-Hant": "提議工具 v{schemaVersion} · 目錄 {catalogHash} · 最多 2 次模型請求 / 1 次提議 / 8 KiB 結果",
    "en": "Proposal tool v{schemaVersion} · Catalog {catalogHash} · At most 2 model requests / 1 proposal / 8 KiB results",
    "ja": "提案ツール v{schemaVersion} · カタログ {catalogHash} · モデルへのリクエスト最大2回 / 提案1回 / 結果8 KiB"
  },
  "agent.chat.localIdentity": {
    "zh-Hans": "本地核对身份（不发送给模型）",
    "zh-Hant": "本機核對身份（不傳送給模型）",
    "en": "Local verification identity (not sent to model)",
    "ja": "ローカル確認用の識別情報（モデルには送信しません）"
  },
  "agent.chat.projectId": {
    "zh-Hans": "项目 {projectId}",
    "zh-Hant": "專案 {projectId}",
    "en": "Project {projectId}",
    "ja": "プロジェクト {projectId}"
  },
  "agent.chat.timelineClipTrackIds": {
    "zh-Hans": "时间线 {timelineId} · 片段 {clipId} · 轨道 {trackId}",
    "zh-Hant": "時間軸 {timelineId} · 片段 {clipId} · 軌道 {trackId}",
    "en": "Timeline {timelineId} · Clip {clipId} · Track {trackId}",
    "ja": "タイムライン {timelineId} · クリップ {clipId} · トラック {trackId}"
  },
  "agent.chat.selectSavedClip": {
    "zh-Hans": "请先在时间线中选中一个已保存片段。片段和同轨区间必须符合安全范围",
    "zh-Hant": "請先在時間軸選中一個已儲存片段。片段及同軌區間必須符合安全範圍",
    "en": "Select a saved timeline clip first. The clip and same-track intervals must fit the safe bounds",
    "ja": "先にタイムラインで保存済みクリップを選択してください。クリップと同じトラックの区間は安全な範囲内である必要があります"
  },
  "agent.chat.savedTimingScope": {
    "zh-Hans": "本次发送的已保存片段时间范围",
    "zh-Hant": "此次傳送的已儲存片段時間範圍",
    "en": "Saved clip timing to send",
    "ja": "今回送信する保存済みクリップの時間範囲"
  },
  "agent.chat.destination": {
    "zh-Hans": "发送目标",
    "zh-Hant": "傳送目標",
    "en": "Destination",
    "ja": "送信先"
  },
  "agent.chat.missingModel": {
    "zh-Hans": "未填写模型",
    "zh-Hant": "尚未填寫模型",
    "en": "No model entered",
    "ja": "モデル未入力"
  },
  "agent.chat.missingEndpoint": {
    "zh-Hans": "未填写服务地址",
    "zh-Hant": "尚未填寫服務地址",
    "en": "No service URL entered",
    "ja": "サービスURL未入力"
  },
  "agent.chat.moveSendDisclosure": {
    "zh-Hans": "发送本条输入、范围内已完成的纯聊天文字，以及上方明确展示的已保存片段与同轨数值时间范围。不含其他轨道、媒体、路径、ID、源身份或未保存草稿；最多 2 次模型请求、1 次仅 startFrame 的提议工具调用、8 KiB 结果。续接关闭工具，提议不会自动应用",
    "zh-Hant": "傳送本條輸入、範圍內已完成的純聊天文字，以及上方明確展示的已儲存片段與同軌數值時間範圍。不含其他軌道、媒體、路徑、ID、來源身份或未儲存草稿；最多 2 次模型請求、1 次僅 startFrame 的提議工具呼叫、8 KiB 結果。接續時關閉工具，提議不會自動套用",
    "en": "Send this input, completed text-only chat within scope, and the explicitly displayed saved clip and numeric same-track time ranges above. Excludes other tracks, media, paths, IDs, source identities, and unsaved drafts. At most 2 model requests, 1 startFrame-only proposal-tool call, and 8 KiB of results. Tools are disabled on continuation; proposals are not applied automatically",
    "ja": "今回の入力、範囲内の完了済みテキストチャット、上に明示された保存済みクリップと同一トラックの数値時間範囲を送信します。他のトラック、メディア、パス、ID、ソースの識別情報、未保存の下書きは含みません。モデルへのリクエストは最大2回、startFrame のみを提案するツール呼び出しは最大1回、結果は最大8 KiBです。続行時はツールを無効にし、提案は自動適用しません"
  },
  "agent.chat.shotSendDisclosure": {
    "zh-Hans": "发送本条输入、范围内已完成的纯聊天文字，以及上方一个镜头的完整已保存标题和画面描述。仅允许 shot.update 的 title、prompt 提议，不发送其他镜头、媒体、未保存草稿或项目读取及修改提议轮次。最多 2 次模型请求、1 次提议工具调用、8 KiB 结果；续接关闭工具，提议不会自动应用",
    "zh-Hant": "傳送本條輸入、範圍內已完成的純聊天文字，以及上方一個鏡頭的完整已儲存標題與畫面描述。僅允許 shot.update 的 title、prompt 提議，不傳送其他鏡頭、媒體、未儲存草稿或專案讀取與修改提議輪次。最多 2 次模型請求、1 次提議工具呼叫、8 KiB 結果；接續時關閉工具，提議不會自動套用",
    "en": "Send this input, completed text-only chat within scope, and the full saved title and visual description of the one shot above. Only shot.update proposals for title and prompt are allowed. Other shots, media, unsaved drafts, and project inspection/edit-proposal turns are excluded. At most 2 model requests, 1 proposal-tool call, and 8 KiB of results. Tools are disabled on continuation; proposals are not applied automatically",
    "ja": "今回の入力、範囲内の完了済みテキストチャット、上記の1ショットの保存済みタイトル全文と画面描写を送信します。許可する提案は shot.update の title と prompt のみです。他のショット、メディア、未保存の下書き、プロジェクト確認・変更提案のターンは送信しません。モデルへのリクエストは最大2回、提案ツールの呼び出しは最大1回、結果は最大8 KiBです。続行時はツールを無効にし、提案は自動適用しません"
  },
  "agent.chat.inspectionSendDisclosure": {
    "zh-Hans": "发送本条输入、范围内的已完成对话，以及上方项目“{value}”的一次已保存文字与元数据读取结果。最多 2 次模型请求、1 次只读工具调用、8 KiB 结果；仅一次续接，续接时关闭工具",
    "zh-Hant": "傳送本條輸入、範圍內已完成的對話，以及上方專案「{value}」的一次已儲存文字與中繼資料讀取結果。最多 2 次模型請求、1 次唯讀工具呼叫、8 KiB 結果；僅接續一次，接續時關閉工具",
    "en": "Send this input, completed conversation within scope, and one read of saved text and metadata from project “{value}” above. At most 2 model requests, 1 read-only tool call, and 8 KiB of results. Only one continuation is allowed, with tools disabled",
    "ja": "今回の入力、範囲内の完了済み会話、上記プロジェクト「{value}」の保存済み文章とメタデータの1回分の読み取り結果を送信します。モデルへのリクエストは最大2回、読み取り専用ツールの呼び出しは最大1回、結果は最大8 KiBです。続行は1回のみで、その際はツールを無効にします"
  },
  "agent.chat.chatSendDisclosure": {
    "zh-Hans": "仅发送本条输入及范围内的已完成纯聊天文字。不含项目名称、ID、记录、媒体或项目读取轮次",
    "zh-Hant": "僅傳送本條輸入及範圍內已完成的純聊天文字，不含專案名稱、ID、記錄、媒體或專案讀取輪次",
    "en": "Send only this input and completed text-only chat within scope. Excludes project names, IDs, records, media, and project inspection turns",
    "ja": "今回の入力と範囲内の完了済みテキストチャットのみを送信します。プロジェクト名、ID、記録、メディア、プロジェクト確認のターンは含みません"
  },
  "agent.chat.consentAndHiddenNotice": {
    "zh-Hans": "{value}隐藏面板、页签或切换项目后，已接受的运行仍可能继续",
    "zh-Hant": "{value}隱藏面板、分頁或切換專案後，已接受的執行仍可能繼續",
    "en": "{value} Accepted runs may continue after hiding this panel or tab, or switching projects",
    "ja": "{value} パネルやタブを隠したりプロジェクトを切り替えたりしても、受け付け済みの実行は続く場合があります"
  },
  "agent.chat.moveSendConsent": {
    "zh-Hans": "我授权按以上项目、片段、保存版本、所展示的片段及同轨数值时间范围、协议、地址、模型和限额发送本条输入与纯聊天上下文，并保存记录；最多 2 次模型请求可能计费。这里只允许提出移动差异，应用仍需我另行明确批准",
    "zh-Hant": "我授權依以上專案、片段、儲存版本、所展示的片段與同軌數值時間範圍、協議、地址、模型及限額傳送本條輸入與純聊天上下文，並儲存記錄；最多 2 次模型請求可能計費。此處僅允許提出移動差異，套用仍須我另行明確批准",
    "en": "I authorize sending this input and text-only chat context and saving records using the project, clip, saved revision, displayed clip and same-track numeric time ranges, protocol, URL, model, and limits above. Up to 2 model requests may incur charges. This permits only a move proposal; applying it still requires my separate explicit approval",
    "ja": "上記のプロジェクト、クリップ、保存リビジョン、表示されたクリップと同一トラックの数値時間範囲、プロトコル、URL、モデル、上限に従って、今回の入力とテキストチャットのコンテキストを送信し、記録を保存することを許可します。最大2回のモデルへのリクエストに料金が発生する場合があります。許可するのは移動差分の提案のみで、適用には私の別途の明示的な承認が必要です"
  },
  "agent.chat.shotSendConsent": {
    "zh-Hans": "我授权按以上项目、镜头、已保存版本、完整文字、协议、地址、模型和工具限额发送本条输入、范围内纯聊天上下文及镜头文字，并保存本次记录；最多 2 次模型请求可能计费。此授权只允许提出差异，应用还需我另行明确批准",
    "zh-Hant": "我授權依以上專案、鏡頭、已儲存版本、完整文字、協議、地址、模型與工具限額傳送本條輸入、範圍內純聊天上下文及鏡頭文字，並儲存此次記錄；最多 2 次模型請求可能計費。此授權只允許提出差異，套用仍須我另行明確批准",
    "en": "I authorize sending this input, text-only chat context within scope, and shot text, and saving this record using the project, shot, saved revision, full text, protocol, URL, model, and tool limits above. Up to 2 model requests may incur charges. This permits only a proposal; applying it requires my separate explicit approval",
    "ja": "上記のプロジェクト、ショット、保存リビジョン、全文、プロトコル、URL、モデル、ツールの上限に従って、今回の入力、範囲内のテキストチャットのコンテキスト、ショットの文章を送信し、記録を保存することを許可します。最大2回のモデルへのリクエストに料金が発生する場合があります。この許可は差分の提案のみを対象とし、適用には私の別途の明示的な承認が必要です"
  },
  "agent.chat.inspectionSendConsent": {
    "zh-Hans": "我授权本次按以上协议、地址、模型和项目范围发送数据并保存记录；允许一次读取及关闭工具后的有限续接，不逐次询问。最多 2 次模型请求可能计费",
    "zh-Hant": "我授權此次依以上協議、地址、模型與專案範圍傳送資料並儲存記錄；允許一次讀取及關閉工具後的有限接續，不逐次詢問。最多 2 次模型請求可能計費",
    "en": "I authorize sending data and saving records for this turn using the protocol, URL, model, and project scope above. I allow one read and bounded continuation with tools disabled, without individual prompts. Up to 2 model requests may incur charges",
    "ja": "今回、上記のプロトコル、URL、モデル、プロジェクト範囲に従ってデータを送信し、記録を保存することを許可します。1回の読み取りと、ツールを無効にした制限付きの続行を、個別確認なしで許可します。最大2回のモデルへのリクエストに料金が発生する場合があります"
  },
  "agent.chat.chatSendConsent": {
    "zh-Hans": "我确认按以上协议、地址和模型发送本条输入及纯聊天上下文，并保存记录。一次模型请求可能计费",
    "zh-Hant": "我確認依以上協議、地址與模型傳送本條輸入及純聊天上下文，並儲存記錄。一次模型請求可能計費",
    "en": "I confirm sending this input and text-only chat context using the protocol, URL, and model above, and saving the record. One model request may incur charges",
    "ja": "上記のプロトコル、URL、モデルで今回の入力とテキストチャットのコンテキストを送信し、記録を保存することを確認します。1回のモデルへのリクエストに料金が発生する場合があります"
  },
  "agent.chat.messageLabel": {
    "zh-Hans": "给 Mio 的消息",
    "zh-Hant": "給 Mio 的訊息",
    "en": "Message to Mio",
    "ja": "Mio へのメッセージ"
  },
  "agent.chat.messagePlaceholder": {
    "zh-Hans": "输入想讨论的内容…",
    "zh-Hant": "輸入想討論的內容…",
    "en": "What would you like to discuss?",
    "ja": "話したい内容を入力…"
  },
  "agent.chat.promptByteCount": {
    "zh-Hans": "{promptBytes} / {AGENT_CHAT_PROMPT_BYTES} 字节 · Ctrl / ⌘ + Enter 发送",
    "zh-Hant": "{promptBytes} / {AGENT_CHAT_PROMPT_BYTES} 位元組 · Ctrl / ⌘ + Enter 傳送",
    "en": "{promptBytes} / {AGENT_CHAT_PROMPT_BYTES} bytes · Ctrl / ⌘ + Enter to send",
    "ja": "{promptBytes} / {AGENT_CHAT_PROMPT_BYTES} バイト · Ctrl / ⌘ + Enter で送信"
  },
  "agent.chat.reload": {
    "zh-Hans": "重新读取",
    "zh-Hant": "重新讀取",
    "en": "Reload",
    "ja": "再読み込み"
  },
  "agent.chat.stopLaterSteps": {
    "zh-Hans": "停止后续步骤",
    "zh-Hant": "停止後續步驟",
    "en": "Stop later steps",
    "ja": "後続の処理を停止"
  },
  "agent.chat.send": {
    "zh-Hans": "发送",
    "zh-Hant": "傳送",
    "en": "Send",
    "ja": "送信"
  },
  "agent.chat.stopDisclosure": {
    "zh-Hans": "停止阻止后续步骤，保留已有文字与结果；无法撤回已发生的费用。重启不会自动续接",
    "zh-Hant": "停止會阻止後續步驟，保留已有文字與結果；無法撤回已發生的費用。重啟不會自動接續",
    "en": "Stopping blocks later steps and retains existing text and results. It cannot reverse charges already incurred. Restarting will not resume automatically",
    "ja": "停止すると後続の処理を止め、既存の文章と結果を保持します。発生済みの料金は取り消せません。再起動しても自動では再開しません"
  },
  "agent.chat.conversationAria": {
    "zh-Hans": "Mio 文字对话",
    "zh-Hant": "Mio 文字對話",
    "en": "Mio text conversation",
    "ja": "Mio テキスト会話"
  },
  "agent.activity.notStartedStopped": {
    "zh-Hans": "未发起 · 不会自动继续",
    "zh-Hant": "尚未發起 · 不會自動繼續",
    "en": "Not started · Will not resume automatically",
    "ja": "未開始 · 自動では再開しません"
  },
  "agent.activity.notStarted": {
    "zh-Hans": "尚未发起",
    "zh-Hant": "尚未發起",
    "en": "Not started",
    "ja": "未開始"
  },
  "agent.activity.intentStopped": {
    "zh-Hans": "已记录 · 未继续",
    "zh-Hant": "已記錄 · 未繼續",
    "en": "Recorded · Not continued",
    "ja": "記録済み · 未続行"
  },
  "agent.activity.intentWaiting": {
    "zh-Hans": "已记录，等待开始",
    "zh-Hant": "已記錄，等待開始",
    "en": "Recorded; waiting to start",
    "ja": "記録済み、開始待ち"
  },
  "agent.activity.savingProposal": {
    "zh-Hans": "正在保存提议，未应用",
    "zh-Hant": "正在儲存提議，尚未套用",
    "en": "Saving proposal; not applied",
    "ja": "提案を保存中、未適用"
  },
  "agent.activity.reading": {
    "zh-Hans": "正在读取",
    "zh-Hant": "正在讀取",
    "en": "Reading",
    "ja": "読み取り中"
  },
  "agent.activity.requestStarted": {
    "zh-Hans": "请求已开始",
    "zh-Hant": "請求已開始",
    "en": "Request started",
    "ja": "リクエスト開始済み"
  },
  "agent.activity.proposalSaved": {
    "zh-Hans": "提议已保存，未自动应用",
    "zh-Hant": "提議已儲存，未自動套用",
    "en": "Proposal saved; not automatically applied",
    "ja": "提案を保存済み、自動適用はしていません"
  },
  "agent.activity.readComplete": {
    "zh-Hans": "读取完成",
    "zh-Hant": "讀取完成",
    "en": "Read complete",
    "ja": "読み取り完了"
  },
  "agent.activity.responseComplete": {
    "zh-Hans": "响应结束",
    "zh-Hant": "回應結束",
    "en": "Response complete",
    "ja": "応答完了"
  },
  "agent.activity.unknownNoRetry": {
    "zh-Hans": "状态未知 · 不会自动重试",
    "zh-Hant": "狀態未知 · 不會自動重試",
    "en": "Status unknown · No automatic retry",
    "ja": "状態不明 · 自動再試行なし"
  },
  "agent.activity.unknown": {
    "zh-Hans": "状态未知",
    "zh-Hant": "狀態未知",
    "en": "Status unknown",
    "ja": "状態不明"
  },
  "agent.activity.moveSummary": {
    "zh-Hans": "片段移动提议 · {clipName} · 保存版本 {expectedRevision}",
    "zh-Hant": "片段移動提議 · {clipName} · 儲存版本 {expectedRevision}",
    "en": "Clip move proposal · {clipName} · Saved revision {expectedRevision}",
    "ja": "クリップ移動提案 · {clipName} · 保存リビジョン {expectedRevision}"
  },
  "agent.activity.moveAuthorization": {
    "zh-Hans": {
      "one": "本轮授权：{trackName}上的“{clipName}”，{value} → {value2}，以及 {count} 个同轨其他片段数值区间。{value3}",
      "other": "本轮授权：{trackName}上的“{clipName}”，{value} → {value2}，以及 {count} 个同轨其他片段数值区间。{value3}"
    },
    "zh-Hant": {
      "one": "本輪授權：{trackName} 上的「{clipName}」，{value} → {value2}，以及 {count} 個同軌其他片段的數值區間。{value3}",
      "other": "本輪授權：{trackName} 上的「{clipName}」，{value} → {value2}，以及 {count} 個同軌其他片段的數值區間。{value3}"
    },
    "en": {
      "one": "Authorized for this turn: “{clipName}” on {trackName}, {value} → {value2}, and {count} numeric interval for other clips on the same track. {value3}",
      "other": "Authorized for this turn: “{clipName}” on {trackName}, {value} → {value2}, and {count} numeric intervals for other clips on the same track. {value3}"
    },
    "ja": {
      "one": "今回の許可範囲：{trackName} 上の「{clipName}」、{value} → {value2}、および同一トラック上の他のクリップの数値区間{count}個。{value3}",
      "other": "今回の許可範囲：{trackName} 上の「{clipName}」、{value} → {value2}、および同一トラック上の他のクリップの数値区間{count}個。{value3}"
    }
  },
  "agent.activity.chatTurnCount": {
    "zh-Hans": {
      "one": "另包含 {count} 轮已完成纯聊天文字",
      "other": "另包含 {count} 轮已完成纯聊天文字"
    },
    "zh-Hant": {
      "one": "另含 {count} 輪已完成的純聊天文字",
      "other": "另含 {count} 輪已完成的純聊天文字"
    },
    "en": {
      "one": "Also includes {count} completed text-only chat turn",
      "other": "Also includes {count} completed text-only chat turns"
    },
    "ja": {
      "one": "完了済みのテキストチャット{count}ターンも含みます",
      "other": "完了済みのテキストチャット{count}ターンも含みます"
    }
  },
  "agent.activity.moveProvenance": {
    "zh-Hans": "不含媒体、源身份、其他轨道或未保存编辑；只提出 startFrame 差异，不代表已应用。本轮文字不加入纯聊天上下文，应用状态请查看独立审阅区",
    "zh-Hant": "不含媒體、來源身份、其他軌道或未儲存編輯；只提出 startFrame 差異，不代表已套用。本輪文字不加入純聊天上下文，套用狀態請查看獨立審閱區",
    "en": "Excludes media, source identities, other tracks, and unsaved edits. This only proposes a startFrame change; it does not establish that it was applied. This turn’s text is not added to text-only chat context. Check the separate review area for application status",
    "ja": "メディア、ソースの識別情報、他のトラック、未保存の編集は含みません。startFrame の差分を提案するだけで、適用済みという意味ではありません。このターンの文章はテキストチャットのコンテキストには追加されません。適用状態は専用のレビュー欄で確認してください"
  },
  "agent.activity.shotAuthorization": {
    "zh-Hans": "本轮授权：项目 {projectId} 的镜头 {shotId}、保存版本 {expectedRevision} 的完整标题和画面描述。{value}不包含未保存编辑；本轮文字不加入纯聊天上下文。工具只提议，不代表已应用，请查看独立审阅区的保存状态",
    "zh-Hant": "本輪授權：專案 {projectId} 的鏡頭 {shotId}、儲存版本 {expectedRevision} 的完整標題與畫面描述。{value}不含未儲存編輯；本輪文字不加入純聊天上下文。工具僅提出提議，不代表已套用，請查看獨立審閱區的儲存狀態",
    "en": "Authorized for this turn: the full title and visual description of shot {shotId} in project {projectId}, saved revision {expectedRevision}. {value}Excludes unsaved edits; this turn is not added to text-only chat context. The tool only proposes changes, not applies them. Check saved status in the separate review area",
    "ja": "今回の許可範囲：プロジェクト {projectId} のショット {shotId}、保存リビジョン {expectedRevision} のタイトル全文と画面描写。{value}未保存の編集は含まず、このターンの文章はテキストチャットのコンテキストに追加しません。ツールは提案するだけで、適用済みではありません。保存状態は専用のレビュー欄で確認してください"
  },
  "agent.activity.projectAuthorizationHeading": {
    "zh-Hans": "本轮授权项目资料 · 不加入纯聊天上下文",
    "zh-Hant": "本輪授權的專案資料 · 不加入純聊天上下文",
    "en": "Project data authorized this turn · Excluded from text-only chat context",
    "ja": "今回許可されたプロジェクト情報 · テキストチャットのコンテキストには追加しません"
  },
  "agent.activity.projectAuthorization": {
    "zh-Hans": "本轮授权：项目 {projectId} 的已保存文字与元数据{value}。这类回复不会加入后续“仅文字聊天”的上下文；授权范围不代表所有资料均已读取",
    "zh-Hant": "本輪授權：專案 {projectId} 的已儲存文字與中繼資料{value}。這類回覆不會加入後續「僅文字聊天」的上下文；授權範圍不代表所有資料均已讀取",
    "en": "Authorized for this turn: saved text and metadata from project {projectId}{value}. These replies are not added to later text-only chat context. Authorization does not mean all data was read",
    "ja": "今回の許可範囲：プロジェクト {projectId} の保存済み文章とメタデータ{value}。この種類の返信は後続のテキストチャットのコンテキストには追加されません。許可範囲内のすべての情報を読み取ったことを意味するものではありません"
  },
  "agent.activity.referencedTurns": {
    "zh-Hans": {
      "one": "，引用 {count} 轮已完成对话",
      "other": "，引用 {count} 轮已完成对话"
    },
    "zh-Hant": {
      "one": "，引用 {count} 輪已完成對話",
      "other": "，引用 {count} 輪已完成對話"
    },
    "en": {
      "one": ", referencing {count} completed conversation turn",
      "other": ", referencing {count} completed conversation turns"
    },
    "ja": {
      "one": "、参照する完了済み会話は{count}ターン",
      "other": "、参照する完了済み会話は{count}ターン"
    }
  },
  "agent.activity.chatContext": {
    "zh-Hans": "本轮上下文：仅聊天文字，不含项目读取对话",
    "zh-Hant": "本輪上下文：僅聊天文字，不含專案讀取對話",
    "en": "This turn’s context: chat text only, excluding project inspection turns",
    "ja": "今回のコンテキスト：チャットの文章のみ。プロジェクト確認の会話は含みません"
  },
  "agent.activity.modelRequestOrdinal": {
    "zh-Hans": "模型请求 {ordinal} / 2{value}",
    "zh-Hant": "模型請求 {ordinal} / 2{value}",
    "en": "Model request {ordinal} / 2{value}",
    "ja": "モデルへのリクエスト {ordinal} / 2{value}"
  },
  "agent.activity.toolsDisabled": {
    "zh-Hans": " · 工具已关闭",
    "zh-Hant": " · 工具已關閉",
    "en": " · Tools disabled",
    "ja": " · ツール無効"
  },
  "agent.activity.gainProposalScope": {
    "zh-Hans": "仅所选片段的音量提议，尚需明确批准",
    "zh-Hant": "僅所選片段的音量提議，仍須明確批准",
    "en": "Selected clip gain proposal only; explicit approval still required",
    "ja": "選択中クリップの音量提案のみ。別途明示的な承認が必要です"
  },
  "agent.activity.moveProposalScope": {
    "zh-Hans": "仅所选片段的同轨移动提议，尚需明确批准",
    "zh-Hant": "僅所選片段的同軌移動提議，仍須明確批准",
    "en": "Selected clip same-track move proposal only; explicit approval still required",
    "ja": "選択中クリップの同一トラック内移動提案のみ。別途明示的な承認が必要です"
  },
  "agent.activity.shotProposalScope": {
    "zh-Hans": "仅所选镜头的修改提议，尚需明确批准",
    "zh-Hant": "僅所選鏡頭的修改提議，仍須明確批准",
    "en": "Selected shot edit proposal only; explicit approval still required",
    "ja": "選択中ショットの変更提案のみ。別途明示的な承認が必要です"
  },
  "agent.activity.readOnlyScope": {
    "zh-Hans": "本轮项目范围内只读",
    "zh-Hant": "本輪專案範圍內唯讀",
    "en": "Read-only within this turn’s project scope",
    "ja": "今回のプロジェクト範囲内での読み取り専用"
  },
  "agent.activity.viewProposalReceipt": {
    "zh-Hans": "查看已保存的提议回执",
    "zh-Hant": "查看已儲存的提議回執",
    "en": "View saved proposal receipt",
    "ja": "保存済みの提案受領記録を見る"
  },
  "agent.activity.viewReadResult": {
    "zh-Hans": "查看已保存的读取结果",
    "zh-Hant": "查看已儲存的讀取結果",
    "en": "View saved read result",
    "ja": "保存済みの読み取り結果を見る"
  },
  "agent.activity.activityAria": {
    "zh-Hans": "本轮运行活动",
    "zh-Hant": "本輪執行活動",
    "en": "Activity for this turn",
    "ja": "今回の実行内容"
  },
  "agent.proposal.shotTitle": {
    "zh-Hans": "镜头标题",
    "zh-Hant": "鏡頭標題",
    "en": "Shot title",
    "ja": "ショットのタイトル"
  },
  "agent.proposal.visualDescription": {
    "zh-Hans": "画面描述",
    "zh-Hant": "畫面描述",
    "en": "Visual description",
    "ja": "画面描写"
  },
  "agent.proposal.unchangedBadge": {
    "zh-Hans": "· 保持不变",
    "zh-Hant": "· 保持不變",
    "en": "· Unchanged",
    "ja": "· 変更なし"
  },
  "agent.proposal.before": {
    "zh-Hans": "修改前",
    "zh-Hant": "修改前",
    "en": "Before",
    "ja": "変更前"
  },
  "agent.proposal.empty": {
    "zh-Hans": "（空）",
    "zh-Hant": "（空）",
    "en": "(Empty)",
    "ja": "（空）"
  },
  "agent.proposal.proposedAfter": {
    "zh-Hans": "提议修改后",
    "zh-Hant": "提議修改後",
    "en": "Proposed after",
    "ja": "提案による変更後"
  },
  "agent.proposal.cleared": {
    "zh-Hans": "（清空）",
    "zh-Hant": "（清空）",
    "en": "(Cleared)",
    "ja": "（消去）"
  },
  "agent.proposal.diffAria": {
    "zh-Hans": "不可修改的已保存提议差异",
    "zh-Hant": "不可修改的已儲存提議差異",
    "en": "Immutable saved proposal diff",
    "ja": "変更できない保存済み提案の差分"
  },
  "agent.proposal.clipPosition": {
    "zh-Hans": "片段位置 · {fps} fps · 结束帧不包含在片段内",
    "zh-Hant": "片段位置 · {fps} fps · 結束影格不包含在片段內",
    "en": "Clip position · {fps} fps · End frame is exclusive",
    "ja": "クリップ位置 · {fps} fps · 終了フレームは区間に含みません"
  },
  "agent.proposal.beforeMove": {
    "zh-Hans": "移动前",
    "zh-Hant": "移動前",
    "en": "Before move",
    "ja": "移動前"
  },
  "agent.proposal.afterMove": {
    "zh-Hans": "提议移动后",
    "zh-Hant": "提議移動後",
    "en": "Proposed after move",
    "ja": "提案による移動後"
  },
  "agent.proposal.startTime": {
    "zh-Hans": "开始：{value}",
    "zh-Hant": "開始：{value}",
    "en": "Start: {value}",
    "ja": "開始：{value}"
  },
  "agent.proposal.endTime": {
    "zh-Hans": "结束：{value}",
    "zh-Hant": "結束：{value}",
    "en": "End: {value}",
    "ja": "終了：{value}"
  },
  "agent.proposal.fixedDuration": {
    "zh-Hans": "片段时长保持 {value}",
    "zh-Hant": "片段時長維持 {value}",
    "en": "Clip duration stays {value}",
    "ja": "クリップの長さは {value} のままです"
  },
  "agent.proposal.movePreservesFields": {
    "zh-Hans": "仅改变当前轨道上的开始位置。源素材、裁切、画面位置和大小、音量及淡入淡出保持不变",
    "zh-Hant": "僅改變目前軌道上的開始位置。來源素材、裁切、畫面位置與大小、音量及淡入淡出保持不變",
    "en": "Only the start position on the current track changes. Source asset, trim, visual position and size, gain, and fades stay unchanged",
    "ja": "現在のトラック上の開始位置だけを変更します。ソース素材、トリミング、映像の位置とサイズ、音量、フェードは変わりません"
  },
  "agent.proposal.nonRippleMove": {
    "zh-Hans": "非波纹移动：不会自动移动其他片段，不会换轨、夹紧或避让。重叠、超界、字幕超出范围或版本变化会阻止应用",
    "zh-Hant": "非波紋移動：不會自動移動其他片段，也不會換軌、限制到邊界或避讓。重疊、超出範圍、字幕超出範圍或版本變更會阻止套用",
    "en": "Non-ripple move: other clips are not moved automatically, and there is no track change, clamping, or collision avoidance. Overlaps, out-of-bounds positions, out-of-range subtitles, or revision changes block application",
    "ja": "リップルなしの移動です。他のクリップを自動で動かしたり、トラックを変えたり、境界内に補正したり、重なりを避けたりはしません。重なり、範囲外の位置や字幕、リビジョンの変更がある場合は適用を拒否します"
  },
  "agent.proposal.totalDuration": {
    "zh-Hans": "时间线总时长：{value} → {value2}{value3}",
    "zh-Hant": "時間軸總時長：{value} → {value2}{value3}",
    "en": "Total timeline duration: {value} → {value2}{value3}",
    "ja": "タイムライン全体の長さ：{value} → {value2}{value3}"
  },
  "agent.proposal.durationUnchanged": {
    "zh-Hans": "（保持不变）",
    "zh-Hant": "（保持不變）",
    "en": " (Unchanged)",
    "ja": "（変更なし）"
  },
  "agent.proposal.durationChanged": {
    "zh-Hans": "（移动末尾片段会改变总时长）",
    "zh-Hant": "（移動末尾片段會改變總時長）",
    "en": " (Moving the last clip changes total duration)",
    "ja": "（末尾のクリップを移動すると全体の長さが変わります）"
  },
  "agent.proposal.moveDiffAria": {
    "zh-Hans": "不可修改的已保存片段移动差异",
    "zh-Hant": "不可修改的已儲存片段移動差異",
    "en": "Immutable saved clip move diff",
    "ja": "変更できない保存済みクリップ移動の差分"
  },
  "agent.proposal.savedProposals": {"zh-Hans": "修改建议", "zh-Hant": "修改建議", "en": "Suggested changes", "ja": "変更の提案"},
  "agent.proposal.independentlySaved": {"zh-Hans": "已保存在本机", "zh-Hant": "已儲存在本機", "en": "Saved locally", "ja": "この端末に保存済み"},
  "agent.proposal.proposalAuthority": {
    "zh-Hans": "模型文字可能说“已修改”，请以这里的保存状态为准。只有明确批准后才会应用这份固定差异；不会自动执行、改写或重新基于新版本生成",
    "zh-Hant": "模型文字可能表示「已修改」，請以此處的儲存狀態為準。只有明確批准後才會套用這份固定差異；不會自動執行、改寫或依新版本重新產生",
    "en": "Model text may say “changed”; use the saved status here as the authority. This fixed diff is applied only after explicit approval. It will not execute, rewrite, or rebase onto a newer revision automatically",
    "ja": "モデルの文章に「変更しました」とあっても、ここに表示する保存状態を確認してください。この固定差分は明示的な承認後にのみ適用されます。自動実行、書き換え、新しいリビジョンに基づく再作成は行いません"
  },
  "agent.proposal.unresolved": {
    "zh-Hans": "待处理",
    "zh-Hant": "待處理",
    "en": "Pending",
    "ja": "保留中"
  },
  "agent.proposal.allRecords": {
    "zh-Hans": "全部记录",
    "zh-Hant": "全部記錄",
    "en": "All records",
    "ja": "すべての記録"
  },
  "agent.proposal.readOnlyCheck": {
    "zh-Hans": "只读核对",
    "zh-Hant": "唯讀核對",
    "en": "Check read-only",
    "ja": "読み取り専用で確認"
  },
  "agent.proposal.pinCapacity": {
    "zh-Hans": "已有 50 份原操作待核对。请先只读核对或恢复保留的原提议，再批准新的提议。原身份与请求不会丢弃",
    "zh-Hant": "已有 50 份原操作待核對。請先以唯讀方式核對或還原保留的原提議，再批准新提議。原身份與請求不會被丟棄",
    "en": "50 original operations are awaiting verification. Check them read-only or recover the retained original proposals before approving new ones. Original identities and requests will not be discarded",
    "ja": "元の操作50件が確認待ちです。新しい提案を承認する前に、保持された元の提案を読み取り専用で確認するか復元してください。元の識別情報とリクエストは破棄しません"
  },
  "agent.proposal.loadingProposals": {
    "zh-Hans": "正在读取保存的提议…",
    "zh-Hant": "正在讀取已儲存的提議…",
    "en": "Loading saved proposals…",
    "ja": "保存済みの提案を読み込み中…"
  },
  "agent.proposal.proposalStatusUnavailable": {
    "zh-Hans": "提议状态暂不可用",
    "zh-Hant": "提議狀態暫時無法使用",
    "en": "Proposal status is unavailable",
    "ja": "提案の状態を確認できません"
  },
  "agent.proposal.noPendingProposals": {
    "zh-Hans": "没有待处理的提议。已应用、拒绝或失效的提议可在全部记录中查看",
    "zh-Hant": "沒有待處理提議。已套用、拒絕或失效的提議可在全部記錄查看",
    "en": "No pending proposals. Applied, rejected, or invalidated proposals are available under All records",
    "ja": "保留中の提案はありません。適用済み、拒否済み、無効になった提案は「すべての記録」で確認できます"
  },
  "agent.proposal.noSavedProposals": {
    "zh-Hans": "还没有保存的修改提议",
    "zh-Hant": "尚無已儲存的修改提議",
    "en": "No saved edit proposals yet",
    "ja": "保存済みの変更提案はまだありません"
  },
  "agent.proposal.pinnedOriginal": {
    "zh-Hans": "原操作待核对 · 保留显示",
    "zh-Hant": "原操作待核對 · 保留顯示",
    "en": "Original operation unconfirmed · Kept visible",
    "ja": "元の操作の確認待ち · 表示を保持"
  },
  "agent.proposal.adjustClipGain": {
    "zh-Hans": "调整一个片段的音量",
    "zh-Hant": "調整一個片段的音量",
    "en": "Adjust one clip’s gain",
    "ja": "1つのクリップの音量を調整"
  },
  "agent.proposal.moveTimelineClip": {
    "zh-Hans": "移动一个时间线片段",
    "zh-Hant": "移動一個時間軸片段",
    "en": "Move one timeline clip",
    "ja": "1つのタイムラインクリップを移動"
  },
  "agent.proposal.baseRevision": {
    "zh-Hans": "基准版本 {expectedRevision}",
    "zh-Hant": "基準版本 {expectedRevision}",
    "en": "Base revision {expectedRevision}",
    "ja": "基準リビジョン {expectedRevision}"
  },
  "agent.proposal.outcomeUnconfirmed": {
    "zh-Hans": "操作结果待确认，不能认定未应用",
    "zh-Hant": "操作結果待確認，不能認定尚未套用",
    "en": "Outcome unconfirmed; do not assume it was not applied",
    "ja": "操作結果は確認待ちです。未適用とは判断できません"
  },
  "agent.proposal.clipTrackSummary": {
    "zh-Hans": "{clipName} · {trackName}（{value}）",
    "zh-Hant": "{clipName} · {trackName}（{value}）",
    "en": "{clipName} · {trackName} ({value})",
    "ja": "{clipName} · {trackName}（{value}）"
  },
  "agent.proposal.audioTrack": {
    "zh-Hans": "音频轨道",
    "zh-Hant": "音訊軌道",
    "en": "Audio track",
    "ja": "オーディオトラック"
  },
  "agent.proposal.videoTrack": {
    "zh-Hans": "视频轨道",
    "zh-Hant": "影片軌道",
    "en": "Video track",
    "ja": "ビデオトラック"
  },
  "agent.proposal.shotIdentity": {
    "zh-Hans": "镜头 {shotId}",
    "zh-Hant": "鏡頭 {shotId}",
    "en": "Shot {shotId}",
    "ja": "ショット {shotId}"
  },
  "agent.proposal.viewIdentityApproval": {
    "zh-Hans": "查看提议身份与批准记录",
    "zh-Hant": "查看提議身份與批准記錄",
    "en": "View proposal identity and approval record",
    "ja": "提案の識別情報と承認記録を見る"
  },
  "agent.proposal.operationIdentity": {
    "zh-Hans": "操作 {operation}",
    "zh-Hant": "操作 {operation}",
    "en": "Operation {operation}",
    "ja": "操作 {operation}"
  },
  "agent.proposal.timelineIdentity": {
    "zh-Hans": "时间线 {timelineId}",
    "zh-Hant": "時間軸 {timelineId}",
    "en": "Timeline {timelineId}",
    "ja": "タイムライン {timelineId}"
  },
  "agent.proposal.clipTrackIdentity": {
    "zh-Hans": "片段 {clipId} · 轨道 {trackId}",
    "zh-Hant": "片段 {clipId} · 軌道 {trackId}",
    "en": "Clip {clipId} · Track {trackId}",
    "ja": "クリップ {clipId} · トラック {trackId}"
  },
  "agent.proposal.proposalIdentity": {
    "zh-Hans": "提议 {id}",
    "zh-Hant": "提議 {id}",
    "en": "Proposal {id}",
    "ja": "提案 {id}"
  },
  "agent.proposal.digest": {
    "zh-Hans": "校验摘要 {digest}",
    "zh-Hant": "校驗摘要 {digest}",
    "en": "Digest {digest}",
    "ja": "検証ダイジェスト {digest}"
  },
  "agent.proposal.sourceRun": {
    "zh-Hans": "来源运行 {runId} · {runStatus}",
    "zh-Hant": "來源執行 {runId} · {runStatus}",
    "en": "Source run {runId} · {runStatus}",
    "ja": "元の実行 {runId} · {runStatus}"
  },
  "agent.proposal.savedOriginalRequest": {
    "zh-Hans": "已保存的原请求 {requestId}",
    "zh-Hant": "已儲存的原請求 {requestId}",
    "en": "Saved original request {requestId}",
    "ja": "保存済みの元のリクエスト {requestId}"
  },
  "agent.proposal.completedRunRequired": {
    "zh-Hans": "只有本轮成功完成后才能批准或拒绝。停止、失败或中断的运行不能批准；停止会使尚未批准的提议失效",
    "zh-Hant": "本輪成功完成後才能批准或拒絕。停止、失敗或中斷的執行不能批准；停止會使尚未批准的提議失效",
    "en": "Approval or rejection requires this turn to finish successfully. Stopped, failed, or interrupted runs cannot be approved. Stopping invalidates proposals that have not been approved",
    "ja": "このターンが正常に完了してから承認または拒否できます。停止、失敗、中断した実行は承認できません。停止すると未承認の提案は無効になります"
  },
  "agent.proposal.notAppliedReceipt": {
    "zh-Hans": "保存服务已确认未应用{value}",
    "zh-Hant": "儲存服務已確認未套用{value}",
    "en": "The save service confirmed it was not applied{value}",
    "ja": "保存サービスが未適用を確認しました{value}"
  },
  "agent.proposal.revisionConflictDetail": {
    "zh-Hans": "：已保存内容已变化，请核对最新版本。旧提议不会自动重新基于新版本修改",
    "zh-Hant": "：已儲存內容已變更，請核對最新版本。舊提議不會自動依新版本修改",
    "en": ": saved content has changed. Check the latest revision. The old proposal will not be rebased automatically",
    "ja": "。保存済みの内容が変わっています。最新リビジョンを確認してください。古い提案を自動で新しいリビジョンに合わせることはありません"
  },
  "agent.proposal.reviewCurrentContent": {
    "zh-Hans": "。请核对提议和当前保存内容",
    "zh-Hant": "。請核對提議與目前已儲存內容",
    "en": ". Review the proposal and currently saved content",
    "ja": "。提案と現在の保存内容を確認してください"
  },
  "agent.proposal.appliedHistoricalReceipt": {
    "zh-Hans": "保存服务已确认应用，{value}版本 {revision}。这是一条历史回执；当前内容会单独读取，不会覆盖更新的时间线或把未保存草稿标记为已保存",
    "zh-Hant": "儲存服務已確認套用，{value}版本 {revision}。這是歷史回執；目前內容會另行讀取，不會覆蓋較新的時間軸，也不會將未儲存草稿標示為已儲存",
    "en": "The save service confirmed application at {value} revision {revision}. This is a historical receipt. Current content is read separately; it will not overwrite a newer timeline or mark unsaved drafts as saved",
    "ja": "保存サービスが{value}のリビジョン {revision} への適用を確認しました。これは過去の受領記録です。現在の内容は別途読み取ります。新しいタイムラインを上書きしたり、未保存の下書きを保存済みとしたりはしません"
  },
  "agent.proposal.timelineObject": {
    "zh-Hans": "时间线",
    "zh-Hant": "時間軸",
    "en": "timeline",
    "ja": "タイムライン"
  },
  "agent.proposal.shotObject": {
    "zh-Hans": "镜头",
    "zh-Hant": "鏡頭",
    "en": "shot",
    "ja": "ショット"
  },
  "agent.proposal.retryApprovalDisclosure": {
    "zh-Hans": "较早的批准请求可能已被接受。重试只提交同一提议、同一摘要的批准，复用服务端已保存的原请求；不会创建新差异或新请求 ID",
    "zh-Hant": "較早的批准請求可能已被接受。重試只提交同一提議、同一摘要的批准，沿用伺服器已儲存的原請求；不會建立新差異或新請求 ID",
    "en": "An earlier approval request may have been accepted. Retrying approves only the same proposal and digest, reusing the original request saved by the server. It does not create a new diff or request ID",
    "ja": "以前の承認リクエストは受け付け済みかもしれません。再試行では同じ提案とダイジェストの承認のみを送信し、サーバーが保存した元のリクエストを再利用します。新しい差分やリクエストIDは作成しません"
  },
  "agent.proposal.recoverOriginalDisclosure": {
    "zh-Hans": "仅恢复上方已批准并保存的原请求，使用同一请求 ID 和差异。结果可能仍未知，不会创建新请求或再次调用模型",
    "zh-Hant": "僅還原上方已批准並儲存的原請求，使用同一請求 ID 與差異。結果可能仍未知，不會建立新請求或再次呼叫模型",
    "en": "Recover only the approved, saved original request above, using the same request ID and diff. The outcome may remain unknown. No new request or model call is created",
    "ja": "上記の承認・保存済みの元のリクエストだけを、同じリクエストIDと差分で復元します。結果が不明のままの場合もあります。新しいリクエストやモデル呼び出しは行いません"
  },
  "agent.proposal.approveApply": {
    "zh-Hans": "批准并应用此差异",
    "zh-Hant": "批准並套用此差異",
    "en": "Approve and apply this diff",
    "ja": "この差分を承認して適用"
  },
  "agent.proposal.reject": {
    "zh-Hans": "拒绝提议",
    "zh-Hant": "拒絕提議",
    "en": "Reject proposal",
    "ja": "提案を拒否"
  },
  "agent.proposal.retrySameApproval": {
    "zh-Hans": "重试同一批准请求",
    "zh-Hant": "重試同一批准請求",
    "en": "Retry the same approval request",
    "ja": "同じ承認リクエストを再試行"
  },
  "agent.proposal.recoverApprovedRequest": {
    "zh-Hans": "恢复已批准的原请求",
    "zh-Hant": "還原已批准的原請求",
    "en": "Recover approved original request",
    "ja": "承認済みの元のリクエストを復元"
  },
  "agent.proposal.inspectOriginal": {
    "zh-Hans": "只读核对原提议",
    "zh-Hant": "以唯讀方式核對原提議",
    "en": "Check original proposal read-only",
    "ja": "元の提案を読み取り専用で確認"
  },
  "agent.proposal.previousPage": {
    "zh-Hans": "上一页",
    "zh-Hant": "上一頁",
    "en": "Previous page",
    "ja": "前のページ"
  },
  "agent.proposal.nextPage": {
    "zh-Hans": "下一页",
    "zh-Hant": "下一頁",
    "en": "Next page",
    "ja": "次のページ"
  },
  "agent.proposal.pageLimit": {
    "zh-Hans": "每页最多 20 份 · 与聊天历史独立",
    "zh-Hant": "每頁最多 20 份 · 與聊天歷史獨立",
    "en": "Up to 20 per page · Separate from chat history",
    "ja": "1ページにつき最大20件 · チャット履歴とは独立"
  },
  "agent.proposal.reviewAria": {
    "zh-Hans": "审阅已保存的修改提议",
    "zh-Hant": "審閱已儲存的修改提議",
    "en": "Review saved edit proposals",
    "ja": "保存済みの変更提案をレビュー"
  },
  "agent.gain.sendDisclosure": {
    "zh-Hans": "发送本条输入、范围内已完成的纯聊天文字，以及上方明确展示的片段名称与已保存音量、轨道名称与类型及静音状态、已知含音频与 0–2 音量范围。不含媒体、路径、ID、源指纹、其他片段、波形或响度测量。最多 2 次模型请求、1 次仅 gain 的提议工具调用、8 KiB 结果；续接关闭工具，提议不会自动应用",
    "zh-Hant": "傳送本條輸入、範圍內已完成的純聊天文字，以及上方明確展示的片段名稱與已儲存音量、軌道名稱與類型及靜音狀態、已知含音訊與 0–2 音量範圍。不含媒體、路徑、ID、來源指紋、其他片段、波形或響度測量。最多 2 次模型請求、1 次僅 gain 的提議工具呼叫、8 KiB 結果；接續時關閉工具，提議不會自動套用",
    "en": "Send this input, completed text-only chat within scope, and the explicitly displayed clip name and saved gain, track name, type and mute state, known audio presence, and 0–2 gain range. Excludes media, paths, IDs, source fingerprints, other clips, waveforms, and loudness measurements. At most 2 model requests, 1 gain-only proposal-tool call, and 8 KiB of results. Tools are disabled on continuation; proposals are not applied automatically",
    "ja": "今回の入力、範囲内の完了済みテキストチャット、上に明示されたクリップ名と保存済み音量、トラック名・種類・ミュート状態、確認済みの音声の有無、0–2の音量範囲を送信します。メディア、パス、ID、ソースの指紋、他のクリップ、波形、ラウドネス測定値は含みません。モデルへのリクエストは最大2回、gain のみを提案するツール呼び出しは最大1回、結果は最大8 KiBです。続行時はツールを無効にし、提案は自動適用しません"
  },
  "agent.gain.sendConsent": {
    "zh-Hans": "我授权按以上项目、片段、保存版本、所展示的音量与轨道状态、协议、地址、模型和限额发送本条输入与纯聊天上下文，并保存记录；最多 2 次模型请求可能计费。这里只允许提出音量差异，应用仍需我另行明确批准",
    "zh-Hant": "我授權依以上專案、片段、儲存版本、所展示的音量與軌道狀態、協議、地址、模型及限額傳送本條輸入與純聊天上下文，並儲存記錄；最多 2 次模型請求可能計費。此處僅允許提出音量差異，套用仍須我另行明確批准",
    "en": "I authorize sending this input and text-only chat context and saving records using the project, clip, saved revision, displayed gain and track state, protocol, URL, model, and limits above. Up to 2 model requests may incur charges. This permits only a gain proposal; applying it still requires my separate explicit approval",
    "ja": "上記のプロジェクト、クリップ、保存リビジョン、表示された音量とトラックの状態、プロトコル、URL、モデル、上限に従って、今回の入力とテキストチャットのコンテキストを送信し、記録を保存することを許可します。最大2回のモデルへのリクエストに料金が発生する場合があります。許可するのは音量差分の提案のみで、適用には私の別途の明示的な承認が必要です"
  },
  "agent.gain.mutedTrackWarning": {
    "zh-Hans": "此轨道已静音。音量会保存，但轨道保持静音时仍听不到；不会自动取消轨道静音",
    "zh-Hant": "此軌道已靜音。音量會儲存，但軌道維持靜音時仍無法聽見；不會自動取消軌道靜音",
    "en": "This track is muted. Gain will be saved, but it remains inaudible while the track is muted. The track will not be unmuted automatically",
    "ja": "このトラックはミュート中です。音量は保存されますが、トラックがミュート中は聞こえません。自動でミュートを解除することはありません"
  },
  "agent.gain.clippingWarning": {
    "zh-Hans": "音量倍率高于 1 可能增加削波失真风险；这里没有自动限幅或响度测量",
    "zh-Hant": "音量倍率高於 1 可能增加削波失真風險；此處沒有自動限幅或響度測量",
    "en": "Gain above 1 may increase clipping risk. There is no automatic limiter or loudness measurement here",
    "ja": "音量倍率が1を超えるとクリッピングによる歪みのリスクが高まる場合があります。ここには自動リミッターやラウドネス測定はありません"
  },
  "agent.gain.previewScope": {
    "zh-Hans": "混音、渲染预览及导出使用此音量。原始源素材预览不会改变；请自行使用普通渲染预览或导出控件核对，不会自动渲染或播放",
    "zh-Hant": "混音、渲染預覽與匯出會使用此音量。原始來源素材預覽不會改變；請自行使用一般渲染預覽或匯出控制項核對，不會自動渲染或播放",
    "en": "Mixing, rendered previews, and exports use this gain. Original source previews stay unchanged. Check using the normal rendered-preview or export controls; no rendering or playback starts automatically",
    "ja": "ミックス、レンダリングプレビュー、書き出しにはこの音量を使います。元のソース素材のプレビューは変わりません。通常のレンダリングプレビューや書き出しの操作で確認してください。自動でレンダリングや再生は開始しません"
  },
  "agent.gain.linearGainHeading": {
    "zh-Hans": "片段音量 · 线性振幅倍率",
    "zh-Hant": "片段音量 · 線性振幅倍率",
    "en": "Clip gain · Linear amplitude multiplier",
    "ja": "クリップ音量 · 線形振幅倍率"
  },
  "agent.gain.before": {
    "zh-Hans": "修改前",
    "zh-Hant": "修改前",
    "en": "Before",
    "ja": "変更前"
  },
  "agent.gain.proposedAfter": {
    "zh-Hans": "提议修改后",
    "zh-Hant": "提議修改後",
    "en": "Proposed after",
    "ja": "提案による変更後"
  },
  "agent.gain.percentageDisclosure": {
    "zh-Hans": "百分比仅供阅读，实际保存上方完整倍率。0 仅让此片段静音，不改变轨道静音状态",
    "zh-Hant": "百分比僅供閱讀，實際儲存上方完整倍率。0 只會讓此片段靜音，不改變軌道靜音狀態",
    "en": "Percentages are for display only; the full multiplier above is saved. 0 silences only this clip and does not change track mute state",
    "ja": "パーセントは表示用です。実際には上記の完全な倍率を保存します。0はこのクリップだけを無音にし、トラックのミュート状態は変えません"
  },
  "agent.gain.preservedFields": {
    "zh-Hans": "仅改变这个已保存片段的 gain。时间、时长、源素材、画面位置、其他片段、字幕、淡入淡出和轨道静音保持不变",
    "zh-Hant": "僅改變此已儲存片段的 gain。時間、時長、來源素材、畫面位置、其他片段、字幕、淡入淡出與軌道靜音保持不變",
    "en": "Only this saved clip’s gain changes. Timing, duration, source asset, visual position, other clips, subtitles, fades, and track mute remain unchanged",
    "ja": "この保存済みクリップの gain だけを変更します。時間、長さ、ソース素材、映像の位置、他のクリップ、字幕、フェード、トラックのミュートは変わりません"
  },
  "agent.gain.diffAria": {
    "zh-Hans": "不可修改的已保存片段音量差异",
    "zh-Hant": "不可修改的已儲存片段音量差異",
    "en": "Immutable saved clip gain diff",
    "ja": "変更できない保存済みクリップ音量の差分"
  },
  "agent.gain.singleAudioClip": {
    "zh-Hans": "只调整一个已保存有声片段的音量",
    "zh-Hant": "只調整一個已儲存且含音訊的片段音量",
    "en": "Adjust only one saved clip with audio",
    "ja": "音声を含む保存済みクリップ1つだけの音量を調整"
  },
  "agent.gain.targetSummary": {
    "zh-Hans": "{clipName} · {trackName}（{value}）· 基准版本 {expectedRevision}",
    "zh-Hant": "{clipName} · {trackName}（{value}）· 基準版本 {expectedRevision}",
    "en": "{clipName} · {trackName} ({value}) · Base revision {expectedRevision}",
    "ja": "{clipName} · {trackName}（{value}）· 基準リビジョン {expectedRevision}"
  },
  "agent.gain.audioTrack": {
    "zh-Hans": "音频轨道",
    "zh-Hant": "音訊軌道",
    "en": "Audio track",
    "ja": "オーディオトラック"
  },
  "agent.gain.videoTrack": {
    "zh-Hans": "视频轨道",
    "zh-Hant": "影片軌道",
    "en": "Video track",
    "ja": "ビデオトラック"
  },
  "agent.gain.savedGainSummary": {
    "zh-Hans": "已保存音量：{value} · 轨道{value2} · 已知含音频 · 可提议倍率 0–2",
    "zh-Hant": "已儲存音量：{value} · 軌道{value2} · 已知含音訊 · 可提議倍率 0–2",
    "en": "Saved gain: {value} · Track {value2} · Known to contain audio · Allowed proposal range 0–2",
    "ja": "保存済み音量：{value} · トラック{value2} · 音声ありと確認済み · 提案できる倍率0–2"
  },
  "agent.gain.muted": {
    "zh-Hans": "已静音",
    "zh-Hant": "已靜音",
    "en": "muted",
    "ja": "ミュート中"
  },
  "agent.gain.unmuted": {
    "zh-Hans": "未静音",
    "zh-Hant": "未靜音",
    "en": "unmuted",
    "ja": "ミュートなし"
  },
  "agent.gain.modelHasNotHeardMedia": {
    "zh-Hans": "以上片段与轨道名称、类型、音量及静音状态是发给模型的全部项目资料。模型没有听过媒体，不能判断实际响度或是否清晰",
    "zh-Hant": "以上片段與軌道的名稱、類型、音量及靜音狀態，是傳送給模型的全部專案資料。模型未聽過媒體，不能判斷實際響度或清晰度",
    "en": "The clip and track names, types, gain, and mute state above are all the project data sent to the model. The model has not heard the media and cannot judge actual loudness or clarity",
    "ja": "上記のクリップとトラックの名前、種類、音量、ミュート状態が、モデルに送信するプロジェクト情報のすべてです。モデルはメディアを聞いておらず、実際のラウドネスや明瞭さは判断できません"
  },
  "agent.gain.toolLimits": {
    "zh-Hans": "提议工具 v{schemaVersion} · 目录 {catalogHash} · 最多 2 次模型请求 / 1 次提议 / 8 KiB 结果",
    "zh-Hant": "提議工具 v{schemaVersion} · 目錄 {catalogHash} · 最多 2 次模型請求 / 1 次提議 / 8 KiB 結果",
    "en": "Proposal tool v{schemaVersion} · Catalog {catalogHash} · At most 2 model requests / 1 proposal / 8 KiB results",
    "ja": "提案ツール v{schemaVersion} · カタログ {catalogHash} · モデルへのリクエスト最大2回 / 提案1回 / 結果8 KiB"
  },
  "agent.gain.localIdentity": {
    "zh-Hans": "本地核对身份（不发送给模型）",
    "zh-Hant": "本機核對身份（不傳送給模型）",
    "en": "Local verification identity (not sent to model)",
    "ja": "ローカル確認用の識別情報（モデルには送信しません）"
  },
  "agent.gain.projectIdentity": {
    "zh-Hans": "项目 {projectId}",
    "zh-Hant": "專案 {projectId}",
    "en": "Project {projectId}",
    "ja": "プロジェクト {projectId}"
  },
  "agent.gain.timelineIdentities": {
    "zh-Hans": "时间线 {timelineId} · 片段 {clipId} · 轨道 {trackId}",
    "zh-Hant": "時間軸 {timelineId} · 片段 {clipId} · 軌道 {trackId}",
    "en": "Timeline {timelineId} · Clip {clipId} · Track {trackId}",
    "ja": "タイムライン {timelineId} · クリップ {clipId} · トラック {trackId}"
  },
  "agent.gain.selectKnownAudio": {
    "zh-Hans": "请选中一个已保存音频片段或已知含音频的视频片段。图片、无声视频和音频元数据未知的素材不能使用此模式",
    "zh-Hant": "請選中一個已儲存的音訊片段，或已知含音訊的影片片段。圖片、無聲影片及音訊中繼資料未知的素材不能使用此模式",
    "en": "Select a saved audio clip or a video clip known to contain audio. Images, silent videos, and assets with unknown audio metadata cannot use this mode",
    "ja": "保存済みのオーディオクリップ、または音声を含むことが確認されたビデオクリップを選択してください。画像、無音の動画、音声メタデータが不明な素材ではこのモードを使用できません"
  },
  "agent.gain.selectionAria": {
    "zh-Hans": "本次发送的已保存片段音量范围",
    "zh-Hant": "此次傳送的已儲存片段音量範圍",
    "en": "Saved clip gain scope to send",
    "ja": "今回送信する保存済みクリップの音量範囲"
  },
  "agent.gain.activityProvenance": {
    "zh-Hans": "片段音量提议 · {clipName} · {trackName} · 保存版本 {expectedRevision} · 已保存音量 {value} · 轨道{value2}。{value3}不含媒体、源身份、其他片段或未保存编辑；只提出 gain 差异，不代表已应用。本轮文字不加入其他范围的项目上下文或纯聊天上下文，应用状态请查看独立审阅区",
    "zh-Hant": "片段音量提議 · {clipName} · {trackName} · 儲存版本 {expectedRevision} · 已儲存音量 {value} · 軌道{value2}。{value3}不含媒體、來源身份、其他片段或未儲存編輯；僅提出 gain 差異，不代表已套用。本輪文字不加入其他範圍的專案上下文或純聊天上下文，套用狀態請查看獨立審閱區",
    "en": "Clip gain proposal · {clipName} · {trackName} · Saved revision {expectedRevision} · Saved gain {value} · Track {value2}. {value3}Excludes media, source identities, other clips, and unsaved edits. It only proposes a gain change and does not establish application. This turn is excluded from other project scopes and text-only chat context. Check the separate review area for application status",
    "ja": "クリップ音量提案 · {clipName} · {trackName} · 保存リビジョン {expectedRevision} · 保存済み音量 {value} · トラック{value2}。{value3}メディア、ソースの識別情報、他のクリップ、未保存の編集は含みません。gain の差分を提案するだけで、適用済みではありません。このターンの文章は他の範囲のプロジェクトコンテキストやテキストチャットのコンテキストには追加しません。適用状態は専用のレビュー欄で確認してください"
  },
  "agent.gain.chatTurnCount": {
    "zh-Hans": { "one": "另包含 {count} 轮已完成纯聊天文字", "other": "另包含 {count} 轮已完成纯聊天文字" },
    "zh-Hant": { "one": "另含 {count} 輪已完成的純聊天文字", "other": "另含 {count} 輪已完成的純聊天文字" },
    "en": { "one": "Also includes {count} completed text-only chat turn", "other": "Also includes {count} completed text-only chat turns" },
    "ja": { "one": "完了済みのテキストチャット{count}ターンも含みます", "other": "完了済みのテキストチャット{count}ターンも含みます" }
  },
  "agent.workspace.selectProject": {
    "zh-Hans": "选择一个项目开始对话",
    "zh-Hant": "選擇一個專案開始對話",
    "en": "Select a project to start a conversation",
    "ja": "プロジェクトを選択して会話を始める"
  },
  "agent.workspace.noImplicitProjectContent": {
    "zh-Hans": "聊天文字不会自动包含项目内容",
    "zh-Hant": "聊天文字不會自動包含專案內容",
    "en": "Chat text does not automatically include project content",
    "ja": "チャットにプロジェクトの内容が自動で含まれることはありません"
  },
  "image.comfy.details.executionParameters": {
    "zh-Hans": "种子 {seed} · 20 steps · CFG 8 · euler / normal · denoise 1",
    "zh-Hant": "種子 {seed} · 20 steps · CFG 8 · euler / normal · denoise 1",
    "en": "Seed {seed} · 20 steps · CFG 8 · euler / normal · denoise 1",
    "ja": "シード {seed} · 20 steps · CFG 8 · euler / normal · denoise 1"
  },
  "image.comfy.details.fixedNodes": {
    "zh-Hans": "负向描述为空 · 固定 7 个内置节点",
    "zh-Hant": "負向描述為空 · 固定 7 個內建節點",
    "en": "Empty negative prompt · 7 fixed built-in nodes",
    "ja": "ネガティブプロンプトは空 · 固定の組み込みノード7個"
  },
  "image.comfy.details.remoteTaskIdentity": {
    "zh-Hans": "远端任务 {promptId}",
    "zh-Hant": "遠端工作 {promptId}",
    "en": "Remote task {promptId}",
    "ja": "リモートタスク {promptId}"
  },
  "image.comfy.details.workflowHash": {
    "zh-Hans": "工作流 SHA-256 {graphHash}",
    "zh-Hant": "工作流程 SHA-256 {graphHash}",
    "en": "Workflow SHA-256 {graphHash}",
    "ja": "ワークフロー SHA-256 {graphHash}"
  },
  "image.comfy.details.frozenWorkflow": {
    "zh-Hans": "完整冻结工作流（审批后按此发送）",
    "zh-Hant": "完整固定工作流程（批准後依此傳送）",
    "en": "Complete frozen workflow (sent exactly as approved)",
    "ja": "固定されたワークフロー全体（承認後、この内容を送信）"
  },
  "image.comfy.details.approvalDisclosure": {
    "zh-Hans": "批准后向所列本机地址提交最多 1 次，可能占用 GPU、内存与磁盘。停止观察或关闭应用不会取消远端工作，GPU 工作可能继续。该地址与模型名称不保证免费、可信或完全离线。保留原始描述，不会自动重试",
    "zh-Hant": "批准後會向所列本機地址提交最多 1 次，可能使用 GPU、記憶體及磁碟。停止觀察或關閉應用程式不會取消遠端工作，GPU 工作可能繼續。該地址與模型名稱不保證免費、可信或完全離線。保留原始描述，不會自動重試",
    "en": "Approval submits at most once to the listed local address and may use GPU, memory, and disk. Stopping observation or closing the app does not cancel remote work; GPU processing may continue. The address and model name do not guarantee that it is free, trusted, or entirely offline. The original prompt is preserved; there is no automatic retry",
    "ja": "承認後、表示されたローカルアドレスへ最大1回送信し、GPU、メモリ、ディスクを使用する場合があります。監視の停止やアプリの終了ではリモート処理をキャンセルせず、GPU処理が続く可能性があります。アドレスやモデル名は、無料、信頼できる、完全にオフラインであることを保証しません。元のプロンプトを保持し、自動再試行はしません"
  },
  "image.comfy.details.originalConfiguration": {
    "zh-Hans": "原审批配置 r{settingsRevision} · {profileId}",
    "zh-Hant": "原批准設定 r{settingsRevision} · {profileId}",
    "en": "Original approval configuration r{settingsRevision} · {profileId}",
    "ja": "元の承認時の設定 r{settingsRevision} · {profileId}"
  },
  "image.comfy.details.frozenWorkflowHash": {
    "zh-Hans": "冻结工作流 SHA-256 {graphHash}",
    "zh-Hant": "固定工作流程 SHA-256 {graphHash}",
    "en": "Frozen workflow SHA-256 {graphHash}",
    "ja": "固定ワークフロー SHA-256 {graphHash}"
  },
  "image.comfy.details.originalReviewNotLoaded": {
    "zh-Hans": "此页未载入任务关联的原始审批，当前连接设置不代表此任务",
    "zh-Hant": "本頁未載入此工作對應的原批准記錄；目前連線設定不代表此工作",
    "en": "This page has not loaded the task’s original approval. Current connection settings do not represent this task",
    "ja": "このページにはタスクに対応する元の承認が読み込まれていません。現在の接続設定は、このタスクの設定を示すものではありません"
  },
  "image.comfy.details.remoteIdentityStatus": {
    "zh-Hans": "远端身份状态：{value}",
    "zh-Hant": "遠端身份狀態：{value}",
    "en": "Remote identity status: {value}",
    "ja": "リモート識別情報の状態：{value}"
  },
  "image.comfy.details.completeWorkflowStatus": {
    "zh-Hans": "完整工作流：{value}",
    "zh-Hant": "完整工作流程：{value}",
    "en": "Complete workflow: {value}",
    "ja": "ワークフロー全体：{value}"
  },
  "image.comfy.details.workflowVerified": {
    "zh-Hans": "已核验与冻结工作流一致",
    "zh-Hant": "已核驗與固定工作流程一致",
    "en": "Verified against the frozen workflow",
    "ja": "固定ワークフローとの一致を検証済み"
  },
  "image.comfy.details.workflowUnverified": {
    "zh-Hans": "尚未核验；仅任务 ID 或排队状态不能证明内容一致",
    "zh-Hant": "尚未核驗；僅工作 ID 或佇列狀態無法證明內容一致",
    "en": "Not verified; a task ID or queue status alone does not prove matching content",
    "ja": "未検証。タスクIDや待機状態だけでは内容の一致を証明できません"
  },
  "image.comfy.details.observationQueued": {
    "zh-Hans": "本次查询等待执行",
    "zh-Hant": "此次查詢等待執行",
    "en": "This query is waiting to run",
    "ja": "今回の照会は実行待ちです"
  },
  "image.comfy.details.observing": {
    "zh-Hans": "正在查询并取回",
    "zh-Hant": "正在查詢並取回",
    "en": "Querying and retrieving",
    "ja": "照会して取得中"
  },
  "image.comfy.details.observationComplete": {
    "zh-Hans": "本次查询已结束；以核验结果为准",
    "zh-Hant": "此次查詢已結束；以核驗結果為準",
    "en": "This query finished; use the verification result",
    "ja": "今回の照会は終了しました。検証結果を確認してください"
  },
  "image.comfy.details.observationInterrupted": {
    "zh-Hans": "本次查询已中断；需要再次明确查询，不会重提生成",
    "zh-Hant": "此次查詢已中斷；須再次明確查詢，不會重新提交生成",
    "en": "This query was interrupted. Query again explicitly; generation will not be resubmitted",
    "ja": "今回の照会は中断されました。再度明示的に照会してください。生成を再送信することはありません"
  },
  "image.comfy.details.noVerifiableResult": {
    "zh-Hans": "。未能取回可核验结果，请查看身份与内容状态",
    "zh-Hant": "。未能取回可核驗結果，請查看身份與內容狀態",
    "en": ". No verifiable result was retrieved. Check identity and content status",
    "ja": "。検証可能な結果を取得できませんでした。識別情報と内容の状態を確認してください"
  },
  "image.comfy.details.observationScope": {
    "zh-Hans": "“查询并取回”只查询此任务并核验后取回结果，不重提生成。关闭面板或停止读取不会停止 ComfyUI 的 GPU 工作",
    "zh-Hant": "「查詢並取回」只會查詢此工作，並在核驗後取回結果，不會重新提交生成。關閉面板或停止讀取不會停止 ComfyUI 的 GPU 工作",
    "en": "“Query and retrieve” only queries this task and retrieves its result after verification; it does not resubmit generation. Closing the panel or stopping reads does not stop ComfyUI GPU work",
    "ja": "「照会して取得」はこのタスクを照会し、検証後に結果を取得するだけで、生成を再送信しません。パネルを閉じたり読み取りを停止したりしても、ComfyUIのGPU処理は停止しません"
  },
  "image.comfy.details.identitySaved": {
    "zh-Hans": "已保存身份，尚未发送",
    "zh-Hant": "已儲存身份，尚未傳送",
    "en": "Identity saved; not yet sent",
    "ja": "識別情報を保存済み、未送信"
  },
  "image.comfy.details.dispatchBoundary": {
    "zh-Hans": "已记录发送边界；是否送达待确认",
    "zh-Hant": "已記錄傳送邊界；是否送達待確認",
    "en": "Dispatch boundary recorded; delivery unconfirmed",
    "ja": "送信開始境界を記録済み、到達は未確認"
  },
  "image.comfy.details.dispatchUnknown": {
    "zh-Hans": "发送结果未知",
    "zh-Hant": "傳送結果未知",
    "en": "Submission outcome unknown",
    "ja": "送信結果不明"
  },
  "image.comfy.details.sameTaskQueued": {
    "zh-Hans": "已找到相同任务 ID · 等待执行",
    "zh-Hant": "已找到相同工作 ID · 等待執行",
    "en": "Same task ID found · Queued",
    "ja": "同じタスクIDを確認 · 待機中"
  },
  "image.comfy.details.sameTaskRunning": {
    "zh-Hans": "已找到相同任务 ID · 正在执行",
    "zh-Hant": "已找到相同工作 ID · 正在執行",
    "en": "Same task ID found · Running",
    "ja": "同じタスクIDを確認 · 実行中"
  },
  "image.comfy.details.completedTaskFound": {
    "zh-Hans": "已找到已完成任务",
    "zh-Hant": "已找到完成的工作",
    "en": "Completed task found",
    "ja": "完了したタスクを確認"
  },
  "image.comfy.details.failedTaskFound": {
    "zh-Hans": "已找到失败任务",
    "zh-Hant": "已找到失敗的工作",
    "en": "Failed task found",
    "ja": "失敗したタスクを確認"
  },
  "image.comfy.details.noEvidence": {
    "zh-Hans": "未取得可核验证据；不证明未执行",
    "zh-Hant": "未取得可核驗證據；不代表未執行",
    "en": "No verifiable evidence; this does not prove non-execution",
    "ja": "検証可能な証拠なし。未実行を意味しません"
  },
  "image.comfy.details.unverified": {
    "zh-Hans": "尚未核验",
    "zh-Hant": "尚未核驗",
    "en": "Not yet verified",
    "ja": "未検証"
  },
  "generation.inputs.firstFrameRole": {
    "zh-Hans": "首帧参考图",
    "zh-Hant": "首影格參考圖",
    "en": "First-frame reference image",
    "ja": "開始フレーム参照画像"
  },
  "generation.inputs.lastFrameRole": {
    "zh-Hans": "尾帧参考图",
    "zh-Hant": "尾影格參考圖",
    "en": "Last-frame reference image",
    "ja": "終了フレーム参照画像"
  },
  "generation.inputs.subjectRole": {
    "zh-Hans": "主体参考",
    "zh-Hant": "主體參考",
    "en": "Subject reference",
    "ja": "被写体参照"
  },
  "generation.inputs.styleRole": {
    "zh-Hans": "风格参考",
    "zh-Hant": "風格參考",
    "en": "Style reference",
    "ja": "スタイル参照"
  },
  "generation.inputs.motionRole": {
    "zh-Hans": "动作参考",
    "zh-Hant": "動作參考",
    "en": "Motion reference",
    "ja": "動きの参照"
  },
  "generation.inputs.roleCount": {
    "zh-Hans": "{value} {value2}",
    "zh-Hant": "{value} {value2}",
    "en": "{value} {value2}",
    "ja": "{value}{value2}"
  },
  "generation.inputs.imageUnit": {
    "zh-Hans": "张",
    "zh-Hant": "張",
    "en": "images",
    "ja": "枚"
  },
  "generation.inputs.itemUnit": {
    "zh-Hans": "个",
    "zh-Hant": "個",
    "en": "items",
    "ja": "個"
  },
  "generation.inputs.runwayRegionMeaning": {
    "zh-Hans": "固定 Runway API 端点标签，不代表数据驻留保证",
    "zh-Hant": "固定 Runway API 端點標籤，不代表資料駐留保證",
    "en": "Fixed Runway API endpoint label; not a data residency guarantee",
    "ja": "固定の Runway API エンドポイントのラベルです。データ保管地域を保証しません"
  },
  "generation.inputs.arkRegionMeaning": {
    "zh-Hans": "固定中国大陆方舟 API 端点",
    "zh-Hant": "固定中國大陸方舟 API 端點",
    "en": "Fixed mainland China Ark API endpoint",
    "ja": "中国本土の固定 Ark API エンドポイント"
  },
  "generation.inputs.veoRegionMeaning": {
    "zh-Hans": "Gemini Developer API，不是 Vertex AI；不代表数据驻留保证",
    "zh-Hant": "Gemini Developer API，並非 Vertex AI；不代表資料駐留保證",
    "en": "Gemini Developer API, not Vertex AI; not a data residency guarantee",
    "ja": "Vertex AI ではなく Gemini Developer API です。データ保管地域を保証しません"
  },
  "generation.inputs.configuredRegionMeaning": {
    "zh-Hans": "由服务器明确配置，账号和密钥须与 API 区域匹配",
    "zh-Hant": "由伺服器明確設定，帳戶與密鑰須符合 API 區域",
    "en": "Explicitly configured by the server; account and key must match the API region",
    "ja": "サーバーで明示的に設定されます。アカウントとキーは API の地域に対応している必要があります"
  },
  "generation.inputs.mockRegionMeaning": {
    "zh-Hans": "本地模拟，不调用外部服务",
    "zh-Hant": "本機模擬，不呼叫外部服務",
    "en": "Local simulation; no external service calls",
    "ja": "ローカルシミュレーション。外部サービスは呼び出しません"
  },
  "generation.inputs.unknownRegionMeaning": {
    "zh-Hans": "API 配置标签，不代表数据驻留保证",
    "zh-Hant": "API 設定標籤，不代表資料駐留保證",
    "en": "API configuration label; not a data residency guarantee",
    "ja": "API 設定のラベルです。データ保管地域を保証しません"
  },
  "generation.inputs.unconfirmedCount": {
    "zh-Hans": "数量未确认",
    "zh-Hant": "數量尚未確認",
    "en": "Count unconfirmed",
    "ja": "数量未確認"
  },
  "generation.inputs.roleLimitsUnavailable": {
    "zh-Hans": "尚未取得此模型的角色限制，请刷新服务商信息后核对",
    "zh-Hant": "尚未取得此模型的角色限制，請重新整理服務商資訊後核對",
    "en": "Role limits for this model are not available yet. Refresh provider information and check again",
    "ja": "このモデルの参照用途ごとの制限をまだ取得できていません。プロバイダー情報を更新して確認してください"
  },
  "generation.inputs.roleNotImplemented": {
    "zh-Hans": "Mioon 当前适配器未接入此角色，尚无对应的生成输入映射",
    "zh-Hant": "Mioon 目前的適配器尚未接入此角色，沒有對應的生成輸入映射",
    "en": "The current Mioon adapter does not implement this role or a corresponding generation-input mapping",
    "ja": "現在の Mioon アダプターはこの参照用途に未対応で、対応する生成入力のマッピングもありません"
  },
  "generation.inputs.formats": {
    "zh-Hans": "格式：{value}",
    "zh-Hant": "格式：{value}",
    "en": "Formats: {value}",
    "ja": "形式：{value}"
  },
  "generation.inputs.undeclared": {
    "zh-Hans": "未声明",
    "zh-Hant": "未宣告",
    "en": "Not declared",
    "ja": "未定義"
  },
  "generation.inputs.singleFile": {
    "zh-Hans": "单张文件：{value}",
    "zh-Hant": "單張檔案：{value}",
    "en": "Per image: {value}",
    "ja": "画像1枚あたり：{value}"
  },
  "generation.inputs.maximumBytes": {
    "zh-Hans": "最多 {value}",
    "zh-Hant": "最多 {value}",
    "en": "Up to {value}",
    "ja": "最大 {value}"
  },
  "generation.inputs.sizeLimitUndeclared": {
    "zh-Hans": "大小上限未声明",
    "zh-Hant": "未宣告大小上限",
    "en": "Size limit not declared",
    "ja": "サイズ上限は未定義"
  },
  "generation.inputs.dataUriLimit": {
    "zh-Hans": "编码后 data URI：最多 {value}",
    "zh-Hant": "編碼後 data URI：最多 {value}",
    "en": "Encoded data URI: up to {value}",
    "ja": "エンコード後の data URI：最大 {value}"
  },
  "generation.inputs.dimensions": {
    "zh-Hans": "尺寸：{value}",
    "zh-Hant": "尺寸：{value}",
    "en": "Dimensions: {value}",
    "ja": "寸法：{value}"
  },
  "generation.inputs.minimumDimensions": {
    "zh-Hans": "宽高均至少 {min}px",
    "zh-Hant": "寬高皆至少 {min}px",
    "en": "Width and height at least {min}px",
    "ja": "幅・高さともに{min}px以上"
  },
  "generation.inputs.maximumDimensions": {
    "zh-Hans": "宽高均不超过 {max}px",
    "zh-Hant": "寬高皆不超過 {max}px",
    "en": "Width and height at most {max}px",
    "ja": "幅・高さともに{max}px以下"
  },
  "generation.inputs.matchAspectRatio": {
    "zh-Hans": "须与镜头画幅比例一致",
    "zh-Hant": "須與鏡頭畫幅比例一致",
    "en": "Must match the shot aspect ratio",
    "ja": "ショットのアスペクト比と一致する必要があります"
  },
  "generation.inputs.independentAspectRatio": {
    "zh-Hans": "图片比例与输出画幅独立，可用方形图",
    "zh-Hant": "圖片比例獨立於輸出畫幅，可使用正方形圖片",
    "en": "Image aspect ratio is independent of output; square images are allowed",
    "ja": "画像の比率は出力とは独立しており、正方形画像も使用できます"
  },
  "generation.inputs.minimumAspectRatio": {
    "zh-Hans": "宽高比至少 {minAspectRatio}",
    "zh-Hant": "寬高比至少 {minAspectRatio}",
    "en": "Aspect ratio at least {minAspectRatio}",
    "ja": "アスペクト比は{minAspectRatio}以上"
  },
  "generation.inputs.maximumAspectRatio": {
    "zh-Hans": "宽高比不超过 {maxAspectRatio}",
    "zh-Hant": "寬高比不超過 {maxAspectRatio}",
    "en": "Aspect ratio at most {maxAspectRatio}",
    "ja": "アスペクト比は{maxAspectRatio}以下"
  },
  "generation.inputs.dimensionsUndeclared": {
    "zh-Hans": "此适配配置未声明像素范围",
    "zh-Hant": "此適配設定未宣告像素範圍",
    "en": "This adapter profile does not declare pixel bounds",
    "ja": "このアダプタープロファイルではピクセル範囲が定義されていません"
  },
  "generation.inputs.adapterScope": {
    "zh-Hans": "Mioon 当前适配器的已接入范围；不代表服务商全部能力",
    "zh-Hant": "Mioon 目前適配器已接入的範圍，不代表服務商的全部能力",
    "en": "Scope implemented by the current Mioon adapter, not the provider’s full capabilities",
    "ja": "現在の Mioon アダプターで実装されている範囲です。プロバイダーのすべての機能を示すものではありません"
  },
  "generation.inputs.totalReferences": {
    "zh-Hans": "总参考图：{minReferences}–{maxReferences} 张。{value}{value2}",
    "zh-Hant": "參考圖總數：{minReferences}–{maxReferences} 張。{value}{value2}",
    "en": "Total reference images: {minReferences}–{maxReferences}. {value} {value2}",
    "ja": "参照画像の合計：{minReferences}–{maxReferences}枚。{value}{value2}"
  },
  "generation.inputs.firstLastCombination": {
    "zh-Hans": "支持单张首帧，或一张首帧加一张尾帧；尾帧不能单独提交",
    "zh-Hant": "支援單張首影格，或一張首影格加一張尾影格；尾影格不能單獨提交",
    "en": "Supports one first frame, or one first frame plus one last frame. A last frame cannot be submitted alone",
    "ja": "開始フレーム1枚、または開始フレーム1枚と終了フレーム1枚に対応します。終了フレームだけでは送信できません"
  },
  "generation.inputs.firstFrameOnly": {
    "zh-Hans": "只接入单张首帧，不组合多个参考角色",
    "zh-Hant": "僅接入單張首影格，不組合多個參考角色",
    "en": "Only one first frame is implemented; multiple reference roles are not combined",
    "ja": "開始フレーム1枚のみに対応し、複数の参照用途は組み合わせません"
  },
  "generation.inputs.fixedSubjectAlternative": {
    "zh-Hans": "另支持单张固定主体图片；不能与首帧、尾帧或连线组合",
    "zh-Hant": "另支援單張固定主體圖片；不能與首影格、尾影格或連線組合",
    "en": "Also supports one fixed subject image, which cannot be combined with first frames, last frames, or connections",
    "ja": "固定された被写体画像1枚にも対応します。開始フレーム、終了フレーム、接続との併用はできません"
  },
  "generation.inputs.roleLimitsAria": {
    "zh-Hans": "各参考角色的数量与限制",
    "zh-Hant": "各參考角色的數量與限制",
    "en": "Counts and limits for each reference role",
    "ja": "参照用途ごとの数量と制限"
  },
  "generation.inputs.planningNotGeneration": {
    "zh-Hans": "主体与风格的策划关联不会自动作为生成输入。角色、产品或场景图片须在镜头属性中明确选择本次固定版本；此入口仅接入 Mock 与 Ark 的 doubao-seedance-2-5-260628。风格仍仅供策划。首帧仍由现有参考图选择或首帧连接提供。尾帧在镜头属性中单独保存；首尾帧组合仅接入 Ark 与 Mock，同一素材不可同时作为首尾帧（当前应用限制）",
    "zh-Hant": "主體與風格的策劃關聯不會自動成為生成輸入。角色、產品或場景圖片須在鏡頭屬性中明確選擇此次的固定版本；此入口僅接入 Mock 與 Ark 的 doubao-seedance-2-5-260628。風格仍僅供策劃。首影格仍由現有參考圖選擇或首影格連線提供。尾影格在鏡頭屬性中另行儲存；首尾影格組合僅接入 Ark 與 Mock，同一素材不可同時作為首尾影格（目前應用程式的限制）",
    "en": "Planning associations for subjects and styles do not automatically become generation inputs. Explicitly select the fixed version of a character, product, or scene image in shot properties for this request. This entry point supports only Mock and Ark’s doubao-seedance-2-5-260628. Styles remain planning-only. First frames still come from the existing reference-image selector or first-frame connections. Last frames are saved separately in shot properties. First/last combinations are implemented only for Ark and Mock; the same asset cannot serve as both (a current app limitation)",
    "ja": "被写体やスタイルの企画上の関連付けは、自動で生成入力にはなりません。人物、製品、シーンの画像は、ショットのプロパティで今回使用する固定バージョンを明示的に選択してください。この入口は Mock と Ark の doubao-seedance-2-5-260628 のみに対応します。スタイルは引き続き企画専用です。開始フレームは既存の参照画像選択または開始フレーム接続で指定します。終了フレームはショットのプロパティで別途保存します。開始・終了フレームの組み合わせは Ark と Mock のみに対応し、同じ素材を両方に使用することはできません（現在のアプリの制限）"
  },
  "generation.inputs.adapterProfile": {
    "zh-Hans": "适配配置",
    "zh-Hant": "適配設定",
    "en": "Adapter profile",
    "ja": "アダプタープロファイル"
  },
  "generation.inputs.profileReview": {
    "zh-Hans": "配置核查",
    "zh-Hant": "設定核查",
    "en": "Profile review",
    "ja": "設定の確認"
  },
  "generation.inputs.reviewDateUnavailable": {
    "zh-Hans": "未提供核查日期",
    "zh-Hant": "未提供核查日期",
    "en": "No review date provided",
    "ja": "確認日が提供されていません"
  },
  "generation.inputs.serverEvaluation": {
    "zh-Hans": "服务端评估",
    "zh-Hant": "伺服器評估",
    "en": "Server evaluation",
    "ja": "サーバー側の評価"
  },
  "generation.inputs.notProvided": {
    "zh-Hans": "尚未提供",
    "zh-Hant": "尚未提供",
    "en": "Not yet provided",
    "ja": "未提供"
  },
  "generation.inputs.apiRegion": {
    "zh-Hans": "API 区域",
    "zh-Hant": "API 區域",
    "en": "API region",
    "ja": "API の地域"
  },
  "generation.inputs.lifecycleDates": {
    "zh-Hans": "生命周期核查：{checkedOn}；最早关闭日期：{earliestShutdownDate}。到期需重新核验该精确模型，不会自动替换模型",
    "zh-Hant": "生命週期核查：{checkedOn}；最早關閉日期：{earliestShutdownDate}。到期須重新核驗該精確模型，不會自動替換模型",
    "en": "Lifecycle reviewed: {checkedOn}; earliest shutdown: {earliestShutdownDate}. This exact model must be revalidated when due; it will not be replaced automatically",
    "ja": "ライフサイクル確認日：{checkedOn}。最も早い終了日：{earliestShutdownDate}。期限にはこの正確なモデルの再検証が必要です。自動で別のモデルに変更することはありません"
  },
  "generation.inputs.providerLifecycleLink": {
    "zh-Hans": "查看服务商生命周期说明",
    "zh-Hant": "查看服務商的生命週期說明",
    "en": "View provider lifecycle information",
    "ja": "プロバイダーのライフサイクル情報を見る"
  },
  "generation.inputs.lifecycleBlocked": {
    "zh-Hans": "服务端评估（{evaluatedAsOf}）：此 Veo 模型已到生命周期复核日期，已阻止新提交",
    "zh-Hant": "伺服器評估（{evaluatedAsOf}）：此 Veo 模型已到生命週期複核日期，已阻止新的提交",
    "en": "Server evaluation ({evaluatedAsOf}): this Veo model has reached its lifecycle review date; new submissions are blocked",
    "ja": "サーバー評価（{evaluatedAsOf}）：この Veo モデルはライフサイクルの再確認日を迎えたため、新規送信を停止しています"
  },
  "generation.inputs.noModelSelected": {
    "zh-Hans": "尚未选择模型",
    "zh-Hant": "尚未選擇模型",
    "en": "No model selected",
    "ja": "モデル未選択"
  },
  "generation.inputs.routeSummary": {
    "zh-Hans": "API：{value} · 区域：{value2}",
    "zh-Hant": "API：{value} · 區域：{value2}",
    "en": "API: {value} · Region: {value2}",
    "ja": "API：{value} · 地域：{value2}"
  },
  "generation.inputs.unconfirmed": {
    "zh-Hans": "尚未确认",
    "zh-Hant": "尚未確認",
    "en": "Unconfirmed",
    "ja": "未確認"
  },
  "generation.inputs.referenceBrief": {
    "zh-Hans": "Mioon 首帧 {value} · 尾帧 {value2} · 其他角色见限制",
    "zh-Hant": "Mioon 首影格 {value} · 尾影格 {value2} · 其他角色請見限制",
    "en": "Mioon first frame {value} · Last frame {value2} · See limits for other roles",
    "ja": "Mioon 開始フレーム {value} · 終了フレーム {value2} · その他の参照用途は制限を確認してください"
  },
  "generation.inputs.notImplemented": {
    "zh-Hans": "未接入",
    "zh-Hant": "尚未接入",
    "en": "Not implemented",
    "ja": "未対応"
  },
  "generation.inputs.noAutomaticReplacement": {
    "zh-Hans": "{lifecycleMessage} 不会自动替换模型",
    "zh-Hant": "{lifecycleMessage} 不會自動替換模型",
    "en": "{lifecycleMessage} The model will not be replaced automatically",
    "ja": "{lifecycleMessage} 自動で別のモデルに変更することはありません"
  },
  "generation.inputs.lifecycleWarning": {
    "zh-Hans": "Veo 生命周期提示：最早 {earliestShutdownDate} 关闭；核查于 {checkedOn}，到期需重新核验",
    "zh-Hant": "Veo 生命週期提示：最早於 {earliestShutdownDate} 關閉；核查日期 {checkedOn}，到期須重新核驗",
    "en": "Veo lifecycle notice: may shut down as early as {earliestShutdownDate}; reviewed {checkedOn}. Revalidation is required when due",
    "ja": "Veo ライフサイクルのお知らせ：最も早い終了日は{earliestShutdownDate}です。確認日は{checkedOn}で、期限には再検証が必要です"
  },
  "generation.inputs.viewLimits": {
    "zh-Hans": "查看输入限制",
    "zh-Hant": "查看輸入限制",
    "en": "View input limits",
    "ja": "入力の制限を見る"
  },
  "generation.inputs.limitsAria": {
    "zh-Hans": "Mioon 模型输入限制",
    "zh-Hant": "Mioon 模型輸入限制",
    "en": "Mioon model input limits",
    "ja": "Mioon モデル入力の制限"
  },
  "image.studio.sourceLabel": {
    "zh-Hans": "来源：{value}",
    "zh-Hant": "來源：{value}",
    "en": "Source: {value}",
    "ja": "ソース：{value}"
  },
  "image.studio.importedAsset": {
    "zh-Hans": "导入素材",
    "zh-Hant": "匯入素材",
    "en": "Imported asset",
    "ja": "取り込んだ素材"
  },
  "image.studio.generatedImage": {
    "zh-Hans": "生成图像",
    "zh-Hant": "生成圖像",
    "en": "Generated image",
    "ja": "生成画像"
  },
  "image.studio.mockTestImage": {
    "zh-Hans": "Mock 测试图像",
    "zh-Hant": "Mock 測試圖像",
    "en": "Mock test image",
    "ja": "Mock テスト画像"
  },
  "image.studio.extractedFrame": {
    "zh-Hans": "视频提取帧",
    "zh-Hant": "從影片擷取的影格",
    "en": "Frame extracted from video",
    "ja": "動画から抽出したフレーム"
  },
  "image.studio.sceneKeyframe": {
    "zh-Hans": "分镜关键帧",
    "zh-Hant": "分鏡關鍵影格",
    "en": "Storyboard keyframe",
    "ja": "絵コンテのキーフレーム"
  },
  "image.studio.fixedSourceIdentity": {
    "zh-Hans": "固定源图身份",
    "zh-Hant": "固定來源圖像身分",
    "en": "Fixed source image identity",
    "ja": "固定した元画像の識別情報"
  },
  "image.studio.assetIdentity": {
    "zh-Hans": "素材 {value}",
    "zh-Hant": "素材 {value}",
    "en": "Asset {value}",
    "ja": "素材 {value}"
  },
  "image.studio.studioEyebrow": {
    "zh-Hans": "IMAGE · STUDIO",
    "zh-Hant": "圖像 · 工坊",
    "en": "IMAGE · STUDIO",
    "ja": "画像 · スタジオ"
  },
  "image.studio.workshopTitle": {
    "zh-Hans": "图像工坊",
    "zh-Hant": "圖像工坊",
    "en": "Image workshop",
    "ja": "画像ワークショップ"
  },
  "image.studio.currentProject": {
    "zh-Hans": "当前项目",
    "zh-Hant": "目前專案",
    "en": "Current project",
    "ja": "現在のプロジェクト"
  },
  "image.studio.mockTest": {
    "zh-Hans": "Mock 测试",
    "zh-Hant": "Mock 測試",
    "en": "Mock test",
    "ja": "Mock テスト"
  },
  "image.studio.localComfy": {
    "zh-Hans": "本地 ComfyUI",
    "zh-Hant": "本機 ComfyUI",
    "en": "Local ComfyUI",
    "ja": "ローカル ComfyUI"
  },
  "image.studio.customPaid": {
    "zh-Hans": "自定义 · 付费",
    "zh-Hant": "自訂 · 付費",
    "en": "Custom · paid",
    "ja": "カスタム · 有料"
  },
  "image.studio.openaiPaid": {
    "zh-Hans": "OpenAI · 付费",
    "zh-Hant": "OpenAI · 付費",
    "en": "OpenAI · paid",
    "ja": "OpenAI · 有料"
  },
  "image.studio.settings": {
    "zh-Hans": "设置",
    "zh-Hant": "設定",
    "en": "Settings",
    "ja": "設定"
  },
  "image.studio.selectProject": {
    "zh-Hans": "选择一个项目开始创建图像",
    "zh-Hant": "請選擇專案，開始建立圖像",
    "en": "Select a project to start creating images",
    "ja": "プロジェクトを選択して画像を作成してください"
  },
  "image.studio.groupNewVersion": {
    "zh-Hans": "此组的新版本 · 基准 r{expectedRevision}",
    "zh-Hant": "此組的新版本 · 基準 r{expectedRevision}",
    "en": "New version in this group · base r{expectedRevision}",
    "ja": "このグループの新しいバージョン · 基準 r{expectedRevision}"
  },
  "image.studio.newImageGroup": {
    "zh-Hans": "新图像组",
    "zh-Hant": "新圖像組",
    "en": "New image group",
    "ja": "新しい画像グループ"
  },
  "image.studio.discardDraftQuestion": {
    "zh-Hans": "当前有未提交的描述或源图选择。放弃草稿并切换生成目标？",
    "zh-Hant": "目前有尚未提交的描述或來源圖像選擇。要放棄草稿並切換生成目標嗎？",
    "en": "There is an unsubmitted prompt or source image selection. Discard the draft and switch the generation target?",
    "ja": "未送信のプロンプトまたは元画像の選択があります。下書きを破棄して生成先を切り替えますか？"
  },
  "image.studio.keepDraft": {
    "zh-Hans": "保留草稿",
    "zh-Hant": "保留草稿",
    "en": "Keep draft",
    "ja": "下書きを保持"
  },
  "image.studio.discardAndSwitch": {
    "zh-Hans": "放弃并切换",
    "zh-Hant": "放棄並切換",
    "en": "Discard and switch",
    "ja": "破棄して切り替え"
  },
  "image.studio.textToImage": {
    "zh-Hans": "文字生图",
    "zh-Hant": "文字生成圖像",
    "en": "Text to image",
    "ja": "テキストから画像"
  },
  "image.studio.editSource": {
    "zh-Hans": "编辑源图",
    "zh-Hant": "編輯來源圖像",
    "en": "Edit source image",
    "ja": "元画像を編集"
  },
  "image.studio.creationMode": {
    "zh-Hans": "图像制作方式",
    "zh-Hant": "圖像製作方式",
    "en": "Image creation mode",
    "ja": "画像の作成方法"
  },
  "image.studio.projectSourceImage": {
    "zh-Hans": "当前项目的源图",
    "zh-Hant": "目前專案的來源圖像",
    "en": "Source image from this project",
    "ja": "現在のプロジェクトの元画像"
  },
  "image.studio.selectSource": {
    "zh-Hans": "选择一张源图…",
    "zh-Hant": "選擇一張來源圖片…",
    "en": "Select a source image…",
    "ja": "ソース画像を 1 枚選択…"
  },
  "image.studio.originalIdentityKept": {
    "zh-Hans": "{value}（保留原始身份）",
    "zh-Hant": "{value}（保留原始身分）",
    "en": "{value} (original identity preserved)",
    "ja": "{value}（元の識別情報を保持）"
  },
  "image.studio.fixedSourceImage": {
    "zh-Hans": "已固定的源图",
    "zh-Hant": "已固定的來源圖像",
    "en": "Fixed source image",
    "ja": "固定した元画像"
  },
  "image.studio.selectedSourceImage": {
    "zh-Hans": "已选择源图",
    "zh-Hant": "已選取來源圖像",
    "en": "Selected source image",
    "ja": "選択した元画像"
  },
  "image.studio.selectionScope": {
    "zh-Hans": "选择只保留本地素材身份，不会上传或生成。最终以后端核验为准",
    "zh-Hant": "選擇僅保留本機素材身分，不會上傳或生成。最終以後端核驗為準",
    "en": "Selection only retains the local asset identity. It does not upload or generate anything. Final verification is performed by the backend",
    "ja": "選択ではローカル素材の識別情報のみ保持し、アップロードや生成は行いません。最終的にはバックエンドの検証結果に従います"
  },
  "image.studio.editingSupport": {
    "zh-Hans": "支持范围与编辑效果",
    "zh-Hant": "支援範圍與編輯效果",
    "en": "Supported inputs and editing effects",
    "ja": "対応範囲と編集の効果"
  },
  "image.studio.editingLimits": {
    "zh-Hans": "支持当前项目的单张受管理 PNG、JPEG 或 WebP，小于 50 MB，每边最多 4096 像素；PNG 须不透明、8 位、非交错，WebP 不能带透明或动画。输出跟随源图比例，尺寸按模型能力决定。不支持蒙版或裁剪，也不支持自定义及 ComfyUI 编辑",
    "zh-Hant": "支援目前專案的單張受管理 PNG、JPEG 或 WebP，小於 50 MB，每邊最多 4096 像素；PNG 須不透明、8 位元、非交錯，WebP 不能帶透明或動畫。輸出跟隨來源圖片比例，尺寸依模型能力決定。不支援遮罩或裁切，也不支援自訂及 ComfyUI 編輯",
    "en": "One managed PNG, JPEG or WebP from this project, smaller than 50 MB and at most 4096 pixels per edge; a PNG must be opaque, 8-bit and non-interlaced, and a WebP must have no transparency or animation. The output follows the source's aspect ratio at a size the model supports. Masks, crops, custom and ComfyUI editing are not supported",
    "ja": "現在のプロジェクトの管理対象 PNG、JPEG、WebP 1枚（50 MB未満、各辺4096ピクセル以下）に対応します。PNG は不透明・8ビット・非インターレース、WebP は透過やアニメーションなしである必要があります。出力はソースの縦横比に合わせ、モデルが対応するサイズになります。マスク、切り抜き、カスタムおよび ComfyUI での編集には対応しません"
  },
  "image.studio.editingEffects": {
    "zh-Hans": "AI 会重新绘制图像，其他部位也可能改变；不保证人物身份或像素精确保持。源图不会被覆盖，结果保存为新素材和版本",
    "zh-Hant": "AI 會重新繪製圖像，其他部位也可能改變；不保證人物身分或像素精確保持。來源圖像不會被覆寫，結果會儲存為新素材與版本",
    "en": "AI redraws the image, so other areas may also change. Exact identity or pixel preservation is not guaranteed. The source image is not overwritten; results are saved as new assets and versions",
    "ja": "AI が画像を描き直すため、他の部分も変わる可能性があります。人物の同一性やピクセル単位の正確な保持は保証しません。元画像は上書きせず、結果を新しい素材とバージョンとして保存します"
  },
  "image.studio.imageName": {
    "zh-Hans": "图像名称",
    "zh-Hant": "圖像名稱",
    "en": "Image name",
    "ja": "画像名"
  },
  "image.studio.namePlaceholder": {
    "zh-Hans": "例如：清晨的山间小屋",
    "zh-Hant": "例如：清晨的山間小屋",
    "en": "For example: Mountain cabin at dawn",
    "ja": "例：夜明けの山小屋"
  },
  "image.studio.editInstructions": {
    "zh-Hans": "编辑要求",
    "zh-Hant": "編輯要求",
    "en": "Edit instructions",
    "ja": "編集指示"
  },
  "image.studio.imagePrompt": {
    "zh-Hans": "图像描述",
    "zh-Hant": "圖像描述",
    "en": "Image prompt",
    "ja": "画像プロンプト"
  },
  "image.studio.editPlaceholder": {
    "zh-Hans": "例如：把背景改成黄昏，保留主体构图…",
    "zh-Hant": "例如：將背景改為黃昏，保留主體構圖…",
    "en": "For example: Change the background to dusk, keeping the subject composition…",
    "ja": "例：被写体の構図を保ち、背景を夕暮れに変更…"
  },
  "image.studio.promptPlaceholder": {
    "zh-Hans": "描述主体、构图、光线与风格…",
    "zh-Hant": "描述主體、構圖、光線與風格…",
    "en": "Describe the subject, composition, lighting, and style…",
    "ja": "被写体、構図、光、スタイルを説明…"
  },
  "image.studio.editInputScope": {
    "zh-Hans": "使用所选源图和这里的编辑要求",
    "zh-Hant": "使用所選來源圖像與此處的編輯要求",
    "en": "Uses the selected source image and these edit instructions",
    "ja": "選択した元画像と、ここに入力した編集指示を使用"
  },
  "image.studio.promptInputScope": {
    "zh-Hans": "仅使用这里输入的描述",
    "zh-Hant": "僅使用此處輸入的描述",
    "en": "Uses only the prompt entered here",
    "ja": "ここに入力したプロンプトのみ使用"
  },
  "image.studio.mockLocal": {
    "zh-Hans": "Mock · 本地测试",
    "zh-Hant": "Mock · 本機測試",
    "en": "Mock · local test",
    "ja": "Mock · ローカルテスト"
  },
  "image.studio.imageProvider": {
    "zh-Hans": "图像提供方",
    "zh-Hant": "圖像提供方",
    "en": "Image provider",
    "ja": "画像プロバイダー"
  },
  "image.studio.mockEditScope": {
    "zh-Hans": "Mock 编辑只生成静态测试卡片，不会实际编辑源图，也不会连接外部服务",
    "zh-Hant": "Mock 編輯僅生成靜態測試卡片，不會實際編輯來源圖像，也不會連接外部服務",
    "en": "Mock editing only generates a static test card. It does not actually edit the source image or connect to external services",
    "ja": "Mock 編集では静止テストカードのみ生成します。元画像を実際に編集したり、外部サービスに接続したりすることはありません"
  },
  "image.studio.mockGenerationScope": {
    "zh-Hans": "确定性测试图案，不会按描述绘制 AI 图像，也不会连接外部服务",
    "zh-Hant": "固定的測試圖案，不會依描述繪製 AI 圖像，也不會連接外部服務",
    "en": "A deterministic test pattern, not an AI image drawn from the prompt. It does not connect to external services",
    "ja": "決定的なテストパターンです。プロンプトに沿った AI 画像は描かず、外部サービスにも接続しません"
  },
  "image.studio.comfyConfiguration": {
    "zh-Hans": "本地 ComfyUI · {value}",
    "zh-Hant": "本機 ComfyUI · {value}",
    "en": "Local ComfyUI · {value}",
    "ja": "ローカル ComfyUI · {value}"
  },
  "image.studio.configurationChecked": {
    "zh-Hans": "已检查配置",
    "zh-Hant": "已檢查設定",
    "en": "Configuration checked",
    "ja": "設定確認済み"
  },
  "image.studio.configurationCheckNeeded": {
    "zh-Hans": "需要配置或检查",
    "zh-Hant": "需要設定或檢查",
    "en": "Configuration or check needed",
    "ja": "設定または確認が必要"
  },
  "image.studio.savedGenerationState": {
    "zh-Hans": "已保存配置 · 新生成：{value}{value2}",
    "zh-Hant": "已儲存設定 · 新生成：{value}{value2}",
    "en": "Saved configuration · new generation: {value}{value2}",
    "ja": "保存済み設定 · 新規生成：{value}{value2}"
  },
  "image.studio.generationAllowed": {
    "zh-Hans": "允许",
    "zh-Hant": "允許",
    "en": "Allowed",
    "ja": "許可"
  },
  "image.studio.generationDisabled": {
    "zh-Hans": "关闭",
    "zh-Hant": "關閉",
    "en": "Disabled",
    "ja": "無効"
  },
  "image.studio.settingsNotRead": {
    "zh-Hans": " · 尚未读取",
    "zh-Hant": " · 尚未讀取",
    "en": " · not yet read",
    "ja": " · 未読み込み"
  },
  "image.studio.checkpointNotSelected": {
    "zh-Hans": "尚未选择 checkpoint",
    "zh-Hant": "尚未選擇 checkpoint",
    "en": "No checkpoint selected",
    "ja": "checkpoint 未選択"
  },
  "image.studio.comfyConfigureEndpoint": {
    "zh-Hans": "在本地 ComfyUI 设置中填写地址并明确检查连接",
    "zh-Hant": "請在本機 ComfyUI 設定中填寫位址，並明確檢查連線",
    "en": "Enter an endpoint in local ComfyUI settings and explicitly check the connection",
    "ja": "ローカル ComfyUI 設定で接続先を入力し、明示的に接続を確認してください"
  },
  "image.studio.comfyExecutionScope": {
    "zh-Hans": "{value}固定支持 v0.39.0。使用已安装并运行的服务，不会安装、启动或下载。准备后先查看后端生成的种子和完整冻结工作流，再单独批准。仅发送上方原始描述，不会改写",
    "zh-Hant": "{value}固定支援 v0.39.0。使用已安裝並執行的服務，不會安裝、啟動或下載。準備完成後，請先查看後端生成的種子與完整固定工作流程，再單獨批准。僅傳送上方原始描述，不會改寫",
    "en": "{value}Supports v0.39.0 only. Uses an already installed, running service; it does not install, start, or download anything. After preparation, review the backend-generated seed and complete frozen workflow before approving separately. Only the original prompt above is sent, without rewriting",
    "ja": "{value}対応バージョンは v0.39.0 に固定されています。インストールして起動済みのサービスを使用し、インストール、起動、ダウンロードは行いません。準備後にバックエンドで生成したシードと固定されたワークフロー全体を確認し、別途承認してください。上記の元のプロンプトのみを、書き換えずに送信します"
  },
  "image.studio.comfyCheckRequired": {
    "zh-Hans": "当前后端尚未核验此配置，请在设置中明确检查连接",
    "zh-Hant": "目前後端尚未核驗此設定，請在設定中明確檢查連線",
    "en": "The current backend has not verified this configuration. Explicitly check the connection in settings",
    "ja": "現在のバックエンドではこの設定を検証していません。設定で明示的に接続を確認してください"
  },
  "image.studio.customCompatible": {
    "zh-Hans": "自定义兼容",
    "zh-Hant": "自訂相容",
    "en": "Custom compatible",
    "ja": "カスタム互換"
  },
  "image.studio.configured": {
    "zh-Hans": "已配置",
    "zh-Hant": "已設定",
    "en": "Configured",
    "ja": "設定済み"
  },
  "image.studio.configurationNeeded": {
    "zh-Hans": "需要配置",
    "zh-Hant": "需要設定",
    "en": "Configuration needed",
    "ja": "設定が必要"
  },
  "image.studio.modelNotConfigured": {
    "zh-Hans": "尚未配置模型",
    "zh-Hant": "尚未設定模型",
    "en": "No model configured",
    "ja": "モデル未設定"
  },
  "image.studio.configureDestination": {
    "zh-Hans": "请在设置中填写发送目标",
    "zh-Hant": "請在設定中填寫傳送目標",
    "en": "Enter the destination in settings",
    "ja": "設定で送信先を入力してください"
  },
  "image.studio.liveRequestUnverified": {
    "zh-Hans": "真实调用尚未验证。{value}{value2}",
    "zh-Hant": "實際呼叫尚未驗證。{value}{value2}",
    "en": "Live requests are unverified. {value}{value2}",
    "ja": "実際のリクエストは未検証です。{value}{value2}"
  },
  "image.studio.currentConfiguration": {
    "zh-Hans": "当前配置 r{revision}。{value}",
    "zh-Hant": "目前設定 r{revision}。{value}",
    "en": "Current configuration r{revision}. {value}",
    "ja": "現在の設定 r{revision}。{value}"
  },
  "image.studio.editPreparationScope": {
    "zh-Hans": "准备时在本地核验源图，单独批准后才发送完整源图与原始编辑要求",
    "zh-Hant": "準備時會在本機核驗來源圖像，單獨批准後才會傳送完整來源圖像與原始編輯要求",
    "en": "Preparation verifies the source image locally. The complete source image and original edit instructions are sent only after separate approval",
    "ja": "準備時にローカルで元画像を検証します。完全な元画像と元の編集指示を送信するのは、別途承認した後だけです"
  },
  "image.studio.originalPromptOnly": {
    "zh-Hans": "只发送上方原始描述，不会改写或优化",
    "zh-Hant": "僅傳送上方原始描述，不會改寫或最佳化",
    "en": "Only the original prompt above is sent. It is not rewritten or optimized",
    "ja": "上記の元のプロンプトのみ送信します。書き換えや最適化は行いません"
  },
  "image.studio.configureDedicatedKey": {
    "zh-Hans": "请在图像设置中启用并配置此连接的专用密钥",
    "zh-Hant": "請在圖像設定中啟用此連線，並設定其專用密鑰",
    "en": "Enable this connection and configure its dedicated key in image settings",
    "ja": "画像設定でこの接続を有効にし、専用のキーを設定してください"
  },
  "image.studio.customCompatibilityScope": {
    "zh-Hans": " 仅兼容固定 JSON 请求与 base64 单张 PNG 响应，不支持所有兼容服务；不探测、不回退、不下载结果 URL",
    "zh-Hant": " 僅相容固定 JSON 請求與 base64 單張 PNG 回應，並非所有相容服務皆受支援；不會探測、回退或下載結果 URL",
    "en": " Only fixed JSON requests and a single base64 PNG response are supported, not all compatible services. There is no probing, fallback, or result-URL download",
    "ja": " 固定 JSON リクエストと base64 の単一 PNG レスポンスのみ対応し、すべての互換サービスが使えるわけではありません。調査、フォールバック、結果 URL からのダウンロードは行いません"
  },
  "image.studio.comfyFixedOutput": {
    "zh-Hans": "512 × 512 · PNG · 1 张 · 20 steps · CFG 8 · euler / normal",
    "zh-Hant": "512 × 512 · PNG · 1 張 · 20 steps · CFG 8 · euler / normal",
    "en": "512 × 512 · PNG · 1 image · 20 steps · CFG 8 · euler / normal",
    "ja": "512 × 512 · PNG · 1 枚 · 20 steps · CFG 8 · euler / normal"
  },
  "image.studio.fixedOutput": {
    "zh-Hans": "1024 × 1024 · PNG · 不透明 · low · 1 张",
    "zh-Hant": "1024 × 1024 · PNG · 不透明 · low · 1 張",
    "en": "1024 × 1024 · PNG · opaque · low · 1 image",
    "ja": "1024 × 1024 · PNG · 不透明 · low · 1 枚"
  },
  "image.studio.localStorageDisclosure": {
    "zh-Hans": "描述、审批与已接受任务保存在本地数据库中，未加密；未确认请求的本页凭据暂存在页面会话中。重启后仍可读取已保存的审批与任务，不会自动发送。请勿在描述中输入密钥或其他秘密",
    "zh-Hant": "描述、批准記錄與已接受工作會以未加密方式儲存在本機資料庫中；未確認請求的本頁憑據暫存於頁面工作階段。重新啟動後仍可讀取已儲存的批准記錄與工作，不會自動傳送。請勿在描述中輸入密鑰或其他秘密",
    "en": "Prompts, approvals, and accepted tasks are stored unencrypted in the local database. This page’s records for unconfirmed requests remain temporarily in the page session. Saved approvals and tasks can still be read after restart and will not be sent automatically. Do not enter keys or other secrets in prompts",
    "ja": "プロンプト、承認記録、受け付けられたタスクは、ローカルデータベースに暗号化せず保存されます。未確認リクエストに関するこのページの記録は、ページセッション中に一時保持されます。再起動後も保存済みの承認記録とタスクを読み取れますが、自動送信はしません。プロンプトにキーやその他の秘密情報を入力しないでください"
  },
  "image.studio.groupTargetStale": {
    "zh-Hans": "此组仍有待处理任务，或基准版本已变化。请读取最新记录，再明确选择生成目标",
    "zh-Hant": "此組仍有待處理工作，或基準版本已變更。請讀取最新記錄，再明確選擇生成目標",
    "en": "This group still has pending tasks, or its base revision changed. Read the latest records, then explicitly select the generation target",
    "ja": "このグループには未処理のタスクがあるか、基準リビジョンが変更されています。最新の記録を読み込み、生成先を明示的に選択してください"
  },
  "image.studio.directPaidApproval": {
    "zh-Hans": "点击即批准向{value}发送当前项目的这份原始描述与上列模型、固定选项和配置版本，最多 1 次生成 POST。费用按用量计，无法预先确定金额；不会自动重试",
    "zh-Hant": "點選即批准向{value}傳送目前專案的這份原始描述，以及上列模型、固定選項與設定版本，最多發出 1 次生成 POST。費用按用量計算，無法預先確定金額；不會自動重試",
    "en": "Clicking approves sending this project’s original prompt, the model above, fixed options, and configuration revision to {value}, with at most one generation POST. Billing is usage-based and the amount cannot be determined in advance. It will not be retried automatically",
    "ja": "クリックすると、現在のプロジェクトの元のプロンプトと、上記のモデル、固定オプション、設定リビジョンを {value} に送信することを承認します。生成 POST は最大 1 回です。従量課金で、金額を事前に確定することはできません。自動で再試行することはありません"
  },
  "image.studio.completeCustomEndpoint": {
    "zh-Hans": "上方完整自定义地址",
    "zh-Hant": "上方完整自訂位址",
    "en": "the full custom endpoint above",
    "ja": "上記の完全なカスタム接続先"
  },
  "image.studio.editApprovalDisclosure": {
    "zh-Hans": "先在本地准备审批。批准时会向 OpenAI 官方发送所选源图的完整文件字节（包括文件内元数据）和原始编辑要求。按用量计费，金额未知；最多发送 1 次，不会自动重试",
    "zh-Hant": "先在本機準備批准請求。批准時會向 OpenAI 官方傳送所選來源圖像的完整檔案位元組（包含檔案內的中繼資料）與原始編輯要求。按用量計費，金額未知；最多傳送 1 次，不會自動重試",
    "en": "First prepare approval locally. Approval sends the selected source image's complete file bytes, including file metadata, and the original edit instructions to official OpenAI. Billing is usage-based and the amount is unknown. It sends at most once, with no automatic retry",
    "ja": "まずローカルで承認用のリクエストを準備します。承認すると、選択した元画像の完全なファイルのバイト列（ファイル内のメタデータを含む）と元の編集指示を OpenAI 公式サービスに送信します。従量課金で金額は不明です。送信は最大 1 回で、自動再試行は行いません"
  },
  "image.studio.confirmingRequest": {
    "zh-Hans": "正在确认请求…",
    "zh-Hant": "正在確認請求…",
    "en": "Confirming request…",
    "ja": "リクエストを確認中…"
  },
  "image.studio.prepareLocalRequest": {
    "zh-Hans": "准备本地运行请求",
    "zh-Hant": "準備本機執行請求",
    "en": "Prepare local execution request",
    "ja": "ローカル実行リクエストを準備"
  },
  "image.studio.prepareEditApproval": {
    "zh-Hans": "核验源图并准备编辑审批",
    "zh-Hant": "核驗來源圖像並準備編輯批准請求",
    "en": "Verify source and prepare edit approval",
    "ja": "元画像を検証して編集の承認を準備"
  },
  "image.studio.paidGenerateOne": {
    "zh-Hans": "付费生成 · 1 张",
    "zh-Hant": "付費生成 · 1 張",
    "en": "Paid generation · 1 image",
    "ja": "有料生成 · 1 枚"
  },
  "image.studio.generateMockEdit": {
    "zh-Hans": "生成 Mock 编辑测试卡片",
    "zh-Hant": "生成 Mock 編輯測試卡片",
    "en": "Generate Mock edit test card",
    "ja": "Mock 編集テストカードを生成"
  },
  "image.studio.generateMockImage": {
    "zh-Hans": "生成 Mock 图像",
    "zh-Hant": "生成 Mock 圖像",
    "en": "Generate Mock image",
    "ja": "Mock 画像を生成"
  },
  "image.studio.editAwaitingApproval": {
    "zh-Hans": "编辑请求等待批准",
    "zh-Hant": "編輯請求等待批准",
    "en": "Edit request awaiting approval",
    "ja": "編集リクエストの承認待ち"
  },
  "image.studio.originalRequestUnconfirmed": {
    "zh-Hans": "原请求待确认",
    "zh-Hant": "原請求待確認",
    "en": "Original request awaiting confirmation",
    "ja": "元のリクエストの確認待ち"
  },
  "image.studio.sourceNotSent": {
    "zh-Hans": "尚未发送源图。请核对下方固定请求后，明确批准或拒绝",
    "zh-Hant": "尚未傳送來源圖像。請核對下方固定請求後，明確批准或拒絕",
    "en": "The source image has not been sent. Review the fixed request below, then explicitly approve or reject it",
    "ja": "元画像はまだ送信していません。以下の固定リクエストを確認し、明示的に承認または拒否してください"
  },
  "image.studio.reconcileOnly": {
    "zh-Hans": "只核对已保存的请求，不会自动重新生成。切换页签或重开面板也不会重发",
    "zh-Hant": "僅核對已儲存的請求，不會自動重新生成。切換分頁或重新開啟面板也不會重新傳送",
    "en": "Only saved requests are checked; generation is not repeated automatically. Switching tabs or reopening the panel will not resend them",
    "ja": "保存済みリクエストを確認するだけで、自動で再生成することはありません。タブを切り替えたりパネルを開き直したりしても再送しません"
  },
  "image.studio.abandonUnapproved": {
    "zh-Hans": "放弃此未批准请求",
    "zh-Hant": "放棄此尚未批准的請求",
    "en": "Abandon this unapproved request",
    "ja": "この未承認リクエストを破棄"
  },
  "image.studio.remoteQueryUnconfirmed": {
    "zh-Hans": "原远端查询待确认。不会自动重试查询或生成；可重新读取本地记录，或明确核对同一查询标识",
    "zh-Hant": "原遠端查詢待確認。不會自動重試查詢或生成；可重新讀取本機記錄，或明確核對同一查詢識別碼",
    "en": "The original remote query is unconfirmed. Neither querying nor generation will be retried automatically. Read local records again or explicitly reconcile the same query ID",
    "ja": "元のリモート照会は未確認です。照会や生成を自動で再試行することはありません。ローカル記録を再読み込みするか、同じ照会 ID を明示的に確認してください"
  },
  "image.studio.reconcileQuery": {
    "zh-Hans": "核对原查询（同一标识）",
    "zh-Hant": "核對原查詢（同一識別碼）",
    "en": "Reconcile original query (same ID)",
    "ja": "元の照会を確認（同じ ID）"
  },
  "image.studio.pollingPaused": {
    "zh-Hans": "已暂停定时读取。任务保留，可手动读取最新状态",
    "zh-Hant": "已暫停定時讀取。工作仍保留，可手動讀取最新狀態",
    "en": "Scheduled reads are paused. Tasks remain, and you can read their latest state manually",
    "ja": "定期読み込みを一時停止しました。タスクは保持されており、最新の状態を手動で読み込めます"
  },
  "image.studio.generationApprovals": {
    "zh-Hans": "生成请求审批",
    "zh-Hant": "生成請求批准",
    "en": "Generation request approvals",
    "ja": "生成リクエストの承認"
  },
  "image.studio.externalToolsPrepareOnly": {
    "zh-Hans": "外部工具只能准备，不能批准",
    "zh-Hant": "外部工具只能準備，不能批准",
    "en": "External tools can prepare, not approve",
    "ja": "外部ツールは準備のみ可能で、承認はできません"
  },
  "image.studio.awaitingApproval": {
    "zh-Hans": "等待批准",
    "zh-Hant": "等待批准",
    "en": "Awaiting approval",
    "ja": "承認待ち"
  },
  "image.studio.approved": {
    "zh-Hans": "已批准",
    "zh-Hant": "已批准",
    "en": "Approved",
    "ja": "承認済み"
  },
  "image.studio.rejected": {
    "zh-Hans": "已拒绝",
    "zh-Hant": "已拒絕",
    "en": "Rejected",
    "ja": "拒否済み"
  },
  "image.studio.possiblySent": {
    "zh-Hans": "可能已发送 · 查看任务结果",
    "zh-Hant": "可能已傳送 · 查看工作結果",
    "en": "Possibly sent · view task result",
    "ja": "送信済みの可能性 · タスク結果を確認"
  },
  "image.studio.projectLabel": {
    "zh-Hans": "项目：{value}",
    "zh-Hant": "專案：{value}",
    "en": "Project: {value}",
    "ja": "プロジェクト：{value}"
  },
  "image.studio.projectIdentity": {
    "zh-Hans": "项目 {projectId}",
    "zh-Hant": "專案 {projectId}",
    "en": "Project {projectId}",
    "ja": "プロジェクト {projectId}"
  },
  "image.studio.approvalSource": {
    "zh-Hans": "此次审批的固定源图",
    "zh-Hant": "此次批准的固定來源圖像",
    "en": "Fixed source image for this approval",
    "ja": "今回の承認で固定した元画像"
  },
  "image.studio.approvalFixedOutput": {
    "zh-Hans": "1024 × 1024 · low · PNG · 不透明 · 1 张",
    "zh-Hant": "1024 × 1024 · low · PNG · 不透明 · 1 張",
    "en": "1024 × 1024 · low · PNG · opaque · 1 image",
    "ja": "1024 × 1024 · low · PNG · 不透明 · 1 枚"
  },
  "image.studio.editOutput": {
    "zh-Hans": "{width} × {height} · PNG · 不透明 · low · 1 张 · 跟随源图比例",
    "zh-Hant": "{width} × {height} · PNG · 不透明 · low · 1 張 · 跟隨來源圖片比例",
    "en": "{width} × {height} · PNG · opaque · low · 1 image · follows the source's aspect ratio",
    "ja": "{width} × {height} · PNG · 不透明 · low · 1 枚 · ソースの縦横比に合わせる"
  },
  "image.studio.editOutputPending": {
    "zh-Hans": "选好源图后，按模型能力决定输出尺寸",
    "zh-Hant": "選好來源圖片後，依模型能力決定輸出尺寸",
    "en": "The output size follows the model once a source image is chosen",
    "ja": "ソース画像を選ぶと、モデルの能力に合わせて出力サイズが決まります"
  },
  "image.studio.approvalEditOutput": {
    "zh-Hans": "{width} × {height} · low · PNG · 不透明 · 1 张",
    "zh-Hant": "{width} × {height} · low · PNG · 不透明 · 1 張",
    "en": "{width} × {height} · low · PNG · opaque · 1 image",
    "ja": "{width} × {height} · low · PNG · 不透明 · 1 枚"
  },
  "image.studio.approvalConfiguration": {
    "zh-Hans": "配置 r{settingsRevision} · {value}",
    "zh-Hant": "設定 r{settingsRevision} · {value}",
    "en": "Configuration r{settingsRevision} · {value}",
    "ja": "設定 r{settingsRevision} · {value}"
  },
  "image.studio.groupBaseRevision": {
    "zh-Hans": "图像组 {groupId} · 基准 r{expectedRevision}",
    "zh-Hant": "圖像組 {groupId} · 基準 r{expectedRevision}",
    "en": "Image group {groupId} · base r{expectedRevision}",
    "ja": "画像グループ {groupId} · 基準 r{expectedRevision}"
  },
  "image.studio.editSendDisclosure": {
    "zh-Hans": "向 OpenAI 发送此固定源图和原始编辑要求。按用量收费，金额未知；批准后最多发送 1 次，不会自动重试",
    "zh-Hant": "向 OpenAI 傳送此固定來源圖像與原始編輯要求。按用量計費，金額未知；批准後最多傳送 1 次，不會自動重試",
    "en": "Send this fixed source image and the original edit instructions to OpenAI. Billing is usage-based and the amount is unknown. At most one send follows approval, with no automatic retry",
    "ja": "この固定した元画像と元の編集指示を OpenAI に送信します。従量課金で金額は不明です。承認後の送信は最大 1 回で、自動再試行は行いません"
  },
  "image.studio.completePayloadAndLimits": {
    "zh-Hans": "完整发送内容与编辑限制",
    "zh-Hant": "完整傳送內容與編輯限制",
    "en": "Complete payload and editing limits",
    "ja": "送信内容の全体と編集の制限"
  },
  "image.studio.editPayloadDisclosure": {
    "zh-Hans": "发送到 {destination}：完整源图字节，包括文件内元数据、原始编辑要求、上列模型和输出选项。素材名称、来源和哈希用于本地审批核验；不会把它们当作额外指令",
    "zh-Hant": "傳送至 {destination}：完整來源圖像位元組，包含檔案內的中繼資料、原始編輯要求、上列模型與輸出選項。素材名稱、來源與雜湊值用於本機批准核驗；不會將其視為額外指令",
    "en": "Sent to {destination}: the complete source image bytes including file metadata, the original edit instructions, the model above, and the output options. Asset names, provenance, and hashes are used for local approval verification, not as additional instructions",
    "ja": "{destination} に送信する内容：ファイル内のメタデータを含む完全な元画像のバイト列、元の編集指示、上記のモデル、出力オプション。素材名、出所、ハッシュはローカルで承認を検証するために使用し、追加の指示としては扱いません"
  },
  "image.studio.editRiskDisclosure": {
    "zh-Hans": "AI 会重新绘制，未要求修改的部分也可能改变；不保证人物身份或像素精确保持。结果保存为新素材，不覆盖源图。断开连接后可能已产生费用；结果未知时只核对原请求，绝不自动重发",
    "zh-Hant": "AI 會重新繪製，未要求修改的部分也可能改變；不保證人物身分或像素精確保持。結果儲存為新素材，不覆寫來源圖像。連線中斷後可能已產生費用；結果未知時僅核對原請求，絕不自動重新傳送",
    "en": "AI redraws the image, and areas you did not ask to change may also change. Exact identity or pixel preservation is not guaranteed. Results are saved as new assets without overwriting the source. Charges may already have occurred after disconnection. If the outcome is unknown, only the original request is checked; it is never resent automatically",
    "ja": "AI が描き直すため、変更を指示していない部分も変わる可能性があります。人物の同一性やピクセル単位の正確な保持は保証しません。結果は新しい素材として保存し、元画像は上書きしません。接続が切れた後でも料金が発生している可能性があります。結果が不明な場合は元のリクエストのみ確認し、自動で再送することは決してありません"
  },
  "image.studio.generationChargeDisclosure": {
    "zh-Hans": "按用量收费，金额未知；批准后最多发送 1 次。保留原始描述，不会自动重试",
    "zh-Hant": "按用量計費，金額未知；批准後最多傳送 1 次。保留原始描述，不會自動重試",
    "en": "Usage-based billing; the amount is unknown. At most one send follows approval. The original prompt is preserved, and there is no automatic retry",
    "ja": "従量課金で、金額は不明です。承認後の送信は最大 1 回です。元のプロンプトを保持し、自動再試行は行いません"
  },
  "image.studio.originalRequestIdentity": {
    "zh-Hans": "原始请求标识",
    "zh-Hant": "原始請求識別碼",
    "en": "Original request identity",
    "ja": "元のリクエストの識別情報"
  },
  "image.studio.approvalInputMismatch": {
    "zh-Hans": "当前描述、提供方或源图与此审批不同。先明确载入此固定请求，再核对批准",
    "zh-Hant": "目前描述、提供方或來源圖像與此批准記錄不同。請先明確載入此固定請求，再核對並批准",
    "en": "The current prompt, provider, or source image differs from this approval. Explicitly load this fixed request first, then review and approve",
    "ja": "現在のプロンプト、プロバイダー、または元画像が、この承認内容と異なります。まずこの固定リクエストを明示的に読み込み、確認して承認してください"
  },
  "image.studio.loadEditRequest": {
    "zh-Hans": "载入此编辑请求",
    "zh-Hant": "載入此編輯請求",
    "en": "Load this edit request",
    "ja": "この編集リクエストを読み込む"
  },
  "image.studio.approvalCheckRequired": {
    "zh-Hans": "当前配置尚未检查。请到本地 ComfyUI 设置明确检查连接后，再核对本审批",
    "zh-Hant": "目前設定尚未檢查。請至本機 ComfyUI 設定明確檢查連線，再核對此批准請求",
    "en": "The current configuration has not been checked. Explicitly check the connection in local ComfyUI settings, then review this approval",
    "ja": "現在の設定は未確認です。ローカル ComfyUI 設定で明示的に接続を確認してから、この承認内容を確認してください"
  },
  "image.studio.approvalConfigurationChanged": {
    "zh-Hans": "配置已变化，此审批不能发送。请拒绝并根据新配置准备新的请求",
    "zh-Hant": "設定已變更，此批准請求無法傳送。請拒絕此請求，並依新設定準備新的請求",
    "en": "The configuration changed, so this approval cannot be sent. Reject it and prepare a new request using the new configuration",
    "ja": "設定が変更されたため、この承認リクエストは送信できません。拒否し、新しい設定で新たなリクエストを準備してください"
  },
  "image.studio.approveFrozenWorkflow": {
    "zh-Hans": "批准此冻结工作流并运行",
    "zh-Hant": "批准此固定工作流程並執行",
    "en": "Approve and run this frozen workflow",
    "ja": "この固定ワークフローを承認して実行"
  },
  "image.studio.approvePaidEdit": {
    "zh-Hans": "批准发送此源图并付费编辑",
    "zh-Hant": "批准傳送此來源圖像並付費編輯",
    "en": "Approve sending this source and paid editing",
    "ja": "この元画像の送信と有料編集を承認"
  },
  "image.studio.approvePaidGeneration": {
    "zh-Hans": "批准并付费生成",
    "zh-Hant": "批准並付費生成",
    "en": "Approve paid generation",
    "ja": "有料生成を承認"
  },
  "image.studio.reject": {
    "zh-Hans": "拒绝",
    "zh-Hant": "拒絕",
    "en": "Reject",
    "ja": "拒否"
  },
  "image.studio.newerRequests": {
    "zh-Hans": "较新请求",
    "zh-Hant": "較新的請求",
    "en": "Newer requests",
    "ja": "新しいリクエスト"
  },
  "image.studio.olderRequests": {
    "zh-Hans": "更早请求",
    "zh-Hant": "較早的請求",
    "en": "Older requests",
    "ja": "古いリクエスト"
  },
  "image.studio.imageRequestApprovals": {
    "zh-Hans": "图像请求审批",
    "zh-Hant": "圖像請求批准",
    "en": "Image request approvals",
    "ja": "画像リクエストの承認"
  },
  "image.studio.imageHistory": {
    "zh-Hans": "图像历史",
    "zh-Hant": "圖像歷史",
    "en": "Image history",
    "ja": "画像履歴"
  },
  "image.studio.reload": {
    "zh-Hans": "重新读取",
    "zh-Hant": "重新讀取",
    "en": "Read again",
    "ja": "再読み込み"
  },
  "image.studio.loadingHistory": {
    "zh-Hans": "正在读取当前图像历史…",
    "zh-Hant": "正在讀取目前圖像歷史…",
    "en": "Reading current image history…",
    "ja": "現在の画像履歴を読み込み中…"
  },
  "image.studio.historyReadFailed": {
    "zh-Hans": "暂时无法读取当前图像历史，请重新读取",
    "zh-Hant": "暫時無法讀取目前圖像歷史，請重新讀取",
    "en": "Current image history cannot be read right now. Read it again",
    "ja": "現在の画像履歴を読み取れません。再読み込みしてください"
  },
  "image.studio.viewGroup": {
    "zh-Hans": "查看图像组",
    "zh-Hant": "查看圖像組",
    "en": "View image group",
    "ja": "画像グループを表示"
  },
  "image.studio.reusePromptNewVersion": {
    "zh-Hans": "复用描述生成此组新版本",
    "zh-Hant": "重用描述以生成此組的新版本",
    "en": "Reuse prompt for a new version in this group",
    "ja": "プロンプトを再利用してこのグループの新バージョンを生成"
  },
  "image.studio.groupHasUnfinishedTask": {
    "zh-Hans": "此组有未结束任务",
    "zh-Hant": "此組有尚未結束的工作",
    "en": "This group has unfinished tasks",
    "ja": "このグループに未完了のタスクがあります"
  },
  "image.studio.readingLocalRecords": {
    "zh-Hans": "正在读取本地记录…",
    "zh-Hant": "正在讀取本機記錄…",
    "en": "Reading local records…",
    "ja": "ローカル記録を読み込み中…"
  },
  "image.studio.historyEmpty": {
    "zh-Hans": "生成后会在这里保留原始结果与版本",
    "zh-Hant": "生成後，原始結果與版本會保留在此處",
    "en": "Original results and versions will remain here after generation",
    "ja": "生成後は、元の結果とバージョンがここに保存されます"
  },
  "image.studio.newerGroups": {
    "zh-Hans": "较新图像组",
    "zh-Hant": "較新的圖像組",
    "en": "Newer image groups",
    "ja": "新しい画像グループ"
  },
  "image.studio.olderGroups": {
    "zh-Hans": "更早图像组",
    "zh-Hant": "較早的圖像組",
    "en": "Older image groups",
    "ja": "古い画像グループ"
  },
  "image.studio.mockEditCard": {
    "zh-Hans": "Mock 编辑静态测试卡片",
    "zh-Hant": "Mock 編輯靜態測試卡片",
    "en": "Mock editing static test card",
    "ja": "Mock 編集の静止テストカード"
  },
  "image.studio.mockPattern": {
    "zh-Hans": "Mock 测试图案",
    "zh-Hant": "Mock 測試圖案",
    "en": "Mock test pattern",
    "ja": "Mock テストパターン"
  },
  "image.studio.remoteOutcomeUnknown": {
    "zh-Hans": "远端结果仍未知。可明确查询同一远端任务并核验取回；也可单独恢复已经落盘的本地结果。不会重新提交生成",
    "zh-Hant": "遠端結果仍未知。可明確查詢同一遠端工作並核驗取回結果；也可單獨還原已寫入磁碟的本機結果。不會重新提交生成",
    "en": "The remote outcome is still unknown. Explicitly query the same remote task and verify retrieved results, or separately recover a local result already written to disk. Generation will not be resubmitted",
    "ja": "リモートの結果はまだ不明です。同じリモートタスクを明示的に照会して取得結果を検証するか、ディスクに保存済みのローカル結果を別途復元できます。生成を再送信することはありません"
  },
  "image.studio.originalPromptAndTask": {
    "zh-Hans": "原始描述与任务",
    "zh-Hant": "原始描述與工作",
    "en": "Original prompt and task",
    "ja": "元のプロンプトとタスク"
  },
  "image.studio.taskOriginalSource": {
    "zh-Hans": "任务原始源图",
    "zh-Hant": "工作的原始來源圖像",
    "en": "Task’s original source image",
    "ja": "タスクの元画像"
  },
  "image.studio.taskIdentity": {
    "zh-Hans": "任务 {id}",
    "zh-Hant": "工作 {id}",
    "en": "Task {id}",
    "ja": "タスク {id}"
  },
  "image.studio.requestIdentity": {
    "zh-Hans": "请求 {requestId}",
    "zh-Hant": "請求 {requestId}",
    "en": "Request {requestId}",
    "ja": "リクエスト {requestId}"
  },
  "image.studio.originalApprovalConfiguration": {
    "zh-Hans": "原审批配置 r{settingsRevision} · {profileId}",
    "zh-Hant": "原批准設定 r{settingsRevision} · {profileId}",
    "en": "Original approval configuration r{settingsRevision} · {profileId}",
    "ja": "元の承認設定 r{settingsRevision} · {profileId}"
  },
  "image.studio.originalApprovalMissing": {
    "zh-Hans": "此页未载入任务关联的原始审批，无法展示当时的地址。当前设置不代表此任务",
    "zh-Hant": "此頁尚未載入與工作關聯的原始批准記錄，無法顯示當時的位址。目前設定不代表此工作的設定",
    "en": "This page has not loaded the task’s original approval, so the endpoint used then cannot be displayed. Current settings do not represent this task",
    "ja": "このページではタスクに紐づく元の承認記録を読み込んでいないため、当時の接続先を表示できません。現在の設定はこのタスクの設定を示すものではありません"
  },
  "image.studio.cancelUnsentTask": {
    "zh-Hans": "取消未发送任务",
    "zh-Hant": "取消尚未傳送的工作",
    "en": "Cancel unsent task",
    "ja": "未送信のタスクをキャンセル"
  },
  "image.studio.queryAndRetrieve": {
    "zh-Hans": "查询并取回",
    "zh-Hant": "查詢並取回",
    "en": "Query and retrieve",
    "ja": "照会して取得"
  },
  "image.studio.checkRecoverLocal": {
    "zh-Hans": "检查并恢复本地结果",
    "zh-Hant": "檢查並還原本機結果",
    "en": "Check and recover local result",
    "ja": "ローカル結果を確認して復元"
  },
  "image.studio.recoverSameLocal": {
    "zh-Hans": "恢复同一份本地结果",
    "zh-Hant": "還原同一份本機結果",
    "en": "Recover the same local result",
    "ja": "同じローカル結果を復元"
  },
  "image.studio.mockEditLabel": {
    "zh-Hans": "Mock · 编辑静态测试卡片",
    "zh-Hant": "Mock · 編輯靜態測試卡片",
    "en": "Mock · editing static test card",
    "ja": "Mock · 編集の静止テストカード"
  },
  "image.studio.mockDeterministicLabel": {
    "zh-Hans": "Mock · 确定性测试图案",
    "zh-Hant": "Mock · 固定測試圖案",
    "en": "Mock · deterministic test pattern",
    "ja": "Mock · 決定的なテストパターン"
  },
  "image.studio.versionImageAlt": {
    "zh-Hans": "{value}，版本 {number}{value2}",
    "zh-Hant": "{value}，版本 {number}{value2}",
    "en": "{value}, version {number}{value2}",
    "ja": "{value}、バージョン {number}{value2}"
  },
  "image.studio.generatedImageAlt": {
    "zh-Hans": "已生成图像",
    "zh-Hant": "已生成圖像",
    "en": "Generated image",
    "ja": "生成済み画像"
  },
  "image.studio.mockAltSuffix": {
    "zh-Hans": "，Mock 测试图案",
    "zh-Hant": "，Mock 測試圖案",
    "en": ", Mock test pattern",
    "ja": "、Mock テストパターン"
  },
  "image.studio.originalResultSize": {
    "zh-Hans": "原始结果 · {width} × {height} PNG · {Math} KB",
    "zh-Hant": "原始結果 · {width} × {height} PNG · {Math} KB",
    "en": "Original result · {width} × {height} PNG · {Math} KB",
    "ja": "元の結果 · {width} × {height} PNG · {Math} KB"
  },
  "image.studio.immutableVersionInfo": {
    "zh-Hans": "不可变版本信息",
    "zh-Hant": "不可變版本資訊",
    "en": "Immutable version information",
    "ja": "変更不可のバージョン情報"
  },
  "image.studio.versionOriginalSource": {
    "zh-Hans": "此版本的原始源图",
    "zh-Hant": "此版本的原始來源圖像",
    "en": "This version’s original source image",
    "ja": "このバージョンの元画像"
  },
  "image.studio.versionIdentity": {
    "zh-Hans": "版本 {id}",
    "zh-Hant": "版本 {id}",
    "en": "Version {id}",
    "ja": "バージョン {id}"
  },
  "image.studio.useInLibrary": {
    "zh-Hans": "在素材库中使用",
    "zh-Hant": "在素材庫中使用",
    "en": "Use in asset library",
    "ja": "素材ライブラリで使用"
  },
  "image.studio.newerVersions": {
    "zh-Hans": "较新版本",
    "zh-Hant": "較新的版本",
    "en": "Newer versions",
    "ja": "新しいバージョン"
  },
  "image.studio.olderVersions": {
    "zh-Hans": "更早版本",
    "zh-Hant": "較早的版本",
    "en": "Older versions",
    "ja": "古いバージョン"
  },
  "image.studio.libraryResultScope": {
    "zh-Hans": "结果已进入项目素材库。可沿用素材库的时间线、首帧与主体参考入口；这里不会自动创建或连接节点",
    "zh-Hant": "結果已加入專案素材庫。可使用素材庫既有的時間軸、首影格與主體參考入口；此處不會自動建立或連接節點",
    "en": "The result is now in the project’s asset library. Use the library’s existing timeline, first-frame, and subject-reference controls. This view does not automatically create or connect nodes",
    "ja": "結果はプロジェクトの素材ライブラリに追加されています。ライブラリの既存のタイムライン、最初のフレーム、被写体参照の操作を利用できます。この画面ではノードを自動で作成したり接続したりしません"
  },
  "image.studio.savedHistory": {
    "zh-Hans": "已保存的图像历史",
    "zh-Hant": "已儲存的圖像歷史",
    "en": "Saved image history",
    "ja": "保存済み画像履歴"
  },
  "image.studio.imageGeneration": {
    "zh-Hans": "图像生成",
    "zh-Hant": "圖像生成",
    "en": "Image generation",
    "ja": "画像生成"
  },
  "tasks.pending.historicalHeld": {
    "zh-Hans": "历史请求 · 暂停恢复",
    "zh-Hant": "歷史請求 · 暫停還原",
    "en": "Historical request · Recovery paused",
    "ja": "過去のリクエスト · 復元を保留"
  },
  "tasks.pending.outcomeUnconfirmed": {
    "zh-Hans": "请求结果待确认",
    "zh-Hant": "請求結果待確認",
    "en": "Request outcome unconfirmed",
    "ja": "リクエスト結果の確認待ち"
  },
  "tasks.pending.sameRequestDisclosure": {
    "zh-Hans": "原编号与完整参数保留在当前会话。恢复时由服务器去重；不会自动重试或创建新的请求编号",
    "zh-Hant": "原編號與完整參數保留在目前會話中。還原時由伺服器去除重複；不會自動重試或建立新的請求編號",
    "en": "The original ID and full parameters are retained in this session. The server deduplicates during recovery. There is no automatic retry or new request ID",
    "ja": "元のIDと完全なパラメーターは現在のセッションに保持されています。復元時にはサーバーが重複を排除します。自動再試行や新しいリクエストIDの作成は行いません"
  },
  "tasks.pending.mutationStorage": {
    "zh-Hans": "恢复记录仅存于当前浏览器会话，未经保险库加密。关闭窗口或重建应用会话可能丢失记录，请先恢复待确认请求。服务器会为保留的原编号保存去重结果",
    "zh-Hant": "還原記錄僅存於目前瀏覽器會話，未經保管庫加密。關閉視窗或重建應用程式會話可能遺失記錄，請先還原待確認請求。伺服器會保存原編號對應的去重結果",
    "en": "Recovery records exist only in this browser session, without vault encryption. Closing the window or recreating the app session may lose them; recover unconfirmed requests first. The server retains deduplication results for the original IDs",
    "ja": "復元記録は現在のブラウザーセッションだけに保存され、保管庫の暗号化は適用されません。ウィンドウを閉じたりアプリセッションを作り直したりすると失われる可能性があるため、先に確認待ちのリクエストを復元してください。サーバーは元のIDに対する重複排除の結果を保持します"
  },
  "tasks.pending.submissionStorage": {
    "zh-Hans": "此待确认提交的恢复参数仍依赖当前浏览器会话。已被服务器接受的生成任务或导出记录会另行持久保存；未知提交不会自动重试",
    "zh-Hant": "此次待確認提交的還原參數仍依賴目前瀏覽器會話。伺服器已接受的生成工作或匯出記錄會另行持久儲存；結果未知的提交不會自動重試",
    "en": "Recovery parameters for this unconfirmed submission still depend on the current browser session. Generation tasks or export records accepted by the server are persisted separately. Unknown submissions are not retried automatically",
    "ja": "この確認待ちの送信を復元するパラメーターは、現在のブラウザーセッションに依存します。サーバーが受け付けた生成タスクや書き出し記録は別途永続保存されます。結果不明の送信を自動再試行することはありません"
  },
  "tasks.pending.duplicateLocalRecord": {
    "zh-Hans": "本地数据库已有此原编号。旧会话记录尚未清除，请明确转存并核对；不会静默隐藏任一记录",
    "zh-Hant": "本機資料庫已有此原編號。舊會話記錄尚未清除，請明確轉存並核對；不會默默隱藏任一記錄",
    "en": "The local database already contains this original ID. The old session record remains. Explicitly transfer and verify it; neither record is hidden silently",
    "ja": "ローカルデータベースに同じ元のIDが存在します。古いセッション記録はまだ残っています。明示的に移管して確認してください。どちらの記録も無断で非表示にしません"
  },
  "tasks.pending.adoptOriginal": {
    "zh-Hans": "转存原请求以便重启恢复",
    "zh-Hant": "轉存原請求以便重啟後還原",
    "en": "Transfer original request for recovery after restart",
    "ja": "再起動後に復元できるよう元のリクエストを移管"
  },
  "tasks.pending.recoverSameRequest": {
    "zh-Hans": "恢复同一请求",
    "zh-Hant": "還原同一請求",
    "en": "Recover the same request",
    "ja": "同じリクエストを復元"
  },
  "tasks.center.addSubtitle": {
    "zh-Hans": "新增字幕",
    "zh-Hant": "新增字幕",
    "en": "Add subtitle",
    "ja": "字幕を追加"
  },
  "tasks.center.updateSubtitle": {
    "zh-Hans": "修改字幕",
    "zh-Hant": "修改字幕",
    "en": "Edit subtitle",
    "ja": "字幕を編集"
  },
  "tasks.center.removeSubtitle": {
    "zh-Hans": "移除字幕",
    "zh-Hant": "移除字幕",
    "en": "Remove subtitle",
    "ja": "字幕を削除"
  },
  "tasks.center.prepared": {
    "zh-Hans": "请求已准备",
    "zh-Hant": "請求已準備",
    "en": "Request prepared",
    "ja": "リクエスト準備済み"
  },
  "tasks.center.checkingOutcome": {
    "zh-Hans": "正在核对执行结果",
    "zh-Hant": "正在核對執行結果",
    "en": "Checking execution outcome",
    "ja": "実行結果を確認中"
  },
  "tasks.center.outcomePending": {
    "zh-Hans": "结果待确认",
    "zh-Hant": "結果待確認",
    "en": "Outcome unconfirmed",
    "ja": "結果の確認待ち"
  },
  "tasks.center.appliedAwaitingClose": {
    "zh-Hans": "已应用，待确认关闭",
    "zh-Hant": "已套用，待確認關閉",
    "en": "Applied; awaiting acknowledgement",
    "ja": "適用済み、確認して閉じてください"
  },
  "tasks.center.confirmedNotApplied": {
    "zh-Hans": "已确认未应用",
    "zh-Hant": "已確認未套用",
    "en": "Confirmed not applied",
    "ja": "未適用を確認済み"
  },
  "tasks.center.timelineFormatOperation": {
    "zh-Hans": "时间线输出规格 · timeline.format.set",
    "zh-Hant": "時間軸輸出規格 · timeline.format.set",
    "en": "Timeline output format · timeline.format.set",
    "ja": "タイムライン出力形式 · timeline.format.set"
  },
  "tasks.center.historicalHeld": {
    "zh-Hans": "历史记录 · 暂停执行，原状态保留",
    "zh-Hant": "歷史記錄 · 暫停執行，原狀態保留",
    "en": "Historical record · Execution paused; original state retained",
    "ja": "過去の記録 · 実行を保留し、元の状態を保持"
  },
  "tasks.center.requestIdentity": {
    "zh-Hans": "请求编号：{requestId}",
    "zh-Hant": "請求編號：{requestId}",
    "en": "Request ID: {requestId}",
    "ja": "リクエストID：{requestId}"
  },
  "tasks.center.legacyAdopted": {
    "zh-Hans": "此请求由旧会话明确转存，保留原始完整参数",
    "zh-Hant": "此請求由舊會話明確轉存，保留原始完整參數",
    "en": "This request was explicitly transferred from an old session with all original parameters retained",
    "ja": "このリクエストは古いセッションから明示的に移管され、元の完全なパラメーターを保持しています"
  },
  "tasks.center.recoveryScope": {
    "zh-Hans": "恢复前先核对服务器中的同一任务；需要执行时使用保存的参数，不使用当前草稿",
    "zh-Hant": "還原前先核對伺服器中的同一工作；需要執行時使用已儲存參數，不使用目前草稿",
    "en": "Check the same server task before recovery. Any execution uses saved parameters, not the current draft",
    "ja": "復元前にサーバー上の同じタスクを確認します。実行が必要な場合は保存済みのパラメーターを使用し、現在の下書きは使用しません"
  },
  "tasks.center.acknowledgeClose": {
    "zh-Hans": "确认并关闭记录",
    "zh-Hant": "確認並關閉記錄",
    "en": "Acknowledge and close record",
    "ja": "確認して記録を閉じる"
  },
  "tasks.center.checkSameRequest": {
    "zh-Hans": "核对同一请求",
    "zh-Hant": "核對同一請求",
    "en": "Check the same request",
    "ja": "同じリクエストを確認"
  },
  "tasks.center.recoverSameRequest": {
    "zh-Hans": "恢复同一请求",
    "zh-Hant": "還原同一請求",
    "en": "Recover the same request",
    "ja": "同じリクエストを復元"
  },
  "tasks.center.localEditRequests": {
    "zh-Hans": "本地编辑请求",
    "zh-Hant": "本機編輯請求",
    "en": "Local edit requests",
    "ja": "ローカル編集リクエスト"
  },
  "tasks.center.durableStorage": {
    "zh-Hans": "{length} 类时间线元数据（含输出规格）、首帧连接与主体编辑请求：本机明文 SQLite 保存，未经保险库加密；不会自动执行",
    "zh-Hant": "{length} 類時間軸中繼資料（含輸出規格）、首影格連線與主體編輯請求：以本機明文 SQLite 儲存，未經保管庫加密；不會自動執行",
    "en": "{length} types of timeline metadata (including output format), first-frame connection, and subject edit requests are stored locally in plaintext SQLite, without vault encryption. They do not execute automatically",
    "ja": "タイムラインのメタデータ（出力形式を含む）、開始フレーム接続、被写体編集の{length}種類のリクエストは、ローカルの平文 SQLite に保存され、保管庫の暗号化は適用されません。自動実行はしません"
  },
  "tasks.center.loadingRecoveryRecords": {
    "zh-Hans": "正在核对全部恢复记录，此类编辑暂不可用",
    "zh-Hant": "正在核對全部還原記錄，此類編輯暫時無法使用",
    "en": "Checking all recovery records; these edits are temporarily unavailable",
    "ja": "すべての復元記録を確認しています。この種類の編集は一時的に利用できません"
  },
  "tasks.center.recoveryListUnavailable": {
    "zh-Hans": "任务恢复列表暂不可用，此类编辑仍被阻止",
    "zh-Hant": "工作還原清單暫時無法使用，此類編輯仍被阻止",
    "en": "The task recovery list is unavailable; these edits remain blocked",
    "ja": "タスクの復元一覧を利用できないため、この種類の編集は引き続き停止しています"
  },
  "tasks.center.reloadTasks": {
    "zh-Hans": "重新载入任务",
    "zh-Hant": "重新載入工作",
    "en": "Reload tasks",
    "ja": "タスクを再読み込み"
  },
  "tasks.center.noLocalPending": {
    "zh-Hans": "没有待确认的本地编辑请求",
    "zh-Hant": "沒有待確認的本機編輯請求",
    "en": "No unconfirmed local edit requests",
    "ja": "確認待ちのローカル編集リクエストはありません"
  },
  "tasks.center.sessionPending": {
    "zh-Hans": "当前会话的待确认请求",
    "zh-Hant": "目前會話的待確認請求",
    "en": "Unconfirmed requests in this session",
    "ja": "現在のセッションの確認待ちリクエスト"
  },
  "tasks.center.originalRecovered": {
    "zh-Hans": "原请求已恢复并确认",
    "zh-Hant": "原請求已還原並確認",
    "en": "Original request recovered and confirmed",
    "ja": "元のリクエストを復元し、確認しました"
  },
  "tasks.center.generationTasks": {
    "zh-Hans": "生成任务",
    "zh-Hant": "生成工作",
    "en": "Generation tasks",
    "ja": "生成タスク"
  },
  "tasks.center.shotTask": {
    "zh-Hans": "镜头任务",
    "zh-Hant": "鏡頭工作",
    "en": "Shot task",
    "ja": "ショットのタスク"
  },
  "tasks.center.historicalPaused": {
    "zh-Hans": "· 历史记录，暂停执行",
    "zh-Hant": "· 歷史記錄，暫停執行",
    "en": "· Historical record; execution paused",
    "ja": "· 過去の記録、実行を保留"
  },
  "tasks.center.generationProblem": {
    "zh-Hans": "生成遇到问题",
    "zh-Hant": "生成遇到問題",
    "en": "Generation encountered a problem",
    "ja": "生成で問題が発生しました"
  },
  "tasks.center.unknownSubmissionWarning": {
    "zh-Hans": "服务商可能已接受任务并计费。请在服务商核实，系统不会盲目重新提交",
    "zh-Hant": "服務商可能已接受工作並計費。請向服務商核實，系統不會貿然重新提交",
    "en": "The provider may have accepted the task and charged for it. Verify with the provider; the system will not blindly resubmit",
    "ja": "プロバイダーがタスクを受け付け、課金している可能性があります。プロバイダー側で確認してください。システムが確認せずに再送信することはありません"
  },
  "tasks.center.providerTaskId": {
    "zh-Hans": "已有服务商任务 ID",
    "zh-Hant": "既有的服務商工作 ID",
    "en": "Existing provider task ID",
    "ja": "既存のプロバイダータスクID"
  },
  "tasks.center.optional": {
    "zh-Hans": "可选",
    "zh-Hant": "選填",
    "en": "Optional",
    "ja": "任意"
  },
  "tasks.center.knownIdRecovered": {
    "zh-Hans": "已知 ID 会自动恢复，无需填写",
    "zh-Hant": "已知 ID 會自動還原，無須填寫",
    "en": "Known IDs are recovered automatically; no entry needed",
    "ja": "既知のIDは自動で復元されるため、入力不要です"
  },
  "tasks.center.reconcileExistingTask": {
    "zh-Hans": "核对并恢复已有任务",
    "zh-Hant": "核對並還原既有工作",
    "en": "Check and recover existing task",
    "ja": "既存タスクを確認して復元"
  },
  "tasks.center.existingStatusChecked": {
    "zh-Hans": "已核对已有任务状态，没有重新提交生成",
    "zh-Hant": "已核對既有工作狀態，未重新提交生成",
    "en": "Existing task status checked; generation was not resubmitted",
    "ja": "既存タスクの状態を確認しました。生成は再送信していません"
  },
  "tasks.center.stopScope": {
    "zh-Hans": "停止范围：{value}",
    "zh-Hant": "停止範圍：{value}",
    "en": "Stop scope: {value}",
    "ja": "停止範囲：{value}"
  },
  "tasks.center.remoteCancellationConfirmed": {
    "zh-Hans": "远端任务已确认取消",
    "zh-Hant": "已確認取消遠端工作",
    "en": "remote cancellation confirmed",
    "ja": "リモートタスクのキャンセル確認済み"
  },
  "tasks.center.localWaitOnly": {
    "zh-Hans": "仅停止本地等待，不代表服务商已取消或停止计费",
    "zh-Hant": "僅停止本機等待，不代表服務商已取消或停止計費",
    "en": "local waiting only; this does not mean the provider cancelled or stopped billing",
    "ja": "ローカルの待機のみ。プロバイダー側のキャンセルや課金停止を意味しません"
  },
  "tasks.center.submissionCount": {
    "zh-Hans": "提交 {value} 次",
    "zh-Hant": "提交 {value} 次",
    "en": "Submitted {value} times",
    "ja": "送信回数：{value}回"
  },
  "tasks.center.viewShot": {
    "zh-Hans": "查看镜头",
    "zh-Hant": "查看鏡頭",
    "en": "View shot",
    "ja": "ショットを見る"
  },
  "tasks.center.retryExists": {
    "zh-Hans": "已有重试任务",
    "zh-Hant": "已有重試工作",
    "en": "Retry task exists",
    "ja": "再試行タスクあり"
  },
  "tasks.center.retryFailed": {
    "zh-Hans": "重试失败任务",
    "zh-Hant": "重試失敗的工作",
    "en": "Retry failed task",
    "ja": "失敗したタスクを再試行"
  },
  "tasks.center.retryAlreadyPending": {
    "zh-Hans": "原任务已有重试正在处理或待核实，请查看新任务",
    "zh-Hant": "原工作已有重試正在處理或待核實，請查看新工作",
    "en": "A retry of the original task is running or unconfirmed; check the new task",
    "ja": "元のタスクの再試行が処理中または確認待ちです。新しいタスクを確認してください"
  },
  "tasks.center.retryOriginalSnapshot": {
    "zh-Hans": "仅对明确失败的原始快照重试",
    "zh-Hant": "僅重試已明確失敗的原始快照",
    "en": "Retry only the original snapshot of a confirmed failure",
    "ja": "明確に失敗した元のスナップショットのみを再試行"
  },
  "tasks.center.stopWaiting": {
    "zh-Hans": "停止等待",
    "zh-Hant": "停止等待",
    "en": "Stop waiting",
    "ja": "待機を停止"
  },
  "tasks.center.stopWaitConfirmation": {
    "zh-Hans": "停止本地等待不一定能取消服务商任务，也不保证停止计费。继续？",
    "zh-Hant": "停止本機等待不一定能取消服務商工作，也不保證停止計費。是否繼續？",
    "en": "Stopping local waiting may not cancel the provider’s task and does not guarantee that billing stops. Continue?",
    "ja": "ローカルでの待機を停止しても、プロバイダーのタスクがキャンセルされるとは限らず、課金が止まる保証もありません。続けますか？"
  },
  "tasks.center.stopRequested": {
    "zh-Hans": "已请求停止。请查看任务记录中的实际取消范围",
    "zh-Hant": "已請求停止。請查看工作記錄中的實際取消範圍",
    "en": "Stop requested. Check the task record for the actual cancellation scope",
    "ja": "停止を要求しました。実際のキャンセル範囲はタスク記録で確認してください"
  },
  "tasks.center.noGenerationTasks": {
    "zh-Hans": "还没有生成任务",
    "zh-Hant": "尚無生成工作",
    "en": "No generation tasks yet",
    "ja": "生成タスクはまだありません"
  },
  "tasks.center.generationEmptyHint": {
    "zh-Hans": "选择镜头并点击生成，这里会显示实时进度和结果",
    "zh-Hant": "選擇鏡頭並按下生成，即可在此查看即時進度與結果",
    "en": "Select a shot and generate to see live progress and results here",
    "ja": "ショットを選んで生成すると、ここに進捗と結果が表示されます"
  },
  "tasks.workspace.heading": {
    "zh-Hans": "任务中心",
    "zh-Hant": "工作中心",
    "en": "Task center",
    "ja": "タスクセンター"
  },
  "tasks.workspace.activeCount": {
    "zh-Hans": "{activeCount} 个任务正在处理",
    "zh-Hant": "{activeCount} 個工作正在處理",
    "en": "{activeCount} tasks in progress",
    "ja": "{activeCount}件のタスクを処理中"
  },
  "tasks.workspace.traceableSubmissions": {
    "zh-Hans": "每次提交都有迹可循",
    "zh-Hant": "每次提交都有跡可循",
    "en": "Every submission is traceable",
    "ja": "すべての送信を追跡できます"
  },
  "tasks.workspace.recordsAria": {
    "zh-Hans": "任务记录",
    "zh-Hant": "工作記錄",
    "en": "Task records",
    "ja": "タスク記録"
  },
  "tasks.workspace.durableState": {
    "zh-Hans": "生成任务状态持久保存；刷新或重启不会重复提交",
    "zh-Hant": "生成工作狀態會持久儲存；重新整理或重啟不會重複提交",
    "en": "Generation task state is saved persistently. Refreshing or restarting does not resubmit",
    "ja": "生成タスクの状態は永続保存されます。更新や再起動で再送信されることはありません"
  }
} as const satisfies MessageCatalog;
