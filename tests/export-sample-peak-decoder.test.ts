import type {ExportSamplePeakDecoderRuntime,ExportSamplePeakDecodeOptions} from '../packages/business/src/export-sample-peak-decoder.ts';
type RunOptions=Parameters<ExportSamplePeakDecoderRuntime['run']>[2];
interface CommandCall {command:string;args:string[];options:RunOptions & {onStdout?:(chunk:Buffer)=>void}}
import type {Failure} from './helpers/strict-timeline-audio-types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportSamplePeakAccumulator, createExportSamplePeakDecoder, parseExportSamplePeakProbe} from '../packages/business/src/export-sample-peak-decoder.ts';

function pcm(frames: number, sample: (frame: number, channel: number) => number) {
  const bytes = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) bytes.writeFloatLE(sample(frame, channel), frame * 8 + channel * 4);
  return bytes;
}
const metadata = (change = {}) => ({streams: [{index: 0, codec_type: 'video', codec_name: 'h264'},
  {index: 3, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', duration: '0.020000', ...change}],
format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '0.020000'}});

test('export peak raw stereo maxima are exact across arbitrary byte boundaries', () => {
  const bytes = pcm(961, (frame: number, channel: unknown) => (channel ? -1 : 1) * (frame === 960 ? channel ? 1.25 : 0.5 : 0.25));
  for (const size of [1, 3, 4, 7, 8, 13, bytes.length]) {
    const reducer = createExportSamplePeakAccumulator(961 / 48000);
    for (let offset = 0; offset < bytes.length; offset += size) reducer.write(bytes.subarray(offset, offset + size));
    const result = reducer.finish();
    assert.deepEqual(result, {sampleRate: 48000, channels: 2, sampleFrames: 961, decodedDurationSeconds: 961 / 48000,
      peakLinear: 1.25, peakDbfs: 20 * Math.log10(1.25), silent: false, overFullScale: true,
      channelPeaks: [{channel: 0, label: 'left', peakLinear: 0.5, peakDbfs: 20 * Math.log10(0.5), silent: false},
        {channel: 1, label: 'right', peakLinear: 1.25, peakDbfs: 20 * Math.log10(1.25), silent: false}]});
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.channelPeaks)); assert.ok(Object.isFrozen(result.channelPeaks[0]));
    assert.throws(() => reducer.finish(), {code: 'SAMPLE_PEAK_INVALID_PCM'});
    assert.throws(() => reducer.write(bytes), {code: 'SAMPLE_PEAK_INVALID_PCM'});
  }
});

test('export peak supports silence, full scale, finite extreme and subnormal without clamping', () => {
  for (const amplitude of [0, -0, 0.5, 1, 1.25, 3.4028234663852886e38, 1.401298464324817e-45]) {
    const reducer = createExportSamplePeakAccumulator(1 / 48000);
    reducer.write(pcm(1, (_: unknown, channel: unknown) => channel ? -amplitude : amplitude));
    const result = reducer.finish(), value = Math.abs(Math.fround(amplitude));
    assert.equal(result.peakLinear, value); assert.equal(result.peakDbfs, value === 0 ? null : 20 * Math.log10(value));
    assert.equal(result.silent, value === 0); assert.equal(result.overFullScale, value > 1);
    assert.equal(JSON.stringify(result).includes('null'), value === 0);
  }
});

test('export peak poison, partial frames, empty input and invalid writes cannot be resumed', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const channel of [0, 1]) {
      const reducer = createExportSamplePeakAccumulator(0.02);
      assert.throws(() => reducer.write(pcm(960, (frame: number, c: number) => frame === 959 && c === channel ? value : 0.25)), {code: 'SAMPLE_PEAK_INVALID_PCM'});
      assert.throws(() => reducer.finish(), {code: 'SAMPLE_PEAK_INVALID_PCM'});
    }
  }
  for (const residual of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const reducer = createExportSamplePeakAccumulator(1 / 48000);
    reducer.write(Buffer.alloc(residual ? 8 + residual : 0));
    assert.throws(() => reducer.finish(), {code: 'SAMPLE_PEAK_INVALID_PCM'});
    assert.throws(() => reducer.write(Buffer.alloc(8)), {code: 'SAMPLE_PEAK_INVALID_PCM'});
  }
  const reducer = createExportSamplePeakAccumulator(1 / 48000);
  assert.throws(() => reducer.write(new Uint8Array(8) as unknown as Buffer), {code: 'SAMPLE_PEAK_INVALID_PCM'});
  assert.throws(() => reducer.write(Buffer.alloc(8)), {code: 'SAMPLE_PEAK_INVALID_PCM'});
});

test('export peak duration tolerance is inclusive but larger truncation fails', () => {
  for (const delta of [-4801, -4800, 4800, 4801]) {
    const reducer = createExportSamplePeakAccumulator(1);
    reducer.write(pcm(48000 + delta, () => 0));
    if (Math.abs(delta) > 4800) assert.throws(() => reducer.finish(), {code: 'SAMPLE_PEAK_DURATION_MISMATCH'});
    else assert.equal(reducer.finish().sampleFrames, 48000 + delta);
  }
});

test('export peak fixed 600 second ceiling rejects even one additional byte', () => {
  const oneSecond = Buffer.alloc(48000 * 8);
  for (const excess of [0, 1, 8]) {
    const reducer = createExportSamplePeakAccumulator(600);
    for (let second = 0; second < 600; second++) reducer.write(oneSecond);
    if (excess) {
      assert.throws(() => reducer.write(Buffer.alloc(excess)), {code: 'MEDIA_OUTPUT_LIMIT'});
      assert.throws(() => reducer.finish(), {code: 'MEDIA_OUTPUT_LIMIT'});
    } else assert.equal(reducer.finish().sampleFrames, 28800000);
  }
});

test('export peak probe requires exactly one indexed AAC48k stereo stream and MP4', () => {
  assert.deepEqual(parseExportSamplePeakProbe(JSON.stringify(metadata()), 0.02), {streamIndex: 3, sampleRate: 48000, channels: 2, durationSeconds: 0.02});
  for (const change of [{index: undefined}, {index: -1}, {index: 0}, {codec_name: 'unknown'}, {codec_name: 'pcm_f32le'},
    {sample_rate: '44100'}, {channels: 1}, {channels: 6}, {channel_layout: undefined}, {channel_layout: '5.1'}, {duration: 'N/A'}]) {
    assert.throws(() => parseExportSamplePeakProbe(JSON.stringify(metadata(change)), 0.02), {code: 'SAMPLE_PEAK_UNSUPPORTED_FORMAT'});
  }
  for (const modify of [(p: ReturnType<typeof metadata>) => p.streams.push({...p.streams[1], index: 4}), (p: ReturnType<typeof metadata>) => p.streams.pop(), (p: { format: { format_name: string; }; }) => p.format.format_name = 'matroska', (p: ReturnType<typeof metadata>) => p.streams = Array(257).fill(p.streams[0])]) {
    const value = metadata(); modify(value);
    assert.throws(() => parseExportSamplePeakProbe(JSON.stringify(value), 0.02), {code: 'SAMPLE_PEAK_UNSUPPORTED_FORMAT'});
  }
  assert.throws(() => parseExportSamplePeakProbe(JSON.stringify(metadata({duration: '1.0'})), 0.02), {code: 'SAMPLE_PEAK_DURATION_MISMATCH'});
  assert.doesNotThrow(() => parseExportSamplePeakProbe(JSON.stringify(metadata({duration: '0.120000'})), 0.02));
  assert.throws(() => parseExportSamplePeakProbe(JSON.stringify(metadata({duration: '0.120001'})), 0.02), {code: 'SAMPLE_PEAK_DURATION_MISMATCH'});
  for (const value of ['invalid', '{}', 'null', 42]) assert.throws(() => parseExportSamplePeakProbe(value, 0.02), {code: 'SAMPLE_PEAK_UNSUPPORTED_FORMAT'});
});

function runtime(overrides:Partial<ExportSamplePeakDecoderRuntime> = {}) {
  const calls:(string|CommandCall)[]=[];
  return {calls,
    checkMediaEffect(fn: () => unknown, signal?: AbortSignal) { if (signal?.aborted) throw Object.assign(Error('Cancelled'), {code: 'MEDIA_CANCELLED'}); const value = fn?.() as {then?:unknown;catch:(fn:()=>void)=>unknown}|undefined; if (value?.then) { value.catch(() => {}); throw Object.assign(Error('Bad callback'), {code: 'MEDIA_INVALID_CONFIGURATION'}); } },
    async withProbePermit<T>(signal: AbortSignal|undefined, work: () => Promise<T>) { calls.push('permit'); return await work(); },
    async run(command:string,args:string[],options:RunOptions) { calls.push({command, args, options}); options.beforeSpawn(); options.beforeEffect(); return JSON.stringify(metadata()); },
    async runStreaming(command:string,args:string[],options:Parameters<ExportSamplePeakDecoderRuntime["runStreaming"]>[2]) { calls.push({command, args, options}); options.beforeSpawn(); options.beforeEffect(); options.onStdout(pcm(960, (_: unknown, channel: unknown) => channel ? -0.75 : 0.5)); return {stdoutBytes: 7680}; },
    ...overrides};
}
const options = (overrides:Partial<ExportSamplePeakDecodeOptions> = {}) => ({beforeEffect() {}, remainingMs: () => 1000, ...overrides});

test('export peak wrapper restricts protocols/demuxer, selects actual stream and never truncates/transforms', async () => {
  const r = runtime(), decode = createExportSamplePeakDecoder(r); let fences = 0;
  const result = await decode('/private/managed.mp4', 0.02, options({beforeEffect() { fences++; }}));
  assert.equal(result.peakLinear, 0.75); assert.ok(fences >= 8);
  const probe = r.calls.find((value):value is CommandCall => (value as CommandCall).command === 'ffprobe'), ffmpeg = r.calls.find((value):value is CommandCall => (value as CommandCall).command === 'ffmpeg');
  assert.equal(probe!.options.timeout, 1000); assert.equal(ffmpeg!.options.timeout, 1000);
  for (const call of [probe, ffmpeg]) {
    assert.equal(call!.args[call!.args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.equal(call!.args[call!.args.indexOf('-format_whitelist') + 1], 'mov');
    assert.equal(call!.args[call!.args.indexOf('-enable_drefs') + 1], '0');
  }
  assert.equal(ffmpeg!.args[ffmpeg!.args.indexOf('-map') + 1], '0:3');
  assert.equal(ffmpeg!.args[ffmpeg!.args.indexOf('-reinit_filter') + 1], '0');
  assert.ok(ffmpeg!.args.includes('-xerror'));
  for (const forbidden of ['-t', '-ss', '-frames:a', '-ac', '-ar', '-af', '-filter_complex', '-y']) assert.ok(!ffmpeg!.args.includes(forbidden), forbidden);
  assert.equal(ffmpeg!.args.at(-1), 'pipe:1'); assert.equal(ffmpeg!.options.maxStdoutBytes, 230400000);
});

test('export peak rejects invalid input and expired or aborted work before permit/spawn', async () => {
  const r = runtime(), decode = createExportSamplePeakDecoder(r);
  for (const file of ['', 'https://example.invalid/audio.mp4', 'pipe:0', 'concat:a|b', 'relative.mp4', '/bad\0file']) await assert.rejects(decode(file, 0.02, options()), {code: 'MEDIA_INVALID_CONFIGURATION'});
  for (const duration of [0, -1, NaN, Infinity, 600.01]) await assert.rejects(decode('/private/managed.mp4', duration, options()));
  await assert.rejects(decode('/private/managed.mp4', 0.02, options({remainingMs: () => 0})), {code: 'SAMPLE_PEAK_BUDGET'});
  await assert.rejects(decode('/private/managed.mp4', 0.02, options({signal: AbortSignal.abort()})), {code: 'MEDIA_CANCELLED'});
  assert.deepEqual((r.calls as unknown), []);
});

test('export peak probe has a 10 second subdeadline within the one remaining operation budget', async () => {
  for (const remainingMs of [120000, 5000]) {
    const r = runtime();
    await createExportSamplePeakDecoder(r)('/private/managed.mp4', 0.02, options({remainingMs: () => remainingMs}));
    const probe = r.calls.find((value):value is CommandCall => (value as CommandCall).command === 'ffprobe'), decode = r.calls.find((value):value is CommandCall => (value as CommandCall).command === 'ffmpeg');
    assert.equal(probe!.options.timeout, Math.min(10000, remainingMs)); assert.equal(decode!.options.timeout, remainingMs);
    assert.equal(probe!.options.maxStdoutBytes, 128 * 1024); assert.equal(probe!.options.maxStderrBytes, 64 * 1024);
    assert.equal(decode!.options.maxStderrBytes, 64 * 1024);
  }
});

test('export peak after-queue ownership fence prevents probe and no failed probe starts decoder', async () => {
  let revoked = false;
  const denied = Object.assign(Error('Owned scope changed'), {code: 'SAMPLE_PEAK_SCOPE'});
  const r = runtime({async withProbePermit<T>(signal: AbortSignal|undefined, work: () => Promise<T>) { revoked = true; return await work(); }});
  await assert.rejects(createExportSamplePeakDecoder(r)('/private/managed.mp4', 0.02, options({beforeEffect() { if (revoked) throw denied; }})), error => error === denied);
  assert.deepEqual((r.calls as unknown), []);
  let decoded = false;
  const unsupported = runtime({async run() { return JSON.stringify(metadata({channels: 1})); }, async runStreaming() { decoded = true; }});
  await assert.rejects(createExportSamplePeakDecoder(unsupported)('/private/managed.mp4', 0.02, options()), {code: 'SAMPLE_PEAK_UNSUPPORTED_FORMAT'});
  assert.equal(decoded, false);
});

test('export peak callback failure preserves original fence or PCM poison plus unconfirmed termination', async () => {
  for (const fenceFailure of [false, true]) {
    let inDecode = false;
    const denied = Object.assign(Error('Owned scope changed'), {code: 'SAMPLE_PEAK_SCOPE'});
    const r = runtime({async runStreaming(command:string,args:string[],options:Parameters<ExportSamplePeakDecoderRuntime["runStreaming"]>[2]) {
      inDecode = true;
      try { options.onStdout(pcm(960, () => NaN)); } catch { throw Object.assign(Error('Wrapped'), {code: 'MEDIA_STREAM_FAILED', terminationUnconfirmed: true}); }
    }});
    await assert.rejects(createExportSamplePeakDecoder(r)('/private/managed.mp4', 0.02, options({beforeEffect() { if (fenceFailure && inDecode) throw denied; }})), error =>
      (error as Failure).code === (fenceFailure ? denied.code : 'SAMPLE_PEAK_INVALID_PCM') && (error as Failure).terminationUnconfirmed === true);
  }
});

test('export peak rejects accidentally asynchronous fences and inconsistent runner byte receipts', async () => {
  const r = runtime();
  await assert.rejects(createExportSamplePeakDecoder(r)('/private/managed.mp4', 0.02,
    options({async beforeEffect() { throw Error('Async callbacks are not admission tokens'); }})), {code: 'MEDIA_INVALID_CONFIGURATION'});
  assert.deepEqual((r.calls as unknown), []);
  const adapter = runtime({async runStreaming(command:string,args:string[],options:Parameters<ExportSamplePeakDecoderRuntime["runStreaming"]>[2]) {
    options.onStdout(pcm(960, () => 0)); return {stdoutBytes: 7679};
  }});
  await assert.rejects(createExportSamplePeakDecoder(adapter)('/private/managed.mp4', 0.02, options()), {code: 'SAMPLE_PEAK_INVALID_PCM'});
});
