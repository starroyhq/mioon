import type { MessageCatalog } from '../types.ts';

/** Connection UI text; never persisted in provider configuration or receipts. */
export const connectionMessages = {
  "connections.storage.none": {
    "zh-Hans": "未保存密钥",
    "zh-Hant": "未儲存密鑰",
    "en": "No key saved",
    "ja": "キー未保存"
  },
  "connections.storage.session": {
    "zh-Hans": "仅本次运行",
    "zh-Hant": "僅本次執行",
    "en": "This session only",
    "ja": "今回の実行のみ"
  },
  "connections.storage.persistent": {
    "zh-Hans": "系统加密保存",
    "zh-Hant": "系統加密儲存",
    "en": "System-encrypted storage",
    "ja": "システムで暗号化して保存"
  },
  "connections.storage.webReason": {
    "zh-Hans": "当前为服务器模式，密钥仅保存在服务器内存；服务器退出后清除",
    "zh-Hant": "目前為伺服器模式，密鑰僅儲存在伺服器記憶體中；伺服器結束後即清除",
    "en": "In server mode, keys are kept only in server memory and cleared when the server exits",
    "ja": "サーバーモードでは、キーはサーバーのメモリ内だけに保持され、サーバー終了時に消去されます"
  },
  "connections.storage.basicReason": {
    "zh-Hans": "系统仅提供 basic_text，不能安全持久保存；密钥仅在本次应用运行中保留",
    "zh-Hant": "系統僅提供 basic_text，無法安全地持久儲存；密鑰僅在本次應用程式執行期間保留",
    "en": "The system provides only basic_text, which cannot securely persist keys. Keys remain only for this app session",
    "ja": "システムでは basic_text のみ利用でき、安全に永続保存できません。キーは今回のアプリ実行中のみ保持されます"
  },
  "connections.storage.unavailableReason": {
    "zh-Hans": "系统安全存储不可用，不能持久保存；可选择仅本次运行",
    "zh-Hant": "系統安全儲存無法使用，不能持久儲存；可選擇僅本次執行",
    "en": "System secure storage is unavailable. Choose session-only storage instead of persistent storage",
    "ja": "システムの安全なストレージを利用できません。永続保存ではなく、今回の実行のみの保存を選べます"
  },
  "connections.storage.availableReason": {
    "zh-Hans": "系统安全存储可用；持久密钥经系统加密保存在项目数据之外",
    "zh-Hant": "系統安全儲存可用；持久儲存的密鑰會由系統加密，並與專案資料分開儲存",
    "en": "System secure storage is available. Persistent keys are system-encrypted and stored outside project data",
    "ja": "システムの安全なストレージを利用できます。永続保存するキーはシステムで暗号化され、プロジェクトデータとは別に保存されます"
  },
  "connections.storage.fallbackReason": {
    "zh-Hans": "当前无法持久保存密钥；仅本次运行可用",
    "zh-Hant": "目前無法持久儲存密鑰；僅本次執行可用",
    "en": "Persistent key storage is currently unavailable. Session-only storage is available",
    "ja": "現在、キーを永続保存できません。今回の実行中のみ保持できます"
  },
  "agent.settings.keyHidden": {
    "zh-Hans": "隐藏设置时已清空新输入的密钥；连接草稿仍保留。需要替换密钥时请重新输入",
    "zh-Hant": "隱藏設定時已清除新輸入的密鑰；連線草稿仍保留。如需更換密鑰，請重新輸入",
    "en": "The newly entered key was cleared when settings were hidden. Your connection draft remains. Enter the key again to replace it",
    "ja": "設定を非表示にしたため、新しく入力したキーを消去しました。接続の下書きは保持されています。キーを置き換える場合は再入力してください"
  },
  "agent.settings.keyLeft": {
    "zh-Hans": "离开设置时已清空新输入的密钥；连接草稿仍保留",
    "zh-Hant": "離開設定時已清除新輸入的密鑰；連線草稿仍保留",
    "en": "The newly entered key was cleared when leaving settings. Your connection draft remains",
    "ja": "設定を離れたため、新しく入力したキーを消去しました。接続の下書きは保持されています"
  },
  "agent.settings.title": {
    "zh-Hans": "Mio",
    "zh-Hant": "Mio",
    "en": "Mio",
    "ja": "Mio"
  },
  "agent.settings.eyebrow": {
    "zh-Hans": "模型连接",
    "zh-Hant": "模型連線",
    "en": "Model connection",
    "ja": "モデル接続"
  },
  "agent.settings.intro": {
      "zh-Hans": "连接设置不会发起模型请求；相同目标地址、模型和发送范围只需授权一次，可在下方撤销",
      "zh-Hant": "連線設定不會發起模型請求；相同目標位址、模型和傳送範圍只需授權一次，可在下方撤銷",
      "en": "Connection settings do not send model requests. Authorize each destination, model and sending scope once; revoke access below",
      "ja": "接続設定からモデルへのリクエストは送信されません。同じ送信先、モデル、送信範囲の許可は一度だけ必要です。下で取り消せます"
  },
  "agent.settings.backAgent": {
    "zh-Hans": "返回 Mio 对话",
    "zh-Hant": "返回 Mio 對話",
    "en": "Back to Mio chat",
    "ja": "Mio チャットに戻る"
  },
  "agent.settings.saveScope": {
    "zh-Hans": "保存仅更新本机工作台设置，不发起模型请求，也不发送项目内容",
    "zh-Hant": "儲存僅更新本機工作台設定，不會發起模型請求，也不會傳送專案內容",
    "en": "Saving only updates local workbench settings. It does not send model requests or project content",
    "ja": "保存ではローカルのワークベンチ設定のみ更新します。モデルへのリクエストやプロジェクト内容は送信しません"
  },
  "agent.settings.unverified": {
    "zh-Hans": "尚未验证连接",
    "zh-Hant": "尚未驗證連線",
    "en": "Connection not verified",
    "ja": "接続未検証"
  },
  "agent.settings.loading": {
    "zh-Hans": "正在读取连接设置…",
    "zh-Hant": "正在讀取連線設定…",
    "en": "Reading connection settings…",
    "ja": "接続設定を読み込み中…"
  },
  "connections.reload": {
    "zh-Hans": "重新读取",
    "zh-Hant": "重新讀取",
    "en": "Read again",
    "ja": "再読み込み"
  },
  "agent.settings.modelService": {
    "zh-Hans": "模型服务",
    "zh-Hant": "模型服務",
    "en": "Model service",
    "ja": "モデルサービス"
  },
  "agent.settings.presetHelp": {
    "zh-Hans": "预设是起点，地址与模型均可编辑",
    "zh-Hant": "預設只是起點，位址與模型皆可編輯",
    "en": "Start with a preset, then edit the endpoint and model",
    "ja": "プリセットを基に、接続先とモデルを編集できます"
  },
  "agent.settings.preset": {
    "zh-Hans": "服务商预设",
    "zh-Hant": "服務商預設",
    "en": "Provider preset",
    "ja": "プロバイダーのプリセット"
  },
  "agent.settings.platform": {
    "zh-Hans": "平台 / 地区",
    "zh-Hant": "平台 / 地區",
    "en": "Platform / region",
    "ja": "プラットフォーム / リージョン"
  },
  "agent.settings.protocol": {
    "zh-Hans": "API 协议",
    "zh-Hant": "API 協定",
    "en": "API protocol",
    "ja": "API プロトコル"
  },
  "agent.settings.protocolHelp": {
    "zh-Hans": "预设只提供默认值，三种协议均可独立选择。切换协议不会更改地址或模型；请按供应商文档核对完整请求地址并重新授权。不会自动探测、重试或回退",
    "zh-Hant": "預設只提供預設值，三種協定均可獨立選擇。切換協定不會變更位址或模型；請依供應商文件核對完整請求位址並重新授權。不會自動偵測、重試或回退",
    "en": "Presets supply defaults; all three protocols can be selected independently. Switching preserves the URL and model. Check the complete request URL against provider documentation and authorize it again. No automatic detection, retries, or fallback",
    "ja": "プリセットは初期値を設定するだけで、3つのプロトコルを個別に選択できます。切り替えても URL とモデルは変わりません。プロバイダーの資料で完全な送信先 URL を確認し、再度認可してください。自動検出、再試行、フォールバックは行いません"
  },
  "agent.settings.baseUrl": {
    "zh-Hans": "服务地址",
    "zh-Hant": "服務位址",
    "en": "Service endpoint",
    "ja": "サービスの接続先"
  },
  "agent.settings.endpointHelp": {
    "zh-Hans": "填写 API 基础地址，不含 /chat/completions 或 /responses。远程服务使用 HTTPS；本地服务请选 Ollama 预设",
    "zh-Hant": "請填寫 API 基礎位址，不含 /chat/completions 或 /responses。遠端服務使用 HTTPS；本機服務請選 Ollama 預設",
    "en": "Enter the API base URL without /chat/completions or /responses. Use HTTPS for remote services; select the Ollama preset for local services",
    "ja": "/chat/completions や /responses を含めず、API のベース URL を入力してください。リモートサービスには HTTPS を使用し、ローカルサービスには Ollama プリセットを選択してください"
  },
  "agent.settings.anthropicEndpointHelp": {
    "zh-Hans": "填写服务根地址，例如 https://api.anthropic.com；保留供应商要求的前缀，系统会追加 /v1/messages。不要填写完整 Messages 地址",
    "zh-Hant": "請填寫服務根位址，例如 https://api.anthropic.com；保留供應商要求的前綴，系統會附加 /v1/messages。請勿填寫完整 Messages 位址",
    "en": "Enter the service root, such as https://api.anthropic.com. Keep any provider-required prefix; /v1/messages is appended. Do not enter the complete Messages URL",
    "ja": "https://api.anthropic.com などのサービスルートを入力してください。プロバイダー指定のプレフィックスは保持し、/v1/messages が追加されます。Messages の完全な URL は入力しないでください"
  },
  "agent.settings.anthropicScope": {
    "zh-Hans": "支持文本和 Mio 宿主工具，关闭思考；不自动重试、切换协议或回退。切换后请核对下方完整请求地址并重新授权",
    "zh-Hant": "支援文字與 Mio 宿主工具，停用思考；不會自動重試、切換協定或回退。切換後請核對下方完整請求位址並重新授權",
    "en": "Supports text and Mio host tools with thinking disabled. No automatic retries, protocol switching, or fallback. Review the complete request URL below and authorize it after switching",
    "ja": "思考を無効にしたテキストと Mio ホストツールに対応します。自動再試行、プロトコル切り替え、フォールバックは行いません。切り替え後は下の完全なリクエスト URL を確認し、再度認可してください"
  },
  "agent.settings.modelName": {
    "zh-Hans": "模型名称",
    "zh-Hant": "模型名稱",
    "en": "Model name",
    "ja": "モデル名"
  },
  "agent.settings.restorePreset": {
    "zh-Hans": "恢复此平台预设",
    "zh-Hant": "還原此平台預設",
    "en": "Restore platform preset",
    "ja": "このプラットフォームのプリセットに戻す"
  },
  "agent.settings.modelPlaceholder": {
    "zh-Hans": "输入账户可用的模型 ID",
    "zh-Hant": "輸入帳戶可用的模型 ID",
    "en": "Enter a model ID available to your account",
    "ja": "アカウントで利用できるモデル ID を入力"
  },
  "agent.settings.responsesCustom": {
    "zh-Hans": "自定义服务：请手动填写支持 Responses 的精确模型 ID；兼容性未经验证",
    "zh-Hant": "自訂服務：請手動填寫支援 Responses 的確切模型 ID；相容性尚未驗證",
    "en": "Custom service: manually enter the exact model ID that supports Responses. Compatibility is unverified",
    "ja": "カスタムサービスでは、Responses に対応する正確なモデル ID を手動で入力してください。互換性は未検証です"
  },
  "agent.settings.responsesScope": {
    "zh-Hans": "仅支持非思考模式；选择并确认项目只读检查后，每轮最多 1 次只读工具调用、2 次模型请求。镜头标题与画面描述的修改需另选提议模式并逐份批准；不支持媒体生成",
    "zh-Hant": "僅支援非思考模式；選擇並確認專案唯讀檢查後，每輪最多 1 次唯讀工具呼叫、2 次模型請求。修改鏡頭標題與畫面描述須另選提案模式，並逐份批准；不支援媒體生成",
    "en": "Only non-thinking mode is supported. After selecting and confirming read-only project inspection, each turn allows at most one read-only tool call and two model requests. Changing shot titles or visual descriptions requires separate proposal mode and approval of each proposal. Media generation is not supported",
    "ja": "非思考モードのみ対応しています。プロジェクトの読み取り専用チェックを選択して確認した場合、1 ターンにつき読み取り専用ツール呼び出しは最大 1 回、モデルリクエストは最大 2 回です。ショット名や画面説明の変更には別途提案モードを選び、各提案を承認する必要があります。メディア生成には対応していません"
  },
  "agent.settings.endpointEmpty": {
    "zh-Hans": "填写完整的 API 基础地址后显示请求地址",
    "zh-Hant": "填寫完整的 API 基礎位址後顯示請求位址",
    "en": "Enter a complete API base URL to preview the request endpoint",
    "ja": "完全な API ベース URL を入力すると、リクエストの送信先を表示します"
  },
  "agent.settings.presetFallback": {
    "zh-Hans": "请自行确认此地址、账户和模型的对应关系",
    "zh-Hant": "請自行確認此位址、帳戶與模型的對應關係",
    "en": "Verify that the endpoint, account, and model match",
    "ja": "接続先、アカウント、モデルの組み合わせを確認してください"
  },
  "agent.settings.presetWarning": {
    "zh-Hans": "预设不代表服务商的所有模型均兼容，也不代表当前账户可用",
    "zh-Hant": "預設不代表服務商的所有模型皆相容，也不代表目前帳戶可使用",
    "en": "A preset does not mean all provider models are compatible or available to your account",
    "ja": "プリセットがあっても、プロバイダーの全モデルの互換性や、現在のアカウントでの利用を保証するものではありません"
  },
  "connections.apiKey": {
    "zh-Hans": "API 密钥",
    "zh-Hant": "API 密鑰",
    "en": "API key",
    "ja": "API キー"
  },
  "agent.settings.noServerKey": {
    "zh-Hans": "服务器未保存密钥",
    "zh-Hant": "伺服器未儲存密鑰",
    "en": "No key saved on server",
    "ja": "サーバーにキーは保存されていません"
  },
  "agent.settings.replaceKey": {
    "zh-Hans": "替换 API 密钥",
    "zh-Hant": "更換 API 密鑰",
    "en": "Replace API key",
    "ja": "API キーを置き換え"
  },
  "agent.settings.enterKey": {
    "zh-Hans": "输入 API 密钥",
    "zh-Hant": "輸入 API 密鑰",
    "en": "Enter API key",
    "ja": "API キーを入力"
  },
  "agent.settings.removePlaceholder": {
    "zh-Hans": "保存时将移除已有密钥",
    "zh-Hant": "儲存時將移除現有密鑰",
    "en": "The existing key will be removed on save",
    "ja": "保存時に既存のキーを削除します"
  },
  "agent.settings.keepPlaceholder": {
    "zh-Hans": "留空保留已有密钥；输入新密钥以替换",
    "zh-Hant": "留空以保留現有密鑰；輸入新密鑰以更換",
    "en": "Leave blank to keep the saved key; enter a new key to replace it",
    "ja": "空欄なら既存のキーを保持し、新しいキーを入力すると置き換えます"
  },
  "agent.settings.newKeyPlaceholder": {
    "zh-Hans": "输入新密钥（可留空，仅保存连接参数）",
    "zh-Hant": "輸入新密鑰（可留空，僅儲存連線參數）",
    "en": "Enter a new key, or leave blank to save connection parameters only",
    "ja": "新しいキーを入力（空欄なら接続パラメーターのみ保存）"
  },
  "agent.settings.keyHelp": {
    "zh-Hans": "已保存的密钥不会回填。新输入仅临时保留，提交或关闭后清空；不会写入浏览器存储",
    "zh-Hant": "已儲存的密鑰不會回填。新輸入僅暫時保留，提交或關閉後清除；不會寫入瀏覽器儲存空間",
    "en": "Saved keys are never shown in the input. New keys are held temporarily and cleared on submission or close. They are not written to browser storage",
    "ja": "保存済みのキーは入力欄に表示しません。新しいキーは一時的に保持し、送信または終了時に消去します。ブラウザーのストレージには書き込みません"
  },
  "agent.settings.bindingWarning": {
    "zh-Hans": "服务商、地区或地址已改变。保存时会清除原密钥；请确认目标后重新输入新密钥",
    "zh-Hant": "服務商、地區或位址已變更。儲存時會清除原密鑰；請確認目標後重新輸入新密鑰",
    "en": "The provider, region, or endpoint changed. Saving will clear the original key. Confirm the destination, then enter a new key",
    "ja": "プロバイダー、リージョン、または接続先が変更されています。保存時に元のキーを消去します。送信先を確認し、新しいキーを入力してください"
  },
  "agent.settings.keyStorage": {
    "zh-Hans": "新密钥的保存方式",
    "zh-Hant": "新密鑰的儲存方式",
    "en": "Storage for the new key",
    "ja": "新しいキーの保存方法"
  },
  "agent.settings.undoRemoveHint": {
    "zh-Hans": "撤销尚未提交的移除操作",
    "zh-Hant": "撤銷尚未提交的移除操作",
    "en": "Undo the removal that has not been submitted",
    "ja": "まだ送信していない削除を取り消す"
  },
  "agent.settings.removeHint": {
    "zh-Hans": "下一次保存时移除已保存密钥",
    "zh-Hant": "下次儲存時移除已儲存的密鑰",
    "en": "Remove the saved key on the next save",
    "ja": "次回の保存時に保存済みキーを削除"
  },
  "connections.undoRemove": {
    "zh-Hans": "撤销移除",
    "zh-Hant": "撤銷移除",
    "en": "Undo removal",
    "ja": "削除を取り消す"
  },
  "connections.removeKey": {
    "zh-Hans": "移除密钥",
    "zh-Hant": "移除密鑰",
    "en": "Remove key",
    "ja": "キーを削除"
  },
  "agent.settings.reenterStorage": {
    "zh-Hans": "更改保存方式需重新输入密钥",
    "zh-Hant": "變更儲存方式須重新輸入密鑰",
    "en": "Enter the key again to change its storage method",
    "ja": "保存方法を変えるには、キーを再入力してください"
  },
  "connections.intentRemove": {
    "zh-Hans": "此次保存：移除已有密钥",
    "zh-Hant": "此次儲存：移除現有密鑰",
    "en": "On save: remove the existing key",
    "ja": "今回の保存：既存のキーを削除"
  },
  "connections.intentKeep": {
    "zh-Hans": "此次保存：保留已有密钥",
    "zh-Hant": "此次儲存：保留現有密鑰",
    "en": "On save: keep the existing key",
    "ja": "今回の保存：既存のキーを保持"
  },
  "agent.settings.intentOllama": {
    "zh-Hans": "此次保存：仅连接参数；本地 Ollama 通常无需密钥",
    "zh-Hant": "此次儲存：僅連線參數；本機 Ollama 通常不需密鑰",
    "en": "On save: connection parameters only. Local Ollama usually does not need a key",
    "ja": "今回の保存：接続パラメーターのみ。ローカルの Ollama は通常キーが不要です"
  },
  "agent.settings.intentNoKey": {
    "zh-Hans": "此次保存：仅连接参数；未配置 API 密钥",
    "zh-Hant": "此次儲存：僅連線參數；尚未設定 API 密鑰",
    "en": "On save: connection parameters only; no API key configured",
    "ja": "今回の保存：接続パラメーターのみ。API キーは未設定です"
  },
  "connections.serverSettings": {
    "zh-Hans": "服务器当前设置",
    "zh-Hant": "伺服器目前設定",
    "en": "Current server settings",
    "ja": "現在のサーバー設定"
  },
  "agent.settings.reloadState": {
    "zh-Hans": "重新读取状态",
    "zh-Hant": "重新讀取狀態",
    "en": "Read state again",
    "ja": "状態を再読み込み"
  },
  "agent.settings.reviewDone": {
    "zh-Hans": "已核对，继续编辑草稿",
    "zh-Hant": "已核對，繼續編輯草稿",
    "en": "Reviewed, continue editing draft",
    "ja": "確認済み、下書きの編集を続ける"
  },
  "agent.settings.useServer": {
    "zh-Hans": "使用服务器设置",
    "zh-Hant": "使用伺服器設定",
    "en": "Use server settings",
    "ja": "サーバー設定を使用"
  },
  "agent.settings.backChat": {
    "zh-Hans": "返回对话",
    "zh-Hant": "返回對話",
    "en": "Back to chat",
    "ja": "チャットに戻る"
  },
  "connections.unsaved": {
    "zh-Hans": "有尚未保存的更改",
    "zh-Hant": "有尚未儲存的變更",
    "en": "Unsaved changes",
    "ja": "未保存の変更があります"
  },
  "agent.settings.singleConnection": {
    "zh-Hans": "当前仅管理一个连接配置",
    "zh-Hant": "目前僅管理一組連線設定",
    "en": "Currently managing one connection configuration",
    "ja": "現在は 1 つの接続設定を管理しています"
  },
  "connections.saving": {
    "zh-Hans": "正在保存…",
    "zh-Hant": "正在儲存…",
    "en": "Saving…",
    "ja": "保存中…"
  },
  "agent.settings.saving": {
    "zh-Hans": "保存中…",
    "zh-Hant": "儲存中…",
    "en": "Saving…",
    "ja": "保存中…"
  },
  "agent.settings.save": {
    "zh-Hans": "保存设置",
    "zh-Hant": "儲存設定",
    "en": "Save settings",
    "ja": "設定を保存"
  },
  "image.settings.storageNone": {
    "zh-Hans": "未保存",
    "zh-Hant": "未儲存",
    "en": "Not saved",
    "ja": "未保存"
  },
  "image.settings.storageSession": {
    "zh-Hans": "仅本次后端运行",
    "zh-Hant": "僅本次後端執行",
    "en": "This backend session only",
    "ja": "今回のバックエンド実行のみ"
  },
  "image.settings.storageChoose": {
    "zh-Hans": "请选择保存方式",
    "zh-Hant": "請選擇儲存方式",
    "en": "Choose a storage method",
    "ja": "保存方法を選択"
  },
  "image.settings.storageWeb": {
    "zh-Hans": "当前服务器不提供系统安全存储。仅本次后端运行可用，后端退出后密钥清除",
    "zh-Hant": "目前伺服器不提供系統安全儲存。密鑰僅於本次後端執行期間可用，後端結束後即清除",
    "en": "This server does not provide system secure storage. Keys are available only for this backend session and cleared when it exits",
    "ja": "このサーバーではシステムの安全なストレージを提供していません。キーは今回のバックエンド実行中のみ利用でき、終了時に消去されます"
  },
  "image.settings.storageBasic": {
    "zh-Hans": "系统仅提供 basic_text，不支持安全持久保存。可明确选择仅本次后端运行",
    "zh-Hant": "系統僅提供 basic_text，不支援安全持久儲存。可明確選擇僅本次後端執行",
    "en": "The system provides only basic_text, which cannot securely persist keys. You can explicitly choose backend-session-only storage",
    "ja": "システムでは basic_text のみ利用でき、安全な永続保存には対応していません。今回のバックエンド実行のみの保存を明示的に選択できます"
  },
  "image.settings.storageUnavailable": {
    "zh-Hans": "系统安全存储不可用。可明确选择仅本次后端运行",
    "zh-Hant": "系統安全儲存無法使用。可明確選擇僅本次後端執行",
    "en": "System secure storage is unavailable. You can explicitly choose backend-session-only storage",
    "ja": "システムの安全なストレージを利用できません。今回のバックエンド実行のみの保存を明示的に選択できます"
  },
  "image.settings.storageAvailable": {
    "zh-Hans": "系统安全存储可用。持久保存需要你的明确选择；不会退回明文文件",
    "zh-Hant": "系統安全儲存可用。持久儲存須由你明確選擇；不會改用明文檔案",
    "en": "System secure storage is available. Persistent storage requires your explicit choice. It will not fall back to plain-text files",
    "ja": "システムの安全なストレージを利用できます。永続保存は明示的に選択する必要があり、平文ファイルへの保存には切り替えません"
  },
  "image.settings.keyHidden": {
    "zh-Hans": "隐藏设置或切换项目时已清空新输入的密钥；非秘密草稿仍保留。需要替换密钥时请重新输入",
    "zh-Hant": "隱藏設定或切換專案時已清除新輸入的密鑰；非機密草稿仍保留。如需更換密鑰，請重新輸入",
    "en": "The newly entered key was cleared when settings were hidden or the project changed. Non-secret drafts remain. Enter the key again to replace it",
    "ja": "設定を非表示にしたかプロジェクトを切り替えたため、新しく入力したキーを消去しました。秘密情報を含まない下書きは保持されています。キーを置き換える場合は再入力してください"
  },
  "image.settings.keyPageHidden": {
    "zh-Hans": "页面隐藏时已清空新输入的密钥；非秘密草稿仍保留",
    "zh-Hant": "頁面隱藏時已清除新輸入的密鑰；非機密草稿仍保留",
    "en": "The newly entered key was cleared when the page was hidden. Non-secret drafts remain",
    "ja": "ページを非表示にしたため、新しく入力したキーを消去しました。秘密情報を含まない下書きは保持されています"
  },
  "image.settings.keyLeft": {
    "zh-Hans": "离开设置时已清空新输入的密钥；非秘密草稿仍保留",
    "zh-Hant": "離開設定時已清除新輸入的密鑰；非機密草稿仍保留",
    "en": "The newly entered key was cleared when leaving settings. Non-secret drafts remain",
    "ja": "設定を離れたため、新しく入力したキーを消去しました。秘密情報を含まない下書きは保持されています"
  },
  "image.settings.keySwitched": {
    "zh-Hans": "切换连接时已清空新输入的密钥；非秘密草稿仍保留",
    "zh-Hant": "切換連線時已清除新輸入的密鑰；非機密草稿仍保留",
    "en": "The newly entered key was cleared when switching connections. Non-secret drafts remain",
    "ja": "接続を切り替えたため、新しく入力したキーを消去しました。秘密情報を含まない下書きは保持されています"
  },
  "image.settings.aria": {
    "zh-Hans": "图像连接设置",
    "zh-Hant": "圖像連線設定",
    "en": "Image connection settings",
    "ja": "画像の接続設定"
  },
  "image.settings.eyebrow": {
    "zh-Hans": "IMAGE · CONNECTION",
    "zh-Hant": "圖像 · 連線",
    "en": "IMAGE · CONNECTION",
    "ja": "画像 · 接続"
  },
  "image.settings.title": {
    "zh-Hans": "图像设置",
    "zh-Hant": "圖像設定",
    "en": "Image settings",
    "ja": "画像設定"
  },
  "image.settings.subtitle": {
    "zh-Hans": "一次配置，逐次确认付费生成",
    "zh-Hant": "設定一次，每次付費生成皆須確認",
    "en": "Configure once, confirm each paid generation",
    "ja": "設定は一度、有料生成は毎回確認"
  },
  "image.settings.backWorkshop": {
    "zh-Hans": "返回图像工坊",
    "zh-Hant": "返回圖像工坊",
    "en": "Back to image workshop",
    "ja": "画像ワークショップに戻る"
  },
  "connections.back": {
    "zh-Hans": "返回",
    "zh-Hant": "返回",
    "en": "Back",
    "ja": "戻る"
  },
  "image.settings.slots": {
    "zh-Hans": "图像连接槽位",
    "zh-Hant": "圖像連線欄位",
    "en": "Image connection slots",
    "ja": "画像の接続スロット"
  },
  "image.settings.official": {
    "zh-Hans": "OpenAI 官方",
    "zh-Hant": "OpenAI 官方",
    "en": "Official OpenAI",
    "ja": "OpenAI 公式"
  },
  "image.settings.custom": {
    "zh-Hans": "自定义兼容连接",
    "zh-Hant": "自訂相容連線",
    "en": "Custom compatible connection",
    "ja": "カスタム互換接続"
  },
  "image.settings.comfy": {
    "zh-Hans": "本地 ComfyUI",
    "zh-Hant": "本機 ComfyUI",
    "en": "Local ComfyUI",
    "ja": "ローカル ComfyUI"
  },
  "image.settings.saveScope": {
    "zh-Hans": "保存只更新本机图像设置，不发送描述、不生成图片。官方与自定义连接各自保存密钥，Mio 与视频设置也相互独立",
    "zh-Hant": "儲存僅更新本機圖像設定，不會傳送描述或生成圖片。官方與自訂連線各自儲存密鑰，Mio 與影片設定亦互相獨立",
    "en": "Saving only updates local image settings. It does not send prompts or generate images. Official and custom connections store separate keys; Mio and video settings are also independent",
    "ja": "保存ではローカルの画像設定のみ更新し、プロンプトの送信や画像生成は行いません。公式接続とカスタム接続のキーは別々に保存し、Mio や動画の設定からも独立しています"
  },
  "image.settings.loading": {
    "zh-Hans": "正在读取图像设置…",
    "zh-Hant": "正在讀取圖像設定…",
    "en": "Reading image settings…",
    "ja": "画像設定を読み込み中…"
  },
  "image.settings.enableCustom": {
    "zh-Hans": "启用自定义兼容图像",
    "zh-Hant": "啟用自訂相容圖像",
    "en": "Enable custom compatible images",
    "ja": "カスタム互換画像を有効化"
  },
  "image.settings.enableOpenai": {
    "zh-Hans": "启用 OpenAI 图像",
    "zh-Hant": "啟用 OpenAI 圖像",
    "en": "Enable OpenAI images",
    "ja": "OpenAI 画像を有効化"
  },
  "image.settings.enableScope": {
    "zh-Hans": "启用不代表授权任何一次付费请求",
    "zh-Hant": "啟用並不代表已授權任何付費請求",
    "en": "Enabling does not authorize any paid request",
    "ja": "有効化しても有料リクエストを承認したことにはなりません"
  },
  "image.settings.baseUrl": {
    "zh-Hans": "兼容 API 基础地址",
    "zh-Hant": "相容 API 基礎位址",
    "en": "Compatible API base URL",
    "ja": "互換 API のベース URL"
  },
  "image.settings.baseUrlHelp": {
    "zh-Hans": "仅支持 HTTPS 公网域名、443 端口和路径前缀。保存前会统一域名大小写、去除 :443 与末尾斜杠。不要输入密钥、查询参数或完整生成路径",
    "zh-Hant": "僅支援 HTTPS 公開網域、443 連接埠與路徑前綴。儲存前會統一網域大小寫，移除 :443 與結尾斜線。請勿輸入密鑰、查詢參數或完整生成路徑",
    "en": "Only HTTPS public domains, port 443, and path prefixes are supported. Saving normalizes domain case and removes :443 and trailing slashes. Do not enter keys, query parameters, or the full generation path",
    "ja": "HTTPS の公開ドメイン、ポート 443、パスの接頭辞のみ対応しています。保存前にドメインの大文字小文字を統一し、:443 と末尾のスラッシュを除去します。キー、クエリパラメーター、生成 API の完全なパスは入力しないでください"
  },
  "image.settings.model": {
    "zh-Hans": "模型标识",
    "zh-Hant": "模型識別碼",
    "en": "Model ID",
    "ja": "モデル ID"
  },
  "image.settings.modelPlaceholder": {
    "zh-Hans": "服务商提供的准确模型标识",
    "zh-Hant": "服務商提供的確切模型識別碼",
    "en": "Exact model ID from the provider",
    "ja": "プロバイダー指定の正確なモデル ID"
  },
  "image.settings.compatibility": {
    "zh-Hans": "仅支持固定 JSON 请求与 base64 单张 PNG 响应。并非所有 OpenAI 兼容服务都可用；不支持本地 ComfyUI、URL 下载、自动探测或回退",
    "zh-Hant": "僅支援固定 JSON 請求與 base64 單張 PNG 回應。並非所有 OpenAI 相容服務皆可用；不支援本機 ComfyUI、URL 下載、自動偵測或回退",
    "en": "Only fixed JSON requests and a single base64 PNG response are supported. Not all OpenAI-compatible services work. Local ComfyUI, URL downloads, automatic detection, and fallback are not supported",
    "ja": "固定 JSON リクエストと base64 の単一 PNG レスポンスのみ対応しています。すべての OpenAI 互換サービスが使えるわけではありません。ローカル ComfyUI、URL ダウンロード、自動検出、フォールバックには対応していません"
  },
  "image.settings.bindingWarning": {
    "zh-Hans": "地址或模型已变化。必须重新输入这个连接的新密钥，或点击移除密钥后保存。原密钥不会带到新地址",
    "zh-Hant": "位址或模型已變更。須重新輸入此連線的新密鑰，或先點選移除密鑰再儲存。原密鑰不會傳至新位址",
    "en": "The endpoint or model changed. Enter a new key for this connection, or select Remove key before saving. The original key will not be carried to the new endpoint",
    "ja": "接続先またはモデルが変更されています。この接続の新しいキーを入力するか、キーの削除を選んでから保存してください。元のキーが新しい接続先に引き継がれることはありません"
  },
  "image.settings.customFormat": {
    "zh-Hans": "自定义兼容 · JSON / base64 PNG",
    "zh-Hant": "自訂相容 · JSON / base64 PNG",
    "en": "Custom compatible · JSON / base64 PNG",
    "ja": "カスタム互換 · JSON / base64 PNG"
  },
  "image.settings.destinationEmpty": {
    "zh-Hans": "填写有效地址后显示完整发送目标",
    "zh-Hant": "填寫有效位址後顯示完整傳送目標",
    "en": "Enter a valid endpoint to show the full destination",
    "ja": "有効な接続先を入力すると完全な送信先を表示します"
  },
  "image.settings.modelEmpty": {
    "zh-Hans": "尚未填写模型",
    "zh-Hant": "尚未填寫模型",
    "en": "No model entered",
    "ja": "モデル未入力"
  },
  "image.settings.fixedOutput": {
    "zh-Hans": "1024 × 1024 · low · PNG · 不透明 · 1 张",
    "zh-Hant": "1024 × 1024 · low · PNG · 不透明 · 1 張",
    "en": "1024 × 1024 · low · PNG · opaque · 1 image",
    "ja": "1024 × 1024 · low · PNG · 不透明 · 1 枚"
  },
  "image.settings.unverified": {
    "zh-Hans": "真实调用尚未验证",
    "zh-Hant": "實際呼叫尚未驗證",
    "en": "Live requests not verified",
    "ja": "実際のリクエストは未検証"
  },
  "image.settings.key": {
    "zh-Hans": "专用于图像的 API 密钥",
    "zh-Hant": "圖像專用 API 密鑰",
    "en": "Image-only API key",
    "ja": "画像専用の API キー"
  },
  "image.settings.removePlaceholder": {
    "zh-Hans": "保存时移除已有密钥",
    "zh-Hant": "儲存時移除現有密鑰",
    "en": "Remove the existing key on save",
    "ja": "保存時に既存のキーを削除"
  },
  "image.settings.keepPlaceholder": {
    "zh-Hans": "留空保留；输入新密钥替换",
    "zh-Hant": "留空以保留；輸入新密鑰以更換",
    "en": "Leave blank to keep; enter a new key to replace",
    "ja": "空欄なら保持、新しいキーを入力すると置き換え"
  },
  "image.settings.customKeyPlaceholder": {
    "zh-Hans": "输入此自定义连接的 API 密钥",
    "zh-Hant": "輸入此自訂連線的 API 密鑰",
    "en": "Enter the API key for this custom connection",
    "ja": "このカスタム接続の API キーを入力"
  },
  "image.settings.openaiKeyPlaceholder": {
    "zh-Hans": "输入 OpenAI API 密钥",
    "zh-Hant": "輸入 OpenAI API 密鑰",
    "en": "Enter an OpenAI API key",
    "ja": "OpenAI API キーを入力"
  },
  "image.settings.keyHelp": {
    "zh-Hans": "密钥写入后不回显，不进入项目、聊天、浏览器存储或日志。离开、隐藏或切换项目会清空尚未提交的密钥",
    "zh-Hant": "密鑰寫入後不會回顯，也不會進入專案、聊天、瀏覽器儲存空間或日誌。離開、隱藏或切換專案時，會清除尚未提交的密鑰",
    "en": "Saved keys are never displayed or placed in projects, chat, browser storage, or logs. Leaving, hiding, or switching projects clears unsubmitted keys",
    "ja": "保存したキーは再表示せず、プロジェクト、チャット、ブラウザーのストレージ、ログにも含めません。画面を離れる、非表示にする、プロジェクトを切り替える操作で未送信のキーを消去します"
  },
  "image.settings.keyStorage": {
    "zh-Hans": "密钥保存方式",
    "zh-Hant": "密鑰儲存方式",
    "en": "Key storage method",
    "ja": "キーの保存方法"
  },
  "image.settings.reenterStorage": {
    "zh-Hans": " 更改已有密钥的保存方式需重新输入密钥",
    "zh-Hant": " 變更現有密鑰的儲存方式須重新輸入密鑰",
    "en": " Enter the key again to change how the saved key is stored",
    "ja": " 保存済みキーの保存方法を変えるには、キーを再入力してください"
  },
  "connections.enabled": {
    "zh-Hans": "已启用",
    "zh-Hant": "已啟用",
    "en": "Enabled",
    "ja": "有効"
  },
  "connections.disabled": {
    "zh-Hans": "未启用",
    "zh-Hant": "未啟用",
    "en": "Disabled",
    "ja": "無効"
  },
  "connections.notConfigured": {
    "zh-Hans": "未配置",
    "zh-Hant": "未設定",
    "en": "Not configured",
    "ja": "未設定"
  },
  "image.settings.undoRemove": {
    "zh-Hans": "撤销移除密钥",
    "zh-Hant": "撤銷移除密鑰",
    "en": "Undo key removal",
    "ja": "キーの削除を取り消す"
  },
  "image.settings.removeKey": {
    "zh-Hans": "移除图像密钥",
    "zh-Hant": "移除圖像密鑰",
    "en": "Remove image key",
    "ja": "画像用キーを削除"
  },
  "image.settings.intentNone": {
    "zh-Hans": "仅保存连接设置，尚无密钥",
    "zh-Hant": "僅儲存連線設定，尚無密鑰",
    "en": "Save connection settings only; no key configured",
    "ja": "接続設定のみ保存、キーは未設定"
  },
  "image.settings.recovery": {
    "zh-Hans": "保存结果待核对，不会自动重试",
    "zh-Hant": "儲存結果待核對，不會自動重試",
    "en": "The save result needs verification. It will not be retried automatically",
    "ja": "保存結果の確認が必要です。自動で再試行することはありません"
  },
  "connections.useSaved": {
    "zh-Hans": "使用已保存设置",
    "zh-Hant": "使用已儲存設定",
    "en": "Use saved settings",
    "ja": "保存済み設定を使用"
  },
  "connections.keepDraft": {
    "zh-Hans": "核对后保留草稿",
    "zh-Hant": "核對後保留草稿",
    "en": "Keep draft after review",
    "ja": "確認して下書きを保持"
  },
  "image.settings.save": {
    "zh-Hans": "保存图像设置",
    "zh-Hant": "儲存圖像設定",
    "en": "Save image settings",
    "ja": "画像設定を保存"
  },
  "connections.comfy.aria": {
    "zh-Hans": "本地 ComfyUI 图像设置",
    "zh-Hant": "本機 ComfyUI 圖像設定",
    "en": "Local ComfyUI image settings",
    "ja": "ローカル ComfyUI 画像設定"
  },
  "connections.comfy.eyebrow": {
    "zh-Hans": "IMAGE · LOCAL CONNECTION",
    "zh-Hant": "圖像 · 本機連線",
    "en": "IMAGE · LOCAL CONNECTION",
    "ja": "画像 · ローカル接続"
  },
  "connections.comfy.subtitle": {
    "zh-Hans": "本地 ComfyUI · 逐次准备并审批",
    "zh-Hant": "本機 ComfyUI · 每次皆須準備並批准",
    "en": "Local ComfyUI · prepare and approve each request",
    "ja": "ローカル ComfyUI · 毎回準備して承認"
  },
  "connections.comfy.scope": {
    "zh-Hans": "仅连接你已安装并启动的 ComfyUI v0.39.0。不会安装或启动运行时，不会下载模型或自定义节点。打开设置和保存均不探测服务",
    "zh-Hant": "僅連接你已安裝並啟動的 ComfyUI v0.39.0。不會安裝或啟動執行環境，也不會下載模型或自訂節點。開啟設定及儲存皆不會探測服務",
    "en": "Connects only to ComfyUI v0.39.0 that you have already installed and started. It does not install or start the runtime, or download models or custom nodes. Opening and saving settings never probes the service",
    "ja": "インストールして起動済みの ComfyUI v0.39.0 にのみ接続します。ランタイムのインストールや起動、モデルやカスタムノードのダウンロードは行いません。設定を開いたり保存したりしてもサービスを調べません"
  },
  "connections.comfy.moduleScope": {
    "zh-Hans": "模块状态与下方新生成开关相互独立；读取模块状态不探测服务",
    "zh-Hant": "模組狀態與下方的新生成開關互相獨立；讀取模組狀態不會探測服務",
    "en": "Module status is independent of the new-generation switch below. Reading module status does not probe the service",
    "ja": "モジュールの状態と、以下の新規生成スイッチは独立しています。モジュールの状態を読み取ってもサービスを調べません"
  },
  "connections.comfy.reloadModule": {
    "zh-Hans": "重新读取模块状态",
    "zh-Hant": "重新讀取模組狀態",
    "en": "Read module status again",
    "ja": "モジュールの状態を再読み込み"
  },
  "connections.comfy.loading": {
    "zh-Hans": "正在读取本地连接设置…",
    "zh-Hant": "正在讀取本機連線設定…",
    "en": "Reading local connection settings…",
    "ja": "ローカル接続設定を読み込み中…"
  },
  "connections.comfy.enable": {
    "zh-Hans": "允许新的本地 ComfyUI 生成",
    "zh-Hant": "允許新的本機 ComfyUI 生成工作",
    "en": "Allow new local ComfyUI generation",
    "ja": "ローカル ComfyUI の新規生成を許可"
  },
  "connections.comfy.enableScope": {
    "zh-Hans": "仅控制新生成准入，不关闭连接模块或阻止旧任务的明确查询；每次仍需审批",
    "zh-Hant": "僅控制新的生成工作是否允許提交，不會關閉連線模組，也不會阻止明確查詢既有工作；每次仍須批准",
    "en": "Only controls admission of new generation requests. It does not disable the connection module or block explicit queries for existing tasks. Each generation still requires approval",
    "ja": "新規生成リクエストの許可のみを制御します。接続モジュールを無効にしたり、既存タスクへの明示的な照会を妨げたりすることはありません。生成のたびに承認が必要です"
  },
  "connections.comfy.baseUrl": {
    "zh-Hans": "运行中的本机地址",
    "zh-Hant": "正在執行的本機位址",
    "en": "Running local endpoint",
    "ja": "起動中のローカル接続先"
  },
  "connections.comfy.endpointHelp": {
    "zh-Hans": "仅允许明确填写 HTTP 127.0.0.1 或 [::1] 与端口。不接受 localhost、局域网、路径、凭据或查询参数，也不能使用 Mioon 自己的端口。不支持认证",
    "zh-Hant": "僅允許明確填寫 HTTP 127.0.0.1 或 [::1] 與連接埠。不接受 localhost、區域網路、路徑、憑證或查詢參數，也不能使用 Mioon 本身的連接埠。不支援驗證",
    "en": "Explicitly enter HTTP 127.0.0.1 or [::1] with a port. localhost, LAN addresses, paths, credentials, query parameters, and Mioon’s own port are not allowed. Authentication is not supported",
    "ja": "HTTP の 127.0.0.1 または [::1] とポート番号を明示してください。localhost、LAN アドレス、パス、認証情報、クエリパラメーター、Mioon 自身のポートは使用できません。認証には対応していません"
  },
  "connections.comfy.checking": {
    "zh-Hans": "正在检查连接…",
    "zh-Hant": "正在檢查連線…",
    "en": "Checking connection…",
    "ja": "接続を確認中…"
  },
  "connections.comfy.check": {
    "zh-Hans": "检查连接与已安装模型",
    "zh-Hant": "檢查連線與已安裝模型",
    "en": "Check connection and installed models",
    "ja": "接続とインストール済みモデルを確認"
  },
  "connections.comfy.checkScope": {
    "zh-Hans": "仅点击检查才向上方地址发起有界只读查询，读取版本、内置节点和 checkpoint 名单，不发送图像描述或生成任务",
    "zh-Hant": "僅在點選檢查時，才會向上方位址發起有界的唯讀查詢，讀取版本、內建節點與 checkpoint 清單，不會傳送圖像描述或生成工作",
    "en": "Only clicking Check sends bounded read-only queries to the endpoint above for the version, built-in nodes, and checkpoint list. It does not send image prompts or generation tasks",
    "ja": "確認をクリックした場合のみ、上記の接続先に範囲を限定した読み取り専用の照会を行い、バージョン、組み込みノード、checkpoint 一覧を取得します。画像プロンプトや生成タスクは送信しません"
  },
  "connections.comfy.model": {
    "zh-Hans": "已安装 checkpoint",
    "zh-Hant": "已安裝 checkpoint",
    "en": "Installed checkpoint",
    "ja": "インストール済み checkpoint"
  },
  "connections.comfy.chooseModel": {
    "zh-Hans": "请先检查连接，再选择模型",
    "zh-Hant": "請先檢查連線，再選擇模型",
    "en": "Check the connection before selecting a model",
    "ja": "接続を確認してからモデルを選択"
  },
  "connections.comfy.modelScope": {
    "zh-Hans": "服务报告的模型与节点名称不证明兼容性、可信代码或离线运行。最终发送前仍会核验配置与本次连接检查记录；运行时之后可能变化，检查不保证可用。真实生成尚未验证",
    "zh-Hant": "服務回報的模型與節點名稱，不代表相容性、程式碼可信或可離線執行。最終傳送前仍會核驗設定與本次連線檢查記錄；執行環境之後可能變更，檢查不保證可用。實際生成尚未驗證",
    "en": "Model and node names reported by the service do not establish compatibility, trusted code, or offline operation. Configuration and this connection check are verified again before final sending. The runtime may change afterward; a check does not guarantee availability. Live generation is unverified",
    "ja": "サービスが報告したモデル名やノード名だけでは、互換性、コードの信頼性、オフライン動作は確認できません。最終送信前に設定と今回の接続確認記録を再検証します。その後にランタイムが変わる可能性があるため、確認は利用可能性を保証しません。実際の生成は未検証です"
  },
  "connections.comfy.workflow": {
    "zh-Hans": "ComfyUI v0.39.0 · 固定 7 节点文生图",
    "zh-Hant": "ComfyUI v0.39.0 · 固定 7 節點文字生成圖像",
    "en": "ComfyUI v0.39.0 · fixed 7-node text-to-image",
    "ja": "ComfyUI v0.39.0 · 固定 7 ノードのテキストから画像生成"
  },
  "connections.comfy.output": {
    "zh-Hans": "512 × 512 · PNG · 1 张 · 20 steps · CFG 8 · euler / normal",
    "zh-Hant": "512 × 512 · PNG · 1 張 · 20 steps · CFG 8 · euler / normal",
    "en": "512 × 512 · PNG · 1 image · 20 steps · CFG 8 · euler / normal",
    "ja": "512 × 512 · PNG · 1 枚 · 20 steps · CFG 8 · euler / normal"
  },
  "connections.comfy.seed": {
    "zh-Hans": "负向描述固定为空；种子在准备请求时由后端生成",
    "zh-Hant": "負向描述固定為空；種子在準備請求時由後端生成",
    "en": "The negative prompt is fixed to empty. The backend creates the seed when preparing the request",
    "ja": "ネガティブプロンプトは空に固定しています。シードはリクエストの準備時にバックエンドで生成します"
  },
  "connections.comfy.unsandboxed": {
    "zh-Hans": "外部运行时未沙箱化",
    "zh-Hant": "外部執行環境未使用沙箱隔離",
    "en": "External runtime is not sandboxed",
    "ja": "外部ランタイムはサンドボックス化されていません"
  },
  "connections.comfy.saveScope": {
    "zh-Hans": "仅保存连接与模型，不保存密钥",
    "zh-Hant": "僅儲存連線與模型，不儲存密鑰",
    "en": "Saves the connection and model only, not keys",
    "ja": "接続とモデルのみ保存し、キーは保存しません"
  },
  "connections.comfy.recovery": {
    "zh-Hans": "保存结果待核对，草稿保留，不会自动重试或检查服务",
    "zh-Hant": "儲存結果待核對，草稿已保留，不會自動重試或檢查服務",
    "en": "The save result needs verification. Your draft remains. It will not retry or check the service automatically",
    "ja": "保存結果の確認が必要です。下書きは保持されています。自動での再試行やサービスの確認は行いません"
  },
  "connections.comfy.save": {
    "zh-Hans": "保存本地连接设置",
    "zh-Hant": "儲存本機連線設定",
    "en": "Save local connection settings",
    "ja": "ローカル接続設定を保存"
  },
  "agent.settings.modelHints": {
    "zh-Hans": "此协议文本配置：{models}",
    "zh-Hant": "此協定的文字設定：{models}",
    "en": "Text configuration for this protocol: {models}",
    "ja": "このプロトコルのテキスト設定：{models}"
  },
  "agent.settings.modelReview": {
    "zh-Hans": "当前模型不在此协议文本配置中，请手动填写：{models}",
    "zh-Hant": "目前模型不在此協定的文字設定中，請手動填寫：{models}",
    "en": "The current model is not in this protocol’s text configuration. Enter one manually: {models}",
    "ja": "現在のモデルはこのプロトコルのテキスト設定にありません。手動で入力してください：{models}"
  },
  "agent.settings.endpointPreview": {
    "zh-Hans": "{protocol} · 请求地址预览",
    "zh-Hant": "{protocol} · 請求位址預覽",
    "en": "{protocol} · request endpoint preview",
    "ja": "{protocol} · リクエスト送信先のプレビュー"
  },
  "agent.settings.sourceCopy": {
    "zh-Hans": "{label} · 可复制到外部浏览器打开",
    "zh-Hant": "{label} · 可複製至外部瀏覽器開啟",
    "en": "{label} · copy to open in an external browser",
    "ja": "{label} · コピーして外部ブラウザーで開けます"
  },
  "agent.settings.serverKey": {
    "zh-Hans": "服务器已保存 · {storage}",
    "zh-Hant": "伺服器已儲存 · {storage}",
    "en": "Saved on server · {storage}",
    "ja": "サーバーに保存済み · {storage}"
  },
  "connections.savedKey": {
    "zh-Hans": "已保存密钥 · {storage}",
    "zh-Hant": "已儲存密鑰 · {storage}",
    "en": "Key saved · {storage}",
    "ja": "キー保存済み · {storage}"
  },
  "connections.storage.appSession": {
    "zh-Hans": "仅本次运行（应用退出后清除）",
    "zh-Hant": "僅本次執行（應用程式結束後清除）",
    "en": "This session only (cleared when the app exits)",
    "ja": "今回の実行のみ（アプリ終了時に消去）"
  },
  "connections.storage.serverSession": {
    "zh-Hans": "仅本次运行（服务器退出后清除）",
    "zh-Hant": "僅本次執行（伺服器結束後清除）",
    "en": "This session only (cleared when the server exits)",
    "ja": "今回の実行のみ（サーバー終了時に消去）"
  },
  "connections.storage.persistentUnavailable": {
    "zh-Hans": "系统加密保存（不可用）",
    "zh-Hant": "系統加密儲存（無法使用）",
    "en": "System-encrypted storage (unavailable)",
    "ja": "システムで暗号化して保存（利用不可）"
  },
  "image.settings.persistentUnavailable": {
    "zh-Hans": "系统加密保存（当前不可用）",
    "zh-Hant": "系統加密儲存（目前無法使用）",
    "en": "System-encrypted storage (currently unavailable)",
    "ja": "システムで暗号化して保存（現在利用不可）"
  },
  "connections.intentReplace": {
    "zh-Hans": "此次保存：替换密钥 · {storage}",
    "zh-Hant": "此次儲存：更換密鑰 · {storage}",
    "en": "On save: replace key · {storage}",
    "ja": "今回の保存：キーを置き換え · {storage}"
  },
  "connections.intentWrite": {
    "zh-Hans": "此次保存：写入密钥 · {storage}",
    "zh-Hant": "此次儲存：寫入密鑰 · {storage}",
    "en": "On save: store key · {storage}",
    "ja": "今回の保存：キーを書き込み · {storage}"
  },
  "agent.settings.leaveSaving": {
    "zh-Hans": "{action}不会撤回已提交的保存",
    "zh-Hant": "{action}不會撤回已提交的儲存",
    "en": "{action} will not withdraw a save that has already been submitted",
    "ja": "{action}操作では、送信済みの保存は取り消せません"
  },
  "image.settings.currentState": {
    "zh-Hans": "服务器当前设置：{state}",
    "zh-Hant": "伺服器目前設定：{state}",
    "en": "Current server settings: {state}",
    "ja": "現在のサーバー設定：{state}"
  },
  "image.settings.currentKey": {
    "zh-Hans": "密钥：{storage}",
    "zh-Hant": "密鑰：{storage}",
    "en": "Key: {storage}",
    "ja": "キー：{storage}"
  },
  "image.settings.revision": {
    "zh-Hans": "配置版本 r{revision}",
    "zh-Hant": "設定版本 r{revision}",
    "en": "Configuration revision r{revision}",
    "ja": "設定リビジョン r{revision}"
  },
  "image.settings.intentNoneFull": {
    "zh-Hans": "此次保存：仅保存连接设置，尚无密钥",
    "zh-Hant": "此次儲存：僅儲存連線設定，尚無密鑰",
    "en": "On save: connection settings only; no key configured",
    "ja": "今回の保存：接続設定のみ。キーは未設定です"
  },
  "connections.comfy.savedModel": {
    "zh-Hans": "{model}（当前未核验）",
    "zh-Hant": "{model}（目前尚未核驗）",
    "en": "{model} (not currently verified)",
    "ja": "{model}（現在未検証）"
  },
  "connections.comfy.savedEnabled": {
    "zh-Hans": "已保存配置 · 新生成：允许 · r{revision}",
    "zh-Hant": "已儲存設定 · 新生成：允許 · r{revision}",
    "en": "Saved configuration · new generation allowed · r{revision}",
    "ja": "保存済み設定 · 新規生成：許可 · r{revision}"
  },
  "connections.comfy.savedDisabled": {
    "zh-Hans": "已保存配置 · 新生成：关闭 · r{revision}",
    "zh-Hant": "已儲存設定 · 新生成：關閉 · r{revision}",
    "en": "Saved configuration · new generation disabled · r{revision}",
    "ja": "保存済み設定 · 新規生成：無効 · r{revision}"
  },
  "agent.settings.officialDocs": {
    "zh-Hans": "官方文档",
    "zh-Hant": "官方文件",
    "en": "Official documentation",
    "ja": "公式ドキュメント"
  },
  "agent.settings.issue.protocol": {
    "zh-Hans": "请选择明确的 API 协议",
    "zh-Hant": "請選擇明確的 API 協定",
    "en": "Select an explicit API protocol",
    "ja": "API プロトコルを明示的に選択してください"
  },
  "agent.settings.issue.required": {
    "zh-Hans": "请填写服务地址和模型名称",
    "zh-Hant": "請填寫服務位址與模型名稱",
    "en": "Enter the service endpoint and model name",
    "ja": "サービスの接続先とモデル名を入力してください"
  },
  "agent.settings.issue.length": {
    "zh-Hans": "服务地址最多 2048 个字符，模型名称最多 200 个字符",
    "zh-Hant": "服務位址最多 2048 個字元，模型名稱最多 200 個字元",
    "en": "The service endpoint is limited to 2048 characters and the model name to 200",
    "ja": "接続先は 2048 文字以内、モデル名は 200 文字以内で入力してください"
  },
  "agent.settings.issue.urlParts": {
    "zh-Hans": "服务地址不能包含账号、密码、查询参数或片段",
    "zh-Hant": "服務位址不能包含帳號、密碼、查詢參數或片段識別碼",
    "en": "The service endpoint must not contain an account name, password, query parameters, or fragment",
    "ja": "接続先にはアカウント名、パスワード、クエリパラメーター、フラグメントを含められません"
  },
  "agent.settings.issue.https": {
    "zh-Hans": "远程服务地址必须使用 HTTPS",
    "zh-Hant": "遠端服務位址必須使用 HTTPS",
    "en": "Remote service endpoints must use HTTPS",
    "ja": "リモートサービスの接続先には HTTPS が必要です"
  },
  "agent.settings.issue.url": {
    "zh-Hans": "请输入完整的服务地址",
    "zh-Hant": "請輸入完整的服務位址",
    "en": "Enter a complete service endpoint",
    "ja": "完全なサービスの接続先を入力してください"
  },
  "agent.settings.issue.key": {
    "zh-Hans": "密钥不能为空白、包含控制字符或超过 8192 字节",
    "zh-Hant": "密鑰不能為空白、含有控制字元，或超過 8192 位元組",
    "en": "The key must not be blank, contain control characters, or exceed 8192 bytes",
    "ja": "キーは空白のみ、制御文字を含むもの、8192 バイトを超えるものを使用できません"
  },
  "connections.error.unauthorized": {
    "zh-Hans": "登录会话已过期，请重新登录后打开设置",
    "zh-Hant": "登入工作階段已過期，請重新登入後開啟設定",
    "en": "Your sign-in session expired. Sign in again, then open settings",
    "ja": "ログインセッションが期限切れです。再ログインしてから設定を開いてください"
  },
  "agent.settings.error.validation": {
    "zh-Hans": "设置未通过校验。请检查平台、服务地址、模型和密钥格式；内网地址不受支持，本机 Ollama 请使用专用预设",
    "zh-Hant": "設定未通過驗證。請檢查平台、服務位址、模型與密鑰格式；不支援內部網路位址，本機 Ollama 請使用專用預設",
    "en": "Settings failed validation. Check the platform, endpoint, model, and key format. Private network endpoints are unsupported; use the dedicated preset for local Ollama",
    "ja": "設定の検証に失敗しました。プラットフォーム、接続先、モデル、キーの形式を確認してください。内部ネットワークの接続先には対応していません。ローカルの Ollama には専用プリセットを使用してください"
  },
  "agent.settings.error.storage": {
    "zh-Hans": "加密持久保存当前不可用。请查看最新存储状态，选择仅本次运行并重新输入密钥",
    "zh-Hant": "加密持久儲存目前無法使用。請查看最新儲存狀態，選擇僅本次執行並重新輸入密鑰",
    "en": "Encrypted persistent storage is currently unavailable. Review the latest storage status, select session-only storage, and enter the key again",
    "ja": "暗号化した永続保存は現在利用できません。最新の保存状態を確認し、今回の実行のみの保存を選択してキーを再入力してください"
  },
  "agent.settings.error.corrupt": {
    "zh-Hans": "无法读取安全设置。请检查本机安全存储后重试，不会覆盖已有设置",
    "zh-Hant": "無法讀取安全設定。請檢查本機安全儲存後重試，不會覆寫現有設定",
    "en": "Secure settings could not be read. Check local secure storage and retry. Existing settings will not be overwritten",
    "ja": "安全な設定を読み取れませんでした。ローカルの安全なストレージを確認して再試行してください。既存の設定は上書きしません"
  },
  "agent.settings.error.closed": {
    "zh-Hans": "设置服务已关闭，请重新打开应用后重试",
    "zh-Hant": "設定服務已關閉，請重新開啟應用程式後重試",
    "en": "The settings service is closed. Reopen the app and retry",
    "ja": "設定サービスは終了しています。アプリを開き直して再試行してください"
  },
  "connections.error.unknown": {
    "zh-Hans": "未收到保存确认，结果可能已经生效",
    "zh-Hant": "未收到儲存確認，結果可能已經生效",
    "en": "No save acknowledgement was received. The change may already have taken effect",
    "ja": "保存の確認応答を受信できませんでした。変更はすでに反映されている可能性があります"
  },
  "agent.settings.notice.rereading": {
    "zh-Hans": "正在重新读取服务器状态；不会再次提交",
    "zh-Hant": "正在重新讀取伺服器狀態；不會再次提交",
    "en": "Reading server state again. The request will not be resubmitted",
    "ja": "サーバーの状態を再読み込み中です。再送信は行いません"
  },
  "agent.settings.notice.review": {
    "zh-Hans": "已重新读取当前状态。草稿仍保留；请核对后继续，替换密钥需要重新输入",
    "zh-Hant": "已重新讀取目前狀態。草稿仍保留；請核對後繼續，更換密鑰須重新輸入",
    "en": "Current state has been read again. Your draft remains. Review it before continuing; enter the key again to replace it",
    "ja": "現在の状態を再読み込みしました。下書きは保持されています。確認してから続けてください。キーを置き換える場合は再入力が必要です"
  },
  "agent.settings.notice.blocked": {
    "zh-Hans": "暂时无法核实保存结果。草稿已保留，请重新读取状态后再保存",
    "zh-Hant": "暫時無法核實儲存結果。草稿已保留，請重新讀取狀態後再儲存",
    "en": "The save result cannot currently be verified. Your draft remains. Read the state again before saving",
    "ja": "保存結果を現在確認できません。下書きは保持されています。状態を再読み込みしてから保存してください"
  },
  "agent.settings.notice.loadError": {
    "zh-Hans": "暂时无法读取 Mio 设置，请检查工作台连接后重试",
    "zh-Hant": "暫時無法讀取 Mio 設定，請檢查工作台連線後重試",
    "en": "Mio settings cannot currently be read. Check the workbench connection and retry",
    "ja": "Mio 設定を現在読み取れません。ワークベンチの接続を確認して再試行してください"
  },
  "connections.notice.useSaved": {
    "zh-Hans": "已使用当前已保存设置",
    "zh-Hant": "已使用目前已儲存設定",
    "en": "Using the current saved settings",
    "ja": "現在保存されている設定を使用しています"
  },
  "agent.settings.notice.keepDraft": {
    "zh-Hans": "已保留草稿。请确认目标与密钥操作，再点击保存",
    "zh-Hant": "已保留草稿。請確認目標與密鑰操作，再點選儲存",
    "en": "Your draft remains. Confirm the destination and key action, then click Save",
    "ja": "下書きを保持しました。送信先とキーの操作を確認してから、保存をクリックしてください"
  },
  "agent.settings.issue.platformProtocol": {
    "zh-Hans": "此平台尚未提供所选协议配置，请明确选择可用协议",
    "zh-Hant": "此平台尚未提供所選協定的設定，請明確選擇可用協定",
    "en": "This platform does not provide the selected protocol configuration. Explicitly choose an available protocol",
    "ja": "このプラットフォームには選択したプロトコルの設定がありません。利用可能なプロトコルを明示的に選択してください"
  },
  "agent.settings.notice.saving": {
    "zh-Hans": "正在保存连接设置…",
    "zh-Hant": "正在儲存連線設定…",
    "en": "Saving connection settings…",
    "ja": "接続設定を保存中…"
  },
  "agent.settings.notice.savedNone": {
    "zh-Hans": "连接设置已保存；未保存 API 密钥。尚未验证连接",
    "zh-Hant": "連線設定已儲存；未儲存 API 密鑰。尚未驗證連線",
    "en": "Connection settings saved without an API key. The connection is not verified",
    "ja": "API キーなしで接続設定を保存しました。接続は未検証です"
  },
  "agent.settings.notice.savedPersistent": {
    "zh-Hans": "连接设置已保存；密钥由系统加密保存。尚未验证连接",
    "zh-Hant": "連線設定已儲存；密鑰由系統加密儲存。尚未驗證連線",
    "en": "Connection settings saved. The key is system-encrypted. The connection is not verified",
    "ja": "接続設定を保存しました。キーはシステムで暗号化して保存されています。接続は未検証です"
  },
  "agent.settings.notice.savedSession": {
    "zh-Hans": "连接设置已保存；密钥仅在本次运行保留。尚未验证连接",
    "zh-Hant": "連線設定已儲存；密鑰僅於本次執行期間保留。尚未驗證連線",
    "en": "Connection settings saved. The key remains for this session only. The connection is not verified",
    "ja": "接続設定を保存しました。キーは今回の実行中のみ保持されます。接続は未検証です"
  },
  "agent.settings.notice.keyCleared": {
    "zh-Hans": "新输入的密钥已清空，如需替换请重新输入",
    "zh-Hant": "新輸入的密鑰已清除，如需更換請重新輸入",
    "en": "The newly entered key was cleared. Enter it again if you want to replace the saved key",
    "ja": "新しく入力したキーを消去しました。保存済みのキーを置き換える場合は再入力してください"
  },
  "agent.settings.notice.conflictReading": {
    "zh-Hans": "设置已在其他窗口更新，正在读取最新状态",
    "zh-Hant": "設定已在其他視窗更新，正在讀取最新狀態",
    "en": "Settings were updated in another window. Reading the latest state",
    "ja": "別のウィンドウで設定が更新されました。最新の状態を読み込み中です"
  },
  "agent.settings.notice.readNoRetry": {
    "zh-Hans": "正在读取当前状态，不会自动重试",
    "zh-Hant": "正在讀取目前狀態，不會自動重試",
    "en": "Reading current state. It will not be retried automatically",
    "ja": "現在の状態を読み込み中です。自動で再試行することはありません"
  },
  "agent.settings.notice.conflict": {
    "zh-Hans": "保存冲突：已读取其他窗口的最新设置。你的连接草稿仍保留；请核对后继续，替换密钥需要重新输入",
    "zh-Hant": "儲存衝突：已讀取其他視窗的最新設定。你的連線草稿仍保留；請核對後繼續，更換密鑰須重新輸入",
    "en": "Save conflict: the latest settings from another window have been read. Your connection draft remains. Review before continuing; enter the key again to replace it",
    "ja": "保存が競合したため、別のウィンドウの最新設定を読み込みました。接続の下書きは保持されています。確認してから続けてください。キーを置き換える場合は再入力が必要です"
  },
  "agent.settings.notice.unknown": {
    "zh-Hans": "未收到保存确认。已读取当前服务器状态，未自动重试；请核对后继续，替换密钥需要重新输入",
    "zh-Hant": "未收到儲存確認。已讀取目前伺服器狀態，未自動重試；請核對後繼續，更換密鑰須重新輸入",
    "en": "No save acknowledgement was received. Current server state was read without an automatic retry. Review before continuing; enter the key again to replace it",
    "ja": "保存の確認応答を受信できませんでした。自動再試行をせず、現在のサーバー状態を読み込みました。確認してから続けてください。キーを置き換える場合は再入力が必要です"
  },
  "image.settings.issue.key": {
    "zh-Hans": "密钥只能包含非空白 ASCII 字符，最多 {bytes} 字节",
    "zh-Hant": "密鑰只能包含非空白 ASCII 字元，最多 {bytes} 位元組",
    "en": "Keys may contain only non-whitespace ASCII characters, up to {bytes} bytes",
    "ja": "キーには空白以外の ASCII 文字のみ使用でき、最大 {bytes} バイトです"
  },
  "image.settings.error.validation": {
    "zh-Hans": "设置未通过校验，请检查地址、模型和密钥格式",
    "zh-Hant": "設定未通過驗證，請檢查位址、模型與密鑰格式",
    "en": "Settings failed validation. Check the endpoint, model, and key format",
    "ja": "設定の検証に失敗しました。接続先、モデル、キーの形式を確認してください"
  },
  "image.settings.error.storage": {
    "zh-Hans": "系统安全存储当前不可用。请明确选择仅本次运行，并重新输入密钥",
    "zh-Hant": "系統安全儲存目前無法使用。請明確選擇僅本次執行，並重新輸入密鑰",
    "en": "System secure storage is currently unavailable. Explicitly select session-only storage and enter the key again",
    "ja": "システムの安全なストレージは現在利用できません。今回の実行のみの保存を明示的に選択し、キーを再入力してください"
  },
  "image.settings.error.corrupt": {
    "zh-Hans": "无法读取安全设置，不会覆盖已有设置",
    "zh-Hant": "無法讀取安全設定，不會覆寫現有設定",
    "en": "Secure settings could not be read. Existing settings will not be overwritten",
    "ja": "安全な設定を読み取れません。既存の設定は上書きしません"
  },
  "image.settings.error.closed": {
    "zh-Hans": "设置服务已关闭，请重新打开应用",
    "zh-Hant": "設定服務已關閉，請重新開啟應用程式",
    "en": "The settings service is closed. Reopen the app",
    "ja": "設定サービスは終了しています。アプリを開き直してください"
  },
  "image.settings.notice.review": {
    "zh-Hans": "已读取当前设置，草稿保留。请核对后继续；替换密钥需重新输入",
    "zh-Hant": "已讀取目前設定，草稿保留。請核對後繼續；更換密鑰須重新輸入",
    "en": "Current settings have been read and your draft remains. Review before continuing; enter the key again to replace it",
    "ja": "現在の設定を読み込み、下書きを保持しました。確認してから続けてください。キーを置き換える場合は再入力が必要です"
  },
  "image.settings.notice.readBlocked": {
    "zh-Hans": "暂时无法核实保存结果。请重新读取，暂不能保存",
    "zh-Hant": "暫時無法核實儲存結果。請重新讀取，目前不能儲存",
    "en": "The save result cannot currently be verified. Read it again; saving is temporarily blocked",
    "ja": "保存結果を現在確認できません。再読み込みしてください。確認できるまでは保存できません"
  },
  "image.settings.notice.loadError": {
    "zh-Hans": "暂时无法读取图像设置，请重新读取",
    "zh-Hant": "暫時無法讀取圖像設定，請重新讀取",
    "en": "Image settings cannot currently be read. Read them again",
    "ja": "画像設定を現在読み取れません。再読み込みしてください"
  },
  "image.settings.issue.configuration": {
    "zh-Hans": "请填写完整的 HTTPS 公网域名地址和模型标识，或同时清空地址与模型并关闭连接。地址不得含查询、凭据或非 443 端口",
    "zh-Hant": "請填寫完整的 HTTPS 公開網域位址與模型識別碼，或同時清空位址與模型並關閉連線。位址不得包含查詢、憑證或非 443 連接埠",
    "en": "Enter a complete HTTPS public-domain endpoint and model ID, or clear both and disable the connection. The endpoint must not contain queries, credentials, or a port other than 443",
    "ja": "HTTPS の公開ドメインの完全な接続先とモデル ID を入力するか、両方を空にして接続を無効にしてください。接続先にクエリ、認証情報、443 以外のポートを含めることはできません"
  },
  "image.settings.issue.binding": {
    "zh-Hans": "地址或模型已变化。请重新输入此连接的新密钥，或明确移除原密钥后保存；原密钥不会带到新地址",
    "zh-Hant": "位址或模型已變更。請重新輸入此連線的新密鑰，或明確移除原密鑰後儲存；原密鑰不會傳至新位址",
    "en": "The endpoint or model changed. Enter a new key for this connection, or explicitly remove the original key before saving. The original key will not be carried to the new endpoint",
    "ja": "接続先またはモデルが変更されています。この接続の新しいキーを入力するか、元のキーを明示的に削除してから保存してください。元のキーが新しい接続先に引き継がれることはありません"
  },
  "image.settings.issue.storage": {
    "zh-Hans": "请选择密钥的保存方式",
    "zh-Hant": "請選擇密鑰的儲存方式",
    "en": "Choose how to store the key",
    "ja": "キーの保存方法を選択してください"
  },
  "image.settings.notice.savedPersistent": {
    "zh-Hans": "图像设置已保存。密钥由系统加密保存。保存不会发送图像请求；真实调用尚未验证",
    "zh-Hant": "圖像設定已儲存。密鑰由系統加密儲存。儲存不會傳送圖像請求；實際呼叫尚未驗證",
    "en": "Image settings saved. The key is system-encrypted. Saving does not send image requests; live requests are unverified",
    "ja": "画像設定を保存しました。キーはシステムで暗号化されています。保存では画像リクエストを送信しません。実際のリクエストは未検証です"
  },
  "image.settings.notice.savedSession": {
    "zh-Hans": "图像设置已保存。密钥仅在本次后端运行中保留。保存不会发送图像请求；真实调用尚未验证",
    "zh-Hant": "圖像設定已儲存。密鑰僅於本次後端執行期間保留。儲存不會傳送圖像請求；實際呼叫尚未驗證",
    "en": "Image settings saved. The key remains for this backend session only. Saving does not send image requests; live requests are unverified",
    "ja": "画像設定を保存しました。キーは今回のバックエンド実行中のみ保持されます。保存では画像リクエストを送信しません。実際のリクエストは未検証です"
  },
  "image.settings.notice.savedNone": {
    "zh-Hans": "图像设置已保存。尚未配置密钥。保存不会发送图像请求；真实调用尚未验证",
    "zh-Hant": "圖像設定已儲存。尚未設定密鑰。儲存不會傳送圖像請求；實際呼叫尚未驗證",
    "en": "Image settings saved. No key is configured. Saving does not send image requests; live requests are unverified",
    "ja": "画像設定を保存しました。キーは未設定です。保存では画像リクエストを送信しません。実際のリクエストは未検証です"
  },
  "image.settings.notice.keyCleared": {
    "zh-Hans": "新输入的密钥已清空",
    "zh-Hant": "新輸入的密鑰已清除",
    "en": "The newly entered key was cleared",
    "ja": "新しく入力したキーを消去しました"
  },
  "image.settings.notice.rereading": {
    "zh-Hans": "正在读取当前状态，不会自动重新保存",
    "zh-Hant": "正在讀取目前狀態，不會自動重新儲存",
    "en": "Reading current state. It will not save again automatically",
    "ja": "現在の状態を読み込み中です。自動で再保存することはありません"
  },
  "image.settings.notice.conflict": {
    "zh-Hans": "设置已在其他窗口变化。你的草稿保留，请核对后继续；替换密钥需重新输入",
    "zh-Hant": "設定已在其他視窗變更。你的草稿保留，請核對後繼續；更換密鑰須重新輸入",
    "en": "Settings changed in another window. Your draft remains. Review before continuing; enter the key again to replace it",
    "ja": "別のウィンドウで設定が変更されました。下書きは保持されています。確認してから続けてください。キーを置き換える場合は再入力が必要です"
  },
  "image.settings.notice.unknown": {
    "zh-Hans": "已读取当前状态，未自动重试。请核对后继续；替换密钥需重新输入",
    "zh-Hant": "已讀取目前狀態，未自動重試。請核對後繼續；更換密鑰須重新輸入",
    "en": "Current state was read without an automatic retry. Review before continuing; enter the key again to replace it",
    "ja": "自動で再試行せず、現在の状態を読み込みました。確認してから続けてください。キーを置き換える場合は再入力が必要です"
  },
  "connections.notice.blocked": {
    "zh-Hans": "暂时无法核实保存结果。草稿保留，请重新读取后再保存",
    "zh-Hant": "暫時無法核實儲存結果。草稿保留，請重新讀取後再儲存",
    "en": "The save result cannot currently be verified. Your draft remains. Read it again before saving",
    "ja": "保存結果を現在確認できません。下書きは保持されています。再読み込みしてから保存してください"
  },
  "image.settings.notice.keepDraft": {
    "zh-Hans": "已保留草稿，请重新确认密钥操作后保存",
    "zh-Hant": "已保留草稿，請重新確認密鑰操作後儲存",
    "en": "Your draft remains. Confirm the key action again before saving",
    "ja": "下書きを保持しました。キーの操作を再確認してから保存してください"
  },
  "connections.comfy.moduleUnknown": {
    "zh-Hans": "模块状态未确认：新的连接检查、生成审批与远端查询已暂停。可重新读取本地状态；已保存图像、任务与本地恢复仍可使用",
    "zh-Hant": "模組狀態尚未確認：新的連線檢查、生成批准與遠端查詢已暫停。可重新讀取本機狀態；已儲存圖像、工作與本機還原仍可使用",
    "en": "Module status is unconfirmed. New connection checks, generation approvals, and remote queries are paused. Read local state again; saved images, tasks, and local recovery remain available",
    "ja": "モジュールの状態が未確認です。新たな接続確認、生成の承認、リモート照会を一時停止しています。ローカルの状態を再読み込みできます。保存済みの画像、タスク、ローカル復元は引き続き利用できます"
  },
  "connections.comfy.moduleMissing": {
    "zh-Hans": "当前发行版未提供 ComfyUI 连接模块。已保存的配置、图像与任务仍保留；不能发起新的连接检查、生成或远端查询",
    "zh-Hant": "目前發行版未提供 ComfyUI 連線模組。已儲存的設定、圖像與工作仍保留；不能發起新的連線檢查、生成或遠端查詢",
    "en": "This distribution does not provide the ComfyUI connection module. Saved settings, images, and tasks remain, but new connection checks, generation, and remote queries cannot be started",
    "ja": "この配布版には ComfyUI 接続モジュールが含まれていません。保存済みの設定、画像、タスクは保持されていますが、新たな接続確認、生成、リモート照会は開始できません"
  },
  "connections.comfy.moduleUnloaded": {
    "zh-Hans": "本次启动未加载 ComfyUI 连接模块。已保存的配置、图像与任务仍保留；不能发起新的连接检查、生成或远端查询",
    "zh-Hant": "本次啟動未載入 ComfyUI 連線模組。已儲存的設定、圖像與工作仍保留；不能發起新的連線檢查、生成或遠端查詢",
    "en": "The ComfyUI connection module was not loaded at this startup. Saved settings, images, and tasks remain, but new connection checks, generation, and remote queries cannot be started",
    "ja": "今回の起動では ComfyUI 接続モジュールが読み込まれていません。保存済みの設定、画像、タスクは保持されていますが、新たな接続確認、生成、リモート照会は開始できません"
  },
  "connections.comfy.moduleAvailable": {
    "zh-Hans": "官方 ComfyUI 连接模块可用 · 实现版本 1。本次启动状态固定；这不代表外部 ComfyUI 服务或模型可用",
    "zh-Hant": "官方 ComfyUI 連線模組可用 · 實作版本 1。本次啟動狀態固定；這不代表外部 ComfyUI 服務或模型可用",
    "en": "Official ComfyUI connection module available · implementation version 1. This status is fixed for this startup; it does not mean the external ComfyUI service or models are available",
    "ja": "公式 ComfyUI 接続モジュールを利用できます · 実装バージョン 1。この状態は今回の起動中は固定で、外部の ComfyUI サービスやモデルが利用可能であることを意味しません"
  },
  "connections.comfy.checkNone": {
    "zh-Hans": "未检查当前地址。保存设置不代表服务可用，也不会检查模型",
    "zh-Hant": "尚未檢查目前位址。儲存設定不代表服務可用，也不會檢查模型",
    "en": "The current endpoint has not been checked. Saving settings does not establish service availability or check models",
    "ja": "現在の接続先は未確認です。設定の保存はサービスの利用可能性を示すものではなく、モデルの確認も行いません"
  },
  "connections.comfy.checkPassed": {
    "zh-Hans": "本次只读检查已通过：版本、所需内置节点和 checkpoint 名单可读。尚未验证真实生成、模型兼容性或可信代码",
    "zh-Hant": "本次唯讀檢查已通過：版本、所需內建節點與 checkpoint 清單可讀。尚未驗證實際生成、模型相容性或程式碼是否可信",
    "en": "This read-only check passed: the version, required built-in nodes, and checkpoint list are readable. Live generation, model compatibility, and trusted code are unverified",
    "ja": "今回の読み取り専用チェックに合格しました。バージョン、必要な組み込みノード、checkpoint 一覧を読み取れます。実際の生成、モデルの互換性、コードの信頼性は未検証です"
  },
  "connections.comfy.checkEmpty": {
    "zh-Hans": "未发现可选 checkpoint。请自行准备兼容模型后，再明确检查；不会自动下载或安装",
    "zh-Hant": "未找到可選的 checkpoint。請自行準備相容模型後，再明確執行檢查；不會自動下載或安裝",
    "en": "No selectable checkpoints were found. Prepare a compatible model yourself, then explicitly check again. Nothing will be downloaded or installed automatically",
    "ja": "選択可能な checkpoint が見つかりませんでした。互換モデルをご自身で用意し、明示的に再確認してください。自動ダウンロードやインストールは行いません"
  },
  "connections.comfy.notice.review": {
    "zh-Hans": "已读取当前保存状态。草稿保留，请核对后继续；没有检查服务或重试保存",
    "zh-Hant": "已讀取目前儲存狀態。草稿保留，請核對後繼續；未檢查服務，也未重試儲存",
    "en": "Current saved state was read. Your draft remains; review before continuing. The service was not checked and saving was not retried",
    "ja": "現在の保存状態を読み込みました。下書きは保持されています。確認してから続けてください。サービスの確認や保存の再試行は行っていません"
  },
  "connections.comfy.notice.loadError": {
    "zh-Hans": "暂时无法读取本地连接设置。不会覆盖已有设置，请重新读取",
    "zh-Hant": "暫時無法讀取本機連線設定。不會覆寫現有設定，請重新讀取",
    "en": "Local connection settings cannot currently be read. Existing settings will not be overwritten. Read them again",
    "ja": "ローカル接続設定を現在読み取れません。既存の設定は上書きしません。再読み込みしてください"
  },
  "connections.comfy.issue.configuration": {
    "zh-Hans": "请填写明确的本机 HTTP 地址与端口，并从检查返回的名单选择 checkpoint；或同时清空地址与模型并关闭连接",
    "zh-Hant": "請填寫明確的本機 HTTP 位址與連接埠，並從檢查回傳的清單選擇 checkpoint；或同時清空位址與模型並關閉連線",
    "en": "Enter an explicit local HTTP endpoint and port, and select a checkpoint from the check results. Alternatively, clear both endpoint and model and disable the connection",
    "ja": "ローカルの HTTP 接続先とポートを明示し、確認結果の一覧から checkpoint を選択してください。または、接続先とモデルを両方空にして接続を無効にしてください"
  },
  "connections.comfy.notice.saved": {
    "zh-Hans": "本地连接设置已保存。没有探测服务或生成图像；每次生成仍需准备并审批",
    "zh-Hant": "本機連線設定已儲存。未探測服務或生成圖像；每次生成仍須準備並批准",
    "en": "Local connection settings saved. The service was not probed and no images were generated. Each generation still requires preparation and approval",
    "ja": "ローカル接続設定を保存しました。サービスの調査や画像生成は行っていません。生成のたびに準備と承認が必要です"
  },
  "connections.comfy.notice.rejected": {
    "zh-Hans": "此次设置未被接受。请检查本机地址、端口与 checkpoint；必要时重新登录",
    "zh-Hant": "此次設定未被接受。請檢查本機位址、連接埠與 checkpoint；必要時重新登入",
    "en": "These settings were not accepted. Check the local endpoint, port, and checkpoint. Sign in again if necessary",
    "ja": "今回の設定は受け付けられませんでした。ローカル接続先、ポート、checkpoint を確認し、必要に応じて再ログインしてください"
  },
  "connections.comfy.notice.rereading": {
    "zh-Hans": "正在读取当前保存状态，不会重试保存或检查服务",
    "zh-Hant": "正在讀取目前儲存狀態，不會重試儲存或檢查服務",
    "en": "Reading current saved state. Saving will not be retried and the service will not be checked",
    "ja": "現在の保存状態を読み込み中です。保存の再試行やサービスの確認は行いません"
  },
  "connections.comfy.notice.conflict": {
    "zh-Hans": "设置已在其他窗口变化。草稿保留，请核对后继续",
    "zh-Hant": "設定已在其他視窗變更。草稿保留，請核對後繼續",
    "en": "Settings changed in another window. Your draft remains; review before continuing",
    "ja": "別のウィンドウで設定が変更されました。下書きは保持されています。確認してから続けてください"
  },
  "connections.comfy.notice.unknown": {
    "zh-Hans": "保存结果尚未确认。已读取当前设置，请核对；不会自动重试",
    "zh-Hant": "儲存結果尚未確認。已讀取目前設定，請核對；不會自動重試",
    "en": "The save result is unconfirmed. Current settings have been read for you to review. It will not be retried automatically",
    "ja": "保存結果は未確認です。現在の設定を読み込みましたので、確認してください。自動で再試行することはありません"
  },
  "connections.comfy.issue.endpoint": {
    "zh-Hans": "请填写 HTTP 127.0.0.1 或 [::1] 与明确端口。没有发起检查",
    "zh-Hant": "請填寫 HTTP 127.0.0.1 或 [::1] 與明確連接埠。尚未發起檢查",
    "en": "Enter HTTP 127.0.0.1 or [::1] with an explicit port. No check was started",
    "ja": "HTTP の 127.0.0.1 または [::1] とポート番号を明示してください。確認は開始していません"
  },
  "connections.comfy.notice.checkedConflict": {
    "zh-Hans": "检查完成，但保存设置已在其他窗口变化。草稿保留，请核对后继续",
    "zh-Hant": "檢查完成，但儲存設定已在其他視窗變更。草稿保留，請核對後繼續",
    "en": "The check finished, but saved settings changed in another window. Your draft remains; review before continuing",
    "ja": "確認は完了しましたが、別のウィンドウで保存設定が変更されています。下書きは保持されています。確認してから続けてください"
  },
  "connections.comfy.notice.checked": {
    "zh-Hans": "检查完成；没有保存设置或生成图像",
    "zh-Hant": "檢查完成；未儲存設定或生成圖像",
    "en": "Check finished. Settings were not saved and no images were generated",
    "ja": "確認が完了しました。設定の保存や画像生成は行っていません"
  },
  "connections.comfy.notice.checkError": {
    "zh-Hans": "无法核验当前连接或依赖。没有生成图像，也不会自动重试检查",
    "zh-Hant": "無法核驗目前連線或相依項目。未生成圖像，也不會自動重試檢查",
    "en": "The current connection or dependencies could not be verified. No images were generated and the check will not be retried automatically",
    "ja": "現在の接続または依存関係を検証できませんでした。画像は生成していません。確認の自動再試行も行いません"
  },
  "connections.comfy.notice.keepDraft": {
    "zh-Hans": "草稿已保留。请重新核对后明确保存",
    "zh-Hant": "草稿已保留。請重新核對後明確儲存",
    "en": "Your draft remains. Review it again, then explicitly save",
    "ja": "下書きを保持しました。再確認したうえで、明示的に保存してください"
  },
  "connections.comfy.notice.useSaved": {
    "zh-Hans": "已使用当前已保存设置。连接仍未重新检查",
    "zh-Hant": "已使用目前已儲存設定。連線仍未重新檢查",
    "en": "Using current saved settings. The connection has not been checked again",
    "ja": "現在保存されている設定を使用しています。接続の再確認は行っていません"
  },
  "agent.settings.presets.custom": {
    "zh-Hans": "自定义兼容服务",
    "zh-Hant": "自訂相容服務",
    "en": "Custom compatible service",
    "ja": "カスタム互換サービス"
  },
  "agent.settings.presets.ollama": {
    "zh-Hans": "Ollama 本地",
    "zh-Hant": "Ollama 本機",
    "en": "Local Ollama",
    "ja": "ローカル Ollama"
  },
  "agent.settings.presets.openaiNote": {
    "zh-Hans": "非推理文本基线；可明确选择 Chat Completions 或 Responses",
    "zh-Hant": "非推理文字基準；可明確選擇 Chat Completions 或 Responses",
    "en": "Non-reasoning text baseline. Explicitly select Chat Completions or Responses",
    "ja": "非推論テキストの基準設定です。Chat Completions または Responses を明示的に選択できます"
  },
  "agent.settings.presets.anthropicNote": {
    "zh-Hans": "Messages 文本与 Mio 宿主工具基线；关闭思考，账户及模型访问权限由供应商决定",
    "zh-Hant": "Messages 文字與 Mio 宿主工具基準；停用思考，帳戶與模型存取權限由供應商決定",
    "en": "Messages text and Mio host-tool baseline with thinking disabled. Account and model access depend on the provider",
    "ja": "思考を無効にした Messages テキストと Mio ホストツールの基準設定です。アカウントとモデルへのアクセス権はプロバイダーに依存します"
  },
  "agent.settings.presets.deepseekNote": {
    "zh-Hans": "非思考模式文本基线；可明确选择 Chat Completions 或 Responses",
    "zh-Hant": "非思考模式文字基準；可明確選擇 Chat Completions 或 Responses",
    "en": "Non-thinking text baseline. Explicitly select Chat Completions or Responses",
    "ja": "非思考モードのテキスト基準設定です。Chat Completions または Responses を明示的に選択できます"
  },
  "agent.settings.presets.qwenNote": {
    "zh-Hans": "区域、工作空间和按量付费账户必须匹配；不继承 Coding Plan 凭证",
    "zh-Hant": "區域、工作空間與按量付費帳戶必須相符；不會沿用 Coding Plan 憑證",
    "en": "The region, workspace, and pay-as-you-go account must match. Coding Plan credentials are not inherited",
    "ja": "リージョン、ワークスペース、従量課金アカウントを一致させてください。Coding Plan の認証情報は引き継ぎません"
  },
  "agent.settings.presets.qwenWorkspace": {
    "zh-Hans": "请填写账户实际工作空间端点；模板不是可直接使用的地址",
    "zh-Hant": "請填寫帳戶實際的工作空間端點；範本並非可直接使用的位址",
    "en": "Enter your account’s actual workspace endpoint. The template is not a usable endpoint",
    "ja": "アカウントの実際のワークスペース接続先を入力してください。テンプレートはそのまま使用できる接続先ではありません"
  },
  "agent.settings.presets.zhipuNote": {
    "zh-Hans": "中国 BigModel 与国际 Z.ai 是独立平台，密钥不假定通用",
    "zh-Hant": "中國 BigModel 與國際 Z.ai 為獨立平台，不假定密鑰可通用",
    "en": "China’s BigModel and international Z.ai are separate platforms. Do not assume keys are interchangeable",
    "ja": "中国の BigModel と国際版 Z.ai は別のプラットフォームです。キーを共通で使えるとは限りません"
  },
  "agent.settings.presets.kimiNote": {
    "zh-Hans": "K2.6 非思考模式基线；区域账户分别配置",
    "zh-Hant": "K2.6 非思考模式基準；區域帳戶須分別設定",
    "en": "K2.6 non-thinking baseline. Configure regional accounts separately",
    "ja": "K2.6 の非思考モードの基準設定です。リージョンごとにアカウントを設定してください"
  },
  "agent.settings.presets.minimaxNote": {
    "zh-Hans": "MiniMax-M3 非思考模式基线；不自动切换到套餐专用模型",
    "zh-Hant": "MiniMax-M3 非思考模式基準；不會自動切換至方案專用模型",
    "en": "MiniMax-M3 non-thinking baseline. It will not switch to plan-specific models automatically",
    "ja": "MiniMax-M3 の非思考モードの基準設定です。プラン専用モデルへの自動切り替えは行いません"
  },
  "agent.settings.presets.openrouterNote": {
    "zh-Hans": "实际能力取决于所选模型和路由供应商",
    "zh-Hant": "實際能力取決於所選模型與路由供應商",
    "en": "Actual capabilities depend on the selected model and routing provider",
    "ja": "実際の機能は、選択したモデルとルーティング先のプロバイダーによって異なります"
  },
  "agent.settings.presets.customNote": {
    "zh-Hans": "仅远程 HTTPS；地址和模型由你填写，兼容性未验证",
    "zh-Hant": "僅限遠端 HTTPS；位址與模型由你填寫，相容性尚未驗證",
    "en": "Remote HTTPS only. Enter the endpoint and model yourself. Compatibility is unverified",
    "ja": "リモート HTTPS のみです。接続先とモデルはご自身で入力してください。互換性は未検証です"
  },
  "agent.settings.presets.ollamaNote": {
    "zh-Hans": "仅本机回环；Chat Completions / Responses 基址使用 /v1，Messages 使用根地址。切换协议后请自行核对地址；不下载模型或授权云端路由",
    "zh-Hant": "僅限本機回環；Chat Completions / Responses 基底位址使用 /v1，Messages 使用根位址。切換協定後請自行核對位址；不會下載模型或授權雲端路由",
    "en": "Local loopback only. Use /v1 as the base path for Chat Completions / Responses and the service root for Messages. Check the URL after switching protocols. No model downloads or cloud routing authorization",
    "ja": "ローカルループバックのみです。Chat Completions / Responses のベースパスは /v1、Messages はサービスルートです。切り替え後は URL を確認してください。モデルのダウンロードやクラウドルーティングの認可は行いません"
  },
  "agent.settings.presets.qwenResponses": {
    "zh-Hans": "仅 qwen3.8-flash 非思考文本配置；本应用限制上下文大小，但供应商自动截断无法禁用。区域、工作空间与账户权限须匹配，未经真实调用验证",
    "zh-Hant": "僅限 qwen3.8-flash 非思考文字設定；本應用程式會限制上下文大小，但無法停用供應商的自動截斷。區域、工作空間與帳戶權限須相符，尚未經實際呼叫驗證",
    "en": "Only the qwen3.8-flash non-thinking text configuration is supported. This app limits context size, but provider auto-truncation cannot be disabled. The region, workspace, and account permissions must match. Live requests are unverified",
    "ja": "qwen3.8-flash の非思考テキスト設定のみ対応しています。アプリはコンテキストサイズを制限しますが、プロバイダーの自動切り詰めは無効にできません。リージョン、ワークスペース、アカウント権限を一致させる必要があります。実際のリクエストは未検証です"
  },
  "agent.settings.platform.beijing": {
    "zh-Hans": "北京 · 按量付费",
    "zh-Hant": "北京 · 按量付費",
    "en": "Beijing · pay as you go",
    "ja": "北京 · 従量課金"
  },
  "agent.settings.platform.singapore": {
    "zh-Hans": "新加坡 · 按量付费",
    "zh-Hant": "新加坡 · 按量付費",
    "en": "Singapore · pay as you go",
    "ja": "シンガポール · 従量課金"
  },
  "agent.settings.platform.workspaceBeijing": {
    "zh-Hans": "北京 · 工作空间端点",
    "zh-Hant": "北京 · 工作空間端點",
    "en": "Beijing · workspace endpoint",
    "ja": "北京 · ワークスペース接続先"
  },
  "agent.settings.platform.workspaceSingapore": {
    "zh-Hans": "新加坡 · 工作空间端点",
    "zh-Hant": "新加坡 · 工作空間端點",
    "en": "Singapore · workspace endpoint",
    "ja": "シンガポール · ワークスペース接続先"
  },
  "agent.settings.platform.workspaceUs": {
    "zh-Hans": "美国东部 · 工作空间端点",
    "zh-Hant": "美國東部 · 工作空間端點",
    "en": "US East · workspace endpoint",
    "ja": "米国東部 · ワークスペース接続先"
  },
  "agent.settings.platform.workspaceHongkong": {
    "zh-Hans": "香港 · 工作空间端点",
    "zh-Hant": "香港 · 工作空間端點",
    "en": "Hong Kong · workspace endpoint",
    "ja": "香港 · ワークスペース接続先"
  },
  "agent.settings.platform.workspaceTokyo": {
    "zh-Hans": "东京 · 工作空间端点",
    "zh-Hant": "東京 · 工作空間端點",
    "en": "Tokyo · workspace endpoint",
    "ja": "東京 · ワークスペース接続先"
  },
  "agent.settings.platform.workspaceFrankfurt": {
    "zh-Hans": "法兰克福 · 工作空间端点",
    "zh-Hant": "法蘭克福 · 工作空間端點",
    "en": "Frankfurt · workspace endpoint",
    "ja": "フランクフルト · ワークスペース接続先"
  },
  "agent.settings.platform.china": {
    "zh-Hans": "中国 · {brand}",
    "zh-Hant": "中國 · {brand}",
    "en": "China · {brand}",
    "ja": "中国 · {brand}"
  },
  "agent.settings.platform.international": {
    "zh-Hans": "国际 · {brand}",
    "zh-Hant": "國際 · {brand}",
    "en": "International · {brand}",
    "ja": "国際 · {brand}"
  },
  "agent.settings.platform.custom": {
    "zh-Hans": "自定义 · 远程 HTTPS",
    "zh-Hant": "自訂 · 遠端 HTTPS",
    "en": "Custom · remote HTTPS",
    "ja": "カスタム · リモート HTTPS"
  },
  "agent.settings.platform.local": {
    "zh-Hans": "本机 · Ollama",
    "zh-Hant": "本機 · Ollama",
    "en": "Local · Ollama",
    "ja": "ローカル · Ollama"
  },
  "connections.generation.available": {
    "zh-Hans": "可用",
    "zh-Hant": "可用",
    "en": "Available",
    "ja": "利用可能"
  },
  "connections.generation.notConfigured": {
    "zh-Hans": "配置未完成",
    "zh-Hant": "設定未完成",
    "en": "Configuration incomplete",
    "ja": "設定未完了"
  },
  "connections.generation.unavailable": {
    "zh-Hans": "不可用",
    "zh-Hant": "無法使用",
    "en": "Unavailable",
    "ja": "利用不可"
  },
  "connections.generation.providerMissing": {
    "zh-Hans": "未找到生成服务商，请刷新工作台后重试",
    "zh-Hant": "找不到生成服務商，請重新整理工作台後重試",
    "en": "No generation provider was found. Refresh the workbench and retry",
    "ja": "生成プロバイダーが見つかりません。ワークベンチを更新して再試行してください"
  },
  "connections.generation.providerDisabled": {
    "zh-Hans": "{provider}：未启用。请按下方服务器配置说明完成设置后重启服务",
    "zh-Hant": "{provider}：未啟用。請依照下方伺服器設定說明完成設定後重新啟動服務",
    "en": "{provider}: disabled. Follow the server configuration instructions below, then restart the service",
    "ja": "{provider}：無効です。以下のサーバー設定手順に従って設定を完了し、サービスを再起動してください"
  },
  "connections.generation.providerIncomplete": {
    "zh-Hans": "{provider}：配置未完成。请按下方服务器配置说明完成设置后重启服务",
    "zh-Hant": "{provider}：設定未完成。請依照下方伺服器設定說明完成設定後重新啟動服務",
    "en": "{provider}: configuration incomplete. Follow the server configuration instructions below, then restart the service",
    "ja": "{provider}：設定未完了です。以下のサーバー設定手順に従って設定を完了し、サービスを再起動してください"
  },
  "connections.generation.providerUnavailable": {
    "zh-Hans": "{provider}：不可用。请按下方服务器配置说明完成设置后重启服务",
    "zh-Hant": "{provider}：無法使用。請依照下方伺服器設定說明完成設定後重新啟動服務",
    "en": "{provider}: unavailable. Follow the server configuration instructions below, then restart the service",
    "ja": "{provider}：利用できません。以下のサーバー設定手順に従って設定を完了し、サービスを再起動してください"
  },
  "connections.generation.textMode": {
    "zh-Hans": "文生视频",
    "zh-Hant": "文字生成影片",
    "en": "Text to video",
    "ja": "テキストから動画"
  },
  "connections.generation.imageMode": {
    "zh-Hans": "图生视频",
    "zh-Hant": "圖片生成影片",
    "en": "Image to video",
    "ja": "画像から動画"
  },
  "connections.generation.subjectMode": {
    "zh-Hans": "主体图片视频",
    "zh-Hant": "主體圖片影片",
    "en": "Subject-image video",
    "ja": "被写体画像から動画"
  },
  "connections.generation.profileUnloaded": {
    "zh-Hans": "服务商信息未加载或不可用，输入限制尚未确认",
    "zh-Hant": "服務商資訊尚未載入或無法使用，輸入限制尚未確認",
    "en": "Provider information is unloaded or unavailable. Input limits are not confirmed",
    "ja": "プロバイダー情報が未読み込みか利用不可のため、入力制限は未確認です"
  },
  "connections.generation.profileUnselected": {
    "zh-Hans": "尚未选择模型，输入限制尚未确认",
    "zh-Hant": "尚未選擇模型，輸入限制尚未確認",
    "en": "No model is selected. Input limits are not confirmed",
    "ja": "モデルが未選択のため、入力制限は未確認です"
  },
  "connections.generation.profileUnknownModel": {
    "zh-Hans": "未识别所选精确模型，不能沿用其他模型的输入限制",
    "zh-Hant": "無法識別所選的確切模型，不能沿用其他模型的輸入限制",
    "en": "The exact selected model is not recognized. Input limits from other models cannot be reused",
    "ja": "選択した正確なモデルを認識できません。他のモデルの入力制限は流用できません"
  },
  "connections.generation.profileRegion": {
    "zh-Hans": "服务器未提供 API 区域，输入限制尚未确认",
    "zh-Hant": "伺服器未提供 API 區域，輸入限制尚未確認",
    "en": "The server did not provide an API region. Input limits are not confirmed",
    "ja": "サーバーから API リージョンが提供されていないため、入力制限は未確認です"
  },
  "connections.generation.profileVersion": {
    "zh-Hans": "输入配置版本缺失或无法识别，请刷新工作台后核对",
    "zh-Hant": "輸入設定版本缺失或無法識別，請重新整理工作台後核對",
    "en": "The input profile version is missing or unrecognized. Refresh the workbench and review it",
    "ja": "入力プロファイルのバージョンが欠けているか認識できません。ワークベンチを更新して確認してください"
  },
  "connections.generation.profileMissing": {
    "zh-Hans": "未取得此模型与 API 区域的唯一输入配置，不能推断支持情况",
    "zh-Hant": "未取得此模型與 API 區域唯一對應的輸入設定，無法推斷支援情況",
    "en": "No unique input profile was obtained for this model and API region. Support cannot be inferred",
    "ja": "このモデルと API リージョンに対応する一意の入力プロファイルを取得できませんでした。対応状況は推測できません"
  },
  "connections.generation.profileIncomplete": {
    "zh-Hans": "此模型的输入配置不完整，请刷新服务商信息后核对",
    "zh-Hant": "此模型的輸入設定不完整，請重新整理服務商資訊後核對",
    "en": "The model’s input profile is incomplete. Refresh provider information and review it",
    "ja": "このモデルの入力プロファイルが不完全です。プロバイダー情報を更新して確認してください"
  },
  "connections.generation.profileEvaluation": {
    "zh-Hans": "尚未取得服务器的输入配置评估，不能确认当前可提交；请刷新后核对",
    "zh-Hant": "尚未取得伺服器的輸入設定評估，無法確認目前可提交；請重新整理後核對",
    "en": "The server’s input profile evaluation is not available. Submission readiness cannot be confirmed. Refresh and review",
    "ja": "サーバーの入力プロファイル評価を取得できていないため、現在送信できるか確認できません。更新して確認してください"
  },
  "connections.generation.subjectProvider": {
    "zh-Hans": "主体图片视频仅接入 Mock 与 Ark 的 doubao-seedance-2-5-260628，不会自动切换其他模型或服务商",
    "zh-Hant": "主體圖片影片僅接入 Mock 與 Ark 的 doubao-seedance-2-5-260628，不會自動切換至其他模型或服務商",
    "en": "Subject-image video is integrated only with Mock and Ark’s doubao-seedance-2-5-260628. Models and providers will not switch automatically",
    "ja": "被写体画像からの動画生成は、Mock と Ark の doubao-seedance-2-5-260628 にのみ対応しています。他のモデルやプロバイダーに自動で切り替えることはありません"
  },
  "connections.generation.subjectProfile": {
    "zh-Hans": "主体输入配置尚未确认，请刷新服务商信息",
    "zh-Hant": "主體輸入設定尚未確認，請重新整理服務商資訊",
    "en": "The subject input profile is unconfirmed. Refresh provider information",
    "ja": "被写体入力プロファイルは未確認です。プロバイダー情報を更新してください"
  },
  "connections.generation.subjectUnsupported": {
    "zh-Hans": "当前精确模型与区域尚未开放单张主体图片输入，请核对服务器配置",
    "zh-Hant": "目前的確切模型與區域尚未開放單張主體圖片輸入，請核對伺服器設定",
    "en": "Single subject-image input is not enabled for this exact model and region. Review server configuration",
    "ja": "この正確なモデルとリージョンでは、1 枚の被写体画像入力は有効になっていません。サーバー設定を確認してください"
  },
  "connections.generation.issue.metadata": {
    "zh-Hans": "参考素材的文件大小元数据不可用，服务器核对后才能提交",
    "zh-Hant": "參考素材的檔案大小中繼資料無法使用，須經伺服器核對後才能提交",
    "en": "Reference asset file-size metadata is unavailable. The server must verify it before submission",
    "ja": "参照素材のファイルサイズ情報を利用できません。送信にはサーバーによる確認が必要です"
  },
  "connections.generation.issue.size": {
    "zh-Hans": "参考素材的文件大小元数据无效，请重新读取或导入素材",
    "zh-Hant": "參考素材的檔案大小中繼資料無效，請重新讀取或匯入素材",
    "en": "Reference asset file-size metadata is invalid. Read or import the asset again",
    "ja": "参照素材のファイルサイズ情報が無効です。素材を再読み込みするか、再度取り込んでください"
  },
  "connections.generation.issue.hash": {
    "zh-Hans": "参考素材缺少有效的 SHA-256 校验值，请重新读取或导入素材",
    "zh-Hant": "參考素材缺少有效的 SHA-256 校驗值，請重新讀取或匯入素材",
    "en": "The reference asset has no valid SHA-256 checksum. Read or import the asset again",
    "ja": "参照素材に有効な SHA-256 チェックサムがありません。素材を再読み込みするか、再度取り込んでください"
  },
  "connections.generation.issue.tooLarge": {
    "zh-Hans": "参考图片超过当前 Mioon 适配器的文件大小限制",
    "zh-Hant": "參考圖片超過目前 Mioon 配接器的檔案大小限制",
    "en": "The reference image exceeds the current Mioon adapter’s file-size limit",
    "ja": "参照画像が現在の Mioon アダプターのファイルサイズ上限を超えています"
  },
  "connections.generation.issue.dataUri": {
    "zh-Hans": "参考图片编码后的完整 data URI 超过当前适配器的大小限制",
    "zh-Hant": "參考圖片編碼後的完整 data URI 超過目前配接器的大小限制",
    "en": "The reference image’s complete encoded data URI exceeds the current adapter’s size limit",
    "ja": "参照画像のエンコード済み data URI 全体が、現在のアダプターのサイズ上限を超えています"
  },
  "connections.generation.issue.dimensions": {
    "zh-Hans": "参考图片尺寸缺失或超出当前 Mioon 适配器的范围",
    "zh-Hant": "參考圖片尺寸缺失，或超出目前 Mioon 配接器的範圍",
    "en": "Reference image dimensions are missing or outside the current Mioon adapter’s range",
    "ja": "参照画像の寸法が欠けているか、現在の Mioon アダプターの対応範囲外です"
  },
  "connections.generation.issue.aspect": {
    "zh-Hans": "参考图片必须与镜头画幅比例一致，不会自动裁剪",
    "zh-Hant": "參考圖片必須與鏡頭畫幅比例一致，不會自動裁切",
    "en": "The reference image must match the shot’s aspect ratio. It will not be cropped automatically",
    "ja": "参照画像はショットのアスペクト比と一致する必要があります。自動でトリミングすることはありません"
  },
  "connections.generation.issue.roleUnsupported": {
    "zh-Hans": "Mioon 当前适配器未接入此参考角色，请查看输入限制",
    "zh-Hant": "Mioon 目前的配接器尚未接入此參考角色，請查看輸入限制",
    "en": "The current Mioon adapter does not support this reference role. See the input limits",
    "ja": "現在の Mioon アダプターはこの参照の役割に対応していません。入力制限を確認してください"
  },
  "connections.generation.issue.roleUnknown": {
    "zh-Hans": "未识别此参考角色，不能自动推断用途",
    "zh-Hant": "無法識別此參考角色，不能自動推斷用途",
    "en": "This reference role is unrecognized. Its purpose cannot be inferred automatically",
    "ja": "この参照の役割を認識できません。用途を自動で推測することはできません"
  },
  "connections.generation.issue.combination": {
    "zh-Hans": "当前 Mioon 适配器未接入此参考组合，不会自动丢弃素材",
    "zh-Hant": "目前 Mioon 配接器尚未接入此參考組合，不會自動捨棄素材",
    "en": "The current Mioon adapter does not support this reference combination. Assets will not be discarded automatically",
    "ja": "現在の Mioon アダプターはこの参照の組み合わせに対応していません。素材を自動で除外することはありません"
  },
  "connections.generation.issue.roleCount": {
    "zh-Hans": "所选参考角色的数量超过当前 Mioon 适配器限制",
    "zh-Hant": "所選參考角色的數量超過目前 Mioon 配接器限制",
    "en": "The selected reference-role count exceeds the current Mioon adapter’s limit",
    "ja": "選択した参照の役割の数が、現在の Mioon アダプターの上限を超えています"
  },
  "connections.generation.issue.count": {
    "zh-Hans": "参考图数量不符合当前模型限制；首尾帧组合仅接入 Ark 与 Mock",
    "zh-Hant": "參考圖數量不符合目前模型限制；首尾影格組合僅接入 Ark 與 Mock",
    "en": "The reference image count does not meet this model’s limits. First-and-last-frame combinations are supported only by Ark and Mock",
    "ja": "参照画像の数が現在のモデルの制限を満たしていません。最初と最後のフレームの組み合わせは Ark と Mock のみ対応しています"
  },
  "connections.generation.issue.mime": {
    "zh-Hans": "当前 Mioon 适配器未接入此参考图片格式",
    "zh-Hant": "目前 Mioon 配接器尚未接入此參考圖片格式",
    "en": "The current Mioon adapter does not support this reference image format",
    "ja": "現在の Mioon アダプターはこの参照画像形式に対応していません"
  },
  "connections.generation.issue.duplicate": {
    "zh-Hans": "同一参考素材不能重复提交",
    "zh-Hant": "同一參考素材不能重複提交",
    "en": "The same reference asset cannot be submitted twice",
    "ja": "同じ参照素材を重複して送信することはできません"
  },
  "connections.generation.issue.lifecycle": {
    "zh-Hans": "此模型已到生命周期复核日期，服务器已阻止新提交。请重新核验该精确模型；不会自动替换模型",
    "zh-Hant": "此模型已到生命週期複核日期，伺服器已阻止新的提交。請重新核驗此確切模型；不會自動更換模型",
    "en": "This model has reached its lifecycle review date, and the server has blocked new submissions. Reverify this exact model. It will not be replaced automatically",
    "ja": "このモデルはライフサイクルの再確認日を迎えたため、サーバーは新規送信をブロックしています。この正確なモデルを再検証してください。自動で置き換えることはありません"
  },
  "connections.generation.issue.frozenInvalid": {
    "zh-Hans": "冻结参考素材清单无效，不能自动修复或缩短",
    "zh-Hant": "固定參考素材清單無效，不能自動修復或縮短",
    "en": "The frozen reference manifest is invalid. It cannot be repaired or shortened automatically",
    "ja": "固定された参照素材一覧が無効です。自動で修復したり短縮したりすることはできません"
  },
  "connections.generation.issue.referencesMissing": {
    "zh-Hans": "参考素材已不存在或冻结清单不完整，请重新核对原始素材",
    "zh-Hant": "參考素材已不存在或固定清單不完整，請重新核對原始素材",
    "en": "Reference assets no longer exist or the frozen manifest is incomplete. Review the original assets again",
    "ja": "参照素材が存在しないか、固定された一覧が不完全です。元の素材を再確認してください"
  },
  "connections.generation.issue.referencesChanged": {
    "zh-Hans": "参考素材与原任务的冻结内容不一致，不能替换后重试",
    "zh-Hant": "參考素材與原工作的固定內容不一致，不能更換後重試",
    "en": "Reference assets do not match the original task’s frozen content. They cannot be replaced for a retry",
    "ja": "参照素材が元のタスクの固定内容と一致しません。置き換えて再試行することはできません"
  },
  "connections.generation.issue.firstFrame": {
    "zh-Hans": "图生视频需要选择一张首帧参考图",
    "zh-Hant": "圖片生成影片須選擇一張首影格參考圖",
    "en": "Image-to-video requires one first-frame reference image",
    "ja": "画像から動画を生成するには、最初のフレーム用の参照画像を 1 枚選択する必要があります"
  },
  "connections.generation.issue.clearFrames": {
    "zh-Hans": "切换文生视频前须明确清除首帧与尾帧选择，不会自动丢弃参考图",
    "zh-Hant": "切換為文字生成影片前，須明確清除首尾影格選擇，不會自動捨棄參考圖",
    "en": "Explicitly clear first- and last-frame selections before switching to text-to-video. Reference images will not be discarded automatically",
    "ja": "テキストから動画に切り替える前に、最初と最後のフレームの選択を明示的に解除してください。参照画像を自動で除外することはありません"
  },
  "connections.generation.issue.unknown": {
    "zh-Hans": "输入未通过核验。请核对输入限制与原始诊断代码：{code}",
    "zh-Hant": "輸入未通過核驗。請核對輸入限制與原始診斷代碼：{code}",
    "en": "Input verification did not pass. Review the input limits and original diagnostic code: {code}",
    "ja": "入力の検証に合格しませんでした。入力制限と元の診断コードを確認してください：{code}"
  },
  "connections.generation.issue.subjectBound": {
    "zh-Hans": "主体图片不能与首帧连线一起提交。请先明确断开首帧连线，再选择本次主体输入",
    "zh-Hant": "主體圖片不能與首影格連線一同提交。請先明確中斷首影格連線，再選擇本次主體輸入",
    "en": "A subject image cannot be submitted with a first-frame connection. Explicitly disconnect the first-frame connection before selecting the subject input",
    "ja": "被写体画像と最初のフレームの接続を同時に送信することはできません。最初のフレームの接続を明示的に解除してから、今回の被写体入力を選択してください"
  },
  "connections.generation.issue.subjectFrames": {
    "zh-Hans": "主体图片不能与首帧或尾帧组合。请手动清除首帧与尾帧选择，并保存镜头后再启用；不会自动清除素材",
    "zh-Hant": "主體圖片不能與首影格或尾影格組合。請手動清除首尾影格選擇，並儲存鏡頭後再啟用；不會自動清除素材",
    "en": "A subject image cannot be combined with first or last frames. Manually clear those selections and save the shot before enabling it. Assets will not be cleared automatically",
    "ja": "被写体画像と最初または最後のフレームは組み合わせられません。フレームの選択を手動で解除し、ショットを保存してから有効にしてください。素材を自動で消去することはありません"
  },
  "connections.generation.issue.subjectMissing": {
    "zh-Hans": "请明确选择一个主体及其固定图片版本，不会自动选用当前版本或策划关联",
    "zh-Hant": "請明確選擇一個主體及其固定圖片版本，不會自動選用目前版本或策劃關聯",
    "en": "Explicitly select a subject and its fixed image version. The current version or planning links will not be selected automatically",
    "ja": "被写体と固定する画像バージョンを明示的に選択してください。現在のバージョンや企画上の関連付けを自動で選択することはありません"
  },
  "connections.generation.issue.subjectInvalid": {
    "zh-Hans": "主体固定版本记录不完整，请重新明确选择版本",
    "zh-Hant": "主體固定版本記錄不完整，請重新明確選擇版本",
    "en": "The fixed subject-version record is incomplete. Explicitly select a version again",
    "ja": "被写体の固定バージョン記録が不完全です。バージョンを再度明示的に選択してください"
  },
  "connections.generation.issue.subjectProject": {
    "zh-Hans": "主体固定版本不属于当前项目，请重新选择",
    "zh-Hant": "主體固定版本不屬於目前專案，請重新選擇",
    "en": "The fixed subject version does not belong to the current project. Select it again",
    "ja": "被写体の固定バージョンは現在のプロジェクトに属していません。選び直してください"
  },
  "connections.generation.issue.subjectAssetMissing": {
    "zh-Hans": "主体固定版本的原图未加载或已缺失，不能提交",
    "zh-Hant": "主體固定版本的原圖尚未載入或已遺失，無法提交",
    "en": "The fixed subject version’s original image is unloaded or missing and cannot be submitted",
    "ja": "被写体の固定バージョンの元画像が未読み込みか見つからないため、送信できません"
  },
  "connections.generation.issue.subjectAssetChanged": {
    "zh-Hans": "主体固定版本的原图内容或元数据已变化，不能替换后提交。请核对原图",
    "zh-Hant": "主體固定版本的原圖內容或中繼資料已變更，不能更換後提交。請核對原圖",
    "en": "The fixed subject version’s original image content or metadata changed. It cannot be replaced for submission. Review the original image",
    "ja": "被写体の固定バージョンの元画像の内容またはメタデータが変更されています。置き換えて送信することはできません。元画像を確認してください"
  },
  "connections.generation.issue.inputRecord": {
    "zh-Hans": "生成输入格式无效，请核对原始请求",
    "zh-Hant": "生成輸入格式無效，請核對原始請求",
    "en": "The generation input format is invalid. Review the original request",
    "ja": "生成入力の形式が無効です。元のリクエストを確認してください"
  },
  "connections.generation.issue.modelUnsupported": {
    "zh-Hans": "此服务商不支持所选精确模型，不会自动更换模型",
    "zh-Hant": "此服務商不支援所選的確切模型，不會自動更換模型",
    "en": "This provider does not support the exact selected model. It will not be changed automatically",
    "ja": "このプロバイダーは選択した正確なモデルに対応していません。モデルを自動で変更することはありません"
  },
  "connections.generation.issue.parametersUnsupported": {
    "zh-Hans": "此模型不接受所选画幅或时长，请核对当前输入限制",
    "zh-Hant": "此模型不接受所選畫幅或時長，請核對目前的輸入限制",
    "en": "This model does not accept the selected aspect ratio or duration. Review the current input limits",
    "ja": "このモデルは選択したアスペクト比または長さに対応していません。現在の入力制限を確認してください"
  },
  "connections.generation.issue.inputUnsupported": {
    "zh-Hans": "此模型不接受当前参考输入。请核对输入模式、素材数量、格式、尺寸和画幅比例；不会自动丢弃或裁剪素材",
    "zh-Hant": "此模型不接受目前的參考輸入。請核對輸入模式、素材數量、格式、尺寸與畫幅比例；不會自動捨棄或裁切素材",
    "en": "This model does not accept the current reference input. Review the input mode, asset count, format, dimensions, and aspect ratio. Assets will not be discarded or cropped automatically",
    "ja": "このモデルは現在の参照入力を受け付けません。入力モード、素材の数、形式、寸法、アスペクト比を確認してください。素材を自動で除外したりトリミングしたりすることはありません"
  },
  "connections.generation.issue.promptInvalid": {
    "zh-Hans": "画面描述无效，请按所选模型的长度限制填写描述",
    "zh-Hant": "畫面描述無效，請依所選模型的長度限制填寫描述",
    "en": "The visual prompt is invalid. Enter a prompt within the selected model’s length limits",
    "ja": "画面説明が無効です。選択したモデルの文字数制限に従って入力してください"
  },
  "connections.generation.issue.parameterInvalid": {
    "zh-Hans": "高级参数或随机种子不符合当前模型限制，请核对参数名称、类型与范围",
    "zh-Hant": "進階參數或隨機種子不符合目前模型限制，請核對參數名稱、類型與範圍",
    "en": "Advanced parameters or the seed do not meet the model’s limits. Check parameter names, types, and ranges",
    "ja": "詳細パラメーターまたはシードが現在のモデルの制限を満たしていません。パラメーターの名前、型、範囲を確認してください"
  },
  "connections.generation.issue.regionChanged": {
    "zh-Hans": "当前服务商区域与原请求不一致，不能改用其他区域重试",
    "zh-Hant": "目前服務商區域與原請求不一致，不能改用其他區域重試",
    "en": "The current provider region differs from the original request. A different region cannot be used for a retry",
    "ja": "現在のプロバイダーのリージョンが元のリクエストと異なります。別のリージョンに変えて再試行することはできません"
  },
  "connections.generation.issue.regionUnsupported": {
    "zh-Hans": "当前精确模型的 API 区域不受支持或尚未明确选择，不会自动回退",
    "zh-Hant": "目前確切模型的 API 區域不受支援或尚未明確選擇，不會自動回退",
    "en": "The API region for this exact model is unsupported or not explicitly selected. There is no automatic fallback",
    "ja": "この正確なモデルの API リージョンは未対応か、明示的に選択されていません。自動フォールバックは行いません"
  },
  "connections.generation.issue.profileUnknown": {
    "zh-Hans": "原请求的完整输入配置标识或版本无法核验，不能回退到当前配置",
    "zh-Hant": "無法核驗原請求的完整輸入設定識別碼或版本，不能回退至目前設定",
    "en": "The original request’s complete input profile identity or version cannot be verified. It cannot fall back to the current profile",
    "ja": "元のリクエストの完全な入力プロファイル識別情報またはバージョンを検証できません。現在のプロファイルにフォールバックすることはできません"
  },
  "connections.generation.issue.referenceInvalid": {
    "zh-Hans": "参考素材记录或清单无效，请核对完整原始素材；不会自动修复或缩短",
    "zh-Hant": "參考素材記錄或清單無效，請核對完整原始素材；不會自動修復或縮短",
    "en": "A reference asset record or manifest is invalid. Review the complete original assets. Records will not be repaired or shortened automatically",
    "ja": "参照素材の記録または一覧が無効です。完全な元の素材を確認してください。記録を自動で修復したり短縮したりすることはありません"
  },
  "connections.generation.issue.bindingMismatch": {
    "zh-Hans": "参考素材与固定角色绑定不一致，请核对原始素材身份与顺序",
    "zh-Hant": "參考素材與固定角色綁定不一致，請核對原始素材身分與順序",
    "en": "Reference assets do not match the fixed role bindings. Review the original asset identities and order",
    "ja": "参照素材が固定した役割の割り当てと一致しません。元の素材の識別情報と順序を確認してください"
  },
  "connections.generation.issue.metadataIncomplete": {
    "zh-Hans": "参考素材元数据缺失或与完整选择不一致，服务器核对后才能提交",
    "zh-Hant": "參考素材中繼資料缺失或與完整選擇不一致，須經伺服器核對後才能提交",
    "en": "Reference metadata is missing or does not match the complete selection. The server must verify it before submission",
    "ja": "参照素材のメタデータが欠けているか、選択全体と一致しません。送信にはサーバーによる確認が必要です"
  },
  "connections.generation.issue.evaluationDate": {
    "zh-Hans": "缺少有效的服务器评估日期，不能确认输入配置仍可使用。请刷新后核对",
    "zh-Hant": "缺少有效的伺服器評估日期，無法確認輸入設定仍可使用。請重新整理後核對",
    "en": "A valid server evaluation date is missing. Continued input-profile availability cannot be confirmed. Refresh and review",
    "ja": "有効なサーバー評価日がないため、入力プロファイルを引き続き利用できるか確認できません。更新して確認してください"
  },
  "connections.generation.issue.schemaUnsupported": {
    "zh-Hans": "输入包含不受支持的结构版本或字段，不会自动忽略。请核对原始请求",
    "zh-Hant": "輸入包含不受支援的結構版本或欄位，不會自動忽略。請核對原始請求",
    "en": "The input contains an unsupported schema version or field. It will not be silently ignored. Review the original request",
    "ja": "入力に未対応のスキーマバージョンまたはフィールドが含まれています。自動で無視することはありません。元のリクエストを確認してください"
  }
} as const satisfies MessageCatalog;
