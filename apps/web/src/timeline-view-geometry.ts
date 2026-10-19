/** Kept in sync with the shared --wb-track-heading and --wb-ruler tokens. */
export const TIMELINE_TRACK_HEADER_PX = 168;
export const TIMELINE_RULER_PX = 24;

/** A new empty editor starts with the primary picture/audio drop zones. All
 * saved/custom tracks remain available as soon as the first edit is made. */
export function timelineVisibleTracks<T extends {id:string;kind:string}>(tracks:readonly T[],pristine:boolean):readonly T[] {
  if(!pristine)return tracks;
  const baseVideo=[...tracks].reverse().find(track=>track.kind==='video');
  return tracks.filter(track=>track.kind==='audio'||track.id===baseVideo?.id);
}

export function timelinePointerFrame(clientX: number, left: number, renderedWidth: number, layoutWidth: number, pixelsPerFrame: number): number | null {
  if (![clientX,left,renderedWidth,layoutWidth,pixelsPerFrame].every(Number.isFinite) || renderedWidth<=0 || layoutWidth<=0 || pixelsPerFrame<=0) return null;
  // DOM pointer coordinates and rectangles include CSS zoom/transforms;
  // timeline widths, scrollLeft and pixelsPerFrame remain in layout pixels.
  return (clientX-left) * layoutWidth / renderedWidth / pixelsPerFrame;
}

export function timelinePointerFrameAtElement(clientX: number, element: HTMLElement, pixelsPerFrame: number): number | null {
  const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
  const value=(name:string)=>Number.parseFloat(style.getPropertyValue(name))||0;
  const layoutWidth=Number.parseFloat(style.width)+(style.boxSizing==='border-box'?0:value('padding-left')+value('padding-right')+value('border-left-width')+value('border-right-width'));
  return timelinePointerFrame(clientX,rect.left,rect.width,layoutWidth,pixelsPerFrame);
}
