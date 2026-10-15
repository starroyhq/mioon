import type { MessageCatalog } from '../types.ts';
export const audioRoleMessages = {
  'audio.role.label': { 'zh-Hans': '音频分类', 'zh-Hant': '音訊分類', en: 'Audio role', ja: '音声の分類' },
  'audio.role.unclassified': { 'zh-Hans': '未分类', 'zh-Hant': '未分類', en: 'Unclassified', ja: '未分類' },
  'audio.role.human': { 'zh-Hans': '人声', 'zh-Hant': '人聲', en: 'Human voice', ja: '人の声' },
  'audio.role.music': { 'zh-Hans': '音乐', 'zh-Hant': '音樂', en: 'Music', ja: '音楽' },
  'audio.role.sfx': { 'zh-Hans': '音效', 'zh-Hant': '音效', en: 'Sound effects', ja: '効果音' },
  'audio.role.hint': {
    'zh-Hans': '仅用于编辑分类，不改变声音，也不代表片段有可听见的音频。点击“保存片段”后生效。',
    'zh-Hant': '僅用於編輯分類，不改變聲音，也不代表片段有可聽見的音訊。按下「儲存片段」後生效。',
    en: 'An editorial label only. It does not change sound or prove audible audio. Use Save clip to apply.',
    ja: '編集用の分類です。音は変わらず、聞こえる音声の存在を示すものでもありません。「クリップを保存」で適用します。'
  },
  'audio.role.unavailable': {
    'zh-Hans': '此工作区尚未确认支持编辑音频分类。其他片段属性仍可编辑。',
    'zh-Hant': '此工作區尚未確認支援編輯音訊分類。其他片段屬性仍可編輯。',
    en: 'Audio role editing is not confirmed for this workspace. Other clip properties remain editable.',
    ja: 'このワークスペースでは音声の分類の編集に対応していることを確認できません。他のクリップ属性は編集できます。'
  },
  'audio.role.unsupportedChange': {
    'zh-Hans': '草稿包含此工作区不支持的音频分类更改。输入已保留；请放弃此草稿后再编辑其他属性。',
    'zh-Hant': '草稿包含此工作區不支援的音訊分類變更。輸入已保留；請捨棄此草稿後再編輯其他屬性。',
    en: 'This draft contains an unsupported audio role change. Input is retained; discard the draft before editing other properties.',
    ja: 'この下書きには未対応の音声分類の変更が含まれています。入力は保持されています。他の属性を編集するには下書きを破棄してください。'
  }
} as const satisfies MessageCatalog;
