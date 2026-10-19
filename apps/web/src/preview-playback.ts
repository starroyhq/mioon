interface SourceSeekBinding {sourceSeekIntent: number | null; programmaticSeek: number | null}
interface StepOptions {
  delta: number; media: HTMLMediaElement | null; current: boolean; timelineMode: boolean;
  timelineDuration: number; playhead: number; sourcePosition: number; sourceCount: number | null;
  sourceFps: number; binding: SourceSeekBinding | null; onSeek(frame: number): void; notify(): void;
}
export function stepPreviewMedia(options: StepOptions): void {
  const {media,binding}=options;
  if (!media || !binding || !options.current || media.readyState<1 || ![-1,1].includes(options.delta)) return;
  media.pause();
  if (options.timelineMode) {options.onSeek(Math.max(0,Math.min(options.timelineDuration,options.playhead+options.delta)));return;}
  if (options.sourceCount===null) return;
  const next=Math.max(0,Math.min(options.sourceCount-1,options.sourcePosition+options.delta));
  binding.sourceSeekIntent=next;binding.programmaticSeek=null;
  media.currentTime=next/options.sourceFps;options.notify();
}
export function previewProgress(value: unknown): number | null {
  return typeof value==='number' && Number.isFinite(value) ? Math.round(Math.max(0,Math.min(100,value))) : null;
}
