import {timelineOutputPreset} from './timeline-output-geometry.ts';

// Versioned, immutable rendering profile. Changing font bytes or geometry needs
// a new ID; saved exports never follow a machine's font discovery/fallback.
export const TIMELINE_SUBTITLE_PROFILE_ID='bottom_cjk_v1';
export const TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID='bottom_cjk_relative_v2';
export const TIMELINE_SUBTITLE_PROFILE_IDS=Object.freeze([TIMELINE_SUBTITLE_PROFILE_ID,TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID] as const);
export type TimelineSubtitleProfileId = typeof TIMELINE_SUBTITLE_PROFILE_IDS[number];
export const TIMELINE_SUBTITLE_FONT_SHA256='7b13c45bba411924f99c1ee26e1a5ee1ea7fc768503a4d03987d587e16a72e99';
export const TIMELINE_SUBTITLE_PROFILE=Object.freeze({
 profileId:TIMELINE_SUBTITLE_PROFILE_ID,fontSha256:TIMELINE_SUBTITLE_FONT_SHA256,
 fontSize:28,outline:2,padding:8,outerMargin:48,maxOuterHeight:120,lineSpacing:8,
});
export type TimelineSubtitleProfile = Readonly<typeof TIMELINE_SUBTITLE_PROFILE>;

export interface TimelineSubtitleLayout {
 readonly fontSize: number;
 readonly outline: number;
 readonly padding: number;
 readonly horizontalMargin: number;
 readonly bottomInset: number;
 readonly maxOuterHeight: number;
 readonly lineSpacing: number;
}

const legacyLayout: TimelineSubtitleLayout=Object.freeze({
 fontSize:TIMELINE_SUBTITLE_PROFILE.fontSize,outline:TIMELINE_SUBTITLE_PROFILE.outline,
 padding:TIMELINE_SUBTITLE_PROFILE.padding,horizontalMargin:TIMELINE_SUBTITLE_PROFILE.outerMargin,
 bottomInset:TIMELINE_SUBTITLE_PROFILE.outerMargin,maxOuterHeight:TIMELINE_SUBTITLE_PROFILE.maxOuterHeight,
 lineSpacing:TIMELINE_SUBTITLE_PROFILE.lineSpacing,
});

/** Recompute from the saved basis, never from the rounded previous projection. */
export function projectTimelineSubtitleLayout(
 frame:{width:number;height:number},
 profile:{profileId:unknown;basisPresetId?:unknown},
):TimelineSubtitleLayout|null{
 if(profile.profileId===TIMELINE_SUBTITLE_PROFILE_ID)return Object.hasOwn(profile,'basisPresetId')?null:legacyLayout;
 if(profile.profileId!==TIMELINE_RELATIVE_SUBTITLE_PROFILE_ID||typeof profile.basisPresetId!=='string')return null;
 const basis=timelineOutputPreset(profile.basisPresetId),target=timelineOutputPreset({fps:30,width:frame.width,height:frame.height});
 if(!basis||!target)return null;
 const short=Math.min(target.width,target.height),basisShort=Math.min(basis.width,basis.height);
 const scale=(pixels:number):number=>Math.round(pixels*short/basisShort);
 return {
  fontSize:scale(legacyLayout.fontSize),outline:scale(legacyLayout.outline),padding:scale(legacyLayout.padding),
  horizontalMargin:scale(legacyLayout.horizontalMargin),bottomInset:Math.round(legacyLayout.bottomInset*target.height/basis.height),
  maxOuterHeight:scale(legacyLayout.maxOuterHeight),lineSpacing:scale(legacyLayout.lineSpacing),
 };
}

export interface TimelineSubtitleInkBox {readonly width:number;readonly height:number}
/** Centre the measured ink and align its padded box to the bottom inset. */
export function positionTimelineSubtitle(
 frame:{width:number;height:number},layout:TimelineSubtitleLayout,ink:TimelineSubtitleInkBox,
):{left:number;top:number;width:number;height:number}|null{
 if(![frame.width,frame.height,ink.width,ink.height].every(value=>Number.isSafeInteger(value)&&value>0))return null;
 const width=ink.width+2*layout.padding,height=ink.height+2*layout.padding;
 if(width>frame.width-2*layout.horizontalMargin||height>layout.maxOuterHeight||height+layout.bottomInset>frame.height)return null;
 return {left:Math.floor((frame.width-ink.width)/2)-layout.padding,top:frame.height-layout.bottomInset-height,width,height};
}

const punctuation=new Set(Array.from('，。！？；：、（）【】《》〈〉“”‘’—…·￥％～',character=>character.codePointAt(0)!));
// Verified against the exact bundled SC face cmap. Newer U+9FF0–9FFF are absent.
// No combining marks, RTL controls, emoji, variation selectors or font fallback.
export function isTimelineSubtitleCodePoint(codePoint: unknown): codePoint is number {
 return typeof codePoint==='number'&&Number.isInteger(codePoint)&&((codePoint>=0x20&&codePoint<=0x7e)||(codePoint>=0x4e00&&codePoint<=0x9fef)||punctuation.has(codePoint));
}
