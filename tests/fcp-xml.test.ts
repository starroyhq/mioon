import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {testEnv} from './helpers/test-env.ts';
import {serializeFcpXml, type FcpXmlAsset} from '../packages/business/src/fcp-xml.ts';
import {getFormat5TimelineIssue, type Format5Clip, type Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {CLIP_TRANSFORM_PROFILE} from '../packages/contracts/src/timeline-clip-transform.ts';
import {CLIP_TRANSITION_KINDS, CLIP_TRANSITION_PROFILE, type ClipTransitionKind} from '../packages/contracts/src/timeline-clip-transition.ts';
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

test('validates the representative sequence against the locally supplied Apple FCPXML 1.13 DTD', {
  skip: process.env.MIOON_FCPXML_DTD ? false : 'Set MIOON_FCPXML_DTD to the local FCPXML 1.13 DTD to run validation',
}, () => {
  const dtd = process.env.MIOON_FCPXML_DTD!;
  const tool = spawnSync('xmllint', ['--noout', '--nonet', '--dtdvalid', pathToFileURL(dtd).href, '-'], {
    input: serializeFcpXml(fixture()), encoding: 'utf8', env: testEnv(),
  });
  assert.ifError(tool.error);
  assert.equal(tool.status, 0, tool.stderr);
});
