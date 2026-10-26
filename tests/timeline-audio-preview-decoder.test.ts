import type {TestContext} from 'node:test';
import type {Failure, Mutable} from './helpers/strict-timeline-audio-types.ts';
import type {TimelineAudioPreviewDecoderRuntime as Runtime, TimelineAudioPreviewRunOptions as RunOptions, TimelineAudioPreviewDecodeRequest as DecodeRequest, TimelineAudioPreviewDecodeOptions as DecodeOptions} from '../packages/business/src/timeline-audio-preview-decoder.ts';
type MediaEvent = Parameters<Parameters<typeof onMediaProcess>[0]>[0];
interface ProbeMetadata {streams: {index?: number; codec_type: string; codec_name: string; width?: number; height?: number; sample_rate?: string; channels?: number; channel_layout?: string; duration?: string}[]; format: {format_name: string; duration: string; size?: string}}
interface RunCall {command: string; args: string[]; options: RunOptions}
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createTimelineAudioPreviewDecoder, parseTimelineAudioPreviewProbe, TIMELINE_AUDIO_PREVIEW_DECODE_LIMITS} from '../packages/business/src/timeline-audio-preview-decoder.ts';
import {run, runStreaming, checkMediaEffect} from '../packages/business/src/media-runtime.ts';
import {withProbePermit, parseProbeOutput, MEDIA_PROBE_LIMITS} from '../packages/business/src/media-probe.ts';
import {onMediaProcess} from '../packages/business/src/media-processes.ts';

const pcm = (frames: number, sample: (frame: number, channel: number) => number = (_frame, channel) => channel ? -1.25 : 0.5) => {
  const data = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) data.writeFloatLE(sample(frame, channel), frame * 8 + channel * 4);
  return data;
};
const metadata = (change: Record<string, unknown> = {}): ProbeMetadata => ({streams: [{index: 0, codec_type: 'video', codec_name: 'h264', width: 16, height: 16},
  {index: 3, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', duration: '1.000000', ...change}],
format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '1.000000', size: '12000'}});
const request = (overrides: Partial<Omit<Mutable<DecodeRequest>, 'segments'>> & {segments?: unknown} = {}): DecodeRequest => {
  const value = {sourceInFrame: 0, frameCount: 1, ...overrides};
  return {...value, segments: Object.hasOwn(overrides, 'segments') ? overrides.segments :
    [{sourceInFrame: value.sourceInFrame, frameCount: value.frameCount, trimStartFrame: 0, outputFrames: value.frameCount}]} as DecodeRequest;
};
const options = (overrides: Partial<DecodeOptions> = {}): DecodeOptions => ({beforeEffect() {}, remainingMs: () => 120000, ...overrides});
function runtime(overrides: Partial<Runtime> = {}): Runtime & {calls: (string | RunCall)[]; allocations: number[]} {
  const calls: (string | RunCall)[] = [], allocations: number[] = [];
  return {calls, allocations, checkMediaEffect,
    onPcmAllocation(bytes) { allocations.push(bytes); },
    async withProbePermit(signal, work) { calls.push('permit'); return await work(); },
    async run(command, args, opts) { calls.push({command, args, options: opts}); opts.beforeSpawn(); opts.beforeEffect(); return JSON.stringify(metadata()); },
    async runStreaming(command, args, opts) { calls.push({command, args, options: opts}); opts.beforeSpawn(); opts.beforeEffect(); const bytes = pcm(opts.maxStdoutBytes / 8); opts.onStdout(bytes); opts.beforeEffect(); return {stdoutBytes: bytes.length}; },
    ...overrides,
  };
}

test('preview probe chooses the same exact first identified audio index as the renderer', () => {
  const value = metadata({index: 7, channels: 1, channel_layout: 'mono', sample_rate: '44100'});
  value.streams.splice(1, 0, {index: 2, codec_type: 'audio', codec_name: 'unknown'});
  value.streams.push({...metadata().streams[1], index: 9});
  const parsed = parseTimelineAudioPreviewProbe(JSON.stringify(value));
  assert.equal(parsed.streamIndex, parseProbeOutput(JSON.stringify(value)).audioStreamIndex);
  assert.deepEqual(parsed, {streamIndex: 7, codecName: 'aac', sampleRate: 44100, channels: 1, channelLayout: 'mono',
    layoutOrigin: 'declared', durationSeconds: 1, audioDurationSeconds: 1, container: 'mov', sizeBytes: 12000});
  assert.ok(Object.isFrozen(parsed));
  value.streams[2].channels = 6; value.streams[2].channel_layout = '5.1';
  assert.throws(() => parseTimelineAudioPreviewProbe(JSON.stringify(value)), {code: 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT'}, 'Never skip the unsupported selected stream for a later stereo stream');
});

test('preview probe permits only actual supported containers, indexed identified audio, bounded metadata and known layouts', () => {
  for (const change of [{index: undefined}, {index: -1}, {index: 0}, {codec_name: 'unknown'}, {codec_name: ''},
    {sample_rate: 'N/A'}, {sample_rate: '0'}, {sample_rate: '48000.0'}, {channels: 0}, {channels: 6},
    {channel_layout: undefined}, {channel_layout: 'unknown'}, {channel_layout: 'mono'}, {duration: '-1'}])
    assert.throws(() => parseTimelineAudioPreviewProbe(JSON.stringify(metadata(change))), {code: 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT'});
  for (const modify of [(p: ProbeMetadata) => p.format.format_name = 'hls', (p: ProbeMetadata) => p.format.format_name = 'concat', (p: ProbeMetadata) => p.format.size = undefined,
    (p: ProbeMetadata) => p.format.size = '1.1', (p: ProbeMetadata) => p.format.duration = 'N/A', (p: ProbeMetadata) => p.format.duration = '0', (p: ProbeMetadata) => p.streams = Array(257).fill(p.streams[0]),
    (p: ProbeMetadata) => p.streams.push({...p.streams[1]})]) {
    const value = metadata(); modify(value);
    assert.throws(() => parseTimelineAudioPreviewProbe(JSON.stringify(value)), {code: 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT'});
  }
  for (const modify of [(p: ProbeMetadata) => p.format.duration = '600.000001', (p: ProbeMetadata) => p.streams[1].duration = '600.000001', (p: ProbeMetadata) => p.format.size = String(512 * 1024 * 1024 + 1)]) {
    const value = metadata(); modify(value);
    assert.throws(() => parseTimelineAudioPreviewProbe(JSON.stringify(value)), {code: 'AUDIO_PREVIEW_SOURCE_LIMIT'});
  }
  for (const value of ['{}', 'null', 'invalid', 3, ' '.repeat(128 * 1024 + 1)]) assert.throws(() => parseTimelineAudioPreviewProbe(value));
});

test('only PCM WAV may derive mono/stereo from explicit one/two channels when layout is absent', () => {
  for (const channels of [1, 2]) {
    const value = metadata({codec_name: 'pcm_s16le', channels, channel_layout: undefined}); value.format.format_name = 'wav';
    const source = parseTimelineAudioPreviewProbe(JSON.stringify(value));
    assert.equal(source.channelLayout, channels === 1 ? 'mono' : 'stereo'); assert.equal(source.layoutOrigin, 'pcm-wav-channel-count');
    value.streams[1].channel_layout = 'unknown';
    assert.throws(() => parseTimelineAudioPreviewProbe(JSON.stringify(value)), {code: 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT'});
    delete value.streams[1].channel_layout; value.streams[1].codec_name = 'adpcm_ima_wav';
    assert.throws(() => parseTimelineAudioPreviewProbe(JSON.stringify(value)), {code: 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT'});
  }
});

test('preview decoder uses one exact allocation and copies arbitrary chunk boundaries without retaining chunks', async () => {
  for (const size of [1, 3, 7, 15, 65536]) {
    const expected = pcm(1600), r = runtime({async runStreaming(command, args, opts) {
      for (let at = 0; at < expected.length; at += size) {
        const chunk = Buffer.from(expected.subarray(at, at + size)); opts.onStdout(chunk); chunk.fill(0);
      }
      return {stdoutBytes: expected.length};
    }});
    const result = await createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request(), options());
    assert.deepEqual(result.pcm, expected); assert.deepEqual(r.allocations, [12800]);
    assert.equal(result.sampleRate, 48000); assert.equal(result.channels, 2); assert.equal(result.sampleFrames, 1600);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.source));
  }
});

test('preview uses exact bounded source seek, actual demuxer/index, renderer pad/trim, and no caller filters or gain', async () => {
  const r = runtime(); let fences = 0;
  const result = await createTimelineAudioPreviewDecoder(r)('/private/untrusted-extension.wav', request({sourceInFrame: 7, frameCount: 3}), options({beforeEffect() { fences++; }}));
  assert.equal(result.pcm.length, 3 * 1600 * 8); assert.ok(fences >= 11);
  const probe = r.calls.find((c): c is RunCall => (c as RunCall).command === 'ffprobe')!, decode = r.calls.find((c): c is RunCall => (c as RunCall).command === 'ffmpeg')!;
  assert.equal(probe.args[probe.args.indexOf('-protocol_whitelist') + 1], 'file,pipe');
  assert.equal(probe.args[probe.args.indexOf('-format_whitelist') + 1], 'mov,matroska,mp3,wav');
  assert.equal(decode.args[decode.args.indexOf('-format_whitelist') + 1], 'mov');
  assert.equal(decode.args[decode.args.indexOf('-f') + 1], 'mov');
  assert.equal(decode.args[decode.args.indexOf('-ss') + 1], (7 / 30).toFixed(9));
  assert.equal(decode.args[decode.args.indexOf('-t') + 1], (4 / 30).toFixed(9));
  assert.ok(decode.args.indexOf('-ss') < decode.args.indexOf('-i'));
  assert.equal(decode.args[decode.args.indexOf('-map') + 1], '[out]');
  assert.equal(decode.args[decode.args.indexOf('-filter_complex') + 1],
    'anullsrc=r=48000:cl=stereo,atrim=end_sample=4800,asetpts=N/SR/TB[silence];' +
    '[0:3]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=4800,asetpts=N/SR/TB[source];' +
    '[silence][source]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=4800,atrim=start_sample=0:end_sample=4800,asetpts=N/SR/TB[out]');
  assert.ok(decode.args.includes('-xerror')); assert.equal(decode.args[decode.args.indexOf('-reinit_filter') + 1], '0');
  assert.equal(decode.args.at(-1), 'pipe:1'); assert.equal(decode.options.maxStdoutBytes, 38400);
  for (const call of [probe, decode]) {
    assert.equal(call.args[call.args.indexOf('-enable_drefs') + 1], '0'); assert.equal(call.args[call.args.indexOf('-use_absolute_path') + 1], '0');
    assert.equal(call.options.maxStderrBytes, 65536);
  }
});

test('original segment seeks and post-resample trims are sequential, probed once and copied into one final allocation', async () => {
  let active = 0, maximum = 0, parts = 0;
  const r = runtime({async runStreaming(command, args, opts) {
    active++; maximum = Math.max(maximum, active); r.calls.push({command, args, options: opts});
    opts.beforeSpawn(); parts++; const data = pcm(opts.maxStdoutBytes / 8, () => parts === 1 ? 0.125 : -0.375);
    opts.onStdout(data); data.fill(0); await Promise.resolve(); active--; return {stdoutBytes: opts.maxStdoutBytes};
  }});
  const segments = [{sourceInFrame: 0, frameCount: 2, trimStartFrame: 1, outputFrames: 1}, {sourceInFrame: 2, frameCount: 2, trimStartFrame: 0, outputFrames: 1}];
  const result = await createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request({sourceInFrame: 1, frameCount: 2, segments}), options());
  assert.equal(maximum, 1); assert.equal(r.calls.filter((call): call is RunCall => (call as RunCall).command === 'ffprobe').length, 1); assert.deepEqual(r.allocations, [25600]);
  const calls = r.calls.filter((call): call is RunCall => (call as RunCall).command === 'ffmpeg')!; assert.equal(calls.length, 2);
  assert.equal(calls[0].args[calls[0].args.indexOf('-ss') + 1], '0.000000000');
  assert.equal(calls[1].args[calls[1].args.indexOf('-ss') + 1], (2 / 30).toFixed(9));
  assert.match(calls[0].args[calls[0].args.indexOf('-filter_complex') + 1], /atrim=start_sample=1600:end_sample=3200/u);
  assert.match(calls[1].args[calls[1].args.indexOf('-filter_complex') + 1], /atrim=start_sample=0:end_sample=1600/u);
  assert.equal(result.pcm.readFloatLE(0), 0.125); assert.equal(result.pcm.readFloatLE(12800), -0.375);
});

test('segment shape, continuity, disjoint original ranges and aggregate work are fixed internal bounds', async () => {
  const r = runtime(), decode = createTimelineAudioPreviewDecoder(r), segment = {sourceInFrame: 0, frameCount: 1, trimStartFrame: 0, outputFrames: 1};
  for (const segments of [[], undefined, Array.from({length: 201}, (_, sourceInFrame) => ({...segment, sourceInFrame})),
    [{...segment, frameCount: 18001}], [{...segment, outputFrames: 0}], [{...segment, trimStartFrame: 1}], [{...segment, outputFrames: 2}],
    [{...segment, frameCount: 1.5}], [{...segment, path: '/private'}], [segment, segment],
    [{sourceInFrame: 0, frameCount: 2, trimStartFrame: 0, outputFrames: 1}, {...segment, sourceInFrame: 1}],
    [{...segment, sourceInFrame: 1}], [{...segment, sourceInFrame: -1}]]) {
    await assert.rejects(decode('/private/source.mp4', request({segments}), options()), {code: 'MEDIA_INVALID_CONFIGURATION'});
  }
  assert.deepEqual(r.calls, []); assert.deepEqual(r.allocations, []);
});

test('a tiny selected suffix retains the original bounded seek/length without allocating the discarded prefix', async () => {
  const r = runtime({async run() {const value = metadata(); value.format.duration = '600'; return JSON.stringify(value);}});
  const result = await createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request({sourceInFrame: 17998,
    segments: [{sourceInFrame: 0, frameCount: 17999, trimStartFrame: 17998, outputFrames: 1}]}), options());
  assert.equal(result.sampleFrames, 1600); assert.deepEqual(r.allocations, [12800]);
  const call = r.calls.find((call): call is RunCall => (call as RunCall).command === 'ffmpeg')!;
  assert.equal(call.args[call.args.indexOf('-ss') + 1], '0.000000000'); assert.equal(call.args[call.args.indexOf('-t') + 1], (18000 / 30).toFixed(9));
  assert.equal(call.options.maxStdoutBytes, 12800);
});

test('per-segment input lookahead is charged before probe or PCM allocation', async () => {
  const r = runtime(), decode = createTimelineAudioPreviewDecoder(r);
  await assert.rejects(decode('/private/source.mp4', request({sourceInFrame: 17999,
    segments: [{sourceInFrame: 0, frameCount: 18000, trimStartFrame: 17999, outputFrames: 1}]}), options()), {code: 'AUDIO_PREVIEW_BUDGET'});
  await assert.rejects(decode('/private/source.mp4', request({sourceInFrame: 17998, frameCount: 2,
    segments: [{sourceInFrame: 0, frameCount: 17999, trimStartFrame: 17998, outputFrames: 1},
      {sourceInFrame: 17999, frameCount: 1, trimStartFrame: 0, outputFrames: 1}]}), options()), {code: 'AUDIO_PREVIEW_BUDGET'});
  assert.deepEqual(r.calls, []); assert.deepEqual(r.allocations, []);
});

test('revocation between original segments prevents the next process and preserves its exact cause', async () => {
  let count = 0, revoked = false; const denied = Object.assign(Error('Revoked between segments'), {code: 'AUDIO_PREVIEW_STALE'});
  const r = runtime({async runStreaming(_command, _args, opts) {count++; opts.onStdout(pcm(1600)); revoked = true; return {stdoutBytes: 12800};}});
  const segments = [{sourceInFrame: 0, frameCount: 1, trimStartFrame: 0, outputFrames: 1}, {sourceInFrame: 1, frameCount: 1, trimStartFrame: 0, outputFrames: 1}];
  await assert.rejects(createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request({frameCount: 2, segments}), options({beforeEffect() {if (revoked) throw denied;}})), error => error === denied);
  assert.equal(count, 1);
});

test('invalid requests, pre-abort and exhausted budget fail before permit or allocation', async () => {
  const r = runtime(), decode = createTimelineAudioPreviewDecoder(r);
  for (const file of ['', 'relative.mp4', 'https://invalid/media.mp4', 'pipe:0', '/bad\0file'])
    await assert.rejects(decode(file, request(), options()), {code: 'MEDIA_INVALID_CONFIGURATION'});
  for (const req of [null, {}, request({frameCount: 0}), request({frameCount: 601}), request({frameCount: 1.1}), request({sourceInFrame: -1}),
    request({sourceInFrame: 18000}), request({sourceInFrame: Infinity}), {...request(), filter: 'volume=2'}])
    await assert.rejects(decode('/private/source.mp4', req as unknown as DecodeRequest, options()), {code: 'MEDIA_INVALID_CONFIGURATION'});
  await assert.rejects(decode('/private/source.mp4', request(), options({remainingMs: () => 0})), {code: 'AUDIO_PREVIEW_BUDGET'});
  await assert.rejects(decode('/private/source.mp4', request(), options({signal: AbortSignal.abort()})), {code: 'MEDIA_CANCELLED'});
  await assert.rejects(decode('/private/source.mp4', request(), options({async beforeEffect() { throw Error('not a synchronous fence'); }})), {code: 'MEDIA_INVALID_CONFIGURATION'});
  assert.deepEqual(r.calls, []); assert.deepEqual(r.allocations, []);
});

test('unsupported source or out-of-bounds interval never allocates or decodes', async () => {
  for (const [probe, req, code] of [[metadata({channels: 6}), request(), 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT'], [metadata(), request({sourceInFrame: 30}), 'AUDIO_PREVIEW_SOURCE_BOUNDS']] as const) {
    const r = runtime({async run() { return JSON.stringify(probe); }, async runStreaming() { assert.fail('must not decode'); }});
    await assert.rejects(createTimelineAudioPreviewDecoder(r)('/private/source.mp4', req, options()), {code});
    assert.deepEqual(r.allocations, []);
  }
});

test('probe and streaming deadlines consume the same remaining budget; maximum allocation is 7,680,000 bytes', async () => {
  let left = 120000;
  const r = runtime({async run(command, args, opts) { assert.equal(opts.timeout, 10000); left = 3210; const value = metadata(); value.format.duration = '600'; return JSON.stringify(value); }});
  await createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request({sourceInFrame: 17400, frameCount: 600}), options({remainingMs: () => left}));
  assert.deepEqual(r.allocations, [7680000]);
  const decode = r.calls.find((c): c is RunCall => (c as RunCall).command === 'ffmpeg')!; assert.equal(decode.options.timeout, 3210); assert.equal(decode.options.maxStdoutBytes, 7680000);
  assert.equal(TIMELINE_AUDIO_PREVIEW_DECODE_LIMITS.maxFrames, 600);
});

test('dequeue, probe completion, spawn, chunks and process completion are all ownership boundaries', async () => {
  for (const boundary of ['dequeue', 'probe-finish', 'spawn', 'chunk', 'finish']) {
    let revoked = false, spawned = false;
    const denied = Object.assign(Error('Source ownership changed'), {code: 'AUDIO_PREVIEW_STALE'});
    const r = runtime({async withProbePermit(signal, work) { if (boundary === 'dequeue') revoked = true; return await work(); },
      async run(command, args, opts) { opts.beforeSpawn(); if (boundary === 'probe-finish') revoked = true; return JSON.stringify(metadata()); },
      async runStreaming(command, args, opts) {
        if (boundary === 'spawn') revoked = true; opts.beforeSpawn(); spawned = true;
        if (boundary === 'chunk') revoked = true; opts.onStdout(pcm(1600));
        if (boundary === 'finish') revoked = true; return {stdoutBytes: 12800};
      }});
    await assert.rejects(createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request(), options({beforeEffect() { if (revoked) throw denied; }})), error => error === denied);
    assert.equal(spawned, boundary === 'chunk' || boundary === 'finish');
    if (boundary === 'dequeue' || boundary === 'probe-finish') assert.deepEqual(r.allocations, []);
  }
});

test('nonfinite, short, partial, extra, false receipt and decode failure never publish PCM', async () => {
  const cases: [Buffer, {stdoutBytes: number}, string][] = [
    [pcm(1599), {stdoutBytes: 12792}, 'AUDIO_PREVIEW_TRUNCATED_PCM'],
    [pcm(1600).subarray(0, -1), {stdoutBytes: 12799}, 'AUDIO_PREVIEW_INVALID_PCM'],
    [pcm(1601), {stdoutBytes: 12808}, 'MEDIA_OUTPUT_LIMIT'],
    [Buffer.alloc(12801), {stdoutBytes: 12801}, 'MEDIA_OUTPUT_LIMIT'],
    [pcm(1600), {stdoutBytes: 12799}, 'AUDIO_PREVIEW_INVALID_PCM'],
    ...[NaN, Infinity, -Infinity].map(value => [pcm(1600, (frame, channel) => frame === 1599 && channel === 1 ? value : 0), {stdoutBytes: 12800}, 'AUDIO_PREVIEW_INVALID_PCM'] as [Buffer, {stdoutBytes: number}, string]),
  ];
  for (const [bytes, receipt, code] of cases) {
    const r = runtime({async runStreaming(command, args, opts) { opts.onStdout(bytes); return receipt; }});
    await assert.rejects(createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request(), options()), {code});
  }
  const failed = Object.assign(Error('Safe tool failure'), {code: 'MEDIA_EXIT_FAILED'});
  const r = runtime({async runStreaming(command, args, opts) { opts.onStdout(pcm(1600)); throw failed; }});
  await assert.rejects(createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request(), options()), error => error === failed);
});

test('callback failure and cancellation retain exact errors and unconfirmed-child ownership', async () => {
  for (const mode of ['poison', 'fence', 'cancel']) {
    let decoding = false;
    const denied = Object.assign(Error('Revoked'), {code: 'AUDIO_PREVIEW_STALE'});
    const cancelled = Object.assign(Error('Cancelled'), {code: 'MEDIA_CANCELLED', terminationUnconfirmed: true});
    const r = runtime({async runStreaming(command, args, opts) {
      decoding = true;
      if (mode === 'cancel') throw cancelled;
      try { opts.onStdout(pcm(1600, () => NaN)); } catch { throw Object.assign(Error('Safe wrapped callback'), {code: 'MEDIA_STREAM_FAILED', terminationUnconfirmed: true}); }
    }});
    await assert.rejects(createTimelineAudioPreviewDecoder(r)('/private/source.mp4', request(), options({beforeEffect() { if (decoding && mode === 'fence') throw denied; }})), error => {
      assert.equal((error as Failure).terminationUnconfirmed, true);
      assert.equal((error as Failure).code, mode === 'poison' ? 'AUDIO_PREVIEW_INVALID_PCM' : mode === 'fence' ? 'AUDIO_PREVIEW_STALE' : 'MEDIA_CANCELLED');
      if (mode === 'cancel') assert.equal(error, cancelled); if (mode === 'fence') assert.equal(error, denied);
      return true;
    });
  }
});

// These real-media tests are intentionally tiny and serial. Fixture writes are
// test setup only. Production decoding is checked for no files/byte mutation.
const actualRuntime = {run, runStreaming, withProbePermit, checkMediaEffect};
const actualDecode = createTimelineAudioPreviewDecoder(actualRuntime);
const encode = (args: string[]) => run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-threads', '1', '-filter_threads', '1', ...args], {timeout: 30000, maxStdoutBytes: 0, maxStderrBytes: 65536});
async function sandbox(t: TestContext) { const root = await mkdtemp(path.join(tmpdir(), 'mioon-audio-preview-')); t.after(() => rm(root, {recursive: true, force: true})); return root; }
function floatWave(seconds: number, sample: (frame: number, channel: number) => number, rate = 48000, channels = 2) {
  const frames = Math.round(seconds * rate), bytes = Buffer.alloc(44 + frames * channels * 4);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32); bytes.writeUInt16LE(32, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) bytes.writeFloatLE(sample(frame, channel), 44 + (frame * channels + channel) * 4);
  return bytes;
}
const manifest = async (root: string) => Promise.all((await readdir(root)).sort().map(async file => [file, createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')]));
async function rendererReference(file: string, streamIndex: number, sourceInFrame: number, frameCount: number, segments = request({sourceInFrame, frameCount}).segments) {
  const expectedBytes = frameCount * 1600 * 8, bytes = Buffer.alloc(expectedBytes); let seen = 0;
  for (const segment of segments) {
    const originalSamples = segment.frameCount * 1600, partBytes = segment.outputFrames * 1600 * 8, before = seen;
    const trimStart = segment.trimStartFrame * 1600, trimEnd = trimStart + segment.outputFrames * 1600;
    await runStreaming('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-filter_complex_threads', '1',
      '-ss', (segment.sourceInFrame / 30).toFixed(9), '-t', ((segment.frameCount + 1) / 30).toFixed(9), '-i', file,
      '-filter_complex', `anullsrc=r=48000:cl=stereo,atrim=end_sample=${originalSamples},asetpts=N/SR/TB[silence];` +
      `[0:${streamIndex}]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1,apad,atrim=end_sample=${originalSamples},asetpts=N/SR/TB[audio];` +
      `[silence][audio]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=end_sample=${originalSamples},atrim=start_sample=${trimStart}:end_sample=${trimEnd},asetpts=N/SR/TB[out]`,
      '-map', '[out]', '-c:a', 'pcm_f32le', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'],
    {timeout: 30000, maxStdoutBytes: partBytes, maxStderrBytes: 65536, onStdout(chunk) { assert.ok(seen + chunk.length <= bytes.length); chunk.copy(bytes, seen); seen += chunk.length; }});
    assert.equal(seen - before, partBytes);
  }
  assert.equal(seen, expectedBytes); return bytes;
}

test('real canonical 48k WAV keeps exact selected onset/end, stereo headroom and one final allocation', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = path.join(root, 'stereo.wav');
  const source = floatWave(0.5, (frame, channel) => frame === 3200 ? channel ? -1.5 : 1.25 : frame === 9599 ? channel ? 0.8 : -0.6 : 0);
  await writeFile(file, source); const before = await manifest(root), allocations: number[] = [], events: MediaEvent[] = [], off = onMediaProcess(event => events.push(event));
  let result;
  try { result = await createTimelineAudioPreviewDecoder({...actualRuntime, onPcmAllocation: bytes => allocations.push(bytes)})(file, request({sourceInFrame: 2, frameCount: 4}), options()); }
  finally { off(); }
  assert.deepEqual(result.pcm, source.subarray(44 + 3200 * 8, 44 + 9600 * 8));
  assert.deepEqual(allocations, [51200]); assert.equal(result.source.channels, 2); assert.equal(result.source.streamIndex, 0);
  assert.deepEqual(events.map(e => [e.type, e.kind]), [['started', 'ffprobe'], ['exited', 'ffprobe'], ['started', 'ffmpeg'], ['exited', 'ffmpeg']]);
  assert.deepEqual(await manifest(root), before);
  t.diagnostic(JSON.stringify({fixture: 'canonical-stereo', bytes: result.pcm.length, firstLeft: result.pcm.readFloatLE(0), lastRight: result.pcm.readFloatLE(result.pcm.length - 4), layoutOrigin: result.source.layoutOrigin}));
});

test('real PCM WAV layout omission is observed; mono conversion follows FFmpeg 1/sqrt(2)', {timeout: 30000}, async t => {
  const root = await sandbox(t), mono = path.join(root, 'mono.wav'), stereo = path.join(root, 'stereo.wav');
  await writeFile(mono, floatWave(0.1, () => 0.5, 48000, 1));
  await encode(['-i', mono, '-c:a', 'pcm_s16le', '-ac', '2', stereo]);
  for (const [file, channels] of [[mono, 1], [stereo, 2]] as const) {
    const raw = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
    assert.equal(raw.streams[0].channels, channels);
    const result = await actualDecode(file, request({frameCount: 3}), options());
    assert.equal(result.source.channels, channels);
    if (raw.streams[0].channel_layout === undefined) assert.equal(result.source.layoutOrigin, 'pcm-wav-channel-count');
    if (channels === 1) {
      const expected = Math.fround(0.5 * Math.SQRT1_2);
      for (let offset = 0; offset < result.pcm.length; offset += 4) assert.ok(Math.abs(result.pcm.readFloatLE(offset) - expected) < 1e-7);
    }
    t.diagnostic(JSON.stringify({fixture: channels === 1 ? 'mono-wav' : 'stereo-wav', ffprobeLayout: raw.streams[0].channel_layout ?? null, admittedLayout: result.source.channelLayout, left: result.pcm.readFloatLE(0)}));
  }
});

test('real 44.1k AAC seek/resample matches the declared renderer source filter byte-for-byte', {timeout: 30000}, async t => {
  const root = await sandbox(t), wav = path.join(root, '44100.wav'), file = path.join(root, '44100.m4a');
  await writeFile(wav, floatWave(0.6, (frame, channel) => (channel ? 0.4 : 0.2) * Math.sin(2 * Math.PI * 997 * frame / 44100), 44100));
  await encode(['-i', wav, '-c:a', 'aac', '-b:a', '192k', file]);
  for (const sourceInFrame of [0, 1, 7]) {
    const result = await actualDecode(file, request({sourceInFrame, frameCount: 4}), options());
    assert.equal(result.source.sampleRate, 44100); assert.equal(result.pcm.length, 51200);
    const expected = await rendererReference(file, result.source.streamIndex, sourceInFrame, 4);
    assert.deepEqual(result.pcm, expected);
    t.diagnostic(JSON.stringify({fixture: 'aac-44100', sourceInFrame, sampleFrames: result.sampleFrames, rendererMaxAbsError: 0}));
  }
});

test('real 44.1k AAC retains original segment reseeks across selected cuts with one probe and allocation', {timeout: 30000}, async t => {
  const root = await sandbox(t), wav = path.join(root, 'segmented.wav'), file = path.join(root, 'segmented.m4a');
  await writeFile(wav, floatWave(0.6, (frame, channel) => (channel ? -0.27 : 0.35) + 0.06 * Math.sin(2 * Math.PI * 733 * frame / 44100), 44100));
  await encode(['-i', wav, '-c:a', 'aac', '-b:a', '128k', file]);
  const segments = [{sourceInFrame: 7, frameCount: 3, trimStartFrame: 0, outputFrames: 3},
    {sourceInFrame: 10, frameCount: 4, trimStartFrame: 0, outputFrames: 4}, {sourceInFrame: 14, frameCount: 4, trimStartFrame: 0, outputFrames: 3}];
  const allocations: number[] = [], events: MediaEvent[] = [], off = onMediaProcess(event => events.push(event)); let full;
  try {full = await createTimelineAudioPreviewDecoder({...actualRuntime, onPcmAllocation: bytes => allocations.push(bytes)})(file, request({sourceInFrame: 7, frameCount: 10, segments}), options());}
  finally {off();}
  assert.deepEqual(allocations, [128000]); assert.equal(events.filter(event => event.type === 'started' && event.kind === 'ffprobe').length, 1);
  assert.equal(events.filter(event => event.type === 'started' && event.kind === 'ffmpeg').length, 3);
  assert.deepEqual(full.pcm, await rendererReference(file, full.source.streamIndex, 7, 10, segments));
  const selectedSegments = [{...segments[0], trimStartFrame: 2, outputFrames: 1}, segments[1], {...segments[2], outputFrames: 1}];
  const selected = await actualDecode(file, request({sourceInFrame: 9, frameCount: 6, segments: selectedSegments}), options());
  assert.deepEqual(selected.pcm, await rendererReference(file, full.source.streamIndex, 9, 6, selectedSegments));
  assert.deepEqual(selected.pcm, full.pcm.subarray(2 * 1600 * 8, 8 * 1600 * 8));
  const suffixSample = 1600 + 317; assert.deepEqual(selected.pcm.subarray(suffixSample * 8), full.pcm.subarray((2 * 1600 + suffixSample) * 8, 8 * 1600 * 8));
  t.diagnostic(JSON.stringify({fixture: 'AAC-original-segment-selected-cuts', fullSampleFrames: full.sampleFrames, selectedSampleFrames: selected.sampleFrames, exactIdentity: true, decoderAllocations: allocations}));
});

test('real short embedded AAC legitimately pads while exact first audio selection ignores later streams', {timeout: 30000}, async t => {
  const root = await sandbox(t), wav = path.join(root, 'short.wav'), other = path.join(root, 'other.wav'), file = path.join(root, 'embedded.mp4');
  await writeFile(wav, floatWave(0.2, frame => 0.25 * Math.sin(2 * Math.PI * 440 * frame / 48000)));
  await writeFile(other, floatWave(1, () => 0));
  await encode(['-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=30:d=1', '-i', wav, '-i', other, '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-threads', '1', file]);
  for (const sourceInFrame of [0, 3, 12]) {
    const result = await actualDecode(file, request({sourceInFrame, frameCount: 12}), options());
    assert.equal(result.source.streamIndex, 1); assert.ok(result.source.audioDurationSeconds! < result.source.durationSeconds);
    assert.deepEqual(result.pcm, await rendererReference(file, 1, sourceInFrame, 12));
    for (let offset = Math.min(12000, result.sampleFrames) * 8; offset < result.pcm.length; offset += 4) assert.equal(result.pcm.readFloatLE(offset), 0);
    if (sourceInFrame === 12) assert.ok(result.pcm.every(byte => byte === 0));
    t.diagnostic(JSON.stringify({fixture: 'short-embedded-aac', sourceInFrame, streamIndex: result.source.streamIndex, sourceDuration: result.source.durationSeconds, audioDuration: result.source.audioDurationSeconds, outputFrames: result.sampleFrames}));
  }
  const segments = [{sourceInFrame: 0, frameCount: 9, trimStartFrame: 3, outputFrames: 6}, {sourceInFrame: 9, frameCount: 12, trimStartFrame: 0, outputFrames: 6}];
  const selected = await actualDecode(file, request({sourceInFrame: 3, frameCount: 12, segments}), options());
  assert.deepEqual(selected.pcm, await rendererReference(file, 1, 3, 12, segments));
  assert.ok(selected.pcm.subarray(6 * 1600 * 8).every(byte => byte === 0));
});

test('real malformed AAC packets cannot become silence and a real video-only source cannot create audio', {timeout: 30000}, async t => {
  const root = await sandbox(t), wav = path.join(root, 'valid.wav'), valid = path.join(root, 'valid.m4a'), corrupt = path.join(root, 'corrupt.m4a'), silentVideo = path.join(root, 'video-only.mp4');
  await writeFile(wav, floatWave(0.4, (frame, channel) => (channel ? 0.3 : 0.2) * Math.sin(2 * Math.PI * 733 * frame / 48000)));
  await encode(['-i', wav, '-c:a', 'aac', '-b:a', '128k', valid]);
  const packets = JSON.parse(await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=pos,size', '-of', 'json', valid],
    {timeout: 10000, maxStdoutBytes: 128 * 1024, maxStderrBytes: 65536})).packets;
  assert.ok(Array.isArray(packets) && packets.length > 1 && packets.length < 100);
  const encoded = await readFile(valid); let corruptedBytes = 0;
  for (const packet of packets) {
    const start = Number(packet.pos), length = Number(packet.size);
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length > 0 && start + length <= encoded.length);
    encoded.fill(0, start, start + length); corruptedBytes += length;
  }
  assert.ok(corruptedBytes > 0); await writeFile(corrupt, encoded);
  const rawProbe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration,size:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration', '-of', 'json', corrupt],
    {timeout: 10000, maxStdoutBytes: 128 * 1024, maxStderrBytes: 65536});
  const identified = parseTimelineAudioPreviewProbe(rawProbe); assert.equal(identified.codecName, 'aac'); assert.equal(identified.streamIndex, 0);
  let published = false;
  await assert.rejects(actualDecode(corrupt, request({frameCount: 6}), options()).then(() => {published = true;}), error =>
    ['MEDIA_EXIT_FAILED', 'MEDIA_PROCESS_FAILED'].includes((error as Failure).code) && (error as Failure).terminationUnconfirmed !== true);
  assert.equal(published, false, 'Fixed silence input must never hide the actual AAC decode error');
  await encode(['-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=30:d=0.4', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', silentVideo]);
  const allocations: number[] = [];
  await assert.rejects(createTimelineAudioPreviewDecoder({...actualRuntime, onPcmAllocation: bytes => allocations.push(bytes)})(silentVideo, request(), options()), {code: 'AUDIO_PREVIEW_UNSUPPORTED_FORMAT'});
  assert.deepEqual(allocations, []);
  t.diagnostic(JSON.stringify({fixture: 'actual-malformed-AAC-and-no-audio', identifiedCodec: identified.codecName,
    corruptedPackets: packets.length, corruptedBytes, realDecodeRejected: true, noAudioRejectedBeforeAllocation: true}));
});

test('real process truncation, poison, excess, and nonzero exit remain distinct safe failures', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = path.join(root, 'private-source.wav'); await writeFile(file, floatWave(0.1, () => 0));
  for (const [script, code] of [
    ['process.stdout.write(Buffer.alloc(8))', 'AUDIO_PREVIEW_TRUNCATED_PCM'],
    ['process.stdout.write(Buffer.alloc(12801))', 'MEDIA_OUTPUT_LIMIT'],
    ['const b=Buffer.alloc(12800); b.writeFloatLE(NaN,12796); process.stdout.write(b)', 'AUDIO_PREVIEW_INVALID_PCM'],
    ['process.stdout.write(Buffer.alloc(12800)); process.stderr.write("private-source.wav"); process.exitCode=9', 'MEDIA_EXIT_FAILED'],
  ]) {
    const events: MediaEvent[] = [], off = onMediaProcess(event => events.push(event));
    try {
      const decode = createTimelineAudioPreviewDecoder({...actualRuntime, runStreaming(_command, _args, opts) { return runStreaming(process.execPath, ['-e', script], opts); }});
      await assert.rejects(decode(file, request(), options()), error => (error as Failure).code === code && !(error as Failure).message.includes('private-source') && (error as Failure).terminationUnconfirmed !== true);
    } finally { off(); }
    assert.equal(events.filter(e => e.type === 'started').length, 2); assert.equal(events.filter(e => e.type === 'exited').length, 2);
  }
});

test('real queued probe cancellation never spawns; real decode cancellation reaps the exact child', {timeout: 30000}, async t => {
  const root = await sandbox(t), file = path.join(root, 'cancel.wav'); await writeFile(file, floatWave(0.1, () => 0));
  const releases: (() => void)[] = [], blockers = Array.from({length: MEDIA_PROBE_LIMITS.concurrent}, () => withProbePermit(undefined, async () => await new Promise<void>(resolve => releases.push(resolve))));
  while (releases.length < MEDIA_PROBE_LIMITS.concurrent) await new Promise(resolve => setImmediate(resolve));
  let controller = new AbortController(), events: MediaEvent[] = [], off = onMediaProcess(event => events.push(event));
  try {
    const pending = assert.rejects(actualDecode(file, request(), options({signal: controller.signal})), {code: 'MEDIA_CANCELLED'});
    controller.abort(); await pending; assert.deepEqual(events, []);
  } finally { releases.forEach(release => release()); await Promise.all(blockers); off(); }
  controller = new AbortController(); events = [];
  off = onMediaProcess(event => { events.push(event); if (event.type === 'started' && event.kind === 'ffmpeg') controller.abort(); });
  try { await assert.rejects(actualDecode(file, request(), options({signal: controller.signal})), {code: 'MEDIA_CANCELLED'}); }
  finally { off(); }
  assert.deepEqual(events.map(e => e.type), ['started', 'exited', 'started', 'exited']);
  assert.throws(() => process.kill(events.at(-1)!.pid!, 0), {code: 'ESRCH'});
});
