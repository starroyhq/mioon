import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {testEnv} from './helpers/test-env.ts';
import {compileEditorExportSpeed} from '../packages/business/src/editor-export-speed.ts';
import type {EditorExportSpeed} from '../packages/business/src/editor-export-speed.ts';
import {serializeFcpXml, type FcpXmlAsset} from '../packages/business/src/fcp-xml.ts';
import {getFormat5TimelineIssue, type Format5Clip, type Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {CLIP_TRANSFORM_PROFILE} from '../packages/contracts/src/timeline-clip-transform.ts';
import {CLIP_TRANSITION_KINDS, CLIP_TRANSITION_PROFILE, type ClipTransitionKind} from '../packages/contracts/src/timeline-clip-transition.ts';
import {compileClipTimeMap} from '../packages/contracts/src/timeline-clip-timing.ts';
import {compileTimeMap, initialTimeMap, projectTimeMapToCurrentClipFields, timeMapPlanFrames, timeMapPlanInfo,
  timeMapSourceAtOutputFrame, timeMapTailInverse, trimTimeMap, type TimeMapResult, type TimeMapSpeed} from '../packages/contracts/src/timeline-time-map.ts';
import type {ClipTiming} from '../packages/contracts/src/timeline-speed.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import type {TimelineTrackRecord} from '../packages/contracts/src/timeline-replacement.ts';

const id = (n: number): string => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const wide = {x: 0, y: 0, width: 1080, height: 1920};
const mediaRoot = 'file:///Volumes/FCP%20Fixture/';
const stamp = '2026-01-01T00:00:00.000Z';
const main = track(1, 'video', 0);
const video = track(2, 'video', 1);
const hiddenVideo = track(3, 'video', 2, {hidden: true});
const audio = track(4, 'audio', 3);
const mutedAudio = track(5, 'audio', 4, {muted: true});

function track(n: number, kind: TimelineTrackRecord['kind'], orderIndex: number, flags: Partial<TimelineTrackRecord> = {}): TimelineTrackRecord {
  return {id: id(n), kind, orderIndex, name: 'Track ' + n, hidden: false, muted: false, ...flags};
}

function clip(n: number, lane: TimelineTrackRecord, startFrame: number, durationFrames: number, fields: Partial<Format5Clip> = {}): Format5Clip {
  return {
    id: id(n), trackId: lane.id, name: 'Clip ' + n, startFrame, durationFrames, sourceInFrame: 5, rect: wide,
    gain: 1, sourceState: 'ready', assetId: id(201),
    ...(lane === main ? {sequenceSource: {kind: 'media' as const, nodeId: id(500 + n), segmentGroupId: id(700 + n)}} : {anchor: null}),
    ...fields,
  };
}

function transition(kind: ClipTransitionKind, durationFrames = 7) {
  return {profileId: CLIP_TRANSITION_PROFILE, kind, durationFrames};
}

function asset(n: number, fields: Partial<FcpXmlAsset> = {}): FcpXmlAsset {
  return {id: id(n), name: 'Media ' + n, fileUrl: mediaRoot + n + '.mov', hasVideo: true, hasAudio: true,
    width: 1920, height: 1080, durationFrames: 600, audioChannels: 2, audioRate: 48000, ...fields};
}

function fixture() {
  const source = asset(201, {name: '影片 & "<> 📷', fileUrl: mediaRoot + 'A%20%26%20B.mov'});
  const still = asset(202, {fileUrl: mediaRoot + '%E7%85%A7%E7%89%87.png', durationFrames: 0,
    width: 1000, height: 500, isStill: true, hasAudio: false});
  const wav = asset(203, {fileUrl: mediaRoot + 'sound.wav', hasVideo: false, audioChannels: 1, audioRate: 44100});
  const offline = asset(204, {fileUrl: mediaRoot + 'seven-missing.mov'});
  const assets = new Map([source, still, wav, offline, {...source, id: id(205)}, asset(206)].map(item => [item.id, item]));

  const primary = [clip(10, main, 0, 31, {name: 'Main <opening> 📽', sourceInFrame: 19})];
  for (const [index, kind] of CLIP_TRANSITION_KINDS.entries()) {
    primary.push(clip(11 + index, main, 31 * (index + 1), 31, {
      assetId: index === 5 ? offline.id : id(205), transitionIn: transition(kind),
    }));
  }
  primary.push(clip(17, main, 217, 15, {
    name: '生成占位', assetId: null, versionId: null, jobId: null, sourceInFrame: 0, sourceState: 'placeholder',
    sequenceSource: {kind: 'shot', nodeId: id(517), segmentGroupId: id(717), versionMode: 'follow'},
  }));
  primary.push(clip(18, main, 232, 8, {name: 'Unsupported source', assetId: id(299)}));
  const subclips = [
    clip(30, video, 4, 19, {name: 'Picture overlay', assetId: still.id, sourceInFrame: 0, anchor: {clipId: id(10), offsetFrames: 4},
      layout: {profileId: 'mioon-clip-layout-v2', basisPresetId: 'portrait_720'},
      rect: {x: 120, y: 320, width: 480, height: 640},
      transform: {profileId: CLIP_TRANSFORM_PROFILE, rotation: 12.5, crop: {left: 0.1, right: 0.05, top: 0.2, bottom: 0},
        keyframes: [{frame: 2, x: 0, y: 0, scale: 1}, {frame: 13, x: 128, y: 64, scale: 1.25}]},
    }),
    clip(31, hiddenVideo, 9, 32, {name: 'Hidden picture', anchor: {clipId: id(10), offsetFrames: 9}}),
    clip(32, hiddenVideo, 41, 31, {transitionIn: transition('wipeRight', 6), anchor: {clipId: id(11), offsetFrames: 10}}),
    clip(33, video, 222, 7, {
      name: 'Other ungenerated shot', assetId: null, sourceInFrame: 0, sourceState: 'placeholder', shotId: id(501),
      versionId: null, jobId: null, anchor: {clipId: id(17), offsetFrames: 5},
    }),
    clip(40, audio, 16, 35, {name: 'Separated dialog', soundOnly: true, audioRole: 'human', gain: 0.5, sourceInFrame: 13, fadeInFrames: 4, fadeOutFrames: 6,
      volumeEnvelope: {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 0, multiplier: 0}, {frame: 11, multiplier: 1}, {frame: 35, multiplier: 0.5}]},
    }),
    clip(41, audio, 235, 31, {name: 'Audio tail', assetId: wav.id, audioRole: 'music', gain: 2}),
    clip(42, mutedAudio, 5, 21, {name: 'Muted track audio', assetId: wav.id}),
    clip(43, audio, 53, 10, {name: 'Muted clip audio', assetId: wav.id, muted: true, fadeInFrames: 4}),
  ];
  const timeline: Format5Timeline = {
    id: id(101), projectId: id(100), revision: 5, fps: 30, width: 1080, height: 1920,
    createdAt: stamp, updatedAt: stamp, durationFrames: 266,
    tracks: [audio, mutedAudio, hiddenVideo, main, video], mainTrack: {trackId: main.id, sequenceNodeId: id(102)},
    clips: [...subclips, ...primary].reverse(),
    subtitles: {profileId: TIMELINE_SUBTITLE_PROFILE_ID, cues: [
      {id: id(71), text: '字幕 <A> & then\n第二行', startFrame: 22, durationFrames: 12, anchor: {clipId: id(10), offsetFrames: 22}},
      {id: id(72), text: 'Caption over gap', startFrame: 222, durationFrames: 5, anchor: null},
    ]},
  };
  assert.equal(getFormat5TimelineIssue(timeline), null);
  return {timeline, assets, projectName: 'Project "A" & <B> 📽'};
}

test('preserves primary timing, source trims, offline media links and named gaps', () => {
  const input = fixture();
  const xml = serializeFcpXml(input);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1\.13">/u);
  assert.match(xml, /<format id="r1" width="1080" height="1920" frameDuration="1\/30s"/u);
  assert.match(xml, /<sequence format="r1" duration="266\/30s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">/u);
  assert.match(xml, /<project name="Project &quot;A&quot; &amp; &lt;B&gt; 📽">/u);
  assert.match(xml, /name="Main &lt;opening&gt; 📽" offset="0s" start="19\/30s" duration="31\/30s"/u);
  assert.match(xml, /name="Clip 16" offset="186\/30s" start="5\/30s" duration="31\/30s"/u);
  assert.match(xml, /name="影片 &amp; &quot;&lt;&gt; 📷"/u);
  assert.match(xml, /src="file:\/\/\/Volumes\/FCP%20Fixture\/seven-missing\.mov"/u);
  assert.match(xml, /<gap name="生成占位" start="0s" offset="217\/30s" duration="15\/30s">.*?value="未生成镜头：生成占位"/u);
  assert.match(xml, /<gap name="Unsupported source" start="0s" offset="232\/30s" duration="8\/30s">/u);
  assert.match(xml, /<gap name="Gap" start="0s" offset="8s" duration="26\/30s"\/>/u);
  assert.equal(xml.match(/src="file:\/\/\/Volumes\/FCP%20Fixture\/A%20%26%20B\.mov"/gu)?.length, 1);
  assert.doesNotMatch(xml, /206\.mov|299\.mov/u);
  assert.equal(serializeFcpXml(input), xml);
});

test('projects connected track offsets and ITT captions using the primary source time', () => {
  const xml = serializeFcpXml(fixture());
  assert.match(xml, /name="Picture overlay" lane="1" offset="23\/30s" start="0s"/u);
  assert.match(xml, /<spine lane="2" offset="28\/30s"><asset-clip .*?name="Hidden picture" offset="0s"/u);
  assert.match(xml, /<spine lane="2".*?<transition name="Edge Wipe" offset="29\/30s" duration="6\/30s">/u);
  assert.match(xml, /name="Separated dialog" lane="-1" offset="35\/30s" start="13\/30s" duration="35\/30s" srcEnable="audio" audioRole="dialogue"/u);
  assert.match(xml, /name="Audio tail" lane="-1" offset="3\/30s".*? audioRole="music"/u);
  assert.match(xml, /name="Muted track audio" lane="-2" offset="24\/30s"/u);
  assert.match(xml, /<caption lane="3" offset="41\/30s" duration="12\/30s" role="Mioon Subtitles\?captionFormat=ITT\.zh-Hans"><text>字幕 &lt;A&gt; &amp; then\n第二行<\/text>/u);
  assert.match(xml, /<caption lane="3" offset="5\/30s" duration="5\/30s".*?<text>Caption over gap<\/text>/u);
  assert.match(xml, /<spine lane="1" offset="5\/30s"><gap name="Other ungenerated shot" start="0s" offset="0s" duration="7\/30s">/u);
});

test('translates all six transition kinds and keeps the odd frame after the cut', () => {
  const xml = serializeFcpXml(fixture());
  const expected = ['Cross Dissolve', 'Dip to Color', 'Edge Wipe', 'Edge Wipe', 'Push', 'Push'];
  const offsets = ['28/30s', '59/30s', '3s', '121/30s', '152/30s', '183/30s'];
  for (const [index, name] of expected.entries()) {
    assert.ok(xml.includes(`<transition name="${name}" offset="${offsets[index]}" duration="7/30s">`));
  }
  for (const [name, value] of [['Color', '0 0 0 1'], ['Angle', '180'], ['Angle', '0'], ['Direction', '3'], ['Direction', '0']]) {
    assert.ok(xml.includes(`<param name="${name}" value="${value}"/>`));
  }
  assert.equal(xml.match(/<effect id=/gu)?.length, 4);
});

test('maps layout, crop, transform, level, fades, mute, and split sound', () => {
  const xml = serializeFcpXml(fixture());
  assert.match(xml, /name="Picture overlay"[^>]*><adjust-crop mode="crop"><crop-rect left="20" top="20" right="10" bottom="0"/u);
  assert.match(xml, /<adjust-transform position="0 0" scale="0\.666667 0\.666667" rotation="-12\.5">/u);
  assert.match(xml, /<keyframe time="13\/30s" value="10 -5" interp="linear" curve="linear"/u);
  assert.match(xml, /<keyframe time="13\/30s" value="0\.833333 0\.833333"/u);
  assert.match(xml, /name="Hidden picture"[^>]*><adjust-blend amount="0"\/>/u);
  assert.match(xml, /<asset .*?hasVideo="0" hasAudio="1" format="r\d+" audioSources="1" audioChannels="1" audioRate="44100"/u);
  assert.match(xml, /<adjust-volume amount="-96dB"><param name="amount"><fadeIn type="linear" duration="4\/30s"\/><fadeOut type="linear" duration="6\/30s"\/>/u);
  assert.match(xml, /<keyframe time="24\/30s" value="-6\.0206dB"/u);
  assert.match(xml, /name="Audio tail"[^>]*><adjust-volume amount="6\.0206dB"\/>/u);
  for (const name of ['Muted track audio', 'Muted clip audio']) {
    assert.match(xml, new RegExp(`name="${name}"[^>]*><adjust-volume amount="-96dB"/>`));
  }
});

test('supports an audio-only stack and long clips without optional transform or envelope data', () => {
  const input = fixture();
  const plain = clip(60, audio, 2, 18001, {assetId: id(203)});
  input.timeline.clips = [plain];
  input.timeline.durationFrames = 18003;
  input.assets.set(id(203), asset(203, {hasVideo: false, durationFrames: 20_000}));
  delete input.timeline.subtitles;
  assert.equal(getFormat5TimelineIssue(input.timeline), null);
  assert.match(serializeFcpXml(input), /<gap name="Gap" start="0s" offset="0s" duration="18003\/30s"><asset-clip .*?lane="-1" offset="2\/30s"/u);
  input.timeline.clips = [clip(61, main, 0, 18003)];
  input.assets.set(id(201), asset(201, {durationFrames: 20_000}));
  assert.equal(getFormat5TimelineIssue(input.timeline), null);
  assert.match(serializeFcpXml(input), /name="Clip 61" offset="0s" start="5\/30s" duration="18003\/30s"\/>/u);
});

function readMap<T>(result: TimeMapResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

const speedClock = {fpsNumerator: 30, fpsDenominator: 1};
const sourceEdge = (frame: number) => ({kind: 'rational' as const, numerator: String(frame), denominator: '1'});
const constant = (numerator: number, denominator: number): TimeMapSpeed => ({kind: 'constant', rate: {numerator, denominator}});

test('writes the same bytes for an explicitly restored 1x clip without changing its transition or connections', () => {
  const input = fixture();
  const legacy = serializeFcpXml(input);
  const opening = input.timeline.clips.find(value => value.id === id(10))!;
  const basis = {profile: 'timeline-speed-v1' as const, sourceFps: speedClock, outputFps: speedClock,
    sourceRange: {start: sourceEdge(opening.sourceInFrame), end: sourceEdge(opening.sourceInFrame + opening.durationFrames)},
    speed: constant(1, 1)};
  const plan = initialTimeMap(readMap(compileTimeMap(basis)));
  const {loTime, hiTime, outputWindow} = readMap(timeMapPlanInfo(plan));
  opening.sourceSpanFrames = opening.durationFrames;
  opening.timing = {profile: 'timeline-speed-v1', basis, view: {direction: 'forward', loTime, hiTime}, outputWindow,
    pitchShift: false, interpolation: 'off'};
  const asset = input.assets.get(opening.assetId!)!;
  input.assets.set(asset.id, {...asset, sourceFps: 60});
  assert.equal(serializeFcpXml({...input, speed: new Map()}), legacy);
});

function motion(n: number, startFrame: number, speed: TimeMapSpeed, direction: 'forward' | 'reverse',
  pitchShift: boolean, interpolation: Extract<ClipTiming, {profile: 'timeline-speed-v1'}>['interpolation'],
  window?: {from: number; to: number}): Format5Clip {
  const basis = {profile: 'timeline-speed-v1' as const, sourceFps: speedClock, outputFps: speedClock,
    sourceRange: {start: sourceEdge(13), end: sourceEdge(61)}, speed};
  const full = initialTimeMap(readMap(compileTimeMap(basis)), direction);
  const plan = window ? readMap(trimTimeMap(full, window.from, window.to)) : full;
  const {loTime, hiTime, outputWindow} = readMap(timeMapPlanInfo(plan));
  const draft = clip(n, main, startFrame, plan.durationFrames);
  return {...draft, ...readMap(projectTimeMapToCurrentClipFields(draft, plan)),
    timing: {profile: 'timeline-speed-v1', basis, view: {direction, loTime, hiTime}, outputWindow, pitchShift, interpolation}};
}

function timedFixture() {
  const input = fixture();
  const overlayImage = input.assets.get(id(202))!;
  const source = asset(201, {sourceFps: 30, durationFrames: 70});
  const highRate = asset(206, {sourceFps: 60, durationFrames: 70});
  const ntscRate = asset(208, {sourceFps: 30_000, sourceFpsDenominator: 1001, durationFrames: 70});
  const forward = motion(80, 0, constant(3, 2), 'forward', true, 'off', {from: 3, to: 21});
  const reverse = motion(81, 18, constant(3, 1), 'reverse', false, 'off', {from: 1, to: 15});
  reverse.transitionIn = transition('wipeLeft');
  reverse.volumeEnvelope = {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 0, multiplier: 0.2}, {frame: 8, multiplier: 1}]};
  const freeze = clip(82, main, 32, 12, {sourceInFrame: 17, sourceSpanFrames: 1,
    timing: {profile: 'timeline-freeze-v1', sourceFrame: 17, sourceVersionId: null, sourceSha256: 'a'.repeat(64)}});
  const curve = motion(83, 44, {kind: 'curve', presetId: 'custom', interpolation: 'log-pchip-v1',
    points: [{sourceFrame: 13, rate: {numerator: 1, denominator: 2}},
      {sourceFrame: 37, rate: {numerator: 5, denominator: 8}},
      {sourceFrame: 61, rate: {numerator: 3, denominator: 4}}]}, 'forward', false, 'blend');
  const optical = motion(84, end(curve), constant(1, 2), 'forward', true, 'optical', {from: 1, to: 19});
  const native = {...motion(85, end(optical), constant(1, 2), 'reverse', true, 'off', {from: 3, to: 31}), assetId: highRate.id};
  const ntsc = {...motion(87, end(native), constant(1, 2), 'forward', true, 'off', {from: 2, to: 30}), assetId: ntscRate.id};
  const attached = clip(86, video, reverse.startFrame + 5, 6, {sourceInFrame: 0, assetId: overlayImage.id,
    anchor: {clipId: reverse.id, offsetFrames: 5}});
  const timeline = {...input.timeline, durationFrames: end(ntsc), clips: [forward, reverse, freeze, curve, optical, native, ntsc, attached],
    subtitles: {profileId: TIMELINE_SUBTITLE_PROFILE_ID,
      cues: [{id: id(73), text: 'Caption over retimed clip', startFrame: 20, durationFrames: 5, anchor: {clipId: reverse.id, offsetFrames: 2}}]}};
  const assets = new Map([source, highRate, ntscRate, overlayImage].map(value => [value.id, value]));
  const speed = new Map<string, EditorExportSpeed>();
  for (const timedClip of timeline.clips.filter(value => value.timing)) {
    const source = assets.get(timedClip.assetId!)!;
    const fps = source.sourceFps!, fpsDenominator = source.sourceFpsDenominator ?? 1;
    const compiled = compileEditorExportSpeed(timedClip, timeline,
      {fps, fpsDenominator, frameCount: Math.floor(source.durationFrames * fps / (timeline.fps * fpsDenominator))});
    assert.ok(compiled, timedClip.name);
    speed.set(timedClip.id, compiled);
  }
  return {...input, timeline, assets, speed, forward, reverse, freeze, curve, optical, native, ntsc};
}

function end(value: Format5Clip): number {
  return value.startFrame + value.durationFrames;
}

function fraction(time: string): {numerator: bigint; denominator: bigint} {
  const match = /^(\d+)(?:\/(\d+))?s$/u.exec(time);
  assert.ok(match, time);
  return {numerator: BigInt(match[1]!), denominator: BigInt(match[2] ?? 1)};
}

const timePointPrecision = 1_000_000n;

function parseTimeMap(xml: string, clip: Format5Clip) {
  const map = new RegExp(`<asset-clip[^>]* name="${clip.name}"[^>]*><timeMap frameSampling="([^"]+)" preservesPitch="([01])">([^<]*(?:<timept[^>]+/>)+)</timeMap>`, 'u').exec(xml);
  assert.ok(map, clip.name);
  const points = Array.from(map[3]!.matchAll(/<timept time="([^"]+)" value="([^"]+)" interp="linear"\/>/gu), match => {
    const time = fraction(match[1]!);
    const numerator = time.numerator * 30n * timePointPrecision;
    assert.equal(numerator % time.denominator, 0n, 'output timepoints are on the written time grid');
    return {output: numerator / time.denominator, sourceTime: fraction(match[2]!)};
  });
  assert.equal(points[0]?.output, 0n);
  assert.equal(points.at(-1)?.output, BigInt(clip.durationFrames) * timePointPrecision);
  assert.ok(points.every((point, index) => index === 0 || point.output > points[index - 1]!.output));
  return {sampling: map[1], pitch: map[2], points};
}

function interpolateTimeMap({points}: ReturnType<typeof parseTimeMap>, output: number): ReturnType<typeof fraction> {
  const tick = BigInt(Math.round(output * Number(timePointPrecision)));
  const last = points.at(-1)!;
  if (tick === last.output) return last.sourceTime;
  const rightIndex = points.findIndex(point => point.output > tick);
  assert.ok(rightIndex > 0);
  const left = points[rightIndex - 1]!, right = points[rightIndex]!;
  const l = left.sourceTime, r = right.sourceTime;
  return {numerator: (right.output - tick) * l.numerator * r.denominator +
    (tick - left.output) * r.numerator * l.denominator,
    denominator: (right.output - left.output) * l.denominator * r.denominator};
}

test('uses FCPXML retiming to preserve shared constant, trimmed reverse, hold and native CFR frames', () => {
  const input = timedFixture();
  const {timeline, forward, reverse, freeze, native, ntsc, assets} = input;
  const xml = serializeFcpXml(input);
  for (const clip of [forward, reverse, freeze]) {
    const plan = readMap(compileClipTimeMap(clip, timeline));
    const graph = parseTimeMap(xml, clip);
    assert.equal(graph.sampling, 'floor');
    for (const [output, expected] of readMap(timeMapPlanFrames(plan)).entries()) {
      const point = interpolateTimeMap(graph, output);
      assert.equal(Number(point.numerator * 30n / point.denominator), expected, `${clip.name} frame ${output}`);
    }
  }
  assert.equal(parseTimeMap(xml, forward).pitch, '0');
  assert.equal(parseTimeMap(xml, reverse).pitch, '1');
  assert.match(xml, /<asset-clip[^>]+name="Clip 82"[^>]+srcEnable="video"><timeMap/u);
  assert.doesNotMatch(xml, /<transition\b/u, 'transition cannot consume a missing retime handle');

  for (const clip of [native, ntsc]) {
    const asset = assets.get(clip.assetId!)!;
    const fps = BigInt(asset.sourceFps!), fpsDenominator = BigInt(asset.sourceFpsDenominator ?? 1);
    const duration = `${fpsDenominator}/${fps}s`;
    const sourceId = new RegExp(`<format id="(r\\d+)" [^>]*frameDuration="${duration}"`, 'u').exec(xml)?.[1];
    assert.ok(sourceId, duration);
    assert.ok(xml.includes(`name="${asset.name}" start="0s" duration="70/30s" hasVideo="1" hasAudio="1" format="${sourceId}"`));
    const view = readMap(compileClipTimeMap(clip, timeline));
    const nativeMap = parseTimeMap(xml, clip);
    for (let output = 0; output < clip.durationFrames; output++) {
      const {source} = readMap(timeMapSourceAtOutputFrame(view, output));
      assert.equal(source.kind, 'exact');
      const numerator = BigInt(source.numerator) * fps;
      const denominator = BigInt(source.denominator) * 30n * fpsDenominator;
      // The reverse shared resolver treats the source boundary as exclusive.
      const expected = Number((numerator - (view.direction === 'reverse' ? 1n : 0n)) / denominator);
      const point = interpolateTimeMap(nativeMap, output);
      assert.equal(Number(point.numerator * fps / (point.denominator * fpsDenominator)), expected, `${duration} source frame ${output}`);
    }
  }
});

test('maps sampling policy and bounds curve error while anchoring clip-relative edits in output time', () => {
  const input = timedFixture();
  const xml = serializeFcpXml(input);
  const {curve, optical, timeline} = input;
  const graph = parseTimeMap(xml, curve);
  assert.equal(graph.sampling, 'frame-blending');
  assert.equal(graph.pitch, '0', 'Mioon always shifts pitch for a nonconstant curve');
  assert.ok(graph.points.length > 2);
  assert.ok(graph.points.some(point => point.output % timePointPrecision !== 0n));
  const map = readMap(compileClipTimeMap(curve, timeline));
  let observedError = 0;
  for (let tick = 0; tick <= curve.durationFrames * 100; tick++) {
    const {position} = readMap(timeMapTailInverse(map, {
      numerator: String(tick + 100 * map.outputWindow.fromFrame), denominator: '100',
    }, {tailInverse: 'latest'}));
    const ideal = position.kind === 'exact' ? Number(position.numerator) / Number(position.denominator) : position.value;
    const graphPoint = interpolateTimeMap(graph, tick / 100);
    const mapped = 30 * Number(graphPoint.numerator) / Number(graphPoint.denominator);
    observedError = Math.max(observedError, Math.abs(mapped - ideal));
  }
  assert.ok(observedError <= input.speed.get(curve.id)!.maxErrorFrames + 1e-10, `unreported curve error ${observedError}`);
  assert.equal(parseTimeMap(xml, optical).sampling, 'optical-flow');
  assert.match(xml, /<clip name="Clip 81" offset="18\/30s" start="0s" duration="14\/30s">/u);
  assert.match(xml, /<keyframe time="8\/30s" value="0dB"/u);
  assert.match(xml, /name="Clip 86" lane="1" offset="5\/30s" start="0s"/u);
  assert.match(xml, /<caption lane="3" offset="2\/30s" duration="5\/30s"[^>]*><text>Caption over retimed clip/u);
});

test('keeps an unrepresentable clip at its timeline length and uses a gap when the plain source would overrun', () => {
  const input = timedFixture();
  input.speed.delete(input.optical.id);
  const {native, timeline, assets} = input;
  const short = asset(207, {durationFrames: 4});
  input.speed.delete(native.id);
  assets.set(short.id, short);
  timeline.clips = timeline.clips.map(value => value.id === native.id ? {...value, assetId: short.id} : value);
  const xml = serializeFcpXml(input);
  assert.match(xml, /<asset-clip[^>]+name="Clip 84"[^>]+duration="18\/30s"\/>/u);
  assert.match(xml, /<gap name="Clip 85"[^>]+duration="28\/30s">/u);
  assert.doesNotMatch(xml, /207\.mov/u);
});

test('validates the representative sequence against the locally supplied Apple FCPXML 1.13 DTD', {
  skip: process.env.MIOON_FCPXML_DTD ? false : 'Set MIOON_FCPXML_DTD to the local FCPXML 1.13 DTD to run validation',
}, () => {
  const dtd = process.env.MIOON_FCPXML_DTD!;
  for (const input of [fixture(), timedFixture()]) {
    const tool = spawnSync('xmllint', ['--noout', '--nonet', '--dtdvalid', pathToFileURL(dtd).href, '-'], {
      input: serializeFcpXml(input), encoding: 'utf8', env: testEnv(),
    });
    assert.ifError(tool.error);
    assert.equal(tool.status, 0, tool.stderr);
  }
});
