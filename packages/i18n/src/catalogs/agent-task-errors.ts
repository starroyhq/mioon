import type { MessageCatalog } from '../types.ts';

export const agentTaskErrorMessages = {
  "agent.task.error.preflightStale": {"zh-Hans": "预检结果已过期，请重新检查时间线后再继续", "zh-Hant": "預檢結果已過期，請重新檢查時間軸後再繼續", "en": "The preflight result is out of date. Check the timeline again before continuing", "ja": "事前チェックの結果が古くなっています。タイムラインを再確認してから続行してください"},
  "agent.task.error.generation": {"zh-Hans": "生成服务未能完成这一步，请检查模型与服务设置及原生成记录", "zh-Hant": "生成服務未能完成這一步，請檢查模型與服務設定及原生成紀錄", "en": "The generation service could not complete this step. Check Models and services settings and the original generation record", "ja": "生成サービスがこのステップを完了できませんでした。モデルとサービスの設定および元の生成記録を確認してください"},
  "agent.task.error.skipRequired": {"zh-Hans": "请先选择跳过冲突的这一处，再继续执行", "zh-Hant": "請先選擇跳過衝突的這一處，再繼續執行", "en": "Choose to skip the conflicting content before continuing", "ja": "競合した箇所をスキップしてから続行してください"},
  "agent.task.error.noteLimit": {"zh-Hans": "待生效的补充说明已满 5 条，请等待下一步读取后再发送", "zh-Hant": "待生效的補充說明已滿 5 條，請等待下一步讀取後再傳送", "en": "Five instructions are waiting. Send another after the next step reads them", "ja": "未反映の補足指示が 5 件あります。次のステップで読み込まれてから追加してください"},
  "agent.task.error.noteCapacity": {"zh-Hans": "这条补充说明超出当前上下文容量，请缩短后重新发送", "zh-Hant": "這條補充說明超出目前上下文容量，請縮短後重新傳送", "en": "This note exceeds the remaining context space. Shorten it and send again", "ja": "この補足指示は現在のコンテキスト容量を超えています。短くして再送してください"},
  "agent.task.error.targetSkipped": {"zh-Hans": "这一处由用户保留，本轮不要再改", "zh-Hant": "這一處由使用者保留，本輪不要再修改", "en": "The user is keeping this content. Do not change it again in this run.", "ja": "この箇所はユーザーの変更を保持します。このラウンドでは再変更しないでください"},
  "agent.task.error.receipt": {
    "zh-Hans": "无法安全读取或保存本地操作记录，请先核对原执行，不要重复发送",
    "zh-Hant": "無法安全讀取或儲存本機操作紀錄，請先核對原執行，不要重複傳送",
    "en": "Local operation records could not be safely read or saved. Check the original run without resending it",
    "ja": "ローカルの操作記録を安全に読み取りまたは保存できません。再送せず、元の実行を確認してください"
  },
  "agent.task.error.localConnection": {
    "zh-Hans": "与本地工作区的连接暂时不可用，请恢复连接后重新读取原执行",
    "zh-Hant": "與本機工作區的連線暫時無法使用，請恢復連線後重新讀取原執行",
    "en": "The local workspace connection is unavailable. Restore it and reload the original run",
    "ja": "ローカルワークスペースに接続できません。接続を復旧して元の実行を再読み込みしてください"
  },
  "agent.task.error.localResponse": {
    "zh-Hans": "无法核实本地工作区返回的状态，请重新读取原执行",
    "zh-Hant": "無法核實本機工作區傳回的狀態，請重新讀取原執行",
    "en": "The local workspace response could not be verified. Reload the original run",
    "ja": "ローカルワークスペースの応答を確認できません。元の実行を再読み込みしてください"
  },
  "agent.task.error.generic": {
    "zh-Hans": "这一步未能完成，请核对已保存的记录",
    "zh-Hant": "這一步未能完成，請核對已儲存的紀錄",
    "en": "This step could not complete. Check the saved records",
    "ja": "このステップを完了できませんでした。保存済みの記録を確認してください"
  },
  "agent.task.error.notFound": {
    "zh-Hans": "找不到这次执行或项目，请重新读取",
    "zh-Hant": "找不到這次執行或專案，請重新讀取",
    "en": "This run or project could not be found. Reload its state",
    "ja": "この実行またはプロジェクトが見つかりません。状態を再読み込みしてください"
  },
  "agent.task.error.validation": {
    "zh-Hans": "请求内容无效，请检查输入与模型设置",
    "zh-Hant": "請求內容無效，請檢查輸入與模型設定",
    "en": "The request is invalid. Check your input and model settings",
    "ja": "リクエストが無効です。入力とモデル設定を確認してください"
  },
  "agent.task.error.busy": {
    "zh-Hans": "当前项目还有未结束的执行，请先继续或停止它",
    "zh-Hant": "目前專案還有未結束的執行，請先繼續或停止它",
    "en": "This project has an unfinished run. Continue or stop it first",
    "ja": "このプロジェクトに未完了の実行があります。先に続行または停止してください"
  },
  "agent.task.error.consent": {
    "zh-Hans": "此模型的发送授权尚未确认或已撤销，请在设置中核对",
    "zh-Hant": "此模型的傳送授權尚未確認或已撤銷，請在設定中核對",
    "en": "Sending to this model is not authorized or its authorization was revoked. Check Settings",
    "ja": "このモデルへの送信が未許可か、許可が取り消されています。設定を確認してください"
  },
  "agent.task.error.changed": {
    "zh-Hans": "内容、状态或模型连接已变化，请重新读取后核对",
    "zh-Hant": "內容、狀態或模型連線已變更，請重新讀取後核對",
    "en": "The content, state or model connection changed. Reload and check it",
    "ja": "内容、状態、またはモデル接続が変更されました。再読み込みして確認してください"
  },
  "agent.task.error.editing": {
    "zh-Hans": "这一处有未完成的手动编辑，请先保存或放弃草稿",
    "zh-Hant": "這一處有未完成的手動編輯，請先儲存或放棄草稿",
    "en": "This content has unfinished manual edits. Save or discard the draft first",
    "ja": "この内容には未完了の手動編集があります。先に下書きを保存または破棄してください"
  },
  "agent.task.error.unknown": {
    "zh-Hans": "上一步结果未知，请先核对原请求，不要重复发送",
    "zh-Hant": "上一步結果未知，請先核對原請求，不要重複傳送",
    "en": "The previous result is unknown. Check the original request without resending it",
    "ja": "前の結果が不明です。再送せず、先に元のリクエストを確認してください"
  },
  "agent.task.error.storageLimit": {
    "zh-Hans": "Mio 任务历史已达容量上限，已有记录保留，请先检查容量诊断",
    "zh-Hant": "Mio 工作歷史已達容量上限，既有紀錄保留，請先檢查容量診斷",
    "en": "Mio task history reached its storage limit. Existing records are retained; check storage diagnostics",
    "ja": "Mio のタスク履歴が保存上限に達しました。既存の記録は保持されています。容量診断を確認してください"
  },
  "agent.task.error.storage": {
    "zh-Hans": "无法安全读取或保存执行记录，已停止后续操作",
    "zh-Hant": "無法安全讀取或儲存執行紀錄，已停止後續操作",
    "en": "Run records could not be safely read or saved. Further operations have stopped",
    "ja": "実行記録を安全に読み取りまたは保存できないため、後続の操作を停止しました"
  },
  "agent.task.error.paused": {
    "zh-Hans": "本轮已暂停，已完成的变化仍保留",
    "zh-Hant": "本輪已暫停，已完成的變化仍保留",
    "en": "This round is paused. Completed changes are retained",
    "ja": "このラウンドは一時停止中です。完了した変更は保持されています"
  },
  "agent.task.error.approval": {
    "zh-Hans": "此操作需要你确认后才能执行",
    "zh-Hant": "此操作需要你確認後才能執行",
    "en": "This operation needs your confirmation before it can run",
    "ja": "この操作を実行するには確認が必要です"
  },
  "agent.task.error.connection": {
    "zh-Hans": "无法连接模型，请检查 Mio 的模型连接与网络",
    "zh-Hant": "無法連接模型，請檢查 Mio 的模型連線與網路",
    "en": "Could not connect to the model. Check the Mio connection and network",
    "ja": "モデルに接続できません。Mio のモデル接続とネットワークを確認してください"
  },
  "agent.task.error.networkDenied": {
    "zh-Hans": "模型地址不符合网络安全规则，请检查 Mio 的模型连接",
    "zh-Hant": "模型位址不符合網路安全規則，請檢查 Mio 的模型連線",
    "en": "The model address does not meet network security rules. Check the Mio connection",
    "ja": "モデルのアドレスがネットワークの安全規則を満たしていません。Mio の接続を確認してください"
  },
  "agent.task.error.timeout": {
    "zh-Hans": "模型请求超时，已保留收到的内容，请先核对本次结果",
    "zh-Hant": "模型請求逾時，已保留收到的內容，請先核對本次結果",
    "en": "The model request timed out. Received content is retained. Check this result first",
    "ja": "モデルへのリクエストがタイムアウトしました。受信内容は保持されています。先に今回の結果を確認してください"
  },
  "agent.task.error.modelRejected": {
    "zh-Hans": "模型服务拒绝了请求，请检查账户、模型和连接设置",
    "zh-Hant": "模型服務拒絕了請求，請檢查帳戶、模型與連線設定",
    "en": "The model service rejected the request. Check your account, model and connection settings",
    "ja": "モデルサービスがリクエストを拒否しました。アカウント、モデル、接続設定を確認してください"
  },
  "agent.task.error.protocol": {
    "zh-Hans": "模型返回的内容不完整或不受支持，请检查协议与模型设置",
    "zh-Hant": "模型傳回的內容不完整或不受支援，請檢查協定與模型設定",
    "en": "The model response is incomplete or unsupported. Check the protocol and model settings",
    "ja": "モデルの応答が不完全か未対応です。プロトコルとモデル設定を確認してください"
  },
  "agent.task.error.limit": {
    "zh-Hans": "已达到输入、输出或存储上限，请核对已保存的记录",
    "zh-Hant": "已達輸入、輸出或儲存上限，請核對已儲存的紀錄",
    "en": "An input, output or storage limit was reached. Check the saved records",
    "ja": "入力、出力、または保存容量の上限に達しました。保存済みの記録を確認してください"
  },
  "agent.task.error.key": {
    "zh-Hans": "请先在 Mio 设置中保存此模型的密钥",
    "zh-Hant": "請先在 Mio 設定中儲存此模型的金鑰",
    "en": "Save this model’s key in Mio settings first",
    "ja": "先に Mio の設定でこのモデルのキーを保存してください"
  },
  "agent.task.error.tools": {
    "zh-Hans": "本轮无法执行模型请求的操作，请核对已保存的记录",
    "zh-Hant": "本輪無法執行模型請求的操作，請核對已儲存的紀錄",
    "en": "The requested operation cannot run in this round. Check the saved records",
    "ja": "このラウンドでは要求された操作を実行できません。保存済みの記録を確認してください"
  },
  "agent.task.error.provider": {
    "zh-Hans": "模型服务在回复时报告错误，已保留收到的内容",
    "zh-Hant": "模型服務在回覆時回報錯誤，已保留收到的內容",
    "en": "The model service reported an error while replying. Received content is retained",
    "ja": "モデルサービスが応答中にエラーを報告しました。受信内容は保持されています"
  },
  "agent.task.error.stopped": {
    "zh-Hans": "本轮已停止，远端计算或计费仍可能继续",
    "zh-Hant": "本輪已停止，遠端運算或計費仍可能繼續",
    "en": "This round has stopped. Remote processing or billing may continue",
    "ja": "このラウンドは停止しました。送信先での処理や課金は続く場合があります"
  },
  "agent.task.error.media": {
    "zh-Hans": "本地媒体处理未完成，请检查视频工具设置与素材",
    "zh-Hant": "本機媒體處理未完成，請檢查影片工具設定與素材",
    "en": "Local media processing did not complete. Check video tool settings and media",
    "ja": "ローカルのメディア処理を完了できませんでした。動画ツールの設定と素材を確認してください"
  },
  "agent.task.error.readOnly": {
    "zh-Hans": "恢复副本中的执行记录仅供查看",
    "zh-Hant": "還原副本中的執行紀錄僅供檢視",
    "en": "Run records in a restored copy are read only",
    "ja": "復元コピーの実行記録は閲覧のみ可能です"
  },
  "agent.task.error.upload": {
    "zh-Hans": "文件未能加入本次对话，请检查文件类型、大小与数量",
    "zh-Hant": "檔案未能加入本次對話，請檢查檔案類型、大小與數量",
    "en": "The file could not be added. Check its type, size and the file count",
    "ja": "ファイルを追加できませんでした。種類、サイズ、ファイル数を確認してください"
  }
} as const satisfies MessageCatalog;
