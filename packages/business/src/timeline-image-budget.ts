interface TimelineWithClips {readonly clips:readonly {readonly colour?:unknown}[]}
/** A new image declaration adds bounded evidence to each clip, but does not
 * enlarge any historical record/receipt/history budget. Called only on an
 * already structurally bounded candidate inside its mutation transaction.
 * Persisted corruption keeps the ordinary invalid-snapshot reader path. */
export function timelineImageResponseBudgetIssue(timeline:TimelineWithClips,maxBytes:number):{
 code:'TIMELINE_IMAGE_AGGREGATE_BUDGET';message:string;status:409;details:{maxBytes:number;actualBytes:number};
}|null {
 if(!Array.isArray(timeline.clips)||timeline.clips.length>100||!timeline.clips.some(clip=>clip!==null&&typeof clip==='object'&&clip.colour!==null&&typeof clip.colour==='object'&&
  'profileId' in clip.colour&&clip.colour.profileId==='mioon-srgb-image-clip-v1'))return null;
 const actualBytes=new TextEncoder().encode(JSON.stringify(timeline)).byteLength;
 if(actualBytes<=maxBytes)return null;
 return {code:'TIMELINE_IMAGE_AGGREGATE_BUDGET',status:409,
  message:'图片色彩证据使时间线超过 256 KiB 保存上限。请缩短片段或轨道名称、字幕文字，或减少片段后重试；本次修改未保存。',
  details:{maxBytes,actualBytes}};
}
