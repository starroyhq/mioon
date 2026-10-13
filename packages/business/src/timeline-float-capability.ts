import path from 'node:path';
import {constants,openSync,fstatSync,lstatSync,closeSync,unlinkSync,rmdirSync,writeFileSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {createTimelineFloatAudioChecker} from './timeline-float-audio-check.ts';
import type {TimelineFloatAudioRuntime} from './timeline-float-audio-check.ts';

const FILE_BYTES = 1024 * 1024;
const changed = (): Error => Object.assign(new Error('The local float capability staging files changed.'), {code:'EXPORT_AUDIO_STAGING_CHANGED'});
const configuration = (): Error => Object.assign(new Error('The local float capability staging root is invalid.'), {code:'MEDIA_INVALID_CONFIGURATION'});
const same = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
interface CapabilityRuntime extends TimelineFloatAudioRuntime {
  createPrivateTemporaryDirectory(root: string, prefix: string): string;
  validatePrivateDirectory(root: string): unknown;
  waitForMediaProcesses(options: {signal?: AbortSignal}): Promise<unknown>;
  videoArgs(): string[];
  verifyProof(bytes: Buffer): void;
}
export interface TimelineFloatCapabilityOptions {
  readonly workRoot: string;
  readonly signal?: AbortSignal;
  readonly beforeEffect?: () => void;
  readonly remainingMs: () => number;
}
interface EffectiveVideo {readonly width: number; readonly height: number; readonly scaling: string; readonly pixelFormat: string}

/** Private, fixed-leaf, inode-owned proof staging. Unknown/replaced files and
 * directories are never removed; descriptors and known files stay held until
 * an unconfirmed direct child actually closes. No recursive cleanup occurs. */
function ownedProof(runtime: CapabilityRuntime, options: TimelineFloatCapabilityOptions): {
  readonly work: string; effect(): void; reserve(leaf: string, content?: string): string; cleanup(): boolean;
} {
  if (typeof options.workRoot !== 'string' || !path.isAbsolute(options.workRoot) || options.workRoot.includes('\0')) throw configuration();
  const prior = (): void => { runtime.checkMediaEffect(options.beforeEffect ?? (() => {}), options.signal); if (options.remainingMs() < 1) throw Object.assign(new Error('Capability deadline expired.'), {code:'MEDIA_TIMEOUT'}); };
  prior();
  const root = lstatSync(options.workRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw configuration();
  const work = runtime.createPrivateTemporaryDirectory(options.workRoot, '.timeline-float-proof-');
  const directoryFd = openSync(work, constants.O_RDONLY | constants.O_NOFOLLOW), directory = fstatSync(directoryFd);
  const files = new Map<string, {fd: number; identity: Stats}>();
  const ownsDirectory = (): boolean => {
    try { const currentRoot = lstatSync(options.workRoot), current = lstatSync(work);
      return currentRoot.isDirectory() && !currentRoot.isSymbolicLink() && same(root,currentRoot) && current.isDirectory() && !current.isSymbolicLink() && same(directory,current);
    } catch { return false; }
  };
  const ownsFile = (file: string, entry: {identity: Stats}): boolean => {
    try { const current = lstatSync(file); return current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && same(entry.identity,current); } catch { return false; }
  };
  const effect = (): void => {
    prior(); if (!ownsDirectory()) throw changed(); runtime.validatePrivateDirectory(work);
    for (const [file,entry] of files) {
      if (!ownsFile(file,entry)) throw changed();
      const current = lstatSync(file);
      if (current.uid !== directory.uid || current.mode & 0o077) throw changed();
      if (current.size > FILE_BYTES) throw Object.assign(new Error('The local capability proof exceeded its file size limit.'), {code:'MEDIA_OUTPUT_LIMIT'});
    }
  };
  const cleanup = (): boolean => {
    let confirmed = true;
    try {
      for (const [file,entry] of files) {
        if (!ownsDirectory()) { confirmed = false; break; }
        if (ownsFile(file,entry)) { try { unlinkSync(file); } catch { confirmed = false; } } else confirmed = false;
      }
      if (ownsDirectory()) { try { rmdirSync(work); } catch { confirmed = false; } } else confirmed = false;
    } finally { for (const entry of files.values()) try { closeSync(entry.fd); } catch { confirmed = false; } try { closeSync(directoryFd); } catch { confirmed = false; } }
    return confirmed;
  };
  const reserve = (leaf: string, content?: string): string => {
    effect();
    if (!['segment-0.mov','segment-1.mov','segments.txt'].includes(leaf) || files.size >= 3) throw changed();
    const file = path.join(work,leaf); if (files.has(file)) throw changed();
    const fd = openSync(file,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
    files.set(file,{fd,identity:fstatSync(fd)});
    if (content !== undefined) { writeFileSync(fd,content); effect(); }
    return file;
  };
  try { effect(); } catch (error) { cleanup(); throw error; }
  return {work,effect,reserve,cleanup};
}

/** Actual selected-video + pcm_f32le/MOV + two-segment concat + AAC/MP4
 * capability proof. Known above-one samples must survive the intermediate and
 * concat unchanged. This is observation only and never a later render token. */
export async function proveTimelineFloatCapability(runtime: CapabilityRuntime, video: EffectiveVideo, options: TimelineFloatCapabilityOptions): Promise<void> {
  if (!options || typeof options.remainingMs !== 'function') throw configuration();
  const owned = ownedProof(runtime,options); let unconfirmed = false, primaryFailure: unknown;
  const runOptions = (maxStdoutBytes: number) => ({signal:options.signal,timeout:Math.floor(options.remainingMs()),maxStdoutBytes,maxStderrBytes:64*1024,beforeSpawn:owned.effect,beforeEffect:owned.effect});
  try {
    const entries: string[] = [], ownedSegments: {file: string; outputFrames: number}[] = [];
    for (let segment=0;segment<2;segment++) {
      const file = owned.reserve(`segment-${segment}.mov`);
      await runtime.run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-filter_complex_threads','1',
        '-f','lavfi','-i','color=c=black:s=64x64:r=30:d=0.1','-f','lavfi','-i','aevalsrc=1.25|-1.5:s=48000:d=0.1:c=stereo',
        '-filter_complex',`[0:v]scale=${video.width}:${video.height}:flags=${video.scaling},setsar=1,format=${video.pixelFormat}[v]`,
        '-map','[v]','-map','1:a:0',...runtime.videoArgs(),'-frames:v','3','-c:a','pcm_f32le','-ar','48000','-ac','2','-t','0.1',
        '-fs',String(FILE_BYTES),'-f','mov',file],runOptions(0));
      owned.effect(); ownedSegments.push({file,outputFrames:3}); entries.push(`file '${file.replaceAll("'","'\\''")}'\nduration 0.100000000`);
    }
    const list = owned.reserve('segments.txt',entries.join('\n')+'\n'); owned.effect();
    const measured = await createTimelineFloatAudioChecker(runtime)(list,6,{signal:options.signal,beforeEffect:owned.effect,ownedSegments,remainingMs:options.remainingMs});
    owned.effect();
    if (measured.channelPeaks[0].peakLinear !== 1.25 || measured.channelPeaks[1].peakLinear !== 1.5 ||
        measured.channelPeaks.some(channel=>channel.overRangeSampleCount !== 9600)) throw Object.assign(new Error('Float intermediate headroom could not be verified.'),{code:'EXPORT_CAPABILITY_FAILED'});
    const chunks: Buffer[] = [];
    const result = await runtime.runStreaming('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-xerror',
      '-protocol_whitelist','file','-format_whitelist','concat,mov','-f','concat','-safe','0','-i',list,
      '-map','0:v:0','-map','0:a:0','-c:v','copy','-video_track_timescale','30000','-af','asetpts=N/SR/TB',
      '-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-t','0.2','-movflags','+frag_keyframe+empty_moov+default_base_moof','-f','mp4','pipe:1'],
      {...runOptions(FILE_BYTES),onStdout(chunk: Buffer): void { owned.effect(); chunks.push(Buffer.from(chunk)); }});
    owned.effect();
    if (!result || typeof result !== 'object' || !('stdoutBytes' in result) || typeof result.stdoutBytes !== 'number') throw configuration();
    runtime.verifyProof(Buffer.concat(chunks,result.stdoutBytes)); owned.effect();
  } catch (error) {
    primaryFailure = error;
    unconfirmed = typeof error === 'object' && error !== null && 'terminationUnconfirmed' in error && error.terminationUnconfirmed === true;
    throw error;
  } finally {
    if (unconfirmed) void runtime.waitForMediaProcesses({signal:options.signal}).then(()=>owned.cleanup());
    else if (!owned.cleanup() && !primaryFailure) throw changed();
  }
}
