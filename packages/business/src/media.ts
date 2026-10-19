import {throwIfMediaAborted,interruptedMediaError} from './media-processes.ts';
import {run,checkMediaEffect,isMediaEffectRestriction} from './media-runtime.ts';
import type {MediaEffectFence} from './media-runtime.ts';
import {parseProbeOutput,withProbePermit} from './media-probe.ts';
import type {ProbeResult} from './media-probe.ts';
import {stat,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {timelineOutputPreset} from '../../contracts/src/timeline-output-geometry.ts';
import type {TimelineOutputGeometry} from '../../contracts/src/timeline-output-geometry.ts';
export {run};

export interface MediaProbeOptions {
  signal?: AbortSignal | null;
  timeout?: number;
  beforeSpawn?: MediaEffectFence;
  beforeEffect?: MediaEffectFence;
}
export interface MediaEffectOptions {
  signal?: AbortSignal | null;
  beforeEffect?: MediaEffectFence;
}
export interface MediaFileInfo {
  sizeBytes: number;
  sha256: string;
  width: number;
  height: number;
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
}
export interface StitchOptions extends MediaEffectOptions {
  outputGeometry?: TimelineOutputGeometry;
}

const isUnconfirmed = (reason: unknown): boolean => typeof reason === 'object' && reason !== null && Boolean((reason as {terminationUnconfirmed?: unknown}).terminationUnconfirmed);

// Preserve the historical rejection precedence: unconfirmed termination, effect
// restriction, caller abort, then the first remaining failure.
function settledFailure(results: readonly PromiseSettledResult<unknown>[], signal?: AbortSignal | null): void {
  const unconfirmed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected' && isUnconfirmed(result.reason));
  if (unconfirmed) throw unconfirmed.reason;
  const restricted = results.find((result): result is PromiseRejectedResult => result.status === 'rejected' && isMediaEffectRestriction(result.reason));
  if (restricted) throw restricted.reason;
  throwIfMediaAborted(signal);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
}
function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

export async function probe(file: string, {signal,timeout,beforeSpawn,beforeEffect}: MediaProbeOptions = {}): Promise<ProbeResult> {
  return withProbePermit(signal, async () => {
    const output = await run('ffprobe', ['-v','error','-show_format','-show_streams','-of','json',file], {signal,timeout,beforeSpawn,beforeEffect});
    checkMediaEffect(beforeEffect,signal);
    return parseProbeOutput(output);
  });
}
// Hash incrementally: long timeline exports must not be copied into JS memory.
export async function fileHash(file: string, {signal,beforeEffect}: MediaEffectOptions = {}): Promise<string> {
  checkMediaEffect(beforeEffect,signal);
  const hash = createHash('sha256'), stream = createReadStream(file);
  const abort = (): void => { stream.destroy(interruptedMediaError()); };
  signal?.addEventListener('abort',abort,{once:true});
  try {
    checkMediaEffect(beforeEffect,signal);
    for await (const data of stream) { checkMediaEffect(beforeEffect,signal); hash.update(data); }
    checkMediaEffect(beforeEffect,signal);
    return hash.digest('hex');
  } finally { signal?.removeEventListener('abort',abort); stream.destroy(); }
}
export async function fileInfo(file: string, {signal,beforeEffect}: MediaEffectOptions = {}): Promise<MediaFileInfo> {
  checkMediaEffect(beforeEffect,signal);
  const s = await stat(file);
  checkMediaEffect(beforeEffect,signal);
  const results = await Promise.allSettled([fileHash(file,{signal,beforeEffect}),probe(file,{signal,beforeEffect})]);
  settledFailure(results, signal);
  const sha256 = fulfilledValue(results[0]), p = fulfilledValue(results[1]);
  checkMediaEffect(beforeEffect,signal);
  return {sizeBytes:s.size,sha256,width:p.width,height:p.height,duration:p.duration,hasVideo:p.hasVideo,hasAudio:p.hasAudio};
}
export async function safePath(root: string, relative: string): Promise<string> {
  const base = await realpath(path.join(root,'media'));
  const target = await realpath(path.join(root,relative));
  if(!target.startsWith(base+path.sep))throw Error('Media path outside managed directory');
  return target;
}
export async function stitch(files: readonly string[], destination: string, {signal,beforeEffect,outputGeometry={fps:30,width:1080,height:1920}}: StitchOptions = {}): Promise<void> {
 checkMediaEffect(beforeEffect,signal);
 const output = timelineOutputPreset(outputGeometry);
 if(!output)throw Object.assign(Error('Invalid frozen storyboard output geometry'),{code:'INVALID_TIMELINE_SNAPSHOT'});
 const args = ['-hide_banner','-loglevel','error','-y'];for(const f of files)args.push('-i',f);
 const results = await Promise.allSettled(files.map(file=>probe(file,{signal,beforeEffect})));
 settledFailure(results,signal);
 const metadata = results.map(fulfilledValue),chains: string[] = [];
 checkMediaEffect(beforeEffect,signal);
 files.forEach((_,i)=>{
  const {duration,hasVideo,hasAudio,videoStreamIndex,audioStreamIndex} = metadata[i] as ProbeResult;
  if(!(duration>0))throw Error('Export input has no duration');
  if(!hasVideo)throw Error('Export input has no video stream');
  // Reuse the probed streams: a preceding cover or unidentified codec must not
  // override the playable source selected by the shared metadata parser.
  chains.push(`[${i}:${videoStreamIndex??'v:0'}]scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease,pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,setpts=PTS-STARTPTS,format=yuv420p[v${i}]`);
  chains.push(hasAudio?`[${i}:${audioStreamIndex??'a:0'}]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`:`anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${i}]`);
 });
 chains.push(files.map((_,i)=>`[v${i}][a${i}]`).join('')+`concat=n=${files.length}:v=1:a=1[outv][outa]`);
 args.push('-filter_complex',chains.join(';'),'-map','[outv]','-map','[outa]','-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',destination);
 await run('ffmpeg',args,{timeout:300000,signal,beforeEffect});
 checkMediaEffect(beforeEffect,signal);await probe(destination,{signal,beforeEffect});checkMediaEffect(beforeEffect,signal);
}
