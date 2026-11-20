import type {MessageCatalog} from '../types.ts';

/** DL-a: the shot properties dialogue panel and the subtitle track's dialogue marks. */
export const dialogueMessages = {
  'dialogue.ui.title': {'zh-Hans':'台词','zh-Hant':'台詞',en:'Dialogue',ja:'台詞'},
  'dialogue.ui.save': {'zh-Hans':'保存台词','zh-Hant':'儲存台詞',en:'Save dialogue',ja:'台詞を保存'},
  'dialogue.ui.saving': {'zh-Hans':'正在保存…','zh-Hant':'儲存中…',en:'Saving…',ja:'保存中…'},
  'dialogue.ui.cues': {
    'zh-Hans':{one:'字幕 · {count} 条，在剪辑 T 轨',other:'字幕 · {count} 条，在剪辑 T 轨'},
    'zh-Hant':{one:'字幕 · {count} 條，在剪輯 T 軌',other:'字幕 · {count} 條，在剪輯 T 軌'},
    en:{one:'Subtitle · {count} cue on the editing T track',other:'Subtitles · {count} cues on the editing T track'},
    ja:{one:'字幕 · 編集 T トラックに {count} 件',other:'字幕 · 編集 T トラックに {count} 件'},
  },
  'dialogue.ui.error.generic': {'zh-Hans':'无法保存台词','zh-Hant':'無法儲存台詞',en:'Could not save the dialogue',ja:'台詞を保存できませんでした'},
  'dialogue.ui.error.invalid': {'zh-Hans':'台词不符合字幕规范：每行最多 20 个字符、最多两行','zh-Hant':'台詞不符合字幕規範：每行最多 20 個字元、最多兩行',en:'The dialogue does not match the subtitle rule: 20 characters per line, two lines at most',ja:'台詞が字幕の規則に合いません：1 行 20 文字まで、2 行まで'},
  'dialogue.ui.error.conflict': {'zh-Hans':'镜头的帧不够放这些台词，或普通字幕占用了可用帧','zh-Hant':'鏡頭的影格不夠放這些台詞，或一般字幕佔用了可用影格',en:'The shot has too few frames for this dialogue, or ordinary subtitles occupy the free frames',ja:'このショットのフレームが台詞に足りないか、通常字幕が空きフレームを使っています'},
  'dialogue.ui.error.stale': {'zh-Hans':'项目已变化，请重新读取后再试','zh-Hant':'專案已變更，請重新讀取後再試',en:'The project changed. Read it again and retry',ja:'プロジェクトが変わりました。読み直してから再試行してください'},
  'dialogue.ui.error.noop': {'zh-Hans':'台词没有变化','zh-Hant':'台詞沒有變更',en:'The dialogue did not change',ja:'台詞は変わっていません'},
  'dialogue.ui.error.unsupported': {'zh-Hans':'这个项目暂时不能编辑台词','zh-Hant':'這個專案暫時不能編輯台詞',en:'Dialogue editing is not available in this project yet',ja:'このプロジェクトでは台詞を編集できません'},
  'dialogue.ui.generationUnsupported': {'zh-Hans':'当前服务不支持','zh-Hant':'目前服務不支援',en:'Not supported by this service',ja:'このサービスでは非対応'},
  'dialogue.ui.generationPromptTooLong': {'zh-Hans':'台词加进提示词后超出该服务的上限，本次生成会被拒绝（不会截断）。','zh-Hant':'台詞加進提示詞後超出該服務的上限，本次生成會被拒絕（不會截斷）。',en:'The dialogue makes the prompt exceed this service\'s limit; this generation is rejected (no truncation).',ja:'台詞を加えるとこのサービスの上限を超えるため、この生成は拒否されます（切り詰めません）。'},
  'dialogue.ui.mark': {'zh-Hans':'台词','zh-Hant':'台詞',en:'Dialogue',ja:'台詞'},
} as const satisfies MessageCatalog;
