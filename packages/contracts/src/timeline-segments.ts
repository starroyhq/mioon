export interface TimelineCompositionSegment {
  readonly beginFrame:number;
  readonly endFrame:number;
}

/** The caller validates the complete saved/frozen timeline first. All clip
 * edges participate, including muted tracks, zero gain, images, and gaps.
 * With at most 100 clips and duration equal to the final clip end, there are
 * at most 200 segments. This preserves export's original reseek boundaries. */
export function timelineCompositionSegments(timeline:{
  readonly durationFrames:number;
  readonly clips:readonly {readonly startFrame:number;readonly durationFrames:number}[];
}):readonly TimelineCompositionSegment[] {
  const edges=[...new Set([0,timeline.durationFrames,
    ...timeline.clips.flatMap(clip=>[clip.startFrame,clip.startFrame+clip.durationFrames]),
  ])].sort((a,b)=>a-b);
  const segments:TimelineCompositionSegment[]=[];
  for(let index=0;index<edges.length-1;index++){
    segments.push(Object.freeze({beginFrame:edges[index]!,endFrame:edges[index+1]!}));
  }
  return Object.freeze(segments);
}
