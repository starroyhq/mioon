import type {MessageCatalog} from '../types.ts';

/** Format-5 clip sound: mute, separate sound and save-as-audio wording. */
export const clipSoundMessages = {
  'clipSound.split': {'zh-Hans': '切开', 'zh-Hant': '切開', en: 'Split', ja: '分割'},
  'clipSound.clipMenu': {'zh-Hans': '片段菜单', 'zh-Hant': '片段選單', en: 'Clip menu', ja: 'クリップメニュー'},
  'clipSound.muteSwitch': {'zh-Hans': '片段声音', 'zh-Hant': '片段聲音', en: 'Clip sound', ja: 'クリップの音声'},
  'clipSound.muted': {'zh-Hans': '已静音', 'zh-Hant': '已靜音', en: 'Muted', ja: 'ミュート中'},
  'clipSound.separate': {'zh-Hans': '分离声音', 'zh-Hant': '分離聲音', en: 'Separate sound', ja: '音声を分離'},
  'clipSound.mute': {'zh-Hans': '静音', 'zh-Hant': '靜音', en: 'Mute', ja: 'ミュート'},
  'clipSound.unmute': {'zh-Hans': '取消静音', 'zh-Hant': '取消靜音', en: 'Unmute', ja: 'ミュート解除'},
  'clipSound.saveAsAudio': {'zh-Hans': '另存为音频素材', 'zh-Hant': '另存為音訊素材', en: 'Save as audio asset', ja: '音声素材として保存'},
  'clipSound.nameSuffix': {'zh-Hans': '声音', 'zh-Hant': '聲音', en: 'Sound', ja: 'サウンド'},
  'clipSound.trackName': {'zh-Hans': '声音', 'zh-Hant': '聲音', en: 'Sound', ja: 'サウンド'},
  'clipSound.assetName': {'zh-Hans': '{name} 的声音', 'zh-Hant': '{name} 的聲音', en: '{name} · Sound', ja: '{name} のサウンド'},
  'clipSound.toast.progress': {'zh-Hans': '正在另存为音频素材：{name}', 'zh-Hant': '正在另存為音訊素材：{name}', en: 'Saving clip sound: {name}', ja: '音声素材として保存中：{name}'},
  'clipSound.toast.done': {'zh-Hans': '已另存为音频素材', 'zh-Hant': '已另存為音訊素材', en: 'Saved as audio asset', ja: '音声素材として保存しました'},
  'clipSound.toast.viewInLibrary': {'zh-Hans': '在素材库中查看', 'zh-Hant': '在素材庫中查看', en: 'View in library', ja: 'ライブラリで表示'},
  'clipSound.toast.failed': {'zh-Hans': '另存为音频素材失败', 'zh-Hant': '另存為音訊素材失敗', en: 'Saving clip sound failed', ja: '音声素材として保存できませんでした'},
  'clipSound.toast.cancelled': {'zh-Hans': '已取消另存为音频素材', 'zh-Hant': '已取消另存為音訊素材', en: 'Saving clip sound cancelled', ja: '音声素材としての保存を取り消しました'},
  'clipSound.retry': {'zh-Hans': '重试', 'zh-Hant': '重試', en: 'Retry', ja: '再試行'},
  'clipSound.cancel': {'zh-Hans': '取消', 'zh-Hant': '取消', en: 'Cancel', ja: 'キャンセル'},
  'editUi.notice.soundSeparated': {'zh-Hans': '已分离声音', 'zh-Hant': '已分離聲音', en: 'Separated the sound', ja: '音声を分離しました'},
  'editUi.error.SEQUENCE_EDIT_SOUND_INVALID': {'zh-Hans': '这个片段没有可分离的声音，或没有可用的音频轨。', 'zh-Hant': '這個片段沒有可分離的聲音，或沒有可用的音訊軌。', en: 'This clip has no sound to separate, or no audio track is available.', ja: 'このクリップには分離できる音声がないか、使用できるオーディオトラックがありません。'},
  'timeline.history.clipSeparateSound': {'zh-Hans': '分离声音', 'zh-Hant': '分離聲音', en: 'Separate sound', ja: '音声を分離'},
} as const satisfies MessageCatalog;
