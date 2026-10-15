import type { MessageCatalog } from '../types.ts';
export const volumeEnvelopeMessages = {
  "volume.envelope.title": {"zh-Hans": "音量关键帧", "zh-Hant": "音量關鍵幀", "en": "Volume keyframes", "ja": "音量キーフレーム"},
  "volume.envelope.frame": {"zh-Hans": "片段内帧", "zh-Hant": "片段內幀", "en": "Local frame", "ja": "クリップ内フレーム"},
  "volume.envelope.multiplier": {"zh-Hans": "音量倍率", "zh-Hant": "音量倍率", "en": "Multiplier", "ja": "音量倍率"},
  "volume.envelope.add": {"zh-Hans": "添加关键帧", "zh-Hant": "新增關鍵幀", "en": "Add keyframe", "ja": "キーフレームを追加"},
  "volume.envelope.remove": {"zh-Hans": "移除第 {index} 个关键帧", "zh-Hant": "移除第 {index} 個關鍵幀", "en": "Remove keyframe {index}", "ja": "キーフレーム {index} を削除"},
  "volume.envelope.clear": {"zh-Hans": "清除音量关键帧", "zh-Hant": "清除音量關鍵幀", "en": "Clear volume keyframes", "ja": "音量キーフレームをクリア"},
  "volume.envelope.effect": {"zh-Hans": "0 为静音，1 保持原音量；与现有音量和淡入淡出相乘。", "zh-Hant": "0 為靜音，1 保持原音量；與現有音量和淡入淡出相乘。", "en": "0 is silence; 1 leaves volume unchanged. Multiplies existing gain and fades.", "ja": "0 は無音、1 は音量を維持します。既存のゲインとフェードに乗算されます。"},
  "volume.envelope.bounds": {"zh-Hans": "需要 1–16 个关键帧。帧为 0–{duration} 的整数，严格递增；倍率为 0–1。", "zh-Hant": "需要 1–16 個關鍵幀。幀為 0–{duration} 的整數，嚴格遞增；倍率為 0–1。", "en": "Use 1–16 keyframes: integer frames 0–{duration}, strictly increasing; multipliers 0–1.", "ja": "キーフレームは 1～16 個です。フレームは 0～{duration} の整数で昇順、倍率は 0～1 にしてください。"},
  "volume.envelope.rejected": {"zh-Hans": "未接受此次输入。仅支持数字及 + - . e E，最多 {limit} 个字符；原值未变。", "zh-Hant": "未接受此次輸入。僅支援數字及 + - . e E，最多 {limit} 個字元；原值未變。", "en": "Input not accepted. Use digits and + - . e E, up to {limit} characters. The previous value is unchanged.", "ja": "入力を受け付けませんでした。数字と + - . e E を {limit} 文字以内で入力してください。元の値は変更されていません。"},
  "volume.envelope.unsupported": {"zh-Hans": "当前工作区无法保存音量关键帧修改；草稿已保留。", "zh-Hant": "目前工作區無法儲存音量關鍵幀修改；草稿已保留。", "en": "This workspace cannot save volume-keyframe changes. The draft is retained.", "ja": "このワークスペースでは音量キーフレームの変更を保存できません。下書きは保持されています。"},
  "volume.envelope.oversize": {"zh-Hans": "输入超过本地草稿大小限制，仍保留在当前表单中，但尚未保存到本地。", "zh-Hant": "輸入超過本機草稿大小限制，仍保留在目前表單中，但尚未儲存至本機。", "en": "Input exceeds the local draft size limit. It remains in this form but has not been saved locally.", "ja": "入力がローカル下書きのサイズ上限を超えています。現在のフォームには保持されていますが、ローカルには保存されていません。"},
} as const satisfies MessageCatalog;
