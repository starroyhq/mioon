import type { MessageCatalog } from '../types.ts';
export const creationUiMessages = {
  "agent.authorization.confirmSend": {"zh-Hans": "确认并发送", "zh-Hant": "確認並傳送", "en": "Confirm and send", "ja": "確認して送信"},
  "agent.authorization.scopeLabel": {"zh-Hans": "发送范围", "zh-Hant": "傳送範圍", "en": "Sending scope", "ja": "送信範囲"},
  "agent.authorization.destinationLabel": {"zh-Hans": "目标与模型", "zh-Hant": "目標與模型", "en": "Destination and model", "ja": "送信先とモデル"},
  "agent.authorization.costLabel": {"zh-Hans": "可能计费", "zh-Hant": "可能計費", "en": "Possible charges", "ja": "料金について"},
  "agent.authorization.scopeDetails": {"zh-Hans": "查看发送详情", "zh-Hant": "查看傳送詳情", "en": "View sending details", "ja": "送信内容の詳細"},
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
  "generation.inputs.formats": {
    "zh-Hans": "格式：{value}",
    "zh-Hant": "格式：{value}",
    "en": "Formats: {value}",
    "ja": "形式：{value}"
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
  "generation.inputs.totalReferences": {
    "zh-Hans": "参考图总数：{minReferences}–{maxReferences} 张",
    "zh-Hant": "參考圖總數：{minReferences}–{maxReferences} 張",
    "en": "References: {minReferences}–{maxReferences} images",
    "ja": "参照画像：{minReferences}～{maxReferences}枚"
  },
  "generation.inputs.roleLimitsAria": {
    "zh-Hans": "各参考角色的数量与限制",
    "zh-Hant": "各參考角色的數量與限制",
    "en": "Counts and limits for each reference role",
    "ja": "参照用途ごとの数量と制限"
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
  "generation.inputs.serverEvaluation": {
    "zh-Hans": "服务端评估",
    "zh-Hant": "伺服器評估",
    "en": "Server evaluation",
    "ja": "サーバー側の評価"
  },
  "generation.inputs.apiRegion": {
    "zh-Hans": "API / 区域",
    "zh-Hant": "API / 區域",
    "en": "API / Region",
    "ja": "API / 地域"
  },
  "generation.inputs.lifecycleDates": {
    "zh-Hans": "核查日 {checkedOn} · 最早关闭日 {earliestShutdownDate}",
    "zh-Hant": "查核日 {checkedOn} · 最早關閉日 {earliestShutdownDate}",
    "en": "Reviewed {checkedOn} · Earliest shutdown {earliestShutdownDate}",
    "ja": "確認日 {checkedOn}・最も早い終了日 {earliestShutdownDate}"
  },
  "generation.inputs.providerLifecycleLink": {
    "zh-Hans": "查看服务商生命周期说明",
    "zh-Hant": "查看服務商的生命週期說明",
    "en": "View provider lifecycle information",
    "ja": "プロバイダーのライフサイクル情報を見る"
  },
  "generation.inputs.lifecycleBlocked": {
    "zh-Hans": "此模型已停止服务，请在生成服务中选择 Gemini Omni",
    "zh-Hant": "此模型已停止服務，請在生成服務中選擇 Gemini Omni",
    "en": "This model has been retired. Select Gemini Omni in Generation Services",
    "ja": "このモデルの提供は終了しました。生成サービスで Gemini Omni を選択してください"
  },
  "generation.inputs.lifecycleWarning": {
    "zh-Hans": "最早于 {earliestShutdownDate} 关闭 · 核查日 {checkedOn}",
    "zh-Hant": "最早於 {earliestShutdownDate} 關閉 · 查核日 {checkedOn}",
    "en": "Earliest shutdown {earliestShutdownDate} · Reviewed {checkedOn}",
    "ja": "最も早い終了日 {earliestShutdownDate}・確認日 {checkedOn}"
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
  "image.studio.sourceNotSent": {"zh-Hans": "尚未发送源图，等待批准", "zh-Hant": "尚未傳送來源圖片，等待批准", "en": "The source image has not been sent; awaiting approval", "ja": "ソース画像は未送信です。承認待ちです"},
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
    "zh-Hans": "本机已有同一请求的记录。",
    "zh-Hant": "本機已有同一請求的記錄。",
    "en": "A local record of this request already exists.",
    "ja": "同じリクエストの記録が本機にあります。"
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
    "zh-Hans": "已从旧会话转存",
    "zh-Hant": "已從舊會話轉存",
    "en": "Transferred from an earlier session",
    "ja": "以前のセッションから移行済み"
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
  "tasks.center.loadingRecoveryRecords": {
    "zh-Hans": "正在读取恢复记录",
    "zh-Hant": "正在讀取復原記錄",
    "en": "Loading recovery records",
    "ja": "復元記録を読み込み中"
  },
  "tasks.center.recoveryListUnavailable": {
    "zh-Hans": "无法读取恢复记录",
    "zh-Hant": "無法讀取復原記錄",
    "en": "Could not read recovery records",
    "ja": "復元記録を読み込めません"
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
    "zh-Hans": "服务商可能已接受任务并计费。",
    "zh-Hant": "服務商可能已接受任務並計費。",
    "en": "The provider may have accepted the task and charged you.",
    "ja": "プロバイダーがタスクを受け付け、課金した可能性があります。"
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
  "tasks.center.reconcileExistingTask": {
    "zh-Hans": "核对并恢复已有任务",
    "zh-Hant": "核對並還原既有工作",
    "en": "Check and recover existing task",
    "ja": "既存タスクを確認して復元"
  },
  "tasks.center.existingStatusChecked": {
    "zh-Hans": "已核对已有任务",
    "zh-Hant": "已核對既有任務",
    "en": "Existing task checked",
    "ja": "既存のタスクを確認済み"
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
    "zh-Hans": "仅停止本地等待",
    "zh-Hant": "僅停止本機等待",
    "en": "Local wait stopped",
    "ja": "ローカルの待機のみ停止"
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
    "zh-Hans": "停止本地等待后，服务商可能继续执行并计费。",
    "zh-Hant": "停止本機等待後，服務商可能繼續執行並計費。",
    "en": "The provider may keep running and charge you after you stop waiting locally.",
    "ja": "ローカルで待機を停止した後も、プロバイダーが処理を続けて課金する場合があります。"
  },
  "tasks.center.stopRequested": {
    "zh-Hans": "已请求停止",
    "zh-Hant": "已請求停止",
    "en": "Stop requested",
    "ja": "停止をリクエスト済み"
  },
  "tasks.center.noGenerationTasks": {
    "zh-Hans": "暂无任务",
    "zh-Hant": "暫無任務",
    "en": "No tasks yet",
    "ja": "タスクはまだありません"
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
  "tasks.workspace.recordsAria": {
    "zh-Hans": "任务记录",
    "zh-Hant": "工作記錄",
    "en": "Task records",
    "ja": "タスク記録"
  },
} as const satisfies MessageCatalog;
