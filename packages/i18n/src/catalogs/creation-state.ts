import type { MessageCatalog } from '../types.ts';
export const creationStateMessages = {
  "agent.chat.state.unauthorized": {
    "zh-Hans": "登录会话已过期，请重新登录后打开对话。",
    "zh-Hant": "登入會話已過期，請重新登入後開啟對話。",
    "en": "Your sign-in session expired. Sign in again, then open the conversation.",
    "ja": "ログインセッションの期限が切れました。再ログインしてから会話を開いてください。"
  },
  "agent.chat.state.sessionExpired": {
    "zh-Hans": "后端已重新启动。已保存的对话仍可读取；中断的回复不会自动续接或重新发送。",
    "zh-Hant": "後端已重新啟動。仍可讀取已儲存的對話；中斷的回覆不會自動接續或重新傳送。",
    "en": "The backend restarted. Saved conversation remains readable; interrupted replies will not resume or resend automatically.",
    "ja": "バックエンドが再起動しました。保存済みの会話は読み取れます。中断した返信の自動再開や再送は行いません。"
  },
  "agent.chat.state.storageFull": {
    "zh-Hans": "本地聊天数据库容量已满，无法保存新的对话。草稿已保留，请检查本地存储；不会自动重新发送。",
    "zh-Hant": "本機聊天資料庫容量已滿，無法儲存新對話。草稿已保留，請檢查本機儲存空間；不會自動重新傳送。",
    "en": "The local chat database is full and cannot save new conversation. Your draft is retained. Check local storage; nothing will be resent automatically.",
    "ja": "ローカルのチャットデータベースが満杯で、新しい会話を保存できません。下書きは保持しています。ローカルストレージを確認してください。自動再送はしません。"
  },
  "agent.chat.state.storageUnavailable": {
    "zh-Hans": "本地聊天数据库暂不可用。请保留草稿并检查本地存储；不会自动重新发送。",
    "zh-Hant": "本機聊天資料庫暫時無法使用。請保留草稿並檢查本機儲存空間；不會自動重新傳送。",
    "en": "The local chat database is unavailable. Keep your draft and check local storage; nothing will be resent automatically.",
    "ja": "ローカルのチャットデータベースを利用できません。下書きを保持し、ローカルストレージを確認してください。自動再送はしません。"
  },
  "agent.chat.state.interrupted": {
    "zh-Hans": "回复因应用或后端中断而结束。已保存的部分文字保留，不会自动续接；远端仍可能已计算或计费。",
    "zh-Hant": "回覆因應用程式或後端中斷而結束。已儲存的部分文字會保留，不會自動接續；遠端仍可能已進行運算或計費。",
    "en": "The reply ended because the app or backend was interrupted. Saved partial text is retained and will not resume automatically. Remote computation or charges may already have occurred.",
    "ja": "アプリまたはバックエンドの中断により返信が終了しました。保存済みの文章は保持し、自動再開はしません。リモート側で処理や課金が発生している可能性があります。"
  },
  "agent.chat.state.settingsConflict": {
    "zh-Hans": "连接设置已改变。请核对最新协议、地址和模型，再重新确认发送。",
    "zh-Hant": "連線設定已變更。請核對最新的協議、地址與模型，再重新確認傳送。",
    "en": "Connection settings changed. Review the latest protocol, URL, and model, then confirm sending again.",
    "ja": "接続設定が変わりました。最新のプロトコル、URL、モデルを確認してから、送信を再確認してください。"
  },
  "agent.chat.state.conversationConflict": {
    "zh-Hans": "对话已在其他窗口更新。请核对最新内容，再确认发送。",
    "zh-Hant": "對話已在其他視窗更新。請核對最新內容，再確認傳送。",
    "en": "The conversation was updated in another window. Review the latest content, then confirm sending.",
    "ja": "別のウィンドウで会話が更新されました。最新の内容を確認してから送信を確認してください。"
  },
  "agent.chat.state.consentChanged": {
    "zh-Hans": "发送目标、对话或项目读取权限已改变，请重新核对并确认。",
    "zh-Hant": "傳送目標、對話或專案讀取權限已變更，請重新核對並確認。",
    "en": "The destination, conversation, or project-read permission changed. Review and confirm again.",
    "ja": "送信先、会話、またはプロジェクトの読み取り権限が変わりました。再度確認してください。"
  },
  "agent.chat.state.activeRun": {
    "zh-Hans": "此项目已有一条回复正在生成，请等待或停止后再发送。",
    "zh-Hant": "此專案已有一則回覆正在生成，請等待或停止後再傳送。",
    "en": "A reply is already being generated for this project. Wait or stop it before sending.",
    "ja": "このプロジェクトでは返信を生成中です。完了を待つか停止してから送信してください。"
  },
  "agent.chat.state.credentialUnavailable": {
    "zh-Hans": "当前连接的密钥不可用。请在连接设置中检查；没有自动切换服务。",
    "zh-Hant": "目前連線的密鑰無法使用，請在連線設定中檢查；沒有自動切換服務。",
    "en": "The key for this connection is unavailable. Check connection settings; no service was switched automatically.",
    "ja": "現在の接続のキーを利用できません。接続設定を確認してください。自動でサービスを切り替えてはいません。"
  },
  "agent.chat.state.busy": {
    "zh-Hans": "本次会话的运行或容量已达上限，请等待正在进行的回复结束。",
    "zh-Hant": "此會話的執行數或容量已達上限，請等待目前的回覆結束。",
    "en": "This session reached its run or capacity limit. Wait for the current reply to finish.",
    "ja": "このセッションの実行数または容量が上限に達しました。現在の返信が終わるまでお待ちください。"
  },
  "agent.chat.state.runExpired": {
    "zh-Hans": "这条运行暂不可读取；可以重新读取已保存的对话，不会重新发送。",
    "zh-Hant": "此執行目前無法讀取；可重新讀取已儲存對話，不會重新傳送。",
    "en": "This run cannot be read right now. Reload the saved conversation; it will not be resent.",
    "ja": "この実行は現在読み取れません。保存済みの会話を再読み込みできます。再送はしません。"
  },
  "agent.chat.state.runNotFound": {
    "zh-Hans": "未找到这条已保存的运行；不会重新发送。",
    "zh-Hant": "找不到此已儲存的執行；不會重新傳送。",
    "en": "This saved run was not found; it will not be resent.",
    "ja": "この保存済み実行が見つかりません。再送はしません。"
  },
  "agent.chat.state.serviceClosed": {
    "zh-Hans": "聊天服务已关闭，请重新读取状态或重启应用。",
    "zh-Hant": "聊天服務已關閉，請重新讀取狀態或重啟應用程式。",
    "en": "The chat service is closed. Reload status or restart the app.",
    "ja": "チャットサービスが終了しています。状態を再読み込みするか、アプリを再起動してください。"
  },
  "agent.chat.state.validation": {
    "zh-Hans": "消息未通过校验，请检查长度及字符。",
    "zh-Hant": "訊息未通過驗證，請檢查長度與字元。",
    "en": "Message validation failed. Check its length and characters.",
    "ja": "メッセージの検証に失敗しました。長さと文字を確認してください。"
  },
  "agent.chat.state.unsupportedProfile": {
    "zh-Hans": "当前文本聊天尚不支持此协议与模型组合。请在连接设置中核对协议和支持的精确模型 ID；不会自动换模型或协议。",
    "zh-Hant": "目前的文字聊天不支援此協議與模型組合。請在連線設定中核對協議及支援的精確模型 ID；不會自動更換模型或協議。",
    "en": "Text chat does not support this protocol/model combination. Check the protocol and exact supported model ID in connection settings. The model or protocol will not be changed automatically.",
    "ja": "テキストチャットは、このプロトコルとモデルの組み合わせに未対応です。接続設定でプロトコルと対応する正確なモデルIDを確認してください。自動でモデルやプロトコルを変更することはありません。"
  },
  "agent.chat.state.keyRequired": {
    "zh-Hans": "请先在连接设置中为当前服务保存 API 密钥。",
    "zh-Hant": "請先在連線設定中儲存目前服務的 API 密鑰。",
    "en": "Save an API key for the current service in connection settings first.",
    "ja": "先に接続設定で現在のサービスの API キーを保存してください。"
  },
  "agent.chat.state.networkDenied": {
    "zh-Hans": "服务地址未通过安全网络检查；本地服务仅支持专用 Ollama 回环地址。",
    "zh-Hant": "服務地址未通過網路安全檢查；本機服務僅支援專用的 Ollama 回環地址。",
    "en": "The service URL failed the network safety check. Local services support only the dedicated Ollama loopback address.",
    "ja": "サービスURLがネットワークの安全確認を通過しませんでした。ローカルサービスは専用の Ollama ループバックアドレスのみに対応します。"
  },
  "agent.chat.state.connectionFailed": {
    "zh-Hans": "无法安全连接模型服务，请检查连接设置和网络。",
    "zh-Hant": "無法安全連接模型服務，請檢查連線設定與網路。",
    "en": "Could not safely connect to the model service. Check connection settings and network.",
    "ja": "モデルサービスへ安全に接続できませんでした。接続設定とネットワークを確認してください。"
  },
  "agent.chat.state.timeout": {
    "zh-Hans": "回复超时，已保留收到的文字。不会自动重新发送。",
    "zh-Hant": "回覆逾時，已保留收到的文字。不會自動重新傳送。",
    "en": "The reply timed out. Received text is retained. There is no automatic resend.",
    "ja": "返信がタイムアウトしました。受信済みの文章は保持しています。自動再送はしません。"
  },
  "agent.chat.state.aborted": {
    "zh-Hans": "回复已停止；远端仍可能已计算或计费。",
    "zh-Hant": "回覆已停止；遠端仍可能已進行運算或計費。",
    "en": "The reply stopped. Remote computation or charges may already have occurred.",
    "ja": "返信を停止しました。リモート側で処理や課金が発生している可能性があります。"
  },
  "agent.chat.state.httpError": {
    "zh-Hans": "模型服务拒绝了请求，请检查账户、模型和配置。",
    "zh-Hant": "模型服務拒絕請求，請檢查帳戶、模型與設定。",
    "en": "The model service rejected the request. Check the account, model, and configuration.",
    "ja": "モデルサービスがリクエストを拒否しました。アカウント、モデル、設定を確認してください。"
  },
  "agent.chat.state.protocolError": {
    "zh-Hans": "模型返回了无效或不支持的文本流，请检查模型兼容配置。",
    "zh-Hant": "模型傳回無效或不支援的文字串流，請檢查模型相容設定。",
    "en": "The model returned an invalid or unsupported text stream. Check model compatibility settings.",
    "ja": "モデルが無効または未対応のテキストストリームを返しました。モデルの互換性設定を確認してください。"
  },
  "agent.chat.state.truncated": {
    "zh-Hans": "连接提前结束，或回复达到输出限制，内容可能不完整。",
    "zh-Hant": "連線提前結束，或回覆已達輸出限制，內容可能不完整。",
    "en": "The connection ended early or the reply reached its output limit. Content may be incomplete.",
    "ja": "接続が早期に終了したか、返信が出力上限に達しました。内容が不完全な可能性があります。"
  },
  "agent.chat.state.limitReached": {
    "zh-Hans": "已达到输入、输出或流量限制，当前回复已停止。",
    "zh-Hant": "已達輸入、輸出或流量限制，目前回覆已停止。",
    "en": "An input, output, or traffic limit was reached. The current reply stopped.",
    "ja": "入力、出力、または通信量の上限に達したため、現在の返信を停止しました。"
  },
  "agent.chat.state.unauthorizedTool": {
    "zh-Hans": "模型请求了未获本轮授权的工具，或超出了本轮工具调用上限；该请求未执行。",
    "zh-Hant": "模型要求了本輪未授權的工具，或超出本輪工具呼叫上限；該請求未執行。",
    "en": "The model requested a tool not authorized for this turn or exceeded the tool-call limit. That request was not executed.",
    "ja": "モデルが今回許可されていないツールを要求したか、ツール呼び出しの上限を超えました。そのリクエストは実行していません。"
  },
  "agent.chat.state.inspectionUnavailable": {
    "zh-Hans": "所选项目的这项资料无法安全读取，没有继续发送模型请求。已收到的文字保留。",
    "zh-Hant": "無法安全讀取所選專案的這項資料，未繼續傳送模型請求。已收到的文字會保留。",
    "en": "This data in the selected project could not be read safely. No further model request was sent. Received text is retained.",
    "ja": "選択したプロジェクトのこの情報を安全に読み取れませんでした。追加のモデルリクエストは送信していません。受信済みの文章は保持します。"
  },
  "agent.chat.state.reasoningUnsupported": {
    "zh-Hans": "此模型返回了不支持的推理或续接数据，请选择非思考文本模式。",
    "zh-Hant": "此模型傳回不支援的推理或接續資料，請選擇非思考文字模式。",
    "en": "This model returned unsupported reasoning or continuation data. Choose a non-thinking text mode.",
    "ja": "このモデルが未対応の推論または続行データを返しました。非思考のテキストモードを選択してください。"
  },
  "agent.chat.state.editValidation": {
    "zh-Hans": "所选内容或提议未通过安全校验，请检查已保存目标、字段及范围。",
    "zh-Hant": "所選內容或提議未通過安全驗證，請檢查已儲存目標、欄位與範圍。",
    "en": "Selected content or the proposal failed safety validation. Check the saved target, fields, and scope.",
    "ja": "選択した内容または提案が安全性の検証を通過しませんでした。保存済みの対象、フィールド、範囲を確認してください。"
  },
  "agent.chat.state.editTargetNotFound": {
    "zh-Hans": "所选项目、镜头或时间线片段不可用，请重新核对已保存目标。",
    "zh-Hant": "所選專案、鏡頭或時間軸片段無法使用，請重新核對已儲存目標。",
    "en": "The selected project, shot, or timeline clip is unavailable. Check the saved target again.",
    "ja": "選択したプロジェクト、ショット、タイムラインクリップを利用できません。保存済みの対象を再確認してください。"
  },
  "agent.chat.state.editRevisionConflict": {
    "zh-Hans": "所选目标的保存版本已变化。请查看最新已保存内容并重新确认；没有自动继续发送。",
    "zh-Hant": "所選目標的儲存版本已變更。請查看最新已儲存內容並重新確認；沒有自動繼續傳送。",
    "en": "The selected target’s saved revision changed. Review the latest saved content and confirm again. Sending did not continue automatically.",
    "ja": "選択した対象の保存リビジョンが変わりました。最新の保存内容を確認し、再確認してください。自動で送信を続けてはいません。"
  },
  "agent.chat.state.proposalStorageFull": {
    "zh-Hans": "本地提议存储已达上限，已保存提议保留，没有自动重发。",
    "zh-Hant": "本機提議儲存空間已達上限，既有提議會保留，沒有自動重送。",
    "en": "Local proposal storage is full. Saved proposals are retained; there was no automatic resend.",
    "ja": "ローカルの提案保存領域が上限に達しました。保存済みの提案は保持し、自動再送はしていません。"
  },
  "agent.chat.state.proposalStorageUnavailable": {
    "zh-Hans": "本地提议存储暂不可用，没有自动重发。请核对已保存状态。",
    "zh-Hant": "本機提議儲存空間暫時無法使用，沒有自動重送。請核對已儲存狀態。",
    "en": "Local proposal storage is unavailable. There was no automatic resend. Check saved status.",
    "ja": "ローカルの提案保存領域を利用できません。自動再送はしていません。保存状態を確認してください。"
  },
  "agent.chat.state.editScopeUnavailable": {
    "zh-Hans": "所选已保存目标不在允许的提议范围内。请核对选择、保存版本及内容范围后重新确认。",
    "zh-Hant": "所選已儲存目標不在允許的提議範圍內。請核對選擇、儲存版本與內容範圍後重新確認。",
    "en": "The selected saved target is outside the allowed proposal scope. Review the selection, saved revision, and content scope, then confirm again.",
    "ja": "選択した保存済みの対象は許可された提案範囲外です。選択、保存リビジョン、内容の範囲を確認してから再確認してください。"
  },
  "agent.chat.state.editTargetChanged": {
    "zh-Hans": "所选目标已变化。请读取最新保存版本并重新核对，本次不会自动发送或应用。",
    "zh-Hant": "所選目標已變更。請讀取最新儲存版本並重新核對，此次不會自動傳送或套用。",
    "en": "The selected target changed. Read the latest saved revision and check again. Nothing will be sent or applied automatically.",
    "ja": "選択した対象が変わりました。最新の保存リビジョンを読み取り、再確認してください。自動送信や自動適用は行いません。"
  },
  "agent.chat.state.providerError": {
    "zh-Hans": "模型服务在回复过程中报告错误，已保留收到的文字。",
    "zh-Hant": "模型服務在回覆期間回報錯誤，已保留收到的文字。",
    "en": "The model service reported an error during the reply. Received text is retained.",
    "ja": "返信中にモデルサービスがエラーを報告しました。受信済みの文章は保持しています。"
  },
  "agent.chat.state.incompleteFallback": {
    "zh-Hans": "回复未完成。已保留收到的文字；不会自动重新发送。",
    "zh-Hant": "回覆未完成。已保留收到的文字；不會自動重新傳送。",
    "en": "The reply did not complete. Received text is retained; it will not be resent automatically.",
    "ja": "返信は完了しませんでした。受信済みの文章は保持し、自動再送はしません。"
  },
  "agent.chat.state.promptRequired": {
    "zh-Hans": "请输入消息。",
    "zh-Hant": "請輸入訊息。",
    "en": "Enter a message.",
    "ja": "メッセージを入力してください。"
  },
  "agent.chat.state.promptByteLimit": {
    "zh-Hans": "消息最多 8192 UTF-8 字节，请缩短后发送。",
    "zh-Hant": "訊息最多 8192 UTF-8 位元組，請縮短後傳送。",
    "en": "Messages are limited to 8192 UTF-8 bytes. Shorten the message before sending.",
    "ja": "メッセージは UTF-8 で最大8192バイトです。短くしてから送信してください。"
  },
  "agent.chat.state.promptControlCharacters": {
    "zh-Hans": "消息包含不支持的控制字符。",
    "zh-Hant": "訊息包含不支援的控制字元。",
    "en": "The message contains unsupported control characters.",
    "ja": "メッセージに未対応の制御文字が含まれています。"
  },
  "agent.chat.state.displayDetached": {
    "zh-Hans": "连接已中断，回复可能仍在继续。重新读取只恢复显示，不会重复发送。",
    "zh-Hant": "連線已中斷，回覆可能仍在繼續。重新讀取只會恢復顯示，不會重複傳送。",
    "en": "The connection was lost; the reply may still be running. Reloading restores display only and does not resend.",
    "ja": "接続が切れましたが、返信処理は続いている可能性があります。再読み込みは表示を復元するだけで、再送はしません。"
  },
  "agent.chat.state.runStateUnknown": {
    "zh-Hans": "暂时无法确认运行状态。已收到的文字保留；只会读取状态，不会重新发送。",
    "zh-Hant": "目前無法確認執行狀態。已收到的文字會保留；只會讀取狀態，不會重新傳送。",
    "en": "Run status cannot be confirmed right now. Received text is retained. Only status will be read; nothing is resent.",
    "ja": "現在、実行状態を確認できません。受信済みの文章は保持します。状態を読み取るだけで、再送はしません。"
  },
  "agent.chat.state.unacknowledgedOriginal": {
    "zh-Hans": "未收到发送确认，尚未找到原请求。查不到不能证明请求未被接受；待确认标识在当前页面会话内保留，后端重启后仍可核对。请重新读取，不会自动重发，远端仍可能已计算或计费。",
    "zh-Hant": "未收到傳送確認，也尚未找到原請求。查無記錄不能證明請求未被接受；待確認標識會保留在目前頁面會話，後端重啟後仍可核對。請重新讀取，不會自動重送；遠端仍可能已進行運算或計費。",
    "en": "No submission acknowledgement was received and the original request has not been found. Not finding it does not prove it was not accepted. Its pending identity is retained in this page session and can still be checked after a backend restart. Reload to check; there is no automatic resend. Remote computation or charges may already have occurred.",
    "ja": "送信の確認応答を受信できず、元のリクエストもまだ見つかりません。見つからないことは未受付の証拠にはなりません。確認待ちの識別情報は現在のページセッションに保持され、バックエンドの再起動後も確認できます。再読み込みで確認してください。自動再送はしません。リモート側で処理や課金が発生している可能性があります。"
  },
  "agent.chat.state.originalConfirmed": {
    "zh-Hans": "已读取原请求并确认其保存状态，没有重新发送。",
    "zh-Hant": "已讀取原請求並確認儲存狀態，沒有重新傳送。",
    "en": "The original request was read and its saved status confirmed. It was not resent.",
    "ja": "元のリクエストを読み取り、保存状態を確認しました。再送はしていません。"
  },
  "agent.chat.state.conversationReadUnknown": {
    "zh-Hans": "暂时无法读取或确认对话。草稿与待确认标识保留；重新读取不会发起模型请求。",
    "zh-Hant": "目前無法讀取或確認對話。草稿與待確認標識會保留；重新讀取不會發起模型請求。",
    "en": "The conversation cannot be read or confirmed right now. The draft and pending identity are retained. Reloading does not start a model request.",
    "ja": "現在、会話を読み取り・確認できません。下書きと確認待ちの識別情報は保持します。再読み込みでモデルリクエストが開始されることはありません。"
  },
  "agent.chat.state.historyReadUnavailable": {
    "zh-Hans": "暂时无法读取更早记录。当前回复与草稿仍保留，请返回最近对话后重新读取。",
    "zh-Hant": "目前無法讀取較早記錄。目前回覆與草稿仍保留，請返回最近對話後重新讀取。",
    "en": "Older records cannot be read right now. The current reply and draft are retained. Return to recent conversation and reload.",
    "ja": "過去の記録を現在読み取れません。現在の返信と下書きは保持します。直近の会話に戻って再読み込みしてください。"
  },
  "agent.chat.state.pendingEnded": {
    "zh-Hans": "已按你的选择结束本地待确认状态，草稿保留。这不会停止或撤回原请求；再次发送可能造成重复回复或费用，请先核对历史并重新确认。",
    "zh-Hant": "已依你的選擇結束本機待確認狀態，草稿會保留。這不會停止或撤回原請求；再次傳送可能造成重複回覆或費用，請先核對歷史並重新確認。",
    "en": "The local pending state was ended as requested, and the draft is retained. This does not stop or withdraw the original request. Sending again may cause duplicate replies or charges. Check history and confirm again first.",
    "ja": "指定に従ってローカルの確認待ち状態を終了し、下書きを保持しました。元のリクエストを停止・取り消す操作ではありません。再送すると返信や料金が重複する可能性があるため、先に履歴を確認し、再確認してください。"
  },
  "agent.chat.state.checkTimelineState": {
    "zh-Hans": "请先核对当前时间线状态。",
    "zh-Hant": "請先核對目前的時間軸狀態。",
    "en": "Check the current timeline state first.",
    "ja": "先に現在のタイムラインの状態を確認してください。"
  },
  "agent.chat.state.checkingSubmission": {
    "zh-Hans": "未收到发送确认。正在读取原请求状态，不会重新发送。",
    "zh-Hant": "未收到傳送確認。正在讀取原請求狀態，不會重新傳送。",
    "en": "No submission acknowledgement was received. Reading the original request’s status; it will not be resent.",
    "ja": "送信の確認応答を受信できませんでした。元のリクエストの状態を読み取っています。再送はしません。"
  },
  "agent.chat.state.requestingStop": {
    "zh-Hans": "正在请求停止后续步骤。已发生的计算或费用无法撤回。",
    "zh-Hant": "正在請求停止後續步驟。已發生的運算或費用無法撤回。",
    "en": "Requesting a stop to later steps. Computation or charges already incurred cannot be undone.",
    "ja": "後続の処理の停止を要求しています。発生済みの処理や料金は取り消せません。"
  },
  "agent.chat.state.stoppedLaterSteps": {
    "zh-Hans": "已停止后续步骤，已收到的文字和读取结果保留；远端仍可能已计算或计费。",
    "zh-Hant": "後續步驟已停止，已收到的文字與讀取結果會保留；遠端仍可能已進行運算或計費。",
    "en": "Later steps stopped. Received text and read results are retained. Remote computation or charges may already have occurred.",
    "ja": "後続の処理を停止しました。受信済みの文章と読み取り結果は保持します。リモート側で処理や課金が発生している可能性があります。"
  },
  "agent.chat.state.stopResponseReceived": {
    "zh-Hans": "停止请求已返回，运行状态如下；已发生的费用无法撤回。",
    "zh-Hant": "停止請求已傳回，執行狀態如下；已發生的費用無法撤回。",
    "en": "The stop request returned; run status is shown below. Charges already incurred cannot be reversed.",
    "ja": "停止リクエストへの応答を受信しました。実行状態は以下のとおりです。発生済みの料金は取り消せません。"
  },
  "agent.chat.state.stopUnconfirmed": {
    "zh-Hans": "未确认停止结果；远端可能仍在运行或计费。正在读取状态，不会重复提交停止。",
    "zh-Hant": "停止結果尚未確認；遠端可能仍在執行或計費。正在讀取狀態，不會重複提交停止。",
    "en": "Stopping is unconfirmed; remote work or billing may continue. Reading status without resubmitting the stop request.",
    "ja": "停止結果は未確認で、リモート側の処理や課金が続いている可能性があります。状態を読み取っており、停止リクエストは再送信しません。"
  },
  "agent.proposal.state.pending": {
    "zh-Hans": "已提议，尚未应用",
    "zh-Hant": "已提議，尚未套用",
    "en": "Proposed; not applied",
    "ja": "提案済み、未適用"
  },
  "agent.proposal.state.approved": {
    "zh-Hans": "已批准，尚未确认应用",
    "zh-Hant": "已批准，尚未確認套用",
    "en": "Approved; application unconfirmed",
    "ja": "承認済み、適用は未確認"
  },
  "agent.proposal.state.dispatching": {
    "zh-Hans": "正在应用，结果待确认",
    "zh-Hant": "正在套用，結果待確認",
    "en": "Applying; outcome unconfirmed",
    "ja": "適用中、結果の確認待ち"
  },
  "agent.proposal.state.unknown": {
    "zh-Hans": "应用结果未知",
    "zh-Hant": "套用結果未知",
    "en": "Application outcome unknown",
    "ja": "適用結果不明"
  },
  "agent.proposal.state.applied": {
    "zh-Hans": "已确认应用",
    "zh-Hant": "已確認套用",
    "en": "Application confirmed",
    "ja": "適用を確認済み"
  },
  "agent.proposal.state.failed": {
    "zh-Hans": "未应用",
    "zh-Hant": "未套用",
    "en": "Not applied",
    "ja": "未適用"
  },
  "agent.proposal.state.rejected": {
    "zh-Hans": "已拒绝，未应用",
    "zh-Hant": "已拒絕，未套用",
    "en": "Rejected; not applied",
    "ja": "拒否済み、未適用"
  },
  "agent.proposal.state.cancelled": {
    "zh-Hans": "提议已失效，未应用",
    "zh-Hant": "提議已失效，未套用",
    "en": "Proposal invalidated; not applied",
    "ja": "提案は無効、未適用"
  },
  "agent.proposal.state.statusUnknown": {
    "zh-Hans": "状态未知",
    "zh-Hant": "狀態未知",
    "en": "Status unknown",
    "ja": "状態不明"
  },
  "agent.proposal.state.pinCapacity": {
    "zh-Hans": "已有 50 份原操作待核对。请先只读核对或恢复下方保留的原提议，再批准新的提议；原身份与请求不会被丢弃。",
    "zh-Hant": "已有 50 份原操作待核對。請先以唯讀方式核對或還原下方保留的原提議，再批准新提議；原身份與請求不會被丟棄。",
    "en": "50 original operations await verification. Check them read-only or recover the retained original proposals below before approving new ones. Original identities and requests will not be discarded.",
    "ja": "元の操作50件が確認待ちです。新しい提案を承認する前に、下に保持されている元の提案を読み取り専用で確認するか復元してください。元の識別情報とリクエストは破棄しません。"
  },
  "agent.proposal.state.loadUnavailable": {
    "zh-Hans": "暂时无法读取修改提议。已有差异保留；重新读取不会批准或应用修改。",
    "zh-Hant": "目前無法讀取修改提議。既有差異會保留；重新讀取不會批准或套用修改。",
    "en": "Edit proposals cannot be read right now. Existing diffs are retained. Reloading does not approve or apply changes.",
    "ja": "変更提案を現在読み取れません。既存の差分は保持します。再読み込みで変更を承認・適用することはありません。"
  },
  "agent.proposal.state.originalAcceptanceUnknown": {
    "zh-Hans": "尚未确认原操作是否被接受。刚刚读取的提议仍待批准，不能据此认定先前请求未被接受；可继续只读核对，或明确重试同一份已保存提议的批准请求。",
    "zh-Hant": "尚未確認原操作是否被接受。剛讀取的提議仍待批准，不能據此認定先前請求未被接受；可繼續以唯讀方式核對，或明確重試同一份已儲存提議的批准請求。",
    "en": "Acceptance of the original operation is unconfirmed. The proposal just read is still pending approval, but this does not prove the earlier request was not accepted. Continue read-only checks or explicitly retry approval of the same saved proposal.",
    "ja": "元の操作が受け付けられたかは未確認です。今読み取った提案は承認待ちですが、以前のリクエストが未受付だった証拠にはなりません。読み取り専用の確認を続けるか、同じ保存済み提案の承認を明示的に再試行できます。"
  },
  "agent.proposal.state.inspectFailed": {
    "zh-Hans": "未能核对原提议。结果仍待确认，没有重新提交。",
    "zh-Hant": "未能核對原提議。結果仍待確認，沒有重新提交。",
    "en": "The original proposal could not be checked. Its outcome remains unconfirmed; nothing was resubmitted.",
    "ja": "元の提案を確認できませんでした。結果は引き続き確認待ちで、再送信はしていません。"
  },
  "agent.proposal.state.appliedConfirmed": {
    "zh-Hans": "已确认应用此份不可修改的提议。当前保存内容将单独读取，属性面板中未保存的输入仍保留。",
    "zh-Hant": "已確認套用此不可修改的提議。目前儲存內容將另行讀取，屬性面板的未儲存輸入仍會保留。",
    "en": "Application of this immutable proposal is confirmed. Current saved content will be read separately; unsaved Inspector input is retained.",
    "ja": "この変更不可の提案の適用を確認しました。現在の保存内容は別途読み取り、インスペクターの未保存の入力は保持します。"
  },
  "agent.proposal.state.operationBlocked": {
    "zh-Hans": "本次操作被保存服务阻止，不能据此判断较早操作的结果。正在只读核对原提议；不会自动重试。",
    "zh-Hant": "此次操作被儲存服務阻止，不能據此判斷較早操作的結果。正在以唯讀方式核對原提議；不會自動重試。",
    "en": "The save service blocked this operation. That does not establish the outcome of earlier operations. Checking the original proposal read-only; there is no automatic retry.",
    "ja": "保存サービスが今回の操作を拒否しました。それだけでは以前の操作の結果は判断できません。元の提案を読み取り専用で確認しており、自動再試行はしません。"
  },
  "agent.proposal.state.acknowledgementMissing": {
    "zh-Hans": "没有收到操作确认。这不代表已拒绝或未应用；正在只读核对原提议，不会自动重试。",
    "zh-Hant": "未收到操作確認。這不代表已被拒絕或尚未套用；正在以唯讀方式核對原提議，不會自動重試。",
    "en": "No acknowledgement was received. This does not mean the operation was rejected or not applied. The original proposal is being checked read-only; it will not be retried automatically.",
    "ja": "操作の確認応答を受信できませんでした。拒否された、または未適用であることを意味しません。元の提案を読み取り専用で確認しています。自動再試行はしません。"
  },
  "agent.proposal.state.checkTimelineState": {
    "zh-Hans": "请先核对当前时间线状态。",
    "zh-Hant": "請先核對目前的時間軸狀態。",
    "en": "Check the current timeline state first.",
    "ja": "先に現在のタイムラインの状態を確認してください。"
  },
  "agent.move.state.invalidProposal": {
    "zh-Hans": "片段提议的类型或固定差异无效，不能批准。",
    "zh-Hant": "片段提議的類型或固定差異無效，不能批准。",
    "en": "The clip proposal type or fixed diff is invalid and cannot be approved.",
    "ja": "クリップ提案の種類または固定差分が無効なため、承認できません。"
  },
  "agent.move.state.selectMoveScope": {
    "zh-Hans": "请先选择“选中片段移动提议”范围，再核对这份固定差异。",
    "zh-Hant": "請先選擇「所選片段的移動提議」範圍，再核對此固定差異。",
    "en": "Select the “Selected clip move proposal” scope before reviewing this fixed diff.",
    "ja": "先に「選択中クリップの移動提案」の範囲を選び、この固定差分を確認してください。"
  },
  "agent.move.state.selectOriginalClip": {
    "zh-Hans": "请先选中这份提议对应的已保存时间线片段。",
    "zh-Hant": "請先選中此提議對應的已儲存時間軸片段。",
    "en": "Select the saved timeline clip that this proposal targets first.",
    "ja": "先にこの提案の対象となる保存済みタイムラインクリップを選択してください。"
  },
  "agent.move.state.targetMismatch": {
    "zh-Hans": "当前选择或已保存时间线版本与提议不一致。旧提议不会自动重新基于新版本修改。",
    "zh-Hant": "目前選擇或已儲存時間軸版本與提議不一致。舊提議不會自動依新版本修改。",
    "en": "The current selection or saved timeline revision does not match the proposal. The old proposal will not be rebased automatically.",
    "ja": "現在の選択または保存済みタイムラインのリビジョンが提案と一致しません。古い提案を自動で新しいリビジョンに合わせることはありません。"
  },
  "agent.move.state.frameTime": {
    "zh-Hans": "{frame} 帧 / {framefps} 秒",
    "zh-Hant": "{frame} 影格 / {framefps} 秒",
    "en": "{frame} frames / {framefps} seconds",
    "ja": "{frame}フレーム / {framefps}秒"
  },
  "agent.gain.state.checkTimelineState": {
    "zh-Hans": "请先核对当前时间线状态。",
    "zh-Hant": "請先核對目前的時間軸狀態。",
    "en": "Check the current timeline state first.",
    "ja": "先に現在のタイムラインの状態を確認してください。"
  },
  "agent.gain.state.selectGainScope": {
    "zh-Hans": "请先选择“选中片段音量提议”范围，再核对这份固定差异。",
    "zh-Hant": "請先選擇「所選片段的音量提議」範圍，再核對此固定差異。",
    "en": "Select the “Selected clip gain proposal” scope before reviewing this fixed diff.",
    "ja": "先に「選択中クリップの音量提案」の範囲を選び、この固定差分を確認してください。"
  },
  "agent.gain.state.selectOriginalAudioClip": {
    "zh-Hans": "请先选中这份提议对应的已保存有声片段。",
    "zh-Hant": "請先選中此提議對應的已儲存有聲片段。",
    "en": "Select the saved clip with audio that this proposal targets first.",
    "ja": "先にこの提案の対象となる、音声を含む保存済みクリップを選択してください。"
  },
  "agent.gain.state.targetMismatch": {
    "zh-Hans": "当前选择、已保存音量、轨道状态或时间线版本与提议不一致。旧提议不会自动重新基于新版本修改。",
    "zh-Hant": "目前選擇、已儲存音量、軌道狀態或時間軸版本與提議不一致。舊提議不會自動依新版本修改。",
    "en": "The current selection, saved gain, track state, or timeline revision does not match the proposal. The old proposal will not be rebased automatically.",
    "ja": "現在の選択、保存済み音量、トラックの状態、タイムラインのリビジョンが提案と一致しません。古い提案を自動で新しいリビジョンに合わせることはありません。"
  },
  "agent.gain.state.gainValue": {
    "zh-Hans": "{value} ({value2}%){value3}",
    "zh-Hant": "{value} ({value2}%){value3}",
    "en": "{value} ({value2}%){value3}",
    "ja": "{value} ({value2}%){value3}"
  },
  "agent.gain.state.clipMuted": {
    "zh-Hans": " · 此片段静音",
    "zh-Hant": " · 此片段靜音",
    "en": " · This clip is muted",
    "ja": " · このクリップは無音"
  },
  "agent.gain.state.waitForProject": {
    "zh-Hans": "请等待当前项目连接与数据加载完成。",
    "zh-Hant": "請等待目前專案的連線與資料載入完成。",
    "en": "Wait for the current project to connect and finish loading.",
    "ja": "現在のプロジェクトの接続とデータ読み込みが完了するまでお待ちください。"
  },
  "agent.gain.state.resolveDrafts": {
    "zh-Hans": "请先保存或放弃属性面板及已恢复的本地片段草稿，再审阅片段音量。草稿不会自动发送、清除或标记为已保存。",
    "zh-Hant": "請先儲存或放棄屬性面板及已還原的本機片段草稿，再審閱片段音量。草稿不會自動傳送、清除或標示為已儲存。",
    "en": "Save or discard Inspector and recovered local clip drafts before reviewing clip gain. Drafts are not automatically sent, cleared, or marked saved.",
    "ja": "クリップの音量をレビューする前に、インスペクターと復元されたローカルのクリップ下書きを保存または破棄してください。下書きを自動送信、消去、保存済みにすることはありません。"
  },
  "agent.gain.state.pendingTimelineOperation": {
    "zh-Hans": "有时间线操作正在处理或待确认，请先在任务中心核对。",
    "zh-Hant": "有時間軸操作正在處理或待確認，請先在工作中心核對。",
    "en": "A timeline operation is in progress or unconfirmed. Check it in the task center first.",
    "ja": "タイムラインの操作が処理中または確認待ちです。先にタスクセンターで確認してください。"
  },
  "image.state.queued": {
    "zh-Hans": "等待生成",
    "zh-Hant": "等待生成",
    "en": "Waiting to generate",
    "ja": "生成待ち"
  },
  "image.state.dispatching": {
    "zh-Hans": "正在发送",
    "zh-Hant": "正在傳送",
    "en": "Sending",
    "ja": "送信中"
  },
  "image.state.receiving": {
    "zh-Hans": "正在接收图像",
    "zh-Hant": "正在接收圖像",
    "en": "Receiving image",
    "ja": "画像を受信中"
  },
  "image.state.saving": {
    "zh-Hans": "正在保存结果",
    "zh-Hant": "正在儲存結果",
    "en": "Saving result",
    "ja": "結果を保存中"
  },
  "image.state.succeeded": {
    "zh-Hans": "已保存",
    "zh-Hant": "已儲存",
    "en": "Saved",
    "ja": "保存済み"
  },
  "image.state.cancelledBeforeDispatch": {
    "zh-Hans": "发送前已取消",
    "zh-Hant": "傳送前已取消",
    "en": "Cancelled before sending",
    "ja": "送信前にキャンセル済み"
  },
  "image.state.interruptedBeforeDispatch": {
    "zh-Hans": "发送前已中断",
    "zh-Hant": "傳送前已中斷",
    "en": "Interrupted before sending",
    "ja": "送信前に中断"
  },
  "image.state.failed": {
    "zh-Hans": "生成失败",
    "zh-Hant": "生成失敗",
    "en": "Generation failed",
    "ja": "生成に失敗"
  },
  "image.state.outcomeUnknown": {
    "zh-Hans": "服务商结果未知",
    "zh-Hant": "服務商結果未知",
    "en": "Provider outcome unknown",
    "ja": "プロバイダー側の結果不明"
  },
  "image.state.localResultError": {
    "zh-Hans": "本地结果保存失败",
    "zh-Hant": "本機結果儲存失敗",
    "en": "Local result save failed",
    "ja": "ローカル結果の保存に失敗"
  },
  "image.state.statusUnconfirmed": {
    "zh-Hans": "状态待确认",
    "zh-Hant": "狀態待確認",
    "en": "Status unconfirmed",
    "ja": "状態の確認待ち"
  },
  "image.state.interruptedDisclosure": {
    "zh-Hans": "应用重启前尚未发送，不会自动继续。可取消此任务，再明确创建新请求。",
    "zh-Hant": "應用程式重啟前尚未傳送，不會自動繼續。可取消此工作，再明確建立新請求。",
    "en": "This was not sent before the app restarted and will not continue automatically. Cancel this task, then explicitly create a new request.",
    "ja": "アプリの再起動前には未送信で、自動では続行しません。このタスクをキャンセルしてから、明示的に新しいリクエストを作成できます。"
  },
  "image.state.unknownDisclosure": {
    "zh-Hans": "无法确认服务商结果。可明确检查并恢复已落盘的本地结果；没有可核验结果时仍保持未知，绝不重新调用服务商。",
    "zh-Hant": "無法確認服務商結果。可明確檢查並還原已寫入磁碟的本機結果；沒有可核驗結果時仍維持未知，絕不再次呼叫服務商。",
    "en": "The provider outcome cannot be confirmed. Explicitly check and recover local results already written to disk. Without a verifiable result, the outcome stays unknown. The provider is never called again.",
    "ja": "プロバイダー側の結果を確認できません。ディスクに書き込まれたローカル結果を明示的に確認して復元できます。検証可能な結果がなければ不明のままとし、プロバイダーを再度呼び出すことはありません。"
  },
  "image.state.localRecoveryDisclosure": {
    "zh-Hans": "已有本地结果待恢复。恢复只处理同一份结果，不再次生成。",
    "zh-Hant": "已有本機結果待還原。還原只處理同一份結果，不會再次生成。",
    "en": "A local result is awaiting recovery. Recovery handles only that same result and does not generate again.",
    "ja": "復元待ちのローカル結果があります。復元は同じ結果だけを処理し、再生成はしません。"
  },
  "image.state.cancellationConfirmed": {
    "zh-Hans": "已确认在发送前取消，没有启动生成。",
    "zh-Hant": "已確認在傳送前取消，未啟動生成。",
    "en": "Cancellation before sending is confirmed. Generation did not start.",
    "ja": "送信前のキャンセルを確認しました。生成は開始していません。"
  },
  "image.state.requestEnded": {
    "zh-Hans": "此请求已结束。查看记录后，可明确创建新的生成请求。",
    "zh-Hant": "此請求已結束。查看記錄後，可明確建立新的生成請求。",
    "en": "This request has ended. After reviewing the record, you may explicitly create a new generation request.",
    "ja": "このリクエストは終了しました。記録を確認した後、明示的に新しい生成リクエストを作成できます。"
  },
  "image.state.customNetworkDenied": {
    "zh-Hans": "发送前网络检查未通过。请检查自定义地址是否指向允许访问的 HTTPS 公网服务，再准备新的请求。",
    "zh-Hant": "傳送前的網路檢查未通過。請確認自訂地址是否指向允許存取的 HTTPS 公網服務，再準備新請求。",
    "en": "The pre-send network check failed. Check that the custom URL points to an allowed public HTTPS service, then prepare a new request.",
    "ja": "送信前のネットワーク確認に失敗しました。カスタムURLが許可された公開 HTTPS サービスを指しているか確認してから、新しいリクエストを準備してください。"
  },
  "image.state.customConnectionFailed": {
    "zh-Hans": "发送前无法建立连接。请检查自定义地址和服务状态，再准备新的请求。",
    "zh-Hant": "傳送前無法建立連線。請檢查自訂地址與服務狀態，再準備新請求。",
    "en": "A connection could not be established before sending. Check the custom URL and service status, then prepare a new request.",
    "ja": "送信前に接続を確立できませんでした。カスタムURLとサービスの状態を確認してから、新しいリクエストを準備してください。"
  },
  "image.state.customTimeout": {
    "zh-Hans": "发送前连接检查超时。请检查自定义服务是否可用，再准备新的请求。",
    "zh-Hant": "傳送前的連線檢查逾時。請確認自訂服務是否可用，再準備新請求。",
    "en": "The pre-send connection check timed out. Check custom service availability, then prepare a new request.",
    "ja": "送信前の接続確認がタイムアウトしました。カスタムサービスを利用できるか確認してから、新しいリクエストを準備してください。"
  },
  "image.state.customDispatchBlocked": {
    "zh-Hans": "发送前安全检查未通过。请重新读取并核对自定义连接设置，再准备新的请求。",
    "zh-Hant": "傳送前的安全檢查未通過。請重新讀取並核對自訂連線設定，再準備新請求。",
    "en": "The pre-send safety check failed. Reload and review custom connection settings, then prepare a new request.",
    "ja": "送信前の安全確認に失敗しました。カスタム接続設定を再読み込みして確認してから、新しいリクエストを準備してください。"
  },
  "image.state.customSettingsConflict": {
    "zh-Hans": "自定义连接在发送前已变化。请读取当前地址、模型与配置版本，再准备新的请求。",
    "zh-Hant": "自訂連線在傳送前已變更。請讀取目前地址、模型與設定版本，再準備新請求。",
    "en": "The custom connection changed before sending. Read the current URL, model, and configuration revision, then prepare a new request.",
    "ja": "送信前にカスタム接続が変わりました。現在のURL、モデル、設定リビジョンを読み取ってから、新しいリクエストを準備してください。"
  },
  "image.state.customUnconfigured": {
    "zh-Hans": "自定义连接缺少完整设置或可用密钥。请检查连接设置并重新输入此连接的密钥，再准备新的请求。",
    "zh-Hant": "自訂連線缺少完整設定或可用密鑰。請檢查連線設定，並重新輸入此連線的密鑰，再準備新請求。",
    "en": "The custom connection lacks complete settings or a usable key. Check connection settings and re-enter this connection’s key, then prepare a new request.",
    "ja": "カスタム接続の設定が不完全か、有効なキーがありません。接続設定を確認してこの接続のキーを再入力してから、新しいリクエストを準備してください。"
  },
  "image.state.customDisabled": {
    "zh-Hans": "自定义连接已停用。请在图像设置中确认是否启用，再准备新的请求。",
    "zh-Hant": "自訂連線已停用。請在圖像設定中確認是否啟用，再準備新請求。",
    "en": "The custom connection is disabled. Decide whether to enable it in image settings, then prepare a new request.",
    "ja": "カスタム接続が無効です。画像設定で有効にするか確認してから、新しいリクエストを準備してください。"
  },
  "image.state.customNotDispatched": {
    "zh-Hans": "{value}本次未发送生成 POST；任何新请求都需要重新明确批准，不会自动重试。",
    "zh-Hant": "{value}此次未傳送生成 POST；任何新請求都須重新明確批准，不會自動重試。",
    "en": "{value} No generation POST was sent. Any new request requires fresh explicit approval; there is no automatic retry.",
    "ja": "{value} 生成 POST は送信していません。新しいリクエストには改めて明示的な承認が必要で、自動再試行はしません。"
  },
  "image.state.sourceRejected": {
    "zh-Hans": "源图未通过后端核验，本次未被接受。仅支持当前项目的完整、不透明、8 位非交错 PNG；最多 8 MiB，每边最多 1024 像素。",
    "zh-Hant": "來源圖片未通過後端核驗，此次未被接受。僅支援目前專案的完整、不透明、8 位元、非交錯 PNG；最多 8 MiB，每邊最多 1024 像素。",
    "en": "The source image failed backend verification and this request was not accepted. Only complete, opaque, 8-bit, non-interlaced PNGs in this project are supported, up to 8 MiB and 1024 pixels per edge.",
    "ja": "ソース画像がバックエンド検証を通過せず、今回のリクエストは受け付けられませんでした。現在のプロジェクトの完全な不透明・8ビット・非インターレース PNG のみ対応し、最大8 MiB、各辺最大1024ピクセルです。"
  },
  "image.state.liveDisabled": {
    "zh-Hans": "真实图像调用尚未启用，本次未被接受。",
    "zh-Hant": "實際圖像呼叫尚未啟用，此次未被接受。",
    "en": "Live image calls are not enabled; this request was not accepted.",
    "ja": "実際の画像呼び出しが有効でないため、今回のリクエストは受け付けられませんでした。"
  },
  "image.state.groupBusy": {
    "zh-Hans": "此组有未结束或结果未知的任务，本次未被接受。请查看原任务。",
    "zh-Hant": "此組有未完成或結果未知的工作，此次未被接受。請查看原工作。",
    "en": "This group has an unfinished task or an unknown outcome. This request was not accepted. Check the original task.",
    "ja": "このグループには未完了または結果不明のタスクがあるため、今回のリクエストは受け付けられませんでした。元のタスクを確認してください。"
  },
  "image.state.revisionConflict": {
    "zh-Hans": "图像组或任务的状态已变化，本次未被接受。请重新读取并明确选择目标。",
    "zh-Hant": "圖像組或工作的狀態已變更，此次未被接受。請重新讀取並明確選擇目標。",
    "en": "The image group or task state changed; this request was not accepted. Reload and explicitly select the target.",
    "ja": "画像グループまたはタスクの状態が変わり、今回のリクエストは受け付けられませんでした。再読み込みして対象を明示的に選択してください。"
  },
  "image.state.queueFull": {
    "zh-Hans": "本地图像队列已满，本次未被接受。草稿保留，可稍后明确提交。",
    "zh-Hant": "本機圖像佇列已滿，此次未被接受。草稿會保留，可稍後明確提交。",
    "en": "The local image queue is full; this request was not accepted. Your draft is retained and can be submitted explicitly later.",
    "ja": "ローカルの画像キューが満杯で、今回のリクエストは受け付けられませんでした。下書きは保持し、後で明示的に送信できます。"
  },
  "image.state.capacityReached": {
    "zh-Hans": "本地图像记录容量已满，本次未被接受。草稿保留。",
    "zh-Hant": "本機圖像記錄容量已滿，此次未被接受。草稿會保留。",
    "en": "Local image record capacity is full; this request was not accepted. Your draft is retained.",
    "ja": "ローカルの画像記録が容量上限に達し、今回のリクエストは受け付けられませんでした。下書きは保持します。"
  },
  "image.state.stateConflict": {
    "zh-Hans": "当前任务或图像组不允许此操作，本次未被接受。请重新读取。",
    "zh-Hant": "目前工作或圖像組不允許此操作，此次未被接受。請重新讀取。",
    "en": "The current task or image group does not allow this operation. It was not accepted. Reload the records.",
    "ja": "現在のタスクまたは画像グループではこの操作を許可していないため、受け付けられませんでした。再読み込みしてください。"
  },
  "image.state.invalidLocalResult": {
    "zh-Hans": "未找到可完整核验的本地结果，本次恢复未被接受。原任务保留，不会重新生成。",
    "zh-Hant": "找不到可完整核驗的本機結果，此次還原未被接受。原工作會保留，不會重新生成。",
    "en": "No fully verifiable local result was found, so recovery was not accepted. The original task is retained; there is no regeneration.",
    "ja": "完全に検証できるローカル結果が見つからず、復元は受け付けられませんでした。元のタスクは保持し、再生成はしません。"
  },
  "image.state.notAcceptedFallback": {
    "zh-Hans": "请求未被接受，草稿保留。请重新读取并核对后再提交。",
    "zh-Hant": "請求未被接受，草稿會保留。請重新讀取並核對後再提交。",
    "en": "The request was not accepted; your draft is retained. Reload and review before submitting.",
    "ja": "リクエストは受け付けられませんでした。下書きは保持します。再読み込みして確認してから送信してください。"
  },
  "image.state.nameRequired": {
    "zh-Hans": "请填写图像名称。",
    "zh-Hant": "請填寫圖像名稱。",
    "en": "Enter an image name.",
    "ja": "画像名を入力してください。"
  },
  "image.state.nameLimit": {
    "zh-Hans": "名称最多 120 个字符。",
    "zh-Hant": "名稱最多 120 個字元。",
    "en": "Names may contain up to 120 characters.",
    "ja": "名前は最大120文字です。"
  },
  "image.state.promptRequired": {
    "zh-Hans": "请填写图像描述。",
    "zh-Hant": "請填寫圖像描述。",
    "en": "Enter an image description.",
    "ja": "画像の説明を入力してください。"
  },
  "image.state.promptLimit": {
    "zh-Hans": "描述最多 {promptCharacters} 个字符。",
    "zh-Hant": "描述最多 {promptCharacters} 個字元。",
    "en": "Descriptions may contain up to {promptCharacters} characters.",
    "ja": "説明は最大{promptCharacters}文字です。"
  },
  "image.state.promptControlCharacters": {
    "zh-Hans": "描述中含有不支持的控制字符。",
    "zh-Hant": "描述含有不支援的控制字元。",
    "en": "The description contains unsupported control characters.",
    "ja": "説明に未対応の制御文字が含まれています。"
  },
  "image.state.invalidAssetIdentity": {
    "zh-Hans": "素材身份或所属项目无效。",
    "zh-Hant": "素材身份或所屬專案無效。",
    "en": "The asset identity or project ownership is invalid.",
    "ja": "素材の識別情報または所属プロジェクトが無効です。"
  },
  "image.state.pngOnly": {
    "zh-Hans": "仅支持 PNG。",
    "zh-Hant": "僅支援 PNG。",
    "en": "Only PNG is supported.",
    "ja": "PNG のみに対応します。"
  },
  "image.state.unsupportedSourceOrigin": {
    "zh-Hans": "此素材来源不支持图像编辑。",
    "zh-Hant": "此素材來源不支援圖像編輯。",
    "en": "This asset origin is not supported for image editing.",
    "ja": "この素材の由来は画像編集に対応していません。"
  },
  "image.state.sourceByteLimit": {
    "zh-Hans": "PNG 必须不超过 8 MiB。",
    "zh-Hant": "PNG 不得超過 8 MiB。",
    "en": "PNG files must not exceed 8 MiB.",
    "ja": "PNG は8 MiB以下である必要があります。"
  },
  "image.state.sourceDimensions": {
    "zh-Hans": "每边最多 1024 像素，总计最多 1,048,576 像素。",
    "zh-Hant": "每邊最多 1024 像素，總計最多 1,048,576 像素。",
    "en": "At most 1024 pixels per edge and 1,048,576 pixels total.",
    "ja": "各辺は最大1024ピクセル、合計は最大1,048,576ピクセルです。"
  },
  "image.state.editProvidersOnly": {
    "zh-Hans": "图像编辑仅支持 Mock 和 OpenAI 官方连接。",
    "zh-Hant": "圖像編輯僅支援 Mock 與 OpenAI 官方連線。",
    "en": "Image editing supports only Mock and the official OpenAI connection.",
    "ja": "画像編集は Mock と OpenAI 公式接続のみに対応します。"
  },
  "image.state.sourceRequired": {
    "zh-Hans": "请选择当前项目的一张 PNG 源图。",
    "zh-Hant": "請選擇目前專案的一張 PNG 來源圖片。",
    "en": "Select a PNG source image from this project.",
    "ja": "現在のプロジェクトから PNG ソース画像を1枚選択してください。"
  },
  "image.state.reviewRecordUnverifiable": {
    "zh-Hans": "无法核验本地审批记录，本次不会继续发送。请重新打开面板后核对。",
    "zh-Hant": "無法核驗本機批准記錄，此次不會繼續傳送。請重新開啟面板後核對。",
    "en": "The local approval record cannot be verified. Sending will not continue. Reopen the panel and check.",
    "ja": "ローカルの承認記録を検証できないため、送信を続けません。パネルを開き直して確認してください。"
  },
  "image.state.requestRecordUpdateFailed": {
    "zh-Hans": "原请求已确认，但无法更新本地请求记录。请重新打开面板后核对。",
    "zh-Hant": "原請求已確認，但無法更新本機請求記錄。請重新開啟面板後核對。",
    "en": "The original request is confirmed, but its local record could not be updated. Reopen the panel and check.",
    "ja": "元のリクエストは確認できましたが、ローカル記録を更新できませんでした。パネルを開き直して確認してください。"
  },
  "image.state.requestStorageBlocked": {
    "zh-Hans": "无法读取本地请求记录。为避免重复生成，暂不能提交。",
    "zh-Hant": "無法讀取本機請求記錄。為避免重複生成，目前無法提交。",
    "en": "Local request records cannot be read. Submissions are blocked to avoid duplicate generation.",
    "ja": "ローカルのリクエスト記録を読み取れません。重複生成を避けるため、送信を停止しています。"
  },
  "image.state.originalRejected": {
    "zh-Hans": "原请求已被拒绝，没有重新生成。",
    "zh-Hant": "原請求已被拒絕，沒有重新生成。",
    "en": "The original request was rejected. There was no regeneration.",
    "ja": "元のリクエストは拒否されました。再生成はしていません。"
  },
  "image.state.waitingForApproval": {
    "zh-Hans": "原始描述仍在等待审批。只有明确点击批准才会发送，不会自动继续。",
    "zh-Hant": "原始描述仍在等待批准。只有明確按下批准才會傳送，不會自動繼續。",
    "en": "The original description is still awaiting approval. It is sent only after explicit approval; it will not continue automatically.",
    "ja": "元の説明は承認待ちです。明示的に承認した場合だけ送信し、自動では続行しません。"
  },
  "image.state.sourceUnknownHeld": {
    "zh-Hans": "源图核验报告问题。请核对 PNG 是否不透明、8 位、非交错、最多 8 MiB 且每边不超过 1024 像素，并重新读取原请求。原请求结果仍未知，原始标识已保留；为避免重复任务，本项目暂不能提交新图像请求，不会自动重发。",
    "zh-Hant": "來源圖片核驗發現問題。請確認 PNG 為不透明、8 位元、非交錯、最多 8 MiB 且每邊不超過 1024 像素，再重新讀取原請求。原請求結果仍未知，原標識已保留；為避免重複工作，此專案目前不能提交新圖像請求，不會自動重送。",
    "en": "Source verification reported a problem. Check that the PNG is opaque, 8-bit, non-interlaced, at most 8 MiB and 1024 pixels per edge, then reload the original request. Its outcome remains unknown and its original identity is retained. New image submissions are blocked for this project to avoid duplicates; there is no automatic resend.",
    "ja": "ソース画像の検証で問題が報告されました。PNG が不透明、8ビット、非インターレース、8 MiB以下、各辺1024ピクセル以下であることを確認し、元のリクエストを再読み込みしてください。元の結果は不明のままで、識別情報を保持しています。重複タスクを避けるため、このプロジェクトでは新しい画像リクエストを送信できません。自動再送はしません。"
  },
  "image.state.comfyPreparationUnknown": {
    "zh-Hans": "尚未确认本地运行准备结果；没有批准运行。请重新读取，或明确放弃此未批准请求。",
    "zh-Hant": "本機執行的準備結果尚未確認，沒有批准執行。請重新讀取，或明確放棄此未批准請求。",
    "en": "Local run preparation is unconfirmed; running was not approved. Reload or explicitly abandon this unapproved request.",
    "ja": "ローカル実行の準備結果は未確認で、実行は承認していません。再読み込みするか、この未承認リクエストを明示的に破棄してください。"
  },
  "image.state.paidPreparationUnknown": {
    "zh-Hans": "尚未确认审批准备结果；没有发起付费审批。请重新读取，或明确放弃此未批准请求。",
    "zh-Hant": "批准準備的結果尚未確認，沒有發起付費批准。請重新讀取，或明確放棄此未批准請求。",
    "en": "Approval preparation is unconfirmed; paid approval was not started. Reload or explicitly abandon this unapproved request.",
    "ja": "承認準備の結果は未確認で、有料処理の承認は開始していません。再読み込みするか、この未承認リクエストを明示的に破棄してください。"
  },
  "image.state.originalNotFoundUnknown": {
    "zh-Hans": "尚未找到原请求的确认记录。这不能证明请求未被接受；请继续核对，不要重复生成。",
    "zh-Hant": "尚未找到原請求的確認記錄。這不能證明請求未被接受；請繼續核對，不要重複生成。",
    "en": "No confirmation record for the original request has been found. This does not prove it was not accepted. Keep checking; do not generate again.",
    "ja": "元のリクエストの確認記録はまだ見つかりません。未受付の証拠にはなりません。確認を続け、重複して生成しないでください。"
  },
  "image.state.originalFound": {
    "zh-Hans": "已找到原请求，没有重新生成。",
    "zh-Hant": "已找到原請求，沒有重新生成。",
    "en": "The original request was found. There was no regeneration.",
    "ja": "元のリクエストが見つかりました。再生成はしていません。"
  },
  "image.state.settingsUnverifiable": {
    "zh-Hans": "暂时无法核验图像设置。付费生成已暂停，Mock 与已保存记录仍可使用。",
    "zh-Hant": "目前無法核驗圖像設定。付費生成已暫停，仍可使用 Mock 與已儲存記錄。",
    "en": "Image settings cannot be verified right now. Paid generation is paused; Mock and saved records remain available.",
    "ja": "画像設定を現在検証できません。有料生成を停止していますが、Mock と保存済みの記録は利用できます。"
  },
  "image.state.remoteIdentityReadFailed": {
    "zh-Hans": "暂时无法读取此任务的本地远端身份记录。没有查询 ComfyUI 或重新提交生成。",
    "zh-Hant": "目前無法讀取此工作的本機遠端身份記錄。沒有查詢 ComfyUI，也沒有重新提交生成。",
    "en": "The local remote-identity record for this task cannot be read right now. ComfyUI was not queried and generation was not resubmitted.",
    "ja": "このタスクのローカルのリモート識別記録を現在読み取れません。ComfyUI への照会も、生成の再送信もしていません。"
  },
  "image.state.originalOutcomeUnconfirmed": {
    "zh-Hans": "原请求的结果仍待确认。只会重新读取本地记录，不会自动重发。",
    "zh-Hant": "原請求結果仍待確認。只會重新讀取本機記錄，不會自動重送。",
    "en": "The original request’s outcome remains unconfirmed. Only local records are reloaded; there is no automatic resend.",
    "ja": "元のリクエストの結果は引き続き確認待ちです。ローカル記録を再読み込みするだけで、自動再送はしません。"
  },
  "image.state.recordsUnavailable": {
    "zh-Hans": "暂时无法读取图像记录。草稿保留，可重新读取。",
    "zh-Hant": "目前無法讀取圖像記錄。草稿會保留，可重新讀取。",
    "en": "Image records cannot be read right now. Your draft is retained; try reloading.",
    "ja": "画像記録を現在読み取れません。下書きは保持しています。再読み込みできます。"
  },
  "image.state.receiptSaveFailed": {
    "zh-Hans": "无法保存本地请求凭据，本次尚未发送。请恢复页面存储后再试。",
    "zh-Hant": "無法儲存本機請求憑據，此次尚未傳送。請恢復頁面儲存後再試。",
    "en": "The local request receipt could not be saved. Nothing has been sent. Restore page storage before trying again.",
    "ja": "ローカルのリクエスト記録を保存できず、まだ送信していません。ページのストレージを復旧してから再試行してください。"
  },
  "image.state.mockEditSaved": {
    "zh-Hans": "请求已保存。Mock 编辑只生成静态测试卡片，不会实际修改源图。",
    "zh-Hant": "請求已儲存。Mock 編輯只生成靜態測試卡，不會實際修改來源圖片。",
    "en": "Request saved. Mock editing generates only a static test card and does not edit the source image.",
    "ja": "リクエストを保存しました。Mock 編集は静的なテストカードを生成するだけで、ソース画像を実際には編集しません。"
  },
  "image.state.mockGenerationSaved": {
    "zh-Hans": "请求已保存。Mock 仅生成确定性测试图案。",
    "zh-Hant": "請求已儲存。Mock 僅生成確定性的測試圖案。",
    "en": "Request saved. Mock generates deterministic test patterns only.",
    "ja": "リクエストを保存しました。Mock は決定的なテストパターンのみを生成します。"
  },
  "image.state.operationConfirmed": {
    "zh-Hans": "操作已确认。",
    "zh-Hant": "操作已確認。",
    "en": "Operation confirmed.",
    "ja": "操作を確認しました。"
  },
  "image.state.sourceIssueUnknown": {
    "zh-Hans": "源图核验报告问题。原请求结果仍未知，原始标识已保留；请重新读取核对，不会重发。",
    "zh-Hant": "來源圖片核驗發現問題。原請求結果仍未知，原標識已保留；請重新讀取核對，不會重送。",
    "en": "Source verification reported a problem. The original outcome is still unknown and its identity is retained. Reload to check; it will not be resent.",
    "ja": "ソース画像の検証で問題が報告されました。元の結果は不明のままで、識別情報を保持しています。再読み込みして確認してください。再送はしません。"
  },
  "image.state.acceptanceUnconfirmed": {
    "zh-Hans": "尚未确认原请求是否已接受。正在核对本地记录，不会重新生成。",
    "zh-Hant": "尚未確認原請求是否已接受。正在核對本機記錄，不會重新生成。",
    "en": "Acceptance of the original request is unconfirmed. Checking local records without regenerating.",
    "ja": "元のリクエストが受け付けられたかは未確認です。ローカル記録を確認しており、再生成はしません。"
  },
  "image.state.comfyRunSaved": {
    "zh-Hans": "本地运行请求已保存。最多提交一次；关闭面板不会取消远端 GPU 工作。",
    "zh-Hant": "本機執行請求已儲存。最多提交一次；關閉面板不會取消遠端 GPU 工作。",
    "en": "Local run request saved. It is submitted at most once. Closing the panel does not cancel remote GPU work.",
    "ja": "ローカル実行リクエストを保存しました。送信は最大1回です。パネルを閉じてもリモートのGPU処理はキャンセルされません。"
  },
  "image.state.paidRequestSaved": {
    "zh-Hans": "付费请求已保存。最多发送一次，不会自动重试。",
    "zh-Hant": "付費請求已儲存。最多傳送一次，不會自動重試。",
    "en": "Paid request saved. It is sent at most once, without automatic retry.",
    "ja": "有料リクエストを保存しました。送信は最大1回で、自動再試行はしません。"
  },
  "image.state.editApprovalSourceInvalid": {
    "zh-Hans": "源图无法通过当前后端核验。此审批不能继续发送；请重新读取原请求，并明确拒绝仍待批准的审批后再选择源图。不会自动重试。",
    "zh-Hant": "來源圖片未通過目前後端的核驗，此批准無法繼續傳送。請重新讀取原請求，並明確拒絕仍待批准的記錄後再選擇來源圖片。不會自動重試。",
    "en": "The source image failed current backend verification, so this approval cannot proceed to sending. Reload the original request and explicitly reject any pending approval before selecting a source again. There is no automatic retry.",
    "ja": "ソース画像が現在のバックエンド検証を通過しないため、この承認で送信を続行できません。元のリクエストを再読み込みし、承認待ちのものを明示的に拒否してから、ソース画像を選び直してください。自動再試行はしません。"
  },
  "image.state.comfyApprovalUnknown": {
    "zh-Hans": "尚未确认本地运行审批结果。只读取原请求，不会自动重新批准、提交或查询远端。",
    "zh-Hant": "本機執行的批准結果尚未確認。只會讀取原請求，不會自動重新批准、提交或查詢遠端。",
    "en": "Local run approval is unconfirmed. Only the original request is read; it will not be automatically approved, submitted, or queried remotely again.",
    "ja": "ローカル実行の承認結果は未確認です。元のリクエストを読み取るだけで、自動で再承認、再送信、リモート照会は行いません。"
  },
  "image.state.paidApprovalUnknown": {
    "zh-Hans": "尚未确认付费审批结果。只会读取原请求，不会自动重新批准或生成。",
    "zh-Hant": "付費批准的結果尚未確認。只會讀取原請求，不會自動重新批准或生成。",
    "en": "Paid approval is unconfirmed. Only the original request is read; it will not be approved again or regenerated automatically.",
    "ja": "有料処理の承認結果は未確認です。元のリクエストを読み取るだけで、自動で再承認や再生成は行いません。"
  },
  "image.state.paidAuthorizationChanged": {
    "zh-Hans": "描述或连接配置已变化。请核对当前完整地址、模型与配置版本后重新点击付费生成。",
    "zh-Hant": "描述或連線設定已變更。請核對目前的完整地址、模型與設定版本，再重新按下付費生成。",
    "en": "The description or connection configuration changed. Review the complete current URL, model, and configuration revision, then choose paid generation again.",
    "ja": "説明または接続設定が変わりました。現在の完全なURL、モデル、設定リビジョンを確認してから、再度有料生成を選択してください。"
  },
  "image.state.paidRequestSaveFailed": {
    "zh-Hans": "无法保存原始付费请求，本次尚未发送。",
    "zh-Hant": "無法儲存原始付費請求，此次尚未傳送。",
    "en": "The original paid request could not be saved. Nothing has been sent.",
    "ja": "元の有料リクエストを保存できませんでした。まだ送信していません。"
  },
  "image.state.preparedScopeChanged": {
    "zh-Hans": "审批内容已保存。页面或配置已变化，请回到原请求并重新明确批准；不会自动发送。",
    "zh-Hant": "批准內容已儲存。頁面或設定已變更，請回到原請求重新明確批准；不會自動傳送。",
    "en": "Approval content is saved. The page or configuration changed. Return to the original request and explicitly approve again; it will not send automatically.",
    "ja": "承認内容を保存しました。ページまたは設定が変わったため、元のリクエストに戻って改めて明示的に承認してください。自動送信はしません。"
  },
  "image.state.editPrepared": {
    "zh-Hans": "源图已通过后端核验，编辑请求已准备。请核对下方固定源图、完整描述和发送目标，再单独批准；目前未发送。",
    "zh-Hant": "來源圖片已通過後端核驗，編輯請求已準備。請核對下方固定來源圖片、完整描述與傳送目標，再另行批准；目前尚未傳送。",
    "en": "The source image passed backend verification and the edit request is prepared. Review the fixed source, full description, and destination below, then approve separately. Nothing has been sent.",
    "ja": "ソース画像がバックエンド検証を通過し、編集リクエストを準備しました。下の固定ソース画像、説明全文、送信先を確認してから、別途承認してください。まだ送信していません。"
  },
  "image.state.preparationSourceInvalid": {
    "zh-Hans": "源图未通过后端核验。原始准备请求仍保留，尚未批准或发送。请重新读取；没有已保存审批时，可明确放弃此未批准请求后重新选择源图。",
    "zh-Hant": "來源圖片未通過後端核驗。原始準備請求仍保留，尚未批准或傳送。請重新讀取；沒有已儲存批准記錄時，可明確放棄此未批准請求後重新選擇來源圖片。",
    "en": "The source image failed backend verification. The original preparation request is retained and has not been approved or sent. Reload. If no saved approval exists, explicitly abandon this unapproved request before selecting another source.",
    "ja": "ソース画像がバックエンド検証を通過しませんでした。元の準備リクエストは保持し、承認も送信もしていません。再読み込みしてください。保存済みの承認がない場合は、この未承認リクエストを明示的に破棄してからソース画像を選び直せます。"
  },
  "image.state.paidPreparationPending": {
    "zh-Hans": "审批准备结果待核对。尚未发起付费审批，不会自动重试。",
    "zh-Hant": "批准準備的結果待核對。尚未發起付費批准，不會自動重試。",
    "en": "Approval preparation awaits verification. Paid approval has not started; there is no automatic retry.",
    "ja": "承認準備の結果は確認待ちです。有料処理の承認は開始しておらず、自動再試行はしません。"
  },
  "image.state.comfyReceiptSaveFailed": {
    "zh-Hans": "无法保存本地运行请求凭据，没有准备或发送生成。",
    "zh-Hant": "無法儲存本機執行的請求憑據，沒有準備或傳送生成。",
    "en": "The local-run request receipt could not be saved. Generation was neither prepared nor sent.",
    "ja": "ローカル実行のリクエスト記録を保存できませんでした。生成の準備も送信もしていません。"
  },
  "image.state.comfyPrepared": {
    "zh-Hans": "本地运行请求已准备。请核对下方实际地址、种子和完整冻结工作流，再单独批准；目前未发送生成。",
    "zh-Hant": "本機執行請求已準備。請核對下方實際地址、種子及完整固定工作流程，再另行批准；目前尚未傳送生成。",
    "en": "The local run request is prepared. Review the actual URL, seed, and complete frozen workflow below, then approve separately. Generation has not been sent.",
    "ja": "ローカル実行リクエストを準備しました。下の実際のURL、シード、固定ワークフロー全体を確認してから、別途承認してください。生成はまだ送信していません。"
  },
  "image.state.comfyPreparationPending": {
    "zh-Hans": "准备结果待核对。尚未批准运行，不会自动重试。请重新读取已保存审批。",
    "zh-Hant": "準備結果待核對。尚未批准執行，不會自動重試。請重新讀取已儲存的批准記錄。",
    "en": "Preparation awaits verification. Running has not been approved; there is no automatic retry. Reload saved approvals.",
    "ja": "準備結果は確認待ちです。実行は承認しておらず、自動再試行はしません。保存済みの承認を再読み込みしてください。"
  },
  "image.state.historicalPromptLoaded": {
    "zh-Hans": "已载入历史描述。这是按描述重新生成，不会读取旧图；点击生成才会创建此组的新版本。",
    "zh-Hant": "已載入歷史描述。這是依描述重新生成，不會讀取舊圖；按下生成才會建立此組的新版本。",
    "en": "The historical description is loaded. This regenerates from the description without reading the old image. A new group version is created only when you choose Generate.",
    "ja": "過去の説明を読み込みました。これは説明に基づく再生成で、古い画像は読み取りません。「生成」を選択したときだけ、このグループの新しいバージョンを作成します。"
  },
  "image.state.historicalPromptUnavailable": {
    "zh-Hans": "无法读取此组的原始描述，未改变草稿。",
    "zh-Hant": "無法讀取此組的原始描述，未變更草稿。",
    "en": "The group’s original description could not be read. The draft was not changed.",
    "ja": "このグループの元の説明を読み取れませんでした。下書きは変更していません。"
  },
  "image.state.fixedEditLoaded": {
    "zh-Hans": "已载入这份固定编辑请求。请核对源图、描述与发送目标，再单独批准。",
    "zh-Hant": "已載入此固定編輯請求。請核對來源圖片、描述與傳送目標，再另行批准。",
    "en": "This fixed edit request is loaded. Review the source image, description, and destination, then approve separately.",
    "ja": "この固定編集リクエストを読み込みました。ソース画像、説明、送信先を確認してから、別途承認してください。"
  },
  "image.state.approvalRequestSaveFailed": {
    "zh-Hans": "无法保存原始审批请求，本次未发送。",
    "zh-Hant": "無法儲存原始批准請求，此次未傳送。",
    "en": "The original approval request could not be saved. Nothing was sent.",
    "ja": "元の承認リクエストを保存できませんでした。送信はしていません。"
  },
  "image.state.requestRejected": {
    "zh-Hans": "已拒绝此原始请求，不会生成图像。",
    "zh-Hant": "已拒絕此原始請求，不會生成圖像。",
    "en": "This original request was rejected. No image will be generated.",
    "ja": "この元のリクエストを拒否しました。画像は生成しません。"
  },
  "image.state.rejectionUnknown": {
    "zh-Hans": "拒绝结果待确认。只会重新读取，不会自动重试。",
    "zh-Hant": "拒絕結果待確認。只會重新讀取，不會自動重試。",
    "en": "Rejection is unconfirmed. Only records are reloaded; there is no automatic retry.",
    "ja": "拒否の結果は確認待ちです。再読み込みするだけで、自動再試行はしません。"
  },
  "image.state.unapprovedAbandoned": {
    "zh-Hans": "已放弃本页尚未批准的请求。若准备记录随后出现，仍需明确批准或拒绝。",
    "zh-Hant": "已放棄本頁尚未批准的請求。若準備記錄稍後出現，仍須明確批准或拒絕。",
    "en": "The unapproved request on this page was abandoned. If a preparation record appears later, it still requires explicit approval or rejection.",
    "ja": "このページの未承認リクエストを破棄しました。準備記録が後から現れた場合も、明示的な承認または拒否が必要です。"
  },
  "image.comfy.observation.recordUnverifiable": {
    "zh-Hans": "无法核验本地查询记录。请重新打开面板后核对；没有重新提交生成。",
    "zh-Hant": "無法核驗本機查詢記錄。請重新開啟面板後核對；沒有重新提交生成。",
    "en": "The local query record cannot be verified. Reopen the panel and check; generation was not resubmitted.",
    "ja": "ローカルの照会記録を検証できません。パネルを開き直して確認してください。生成は再送信していません。"
  },
  "image.comfy.observation.receiptSaveFailed": {
    "zh-Hans": "无法保存本地查询凭据。没有发起远端查询。",
    "zh-Hant": "無法儲存本機查詢憑據。沒有發起遠端查詢。",
    "en": "The local query receipt could not be saved. No remote query was started.",
    "ja": "ローカルの照会記録を保存できませんでした。リモート照会は開始していません。"
  },
  "image.comfy.observation.accepted": {
    "zh-Hans": "此查询已接受。只读取保存的生成身份并按证据取回结果，不提交新的生成。",
    "zh-Hant": "此查詢已被接受。僅讀取已儲存的生成身份，並依證據取回結果，不提交新生成。",
    "en": "This query was accepted. It reads only the saved generation identity and retrieves results based on evidence; it does not submit new generation.",
    "ja": "この照会は受け付けられました。保存済みの生成識別情報だけを読み取り、証拠に基づいて結果を取得します。新しい生成は送信しません。"
  },
  "image.comfy.observation.notAccepted": {
    "zh-Hans": "此次查询未被接受，查询凭据已核对。请读取当前状态后再明确查询；没有自动重试或提交生成。",
    "zh-Hant": "此次查詢未被接受，查詢憑據已核對。請讀取目前狀態後再明確查詢；沒有自動重試或提交生成。",
    "en": "This query was not accepted, and its receipt was checked. Read the current state before explicitly querying again. There was no automatic retry or generation submission.",
    "ja": "今回の照会は受け付けられず、照会記録を確認しました。現在の状態を読み取ってから、明示的に再照会してください。自動再試行や生成の送信はしていません。"
  },
  "image.comfy.observation.acceptanceUnknown": {
    "zh-Hans": "查询是否已接受仍待确认。保留同一个查询标识；重新读取只核对本地记录，不会重提生成。",
    "zh-Hant": "查詢是否被接受仍待確認。同一查詢標識會保留；重新讀取只核對本機記錄，不會重新提交生成。",
    "en": "Query acceptance remains unconfirmed. The same query identity is retained. Reloading only checks local records and does not resubmit generation.",
    "ja": "照会が受け付けられたかは確認待ちです。同じ照会識別情報を保持します。再読み込みはローカル記録を確認するだけで、生成は再送信しません。"
  }
} as const satisfies MessageCatalog;
