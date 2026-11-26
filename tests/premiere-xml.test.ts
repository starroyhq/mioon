import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import type {FcpXmlAsset} from '../packages/business/src/fcp-xml.ts';
import {serializePremiereXml} from '../packages/business/src/premiere-xml.ts';
import {getFormat5TimelineIssue, type Format5Clip, type Format5Timeline} from '../packages/contracts/src/project-format5.ts';
import {CLIP_TRANSFORM_PROFILE} from '../packages/contracts/src/timeline-clip-transform.ts';
import {CLIP_TRANSITION_KINDS, CLIP_TRANSITION_PROFILE} from '../packages/contracts/src/timeline-clip-transition.ts';
import {timelineCrossfadeEnvelopes} from '../packages/contracts/src/timeline-crossfade.ts';
import type {TimelineTrackRecord} from '../packages/contracts/src/timeline-replacement.ts';
import {TIMELINE_SUBTITLE_PROFILE_ID} from '../packages/contracts/src/timeline-subtitle-profile.ts';
import {VOLUME_ENVELOPE_PROFILE} from '../packages/contracts/src/timeline-volume-envelope.ts';
import {testEnv} from './helpers/test-env.ts';

const id = (n: number): string => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const date = '2026-01-01T00:00:00.000Z';
const portrait = {x: 0, y: 0, width: 1080, height: 1920};
const mediaRoot = 'file:///Volumes/Premiere%20Fixture/Media/';

function track(orderIndex: number, kind: TimelineTrackRecord['kind'], flags: Partial<TimelineTrackRecord> = {}): TimelineTrackRecord {
  return {id: id(orderIndex + 1), kind, orderIndex, name: 'Track ' + orderIndex, hidden: false, muted: false, ...flags};
}
const main = track(0, 'video'), overlay = track(1, 'video', {hidden: true}), dialogue = track(2, 'audio'),
  music = track(3, 'audio'), muted = track(4, 'audio', {muted: true});
const picture: FcpXmlAsset = {id: id(201), name: '画面 & 声音', fileUrl: mediaRoot + '001_A%20%26%20B.mp4',
  hasVideo: true, hasAudio: true, durationFrames: 720, width: 1920, height: 1080, audioRate: 48000, audioChannels: 2};
const still: FcpXmlAsset = {id: id(202), name: '照片', fileUrl: mediaRoot + '002_%E7%85%A7%E7%89%87.png',
  hasVideo: true, hasAudio: false, durationFrames: 0, width: 1080, height: 1920, isStill: true};
const wav: FcpXmlAsset = {id: id(203), name: '声轨', fileUrl: mediaRoot + '003_sound.wav',
  hasVideo: false, hasAudio: true, durationFrames: 300, audioRate: 44100, audioChannels: 1};
const offline: FcpXmlAsset = {...picture, id: id(204), name: '离线', fileUrl: mediaRoot + 'Offline_fixture.mp4'};

function clip(n: number, lane: TimelineTrackRecord, startFrame: number, durationFrames: number, fields: Partial<Format5Clip> = {}): Format5Clip {
  const role = lane === main ? {sequenceSource: {kind: 'media' as const, nodeId: id(n + 300), segmentGroupId: id(n + 500)}} : {anchor: null};
  return {id: id(n), name: 'Clip ' + n, trackId: lane.id, assetId: picture.id, startFrame, durationFrames, sourceInFrame: 12,
    rect: portrait, gain: 1, sourceState: 'ready', ...role, ...fields};
}

function fixture() {
  const opening = clip(10, main, 0, 30, {name: '片头 <A> & 📽', sourceInFrame: 19, colour: {
    profileId: 'mioon-rec709-sdr-clip-v1',
    source: {assetSha256: 'a'.repeat(64), streamIndex: 0, profileId: 'rec709-yuv-sdr-v1', range: 'limited', declaredBy: 'user', declaredAt: date},
    look: {resourceId: id(702), resourceSha256: 'b'.repeat(64), resourceProfile: 'mioon-cube3d-normalized-tetrahedral-v1',
      purpose: 'rec709-sdr-creative', declaredBy: 'user', enabled: true, strength: .5},
  }});
  const alternate = {...picture, id: id(205)};
  const cuts = CLIP_TRANSITION_KINDS.map((kind, index) => clip(11 + index, main, (index + 1) * 30, 30, {
    transitionIn: {kind, profileId: CLIP_TRANSITION_PROFILE, durationFrames: 7}, assetId: alternate.id,
  }));
  const hole = clip(17, main, 210, 15, {name: '占位镜头', sourceState: 'placeholder', sourceInFrame: 0,
    assetId: null, versionId: null, jobId: null, sequenceSource: {kind: 'shot', nodeId: id(517), segmentGroupId: id(717), versionMode: 'follow'}});
  const dangling = clip(18, main, 225, 15, {assetId: offline.id});
  const unsupported = clip(19, main, 240, 15, {assetId: id(999)});
  const afterGap = clip(20, main, 255, 15);
  const transformed = clip(30, overlay, 5, 22, {assetId: still.id, sourceInFrame: 0, anchor: {clipId: opening.id, offsetFrames: 5},
    layout: {profileId: 'mioon-clip-layout-v2', basisPresetId: 'portrait_720'},
    rect: {x: 240, y: 400, width: 240, height: 480},
    transform: {profileId: CLIP_TRANSFORM_PROFILE, rotation: 12.5, crop: {left: .1, right: 0, top: .2, bottom: 0},
      keyframes: [{frame: 2, x: 0, y: 0, scale: 1}, {frame: 16, x: 48, y: 32, scale: 1.25}]}});
  const separated = clip(40, dialogue, 12, 40, {sourceInFrame: 13, soundOnly: true, gain: .5, fadeInFrames: 4, fadeOutFrames: 6,
    volumeEnvelope: {profileId: VOLUME_ENVELOPE_PROFILE, points: [{frame: 0, multiplier: .5}, {frame: 10, multiplier: 1},
      {frame: 40, multiplier: .5}]}});
  const crossOut = clip(41, dialogue, 60, 30, {assetId: wav.id, sourceInFrame: 0});
  const crossIn = clip(42, music, 80, 30, {assetId: wav.id, sourceInFrame: 0});
  const {outgoing, incoming} = timelineCrossfadeEnvelopes(crossOut, crossIn)!;
  crossOut.volumeEnvelope = outgoing;
  crossIn.volumeEnvelope = incoming;
  const mutedClip = clip(43, music, 120, 20, {assetId: wav.id, muted: true});
  const onMutedTrack = clip(44, muted, 30, 30, {assetId: wav.id});
  const timeline: Format5Timeline = {id: id(101), projectId: id(100), revision: 5, fps: 30, width: 1080, height: 1920,
    createdAt: date, updatedAt: date, durationFrames: 270, mainTrack: {trackId: main.id, sequenceNodeId: id(102)},
    tracks: [music, dialogue, overlay, main, muted],
    clips: [opening, ...cuts, hole, dangling, unsupported, afterGap, transformed, separated, crossOut, crossIn, mutedClip, onMutedTrack].reverse(),
    subtitles: {profileId: TIMELINE_SUBTITLE_PROFILE_ID, cues: [
      {id: id(71), text: '仅保留在清单的字幕', startFrame: 22, durationFrames: 12, anchor: {clipId: opening.id, offsetFrames: 22}},
    ]}};
  assert.equal(getFormat5TimelineIssue(timeline), null);
  return {timeline, projectName: '序列 <portrait> & 🎬',
    assets: new Map([picture, still, wav, offline, alternate].map(asset => [asset.id, asset]))};
}

function clipXml(xml: string, n: number, media: 'video' | 'audio'): string {
  const element = xml.match(new RegExp(`<clipitem id="${media}-${id(n)}">.*?</clipitem>`, 'u'))?.[0];
  assert.ok(element, `Missing ${media} item ${n}`);
  return element;
}

test('writes a custom 1080×1920 30 fps sequence, with absolute track times and source trims', () => {
  const input = fixture();
  const xml = serializePremiereXml(input);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="sequence-1">/u);
  assert.match(xml, /<name>序列 &lt;portrait&gt; &amp; 🎬<\/name><duration>270<\/duration><rate><timebase>30<\/timebase><ntsc>FALSE<\/ntsc><\/rate>/u);
  assert.match(xml, /<video><format><samplecharacteristics>.*?<width>1080<\/width><height>1920<\/height><anamorphic>FALSE<\/anamorphic><pixelaspectratio>square<\/pixelaspectratio><fielddominance>none<\/fielddominance>/u);
  assert.match(clipXml(xml, 30, 'video'), /<start>5<\/start><end>27<\/end><in>0<\/in><out>22<\/out><stillframe>TRUE<\/stillframe>/u);
  assert.match(clipXml(xml, 18, 'video'), /<start>225<\/start><end>240<\/end><in>12<\/in><out>27<\/out>/u);
  assert.match(clipXml(xml, 20, 'video'), /<start>255<\/start><end>270<\/end><in>12<\/in><out>27<\/out>/u);
  assert.doesNotMatch(xml, /占位镜头|仅保留在清单的字幕|<caption|<generatoritem|\.cube|\bLUT\b/u);
  assert.doesNotMatch(xml, new RegExp(id(19), 'u'));
  assert.equal(xml.match(/<pathurl>file:[^<]*001_A%20%26%20B\.mp4<\/pathurl>/gu)?.length, 1);
  assert.match(clipXml(xml, 16, 'video'), /<file id="file-1"\/>/u);
  assert.match(xml, /<pathurl>file:[^<]*Offline_fixture\.mp4<\/pathurl>/u);
  assert.equal(serializePremiereXml(input), xml);
});

test('uses all six transition placements and includes the source handles without shifting unaffected audio', () => {
  const xml = serializePremiereXml(fixture());
  const effects = ['Cross Dissolve', 'Dip to Black', 'Wipe', 'Wipe', 'Push', 'Push'];
  const transitions = [...xml.matchAll(/<transitionitem>.*?<start>(\d+)<\/start><end>(\d+)<\/end><alignment>center<\/alignment><effect><name>([^<]+)<\/name>.*?<\/transitionitem>/gu)];
  assert.deepEqual(transitions.map(([, start, end, name]) => [Number(start), Number(end), name]),
    effects.map((name, index) => [(index + 1) * 30 - 3, (index + 1) * 30 + 4, name]));
  assert.match(clipXml(xml, 10, 'video'), /<start>0<\/start><end>-1<\/end><in>19<\/in><out>53<\/out>/u);
  assert.match(clipXml(xml, 11, 'video'), /<start>-1<\/start><end>-1<\/end><in>9<\/in><out>46<\/out>/u);
  assert.match(clipXml(xml, 16, 'video'), /<start>-1<\/start><end>210<\/end><in>9<\/in><out>42<\/out>/u);
  assert.match(clipXml(xml, 11, 'audio'), /<start>30<\/start><end>60<\/end><in>12<\/in><out>42<\/out>/u);
  assert.match(transitions[2]![0], /<wipecode>1<\/wipecode><reverse>TRUE<\/reverse>/u);
  assert.match(transitions[3]![0], /<wipecode>1<\/wipecode><reverse>FALSE<\/reverse>/u);
  assert.match(transitions[4]![0], /<reverse>TRUE<\/reverse>/u);
  assert.match(transitions[5]![0], /<reverse>FALSE<\/reverse>/u);
});

test('shares copied paths without conflating video and still source definitions', () => {
  const input = fixture();
  const stillAlias = {...still, id: id(205), fileUrl: picture.fileUrl};
  input.assets.set(stillAlias.id, stillAlias);
  const xml = serializePremiereXml(input);
  assert.match(clipXml(xml, 10, 'video'), /<file id="file-1"><name>画面 &amp; 声音<\/name>/u);
  assert.match(clipXml(xml, 11, 'video'), /<stillframe>TRUE<\/stillframe><file id="file-2"><name>照片<\/name>/u);
  assert.match(clipXml(xml, 12, 'video'), /<file id="file-2"\/>/u);
  assert.equal(xml.match(/<pathurl>file:[^<]*001_A%20%26%20B\.mp4<\/pathurl>/gu)?.length, 2);
});

test('encodes motion, crop and hidden layers while keeping linked sound and channel metadata', () => {
  const xml = serializePremiereXml(fixture());
  const transformed = clipXml(xml, 30, 'video');
  assert.match(transformed, /<name>Basic Motion<\/name><effectid>basic<\/effectid>/u);
  assert.match(transformed, /<parameterid>center<\/parameterid><name>Center<\/name><keyframe><when>0<\/when><value><horiz>0<\/horiz><vert>0<\/vert>/u);
  assert.match(transformed, /<when>16<\/when><value><horiz>0\.06666667<\/horiz><vert>0\.025<\/vert>/u);
  assert.match(transformed, /<parameterid>scale<\/parameterid>.*?<when>16<\/when><value>46\.2962963<\/value>/u);
  assert.match(transformed, /<parameterid>rotation<\/parameterid><name>Rotation<\/name><value>12\.5<\/value>/u);
  assert.match(transformed, /<name>Crop<\/name>.*?<parameterid>left<\/parameterid><name>Left<\/name><value>10<\/value>.*?<parameterid>top<\/parameterid><name>Top<\/name><value>20<\/value>/u);
  assert.ok(xml.includes(transformed + '<enabled>FALSE</enabled><locked>FALSE</locked></track>'));
  assert.match(clipXml(xml, 10, 'video'), new RegExp(`<linkclipref>audio-${id(10)}</linkclipref>`, 'u'));
  assert.match(clipXml(xml, 10, 'audio'), new RegExp(`<linkclipref>video-${id(10)}</linkclipref>`, 'u'));
  assert.match(clipXml(xml, 40, 'audio'), /<sourcetrack><mediatype>audio<\/mediatype><trackindex>1<\/trackindex><\/sourcetrack>/u);
  assert.doesNotMatch(xml, new RegExp(`video-${id(40)}`, 'u'));
  assert.match(xml, /<samplerate>44100<\/samplerate><\/samplecharacteristics><channelcount>1<\/channelcount><layout>mono<\/layout>/u);
  assert.match(xml, /<samplerate>48000<\/samplerate><\/samplecharacteristics><channelcount>2<\/channelcount><layout>stereo<\/layout>/u);
});

test('preserves fade and crossfade breakpoints and applies mute as low linear gain', () => {
  const xml = serializePremiereXml(fixture());
  const points = (n: number) => [...clipXml(xml, n, 'audio').matchAll(/<keyframe><when>(\d+)<\/when><value>([^<]+)<\/value><\/keyframe>/gu)]
    .map(([, when, gain]) => [Number(when), Number(gain)]);
  assert.deepEqual(points(40), [[13, 0], [17, .35], [23, .5], [47, .3], [53, 0]]);
  assert.deepEqual(points(41), [[0, 1], [20, 1], [30, 0]]);
  assert.deepEqual(points(42), [[0, 0], [10, 1], [30, 1]]);
  for (const n of [43, 44]) {
    assert.match(clipXml(xml, n, 'audio'), /<name>Audio Levels<\/name>.*?<parameterid>level<\/parameterid><name>Level<\/name><value>0\.00001585<\/value>/u);
  }
});

test('extends a still for a transition and keeps long clips without optional effects editable', () => {
  const input = fixture();
  const transitionIn = {kind: 'dissolve', profileId: CLIP_TRANSITION_PROFILE, durationFrames: 7};
  const first = clip(60, main, 0, 18001);
  const held = clip(61, main, 18001, 21, {assetId: still.id, sourceInFrame: 0, transitionIn});
  input.timeline.clips = [first, held];
  input.timeline.durationFrames = 18022;
  delete input.timeline.subtitles;
  assert.equal(getFormat5TimelineIssue(input.timeline), null);
  const xml = serializePremiereXml(input);
  assert.match(clipXml(xml, 60, 'audio'), /<start>0<\/start><end>18001<\/end><in>12<\/in><out>18013<\/out>/u);
  assert.match(clipXml(xml, 61, 'video'), /<start>-1<\/start><end>18022<\/end><in>0<\/in><out>24<\/out>/u);
  assert.match(xml, /<transitionitem>.*?<start>17998<\/start><end>18005<\/end>/u);
});

test('generates well-formed XML and accepts a local Apple XMEML v5 DTD for validation', t => {
  const dtd = process.env.MIOON_PREMIERE_XMEML_DTD;
  const args = dtd ? ['--dtdvalid', pathToFileURL(dtd).href] : [];
  const check = spawnSync('xmllint', ['--noout', '--nonet', ...args, '-'], {
    input: serializePremiereXml(fixture()), encoding: 'utf8', env: testEnv(),
  });
  if ((check.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' && !dtd) {
    t.skip('xmllint is not installed');
    return;
  }
  assert.ifError(check.error);
  assert.equal(check.status, 0, check.stderr);
});
