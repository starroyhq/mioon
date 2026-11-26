import {lstat} from 'node:fs/promises';
import {AppError} from '../../contracts/src/app-error.ts';
import {timeMapPlanFrames, timeMapSourceRangeForEdit, timeMapSourceWindowForOutput, timeMapTailInverse} from '../../contracts/src/timeline-time-map.ts';
import type {CompiledTimeMap, ContinuousSourcePosition, TimeMapResult, TimeMapSourceBoundary} from '../../contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../../contracts/src/timeline-speed.ts';
import {SPEED_BUDGET_EXCEEDED, SPEED_CAPABILITY_UNAVAILABLE, SPEED_MAPPING_INVALID, SPEED_SOURCE_UNSUPPORTED,
  TIMELINE_SPEED_EXPORT_MESSAGES} from '../../contracts/src/timeline-speed-export.ts';
import {checkMediaEffect, isMediaToolFailure, run, runStreaming} from './media-runtime.ts';
import type {MediaEffectFence} from './media-runtime.ts';
import {withProbePermit} from './media-probe.ts';

const fps = 30;
const maxScriptBytes = 2 * 1024 * 1024;
const maxIndexFrames = 60_000;
const defaultProxyBytes = 2 * 1024 ** 3;
const maxRawFrameBytes = 128 * 1024 ** 2;
const colourFlags = {
  color_range: '-color_range',
  color_space: '-colorspace',
  color_primaries: '-color_primaries',
  color_transfer: '-color_trc',
  chroma_location: '-chroma_sample_location',
} as const;

type Metadata = Record<string, unknown>;
interface Rational {readonly numerator: bigint; readonly denominator: bigint}
interface VideoIndex {
  readonly stream: Metadata;
  readonly timeBase: Rational;
  readonly stamps: readonly bigint[];
  readonly end: bigint;
  readonly framesPerSecond: number | null;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: string;
  readonly rotation: number;
}
type VideoProbeOptions = Pick<SpeedExportVideoOptions, 'signal' | 'beforeEffect'> & {readonly maxPixels?: number};

export interface SpeedExportVideoStage {
  readonly file: string;
  /** Arguments consumed before this input's -i. Frame ranges are ordinal. */
  readonly inputArgs: readonly string[];
  readonly stream: 'v:0';
  readonly frameCount: number;
  /** Source interpretation reclaimed when the rawvideo demuxer owns no metadata. */
  readonly filterPrefix: string;
  readonly bytes: number;
  readonly path: 'cfr' | 'lookup' | 'freeze';
}
export interface SpeedExportReverseVideo {
  readonly file: string;
  /** The lowest original presentation ordinal included in this reverse proxy. */
  readonly firstSourceOrdinal: number;
  readonly frameCount: number;
  readonly storage: 'matroska' | 'raw';
}
export interface SpeedExportVideoOptions {
  readonly source: {readonly path: string; readonly videoStreamIndex?: number | string | null};
  readonly reverse?: SpeedExportReverseVideo;
  readonly timing: ClipTiming;
  readonly plan: CompiledTimeMap;
  readonly file: string;
  readonly scriptFile: string;
  readonly reserve: (file: string) => void;
  readonly writeOwnedFile: (file: string, bytes: string) => Promise<void>;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  readonly beforeEffect?: MediaEffectFence;
  readonly beforeStart?: MediaEffectFence;
}

function mappingError(): never {
  throw new AppError(SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_MAPPING_INVALID], 409);
}
function reverseCoverageError(): never {
  throw new AppError(SPEED_MAPPING_INVALID, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_MAPPING_INVALID], 409,
    {reason:'REVERSE_PROXY_COVERAGE'});
}
function sourceError(): never {
  throw new AppError(SPEED_SOURCE_UNSUPPORTED, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_SOURCE_UNSUPPORTED], 409);
}
function budgetError(): never {
  throw new AppError(SPEED_BUDGET_EXCEEDED, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_BUDGET_EXCEEDED], 409);
}
function unwrap<T>(result: TimeMapResult<T>): T {
  if (!result.ok) mappingError();
  return result.value;
}
function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
function asRational(value: unknown): Rational | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}\/[1-9]\d{0,9}$/u.test(value)) return null;
  const [num, den] = value.split('/');
  return {numerator: BigInt(num!), denominator: BigInt(den!)};
}
function sourceBoundary(value: TimeMapSourceBoundary): Rational {
  return value.kind === 'rational' ? {numerator: BigInt(value.numerator), denominator: BigInt(value.denominator)}
    : {numerator: BigInt(value.ticks), denominator: 1n << 64n};
}

function streamSelector(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === 'v:0') return 'v:0';
  const text = String(value);
  return /^(?:0|[1-9]\d{0,2})$/u.test(text) ? text : sourceError();
}

/** Capture the physical frame's clock, not the container's average frame rate.
 * A bounded complete index also lets us reject video geometry/raster changes
 * instead of letting FFmpeg renegotiate to some other pixel format. */
async function probeVideo(file: string, selector: string, {signal, beforeEffect, maxPixels}: VideoProbeOptions): Promise<VideoIndex> {
  let stdout: string;
  try {
    const chunks: Buffer[] = [];
    await withProbePermit(signal, () => runStreaming('ffprobe', ['-v','error','-protocol_whitelist','file,pipe',
      ...(maxPixels === undefined ? [] : ['-threads','1','-max_pixels',String(maxPixels)]),
      '-format_whitelist','mov,matroska','-select_streams',selector,'-show_streams','-show_frames',
      '-show_entries',[
        'stream=index,pix_fmt,width,height,time_base,start_pts,duration_ts,r_frame_rate,sample_aspect_ratio,' + Object.keys(colourFlags).join(','),
        'stream_side_data=rotation,displaymatrix',
        'frame=best_effort_timestamp,duration,pix_fmt,width,height,sample_aspect_ratio,' + Object.keys(colourFlags).join(','),
      ].join(':'),
      '-of','json',file], {signal,beforeEffect,maxStdoutBytes:16*1024**2,onStdout:chunk=>{chunks.push(chunk);}}));
    stdout = Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (isMediaToolFailure(error) && (error as {code?: string}).code === 'MEDIA_OUTPUT_LIMIT') budgetError();
    throw error;
  }
  const result = JSON.parse(stdout) as {streams?: Metadata[]; frames?: Metadata[]};
  const stream = result.streams?.[0];
  const frames = result.frames;
  if (result.streams?.length !== 1 || !stream || !frames?.length) sourceError();
  if (frames.length > maxIndexFrames) budgetError();
  const width = safeInteger(stream.width), height = safeInteger(stream.height);
  const pixelFormat = stream.pix_fmt;
  const timeBase = asRational(stream.time_base);
  const first = safeInteger(frames[0]!.best_effort_timestamp);
  if (!width || width < 0 || !height || height < 0 || width * height > 64 * 1024 ** 2 || first === null ||
      typeof pixelFormat !== 'string' || !/^[a-z0-9_]{1,32}$/u.test(pixelFormat) || !timeBase) sourceError();
  const stamps = frames.map((frame, index) => {
    const pts = safeInteger(frame.best_effort_timestamp);
    if (pts === null || !Number.isSafeInteger(pts - first) || frame.width !== width || frame.height !== height ||
        frame.pix_fmt !== pixelFormat || index > 0 && pts <= Number(frames[index-1]!.best_effort_timestamp)) sourceError();
    return BigInt(pts - first);
  });
  const last = stamps.at(-1)!;
  const packetDuration = safeInteger(frames.at(-1)?.duration);
  const streamDuration = safeInteger(stream.duration_ts);
  const streamStart = safeInteger(stream.start_pts);
  const durationEnd = streamDuration !== null && streamStart !== null && streamStart === first ? BigInt(streamDuration) : null;
  const physicalEnd = packetDuration !== null && packetDuration > 0 ? last + BigInt(packetDuration) : durationEnd;
  // Earlier timestamps still allow lookup even when the container gives no EOF
  // duration. A sample strictly beyond the final PTS needs an explicit end.
  const end = physicalEnd !== null && physicalEnd > last ? physicalEnd : last;
  const nominal = asRational(stream.r_frame_rate);
  const nominalRate = nominal && nominal.numerator % nominal.denominator === 0n
    ? Number(nominal.numerator / nominal.denominator) : null;
  const step = stamps[1];
  const exactStep = step !== undefined && nominalRate && step * timeBase.numerator * BigInt(nominalRate) === timeBase.denominator;
  const framesPerSecond = exactStep && stamps.every((value, index) => value === step * BigInt(index)) && end === last + step
    ? nominalRate : null;
  const side = Array.isArray(stream.side_data_list) ? (stream.side_data_list as Metadata[]).find(entry => entry.rotation !== undefined) : undefined;
  const interpretation = {...stream};
  for (const field of [...Object.keys(colourFlags),'sample_aspect_ratio']) {
    // The compact proxy carries one interpretation for the selected source.
    // Do not overwrite contradictory frame-level colour or aspect labels.
    const known = field==='sample_aspect_ratio' ? knownAspect : knownColourLabel;
    const label = known(stream[field]) ? stream[field] : undefined;
    const frameLabel = frames.find(frame=>known(frame[field]))?.[field];
    const expected = label ?? frameLabel;
    if (expected!==undefined) {
      if (frames.some(frame=>known(frame[field]) && frame[field]!==expected)) sourceError();
      interpretation[field] = expected;
    }
  }
  return {stream:interpretation,timeBase,stamps,end,framesPerSecond,width,height,pixelFormat,rotation:displayRotation(side)};
}

/** Carry a pure rotation to the ordinary compositor's existing autorotation.
 * Do not quantize input pixels in the speed-only intermediate. */
function displayRotation(side: Metadata | undefined): number {
  if (!side) return 0;
  const rotation = safeInteger(side.rotation);
  if (rotation === null || Math.abs(rotation) > 360 || rotation % 90 !== 0 || typeof side.displaymatrix !== 'string') sourceError();
  const matrix = side.displaymatrix.trim().split('\n').flatMap(row => row.replace(/^.*?:/u, '').trim().split(/\s+/u).map(Number));
  if (matrix.length !== 9 || matrix.some(value => !Number.isSafeInteger(value))) sourceError();
  const scale = 65536;
  const degrees = ((rotation % 360) + 360) % 360;
  const expected = degrees === 0 ? [scale, 0, 0, scale] : degrees === 90 ? [0, -scale, scale, 0]
    : degrees === 180 ? [-scale, 0, 0, -scale] : [0, scale, -scale, 0];
  if ([matrix[0],matrix[1],matrix[3],matrix[4]].some((value,index)=>value!==expected[index]) ||
      matrix[2]!==0 || matrix[5]!==0 || matrix[6]!==0 || matrix[7]!==0 || matrix[8]!==1073741824) sourceError();
  return rotation;
}

/** Compare the shared source clock against exact native ticks. A curve
 * interval crossing a genuine VFR boundary is ambiguous and fails closed.
 * Exact ties on the project grid use the shared chosen project frame. */
function nativeOrdinal(index: VideoIndex, {source, frame}: {source: ContinuousSourcePosition; frame: number}, reverse: boolean): number {
  const {stamps, timeBase, end} = index;
  const test = (stamp: bigint): boolean => {
    const clock = stamp * timeBase.numerator * BigInt(fps);
    if (source.kind === 'exact') {
      const distance = clock * BigInt(source.denominator) - BigInt(source.numerator) * timeBase.denominator;
      return reverse ? distance < 0n : distance <= 0n;
    }
    if (clock % timeBase.denominator === 0n) return clock / timeBase.denominator <= BigInt(frame);
    const time = Number(clock) / Number(timeBase.denominator);
    const roundoff = 4 * Number.EPSILON * Math.max(1, Math.abs(time));
    if (source.value - source.errorBound >= time + roundoff) return true;
    if (source.value + source.errorBound < time - roundoff) return false;
    return sourceError();
  };
  // At the first presentation boundary the shared reverse map clamps to the
  // first frame. Other exact ties follow its backward half-open interval.
  if ((!reverse && !test(0n)) || test(end) && (end > stamps.at(-1)! || source.kind === 'numeric' ||
    BigInt(source.numerator) * timeBase.denominator !== end * BigInt(source.denominator) * timeBase.numerator * BigInt(fps))) sourceError();
  let low = 0, high = stamps.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (test(stamps[middle]!)) low = middle;
    else high = middle - 1;
  }
  return low;
}

function videoFrameTable(index: VideoIndex, plan: CompiledTimeMap): Int32Array {
  const projectFrames = unwrap(timeMapPlanFrames(plan));
  const window = unwrap(timeMapSourceWindowForOutput(plan));
  const reverse = plan.direction === 'reverse';
  const first = projectFrames[reverse ? projectFrames.length-1 : 0]!;
  const last = projectFrames[reverse ? 0 : projectFrames.length-1]!;
  if (first < window.startFrame || last >= window.endFrame) mappingError();
  if (index.framesPerSecond === fps) {
    if (last >= index.stamps.length) sourceError();
    return projectFrames;
  }
  return projectFrames.map((frame, offset) => {
    const result = unwrap(timeMapTailInverse(plan, {numerator:String(plan.outputWindow.fromFrame + offset), denominator:'1'}, {tailInverse:'latest'}));
    // A freeze's persisted sourceFrame is an exact source-clock position.
    // Curve numeric uncertainty is retained through the actual PTS comparison.
    return nativeOrdinal(index, {source: result.position, frame}, reverse);
  });
}

/** A picture consumer uses the same physical presentation ordinals as export,
 * including VFR uncertainty and the direction rule at exact time boundaries. */
export async function readTimelineVideoSamples(source: SpeedExportVideoOptions['source'], plan: CompiledTimeMap,
  options: VideoProbeOptions) {
  if (plan.root.sourceFps.fpsNumerator !== fps || plan.root.sourceFps.fpsDenominator !== 1 ||
      plan.root.outputFps.fpsNumerator !== fps || plan.root.outputFps.fpsDenominator !== 1) mappingError();
  const stream = streamSelector(source.videoStreamIndex);
  const index = await probeVideo(source.path, stream, options);
  return {stream, index, ordinals: videoFrameTable(index, plan)};
}

function reverseOrdinals(index: VideoIndex, table: Int32Array, reverse: SpeedExportReverseVideo): Int32Array {
  const {firstSourceOrdinal,frameCount} = reverse;
  if (!Number.isSafeInteger(firstSourceOrdinal) || firstSourceOrdinal < 0 || !Number.isSafeInteger(frameCount) ||
      frameCount < 1 || firstSourceOrdinal + frameCount > index.stamps.length) reverseCoverageError();
  const end = firstSourceOrdinal + frameCount;
  return table.map(sourceOrdinal => {
    if (sourceOrdinal < firstSourceOrdinal || sourceOrdinal >= end) reverseCoverageError();
    return end - 1 - sourceOrdinal;
  });
}

interface FastPath {readonly start: number; readonly end: number; readonly nativeFps: number; readonly p: number; readonly q: number}
function alignedSourceFrame(value: TimeMapSourceBoundary, nativeFps: number): number | null {
  const boundary = sourceBoundary(value);
  const denominator = boundary.denominator * BigInt(fps);
  const numerator = boundary.numerator * BigInt(nativeFps);
  if (numerator < 0n || numerator % denominator !== 0n || numerator / denominator > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(numerator / denominator);
}

/** Prove the actual native grid, endpoint alignment and exact filter arithmetic,
 * then cross-check the resulting ordinal equation against every shared sample. */
function proveFastPath(index: VideoIndex, plan: CompiledTimeMap, timing: ClipTiming, table: Int32Array): FastPath | null {
  const nativeFps = index.framesPerSecond;
  if (!nativeFps || timing.profile!=='timeline-speed-v1' || timing.basis.speed.kind!=='constant' || plan.root.interpolation!=='constant') return null;
  const range = unwrap(timeMapSourceRangeForEdit(plan));
  const start = alignedSourceFrame(range.start,nativeFps), end = alignedSourceFrame(range.end,nativeFps);
  const {numerator:p, denominator:q} = timing.basis.speed.rate;
  if (start===null || end===null || end<=start || end>index.stamps.length || nativeFps*p>2147483647 ||
      BigInt(end-start+1)*BigInt(p)*BigInt(q)>BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const divisor = BigInt(fps*q), stride = BigInt(nativeFps*p);
  const natural = (BigInt(end-start)*divisor + stride - 1n) / stride;
  if (natural !== BigInt(plan.durationFrames)) return null;
  for (let output=0; output<table.length; output++) {
    const sample = Math.min(end-1,start+Number(BigInt(output)*stride/divisor));
    if (sample !== table[output]) return null;
  }
  return {start,end,nativeFps,p,q};
}

function fastFilter(path: FastPath): string {
  const {start,end,nativeFps,p,q} = path;
  return `trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=1,settb=expr=1/(${nativeFps}*${p}),setpts=PTS*${q}/${p},fps=${fps}:round=up:start_time=0`;
}

interface SelectionRun {readonly source: number; readonly output: number}
function ordinalRuns(table: Int32Array): SelectionRun[] {
  const start = table[0]!;
  const selected = [{source: 0, output: 0}];
  for (let output=1; output<table.length; output++) {
    const source = table[output]!;
    const previous = table[output-1]!;
    if (source < previous) mappingError();
    if (source !== previous) selected.push({source:source-start,output});
  }
  // Let fps see an explicit half-open endpoint even when the last source
  // frame is repeated. The sentinel is clipped away and cannot reach export.
  selected.push({source:table.at(-1)!-start+1,output:table.length});
  return selected;
}

function tree<T>(values: readonly T[], variable: string, key: (value: T,index: number) => number,
  leaf: (value: T,index: number) => string, start = 0, end = values.length): string {
  if (end - start === 1) return leaf(values[start]!, start);
  const mid = Math.floor((start + end) / 2);
  return `if(lt(${variable},${key(values[mid]!,mid)}),${tree(values,variable,key,leaf,start,mid)},${tree(values,variable,key,leaf,mid,end)})`;
}

function lookupFilter(table: Int32Array): string {
  const first = table[0]!, last = table.at(-1)!;
  const runs = ordinalRuns(table);
  const ranges: Array<{start: number; end: number}> = [];
  for (const run of runs) {
    const range = ranges.at(-1);
    if (range?.end === run.source-1) range.end = run.source;
    else ranges.push({start:run.source,end:run.source});
  }
  const select = ranges.length===1 ? '' :
    `select='${tree(ranges,'n',range=>range.start,range=>`between(n,${range.start},${range.end})`)}',`;
  const timestamps = tree(runs,'N',(_run,index)=>index,run=>String(run.output));
  return `trim=start_frame=${first}:end_frame=${last+1},tpad=stop_mode=clone:stop=1,${select}settb=1/${fps},setpts='${timestamps}',fps=${fps}:round=up:start_time=0`;
}

function floatFrameBytes(index: VideoIndex): number | null {
  const format = index.pixelFormat;
  if (!format.includes('f32')) return null;
  const channels = /^(gbrpf32|rgbf32)/u.test(format) ? 3 : /^(gbrapf32|rgbaf32)/u.test(format) ? 4 : /^grayf32/u.test(format) ? 1 : null;
  if (!channels) sourceError();
  return index.width * index.height * channels * 4;
}

function rawVideoInput(index: VideoIndex): string[] {
  return ['-f','rawvideo','-pixel_format',index.pixelFormat,'-video_size',`${index.width}x${index.height}`,'-framerate',String(fps)];
}

function knownColourLabel(value: unknown): value is string {
  return typeof value==='string' && !['unknown','unspecified','N/A'].includes(value) && /^[a-z0-9_-]+$/ui.test(value);
}

function colourParameters(stream: Metadata): string[] {
  return Object.entries(colourFlags).flatMap(([field, option]) => {
    const value = stream[field];
    if (!knownColourLabel(value)) return [];
    // FFprobe reports the name `gbr`; the FFmpeg codec option uses `rgb`.
    return [option,field==='color_space'&&value==='gbr'?'rgb':value];
  });
}

function knownAspect(value: unknown): value is string {
  return typeof value==='string' && /^[1-9]\d*:[1-9]\d*$/u.test(value);
}

function rawFilterPrefix(stream: Metadata): string {
  const aspect = knownAspect(stream.sample_aspect_ratio) ? stream.sample_aspect_ratio.replace(':','/') : '1';
  const fields = {color_range:'range',color_space:'colorspace',color_transfer:'color_trc',
    color_primaries:'color_primaries',chroma_location:'chroma_location'} as const;
  const labels = Object.entries(fields).flatMap(([field,name])=>{
    const label = stream[field];
    return knownColourLabel(label) ? [`${name}=${label}`] : [];
  });
  const sar = `setsar=${aspect}`;
  return labels.length ? `${sar},setparams=${labels.join(':')}` : sar;
}

function verifyIndexedProxy(source: VideoIndex, proxy: VideoIndex, frames: number): void {
  if (proxy.stamps.length!==frames || proxy.width!==source.width || proxy.height!==source.height ||
      proxy.pixelFormat!==source.pixelFormat || proxy.rotation!==0 ||
      Object.keys(colourFlags).some(field=>knownColourLabel(source.stream[field]) &&
        source.stream[field]!==proxy.stream[field]) ||
      (knownAspect(source.stream.sample_aspect_ratio) && source.stream.sample_aspect_ratio!==proxy.stream.sample_aspect_ratio))
    sourceError();
  const {numerator,denominator} = proxy.timeBase;
  // Matroska rounds PTS to milliseconds. The consumer instead recreates the
  // exact 30fps clock from this verified, strictly increasing ordinal list.
  if (proxy.stamps.some((value,index)=>{
    const distance = value*numerator*BigInt(fps)-BigInt(index)*denominator;
    return 2n*(distance<0n?-distance:distance)>BigInt(fps)*numerator;
  })) mappingError();
}

function losslessVideoArgs(format: string): string[] {
  return ['-c:v','ffv1','-level','3','-slicecrc','1',
    ...(format==='gbrap16le'||format==='gbrap16be' ? ['-threads:v','4','-slices','4'] : ['-threads:v','1']),
    '-pix_fmt','+'+format,'-fps_mode','passthrough','-f','matroska'];
}

/** Execute the actual time filters and lossless codec before enabling a speed
 * export. Capability discovery never depends on the installed filter names. */
export async function assertSpeedExportVideoCapability({signal,beforeEffect}: Pick<SpeedExportVideoOptions,'signal'|'beforeEffect'> = {}): Promise<void> {
  try {
    await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-filter_threads','1',
      '-f','lavfi','-i','color=s=16x16:r=30:d=0.2','-vf',
      "trim=start_frame=1:end_frame=3,tpad=stop_mode=clone:stop=1,select='gte(n,0)',settb=1/30,setpts=N*2,fps=30:round=up,trim=end_frame=3",
      '-c:v','ffv1','-level','3','-threads:v','1','-pix_fmt','+yuv420p','-f','matroska','pipe:1'],{signal,beforeEffect,timeout:15000});
  } catch (error) {
    if (!isMediaToolFailure(error)) throw error;
    throw new AppError(SPEED_CAPABILITY_UNAVAILABLE, TIMELINE_SPEED_EXPORT_MESSAGES[SPEED_CAPABILITY_UNAVAILABLE], 409);
  }
}

export async function prepareSpeedExportVideo(options: SpeedExportVideoOptions): Promise<SpeedExportVideoStage> {
  const {source,reverse,timing,plan,file,scriptFile,reserve,writeOwnedFile,signal,beforeEffect,beforeStart,maxBytes=defaultProxyBytes} = options;
  if ((plan.direction==='reverse')!==Boolean(reverse)) mappingError();
  if (!Number.isSafeInteger(maxBytes) || maxBytes<1) budgetError();
  checkMediaEffect(beforeEffect,signal);
  const {stream: selector, index, ordinals} = await readTimelineVideoSamples(source,plan,{signal,beforeEffect});
  let table = ordinals;
  const frameBytes = floatFrameBytes(index);
  let media = source.path, mediaSelector = selector;
  let mediaArgs = ['-format_whitelist','mov,matroska','-noautorotate'];
  if (reverse) {
    table = reverseOrdinals(index,table,reverse);
    media = reverse.file;
    mediaSelector = 'v:0';
    if (media===source.path || reverse.storage!==(frameBytes===null?'matroska':'raw')) reverseCoverageError();
    if (frameBytes===null) {
      const proxy = await probeVideo(media,mediaSelector,{signal,beforeEffect});
      if (proxy.stamps.length!==reverse.frameCount) reverseCoverageError();
      verifyIndexedProxy(index,proxy,reverse.frameCount);
      mediaArgs = ['-format_whitelist','matroska','-noautorotate'];
    } else {
      const bytes = frameBytes*reverse.frameCount;
      const info = await lstat(media);
      checkMediaEffect(beforeEffect,signal);
      if (!Number.isSafeInteger(bytes) || !info.isFile() || info.size!==bytes) reverseCoverageError();
      mediaArgs = [...rawVideoInput(index),'-noautorotate'];
    }
  } else if (index.rotation!==0) mediaArgs.push(`-display_rotation:${selector}`,'0');
  const fast = reverse ? null : proveFastPath(index,plan,timing,table);
  const filter = fast ? fastFilter(fast) : lookupFilter(table);
  const script = `[0:${mediaSelector}]${filter},trim=end_frame=${plan.durationFrames},settb=1/${fps},setpts=N[out]`;
  if (Buffer.byteLength(script)>maxScriptBytes) budgetError();
  const rawBytes = frameBytes===null ? null : frameBytes*plan.durationFrames;
  if (frameBytes!==null && (frameBytes>maxRawFrameBytes || !Number.isSafeInteger(rawBytes) || rawBytes!>maxBytes)) budgetError();
  await writeOwnedFile(scriptFile,script);
  checkMediaEffect(beforeEffect,signal);
  reserve(file);
  checkMediaEffect(beforeStart,signal);
  const encoding = frameBytes===null ? losslessVideoArgs(index.pixelFormat)
    : ['-c:v','rawvideo','-threads:v','1','-pix_fmt','+'+index.pixelFormat,'-fps_mode','passthrough','-f','rawvideo'];
  await run('ffmpeg',['-nostdin','-hide_banner','-v','error','-xerror','-y','-filter_complex_threads','1','-threads','1',
    '-protocol_whitelist','file,pipe',...mediaArgs,'-i',media,
    '-/filter_complex',scriptFile,'-map','[out]','-map_metadata','-1','-an','-sn','-dn',...colourParameters(index.stream),
    ...encoding,'-fs',String(maxBytes),file],
    {signal,beforeEffect,timeout:Math.max(120000,plan.durationFrames*300)});
  checkMediaEffect(beforeEffect,signal);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size===0) sourceError();
  if (stat.size>=maxBytes && stat.size!==rawBytes) budgetError();
  if (rawBytes===null) verifyIndexedProxy(index,await probeVideo(file,'v:0',{signal,beforeEffect}),plan.durationFrames);
  else if (stat.size!==rawBytes) mappingError();
  checkMediaEffect(beforeEffect,signal);
  const inputArgs = frameBytes===null ? [] : rawVideoInput(index);
  if (index.rotation!==0) inputArgs.push('-display_rotation:v:0',String(index.rotation));
  return {file,inputArgs,stream:'v:0',frameCount:plan.durationFrames,filterPrefix:rawBytes===null?'':rawFilterPrefix(index.stream),
    bytes:stat.size,path:timing.profile==='timeline-freeze-v1'?'freeze':fast?'cfr':'lookup'};
}
