import type { MessageCatalog } from '../types.ts';
export const audioRoleMessages = {
  'audio.role.label': { 'zh-Hans': '音频分类', 'zh-Hant': '音訊分類', en: 'Audio role', ja: '音声の分類' },
  'audio.role.unclassified': { 'zh-Hans': '未分类', 'zh-Hant': '未分類', en: 'Unclassified', ja: '未分類' },
  'audio.role.human': { 'zh-Hans': '人声', 'zh-Hant': '人聲', en: 'Human voice', ja: '人の声' },
  'audio.role.music': { 'zh-Hans': '音乐', 'zh-Hant': '音樂', en: 'Music', ja: '音楽' },
  'audio.role.sfx': { 'zh-Hans': '音效', 'zh-Hant': '音效', en: 'Sound effects', ja: '効果音' },
  'audio.role.loading': { 'zh-Hans': '正在检查此工作区的音频分类支持；其他属性仍可编辑', 'zh-Hant': '正在檢查此工作區的音訊分類支援；其他屬性仍可編輯', en: 'Checking audio role support. Other properties remain editable', ja: '音声分類への対応を確認中です。他の属性は編集できます' },
  'audio.role.unsupported': { 'zh-Hans': "此工作区不支持编辑音频分类", 'zh-Hant': "此工作區不支援編輯音訊分類", en: "Audio roles cannot be edited in this workspace", ja: "このワークスペースでは音声分類を編集できません" },
  'audio.role.unavailable': {
    'zh-Hans': '此工作区尚未确认支持编辑音频分类。其他片段属性仍可编辑',
    'zh-Hant': '此工作區尚未確認支援編輯音訊分類。其他片段屬性仍可編輯',
    en: 'Audio role editing is not confirmed for this workspace. Other clip properties remain editable',
    ja: 'このワークスペースでは音声の分類の編集に対応していることを確認できません。他のクリップ属性は編集できます'
  },
  'audio.role.unsupportedChange': {
    'zh-Hans': "草稿包含不受支持的音频分类更改",
    'zh-Hant': "草稿包含不受支援的音訊分類變更",
    en: "This draft contains an unsupported audio role change",
    ja: "下書きに未対応の音声分類の変更があります"
  }
} as const satisfies MessageCatalog;
