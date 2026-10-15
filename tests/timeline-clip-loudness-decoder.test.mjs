import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimelineClipLoudnessDecoder, planTimelineClipLoudnessDecode} from '../packages/business/src/timeline-clip-loudness-decoder.ts';
import {timelineClipAudioFilter} from '../packages/business/src/timeline-audio-filter-graph.ts';
import {checkMediaEffect} from '../packages/business/src/media-runtime.mjs';
const fixture = () => ({clip: {id: 'clip', trackId: 'track', assetId: 'source', startFrame: 91,
  durationFrames: 30, sourceInFrame: 17, gain: .75, fadeInFrames: 3, fadeOutFrames: 5},
  track: {id: 'track', kind: 'audio', orderIndex: 1, muted: false, hidden: false},
  asset: {file: '/private/source.wav', mimeType: 'audio/wav', duration: 10, hasAudio: true}});
const metadata = patch => JSON.stringify({streams: [{index: 3, codec_type: 'audio', codec_name: 'aac', sample_rate: '44100',
  channels: 2, channel_layout: 'stereo', duration: '10', ...patch}], format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10', size: '40000'}});
const noAudio = JSON.stringify({streams: [{index: 0, codec_type: 'video', codec_name: 'h264', width: 16, height: 16, duration: '10'}],
  format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10', size: '40000'}});
function runtime(probe = metadata(), patch = {}) {
  const calls = [];
  return {calls, checkMediaEffect, withProbePermit: async (_signal, work) => work(),
    run: async (command, args, opts) => {opts.beforeSpawn(); calls.push({command, args, opts}); return probe;},
    runStreaming: async (command, args, opts) => {opts.beforeSpawn(); calls.push({command, args, opts});
      const bytes = Buffer.alloc(opts.maxStdoutBytes); opts.onStdout(bytes); return {stdoutBytes: bytes.length};}, ...patch};
}
const options = extra => ({beforeEffect() {}, remainingMs: () => 120000, onPcm() {}, ...extra});
test('independent descriptor has one segment and preserves source trim, gain and clip-local fades under rebase', async () => {
  const signal = fixture(), r = runtime(), before = structuredClone(signal), chunks = [];
  const plan = planTimelineClipLoudnessDecode(signal);
  assert.deepEqual(plan, {sampleFrames: 48000, pcmBytes: 384000, segmentCount: 1, decodeWorkFrames: 31});
  const result = await createTimelineClipLoudnessDecoder(r)(signal, options({onPcm: chunk => chunks.push(chunk)}));
  assert.equal(result.sampleFrames, 48000); assert.deepEqual(signal, before);
  const args = r.calls.find(call => call.command === 'ffmpeg').args;
  assert.equal(args[args.indexOf('-ss') + 1], (17 / 30).toFixed(9));
  assert.equal(args[args.indexOf('-t') + 1], (31 / 30).toFixed(9));
  const filters = args[args.indexOf('-filter_complex') + 1];
  assert.ok(filters.includes(timelineClipAudioFilter(signal.clip, signal.clip.startFrame, 48000, 0, 3)));
  assert.match(filters, /asetpts=N\+0,afade=t=in:ss=0:ns=4800:curve=tri,afade=t=out:ss=40000:ns=8000:curve=tri/);
  assert.match(filters, /amix=inputs=2:duration=first:dropout_transition=0:normalize=0/);
  assert.equal(args.filter(arg => arg === '-i').length, 1); assert.equal(args.at(-1), 'pipe:1');
  assert.equal(chunks.reduce((sum, value) => sum + value.length, 0), 384000);
});
test('timeline placement cannot add leading silence, extra segments, or change selected PCM mapping', async () => {
  const graphs = [];
  for (const startFrame of [0, 7, 91, 1000]) {
    const signal = fixture(); signal.clip.startFrame = startFrame; const r = runtime();
    await createTimelineClipLoudnessDecoder(r)(signal, options()); graphs.push(r.calls.find(call => call.command === 'ffmpeg').args);
  }
  for (const graph of graphs) assert.deepEqual(graph, graphs[0]);
});
test('muted, zero gain and image selections reject without a source probe', async () => {
  for (const [change, code] of [[s => s.track.muted = true, 'MUTED'], [s => s.clip.gain = 0, 'ZERO_GAIN'],
    [s => s.asset.mimeType = 'image/png', 'NO_AUDIO']]) {
    const signal = fixture(), r = runtime(); change(signal);
    await assert.rejects(createTimelineClipLoudnessDecoder(r)(signal, options()), {code: `TIMELINE_CLIP_LOUDNESS_${code}`});
    assert.equal(r.calls.length, 0);
  }
});
test('hidden video embedded sound is measured; actual audio mismatch and genuine no-audio are not silence', async () => {
  const signal = fixture(); signal.track.kind = 'video'; signal.track.hidden = true; signal.asset.mimeType = 'video/mp4';
  const r = runtime(); await createTimelineClipLoudnessDecoder(r)(signal, options()); assert.equal(r.calls.length, 2);
  signal.asset.hasAudio = false; signal.clip.fadeInFrames = 0; signal.clip.fadeOutFrames = 0;
  await assert.rejects(createTimelineClipLoudnessDecoder(runtime())(signal, options()), {code: 'TIMELINE_MIX_LOUDNESS_SOURCE_METADATA_MISMATCH'});
  let samples = 0; const silent = runtime(noAudio);
  await assert.rejects(createTimelineClipLoudnessDecoder(silent)(signal, options({onPcm: () => samples++})), {code: 'TIMELINE_CLIP_LOUDNESS_NO_AUDIO'});
  assert.equal(silent.calls[0].command, 'ffprobe'); assert.equal(samples, 0);
});
test('unknown and multichannel layouts refuse before PCM; supported mono/44.1k retains fixed output', async () => {
  for (const patch of [{channels: 2, channel_layout: 'unknown'}, {channels: 6, channel_layout: '5.1'}]) {
    const r = runtime(metadata(patch)); await assert.rejects(createTimelineClipLoudnessDecoder(r)(fixture(), options()), {code: 'TIMELINE_MIX_LOUDNESS_UNSUPPORTED_FORMAT'});
    assert.equal(r.calls.length, 1);
  }
  const r = runtime(metadata({channels: 1, channel_layout: 'mono'}));
  const result = await createTimelineClipLoudnessDecoder(r)(fixture(), options()); assert.equal(result.channels, 2); assert.equal(result.sampleRate, 48000);
});
test('exact sample count, finite PCM and callback cancellation remain enforced', async () => {
  for (const mode of ['short', 'extra', 'nan', 'abort']) {
    const abort = new AbortController(); const r = runtime(metadata(), {runStreaming: async (_cmd, _args, opts) => {
      opts.beforeSpawn(); const bytes = Buffer.alloc(opts.maxStdoutBytes + (mode === 'extra' ? 8 : mode === 'short' ? -8 : 0));
      if (mode === 'nan') bytes.writeFloatLE(NaN, 0); if (mode === 'abort') abort.abort();
      opts.onStdout(bytes); return {stdoutBytes: bytes.length};
    }});
    await assert.rejects(createTimelineClipLoudnessDecoder(r)(fixture(), options({signal: abort.signal})));
  }
});
test('60 second clip planner stays one pass; longer selections refuse before allocating PCM', () => {
  const signal = fixture(); signal.clip.durationFrames = 1800; signal.clip.sourceInFrame = 0; signal.asset.duration = 600;
  const plan = planTimelineClipLoudnessDecode(signal); assert.equal(plan.pcmBytes, 23040000); assert.equal(plan.decodeWorkFrames, 1801);
  signal.clip.durationFrames++; assert.throws(() => planTimelineClipLoudnessDecode(signal));
});

test('adapter preserves the existing synchronous borrowed-chunk callback contract', async () => {
  await assert.rejects(createTimelineClipLoudnessDecoder(runtime())(fixture(), options({onPcm: async () => {}})), {code: 'MEDIA_INVALID_CONFIGURATION'});
});
