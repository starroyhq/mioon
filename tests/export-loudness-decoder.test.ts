import test from 'node:test';
import assert from 'node:assert/strict';
import {createExportLoudnessDecoder, parseExportLoudnessProbe} from '../packages/business/src/export-loudness-decoder.ts';
import {createExportSamplePeakDecoder} from '../packages/business/src/export-sample-peak-decoder.ts';

function pcm(frames = 24000, sample = (frame, channel) => (channel ? -1 : 1) * 0.1 * Math.sin(2 * Math.PI * 1000 * frame / 48000)) {
  const bytes = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < 2; channel++) bytes.writeFloatLE(sample(frame, channel), frame * 8 + channel * 4);
  return bytes;
}
const metadata = (change = {}) => ({streams: [{index: 0, codec_type: 'video', codec_name: 'h264'},
  {index: 3, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2, channel_layout: 'stereo', duration: '0.500000', ...change}],
  format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '0.500000'}});
const deferred = () => {let resolve; return {promise: new Promise(r => {resolve = r;}), resolve};};
const options = (overrides = {}) => ({beforeEffect() {}, remainingMs: () => 1000, ...overrides});
function runtime(overrides = {}) {
  const calls = [];
  return {calls,
    checkMediaEffect(fn, signal) {if (signal?.aborted) throw Object.assign(Error('Cancelled'), {code: 'MEDIA_CANCELLED'}); const value = fn?.();
      if (value?.then) {value.catch(() => {}); throw Object.assign(Error('Invalid callback'), {code: 'MEDIA_INVALID_CONFIGURATION'});}},
    async withProbePermit(signal, work) {calls.push('permit'); return await work();},
    async run(command, args, options) {calls.push({command, args, options}); options.beforeSpawn(); options.beforeEffect(); return JSON.stringify(metadata());},
    async runStreaming(command, args, options) {calls.push({command, args, options}); options.beforeSpawn(); options.beforeEffect(); const bytes = pcm(); options.onStdout(bytes); return {stdoutBytes: bytes.length};},
    ...overrides};
}

test('loudness reuses exact samplePeak probe/decode argument bytes without transforms or file output', async () => {
  const loud = runtime(), peak = runtime();
  const measurement = await createExportLoudnessDecoder(loud)('/private/managed.mp4', 0.5, options());
  await createExportSamplePeakDecoder(peak)('/private/managed.mp4', 0.5, options());
  assert.equal(measurement.state, 'valid');
  assert.deepEqual(loud.calls.filter(c => typeof c === 'object').map(({command, args}) => ({command, args})),
    peak.calls.filter(c => typeof c === 'object').map(({command, args}) => ({command, args})));
  const inputArgs = ['-protocol_whitelist', 'file', '-format_whitelist', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-f', 'mov', '-i', '/private/managed.mp4'];
  assert.deepEqual(peak.calls.find(c => c.command === 'ffprobe').args, ['-v', 'error', '-show_entries',
    'format=format_name,duration:stream=index,codec_type,codec_name,sample_rate,channels,channel_layout,duration', '-of', 'json', ...inputArgs]);
  assert.deepEqual(peak.calls.find(c => c.command === 'ffmpeg').args, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror',
    '-threads', '1', '-filter_threads', '1', '-reinit_filter', '0', ...inputArgs, '-map', '0:3', '-vn', '-sn', '-dn', '-threads', '1',
    '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']);
  const ffmpeg = loud.calls.find(c => c.command === 'ffmpeg');
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf('-map') + 1], '0:3'); assert.equal(ffmpeg.args.at(-1), 'pipe:1');
  for (const forbidden of ['-t', '-ss', '-frames:a', '-ac', '-ar', '-af', '-filter_complex', '-y', 'loudnorm', 'ebur128']) assert.ok(!ffmpeg.args.includes(forbidden), forbidden);
  assert.equal(ffmpeg.options.maxStdoutBytes, 230400000); assert.equal(ffmpeg.options.maxStderrBytes, 65536);
});

test('strict probe distinguishes no audio from unsupported or malformed MP4', () => {
  assert.equal(parseExportLoudnessProbe(JSON.stringify(metadata()), 0.5).streamIndex, 3);
  const noAudio = metadata(); noAudio.streams.pop();
  assert.throws(() => parseExportLoudnessProbe(JSON.stringify(noAudio), 0.5), {code: 'LOUDNESS_NO_AUDIO'});
  for (const modify of [p => p.streams = [], p => p.streams[0].index = undefined, p => p.streams[0].codec_type = undefined,
    p => p.streams.push({...p.streams[0]}), p => p.format.format_name = 'matroska', p => p.format.duration = 'N/A']) {
    const value = structuredClone(noAudio); modify(value);
    assert.throws(() => parseExportLoudnessProbe(JSON.stringify(value), 0.5), {code: 'LOUDNESS_UNSUPPORTED_FORMAT'});
  }
  noAudio.format.duration = '0.600001';
  assert.throws(() => parseExportLoudnessProbe(JSON.stringify(noAudio), 0.5), {code: 'LOUDNESS_DURATION_MISMATCH'});
  for (const change of [{codec_name: 'pcm_f32le'}, {sample_rate: '44100'}, {channels: 1}, {channels: 6}, {channel_layout: undefined}, {duration: 'N/A'}, {index: 0}])
    assert.throws(() => parseExportLoudnessProbe(JSON.stringify(metadata(change)), 0.5), {code: 'LOUDNESS_UNSUPPORTED_FORMAT'});
  const ambiguous = metadata(); ambiguous.streams.push({...ambiguous.streams[1], index: 4});
  assert.throws(() => parseExportLoudnessProbe(JSON.stringify(ambiguous), 0.5), {code: 'LOUDNESS_UNSUPPORTED_FORMAT'});
});

test('no-audio and unsupported probes never start ffmpeg', async () => {
  for (const noAudio of [true, false]) {
    let spawned = false;
    const r = runtime({async run() {const p = metadata(noAudio ? {} : {channels: 1}); if (noAudio) p.streams.pop(); return JSON.stringify(p);},
      async runStreaming() {spawned = true;}});
    await assert.rejects(createExportLoudnessDecoder(r)('/private/managed.mp4', 0.5, options()), {code: noAudio ? 'LOUDNESS_NO_AUDIO' : 'LOUDNESS_UNSUPPORTED_FORMAT'});
    assert.equal(spawned, false);
  }
});

test('measurement waits for natural EOF and includes the last decoded sample and FIR tail', async () => {
  const entered = deferred(), eof = deferred(); let settled = false;
  const r = runtime({async runStreaming(_command, _args, options) {
    const bytes = pcm(24000, (frame, channel) => frame === 23999 ? channel ? -0.9 : 0.9 : 0);
    options.onStdout(bytes.subarray(0, bytes.length - 3)); entered.resolve(); await eof.promise;
    options.onStdout(bytes.subarray(bytes.length - 3)); return {stdoutBytes: bytes.length};
  }});
  const pending = createExportLoudnessDecoder(r)('/private/managed.mp4', 0.5, options()).then(result => {settled = true; return result;});
  await entered.promise; assert.equal(settled, false); eof.resolve(); const result = await pending;
  assert.equal(result.sampleFrames, 24000); assert.equal(result.samplePeakLinear, Math.fround(0.9)); assert.ok(result.truePeakLinear >= result.samplePeakLinear);
});

test('valid partial PCM cannot become success after a decoder error, cancellation, truncation, or inconsistent receipt', async () => {
  for (const kind of ['failure', 'cancelled', 'partial', 'receipt', 'poison', 'empty']) {
    const r = runtime({async runStreaming(_command, _args, options) {
      const bytes = pcm(kind === 'partial' ? 18000 : kind === 'empty' ? 0 : 24000);
      if (kind === 'poison') bytes.writeFloatLE(NaN, bytes.length - 4);
      options.onStdout(bytes);
      if (kind === 'failure') throw Object.assign(Error('Bad codec'), {code: 'MEDIA_PROCESS_FAILED'});
      if (kind === 'cancelled') throw Object.assign(Error('Cancelled'), {code: 'MEDIA_CANCELLED'});
      return {stdoutBytes: bytes.length + (kind === 'receipt' ? 1 : 0)};
    }});
    await assert.rejects(createExportLoudnessDecoder(r)('/private/managed.mp4', 0.5, options()), {
      code: kind === 'failure' ? 'MEDIA_PROCESS_FAILED' : kind === 'cancelled' ? 'MEDIA_CANCELLED' : kind === 'partial' ? 'LOUDNESS_DURATION_MISMATCH' : 'LOUDNESS_INVALID_PCM'});
  }
});

test('input/deadline rejection precedes permit and child launch', async () => {
  const r = runtime(), decode = createExportLoudnessDecoder(r);
  for (const file of ['', 'https://example.invalid/a.mp4', 'pipe:0', 'concat:a|b', 'relative.mp4', '/bad\0file'])
    await assert.rejects(decode(file, 0.5, options()), {code: 'MEDIA_INVALID_CONFIGURATION'});
  await assert.rejects(decode('/private/a.mp4', 600.01, options()), {code: 'LOUDNESS_DURATION_LIMIT'});
  await assert.rejects(decode('/private/a.mp4', 0.5, options({remainingMs: () => 0})), {code: 'LOUDNESS_BUDGET'});
  await assert.rejects(decode('/private/a.mp4', 0.5, options({signal: AbortSignal.abort()})), {code: 'MEDIA_CANCELLED'});
  assert.deepEqual(r.calls, []);
});

test('probe subdeadline is capped within a decreasing one-operation deadline', async () => {
  let remaining = 120000;
  const r = runtime(); const run = r.run.bind(r);
  r.run = async (...args) => {const result = await run(...args); remaining = 2345; return result;};
  await createExportLoudnessDecoder(r)('/private/a.mp4', 0.5, options({remainingMs: () => remaining}));
  const probe = r.calls.find(c => c.command === 'ffprobe'), decode = r.calls.find(c => c.command === 'ffmpeg');
  assert.equal(probe.options.timeout, 10000); assert.equal(decode.options.timeout, 2345); assert.equal(probe.options.maxStdoutBytes, 131072);
});

test('after-permit fence and callback failures retain exact cause and termination uncertainty', async () => {
  const denied = Object.assign(Error('Owner changed'), {code: 'LOUDNESS_ARTIFACT_CHANGED'}); let revoked = false;
  const r = runtime({async withProbePermit(_signal, work) {revoked = true; return await work();}});
  await assert.rejects(createExportLoudnessDecoder(r)('/private/a.mp4', 0.5, options({beforeEffect() {if (revoked) throw denied;}})), error => error === denied);
  assert.deepEqual(r.calls, []);
  const poisoned = runtime({async runStreaming(_command, _args, options) {
    try {options.onStdout(pcm(1, () => NaN));} catch {throw Object.assign(Error('Wrapped'), {code: 'MEDIA_STREAM_FAILED', terminationUnconfirmed: true});}
  }});
  await assert.rejects(createExportLoudnessDecoder(poisoned)('/private/a.mp4', 0.5, options()), error => error.code === 'LOUDNESS_INVALID_PCM' && error.terminationUnconfirmed === true);
});
