// Versioned, immutable rendering profile. Changing font bytes or geometry needs
// a new ID; saved exports never follow a machine's font discovery/fallback.
export const TIMELINE_SUBTITLE_PROFILE_ID='bottom_cjk_v1';
export const TIMELINE_SUBTITLE_FONT_SHA256='7b13c45bba411924f99c1ee26e1a5ee1ea7fc768503a4d03987d587e16a72e99';
export const TIMELINE_SUBTITLE_PROFILE=Object.freeze({
 profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256,
 fontSize:28,outline:2,padding:8,outerMargin:48,maxOuterHeight:120,lineSpacing:8,
});
const punctuation=new Set(Array.from('，。！？；：、（）【】《》〈〉“”‘’—…·￥％～',character=>character.codePointAt(0)));
// Verified against the exact bundled SC face cmap. Newer U+9FF0–9FFF are absent.
// No combining marks, RTL controls, emoji, variation selectors or font fallback.
export function isTimelineSubtitleCodePoint(codePoint){
 return Number.isInteger(codePoint)&&((codePoint>=0x20&&codePoint<=0x7e)||(codePoint>=0x4e00&&codePoint<=0x9fef)||punctuation.has(codePoint));
}
