import assert from 'node:assert/strict';
import {mkdtemp, open, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {
  compileFreezeTimeMap, compileTimeMap, initialTimeMap, instantiateSpeedPreset, splitTimeMap, timeMapRootInfo, timeMapSourceRangeForEdit,
  timeMapTailInverse, trimTimeMap,
  type CompiledTimeMap, type TimeMapResult, type TimeMapSpeed,
} from '../packages/contracts/src/timeline-time-map.ts';
import {run} from '../packages/business/src/media-runtime.ts';
import {createSpeedAudioSourceClock} from '../packages/business/src/timeline-speed-export-audio-clock.ts';
import {prepareTimelineSpeedAudio, timelineReverseAudioClock, timelineSpeedAudioMode, type TimelineSpeedAudioSource}
  from '../packages/business/src/timeline-speed-export-audio.ts';

const fps = {fpsNumerator: 30, fpsDenominator: 1};
const samplesPerFrame = 1600;
const bytesPerFrame = samplesPerFrame * 8;
const rootClock = (value: number) => ({kind: 'rational' as const, numerator: String(value), denominator: '1'});
const constant = (numerator: number, denominator = 1) => ({kind: 'constant' as const, rate: {numerator, denominator}});

function unwrap<T>(result: TimeMapResult<T>): T {
  if (!result.ok) throw Error(result.code);
  return result.value;
}

function mapping(speed: TimeMapSpeed, frames: number, pitchShift = false, direction: 'forward' | 'reverse' = 'forward') {
  const basis = {profile: 'timeline-speed-v1' as const, sourceFps: fps, outputFps: fps,
    sourceRange: {start: rootClock(0), end: rootClock(frames)}, speed};
  const plan = initialTimeMap(unwrap(compileTimeMap(basis)), direction);
  const timing: ClipTiming = {profile: 'timeline-speed-v1', basis, outputWindow: plan.outputWindow, pitchShift,
    view: {direction, loTime: {anchor: 'start', offsetOutputFrames: 0}, hiTime: {anchor: 'end', offsetOutputFrames: 0}},
    interpolation: 'off'};
  return {timing, plan};
}

async function fixture(t: test.TestContext, frames: number, sourceExpression: string, reverse = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-speed-export-audio-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const source: TimelineSpeedAudioSource = {file: path.join(directory, 'generated.wav'), streamIndex: 'a:0',
    ...(reverse ? {reversed: {fromSample: 0, toSample: frames * samplesPerFrame}} : {})};
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
    `aevalsrc=${sourceExpression}:s=48000`, '-af', `atrim=end_sample=${frames * samplesPerFrame}${reverse ? ',areverse' : ''}`,
    '-c:a', 'pcm_f32le', source.file]);
  let fileCount = 0;
  async function render(timing: ClipTiming, plan: CompiledTimeMap) {
    const destination = path.join(directory, `track-${fileCount++}.f32le`);
    const result = await prepareTimelineSpeedAudio({timing, plan, source, destination},
      {openOwnedFile: file => open(file, 'wx', 0o600)});
    assert.equal(result?.samples, plan.durationFrames * samplesPerFrame);
    const bytes = await readFile(destination);
    assert.equal(bytes.length, plan.durationFrames * bytesPerFrame);
    return bytes;
  }
  return {render};
}

function assertSilentFrom(pcm: Buffer, firstSample: number): void {
  assert.notEqual(pcm.readFloatLE((firstSample - 1) * 8), 0);
  assert(pcm.subarray(firstSample * 8).every(byte => byte === 0));
}

test('extreme rates force continuous pitch shifting and only pad the remaining output clock', async t => {
  const remote = await fixture(t, 7, '0.25|-0.25');
  for (const [numerator, denominator, motionSamples] of [[1, 10, 112000], [11, 10, 10182], [10, 1, 1120]] as const) {
    const {timing, plan} = mapping(constant(numerator, denominator), 7);
    assert.equal(timelineSpeedAudioMode(timing), 'shift');
    const pcm = await remote.render(timing, plan);
    assert.equal(pcm.readFloatLE(0), 0.25);
    assert.equal(pcm.readFloatLE(4), -0.25);
    assertSilentFrom(pcm, motionSamples);
  }
});

test('changing curve uses the same PCM sample positions after split and trim', async t => {
  const frames = 43;
  const remote = await fixture(t, frames, '0.1+0.03*sin(2*PI*440*t)|0.2+0.04*cos(2*PI*660*t)');
  const motion = unwrap(instantiateSpeedPreset('fastToSlow', 0, frames));
  const {timing, plan} = mapping(motion, frames);
  assert.equal(timelineSpeedAudioMode(timing), 'shift');
  const whole = await remote.render(timing, plan);
  const {left, right} = unwrap(splitTimeMap(plan, 1));
  const independent = await Promise.all([left, right].map(part => remote.render({...timing, outputWindow: part.outputWindow}, part)));
  assert.deepEqual(Buffer.concat(independent), whole);

  const interior = unwrap(trimTimeMap(plan, 5, 12));
  assert.deepEqual(await remote.render({...timing, outputWindow: interior.outputWindow}, interior),
    whole.subarray(5 * bytesPerFrame, 12 * bytesPerFrame));
});

test('curves in the 2x–4x band resample continuously even with pitchShift disabled', async t => {
  const frames = 73;
  const remote = await fixture(t, frames, '0.2*sin(2*PI*440*t)|0.3*sin(2*PI*440*t)');
  for (const [first, last] of [[2, 4], [3, 3]] as const) {
    const curve = {kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'custom',
      points: [{sourceFrame: 0, rate: {numerator: first, denominator: 1}},
        {sourceFrame: frames, rate: {numerator: last, denominator: 1}}]} as const;
    const {timing, plan} = mapping({...curve, points: [...curve.points]}, frames);
    assert.equal(timelineSpeedAudioMode(timing), 'shift');
    const pcm = await remote.render(timing, plan);
    let crossings = 0;
    for (let sample = 1; sample <= 12000; sample++) {
      if (pcm.readFloatLE((sample - 1) * 8) < 0 && pcm.readFloatLE(sample * 8) >= 0) crossings++;
    }
    // A preserved 440 Hz tone has 110 crossings in 250 ms.
    if (first === last) assert.ok(Math.abs(crossings - 330) <= 1);
    else assert.ok(crossings >= 219 && crossings <= 441);
    const {left, right} = unwrap(splitTimeMap(plan, 5));
    const parts = await Promise.all([left, right].map(part => remote.render({...timing, outputWindow: part.outputWindow}, part)));
    assert.deepEqual(Buffer.concat(parts), pcm);
    const interior = unwrap(trimTimeMap(plan, 4, 10));
    assert.deepEqual(await remote.render({...timing, outputWindow: interior.outputWindow}, interior),
      pcm.subarray(4 * bytesPerFrame, 10 * bytesPerFrame));
  }
});

test('certified curve phase stays within one hundredth of a source sample through fast and slow knots', () => {
  const frames = 13;
  const curve = {kind: 'curve', interpolation: 'log-pchip-v1', presetId: 'custom', points: [
    {sourceFrame: 0, rate: {numerator: 1, denominator: 10}},
    {sourceFrame: 3, rate: {numerator: 10, denominator: 1}},
    {sourceFrame: 5, rate: {numerator: 1, denominator: 4}},
    {sourceFrame: frames, rate: {numerator: 3, denominator: 1}},
  ]} as const;
  for (const direction of ['forward', 'reverse'] as const) {
    const {plan} = mapping({...curve, points: [...curve.points]}, frames, true, direction);
    const {rootLength} = timeMapRootInfo(plan.root);
    assert.equal(rootLength.kind, 'numeric');
    const motionSamples = Math.ceil(rootLength.value * samplesPerFrame);
    const position = createSpeedAudioSourceClock(plan, motionSamples, undefined, curve.points);
    const samples = new Set([0, 1, 63, 64, 65, motionSamples - 2, motionSamples - 1]);
    for (let sample = 79; sample < motionSamples; sample += 613) samples.add(sample);
    for (const sample of samples) {
      const expected = unwrap(timeMapTailInverse(plan, {numerator: String(sample), denominator: '1600'},
        {tailInverse: 'latest'})).position;
      assert.equal(expected.kind, 'numeric');
      assert.ok(Math.abs(position(sample) - expected.value * samplesPerFrame) <= 0.01,
        `${direction} phase at ${sample}`);
    }
  }
});

test('long curves keep the inverse phase bound in both ends and interior blocks', () => {
  const frames = 18_000;
  const curve = unwrap(instantiateSpeedPreset('fastToSlow', 0, frames));
  assert.equal(curve.kind, 'curve');
  const {plan} = mapping(curve, frames);
  const {rootLength} = timeMapRootInfo(plan.root);
  assert.equal(rootLength.kind, 'numeric');
  const motionSamples = Math.ceil(rootLength.value * samplesPerFrame);
  const position = createSpeedAudioSourceClock(plan, motionSamples, undefined, curve.points);
  for (const offset of [2744, 2813, Math.floor(motionSamples / 3), Math.floor(motionSamples * 2 / 3), motionSamples - 17]) {
    const expected = unwrap(timeMapTailInverse(plan, {numerator: String(offset), denominator: '1600'},
      {tailInverse: 'latest'})).position;
    assert.equal(expected.kind, 'numeric');
    assert.ok(Math.abs(position(offset) - expected.value * samplesPerFrame) <= 0.01, `phase at ${offset}`);
  }
});

test('allowed constant speeds use one atempo timeline and preserve tone across output windows', async t => {
  const frames = 151;
  const remote = await fixture(t, frames, '0.2*sin(2*PI*440*t)|0.3*sin(2*PI*440*t)');
  for (const speed of [constant(2), constant(5, 2), constant(3), constant(7, 2), constant(4)]) {
    const {timing, plan} = mapping(speed, frames);
    assert.equal(timelineSpeedAudioMode(timing), 'preserve');
    const pcm = await remote.render(timing, plan);
    const {left, right} = unwrap(splitTimeMap(plan, 13));
    const parts = await Promise.all([left, right].map(part => remote.render({...timing, outputWindow: part.outputWindow}, part)));
    assert.deepEqual(Buffer.concat(parts), pcm);
    let crossings = 0;
    for (let sample = 12001; sample < 36001; sample++) {
      if (pcm.readFloatLE((sample - 1) * 8) < 0 && pcm.readFloatLE(sample * 8) >= 0) crossings++;
    }
    assert.ok(Math.abs(crossings - 220) <= 1, `Expected 440 Hz, observed ${crossings * 2} Hz`);
  }
  const {timing} = mapping(constant(4), frames, true);
  assert.equal(timelineSpeedAudioMode(timing), 'shift');
});

test('one-frame atempo views retain audible samples before the ceil tail', async t => {
  const remote = await fixture(t, 1, '0.25|-0.25');
  for (const speed of [constant(5, 2), constant(3), constant(4)]) {
    const {timing, plan} = mapping(speed, 1);
    const pcm = await remote.render(timing, plan);
    const motionSamples = Math.ceil(samplesPerFrame * speed.rate.denominator / speed.rate.numerator);
    assert.ok(Math.abs(pcm.readFloatLE(0) - 0.25) < 1e-6);
    assertSilentFrom(pcm, motionSamples);
  }
});

test('reverse playback consumes the trusted reverse sample clock and keeps the ceil tail silent', async t => {
  const frames = 9;
  const remote = await fixture(t, frames, '0.1+n/48000|0.25', true);
  const {timing, plan} = mapping(constant(10), frames, false, 'reverse');
  const pcm = await remote.render(timing, plan);
  assert.ok(Math.abs(pcm.readFloatLE(0) - (0.1 + (frames * samplesPerFrame - 1) / 48000)) < 1e-6);
  assert.ok(pcm.readFloatLE(100 * 8) < pcm.readFloatLE(0));
  assertSilentFrom(pcm, 1440);
});

test('reverse audio after a fractional split reads only the admitted PCM grid and keeps its motion tail', async t => {
  const frames = 8;
  const remote = await fixture(t, frames, '0.1+n/48000|0.25', true);
  const original = mapping(constant(10, 9), frames);
  const {right} = unwrap(splitTimeMap(original.plan, 1));
  const sourceRange = unwrap(timeMapSourceRangeForEdit(right));
  const {timing: reverseTiming} = mapping(constant(1, 10), frames, true, 'reverse');
  const basis = {...reverseTiming.basis, sourceRange};
  const plan = initialTimeMap(unwrap(compileTimeMap(basis)), 'reverse');
  const timing = {...reverseTiming, basis, outputWindow: plan.outputWindow};
  assert.deepEqual(timelineReverseAudioClock(plan, timing), {fromSample: 1778, toSample: 12800});
  const pcm = await remote.render(timing, plan);
  assert.ok(Math.abs(pcm.readFloatLE(0) - (0.1 + 12799 / 48000)) < 1e-6);
  // The last motion sample is at source 1777.8. Available PCM begins at
  // ceil(1600 * 10 / 9) = 1778, so the cubic taps clamp to that sample.
  assert.ok(Math.abs(pcm.readFloatLE(110222 * 8) - (0.1 + 1778 / 48000)) < 1e-6);
  assertSilentFrom(pcm, 110223);
});

test('raw reverse PCM uses its verified native sample rate and layout', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-speed-export-raw-reverse-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const frames = 9, sampleRate = 44100;
  const {timing, plan} = mapping(constant(2), frames, true, 'reverse');
  const source: TimelineSpeedAudioSource = {file: path.join(directory, 'proxy.f32le'), streamIndex: 'a:0',
    reversed: {fromSample: 0, toSample: frames * samplesPerFrame, raw: {sampleRate, channels: 1, layout: 'mono'}}};
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
    `aevalsrc=0.25+0.25*t:s=${sampleRate}`, '-af', `atrim=end_sample=${frames * sampleRate / 30},areverse`,
    '-c:a', 'pcm_f32le', '-f', 'f32le', source.file]);
  const destination = path.join(directory, 'output.f32le');
  const output = await prepareTimelineSpeedAudio({timing, plan, source, destination},
    {openOwnedFile: file => open(file, 'wx', 0o600)});
  assert.equal(output?.samples, plan.durationFrames * samplesPerFrame);
  const pcm = await readFile(destination);
  assert.ok(Math.abs(pcm.readFloatLE(0) - 0.325 * Math.SQRT1_2) < 0.0001);
  assert.ok(Math.abs(pcm.readFloatLE(4800 * 8) - 0.275 * Math.SQRT1_2) < 0.0001);
  assert.equal(pcm.readFloatLE(0), pcm.readFloatLE(4));
  assertSilentFrom(pcm, frames * samplesPerFrame / 2);

  const never = {openOwnedFile() { throw Error('Invalid proxy must not create PCM'); }};
  const clock = source.reversed!;
  await assert.rejects(prepareTimelineSpeedAudio({timing, plan, source: {...source,
    reversed: {...clock, toSample: clock.toSample - 1}}, destination}, never),
  {code: 'SPEED_MAPPING_INVALID', details: {audioReason: 'REVERSE_PCM_WINDOW'}});
  await assert.rejects(prepareTimelineSpeedAudio({timing, plan, source: {...source,
    reversed: {...clock, raw: {...clock.raw!, layout: 'stereo'}}}, destination}, never),
  {code: 'SPEED_SOURCE_UNSUPPORTED', details: {audioReason: 'SOURCE_CLOCK_UNVERIFIED'}});
});

test('mixed source normalizes both audio leads and audio delays to the selected video clock', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mioon-speed-export-audio-sync-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const {timing, plan} = mapping(constant(11, 10), 30, true);
  async function delayedTrack(delay: 'audio' | 'video') {
    const file = path.join(directory, `${delay}.mkv`);
    const destination = path.join(directory, `${delay}.f32le`);
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(delay === 'video' ? ['-itsoffset', '0.5'] : []), '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=2',
      ...(delay === 'audio' ? ['-itsoffset', '0.5'] : []), '-f', 'lavfi', '-i', 'aevalsrc=0.25*t|-0.25*t:s=48000:d=2',
      '-map', '0:v', '-map', '1:a', '-c:v', 'ffv1', '-c:a', 'pcm_f32le', file]);
    await prepareTimelineSpeedAudio({timing, plan, source: {file, streamIndex: 'a:0', videoStreamIndex: 0}, destination},
      {openOwnedFile: output => open(output, 'wx', 0o600)});
    return {file, pcm: await readFile(destination)};
  }
  const delay = await delayedTrack('audio');
  const lead = await delayedTrack('video');
  assert(delay.pcm.subarray(0, 21816 * 8).every(byte => byte === 0));
  assert.ok(Math.abs(delay.pcm.readFloatLE(24000 * 8) - 0.0125) < 0.0001);
  assert.ok(Math.abs(lead.pcm.readFloatLE(0) - 0.125) < 0.00001);
  assert.ok(Math.abs(lead.pcm.readFloatLE(24000 * 8) - 0.2625) < 0.0001);

  const never = {openOwnedFile() { throw Error('Unverified clock must not create PCM'); }};
  await assert.rejects(prepareTimelineSpeedAudio({timing, plan,
    source: {file: delay.file, streamIndex: 'a:0', videoStreamIndex: 'v:3'},
    destination: path.join(directory, 'unverified.f32le')}, never),
  {code: 'SPEED_SOURCE_UNSUPPORTED', details: {audioReason: 'SOURCE_CLOCK_UNVERIFIED'}});
});

test('freeze supplies no audible input and creates no PCM file', async () => {
  const freeze = {profile: 'timeline-freeze-v1', sourceFrame: 5, sourceVersionId: null, sourceSha256: 'a'.repeat(64)} as const;
  const plan = initialTimeMap(unwrap(compileFreezeTimeMap({sourceFrame: 5, durationFrames: 2, sourceFps: fps, outputFps: fps})));
  const never = {openOwnedFile() { throw Error('Must not create a file'); }};
  const input = {source: {file: 'unread', streamIndex: 0}, destination: 'unwritten'};
  assert.equal(await prepareTimelineSpeedAudio({...input, timing: freeze, plan}, never), null);
});
