import type { MessageCatalog } from '../types.ts';
export const clipLoudnessMessages = {
  "audio.loudness.clip.unauthorized": {
    "zh-Hans": "会话已过期，请重新登录后明确重新准备",
    "zh-Hant": "工作階段已過期，請重新登入後明確重新準備",
    "en": "Your session expired. Sign in again and explicitly prepare again",
    "ja": "セッションの有効期限が切れました。再ログインしてから明示的に再準備してください"
  },
  "audio.loudness.clip.changed": {
    "zh-Hans": "已保存时间线或来源已变化，结果已丢弃，请重新准备",
    "zh-Hant": "已儲存時間軸或來源已變更，結果已捨棄，請重新準備",
    "en": "The saved timeline or source changed; results were discarded. Prepare again",
    "ja": "保存済みタイムラインまたはソースが変わったため、結果を破棄しました。再準備してください"
  },
  "audio.loudness.clip.busy": {
    "zh-Hans": "另一个音频检查仍在运行或清理，本次未排队，请稍后明确重试",
    "zh-Hant": "另一個音訊檢查仍在執行或清理，本次未加入佇列，請稍後明確重試",
    "en": "Another audio check is still running or cleaning up. This request was not queued; explicitly retry later",
    "ja": "別の音声検査が実行中または後処理中です。今回のリクエストはキューに入れていません。後で明示的に再試行してください"
  },
  "audio.loudness.clip.format": {
    "zh-Hans": "所选片段的音频格式或声道布局暂不支持，未生成报告",
    "zh-Hant": "所選片段的音訊格式或聲道配置暫不支援，未產生報告",
    "en": "The selected clip’s audio format or channel layout is unsupported. No report was produced",
    "ja": "選択したクリップの音声形式またはチャンネル構成は未対応です。結果はありません"
  },
  "audio.loudness.clip.bounds": {
    "zh-Hans": "所选已保存片段超出源音频范围，请核对来源后重新分析",
    "zh-Hant": "所選已儲存片段超出來源音訊範圍，請核對來源後重新分析",
    "en": "The selected saved clip exceeds the source audio bounds. Check its source and analyze again",
    "ja": "選択した保存済みクリップがソース音声の範囲を超えています。ソースを確認して再分析してください"
  },
  "audio.loudness.clip.cleanup": {
    "zh-Hans": "上一音频检查尚未确认结束，请等待资源释放后明确重试",
    "zh-Hant": "上一個音訊檢查尚未確認結束，請等待資源釋放後明確重試",
    "en": "The previous audio check has not been confirmed ended. Wait for resources to be released, then explicitly retry",
    "ja": "前の音声検査が終了したことはまだ確認できていません。リソース解放を待ってから明示的に再試行してください"
  },
  "audio.loudness.clip.cancelled": {
    "zh-Hans": "本次只读观察已取消，未修改时间线；需要时请明确重新准备",
    "zh-Hant": "本次唯讀觀察已取消，未修改時間軸；需要時請明確重新準備",
    "en": "This read-only observation was cancelled without changing the timeline. Explicitly prepare again if needed",
    "ja": "今回の読み取り専用の観測をキャンセルしました。タイムラインは変更していません。必要に応じて明示的に再準備してください"
  },
  "audio.loudness.clip.stale": {
    "zh-Hans": "当前身份或显示范围已变化，原结果已清除，请重新准备",
    "zh-Hant": "目前身分或顯示範圍已變更，原結果已清除，請重新準備",
    "en": "The current identity or displayed scope changed. The original result was cleared; prepare again",
    "ja": "現在の識別情報または表示範囲が変わったため、元の結果を消去しました。再準備してください"
  },
  "audio.loudness.clip.title": {
    "zh-Hans": "单个已保存片段响度",
    "zh-Hant": "單個已儲存片段響度",
    "en": "Selected saved-clip loudness",
    "ja": "選択した保存済みクリップのラウドネス"
  },
  "audio.loudness.clip.analyze": {
    "zh-Hans": "分析此已保存片段",
    "zh-Hant": "分析此已儲存片段",
    "en": "Analyze saved clip",
    "ja": "保存済みクリップを分析"
  },
  "audio.loudness.clip.limitation": {
    "zh-Hans": "独立测量已保存的裁剪、增益与淡入淡出，不包含其他片段或时间线前置空白。不是整片混音或已导出文件；不修改音量、不提供增益候选，也未实现逐段响度统一。估算真峰值不保证混音或 AAC 编码后的峰值；报告仅临时显示",
    "zh-Hant": "獨立測量已儲存的裁剪、增益與淡入淡出，不包含其他片段或時間軸前置空白。不是整片混音或已導出檔案；不修改音量、不提供增益候選，也未實現逐段響度統一。估算真峰值不保證混音或 AAC 編碼後的峰值；報告僅暫時顯示",
    "en": "Measures only the saved trim, gain and fades, without other clips or leading timeline silence. Not a full mix or exported file. Does not change volume, suggest gain or match loudness across clips. Estimated true peak does not guarantee mix or AAC-encoded peaks. This report is temporary",
    "ja": "保存済みのトリム、ゲイン、フェードだけを独立して測定します。他のクリップやタイムライン先頭の無音は含みません。全体ミックスや書き出しファイルではありません。音量変更、ゲイン候補、クリップ間のラウドネス統一は行いません。推定トゥルーピークはミックスや AAC 符号化後のピークを保証しません。結果は一時表示のみです"
  },
  "audio.loudness.clip.blocked": {
    "zh-Hans": "请先保存或解决草稿与冲突，并等待时间线操作结束、连接恢复后分析",
    "zh-Hant": "請先儲存或解決草稿與衝突，並等待時間軸操作結束、連線恢復後分析",
    "en": "Save or resolve drafts and conflicts, wait for timeline operations to finish, and reconnect before analyzing",
    "ja": "下書きや競合を保存・解決し、タイムライン操作の完了と接続の復旧を待ってから分析してください"
  },
  "audio.loudness.clip.inaudible": {
    "zh-Hans": "仅支持轨道未静音、已保存增益大于零的音频或视频片段。音轨由后端核验；不会解除静音或改测原始源",
    "zh-Hant": "僅支援軌道未靜音、已儲存增益大於零的音訊或影片片段。音軌由後端核驗；不會解除靜音或改測原始來源",
    "en": "Requires an audio/video clip, an unmuted track and positive saved gain. The backend verifies the audio stream; it will not unmute or measure the raw source instead",
    "ja": "音声・動画クリップ、ミュートされていないトラック、正の保存済みゲインが必要です。音声ストリームはバックエンドで確認します。ミュート解除や元ソースへの測定変更は行いません"
  },
  "audio.loudness.clip.restored": {
    "zh-Hans": "恢复分支不支持此片段测量",
    "zh-Hant": "還原分支不支援此片段測量",
    "en": "Clip measurement is unavailable in restored branches",
    "ja": "復元ブランチではクリップ測定を利用できません"
  },
  "audio.loudness.clip.timeout": {
    "zh-Hans": "片段分析或响应等待已超时（处理预算 120 秒），未保留部分结果",
    "zh-Hant": "片段分析或回應等待已逾時（處理預算 120 秒），未保留部分結果",
    "en": "Clip analysis or response waiting timed out (120-second processing budget). No partial result was retained",
    "ja": "クリップ分析または応答待ちがタイムアウトしました（処理上限 120 秒）。部分的な結果は保持していません"
  },
  "audio.loudness.clip.resource": {
    "zh-Hans": "片段测量达到来源或解码资源上限，未缩短范围",
    "zh-Hant": "片段測量達到來源或解碼資源上限，未縮短範圍",
    "en": "Clip measurement reached a source or decode limit; the range was not shortened",
    "ja": "クリップ測定がソースまたはデコードの上限に達しました。範囲は短縮していません"
  },
  "audio.loudness.clip.decode": {
    "zh-Hans": "片段音频未完整解码或样本数量不符，未生成报告",
    "zh-Hant": "片段音訊未完整解碼或樣本數量不符，未產生報告",
    "en": "Clip audio was not fully decoded or sample counts did not match. No report was produced",
    "ja": "クリップ音声を完全にデコードできないかサンプル数が一致しないため、結果はありません"
  },
  "audio.loudness.clip.owner": {
    "zh-Hans": "当前连接不拥有工作区，无法分析片段",
    "zh-Hant": "目前連線不擁有工作區，無法分析片段",
    "en": "This connection does not own the workspace and cannot analyze the clip",
    "ja": "現在の接続はワークスペースの所有者ではないため、クリップを分析できません"
  },
  "audio.loudness.clip.failed": {
    "zh-Hans": "此已保存片段暂时无法测量，请检查时间线和来源",
    "zh-Hant": "此已儲存片段暫時無法測量，請檢查時間軸與來源",
    "en": "This saved clip cannot be measured now. Check the timeline and source",
    "ja": "この保存済みクリップを測定できません。タイムラインとソースを確認してください"
  },
  "audio.loudness.clip.protocol": {
    "zh-Hans": "测量响应不完整或与所选已保存片段不匹配，结果已丢弃",
    "zh-Hant": "測量回應不完整或與所選已儲存片段不符，結果已捨棄",
    "en": "The response was incomplete or did not match the selected saved clip; the result was discarded",
    "ja": "測定応答が不完全、または選択した保存済みクリップと一致しないため、結果を破棄しました"
  },
  "audio.loudness.clip.stopped": {
    "zh-Hans": "本次片段测量已停止；需要时请重新分析",
    "zh-Hant": "本次片段測量已停止；需要時請重新分析",
    "en": "Clip measurement stopped. Analyze again if needed",
    "ja": "クリップ測定を停止しました。必要に応じて再分析してください"
  },
  "audio.loudness.clip.incomplete": {
    "zh-Hans": "片段测量未完成，请检查连接后重新分析",
    "zh-Hant": "片段測量未完成，請檢查連線後重新分析",
    "en": "Clip measurement did not complete. Check the connection and analyze again",
    "ja": "クリップ測定が完了しませんでした。接続を確認して再分析してください"
  },
  "audio.loudness.clip.preparing": {
    "zh-Hans": "正在独立测量此完整已保存片段。完整解码可能需要一段时间，可取消本次观察…",
    "zh-Hant": "正在獨立測量此完整已儲存片段。完整解碼可能需要一些時間，可取消本次觀察…",
    "en": "Measuring the entire saved clip independently. Full decoding can take time; you can cancel this observation…",
    "ja": "保存済みクリップ全体を独立して測定中です。完全なデコードには時間がかかる場合があります。この観測はキャンセルできます…"
  },
  "audio.loudness.clip.integrated": {
    "zh-Hans": "综合响度：",
    "zh-Hant": "綜合響度：",
    "en": "Integrated loudness:",
    "ja": "統合ラウドネス："
  },
  "audio.loudness.clip.peaks": {
    "zh-Hans": "估算真峰值：{truePeak} · 样本峰值：{sample}",
    "zh-Hant": "估算真峰值：{truePeak} · 樣本峰值：{sample}",
    "en": "Estimated true peak: {truePeak} · Sample peak: {sample}",
    "ja": "推定トゥルーピーク：{truePeak} · サンプルピーク：{sample}"
  },
  "audio.loudness.clip.range": {
    "zh-Hans": "已保存时间线位置 [{start}, {end}) 帧；源范围 [{source}, {sourceEnd}) 帧，共 {duration} 帧（30 fps）",
    "zh-Hant": "已儲存時間軸位置 [{start}, {end}) 幀；來源範圍 [{source}, {sourceEnd}) 幀，共 {duration} 幀（30 fps）",
    "en": "Saved timeline position [{start}, {end}) frames; source range [{source}, {sourceEnd}) frames; {duration} frames at 30 fps",
    "ja": "保存済みタイムライン位置 [{start}, {end}) フレーム、ソース範囲 [{source}, {sourceEnd}) フレーム、計 {duration} フレーム（30 fps）"
  },
  "audio.loudness.clip.stage": {
    "zh-Hans": "测量阶段：单片段增益与淡入淡出后、混音前。已保存增益 ×{gain}；淡入 {fadeIn} 帧，淡出 {fadeOut} 帧",
    "zh-Hant": "測量階段：單片段增益與淡入淡出後、混音前。已儲存增益 ×{gain}；淡入 {fadeIn} 幀，淡出 {fadeOut} 幀",
    "en": "Stage: isolated clip after gain/fades, before mixing. Saved gain ×{gain}; fade in {fadeIn} frames, fade out {fadeOut} frames",
    "ja": "測定段階：単一クリップのゲイン・フェード適用後、ミックス前。保存済みゲイン ×{gain}、フェードイン {fadeIn} フレーム、フェードアウト {fadeOut} フレーム"
  },
  "audio.loudness.clip.details": {
    "zh-Hans": "本次保存身份与测量配置",
    "zh-Hant": "本次儲存身分與測量設定",
    "en": "Saved identity and measurement profile",
    "ja": "保存済み識別情報と測定プロファイル"
  },
  "audio.loudness.clip.identity": {
    "zh-Hans": "项目 {project} · 时间线 {timeline} · 修订 {revision} · 片段 {clip} · 轨道 {track} · 资产 {asset}",
    "zh-Hant": "專案 {project} · 時間軸 {timeline} · 修訂 {revision} · 片段 {clip} · 軌道 {track} · 素材 {asset}",
    "en": "Project {project} · Timeline {timeline} · Revision {revision} · Clip {clip} · Track {track} · Asset {asset}",
    "ja": "プロジェクト {project} · タイムライン {timeline} · リビジョン {revision} · クリップ {clip} · トラック {track} · 素材 {asset}"
  },
  "audio.loudness.clip.samples": {
    "zh-Hans": "片段局部测量范围 [0, {end}) 帧；48 kHz 双声道，共 {frames} 个样本帧",
    "zh-Hant": "片段局部測量範圍 [0, {end}) 幀；48 kHz 雙聲道，共 {frames} 個樣本幀",
    "en": "Clip-local measurement range [0, {end}) frames; 48 kHz stereo, {frames} sample frames",
    "ja": "クリップ内測定範囲 [0, {end}) フレーム、48 kHz ステレオ、{frames} サンプルフレーム"
  },
  "audio.loudness.clip.durationLimit": {
    "zh-Hans": "仅分析完整已保存片段，最长 {seconds} 秒。超过时不可分析，不会自动裁短或替换范围",
    "zh-Hant": "僅分析完整已儲存片段，最長 {seconds} 秒。超過時無法分析，不會自動裁短或替換範圍",
    "en": "Only the entire saved clip is measured, up to {seconds} seconds. Longer clips are unavailable; no automatic trimming or range substitution",
    "ja": "保存済みクリップ全体のみを最大 {seconds} 秒まで測定します。長いクリップは分析できません。自動トリムや範囲の置き換えは行いません"
  },
  "audio.loudness.clip.sourceHash": {
    "zh-Hans": "来源 SHA-256：",
    "zh-Hant": "來源 SHA-256：",
    "en": "Source SHA-256:",
    "ja": "ソース SHA-256："
  },
  "audio.loudness.clip.integratedValue": {
    "zh-Hans": "{value} LUFS",
    "zh-Hant": "{value} LUFS",
    "en": "{value} LUFS",
    "ja": "{value} LUFS"
  },
  "audio.loudness.clip.tooLong": {
    "zh-Hans": "此已保存片段过长，当前不可分析",
    "zh-Hant": "此已儲存片段過長，目前無法分析",
    "en": "This saved clip is too long to analyze",
    "ja": "この保存済みクリップは長すぎるため分析できません"
  },
  "audio.loudness.clip.noAudio": {
    "zh-Hans": "后端确认所选片段没有可测音轨，不能将其报告为数字静音",
    "zh-Hant": "後端確認所選片段沒有可測音軌，不能將其報告為數位靜音",
    "en": "The backend found no measurable audio stream in the selected clip. This is not reported as digital silence",
    "ja": "バックエンドで選択したクリップに測定可能な音声ストリームがないことを確認しました。デジタル無音としては扱いません"
  },
  "audio.loudness.clip.metadataMismatch": {
    "zh-Hans": "实际音频与已保存的来源信息不符，未生成报告。请核对来源",
    "zh-Hant": "實際音訊與已儲存的來源資訊不符，未產生報告。請核對來源",
    "en": "Actual audio does not match the saved source metadata. No report was produced; check the source",
    "ja": "実際の音声が保存済みソース情報と一致しません。結果はありません。ソースを確認してください"
  },
  "audio.loudness.dialogue.label": {
    "zh-Hans": "对白响度匹配",
    "zh-Hant": "對白響度匹配",
    "en": "Match dialogue loudness",
    "ja": "台詞のラウドネスを揃える"
  },
  "audio.loudness.dialogue.help": {
    "zh-Hans": "逐段测量标为“人声”的片段，按目标响度给出各自的建议增益。只调整增益，不做限幅或压缩。",
    "zh-Hant": "逐段測量標為「人聲」的片段，按目標響度給出各自的建議增益。只調整增益，不做限幅或壓縮。",
    "en": "Measures each clip marked Human voice and suggests its own gain for the target loudness. Only gain changes; nothing is limited or compressed.",
    "ja": "「人の声」に分類したクリップを1件ずつ測定し、目標ラウドネスに合わせた個別のゲインを提案します。変わるのはゲインだけで、リミッターや圧縮はかけません。"
  },
  "audio.loudness.dialogue.none": {
    "zh-Hans": "时间线上没有标为“人声”的片段。可以在片段属性的“音频分类”里设置。",
    "zh-Hant": "時間軸上沒有標為「人聲」的片段。可以在片段屬性的「音訊分類」裡設定。",
    "en": "No clip on the timeline is marked Human voice. Set it under Audio role in the clip properties.",
    "ja": "タイムラインに「人の声」に分類したクリップがありません。クリップのプロパティの「音声の分類」で設定できます。"
  },
  "audio.loudness.dialogue.analyze": {
    "zh-Hans": "分析对白",
    "zh-Hant": "分析對白",
    "en": "Measure dialogue",
    "ja": "台詞を測定"
  },
  "audio.loudness.dialogue.analyzeAgain": {
    "zh-Hans": "重新分析",
    "zh-Hant": "重新分析",
    "en": "Measure again",
    "ja": "もう一度測定"
  },
  "audio.loudness.dialogue.stop": {
    "zh-Hans": "停止",
    "zh-Hant": "停止",
    "en": "Stop",
    "ja": "停止"
  },
  "audio.loudness.dialogue.progress": {
    "zh-Hans": "正在测量第 {done}/{total} 段…",
    "zh-Hant": "正在測量第 {done}/{total} 段…",
    "en": "Measuring clip {done} of {total}…",
    "ja": "{total} 件中 {done} 件目を測定中…"
  },
  "audio.loudness.dialogue.summary": {
    "zh-Hans": "已测量 {count} 段，建议调整 {selected} 段",
    "zh-Hant": "已測量 {count} 段，建議調整 {selected} 段",
    "en": "{count} measured, {selected} to change",
    "ja": "測定 {count} 件、変更の提案 {selected} 件"
  },
  "audio.loudness.dialogue.current": {
    "zh-Hans": "当前 {lufs} LUFS · 真峰值 {peak} dBTP",
    "zh-Hant": "目前 {lufs} LUFS · 真峰值 {peak} dBTP",
    "en": "Now {lufs} LUFS · true peak {peak} dBTP",
    "ja": "現在 {lufs} LUFS・トゥルーピーク {peak} dBTP"
  },
  "audio.loudness.dialogue.suggest": {
    "zh-Hans": "建议 {db} dB（增益 {before} → {after}）",
    "zh-Hant": "建議 {db} dB（增益 {before} → {after}）",
    "en": "Suggested {db} dB (gain {before} → {after})",
    "ja": "提案 {db} dB（ゲイン {before} → {after}）"
  },
  "audio.loudness.dialogue.peakRisk": {
    "zh-Hans": "调整后真峰值约 {peak} dBTP，超过上限，默认不勾选",
    "zh-Hant": "調整後真峰值約 {peak} dBTP，超過上限，預設不勾選",
    "en": "The true peak would be about {peak} dBTP, above the ceiling, so it is left unchecked",
    "ja": "変更後のトゥルーピークは約 {peak} dBTP で上限を超えるため、初期状態ではチェックしません"
  },
  "audio.loudness.dialogue.close": {
    "zh-Hans": "已接近目标，无需调整",
    "zh-Hant": "已接近目標，無需調整",
    "en": "Already within 0.1 LU of the target",
    "ja": "目標との差が 0.1 LU 以内のため、変更は不要です"
  },
  "audio.loudness.dialogue.noLoudness": {
    "zh-Hans": "静音、太短或低于门限，测不出综合响度",
    "zh-Hant": "靜音、太短或低於門限，測不出綜合響度",
    "en": "Silent, too short or below the gate: no integrated loudness",
    "ja": "無音、短すぎる、またはゲート未満のため、統合ラウドネスを測れません"
  },
  "audio.loudness.dialogue.gainRange": {
    "zh-Hans": "需要的增益超出 0–2 范围，只调增益达不到目标",
    "zh-Hant": "需要的增益超出 0–2 範圍，只調增益達不到目標",
    "en": "The needed gain is outside 0–2, so gain alone cannot reach the target",
    "ja": "必要なゲインが 0〜2 の範囲を超えるため、ゲインだけでは目標に届きません"
  },
  "audio.loudness.dialogue.muted": {
    "zh-Hans": "所在轨道已静音，跳过",
    "zh-Hant": "所在軌道已靜音，略過",
    "en": "Its track is muted; skipped",
    "ja": "トラックがミュートのためスキップします"
  },
  "audio.loudness.dialogue.zeroGain": {
    "zh-Hans": "增益为 0，跳过",
    "zh-Hant": "增益為 0，略過",
    "en": "Its gain is 0; skipped",
    "ja": "ゲインが 0 のためスキップします"
  },
  "audio.loudness.dialogue.tooLong": {
    "zh-Hans": "超过 {seconds} 秒，无法测量",
    "zh-Hant": "超過 {seconds} 秒，無法測量",
    "en": "Longer than {seconds} s; cannot be measured",
    "ja": "{seconds} 秒を超えるため測定できません"
  },
  "audio.loudness.dialogue.noSource": {
    "zh-Hans": "找不到素材，跳过",
    "zh-Hant": "找不到素材，略過",
    "en": "Its source is missing; skipped",
    "ja": "素材が見つからないためスキップします"
  },
  "audio.loudness.dialogue.waiting": {
    "zh-Hans": "等待测量",
    "zh-Hant": "等待測量",
    "en": "Waiting",
    "ja": "測定待ち"
  },
  "audio.loudness.dialogue.measuring": {
    "zh-Hans": "正在测量…",
    "zh-Hant": "正在測量…",
    "en": "Measuring…",
    "ja": "測定中…"
  },
  "audio.loudness.dialogue.failed": {
    "zh-Hans": "测量失败：{reason}",
    "zh-Hant": "測量失敗：{reason}",
    "en": "Measurement failed: {reason}",
    "ja": "測定に失敗しました：{reason}"
  },
  "audio.loudness.dialogue.select": {
    "zh-Hans": "应用到“{name}”",
    "zh-Hant": "套用到「{name}」",
    "en": "Apply to “{name}”",
    "ja": "「{name}」に適用"
  },
  "audio.loudness.dialogue.apply": {
    "zh-Hans": "应用到 {count} 段",
    "zh-Hant": "套用到 {count} 段",
    "en": "Apply to checked ({count})",
    "ja": "{count} 件に適用"
  },
  "audio.loudness.dialogue.applyHint": {
    "zh-Hans": "勾选的增益一次保存为一条历史，撤销一次即可全部复原",
    "zh-Hant": "勾選的增益一次儲存為一筆歷史，復原一次即可全部還原",
    "en": "Checked gains are saved as one history entry; one undo restores them all",
    "ja": "チェックしたゲインは1件の履歴としてまとめて保存され、1回の取り消しですべて元に戻ります"
  },
  "audio.loudness.dialogue.applying": {
    "zh-Hans": "正在保存增益…",
    "zh-Hant": "正在儲存增益…",
    "en": "Saving gains…",
    "ja": "ゲインを保存中…"
  },
  "audio.loudness.dialogue.applied": {
    "zh-Hans": "已调整 {count} 段对白的增益",
    "zh-Hant": "已調整 {count} 段對白的增益",
    "en": "Dialogue gains changed: {count}",
    "ja": "{count} 件の台詞のゲインを変更しました"
  },
  "audio.loudness.dialogue.stale": {
    "zh-Hans": "时间线已变化，请重新分析",
    "zh-Hant": "時間軸已變更，請重新分析",
    "en": "The timeline changed. Measure again",
    "ja": "タイムラインが変わりました。もう一度測定してください"
  },
  "audio.loudness.dialogue.cancelled": {
    "zh-Hans": "已停止测量",
    "zh-Hant": "已停止測量",
    "en": "Measurement stopped",
    "ja": "測定を停止しました"
  },
  "audio.loudness.dialogue.limitation": {
    "zh-Hans": "只测量每段对白本身（含它的增益和淡入淡出），不含其他轨道，也不是导出后的结果；每段最长 {seconds} 秒。",
    "zh-Hant": "只測量每段對白本身（含它的增益和淡入淡出），不含其他軌道，也不是匯出後的結果；每段最長 {seconds} 秒。",
    "en": "Each dialogue clip is measured on its own, with its gain and fades but without other tracks, and not as exported. Each clip can be at most {seconds} s.",
    "ja": "台詞クリップは1件ずつ、そのゲインとフェードを含めて単体で測定します。ほかのトラックや書き出し後の結果は含みません。1件の長さは最大 {seconds} 秒です。"
  }
} as const satisfies MessageCatalog;
