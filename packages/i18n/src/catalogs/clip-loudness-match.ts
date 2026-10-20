import type { MessageCatalog } from '../types.ts';

export const clipLoudnessMatchMessages = {
  'audio.loudness.match.rangeValue': { 'zh-Hans': '{value} LU', 'zh-Hant': '{value} LU', en: '{value} LU', ja: '{value} LU' },
  'audio.loudness.match.gainValue': { 'zh-Hans': '{value} dB', 'zh-Hant': '{value} dB', en: '{value} dB', ja: '{value} dB' },
  'audio.loudness.match.range': { 'zh-Hans': '响度范围 LRA', 'zh-Hant': '響度範圍 LRA', en: 'Loudness range', ja: 'ラウドネスレンジ' },
  'audio.loudness.match.target': { 'zh-Hans': '目标响度', 'zh-Hant': '目標響度', en: 'Target loudness', ja: '目標ラウドネス' },
  'audio.loudness.match.ceiling': { 'zh-Hans': '真峰值上限', 'zh-Hant': '真峰值上限', en: 'True-peak ceiling', ja: 'トゥルーピーク上限' },
  'audio.loudness.match.targetInvalid': { 'zh-Hans': '目标须为 −60 至 −5 LUFS，峰值上限须为 −20 至 0 dBTP', 'zh-Hant': '目標須為 −60 至 −5 LUFS，峰值上限須為 −20 至 0 dBTP', en: 'Use −60 to −5 LUFS and a −20 to 0 dBTP ceiling', ja: '目標は −60〜−5 LUFS、ピーク上限は −20〜0 dBTP で入力してください' },
  'audio.loudness.match.afterLoudness': { 'zh-Hans': '候选响度', 'zh-Hant': '候選響度', en: 'Measured candidate', ja: '候補のラウドネス' },
  'audio.loudness.match.afterPeak': { 'zh-Hans': '候选真峰值', 'zh-Hant': '候選真峰值', en: 'Candidate true peak', ja: '候補のトゥルーピーク' },
  'audio.loudness.match.gain': { 'zh-Hans': '增益调整', 'zh-Hant': '增益調整', en: 'Gain adjustment', ja: 'ゲイン調整' },
  'audio.loudness.match.stage': { 'zh-Hans': '匹配到草稿', 'zh-Hant': '匹配至草稿', en: 'Stage matched gain', ja: '一致したゲインを下書きへ' },
  'audio.loudness.match.staged': { 'zh-Hans': '匹配增益已放入草稿，点击“保存片段”后生效', 'zh-Hant': '匹配增益已放入草稿，點擊「儲存片段」後生效', en: 'Matched gain is in the draft; save the clip to apply it', ja: '一致したゲインを下書きに反映しました。クリップを保存すると適用されます' },
  'audio.loudness.match.gainOutOfRange': { 'zh-Hans': '所需增益超出片段允许范围，无法匹配；未自动降低目标', 'zh-Hant': '所需增益超出片段允許範圍，無法匹配；未自動降低目標', en: 'Required gain exceeds the clip range; the target was not lowered', ja: '必要なゲインがクリップの範囲外です。目標値は自動変更していません' },
  'audio.loudness.match.noValidLoudness': { 'zh-Hans': '此片段没有可用于匹配的有效综合响度', 'zh-Hant': '此片段沒有可用於匹配的有效綜合響度', en: 'This clip has no valid integrated loudness to match', ja: 'このクリップには一致処理に使える有効な統合ラウドネスがありません' },
  'audio.loudness.match.peakConflict': { 'zh-Hans': '候选真峰值超出上限及 0.5 dB 余量，无法匹配；未自动限幅', 'zh-Hant': '候選真峰值超出上限及 0.5 dB 餘量，無法匹配；未自動限幅', en: 'The candidate exceeds the ceiling with a 0.5 dB reserve; no limiter was applied', ja: '候補が 0.5 dB の余裕を含むピーク上限を超えます。リミッターは適用していません' },
  'audio.loudness.match.targetMissed': { 'zh-Hans': '候选复测未达到目标，无法匹配', 'zh-Hant': '候選複測未達到目標，無法匹配', en: 'The measured candidate did not reach the target', ja: '候補の再測定結果が目標に達していません' },
  'audio.loudness.match.alreadyMatched': { 'zh-Hans': '当前增益已达到目标，无需调整', 'zh-Hant': '目前增益已達到目標，無須調整', en: 'The current gain already meets the target', ja: '現在のゲインはすでに目標を満たしています' },
  'audio.loudness.match.rangeShort': { 'zh-Hans': '不足 3 秒', 'zh-Hant': '不足 3 秒', en: 'Under 3 seconds', ja: '3 秒未満' },
  'audio.loudness.match.rangeUnavailable': { 'zh-Hans': '无有效范围', 'zh-Hant': '無有效範圍', en: 'No valid range', ja: '有効な範囲なし' },
  'audio.loudness.match.limitation': { 'zh-Hans': '仅测量此已保存片段的裁剪、增益、淡入淡出与音量包络，不包含其他片段或时间线前置空白。匹配候选经过真实音频复测，只写入草稿，保存后才改变时间线。单片段结果不保证总混音或编码后的峰值；报告仅临时显示', 'zh-Hant': '僅測量此已儲存片段的裁剪、增益、淡入淡出與音量包絡，不包含其他片段或時間軸前置空白。匹配候選經過真實音訊複測，只寫入草稿，儲存後才改變時間軸。單片段結果不保證總混音或編碼後的峰值；報告僅暫時顯示', en: 'Measures this saved clip’s trim, gain, fades and volume envelope, excluding other clips and leading timeline silence. The candidate is measured from real audio and only staged in the draft; saving changes the timeline. Clip results do not guarantee mixed or encoded peaks. Reports are temporary', ja: '保存済みクリップのトリム、ゲイン、フェード、音量エンベロープのみを測定します。他のクリップや先頭の無音は含みません。候補は実際の音声で再測定し、下書きにのみ反映します。保存するとタイムラインが変わります。全体ミックスや符号化後のピークは保証しません。結果は一時表示です' },
  'audio.loudness.match.rangeLimitation': { 'zh-Hans': 'LRA 采用完整 3 秒短时窗口；不足 3 秒、静音或门限下信号不显示数值。0.5 dB 峰值余量仅供本应用匹配检查，不是编码安全保证', 'zh-Hant': 'LRA 採用完整 3 秒短時視窗；不足 3 秒、靜音或門限下訊號不顯示數值。0.5 dB 峰值餘量僅供本應用匹配檢查，不是編碼安全保證', en: 'LRA uses complete 3-second short-term windows. Shorter, silent or below-gate audio has no numeric range. The 0.5 dB reserve is an application check, not a codec safety guarantee', ja: 'LRA は完全な 3 秒の短時間ウィンドウで測定します。3 秒未満、無音、ゲート未満の音声には数値を表示しません。0.5 dB の余裕はアプリ内の検査用で、符号化後の安全性を保証しません' },
} as const satisfies MessageCatalog;
